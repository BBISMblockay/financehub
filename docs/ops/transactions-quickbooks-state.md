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

### Why "unknown" needs its own reading, and its own query

`quickbooks-post-journal` inserts its posting claim with status `submitting`
**before** it calls Intuit, and links `card_import_batches.posting_id` only in
`finalize()`, after a confirmed success. `card_import_batches_v` joins the
posting *through* that `posting_id`.

So an unfinished or refused attempt is **invisible on the batch**: its
`posting_status` is null and its status is still `approved` — byte for byte the
shape of a period nobody has sent. Production bears this out: of 25
`card_import` claims, the 9 posted ones are linked to their batch and all 16
failed ones are not.

That is why the page reads the claim separately (`loadPostingClaims`),
correlated the way `on_deck_coding_items()` does it — company, `source =
'card_import'`, `source_ref` = the batch id — and why a journal entry id alone
is never read as proof the entry posted. Reading the batch alone would tell
someone "approved but not sent yet" about an entry QuickBooks may well hold.
The first version of this change did exactly that, and its tests passed because
they injected `posting_status` onto a batch fixture, a shape production never
produces. Found by review cycle 1 on PR #995.

Two rules follow:

- **An unresolved attempt outranks everything else**, including the posting
  switch: turning posting off for an account does not resolve a send already
  made.
- **A period nobody looked up is not a period with no attempt.** The claim read
  tracks which batch ids it actually covered. `loadBatches()` reads the latest
  60 periods, but opening a journal link fetches a single older period by id and
  selecting an account loads that account's whole history, so both of those
  paths read the claims of what they appended before anything renders — and an
  id still outside what was read says so rather than falling through to "has
  not been sent yet". Found by review cycle 2 on PR #995.
- **A failed lookup is not "no attempt".** If the claim read fails, the line
  says the attempts could not be read and names the error, rather than
  asserting the period was never sent. The read also never takes the register
  down: a throw degrades to that same recorded error. It measured 2.3ms on
  production under an index scan (`idx_quickbooks_postings_company_status`),
  against the 8s statement timeout `authenticated` is capped at.

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
- **Nothing is sent, approved or written.** The only addition to what the page
  already read is the one SELECT over `quickbooks_journal_postings` described
  above; everything else comes from fields the batch list already loads
  (`BATCH_FIELDS` over `card_import_batches_v`).

## Tests

`node scripts/tests/transactions-qbo-state.test.mjs` — 41 checks against the
shipped page, with the real `transaction-filters.js`, `transaction-dates.js` and
`card-splits.js` loaded rather than stubs, including the panel and strip wiring
and not only the helpers. Green under both UTC and `TZ=America/Los_Angeles`.
30 mutations were confirmed to fail a test, among them reading the unfinished
attempt from the batch instead of its claim (the cycle-1 finding), correlating
the claim read on the wrong column, swallowing a failed or thrown claim read,
reading a journal entry id as proof of posting, comparing the period end
against a UTC date, and treating a period the page never looked up as a period
with no attempts (the cycle-2 finding), on each of the two paths that append
one. The integrated run of those two paths is not reachable in this harness —
both go through `loadTxns()` and the real workspace widget — so their wiring is
held by a source assertion, with the behaviour it depends on driven directly.
