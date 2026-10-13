// Shopify order facts upsert on the PER-COMPANY key, falling back to the old
// company-less key only while 20261013220000 has not applied
// (scripts/lib/shopify-order-fact-keys.mjs).
//
// Run: node scripts/tests/shopify-order-fact-keys.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import { ORDER_FACT_KEYS, upsertOrderFact, resetOrderFactKeyCache } from '../lib/shopify-order-fact-keys.mjs';
import { upsertInChunks } from '../lib/shopify-sync-core.mjs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const NO_KEY = 'there is no unique or exclusion constraint matching the ON CONFLICT specification';

/** An upsertInChunks stand-in that knows which keys "exist". */
function fakeUpsert(existingKeys, log) {
  return async (_db, table, rows, onConflict) => {
    log.push(`${table}:${onConflict}`);
    if (!existingKeys.has(onConflict)) throw new Error(`${table} upsert failed: ${NO_KEY}`);
    return rows.length;
  };
}

test('every order-fact table upserts on its per-company key once the migration has applied', async () => {
  resetOrderFactKeyCache();
  const log = [];
  const up = fakeUpsert(new Set(Object.values(ORDER_FACT_KEYS).map((k) => k.perCompany)), log);
  for (const table of Object.keys(ORDER_FACT_KEYS)) {
    assert.equal(await upsertOrderFact(up, null, table, [{}]), 1);
    assert.match(ORDER_FACT_KEYS[table].perCompany, /company_entity_id$/);
  }
  assert.deepEqual(log, Object.entries(ORDER_FACT_KEYS).map(([t, k]) => `${t}:${k.perCompany}`));
});

test('before the migration it falls back to the old key, once per table, and remembers', async () => {
  resetOrderFactKeyCache();
  const log = [];
  const up = fakeUpsert(new Set([ORDER_FACT_KEYS.shopify_orders.legacy]), log);
  assert.equal(await upsertOrderFact(up, null, 'shopify_orders', [{}, {}]), 2);
  assert.equal(await upsertOrderFact(up, null, 'shopify_orders', [{}]), 1);
  assert.deepEqual(log, [
    'shopify_orders:shop_domain,order_id,company_entity_id', // the one failed attempt
    'shopify_orders:shop_domain,order_id',
    'shopify_orders:shop_domain,order_id', // straight to legacy afterwards
  ]);
});

test('a run settled on the old key switches when the migration lands mid-run', async () => {
  resetOrderFactKeyCache();
  const log = [];
  const existing = new Set([ORDER_FACT_KEYS.shopify_orders.legacy]);
  const up = fakeUpsert(existing, log);
  await upsertOrderFact(up, null, 'shopify_orders', [{}]); // settles on legacy
  existing.clear(); existing.add(ORDER_FACT_KEYS.shopify_orders.perCompany); // migration applies
  assert.equal(await upsertOrderFact(up, null, 'shopify_orders', [{}, {}, {}]), 3);
  assert.equal(await upsertOrderFact(up, null, 'shopify_orders', [{}]), 1);
  assert.deepEqual(log.slice(2), [
    'shopify_orders:shop_domain,order_id', // old key, now gone
    'shopify_orders:shop_domain,order_id,company_entity_id',
    'shopify_orders:shop_domain,order_id,company_entity_id', // and stays there
  ]);
});

test('any other failure is a failure, and so is a missing key after the new one worked', async () => {
  resetOrderFactKeyCache();
  // Fails on the per-company key only, so a wrong fallback would SUCCEED here.
  const boom = async (_db, table, rows, key) => {
    if (key === ORDER_FACT_KEYS.shopify_orders.perCompany) throw new Error(`${table} upsert failed: statement timeout`);
    return rows.length;
  };
  await assert.rejects(upsertOrderFact(boom, null, 'shopify_orders', [{}]), /statement timeout/);

  resetOrderFactKeyCache();
  let calls = 0;
  const flaky = async (_db, table, rows, key) => {
    if (key === ORDER_FACT_KEYS.shopify_orders.legacy) return rows.length; // the old key would "work"
    calls += 1;
    if (calls === 1) return rows.length; // per-company key worked
    throw new Error(`${table} upsert failed: ${NO_KEY}`); // then "vanished"
  };
  await upsertOrderFact(flaky, null, 'shopify_orders', [{}]);
  await assert.rejects(upsertOrderFact(flaky, null, 'shopify_orders', [{}]), /no unique or exclusion/,
    'a key that was there and is not is never quietly swapped for the old, cross-tenant one');
  await assert.rejects(upsertOrderFact(async () => 0, null, 'sales_by_day', [{}]), /not an order-fact table/);
});

test('two companies syncing one store keep one copy each', async () => {
  resetOrderFactKeyCache();
  const db = createFakeSupabase();
  const row = (company) => ({ shop_domain: 'baseballismmlb.myshopify.com', order_id: '1001', company_entity_id: company, total_price: 10 });
  await upsertOrderFact(upsertInChunks, db, 'shopify_orders', [row('company-baseballism')]);
  await upsertOrderFact(upsertInChunks, db, 'shopify_orders', [row('company-blockayops')]);
  await upsertOrderFact(upsertInChunks, db, 'shopify_orders', [{ ...row('company-baseballism'), total_price: 12 }]);
  const rows = db.rows('shopify_orders');
  assert.equal(rows.length, 2, 'one per company -- and the re-sync updated, not duplicated');
  assert.equal(rows.find((r) => r.company_entity_id === 'company-baseballism').total_price, 12);
  assert.equal(rows.find((r) => r.company_entity_id === 'company-blockayops').total_price, 10);
});

test('no code path upserts an order-fact table on a key of its own', () => {
  for (const p of [
    'scripts/lib/shopify-sync-core.mjs',
    'supabase/functions/shopify-sync-run/lib/shopify-sync-core.mjs',
    'supabase/functions/ad-platform-sync-run/lib/shopify-sync-core.mjs',
  ]) {
    const src = read(p);
    assert.doesNotMatch(src, /upsertInChunks\(supabase, 'shopify_(orders|order_lines|draft_orders|payouts)'/, p);
    assert.match(src, /import \{ upsertOrderFact \} from '\.\/shopify-order-fact-keys\.mjs';/, p);
  }
});

test('the edge functions ship the same module, byte for byte', () => {
  const original = read('scripts/lib/shopify-order-fact-keys.mjs');
  for (const fn of ['shopify-sync-run', 'ad-platform-sync-run']) {
    assert.equal(read(`supabase/functions/${fn}/lib/shopify-order-fact-keys.mjs`), original,
      `edit scripts/lib/shopify-order-fact-keys.mjs and re-copy it into ${fn}/lib`);
  }
});
