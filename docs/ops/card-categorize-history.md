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
   account set). `coding_source = 'manual'` or `'rule'` counts once saved. `'ai'`
   counts ONLY when its batch is `approved` or `posted`: an accepted-but-unreviewed
   suggestion is the model agreeing with itself. Rows in a `voided` batch never count.
   Confirmation is decided in the function, not in SQL, so the rule is one testable place.
2. **The QBO ledger archive** (`qbo_history_lines`, see [qbo-history.md](qbo-history.md)),
   reached only through `qbo_history_imports` rows for this company AND the card
   source's `qbo_connection_id`. `row_kind = 'transaction'` only, and only lines on
   expense, COGS, asset and income account types. Settlement legs on Accounts Payable,
   Credit Card and Other Current Liability are excluded: they say how a bill was PAID,
   not what it WAS. Lines are paged 1000 at a time, newest first, up to 5 pages; hitting
   the cap adds a "ledger sample capped" note to every evidence line. Overlapping
   snapshots holding the same QuickBooks line are de-duplicated.

## Window and scoping

Each merchant group anchors on the LATEST `txn_date` among its rows (a row with no
date anchors on today, which can only widen "before"). History counts from 24 months
before the anchor up to the anchor; nothing dated after it counts. There is no
cross-company read: SILO rows carry `company_entity_id`, ledger lines are only
reachable through this company's imports for this connection.

## Matching and weighting

SILO rows match on `merchant_norm`, the same key the request groups by. Ledger lines
have no merchant key, so the counterparty is reduced with `normalizeMerchant()`, a
mirror of `public.normalize_merchant` (and the copy in `v2/transactions.html`).
Changing one without the others silently stops history matching. A "similar payee
name" match is whole-word containment of a key at least 4 characters long ("state
farm" inside "state farm insurance co"; "sun" never claims "sunrise bakery").

Each matched line adds weight to its account: recency 1.0 (within 6 months of the
anchor), 0.7 (within 12), 0.4 (within 24), multiplied by 1.0 for a SILO exact match,
0.8 for a ledger exact match, 0.4 for a ledger similar-name match. An account that is
not in the active chart is tallied separately as "since-removed" and can never lead.

## Statuses and confidence caps

| Status | Meaning | Cap on the model's confidence |
|--------|---------|-------------------------------|
| `consistent` | one account, or the leading account holds >= 0.75 of the weight, and its weight is >= 0.8 (one weak similar line is a hint, not a precedent) | 0.5 if the model chose a DIFFERENT account; no cap when it agrees |
| `conflicting` | more than one account and no clear leader | 0.55 |
| `inactive_only` | history points only at since-removed accounts | 0.6 |
| `none` | no confirmed coding in the window | 0.75 |
| `unavailable` | both sources failed to read | 0.75 |

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
gains `history` stats: `window_months`, `silo_rows`, `ledger_lines`,
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
