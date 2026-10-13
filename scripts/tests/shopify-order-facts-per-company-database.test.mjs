// 20261013220000_shopify_order_facts_per_company.sql against real PostgreSQL
// (PGlite), read from disk. Proves:
//   - it applies, twice
//   - the company-less keys are gone and the per-company keys exist
//   - one store's order facts can be held by two companies, one copy each
//   - a re-sync within one company still upserts (updates, never duplicates)
//     on exactly the onConflict columns scripts/lib/shopify-order-fact-keys.mjs
//     sends, and the old key is refused with the error the fallback reads
//   - shopify_order_facts_keyed_by_company() is false before, true after, and
//     false again if any company-less key comes back
//   - only service_role may call it
//   - verify_v2_schema.sql's check reads MISSING / ok / CRITICAL correctly
//
// Stand-in schema: the four tables' key columns and production's constraint
// names as of 2026-10-13 (pg_constraint).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { ORDER_FACT_KEYS } from '../lib/shopify-order-fact-keys.mjs';

const db = new PGlite();
const MIGRATION = new URL('../../supabase/migrations/20261013220000_shopify_order_facts_per_company.sql', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const A = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const B = '00000000-0000-0000-0000-00000000000b';
const SHOP = 'baseballismmlb.myshopify.com';

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.shopify_orders (id bigserial primary key, company_entity_id uuid not null,
    shop_domain text, order_id text, total_price numeric,
    constraint shopify_orders_shop_domain_order_id_key unique (shop_domain, order_id));
  create table public.shopify_order_lines (id bigserial primary key, company_entity_id uuid not null,
    shop_domain text, order_id text, line_item_id text, quantity integer,
    constraint shopify_order_lines_shop_domain_order_id_line_item_id_key unique (shop_domain, order_id, line_item_id));
  create table public.shopify_draft_orders (id bigserial primary key, company_entity_id uuid not null,
    shop_domain text, draft_order_id text, total_price numeric,
    constraint shopify_draft_orders_shop_domain_draft_order_id_key unique (shop_domain, draft_order_id));
  create table public.shopify_payouts (id bigserial primary key, company_entity_id uuid not null,
    shop_domain text, payout_id text, amount numeric,
    constraint shopify_payouts_payout_id_key unique (payout_id));
`);

const sql = await readFile(MIGRATION, 'utf8');
const verifyAll = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const VERIFY = verifyAll.slice(verifyAll.indexOf("select 'Shopify order facts keyed per company'"));
const verify = async () => (await q(VERIFY.slice(0, VERIFY.indexOf(';') + 1)))[0].status;
const keyed = async () => (await q('select public.shopify_order_facts_keyed_by_company() as v'))[0].v;
const VALUE_COL = { shopify_orders: 'total_price', shopify_order_lines: 'quantity', shopify_draft_orders: 'total_price', shopify_payouts: 'amount' };
const KEY_VALUES = { shop_domain: SHOP, order_id: '1001', line_item_id: '1', draft_order_id: 'D1', payout_id: 'P1' };

/** The INSERT ... ON CONFLICT PostgREST builds for upsert(rows, { onConflict }). */
async function upsert(table, onConflict, company, value) {
  const cols = [...new Set([...onConflict.split(','), 'company_entity_id', VALUE_COL[table]])];
  const vals = cols.map((c) => (c === 'company_entity_id' ? company : c === VALUE_COL[table] ? value : KEY_VALUES[c]));
  await db.query(
    `insert into public.${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
     on conflict (${onConflict}) do update set ${VALUE_COL[table]} = excluded.${VALUE_COL[table]},
       company_entity_id = excluded.company_entity_id`,
    vals,
  );
}

await test('before it applies, a second company MOVES the first one\'s orders (the bug)', async () => {
  await upsert('shopify_orders', ORDER_FACT_KEYS.shopify_orders.legacy, A, 10);
  await upsert('shopify_orders', ORDER_FACT_KEYS.shopify_orders.legacy, B, 10);
  assert.deepEqual(await q('select company_entity_id from public.shopify_orders'), [{ company_entity_id: B }]);
  await db.exec('delete from public.shopify_orders');
});

await test('verify reads MISSING before it applies', async () => {
  assert.match(await verify(), /^MISSING/);
});

await test('applies, and applies again -- adopting a key index built beforehand', async () => {
  // What `create unique index concurrently` ahead of time leaves behind.
  await db.exec(`create unique index shopify_order_lines_shop_order_line_company_key
    on public.shopify_order_lines (shop_domain, order_id, line_item_id, company_entity_id)`);
  const before = (await q(`select oid from pg_class where relname = 'shopify_order_lines_shop_order_line_company_key'`))[0].oid;
  await db.exec(sql);
  const [c] = await q(`select conindid from pg_constraint where conname = 'shopify_order_lines_shop_order_line_company_key'`);
  assert.equal(c.conindid, before, 'the existing index became the constraint, not a second build');
  await db.exec(sql);
});

await test('the company-less keys are gone; the per-company keys lead with the old columns', async () => {
  const rows = await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where contype = 'u' and connamespace = 'public'::regnamespace order by 1, 2`);
  assert.deepEqual(rows.map((r) => [r.t, r.def]), [
    ['shopify_draft_orders', 'UNIQUE (shop_domain, draft_order_id, company_entity_id)'],
    ['shopify_order_lines', 'UNIQUE (shop_domain, order_id, line_item_id, company_entity_id)'],
    ['shopify_orders', 'UNIQUE (shop_domain, order_id, company_entity_id)'],
    ['shopify_payouts', 'UNIQUE (payout_id, company_entity_id)'],
  ]);
});

await test('two companies hold one copy each; a re-sync updates its own copy only', async () => {
  for (const [table, key] of Object.entries(ORDER_FACT_KEYS)) {
    await upsert(table, key.perCompany, A, 10);
    await upsert(table, key.perCompany, B, 20);
    await upsert(table, key.perCompany, A, 11);
    const rows = await q(`select company_entity_id::text as c, ${VALUE_COL[table]}::numeric as v
      from public.${table} order by 1`);
    assert.deepEqual(rows.map((r) => [r.c, Number(r.v)]), [[B, 20], [A, 11]].sort(), table);
  }
});

await test('the old onConflict is refused with the message the fallback recognises', async () => {
  for (const [table, key] of Object.entries(ORDER_FACT_KEYS)) {
    await assert.rejects(upsert(table, key.legacy, A, 1),
      /no unique or exclusion constraint matching the ON CONFLICT specification/, table);
  }
});

await test('the guard\'s signal: true when applied, false when any old key is back', async () => {
  assert.equal(await keyed(), true);
  await db.exec('delete from public.shopify_payouts where company_entity_id <> $$' + A + '$$');
  await db.exec('alter table public.shopify_payouts add constraint shopify_payouts_payout_id_key unique (payout_id)');
  assert.equal(await keyed(), false, 'half-applied keeps the guard on');
  await db.exec(sql);
  assert.equal(await keyed(), true, 're-applying repairs it');
});

await test('verify: ok once applied, CRITICAL for a company-less unique index or a browser grant', async () => {
  assert.equal(await verify(), 'ok');
  await db.exec('create unique index stray_payout on public.shopify_payouts (shop_domain, payout_id)');
  assert.match(await verify(), /CRITICAL: a Shopify order-fact table has a unique key without company_entity_id/);
  await db.exec('drop index public.stray_payout');
  await db.exec('alter table public.shopify_orders drop constraint shopify_orders_shop_order_company_key');
  assert.match(await verify(), /CRITICAL: a per-company Shopify order-fact key is missing/);
  // Rebuilt from scratch this time (step 3 adopted a pre-built lines index).
  await db.exec('alter table public.shopify_order_lines drop constraint shopify_order_lines_shop_order_line_company_key');
  await db.exec(sql);
  assert.equal(await verify(), 'ok', 'a re-apply rebuilds both keys with the company in them');
  await db.exec('grant execute on function public.shopify_order_facts_keyed_by_company() to authenticated');
  assert.match(await verify(), /callable from the browser/);
  await db.exec(sql);
  assert.equal(await verify(), 'ok', 're-applying revokes it again');
});

await test('only service_role may call the signal', async () => {
  const fn = 'public.shopify_order_facts_keyed_by_company()';
  for (const [role, can] of [['anon', false], ['authenticated', false], ['service_role', true]]) {
    assert.equal((await q(`select has_function_privilege($1, $2, 'execute') as v`, [role, fn]))[0].v, can, role);
  }
});

console.log(`# pass ${passed}`);
