# v3/ — two features: dashboards/reports, and Product Studio

v3 is not the new home for pages; new tools still go in `v2/`. It holds exactly two surfaces, with
separate rules.

## Product Studio — `product-workflow.html`, `product-workflow-*.js/.css`, `product-studio-images.js`

**Read `docs/ops/product-workflow-preview.md` before changing it**; it covers `product_workflow_briefs`
and the gate. `product_concepts` detail: `docs/agents/database.md`.
- **Ready for PO is not `product_concepts.status = 'approved'`.** It is a concept brief a person marked
  ready (`po_ready_at/by`). It is checked by `product_concept_po_readiness_issues()` both when marking
  and when creating the PO, and it is bound to the reviewed brief and a fingerprint of the concept's
  purchasing fields. Never add a path to a PO that skips that gate.
- `trg_guard_concept_po_writes` refuses browser writes that attach a concept to a PO. The hidden
  `#btnFromConcept` picker in `v2/po-builder.html` stays hidden.
- One concept, one PO from this flow.
- Tests: `v3/tests/unit/product-workflow.test.js`, `v3/tests/browser/product-workflow.test.js`,
  `scripts/tests/product-workflow-database.test.mjs`, `product-workflow-spread-database.test.mjs`,
  `product-studio-ready-for-po-database.test.mjs`.

## Dashboards and reports — `dashboards.html`, `dashboard.html`, `report-builder.html`, `js/`, `dashboard.css`

**Read `v3/README.md` before changing them.** It records what was deliberately left out. Table detail
(`dashboards`, `dashboard_widgets`, `silo_chat_saved_reports`, `dashboard_filter_views`):
`docs/agents/database.md`.
- Dashboards are stored as CONFIGURATION, never HTML. A new visual option goes in schemaless
  `visual_config`; only a new `visual_type` needs a migration (the CHECK constraint).
- `js/chart-adapter.js` is the only file that talks to ECharts. Its defaults apply to every tile on
  every board.
- `js/metrics.js` decides how a column combines: ratios are pooled from numerator and denominator or
  refused, **never averaged or summed**. `chart-adapter.js` pools through the same function.
- A column LABEL belongs to the report (`columns_metadata`); DISPLAY choices belong to the widget.
- Report `{{tokens}}` are substituted by `js/report-params.js` with typed checks. An undeclared token
  is an error, never a passthrough. Date slicers store the TOKEN (`today-27d`), not the resolved date.
- `js/filter-bar.js` is built once and updated in place. Rebuilding its `innerHTML` drops typed input.
- A KPI's title is never evidence of which column it shows.
- SILO (`system`) dashboards and reports are global and read-only to every client; changing one is a
  migration.
- Gradients are plain objects, never `echarts.graphic.*` (the unit suites build options in node).

## Tests
`node v3/tests/run.js --unit` needs no install. Browser suites need `cd v3/tests && npm install` and are
skipped without it.
