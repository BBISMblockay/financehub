# Is this transaction in QuickBooks?

Page: Transactions (`v2/transactions.html`). No migration, no edge function.

## Why this exists

SILO sends nothing to QuickBooks on its own. There is no cron and no background
pusher: `quickbooks-post-journal` runs when a person approves a period and then
posts it. So a transaction coded weeks ago is still absent from QuickBooks for as
long as its period is a draft.

On 2026-10-14 that cost a day of looking. A July bank row was recoded by hand;
the row said "Categorized in SILO", the save said "Saved 1 row.", and nothing
anywhere said the change had not reached QuickBooks. It had not: the July period
(804 rows, every one coded) had been a draft since 2026-09-14, and so had August
(620 rows). July's hold was deliberate — SILO accounting was still being tested —
which is exactly the problem. A month held on purpose and a month forgotten
looked identical.

## What a reader now sees

**On the transaction panel**, under Accounting details, a QuickBooks line that is
separate from SILO's own state and is always exactly one of three readings:

| Reading | When |
|---------|------|
| `In QuickBooks — journal entry SILO-…` | the period is posted. If a posted reclass moved the amount, it names the account holding it now |
| `Not in QuickBooks — …` | with the next step: categorize the row, approve the month, send the approved month, or that posting is off for the account. A refused post says QuickBooks refused it |
| `Unknown — …` | a post was sent and QuickBooks never confirmed it |

That third reading is not hedging. `quickbooks-post-journal` claims its posting
**before** it calls Intuit, so `submitting` and `unknown` mean the entry may or
may not exist, and a readback can leave a `qbo_journal_entry_id` on a posting
that never confirmed. A journal entry id is therefore never read as proof the
entry posted. SILO locks the entry in that state so it cannot post twice, and
the line says so.

A **void** is not this case: `void_card_posting` clears the batch's `posting_id`,
so a voided period reads as not posted, with no stale entry number.

**On the workflow strip**, the QuickBooks step names the month to approve
("Not sent — approve July 2026") instead of the old "Approval required", which
said the same thing about a month waiting on its last uncoded row as about a
finished month nobody had approved. Its green tick reads the same predicate as
its text, so an unconfirmed post cannot show a completed step.

**On save**, a recode in a closed period that is not posted adds: "Not in
QuickBooks yet — July 2026 has to be approved and posted." The open current month
is left alone; nobody expects it in the books yet. "Closed" is judged by the
reader's own calendar day, not UTC — west of UTC, `toISOString()` calls a month
closed up to 17 hours early, while the people closing it are still in it.

## What this deliberately does not do

- **No alarm, and no nudge.** On Deck already lists a fully coded, unposted
  period through `on_deck_coding_items()` (stage `approve`, "QuickBooks entry not
  prepared (optional)"). Since a hold can be deliberate, nothing here escalates
  it; the gap was in Transactions, where the coding happens.
- **Nothing is sent, approved or queried.** Every reading comes from fields the
  batch list already loads (`BATCH_FIELDS` over `card_import_batches_v`).

## Tests

`node scripts/tests/transactions-qbo-state.test.mjs` — 29 checks against the
shipped page, with the real `transaction-filters.js`, `transaction-dates.js` and
`card-splits.js` loaded rather than stubs, including the panel and strip wiring
and not only the helpers. Green under both UTC and `TZ=America/Los_Angeles`.
15 mutations were confirmed to fail a test, among them reading a journal entry id
as proof of posting (which was a real bug in the first version) and comparing the
period end against a UTC date.
