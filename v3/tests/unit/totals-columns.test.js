/* Batch 2: totals, column selection, chart options.
 *
 * The rule under test throughout is the same one the rest of v3 follows:
 * refuse to state something the data does not support. A total of a rate is
 * not a smaller number, it is a wrong one, so it is blank. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const R = createReporter('totals-columns');
const { test, eq, has, not, truthy } = R;

const SALES = [
  { product_title: 'Tee', net_sales: 100, units: 4, conversion_rate: 0.5 },
  { product_title: 'Shorts', net_sales: 250, units: 6, conversion_rate: 0.3 },
];
const SEM = { net_sales: 'currency', units: 'count', conversion_rate: 'percent',
              product_title: 'category' };

// ── Totals on a table ─────────────────────────────────────────────────
console.log('\n── table totals ──');
test('no totals unless asked', () =>
  not(C.tableHtml(SALES, {}, SEM), 'dw-total-row'));
test('currency and counts are summed', () => {
  const html = C.tableHtml(SALES, { totals: 'row' }, SEM);
  has(html, 'dw-total-row');
  has(html, '$350');
  has(html, '>10<');
});
test('a RATE is left blank, not summed or averaged', () => {
  const html = C.tableHtml(SALES, { totals: 'row' }, SEM);
  not(html, '80%');      // 0.5 + 0.3 summed
  not(html, '40%');      // averaged
});
test('the first column is labelled Total, not summed', () =>
  has(C.tableHtml(SALES, { totals: 'row' }, SEM), 'dw-total-label">Total<'));
test('a negative total is coloured like any other negative', () =>
  has(C.tableHtml([{ a: 'x', v: -5 }, { a: 'y', v: -3 }], { totals: 'row' }, { v: 'currency' }),
      'dw-num dw-neg'));
test('a truncated table SAYS the total covers only what is shown', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ a: 'r' + i, v: 1 }));
  has(C.tableHtml(many, { totals: 'row', limit: 3 }, { v: 'currency' }),
      'the total covers the rows shown');
});

// ── Column selection ──────────────────────────────────────────────────
console.log('\n── columns ──');
test('with no config every column shows, in query order', () => {
  const html = C.tableHtml(SALES, {}, SEM);
  truthy(html.indexOf('Product Title') < html.indexOf('Net Sales'), 'query order lost');
  has(html, 'Conversion Rate');
});
test('a column list HIDES the rest', () => {
  const html = C.tableHtml(SALES, { columns: ['product_title', 'net_sales'] }, SEM);
  has(html, 'Product Title');
  not(html, 'Conversion Rate');
});
test('the list also REORDERS', () => {
  const html = C.tableHtml(SALES, { columns: ['net_sales', 'product_title'] }, SEM);
  truthy(html.indexOf('Net Sales') < html.indexOf('Product Title'), 'not reordered');
});
test('a column the query no longer returns drops out rather than rendering blank', () => {
  const html = C.tableHtml(SALES, { columns: ['net_sales', 'gone_away'] }, SEM);
  has(html, 'Net Sales');
  not(html, 'Gone Away');
});
test('an empty list is ignored, not treated as "hide everything"', () =>
  has(C.tableHtml(SALES, { columns: [] }, SEM), 'Product Title'));

// ── Matrix totals ─────────────────────────────────────────────────────
console.log('\n── matrix totals ──');
const M = [
  { m: 'Jan', l: 'Income', v: 100 }, { m: 'Feb', l: 'Income', v: 200 },
  { m: 'Jan', l: 'Costs', v: 40 },   { m: 'Feb', l: 'Costs', v: 60 },
];
const MC = { row_field: 'l', x_field: 'm', y_field: 'v', aggregate: 'none' };

test('a total COLUMN sums across each row', () => {
  const html = C.matrixHtml(M, { ...MC, totals: 'column' }, { v: 'currency' });
  has(html, '$300');   // Income across Jan+Feb
  has(html, '$100');   // Costs across Jan+Feb
});
test('a total ROW sums down each column', () => {
  const html = C.matrixHtml(M, { ...MC, totals: 'row' }, { v: 'currency' });
  has(html, 'dw-total-row');
  has(html, '$140');   // Jan down
  has(html, '$260');   // Feb down
});
test('both gives a grand total in the corner', () => {
  const html = C.matrixHtml(M, { ...MC, totals: 'both' }, { v: 'currency' });
  has(html, '$400');
});
test('totals are REFUSED for a rate, and the tile says why', () => {
  const html = C.matrixHtml(M, { ...MC, totals: 'both' }, { v: 'percent' });
  not(html, 'dw-total-row');
  has(html, 'summing a rate is not meaningful');
});
test('no totals config means no totals markup at all', () =>
  not(C.matrixHtml(M, MC, { v: 'currency' }), 'dw-total'));

// ── Chart options ─────────────────────────────────────────────────────
console.log('\n── chart options ──');
const CHART = [{ platform: 'meta', spend: 100, clicks: 20 },
                { platform: 'google', spend: 80, clicks: 15 }];

const optionOf = (cfg) => {
  const shaped = C.shape(CHART, cfg, { spend: 'currency', clicks: 'count' });
  return C.optionFor(cfg.visual || 'bar', shaped, cfg);
};

test('value labels are off by default', () => {
  const o = optionOf({ x_field: 'platform', y_field: 'spend' });
  truthy(o.series.every((sr) => !sr.label || sr.label.show === false), 'labels on by default');
});
test('show_values turns them on', () => {
  const o = optionOf({ x_field: 'platform', y_field: 'spend', show_values: true });
  truthy(o.series.some((sr) => sr.label && sr.label.show === true), 'labels not shown');
});
test('value labels are suppressed on a long series, where they would collide', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ platform: 'p' + i, spend: i }));
  const shaped = C.shape(many, { x_field: 'platform', y_field: 'spend', limit: 0 }, { spend: 'currency' });
  const o = C.optionFor('bar', shaped, { show_values: true, limit: 0 });
  truthy(o.series.every((sr) => !sr.label || sr.label.show === false), 'labels not suppressed');
});
test('stacking is off by default', () => {
  const o = optionOf({ x_field: 'platform', measures: ['spend'], y_field: 'spend' });
  truthy(o.series.every((sr) => !sr.stack), 'stacked by default');
});
test('stacked bars stack when every series shares a semantic', () => {
  const rows = [{ p: 'a', x: 1, y: 2 }, { p: 'b', x: 3, y: 4 }];
  const shaped = C.shape(rows, { x_field: 'p', measures: ['x', 'y'], y_field: 'x' },
    { x: 'currency', y: 'currency' });
  const o = C.optionFor('bar', shaped, { stacked: true });
  truthy(o.series.every((sr) => sr.stack === 'total'), 'not stacked');
});
test('MIXED semantics refuse to stack — dollars on a ratio is a number that does not exist', () => {
  const rows = [{ p: 'a', spend: 1, roas: 2 }, { p: 'b', spend: 3, roas: 4 }];
  const shaped = C.shape(rows, { x_field: 'p', measures: ['spend', 'roas'], y_field: 'spend' },
    { spend: 'currency', roas: 'number' });
  const o = C.optionFor('bar', shaped, { stacked: true });
  truthy(o.series.every((sr) => !sr.stack), 'stacked across different semantics');
});
test('a LINE chart never stacks, even when asked', () => {
  const rows = [{ p: 'a', x: 1, y: 2 }, { p: 'b', x: 3, y: 4 }];
  const shaped = C.shape(rows, { x_field: 'p', measures: ['x', 'y'], y_field: 'x' },
    { x: 'currency', y: 'currency' });
  const o = C.optionFor('line', shaped, { stacked: true });
  truthy(o.series.every((sr) => !sr.stack), 'a stacked line is an area chart nobody asked for');
});

const r = R.summary();
process.exit(r.fail ? 1 : 0);
