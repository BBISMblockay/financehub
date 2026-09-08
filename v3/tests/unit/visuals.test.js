/* The three new visuals, and the rule that governs all of them:
 * a visual that cannot draw a result honestly is not OFFERED.
 *
 * validateVisual() is called before the picker lists a type, not only
 * before a tile draws one. Listing Heatmap for a one-dimension query
 * produces a tile that says "needs two dimensions" -- a worse answer than
 * not offering it, because by then the person has committed the tile. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const R = createReporter('visuals');
const { test, eq, has, truthy } = R;

const V = (type, rows, cfg) => C.validateVisual(type, rows, cfg || {}, {});

// ── What each visual needs ────────────────────────────────────────────
console.log('\n── field validation ──');

const oneDim = [{ product: 'A', net_sales: 10 }, { product: 'B', net_sales: 20 }];
const twoDim = [
  { size: 'S', location: 'Web', units: 3 },
  { size: 'M', location: 'Web', units: 5 },
  { size: 'S', location: 'Retail', units: 2 },
];
const rateOnly = [{ channel: 'Web', conversion_rate: 2.4 }, { channel: 'Retail', conversion_rate: 3.1 }];

test('bar needs a dimension and a measure', () => truthy(V('bar', oneDim).ok));
test('a result with no dimension cannot be a bar', () =>
  truthy(!V('bar', [{ a: 1, b: 2 }]).ok));
test('heatmap needs TWO dimensions', () => {
  const bad = V('heatmap', oneDim);
  truthy(!bad.ok);
  has(bad.reason, 'two dimensions');
});
test('...and is fine with two', () => truthy(V('heatmap', twoDim).ok));
test('matrix has the same requirement, because it is the same shape', () =>
  eq(V('matrix', oneDim).ok, V('heatmap', oneDim).ok));
test('combo needs two numeric columns -- one for bars, one for the line', () => {
  const bad = V('combo', oneDim);
  truthy(!bad.ok);
  has(bad.reason, 'two numeric columns');
});
test('...and is offered once there are two', () =>
  truthy(V('combo', [{ d: 'x', a: 1, b: 2 }, { d: 'y', a: 3, b: 4 }]).ok));

// A bridge ADDS its steps up. Rates do not add up, so the answer would be
// a chart whose height is not a quantity.
test('waterfall refuses a rate outright', () => {
  const bad = V('waterfall', rateOnly, { y_field: 'conversion_rate' });
  truthy(!bad.ok);
  has(bad.reason, 'do not add up');
});
test('donut refuses one too -- slices of a whole have to add up', () => {
  const bad = V('donut', rateOnly, { y_field: 'conversion_rate' });
  truthy(!bad.ok);
  has(bad.reason, 'add up');
});
test('a KPI is fine with a rate: one number, no addition', () =>
  truthy(V('kpi', rateOnly, { y_field: 'conversion_rate' }).ok));
test('nested JSON can only be a table', () => {
  const rows = [{ d: 'x', payload: { a: 1 } }];
  truthy(V('table', rows).ok);
  truthy(!V('bar', rows).ok);
  has(V('bar', rows).reason, 'nested JSON');
});
test('no rows means nothing can be drawn', () => truthy(!V('bar', []).ok));

// ── Heatmap shaping ───────────────────────────────────────────────────
console.log('\n── heatmap ──');

const grid = C.grid2dOf(twoDim, { row_field: 'size', x_field: 'location', y_field: 'units' }, {});
test('rows and columns come from the query, in first-appearance order', () => {
  eq(grid.rows, ['S', 'M']);
  eq(grid.cols, ['Web', 'Retail']);
});
test('every present pair becomes a data point', () => eq(grid.data.length, 3));
// "No row for (M, Retail)" and "(M, Retail) was zero" are different facts.
// A heatmap that colours the first as the ramp's zero is the same class of
// lie as a coalesced velocity.
test('an ABSENT pair is omitted entirely, never emitted as zero', () => {
  const present = grid.data.map((d) => `${d[1]},${d[0]}`);
  truthy(!present.includes('1,1'), 'M x Retail should not exist');
  truthy(!grid.data.some((d) => d[2] === 0));
});
test('cells aggregate when a pair has several source rows', () => {
  const g2 = C.grid2dOf(
    [{ a: 'x', b: 'y', v: 2 }, { a: 'x', b: 'y', v: 3 }],
    { row_field: 'a', x_field: 'b', y_field: 'v' }, {});
  eq(g2.data[0][2], 5);
});
test('a date column across the top is ordered chronologically, not by arrival', () => {
  const g3 = C.grid2dOf([
    { line: 'Income', month: '2026-03-01', v: 3 },
    { line: 'Income', month: '2026-01-01', v: 1 },
  ], { row_field: 'line', x_field: 'month', y_field: 'v' }, {});
  eq(g3.rawCols, ['2026-01-01', '2026-03-01']);
  eq(g3.cols, ['Jan 2026', 'Mar 2026']);
});
test('one dimension is not a heatmap', () =>
  truthy(C.grid2dOf(oneDim, {}, {}) === null));

const heat = C.heatmapOption(grid, C.theme(), 'count');
test('the option is a heatmap series', () => eq(heat.series[0].type, 'heatmap'));
// ECharts puts category index 0 at the BOTTOM. Without inverting, a
// heatmap and a matrix over the same rows disagree about which way up they
// go, and a P&L comes out upside down in one of them.
test('the first row the query returned is drawn at the TOP, like the matrix', () =>
  eq(heat.yAxis.inverse, true));
test('a single-sign measure gets a sequential ramp', () =>
  eq(heat.visualMap.inRange.color.length, 2));
test('a measure crossing zero gets a DIVERGING ramp instead', () => {
  const signed = C.grid2dOf([
    { a: 'x', b: 'p', v: -5 }, { a: 'y', b: 'p', v: 7 },
  ], { row_field: 'a', x_field: 'b', y_field: 'v' }, {});
  const opt = C.heatmapOption(signed, C.theme(), 'currency');
  eq(opt.visualMap.inRange.color.length, 3);
  eq([opt.visualMap.min, opt.visualMap.max], [-7, 7]);
});

// ── Waterfall ─────────────────────────────────────────────────────────
console.log('\n── waterfall ──');

const bridge = [
  { step: 'Opening', delta: 100 },
  { step: 'New orders', delta: 40 },
  { step: 'Refunds', delta: -15 },
  { step: 'Total', delta: 125 },
];
const shaped = C.shape(bridge, { x_field: 'step', y_field: 'delta', sort: 'none' }, {});
const wf = C.waterfallOption(shaped, C.theme(), {});

test('three series: an invisible base plus up and down', () => eq(wf.series.length, 3));
test('the base is transparent, silent and out of the tooltip', () => {
  eq(wf.series[0].itemStyle.color, 'transparent');
  truthy(wf.series[0].silent);
});
test('a positive step stacks on the running total', () => {
  // Opening 100 starts at 0; New orders 40 starts at 100.
  eq(wf.series[0].data.slice(0, 2), [0, 100]);
});
test('a negative step is drawn downward from the new running total', () => {
  // After 140, a -15 step is based at 125 and 15 tall on the "down" series.
  eq(wf.series[0].data[2], 125);
  eq(wf.series[2].data[2], 15);
});
// Drawing a labelled total as another delta double-counts the whole chart.
test('a step named like a total is drawn from ZERO, not stacked', () =>
  eq(wf.series[0].data[3], 0));
test('the order is the query order, and nothing sorts it', () =>
  eq(wf.xAxis.data, ['Opening', 'New orders', 'Refunds', 'Total']));
test('a waterfall has no legend -- up/down is the colour, not a series list', () =>
  eq(wf.legend.show, false));

// ── Combo ─────────────────────────────────────────────────────────────
console.log('\n── combo ──');

// Two measures on a SIMILAR scale and with the same meaning -- both
// currency, both around 1,100 -- so nothing about the numbers says which is
// the reference line and the axis heuristic has nothing to go on. That is
// exactly the case line_measures exists for.
const target = [
  { day_date: '2026-09-01', net_sales: 1000, target_sales: 1100 },
  { day_date: '2026-09-02', net_sales: 1200, target_sales: 1100 },
];
const cShape = C.shape(target, { x_field: 'day_date', measures: ['net_sales', 'target_sales'], sort: 'x_asc' }, {});
test('similar scales share one axis, so neither becomes a line by inference', () =>
  eq(cShape.series.map((s) => s.axis), [0, 0]));
test('naming a line_measure draws it as a line anyway', () => {
  const opt = C.optionFor('combo', cShape, { line_measures: ['target_sales'] });
  eq(opt.series.map((s) => s.type), ['bar', 'line']);
});
test('...and without naming one, combo is just bars', () => {
  const opt = C.optionFor('combo', cShape, {});
  eq(opt.series.map((s) => s.type), ['bar', 'bar']);
});

// ── Axis label and legend ─────────────────────────────────────────────
console.log('\n── axis label / legend ──');

test('an axis label goes on the LEFT axis only', () => {
  const roas = C.shape([
    { d: '1', net_sales: 40000, roas: 3.2 }, { d: '2', net_sales: 38000, roas: 3.4 },
  ], { x_field: 'd', measures: ['net_sales', 'roas'] }, {});
  const opt = C.optionFor('bar', roas, { axis_label: 'Dollars' });
  eq(opt.yAxis[0].name, 'Dollars');
  truthy(opt.yAxis[1].name === undefined, 'the right axis measures something else');
});
test('the legend can be turned off without losing the second axis', () => {
  const roas = C.shape([
    { d: '1', net_sales: 40000, roas: 3.2 }, { d: '2', net_sales: 38000, roas: 3.4 },
  ], { x_field: 'd', measures: ['net_sales', 'roas'] }, {});
  const opt = C.optionFor('bar', roas, { legend: 'off' });
  truthy(!opt.legend);
  eq(opt.yAxis.length, 2);
});

const r = R.summary();
process.exit(r.fail ? 1 : 0);
