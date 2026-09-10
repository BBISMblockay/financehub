/* A KPI is one number under one title, so the column it draws is the whole
 * tile. Getting it wrong is not a formatting slip.
 *
 * This suite exists because of a live failure: a card titled "Total sales"
 * printed MLB sales. The old code fell back to the first numeric column
 * whenever `y_field` was unset, and every path that creates a KPI without
 * choosing one landed there silently. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const R = createReporter('kpi');
const { test, eq, has, not, truthy } = R;

// The shape of the live bug: two measures, one of them a narrow slice.
const ambiguous = [{ mlb_sales: 55463.51, all_sales: 637832 }];
const single = [{ net_sales: 918233.19 }];

// ── Which measure ─────────────────────────────────────────────────────
console.log('\n── choosing the measure ──');

test('with a choice to make and none made, the card says so', () => {
  const html = C.kpiHtml(ambiguous, {}, {});
  has(html, 'no measure selected');
});
test('...and names the candidates rather than just refusing', () => {
  const html = C.kpiHtml(ambiguous, {}, {});
  has(html, 'MLB Sales');
  has(html, 'All Sales');
});
// The exact live failure: the card must not print the first numeric column.
test('it never falls through to the first numeric column', () =>
  not(C.kpiHtml(ambiguous, {}, {}), '$55,464'));
test('the title is not evidence -- a card called "Total sales" gets no guess', () => {
  // The title lives on the widget, not in the config the renderer reads, so
  // this is really an assertion that nothing here consults it.
  const html = C.kpiHtml(ambiguous, { title: 'Total sales' }, {});
  has(html, 'no measure selected');
});
test('an explicit measure is drawn, obviously', () =>
  has(C.kpiHtml(ambiguous, { y_field: 'all_sales' }, {}), '$637,832'));
// One numeric column: "first numeric" and "the only measure" are the same
// statement, and there is nothing to get wrong.
test('ONE numeric column needs no choice', () =>
  has(C.kpiHtml(single, {}, {}), '$918,233'));
test('a measure the query stopped returning falls back to the prompt, not to a wrong column', () =>
  has(C.kpiHtml(ambiguous, { y_field: 'gone_away' }, {}), 'no measure selected'));
test('no numeric column at all says that instead', () =>
  has(C.kpiHtml([{ name: 'x' }], {}, {}), 'No numeric column'));
test('kpiField reports whether the measure was CHOSEN or inferred', () => {
  const prof = C.profileColumns(single);
  eq(C.kpiField(prof, {}).chosen, false);
  eq(C.kpiField(prof, { y_field: 'net_sales' }).chosen, true);
});

// ── Rolling up ────────────────────────────────────────────────────────
console.log('\n── rolling up ──');

const days = [
  { day_date: '2026-09-01', net_sales: 100, orders: 2, sessions: 100, conversion_rate: 2 },
  { day_date: '2026-09-02', net_sales: 200, orders: 1000, sessions: 10000, conversion_rate: 10 },
];
test('currency sums across rows and says so', () => {
  const html = C.kpiHtml(days, { y_field: 'net_sales' }, {});
  has(html, '$300');
  has(html, 'sum of Net Sales');
});
test('a rate is POOLED, and the label says pooled rather than sum', () => {
  const html = C.kpiHtml(days, { y_field: 'conversion_rate' }, {});
  has(html, '9.9%');
  has(html, 'pooled from orders');
});
test('a rate with no parts is refused with a reason, not averaged into 6%', () => {
  const html = C.kpiHtml([{ conversion_rate: 2 }, { conversion_rate: 10 }], { y_field: 'conversion_rate' }, {});
  has(html, 'cannot be rolled up');
  not(html, '6%');
});

// ── Comparison ────────────────────────────────────────────────────────
console.log('\n── comparison ──');

test('previous_row compares the last two rows, in words as well as colour', () => {
  const html = C.kpiHtml(days, { y_field: 'net_sales', compare: 'previous_row' }, {});
  has(html, 'dw-kpi-delta--up');
  has(html, 'up vs');
});
// A comparison manufactured from one row is worse than none.
test('previous_row on a single row REFUSES and says why', () => {
  const html = C.kpiHtml(single, { y_field: 'net_sales', compare: 'previous_row' }, {});
  has(html, 'No comparison');
  has(html, 'at least two rows');
});
test('a named comparison column works', () =>
  has(C.kpiHtml([{ a: 120, b: 100 }], { y_field: 'a', compare_field: 'b' }, {}), 'dw-kpi-delta--up'));
test('a comparison column the query stopped returning says so rather than vanishing', () =>
  has(C.kpiHtml(single, { y_field: 'net_sales', compare_field: 'gone' }, {}), 'No comparison'));
// 4% -> 5% is +1pp. Calling it +25% is a true statement about a different
// quantity, and the one people quote when they want the bigger number.
test('a RATE compares in percentage points, with the relative change in brackets', () => {
  const html = C.kpiHtml([{ conversion_rate: 5, prior_rate: 4 }],
    { y_field: 'conversion_rate', compare_field: 'prior_rate' }, {});
  has(html, '1pp');
  has(html, '25% relative');
});
test('a zero prior prints the absolute move rather than an infinite percentage', () => {
  const html = C.kpiHtml([{ a: 50, b: 0 }], { y_field: 'a', compare_field: 'b' }, {});
  has(html, 'the prior value is zero');
  not(html, 'Infinity');
});

// ── Sparkline ─────────────────────────────────────────────────────────
console.log('\n── sparkline ──');

const series = Array.from({ length: 10 }, (_, i) => ({ v: 100 + i * 5 }));
test('off by default', () => not(C.kpiHtml(series, { y_field: 'v' }, {}), 'dw-kpi-spark'));
test('on, it draws one polyline', () => {
  const html = C.kpiHtml(series, { y_field: 'v', sparkline: true }, {});
  has(html, 'dw-kpi-spark');
  eq((html.match(/<polyline/g) || []).length, 1);
});
test('...with a text alternative, since it carries no axes', () =>
  has(C.kpiHtml(series, { y_field: 'v', sparkline: true }, {}), 'aria-label="Trend across 10 points'));
test('a single row has no trend to draw', () =>
  not(C.kpiHtml(single, { y_field: 'net_sales', sparkline: true }, {}), 'dw-kpi-spark'));
// The fill under the line is an SVG gradient, and an SVG gradient is
// addressed by id. Two KPI tiles on one board that minted the same id
// would leave the second definition painting the first tile's fill.
test('two sparklines never share a gradient id', () => {
  const idOf = (html) => (html.match(/<linearGradient id="([^"]+)"/) || [])[1];
  const a = idOf(C.kpiHtml(series, { y_field: 'v', sparkline: true }, {}));
  const b = idOf(C.kpiHtml(series, { y_field: 'v', sparkline: true }, {}));
  truthy(a && b);
  truthy(a !== b, `both sparklines used ${a}`);
});
test('...and the line references the id its own <defs> declared', () => {
  const html = C.kpiHtml(series, { y_field: 'v', sparkline: true }, {});
  const id = (html.match(/<linearGradient id="([^"]+)"/) || [])[1];
  has(html, `fill="url(#${id})"`);
});

const r = R.summary();
process.exit(r.fail ? 1 : 0);
