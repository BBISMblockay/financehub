/* BUG 2 — "≤7 days" included a product with 1,002 units, zero recorded sales
 * and blank cover.
 *
 * Root cause: inventory_workboard_v.days_oos is NULL when there is no demand
 * basis to divide by, and the page read it through a num() helper that turns
 * NULL into 0. The filter then said `if (d > 0 && d > maxDays) return false`,
 * which passes 0 straight through — so every row with no demand data matched
 * every cover lens.
 *
 * Scale of it, measured against Baseballism on 2026-09-07: 58,384 of 66,745
 * rows have no cover basis. 26,947 of those have no matched sales history at
 * all, and 3,267 of THOSE hold stock — 141,242 units that the lens was
 * presenting as "about to run out".
 *
 * The rule these tests hold down: a row qualifies for "cover ≤ N" only when
 * its cover is an actual number. Unknown has not been shown to be under N; it
 * has not been shown to be anything. */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadSignals } = require('../lib/load');
const F = require('../fixtures/sonic-rows');

const S = loadSignals();
const r = createReporter('cover-basis');
const st = (over) => Object.assign(S.emptyState(), over || {});

console.log('\n── null cover survives as null ──');
r.test('the Sonic pin has NO cover, not zero cover', () => {
  r.eq(S.coverDays(F.rows.PIN), null);
});
r.test('a genuine zero cover stays zero', () => {
  // 0 units on hand / 15 sold a day. Real, measured, and equal to 0.
  r.eq(S.coverDays(F.rows.TEE_YM), 0);
});
r.test('the two are not the same value', () => {
  r.truthy(S.coverDays(F.rows.PIN) !== S.coverDays(F.rows.TEE_YM),
    'unknown and zero must not collapse to one value');
});

console.log('\n── the reported filter, exactly ──');
r.test('cover ≤ 7 EXCLUDES the 1,002-unit pin', () => {
  r.eq(S.matchesFilters(F.rows.PIN, st({ maxCoverDays: 7 })), false);
});
r.test('cover ≤ 7 still INCLUDES a real 0-day row', () => {
  // Out of stock and selling 450 a month genuinely is urgent cover.
  r.eq(S.matchesFilters(F.rows.TEE_YM, st({ maxCoverDays: 7 })), true);
});
r.test('cover ≤ 7 excludes a 7.5-day row (boundary is inclusive at 7)', () => {
  r.eq(S.matchesFilters(F.rows.TEE_YL, st({ maxCoverDays: 7 })), false);
});
r.test('cover ≤ 8 includes that same 7.5-day row', () => {
  r.eq(S.matchesFilters(F.rows.TEE_YL, st({ maxCoverDays: 8 })), true);
});
r.test('matched-but-genuinely-dead stock is also excluded from a cover lens', () => {
  // No sales in 365d means there is no rate; there is still no cover number.
  r.eq(S.matchesFilters(F.rows.DEAD_STOCK, st({ maxCoverDays: 7 })), false);
});

console.log('\n── across the whole fixture set ──');
r.test('no row without a measurable cover survives a cover lens', () => {
  const kept = F.all().filter((row) => S.matchesFilters(row, st({ maxCoverDays: 14 })));
  const bad = kept.filter((row) => S.coverDays(row) === null);
  r.eq(bad.map((x) => x.sku), []);
});
r.test('the lens returns the rows it should', () => {
  const kept = F.all()
    .filter((row) => S.matchesFilters(row, st({ maxCoverDays: 14 })))
    .map((x) => x.variant)
    .sort();
  // YM (0d), YS (0d), YL (7.5d), and Stolen Bases YS (-0.1d, negative stock).
  r.eq(kept, ['YL', 'YM', 'YS', 'YS']);
});

console.log('\n── the five states the task asks to be distinguishable ──');
r.test('out of stock', () => { r.eq(S.inventorySignal(F.rows.TEE_YM).code, 'out_of_stock'); });
r.test('low cover with a valid demand basis', () => {
  r.eq(S.inventorySignal(F.rows.TEE_YL).code, 'low_cover');
  r.eq(S.demandBasis(F.rows.TEE_YL), 'measured');
});
r.test('no recorded sales', () => {
  r.eq(S.inventorySignal(F.rows.DEAD_STOCK).code, 'no_sales');
  r.eq(S.demandBasis(F.rows.DEAD_STOCK), 'no_sales');
});
r.test('unknown / missing demand', () => {
  r.eq(S.inventorySignal(F.rows.PIN).code, 'unknown_demand');
  r.eq(S.demandBasis(F.rows.PIN), 'unknown');
});
r.test('negative inventory / data review', () => {
  r.eq(S.inventorySignal(F.rows.STOLEN_YS).code, 'data_review');
});
r.test('all five are distinct codes', () => {
  const codes = [F.rows.TEE_YM, F.rows.TEE_YL, F.rows.DEAD_STOCK, F.rows.PIN, F.rows.STOLEN_YS]
    .map((x) => S.inventorySignal(x).code);
  r.eq(new Set(codes).size, 5);
});
r.test('stale is kept apart from both no-sales and unknown', () => {
  r.eq(S.inventorySignal(F.rows.STALE_STOCK).code, 'stale');
});

console.log('\n── the cell text, which is where the ambiguity was visible ──');
r.test('unknown cover reads "Unknown", never a blank', () => {
  r.eq(S.coverDisplay(F.rows.PIN).text, 'Unknown');
});
r.test('dead stock reads "No sales", not "Unknown"', () => {
  r.eq(S.coverDisplay(F.rows.DEAD_STOCK).text, 'No sales');
});
r.test('a real zero prints 0', () => {
  r.eq(S.coverDisplay(F.rows.TEE_YM).text, '0');
});
r.test('a slightly negative cover shows 0, never "-0"', () => {
  // -1 unit / 10.9 a day is -0.09 days, and (-0.09).toFixed(0) is "-0",
  // which reads as a typo. The Data review signal reports the negative stock.
  r.eq(S.coverDisplay(F.rows.STOLEN_YS).text, '0');
});
r.test('a real negative cover of a full day is still shown as negative', () => {
  const row = Object.assign({}, F.rows.STOLEN_YS, { days_cover: -3.2 });
  r.eq(S.coverDisplay(row).text, '-3');
});
r.test('every no-number cell explains itself in its tooltip', () => {
  [F.rows.PIN, F.rows.DEAD_STOCK, F.rows.STALE_STOCK].forEach((row) => {
    const d = S.coverDisplay(row);
    r.truthy(d.muted, 'should be rendered muted');
    r.truthy(d.title && d.title.length > 30, 'should carry an explanation');
  });
});

console.log('\n── sorting must not park unknowns at an extreme ──');
r.test('cover ascending puts unmeasurable rows LAST, not first', () => {
  const sorted = F.all().slice().sort((a, b) => S.compareRows(a, b, 'cover_asc'));
  const firstUnknown = sorted.findIndex((x) => S.coverDays(x) === null);
  const lastKnown = sorted.map((x) => S.coverDays(x) !== null).lastIndexOf(true);
  r.truthy(firstUnknown > lastKnown, 'an unknown cover must not sort as the lowest cover');
});
r.test('cover descending also puts them last', () => {
  const sorted = F.all().slice().sort((a, b) => S.compareRows(a, b, 'cover_desc'));
  const firstUnknown = sorted.findIndex((x) => S.coverDays(x) === null);
  const lastKnown = sorted.map((x) => S.coverDays(x) !== null).lastIndexOf(true);
  r.truthy(firstUnknown > lastKnown, 'an unknown cover must not sort as the highest cover either');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
