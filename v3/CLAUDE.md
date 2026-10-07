# v3/ — dashboard and report runtime

**Read `v3/README.md` before changing anything here.** It records what was deliberately left out.
Table-level detail for `dashboards`, `dashboard_widgets`, `silo_chat_saved_reports` and
`dashboard_filter_views`: `docs/agents/database.md`.

- v3 is ONE feature, not the new home for pages. New tools still go in `v2/`.
- Dashboards are stored as CONFIGURATION, never HTML. A new visual option goes in schemaless
  `visual_config`; only a new `visual_type` needs a migration (the CHECK).
- `js/chart-adapter.js` is the only file that talks to ECharts. Defaults there apply to every tile on
  every board, so change them deliberately.
- `js/metrics.js` decides how a column combines: ratios pooled from numerator and denominator, or
  refused, **never averaged or summed**. `chart-adapter.js` pools through the same function.
- A column LABEL belongs to the report (`columns_metadata`); DISPLAY choices belong to the widget.
- Report `{{tokens}}` are substituted by `js/report-params.js` with typed checks. An undeclared token
  is an error, never a passthrough. Date slicers store the TOKEN (`today-27d`), not the resolved date.
- `js/filter-bar.js` is built once and updated in place. Rebuilding its `innerHTML` drops typed input.
- A KPI's title is never evidence of which column it shows.
- SILO (`system`) dashboards and reports are global and read-only to every client; changing one is a
  migration.
- Gradients are plain objects, never `echarts.graphic.*` (unit suites build options in node).
- Tests: `node v3/tests/run.js --unit` (no install). Browser suites need `cd v3/tests && npm install`
  and are skipped without it.
