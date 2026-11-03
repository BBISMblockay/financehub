// Sales & journals: a location's month can net NEGATIVE on shipping, tax or
// receivable (a refund-heavy month). The page's "Balanced" chip summed the
// SIGNED amounts and always read 0.00, while je-composer.js stages
// Math.abs(amount) on whichever side the value sat on -- so a negative credit
// became a positive credit instead of a debit, and the staged entry did not
// balance. October 2026 was out by $34,049.62 that way.
//
// These tests run the page's real salesEntryLines() against the production
// bucket figures and assert BOTH balance definitions agree:
//   page   = sum of signed dr/cr      (the chip, the Sales Journal card)
//   staged = sum of abs() per side    (what the composer writes to the DB)
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../../v2/accounting-export.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('  async function boot()'));

// The page's inline script is not an IIFE and touches the DOM at the top
// level, so the harness supplies just enough of one to let it evaluate, then
// reaches back in for the two pure functions under test.
function subject() {
  const node = () => ({value: '', innerHTML: '', textContent: '', hidden: false, className: '',
    style: {}, dataset: {}, querySelector: node, querySelectorAll: () => [], addEventListener() {}});
  const db = {from() {const q = {}; for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'in', 'maybeSingle', 'upsert', 'insert']) q[m] = () => q;
    q.then = (res, rej) => Promise.resolve({data: [], error: null}).then(res, rej); return q;}};
  const window = {__SILO_CONFIG__: {SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'synthetic'},
    supabase: {createClient: () => db}, location: {pathname: '/', search: ''}};
  const box = {window, document: {getElementById: node, querySelector: node, querySelectorAll: () => [],
    addEventListener() {}}, console, setTimeout() {}, fetch: () => Promise.resolve(), sessionStorage: {getItem: () => null, setItem() {}}};
  vm.runInNewContext(
    '(function(){\n' + script + '\nwindow.subject = {salesEntryLines, computeTotals, state, round2};\n})();',
    box,
  );
  const api = window.subject;
  // Name every account after its mapping key, so a line is identifiable and
  // nothing resolves to the "** UNMAPPED **" marker.
  for (const key of ['tax_income_all', 'freight', 'discounts', 'tax_liability', 'tax_payable',
    'accounts_receivable', 'processing_fees']) api.state.coa[key] = key;
  api.state.locationAccounts = new Proxy({}, {get: () => (
    {revenue_name: 'revenue_template', refunds_name: 'refunds_template'})});
  return api;
}

// Scores one bucket the way each surface does.
function score(api, bucket) {
  const lines = api.salesEntryLines(bucket);
  let pageDr = 0, pageCr = 0, stagedDr = 0, stagedCr = 0;
  const negative = [];
  for (const l of lines) {
    pageDr += Number(l.dr || 0);
    pageCr += Number(l.cr || 0);
    if (Number(l.dr) < 0 || Number(l.cr) < 0) negative.push(l.account);
    if (!l.dr && !l.cr) continue;                 // every surface skips a zero line
    // je-composer.js: posting type from the non-zero side, amount abs()'d.
    if (l.dr) stagedDr += Math.abs(Number(l.dr));
    else stagedCr += Math.abs(Number(l.cr));
  }
  // `|| 0` normalises -0, which strictEqual treats as unequal to 0.
  const cents = (n) => (Math.round(n * 100) / 100) || 0;
  return {page: cents(pageDr - pageCr), staged: cents(stagedDr - stagedCr), negative};
}

// Real rows from accounting_sales_buckets(), read off production 2026-11-03.
// These three months are the only ones since Jan 2026 that carried a negative
// term; every other month was already clean on both definitions.
const PRODUCTION = [
  ['2026-10 college_world_series', {location_tag: 'cws', gross: 0, discounts: 0, refunds: 27.06, shipping: 0, taxes: -6.94}],
  ['2026-10 wholesale', {location_tag: 'wholesale', gross: 0, discounts: 0, refunds: 16997.75, shipping: -380.29, taxes: 0}],
  ['2026-05 negative tax', {location_tag: 'may', gross: 0, discounts: 0, refunds: 42.00, shipping: 0, taxes: -42.00}],
  ['2026-01 negative tax', {location_tag: 'jan', gross: 0, discounts: 0, refunds: 60.00, shipping: 0, taxes: -60.00}],
];

test('a month with a negative total balances on the card AND as staged lines', () => {
  const api = subject();
  for (const [label, bucket] of PRODUCTION) {
    const r = score(api, bucket);
    assert.equal(r.page, 0, `${label}: the Sales Journal card does not balance`);
    assert.equal(r.staged, 0, `${label}: the staged entry does not balance (out by ${r.staged})`);
    assert.deepEqual(r.negative, [],
      `${label}: negative amounts on ${r.negative.join(', ')} -- the composer would abs() these onto the wrong side`);
  }
});

test('an ordinary all-positive month is unchanged', () => {
  const api = subject();
  const bucket = {location_tag: 'ok', gross: 10000, discounts: 500, refunds: 250, shipping: 125.50, taxes: 812.34};
  const r = score(api, bucket);
  assert.equal(r.page, 0);
  assert.equal(r.staged, 0);
  // Side and amount of every line, so the sign normalisation cannot quietly
  // reroute a normal month.
  const want = {revenue_template: [0, 10000], tax_income_all: [0, 812.34], freight: [0, 125.50],
    refunds_template: [250, 0], discounts: [500, 0], tax_liability: [812.34, 0],
    tax_payable: [0, 812.34], accounts_receivable: [10187.84, 0]};
  for (const l of api.salesEntryLines(bucket)) {
    // Unmapped accounts resolve to a visible marker, so match on the key.
    assert.ok(want[l.account], `unexpected line ${l.account}`);
    assert.deepEqual([l.dr, l.cr], want[l.account], `line ${l.account}`);
  }
});

test('a zero month produces no lines to post', () => {
  const api = subject();
  const lines = api.salesEntryLines({location_tag: 'none', gross: 0, discounts: 0, refunds: 0, shipping: 0, taxes: 0});
  assert.equal(lines.filter((l) => l.dr || l.cr).length, 0);
});

test('a term that nets to zero only after rounding produces no line at all', () => {
  const api = subject();
  // Ordinary 2dp figures whose receivable is exactly zero in cents but drifts
  // to -5.68e-14 in float. Left unrounded that is a truthy amount, so it
  // survives the "skip zero lines" guard, stages as "0.00", and the composer
  // then refuses the whole entry ("every line needs an amount above zero").
  // Both drift directions matter: a negative one is rounded away by the sign
  // flip, but a POSITIVE one never reaches the flip, so only rounding the
  // inputs stops it.
  for (const bucket of [
    {location_tag: 'drift-neg', gross: 1344.37, discounts: 1058.41, refunds: 1739.79, shipping: 1830.65, taxes: -376.82},
    {location_tag: 'drift-pos', gross: 1985.52, discounts: 118.07, refunds: 768.13, shipping: 60.51, taxes: -1159.83},
  ]) {
    const ar = api.salesEntryLines(bucket).filter((l) => l.account === 'accounts_receivable');
    assert.equal(ar.length, 1);
    assert.deepEqual([ar[0].dr, ar[0].cr], [0, 0],
      `${bucket.location_tag}: receivable should drop out entirely, not stage as 0.00`);
    const r = score(api, bucket);
    assert.equal(r.page, 0, bucket.location_tag);
    assert.equal(r.staged, 0, bucket.location_tag);
  }
});

test('the chip and the staged entry agree across randomised months', () => {
  const api = subject();
  // Deterministic pseudo-random sweep: the point is that NO combination of
  // signs can make the two definitions disagree again.
  let seed = 20261103;
  const rnd = () => {seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648;};
  const money = () => Math.round((rnd() * 40000 - 20000) * 100) / 100;
  for (let i = 0; i < 2000; i++) {
    const bucket = {location_tag: `r${i}`, gross: money(), discounts: money(),
      refunds: money(), shipping: money(), taxes: money()};
    const r = score(api, bucket);
    assert.equal(r.page, 0, `case ${i} ${JSON.stringify(bucket)}: card`);
    assert.equal(r.staged, 0, `case ${i} ${JSON.stringify(bucket)}: staged out by ${r.staged}`);
    assert.deepEqual(r.negative, [], `case ${i}: negative amounts`);
  }
});

test('the Receivable / clearing KPI nets a credit-side receivable', () => {
  const api = subject();
  // 2026-10 wholesale: refunds 16,997.75 and shipping -380.29 put the
  // receivable at -17,378.04, i.e. on the credit side. The KPI is the net
  // movement, so it must read -17,378.04, not 0.00.
  api.state.buckets = [{location_tag: 'wholesale', gross: 0, discounts: 0,
    refunds: 16997.75, shipping: -380.29, taxes: 0, total: 0}];
  api.state.payouts = [];
  assert.equal(api.round2(api.computeTotals().clearingTotal), -17378.04);
});

test('computeTotals reports the same balance the staged entry will have', () => {
  const api = subject();
  api.state.buckets = PRODUCTION.map(([, b]) => ({...b, total: 0}));
  api.state.payouts = [];
  const totals = api.computeTotals();
  assert.equal(totals.diff, 0);
  let stagedDr = 0, stagedCr = 0;
  for (const [, b] of PRODUCTION) {
    for (const l of api.salesEntryLines(b)) {
      if (!l.dr && !l.cr) continue;
      if (l.dr) stagedDr += Math.abs(Number(l.dr)); else stagedCr += Math.abs(Number(l.cr));
    }
  }
  assert.equal(api.round2(totals.journalDr), api.round2(stagedDr));
  assert.equal(api.round2(totals.journalCr), api.round2(stagedCr));
});
