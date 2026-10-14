# Reclassifying a transaction after its period is posted

Migration: `20261013180000_card_transaction_reclass.sql`. Page: Transactions (`v2/transaction-reclass.js`).

## Why

Once a card or bank period is posted to QuickBooks, its coding is locked. RLS refuses edits, and the
QuickBooks entry is the approved snapshot. Before this change, fixing one row's category meant:

1. Delete the whole month's entry in QuickBooks.
2. **Mark unposted**, then **Reopen approval**.
3. Recode the row.
4. Re-approve and re-post the month.

The alternative was a hand-written adjustment that SILO never tied back to the row.

## What it does

Transactions → open a row in a posted period → **Reclassify…** → choose the correct category (and the
location and customer/vendor if they change), then give a reason.

- `stage_card_transaction_reclass()` writes a **draft** journal adjustment with two lines, for the same
  amount:
  - The new account, on the transaction's side: Debit for a charge, Credit for a refund.
  - The account the amount sits on now, on the other side.
- The composer opens on that draft **as read back from the database**, in review-only mode.
- Only **Approve & post** sends it, through the same `quickbooks-post-journal` path and controls as every
  other adjustment. Closing the composer leaves a draft. The panel then offers **Review and post** or
  **Discard draft**.
- The posted month entry and the transaction row never change. The panel shows where the amount sits in
  QuickBooks now: the latest posted reclass's target.
- **Date:** the original entry's date (the batch's entry date). If SILO's period lock covers that date,
  it is the first open day after the lock instead. You can choose a later date, but never an earlier date
  and never a locked one.

## What it refuses (by design)

- A period that is not posted. A draft or categorized period is edited directly; an approved one is
  reopened.
- A split, uncoded, excluded or zero-amount row.
- On a bank feed:
  - anything other than a settled purchase or refund (transfers, card payments and settlements stay
    journal entries);
  - a row with an open bank change.
- A second reclass while one is awaiting review or posting. After one posts, the next reclass moves the
  amount from that one's target.
- A target account that is not active in the period's QuickBooks connection. A receivable account
  needs a customer and a payable account needs a vendor.
- Approving a reclass whose lines, connection or date were edited after staging. Drafts are editable
  through RLS and the generic composer, so approval re-checks them against the record.
- Unposting a reclass while a later reclass of the same transaction is active.
- Reopening a period that has an active reclass: recoding it would move the same amount twice. To do
  that, retire the reclass first (see "Undoing a reclass" below).
- A row with no location of its own in a period approved before approvals recorded their default
  location (no approval snapshot). It posted on whatever the source's default was then, which nothing
  recorded, so the source leg can't be placed correctly. Post a journal entry for it instead.

## Which location the reversal uses

A row with no location of its own posted on its source's **default location as of approval**
(`approve_card_import_batch` posts `coalesce(row, source default)`). The reclass credits (or debits)
that same location, read from the frozen approval: the settlement line's location, or, for a period
that netted to zero, the note `silo_ledger_freeze` took at approval. Today's source default is never
used, because it may have changed since. `card_transaction_reclass_from()` returns this and the
dialog defaults to it.

## Undoing a reclass

- **Draft:** **Discard draft** on the transaction panel, or **Discard** in Books → journal register.
- **Approved, never posted:** **Reopen approval** on the panel, or **Reopen** in the register. It goes
  back to draft (nothing is sent to QuickBooks); then discard it.
- **Posted:**
  1. Delete the entry in QuickBooks.
  2. **Void** it in Books → journal register. This marks it unposted and returns it to approved.
  3. **Reopen approval**, then **Discard draft**.

  If a later reclass of the same transaction is active, undo that one first.

## Not in the SILO ledger

A reclass is a journal adjustment, not a `ledger_entries` row. Books → Ledger already counts every
posted QuickBooks journal (adjustments included) alongside SILO's ledger lines. Recording the reclass in
both places would count it twice. Reports that read `card_transactions` categories still show the posted
category. QuickBooks, and Books → Ledger, carry the reclass.

## Rollout

- Apply the migration (Blake's approval). No edge function deploy is needed:
  `quickbooks-post-journal` already posts any approved adjustment.
- Then publish the page.
- Without the migration, the page shows "Reclasses could not be read" on posted rows, and nothing else
  changes.

## Tests

- `node scripts/tests/card-reclass-database.test.mjs`: 17 checks against the real finance migrations,
  the SILO ledger and this migration, in PGlite. It has mutation hooks in its header (`CARD_RECLASS_MUTATION`).
- `node scripts/tests/transaction-reclass-ui.test.mjs`: the shipped module and dialog, plus the page
  wiring.
- `node scripts/tests/je-composer-review.test.mjs`: the review-only mode.
