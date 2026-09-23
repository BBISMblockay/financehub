# Card AI historical coding evidence

## Purpose and boundary

`card-categorize` (the "Ask AI to categorize" button on `/v2/transactions.html`)
already knows which accounts a company posts to and which merchants have a learned
rule. Neither settles a near-duplicate ("Insurance Expense" against "Insurance -
General Liability"). What settles it is where THIS company put THIS vendor before.
Since 2026-09-14 the function reads that history, shows it beside every suggestion,
and lowers confidence when history conflicts, is missing, or disagrees with the model.

The boundary is unchanged: the caller applies explicit rules first and sends only
uncoded rows; manual selections are never touched; the function writes nothing and
recategorizes nothing. History decides a confidence CEILING, never the answer.

## The two sources and the confirmation rule

Both are read for the caller's active company only.

1. **Confirmed SILO codings** from `card_transactions_v` (`status = 'coded'`, an
   account set), and only from batches bound to the SAME QuickBooks connection as the
   source being coded. The binding that counts is the BATCH's own `qbo_connection_id`,
   frozen when the batch was made, not the source's current one: a CSV source can be
   rebound from realm A to realm B while its realm-A batches keep their binding. A batch
   with no binding at all (made before batches recorded one) falls back to its source's
   current connection, resolved through the view's per-company-unique `source_key`. An
   account id only means something inside its realm: a company that moved realms can
   have an old "42 = Travel" beside a current "42 = Advertising", so both checks run
   BEFORE any id is resolved.
   `coding_source = 'manual'` or `'rule'` counts once saved. `'ai'` counts ONLY when its
   batch is `approved` or `posted`: an accepted-but-unreviewed suggestion is the model
   agreeing with itself. Rows in a `voided` batch never count. Confirmation is decided
   in the function, not in SQL, so the rule is one testable place. Rows are paged 1000
   at a time, newest first then by row id, up to 5 pages; hitting the cap adds a "SILO
   sample capped" note.
2. **The QBO ledger archive** (`qbo_history_lines`, see [qbo-history.md](qbo-history.md)),
   reached only through `qbo_history_imports` rows for this company AND the card
   source's `qbo_connection_id`. `row_kind = 'transaction'` only (never `opening`,
   and never `zero_amount`, the kind the archive gives a blank or `.00` line since
   `20260914220000`, so a zero-dollar journal line cannot be a precedent), and only lines on
   expense, COGS, asset and income account types. Settlement legs on Accounts Payable,
   Credit Card and Other Current Liability are excluded: they say how a bill was PAID,
   not what it WAS. Lines are paged 1000 at a time, newest first, up to 5 pages; hitting
   the cap adds a "ledger sample capped" note to every evidence line. Overlapping
   snapshots holding the same QuickBooks line are de-duplicated.

A capped source, on either side, is a partial sample whatever it appears to say: the
evidence line is prefixed "History sample capped, treat as partial" and confidence is
held to 0.55 even when the visible sample is consistent, so it lands inside the page's
"Low confidence" (< 0.6) filter.

## Window and scoping

Since 2026-09-23 (`20260923140000`) history is read by ONE database function,
`card_coding_history_evidence(company, connection, pairs, per_key, exclude)`,
service-role only. Each merchant group asks with its own date: the EARLIEST
`txn_date` among its rows (a row with no date counts as today, which cannot
move an earlier anchor). History counts from 24 months before that date up to
it; nothing dated after ANY line of the group counts. Before, the anchor was
the latest line, so a coding made between a group's first and last line could
be cited as precedent for the first.

There is no cross-company or cross-realm read: SILO rows must belong to this
company and to a batch bound to this QuickBooks connection (the batch's own
binding, else its source's); ledger lines are reached only through this
company's archive imports for this connection.

## Matching BEFORE capping

The old read paged the window's ledger lines newest-first, stopped at 5,000
and then searched those for the merchant. On Baseballism the 24-month window
held 53,869 lines (18,001 after deduplicating nine overlapping snapshots), so
5,000 reached back only to 2026-06-30 and most merchants' history was never
looked at. The function now matches first, per merchant, and caps each
merchant separately (100 lines per source, exact matches kept ahead of
similar ones), returning how many lines matched, so a capped merchant is
disclosed (`History sample capped`) rather than read as the whole story.
Matching runs against the distinct normalised payees and memos, so its cost
follows how many different names the ledger holds: 2.6s on Baseballism
production for the 52 merchants then uncoded (13s before the normalised lists
were materialised).

## Matching and weighting

SILO rows match on the merchant key exactly. Ledger lines match on the payee
(exact, or whole-word similar at 4+ characters: "state farm" inside "state
farm insurance co"; "sun" never claims "sunrise bakery") or on the MEMO (exact,
or the memo containing the key) -- QuickBooks bank-feed lines often carry the
descriptor in the memo with no payee. A memo-exact match is exact evidence; a
contains match is similar. In a bank feed the direction is part of the
question: SILO rows must have the same sign, and an outflow never takes an
income-account line as precedent. `normalize_merchant` is now used only in
SQL for this; the TypeScript mirror was removed.

**The company's own confirmed SILO codings take precedence.** Where a merchant
has any, ledger lines are read and disclosed (`N QBO ledger lines not
weighed`) but do not vote. The archive records the PREVIOUS bookkeeping
practice. See "Backtest" below for why.

Each matched line adds weight to its account: recency 1.0 (within 6 months of the
anchor), 0.7 (within 12), 0.4 (within 24), multiplied by 1.0 for a SILO match,
0.8 for a ledger exact or memo match, 0.4 for a similar match. An account that is
still active in QuickBooks but not offered for this transaction type (an income account
in card mode) is tallied separately as "not offered for this transaction type"; an
account absent from the active chart altogether is tallied as "since-removed". Neither
can lead, and the two are never confused. The chart is read once per request; if
that read fails the request stops before any model call.

## Backtest (2026-09-23, evidence only)

`scripts/sql/card_coding_evidence_backtest.sql`, read-only against production:
1,764 Baseballism rows coded by a person between 2026-07-01 and 2026-09-18,
each asked about with history dated up to its own date and never itself. It
measures the EVIDENCE (does history lead with the account the person chose),
not the model's answer.

| Retrieval | Exact precedent | Agrees | Disagrees | Consistent and wrong |
|---|---|---|---|---|
| Old (capped 5,000 lines, payee only) | 857 | 738 | 119 | 96 |
| New, ledger weighed against SILO | 770 | 609 | 161 | 38 |
| **New, SILO first (shipped)** | **964** | **858** | **106** | **48** |

Weighing the full ledger against SILO made agreement WORSE: the older archive
codes many vendors differently than the current bookkeeper does, and its
volume outvoted the company's own recent codings. Shortening the ledger window
(3/6/12 months) helped only partly (713/654/633 agree). Letting confirmed SILO
codings decide, and the ledger answer only merchants SILO has never coded (831
of the 1,764 rows), gave the best result on every column but one. Direction
filtering changed nothing on this sample. This is one company; the model's
own accuracy with this evidence is not yet measured.

## Statuses and confidence caps

| Status | Meaning | Cap on the model's confidence |
|--------|---------|-------------------------------|
| `consistent` | one account, or the leading account holds >= 0.75 of the weight, and its weight is >= 0.8 (one weak similar line is a hint, not a precedent) | 0.5 if the model chose a DIFFERENT account; no cap when it agrees |
| `conflicting` | more than one account and no clear leader | 0.55 |
| `inactive_only` | history points only at since-removed accounts | 0.6 |
| `none` | no confirmed coding in the window | 0.75 |
| `unavailable` | both sources failed to read | 0.75 |
| any, with a capped source | the sample is partial | 0.55 (applied on top of the row above) |

Caps are applied AFTER the model answers and only ever lower a value. The existing
chart and account-type checks still run first; a discarded account is still 0.

The model sees a "Historical coding evidence" section in its system prompt, one
line per merchant, with explicit rules: prefer a consistent account; name a conflict
in reasoning and stay below 0.6; never claim precedent without listed history; an
account NAME resembling a merchant is not history.

## What the response carries and what the UI shows

Every suggestion gains two additive fields: `evidence` (one line a bookkeeper can
check, e.g. "History agrees. CONSISTENT: Insurance - General Liability [3 confirmed
SILO codings, 2 ledger lines; last 2026-07-02].") and `history_status`. The response
gains `history` stats: `window_months`, `silo_rows`, `silo_capped`, `ledger_lines`,
`ledger_imports`, `ledger_capped`, `unavailable`. `/v2/transactions.html` renders the line under the suggestion's reasoning as "History: ..." in the review panel, and when a suggestion is accepted the line is appended to the row's stored `ai_reasoning`, so the evidence travels with the coded row. A capped suggestion also surfaces through the existing "Low confidence" (< 0.6) filter, which is what gets a person to look.

A candidate backed only by similar payee names, with no exact match in either source, is reported as WEAK and treated like a conflict (confidence capped at 0.55): a resemblance is a hint, never precedent, however many lines carry it.

## Failure handling

A read error on one source degrades to the other and is named in the evidence line
("QBO ledger archive unavailable"); the request still returns suggestions. Only when
BOTH sources fail is the status `unavailable`. A model that returns no suggestion for
a line still gets its evidence line attached.

## Deliberately not done

- No automatic recategorization: rules and manual codings win, and nothing here
  writes to `card_transactions`, `card_coding_rules` or QuickBooks.
- No cross-company learning, even for shared merchants like Amazon.
- No binding to account names: a name that looks like the merchant is not evidence,
  and the prompt says so.
- No SILO learned rule is created from ledger history; rules are still learned from
  confirmed rows on the page.

## Dependency: the QBO history archive must exist

The ledger source is only as full as Books & setup -> QBO history has archived. A
company that has never archived its ledger (or archived a window outside the 24
months before its transactions) has an EMPTY ledger source, and the evidence says
"No confirmed coding for this merchant", never that similar account names are GL
evidence. Archiving more history is the way to improve suggestions for a new card.

## How to verify

```sh
node scripts/tests/card-categorize-history.test.mjs
node scripts/tests/card-categorize-bank-guard.test.mjs
```

Both run in `.github/workflows/sync-tests.yml` with no secrets. Note the drift check:
this change makes `main` differ from the deployed function, so
`deployment-drift-check.yml` fails after merge until `card-categorize` is deployed
from `main` and its `DEFERRED_DRIFT` entry in `scripts/check-function-drift.mjs` is
removed (see [bugs.md](bugs.md)).
