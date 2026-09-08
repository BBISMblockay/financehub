/* Daily Sales Trend — the headline cards must not move when the chart metric
 * does.
 *
 * The reported defect: switching the chart from Net Sales to Units changed the
 * year-over-year percentage on BOTH headline cards and stripped the currency
 * formatting off the Net Sales card.
 *
 * Three separate faults produced it, all in one render function:
 *
 *   1. `fmtVal()` returns a plain number when the chart metric is units, and
 *      it was applied to the Net Sales value.
 *   2. A single `varPct` was computed from the CHART metric and written to the
 *      Net Sales card.
 *   3. The Units card did no arithmetic at all —
 *          el.kpiPeriodQtyVar.textContent = el.kpiPeriodVar.textContent;
 *      — so it never once displayed a units comparison. It always showed
 *      whatever the other card showed, which is why the bug reads as "both
 *      cards change together".
 *
 * Fault 3 is the one worth keeping a test on: the Units card was WRONG even
 * with the chart set to Net Sales, which is the default. Nobody would have
 * seen it by switching metrics alone.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const K = loadV2(['daily-trend-kpis.js']).SiloDailyTrendKpis;
const r = createReporter('daily-trend-kpis');

/* Deliberately built so net and units move in OPPOSITE directions. If a card
 * ever borrows the other's comparison the sign flips, which no rounding
 * tolerance can hide. */
const DAYS = [
  { day: '2026-09-01', net: 1000, qty: 50, discounts: 10, pyNet: 800,  pyQty: 80, pyDiscounts: 5 },
  { day: '2026-09-02', net: 2000, qty: 70, discounts: 20, pyNet: 1200, pyQty: 60, pyDiscounts: 8 },
];
// net:   3000 vs 2000  => +50.0%
// units:  120 vs  140  => -14.3%

console.log('\n── each card owns its own metric ──');
const cards = K.headlineCards(DAYS);
r.test('there are exactly two headline cards', () => { r.eq(cards.length, 2); });
r.test('the net card sums net, not the charted metric', () => { r.eq(cards[0].value, 3000); });
r.test('the units card sums units', () => { r.eq(cards[1].value, 120); });
r.test('the net card keeps currency formatting', () => { r.eq(cards[0].text, '$3,000'); });
r.test('the units card is NOT formatted as currency', () => {
  r.eq(cards[1].text, '120');
  r.not(cards[1].text, '$');
});

console.log('\n── the fault nobody would have seen: the units comparison ──');
r.test('the units card computes its OWN variance', () => { r.eq(cards[1].variance.toFixed(1), '-14.3'); });
r.test('the net card computes its own variance', () => { r.eq(cards[0].variance.toFixed(1), '50.0'); });
r.test('the two variances are different values, not one copied to both', () => {
  r.truthy(cards[0].varianceText !== cards[1].varianceText,
    `both cards read "${cards[0].varianceText}"`);
});
r.test('they even point opposite ways', () => {
  r.eq(cards[0].direction, 'pos');
  r.eq(cards[1].direction, 'neg');
});

console.log('\n── switching the chart metric moves nothing above it ──');
r.test('headlineCards() cannot depend on the chart metric — it takes only rows', () => {
  // Structural, not behavioural: the argument list is the guarantee. A future
  // edit that wants the metric back has to change this signature and this test.
  r.eq(K.headlineCards.length, 1);
});
r.test('cards are byte-identical across every chart metric', () => {
  const shot = () => JSON.stringify(K.headlineCards(DAYS));
  const baseline = shot();
  ['net', 'units', 'discounts'].forEach((m) => {
    // Nothing to pass — that is the point. Simulate a re-render per metric.
    K.bestDay(DAYS, m);
    r.eq(shot(), baseline, `cards changed after rendering with metric ${m}`);
  });
});

console.log('\n── best day legitimately follows the chart, and says so ──');
r.test('best day by net sales is formatted as currency and named', () => {
  const b = K.bestDay(DAYS, 'net');
  r.eq(b.day, '2026-09-02');
  r.eq(b.text, '$2,000');
  r.eq(b.metricLabel, 'Net sales');
});
r.test('best day by units is a plain count and named', () => {
  const b = K.bestDay(DAYS, 'units');
  r.eq(b.text, '70');
  r.eq(b.metricLabel, 'Units');
});
r.test('best day on no rows is null rather than a fabricated day', () => {
  r.eq(K.bestDay([], 'net'), null);
});

console.log('\n── no prior-year base is "no comparison", never 0% ──');
r.test('a zero prior year yields null, not Infinity or 0', () => {
  r.eq(K.variance(500, 0), null);
});
r.test('and renders as an em dash', () => {
  const c = K.headlineCards([{ day: '2026-09-01', net: 500, qty: 5, pyNet: 0, pyQty: 0 }]);
  r.eq(c[0].varianceText, 'vs LY —');
  r.eq(c[1].varianceText, 'vs LY —');
});
r.test('an empty range does not claim a value', () => {
  const c = K.headlineCards([]);
  r.eq(c[0].text, '—');
  r.eq(c[1].text, '—');
});

console.log('\n── incomplete days are identified, on Pacific ──');
const AT = (iso) => new Date(iso);
r.test('Pacific date is used, not the UTC host date', () => {
  // 2026-09-08T04:00Z is still 2026-09-07 in Pacific. Using the host date
  // here would call the 7th complete a full day early.
  r.eq(K.pacificToday(AT('2026-09-08T04:00:00Z')), '2026-09-07');
});
r.test('Pacific today is incomplete', () => {
  r.eq(K.isIncompleteDay('2026-09-07', AT('2026-09-08T04:00:00Z')), true);
});
r.test('the previous Pacific day is complete', () => {
  r.eq(K.isIncompleteDay('2026-09-06', AT('2026-09-08T04:00:00Z')), false);
});
r.test('a future day is incomplete', () => {
  r.eq(K.isIncompleteDay('2026-09-09', AT('2026-09-08T04:00:00Z')), true);
});
r.test('the note names the day and says why it is not comparable', () => {
  const note = K.completenessNote(
    [{ day: '2026-09-06' }, { day: '2026-09-07' }], AT('2026-09-08T04:00:00Z'));
  r.eq(note.days, ['2026-09-07']);
  r.has(note.text, 'not comparable');
});
r.test('a fully complete range produces no note at all', () => {
  r.eq(K.completenessNote([{ day: '2026-09-01' }], AT('2026-09-08T04:00:00Z')), null);
});

console.log('\n── the comparison convention is preserved, not swapped ──');
r.test('prior year is the same CALENDAR dates, not a 364-day shift', () => {
  const py = K.priorYearRange('2026-09-01', '2026-09-30');
  r.eq(py.from, '2025-09-01');
  r.eq(py.to, '2025-09-30');
});
r.test('a 364-day shift would have given different dates — guard against a silent swap', () => {
  // 2026-09-01 minus 364 days is 2025-09-02. If this ever equals the range
  // above, someone has changed the convention.
  r.truthy(K.priorYearRange('2026-09-01', '2026-09-01').from !== '2025-09-02');
});
r.test('Feb 29 clamps to Feb 28 rather than drifting into March', () => {
  r.eq(K.addYears('2024-02-29', 1), '2025-02-28');
});
r.test('the note states the actual comparison dates', () => {
  const n = K.comparisonNote('2026-09-01', '2026-09-30');
  r.has(n.text, '2025-09-01');
  r.has(n.text, '2025-09-30');
});
r.test('and names the convention so it is not mistaken for weekday alignment', () => {
  const n = K.comparisonNote('2026-09-01', '2026-09-30');
  r.has(n.text, 'calendar-date');
  r.has(n.text, '364-day');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
