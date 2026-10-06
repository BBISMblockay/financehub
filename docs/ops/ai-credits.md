# AI credit billing

Connects measured AI usage to what a tenant pays: a subscription with a
monthly allowance of customer-priced AI credit, plus one-off top-ups.
Migration `20261001120000_ai_credit_billing.sql`; functions `silo-chat`,
`on-deck-prepare`, `card-categorize`, `payment-request-extract`,
`stripe-billing`, `stripe-webhook`; pages `/v2/billing.html`
and `/v2/silo-chat.html`.

**Status: implemented and tested locally. Not applied, not deployed, no live
Stripe or provider call has been made.** Nothing changes for anyone until a
settings row switches it on (step 5 below).

## The model, and where each number lives

| Fact | Where | Committed? |
|---|---|---|
| Subscription price ($500/month) | Stripe price on `billing_plans.stripe_price_id` | Plan row: rollout |
| Included credit per paid period ($30) | `billing_plans.included_ai_credit_micros` | **No** — set at rollout |
| Provider token rates | `ai_provider_rates` (one row per model, immutable, new row per price change) | **No** |
| Customer multiplier and on/off | `ai_billing_settings` (`customer_multiplier_bps`, `mode`) | **No** |
| Top-up packs (price, credit) | `ai_credit_packs` | **No** |

**Sold terms are frozen.** A pack's price, currency and credit cannot be
edited or deleted (`trg_ai_credit_packs_frozen`), and a plan's
`included_ai_credit_micros` is write-once (`trg_billing_plans_allowance_frozen`).
A webhook can land after a change; with these frozen it still grants what was
sold. To change terms, retire the pack (`is_active = false`) and add a new one,
or create a new Stripe Price and plan row.

The pricing tables have RLS on, no policy and no client grant. No view, RPC
result or page carries provider cost, rates or the multiplier.
`ai_credit_summary()` returns customer dollars only, and the database test
fails if its output contains `provider`, `multiplier`, `bps` or `rate`.

All money is integer **micro-USD of customer credit** (`$1 = 1,000,000`).

## How a charge happens

1. **Open** (before the first model call). `ai_credit_open` checks mode,
   membership, price, and takes a hold sized to the worst case: every
   estimated input token at the dearest input rate, the full `max_tokens`,
   every allowed web search. Ask SILO holds two calls (the first, plus the
   forced final answer). An empty balance refuses here, before the model is
   called, with HTTP 402.
2. **Step** (before each later Ask SILO call). Records usage so far and grows
   the hold to *spent + 2 × this call's worst case*. If it cannot grow, the
   investigation stops and the forced final answer is written on the hold
   already held. The answer says credit ran low.
3. **Settle** (once). `succeeded` charges the measured usage × rates ×
   multiplier, rounded up to the micro once on the total, **capped at the
   hold**. The excess is recorded (`computed_charge_micros`) and absorbed by
   SILO. Every other outcome (`failed`, `timed_out`, `cancelled`,
   `interrupted`) charges 0. Provider cost is still recorded for SILO.
   Included credit is spent before purchased credit.
4. **Sweep**. A hold left open for 15 minutes is closed as
   `interrupted` (free) on the company's next `open`. The worker was killed
   and nothing was delivered.

The safety properties are database constraints, not caller discipline:
`held ≤ included + purchased` is a CHECK, a charge must be ≤ its hold, only
`succeeded` may charge, the ledger is append-only, and every grant/charge has
a unique idempotency key. `ai_credit_reconcile()` compares ledger, balances
and open holds. `verify_v2_schema.sql` goes CRITICAL if they disagree.

**Retries.** A reservation is keyed by the request id: a replay is refused
(`duplicate`, 409) and a second settle returns the first result. Ask SILO
mints an id when the browser sends none. The browser's "Try again" sends a new
request, which is a new, separately metered question; the failed one was free.

## Where credit comes from

| Grant | Trigger | Idempotency key |
|---|---|---|
| Included | `invoice.paid` (webhook) or Billing **Sync**, from the re-fetched invoice: `status = paid`, `amount_paid > 0`, `billing_reason` `subscription_create`/`subscription_cycle`, a line priced on a plan with included credit | `included:<subscription>:<period_start>` |
| Top-up | `checkout.session.completed` / `checkout.session.async_payment_succeeded` (webhook) or Billing **Sync** (pages through all of the customer's sessions; says so if it hit its 2,000-session bound), from the re-fetched session: `mode = payment`, `payment_status = paid`, SILO's `silo_purpose`/company metadata, the company's customer, and **`amount_subtotal` + `currency` equal to the pack's price** (and the line item's Price, when present). A mismatch raises, so the webhook keeps retrying and the event stays visible rather than crediting terms nobody sold. Credit from `ai_credit_packs`, never the session | `purchase:<payment_intent>` (also unique per PaymentIntent) |

Nothing is granted from the success redirect. That page calls Sync, which asks
Stripe. Proration, manual, open and zero-amount invoices grant nothing.

**Included credit does not roll over; top-ups do** (Blake, 2026-10-01).
Included credit is tracked **per grant** (`ai_credit_included_grants`, one row
per paid period, with what remains of it). Spend takes included credit first,
oldest grant first. When the next period's grant arrives, every grant whose
period has ended is expired with an `included_expiry` ledger entry. When a
period ends with no renewal (a lapsed subscription), the next AI request
removes it, and Billing shows it as gone straight away. Top-up credit is never
expired.

Open holds are backed by purchased credit and current grants first. Only the
shortfall keeps an ended grant's credit alive, and the settle that releases
that hold expires the rest at once. An invoice delivered after its own period
ended (a late or out-of-order webhook) grants nothing (`period_ended`).

Every function that touches included credit takes the company's account row
lock **first**, then grants and reservations. Two deliveries of the same
renewal therefore serialise. The race test proves the second finds the grant
already made and leaves the new allowance intact.

## Coverage

| AI entry point | Metered | Notes |
|---|---|---|
| Ask SILO (`silo-chat`) | **Yes** | Every model call, including the forced final answer and its continuation |
| On Deck (`on-deck-prepare`) | **Yes** | Checked BEFORE On Deck's own cap, so an empty balance pauses preparation without consuming cap. Charged only when the draft was **stored**, proven by the `prepared`/`revised` event `on_deck_finish` writes in the same transaction. A proposal edited or dismissed during generation (`on_deck_finish` then leaves it alone), provider failures, invalid drafts and failed writes are free |
| Card coding suggestions (`card-categorize`, `card-coding-prepare-scheduled`) | **Yes** | Decided 2026-10-01. One hold per model call (up to 4 run at once). Charged only once at least one suggestion for a line that was asked about is **stored**. A failed, empty or unparseable call, answers that match no requested line, and a failed write are free. A free call still records its measured token usage, so SILO's provider cost for failures is not undercounted. With no credit the model is not called and **nothing is recorded**, so the five-attempt retry limit is not consumed and a top-up resumes preparation on the next pass. Scheduled preparation spends credit too |
| Invoice reading (`payment-request-extract`) | **Yes** | Decided 2026-10-01. One hold per document, charged only when the read accepted at least one fact (a field or a PO reference). Provider errors, truncation, timeouts, "more than one invoice" refusals and a read with every field empty or rejected are free. With no credit the page says so and keeps the locally read fields; manual entry is unaffected |
| Ask SILO evals (`silo-chat/evals`) | No | Internal tooling |

On Deck's **operational cap** (`on_deck_settings.monthly_cap_usd`) is
unchanged and separate. Billing shows only its state (within / near / paused)
and the attempt count, never an amount. Showing its provider-dollar amount
beside customer-priced credit would reveal the multiplier.

## What people see (Ask SILO)

Decided 2026-10-06 (Blake): a price under every answer reads as a meter and
makes people ration the questions Ask SILO is most useful for, so cost is
shown to the person who pays and kept out of everyone else's way.

| Viewer | Balance pill | Per-answer cost |
|---|---|---|
| Owner-admin (`ai_credit_summary().can_top_up`) | Always: green, **yellow** when getting low, **red** when very low or out | Inside the answer's "N queries run" details (or an "AI credit" details when no query ran) |
| Everyone else | Hidden until credit is low: yellow "AI credit low", red when very low, "AI credit: out" | Never |

Levels (`SiloAICredit.level` in `v2/ai-credit.js`), on an enforced balance only:
- **Yellow:** under 25% of the plan's monthly included credit or under $10, whichever is higher.
- **Red:** under 10% or under $2, whichever is higher, or nothing left.

A preview deducts nothing and has no level. An unreadable summary hides the pill, because it does not say who is asking. Billing shows "unavailable" to owners.

## Rollout (in order)

1. **Apply** `20261001120000_ai_credit_billing.sql`, then run
   `verify_v2_schema.sql`. With no settings row the feature is **off**.
2. **Deploy** `stripe-webhook`, `stripe-billing`, `silo-chat`, `on-deck-prepare`,
   `payment-request-extract`, `card-categorize` and `card-coding-prepare-scheduled` (which bundles
   card-categorize's `prepare.ts`). **Stripe is live**, so the two Stripe
   functions change live webhook handling the moment they deploy; in off mode
   the only difference is the grant calls, which find nothing to do.
   **`card-categorize` is a deferred-drift function**: production runs a
   different location rule than `main` (`scripts/check-function-drift.mjs`).
   Deploying it from `main` ships `main`'s rule. Decide that first, or port
   the credit change onto the deployed version.
   Off mode = no behaviour change (one extra RPC per Ask SILO request /
   On Deck attempt). Order between 1 and 2 does not matter. The functions read
   a missing RPC as "off", and the webhook reads a missing grant function as
   "nothing to grant".
3. **Stripe (test mode first).** Create one Price per top-up pack (one-off,
   USD). Add `checkout.session.async_payment_succeeded` to the **platform**
   webhook endpoint (`checkout.session.completed` and `invoice.paid` are
   already there).
4. **Configure, out of the repo** (SQL editor, service role). Values in
   angle brackets are decisions, not defaults:
   ```sql
   insert into ai_provider_rates (model, effective_from, input_micros_per_token,
     output_micros_per_token, cache_read_micros_per_token,
     cache_write_5m_micros_per_token, cache_write_1h_micros_per_token,
     web_search_micros_per_request)
   values ('<CHAT_MODEL>', now(), <in>, <out>, <cache read>, <5m write>, <1h write>, <per search>);
   -- one row per model in use: silo-chat's CHAT_MODEL and On Deck's model
   update billing_plans set included_ai_credit_micros = 30000000 where plan_key = '<plan>';
   insert into ai_credit_packs (pack_key, title, stripe_price_id, unit_amount_cents, credit_micros)
   values ('<key>', '<title>', '<price_...>', <cents>, <micros>);
   insert into ai_billing_settings (mode, customer_multiplier_bps) values ('shadow', <bps>);
   ```
   In **enforce** mode a model with no rate row refuses requests
   (`unpriced_model`). Add the rate row before changing `CHAT_MODEL`.
5. **Shadow** for a few days: usage is priced and shown as "Preview",
   nothing held or deducted. Compare a day of `provider_cost_micros` with the
   provider's usage report (query below).
6. **Grant the current period.** Press Billing → refresh (Sync) for each
   subscribed company. It grants the current paid period from Stripe's
   invoice.
7. **Enforce:** `update ai_billing_settings set mode = 'enforce';`

## Rollback

- **Immediate:** `update ai_billing_settings set mode = 'off';`. Holds,
  charges and refusals stop at once. Open holds are left in the account. Run
  `select ai_credit_sweep(null, interval '0 minutes');` to release them free.
- Function rollback is a redeploy of the previous version. Nothing else depends
  on the new code.
- Do **not** drop the tables once anything was charged. They are the record of
  what customers paid for. Before any data exists, the migration can be
  reversed by dropping the seven `ai_*` tables, the two frozen-terms triggers, the `ai_credit_*`/`ai_rates_*`
  functions and `billing_plans.included_ai_credit_micros`.

## Operating queries (service role)

```sql
-- Reconciliation (must be empty)
select * from ai_credit_reconcile() where not ok;
-- Provider cost vs customer charge by day and feature
select date_trunc('day', settled_at)::date day, feature, outcome, count(*),
       sum(provider_cost_micros)/1e6 provider_usd, sum(charged_micros)/1e6 charged_usd,
       sum(computed_charge_micros - charged_micros) filter (where outcome='succeeded')/1e6 absorbed_usd
  from ai_credit_reservations where status = 'settled' group by 1,2,3 order by 1 desc;
-- Holds open now
select company_entity_id, feature, count(*), sum(held_micros)/1e6
  from ai_credit_reservations where status = 'held' group by 1,2;
```

## Decisions

Recorded (Blake, 2026-10-01):

- **Rollover**: top-ups roll over; the included allowance does not.
- **Price**: the multiplier is decided; it is set in `ai_billing_settings`
  at rollout and deliberately not written in the repo.
- **Partial answers** are delivered and charged.
- **Card coding** and **invoice reading** are billed.
- **Trials**: a trialing workspace gets no included allowance (its first
  invoice is $0, and included credit comes only from a paid invoice). The
  workspace owner can buy top-ups during the trial (`trialing` is a live
  status for top-ups; a handler test covers it).
- **Refunds**: no clawback. Top-ups roll over, so there is no unused-credit
  refund to handle (`charge.refunded` is not routed).
- **No per-seat scaling**: revenue is from AI usage, not seats. Included
  credit is per subscription.

- **Who may spend**: anyone who can use an AI feature spends the company's
  shared credit. The feature's own gate is the only limit (Ask SILO's access,
  card coding's finance gate, and so on). No per-person cap. Only an
  owner-admin can buy more.
- **Auto-refill**: not now. Top-ups are bought by hand.
- **The 2026-09-24 plan is dropped**: the 3-question trial, the 22% markup and
  the company-set spend limit in `docs/ops/ask-silo-paid-pilot-audit.md` are
  superseded by this model and will not be built.

Still open:

1. **On Deck settings page** (`settings-company.html`) shows On Deck's spend
   in provider dollars to company admins. Beside Billing's customer-priced
   usage, that reveals the ratio. Pre-existing; not changed here.

## Verification record (2026-10-01, local)

- `scripts/tests/ai-credit-database.test.mjs`: 36 checks on PGlite with the real
  Stripe + credit migrations: boundary, modes, grants, per-grant expiry
  (renewal during a hold, settle after a period ended, late invoice), frozen
  terms, top-up price check, holds, settles, sweep, reconciliation, summary
  scoping, invoice reading, and the verify check. Twelve mutations each fail it.
- `scripts/tests/ai-credit-concurrency.test.mjs`: four races on two real
  PostgreSQL 16 connections (two opens, settle vs sweep, a duplicate top-up, a
  duplicate renewal). Two lock-removal mutations each fail it. Removing the
  account lock from the renewal path does **not** fail it: the ledger's unique
  key and the per-grant rows already serialise that race. The lock is kept for
  lock order (account → grants), which a test cannot force into a deadlock.
- `card-categorize-persistence.test.mjs`: 26 (7 credit scenarios, incl.
  unstored answers free, no recorded attempt on refusal, and an unparseable
  answer keeping its measured usage; 3 mutations).
- `payment-request-extract/handler.test.mjs`: 15 (7 credit, incl. an all-empty
  and an all-rejected read being free with usage kept; 4 mutations).
- `silo-chat/handler.test.mjs`: 149. `on-deck-edge.test.mjs`: 17 (incl. a
  proposal changed mid-generation), `on-deck-core.test.mjs`: 14.
- `stripe-handlers.test.mjs`: 69 (incl. trial top-up and paginated Sync
  recovery past 150 newer sessions; a pagination mutation fails it).
- `plaid-bank-feed-database.test.mjs`: 38. The Plaid fixture now stops at an
  end marker in `verify_v2_schema.sql`, so the AI credit check no longer runs
  inside it. That failure is what had been skipping the AI credit suite in CI.
- Browser: `ai-credit-billing.test.js` (12), `ask-silo-credit.test.js` (14),
  `ask-silo-credit-recovery.test.js` (12: a charged answer recovered after a
  dropped connection shows its cost and refreshes the balance),
  `ask-silo-conversation.test.js` (20). `node v2/tests/run.js --unit`: 25 suites.

**Not verified:** live Stripe (test or live mode), a deployed function, real
token usage against the provider's invoice, production data volumes, and the
deployment drift check.
