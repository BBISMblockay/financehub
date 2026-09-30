// Shopify order payment terms (20260930150000): orderPaymentTerms() and its
// wiring into ordersToOrderRows(), the builder the nightly sync and
// shopify-orders-backfill.mjs both write shopify_orders through.
//
// The rule that matters most: "not returned" and "no terms" are different
// facts. Shopify only sends payment_terms to an app holding
// read_payment_terms, so a missing key must stay NULL, never become 'none'.
import assert from 'node:assert/strict';
import {
  orderPaymentTerms, ordersToOrderRows, addPaymentTermsTally, upsertOrderFacts,
} from '../lib/shopify-sync-core.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

// Shape from Shopify's documented REST payload (payment_terms/create webhook
// and the Order resource): a Net 30 draft order, one schedule, unpaid.
const NET30 = {
  id: 706405506930370084, payment_terms_name: 'Net 30', payment_terms_type: 'net', due_in_days: 30,
  payment_schedules: [{ id: 1, issued_at: '2026-09-17T10:00:00-07:00', due_at: '2026-10-17T10:00:00-07:00',
    completed_at: null, amount: '2062.12', outstanding_balance: '2062.12' }],
};

await test('terms present: name, type, days, due date; nothing completed', () => {
  const t = orderPaymentTerms({ payment_terms: NET30, total_outstanding: '2062.12' });
  assert.deepEqual(t, {
    payment_terms_status: 'present', payment_terms_name: 'Net 30', payment_terms_type: 'net',
    payment_due_in_days: 30, payment_due_at: '2026-10-17T10:00:00-07:00', payment_terms_completed_at: null,
    total_outstanding: 2062.12,
  });
});

await test('payment_terms: null is "none" -- Shopify said the order has no terms', () => {
  const t = orderPaymentTerms({ payment_terms: null, total_outstanding: '0.00' });
  assert.equal(t.payment_terms_status, 'none');
  assert.equal(t.payment_due_at, null);
  assert.equal(t.total_outstanding, 0);
});

await test('payment_terms key ABSENT is NULL (not returned), never "none"', () => {
  const t = orderPaymentTerms({ total_price: '10.00' });
  assert.equal(t.payment_terms_status, null);
  assert.equal(t.payment_terms_name, null);
  assert.equal(t.total_outstanding, null, 'no total_outstanding key -> unknown, not 0');
});

await test('several schedules: the earliest OPEN one is the due date', () => {
  const t = orderPaymentTerms({ payment_terms: { ...NET30, payment_terms_type: 'fixed', payment_schedules: [
    { due_at: '2026-09-01T00:00:00Z', completed_at: '2026-08-30T00:00:00Z' },
    { due_at: '2026-11-01T00:00:00Z', completed_at: null },
    { due_at: '2026-10-01T00:00:00Z', completed_at: null },
  ] } });
  assert.equal(t.payment_due_at, '2026-10-01T00:00:00Z');
  assert.equal(t.payment_terms_completed_at, null, 'something is still owed');
});

await test('all schedules complete: due date is the last one, completed_at the latest completion', () => {
  const t = orderPaymentTerms({ payment_terms: { ...NET30, payment_schedules: [
    { due_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-05T00:00:00Z' },
    { due_at: '2026-10-01T00:00:00Z', completed_at: '2026-09-20T00:00:00Z' },
  ] } });
  assert.equal(t.payment_due_at, '2026-10-01T00:00:00Z');
  assert.equal(t.payment_terms_completed_at, '2026-09-20T00:00:00Z');
});

await test('terms with no schedules: present, but no due date and not completed', () => {
  const t = orderPaymentTerms({ payment_terms: { payment_terms_name: 'Due on receipt', payment_terms_type: 'receipt', payment_schedules: [] } });
  assert.equal(t.payment_terms_status, 'present');
  assert.equal(t.payment_due_at, null);
  assert.equal(t.payment_terms_completed_at, null);
  assert.equal(t.payment_due_in_days, null);
});

await test('junk values are unknown, never guessed', () => {
  const t = orderPaymentTerms({ total_outstanding: 'n/a', payment_terms: {
    payment_terms_name: '  ', due_in_days: '30', payment_schedules: [null, { due_at: 'not a date' }, 'x'] } });
  assert.equal(t.payment_terms_name, null);
  assert.equal(t.payment_due_in_days, null, 'a string is not an integer day count');
  assert.equal(t.payment_due_at, null);
  assert.equal(t.total_outstanding, null);
});

await test('non-objects do not throw', () => {
  for (const v of [null, undefined, 'x', 3]) assert.equal(orderPaymentTerms(v).payment_terms_status, null);
});

const connection = { id: 'conn-1', company_entity_id: 'co-1', shop_domain: 'baseballism.myshopify.com' };
const baseOrder = (o) => ({ id: 1, name: '#1', created_at: '2026-09-17T10:00:00Z', line_items: [], total_price: '100.00', ...o });

await test('ordersToOrderRows writes the terms onto every order row', () => {
  const { orderRows } = ordersToOrderRows({
    orders: [
      baseOrder({ id: 1, payment_terms: NET30, total_outstanding: '2062.12', tags: 'Daniel Gottsch, Wholesale' }),
      baseOrder({ id: 2, payment_terms: null, total_outstanding: '0.00' }),
      baseOrder({ id: 3 }),
    ],
    connection, skuMeta: new Map(), syncedAt: '2026-09-30T00:00:00Z', batchId: 'b',
  });
  assert.deepEqual(orderRows.map((r) => r.payment_terms_status), ['present', 'none', null]);
  assert.equal(orderRows[0].payment_due_at, '2026-10-17T10:00:00-07:00');
  assert.equal(orderRows[0].total_outstanding, 2062.12);
  assert.equal(orderRows[0].tags, 'Daniel Gottsch, Wholesale', 'existing columns untouched');
});

await test('every order row carries every terms key, so one upsert batch has one shape', () => {
  const { orderRows } = ordersToOrderRows({
    orders: [baseOrder({ id: 1, payment_terms: NET30 }), baseOrder({ id: 2 })],
    connection, skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  const keys = orderRows.map((r) => Object.keys(r).sort().join(','));
  assert.equal(new Set(keys).size, 1);
  for (const k of ['payment_terms_status', 'payment_terms_name', 'payment_terms_type', 'payment_due_in_days',
    'payment_due_at', 'payment_terms_completed_at', 'total_outstanding']) assert.ok(k in orderRows[1], k);
});

await test('tallies add up across batches', () => {
  let t = addPaymentTermsTally(null, null);
  t = addPaymentTermsTally(t, { present: 2, none: 5, not_returned: 0 });
  t = addPaymentTermsTally(t, { present: 1, not_returned: 3 });
  assert.deepEqual(t, { present: 3, none: 5, not_returned: 3 });
});

await test('upsertOrderFacts writes the terms to shopify_orders and reports the tally it wrote', async () => {
  const written = {};
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  const supabase = { from: (table) => ({
    delete: () => chain,
    upsert: (rows) => { (written[table] ||= []).push(...rows); return Promise.resolve({ error: null }); },
  }) };
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [baseOrder({ id: 1, payment_terms: NET30 }), baseOrder({ id: 2, payment_terms: null }),
      baseOrder({ id: 3 }), baseOrder({ id: 4 })],
    skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  assert.deepEqual(r.payment_terms, { present: 1, none: 1, not_returned: 2 });
  assert.deepEqual(written.shopify_orders.map((o) => o.payment_terms_status), ['present', 'none', null, null]);
});

await test('a database without the terms columns does NOT stop the order sync: rows are rewritten without them', async () => {
  const written = [];
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  const supabase = { from: (table) => ({
    delete: () => chain,
    upsert: (rows) => {
      if (table === 'shopify_orders' && rows.some((r) => 'payment_terms_status' in r)) {
        return Promise.resolve({ error: { message: "Could not find the 'payment_due_at' column of 'shopify_orders' in the schema cache" } });
      }
      if (table === 'shopify_orders') written.push(...rows);
      return Promise.resolve({ error: null });
    },
  }) };
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [baseOrder({ id: 1, payment_terms: NET30 }), baseOrder({ id: 2 })], skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  assert.equal(r.orders_upserted, 2);
  assert.equal(written.length, 2, 'the orders were still written');
  assert.ok(written.every((w) => !('payment_terms_status' in w) && !('total_outstanding' in w)));
  assert.equal(r.payment_terms, null, 'no tally claimed for terms that were not stored');
  assert.match(r.payment_terms_skipped, /20260930150000/);
});

await test('any OTHER upsert failure still fails the sync -- even one only terms rows cause', async () => {
  // Not a missing column: a real terms bug (a bad status value) must surface,
  // never be hidden by quietly rewriting the rows without their terms.
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  const supabase = { from: () => ({ delete: () => chain,
    upsert: (rows) => Promise.resolve({ error: rows.some((r) => 'payment_terms_status' in r)
      ? { message: 'new row for relation "shopify_orders" violates check constraint "shopify_orders_payment_terms_status_check"' }
      : null }) }) };
  await assert.rejects(() => upsertOrderFacts(supabase, connection, {
    orders: [baseOrder({ id: 1 })], skuMeta: new Map(), syncedAt: 'x', batchId: 'b' }), /shopify_orders upsert failed/);
});

console.log(`\nshopify-order-terms: ${passed} passed`);
