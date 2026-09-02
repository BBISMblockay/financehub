/* Presentation defaults that apply to EVERY tile on EVERY dashboard.
 *
 * These live in chart-adapter.js rather than in any report's SQL, which is
 * the point: improving a default here improves every tile that already
 * exists, including reports nobody has opened since. So the tests are about
 * the defaults being right, not about one report looking correct. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const R = createReporter('presentation');
const { test, eq, has, not, truthy } = R;

// ── Column labels ─────────────────────────────────────────────────────
console.log('\n── column labels ──');
test('snake_case becomes words', () =>
  eq(C.columnLabel('qty_arriving_by_cutoff'), 'Qty Arriving By Cutoff'));
test('acronyms stay upper-case', () => {
  eq(C.columnLabel('platform_roas'), 'Platform ROAS');
  eq(C.columnLabel('aov'), 'AOV');
  eq(C.columnLabel('mtd_cy'), 'MTD CY');
});
test('SQL noise suffixes are dropped', () => {
  eq(C.columnLabel('product_type_snapshot'), 'Product Type');
  eq(C.columnLabel('location_tag'), 'Location');
});
test('a single word is just capitalised', () => eq(C.columnLabel('line'), 'Line'));
test('a REPORT can override the label', () =>
  eq(C.columnLabel('net_sales', { net_sales: { semantic: 'currency', label: 'Revenue (net)' } }),
     'Revenue (net)'));
test('a plain-string semantic map does not break the override lookup', () =>
  eq(C.columnLabel('net_sales', { net_sales: 'currency' }), 'Net Sales'));

test('a table renders labels, keeping the real name on hover', () => {
  const html = C.tableHtml([{ product_type_snapshot: 'Youth', platform_roas: 2.4 }], {}, null);
  has(html, '>Product Type<');
  has(html, '>Platform ROAS<');
  has(html, 'title="product_type_snapshot"');   // the true column name survives
});

// ── Date column headers on a matrix ───────────────────────────────────
console.log('\n── matrix date headers ──');
const pl = (months) => months.flatMap((m) => [
  { month: m, line: 'Total Income', amount: 100 },
  { month: m, line: 'Net Income', amount: -50 }]);
const MCFG = { row_field: 'line', x_field: 'month', y_field: 'amount', aggregate: 'none' };

test('month-grain dates read as Jan 2025, not 2025-01-01', () => {
  const html = C.matrixHtml(pl(['2025-01-01', '2025-02-01']), MCFG, { month: 'date', amount: 'currency' });
  has(html, '>Jan 2025<');
  has(html, '>Feb 2025<');
  not(html, '>2025-01-01<');
});
test('a NON month-grain date set keeps ISO, which is unambiguous', () => {
  const html = C.matrixHtml(pl(['2025-01-06', '2025-01-13']), MCFG, { month: 'date', amount: 'currency' });
  has(html, '>2025-01-06<');
});
test('the corner cell shows the row dimension as a label', () =>
  has(C.matrixHtml(pl(['2025-01-01']), MCFG, { month: 'date' }), '>Line<'));

// ── Negative emphasis ─────────────────────────────────────────────────
console.log('\n── negatives ──');
test('a negative currency cell is marked in a matrix', () =>
  has(C.matrixHtml(pl(['2025-01-01']), MCFG, { month: 'date', amount: 'currency' }), 'dw-neg'));
test('a negative currency cell is marked in a table', () =>
  has(C.tableHtml([{ net_sales: -639024 }], {}, { net_sales: 'currency' }), 'dw-neg'));
test('a POSITIVE value is not marked', () =>
  not(C.tableHtml([{ net_sales: 1540668 }], {}, { net_sales: 'currency' }), 'dw-neg'));
test('a count is never marked, even negative — it is not a gain or a loss', () =>
  not(C.tableHtml([{ units: -5 }], {}, { units: 'count' }), 'dw-neg'));
test('a date is never marked', () =>
  not(C.tableHtml([{ day_date: '2025-01-01' }], {}, { day_date: 'date' }), 'dw-neg'));

// ── KPI delta and abbreviation ────────────────────────────────────────
console.log('\n── KPI ──');
const SERIES = [{ m: 'Jul', net_sales: 800 }, { m: 'Aug', net_sales: 1000 }];

test('with no compare config a KPI is just the number, as before', () => {
  const html = C.kpiHtml(SERIES, { y_field: 'net_sales' }, { net_sales: 'currency' });
  not(html, 'dw-kpi-delta');
});
test('previous_row compares the last two rows', () => {
  const html = C.kpiHtml(SERIES, { y_field: 'net_sales', compare: 'previous_row' }, { net_sales: 'currency' });
  has(html, 'dw-kpi-delta--up');
  has(html, '25%');                       // 800 -> 1000
});
test('a fall reads as down, not as a negative percentage', () => {
  const html = C.kpiHtml([{ v: 1000 }, { v: 750 }], { y_field: 'v', compare: 'previous_row' },
    { v: 'currency' });
  has(html, 'dw-kpi-delta--down');
  has(html, '25%');
  not(html, '-25%');                      // direction is the arrow and the word
});
test('direction is stated in WORDS too, not colour alone', () => {
  const html = C.kpiHtml(SERIES, { y_field: 'net_sales', compare: 'previous_row' }, { net_sales: 'currency' });
  has(html, 'up vs');
});
test('comparing against a named column works', () => {
  const html = C.kpiHtml([{ this_year: 1200, last_year: 1000 }],
    { y_field: 'this_year', compare_field: 'last_year' }, { this_year: 'currency', last_year: 'currency' });
  has(html, 'dw-kpi-delta--up');
  has(html, '20%');
  has(html, 'Last Year');                 // the compare column is labelled too
});
test('a zero prior does not produce Infinity%', () => {
  const html = C.kpiHtml([{ v: 0 }, { v: 500 }], { y_field: 'v', compare: 'previous_row' }, { v: 'currency' });
  not(html, 'Infinity');
  not(html, 'NaN');
});
test('abbreviate shortens, and keeps the full value on hover', () => {
  const html = C.kpiHtml([{ v: 36393571 }], { y_field: 'v', abbreviate: true }, { v: 'currency' });
  has(html, '$36.4M');
  has(html, 'title="$36,393,571"');
});
test('without abbreviate the number is full precision', () =>
  has(C.kpiHtml([{ v: 36393571 }], { y_field: 'v' }, { v: 'currency' }), '$36,393,571'));
test('the KPI label is a readable column name', () =>
  has(C.kpiHtml([{ net_sales: 100 }], { y_field: 'net_sales' }, { net_sales: 'currency' }), 'Net Sales'));

const r = R.summary();
process.exit(r.fail ? 1 : 0);
