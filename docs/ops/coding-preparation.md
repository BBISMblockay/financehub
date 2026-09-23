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
| `card-coding-prepare-scheduled` | GitHub OIDC from `plaid-sync.yml` or `card-coding-prepare.yml` on `main` | prepare whatever `next_card_coding_work` hands it, one import per call | name a company or rows, retry dismissed work, write coding |
| `accept_card_coding_suggestions` | a signed-in finance user | save a suggestion through `apply_card_coding` after re-checking it | approve or post |

Preparation never writes `card_transactions`. A person accepts; a person approves; a person posts.

## Switching it on

Nothing below has been done by the PRs that added it.

1. Apply `20260923120000_card_coding_suggestions.sql` and
   `20260923130000_card_coding_background_preparation.sql`, then run
   `verify_v2_schema.sql` (all `ok`).
2. Deploy `card-categorize` and `card-coding-prepare-scheduled` with
   `deploy-edge-function.yml`.
3. Set the function secret `CODING_PREP_BACKGROUND_ENABLED=true`
   (`ANTHROPIC_API_KEY` is already set for card-categorize).
4. Switch on the accounts to prepare. Background preparation spends model
   calls on a company's behalf, so it is **per account and off by default**:
   `update card_sources set auto_prepare_coding = true where id = '<account id>';`
   (a finance user may do the same through the API). The Prepare button works
   on every account regardless.
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
