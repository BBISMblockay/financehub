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
import { runWindowedHistory, purgeShopifySalesForShop } from '../lib/shopify-sync-core.mjs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const CO = 'co-1';
const SHOP = 'baseballism.myshopify.com';
const SOURCE = 'shopify_api';

const conn = () => ({
  id: 'c-1',
  company_entity_id: CO,
  shop_domain: SHOP,
  shop_name: 'Baseballism',
  api_version: '2024-10',
  access_token: 'tok',
  // runWindowedHistory gates on scopes before it touches anything.
  scopes_granted: ['read_orders', 'read_products', 'read_locations', 'read_inventory'],
  meta: {},
});

/** Shopify with no orders in any window: the import writes nothing, so every
 *  row still in sales_by_day afterwards is a row the PURGE spared. That is the
 *  property under test, and real orders would only mask it. */
function stubShopify({ failOrdersAfter = Infinity, onOrders = null } = {}) {
  const original = globalThis.fetch;
  let orderCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = (() => {
      if (u.includes('/locations.json')) return { locations: [] };
      if (u.includes('/variants.json')) return { variants: [] };
      if (u.includes('/products.json')) return { products: [] };
      if (u.includes('/orders.json')) {
        orderCalls += 1;
        if (orderCalls > failOrdersAfter) throw new Error('Shopify 503 mid-import');
        if (onOrders) onOrders(u, orderCalls);
        return { orders: [] };
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
  };
}

/** Nine years of sales, one row a year, plus one inside any recent window. */
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

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));

test('a 60-day import deletes 60 days, not nine years', async () => {
  const supabase = createFakeSupabase();
  const seeded = seedSales(supabase, [daysAgo(10)]);
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, conn(), { batchId: 'b', historyDays: 60 });
    assert.equal(result.status, 'complete');

    const left = salesDays(supabase);
    // Everything older than the window survives; only the in-window row went.
    assert.deepEqual(left, seeded.filter((d) => d < daysAgo(60)).sort(),
      'rows outside the 60-day window must survive a 60-day import');
    assert.ok(left.includes('2017-11-25'), 'the oldest row in the shop is not the import\'s business');

    // And the delete itself was bounded -- asserted on the filters, so a purge
    // that deleted everything and an import that rewrote it would still fail.
    const deletes = supabase.calls.deletes.filter((d) => d.table === 'sales_by_day');
    assert.ok(deletes.length > 0, 'the window is still purged before being rebuilt');
    for (const d of deletes) {
      const from = d.filters.find((f) => f.op === 'gte' && f.col === 'day_date')?.val;
      assert.ok(from >= result.purged_range.from,
        `a purge slice started at ${from}, before the window start ${result.purged_range.from}`);
    }
    assert.equal(result.purged_range.from, daysAgo(60));
  } finally {
    shopify.restore();
  }
});

test('an import that dies mid-window leaves the older history intact', async () => {
  const supabase = createFakeSupabase();
  const seeded = seedSales(supabase);
  // 730 days in 60-day chunks: fail on the second window, the shape of the
  // real 3.5h import that died at 95%.
  const shopify = stubShopify({ failOrdersAfter: 1 });
  try {
    await assert.rejects(
      () => runWindowedHistory(supabase, conn(), { batchId: 'b', historyDays: 730, chunkDays: 60 }),
      /503/,
    );
    const left = salesDays(supabase);
    for (const day of seeded.filter((d) => d < daysAgo(730))) {
      assert.ok(left.includes(day), `${day} is outside the window and must survive a failed import`);
    }
  } finally {
    shopify.restore();
  }
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
      cursor: daysAgo(30),
      windows_done: 1,
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
    // A resume must not purge: the windows already imported are not re-fetched.
    assert.equal(supabase.calls.deletes.filter((d) => d.table === 'sales_by_day').length, 0,
      'resuming an import must delete nothing');
  } finally {
    shopify.restore();
  }
});

test('replan re-plans, and purges only the new window', async () => {
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
    assert.equal(result.purged_range.from, daysAgo(365));
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
  // import is between windows. Simulate it after the first window.
  const shopify = stubShopify({
    onOrders: (_u, call) => {
      if (call === 1) {
        const row = supabase.rows('shopify_connections').find((r) => r.id === c.id);
        const stored = supabase.tables.get('shopify_connections').find((r) => r.id === c.id);
        stored.meta = {
          ...row.meta,
          history_backfill: { ...row.meta.history_backfill, status: 'cancelled', cancelled_at: 'T' },
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

test('the purge never crosses into another shop, source, or past the window end', async () => {
  const supabase = createFakeSupabase();
  const inWindow = daysAgo(5);
  for (const row of [
    { shop_domain: 'other.myshopify.com', source: SOURCE, day_date: inWindow, row_hash: 'o1' },
    { shop_domain: SHOP, source: 'quickbooks', day_date: inWindow, row_hash: 'q1' },
    { shop_domain: SHOP, source: SOURCE, day_date: inWindow, row_hash: 's1' },
    // Both ends of the window are bounds. A row dated after range_end (the
    // old code swept to today + 2 regardless) is as much outside the window
    // as the nine-year-old one is.
    { shop_domain: SHOP, source: SOURCE, day_date: daysAgo(-2), row_hash: 'f1' },
  ]) {
    supabase.from('sales_by_day').insert({ company_entity_id: CO, total_orders: 1, ...row });
  }
  const shopify = stubShopify();
  try {
    const result = await runWindowedHistory(supabase, conn(), { batchId: 'b', historyDays: 30 });
    assert.equal(result.purged_range.to, daysAgo(0), 'the purge ends where the window ends');
    const left = supabase.rows('sales_by_day').map((r) => r.row_hash).sort();
    assert.deepEqual(left, ['f1', 'o1', 'q1'],
      'only this shop\'s shopify_api rows inside the window are rebuilt');
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
