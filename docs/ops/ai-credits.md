# AI credit billing

Connects measured AI usage to what a tenant pays: a subscription with a
monthly allowance of customer-priced AI credit, plus one-off top-ups.
Migration `20261001120000_ai_credit_billing.sql`; functions `silo-chat`,
`on-deck-prepare`, `stripe-billing`, `stripe-webhook`; pages `/v2/billing.html`
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
| Top-up | `checkout.session.completed` / `checkout.session.async_payment_succeeded` (webhook) or Billing **Sync** (lists the customer's sessions), from the re-fetched session: `mode = payment`, `payment_status = paid`, SILO's `silo_purpose`/company metadata, the company's customer. Amount from `ai_credit_packs`, never the session | `purchase:<payment_intent>` (also unique per PaymentIntent) |

Nothing is granted from the success redirect. That page calls Sync, which asks
Stripe. Proration, manual, open and zero-amount invoices grant nothing.

## Coverage

| AI entry point | Metered | Notes |
|---|---|---|
| Ask SILO (`silo-chat`) | **Yes** | Every model call, including the forced final answer and its continuation |
| On Deck (`on-deck-prepare`) | **Yes** | Checked BEFORE On Deck's own cap, so an empty balance pauses preparation without consuming cap. A prepared draft is charged; provider failures, invalid drafts and failed writes are free |
| Card coding suggestions (`card-categorize`, `card-coding-prepare-scheduled`) | **No** | Finance automation; whether it is billable is a decision (below) |
| Payment request extraction (`payment-request-extract`) | **No** | Same |
| Ask SILO evals (`silo-chat/evals`) | No | Internal tooling |

On Deck's **operational cap** (`on_deck_settings.monthly_cap_usd`) is
unchanged and separate. Billing shows only its state (within / near / paused)
and the attempt count, never an amount. Showing its provider-dollar amount
beside customer-priced credit would reveal the multiplier.

## Rollout (in order)

1. **Apply** `20261001120000_ai_credit_billing.sql`, then run
   `verify_v2_schema.sql`. With no settings row the feature is **off**.
2. **Deploy** `stripe-webhook`, `stripe-billing`, `silo-chat`, `on-deck-prepare`.
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
  reversed by dropping the six `ai_*` tables, the `ai_credit_*`/`ai_rates_*`
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

## Decisions needed (not invented here)

1. **Rollover/expiry of included credit.** Not defined anywhere. As built,
   unused included credit **carries over** (nothing expires). The mockup's
   "this period" wording assumes a period allowance. Expiry would be a new
   ledger entry type at period end.
2. **Refunds.** A refunded top-up or subscription invoice does **not**
   remove credit (`charge.refunded` is not routed). Decide whether a refund
   claws back unspent credit.
3. **Auto-refill.** Not built. The earlier audit's decision (opt-in, bounded
   by a spend limit) predates this model.
4. **The 2026-09-24 decisions this supersedes.** `docs/ops/ask-silo-paid-pilot-audit.md`
   recorded a 3-question trial, 22% markup, top-up only, and a company-set
   $100–$1,000 running spend limit. This build follows the 2026-10-01 model
   (subscription + included credit, private multiplier). The trial and the
   spend limit are **not** built. Confirm they are dropped.
5. **Partial answers are charged.** An answer cut short by the time budget or
   by low credit is delivered and charged (capped at the hold). Only requests
   that deliver no answer are free. Confirm.
6. **Trial periods.** A $0 trial invoice grants no included credit
   (`amount_paid > 0` is required).
7. **Seat-based plans.** Included credit is per subscription, not per seat.
8. **Who may ask.** Unchanged: whoever could use Ask SILO before. Top-ups
   use the existing owner-admin gate of `stripe-billing`.
9. **Finance AI** (card coding, payment-request extraction): billable or not.
10. **On Deck settings page** (`settings-company.html`) already shows On
    Deck's spend in provider dollars to company admins. With a private
    multiplier, that figure beside Billing's customer-priced usage reveals the
    ratio. Pre-existing; not changed here.

## Verification record (2026-10-01, local)

- `scripts/tests/ai-credit-database.test.mjs`: 28 checks on PGlite with the real
  Stripe + credit migrations (boundary, modes, grants, holds, settles, sweep,
  reconciliation, summary scoping, verify check). Six mutations each fail it.
- `scripts/tests/ai-credit-concurrency.test.mjs`: three races on two real
  PostgreSQL 16 connections. Two mutations each fail it. With both lock layers
  removed, the CHECK constraint still refuses the overdraw (as an error).
- `silo-chat/handler.test.mjs`: 149 (10 new credit scenarios, incl. 402 before
  any model call, duplicate, unreachable meter, free failures, company switch,
  low-credit forced answer, failed settle → "pending").
- `on-deck-edge.test.mjs`: 16 (6 new), `on-deck-core.test.mjs`: 14.
- `stripe-handlers.test.mjs`: 65 (11 new), with all 20 existing mutations still killing.
- Browser: `ai-credit-billing.test.js` (12), `ask-silo-credit.test.js` (14);
  existing `payments-ui` and `ask-silo-conversation` unchanged.

**Not verified:** live Stripe (test or live mode), a deployed function, real
token usage against the provider's invoice, production data volumes, and the
deployment drift check.
