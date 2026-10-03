# Underwriting workspace

Direct URL: `/v2/underwriting/index.html`. This plain v2 Beacon page is deliberately
unlisted: no navigation, search, home, menu, accounting-suite or dashboard
registration. The existing report dashboard is untouched. There is no new app
framework, backend workflow, database schema or server persistence.

## Workflow

Four keyboard-accessible steps keep the work progressive:

1. **Business picture**: read-only QBO revenue/margin, balance-sheet/cash history,
   company sales plans, inventory valuation coverage and placed purchase orders
2. **Funding options**: dynamic loan/LOC register, current access, explicit debt
   schedule source, cash need, incremental payment room, conservative funding
   interval, proposal terms and amortizing/interest-only structure comparison
3. **Test the scenario**: cash projection, explicit weaker-sales/growth inputs,
   slower collections or inventory-cash recovery, with detailed monthly
   debt/PO/cash timeline and reviewed payment editors behind disclosures
4. **Review proposal**: concise draft underwriter memo with requested amount and
   terms, repayment basis, binding constraint, material risks, conditions and
   decision requested. Printable supporting schedules retain the working
   assumptions, per-facility evidence, receipt timing and source coverage

All output is analyst decision support. No approval/denial, credit eligibility,
score-based multiplier, lender offer or equity-investment model is implemented.
Nothing posts to books, starts a source sync, changes reports, uploads documents,
sends invitations or transmits a proposal. Document references are local notes.

## Authorization and sources

`context.js` verifies the signed-in user, current company and existing finance /
executive RPC gates. Existing RLS is the security boundary. Every direct table
read includes the company predicate. Fixed aggregate SQL uses the existing
authenticated SECURITY INVOKER read-only report RPC. No new grants or policies.

The context is rechecked after source reads, file reads, focus/visibility resume,
and before download, review capture or printing. Abort/generation guards reject
stale asynchronous loads. Auth/company changes clear all sources, facilities,
scenario inputs, review baseline and print material. Refreshing a changed matched
source balance invalidates its payment review and portfolio attestation.

Source semantics:

- One stored QBO connection anchors statements; latest failed attempts are not
  silently replaced with older successful facts. Monthly history is identified
  separately when a latest headline statement is cumulative
- BS ending stocks are not summed. Cumulative CF totals are not added to monthly
  columns. Scope-filtered, ambiguous, overlapped or future dates do not become
  company-wide monthly actuals
- Account matches use connection ID + QBO account ID, never lender-name guessing
- Bank current/provider-available balances retain status, environment and dates.
  LOC/ZBA sweeps or zero net movement do not establish operating breakeven
- Sales plans use the existing active daily/location projection schema. Plan
  currency, margin and collection definitions are not stored, so no authoritative
  plan variance or automatic cash conversion is invented
- Inventory is a recorded quantity/value-coverage snapshot, not eligible
  collateral or an invented aging report
- Placed POs retain status, arrival dates and cost coverage. Arrival is not a
  payment date, recorded cost is not unpaid balance, and partially received
  order quantities may still be full ordered quantities
- Missing, mixed-currency, partial, failed and truncated evidence remains visible

Prior live read-only preflight checked relevant policies, grants, source schema
and read-only EXPLAIN for six fixed aggregate queries. It did not impersonate an
end user or perform operational writes. This revision adds local models only.

## Multiple facilities and existing obligations

`facility-model.js` is pure and independent of source reads. Each stable-ID record
has explicit loan/LOC kind, currency, account match or evidenced manual balance,
as-of dates and payment evidence. Editable lender terms never overwrite books.

- LOC committed limit, borrowing base, reserves and lender net quote remain
  distinct. A net quote is not reduced by the draw a second time. Usable credit
  is bounded by documented limits/restrictions and current comparable draw
- Unknown availability remains null. A known subset is labeled a subtotal. The
  full total requires an attested register and complete comparable LOC evidence
- Loans do not create revolving availability. No undrawn line becomes cash or
  automatically offsets a funding gap; draw modeling is not implemented
- Duplicate source account matches/IDs are blocked. Switching matched accounts
  or balance evidence source clears lender terms and payment review
- Documented P&I uses an explicit monthly baseline and per-month overrides,
  including zero, balloons and no-payment months. It does not claim a remaining
  principal balance because total P&I alone cannot establish amortization
- Loan term schedules use documented opening principal, explicit first-due and
  final-due months, frequency and repayment type. Opening principal is not an
  inflow. A full regular interest interval is assumed; stub periods, fees,
  variable rates or intervening draws require documented payment input
- A term projection requires the opening balance on forecast day one or the
  preceding day. Older balances cannot be silently aged forward
- **Manual aggregate** and **sum of facility schedules** are exclusive sources of
  existing debt service. The other is reconciliation context, never added again
- Portfolio completeness and each facility’s schedule evidence are required in
  facility mode. Incomplete reference records do not invalidate an independently
  documented manual aggregate; the limitations stay visible

## Cash, debt and capacity math

Amounts are native-currency units. Cash before debt is operating cash after
expenses, tax, maintenance capex and ordinary working capital, before required
P&I. Source profit, debt balances or net financing flows never become capacity.
Monthly cash/debt overrides carry separate evidence. Existing debt is deducted
once; the proposed loan enters once, with fixed upfront fees and plan uses once.

`scenario-model.js` supports monthly/quarterly/annual amortization,
interest-only-plus-balloon and amortizing-balloon schedules, cents rounding,
zero rates and explicit maturity. First proposed payment is one full interval
following funding. Including a 36-month loan’s final payment needs 37 monthly
rows including funding. DSCR uses matched-month pre-debt cash / total required
P&I; no-payment months are N/A and ratios are not averaged.

`capacity-model.js` distinguishes raw pre-financing cash need from incremental
payment room and a feasible principal interval. It intersects every month’s
cash-floor inequality with the selected monthly coverage target, includes
financing fees and the loan’s own payment cost, and applies a conservative
rounding-error envelope. Production cents schedules verify the interval.
Incomplete or uncertifiable cases remain unassessed. No automatic lender policy.

A window-only result is explicitly scoped; maturity beyond the horizon and
pre-funding shortfalls never headline full-term capacity. Existing availability
remains separate. Zero borrowing can be feasible separately from a positive
principal interval. Full-term refers to the proposed loan’s modeled maturity,
not the lifetime payoff of every existing facility.

## Commitments and downside

Reviewed planned payments specify amount, month, currency, contract reference,
deposit/balance stage and whether the amount is incremental or already in the
cash/WC/other-use baseline. Duplicate references/month/stage are blocked;
included WC/other payments cannot exceed those same-month modeled uses. Missing
review suppresses cash-path conclusions. Edits invalidate the relevant review.

Growth funds additional inventory/operating WC, not an invented sales uplift.
Weaker sales/margin inputs are an explicit gross-contribution cash sensitivity,
not a full operating forecast with inferred expense offsets.

`cash-timing.js` moves explicitly documented receipt pools from an entered month
to a later recovery month. Collections and inventory cash recovery are separate
fixed scenarios. Amounts must be included in the original baseline and remain
collectible under the sales downside. Both enabled pools require explicit
nonoverlap review. PO payment dates and debt due dates do not move. Receipts
outside the horizon remain unreceived. Missing enabled assumptions block cash
conclusions; disabled cases do nothing. Inputs retain provenance.

## Local review and printable handoff

`review-snapshot.js` compares selected numeric/configuration facts against a
baseline only captured by the explicit review button or loaded from a scenario.
There is no fictitious history or background monitor. Stable semantic IDs prevent
metric reordering from comparing different facts. Currency, basis, period,
coverage and horizon changes suppress misleading numeric deltas. Raw source
rows, free-form notes, client names and credentials are not in review snapshots.

The memo prioritizes material gaps; calculation notes and evidence remain in
supporting detail. Print builds a static appendix with full proposal schedule,
per-facility P&I, terms/evidence, monthly overrides, commitment treatment and
receipt timing. It invokes the browser’s print dialog; nothing is sent.

## Scenario files

Version 4 is a full company-bound snapshot of values, overrides, commitments,
facilities, receipt timing and optional actual review baseline. Strict validation
rejects malformed/duplicate IDs, wrong companies, unsupported fields and invalid
numeric/date inputs. Draft unknowns can roundtrip but cannot qualify capacity.
Versions 1–3 require explicit re-entry rather than invented migration assumptions.
Maximum local file size is 2 MB, enforced before both import and export. Review
snapshots have a 2,000-fact bound; oversized captures are visibly unavailable.

## Verification and release hold

Run from repository root:

```
node --test v2/underwriting/tests/*.test.mjs
node v2/tests/run.js --unit
find v2/underwriting -name '*.js' -o -name '*.mjs' | xargs -n1 node --check
git diff --check
```

All fixtures are synthetic. Test coverage includes debt/amortization boundaries,
capacity interval certification, multiple-lender overlaps, source identity,
unknown/zero, currency, mode exclusivity, import replacement, stale async/auth
changes, receipt conservation, review provenance, keyboard tabs and print gating.
These new unit tests are not wired into the existing CI runner.

Browser suite (only in a supported authorized Chromium environment):

```
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium \
UW_OUTPUT=/absolute/path/to/screenshots \
node v2/underwriting/tests/browser.mjs
```

Browser/mobile/real authenticated walkthrough remains unverified here: Chromium
process sockets are blocked, hosted localhost is blocked and its file protocol
is disallowed. No restriction was relaxed or denied route retried. Shared images
are actual calculated synthetic DOM design renderings with preview-only PDF
layout adaptations, clearly labeled browser verification pending. Print layout
is also checked with a non-browser PDF renderer, not a browser print pass.

This change is submitted as a draft PR after the user reviewed the synthetic
design renderings. Browser/mobile/live-auth verification and company-specific
cash/lender evidence remain release gates. Merge, deployment and migration
application are not authorized by this PR.
