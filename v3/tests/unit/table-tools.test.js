/* Search, sort and CSV on a table tile -- and the one property all three
 * share: they must describe the same rows.
 *
 * An export that quietly covers a different set from the screen is the most
 * expensive kind of wrong number, because it leaves the building. So
 * tableRows() is the single decision about "which rows", and both the table
 * and the CSV are built from it. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const R = createReporter('table-tools');
const { test, eq, has, not, truthy } = R;

const rows = [
  { product_title: 'Bubbles and Doubles Tee', net_sales: 241033.55, units: 19362 },
  { product_title: 'Stuck On The Game Shorts', net_sales: 118240, units: 13219 },
  { product_title: 'Pin of the Month', net_sales: 4210.5, units: 842 },
];

// ── Search ────────────────────────────────────────────────────────────
console.log('\n── search ──');

test('search matches any cell, case-insensitively', () =>
  eq(C.tableRows(rows, {}, { search: 'bubbles' }).shown.length, 1));
test('search matches a numeric cell too', () =>
  eq(C.tableRows(rows, {}, { search: '842' }).shown.length, 1));
test('no match is zero rows, not every row', () =>
  eq(C.tableRows(rows, {}, { search: 'zzz' }).shown.length, 0));
test('the table says what the search matched, against what is loaded', () => {
  const html = C.tableHtml(rows, {}, {}, { search: 'tee' });
  has(html, 'Search matched 1 of 3 loaded rows');
});
// Reading is not editing: a search must not become part of the saved
// dashboard, so it is passed in as UI state rather than read from config.
test('search is UI state -- passing none is the unfiltered table', () =>
  eq(C.tableRows(rows, {}, {}).shown.length, 3));

// ── Sort ──────────────────────────────────────────────────────────────
console.log('\n── sort ──');

test("the widget's configured sort still applies with no click", () =>
  eq(C.tableRows(rows, { y_field: 'units', sort: 'asc' }, {}).shown[0].units, 842));
test("a reader's column click wins over the configured sort", () =>
  eq(C.tableRows(rows, { y_field: 'units', sort: 'asc' },
    { sortCol: 'net_sales', sortDir: 'desc' }).shown[0].net_sales, 241033.55));
test('a text column sorts alphabetically, not numerically', () =>
  eq(C.tableRows(rows, {}, { sortCol: 'product_title', sortDir: 'asc' }).shown[0].product_title,
    'Bubbles and Doubles Tee'));
test('the sorted header is marked for assistive tech, not only with an arrow', () => {
  const html = C.tableHtml(rows, {}, {}, { sortCol: 'units', sortDir: 'desc' });
  has(html, 'aria-sort="descending"');
});
test('an unsorted header says so rather than being silent', () =>
  has(C.tableHtml(rows, {}, {}, {}), 'aria-sort="none"'));
test('every header is a real button, so the sort is keyboard-reachable', () => {
  const html = C.tableHtml(rows, {}, {}, {});
  eq((html.match(/data-sort-col=/g) || []).length, 3);
});
test('clicking the sorted column again offers the other direction', () => {
  const html = C.tableHtml(rows, {}, {}, { sortCol: 'units', sortDir: 'desc' });
  has(html, 'data-sort-col="units" data-sort-dir="asc"');
});

// ── Scrolling and cells ───────────────────────────────────────────────
console.log('\n── access ──');

// A wide table whose rightmost columns can only be reached by dragging is
// unusable without a mouse.
test('the horizontal scroller is focusable and labelled', () => {
  const html = C.tableHtml(rows, {}, {}, {});
  has(html, 'class="dw-table-wrap" tabindex="0" role="region"');
  has(html, 'aria-label="Table, scroll horizontally for more columns"');
});
test('a dimension cell carries its RAW value for click-to-filter', () => {
  const html = C.tableHtml(rows, {}, {}, {});
  has(html, 'data-col="product_title"');
  has(html, 'data-value="Bubbles and Doubles Tee"');
});
test('a numeric cell carries no filter value -- filtering on $241,033.55 matches nothing', () => {
  const html = C.tableHtml(rows, {}, {}, {});
  not(html, 'data-value="241033.55"');
});

// ── Totals ────────────────────────────────────────────────────────────
console.log('\n── totals ──');

const withRate = [
  { channel: 'Web', orders: 1000, sessions: 10000, conversion_rate: 10 },
  { channel: 'Retail', orders: 2, sessions: 100, conversion_rate: 2 },
];
test('currency and counts total', () => {
  const html = C.tableHtml(rows, { totals: 'row' }, {}, {});
  has(html, 'dw-total-row');
  has(html, '33,423');
});
test('a rate is POOLED from its parts when the report returns them', () => {
  const html = C.tableHtml(withRate, { totals: 'row' }, {}, {});
  // 1002 / 10100 = 9.92%, not the 12 a sum gives nor the 6 an average does.
  has(html, '9.9%');
});
test('...and the total says it was pooled, not summed', () =>
  has(C.tableHtml(withRate, { totals: 'row' }, {}, {}), 'pooled from orders'));
test('a rate with no parts in the result is left BLANK and the reason is stated', () => {
  const bare = [{ channel: 'Web', conversion_rate: 10 }, { channel: 'Retail', conversion_rate: 2 }];
  const html = C.tableHtml(bare, { totals: 'row' }, {}, {});
  not(html, '>12<');
  has(html, 'No total for');
});
test('a truncated table says the total covers only the rows shown', () =>
  has(C.tableHtml(rows, { totals: 'row', limit: 2 }, {}, {}), 'the total covers the rows shown'));

// ── Conditional formatting ────────────────────────────────────────────
console.log('\n── conditional formatting ──');

const rules = (r) => C.tableHtml(rows, { rules: [r] }, {}, {});
test('a threshold rule tones the matching cells', () =>
  has(rules({ col: 'units', op: 'gt', value: 15000, tone: 'pos' }), 'dw-rule--pos'));
test('...and leaves the others alone', () => {
  const html = rules({ col: 'units', op: 'gt', value: 15000, tone: 'pos' });
  eq((html.match(/dw-rule--pos/g) || []).length, 1);
});
test('a between rule takes both bounds', () =>
  has(rules({ col: 'units', op: 'between', value: 800, value2: 1000, tone: 'warn' }), 'dw-rule--warn'));
test('a rule naming a column the query no longer returns is skipped, not an error', () =>
  not(rules({ col: 'gone_away', op: 'gt', value: 1, tone: 'neg' }), 'dw-rule'));
test('a contains rule works on text', () =>
  has(rules({ col: 'product_title', op: 'contains', value: 'pin', tone: 'neg' }), 'dw-rule--neg'));

// ── CSV ───────────────────────────────────────────────────────────────
console.log('\n── csv ──');

test('the CSV header uses the same labels the table prints', () => {
  const csv = C.tableCsv(rows, {}, {}, {});
  has(csv.split('\n')[0], 'Product Title,Net Sales,Units');
});
test('values are RAW, not formatted -- a spreadsheet needs 241033.55', () =>
  has(C.tableCsv(rows, {}, {}, {}), '241033.55'));
test('a comma in a value is quoted, and a quote is doubled', () => {
  const csv = C.tableCsv([{ a: 'Tee, black', b: 'say "hi"' }], {}, {}, {});
  has(csv, '"Tee, black"');
  has(csv, '"say ""hi"""');
});
test('the export follows the current search', () =>
  eq(C.tableCsv(rows, {}, {}, { search: 'pin' }).trim().split('\n').length, 3)); // scope + header + 1 row
test('the export follows the current sort', () => {
  const csv = C.tableCsv(rows, {}, {}, { sortCol: 'units', sortDir: 'asc' });
  has(csv.split('\n')[1], 'Pin of the Month');
});
test('the export follows hidden and reordered columns', () => {
  const csv = C.tableCsv(rows, { columns: ['units', 'product_title'] }, {}, {});
  eq(csv.split('\n')[0], 'Units,Product Title');
});
// An export that looks complete and is not is the whole risk here.
test('a page-capped export names its scope IN THE FILE, not only in the UI', () => {
  const csv = C.tableCsv(rows, {}, {}, { hasMore: true });
  has(csv.split('\n')[0], '# ');
  has(csv, 'Load more first for the rest');
});
test('a partially loaded report says how much of it is in the file', () => {
  const csv = C.tableCsv(rows, {}, {}, { totalRows: 7231 });
  has(csv, '3 of 7231 rows loaded');
});
test('a complete, unfiltered export carries no scope line to misread', () =>
  not(C.tableCsv(rows, {}, {}, {}).split('\n')[0], '#'));

const r = R.summary();
process.exit(r.fail ? 1 : 0);
