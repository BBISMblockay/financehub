# QuickBooks sync page

Page: `/v2/quickbooks-sync.html`, not in the menu yet (`testing/` is not published, so it could not be opened
there; it joins `ACCOUNTING_PAGES` when it goes live). Logic: `v2/quickbooks-sync.js`. No migration, no edge function.

Steps 1-2 of the 2026-11-25 accounting audit (Blake: "categorize in silo, watch the financials build,
sync with qbo which would generate all the entries, show a loading progress, approve or fix").

## What it is

One list of everything SILO sends to QuickBooks: every card and bank month and every journal entry.
Each row is in one state:

| State | Means |
|---|---|
| Synced | SILO sent it and QuickBooks confirmed it |
| Waiting | Finished and categorized; goes out on the next sync |
| Needs a fix | Something a person has to do first, said in plain words on the row |
| Open month | The month has not ended. Listed, not scored, never sent |
| Not sent by SILO | Sending is off for the account, or the month predates SILO's posting start |

**Sync selected** sends the rows a person ticked, one after another, with a progress line. See "The screen" below.

## It adds no write path

For a month: `card_import_batch_preview` (runs the real approval and rolls it back, so a refusal is known
before anything is frozen), then `approve_reviewed_card_import_batch(batch, hash)`, then
`quickbooks-post-journal` with `expected_approval_hash`. For a journal entry already approved:
`quickbooks-post-journal` with its hash. These are the calls On Deck and Transactions already make one at
a time. The page writes no table.

## Rules

- **An unconfirmed send outranks everything**, and is read from the claim, not the batch
  (`transactions-quickbooks-state.md`). Claims that could not be read make a row Needs a fix, never Waiting.
- **A month that has not ended is not sent.** Sending freezes its rows while the feed is still filling it.
  "Ended" is judged against `silo_business_today()`.
- **Sent, then marked unposted = unticked by default.** A voided claim for the same approval means a person
  took it back on purpose (it may have been re-entered in QuickBooks by hand). It is offered, never assumed.
- **A refusal QuickBooks would repeat is a fix, not a retry.** A validation fault on the same approval is
  not sent again unchanged. A transient failure is retried.
- **An unknown outcome stops the run.** A refusal moves on to the next row.
- **The active company is re-checked before every row.**
- **Reporting-only companies (`bookkeeping_mode = 'qbo'`) send nothing.** That includes a month approved before the
  switch: it is listed as outside SILO, never offered, and the button stays off. If the setting cannot be read,
  every row is Needs a fix and nothing can be sent.
- After the page loads it pre-checks up to 12 waiting months with the preview RPC, so a refusal shows before
  anyone presses Sync.

## Not in this version

- Open months stay unsent, and a sent month is still locked: locking by closed period is audit step 3.
- Sales, prepaid and depreciation entries are still created on their own pages; once approved they sync here.
- No nightly run. Sending still needs a signed-in finance user.

## Already in QuickBooks (20261125130000)

SILO knows only what it sent, so an entry made by hand in QuickBooks used to sit under Waiting,
unticked, for ever. A finance user can now press **Already in QuickBooks** on any row SILO would
send. The row moves to Synced ("Entered in QuickBooks by hand") and **Undo** takes the mark off.

- The mark is a row in `quickbooks_entered_by_hand`, keyed exactly like a sending claim
  (`source`, `source_ref`), written only by `set_entry_entered_in_quickbooks(kind, id, marked)`.
- While it stands, the trigger `qbo_entered_by_hand_claim` refuses any claim to send that entry
  (`P0PS3`), from this page or any other. That is the protection; the page's reading is only display.
- **A mark speaks only for the content it was made on** (`snapshot`): a journal entry's approval
  hash, or a month's `card_import_content_fingerprint` (every coded line, with its description and memo, plus the count of rows still
  uncategorized; independent of the month's status). If a late bank row lands, a row is recoded, or
  an entry is approved again, the mark no longer counts: the row goes back to Waiting, unticked,
  "Changed since it was marked as entered by hand", and the guard lets the new content through.
  Pressing **Already in QuickBooks** again moves the mark to the new content.
- An entry SILO has a send on record for (unconfirmed or posted) cannot be marked, and a journal
  entry must be approved first.
- The page reads marks through `quickbooks_entered_by_hand_list()` (finance-gated). A database
  without the migration shows no button and no error. If the marks cannot be read, nothing is
  offered for sending ("Needs a fix", refresh), exactly as when sends cannot be read.

## The screen (2026-11-25 redesign)

Blake: "seems like its all inclusive kinda wierd. and just one big list? no tick boxes".

- **To do** is the default and only list: Waiting and Needs a fix. Each sendable row has a tick box, with
  select-all in the header. Nothing is ticked on load. **Sync selected** sends only ticked rows (`chosen()`),
  and the confirm dialog lists exactly those. A tick is kept by key and dropped as soon as its row stops
  being sendable.
- **Already in QuickBooks** is in the ⋯ menu and applies to the ticked rows, one at a time, the company
  checked before each, stopping at the first refusal. **Undo** stays on a marked row.
- Open months and rows SILO does not send are not tasks: one quiet line, the rows behind it.
- **In QuickBooks** is one line per month; the entries and their QuickBooks numbers are behind it.
- **QuickBooks and SILO agree / Differs by X** on each of those months comes from the read-back
  (`quickbooks_ledger_mirror_*`) through the view `quickbooks_sent_entries_check_v` (20261125235000), read
  as the signed-in finance user. One row per entry SILO posted: `unread`, `as_sent`, `changed` or
  `settled`. An entry is judged only for days a read covers on its own connection: same day, same net
  amount per account, matched by QuickBooks transaction id and type Journal Entry. Changed, moved or
  deleted in QuickBooks = `changed`; X is half the sum of per-account differences (a deleted entry
  differs by its whole amount). A month says agree only when every entry SILO posted in it was compared
  and none is still `changed`; an entry no read reaches makes it "not compared yet". Entries made by
  hand in QuickBooks are not judged here.
- **QuickBooks is the master copy** (Blake, 2026-11-25: "qbo is current master", "with action to get
  settled and mirrored, not just flag"). SILO's statements already use QuickBooks' lines for a month that
  was read back. A month that differs lists each changed entry and one button, **Use QuickBooks' version**:
  it calls `quickbooks_accept_quickbooks_version(posting_id)` for each, which records the exact QuickBooks
  state accepted (`quickbooks_entry_settlements`). The entry reads `settled` and the month agrees. If
  QuickBooks changes that entry again, the acceptance no longer matches and it is flagged again. Nothing
  is written to QuickBooks, and no posting or journal entry changes.
- **Mirror now** (header) reads QuickBooks again on demand: the page calls
  `quickbooks-ledger-mirror-scheduled` with the person's own session and `{since}` until it answers
  done, one month per call, newest first, the last twelve months plus the current one. The database
  (`quickbooks_ledger_mirror_my_due`) decides who may ask (finance, active company) and which month is
  next; the page names no company or month. The nightly run is unchanged.
- If the read-back or the comparison cannot be read, no month gets a verdict and nothing else on the
  page changes. The verdict gates no send.

## Tests

`node --test scripts/tests/quickbooks-sync.test.mjs` (40). `QBSYNC_MUTATION=<name>` breaks one protection; every one
must fail the suite and CI runs each. The entry check, the settle function and Mirror now's work list run on real
PostgreSQL in `scripts/tests/quickbooks-ledger-mirror-database.test.mjs` (26 checks; `SETTLE_MUTATION`, 19). The database side is `scripts/tests/card-rules-auto-apply-database.test.mjs`
(13 checks, 17 mutations). Verified in Chromium against the shipped page with stubbed
data (light, dark, phone, a full send run); not yet exercised against production.
