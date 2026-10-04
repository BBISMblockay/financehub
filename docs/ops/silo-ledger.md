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
- Card-batch postings are not counted a second time, because they are the same transactions.
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

## Activation

1. Apply `20261005120000_silo_daily_ledger.sql` after `20261004120000`. It runs the backfill.
2. Run `verify_v2_schema.sql`. Three "SILO ledger" checks must read ok, and the balance check is
   CRITICAL if any entry does not balance.
3. Open Books → Ledger and check that the bank account's SILO balance matches the bank feed's balance
   as of today.

No edge function changes; no secrets.

## Tests

- `node scripts/tests/silo-ledger-database.test.mjs`: 19 checks. Mutations
  `SILO_LEDGER_MUTATION=no-start-check|edit-in-place|ignore-lock|read-ungated|cosmetic-rerecord` must each fail it,
  and run in CI.
- `node --test scripts/tests/accounting-ledger.test.mjs`: Ledger tab, 12 tests.
- `node scripts/tests/on-deck-coding-database.test.mjs` (23) and the On Deck browser suites.
