# Report builder UX — before / after (2026-09-25)

Screenshots for the report builder redesign PR. Kept in the repo so the PR is
readable a year from now, when the branch that produced it is gone (same
reasoning as `docs/ops/screenshots/v3-bi-workspace/`).

Both sides show the **same report** — `sales_by_product_title_daily_v`,
grouped by product title, summed to Net Sales — rendered by the real
`/v3/report-builder.html` against the test suite's stubbed Supabase. No real
company data is in any of them; the two rows in the preview are fixture rows.

| File | What it shows |
|---|---|
| `before-desktop.png` | origin/main. One always-open form: a raw relname list with no grouping beyond kind, a field cloud with a `text`/`numeric`/`bigint` badge on every row, every measure/filter row always expanded, and — the bug this PR also fixes — a measure row whose `select`s each claimed the full row width and wrapped onto five stacked lines instead of one. Table-only preview. |
| `after-desktop.png` | The same report. The field-type grid is gone; a friendly source name with the technical relname tucked behind Details; sources grouped by business area; a field browser (Group by / Measures, click or drag to add, icon instead of a type badge); a large Rows/Values/Filters chip bar reading straight off the config (`Net Sales`, not `Sum of Net Sales` — the aggregation is implicit unless it's non-default); Totals/Filters/Date/Sort/SQL collapsed behind a labelled `▸`, opening only while empty or just edited; a titled chart drawn above the table. First pass of this PR still left the always-open form underneath the new chip bar, which read as decoration on an unchanged analyst tool — this is the second pass, after that feedback. |
| `before-phone.png` / `after-phone.png` | 390px. The rail's height cap was sized for a bare source list; adding the field browser without also bounding it independently made rail content spill past its box and overlap the page below it. Fixed by giving the source list and the field browser their own scrollports rather than sharing one fixed-height box. |

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
