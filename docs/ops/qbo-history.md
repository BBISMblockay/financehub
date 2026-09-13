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

Stored exceptions include running-balance gaps, missing transaction references,
period-total disagreement, GL/TB closing disagreement, missing accounts on either
report and account sections with no lines. A TB account absent from GL is an
exception even if its closing balance is zero. No fuzzy/name-based account mapping
or automatic adjustment is attempted. Accounts absent from the saved Silo chart
stop the import and require chart reconciliation first.

## Delivery and validation

New migration: `20260913022606_qbo_historical_ledger.sql`, after accounting foundation.
No Edge Function change or deployment is required. Apply only this new migration
following review, not the historical `apply_all_post_merge.sql` bundle. The PR does
not apply it, disconnect QBO, post a journal or alter source posting switches.

Local tests:

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
