# Report builder UX — before / after (2026-09-25)

Screenshots for the report builder redesign PR. Kept in the repo so the PR is
readable a year from now, when the branch that produced it is gone (same
reasoning as `docs/ops/screenshots/v3-bi-workspace/`).

All sides show the **same report** — `sales_by_product_title_daily_v`,
grouped by product title, summed to Net Sales — rendered by the real
`/v3/report-builder.html` against the test suite's stubbed Supabase. No real
company data is in any of them; the two rows in the preview are fixture rows.

This went through five passes, each landing after the previous one was
reviewed and found wanting. Recorded here rather than squashed away, because
"what did we already try and why wasn't it enough" is exactly the thing a
screenshot folder should answer a year from now.

| File | What it shows |
|---|---|
| `before-desktop.png` | origin/main. One always-open form: a raw relname list with no grouping beyond kind, a field cloud with a `text`/`numeric`/`bigint` badge on every row, every measure/filter row always expanded, and — a bug this PR also fixes — a measure row whose `select`s each claimed the full row width and wrapped onto five stacked lines instead of one. Everything flush against hairline borders, no depth, no grouping. Table-only preview. |
| `after-desktop.png` | The same, configured report, current state (pass 5). A Rows/Values/Filters chip bar reading straight off the config (`Net Sales`, not `Sum of Net Sales` — the aggregation is implicit unless it's non-default); the field-type grid gone in favour of the rail's field browser (icon instead of a badge); Summarise/Date range/Filters/Totals/Sort/SQL now live in **one bordered panel** with a divider between each row, rather than as separate floating cards; a segmented Chart/Table control; a chart card above a flat table. Everything renders in one continuous, natural-height column — see pass 5 below for why that specific property is the point of this screenshot, not just its layout. |
| `after-desktop-empty.png` | The same source, nothing configured yet. Compact by default: Date range and Filters sit open only because they are genuinely empty (a rolling window or a filter picked "by default" was the exact thing item 5 of the brief called out as misleading), the field browser and chips are the only place a field is added, and the whole build side settles into one short panel instead of one long form or a stack of separate cards. |
| `after-desktop-sql.png` | The SQL tab. The generated SQL sits in its own wider, flat card (code wants room a chip list does not), with Run query beside it — this is the "collapsible, resizable dock" from item 4, styled to read as one calm surface rather than a plain textarea in a tab pane or a heavily-shadowed box. |
| `before-phone.png` / `after-phone.png` | 390px. The rail's height cap was sized for a bare source list; adding the field browser without also bounding it independently made rail content spill past its box and overlap the page below it — fixed by giving the source list and the field browser their own scrollports (pass 1–3). Pass 5 fixed a second, more severe mobile bug underneath that one: see below. |

## What changed each pass, briefly

1. **Pass 1** added the chip bar, field browser, command search, chart-above-table preview, and the friendly/grouped rail — but left the original always-open field-type grid and rule editors in place underneath the chips, so the page still read as the same dense form with a summary bar bolted on top.
2. **Pass 2** removed the field-type grid (the rail's field browser replaced it), collapsed Totals/Filters/Date/Sort/SQL behind `<details>`, and dropped the "Sum of" verbosity from chip text — the right structural change, but styled with the same flush hairline borders and dashed boxes as the rest of beacon's dense form chrome, so it still read as unpolished.
3. **Pass 3** was a visual pass on top of pass 2's structure: floating cards with real shadows and radius instead of bordered strips, a proper segmented Chart/Table control instead of a text-link toggle, hover states that are actually visible against a white card, reorder arrows that only render once there is something to reorder, and the removal of a status banner that had nothing to do with the new layout. Feedback after this pass: still reads as "horrible spacing," not smooth, not close enough to the mockup layout — pass 3 had over-corrected by giving nearly every section (rail, each of five editors individually, table, chart, params) its own floating white card with a heavy two-layer shadow, which reads as busier and boxier than either mockup.
4. **Pass 4** reverses that: `.rb-card` drops back to a border + radius with no shadow by default (a `.rb-card--lift` variant exists for the rare case that still wants one); the rail goes back to a flat panel with a plain right border, no card, no white background; Summarise, Date range, Filters, Totals, Sort and the generated-SQL disclosure are consolidated into **one** `.rb-editor-group` panel with internal dividers instead of five separate shadowed boxes; only the chip row and the chart card keep a hairline shadow (`var(--bcn-shadow)`, beacon's own token, not the two-layer mix); the results table is fully flat (no border, no shadow) so it reads as part of the canvas rather than another floating box.
5. **Pass 5** (current) is not a visual pass — the user sent back a screenshot of the real page (not a mockup) with a genuinely broken area circled: a "+ Add a filter" button floating alone with no visible header above it, a stray cut-off word, then the Parameters card immediately below with no transition. That screenshot exposed two real bugs pass 4's own screenshots had not caught (both reproduced and confirmed against the live page before being called bugs, not inferred from the picture alone):
   - **A `<details>` element never closes once it has ever opened empty.** `renderBuild()` tracked "did the user open this section" with a `toggle` event listener, but Chromium fires a synthetic `toggle` the instant a freshly-rendered `<details open>` is inserted into the DOM — confirmed by attaching a page-level listener and watching two fire on the very first render, before any click happened. That synthetic event was read as "the user opened this," so `secDate`, `secFilters` and `secMeasures` got permanently stuck open the first time each was empty, even after they were filled in — stacking three-plus open editors into one very tall panel. Fixed by tracking a real `click` on `<summary>` instead, which only fires on actual user interaction.
   - **`.rb-panes` lost a flex-shrink fight the moment Preview held a real chart+table.** `.rb-panes` (Build/SQL) had `flex: 1` with a `0%` basis, while `.rb-params` and `.rb-preview` were sized by their own content as ordinary siblings in the same flex column. The moment Preview had a real result to draw, flexbox's shrink algorithm gave Params and Preview their full content height and left `.rb-panes` a ~110px sliver — showing one random, uncontextualized fragment of whichever editor the leftover scroll position happened to land on. Confirmed by measuring `.rb-panes`' computed height directly before and after Preview rendered real rows (419px → 111px, no user action in between). Fixed by making `.rb-main` the single scroll owner for the whole right-hand column — Build, Params and Preview all render at their natural height in one continuous flow, and nothing is ever squeezed to make room for a sibling. A capped `max-height` was added to the results table (`.rb-preview-body`) so a very large result set still gets its own internal scrollbar rather than stretching the whole page.
   
   Fixing the second bug surfaced a **third**, pre-existing bug specific to the phone layout, silent until then: at the 860px breakpoint the rail (source list + field browser) is taller than the entire viewport budget, and `.rb-main` — which had always computed to a genuine 0×0 box there, on `main` itself, independent of anything above — used to leave that overflow visible (so content still rendered, just spilling past its own box onto whatever came after it in the page). Once `.rb-main` gained real overflow handling as part of the fix above, that same 0-height box started **clipping** its content instead of merely mis-positioning it, which made every Build control on a phone genuinely unreachable (confirmed: the automated phone screenshot script, which had run clean on every prior pass, started timing out trying to click the Summarise checkbox — intercepted by the rail's own overflow sitting in the same screen position). Fixed by letting `.rb-layout`/`.rb-main` take their natural content height at that breakpoint instead of being forced to fit the viewport, so the overflow reaches `.silo-main`'s own pre-existing page scroll (`v2/beacon.css`) instead of a zero-height scrollport nothing could ever be scrolled into.
   
   All three were confirmed by direct measurement against the live page (computed heights, a page-level `toggle` listener, before/after diffs) before being treated as bugs, and all three are covered by the existing 37-suite regression run, which stayed green throughout.

## Regenerating

```bash
cd v3/tests && npm install && npx playwright install chromium
```

Then drive `/v3/report-builder.html` with Playwright against
`v3/tests/lib/harness.js`'s `startSuite()` — pick a source, turn on
Summarise, add a total, group by a dimension, Preview, screenshot. There is
no checked-in script for this (same reasoning as the BI workspace folder):
"before" means whatever the previous build looked like, which only makes
sense re-derived at the time, via `git stash` or a worktree at the base
commit running its own copy of the harness.
