# On Deck business briefing

## Preflight (October 8, 2026)

Requested experience: one evidence-backed next move, at most two secondary
actions, potential benefit and a prepared next step. Beacon rendering shown
before implementation. Default On Deck view becomes Briefing; All work retains
the existing proposal, coding, evidence, revision, decision and receipt flows.
No login redirect or sidebar gating changes: existing user landing preferences
and direct links remain intact.

Call sites: on-deck.js init/load, coding onChange, renderReady/renderAfter,
proposalCard, select/renderDetail, and view-tab handlers. Inputs: the already
authorized company-scoped proposal/settings queries and finance-gated coding
items. The new briefing model is pure; it makes no API calls or writes. No
policy, grant, migration, worker, provider, scheduler or destructive operation
changes. Existing displayed-version/source/approval gates remain authoritative.

Selection requires a ready, recommended, nonempty draft, no missing inputs, a
valid unexpired evidence window and kind-specific numeric evidence. Automatically
discovered ads/SEO/restock precede employee-prepared launches. Restock timing can
raise urgency; cross-workflow monetary/SEO/ad scores are not compared. Stable
ordering uses within-kind source rank, not draft version or updated_at, so a
routine refresh alone cannot promote an item. SEO with identical inspected and
proposed metadata stays off the briefing. Potential benefits are hypotheses,
not forecasts; no inferred revenue, savings, CTR decline or causal claims.

Partial reads fail independently. A failed refresh clears that domain's stale
briefing candidates and reports the error while the other authorized domain
stays available. A company mismatch clears the briefing. Read-only actions
open the existing reviewer, never approve or publish. Repeated refreshes do
not write; explicit preparation retains the existing RPC. User selection is
preserved in All work. Completed receipts are described as records, not ROI.

Tests defined before implementation: ready/missing/expired/unrecommended and
unknown-kind exclusion; unchanged SEO metadata; stable refresh ordering;
automatic source preference; actual source metrics and no fabricated outcomes;
bounded one-plus-two presentation; review/evidence routing; all-work/back flow;
coding-only and proposal-only access; partial refresh failure; company change;
loading/disabled/empty/error states; text-only untrusted input; keyboard focus;
light/dark desktop and narrow mobile bounds; existing proposal approvals and
transaction coding regression suites. Mutate eligibility and presentation
limits to demonstrate test failures.

Live-only unknowns: production source quality and stored draft completeness,
actual timing of preparation, and authorization of each destination workflow.
Local browser fixtures verify the real frontend wiring without production
mutations. No provider runs or production deployment are part of this PR.

## Implementation and verification

The default Briefing uses existing authorized rows only. All work retains
proposal edits, evidence, history, exact-version approvals, finance review and
ledger receipts. The briefing adds no API or provider calls. Its read-only
buttons open those reviewers with the selected record and evidence tab.
Potential benefits and evaluation guidance are deterministic per workflow;
they do not imply that SILO automatically runs an experiment or measures lift.
One recent confirmed proposal handoff is shown as a recorded action, not ROI.

Eligibility is deliberately conservative. The current free-text SEO contract
must expose a Draft/Proposed Title (Tag) or Meta Description different from the
inspection; ambiguous formatting stays available in All work. This does not
change backend qualification or approval. Numeric performance indices remain
observations, and the backend's source rank is respected without comparing
revenue, impression and ad score units. A routine draft refresh is not a rank
signal. Source freshness is represented by the stored validity window, not
an assertion that every integration succeeded overnight.

Local checks: all 30 v2 unit suites in a clean checkout of the same base plus
the exact changed files; all 35 v2 browser suites; final targeted briefing,
proposal and coding suites (11, 11 and 22 checks). Ready-gate, expiry-gate and
one-plus-two-limit mutations each cause the briefing unit tests to fail.
Desktop/light, desktop/dark and 390px mobile captures inspected. Full unit
verification uses the clean checkout because Windows CRLF conversion changes
three unrelated content-hash tests; no unrelated files were normalized.

No migration, Edge deployment, provider invocation or production mutation.
Login routing, personal default pages and navigation gates are unchanged.
After merge, normal static deployment serves the revised On Deck page.

## Growth focus follow-up preflight

Production revealed that all six growth drafts were needs_info, leaving routine bank classifications as the featured action. Routine coding and employee launch work must never occupy the growth hero. Add a separate, explicitly investigative SEO signal for valid screened search evidence even when its draft needs context; it opens Evidence and preserves every approval gate. Never invent a changed draft, missing benchmark, forecast or automatic provider search. Keep bookkeeping as one quiet supporting item. Render a wide main opportunity beside a compact supporting rail, colored semantic symbols, ready/context labels, a prepared-note treatment and larger typography with shared Beacon blue in both themes. Verify real needs_info SEO routing, coding-only fallback, mixed-domain ranking, expiry/read errors, permissions, responsive bounds and screenshots of both ready and investigative states before opening a follow-up PR.

Follow-up implementation: qualified needs_info ads and SEO evidence can produce an explicitly investigative action, ranked below ready growth drafts and routed to the exact Evidence tab in Needs you. No approval gate is relaxed. Coding and employee-prepared launch work are limited to a quiet supporting item and never featured. The desktop growth hero/rail, colored SVG symbols, ready/context statuses, highlighted prepared note, shared Beacon blue, and mobile stacking are rendered from the real frontend. All 31 unit suites pass; new regressions reject bookkeeping promotion and expiry bypass. Browser checks verify investigative routing, disabled SEO approval, exact selected row, finance-only fallback, refresh failures, company switching, ready flows, and mobile bounds.

## Task handoff preflight

The investigative action reaches a needs_info proposal with a disabled creation button and no explanation on the draft tab. Show a persistent next-step/input panel on every detail tab. Classify only the three audited SEO contextual research labels as research that may explicitly be carried into an unpublished draft task; unknown labels remain essential inputs. Collect required facts, preserve unanswered questions in the actual destination body, and save through the existing versioned edit RPC. A separate reviewed approval creates the task through the existing gate. Preserve exact selected proposal through edits and completion and show its real receipt. No scheduler/provider call, SQL or approval-gate change. Tests must exercise blocked click -> task prep -> saved ready version -> confirmed draft task receipt, required inputs, partial deferral, expired/stale errors, text safety and phone layout.

Task handoff verification: all 31 unit and 36 browser suites pass. The final 13-check briefing browser suite additionally verifies save refusal on stale evidence leaves the dialog and proposal blocked, exact edited-version confirmation, preservation of unanswered research in the created draft body, and immediate exact-proposal receipt. The research-loss mutation fails the new unit test. The existing SEO approval SQL was inspected: proposed_body receives content.body and approval_status is draft; edits remain gated by source version, displayed version and reviewer access. No database policy or schema changed and no production task was created. Desktop next-step and phone task-prep renders were inspected.
