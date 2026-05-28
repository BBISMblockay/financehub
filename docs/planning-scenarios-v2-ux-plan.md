# Planning Scenarios v2 — UX/UI/Perf pass (plan)

Status: PLAN. No engine or page logic is changed in this PR — only this document.
Target files for the follow-up PR:
- `v2/planning-scenarios.html` (chrome script + markup)
- `pages/planning-scenarios-engine.js` (load order, KPI gating, seed semantics)
- `docs/planning-scenarios-filter-scope.md` (acceptance updates)

Reference:
- v1 (works in theory, simpler): `legacy/pages/planning-scenarios.html`
- v2 (current, but underperforming UX): `v2/planning-scenarios.html` + `pages/planning-scenarios-engine.js`

---

## 1. Why v2 is not working as well as v1

Comparing the two pages side by side and tracing the engine, v2 has eight concrete regressions vs v1. They are individually small but compound into a slow, confusing first-run.

### 1.1 Two overlapping mode dimensions are conflated in chrome
v1 has **one** mode dimension that matters for the user: `selPlanMode` = `historical` | `revenue_plan`. Seeding is three independent buttons (`Seed from Historical`, `Seed Mix`, `Seed ASP`) that always live next to their table.

v2 introduces a second dimension — `seedMode` = `historical` | `projections` | `manual` — driven from `filtersCard.dataset.seedMode` (see `v2/planning-scenarios.html` ~L1547, `SEED_META`). The legacy `selPlanMode` still exists but is buried inside `<details class="ps-advanced">` (~L1019). Engine still reads both (`getPlanMode()` and `getSeedMode()` in `planning-scenarios-engine.js` L28).

Result: users cannot tell whether they are picking a *calculation* mode or a *seed source*. The "Manual" seed button does not change calculation — it just toggles a CSS data-attribute — but it looks like a third calculation mode next to Historical/Projections.

### 1.2 Seed-mode buttons are destructive and synchronous
`v2/planning-scenarios.html` L1628–L1636: clicking any seed button immediately calls `seedCurrentMode()`, which (for `historical`) fires `btnSeedRevenue`, `btnSeedMix`, `btnSeedAsp` in order, each of which **overwrites every `revplan_*` / `mixplan_*` / `aspplan_*` input** for the selected month range and re-runs the full scenario (`seedRevenuePlan` → `runFull` in engine L41).

v1 makes these three actions individual buttons next to each card with no auto-fire on tab switch. v2's auto-seed-on-click destroys whatever the user has typed and is the single biggest cause of "I lost my numbers".

### 1.3 Projections load is gated behind a destructive click
`loadProjectionData()` (engine L17) is the only call site that ever populates `PROJ_ROWS`, and it is only invoked from `seedRevenueFromProjections()` (engine L64). That function is called from `clickHidden('btnSeedFromProjections')` inside `seedCurrentMode()`.

So switching to "Projections" mode triggers, in order:
1. Network call against `revenue_projections` (no prefetch, no spinner inside the panel — only `statusLine` text).
2. `revplan_*` overwrite for every month.
3. `runFull()` which then triggers `loadHeavyData()` (inventory + open PO).

That is two large round trips before the user sees any output. KPIs show "After run" / "Run scenario" the whole time. `projSummaryRollupRows` text is read 250 ms later by a `setTimeout` in `updateDerivedStatus` (~L1611) — it almost always reads `—` on the first switch because the load is still in flight.

### 1.4 Heavy data is lazy but the UI does not reflect it
`loadHeavyData()` (engine L16) is only called on the first `runFull()`. Inventory and open-PO tabs/cards show "Run scenario" until then. The KPI strip shows static placeholders that look broken (`kpiInventoryGap` = "Run scenario", `kpiOpenPoImpact` = "After run"). v1 loads everything in `loadAll()` and renders complete numbers immediately.

The intent (perf) is right; the execution leaves the page looking empty.

### 1.5 Plan inputs are tabbed — you can no longer see Revenue + Mix + ASP at once
v1 lays out the three editable cards side by side (`<section id="planningInputs" class="grid grid-cols-1 2xl:grid-cols-3 gap-3">` — legacy L25). v2 collapses them behind three tabs (`ps-plan-tab` Revenue / Mix / ASP, page L1138–L1141 and L1144–L1190). The cause-and-effect between "I raised Mix for July" → "Month Σ live" → "Required units changes" is invisible when the user has to flip tabs.

### 1.6 Defaults shifted in a way that hides the value of the tool
v1 defaults `selScenario=25`, `numCustomLift=25`, `numSafetyPct=10`, so the user immediately sees a meaningful "+25% growth" scenario and a buffered gap.
v2 defaults all three to 0 (engine `ensureBaselineDefaults`, L61) and `CARD_SCENARIOS` to `[0,10,20,50]` (engine L6) vs v1's `[0,25,50,100]`. With 0% lift and 0% buffer the page intentionally looks like "no plan yet" — which is technically correct but kills the demo value.

### 1.7 Product-type setup story is incomplete in Projections mode
`revenue_projections` has no `product_type` column (see `docs/planning-scenarios-filter-scope.md`). v2 acknowledges this in `renderCalculationBasis` (engine L56) but the chrome doesn't *act* on it:
- Switching to Projections seed mode still leaves the `Product type` dropdown active and primary in the Scope lane.
- After projection seed, Mix is computed from filtered historical sales, but the UI shows the user-typed mix box.
- There's no inline reminder that "Mix and ASP will still come from historical for {{productType}}".

The intent is correct in the engine; the chrome doesn't surface it.

### 1.8 Family detail requires two interactions and one extra render
`_familyExpanded=false` by default (engine L9). `setFamilyExpanded(true)` is called from `setOutTab('families')` (page L1539). That gates the table behind: 1) Run, 2) open Families tab — and the table only fills when `_invLoaded` is true. v1 just renders families inline on every run with no gating.

---

## 2. Goals of the follow-up PR

1. Make the **calculator easier to drive**: one obvious mode picker + one obvious seed-source picker, never overlapping, never both inside Advanced.
2. Make **scenario setup for product types** explicit: when the user picks a product type, the page tells them what is being filtered and what is not (Projections seed is company-wide, Mix/ASP come from sales).
3. Make **mix / ASP / revenue selection mode** non-destructive: seed actions only fill cells that are blank by default; "Reseed (overwrite)" is a separate, explicit action.
4. Make **projections load fast and visible**: prefetch on boot in the background, show a panel-level spinner, never block the seed click on a cold load.
5. Restore the **v1 ergonomics that worked**: Revenue/Mix/ASP visible at once, sensible default lift/buffer, families visible after Run without an extra tab click.

Non-goals: do not change the engine math (`calculateRevenuePlanScenario`, `calculateHistoricalScenario`). v1-parity math is already correct per `docs/planning-scenarios-filter-scope.md`.

---

## 3. Concrete changes

### 3.1 Calculator-mode UX (Section ~L913–L1090 of `v2/planning-scenarios.html`)

Replace the three-button "Build from" strip + the hidden `selPlanMode` in Advanced with a single visible **two-axis control**:

| Axis | Control | Values |
|---|---|---|
| Calculation mode | `selPlanMode` (visible in Setup lane, replaces "Build from") | `Revenue Plan (revenue × mix ÷ asp)` · `Historical Lift` |
| Seed source for Revenue Plan | new `selSeedSource` radio group inside the Revenue tab header | `Historical sales` · `Revenue projections` · `Type it in` |

Why: "Calculation mode" picks the formula; "Seed source" picks where the *Revenue* column gets its starting numbers. v1 only had the first axis because there was only one seed source. v2 added a second axis but conflated it with the first.

Implementation notes:
- Move `selPlanMode` out of `<details class="ps-advanced">` into a dedicated `.ps-lane` labeled "Calculation".
- Remove `ps-seed-strip` and `btnSeedMonthlyPlan` from the setup header.
- Put the seed-source radio inside the Revenue plan card header (next to Seed/Reseed buttons — see 3.3).
- Remove the hidden `selDataSource` shim (page L1052, L1565); engine already keys off `selSeedSource` via `getSeedMode()` rewriting (see 3.6).

### 3.2 Product-type aware setup strip
Inside the Scope lane (page L933–L968):
- Add a small inline note under the product-type dropdown that updates live: `"Filters scenario math; not used to slice revenue projections (company-wide)."` when seed source is `projections`.
- When seed source is `historical`, the note reads: `"Used for Mix and ASP seed from sales."`.
- Add a "Lock to this type" toggle that disables Channel + Search when set (small UX nicety so users don't accidentally combine three filters and end up with empty data).

### 3.3 Non-destructive seeding (engine `seedRevenuePlan`, `seedMixPlan`, `seedAspPlan`, `seedRevenueFromProjections`)

Today:
```js
for (const month of selectedMonths()) {
  const node = el(`revplan_${month}`);
  if (node) node.value = Math.round(allRevenueForMonth(month));
}
```

Change to honor a single seed mode flag:
```js
function seedRevenuePlan({ overwrite = false } = {}) {
  for (const month of selectedMonths()) {
    const node = el(`revplan_${month}`);
    if (!node) continue;
    if (!overwrite && node.value !== "") continue;
    node.value = Math.round(allRevenueForMonth(month));
  }
  runFull();
}
```

UI: each plan card gets two buttons — `Seed blanks` (default) and `Reseed all (overwrite)` (with a confirm). Wire same pattern for mix/asp/projections.

This is the single biggest UX win: switching seed source no longer wipes user input.

### 3.4 Projections preload + visible loading state

- Call `loadProjectionData()` from the bottom of `loadAll()` (engine L80), after sales + locations succeed, **without blocking the boot render**. Use `Promise.resolve().then(() => loadProjectionData())` so the projection panel can populate while the user is reading the page.
- Add an in-panel spinner inside `#projSeedSection` (page L1092). Render `"Loading {{scenario}} projections…"` text bound to a new `_projLoading` flag in the engine.
- When `seedRevenueFromProjections` runs and `_projLoaded` is false, await the in-flight promise instead of starting a second load. Use a module-level `_projPromise` to dedupe.
- Replace the 250 ms `setTimeout(updateDerivedStatus, 250)` calls (page L1608, L1670, L1686) with explicit awaits on the engine promise: expose `await window.SiloPlanningScenarios.ensureProjections()` and await it from the chrome.

### 3.5 Heavy-data preload (optional, behind a feature flag)

Two options, in priority order:
1. **Preferred:** Keep lazy `loadHeavyData()` but start it in the *background* after `loadAll()` resolves, the same way as projections. Existing `_invLoaded` gate then trips by the time the user hits Run. Engine change is one line.
2. Alternative: keep current eager-on-first-Run behavior but add a top-right toast `"Loading inventory + open POs…"` so the empty KPI strip no longer looks broken.

### 3.6 Revenue / Mix / ASP visible together

Replace the `.ps-plan-tabs` tab pattern (page L1137–L1141, L1144–L1190) with a responsive 1/2/3-column grid (`grid-template-columns: repeat(auto-fit, minmax(360px, 1fr))`), so on wide screens all three cards show side-by-side (v1 parity) and on narrow they stack. Drop `.ps-plan-tab` listeners.

The tabs CSS can stay in `<style>` for now in case we re-introduce them on mobile.

### 3.7 Restore growth defaults

In `ensureBaselineDefaults()` (engine L61), default to a "growth preset" instead of zeros:
```js
function ensureBaselineDefaults() {
  if (el("selScenario")) el("selScenario").value = "25";
  if (el("numCustomLift")) el("numCustomLift").value = "25";
  if (el("numSafetyPct")) el("numSafetyPct").value = "10";
  if (el("selectedScenarioChip")) el("selectedScenarioChip").textContent = "+25%";
}
```

Also restore `CARD_SCENARIOS=[0,25,50,100]` (engine L6) so the four headline cards span Baseline → Aggressive like v1.

### 3.8 Ungate Family detail

In `renderFamilies()` (engine L74), drop the `if (!_familyExpanded)` early return when `_invLoaded` is true. Keep the early return *only* while inventory is still loading. Remove `setFamilyExpanded(true)` from `setOutTab('families')` (page L1539) since it becomes a no-op.

### 3.9 KPI strip honesty

In `renderKpiStrip()` (engine L55), when inventory is still loading display `"Loading…"` with a small spinner instead of `"Run scenario"` / `"After run"`. Only show numbers once `_invLoaded` is true.

### 3.10 Status strip cleanup

Drop the "Calculation basis" tile (page L1064–L1067) — it duplicates `calcBasisBody` text directly below it. Add a "Last run" tile so the user can see staleness.

---

## 4. File-by-file diff summary

| File | Lines touched (approx) | Nature |
|---|---|---|
| `v2/planning-scenarios.html` | L913–L1090 (setup card), L1133–L1190 (plan inputs), L1547–L1686 (chrome JS) | Restructure controls, drop tabs, rewire seed buttons, add projection prefetch await, drop `selDataSource` shim |
| `pages/planning-scenarios-engine.js` | L6 (`CARD_SCENARIOS`), L9 (`_projPromise` flag), L16–L17 (loaders), L41 (seed signatures), L51–L52 (KPI/loading gating), L55 (KPI strip honesty), L61 (defaults), L64 (projection await), L74 (family gating), L80 (background preload), L83 (export `ensureProjections`) | Targeted edits; no math changes |
| `docs/planning-scenarios-filter-scope.md` | Acceptance checklist | Add: "Seeding does not overwrite typed values unless Reseed is clicked", "Projections load in background after first paint", "+25%/10% buffer defaults render with non-zero KPIs after Run" |

No DB / migration changes. No new dependencies.

---

## 5. Acceptance criteria for the follow-up PR

- [ ] Calculator mode and seed source are two visible, distinct controls; neither is in Advanced.
- [ ] Switching seed source does not modify any plan input cell. "Seed blanks" fills blanks. "Reseed all" prompts and overwrites.
- [ ] Projection rows load in the background on boot; switching to Projections seed source never starts a fresh fetch (only re-uses the in-flight or completed promise).
- [ ] First paint of `projSeedSection` shows `"Loading projections…"`; the metrics tiles populate without a 250 ms blind `setTimeout`.
- [ ] Revenue, Mix, ASP cards are visible simultaneously at viewport ≥ 1200 px wide.
- [ ] Default scenario after Reset is +25% lift, 10% buffer, with headline cards Baseline / +25 / +50 / +100.
- [ ] Family detail renders after Run without opening the Families tab first (still capped at `_familyLimit=100` with "Show all" button).
- [ ] KPI strip never shows "After run" / "Run scenario" once `_invLoaded` is true.
- [ ] Selecting a product type while in Projections seed mode shows an inline reminder about what is and isn't sliced.

---

## 6. Risks and rollback

- Math is unchanged; the regression risk is purely UX.
- `selDataSource` removal will break any external bookmark/state that wrote to it. Risk is low (it has never been a labeled control), but keep a hidden compatibility shim that mirrors `selSeedSource → selDataSource` until the next release.
- Auto-prefetch in the background will increase boot bandwidth on first load. Acceptable tradeoff because `revenue_projections` is small (it's a planning table, not transactions).
- If background heavy-data preload turns out to compete with sales paint, fall back to option 3.5(2) (toast only).

---

## 7. Suggested commit sequence (in the follow-up PR)

1. `chore(planning-v2): restructure setup card — calc mode + seed source split` (chrome only, behind feature flag if needed)
2. `feat(planning-v2): non-destructive seed buttons (seed-blanks + reseed-all)`
3. `perf(planning-v2): background-prefetch projections + heavy data`
4. `ux(planning-v2): show Revenue/Mix/ASP cards together, drop tabs at ≥1200px`
5. `ux(planning-v2): +25%/10%/buffer defaults; restore v1 card scenario set`
6. `ux(planning-v2): ungate Family detail when inventory ready; KPI strip honest states`
7. `docs(planning): update filter-scope checklist for v2 UX pass`
