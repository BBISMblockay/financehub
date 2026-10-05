// Shopify order paid date (20261005130000): settledPaidAt(), the lookup
// fetchOrderPaidDates() and its wiring through upsertOrderFacts(), which the
// nightly sync, the history import and shopify-orders-backfill.mjs all use.
//
// The two real orders are copied from Shopify (baseballism.myshopify.com,
// read 2026-10-05), in the REST transactions shape the sync receives:
//   #1606165  one SALE of the full 348.15, processed 2026-10-05T16:57:14Z,
//             with payment_terms_completed_at blank.
//   #1586119  two SALEs on Aug 31 (461.16 + 15.68 = 476.84, the order total)
//             and a 36.35 REFUND on Sep 8. Paid when the second sale landed;
//             the refund never moves the paid date.
//
// Database checks (the migration against PGlite) run when
// scripts/tests/finance-db has been installed: npm ci --prefix scripts/tests/finance-db
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  settledPaidAt, orderNeedsPaidDate, fetchOrderPaidDates, ordersToOrderRows, upsertOrderFacts,
  addPaidDatesTally, PAID_DATE_KEYS,
} from '../lib/shopify-sync-core.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const ORDER_1606165 = {
  id: 7047075397702, name: '#1606165', source_name: 'shopify_draft_order', financial_status: 'paid',
  total_price: '348.15', created_at: '2026-09-30T18:00:00Z', payment_terms: { payment_schedules: [] },
};
const TX_1606165 = [
  { kind: 'sale', status: 'success', amount: '348.15', processed_at: '2026-10-05T16:57:14Z' },
];
const ORDER_1586119 = {
  id: 6635382734918, name: '#1586119', source_name: 'shopify_draft_order', financial_status: 'partially_refunded',
  total_price: '476.84', created_at: '2026-08-20T18:00:00Z', payment_terms: { payment_schedules: [] },
};
const TX_1586119 = [
  { kind: 'sale', status: 'success', amount: '461.16', processed_at: '2026-08-31T17:43:22Z' },
  { kind: 'sale', status: 'success', amount: '15.68', processed_at: '2026-08-31T17:43:59Z' },
  { kind: 'refund', status: 'success', amount: '36.35', processed_at: '2026-09-08T21:10:31Z' },
];

await test('#1606165: paid when its one successful sale was processed', () => {
  assert.equal(settledPaidAt(ORDER_1606165, TX_1606165), '2026-10-05T16:57:14Z');
});

await test('#1586119: paid when the second Aug 31 sale reached the total; the Sep 8 refund is not a payment', () => {
  assert.equal(settledPaidAt(ORDER_1586119, TX_1586119), '2026-08-31T17:43:59Z');
  // Order of arrival does not matter: transactions are sorted by time.
  assert.equal(settledPaidAt(ORDER_1586119, [...TX_1586119].reverse()), '2026-08-31T17:43:59Z');
});

await test('failed payments, authorizations and voids are not payments; a capture is', () => {
  const tx = [
    { kind: 'sale', status: 'failure', amount: '348.15', processed_at: '2026-10-01T00:00:00Z' },
    { kind: 'authorization', status: 'success', amount: '348.15', processed_at: '2026-10-02T00:00:00Z' },
    { kind: 'void', status: 'success', amount: '348.15', processed_at: '2026-10-02T01:00:00Z' },
    { kind: 'capture', status: 'success', amount: '348.15', processed_at: '2026-10-03T00:00:00Z' },
  ];
  assert.equal(settledPaidAt(ORDER_1606165, tx), '2026-10-03T00:00:00Z');
  assert.equal(settledPaidAt(ORDER_1606165, tx.slice(0, 3)), null, 'no successful sale or capture');
});

await test('an order Shopify does not call settled has no paid date, whatever its transactions', () => {
  for (const financial_status of ['pending', 'partially_paid', 'authorized', 'voided', undefined]) {
    assert.equal(settledPaidAt({ ...ORDER_1606165, financial_status }, TX_1606165), null, financial_status);
  }
  assert.equal(settledPaidAt({ ...ORDER_1606165, financial_status: 'refunded' }, TX_1606165), '2026-10-05T16:57:14Z');
});

await test('settled when the total was reached, not at a later extra payment', () => {
  const tx = [...TX_1606165, { kind: 'sale', status: 'success', amount: '5.00', processed_at: '2026-10-07T12:00:00Z' }];
  assert.equal(settledPaidAt(ORDER_1606165, tx), '2026-10-05T16:57:14Z');
});

await test('payments that never reach the total (order edited down) settle at the last payment', () => {
  const edited = { ...ORDER_1606165, total_price: '500.00' };
  const tx = [
    { kind: 'sale', status: 'success', amount: '100.00', processed_at: '2026-10-01T00:00:00Z' },
    { kind: 'sale', status: 'success', amount: '248.15', processed_at: '2026-10-04T00:00:00Z' },
  ];
  assert.equal(settledPaidAt(edited, tx), '2026-10-04T00:00:00Z');
});

await test('only draft orders and orders with payment terms are looked up', () => {
  assert.equal(orderNeedsPaidDate(ORDER_1606165), true);
  assert.equal(orderNeedsPaidDate({ source_name: 'shopify_draft_order', payment_terms: null }), true);
  assert.equal(orderNeedsPaidDate({ source_name: 'web', payment_terms: { payment_schedules: [] } }), true);
  assert.equal(orderNeedsPaidDate({ source_name: 'web', payment_terms: null }), false, 'checkout order');
  assert.equal(orderNeedsPaidDate({ source_name: 'pos' }), false, 'terms not returned, not a draft');
  assert.equal(orderNeedsPaidDate({ ...ORDER_1606165, test: true }), false, 'test order');
});

// ── fetchOrderPaidDates against a stand-in Shopify ─────────────────────────
const BASE = 'https://baseballism.myshopify.com/admin/api/2025-01';
const realFetch = globalThis.fetch;
function stubShopify(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ transactions: route.body }), {
      status: route.status || 200, headers: route.link ? { link: route.link } : {},
    });
  };
  return calls;
}
const txUrl = (id) => `${BASE}/orders/${id}/transactions.json?limit=250`;

await test('lookup: settled orders cost one call each; pending and checkout orders cost none', async () => {
  const calls = stubShopify({
    [txUrl(7047075397702)]: { body: TX_1606165 },
    [txUrl(6635382734918)]: { body: TX_1586119 },
  });
  const pending = { ...ORDER_1606165, id: 1, financial_status: 'pending' };
  const checkout = { id: 2, source_name: 'web', payment_terms: null, financial_status: 'paid', total_price: '10' };
  const { paid, stats } = await fetchOrderPaidDates({}, BASE, [ORDER_1606165, ORDER_1586119, pending, checkout],
    { checkedAt: '2026-10-05T23:00:00Z' });
  globalThis.fetch = realFetch;
  assert.deepEqual(calls, [txUrl(7047075397702), txUrl(6635382734918)]);
  assert.deepEqual(paid.get('7047075397702'), { paid_at: '2026-10-05T16:57:14Z', paid_at_checked_at: '2026-10-05T23:00:00Z' });
  assert.deepEqual(paid.get('6635382734918'), { paid_at: '2026-08-31T17:43:59Z', paid_at_checked_at: '2026-10-05T23:00:00Z' });
  assert.deepEqual(paid.get('1'), { paid_at: null, paid_at_checked_at: '2026-10-05T23:00:00Z' }, 'pending: checked, not settled');
  assert.equal(paid.has('2'), false, 'checkout order is not looked up');
  assert.deepEqual(stats, { candidates: 3, not_settled: 1, looked_up: 2, settled: 2, no_payment_found: 0, failed: 0 });
});

await test('lookup follows pagination: a payment on page 2 still counts', async () => {
  const page2 = `${BASE}/orders/6635382734918/transactions.json?page_info=abc`;
  stubShopify({
    [txUrl(6635382734918)]: { body: TX_1586119.slice(0, 1), link: `<${page2}>; rel="next"` },
    [page2]: { body: TX_1586119.slice(1) },
  });
  const { paid } = await fetchOrderPaidDates({}, BASE, [ORDER_1586119], { checkedAt: 'c' });
  globalThis.fetch = realFetch;
  assert.equal(paid.get('6635382734918').paid_at, '2026-08-31T17:43:59Z');
});

await test('a failed lookup is counted and left OUT, so the stored paid_at is not overwritten', async () => {
  stubShopify({
    [txUrl(7047075397702)]: { body: [], status: 500 },
    [txUrl(6635382734918)]: { body: TX_1586119 },
  });
  const { paid, stats } = await fetchOrderPaidDates({}, BASE, [ORDER_1606165, ORDER_1586119], { checkedAt: 'c' });
  globalThis.fetch = realFetch;
  assert.equal(paid.has('7047075397702'), false);
  assert.equal(paid.get('6635382734918').paid_at, '2026-08-31T17:43:59Z', 'one failure does not stop the rest');
  assert.equal(stats.failed, 1);
});

// ── upsertOrderFacts wiring ────────────────────────────────────────────────
const connection = { id: 'conn', company_entity_id: 'co', shop_domain: 'baseballism.myshopify.com' };

await test('rows not looked up carry NO paid keys; looked-up rows carry both', () => {
  const paid = new Map([['7047075397702', { paid_at: '2026-10-05T16:57:14Z', paid_at_checked_at: 'c' }]]);
  const { orderRows } = ordersToOrderRows({
    orders: [ORDER_1606165, { id: 9, source_name: 'web', financial_status: 'paid' }],
    connection, skuMeta: new Map(), syncedAt: 's', batchId: 'b', paidDates: paid,
  });
  assert.equal(orderRows[0].paid_at, '2026-10-05T16:57:14Z');
  assert.ok(PAID_DATE_KEYS.every((k) => !(k in orderRows[1])), 'absent, not null');
});

function fakeSupabase(onUpsert) {
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  return { from: (table) => ({ delete: () => chain, upsert: (rows) => Promise.resolve(onUpsert(table, rows) || { error: null }) }) };
}

await test('upsertOrderFacts never sends a mixed batch: a paid-less row would be written as paid_at NULL', async () => {
  stubShopify({ [txUrl(7047075397702)]: { body: TX_1606165 } });
  const batches = [];
  const supabase = fakeSupabase((table, rows) => { if (table === 'shopify_orders') batches.push(rows); });
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [ORDER_1606165, { id: 9, source_name: 'web', financial_status: 'paid' }, { id: 10, source_name: 'pos' }],
    skuMeta: new Map(), syncedAt: '2026-10-05T23:00:00Z', batchId: 'b', shopify: { headers: {}, base: BASE },
  });
  globalThis.fetch = realFetch;
  assert.equal(r.orders_upserted, 3);
  for (const rows of batches) {
    const shapes = new Set(rows.map((row) => Object.keys(row).sort().join(',')));
    assert.equal(shapes.size, 1, 'one key set per upsert request');
  }
  const all = batches.flat();
  assert.equal(all.find((x) => x.order_id === '7047075397702').paid_at, '2026-10-05T16:57:14Z');
  assert.ok(!('paid_at' in all.find((x) => x.order_id === '9')));
  assert.equal(r.paid_dates.settled, 1);
});

await test('without Shopify credentials (on-demand copy, tests) paid_at is simply not written', async () => {
  const rows = [];
  const supabase = fakeSupabase((table, r) => { if (table === 'shopify_orders') rows.push(...r); });
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [ORDER_1606165], skuMeta: new Map(), syncedAt: 's', batchId: 'b' });
  assert.ok(!('paid_at' in rows[0]));
  assert.equal('paid_dates' in r, false);
});

await test('a database without the paid_at columns keeps syncing orders, and says why', async () => {
  stubShopify({ [txUrl(7047075397702)]: { body: TX_1606165 } });
  const written = [];
  const supabase = fakeSupabase((table, rows) => {
    if (table !== 'shopify_orders') return null;
    if (rows.some((x) => 'paid_at' in x)) {
      return { error: { message: "Could not find the 'paid_at' column of 'shopify_orders' in the schema cache" } };
    }
    written.push(...rows);
    return null;
  });
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [ORDER_1606165], skuMeta: new Map(), syncedAt: 's', batchId: 'b', shopify: { headers: {}, base: BASE } });
  globalThis.fetch = realFetch;
  assert.equal(written.length, 1);
  assert.equal(written[0].payment_terms_status, 'present', 'terms still written');
  assert.equal(r.paid_dates, null);
  assert.match(r.paid_dates_skipped, /20261005130000/);
});

await test('tallies add up across windows', () => {
  let t = addPaidDatesTally(null, null);
  assert.equal(t, null);
  t = addPaidDatesTally(t, { candidates: 2, not_settled: 1, looked_up: 1, settled: 1, no_payment_found: 0, failed: 0 });
  t = addPaidDatesTally(t, { candidates: 1, failed: 1 });
  assert.deepEqual(t, { candidates: 3, not_settled: 1, looked_up: 1, settled: 1, no_payment_found: 0, failed: 1 });
});

// ── The migration against real PostgreSQL ──────────────────────────────────
const pglitePath = new URL('./finance-db/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url);
if (!existsSync(pglitePath)) {
  console.log('# skip: database checks (npm ci --prefix scripts/tests/finance-db)');
} else {
  const { PGlite } = await import(pglitePath.href);
  const db = new PGlite();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  await db.exec(`
    create table public.shopify_orders (
      id bigserial primary key, company_entity_id uuid, connection_id uuid, shop_domain text, order_id text,
      order_number text, source_name text, financial_status text, fulfillment_status text,
      cancelled_at timestamptz, cancel_reason text, customer_id text, customer_email text, customer_name text,
      currency text, subtotal_price numeric, total_discounts numeric, total_tax numeric, total_shipping numeric,
      total_price numeric, tags text, location_id text, line_item_count integer,
      shopify_created_at timestamptz, shopify_processed_at timestamptz, shopify_updated_at timestamptz,
      synced_at timestamptz, sync_batch_id text, created_at timestamptz default now(),
      unique (shop_domain, order_id));
    create table public.shopify_channel_map (company_entity_id uuid, source_name text, display_name text);
    create view public.shopify_orders_v with (security_invoker = true) as select o.id from public.shopify_orders o;
    create function public.silo_business_today() returns date language sql stable as $$ select date '2026-10-05' $$;
    create function public.silo_business_timezone() returns text language sql stable as $$ select 'America/Los_Angeles' $$;
    create table public.silo_chat_schema_catalog (relname text primary key, description text);
    insert into public.silo_chat_schema_catalog values ('shopify_orders', 'One row per Shopify order.'), ('shopify_orders_v', null);
    create function public.refresh_chat_schema_catalog() returns void language plpgsql as $$ begin end $$;
  `);
  // Production's state: the terms migration applied (it replaces the view).
  await db.exec('drop view public.shopify_orders_v;');
  await db.exec(await readFile(new URL('../../supabase/migrations/20260930150000_shopify_order_payment_terms.sql', import.meta.url), 'utf8'));
  const before = (await q(`select column_name from information_schema.columns where table_schema='public'
    and table_name='shopify_orders_v' order by ordinal_position`)).map((r) => r.column_name);
  const sql = await readFile(new URL('../../supabase/migrations/20261005130000_shopify_order_paid_at.sql', import.meta.url), 'utf8');

  await test('db: the migration applies, and applies again', async () => { await db.exec(sql); await db.exec(sql); });

  await test('db: every existing view column stays in place; paid_at columns come last', async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_schema='public'
      and table_name='shopify_orders_v' order by ordinal_position`)).map((r) => r.column_name);
    assert.deepEqual(cols.slice(0, before.length), before);
    assert.deepEqual(cols.slice(before.length), ['paid_at', 'paid_at_checked_at']);
  });

  await test('db: the view stays security_invoker', async () => {
    const [r] = await q(`select reloptions from pg_class where oid = 'public.shopify_orders_v'::regclass`);
    assert.ok((r.reloptions || []).includes('security_invoker=true'));
  });

  await test('db: the view carries paid_at through, and the catalog note is appended once', async () => {
    await q(`insert into public.shopify_orders (shop_domain, order_id, financial_status, paid_at, paid_at_checked_at)
      values ('s', '6635382734918', 'partially_refunded', '2026-08-31T17:43:59Z', '2026-10-05T23:00:00Z')`);
    const [r] = await q(`select paid_at, paid_at_checked_at from public.shopify_orders_v where order_id = '6635382734918'`);
    assert.equal(new Date(r.paid_at).toISOString(), '2026-08-31T17:43:59.000Z');
    const [c] = await q(`select description from public.silo_chat_schema_catalog where relname = 'shopify_orders'`);
    assert.equal(c.description.split('Paid date (20261005130000)').length - 1, 1);
  });
}

console.log(`\nshopify-order-paid-at: ${passed} passed`);
