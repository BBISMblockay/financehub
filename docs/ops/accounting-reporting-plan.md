# A SILO reporting layer over QBO reports and retained GL detail

Assessment written 2026-09-15 alongside the Accounting Suite usability PR.
**Nothing here is implemented.** It is a bounded plan, deliberately kept out of
that PR: a reporting engine and a filter bar do not belong in one change, and
the engine question has an answer that only shows up once you count what is
actually in the database.

---

## Count first

Production, read 2026-09-15:

| | Rows |
|---|---|
| `quickbooks_report_runs` (stored QBO report snapshots) | **187** |
| `qbo_history_imports` (retained GL detail) | **0** |
| `qbo_history_lines` | **0** |
| `card_import_batches` / of those `posted` | 15 / **4** |
| `journal_adjustments` | 3 |
| `silo_chat_saved_reports` | 81 |
| `dashboards` | 14 |

The second row is the finding that shapes everything else. **SILO retains no
general-ledger history at all today.** The archive path existed but timed out
on every real report until the bounded-job fix merged the same day (see
[qbo-history.md](qbo-history.md) and the 2026-09-15 CHANGELOG entry), and no
import has been run since. Any design that says "report over retained GL
detail" is, right now, reporting over an empty table.

So the first requirement is not a feature. It is that an empty or partial
archive **reads as empty or partial**, on the screen, in words — never as a
clean zero.

---

## The three sources, and why they must never be added together

There are three kinds of accounting number in SILO and they overlap in ways
that make a naive union double-count. Keeping them apart is the design.

### 1. QBO reports (`quickbooks_report_runs`)

A point-in-time snapshot of a QBO-computed report — BalanceSheet, P&L, GL,
TrialBalance, TransactionList — fetched by the `quickbooks-report` edge
function and stored raw. **QuickBooks did the arithmetic.** These are the
authoritative totals, and the only ones that already include everything SILO
never sees: invoices, bills, payroll, payments, manual entries made in QBO.

- Grain: a whole report, not rows.
- Freshness: the moment it was fetched. It is a photograph; it does not update.
- Completeness: whatever the QBO report covers, which is everything.

### 2. Retained GL detail (`qbo_history_imports` / `qbo_history_lines`)

Line-level GeneralLedger detail for an explicitly chosen window before
`accounting_start_date`, copied in and frozen. Immutable by trigger, each
import independent, overlapping windows are separate versions.

- Grain: one row per GL line.
- Freshness: frozen at import.
- Completeness: **only the windows someone imported.** There is no continuous
  history and nothing fills a gap. Two imports of overlapping windows are two
  versions of the same reality, not two halves of it.

### 3. SILO activity (`card_transactions`, `card_transaction_splits`, `journal_adjustments`)

What SILO itself coded and, for four batches so far, posted to QBO.

- Grain: transaction and journal line.
- Freshness: live.
- Completeness: card and bank feeds only — a fraction of the company's
  activity.

### The double-count

A posted card batch **is already in QBO**, so it is already in (1) and would
already be in (2) for a window covering it. A report that sums "QBO P&L plus
SILO coded spend" counts every posted batch twice. The rule:

> **A number is sourced from exactly one of the three, and the report says
> which.** They may be shown side by side and compared; they may never be
> summed.

The one legitimate cross-source operation is *reconciliation* — "SILO coded
$X to this account this month; QBO's P&L shows $Y" — and its whole value comes
from the two numbers being computed independently. That is the same shape as
`silo_report_tieouts`, which is the existing pattern to follow.

---

## Reuse, don't rebuild

The engine already exists and is already the right one:

- **`chat_run_readonly_query(query, p_offset)`** — SECURITY INVOKER, single
  SELECT/WITH, 1000-row pages, 30s statement timeout. Every read is scoped by
  the caller's own RLS, so a report can never surface rows its reader could not
  query by hand. CLAUDE.md is explicit that new authoring experiences go in
  front of this engine rather than building a second one.
- **`silo_chat_saved_reports`** — the generic saved-report layer (despite its
  name), with `parameters` for typed `{{token}}` substitution, `columns_metadata`
  for semantic column types, `builder_config` for re-opening a guided report,
  and `row_estimate` for authoring-time size.
- **`/v3/report-builder.html`, `/v3/dashboards.html`, `/v3/dashboard.html`** —
  guided authoring, the widget picker, slicers, drill-through.
- **`silo_report_tieouts`** — a second, independent path to every number a
  `system` report publishes, with `run_report_tieouts()` as the runner.

So the reporting layer is **mostly SQL views plus seeded `source = 'system'`
report definitions**, not a new runtime. That is a much smaller piece of work
than it first looks, and it inherits tenant isolation for free.

Two constraints that come with that reuse, both already written down and both
easy to violate here:

- A `system` report is **global** (`company_entity_id is null`) and is safe only
  because `chat_run_readonly_query` runs it under the caller's RLS. Every
  seeded definition must read an RLS-enabled table or a `security_invoker`
  view, **never a materialized view** — Postgres does not enforce RLS on
  matviews, so a global definition over one hands every tenant's rows to every
  tenant.
- Charts do not paginate. A report meant for a tile must aggregate to a shape
  that fits a page, or it silently draws the first 1000 rows.

---

## The bounded plan

Four PRs, in this order. Each is useful on its own and none of them is a
rewrite.

### PR A — make the sources legible (views + freshness)

No UI. Three `security_invoker` views and one function:

- `qbo_report_runs_v` — one row per stored report run with its report name,
  period, fetch time and **age**, so any surface can print "as of".
- `qbo_history_coverage_v` — per company: which date windows are imported, how
  many lines, where the **gaps** are, and whether windows overlap. This is what
  makes "incomplete import" sayable rather than invisible. With zero imports it
  returns "no history retained", which is the true and useful answer today.
- `silo_coded_activity_v` — SILO's own posted and unposted coded lines, through
  `card_coding_effective_lines` so a split contributes its lines and not a
  phantom parent, **tagged with whether the batch is posted** (posted = already
  in QBO = do not add to a QBO number).
- `accounting_source_freshness()` — one call returning, per source, the newest
  data and its age, for a header strip.

Tests: a database suite against the committed migrations, including a gap case,
an overlapping-windows case, and a split contributing exactly its lines.

### PR B — seeded system reports, with tie-outs

Four or five `source = 'system'` definitions over those views, each with at
least one `reconciliation` and one `sanity` row in `silo_report_tieouts`, as
`verify_v2_schema.sql` already requires:

- *Coded spend by account, by month* (source: SILO activity).
- *Coded spend vs QBO P&L by account* (explicitly a comparison, two columns,
  never a sum).
- *Card batch posting status* (what is drafted, approved, posted, voided).
- *Retained GL coverage* (the coverage view, so "what history do we hold" is a
  report anyone can open).
- *Journal adjustments raised and posted*.

Each carries `columns_metadata` so a currency column is not inferred from its
name, and `parameters` for period so one slicer drives a whole board.

### PR C — the drill-down, which is the actual ask

"Reports" today (`/v2/qbo-reports.html`) already drills account row → transaction
list → JournalEntry detail, by calling `quickbooks-report` live. That is the
right interaction and the wrong plumbing for a dashboard: it is a per-click QBO
round trip.

The drill-down to build is the SILO one, which no QBO round trip can give:
**account → the SILO transactions coded to it → the split lines → the batch →
the posted JournalEntry id**. Every hop is a table SILO owns, it works
offline from QBO, and it answers the question a bookkeeper actually asks
("why is this number what it is") in SILO's own terms.

Implemented as v3 drill-through (already supported: a widget can carry the
clicked value and the whole filter position to another dashboard), plus one
target board.

### PR D — freshness and completeness on the surface

Every reporting surface prints, beside the number and not in a tooltip:

- **which source** the number came from;
- **as of when** — for a QBO report, the fetch time, because a stored snapshot
  from three weeks ago looks exactly like a live one;
- **what is missing** — a GL window not imported, a batch not posted, a day the
  card feed did not cover.

The precedent is `/v2/seo-overview.html`, which carries freshness (data through
which day, lag) and coverage (unattributed share) beside every number, and
renders a prior-window absence as "not returned" rather than 0. Do the same
thing here, for the same reason: **absent is not zero**, and an accounting
screen that prints 0 for "we never imported that period" is worse than one that
prints nothing.

---

## What this plan deliberately does not do

- **No reporting-engine rebuild.** `chat_run_readonly_query` stays the only
  execution path.
- **No new posting or write path.** Reporting is read-only, including of
  `qbo_history_*`, which is immutable by trigger anyway.
- **No merged "SILO + QBO" ledger.** That is a book-of-record change, not a
  reporting change, and the boundary in [qbo-history.md](qbo-history.md) says
  QBO remains the book of record in this phase.
- **No claim of disconnect-readiness.** Matching GL closing balances to a trial
  balance does not prove every source document was retained, and the existing
  UI already says so. A reporting layer must not quietly start implying
  otherwise.

## Open question for Blake

Running the GL archive at all is a decision, not a default: it is the step that
turns source (2) from empty into partial. Until an import exists, PR A's
coverage view will correctly report "no retained history", and PRs B–D are
useful over sources (1) and (3) alone. Worth deciding before PR B, because it
changes which of the seeded reports are worth seeding first.
