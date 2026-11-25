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

**Sync with QuickBooks** sends every Waiting row, one after another, with a progress line.

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

## Tests

`node --test scripts/tests/quickbooks-sync.test.mjs` (27). `QBSYNC_MUTATION=<name>` breaks one protection;
all 18 must fail the suite and CI runs each. Verified in Chromium against the shipped page with stubbed
data (light, dark, phone, a full send run); not yet exercised against production.
