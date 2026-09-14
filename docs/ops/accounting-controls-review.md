# Accounting controls review — before connecting production banks

Reviewed 2026-09-14 against `main` at `6401f21` (after #690). Scope: the five
control areas below, traced through the migrations, the posting edge function,
the Plaid ingestion handler and the finance pages. Evidence is separated into
**source inspection**, **executed locally** (PGlite runs of the committed SQL,
the workflow's own unit suites) and **live** (nothing live was run: no QBO,
Plaid or Supabase write was performed for this review).

Verdict in one line: **the approval → posting → recovery chain is strong and is
proven by executing the committed SQL; there is no period lock and no bank
reconciliation anywhere in SILO, and both are policy decisions rather than
bugs.** One confirmed defect was fixed in the same PR (CI on `main` had been red
since #684). The section "Next bounded PRs" is the recommendation.

## 1. Opening balances and historical records

**Exists.** `seed_accounting_from_qbo` / `accept_accounting_opening_balances`
(`20260912231606`), `archive_qbo_ledger` (`20260913022606`), Books & setup page.

| Property | Where enforced | How verified |
|---|---|---|
| Balanced | seed refuses `debits <> credits` and ties both sums to the provider's single `GrandTotal` row | source; executed: synthetic TB seeded and accepted, a re-seed after acceptance refused |
| Tenant-scoped | every RPC reads `active_company_id()`; the report run, its connection and every account must belong to that company; `accounting_opening_balances` is `unique(company_entity_id)` | source; `accounting-foundation-database` suite (tenant/permission cases) |
| Dated correctly | `Header.EndPeriod` must equal the run's `end_date`; `accounting_start_date = cutoff + 1`; the history archive requires `gl.end_date < accounting_start_date` and a TB at the same end date | source |
| Duplicate imports | one baseline per company; accepted baseline immutable; `qbo_history_imports` unique on `(company, connection, source_hash)`, retry returns the existing id; `UPDATE/DELETE/TRUNCATE` denied by trigger even for service role | source; both DB suites |
| Provenance | full GL/TB JSON, params, fetch times, realm and account context copied into the snapshot; no FK to credentials or the report cache | source |

**What SILO retains if QBO disconnects:** the seeded chart (`accounting_accounts`,
a snapshot at import, not a live mirror), the accepted opening trial balance,
every archived GL/TB window (`qbo_history_*`), every stored report run
(`quickbooks_report_runs.raw_response`), every posted journal's exact payload
and readback (`quickbooks_journal_postings`), and the card/bank transaction
ledger with its approval snapshots. All of it is readable with the connection
inactive — the RPCs and pages that read it never call QBO.

**What still needs live QBO:** `/v2/qbo-reports.html` (every report fetch and
JE drill-down), `/v2/cash-forecast.html` and `/v2/cashflow.js` liquidity
(live Balance Sheet for facility balances), the Books & setup TB fetch and the
history archive fetch (both can also use a stored run), `/v2/schedules.html`'s
balance lookup, and — by design — posting itself. Nothing in SILO computes a
trial balance or a GL from its own rows; the journal register is a source
register, not a ledger. That is documented in `accounting-foundation.md` and is
still true.

**Not verified:** a real Test Company seed against sandbox QBO (the seed RPC has
only been exercised on the synthetic flat/nested fixtures and, per
`qbo-history.md`, live reconciliation was not completed for the history PR).

## 2. Reconciliation

**Does not exist.** Executed against the committed schema: the only columns
matching `cleared|statement|reconcil` are `qbo_history_imports.reconciliation`
and `reconciliation_status`, which is the GL-vs-TB *tie-out of an archived QBO
report*, not a bank reconciliation. `plaid_accounts` holds a point-in-time
provider balance (`current_balance`, `available_balance`, `balance_updated_at`),
never a statement beginning/ending balance. There is no cleared flag on
`card_transactions`, no outstanding-items list, no reconciliation adjustment
type and no record of a period being reconciled.

What exists and is often mistaken for reconciliation:

- **Transaction coding** (Transactions page): every bank/card row gets an
  account, a treatment and a review; approval freezes it. This is coding, not
  a comparison against a statement.
- **Provider change exceptions** (`plaid_sync_exceptions`): a modified/removed
  row after approval is quarantined and needs a reasoned resolution or a posted
  correction. This is change control on the feed, not a statement tie-out.
- **QBO history tie-out**: closing balances of an archived GL window against
  the TB at the same date. This proves the archive copied QBO faithfully; it
  says nothing about the bank.

Today the only reconciliation of a bank account is QBO's own Reconcile screen,
after SILO has posted. That is a workable interim control while QBO is the book
of record, and it is the reason "one reconciled month" cannot yet be proven
inside SILO.

## 3. Period locks

**Do not exist at any layer.** Executed against the committed schema:

- No table, column or function named for a period, lock or close (the only
  matches are `qbo_history_imports_period`, an index, and
  `plaid_lock_financial_account`, an advisory lock for concurrency).
- `approve_card_import_batch` accepted a batch whose `entry_date` was
  **2019-01-31** on a batch whose period is August 2026, and froze that date
  into the approval snapshot's `TxnDate`.
- With opening balances accepted as of **2026-08-31** (Silo start 2026-09-01),
  `approve_journal_adjustment` accepted an adjustment dated **2026-03-15**.
  Nothing relates an entry date to `accounting_start_date`, and the accepted
  baseline cannot be re-seeded, so a backdated post silently makes the
  immutable baseline disagree with QBO's TB at that date.
- The Transactions page and the JE composer only require that a date is set.
  `entry_date` is client-supplied on insert for both card batches and
  adjustments, and is editable while the row is draft/categorized.

What *is* enforced, and is not a period lock: an approved or posted row's
`entry_date` cannot be changed by a client (RLS `USING` requires draft status;
executed: 0 rows affected on both tables), so a frozen date stays frozen.
QBO's own closing-date control still applies to whatever SILO posts.

This is a policy gap, not a bug: who may close a period, whether the lock
mirrors QBO's closing date or `accounting_start_date`, and what a late bank
item does when its month is closed (today `plaid_open_monthly_batch` dates a
continuation batch at the original month end, i.e. it backdates by design) all
need Blake's decision before any enforcement is written. See "Next bounded PRs".

## 4. Audit and posting integrity

**Exists and holds.** All of the following were verified by executing the
committed SQL, not only by reading it (`finance-v1-database` 26 cases,
`plaid-bank-feed-database` 33 cases, plus the probe recorded here).

| Control | Mechanism | Executed evidence |
|---|---|---|
| Immutable approval snapshot | approval RPCs build the QBO payload server-side and store `approval_snapshot` + sha256 `approval_hash`; RLS forbids client updates once status leaves draft; `plaid_guard_transaction` freezes child rows for every role once the batch is approved | 0 rows affected updating an approved batch/adjustment as finance; suite case "approved snapshot survives source-config changes" |
| Client cannot forge state | INSERT/UPDATE `WITH CHECK` pins `status` to draft/categorized and approval columns to null; no client write policy on `quickbooks_journal_postings` | draft → approved by direct UPDATE refused; INSERT into postings refused |
| Balanced entries | adjustments: debits must equal credits to the cent; card batches: the balancing line is generated from the coded net | unbalanced adjustment refused |
| Tenant isolation | composite `(id, company_entity_id)` FKs on source → batch → transaction → connection; every RPC filters by `active_company_id()`; the posting function loads parent and connection with the company filter | suite case "composite company constraints reject cross-tenant parents and QBO connection" |
| Duplicate posting | partial unique index on `(company, source, source_ref)` for `submitting/unknown/posted`; deterministic `SILO-<hash>` DocNumber; retry searches QBO by DocNumber before any new POST | second active claim refused by `uq_quickbooks_postings_active_claim` |
| Uncertain QBO outcome | network error, 408/429/5xx, missing id, or local persistence failure leaves the claim `unknown`; release requires zero DocNumber matches **and** an operator note; a confirmed `posted` claim is never released automatically | `finance-v1-controls` / `finance-v1-posting-handler` suites (mock IO); recovery paths not exercised live |
| Reversals and corrections | `void_journal_adjustment` / `void_card_posting` require a reason, record it on the posting row, return the parent to approved; reopen requires a reason and refuses while a claim is active; a posted bank contribution changed by the provider needs a posted same-connection correction linked to the exception | reopen while an `unknown` claim stands refused; suite cases 25, 29, 32 |
| Audit trail | `finance_audit_events` append-only via trigger, with INSERT/UPDATE/DELETE/TRUNCATE revoked from service role too; every finance table fires it with the actor | UPDATE as finance and DELETE as service role both refused |

Two observations that are not defects but should be known:

- `void_card_posting` (`20260831220000`) is looser than its adjustment sibling:
  no `FOR UPDATE`, no connection or payload-hash check, no `recovery_note`. The
  V1 unique claim index makes the `LIMIT 1` unambiguous and a posted batch
  cannot be re-approved without a void first, so it cannot release the wrong
  row today. Worth aligning when the void path is next touched.
- `plaid-core.mjs`'s `normalizeTransaction` is exported and unit-tested but is
  **not called by the ingestion handler**; every lifecycle and currency check
  that matters runs in `plaid_project_transaction` (SQL), which the DB suite
  covers (missing `pending` rejected, non-USD excluded). The JS test gives no
  assurance about ingestion; do not cite it as such.

## 5. Bank-feed boundaries

**Exists and holds** (source inspection of `plaid-finance/handler.ts`,
`plaid-core.mjs`, the Plaid migration; executed via the DB suite and the
handler suite with synthetic IO).

- **Pending / posted / removed:** decided in SQL from the provider payload; a
  missing or non-boolean `pending` fails the sync rather than defaulting to
  posted. Pending and removed rows are excluded and cannot be approved; a
  pending → posted replacement links through `pending_transaction_id` and
  retires the pending row. Removal after approval becomes an exception.
- **Cursor and retries:** a `/transactions/sync` cycle is paginated to
  `has_more = false` (50 pages, 20,000 changes, 115 s budget) before one
  atomic `plaid_apply_sync` commits rows and cursor; `MUTATION_DURING_PAGINATION`
  restarts from the original cursor up to twice and discards partial pages;
  the RPC rejects a stale expected cursor or an expired/foreign lease. A lost
  response after commit is safe to retry. An oversized cycle never advances the
  cursor — fail-safe, but a permanent stall until the limit is reviewed.
- **Transfers and card paydowns:** `plaid_guard_batch` refuses approval unless
  transfer/payroll/Shopify settlements hit an Other Current Asset/Liability
  clearing account and a `card_payment` is coded only on the bank leg to a
  Credit Card/AP account; the card feed's payment leg cannot post again.
  Treatment `unknown` blocks approval.
- **Forecast vs ledger:** `cash_forecast_items` / `cash_forecast_overrides`
  are separate tables with their own validation trigger; `cashflow.js` writes
  only to those two tables (grep of every `.insert/.update/.rpc` call). No
  forecast row can reach a journal.

**Not verified:** a live Plaid item beyond what the Test Co scheduled sync has
already shown; the 115 s budget and `sync_restart_limit` paths end-to-end; the
handler leaving a lease to expire when `plaid_release_sync` itself throws
(safe for the ledger, blocks re-sync for five minutes).

## Confirmed defect fixed in this PR

**CI on `main` was red on every push since #684.** `sync-tests.yml`'s
finance-database job runs `plaid-bank-feed-database.test.mjs`, which executes
every `verify_v2_schema.sql` check from the Plaid marker to the end of the
file. #684 (profiles scope) and #686 (cashflow overrides) appended checks after
that marker without applying their migrations in the harness, so the check
returned `MISSING: shares_active_company helper` and the job failed
(run 34747175664 and every one before it back to #684). Production is **not**
missing those migrations — the drift check's only failing row is the
pre-existing insert-stamp trigger finding recorded in CLAUDE.md. The harness
now applies `20260904310000_cash_flow_forecast.sql`,
`20260913054723_profiles_active_company_scope.sql` and
`20260913062551_cashflow_overrides_liquidity.sql` (twice, like the others) with
`btree_gist` loaded for the override exclusion constraint. Mutation: removing
the profiles migration from the list reproduces the failure exactly.

## Next bounded PRs (recommendations, not built here)

1. **Period lock.** One `accounting_periods` row per company with a
   `locked_through` date set by a finance user with a reason (audited), plus a
   floor of `accounting_start_date - 1` once opening balances are accepted.
   Enforce in `approve_card_import_batch`, `approve_journal_adjustment`, the
   `plaid_guard_new_posting_claim` trigger and the draft RLS `WITH CHECK` on
   `entry_date`, so no UI path matters. Decisions needed first: whether the
   lock mirrors QBO's closing date; what a Plaid continuation batch does for a
   locked month (today it backdates to month end); whether reopen may cross a
   lock. Roughly one migration, one DB suite, two page changes.
2. **Bank reconciliation.** Per mapped account and statement period: statement
   beginning/ending balance entered by a person, cleared flags on
   `card_transactions` (posted, USD, in the approved batch), outstanding-item
   list, difference to zero, and a `reconciled_at/by` record that a later
   period lock can require. The provider balance already on `plaid_accounts`
   is a hint, never the statement. This is the module that lets SILO prove one
   reconciled month itself; until it exists the proof is QBO's Reconcile
   screen for the account SILO posted to.
3. **Void path alignment** (small): give `void_card_posting` the same lock,
   connection/hash binding and `recovery_note` as `void_journal_adjustment`.

## Remaining blockers to proving one reconciled month

- No reconciliation record in SILO (item 2 above); the proof lives in QBO.
- No period lock, so a reconciled month can be changed by a backdated entry.
- Live acceptance gates still open from earlier PRs: Test Company seed of
  opening balances against sandbox QBO, a live GL/TB archive window, and the
  first production Plaid account's cutover and first batch review.
