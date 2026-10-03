# Underwriting workspace

Direct URL: `/v2/underwriting/index.html`. One page, two modes: a Quick look that
lands first, and the four-step Advanced workflow. This plain v2 Beacon page is deliberately
unlisted: no navigation, search, home, menu, accounting-suite or dashboard
registration. The existing report dashboard is untouched. There is no new app
framework, backend workflow, database schema or server persistence.

## Quick look (lands first)

Most people open this page with one question: can the business carry this
loan? `quick-look.js` answers it from the saved QuickBooks statements with three
typed inputs (amount, rate, term; purpose optional) and shows what the answer
rests on, with dates:

- **From the books**: book bank balances and total assets from the latest
  balance sheet; average monthly revenue, gross profit, operating cash flow and
  net operating income over the complete months in the saved statements (up to
  12, partial months excluded).
- **Existing debt** is drafted from balance-sheet accounts by QuickBooks
  account TYPE, never by name: long-term liabilities and credit cards start
  ticked, other current liabilities (payables, tax, deferred revenue) start
  unticked. Balances are book balances; monthly payments are only what a person
  types. Unmatched liability accounts remain visible with an unknown balance.
  Incomplete account mapping or balance-sheet coverage blocks a positive Quick
  look verdict and withholds total debt and debt-to-assets ratios. Known amounts
  are labeled subtotals; excluded rows and unresolved coverage print in the proposal.
- **Verdict**: combined monthly service (new payment plus typed existing
  payments) as a share of average monthly operating cash flow (or net operating
  income when no cash-flow statement is saved). Up to 25% reads comfortable, up
  to 50% tight, above that does not fit; a non-positive basis does not fit;
  fewer than three complete months is "not enough history". **A ticked debt
  with no payment entered caps the verdict at tight** -- a payment nobody has
  entered is not a payment of zero. The rules are printed under the result.

**Figures as of** bounds EVERYTHING dated, not only the balance-sheet column
and the trailing windows. In the proposal, recorded sales stop at the as-of
month and "planned ahead" starts the month after it; a bank balance dated
after the month, or carrying no date at all, is named and left out (the feed
holds only its last position, and an undated current balance cannot be placed
on either side of the cutoff); the on-hand aggregate is dated by BOTH ends of its
rows (`asOf` is the oldest row, `newestAsOf` the newest) plus
`missingSnapshotRows`, and stands as of the month only when its newest row is
inside the month and every row is dated -- Store A synced in July and Store B
in October is October stock under an August cutoff whatever the oldest row
says -- otherwise it is named as held but not as of (SILO keeps no on-hand
history); and the PO register, which holds
CURRENT status only, prints the orders placed by the end of the month as a
stated lower bound (orders placed by then and received since are gone from
the placed set), or nothing when its 200-row detail list is capped. Nothing
dated after the as-of month is printed under a header that says "figures as
of" that month; Sources and dates still lists every source with its own date.
The forward outlook is the one thing that reaches past the as-of month, on
purpose: it starts the month after it.

**Judge on** picks the basis. *Sales plan ahead* (the default whenever the
company has a plan ahead) turns the stored active sales plan for the next 12
plan months into projected monthly operating cash: planned sales × plan
attainment × conversion, both measured over ONE calibration cohort -- the
complete months whose plan and recorded sales were matched location by
location by the plan parser (`matchedPlannedSales` / `matchedActualNetSales`,
never whole-month totals), whose plan was mostly RECORDED, and which the cash
source covers. "Mostly recorded" is a bound in dollars, not location-days: a
month in which more than 20% of planned sales (`maximumUnmeasuredPlanShare`)
fell on location-days with no recorded sales row does not calibrate. Measured
on the live plan (2026-10) every month carried 30-50% of its location-days
unrecorded -- event and pop-up locations are planned daily and trade rarely --
but only 1-9% of its planned dollars, so a location-day bound would switch
the basis off for the one company that has a plan, while a one-recorded-day
month still fails the dollar bound at 97% unrecorded. Attainment is matched
recorded sales ÷ EVERY planned dollar in the cohort months, the unrecorded
location-days included: the data cannot say whether such a day was a closed
seasonal store or a missing record, so its planned dollars count as
unattained and can only lower the figure. The share so counted is printed
beside it. Conversion is operating cash ÷ ALL recorded sales in those months
(streams the plan never covered included), floored month by month at the
planned locations' own sales: an unplanned location that nets to RETURNS for
a month would otherwise pull the denominator below the matched sales and
inflate the ratio (traced in review: $500k matched, $400k of unplanned
returns, $50k cash read as 50% conversion and projected five times the cash
the month produced). With the floor, attainment × conversion ≤ cash ÷ plan
holds by construction, and the months it bit are named in the reasons.
Measured 2026-10-03 the live unplanned stream is positive every month (the
Allen store and spring-training locations), so the floor is a guard, not a
correction. Applied to planned sales only. The cash source is the
saved cash-flow statement; net operating income stands in only when no cash-
flow statement is saved at all -- a thin one is incomplete coverage, never a
reason to read profit as cash. Fewer than three cohort months, or a plan row
that maps to no location (in history or ahead), means no forward basis, with
the reason named; the plan is never taken at face value. Recorded sales are
Shopify net sales, so the conversion keeps the Shopify-versus-QuickBooks scope
difference inside a measured ratio. The
verdict names the weakest plan month and always shows the other basis beside
the chosen one; the proposal carries the month-by-month plan table with planned
sales as plain numbers (no recorded currency). *Recent results* is the trailing
average over complete statement months.

**Figures as of** lists the complete months on the saved balance sheet (latest
by default). Choosing one re-dates the balance-sheet facts and the debt
balances to that month's column and ends every trailing average at it, so the
same request can be read as of a stronger or weaker window; the proposal says
which month it is as of. A month not on the statement falls back to the latest
and says so. The Advanced register always reads the latest statement balance.

The three inputs are the same fields as the advanced proposal, so switching to
the Advanced workflow finds them filled. **Ticked debts are the Advanced
facility register**: ticking creates a facility matched to that account
(`quick:<account id>`, payments mode, the typed payment as its monthly P&I),
unticking removes the facility Quick look made, a payment typed in either place
shows in both, and a facility removed in Advanced unticks the row. A facility a
person built by hand for the same account is never removed from Quick look.
When the first facilities arrive and the manual aggregate is blank, capacity
switches to facility mode once; a later choice of mode is kept. Opening cash is seeded once from book
bank balances (only when blank, with provenance naming the source and date; the
review box stays unchecked). Ticks and typed payments travel in the v4 scenario
file (`quick.debts`); balances come back from the live balance sheet.

**Draft proposal** (`quickProposalHtml`, previewed under "Draft proposal
preview" and printed by "Print draft proposal") is the document for an
underwriter, assembled entirely from the loaded sources plus the three inputs:
request and verdict; complete-month revenue, gross profit, margin, operating
income and operating cash flow with totals; the balance sheet lines as of its
date; live bank balances; ticked debt with totals and debt-to-assets; inventory
units and recorded value by product group with placed-PO arrivals by month;
recorded sales against the plan for the last six months and the next three; a
sources-and-dates table; and the rules it was judged by. A source that did not
load is named as such rather than left blank. A quick read of saved snapshots,
not an approval, covenant test or lender policy.

## Advanced workflow

Four keyboard-accessible steps keep the work progressive, behind the mode switch:

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
stale asynchronous loads. A DEFINITIVE answer (signed out, disabled, another
company, no finance/executive gate) clears all sources, facilities, scenario
inputs, review baseline and print material. A read that did not come back at all
(network blip, 5xx, a laptop waking before Wi-Fi) is TRANSIENT: `readContext`
marks it, the workspace is hidden behind a Retry, and nothing typed is lost --
the same stance `ensureActiveCompany()` takes toward a failed profile read. While
held, download, import, print and review capture refuse. Refreshing a changed
matched source balance invalidates its payment review and portfolio attestation.

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

A hand-entered existing payment is rounded to cents at ingestion, so every row,
the combined service, the horizon total and the capacity headroom read one figure.
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
Certified zero borrowing is reported as feasible with a zero ceiling on every
exit, including the one where no positive cent interval survives rounding. The
post-window residual and remaining service describe the headline CEILING (null
when nothing is borrowed), never the suggested minimum, which is 0 whenever zero
borrowing is feasible.

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
receipt timing. It invokes the browser’s print dialog; nothing is sent. The
packet is rebuilt from CURRENT inputs on every print, including the browser's
own Ctrl+P / File > Print (`beforeprint`), and emptied again afterwards: the
print stylesheet shows only the packet, so one left over from an earlier button
print would otherwise print an old amount with nothing on the page saying so.

## Scenario files

Version 4 is a full company-bound snapshot of values, overrides, commitments,
facilities, receipt timing and optional actual review baseline. Strict validation
rejects malformed/duplicate IDs, wrong companies, unsupported fields and invalid
numeric/date inputs. Facility and commitment IDs must fit the review-snapshot
identifier grammar (`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$`): a fact id is built
from them, and an id outside that grammar would make review capture permanently
unavailable after import. Monthly overrides are bounded to 1,200 months and an
empty month is not carried. Draft unknowns can roundtrip but cannot qualify
capacity. Versions 1–3 require explicit re-entry rather than invented migration
assumptions. Maximum local file size is 2 MB, enforced on the raw file before
import and on the compact serialization before export -- compact on purpose,
since a pretty-printed copy measured 1.46x larger and could turn a file that
imported into one that could not be downloaded again. Review snapshots have a
2,000-fact bound; oversized captures are visibly unavailable.

## Verification and release hold

Run from repository root:

```
node --test v2/underwriting/tests/*.test.mjs
node v2/underwriting/tests/browser.mjs --contract-only
node v2/tests/run.js --unit
find v2/underwriting -name '*.js' -o -name '*.mjs' | xargs -n1 node --check
git diff --check
```

All fixtures are synthetic. Test coverage includes debt/amortization boundaries,
capacity interval certification, multiple-lender overlaps, source identity,
unknown/zero, currency, mode exclusivity, import replacement, stale async/auth
changes, receipt conservation, review provenance, keyboard tabs and print gating.
The existing v2 page workflow runs these unit/integration tests and the synthetic
scenario contract on underwriting pull requests and main-branch changes. Both
checks use a bare Node 22 checkout without secrets, installs or live sources.
The contract check does not execute a browser. The same workflow's Chromium job
also runs the synthetic browser suite below using its existing Playwright install,
and retains synthetic desktop/mobile screenshots as CI artifacts. No live
credentials or company records are used; the normal Chromium sandbox is retained.

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

