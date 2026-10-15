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
| `In QuickBooks — journal entry SILO-…` | SILO posted the period. If a posted reclass moved the amount, it names the account holding it now |
| `Not sent to QuickBooks — …` | with the next step: categorize the row, approve the month, send the approved month, or that posting is off for the account. A refused post says QuickBooks refused it |
| `Unknown — …` | a post was sent and QuickBooks never confirmed it |

### Why it says "not sent", never "not in QuickBooks"

SILO reads nothing back out of QuickBooks. It knows what it posted itself and
nothing more, so an unposted period can only be reported as not sent.

Baseballism's July and August 2026 are the case that proves it: those months
were coded inside QuickBooks directly, off a three-month Plaid import, and are
deliberately out of SILO (Blake, 2026-10-15). Their rows are in QuickBooks. A
line reading "Not in QuickBooks — July 2026 is still a draft" would have been
false on exactly the months that prompted this change.

So the draft, approved and posting-off readings also carry one clause — "SILO
reports only what it posted itself, so a month entered in QuickBooks directly
does not show here" — because those are the three states where a reader could
take silence for absence. A posted period, an unresolved attempt and a refusal
each say precisely what happened and do not carry it.

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

**On save**, a recode in a closed period that is not posted adds: "SILO has not
posted July 2026 — it is still a draft here." The open current month
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

`node scripts/tests/transactions-qbo-state.test.mjs` — 49 checks against the
shipped page, with the real `transaction-filters.js`, `transaction-dates.js` and
`card-splits.js` loaded rather than stubs, including the panel and strip wiring
and not only the helpers. Green under both UTC and `TZ=America/Los_Angeles`.
43 mutations were confirmed to fail a test, among them reading the unfinished
attempt from the batch instead of its claim (the cycle-1 finding), correlating
the claim read on the wrong column, swallowing a failed or thrown claim read,
reading a journal entry id as proof of posting, comparing the period end
against a UTC date, and treating a period the page never looked up as a period
with no attempts (the cycle-2 finding), on each of the two paths that append
one. The integrated run of those two paths is not reachable in this harness —
both go through `loadTxns()` and the real workspace widget — so their wiring is
held by a source assertion, with the behaviour it depends on driven directly.
Seven of the mutations restore some form of "not in QuickBooks", one per
reading, against a sweep that asserts no reading anywhere asserts absence.

## A fourth reading: handled outside SILO (2026-10-15)

`card_sources.posting_start_on` is the first day SILO may post an account
(`20261015020000_card_posting_start.sql`; set in Books & setup). A period ending
before it was not SILO's to send — Baseballism's July and August 2026 bank
periods were categorized inside QuickBooks directly, off a three-month Plaid
backload — so the row reads **Handled outside SILO** and asks for nothing, the
workflow strip says the same, the save confirmation stops naming the period as
unposted work, and the Approve button is disabled with that reason rather than
letting the database trigger's refusal be the first anyone hears of it.

Its place in the precedence matters: it comes AFTER the two claim readings and
BEFORE the posting switch. A post already sent and unconfirmed is not settled by
a date set afterwards, so an unresolved claim still reads **Unknown**. A period
already posted still reads **In QuickBooks**: the date governs what SILO may
send from now on, and does not relabel history.

The reading needs `source_posting_start_on` in `BATCH_FIELDS`; unselected it is
`undefined` and every period silently reads as SILO's, which a test pins.

A cut-over need not fall on a period boundary. A period whose own end is after
it is SILO's to post, but the entry approval freezes is built from every
non-zero effective line in the batch -- so a September 15 cut-over on a
September 1-30 import would freeze the September 10 rows and posting would send
them. `card_posting_start_guard` refuses that approval, counting the rows and
naming the earliest; the entry pane blocks Approve with the same count, so the
database's refusal is never the first anyone hears of it. Excluding those rows,
or moving them to their own import, clears it, because the guard asks exactly
the lines approval freezes.
