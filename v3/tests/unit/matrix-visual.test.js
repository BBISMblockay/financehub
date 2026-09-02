/* The matrix visual: one dimension down, another across.
 *
 * The two rules worth protecting are about ORDER and about EMPTY. A P&L
 * read alphabetically is not a P&L, and a matrix that prints 0 where there
 * was no row is the same class of lie as a coalesced velocity. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const R = createReporter('matrix-visual');
const { test, eq, has, not, truthy } = R;

// A P&L in statement order, exactly the shape the QBO report returns.
const PL = [];
for (const month of ['2025-01-01', '2025-02-01']) {
  PL.push(
    { month, line_no: 1, line: 'Total Income', amount: 924080.35 },
    { month, line_no: 2, line: 'Total Cost of Goods Sold', amount: 662604.57 },
    { month, line_no: 3, line: 'Gross Profit', amount: 261475.78 },
    { month, line_no: 8, line: 'Net Income', amount: -639024.07 });
}
const CFG = { row_field: 'line', x_field: 'month', y_field: 'amount', aggregate: 'none' };
const SEM = { amount: 'currency', month: 'date', line: 'category' };

console.log('\n── shape ──');
test('rows are the row dimension, columns the column dimension', () => {
  const html = C.matrixHtml(PL, CFG, SEM);
  has(html, '>Total Income<');
  has(html, '>Net Income<');
  has(html, '>2025-01-01<');
  has(html, '>2025-02-01<');
});
test('the measure is formatted by its semantic', () =>
  has(C.matrixHtml(PL, CFG, SEM), '$924,080'));
test('a negative reads as negative', () =>
  has(C.matrixHtml(PL, CFG, SEM), '-$639,024'));

console.log('\n── order: the whole reason a P&L works ──');
test('rows keep the QUERY order, not alphabetical', () => {
  const html = C.matrixHtml(PL, CFG, SEM);
  const order = ['Total Income', 'Total Cost of Goods Sold', 'Gross Profit', 'Net Income']
    .map((l) => html.indexOf('>' + l + '<'));
  truthy(order.every((v, i) => i === 0 || v > order[i - 1]),
    'statement order lost — got positions ' + JSON.stringify(order));
  // Alphabetically "Gross Profit" would come first; it must not.
  truthy(html.indexOf('>Total Income<') < html.indexOf('>Gross Profit<'),
    'sorted alphabetically instead of by query order');
});
test('date columns are chronological even if the query is not', () => {
  const scrambled = [
    { m: '2025-03-01', l: 'A', v: 3 }, { m: '2025-01-01', l: 'A', v: 1 },
    { m: '2025-02-01', l: 'A', v: 2 }];
  const html = C.matrixHtml(scrambled, { row_field: 'l', x_field: 'm', y_field: 'v' }, { m: 'date' });
  const at = (d) => html.indexOf('>' + d + '<');
  truthy(at('2025-01-01') < at('2025-02-01') && at('2025-02-01') < at('2025-03-01'),
    'date columns not in order');
});
test('a NON-date column keeps first-appearance order', () => {
  const rows = [{ c: 'zulu', r: 'x', v: 1 }, { c: 'alpha', r: 'x', v: 2 }];
  const html = C.matrixHtml(rows, { row_field: 'r', x_field: 'c', y_field: 'v' }, {});
  truthy(html.indexOf('>zulu<') < html.indexOf('>alpha<'), 'column order was re-sorted');
});

console.log('\n── empty is not zero ──');
test('a missing (row, column) pair renders EMPTY, never 0', () => {
  const sparse = [
    { m: 'Jan', l: 'Income', v: 100 },
    { m: 'Feb', l: 'Income', v: 200 },
    { m: 'Jan', l: 'Refunds', v: 5 },
    // no Feb Refunds row at all
  ];
  const html = C.matrixHtml(sparse, { row_field: 'l', x_field: 'm', y_field: 'v' }, { v: 'currency' });
  has(html, '<td class="dw-num"></td>');
});
test('an explicit zero still prints as zero', () => {
  const rows = [{ m: 'Jan', l: 'Income', v: 0 }];
  has(C.matrixHtml(rows, { row_field: 'l', x_field: 'm', y_field: 'v' }, { v: 'currency' }), '$0');
});

console.log('\n── aggregation ──');
test('several source rows per cell are summed by default', () => {
  const rows = [{ m: 'Jan', l: 'A', v: 10 }, { m: 'Jan', l: 'A', v: 15 }];
  has(C.matrixHtml(rows, { row_field: 'l', x_field: 'm', y_field: 'v' }, {}), '25');
});
test('aggregate:none takes the single value', () => {
  const rows = [{ m: 'Jan', l: 'A', v: 10 }];
  has(C.matrixHtml(rows, { row_field: 'l', x_field: 'm', y_field: 'v', aggregate: 'none' }, {}), '10');
});

console.log('\n── guards ──');
test('0 rows says so', () => has(C.matrixHtml([], CFG, SEM), '0 rows'));
test('the same field for rows and columns is refused, not drawn', () =>
  has(C.matrixHtml(PL, { row_field: 'line', x_field: 'line', y_field: 'amount' }, SEM),
      'needs a row field'));
test('markup in a row label is escaped', () => {
  const rows = [{ m: 'Jan', l: '<script>alert(1)</script>', v: 1 }];
  const html = C.matrixHtml(rows, { row_field: 'l', x_field: 'm', y_field: 'v' }, {});
  not(html, '<script>');
  has(html, '&lt;script&gt;');
});
test('a row limit reports what it hid', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ m: 'Jan', l: 'L' + i, v: i }));
  has(C.matrixHtml(rows, { row_field: 'l', x_field: 'm', y_field: 'v', limit: 3 }, {}),
      'Showing 3 of 8 rows');
});
test('it picks sensible fields with no config at all', () => {
  const html = C.matrixHtml(PL, {}, SEM);
  not(html, 'needs a row field');
  has(html, '<table');
});

const r = R.summary();
process.exit(r.fail ? 1 : 0);
