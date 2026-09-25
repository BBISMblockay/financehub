/* A report opened to read: which tiles its temporary board gets. */
'use strict';
const { loadV3 } = require('../lib/load');
const { createReporter } = require('../lib/assert');
const g = loadV3(['report-preview.js']);
const P = g.SiloReportPreview;
const R = createReporter('report preview');
const { test, eq } = R;

const report = { id: 'r1', title: 'Daily Sales', description: 'd' };
const table = P.tableWidget(report, 0, { query_sql: 'select 1', report_parameters: null });

test('the board has no id, so nothing can be saved against it', () => {
  eq(P.previewBoard(report).id, null);
  eq(P.previewBoard(report).name, 'Daily Sales');
});
test('the table is full width and carries the report fields', () => {
  eq(table.layout.w, 12);
  eq(table.query_sql, 'select 1');
  eq(table.visual_type, 'table');
});
test('no chart when the recommendation is a table', () => {
  eq(P.chartWidget(table, { visual_type: 'table' }), null);
  eq(P.arrange(table, null).map((w) => w.id), [P.TABLE_ID]);
});
test('a chart sits above the table; a KPI stays small', () => {
  const line = P.chartWidget(table, { visual_type: 'line', visual_config: { x_field: 'day_date' } });
  eq(P.arrange(table, line).map((w) => [w.id, w.layout.y]), [[P.CHART_ID, 0], [P.TABLE_ID, 5]]);
  eq(P.chartWidget(table, { visual_type: 'kpi' }).layout.w, 4);
  eq(table.layout.y, 0, 'arrange does not move the original table object');
});
test('a report can name the column its chart plots', () => {
  const rec = { visual_type: 'line', visual_config: { x_field: 'day_date', y_field: 'ad_spend' } };
  const rows = [{ day_date: '2026-09-01', ad_spend: 10, mer: 3.2 }];
  eq(P.preferPrimary(rec, { mer: { semantic: 'number', chart_primary: true } }, rows).visual_config.y_field, 'mer');
  eq(P.preferPrimary(rec, {}, rows).visual_config.y_field, 'ad_spend', 'unflagged: recommendation stands');
  eq(P.preferPrimary(rec, { roas: { chart_primary: true } }, rows).visual_config.y_field, 'ad_spend', 'absent column ignored');
});
test('a report can name the column its chart is broken out by: a top-10 ranking', () => {
  const rec = { visual_type: 'bar', visual_config: { x_field: 'kind', y_field: 'sends', sort: 'desc', limit: 10 } };
  const rows = [{ kind: 'campaign', message: 'Fall drop', sends: 900, attributed_revenue: 1200 }];
  const meta = { message: { chart_dimension: true }, attributed_revenue: { chart_primary: true } };
  const out = P.preferPrimary(rec, meta, rows);
  eq(out.visual_type, 'bar');
  eq([out.visual_config.x_field, out.visual_config.y_field, out.visual_config.sort, out.visual_config.limit],
     ['message', 'attributed_revenue', 'desc', 10]);
  eq(rec.visual_config.x_field, 'kind', 'the recommendation object is not mutated');
  eq(P.preferPrimary({ visual_type: 'donut', visual_config: {} }, meta, rows).visual_type, 'bar',
     'a named breakout is drawn as a ranking, never a donut');
});
const result = R.summary();
process.exit(result.fail ? 1 : 0);
