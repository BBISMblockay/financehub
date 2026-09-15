# Account visibility, creating accounts, and managing locations

Assessment written 2026-09-15 alongside the Accounting Suite usability PR. It
is the preflight for a **second, separate PR**, because every item here needs a
migration or an external write path and the usability work deliberately did
not.

Nothing in this document has been implemented. Read the "What is true today"
section before designing against it — two of the obvious designs are wrong for
reasons that are only visible in the sync code.

---

## What is true today

### The chart of accounts is a mirror, not a record

`quickbooks_accounts` and `quickbooks_locations` are **purge-and-replace
mirrors of QuickBooks**, written only by the `quickbooks-accounts-sync` edge
function with the service-role key. Their columns are QBO's columns plus
`synced_at`:

| Table | Columns |
|---|---|
| `quickbooks_accounts` | `id`, `connection_id`, `company_entity_id`, `qbo_account_id`, `name`, `fully_qualified_name`, `account_type`, `account_sub_type`, `classification`, `currency`, `is_active`, `synced_at` |
| `quickbooks_locations` | `id`, `connection_id`, `company_entity_id`, `qbo_location_id`, `name`, `fully_qualified_name`, `is_active`, `synced_at` |

There is **no SILO-owned field on either table**, and adding one would be a
mistake: each sync run upserts on `(connection_id, qbo_account_id)` and then
deletes every row whose `synced_at` predates the run, to drop accounts that
vanished from QBO. A SILO flag stored there survives an upsert and is
destroyed by that delete — so an account that disappears from QBO for one run
(a paging failure, a renamed realm) silently loses its hidden state and
reappears in every picker. **The flag belongs in its own table.**

`is_active` already mirrors QBO's `Active` (an archived account comes back with
`Active = false` and is kept; a deleted one stops coming back and is removed).
So "archived in QBO" is already represented, and "hidden in SILO" has to be a
different column in a different table or the two meanings collapse.

Production today: **458 accounts, 65 locations** on one connection.

### Who reads the chart

Every one of these is a place a hidden account must stop appearing — or, in
two cases, must deliberately keep appearing:

| Reader | File | Must hidden accounts disappear? |
|---|---|---|
| Transaction coding pickers (account, bulk account) | `v2/transactions.html` `buildOptionCache()` | **Yes** |
| Split editor line accounts | `v2/card-splits.js` | **Yes** |
| Rule builder account/location/entity | `v2/transactions.html` rules pane | **Yes** for new rules |
| AI category suggestions | `supabase/functions/card-categorize` (the caller sends the codeable account list) | **Yes** — the model must never be offered one |
| Journal-entry composer account cells | `v2/je-composer.js` | **Yes** for new lines |
| Card source balancing account / credit vendor | `v2/transactions.html` accounts pane | **Yes** |
| Schedules, fixed assets, cash forecast account pickers | `v2/schedules.html`, `v2/fixed-assets.html`, `v2/cash-forecast.html` | **Yes** |
| Accounting export COA mapping | `v2/accounting-export.html` | **Yes** for new mappings |
| An already-coded transaction, split line or approved entry | everywhere | **NO — it must still render its account's name** |
| `quickbooks-report` output, the QBO history archive, and anything built from them | `v2/qbo-reports.html`, `qbo_history_*` | **NO — balances and activity are QBO's, and must not move** |

The last two rows are the whole safety property. Hiding is a **picker
preference**, never a filter on stored data or on a financial report.

### Rules are the sharp edge

`card_coding_rules` stores `qbo_account_id` and is applied automatically on
import (`applyRules`) and by "Apply saved rules". Production carries **813
rules**. Hiding an account that rules point at and doing nothing else means
those rules keep coding transactions to an account the person just said they
did not want to see — silently, because the coding pass reports only a count.

The requirement is explicit and correct: such a rule must **require attention
rather than silently apply**. The proposed behaviour is below.

### Creating accounts and managing locations

`quickbooks-post-journal` is, per CLAUDE.md, **the only write path to
QuickBooks**, and it posts a JournalEntry from a frozen approval snapshot. There
is no Account-create or Department-create path anywhere in this repo, and the
OAuth scope currently requested has not been checked for whether it permits
one.

So there are two genuinely different products here and they should not be
confused:

1. **Hide in SILO** — entirely local, one new table, no QBO write. Buildable
   now.
2. **Create an account / create a location in QBO** — a new external write
   path (`POST /v3/company/<realm>/account`), with its own idempotency,
   error-mapping and readback problems, plus a product decision about whether
   SILO should be able to change a customer's chart of accounts at all.

**A local-only account must never be invented.** An account row that exists in
SILO and not in QBO would pass every picker and then fail at post time, or
worse, post to a `qbo_account_id` QuickBooks does not recognise. If (2) is not
built, the honest UI is a link out to QuickBooks and a "Refresh chart of
accounts" button that re-runs the sync — which is work item 4 below.

---

## Proposed plan (the second PR)

### 1. One table, SILO-owned

```sql
create table public.qbo_account_preferences (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid not null references public.quickbooks_connections(id) on delete cascade,
  qbo_account_id text not null,
  hidden_in_silo boolean not null default false,
  hidden_reason text,
  hidden_at timestamptz,
  hidden_by uuid references auth.users(id),
  unique (connection_id, qbo_account_id)
);
```

Keyed on `(connection_id, qbo_account_id)` rather than on
`quickbooks_accounts.id`, because that surrogate id is re-minted whenever the
sync's delete path removes and re-adds a row. Scoped per connection, as the
requirement asks: two QBO companies can disagree about what is worth seeing.

RLS: read for any active company member (a picker needs it); write gated by
`can_manage_journal_entries()`, the same gate the rest of the coding tables
use — hiding an account changes what everyone else can code to.

Reversible by construction: unhiding is an update, and the account row itself
was never touched.

### 2. One view, so there is one definition of "offerable"

```sql
create view public.qbo_codeable_accounts_v with (security_invoker = true) as
  select a.*, coalesce(p.hidden_in_silo, false) as hidden_in_silo
    from public.quickbooks_accounts a
    left join public.qbo_account_preferences p
      on p.connection_id = a.connection_id and p.qbo_account_id = a.qbo_account_id
   where a.company_entity_id = public.active_company_id();
```

Every picker reads this view and filters `hidden_in_silo = false` **in one
shared helper** (`refsForConnection()` in `transactions.html` is already that
helper for the register; `je-composer.js` has its own). Two copies of the
filter is how one surface ends up still offering a hidden account.

Note it carries the flag rather than filtering it: the "Show hidden" control
needs the hidden rows, and so does the display of an already-coded row.

### 3. Rules pointing at a hidden account demand attention

When an account is hidden, any `card_coding_rules` row (and any
`card_split_rule_lines` row) naming it is surfaced, not deleted and not
silently applied:

- The hide dialog **counts the affected rules before hiding** and says so —
  "4 rules code to this account" — with the choice to review them.
- The Rules page shows such a rule with a warning chip and offers "re-point" or
  "delete".
- **`applyRules()` skips a rule whose account is hidden** and records it the
  way `coding_conflict` is already recorded, so the transaction is left uncoded
  with a stated reason rather than coded to a hidden account.
- `card-categorize` is sent the filtered list, so the model cannot suggest one.

This is the one part that is not purely additive, and it is the part most worth
reviewing carefully.

### 4. Where a change is saved, said out loud

The Books & setup page (`v2/accounting-books.html`) gains an Accounts section
with: the chart, a Hidden filter, per-row Hide / Unhide, **and a sentence per
control naming where the change lands**. "Hide in SILO" says *this changes what
SILO offers; QuickBooks is untouched and reports are unaffected*. There is no
"Create account" button unless item 5 is built; there is a "Refresh from
QuickBooks" button (re-runs `quickbooks-accounts-sync`) and a link out to QBO's
chart of accounts.

Locations get the same treatment, minus creation, for the same reason.

### 5. Creating an account in QBO — the exact gap

**Not in scope for the second PR.** To build it:

- `quickbooks-oauth-start` requests `com.intuit.quickbooks.accounting`, which
  does cover Account creation — **unverified, check before designing**.
- It needs a new edge function, or an explicitly-named second operation on an
  existing one. It must not be bolted onto `quickbooks-post-journal`: that
  function's entire safety model is "post the frozen snapshot and nothing
  else", and an account-create has different idempotency (QBO rejects a
  duplicate `Name`, which is a success-shaped failure).
- It needs a decision from Blake that SILO may alter the chart of accounts at
  all. Today the bookkeeping boundary is that SILO proposes and QuickBooks
  records; creating accounts crosses it.

Until that decision, item 4's link-out is the answer, and it is an honest one.

### Out of scope, on purpose

- Hiding an account for one person rather than for the company. Per-user
  visibility makes "why can't you see this account" unanswerable, the same
  reason `dashboards.filter_state` is one shared position.
- Hiding by account TYPE or a name pattern. A rule that hides future accounts
  is a rule nobody remembers writing.
- Any change to `quickbooks-report`, the QBO history archive, or the accounting
  export's own totals. Hiding must never move a number.

---

## How to prove it is safe

The checks that would have to pass before this ships:

1. Hide an account that a coded transaction already uses → the transaction
   still shows the account name, in the table, in the review panel and in the
   journal preview.
2. Hide an account that an **approved** batch's snapshot references → the
   snapshot is unchanged and the batch still posts. (The snapshot is frozen and
   hashed; this is really a test that nothing reads the picker at post time.)
3. Balance Sheet and P&L before and after hiding → **identical to the cent**.
4. Hide an account that 4 rules point at → those 4 rules are reported, and a
   subsequent `applyRules()` run leaves the matching rows uncoded with a stated
   reason rather than coding them.
5. Unhide → the account returns to every picker, and the rules apply again.
6. A sync run between hide and unhide → the flag survives, including a run
   where the account is momentarily absent from QBO.
7. Impersonation across two companies → company A's hidden set is invisible to
   company B, and a connection's preferences do not leak to another connection
   in the same company.
