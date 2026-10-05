# SILO daily ledger

Decided with Blake on 2026-10-04: SILO keeps its own books day by day. A bank or card transaction is
in SILO's ledger the moment it is categorized and settled. Sending to QuickBooks stays monthly and
optional. It is the existing batch approval and `quickbooks-post-journal` path, unchanged.

Migration: `20261005120000_silo_daily_ledger.sql`.

## What gets recorded, and when

- **When:** at commit time, by deferred triggers on `card_transactions`, `card_transaction_splits`
  and `card_sources`. Nothing calls it, so no page or sync can forget to.
- **What:** one balanced entry per transaction, built by `silo_ledger_desired_lines()`.
  - Its lines are the transaction's split lines (or its single line) from
    `card_coding_effective_lines`, plus a balancing line on the source's account.
  - This is the same construction `approve_card_import_batch` uses for a whole batch, applied to one
    transaction. There is no second definition of a posted line.
- **Settled only:** a pending bank row records nothing. The existing bank-feed guard keeps pending
  rows excluded, and the ledger checks `provider_status = 'posted'` again.
- **Never before the books start:** a transaction is skipped if it is dated before
  `greatest(accounting_start_date, card_sources.authoritative_from)`. Those are already inside the
  accepted opening balances. With no accepted opening balances, nothing is recorded.
- **Who decides:** a saved rule, an accepted AI suggestion, or a person coding the row. Each of these
  codes the row, and coding records it. An unaccepted suggestion is not coding and records nothing.
  Applying saved rules on the server at bank sync is the next PR; today rules are applied by the
  Transactions page.

- **Only valid coding is recorded.** `silo_ledger_blocker()` runs, per transaction, the checks the
  QuickBooks approval runs:
  - active accounts, locations, customers and vendors, and the receivable/payable entity rule;
  - the balancing account and its vendor or customer, and split totals;
  - for a bank feed: USD data, a known treatment, direction, the clearing-account type (a card
    payment belongs on the card or payable account), and no open feed exception.

  A coded row that fails is **held**: nothing new is written for it, and an entry already recorded
  for it stays (a temporary problem never reverses a correct entry). On Deck shows its import as
  "needs input" with the reason (`silo_ledger_batch_status()`).
- **Held rows catch up on their own** when the problem clears (`silo_ledger_resync_held()`):
  switching a source back on or changing its QuickBooks connection, resolving or removing a bank-feed
  exception, or a chart account, location, customer or vendor becoming active (statement-level
  triggers, one resync per company per statement). Fixing the coding in Transactions records it on
  save, as before.
- A QuickBooks-posted batch, or an approved one with its snapshot, is never blocked, and is recorded
  **from that frozen snapshot**: its balancing account, location, entity and connection come from the
  snapshot's settlement line, not from the card source as it is today. (Measured 2026-10-05: the
  approved Operating batch's snapshot names a different balancing account than the source now does.)
  Posted batches from before snapshots existed (4) use the source as it is.
- **Opening balances accepted later:** accepting them, or moving `accounting_start_date`, records
  every already-categorized transaction for that company (a trigger on each table). It takes the
  company lock exclusive before it looks, so a categorization saved at the same moment is either seen
  by it or waits and is then recorded by its own save. `silo_ledger_batch_status()` also reports a
  valid categorized row that is somehow not recorded, so nothing can sit unrecorded silently.
- **Before the migration** (the page deployed first), On Deck shows categorized imports as "Not
  recorded in SILO yet" and keeps the monthly approval as pending work; nothing is called recorded.

## Corrections

The ledger is append-only. Statement-level triggers refuse any UPDATE, DELETE or TRUNCATE, the
owner's included.

- A changed transaction writes a **reversal** of its active entry plus a **new entry**.
  - Changes covered: account, amount, split, date, exclusion, removal by the bank, deletion.
  - An unchanged save writes nothing: entries are fingerprinted on the date and the accounting
    facts of each line (account, side, amount, location, entity). Descriptions are labels, so
    renaming a card or a merchant writes nothing.
  - Each entry can be reversed only once (unique index).
- **Period lock:** `set_accounting_period_lock(through, reason)` is finance-only and moves forward
  only. Nothing is ever dated on or before the lock. A correction to a locked month, or a late
  arrival for one, is dated the first open day.
- **History is frozen while an approval snapshot is live** (batch `approved` or `posted`).
  QuickBooks receives exactly that snapshot, so changing the source's balancing account, location,
  vendor or feed start does not rewrite SILO's entry for it.
  - Marking a post unposted keeps the snapshot, so it stays frozen.
  - Reopening the batch discards the approval and resyncs it to the current facts.
- **The connection is stored on each entry.** When neither the source nor the batch names a
  QuickBooks connection, the company's one active connection is used and stored, so Books → Ledger
  (which filters by connection) shows it.
- **Locking:** recording takes a per-company advisory lock shared, then the transaction's own lock
  (always in that order: the reverse deadlocked against opening-balance acceptance, which holds the
  company lock and then records rows). `set_accounting_period_lock` takes the company lock exclusive. A recording that overlaps a lock change waits, then reads the new lock. The
  lock row's upsert only ever advances the date.
- Every entry balances to the cent. The writer checks it, and a deferred constraint trigger checks it
  again, so a direct write cannot dodge it.

## Reading it

- `silo_ledger_lines_v` (security invoker) has one row per line with:
  - `signed_amount` (debit positive);
  - `in_quickbooks`: the transaction's batch is posted. Posted rows cannot change, so recording time
    is deliberately not compared with posting time; the backfill records months posted long before
    this ledger existed;
  - `quickbooks_date`: the date QuickBooks books that posted batch;
  - `qbo_connection_id`.
- Read access: finance population (`can_manage_journal_entries()` or `is_exec_or_owner()`), active
  company only. No client write grant on any ledger table.
- **Books → Ledger** now shows six columns:
  - Opening;
  - Recorded in SILO: ledger lines plus the non-transaction entries SILO posted;
  - SILO balance;
  - Not yet in QuickBooks: lines not sent, or sent on a date after the trial balance;
  - Other activity in QuickBooks: closing − opening − (recorded − not yet in QuickBooks);
  - Closing.
- A posted card batch is counted from its QuickBooks posting (what QuickBooks holds, including rows
  dated before the ledger's start), and the ledger's in-QuickBooks lines for that batch are skipped,
  so each transaction counts once. `silo_ledger_lines_v.batch_id` is what pairs them.
- Without the migration, the tab behaves exactly as before.

## On Deck

- A saved categorization is the finish line. Home and the Ready section count only transactions
  waiting to be categorized.
- A batch whose transactions are all categorized is a receipt ("Recorded in SILO").
- Preparing the monthly QuickBooks entry ("Approve QuickBooks entry") and sending it are optional and
  never pending.
- A card that does not send to QuickBooks is no longer "needs input".

## Unchanged

- `accounting_settings.books_authority` stays `'qbo'`. QuickBooks remains the system that produces
  statements; making SILO the authority is a separate decision.
- The QuickBooks push is still per import batch (monthly), through the existing approval snapshot.
  Pushing the ledger's own period totals instead is the next PR.
- Journal adjustments (schedules, fixed assets, sales journals) are not ledger entries yet. Books →
  Ledger counts them from their QuickBooks postings, as before.

## Production estimate (read-only, 2026-10-04)

- The backfill would record about 2,220 categorized transactions dated 2026-08-01 or later, across
  the operating bank feed and four card sources.
- It skips 819 dated earlier, which are already in the accepted opening balances: 804 July bank-feed
  rows and 15 Columbia CC rows.

Of the categorized rows the backfill would consider, the new validator would hold back 9 in
Operating's draft month, because their bank-feed treatment is unknown or the data is not USD. They
show as "needs input" in On Deck. Posted batches (Columbia CC, Divvy, Flex, Shopify Payable CC) are
not re-validated.

## Activation

1. Apply `20261005120000_silo_daily_ledger.sql` after `20261004120000`. It runs the backfill.
2. Run `verify_v2_schema.sql`. Three "SILO ledger" checks must read ok, and the balance check is
   CRITICAL if any entry does not balance.
3. Open Books → Ledger and check that the bank account's SILO balance matches the bank feed's balance
   as of today.

No edge function changes; no secrets.

## Tests

- `node scripts/tests/silo-ledger-database.test.mjs`: 27 checks. Mutations
  `SILO_LEDGER_MUTATION=no-start-check|edit-in-place|ignore-lock|read-ungated|cosmetic-rerecord|no-validation|posted-not-frozen|no-books-start-sync|lock-unshared|connection-not-stored|approved-not-frozen|held-reverses|no-chart-resync|no-source-resync|snapshot-ignored`
  must each fail it, and run in CI.
- `SILO_PG_CONN=... node scripts/tests/silo-ledger-concurrency.test.mjs`: two real PostgreSQL
  sessions.
  - Race 5: re-saving an already-categorized row while opening balances are accepted does not
    deadlock (mutation `txn-lock-first`, `LEDGER_RACE_ONLY=5`).
  - Race 1: recording while finance locks the month lands on the first open day.
  - Race 2: two first locks at once cannot reopen a closed month.
  - Races 3 and 4: accepting opening balances while a categorization commits, in both orders,
    records it.
  - Mutations `LEDGER_RACE_MUTATION=lock-unshared|period-unlocked|books-unlocked` must each fail
    it (`period-unlocked` with `LEDGER_RACE_ONLY=2`, `books-unlocked` with `LEDGER_RACE_ONLY=3` and
    `4`). Runs in the CI PostgreSQL job.
- `node --test scripts/tests/accounting-ledger.test.mjs`: Ledger tab, 12 tests.
- `node scripts/tests/on-deck-coding-database.test.mjs` (23) and the On Deck browser suites.
