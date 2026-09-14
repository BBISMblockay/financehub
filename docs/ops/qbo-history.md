# QBO historical ledger archive

## Purpose and boundary

Books & setup → QBO history retains GeneralLedger report detail in Silo before a
future QBO disconnect. It is a read-only historical reference, separate from the
accepted opening trial balance, journal register, bank-feed transactions and QBO
posting. Importing or replaying history never creates journal adjustments or
outbound postings. QBO remains the book of record in this phase.

This is **not a complete QBO backup or a disconnect-readiness check**. Invoice and
bill documents, payment applications, attachments, bank reconciliations and an
independent Silo ledger are later work. Matching GL closing balances to a trial
balance cannot prove that offsetting omitted lines or every source document were
retained. The UI says this even when all account checks match.

## Existing path, new storage

1. Prepare accounting settings and account identities with the existing QBO seed.
2. Choose a window before `accounting_start_date`, up to 366 days inclusive. Use
   smaller windows if QBO times out or returns a report too large to process.
3. The browser calls existing `quickbooks-report` sequentially for unfiltered
   `GeneralLedger` and same-end-date `TrialBalance`, both bound to the settings'
   exact QBO connection. TB starts at the configured fiscal-year start.
4. `archive_qbo_ledger` accepts only the two stored report IDs. Under finance auth,
   active-company isolation and a company-row lock it re-reads settings and reports,
   checks provider headers, currency, basis, dates, columns, filters and TB totals,
   then atomically saves copied evidence, normalized browse rows and reconciliation.
5. Select one saved snapshot to browse its lines and account checks. Saved views
   query Silo only; a disconnected QBO connection does not prevent reads.

The RPC copies the full GL/TB JSON, request params, fetch timestamps, realm ID and
Silo account context into `qbo_history_imports.source_snapshot`. No credentials are
copied. Snapshot provenance UUIDs deliberately have no FK to connection credentials
or the report cache. `qbo_history_lines` uses an import/company composite FK.
Both tables have finance/company RLS, SELECT-only browser grants, and triggers
rejecting UPDATE, DELETE and TRUNCATE, including through service clients. The
import header insertion records the current user in the finance audit trail.

Each snapshot is independent. Overlapping date windows and reports fetched again
are separate versions; they are never summed into Silo books or with each other.
Retrying the same source snapshot and account context returns its existing ID.
A refreshed QBO report may produce a new snapshot; the old evidence is not rewritten.
If a response is lost after saving, refresh saved history before fetching again.

## Provider shape and reconciliation

Use QBO's default GL columns, identified by `ColKey`, not display-name heuristics:
`tx_date`, `txn_type`, `doc_num`, `name`, `memo`, `split_acc`, `subt_nat_amount`,
`rbal_nat_amount`. Preserve raw rows and natural amounts/balances, not fabricated
transaction-level debit and credit lines. Account types from the frozen Silo chart
context normalize ending balances to debits minus credits for the TB comparison.

Nested account sections are walked in provider order. A headerless section holding
a parent's own rows inherits its ID. A named group without an ID never inherits an
ID and is only a container for identified children. Parent totals are checked
against child totals but never inserted as transactions or account balances.
Beginning balances stay separate from movement rows. A blank period total is zero;
missing/malformed columns, invalid numbers, mixed grouped/direct rows and duplicate
account sections fail atomically instead of silently dropping detail. Same QBO
transaction IDs on multiple GL lines are preserved; identity is the source ordinal.

### Number formats and blank amounts (20260914220000)

QBO writes fractional amounts without a leading digit: `.00`, `.44`, `-.67`. The
first archive migration required a digit before the point and rejected every real
report with `Invalid ledger movement` (the trial balance parser would have failed the
same way one step earlier on a `.44` balance). Since `20260914220000` every numeric
cell in both reports goes through one parser, `qbo_report_number(value, context)`:
an optional sign, then digits with an optional fraction, or a fraction alone. The
value is cast to `numeric` exactly as written, so precision is never rounded.
Thousands separators, exponents, currency symbols, whitespace, a trailing point and
anything else still fail the whole import with
`Unsupported number format in <cell> at row <n> of account <QBO id>` — the cell,
the ordinal within that account's section and the account id, never the value.
That message is distinct from the connection, date, coverage and column messages,
so an operator can tell a formatting problem apart without reading the report.

Blank movement cells were investigated against a stored 366-day production report
before this rule was written (aggregates only, nothing copied): 41 of 36,778 data
rows had an empty amount, every one on a Payment or Journal Entry line, every one
with a running balance identical to the prior line, and none with a missing `value`
key. That is QBO's rendering of a zero-value line ($0 payment application, zero
journal line). The archive therefore treats a blank amount as zero **only when the
row's running balance equals the balance carried in** from the prior line (the
beginning balance, or zero for an account with no beginning-balance row). The row is
kept as a line with `natural_amount = 0` and its raw row intact, and the account's
reconciliation entry counts it in `blank_amount_rows` (the RPC result carries the
total). A blank amount beside a running balance that moved is ambiguous and fails
the import: `Blank ledger amount with a changed running balance at row <n> of
account <id>`. A cell with no `value` key at all, a blank running balance and a
blank trial balance grand total are shape failures, never zeros. Blank rows still
count toward the period total and the running-balance chain, so a blank that hid a
real movement would surface as `movement_total_mismatch` or `running_balance_gap`
like any other row.

**Row kinds.** `qbo_history_lines.row_kind` is `opening` (a Beginning Balance row),
`transaction` (a line that moved the account) or, since `20260914220000`,
`zero_amount` (a line whose amount is zero, whether blank or written `.00`; the
same report had 685 explicit `.00` lines beside the 41 blanks). A zero line is
retained for audit, the running-balance chain, the period total and the
reconciliation, and it counts in `transaction_count` and in `zero_amount_rows`, but
the card categorizer's evidence read filters `row_kind = 'transaction'`
(`supabase/functions/card-categorize/index.ts`), so a zero-dollar journal line or
payment application can never be the only "history" that steers a merchant to an
account. That exclusion lives in the stored kind, not in the Edge Function, so no
deploy is needed and a future reader of the archive gets the same distinction. It
is also a stored invariant: the CHECK `qbo_history_lines_transaction_nonzero`
refuses any `transaction` row with a zero amount, even from a service-role write.
Adding that CHECK is the migration's compatibility proof for archives saved before
it: if a zero-amount `transaction` row already existed anywhere, the `ALTER` would
fail and the migration would stop before re-creating the RPC. That is deliberate.
Do not delete the row to get past it (the tables are immutable by design); it needs
a reviewed compatibility migration that reclassifies the row with the immutability
trigger disabled for that statement and re-enabled after. When this migration was
written production held no archives at all, and the original RPC never accepted a
blank amount, so the case is empty; the constraint keeps it that way.

**Summary cells.** Only a PRESENT empty string in a section's period total or a
group's total means zero. A missing `value` key or a JSON null there fails the
import (`Period total cell is missing for account <id>` / `Ledger total cell is
missing in grouped ledger total for <id>`), the same shape rule the movement,
running-balance and trial-balance cells follow.

Stored exceptions include running-balance gaps, missing transaction references,
period-total disagreement, GL/TB closing disagreement, missing accounts on either
report and account sections with no lines. A TB account absent from GL is an
exception even if its closing balance is zero. No fuzzy/name-based account mapping
or automatic adjustment is attempted. Accounts absent from the saved Silo chart
stop the import and require chart reconciliation first.

## Delivery and validation

Migrations, in order: `20260913022606_qbo_historical_ledger.sql` (tables, RLS, the
RPC) after accounting foundation, then `20260914220000_qbo_history_number_formats.sql`
(the shared number parser and the re-created RPC). Both are additive; the second
never edits the first. No Edge Function change or deployment is required. Apply only
the new migration following review, not the historical `apply_all_post_merge.sql`
bundle. The PR does not apply it, disconnect QBO, post a journal or alter source
posting switches.

### Deploying the number-format fix and retrying the import

1. Merge the PR. `deployment-drift-check.yml` goes red on the next run because
   `verify_v2_schema.sql`'s `QBO history number formats` row reports STALE until the
   migration is applied. That red is the reminder, not a fault.
2. In the Supabase SQL editor, run the full contents of
   `supabase/migrations/20260914220000_qbo_history_number_formats.sql` once. It is
   idempotent (`create or replace`), so a second run changes nothing.
3. Run `supabase/verify_v2_schema.sql`. `QBO history number formats`, `QBO history
   import RPC` and `QBO history retention and audit` must all read `ok`.
4. Retry from Books & setup → QBO history with the same window. The browser fetches
   a fresh GL/TB pair (the earlier fetches were stored but never archived, and
   nothing references them), then calls the RPC. A report that failed on
   formatting now saves; a report that still fails names the cell, row ordinal
   and QBO account id in the status line. Nothing is written on failure, so a
   retry is always safe.
5. Confirm the saved snapshot's transaction count and exception list against QBO
   for a small window before relying on a large one. `blank_amount_rows` in the
   reconciliation shows how many zero-value lines were settled from the running
   balance.

Known next stop: the stored Baseballism reports (both the 366-day and the
one-month window fetched on 2026-09-14) contain a `Not Specified` section, QBO's
group for lines with no account, which the archive refuses as an unidentified
section (`Unsupported or duplicate ledger account section; raw report remains
available`). That refusal is by design and is not a number-format problem; see
`docs/ops/bugs.md` for the shape and the decision it needs. A window whose report
has no such section archives normally once this migration is applied.

Snapshot supersession (choosing the newest of overlapping windows for browsing)
is a separate follow-up recorded in `docs/ops/bugs.md`; this fix does not change
how snapshots are listed or selected.

Local tests (the database suite reproduces the leading-decimal rejection against
the original SQL before applying the fix, then covers positive and negative
fractions, zero, blank amounts corroborated and contradicted by the running balance,
missing cells, malformed formats, totals, running balances, precision and atomic
rollback):

```sh
node scripts/tests/qbo-history-database.test.mjs
node --test scripts/tests/qbo-history-ui.test.mjs
node scripts/tests/plaid-bank-feed-database.test.mjs
```

The synthetic GL fixture preserves observed provider structure (nested accounts,
headerless parent rows, a named container with no ID, beginning balances and blank
zero totals), with invented account labels, IDs and values. Database tests execute
the real RPC; UI tests drive the actual fetch → archive → browse handler. Existing
finance/approval/posting/Plaid regressions remain required. The Plaid database suite
executes the appended verifier blocks in its local PostgreSQL fixture.

**Live acceptance remains a Test Company-only gate after review and migration:**
verify active tenant and source report ownership, save a small window, inspect
references and exceptions against QBO, retry the stored report pair, and verify
counts in opening balances/journals/posting logs remain unchanged. Review both
themes and mobile layout on the deployed/approved preview page. Do not disconnect
a live company to test retention; local tests prove cached-report removal and
inactive connections leave archived data readable. Automatic approval review
blocked further live report reconciliation during PR preparation because it
flagged the report IDs' tenant scope; no live reconciliation success is claimed.
