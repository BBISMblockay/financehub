/* The 'fraction' semantic: a percentage whose scale is DECLARED as 0-1.
 *
 * 'percent' has to guess the scale from the value -- |n| <= 1 is a fraction,
 * anything bigger is already x100 -- and that guess is wrong both ways. The
 * case that motivated this (2026-09-24): Redo's automation open rate is
 * unique_opens / delivered over a window, and when opens land on messages
 * delivered before the window it comes out above 1. Measured on a live
 * automation: 1.081754, which 'percent' prints as "1.1%" instead of 108.2%.
 *
 * So a report that KNOWS its rates are fractions declares 'fraction' in
 * columns_metadata, and every rate rule that applies to 'percent' -- never
 * summed, never a donut or a waterfall, change in points -- applies to it too.
 */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const M = g.SiloMetrics;
const F = g.SiloFieldSemantics;
const R = createReporter('fraction-semantic');
const { test, eq, has, not, truthy } = R;

console.log('\n── formatting ──');
test('a fraction above 1 prints as itself x100, not as a small percentage', () => {
  eq(C.formatValue(1.081754, 'fraction'), '108.2%');
  // The bug, pinned: the guessing semantic reads the same value as 1.1%.
  eq(C.formatValue(1.081754, 'percent'), '1.1%');
});
test('ordinary rates read the same as the percent semantic would', () => {
  eq(C.formatValue(0.653688, 'fraction'), '65.4%');
  eq(C.formatValue(0.24233, 'fraction'), '24.2%');
});
test('a small rate keeps two decimals, the only digits anyone compares', () => {
  eq(C.formatValue(0.001717, 'fraction'), '0.17%');
  eq(C.formatValue(0.000139, 'fraction'), '0.01%');
});
test('zero and a missing value', () => {
  eq(C.formatValue(0, 'fraction'), '0%');
  eq(C.formatValue(null, 'fraction'), '');
});
test('compact (axis labels) uses the declared scale too', () =>
  eq(C.compact(1.081754, 'fraction'), '108.2%'));

console.log('\n── resolution ──');
test('a report can declare it', () =>
  eq(F.resolve('open_rate', 'number', { reportMetadata: { open_rate: { semantic: 'fraction' } } }).semantic,
     'fraction'));
test('a widget override can declare it', () =>
  eq(F.resolve('open_rate', 'number', { overrides: { open_rate: 'fraction' } }).semantic, 'fraction'));
test('it is never INFERRED from a name -- only a source that knows its scale declares it', () =>
  eq(F.resolve('open_rate', 'number', {}).semantic, 'percent'));
test('it is a measure', () => truthy(F.isMeasure('fraction')));

console.log('\n── rate rules ──');
test('it defaults to averaging, never summing', () => eq(C.defaultAggregate('fraction'), 'avg'));
test('the metric layer treats it as a rate', () => truthy(M.isRate('fraction')));
test('a change is in percentage points, scaled x100', () => {
  const c = M.change(0.051, 0.042, 'fraction');
  eq(c.unit, 'pp');
  truthy(Math.abs(c.points - 0.9) < 1e-9);
});
test('the KPI prints points, not a hundredth of a point', () => {
  const html = C.kpiHtml([{ open_rate: 0.051, prior: 0.042 }],
    { y_field: 'open_rate', compare_field: 'prior' }, { open_rate: 'fraction', prior: 'fraction' });
  has(html, '0.9pp');
  has(html, '5.1%');
});
const RATES = [
  { automation: 'Welcome', open_rate: 0.5, sends: 10 },
  { automation: 'Cart', open_rate: 0.3, sends: 20 },
];
const SEM = { automation: 'category', open_rate: 'fraction', sends: 'count' };
test('a table total leaves it blank rather than summing or averaging it', () => {
  const html = C.tableHtml(RATES, { totals: 'row' }, SEM);
  has(html, '>30<');          // the count IS summed
  not(html, '80%');           // 0.5 + 0.3
  not(html, '40%');           // their mean
});
test('a donut refuses it', () =>
  eq(C.validateVisual('donut', RATES, { x_field: 'automation', y_field: 'open_rate' }, SEM).ok, false));
test('a waterfall refuses it', () =>
  eq(C.validateVisual('waterfall', RATES, { x_field: 'automation', y_field: 'open_rate' }, SEM).ok, false));
test('a negative fraction is coloured like a negative percent', () =>
  has(C.tableHtml([{ a: 'x', d: -0.02 }], {}, { a: 'category', d: 'fraction' }), 'dw-neg'));

const r = R.summary();
process.exit(r.fail ? 1 : 0);
