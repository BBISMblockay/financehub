/* Metric arithmetic: how a column is combined, and what a change in it
 * means.
 *
 * These two questions were previously answered inline in four places each,
 * and both have a wrong answer that looks right. Summing a rate produces a
 * plausible number that does not exist; averaging one produces a different
 * plausible number that is not the pooled rate. Calling a 4%-to-5% move
 * "+25%" is a true statement about a different quantity, and it is the one
 * people quote.
 *
 * So the assertions here are mostly about REFUSALS. */
'use strict';
const { loadV3 } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(['report-params.js', 'field-semantics.js', 'metrics.js']);
const M = g.SiloMetrics;
const R = createReporter('metrics');
const { test, eq, has, truthy } = R;

// ── Aggregation ───────────────────────────────────────────────────────
console.log('\n── aggregation ──');

const money = [{ net_sales: 100 }, { net_sales: 250 }, { net_sales: 50 }];
test('currency sums', () => {
  const r = M.aggregate(money, 'net_sales', 'currency', {});
  eq([r.value, r.method], [400, 'sum']);
});
test('a count sums', () => eq(M.aggregate([{ units: 3 }, { units: 4 }], 'units', 'count', {}).value, 7));

// The headline case. 2% over 100 sessions and 10% over 10,000 sessions is
// 9.9% pooled -- not the 6% an average gives and not the 12% a sum gives.
const rates = [
  { conversion_rate: 2, orders: 2, sessions: 100 },
  { conversion_rate: 10, orders: 1000, sessions: 10000 },
];
test('a rate is POOLED from its numerator and denominator, not averaged', () => {
  const r = M.aggregate(rates, 'conversion_rate', 'percent', {});
  truthy(Math.abs(r.value - 9.9207920792) < 1e-6, `got ${r.value}`);
  has(r.method, 'pooled from orders');
});
test('...and the pooled answer is neither the average nor the sum', () => {
  const r = M.aggregate(rates, 'conversion_rate', 'percent', {});
  truthy(r.value !== 6 && r.value !== 12, `got ${r.value}`);
});

test('a rate with NO numerator/denominator in the result is REFUSED, not averaged', () => {
  const r = M.aggregate([{ conversion_rate: 2 }, { conversion_rate: 10 }], 'conversion_rate', 'percent', {});
  eq(r.value, null);
  truthy(r.refused);
  has(r.note, 'not the pooled rate');
});
test('...and the refusal names the columns that would make it possible', () => {
  const r = M.aggregate([{ conversion_rate: 2 }, { conversion_rate: 10 }], 'conversion_rate', 'percent', {});
  has(r.note, 'orders');
  has(r.note, 'sessions');
});
test('one row is not an aggregation -- it is the value', () => {
  const r = M.aggregate([{ conversion_rate: 4.2 }], 'conversion_rate', 'percent', {});
  eq(r.value, 4.2);
});
test('a zero denominator empties the cell rather than dividing by zero', () => {
  const r = M.aggregate(
    [{ conversion_rate: 0, orders: 0, sessions: 0 }, { conversion_rate: 0, orders: 0, sessions: 0 }],
    'conversion_rate', 'percent', {});
  eq(r.value, null);
  truthy(r.refused);
});
test('an explicit avg is honoured -- the author asked for it', () =>
  eq(M.aggregate(money, 'net_sales', 'currency', { aggregate: 'avg' }).value, 400 / 3));
test('a category does not add up', () =>
  truthy(M.aggregate([{ a: 'x' }], 'a', 'category', {}).value === null));

// ── Change ────────────────────────────────────────────────────────────
console.log('\n── change ──');

test('an absolute and a relative change for a quantity', () => {
  const c = M.change(1200, 1000, 'currency');
  eq([c.absolute, Math.round(c.percent), c.unit, c.direction], [200, 20, '%', 'up']);
});
test('a RATE changes in percentage points', () => {
  const c = M.change(5, 4, 'percent');
  eq([c.points, c.unit, c.direction], [1, 'pp', 'up']);
});
test('...and its relative change is still available, just not the headline', () => {
  const c = M.change(5, 4, 'percent');
  eq(Math.round(c.percent), 25);
});
test('a fall reads as down', () => eq(M.change(750, 1000, 'currency').direction, 'down'));
test('no change reads as flat', () => eq(M.change(10, 10, 'currency').direction, 'flat'));
test('a zero prior has no percentage to report', () => {
  const c = M.change(50, 0, 'currency');
  eq(c.percent, null);
  has(c.note, 'no prior value');
});
test('a missing side is not a change', () => truthy(!M.change(null, 10, 'currency').ok));

// ── Periods ───────────────────────────────────────────────────────────
console.log('\n── periods ──');

test('an inclusive range counts both ends', () => eq(M.inclusiveDays('2026-09-01', '2026-09-07'), 7));
test('a single day is one day, not zero', () => eq(M.inclusiveDays('2026-09-01', '2026-09-01'), 1));
test('the previous period is the same LENGTH, immediately before', () =>
  eq(M.priorPeriod('2026-09-01', '2026-09-07'), { from: '2026-08-25', to: '2026-08-31', days: 7, basis: 'previous period' }));
test('the previous YEAR is the same calendar dates', () =>
  eq(M.priorYear('2026-09-01', '2026-09-06'), { from: '2025-09-01', to: '2025-09-06', days: 6, basis: 'same dates last year' }));
test('29 February snaps back to the 28th rather than becoming 1 March', () =>
  eq(M.priorYear('2024-02-29', '2024-02-29').from, '2023-02-28'));

// ── Refusals ──────────────────────────────────────────────────────────
console.log('\n── what cannot be compared ──');

test('one row has no previous row', () => {
  const c = M.canCompare('previous_row', { rowCount: 1 });
  truthy(!c.ok);
  has(c.reason, 'at least two rows');
});
test('two rows do', () => truthy(M.canCompare('previous_row', { rowCount: 2 }).ok));
test('a previous period needs a date range to be previous TO', () => {
  const c = M.canCompare('previous_period', {});
  truthy(!c.ok);
  has(c.reason, 'date range');
});
test('a column comparison needs the column to exist', () =>
  truthy(!M.canCompare('column', { hasColumn: false }).ok));

// ── A real case, measured against production ──────────────────────────
// Baseballism, 1-6 Sep 2026 inclusive, all stores, deduplicated
// sales_by_day, Total Sales. Read out of the live database while building
// this, and kept here as a FIXTURE rather than as an MLB feature: the
// point is that the shared metric layer gets a known answer right.
//
//   MLB (sku ilike '%mlb%')   $55,463.51
//   All sales                $637,832.00
//   Share                          8.70%
//
// The daily split below is the same window, by day, read from the same
// place. Its per-day shares AVERAGE to 11.74% -- three percentage points
// away from the real pooled 8.70%, because 1 Sep is a third of the window's
// sales at a below-average share and an average weights it the same as
// 6 Sep. That gap is the exact failure mode aggregate() refuses, measured
// rather than argued.
console.log('\n── the MLB validation case ──');

const SEP = [
  { day_date: '2026-09-01', mlb_sales: 12309.46, all_sales: 301108.82 },
  { day_date: '2026-09-02', mlb_sales: 6926.96, all_sales: 80329.14 },
  { day_date: '2026-09-03', mlb_sales: 10096.95, all_sales: 77717.45 },
  { day_date: '2026-09-04', mlb_sales: 8068.94, all_sales: 69621.75 },
  { day_date: '2026-09-05', mlb_sales: 9271.18, all_sales: 55363.25 },
  { day_date: '2026-09-06', mlb_sales: 8790.02, all_sales: 53691.59 },
];
const round2 = (n) => Math.round(n * 100) / 100;

test('the numerator totals the observed MLB figure', () =>
  eq(round2(M.aggregate(SEP, 'mlb_sales', 'currency', {}).value), 55463.51));
test('the denominator totals the observed all-sales figure', () =>
  eq(round2(M.aggregate(SEP, 'all_sales', 'currency', {}).value), 637832));
test('the share, pooled from both, is the observed 8.70%', () => {
  const n = M.aggregate(SEP, 'mlb_sales', 'currency', {}).value;
  const d = M.aggregate(SEP, 'all_sales', 'currency', {}).value;
  eq(Math.round((n / d) * 10000) / 100, 8.7);
});
// A filter change has to move BOTH sides. Halving the window on the
// numerator alone would leave a ratio nobody can reconcile with either
// number printed beside it.
test('narrowing the window moves numerator and denominator together', () => {
  const half = SEP.slice(0, 3);
  const n = M.aggregate(half, 'mlb_sales', 'currency', {}).value;
  const d = M.aggregate(half, 'all_sales', 'currency', {}).value;
  const share = (n / d) * 100;
  truthy(share > 0 && share < 100, `got ${share}`);
  truthy(Math.abs(share - 6.39) < 0.02, `the first three days pool to 6.39%, got ${share}`);
});
// Measured, not asserted in the abstract: 11.74 against the real 8.70.
test('averaging the daily shares would be 3 points wrong -- so it is refused', () => {
  const naive = SEP.reduce((a, r) => a + (r.mlb_sales / r.all_sales) * 100, 0) / SEP.length;
  truthy(Math.abs(naive - 11.74) < 0.05, `the naive average is ${naive}`);
  const refused = M.aggregate(
    SEP.map((r) => ({ mlb_share_pct: (r.mlb_sales / r.all_sales) * 100 })),
    'mlb_share_pct', 'percent', {});
  eq(refused.value, null);
  truthy(refused.refused);
});

// ── Labels ────────────────────────────────────────────────────────────
console.log('\n── labels ──');

// They differ by discounts, returns and (per report) shipping and tax, and
// they sit side by side in SILO's own sales rollups. Labelling either one
// "Sales" makes the difference invisible exactly when two tiles are being
// compared.
test('Total Sales and Net Sales are named in full, and differently', () => {
  eq(M.label('total_sales'), 'Total Sales');
  eq(M.label('net_sales'), 'Net Sales');
  truthy(M.label('total_sales') !== M.label('net_sales'));
});
test('an unknown column has no canonical label -- the generic titler handles it', () =>
  eq(M.label('qty_arriving_by_cutoff'), null));

const r = R.summary();
process.exit(r.fail ? 1 : 0);
