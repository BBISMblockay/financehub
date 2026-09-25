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
const result = R.summary();
process.exit(result.fail ? 1 : 0);
