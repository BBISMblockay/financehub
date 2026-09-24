# Ask SILO — paid pilot readiness audit (2026-09-24)

**Scope.** Can Ask SILO run as a paid pilot for **2,000 client companies** asking
**2,000–5,000 questions per day in total** (questions, not simultaneous users)?
Read-only code inspection of `supabase/functions/silo-chat/index.ts`,
`v2/silo-chat.html`, the `/v3/` dashboard loaders, `chat_run_readonly_query` and the
Stripe platform billing added in `20260919120000`. Nothing was deployed, run against
production, or load-tested. Line numbers are as of `25ab52c`.

**Verdict.** Not ready. Company isolation is in good shape and should be kept as it
is. The blockers are commercial and operational. Ask SILO does not meter cost, does
not check who is allowed to spend it, and has no limit on how much it runs. It also
has no fair queue and no retry when Anthropic is overloaded.

Labels used below: **Confirmed** = read in code. **Absent** = searched for and not
found. **Assumption** = can't be settled from code; needs a live measurement.

---

## 1. What exists

### Protections to keep (confirmed)

| Protection | Where |
|---|---|
| Every DB call uses the **caller's JWT** (anon key + bearer). silo-chat never uses the service role (Phase A step 5 adds a narrowly scoped exception for the ledger) | `index.ts:1356-1366` |
| The company comes from `profiles.active_company_id`. A company id in the request body can only cause a **refusal** if it doesn't match. The company is re-checked before the answer is returned and before every write tool | `index.ts:1418-1452`, `:1684-1707`, `:1985-2003` |
| `chat_run_readonly_query`: SECURITY INVOKER, one SELECT/WITH per call, `set transaction read only`, 1000-row page cap, anon revoked | `20260916120000_chat_readonly_query_read_only_txn.sql:74-133` |
| Materialized views have SELECT revoked from `authenticated`. Tenant filtering lives in wrapper views | e.g. `20260907120000:143`, `20260904210000:61` |
| Saved reports / dashboards: visible within the company when shared, or to the creator only. `system` reports are global but no client can write them. `dashboard_widgets_v` is security_invoker, so a private report's SQL comes back null | `20260821090000:26-30`, `20260828130000:89-158`, `20260828120000:216-223` |
| Dashboard parameters are **typed**, and an undeclared `{{token}}` is an error | `v3/js/report-params.js:142-268` |
| Per-request bounds: 20 tool rounds, 95 s wall-clock budget, 125 s continuation cutoff (the gateway kills requests at 150 s), 3 `describe_relations` calls, 5 web searches | `index.ts:994`, `:1080`, `:1135`, `:1002`, `:470` |
| Client single-flight, plus a `request_id`-based recovery poll before any "Try again" | `silo-chat.html:1262-1287`, `:1032-1087` |
| Append-only audit row per question, with company, `request_id` and diagnostics | `20260814190000`, `20260916121000`, `20260916140000`; insert `index.ts:1240-1290` |
| Question counts per company | `silo_chat_usage_by_company_v`, `20260918120000_company_onboarding.sql:904-920` ("meters nothing and limits nothing") |
| Platform subscription mirror: plans, one subscription per company, `trial_end`, `is_entitled` | `20260919120000:221-266`, `:1864-1870` |
| Precedent for storing token usage: card-categorize saves Anthropic `usage` per run | `card-categorize/prepare.ts:523-525`, `:1182`; `card_coding_preparation_runs.usage` |

### Pilot blockers (confirmed gaps)

**Billing and cost**
1. **No usage capture.** silo-chat never reads `usage`: zero matches for
   `input_tokens` / `output_tokens` / `cache_read_input_tokens` in `index.ts`. Cost per
   question, per company or in total can't be known.
2. **No gate on spend.** Access checks stop at "authenticated" (`index.ts:1365`).
   `is_entitled` is never consulted, and the migration says so on purpose
   (`20260919120000:1870`). There is no trial cap, allowance, balance, spend cap or
   auto-recharge anywhere in the repo (**absent**).
3. **The audit log can't be the billing record.** `request_id` is nullable and not
   unique (`20260916121000:33-34`). The insert can fail silently
   (`audit_logged:false`, `index.ts:1259-1290`). A request killed by the gateway at
   150 s writes no row at all (`budget-lib.mjs:15-18`), yet its model calls were
   already billed by Anthropic.
4. **Stripe only knows subscriptions.** Plans are flat monthly/yearly prices with no
   metered price. There is no one-time credit purchase and no top-up webhook route
   (`stripe-billing/handler.ts:77-81`, `stripe-webhook/event-routing.mjs:28-36`).
   `docs/ops/stripe.md:152-153` lists Ask SILO as *included* in Growth, which today
   means unlimited.

**Permissions**
5. **Who may spend is decided only in the client.** The exec-only rule is sidebar
   config (`v2/nav-config.js:41-42,62,238`). Any active member of any company can
   call the endpoint directly.

**Capacity**
6. **No rate limit and no concurrency limit** per user, company or overall. The only
   limits are per request.
7. **No retry on Anthropic 429/529/5xx.** `callAnthropic` throws on any non-OK
   response (`index.ts:982`). A single overload response wastes every round already
   paid for, and the user's "Try again" starts the whole loop over with a new
   `request_id` (`silo-chat.html:1111`).
8. **No server-side dedupe of an in-flight `request_id`.** Two tabs, or a retry
   after a dropped connection, run twice.
9. **Model spend grows much faster than rounds.** Only the system prompt and tools
   are cached (`index.ts:954`). The growing transcript (all earlier tool results) is
   re-sent uncached on every round, so a 20-round question costs far more than 20×
   a 1-round one.

**Security and workflow**
10. **Hardcoded tester allowlist** `PRODUCT_CONCEPT_TESTERS` (`index.ts:143`, `:1532`,
    `:1573`; open in `multi-tenant-audit-2026-09.md:410-412`). Each new tenant means
    editing code.
11. **Data egress to decide on.** Full history, notes, brand context and query rows
    go to Anthropic (`index.ts:937-954`). The model can also put business data into
    `web_search` queries (`:468`). A pilot contract should cover this.

### Assumptions (need live verification)
- `has_table_privilege('authenticated', <mv>, 'SELECT')` is false for **every** row in
  `pg_matviews`, including any created after 2026-09-07.
- Through `run_sql`, as `authenticated`, these all fail or return only the caller's
  rows: `pg_stat_activity` (other tenants' SQL text), `auth.users`, `storage.objects`,
  and a `select set_active_company(...)`.
- `chat_run_readonly_query` still has `prosecdef = false`, and anon has no EXECUTE.
- Anthropic org rate limits (RPM / input TPM / output TPM) and the current 429 rate.
- Supabase compute size, pooler size, and Edge Function concurrency and CPU limits.
- Real per-question token profile, and mean and p95 duration. `diagnostics` stores timing
  but not tokens.

---

## 2. Smallest practical implementation sequence

Each phase ships on its own, and none weakens a protection listed above. It follows
the decisions recorded in §5: a 3-question trial, then top-up only, 22% markup,
admins spend, and a company-set running-total spend limit of $100–$1,000.

### Phase A — cost tracking and budget enforcement (required before the pilot)

1. **Price book and config.** `ai_price_book(model, input, output, cache_write,
   cache_read, web_search, effective_from)` stores **provider** rates. A per-company
   `ai_billing_config` holds `markup_bps` (platform default **2200**, i.e. 22%). Both are
   written only by migration or service role, like `billing_plans`.
2. **Usage ledger** `ai_usage_ledger`: `request_id uuid UNIQUE NOT NULL`, company,
   user, model, token totals by type, `provider_cost_micros`,
   `customer_charge_micros`, `markup_bps`, the `ai_price_book` row used, `bucket`
   (trial / prepaid), and `status` (`reserved` → `settled` | `swept`).
   **Provider cost and customer charge are separate columns.** Markup and price-book
   row are **snapshotted at reserve time**. Micros are computed once, from token
   totals at settle, not summed from rounded per-call values (a cache-read token is
   ~0.2 micro), with one stated rounding rule. The charge is provider cost ×
   (1 + bps/10000). **The server mints the `request_id` when the client sends none
   or an invalid one.** Today it falls back to `null` (`index.ts:1382`), and a null
   slips past UNIQUE and past dedupe.
3. **Balances** `ai_company_balances`:
   - **Trial questions remaining.** **3**, granted once per company and never
     reset. Each trial question has a hard **$0.50 provider-cost ceiling**, and the
     loop forces the final answer as it nears it. That caps SILO's exposure at $1.50
     per company, or **$3,000 across all 2,000 companies in the worst case**
     (≈ $1,600 at the typical $0.26). A dollar trial doesn't bound cost the same way:
     $10 each on 2,000 companies is up to ~$16,000 of provider cost. Founding a
     company is invite-gated (`redeem_platform_invite`), so nobody can farm trials
     by signing up repeatedly. The trial is separate from the Stripe trial, since
     `trialing` already counts as `is_entitled` (`20260919120000:1864`).
   - **Prepaid balance.** Plans include no usage; everything after the trial is
     top-up.
   - **Spend limit.** Set by the company, CHECKed to $100–$1,000. It is a **running
     total** of customer charges that never resets on a calendar. When it is
     reached, Ask SILO stops until an admin raises the limit. `spent_total` only
     grows, so no rollover logic exists and no late webhook can reset it.
   - **Auto-recharge.** Enabled flag and amount. It never recharges past the spend
     limit.
4. **Reserve → record → settle.**
   - **Reserve before every model call, atomically.** A request-level estimate is
     not enough, because a question's cost isn't known until its rounds have run.
     - **At entry**, `ai_open_request(request_id, company, user)` refuses a **null
       company** (today one reaches the loop; `index.ts:1445-1447` only rejects a
       *mismatch*) and re-checks active membership, since it runs as service role.
       It then reserves the worst-case cost of the first call **plus one
       final-answer call**.
     - **Before each later call**, `ai_reserve_call` reserves that call's worst case:
       the input tokens about to be sent × the input price, plus `max_tokens` × the
       output price. This is a single conditional `UPDATE … SET reserved = reserved
       + x WHERE available - reserved >= x` (with the spend-limit check in the same
       statement), so balance and limit can **never** be overdrawn, even by
       concurrent requests.
     - **If a reservation fails**, the loop makes no further tool calls and answers
       with the final-answer allowance it already holds, or stops with 402 if it
       holds none. No model call is ever made without budget reserved for it.
     - **After each call**, its actual cost replaces the reservation.
   - **Record.** Record usage **inside `callAnthropic`** (not at each call site),
     writing the running total to the ledger row after every call.
   - **Uncertain provider charges.** A call that aborted
     (`ModelCallDeadlineError`), timed out, or returned no usage block may still be
     billed by Anthropic. Its full reservation is kept as provider cost with
     `usage_status = 'unconfirmed'`, **never assumed zero**, and reconciled against
     Anthropic's usage report.
   - **Settle** in a `finally` covering every exit: success, the 503/409 early
     returns in `finishWithAnswer` (`index.ts:1689-1706`) and the outer catch.
   - **Sweep.** A scheduled sweep closes rows still `reserved` after the gateway
     limit (~150 s, not minutes, or an orphaned hold blocks the per-company cap). It
     settles provider cost **from the last recorded usage plus any unconfirmed call
     reservations**, with customer charge 0 (nothing was delivered; see §5).
   - **One winner.** Settle and sweep both use `UPDATE … WHERE status = 'reserved'`,
     so only one of them wins.
5. **Only the service role writes the ledger.** The reserve/record/settle RPCs must
   not be callable by `authenticated`. Revoke EXECUTE from anon **and** authenticated
   by name, as in `20260904330000`. Otherwise a browser could settle its own request
   at zero. This adds a service-role client to silo-chat. Keep it narrow:
   - It lives in its own module that exposes only these three calls.
   - Its only inputs are server-derived: the request id, the company and the
     computed usage.
   - It is never passed to tool handlers.
   - A test (like `prompt.test.mjs`) fails if `SERVICE_ROLE` is referenced anywhere
     else.

   All queries keep running under the caller's JWT. Update the §1 row above once
   this lands.
6. **Server-side spend gate: admins only.** The function refuses callers failing
   `is_admin_user()` (membership `owner_admin`/`admin`, or profile fallback). The
   same gate covers buying top-ups and changing the cap. Today `stripe-billing` is
   owner-admin only, so this is a deliberate widening for credit purchases, not for
   subscriptions.
7. **Failed requests are free to the customer, not to SILO.** Their provider cost
   counts against an **internal failure budget**: per company per day, plus a
   platform-wide daily limit. A company past its budget is refused (with a message
   to contact support) until the next day or until someone reviews it. That way,
   repeated failures, accidental or deliberate, can't turn into unlimited free model
   spend.

   **Failed-request UX.** No customer charge when no answer was saved. The chat says
   the question failed and suggests a reworded version. Default: a fixed hint chosen
   by failure reason (timeout → narrow the date range; query error → name the metric
   or table; round cap → split the question). A model-written rewrite costs an extra
   call that SILO absorbs, so use it only if the hints prove too weak.

### Phase B — reliable processing

8. **Admission control, then a fair queue.** Rejecting excess load and scheduling it
   fairly are different mechanisms:
   - **Rejection (minimum for the pilot).** An admission row keyed by `request_id`
     dedupes (409 if the request is already in flight) and enforces a
     **per-company in-flight cap** plus a **global cap**, returning 429 +
     `Retry-After`. It protects capacity. It is **not fair**: the clients that retry
     fastest win the freed slots, and one busy company can keep most of the global
     cap by retrying.
   - **Fair queueing (required once the global cap is reached regularly).**
     Requests are accepted into a queue instead of refused, and a dispatcher picks
     the next one **round-robin across companies**, choosing the company served
     longest ago. This needs asynchronous processing (step 12), because a queued
     request cannot hold an HTTP connection open against the 150 s gateway.
   - **When to switch.** Launch with rejection only, and watch how often the cap is
     hit. Move to the queue before 429s become routine.
9. **Anthropic retry.** 2–3 jittered retries on 429/529/5xx, bounded by the time
   budget that's left.
10. **Cache the growing transcript.** Add a second `cache_control` breakpoint on the
   last message so earlier tool results are read from cache instead of re-billed. This
   is the biggest cost lever (see §3).
11. **Protect the app DB.** Give chat SQL its own role and `statement_timeout`. Today
    the 8 s `authenticated` timeout governs, not the declared 30 s (`docs/ops/bugs.md`).
    Consider a read replica for chat and dashboards together: dashboards fire one
    `chat_run_readonly_query` per widget via `Promise.all`
    (`v3/js/dashboard-renderer.js:744`, `:864`) on the same role.
12. **Asynchronous processing.** Return the `request_id` at once, run the loop in a
    worker, and let the client poll. The client's existing recovery poll is the read
    side. This is required for the fair queue in step 8, and also once p95 duration
    nears the 150 s gateway limit.

### Phase C — customer and admin controls

13. Customer:
    - A usage-and-balance panel on Billing.
    - **Credit-pack purchase.** Checkout in `mode: 'payment'`. The webhook already
      routes `checkout.session.completed` as a subscription checkout, so it must
      branch on `mode`. Key each credit on a **UNIQUE `payment_intent` id**.
      `stripe_webhook_events` dedupes by event and deliberately re-runs errored
      rows (`20260919120000:958-960`), so it can't be the only guard.
    - **Auto-recharge** opt-in, never exceeding the company's spend limit. It needs one in-flight flag
      per company and a Stripe idempotency key per (company, period, count),
      because two concurrent reservations can both trigger it.
    - A clear 402/429 message in chat.
14. Admin (Silo Admin): per-company provider cost vs. charge vs. margin, markup
    override, manual credit/adjustment entry (as a ledger row, never an in-place
    edit), and a platform-wide daily provider-cost alarm.
15. Replace `PRODUCT_CONCEPT_TESTERS` with a per-company feature flag.

---

## 3. Illustrative costs

**Every number here is an assumption until Phase A step 2 records real usage. Do not
set customer prices from this section.** Before pricing, verify current Anthropic
pricing for the model in use, load it into `ai_price_book`, and check it against
measured usage. Customer charges then follow as provider cost × (1 + markup), from
the price book, never from this table.
Prices are Anthropic first-party list prices for `claude-sonnet-5` (the default
`CHAT_MODEL`, `index.ts:135`), taken from a price table cached 2026-06-24: input
$2 / MTok, output $10, cache write ~$2.50 (1.25×), cache read ~$0.20 (0.1×). Web
search is assumed at $10 per 1,000. **Check current pricing before quoting a
customer.**

Profile assumptions: a cached prefix (system + tools + schema) of ~20k tokens (the
static text is ~65–100k chars; `index.ts:155-660`). Sonnet 5 runs adaptive thinking
when `thinking` is omitted, so output includes thinking tokens.

| Question shape | Model calls | Uncached input / call (avg) | Output / call | ≈ Provider cost |
|---|---|---|---|---|
| Light | 3 | 5k | 1k | **$0.12** |
| Typical | 6 | 8k | 1.5k | **$0.26** |
| Heavy (hits the 20-round cap) | 20 | 40k | 1.5k | **$2.00** |

Assumed mix: 60% light / 35% typical / 5% heavy → **≈ $0.26 per question**. The first call of each request
is priced as a cache write (the schema slice and notes differ by question). Web search
is not included; one search per question adds ~$0.01.

| | 2,000 / day | 5,000 / day |
|---|---|---|
| Provider cost / day (mix) | ≈ $520 | ≈ $1,300 |
| Provider cost / 30 days | ≈ $15,600 | ≈ $39,000 |
| Bounds / day (all light … all heavy) | $240 … $4,000 | $600 … $10,000 |
| Customer charge at the 22% markup (30 days, mix) | ≈ $19,000 | ≈ $47,600 |

What this means:
- The **heavy tail sets the budget.** Five percent of questions carry about 40% of
  the cost. Step 10 (transcript caching) and the per-call reservations in step 4
  limit it.
- Averaged across 2,000 companies, 5,000/day is only ~75 questions per company per
  month. Priced at 22%, a typical question costs the customer about $0.32
  ($0.26 × 1.22).
- **Capacity is not established by this audit.** Average concurrency =
  arrival rate × **mean** request duration (Little's law); a median can't give it.
  Mean duration comes from `silo_chat_audit_log` (`diagnostics.elapsed_ms`), and the
  arrival rate at peak from the audit log's timestamps. Neither was measured here.
  Nor were:
  - the database load from chat and dashboard queries together
    (`pg_stat_statements`), and
  - Anthropic's input and output TPM limits for the account.

  Size the caps in step 8 from those measurements, not from this document.

---

## 4. Essential acceptance checks

1. **Ledger is complete.** For N test questions, the ledger has exactly N settled
   rows, one per `request_id`, including requests sent with no id. Provider cost
   matches Anthropic's Usage & Cost report for the same window within rounding.
   Customer charge = provider cost × (1 + stored bps/10000).
2. **Trial holds.** A 4th trial question gets 402. A deliberately heavy trial
   question stops at the $0.50 ceiling with an answer.
3. **Spend limits hold strictly under concurrency.** One company fires 20 parallel
   questions with budget for about 3. Reserved plus spent never exceeds the balance
   or the spend limit at any moment, including mid-request. Requests that can't
   reserve get 402/429, or stop at their final-answer allowance.
4. **Auto-recharge stops at its cap.** Drain the balance repeatedly. Recharges stop
   at the spend limit, and a duplicated webhook delivery credits once.
5. **Failures are recorded and bounded.** Inject a 429, a 5xx and a forced 150 s
   timeout.
   - Each one leaves a settled or swept row whose provider cost covers the calls
     that ran, with aborted calls marked `unconfirmed` and not treated as zero.
   - None charges the customer, and none produces two rows for one `request_id`.
   - Repeating failures until the internal failure budget is spent gets refused.
6. **Client can't write the ledger.** Calling reserve/settle as `authenticated` and
   as anon is permission-denied.
7. **Two-tenant walkthrough.** Tenants A and B each ask the same question, save a
   report, add it to a dashboard and publish. There's no row overlap. B can't see A's
   report or dashboard ids. `dashboard_widgets_v.query_sql` is null across tenants.
   Each ledger row is charged to the asking company.
8. **Company switch mid-question** returns 409 `company_changed`. The provider cost
   is recorded against the company that reserved it, and the customer charge is 0.
   A user with no active company is refused before any model call.
9. **Probes through `run_sql`**: every `*_mv`, `pg_stat_activity`, `auth.users` and
   `set_active_company` fail (see §1 assumptions).
10. **Spend gate.** A non-admin member gets refused when calling the
   endpoint directly with curl.
11. **App stays responsive.** With the global cap saturated, a dashboard open and a
    PO list load stay within their normal latency.
12. `verify_v2_schema.sql` is all-ok, with checks added for the new tables and for
    the grants on the ledger RPCs.

## 5. Decisions

### Recorded (Blake, 2026-09-24)

| Decision | Answer |
|---|---|
| Pricing model | **3 free trial questions per company (each capped at $0.50 provider cost), then top-up only.** Plans include no Ask SILO usage. Replaces an earlier $10 trial, which could expose ~$16,000 across 2,000 companies |
| Markup | **22%** on provider cost (`markup_bps = 2200`) |
| Spending limit | **Company-set running total, $100–$1,000**, not reset monthly. It covers all charges including auto-recharge, and Ask SILO stops at it until an admin raises it |
| Who may spend | **Admins** (ask questions, buy top-ups, set the cap) |
| Failed requests | **No charge to the customer.** If no answer is saved, say it failed and suggest a reworded question. Provider cost is still recorded and counts against an internal failure budget |
| Data terms | **Standard Anthropic retention; `web_search` stays on** |

### Still open

1. **Internal failure budget**: per-company daily and platform daily provider-cost
   limits for failed requests.
2. **Auto-recharge amount**: fixed packs, or chosen by the company within its cap?
3. **Concurrency limits**: per-company in-flight cap and global cap. These need
   measured mean duration, peak arrival rate and the Anthropic TPM limits first.
4. **Platform alarm**: daily provider-cost threshold.
5. **Plan copy**: `docs/ops/stripe.md` must stop saying Ask SILO is included in
   Growth.
