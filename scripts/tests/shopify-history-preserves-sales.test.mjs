// A history import must not destroy the history it is not re-importing.
//
// What the audit found on 2026-10-13, in runWindowedHistory: whenever stored
// state was not 'running' it called purgeShopifySalesForShop, which walks from
// the shop's OLDEST sales_by_day row to today and deletes every shopify_api row
// for the shop -- and then re-imported only `historyDays`. On
// baseballism.myshopify.com that is 610,484 rows spanning 2017-11-25 to
// 2026-10-12: the 60-day first-connect default, or the UI's 90d button, would
// have deleted nine years of sales and restored two months. There is no
// transaction around it, so an interrupted re-import leaves the gap permanent
// (and Shopify caps order history at 60 days without read_all_orders, which
// self-installed apps do not have -- so for most shops the deleted years are
// not re-fetchable AT ALL).
//
// Bounding that purge to the requested RANGE was not enough, and cycle 1 of
// the review on PR #967 said so: a 730-day plan purged up front still deleted
// ~670 days it had not fetched when the import died after its first window.
// So the purge now belongs to the window, runs only once Shopify has answered
// for that window, and never runs for a window that came back with no orders
// -- which is exactly what a token without read_all_orders returns for
// anything older than 60 days, HTTP 200 and empty. Refund rows, dated by the
// refund rather than by their parent order, are spared for the same reason
// runHistoryChunk keeps them regardless of window.
//
// Two more defects in the same function, both of which make a retry worse:
// a resume silently ignored a newly requested window but reported the
// REQUESTED day count back as if it had run (a 730-day dispatch against a
// stuck 60-day import finished green claiming 730), and the per-window meta
// write was built from in-memory meta, so the UI's Cancel -- which sets
// meta.history_backfill.status = 'cancelled' on the row -- was overwritten by
// the next window and the import ran on.
//
// These tests drive the real runWindowedHistory over the fake Supabase and a
// stubbed Shopify, because the bound being right inside purgeShopifySalesForShop
// says nothing about the caller passing it.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runWindowedHistory,
  purgeShopifySalesForShop,
  effectiveHistoryDays,
  windowFullyReadable,
  NO_ALL_ORDERS_HISTORY_DAYS,
  READABLE_WHOLE_DAYS,
} from '../lib/shopify-sync-core.mjs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const CO = 'co-1';
const SHOP = 'baseballism.myshopify.com';
const SOURCE = 'shopify_api';
const ALL_ORDERS = ['read_orders', 'read_all_orders', 'read_products', 'read_locations', 'read_inventory'];

const conn = (over = {}) => ({
  id: 'c-1',
  company_entity_id: CO,
  shop_domain: SHOP,
  shop_name: 'Baseballism',
  api_version: '2024-10',
  access_token: 'tok',
  // runWindowedHistory gates on scopes before it touches anything, and
  // read_all_orders is what decides how far back the plan may reach.
  scopes_granted: ALL_ORDERS,
  meta: {},
  ...over,
});

/** The connection row itself. The import re-reads it between windows (that is
 *  how Cancel reaches it) and fails closed when it cannot, so every fixture
 *  needs the row, not just the object passed in. */
function seedConnection(supabase, c) {
  supabase.from('shopify_connections').insert({ id: c.id, meta: c.meta ?? {} });
  return c;
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));

/** One order, dated inside the window being fetched. Its only job is to make
 *  the window non-empty: an empty answer deliberately purges nothing, so a
 *  stub with no orders could never show that a window IS rebuilt. */
const anOrder = (day, id = 1) => ({
  id,
  created_at: `${day}T12:00:00Z`,
  updated_at: `${day}T12:00:00Z`,
  line_items: [],
});

/** Shopify, with control over which windows answer and which one dies.
 *
 * `emptyBefore` models a token without read_all_orders: windows older than
 * that date come back HTTP 200 with no orders, which is what Shopify actually
 * does rather than an error.
 */
function stubShopify({ failOrdersAfter = Infinity, withOrders = true, emptyBefore = null, onOrders = null } = {}) {
  const original = globalThis.fetch;
  let orderCalls = 0;
  const windows = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = (() => {
      if (u.includes('/locations.json')) return { locations: [] };
      if (u.includes('/variants.json')) return { variants: [] };
      if (u.includes('/products.json')) return { products: [] };
      if (u.includes('/orders.json')) {
        orderCalls += 1;
        const min = new URL(u).searchParams.get('created_at_min').slice(0, 10);
        const max = new URL(u).searchParams.get('created_at_max').slice(0, 10);
        windows.push({ min, max });
        if (orderCalls > failOrdersAfter) throw new Error('Shopify 503 mid-import');
        if (onOrders) onOrders(u, orderCalls);
        if (!withOrders) return { orders: [] };
        // A window whose whole range sits at or before the cutoff answers
        // empty, which is what Shopify does for anything older than 60 days
        // on a token without read_all_orders: HTTP 200, no orders.
        if (emptyBefore && max <= emptyBefore) return { orders: [] };
        return { orders: [anOrder(max, orderCalls)] };
      }
      throw new Error(`stub: unexpected Shopify call ${u}`);
    })();
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  };
  return {
    restore: () => { globalThis.fetch = original; },
    orderCalls: () => orderCalls,
    windows: () => windows,
  };
}

/** Nine years of sales, one row a year, plus whatever a test adds. */
function seedSales(supabase, extra = []) {
  const days = ['2017-11-25', '2019-06-01', '2021-03-14', '2023-09-09', '2025-12-31', ...extra];
  for (const day of days) {
    supabase.from('sales_by_day').insert({
      company_entity_id: CO,
      shop_domain: SHOP,
      source: SOURCE,
      day_date: day,
      row_hash: `h-${day}`,
      total_orders: 1,
      net_sales: 100,
    });
  }
  return days;
}

const salesDays = (supabase) => supabase.rows('sales_by_day')
  .filter((r) => r.shop_domain === SHOP && r.source === SOURCE)
  .map((r) => r.day_date).sort();

const deleteSlices = (supabase) => supabase.calls.deletes
  .filter((d) => d.table === 'sales_by_day')
  .map((d) => ({
    from: d.filters.find((f) => f.op === 'gte' && f.col === 'day_date')?.val,
    to: d.filters.find((f) => f.op === 'lte' && f.col === 'day_date')?.val,
    sparesRefunds: d.filters.some((f) => f.op === 'neq' && f.col === 'total_orders' && f.val === 0),
  }));

test('a 60-day import deletes 60 days, not nine years', async () => {
  const supabase = createFakeSupabase();
  const seeded = seedSales(supabase, [daysAgo(10)]);
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, seedConnection(supabase, conn()), { batchId: 'b', historyDays: 60 });
    assert.equal(result.status, 'complete');

    const left = salesDays(supabase);
    assert.ok(left.includes('2017-11-25'), 'the oldest row in the shop is not the import\'s business');
    for (const day of seeded.filter((d) => d < daysAgo(60))) {
      assert.ok(left.includes(day), `${day} is outside the 60-day window and must survive`);
    }

    // Asserted on the delete filters, so a purge that deleted everything and
    // an import that happened to rewrite it would still fail.
    const slices = deleteSlices(supabase);
    assert.ok(slices.length > 0, 'the windows are still purged before being rebuilt');
    for (const slice of slices) {
      assert.ok(slice.from >= daysAgo(60), `a purge slice started at ${slice.from}, before the window start`);
      assert.ok(slice.to <= daysAgo(0), `a purge slice ran to ${slice.to}, past the window end`);
    }
  } finally {
    shopify.restore();
  }
});

// Cycle-1 P1. Purging the whole plan up front meant an import that died in its
// first window had already deleted every later window -- days it never
// fetched, and on a store without read_all_orders days it could never fetch.
test('an import that dies leaves BOTH older history and its unreached windows intact', async () => {
  const supabase = createFakeSupabase();
  // One row in each 60-day window of a 730-day plan, plus the nine-year rows.
  const inRange = [daysAgo(700), daysAgo(500), daysAgo(300), daysAgo(100)];
  const seeded = seedSales(supabase, inRange);
  const shopify = stubShopify({ failOrdersAfter: 1 });
  try {
    await assert.rejects(
      () => runWindowedHistory(supabase, seedConnection(supabase, conn()),
        { batchId: 'b', historyDays: 730, chunkDays: 60 }),
      /503/,
    );
    const left = salesDays(supabase);
    for (const day of seeded.filter((d) => d < daysAgo(730))) {
      assert.ok(left.includes(day), `${day} is outside the window and must survive a failed import`);
    }
    // Everything the import never reached is still here. A failed chunk is
    // retried with backoff and halved on the last attempts, so the count of
    // fetches says nothing: the newest window ATTEMPTED is the frontier.
    const reached = shopify.windows().reduce((max, w) => (w.max > max ? w.max : max), '');
    assert.ok(reached < daysAgo(600), `the import got further than expected (${reached})`);
    const unreached = inRange.filter((d) => d > reached);
    assert.ok(unreached.length >= 3, 'the plan has windows the import never reached');
    for (const day of unreached) {
      assert.ok(left.includes(day),
        `${day} belongs to a window the import never fetched and must survive`);
    }
  } finally {
    shopify.restore();
  }
});

// Cycle-1 P1. Without read_all_orders Shopify answers a 200 with no orders for
// anything older than 60 days. Deleting those days would be pure loss: nothing
// comes back to replace them.
// Cycle-2 P1. "Empty" means two different things, and the first version of
// this fix treated them alike. With read_all_orders an empty window is
// AUTHORITATIVE -- the last order in that period was deleted in Shopify, and
// keeping the old row overstates revenue for ever.
test('an empty window the token can fully read is still rebuilt', async () => {
  const supabase = createFakeSupabase();
  const stale = daysAgo(10);
  supabase.from('sales_by_day').insert({
    company_entity_id: CO, shop_domain: SHOP, source: SOURCE,
    day_date: stale, row_hash: 'an-order-since-deleted', total_orders: 2, net_sales: 200,
  });
  const shopify = stubShopify({ withOrders: false });
  try {
    await runWindowedHistory(supabase, seedConnection(supabase, conn()), {
      batchId: 'b', historyDays: 30, chunkDays: 30,
    });
    assert.deepEqual(salesDays(supabase), [],
      'Shopify says this period has no orders, and it can see the whole period');
  } finally {
    shopify.restore();
  }
});

// ...while a window BEYOND what the token can read is not evidence of
// anything. Without read_all_orders Shopify answers it with HTTP 200 and no
// orders, so deleting those days replaces real sales with nothing -- and the
// days cannot be refetched.
test('a window beyond what the token can read is never rebuilt, empty or not', async () => {
  const supabase = createFakeSupabase();
  const capped = conn({ scopes_granted: ['read_orders', 'read_products', 'read_locations'] });
  // A plan made while read_all_orders was granted, resumed after it was
  // revoked: the stored range reaches far past what the token can now read.
  capped.meta = {
    history_backfill: {
      status: 'running', target_days: 365, chunk_days: 60,
      range_start: daysAgo(365), range_end: daysAgo(0), cursor: daysAgo(365),
      windows_done: 0, windows_total: 7, orders_total: 0, sales_rows_total: 0,
    },
  };
  const old = [daysAgo(300), daysAgo(200), daysAgo(100)];
  const seeded = seedSales(supabase, old);
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, seedConnection(supabase, capped), {
      batchId: 'b', historyDays: 365, chunkDays: 60,
    });
    const left = salesDays(supabase);
    for (const day of seeded.filter((d) => d < daysAgo(59))) {
      assert.ok(left.includes(day),
        `${day} is beyond what the token can read — the window answering is not permission to delete it`);
    }
    const unreadable = result.chunks.filter((c) => c.not_purged);
    assert.ok(unreadable.length >= 4, 'the windows outside the readable range say why they kept their rows');
    for (const c of unreadable) assert.equal(c.purged_range, undefined);
  } finally {
    shopify.restore();
  }
});

// Cycle-1 P1. A refund row is dated by the REFUND, so an order created six
// months ago and refunded yesterday has its refund row inside a 60-day window
// while its parent order is outside the fetch. runHistoryChunk keeps refund
// rows regardless of window for exactly this reason; the purge has to agree.
test('a refund row inside the window survives, because nothing refetches its parent', async () => {
  const supabase = createFakeSupabase();
  supabase.from('sales_by_day').insert({
    company_entity_id: CO, shop_domain: SHOP, source: SOURCE,
    day_date: daysAgo(5), row_hash: 'refund-of-an-old-order', total_orders: 0, net_sales: -40,
  });
  supabase.from('sales_by_day').insert({
    company_entity_id: CO, shop_domain: SHOP, source: SOURCE,
    day_date: daysAgo(5), row_hash: 'an-ordinary-day', total_orders: 3, net_sales: 300,
  });
  const shopify = stubShopify();
  try {
    await runWindowedHistory(supabase, seedConnection(supabase, conn()), { batchId: 'b', historyDays: 30 });
    const left = supabase.rows('sales_by_day').map((r) => r.row_hash);
    assert.ok(left.includes('refund-of-an-old-order'),
      'a refund row in the window must survive: its parent order is not in the fetch');
    assert.ok(!left.includes('an-ordinary-day'), 'an ordinary in-window day is still rebuilt');
    for (const slice of deleteSlices(supabase)) {
      assert.equal(slice.sparesRefunds, true, 'every purge slice must spare total_orders = 0');
    }
  } finally {
    shopify.restore();
  }
});

// Cycle-1 P1. The UI offers "import the last 60 days anyway" when the store has
// no read_all_orders, and used to send the original 365/730 regardless.
test('a plan is clamped to what the token can read', async () => {
  // Shopify's cap is a timestamp, so the earliest calendar date of a 60-day
  // window is only partly answerable: a clamped plan takes the whole days.
  assert.deepEqual(effectiveHistoryDays({ scopes_granted: ['read_orders'] }, 730),
    { days: READABLE_WHOLE_DAYS, clamped: true, requested: 730 });
  assert.equal(READABLE_WHOLE_DAYS, NO_ALL_ORDERS_HISTORY_DAYS - 1);
  assert.deepEqual(effectiveHistoryDays({ scopes_granted: ALL_ORDERS }, 730),
    { days: 730, clamped: false });
  assert.deepEqual(effectiveHistoryDays({ scopes_granted: ['read_orders'] }, 30),
    { days: 30, clamped: false });
  // Scopes nobody has recorded yet are not evidence the scope is missing.
  assert.deepEqual(effectiveHistoryDays({ scopes_granted: [] }, 730), { days: 730, clamped: false });
  assert.deepEqual(effectiveHistoryDays({}, 730), { days: 730, clamped: false });

  const supabase = createFakeSupabase();
  const seeded = seedSales(supabase, [daysAgo(200)]);
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(
      supabase,
      seedConnection(supabase, conn({ scopes_granted: ['read_orders', 'read_products', 'read_locations'] })),
      { batchId: 'b', historyDays: 730, chunkDays: 60 },
    );
    assert.equal(result.history_days, READABLE_WHOLE_DAYS, 'the plan is the window the token can read');
    assert.equal(result.clamped_to, READABLE_WHOLE_DAYS);
    const left = salesDays(supabase);
    for (const day of seeded.filter((d) => d < daysAgo(READABLE_WHOLE_DAYS))) {
      assert.ok(left.includes(day), `${day} is beyond what the token can read and must survive`);
    }
  } finally {
    shopify.restore();
  }
});

test('readability is scopes plus the cap, and an unknown scope set is the capped case', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const all = { scopes_granted: ALL_ORDERS };
  const capped = { scopes_granted: ['read_orders'] };
  // read_all_orders reaches the whole history, so every window is readable.
  assert.equal(windowFullyReadable(all, '2017-11-25', now), true);
  // Without it, the readable range is the whole days inside the cap.
  assert.equal(windowFullyReadable(capped, '2026-08-16', now), true);
  assert.equal(windowFullyReadable(capped, '2026-08-15', now), true);
  assert.equal(windowFullyReadable(capped, '2026-08-14', now), false,
    'the earliest calendar date of a 60-day window is only partly answerable');
  assert.equal(windowFullyReadable(capped, '2025-01-01', now), false);
  // Scopes nobody recorded cannot establish readability.
  assert.equal(windowFullyReadable({}, '2025-01-01', now), false);
  assert.equal(windowFullyReadable({}, '2026-10-01', now), true);
});

test('a resume reports the plan that ran, not the one requested', async () => {
  const supabase = createFakeSupabase();
  seedSales(supabase);
  const running = conn();
  running.meta = {
    history_backfill: {
      status: 'running',
      target_days: 60,
      chunk_days: 30,
      range_start: daysAgo(60),
      range_end: daysAgo(0),
      cursor: daysAgo(0),
      windows_done: 2,
      windows_total: 2,
      orders_total: 0,
      sales_rows_total: 0,
    },
  };
  supabase.from('shopify_connections').insert({ id: running.id, meta: running.meta });
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, running, {
      batchId: 'b', historyDays: 730, chunkDays: 60,
    });
    assert.equal(result.history_days, 60, 'the stored 60-day plan is what actually ran');
    assert.equal(result.chunk_days, 30);
    assert.equal(result.requested_days, 730);
    assert.equal(result.plan_mismatch, true, 'the caller must be told its window was not applied');
    assert.equal(result.resumed, true);
    // The stored cursor is already at range_end, so there is no window left to
    // fetch -- and a resume with nothing to fetch must delete nothing.
    assert.equal(deleteSlices(supabase).length, 0, 'resuming a finished plan must delete nothing');
  } finally {
    shopify.restore();
  }
});

test('replan re-plans, and the new plan is what runs', async () => {
  const supabase = createFakeSupabase();
  const seeded = seedSales(supabase);
  const running = conn();
  running.meta = {
    history_backfill: {
      status: 'running', target_days: 60, chunk_days: 30,
      range_start: daysAgo(60), range_end: daysAgo(0), cursor: daysAgo(30),
      windows_done: 1, windows_total: 2, orders_total: 0, sales_rows_total: 0,
    },
  };
  supabase.from('shopify_connections').insert({ id: running.id, meta: running.meta });
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, running, {
      batchId: 'b', historyDays: 365, chunkDays: 60, replan: true,
    });
    assert.equal(result.history_days, 365);
    assert.equal(result.resumed, false);
    const left = salesDays(supabase);
    for (const day of seeded.filter((d) => d < daysAgo(365))) {
      assert.ok(left.includes(day), `${day} predates the new window and must survive a replan`);
    }
  } finally {
    shopify.restore();
  }
});

test('Cancel stops the import, and the next window does not undo it', async () => {
  const supabase = createFakeSupabase();
  seedSales(supabase);
  const c = conn();
  supabase.from('shopify_connections').insert({ id: c.id, meta: {} });
  // The UI's cancel action writes status 'cancelled' onto the row while the
  // import is between windows. Simulate it during the first window.
  const shopify = stubShopify({
    onOrders: (_u, call) => {
      if (call === 1) {
        const stored = supabase.tables.get('shopify_connections').find((r) => r.id === c.id);
        stored.meta = {
          ...stored.meta,
          history_backfill: { ...stored.meta.history_backfill, status: 'cancelled', cancelled_at: 'T' },
        };
      }
    },
  });
  try {
    const result = await runWindowedHistory(supabase, c, {
      batchId: 'b', historyDays: 365, chunkDays: 30,
    });
    assert.equal(result.status, 'cancelled', 'a cancelled import does not report complete');
    assert.ok(shopify.orderCalls() <= 2,
      `a cancelled import must stop fetching, not run all 13 windows (fetched ${shopify.orderCalls()})`);
    const stored = supabase.rows('shopify_connections').find((r) => r.id === c.id);
    assert.equal(stored.meta.history_backfill.status, 'cancelled',
      'the cancel must survive the loop, not be overwritten by the next window write');
  } finally {
    shopify.restore();
  }
});

// Cycle-2 P1. The re-read is how Cancel reaches a running import, so a
// re-read it cannot trust must stop the run rather than fall back to the meta
// the run opened with -- writing that stale object is the original bug. The
// stored cursor has not moved, so the next run repeats the window and the
// upsert is idempotent: the cost is time, not data.
test('an import that cannot re-read its own row stops instead of writing stale state', async () => {
  const supabase = createFakeSupabase();
  seedSales(supabase);
  const c = seedConnection(supabase, conn());
  const shopify = stubShopify({
    onOrders: (_u, call) => {
      // The row becomes unreadable while the first window is fetching.
      if (call === 1) supabase.tables.set('shopify_connections', []);
    },
  });
  try {
    await assert.rejects(
      () => runWindowedHistory(supabase, c, { batchId: 'b', historyDays: 90, chunkDays: 30 }),
      /disappeared mid-import|Could not re-read/,
    );
  } finally {
    shopify.restore();
  }
});

test('the purge never crosses into another shop, source, or past the window it owns', async () => {
  const supabase = createFakeSupabase();
  const inWindow = daysAgo(5);
  for (const row of [
    { shop_domain: 'other.myshopify.com', source: SOURCE, day_date: inWindow, row_hash: 'o1' },
    { shop_domain: SHOP, source: 'quickbooks', day_date: inWindow, row_hash: 'q1' },
    { shop_domain: SHOP, source: SOURCE, day_date: inWindow, row_hash: 's1' },
    // Both ends are bounds. A row dated after the plan's end (the old code
    // swept to today + 2 regardless) is as outside it as the nine-year-old one.
    { shop_domain: SHOP, source: SOURCE, day_date: daysAgo(-2), row_hash: 'f1' },
  ]) {
    supabase.from('sales_by_day').insert({ company_entity_id: CO, total_orders: 1, ...row });
  }
  const shopify = stubShopify();
  try {
    await runWindowedHistory(supabase, seedConnection(supabase, conn()), { batchId: 'b', historyDays: 30 });
    const left = supabase.rows('sales_by_day').map((r) => r.row_hash).sort();
    assert.deepEqual(left, ['f1', 'o1', 'q1'],
      'only this shop\'s shopify_api rows inside the window are rebuilt');
  } finally {
    shopify.restore();
  }
});

// A non-final window owns up to the day BEFORE its end: the boundary date is
// completed by the next window, which over-fetches a day to do it. Purging
// through window_end would delete a day this window does not rewrite.
test('a non-final window purges up to the day before its end', async () => {
  const supabase = createFakeSupabase();
  // A purge with nothing to delete reports nothing, so give every window a day.
  seedSales(supabase, [daysAgo(75), daysAgo(45), daysAgo(15)]);
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, seedConnection(supabase, conn()), {
      batchId: 'b', historyDays: 90, chunkDays: 30,
    });
    const chunks = result.chunks.filter((c) => c.purged_range);
    assert.ok(chunks.length >= 2, 'a 90-day plan in 30-day chunks purges more than one window');
    for (const c of chunks.slice(0, -1)) {
      assert.ok(c.purged_range.to < c.window_end,
        `a non-final window purged through ${c.purged_range.to}, its own end`);
    }
    const last = chunks[chunks.length - 1];
    assert.equal(last.purged_range.to, last.window_end, 'the final window owns its end date');
  } finally {
    shopify.restore();
  }
});

test('an unbounded purge is still available, and is still unbounded', async () => {
  // Nothing in the import path may call it this way, but the function keeps
  // the no-range behaviour for a caller that genuinely means every row --
  // so the bound is a decision the caller makes, visible at the call site.
  const supabase = createFakeSupabase();
  seedSales(supabase);
  const purged = await purgeShopifySalesForShop(supabase, CO, SHOP);
  assert.equal(purged.from, '2017-11-25');
  assert.deepEqual(salesDays(supabase), []);
  assert.equal(await purgeShopifySalesForShop(supabase, CO, SHOP), null,
    'purging a shop with no rows reports nothing deleted');
});
