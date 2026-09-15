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
   then works through the ledger as a **job the browser drives with repeated calls
   of the same RPC**, each bounded to a few thousand rows and a few seconds (see
   "Bounded archive" below). The page shows rows checked so far; nothing is saved
   until the last call atomically writes the copied evidence, the normalized browse
   rows and the reconciliation. An unfinished job can be resumed from the page
   without a new QBO fetch.
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

## Bounded archive (20260915000000)

### What failed, measured

Both production imports on 2026-09-14 (2025-08-01..2026-07-31, 36,778 data rows,
and the reduced 2026-01-01..2026-07-31 window) fetched their reports and then timed
out inside `archive_qbo_ledger`. Reproduced on a real PostgreSQL 16 server with
synthetic reports in the production shape (`scripts/tests/qbo-history-benchmark.mjs`,
generator `scripts/tests/fixtures/qbo-ledger-generator.mjs`: nested accounts, a
headerless child holding a parent's own rows, a named group without an id, beginning
balances on balance-sheet accounts, leading-decimal amounts, blank and explicit-zero
lines, a trial balance that ties):

| data rows | original RPC, one call | a second session wanting the company row waited |
|---|---|---|
| 1,000 | 1.4 s | 1.1 s |
| 2,000 | 5.1 s | 4.8 s |
| 4,000 | 19.7 s | 19.1 s |
| 8,000 | 77.9 s | 79.2 s |
| 16,000 | 431 s | — |

Time quadruples per doubling. The RPC appended every staged line to one growing
`jsonb` value (`staged := staged || jsonb_build_array(...)`); each append copies the
whole array, so the cost is the sum of ever-larger copies. The 8 s ceiling is crossed
near 2,500 rows, which is why the reduced window failed too, and the full-year
report extrapolates to roughly half an hour. While it ran it held the company row
`FOR UPDATE`, so any other finance write for the company (approvals, postings,
another archive) blocked for the whole run.

### Why the 55 s function timeout did not help

Production carried a hand-applied `ALTER FUNCTION archive_qbo_ledger SET
statement_timeout = '55s'` while `authenticated` stays at 8 s. Measured on the same
server, under the transaction shape PostgREST uses (`BEGIN; SET LOCAL ROLE; SET LOCAL
statement_timeout` from the role's settings; `SELECT rpc()`): a function declared
with `SET statement_timeout = '10s'` is cancelled at the role's limit exactly like a
function without it, even though `current_setting('statement_timeout')` inside it
reports 10 s. Postgres arms the timer when the top-level statement starts; the
function's own SET is applied when the function is entered, after that. The
effective ceiling for the RPC is therefore the role's 8 s, always. The repository
records no such setting, and `20260915000000`'s `create or replace` replaces the
function's configuration, so applying it removes the ineffective override rather
than leaving unrecorded drift. `verify_v2_schema.sql`'s `QBO history bounded
archive` row goes STALE if one is ever put back.

### How it works now

**Two phases are not row-bounded, and that is why there is a ceiling.** The
per-call budget governs row processing. Freezing and hashing the source cannot
be resumed part-way, and the final copy must be one statement pair in one
transaction: the evidence tables are immutable by trigger, so there is no
"incomplete" flag to set and clear, and a half-copied import would read as
whole to the card categorizer. Both grow with the report. Measured longest
single call:

| data rows | 36,778 | 80,000 | 100,000 | 120,000 | 150,000 |
|---|---|---|---|---|---|
| longest call | 2.5 s | 3.3 s | 3.6 s | 5.2 s | 6.9 s |

So a job refuses before any work when the report exceeds **100,000 ledger rows**
(longest call measured 3.6 s, a 2.2x margin under the 8 s ceiling) or **8 MB**
of stored JSON, the byte check first because it is free and screens an absurd
document out before the counting pass. **Both ceilings are needed and either
can bind first**: a sparse ledger reaches 100,000 rows while still small, and a
ledger with long memos reaches 8 MB while still short. The refusal names the count and says to
archive the period in parts, which is what this runbook already tells an
operator to do with a report too large to process. Nothing is truncated and no
row is skipped: the archive covers the window completely or refuses it and says
why. Baseballism's full year is 36,778 rows, comfortably inside. The ceiling is
settable (`silo.qbo_archive_max_rows`) for tests; raising it risks a timeout on
that import, never a partial archive.

**Where the 8 MB comes from, and why the guard runs first.** Hashing the
snapshot is the largest piece of the unbounded setup, and it is worse than
linear in the document's size. Measured on the same PostgreSQL 16:

| stored general ledger | byte check | row count (the guard) | build + sha256 the snapshot |
|---|---|---|---|
| 2.1 MB / 40,040 rows | 0.6 ms | 0.13 s | 0.33 s |
| 7.7 MB / 150,040 rows | 0.6 ms | 0.55 s | 1.21 s |
| ~15.5 MB | 0.6 ms | — | 7.10 s |
| ~23 MB | 0.6 ms | — | 9.27 s |
| ~31 MB | 0.6 ms | — | 21.1 s |

Two things follow. First, the byte ceiling has to be about 8 MB: 7.7 MB is the
largest document measured to hash comfortably inside the budget, and by 15.5 MB
the hash alone is 7.10 s against an 8 s timeout. A more generous limit would
admit documents the setup cannot finish, which is the work this guard exists to
bound. Second, the guard has to run BEFORE the snapshot is built and hashed: a
guard standing after the hash would let an oversized report be copied and
sha256'd straight through the timeout and be cancelled, and the operator would
see a cancellation rather than the refusal telling them to archive the period
in parts. Running the byte check first costs 0.6 ms. `verify_v2_schema.sql`
asserts the ORDER, not just that the guard exists. Both ceilings are settable
(`silo.qbo_archive_max_rows`, `silo.qbo_archive_max_bytes`) for tests; raising
either risks a timeout on that import, never a partial archive.

Re-archiving the same two stored report runs is answered from their ids before
any of this, so a period that is already archived returns its existing import
without rebuilding the snapshot and is never refused as too large. A re-fetch
of the same period produces new run ids, and the hash comparison after the
snapshot is built still recognises it as identical content.

The archive is a job (`qbo_history_jobs`) with two staging tables
(`qbo_history_staging_sections`, `qbo_history_staging_lines`). Every call of
`archive_qbo_ledger(gl, tb)` is bounded: at most 5,000 ledger rows or about 3 s
of work, whichever comes first (session settings `silo.qbo_archive_batch_rows` /
`silo.qbo_archive_batch_ms` override the budget in tests).

- **First call.** Everything the single-call RPC validated is validated up front:
  finance auth, company lock, settings, report ownership and connection, headers,
  currency, basis, dates, filters, columns, trial balance totals, and every grouped
  section's tie to its children. The frozen source snapshot and its sha256 are
  stored on the job; each leaf account section is staged in provider order. Then
  rows are processed until the budget is spent.
- **Every call.** Resumes the first unfinished section from the row it stopped at
  (running balance, movement, beginning-balance and reference flags, blank and zero
  counts are persisted per section), inserts normalized lines into staging, and
  returns `{status:'in_progress', rows_done, rows_total, sections_done,
  sections_total}`. The page shows that progress. Retrying with the same two stored
  reports resumes the same job; a resume does not rebuild or re-hash the snapshot.
- **Last call.** Cross-checks trial balance accounts absent from the ledger, inserts
  the immutable import header and copies every staged line into
  `qbo_history_lines` in one set-based statement, empties the staging rows, marks
  the job complete and returns `{id, status:'complete', ...}` -- the result shape
  the page always used.

Measured on the same idle server with the same fixtures (calls are sequential;
elapsed includes a psql round trip per call). Every call, including the heaviest
last one, sits well under the 8 s ceiling:

| data rows | calls | elapsed | longest call |
|---|---|---|---|
| 1,000 | 1 | 0.2 s | 0.2 s |
| 5,000 | 2 | 0.9 s | 0.6 s |
| 36,778 | 8 | 5.7 s | 2.9 s (the last call: snapshot insert + 36,818-line copy) |
| 40,000 | 9 | 5.6 s | 2.3 s |

The local suite archives 40,040 lines in 6 bounded calls on PGlite in about 4 s.

### Completeness, evidence and failure

- **Nothing partial is evidence.** `qbo_history_imports` and `qbo_history_lines`
  receive rows only in the last call, atomically. The card categorizer reads only
  those two tables, so an in-flight or failed archive can never steer a coding
  suggestion. Finance users can read a job's progress; the staging tables are closed
  to every client role in both directions.
- **Complete or nothing.** A job completes only when every staged section has been
  checked; `transaction_count`, zero and blank counts and the reconciliation are
  accumulated across calls and stored with the import. The last call also asserts
  the archived line count equals the staged count.
- **Malformed data at any point** (the same cell-level messages as before) marks the
  job `failed` with the message, deletes its staging rows, and returns
  `{status:'failed', error}`; the failing call's own row work rolls back and the
  evidence tables were never touched. **Finalization has its own such block**: a
  constraint, trigger or storage error during the final insert and copy
  terminates the job with its reason too, rather than leaving it `running` at
  100% for the page to offer as resumable while every resume repeats the same
  failure. A retry with the same reports starts a fresh
  job and fails identically; a corrected report (a new source) archives.
- **Duplicates.** A completed source returns `{already_imported: true}` as before.
  A partial unique index refuses a second running job for one source even from a
  service-role write. Only one job per company and connection is live: starting a
  newer source abandons an unfinished older one and removes its staging.
- **Locks.** Each call takes the company row lock for its own bounded duration, so
  other finance writes wait seconds, not the length of the import.
- **Audit.** The import's `finance_audit_event` trigger now uses
  `qbo_history_audit_event()`, which records the inserted row without the
  multi-megabyte `source_snapshot` body (the sha256 `source_hash` stays in the
  event). The original trigger copied the whole snapshot into
  `finance_audit_events`, writing it twice.

Unchanged: tenant and connection isolation, the immutable evidence tables and their
triggers, the number parser and blank-amount rule, `zero_amount` rows kept out of
coding precedent, the reconciliation issue names, and the `Not Specified` refusal
(`docs/ops/bugs.md`). Snapshot supersession stays a separate follow-up.

## Delivery and validation

Migrations, in order: `20260913022606_qbo_historical_ledger.sql` (tables, RLS, the
RPC) after accounting foundation, then `20260914220000_qbo_history_number_formats.sql`
(the shared number parser and the re-created RPC), then
`20260915000000_qbo_history_bounded_archive.sql` (job and staging tables, the audit
function, the bounded RPC). All are additive; a later one never edits an earlier one. No Edge Function change or deployment is required. Apply only
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

### Deploying the bounded archive and retrying the full-year import

1. Merge the PR. `deployment-drift-check.yml` goes red on the next run because
   `verify_v2_schema.sql`'s `QBO history bounded archive` row reports MISSING until
   the migration is applied. That red is the reminder, not a fault.
2. In the Supabase SQL editor, run the full contents of
   `supabase/migrations/20260915000000_qbo_history_bounded_archive.sql` once. It is
   idempotent. It replaces `archive_qbo_ledger`'s configuration, which drops the
   hand-applied 55 s `statement_timeout` (ineffective, measured above); do not
   re-apply it. No Edge Function deploy, no secret, no catalog refresh.
3. Run `supabase/verify_v2_schema.sql`. `QBO history bounded archive`, `QBO history
   number formats`, `QBO history import RPC` and `QBO history retention and audit`
   must all read `ok`, and check 6 (company stamp triggers) stays `ok` -- the
   migration attaches the stamp trigger to its new tables.
4. Retry from Books & setup -> QBO history with the full window. The page fetches
   the GL/TB pair once, then calls the RPC repeatedly, showing rows checked; expect
   roughly 8 calls for the full-year report. If the tab is closed or the network
   drops mid-way, "Resume unfinished archive" continues from the stored reports.
5. The `Not Specified` section no longer stops the import (`20260915200000`).

## The trial balance is fiscal-year-to-date, whatever you ask for

**QBO's TrialBalance ignores `start_date`.** It reports balance-sheet accounts
as at the end date and income and expense accounts for the **fiscal year to
date**, and it echoes the requested `StartPeriod` back in the header regardless.
Measured 2026-09-15: two runs against the same end date, one asking for
`2025-08-01` and one for `2026-01-01`, returned **byte-identical rows**
(`0ebb2460535dd4f69dc885eb3c62761a`) with only the header label differing.

The consequence is a hard limit, not a bug we can fix: **only a ledger window
that begins on the fiscal year start can be reconciled in full.** A window that
crosses the boundary archives every line correctly and then disagrees with the
trial balance on every P&L account, because the ledger covers more months than
the trial balance does.

Measured on the 2025-08-01 → 2026-07-31 window (12 months of ledger against 7
months of trial balance):

| account type | accounts mismatched | absolute difference |
|---|---|---|
| Income | 35 | 16,518,388.26 |
| Cost of Goods Sold | 5 | 8,565,950.91 |
| Expense | 17 | 7,063,382.26 |
| Other Expense | 6 | 899,499.69 |
| Equity | 1 | 239,045.48 |
| Bank / AR / AP / Credit Card | **0** | **0.00** |

All 36,778 lines were archived correctly. Applying each account's debit/credit
direction, **63 of the 64 differences equal that account's own
August–December 2025 activity to the cent, residual $0.00** — the months the
trial balance does not cover. Not one balance-sheet account moved, because those
are as-at figures.

**What was done about it.** `/v2/accounting-books.html` offers the archivable
**fiscal years as buttons** (`2025`, `2024`, …), each resolving to that fiscal
year's own window.

**Only the START is constrained.** The trial balance is as-at its end date, so
any end date inside the fiscal year reconciles just as well as the year end. The
year still running therefore carries its own **Through** control, defaulting to
the day before the accounting start date and bounded by the year: a company that
has closed June but not July archives through June rather than being forced to
the latest possible day. An end date outside the year is refused by name rather
than silently clamped, because a clamped window would reconcile perfectly and
answer a question nobody asked. A completed year archives whole and ignores that
control.

**"Covered" is computed, never inferred from an overlap.** Each year reports one
of four states: *saved* (a snapshot of exactly that window, with the newest
one's exception count), *covered by other windows*, *partly saved* with the
missing dates named, or *not saved*. Coverage walks the saved windows in date
order and reports what they leave behind, so January–June plus July–December
really does cover the year while a single overlapping day leaves the rest of it
as a gap. An earlier version set the covered state from any intersection, which
would have told a reader a year was covered when eleven months of it were
missing — talking them out of the archive this control exists to offer. The window that cannot reconcile is therefore not
reachable, rather than merely refused after the fact. **The manual From/Through fields are gone.** They were the only way left to
request a window that does not begin on the fiscal year start -- that is, the
only way to reach the wall of false P&L exceptions described above. A year now
IS the request. An **Earlier years** control extends the list four at a time to
twelve, so nothing the fields could reach is lost except the windows that could
never reconcile. `windowDates()` stays as the backstop inside `archiveWindow()`,
since it is the one place that knows the archive's own limits.

**A correction worth recording.** `20260915210000` was written believing the
page's fiscal-year-start request was itself the cause, and added two checks:
`tb.start_date = gl.start_date`, and each report's `Header.StartPeriod` against
the ledger's start. The first is harmless and still true. **The second cannot
ever fire for a trial balance**, because QBO echoes whatever start date was
requested — it verifies a label, not the data, and must not be read as proof
that the trial balance covers the period it claims. See `docs/ops/bugs.md`.

## QuickBooks' `Not Specified` section

QBO groups ledger lines that have no account under a header called
`Not Specified` with no account id. Measured on the stored Baseballism reports
on 2026-09-15:

| window | leaf sections | ledger rows | sections with no account id | duplicate ids |
|---|---|---|---|---|
| 2025-08-01 to 2026-07-31 | 209 | 36,778 | 1 | 0 |
| 2026-01-01 to 2026-07-31 | 193 | 23,002 | 1 | 0 |

The section holds 24 rows in the full-year window, every one either a Journal
Entry for `.00` or a Payment with a blank amount reading `Created by QB Online
to link credits to ...`. **Not one row carries an amount.** These are records
QuickBooks generates to link credits; nobody can assign them an account, so
refusing the import over the section made that window permanently unarchivable.
The `duplicate` half of the old message was never involved -- both windows have
zero duplicate account ids.

**What happens now.** The section is archived, not skipped. Every row is kept
and readable under the account id `silo:unattributed`, which cannot collide with
a QuickBooks id (those are numeric), with `account_type` `Unattributed` and the
section's own name. It appears in the reconciliation under its own issue,
`unattributed_ledger_section`, with a null difference because it has no trial
balance counterpart.

**What still refuses, and why it is four cells and not one.** The placeholder
has no trial-balance counterpart, so the comparison is skipped for it -- which
means whatever admission lets through is never checked against anything again.
Admission is the only test this section ever faces, so it requires all four of
these to be present and blank or zero:

| cell | what the provider is claiming |
|---|---|
| each row's `ColData[6]` | the amount that moved on that line |
| each row's `ColData[7]` | the running balance after that line |
| `Summary.ColData[6]` | the section's total movement for the period |
| `Summary.ColData[7]` (`rbal_nat_amount`) | the section's ending balance |

Each is a separate claim and none implies the others. Any of them non-zero fails
the whole import, naming what it found. That is a bookkeeping problem for a
person to fix in QuickBooks, and filing it under a placeholder would be exactly
the silent mis-attribution this archive exists to prevent. Nothing is truncated
and no row is dropped on either path.

Neither narrower version is sufficient, and neither gap is theoretical. A
`Beginning Balance` row carries a blank amount and a real running balance, so an
amounts-only test admits a section with a $250 closing balance, never compares
it to anything, and reports `matched`. And a section can report zero movement in
`Summary.ColData[6]` while reporting a balance carried out in
`Summary.ColData[7]`, so checking the period total does not vouch for the
balance. On a real account both surface as a `trial_balance_mismatch`; here
nothing downstream looks at them.

**A blank running balance reads as zero here, and only here.** Once admission
has established that every amount and every balance in the section is blank or
zero, a blank balance cell is a zero QBO did not bother to print. On a real
account it stays a hard refusal, because there it is a figure that went missing.
This matters: of the seven stored windows, four carry exactly one row with both
cells blank, and they failed on `Missing running balance` rather than on the
account-less section -- so archiving the section without this would have fixed
the one window that was reported and left the others refusing with a different
message.

| window | rows | blank amount | blank running balance |
|---|---|---|---|
| 2025-07-31 to 2026-07-31 | 26 | 13 | 1 |
| 2025-08-01 to 2026-07-31 | 24 | 12 | 0 |
| 2026-01-01 to 2026-07-31 | 14 | 7 | 1 |
| 2026-01-01 to 2026-09-01 | 15 | 8 | 0 |
| 2026-01-01 to 2026-09-03 | 15 | 8 | 1 |
| 2026-01-01 to 2026-09-14 | 16 | 8 | 0 |
| 2026-07-01 to 2026-07-31 | 2 | 1 | 1 |

Across all seven, amount and running balance cells are only ever `''` or `.00`,
the period total is always `.00`, the section ending balance is always `''` (a
present, blank cell in all 14 stored sections), and every row carries a
transaction id and an in-window date -- so none of the admission tests above
refuses the real report.

**One judgement call.** The `unattributed_ledger_section` notice does not
increment `exception_count`, so an otherwise clean archive still reads
`matched`. The section is provably zero by the admission test, so the books tie
either way, and an exception that fires on every archive forever is a signal
people stop reading. **The exemption is the notice, not the section:** every
other problem on it -- a running balance gap, a period total that disagrees, a
row with no transaction reference -- is counted exactly as it would be on a real
account. A blanket exemption would let a real mismatch there sit behind an
archive that still reported `matched`.

Snapshot supersession (choosing the newest of overlapping windows for browsing)
is a separate follow-up recorded in `docs/ops/bugs.md`; this fix does not change
how snapshots are listed or selected.

Local tests (the database suite reproduces the leading-decimal rejection against
the original SQL before applying the fix, then covers positive and negative
fractions, zero, blank amounts corroborated and contradicted by the running balance,
missing cells, malformed formats, totals, running balances, precision and atomic
rollback):

```sh
node scripts/tests/qbo-history-database.test.mjs          # includes a 40,000-row synthetic archive
QBO_DB_MUTATION=no-resume-state node scripts/tests/qbo-history-database.test.mjs   # must fail
QBO_DB_MUTATION=unbounded node scripts/tests/qbo-history-database.test.mjs         # must fail
node --test scripts/tests/qbo-history-ui.test.mjs
node scripts/tests/plaid-bank-feed-database.test.mjs
# timing, on a real server (not CI): PGHOST=... node scripts/tests/qbo-history-benchmark.mjs --rows 2000,8000 [--after]
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
