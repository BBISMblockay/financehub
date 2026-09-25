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
test('a report that declares its queries draws each one, titled, in order', () => {
  const r = { id: 'r', title: 'Inventory Summary', queries_run: ['q0', 'q1', 'q2'],
    columns_metadata: { _queries: [{ index: 0, title: 'Total', chart: false }, { index: 1, title: 'By type' }, { index: 2, title: 'By SKU', chart: false }] } };
  eq(P.declaredQueries(r), [
    { index: 0, title: 'Total', chart: false }, { index: 1, title: 'By type', chart: true }, { index: 2, title: 'By SKU', chart: false }]);
  const t = P.queryTable(r, { index: 1, title: 'By type' }, { query_sql: 'q1' });
  eq([t.id, t.title, t.query_index, t.query_sql], ['preview-q1-table', 'By type', 1, 'q1']);
});
test('without a declaration a report is a transcript: nothing declared', () => {
  eq(P.declaredQueries({ queries_run: ['a', 'b'], columns_metadata: { spend: { semantic: 'currency' } } }), null);
  eq(P.declaredQueries({ queries_run: ['a'] }), null);
});
test('malformed entries are dropped, never guessed at', () => {
  const r = { queries_run: ['a', 'b'], columns_metadata: { _queries: [
    { index: 5, title: 'x' }, { index: 1.5 }, { index: 0 }, { index: 0, title: 'dup' }, null, { index: '1', title: 'B' }] } };
  eq(P.declaredQueries(r), [{ index: 0, title: 'Query 1', chart: true }, { index: 1, title: 'B', chart: true }]);
  eq(P.declaredQueries({ queries_run: ['a'], columns_metadata: { _queries: [{ index: 3 }] } }), null);
});
test('parts stack in order, each chart directly above its own table', () => {
  const t0 = { id: 't0', layout: { x: 0, y: 0, w: 12, h: 8 } };
  const t1 = { id: 't1', layout: { x: 0, y: 0, w: 12, h: 8 } };
  const c1 = { id: 'c1', layout: { x: 0, y: 0, w: 12, h: 5 } };
  const out = P.stack([{ table: t0, rowCount: 1 }, { table: t1, chart: c1, rowCount: 40 }]);
  eq(out.map((w) => [w.id, w.layout.y, w.layout.h]), [['t0', 0, 3], ['c1', 3, 5], ['t1', 8, 9]]);
  eq(out.map((w) => w.sort_order), [0, 1, 2]);
  eq(t1.layout.y, 0, 'inputs are not moved');
});
test('a chart for a part gets its own id', () => {
  const t = P.queryTable({ id: 'r', title: 'X' }, { index: 2, title: 'Y' }, {});
  eq(P.chartWidget(t, { visual_type: 'bar', visual_config: {} }, P.queryChartId(2)).id, 'preview-q2-chart');
});

const result = R.summary();
process.exit(result.fail ? 1 : 0);
