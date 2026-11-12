// The Affiliate Studio Overview tab's maths (v2/affiliates/studio-core.js):
// the two windows it compares, what counts as a sale, what it refuses to sum,
// and who it puts on the "reach out" list and why.
//
// Mutations (CI runs each and requires a failure):
//   AFFILIATE_OVERVIEW_MUTATION=curmix    orders in another currency are added to the program's
//   AFFILIATE_OVERVIEW_MUTATION=weekcur   the weekly trend adds other currencies together
//   AFFILIATE_OVERVIEW_MUTATION=refused   an order the resolver refused counts as a sale
//   AFFILIATE_OVERVIEW_MUTATION=orderdupe two rows for one order count as two orders
//   AFFILIATE_OVERVIEW_MUTATION=undated   an undated ledger line lands in every window
//   AFFILIATE_OVERVIEW_MUTATION=quietnow  "quiet" ignores how long the window is
//   AFFILIATE_OVERVIEW_MUTATION=stucknow  an invite is chased the day it goes out
//   AFFILIATE_OVERVIEW_MUTATION=codefresh a code that went live today is called a failure
//   AFFILIATE_OVERVIEW_MUTATION=capok     a read that filled every page is treated as complete
//   AFFILIATE_OVERVIEW_MUTATION=pageerr   a page that could not be read is treated as the end
//   AFFILIATE_OVERVIEW_MUTATION=unclaimed owed money is read as unclaimed, so a draft payout hides it
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_OVERVIEW_MUTATION || '';
const MUTS = {
  curmix: ["    && CUR(r.order_currency || cur) === cur);", '  );'],
  weekcur: ["    if (!r?.order_day || CUR(r.order_currency || r.currency || cur) !== cur) continue;", '    if (!r?.order_day) continue;'],
  refused: ['  const earning = ovWindowRows(rows, opts).filter((r) => EARNING.has(r.basis));', '  const earning = ovWindowRows(rows, opts);'],
  orderdupe: ['    orders: new Set(earning.map((r) => r.order_id)).size,', '    orders: earning.length,'],
  undated: ["  return (ledger || []).filter((r) => r?.order_day && r.order_day >= from && r.order_day <= to", '  return (ledger || []).filter((r) => (!r?.order_day || (r.order_day >= from && r.order_day <= to))'],
  quietnow: ['    if (silent > days) {', '    if (silent > 0) {'],
  stucknow: ['      if (age >= OV_STUCK_DAYS)', '      if (age >= 0)'],
  codefresh: ['      if (age >= OV_SILENT_CODE_DAYS)', '      if (age >= 0)'],
  capok: ['    if (page.length < pageSize) return rows;\n  }\n  return null;', '    if (page.length < pageSize) return rows;\n  }\n  return rows;'],
  pageerr: ['    if (!Array.isArray(page)) return null;', '    if (!Array.isArray(page)) return rows;'],
  unclaimed: ['    .reduce((n, b) => n + (Number(b.earned_cents || 0) - Number(b.paid_cents || 0)), 0);', '    .reduce((n, b) => n + Number(b.unclaimed_cents || 0), 0);'],
};
if (MUT && !MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
let src = await readFile(new URL('../../v2/affiliates/studio-core.js', import.meta.url), 'utf8');
if (MUT) {
  assert.ok(src.includes(MUTS[MUT][0]), `mutation ${MUT}: pattern not found`);
  src = src.split(MUTS[MUT][0]).join(MUTS[MUT][1]);
}
const dir = await mkdtemp(join(tmpdir(), 'affov-'));
await writeFile(join(dir, 'studio-core.mjs'), src);
const C = await import(pathToFileURL(join(dir, 'studio-core.mjs')).href);

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

const TODAY = '2026-11-12';
const d = (back) => C.dayShift(TODAY, back);
const E = 'single_affiliate_code';
const USD = { currency: 'USD' };
const W30 = { from: d(29), to: TODAY, ...USD };
const P30 = { from: d(59), to: d(30), ...USD };

const ROWS = [
  { id: '1', affiliate_id: 'A', order_id: 'o1', order_day: d(1), basis: E, gross_subtotal_cents: 10000, order_currency: 'USD' },
  { id: '2', affiliate_id: 'A', order_id: 'o2', order_day: d(10), basis: E, gross_subtotal_cents: 5000, order_currency: 'USD' },
  // a second row for the same order: one order, however many rows
  { id: '2b', affiliate_id: 'A', order_id: 'o2', order_day: d(10), basis: E, gross_subtotal_cents: 0, order_currency: 'USD' },
  { id: '3', affiliate_id: 'B', order_id: 'o3', order_day: d(5), basis: E, gross_subtotal_cents: 2000, order_currency: 'USD' },
  // refused: recorded so it can be explained, never credited
  { id: '4', affiliate_id: null, order_id: 'o4', order_day: d(3), basis: 'ambiguous_multiple_affiliate_codes', gross_subtotal_cents: 9999, order_currency: 'USD' },
  // another currency: counted apart, never added in
  { id: '5', affiliate_id: 'A', order_id: 'o5', order_day: d(2), basis: E, gross_subtotal_cents: 70000, order_currency: 'CAD' },
  // the window before this one
  { id: '6', affiliate_id: 'A', order_id: 'o6', order_day: d(35), basis: E, gross_subtotal_cents: 40000, order_currency: 'USD' },
  // inside 12 weeks, outside both 30-day windows
  { id: '7', affiliate_id: 'A', order_id: 'o7', order_day: d(70), basis: E, gross_subtotal_cents: 1000, order_currency: 'USD' },
];
const LEDGER = [
  { id: 'l1', affiliate_id: 'A', order_day: d(1), amount_cents: 1000, currency: 'USD' },
  { id: 'l2', affiliate_id: 'A', order_day: d(10), amount_cents: 500, currency: 'USD' },
  { id: 'l3', affiliate_id: 'B', order_day: d(5), amount_cents: 200, currency: 'USD' },
  { id: 'l4', affiliate_id: 'A', order_day: d(35), amount_cents: 4000, currency: 'USD' },
  { id: 'l5', affiliate_id: 'A', order_day: d(1), amount_cents: 9999, currency: 'CAD' },
  { id: 'l6', affiliate_id: 'A', order_day: null, amount_cents: 777, currency: 'USD' },
];
const AFFILIATES = [
  { id: 'A', display_name: 'Aya', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { id: 'B', display_name: 'Bo', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { id: 'C', display_name: 'Cal', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { id: 'D', display_name: 'Dee', status: 'active', created_at: '2026-01-01T00:00:00Z' },
  { id: 'E', display_name: 'Eli', status: 'invited', created_at: `${d(9)}T00:00:00Z` },
  { id: 'F', display_name: 'Fay', status: 'invited', created_at: `${d(2)}T00:00:00Z` },
  { id: 'G', display_name: 'Gus', status: 'terminated', created_at: '2026-01-01T00:00:00Z' },
  // active, no sale yet, but the code only went live three days ago
  { id: 'H', display_name: 'Hana', status: 'active', created_at: '2026-01-01T00:00:00Z' },
];
const CODES = [
  { id: 'c1', affiliate_id: 'A', code: 'AYA10', status: 'active', starts_on: d(100) },
  { id: 'c2', affiliate_id: 'C', code: 'CAL10', status: 'active', starts_on: d(20) },
  { id: 'c3', affiliate_id: 'H', code: 'NEW10', status: 'active', starts_on: d(3) },
];
const PERF = [
  { affiliate_id: 'A', first_order_day: d(90), last_order_day: d(1) },
  { affiliate_id: 'B', first_order_day: d(5), last_order_day: d(5) },
  { affiliate_id: 'D', first_order_day: d(200), last_order_day: d(50) },
];

await t('calendar maths are plain UTC days', () => {
  assert.equal(C.dayDiff('2026-11-12', '2026-11-02'), 10);
  assert.equal(C.dayShift('2026-03-01', 1), '2026-02-28');
});

const cur = C.ovWindow(ROWS, W30);
await t('a window sells only what the resolver would pay on, in its own currency', () => {
  assert.equal(cur.sales, 17000);
});
await t('an order is counted once, however many rows it has', () => {
  assert.equal(cur.orders, 3);
});
await t('sellers are the affiliates with an earning order', () => {
  assert.deepEqual([...cur.sellers].sort(), ['A', 'B']);
});
await t('the window before it is read the same way', () => {
  assert.equal(C.ovWindow(ROWS, P30).sales, 40000);
});
await t('orders in another currency are counted apart', () => {
  assert.equal(C.ovOtherCurrencyOrders(ROWS, W30), 1);
});
await t('commission comes from the ledger, dated, in the settlement currency', () => {
  assert.equal(C.ovLedgerTotal(LEDGER, W30), 1700);
  assert.equal(C.ovLedgerTotal(LEDGER, P30), 4000);
});

const WK = { today: TODAY, weeks: 12, currency: 'USD' };
const weekly = C.ovWeekly(ROWS, { ...WK, pick: (r) => (C.OV_EARNING_BASES.includes(r.basis) ? Number(r.gross_subtotal_cents || 0) : 0) });
await t('the trend is twelve weeks, oldest first, one currency', () => {
  assert.equal(weekly.length, 12);
  assert.equal(weekly.reduce((a, b) => a + b, 0), 10000 + 5000 + 2000 + 40000 + 1000);
  assert.equal(weekly[11], 10000 + 2000);
});
await t('the weekly seller count is distinct affiliates per week', () => {
  const s = C.ovWeeklySellers(ROWS, WK);
  assert.equal(s.length, 12);
  assert.equal(s[11], 2);
});

const per = C.ovPerAffiliate({
  rows: ROWS, ledger: LEDGER, performance: PERF, affiliates: AFFILIATES,
  currency: 'USD', from: W30.from, to: W30.to, prevFrom: P30.from, prevTo: P30.to,
});
const by = Object.fromEntries(per.map((x) => [x.id, x]));
await t('per affiliate: this window, the one before, and the ledger', () => {
  assert.equal(by.A.sales, 15000);
  assert.equal(by.A.orders, 2);
  assert.equal(by.A.comm, 1500);
  assert.ok(by.A.growth < 0);
  assert.equal(by.B.prevSales, 0);
});
await t('an affiliate row that no longer exists is dropped, not drawn', () => {
  const orphan = C.ovPerAffiliate({
    rows: ROWS, ledger: [], performance: [], affiliates: [], currency: 'USD',
    from: W30.from, to: W30.to, prevFrom: P30.from, prevTo: P30.to,
  });
  assert.deepEqual(orphan, []);
});

const reach = C.ovReachOut({ affiliates: AFFILIATES, codes: CODES, performance: PERF, perWindow: per, today: TODAY, days: 30 });
const kinds = Object.fromEntries(reach.map((x) => [x.id, x.kind]));
await t('each reason is a fact about this program', () => {
  assert.equal(kinds.A, 'drop');
  assert.equal(kinds.B, 'rise');
  assert.equal(kinds.C, 'never');
  assert.equal(kinds.D, 'quiet');
  assert.equal(kinds.E, 'stuck');
});
await t('nobody is chased before there is something to chase', () => {
  assert.equal(kinds.F, undefined);
  assert.equal(kinds.G, undefined);
  assert.equal(kinds.H, undefined);
});
await t('one affiliate gets one reason, the most urgent', () => {
  assert.equal(reach.filter((x) => x.id === 'A').length, 1);
  assert.equal(reach[0].kind, 'stuck');
});
await t('the quiet day count is the real one', () => {
  assert.equal(reach.find((x) => x.id === 'D').days, 50);
});
await t('the message names the code and sends nothing', () => {
  const msg = C.ovMessage(reach.find((x) => x.id === 'C'), { brand: 'Brand', code: 'CAL10' });
  assert.ok(msg.includes('CAL10'));
  assert.ok(msg.includes('Brand'));
  assert.ok(msg.startsWith('Hi Cal,'));
});
await t('every reason has a label', () => {
  for (const k of Object.keys(C.OV_REASONS)) assert.ok(C.OV_REASONS[k]);
});

// Paging: the only proof a window was read whole is a short last page.
const pages = (total, size) => async (i) => {
  const start = i * size;
  if (start >= total) return [];
  return Array.from({ length: Math.min(size, total - start) }, (_, k) => ({ id: start + k }));
};
await t('a short page ends the read', async () => {
  const rows = await C.pagedCollect(pages(2500, 1000), { pageSize: 1000, maxPages: 60 });
  assert.equal(rows.length, 2500);
});
await t('a window that exactly fills a page is still read whole', async () => {
  const rows = await C.pagedCollect(pages(2000, 1000), { pageSize: 1000, maxPages: 60 });
  assert.equal(rows.length, 2000);
});
await t('a read that fills every page is refused, not truncated', async () => {
  assert.equal(await C.pagedCollect(pages(5001, 1000), { pageSize: 1000, maxPages: 5 }), null);
  assert.equal(await C.pagedCollect(pages(5000, 1000), { pageSize: 1000, maxPages: 5 }), null);
});
await t('a page that could not be read refuses the whole read', async () => {
  const fail = async (i) => (i === 1 ? null : Array.from({ length: 1000 }, (_, k) => ({ id: k })));
  assert.equal(await C.pagedCollect(fail, { pageSize: 1000, maxPages: 60 }), null);
});

// Owed money: a draft payout claims a ledger line without paying it.
const BAL = [
  { affiliate_id: 'A', currency: 'USD', earned_cents: 10000, claimed_cents: 10000, paid_cents: 0, unclaimed_cents: 0 },
  { affiliate_id: 'B', currency: 'USD', earned_cents: 5000, claimed_cents: 5000, paid_cents: 5000, unclaimed_cents: 0 },
  { affiliate_id: 'C', currency: 'USD', earned_cents: 2000, claimed_cents: 0, paid_cents: 0, unclaimed_cents: 2000 },
  { affiliate_id: 'D', currency: 'CAD', earned_cents: 9999, claimed_cents: 0, paid_cents: 0, unclaimed_cents: 9999 },
  { affiliate_id: 'E', currency: 'USD', earned_cents: -500, claimed_cents: 0, paid_cents: 0, unclaimed_cents: -500 },
];
await t('owed is what is unpaid, whatever a draft payout has claimed', () => {
  assert.equal(C.ovUnpaid(BAL, 'USD'), 10000 - 0 + 5000 - 5000 + 2000 + (-500));
});
await t('owed keeps a negative adjustment and ignores other currencies', () => {
  assert.equal(C.ovUnpaid([BAL[4]], 'USD'), -500);
  assert.equal(C.ovUnpaid(BAL, 'CAD'), 9999);
});

console.log(`\n1..${n}`);
