// A Shopify store connected under two companies must never have its orders
// moved from one to the other (scripts/lib/shopify-tenant-guard.mjs).
//
// shopify_orders, _draft_orders and shopify_payouts are unique without
// company_entity_id, so a second company's sync rewrites the first's rows.
// Found by PR #971's pre-merge review: "Start first import" was offered for
// BlockayOps' connection to baseballismmlb, whose orders Baseballism holds.
//
// Run: node scripts/tests/shopify-tenant-guard.test.mjs
// Mutations checked by hand: the comparison inverted, one table dropped from
// ORDER_FACT_TABLES, the error path failing open, the nightly calling
// syncConnection before the guard.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import { orderFactsHeldElsewhere, ORDER_FACT_TABLES } from '../lib/shopify-tenant-guard.mjs';

const BBISM = 'company-baseballism';
const OPS = 'company-blockayops';
const MLB = 'baseballismmlb.myshopify.com';
const conn = (company, domain = MLB) => ({ id: `conn-${company}`, company_entity_id: company, shop_domain: domain });
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('a second company is refused a store whose orders another company holds', async () => {
  const db = createFakeSupabase();
  db.from('shopify_orders').insert({ shop_domain: MLB, order_id: '1', company_entity_id: BBISM });
  const res = await orderFactsHeldElsewhere(db, conn(OPS));
  assert.equal(res.blocked, true);
  assert.equal(res.heldBy, BBISM);
  assert.equal(res.table, 'shopify_orders');
});

test('the company that holds the orders keeps syncing them', async () => {
  const db = createFakeSupabase();
  db.from('shopify_orders').insert({ shop_domain: MLB, order_id: '1', company_entity_id: BBISM });
  assert.equal((await orderFactsHeldElsewhere(db, conn(BBISM))).blocked, false);
});

test('a store nobody has synced yet is free to its first company', async () => {
  const db = createFakeSupabase();
  db.from('shopify_orders').insert({ shop_domain: 'other.myshopify.com', order_id: '1', company_entity_id: BBISM });
  assert.equal((await orderFactsHeldElsewhere(db, conn(OPS))).blocked, false);
});

test('draft orders and payouts count too: they are keyed without the company as well', async () => {
  for (const table of ['shopify_order_lines', 'shopify_draft_orders', 'shopify_payouts']) {
    const db = createFakeSupabase();
    db.from(table).insert({ shop_domain: MLB, company_entity_id: BBISM });
    const res = await orderFactsHeldElsewhere(db, conn(OPS));
    assert.equal(res.blocked, true, table);
    assert.equal(res.table, table);
  }
  assert.deepEqual([...ORDER_FACT_TABLES].sort(), ['shopify_draft_orders', 'shopify_order_lines', 'shopify_orders', 'shopify_payouts']);
});

test('a check that cannot be made blocks: guessing wrong costs another tenant its data', async () => {
  const db = createFakeSupabase();
  const realFrom = db.from.bind(db);
  db.from = (table) => {
    const b = realFrom(table);
    b.select = () => {
      const q = { eq: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'timeout' } }) };
      return q;
    };
    return b;
  };
  const res = await orderFactsHeldElsewhere(db, conn(OPS));
  assert.equal(res.blocked, true);
  assert.match(res.reason, /could not check/);
  for (const bad of [{ shop_domain: MLB }, { company_entity_id: OPS }, null]) {
    assert.equal((await orderFactsHeldElsewhere(createFakeSupabase(), bad)).blocked, true);
  }
});

test('the edge function ships the same guard, byte for byte', () => {
  assert.equal(
    read('supabase/functions/shopify-sync-run/lib/shopify-tenant-guard.mjs'),
    read('scripts/lib/shopify-tenant-guard.mjs'),
    'edit scripts/lib/shopify-tenant-guard.mjs and re-copy it',
  );
});

test('the nightly and the first-import job check before they sync', () => {
  const src = read('scripts/shopify-sync.mjs');
  const loop = src.slice(src.indexOf('for (const connection of connections)'));
  const guardAt = loop.indexOf('orderFactsHeldElsewhere(supabase, connection)');
  const syncAt = loop.indexOf('syncConnection(connection)');
  assert.ok(guardAt > 0 && guardAt < syncAt, 'the guard runs before syncConnection');
  const between = loop.slice(guardAt, syncAt);
  assert.match(between, /if \(guard\.blocked\) \{[\s\S]*continue;\s*\}/, 'a blocked store is skipped, on the guard\'s own verdict');
  assert.match(between, /if \(ONLY_CONNECTION_ID[^)]*\) \{\s*hadError = true;/,
    'a run aimed at that store fails, so its bootstrap job records why');
});

test('the edge function refuses both order-writing actions', () => {
  const src = read('supabase/functions/shopify-sync-run/index.ts');
  const guardAt = src.indexOf('orderFactsHeldElsewhere(admin, connection)');
  assert.ok(guardAt > 0 && guardAt < src.indexOf("case 'start_history_backfill'"));
  assert.match(src.slice(guardAt - 200, guardAt), /action === 'start_history_backfill' \|\| action === 'history_chunk'/);
  assert.match(src.slice(guardAt, guardAt + 200), /if \(guard\.blocked\) \{\s*return json\(/, 'a blocked store gets a refusal, not a pass');
});

test('the manual orders backfill checks before it fetches anything', () => {
  const src = read('scripts/shopify-orders-backfill.mjs');
  const fn = src.slice(src.indexOf('async function backfillConnection'));
  const guardAt = fn.indexOf('orderFactsHeldElsewhere(supabase, connection)');
  assert.ok(guardAt > 0 && guardAt < fn.indexOf('ensureShopifyAccessToken'), 'before any Shopify call');
  assert.match(fn.slice(guardAt, guardAt + 200), /if \(guard\.blocked\) throw/);
});

test('a scheduled run warns only when another company really holds the store', () => {
  const src = read('scripts/shopify-sync.mjs');
  assert.match(src, /if \(ONLY_CONNECTION_ID \|\| PLAN\.manual \|\| !guard\.heldBy\) \{\s*hadError = true;/,
    'a failed check, a manual run, or a single-store run fails');
});
