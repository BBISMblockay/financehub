# Coding preparation

How transactions reach the bookkeeper already prepared, and how to switch it on.

```
bank feed sync ─▶ prepare-coding job ─▶ card-coding-prepare-scheduled ─▶ prepareCoding()
nightly 10:41 UTC ─▶ card-coding-prepare.yml ─┘                            │
"Prepare now" / Retry on the page ─▶ card-categorize ──────────────────────┘
                                                                           ▼
                                          card_coding_suggestions (never card_transactions)
                                                                           ▼
                             bookkeeper: Use category / Dismiss ─▶ apply_card_coding
                                                                           ▼
                                               batch approval ─▶ QuickBooks posting (unchanged)
```

## What each piece may do

| Piece | Identity | May | May not |
|---|---|---|---|
| `card-categorize` | a signed-in finance user; company from their profile | prepare the rows they name, retry dismissed ones | write coding, approve, post |
| `card-coding-prepare-scheduled` | GitHub OIDC from `plaid-sync.yml` or `card-coding-prepare.yml` on `main` | prepare whatever `next_card_coding_work` hands it, one import per call; once per run, apply the company's SAVED RULES (below) | name a company or rows, retry dismissed work, write coding from a suggestion |
| `accept_card_coding_suggestions` | a signed-in finance user | save a suggestion through `apply_card_coding` after re-checking it | approve or post |

Preparation never writes `card_transactions`. A person accepts; a person approves; a person posts.
The one exception is a rule the company itself saved (owner decision 2026-11-25): see "Saved rules" below.

## Switching it on

Nothing below has been done by the PRs that added it.

1. Apply `20260923120000_card_coding_suggestions.sql` and
   `20260923130000_card_coding_background_preparation.sql`, then run
   `verify_v2_schema.sql` (all `ok`).
2. Deploy `card-categorize` and `card-coding-prepare-scheduled` with
   `deploy-edge-function.yml`.
3. Set the function secret `CODING_PREP_BACKGROUND_ENABLED=true`
   (`ANTHROPIC_API_KEY` is already set for card-categorize).
4. A finance user can enable it in Transactions → the selected account's
   details → **Automatic coding suggestions**. Background preparation spends
   model calls on a company's behalf (including an existing eligible backlog),
   so it is **per account and off by default**. The setting writes only
   `card_sources.auto_prepare_coding`, checks the previous value and company,
   and verifies the returned value. The Prepare button works on every account
   regardless. A missing preparation column shows unavailable, not an opt-in.
   The UI says **requested**, not running: it cannot inspect the repository
   variable or Edge Function secret. Setting this preference alone does not
   turn on the scheduler.
5. Set the repository variable `CODING_PREP_ENABLED=true` and dispatch
   `card-coding-prepare.yml` by hand. Read the job's JSON summary and the new
   rows in `card_coding_preparation_runs` (below). If anything looks wrong,
   unset the variable; nothing else changes.
6. Leave it set. From then on preparation follows every bank feed sync and
   runs nightly, for the accounts switched on.

To stop it: unset `CODING_PREP_ENABLED` (the workflows skip), set
`CODING_PREP_BACKGROUND_ENABLED` to anything else (the function refuses), or
switch `auto_prepare_coding` off for one account. The
bookkeeper's Prepare button keeps working either way.

## Reading what happened

```sql
-- Recent runs: what was asked, what came back, how long each phase took.
select trigger, status, transactions_requested, suggestions_recorded, needs_judgment_recorded,
       failures_recorded, skipped, timings, usage, error, started_at, finished_at
from card_coding_preparation_runs order by started_at desc limit 20;

-- Why a row is not being prepared.
select t.id, t.description, public.card_coding_needs_preparation(t, b, s) as reason
from card_transactions t join card_import_batches b on b.id = t.batch_id join card_sources s on s.id = b.source_id
where t.status = 'uncoded' and b.status in ('draft','categorized');
```

`timings` is milliseconds per phase (`auth_ms`, `load_ms`, `context_ms`,
`history_ms`, `model_ms` with each call in `model_call_ms`, `persist_ms`,
`total_ms`); `usage` is the model's own token counts.

## Limits worth knowing

- One scheduler call prepares at most 40 rows of one import (four model
  calls of ten merchants, one concurrent wave), so it ends well inside the
  150s gateway cut. The runner stays on an import while it makes progress, up
  to ten calls (400 rows), and stops a pass at 200 calls. A test ties the row
  limit to the batch size and concurrency in `prepare.ts`, so shrinking one
  without the other fails.
- A failed row is retried automatically four more times, backing off; after
  that it waits for someone to press Retry.
- A dismissal holds until the transaction's facts change.

## Account preference UI release

The account-details control reuses the September preparation schema and the
existing jobs. It adds no migration and requires no Edge Function redeploy.
It does not change any existing preference, repository variable or function
secret. A deployment where steps 1–3 and 5 have not happened still needs those
operational prerequisites before the preference can produce suggestions.
Enabling the preference does not invoke AI immediately; it makes eligible rows
available to the next scheduled preparation run. Turning it off leaves existing
suggestions intact and does not cancel a preparation call already in flight.
There is no automatic acceptance, approval or posting.

## Saved rules run on their own (20261125130000)

Until 2026-11-25 a saved rule only ran when someone opened Transactions and pressed Save, and
preparation skips a row a rule answers (`rule_applies`), so those rows sat: 207 of 362 uncategorized
November bank rows on 2026-11-24. Now the first call of every scheduled run (after each bank feed
sync, and nightly) calls `apply_saved_card_coding_rules(500)` before it looks for model work.

It is the page's `applyRules()` in SQL and writes through `apply_card_coding`, the statement the
page's Save uses. It categorizes a row only when all of these hold:

- the account is switched on (`card_sources.auto_prepare_coding`) and active, the month is open;
- **no person has ever saved the row** (`updated_by is null`), so clearing a rule's answer by hand sticks;
- one rule answers it with no merchant/card conflict (`card_coding_rule_match`);
- the rule's account is active in the source's current QuickBooks chart;
- for a bank-feed row, the transaction type can be read (`card_coding_infer_treatment`, a mirror of
  `inferTreatment()` in `v2/transaction-dates.js`; a parity test runs both over every case).

Anything else is left exactly as it was and counted by reason (`changed`, `no_connection`,
`account_unavailable`, `needs_type`, `not_saved`, `refused`). The limit counts rows categorized, not
rows looked at, so a permanently skipped row never hides the ones after it. The function is
service-role only. The scheduler's answer carries counts only (`rules: {applied, skipped, more}`),
and the workflow's JSON summary repeats them; a failure or a database without the function reports
nothing and never stops preparation. A row categorized this way has `coding_source = 'rule'`, its
`rule_id`, no `updated_by`, and a `finance_audit_events` row with no actor.

To switch it on: apply the migration, then deploy `card-coding-prepare-scheduled`. Either order is
safe. To stop it for one account, switch `auto_prepare_coding` off. Approval and sending are
unchanged and still need a person.
