'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');
const C = loadV3(PURE_MODULES).SiloChart;
const R = createReporter('summary-layout');
const { test, has, not, eq } = R;
const long = 'Read the coverage before deciding. '.repeat(12);
const rows = [{ month: 'August 2026', focus: 'Profit', result: long, amount: -534623, missing: null },
  { month: 'July 2026', focus: 'Margin', result: '<img src=x onerror=alert(1)>', amount: 0, missing: null }];
const cfg = { table_layout: 'summary', summary_heading: 'focus', sort: 'none', limit: 0 };
test('full text, all fields, null distinct from zero', () => {
  const h = C.tableHtml(rows, cfg, { amount: 'currency' });
  has(h, '<h3>Profit</h3>'); has(h, long); has(h, 'August 2026');
  has(h, 'Not returned'); has(h, '$0.00'); has(h, '-$534,623');
});
test('HTML-looking query values remain inert text', () => {
  const h = C.tableHtml(rows, cfg);
  not(h, '<img'); has(h, '&lt;img');
});
test('selection, limits and search keep the same scope as CSV', () => {
  const c = { ...cfg, columns: ['focus', 'result'], limit: 1 };
  const h = C.tableHtml(rows, c); const csv = C.tableCsv(rows, c);
  has(h, 'Showing 1 of 2'); not(h, 'August 2026'); not(csv, 'August 2026');
  const filtered = C.tableHtml(rows, cfg, null, { search: 'Margin' });
  not(filtered, '<h3>Profit</h3>'); has(filtered, '<h3>Margin</h3>'); has(filtered, 'Search matched 1 of 2');
});
test('ordinary tables unchanged, empty/removed heading safe', () => {
  has(C.tableHtml(rows, {}), '<table'); not(C.tableHtml(rows, {}), 'dw-summary-card');
  has(C.tableHtml(rows, { ...cfg, summary_heading: 'gone' }), '<h3>August 2026</h3>');
  has(C.tableHtml([], cfg), '0 rows'); has(C.tableHtml([{}], cfg), 'No columns');
});
test('summary totals still use shared aggregation', () => {
  const h = C.tableHtml(rows, { ...cfg, totals: 'row' }, { amount: 'currency' });
  has(h, 'dw-total-row'); has(h, '-$534,623');
});
test('negative compact currency has conventional sign placement', () => {
  eq(C.compact(-534623, 'currency'), '-$534.6k');
  eq(C.compact(534623, 'currency'), '$534.6k');
});
test('comparison label changes words, not value or rate calculation', () => {
  const h = C.kpiHtml([{ rate: 40.8, prior: 49.9 }], { y_field: 'rate', compare_field: 'prior', compare_label: 'Previous month' }, { rate: 'percent', prior: 'percent' });
  has(h, '40.8%'); has(h, '9.1pp'); has(h, 'Previous month'); has(h, '49.9%');
});
R.summary(); process.exitCode = R.fail ? 1 : 0;
