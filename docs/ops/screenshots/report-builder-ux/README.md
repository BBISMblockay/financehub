# Report builder UX — before / after (2026-09-25)

Screenshots for the report builder redesign PR. Kept in the repo so the PR is
readable a year from now, when the branch that produced it is gone (same
reasoning as `docs/ops/screenshots/v3-bi-workspace/`).

All sides show the **same report** — `sales_by_product_title_daily_v`,
grouped by product title, summed to Net Sales — rendered by the real
`/v3/report-builder.html` against the test suite's stubbed Supabase. No real
company data is in any of them; the two rows in the preview are fixture rows.

This went through three passes, each landing after the previous one was
reviewed and found wanting. Recorded here rather than squashed away, because
"what did we already try and why wasn't it enough" is exactly the thing a
screenshot folder should answer a year from now.

| File | What it shows |
|---|---|
| `before-desktop.png` | origin/main. One always-open form: a raw relname list with no grouping beyond kind, a field cloud with a `text`/`numeric`/`bigint` badge on every row, every measure/filter row always expanded, and — a bug this PR also fixes — a measure row whose `select`s each claimed the full row width and wrapped onto five stacked lines instead of one. Everything flush against hairline borders, no depth, no grouping. Table-only preview. |
| `after-desktop.png` | The same, configured report, current state. A large Rows/Values/Filters chip bar reading straight off the config (`Net Sales`, not `Sum of Net Sales` — the aggregation is implicit unless it's non-default); the field-type grid gone in favour of the rail's field browser (icon instead of a badge); Totals/Filters/Date/Sort/SQL collapsed behind a labelled chevron, opening only while empty or just edited; a segmented Chart/Table control; a titled chart card above a table card. The page reads as a set of floating cards on a light canvas — border-radius, a two-layer soft shadow, real gaps between them — reusing the exact shadow formula `v3/README.md` already documents for a dashboard tile, rather than the flush hairline-bordered strips of passes one and two. |
| `after-desktop-empty.png` | The same source, nothing configured yet. Compact by default: Date range and Filters sit open only because they are genuinely empty (a rolling window or a filter picked "by default" was the exact thing item 5 of the brief called out as misleading), the field browser and chips are the only place a field is added, and the whole build side settles into a handful of short cards instead of one long form. |
| `after-desktop-sql.png` | The SQL tab. The generated SQL sits in its own wider card (code wants room a chip list does not), with Run query beside it — this is the "collapsible, resizable dock" from item 4, styled to read as one now rather than a plain textarea in a tab pane. |
| `before-phone.png` / `after-phone.png` | 390px. The rail's height cap was sized for a bare source list; adding the field browser without also bounding it independently made rail content spill past its box and overlap the page below it — fixed by giving the source list and the field browser their own scrollports. The after state also shows the chip bar stacking into full-width cards rather than wrapping awkwardly. |

## What changed each pass, briefly

1. **Pass 1** added the chip bar, field browser, command search, chart-above-table preview, and the friendly/grouped rail — but left the original always-open field-type grid and rule editors in place underneath the chips, so the page still read as the same dense form with a summary bar bolted on top.
2. **Pass 2** removed the field-type grid (the rail's field browser replaced it), collapsed Totals/Filters/Date/Sort/SQL behind `<details>`, and dropped the "Sum of" verbosity from chip text — the right structural change, but styled with the same flush hairline borders and dashed boxes as the rest of beacon's dense form chrome, so it still read as unpolished.
3. **Pass 3** (current) is a visual pass on top of pass 2's structure: floating cards with real shadows and radius instead of bordered strips, a proper segmented Chart/Table control instead of a text-link toggle, hover states that are actually visible against a white card, reorder arrows that only render once there is something to reorder, and the removal of a status banner that had nothing to do with the new layout.

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
