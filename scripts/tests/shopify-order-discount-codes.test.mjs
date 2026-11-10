// Order-level discount codes and refunded subtotal (20261110083000):
// orderDiscountCodes(), orderRefundedSubtotal() and their wiring into
// upsertOrderFacts(), which the nightly sync and shopify-orders-backfill.mjs
// both write shopify_orders through. Affiliate Studio commissions on these.
//
// The rules that matter:
//   * NULL means NOT MEASURED. A payload with no discount_codes key, or no
//     refunds array, must store NULL -- never [] or 0, which would claim a
//     measurement nobody took (and, for refunds, pay commission on money that
//     came back).
//   * Codes are folded to upper case, because Shopify matches them
//     case-insensitively; two spellings are one code.
//   * A database that has not applied the migration must not stop the order
//     sync, and the two columns are stripped as a PAIR.
//
// Mutations (CI runs each and requires a failure):
//   ORDER_CODES_MUTATION=nullcodes   an absent key is stored as []
//   ORDER_CODES_MUTATION=nullrefund  an absent refunds array is stored as 0
//   ORDER_CODES_MUTATION=fold        codes are stored as typed
//   ORDER_CODES_MUTATION=taxrefund   refund tax is netted into the subtotal
//   ORDER_CODES_MUTATION=pair        only discount_codes is stripped on fallback
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.ORDER_CODES_MUTATION || '';
const ROOT = new URL('../../', import.meta.url);

// The module under test, mutated in a temporary copy of scripts/lib when a
// mutation is requested, so the checked-in file is never touched.
async function loadCore() {
  const src = new URL('scripts/lib/', ROOT);
  if (!MUT) return import(new URL('shopify-sync-core.mjs', src));
  const dir = await mkdtemp(join(tmpdir(), 'order-codes-'));
  await cp(src, dir, { recursive: true });
  const file = join(dir, 'shopify-sync-core.mjs');
  let code = await readFile(file, 'utf8');
  const swap = (from, to) => {
    assert.ok(code.includes(from), `mutation ${MUT}: pattern not found`);
    code = code.split(from).join(to);
  };
  if (MUT === 'nullcodes') swap("if (!Object.prototype.hasOwnProperty.call(order, 'discount_codes')) return null;", "if (!Object.prototype.hasOwnProperty.call(order, 'discount_codes')) return [];");
  if (MUT === 'nullrefund') swap('if (!Array.isArray(order.refunds)) return null;', 'if (!Array.isArray(order.refunds)) return 0;');
  if (MUT === 'fold') swap("const folded = String(code ?? '').trim().toUpperCase();", "const folded = String(code ?? '').trim();");
  if (MUT === 'taxrefund') swap('const amount = Number(rli?.subtotal ?? 0);', 'const amount = Number(rli?.subtotal ?? 0) + Number(rli?.total_tax ?? 0);');
  if (MUT === 'pair') swap('ordersUpserted = await writeOrders(stripKeys(orderRows, AFFILIATE_ORDER_KEYS));', "ordersUpserted = await writeOrders(stripKeys(orderRows, ['discount_codes']));");
  if (!['nullcodes', 'nullrefund', 'fold', 'taxrefund', 'pair'].includes(MUT)) throw new Error(`unknown mutation ${MUT}`);
  await writeFile(file, code);
  return import(pathToFileURL(file).href);
}

const core = await loadCore();
const { orderDiscountCodes, orderRefundedSubtotal, ordersToOrderRows, upsertOrderFacts, AFFILIATE_ORDER_KEYS } = core;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const connection = { id: 'conn-1', company_entity_id: 'co-1', shop_domain: 'brand.myshopify.com' };
const baseOrder = (o) => ({ id: 1, name: '#1', created_at: '2026-11-01T10:00:00Z', line_items: [], total_price: '100.00', ...o });

await test('codes are folded, trimmed and de-duplicated (Shopify matches case-insensitively)', () => {
  assert.deepEqual(
    orderDiscountCodes({ discount_codes: [{ code: 'team50', amount: '5.00', type: 'percentage' }, { code: ' TEAM50 ' }, { code: 'Welcome10' }] }),
    ['TEAM50', 'WELCOME10']);
});

await test('an empty array is a measurement: no code was used', () => {
  assert.deepEqual(orderDiscountCodes({ discount_codes: [] }), []);
});

await test('an ABSENT discount_codes key is NULL (not measured), never []', () => {
  assert.equal(orderDiscountCodes({ total_price: '10.00' }), null);
  assert.equal(orderDiscountCodes({ discount_codes: null }), null, 'a non-array is not a measurement either');
});

await test('codes are capped in count and length so a broken payload cannot write an unbounded value', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ code: `C${i}` }));
  assert.equal(orderDiscountCodes({ discount_codes: many }).length, 20);
  assert.equal(orderDiscountCodes({ discount_codes: [{ code: 'x'.repeat(500) }] })[0].length, 128);
});

await test('refunded subtotal is merchandise after discounts: no tax, no shipping', () => {
  const order = { refunds: [
    { refund_line_items: [{ line_item_id: 1, subtotal: '20.00', total_tax: '1.60' }],
      order_adjustments: [{ kind: 'shipping_refund', amount: '-5.00' }] },
    { refund_line_items: [{ line_item_id: 2, subtotal: 7.5, total_tax: 0.6 }] },
  ] };
  assert.equal(orderRefundedSubtotal(order), 27.5);
});

await test('refunds: [] is a measurement of 0; an absent array is NULL', () => {
  assert.equal(orderRefundedSubtotal({ refunds: [] }), 0);
  assert.equal(orderRefundedSubtotal({ total_price: '10.00' }), null);
});

await test('ordersToOrderRows writes both columns onto every order row', () => {
  const { orderRows } = ordersToOrderRows({
    orders: [
      baseOrder({ id: 1, discount_codes: [{ code: 'pat10' }], refunds: [] }),
      baseOrder({ id: 2 }),
    ],
    connection, skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  assert.deepEqual(orderRows.map((r) => [r.discount_codes, r.refunded_subtotal]), [[['PAT10'], 0], [null, null]]);
});

await test('a database without the columns does NOT stop the order sync, and both are stripped together', async () => {
  const written = [];
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  const supabase = { from: (table) => ({
    delete: () => chain,
    upsert: (rows) => {
      if (table === 'shopify_orders' && rows.some((r) => AFFILIATE_ORDER_KEYS.some((k) => k in r))) {
        return Promise.resolve({ error: { message: "Could not find the 'refunded_subtotal' column of 'shopify_orders' in the schema cache" } });
      }
      if (table === 'shopify_orders') written.push(...rows);
      return Promise.resolve({ error: null });
    },
  }) };
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [baseOrder({ id: 1, discount_codes: [{ code: 'A' }], refunds: [] })], skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  assert.equal(r.orders_upserted, 1);
  assert.equal(written.length, 1, 'the order was still written');
  assert.ok(!('discount_codes' in written[0]) && !('refunded_subtotal' in written[0]));
  assert.match(r.discount_codes_skipped, /20261110083000/);
});

await test('with the columns present, nothing is skipped and the values land', async () => {
  const written = [];
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  const supabase = { from: (table) => ({
    delete: () => chain,
    upsert: (rows) => { if (table === 'shopify_orders') written.push(...rows); return Promise.resolve({ error: null }); },
  }) };
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [baseOrder({ id: 1, discount_codes: [{ code: 'a' }], refunds: [{ refund_line_items: [{ subtotal: '3.00' }] }] })],
    skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  assert.equal(r.discount_codes_skipped, undefined);
  assert.deepEqual(written[0].discount_codes, ['A']);
  assert.equal(written[0].refunded_subtotal, 3);
});

await test('both missing-column fallbacks compose: no terms columns AND no affiliate columns', async () => {
  const written = [];
  const chain = { eq() { return chain; }, in() { return Promise.resolve({ error: null }); } };
  const supabase = { from: (table) => ({
    delete: () => chain,
    upsert: (rows) => {
      if (table !== 'shopify_orders') return Promise.resolve({ error: null });
      if (rows.some((r) => 'discount_codes' in r)) return Promise.resolve({ error: { message: 'column "discount_codes" of relation "shopify_orders" does not exist' } });
      if (rows.some((r) => 'payment_terms_status' in r)) return Promise.resolve({ error: { message: "Could not find the 'payment_due_at' column of 'shopify_orders' in the schema cache" } });
      written.push(...rows);
      return Promise.resolve({ error: null });
    },
  }) };
  const r = await upsertOrderFacts(supabase, connection, {
    orders: [baseOrder({ id: 1, discount_codes: [] })], skuMeta: new Map(), syncedAt: 'x', batchId: 'b',
  });
  assert.equal(written.length, 1);
  assert.ok(r.discount_codes_skipped && r.payment_terms_skipped);
});

await test('the edge copy that is pinned to scripts/lib ships the same change', async () => {
  if (MUT) return; // the mutated copy lives in a temp dir by design
  const original = await readFile(new URL('scripts/lib/shopify-sync-core.mjs', ROOT), 'utf8');
  const edge = await readFile(new URL('supabase/functions/ad-platform-sync-run/lib/shopify-sync-core.mjs', ROOT), 'utf8');
  assert.equal(edge, original);
});

console.log(`\nshopify-order-discount-codes: ${passed} passed`);
