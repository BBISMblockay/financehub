# Splitting one transaction across several accounts

**What it is for.** A $25,187.68 loan payment is not one expense. Part of it
reduces the loan and part of it is interest, and until this existed a coded row
carried exactly one account. The three available answers were all wrong: code it
all to the liability and the interest expense never appears (and principal paid
is overstated), code it all to interest and the loan never comes down, or
exclude the row and hand-write a journal adjustment every month with nothing
connecting the excluded row to the entry that replaced it. The same shape covers
a card payment with a fee on it, a payroll draft, and a vendor charge that
belongs to two cost centres.

## How to split one

1. Open the transaction on `/v2/transactions.html` (the Category cell, or
   **Split across accounts** in the review panel).
2. Choose an account for each line, and type its amount from the statement.
3. The footer shows the transaction total, the lines total, and what is left to
   allocate. **Remainder** puts the unallocated balance on a line so the last
   one does not have to be worked out by hand.
4. **Save split** is disabled until the lines total the transaction to the cent
   and every line is complete. Whatever is still missing is listed above the
   footer in words.

Each line carries its own location, customer/vendor and memo. A line on a
receivable or payable account needs a customer or vendor before it can be saved,
the same rule QuickBooks applies to any journal line.

**Remove split** returns the transaction to uncoded. It does not guess which of
the accounts was the "real" one.

## Amounts are typed every time, on purpose

Tick **Remember these accounts** and SILO saves the SHAPE of the split — the
ordered accounts, with their locations, entities and memos — against the
merchant or the card. Next month the same merchant opens with those lines
already chosen and **every amount box empty.**

That is deliberate and it is the single most important thing to understand about
this feature. An amortizing payment divides differently every month: the
principal share grows and the interest share shrinks. A remembered amount, or a
remembered percentage, would be wrong by construction — and wrong in the worst
way, because it would look like SILO knew. So there is no default amount, no
remembered proportion, and no "same as last month". The rule tables have no
amount column at all, and `verify_v2_schema.sql` fails CRITICAL if one appears.

Where a merchant rule and a card-name rule split the same transaction
differently, neither is applied and the editor says so. Knowing the vendor and
knowing which card paid are different claims, and where they disagree neither is
evidence — the same stance ordinary card-coding rules take.

## What a split changes downstream

- The journal preview shows one line per split line, not one per transaction.
- The posted entry does the same: `approve_card_import_batch` aggregates through
  `card_coding_effective_lines`, which yields a split row's lines and an unsplit
  row's single line. There is one definition of a posted line, so a split line
  cannot skip an account, location or entity check that an ordinary line passes.
- The settlement (card or bank) leg is unchanged — it is computed from the batch
  total, which is why the lines must tie exactly.
- Bulk category, location and entity skip split rows and say how many they
  skipped. So do the rule pass and the AI pass. Their accounts were chosen line
  by line; a merchant rule does not outrank that.
- A split row shows **Split · N accounts** where an account name would be, and
  its own `qbo_account_id` is null. Anything reading only that column reports no
  account rather than one account standing for several.

## If something looks wrong

| Symptom | What it means |
|---|---|
| "Split lines could not load" on the page | The split lines did not read. Split transactions will render as having no account. **Do not approve the journal entry** until it is resolved — the entry would be missing those lines. |
| Save refused with a total | The lines do not sum to the transaction. The message names the difference. |
| "This transaction is split across N accounts; clear its splits before coding it to one account" | Something tried to write a single account onto a split row. Remove the split first, or edit the lines. |
| A saved split offered nothing | No rule matches this merchant or card yet, or two rules disagree. Enter the lines and tick Remember. |

## Where it lives

| Piece | File |
|---|---|
| Tables, invariants, RPCs, re-created approval | `supabase/migrations/20260915100000_card_transaction_splits.sql` |
| Editor | `v2/card-splits.js` (drawer markup and wiring in `v2/transactions.html`) |
| Database regressions | `scripts/tests/card-splits-database.test.mjs` |
| Editor regressions | `scripts/tests/card-splits-ui.test.mjs` |
| Health check | `Card transaction splits` in `supabase/verify_v2_schema.sql` |

Writes go through `set_card_transaction_splits` only: the tables carry no client
insert, update or delete grant, and the RPC is finance-gated
(`can_manage_journal_entries()`), company-scoped, and refuses a batch that has
left `draft` / `categorized`.
