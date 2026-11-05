// products_master.product_title becomes ONE canonical title per (company, sku)
// (20261105080000), executed in a real PostgreSQL (PGlite): the migration
// verbatim, including its own backfill and its own stability guard.
//
// 20261104193000 fixed the SALES rollup. It left the stored column alone, and
// that column is what the Catalog tab, the PO builder, the launch-calendar
// product picker, SEO Studio and the v3 report builder read -- so a product
// could be called one thing in a report and another in the tool you act on it
// with. Measured on production before this ran: 1,259 SKUs across four
// companies, 1,194 of them Baseballism's.
//
// What these tests pin is WHICH title the column ends up with, that a SKU with
// no catalog row is never blanked, that one company's catalog cannot name
// another's title, and that a second run changes nothing -- the property the
// migration's own guard depends on.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/products-master-canonical-title-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MIGRATION = readFileSync(
  'supabase/migrations/20261105080000_products_master_canonical_title.sql', 'utf8');
const VERIFY = readFileSync('supabase/verify_v2_schema.sql', 'utf8');

const CO_A = '00000000-0000-4000-a000-00000000000a';
const CO_B = '00000000-0000-4000-a000-00000000000b';

const ONLINE = 'shop-online.myshopify.com';
const WHOLESALE = 'shop-wholesale.myshopify.com';

// The production case: the same youth hoodie, carried in two stores, whose
// wholesale catalog puts the words in a different order.
const RIGHT = 'Short Sleeve Youth Hoodie - New York Yankees';
const WRONG = 'Short Sleeve Hoodie Youth - New York Yankees';

const OLD_STAMP = '2020-01-01T00:00:00Z';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

/* Only what the migration touches: the two tables, the three roles, and
 * Supabase's default privileges, so the grant assertions cannot pass
 * trivially. */
async function fresh() {
  const db = new PGlite();
  const q = async (sql) => (await db.query(sql)).rows;
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

    create table products_master(
      company_entity_id uuid, sku text, product_title text, product_type text,
      shop_domain text, shopify_status text,
      updated_at timestamptz default '${OLD_STAMP}',
      constraint products_master_company_sku_key unique (company_entity_id, sku));

    create table shopify_product_skus(
      company_entity_id uuid, shop_domain text, shopify_product_id text,
      shopify_variant_id text, sku text, product_handle text, product_title text,
      variant_title text, shopify_status text, online_published_at timestamptz,
      last_seen_at timestamptz);
  `);
  return { db, q };
}

/* The hoodie as the sync leaves it: products_master carrying the WHOLESALE
 * copy (that store synced last), and both stores' rows in the per-shop table
 * with only the online one published and active. */
const seedHoodie = (db) => db.exec(`
  insert into products_master(company_entity_id, sku, product_title, shop_domain)
  values ('${CO_A}', 'HOODIE-YTH-M', '${WRONG}', '${WHOLESALE}');

  insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
    sku, product_title, shopify_status, online_published_at, last_seen_at)
  values
    ('${CO_A}', '${ONLINE}',    '100', 'HOODIE-YTH-M', '${RIGHT}', 'active',   '2026-03-01T00:00:00Z', '2026-11-04T00:00:00Z'),
    ('${CO_A}', '${WHOLESALE}', '200', 'HOODIE-YTH-M', '${WRONG}', 'draft',    null,                   '2026-11-04T12:00:00Z');
`);

const titleOf = async (q, co, sku) => {
  const rows = await q(`select product_title, updated_at from products_master
                         where company_entity_id = '${co}' and sku = '${sku}'`);
  return rows[0];
};

await test('the published store\'s title wins, replacing whichever store synced last', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  assert.equal((await titleOf(q, CO_A, 'HOODIE-YTH-M')).product_title, WRONG,
    'before: products_master carries the store that synced last');
  await db.exec(MIGRATION);
  const row = await titleOf(q, CO_A, 'HOODIE-YTH-M');
  assert.equal(row.product_title, RIGHT);
  assert.notEqual(new Date(row.updated_at).toISOString(), new Date(OLD_STAMP).toISOString(),
    'a row that changed is stamped, so the Catalog tab can see it moved');
});

await test('a SKU with no catalog row keeps its title and is never blanked', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into products_master(company_entity_id, sku, product_title)
    values ('${CO_A}', 'LEGACY-1', 'A product Shopify no longer lists');`);
  await db.exec(MIGRATION);
  const row = await titleOf(q, CO_A, 'LEGACY-1');
  assert.equal(row.product_title, 'A product Shopify no longer lists');
  assert.equal(new Date(row.updated_at).toISOString(), new Date(OLD_STAMP).toISOString(),
    'and it is not even restamped, because nothing about it changed');
});

await test('a catalog row with no title cannot blank a stored one', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into products_master(company_entity_id, sku, product_title)
    values ('${CO_A}', 'TEE-1', 'A Tee');
    insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
      sku, product_title, shopify_status, last_seen_at)
    values ('${CO_A}', '${ONLINE}', '300', 'TEE-1', null, 'active', '2026-11-04T00:00:00Z');`);
  await db.exec(MIGRATION);
  assert.equal((await titleOf(q, CO_A, 'TEE-1')).product_title, 'A Tee');
});

await test('one company\'s catalog never names another company\'s title', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into products_master(company_entity_id, sku, product_title)
    values ('${CO_A}', 'SHARED-SKU', 'A''s own name'),
           ('${CO_B}', 'SHARED-SKU', 'B''s own name');
    insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
      sku, product_title, shopify_status, online_published_at, last_seen_at)
    values ('${CO_A}', '${ONLINE}', '400', 'SHARED-SKU', 'A canonical', 'active', '2026-01-01T00:00:00Z', '2026-11-04T00:00:00Z');`);
  await db.exec(MIGRATION);
  assert.equal((await titleOf(q, CO_A, 'SHARED-SKU')).product_title, 'A canonical');
  assert.equal((await titleOf(q, CO_B, 'SHARED-SKU')).product_title, "B's own name",
    'B has no catalog row for it, so B is left exactly as it was');
});

/* Two ACTIVE stores, only one of them published online, and the unpublished
 * one seen more recently -- so recency alone would pick the wrong title. */
const seedTwoActive = (db) => db.exec(`
  insert into products_master(company_entity_id, sku, product_title, shop_domain)
  values ('${CO_A}', 'TEE-TIE', '${WRONG}', '${WHOLESALE}');

  insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
    sku, product_title, shopify_status, online_published_at, last_seen_at)
  values
    ('${CO_A}', '${ONLINE}',    '500', 'TEE-TIE', '${RIGHT}', 'active', '2026-03-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    ('${CO_A}', '${WHOLESALE}', '600', 'TEE-TIE', '${WRONG}', 'active', null,                   '2026-11-04T00:00:00Z');
`);

await test('between two active stores the one published online wins, not the most recent', async () => {
  const { db, q } = await fresh();
  await seedTwoActive(db);
  await db.exec(MIGRATION);
  assert.equal((await titleOf(q, CO_A, 'TEE-TIE')).product_title, RIGHT);
});

await test('a tie on status, publication and recency is still settled, and settled the same way twice', async () => {
  // Nothing but shop_domain and product id separates these two, which is
  // exactly why both are in the ORDER BY: without them the choice would be
  // arbitrary and a later refresh could move the title.
  const build = async () => {
    const { db, q } = await fresh();
    await db.exec(`
      insert into products_master(company_entity_id, sku, product_title)
      values ('${CO_A}', 'TWIN-1', 'whatever the sync left');
      insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
        sku, product_title, shopify_status, online_published_at, last_seen_at)
      values
        ('${CO_A}', 'a-store.myshopify.com', '700', 'TWIN-1', 'A store title', 'active', '2026-01-01T00:00:00Z', '2026-11-04T00:00:00Z'),
        ('${CO_A}', 'z-store.myshopify.com', '800', 'TWIN-1', 'Z store title', 'active', '2026-01-01T00:00:00Z', '2026-11-04T00:00:00Z');`);
    await db.exec(MIGRATION);
    return (await titleOf(q, CO_A, 'TWIN-1')).product_title;
  };
  const first = await build();
  assert.equal(first, 'A store title', 'shop_domain breaks the tie, so the answer is stated rather than arbitrary');
  assert.equal(await build(), first, 'and the same data gives the same answer on a fresh database');
});

await test('a second call changes nothing, and reports that it changed nothing', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);          // its own guard already asserts this once
  const [again] = await q('select public.apply_canonical_product_titles() as n');
  assert.equal(Number(again.n), 0);
  const stamped = await titleOf(q, CO_A, 'HOODIE-YTH-M');
  const [third] = await q('select public.apply_canonical_product_titles() as n');
  assert.equal(Number(third.n), 0);
  assert.equal((await titleOf(q, CO_A, 'HOODIE-YTH-M')).updated_at.toISOString(),
    stamped.updated_at.toISOString(), 'and a no-op run does not move updated_at');
});

await test('the function is a definer that writes every company, so no client role may call it', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const [row] = await q(`
    select has_function_privilege('anon', 'public.apply_canonical_product_titles()', 'EXECUTE') as anon,
           has_function_privilege('authenticated', 'public.apply_canonical_product_titles()', 'EXECUTE') as auth,
           has_function_privilege('service_role', 'public.apply_canonical_product_titles()', 'EXECUTE') as svc,
           (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'apply_canonical_product_titles') as definer`);
  assert.equal(row.anon, false);
  assert.equal(row.auth, false);
  assert.equal(row.svc, true, 'the sync calls it as the service role');
  assert.equal(row.definer, true);
});

// The verify arm for this, lifted verbatim out of verify_v2_schema.sql so the
// test runs what production runs rather than a paraphrase. Only the two arms
// this migration added are exercised; the rest of the check needs the rollup.
await test('verify_v2_schema.sql fails when the function is missing or exposed', async () => {
  assert.ok(VERIFY.includes("p.proname='apply_canonical_product_titles'"),
    'verify_v2_schema.sql no longer checks for apply_canonical_product_titles()');
  assert.ok(VERIFY.includes("has_function_privilege('authenticated', 'public.apply_canonical_product_titles()', 'EXECUTE')"),
    'verify_v2_schema.sql no longer checks who may execute it');
  // Its OWN check, not an arm of the rollup's: product-title-canonical's test
  // lifts that one verbatim and knows nothing of this function, so folding
  // these arms in there turned that suite red.
  assert.ok(VERIFY.includes('end as apply_canonical_product_titles;'),
    'the function needs a check of its own, separate from sales_by_product_title_daily_v');

  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const probe = `
    select case
      when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='apply_canonical_product_titles')
        then 'MISSING'
      when has_function_privilege('authenticated', 'public.apply_canonical_product_titles()', 'EXECUTE')
        or has_function_privilege('anon', 'public.apply_canonical_product_titles()', 'EXECUTE')
        then 'BROKEN'
      else 'ok' end as verdict`;
  assert.equal((await q(probe))[0].verdict, 'ok');
  await db.exec('grant execute on function public.apply_canonical_product_titles() to authenticated');
  assert.equal((await q(probe))[0].verdict, 'BROKEN');
  await db.exec('drop function public.apply_canonical_product_titles()');
  assert.equal((await q(probe))[0].verdict, 'MISSING');
});

/* ── Mutations ──────────────────────────────────────────────────────────────
 * Each one breaks a single guard in the migration and must make at least one
 * check fail. A mutation whose pattern no longer matches fails loudly rather
 * than counting as a kill. */
const MUTATIONS = [
  // The published store's copy is what wins; reverse the first tiebreak and
  // the draft wholesale title comes back.
  ['published store no longer wins',
    "(coalesce(ps.shopify_status, '') = 'active') desc,",
    "(coalesce(ps.shopify_status, '') = 'active') asc,"],
  // Between two active stores, the one published online decides. Removing
  // that tiebreak falls through to recency, and the unpublished store's
  // title comes back.
  ['published-at no longer breaks a tie between two active stores',
    '      (ps.online_published_at is not null) desc,',
    ''],
  // A title-less catalog row must not reach the update at all.
  ['a catalog row with no title is allowed through',
    '      and ps.product_title is not null',
    ''],
  // Writing every matching row, not only the ones that differ, restamps
  // 30,000 rows a night and makes a second call non-zero.
  ['every row is rewritten, not only the ones that differ',
    '     and pm.product_title is distinct from ct.product_title;',
    ';'],
  // The company predicate is the tenant boundary.
  ['the company is not part of the join',
    '   where ct.company_entity_id = pm.company_entity_id\n     and ct.sku = pm.sku',
    '   where ct.sku = pm.sku'],
  // A definer function that writes every company must not be callable by a
  // signed-in user.
  ['the client roles keep their default grant',
    'revoke execute on function public.apply_canonical_product_titles() from public, anon, authenticated;',
    ''],
];

for (const [name, from, to] of MUTATIONS) {
  await test(`mutation caught: ${name}`, async () => {
    assert.ok(MIGRATION.includes(from), `mutation pattern no longer matches the migration: ${name}`);
    const mutated = MIGRATION.split(from).join(to);
    assert.notEqual(mutated, MIGRATION);
    const checks = [];

    // The hoodie must come out as the published store named it.
    {
      const { db, q } = await fresh();
      await seedHoodie(db);
      let failed = false;
      try {
        await db.exec(mutated);
        failed = (await titleOf(q, CO_A, 'HOODIE-YTH-M')).product_title !== RIGHT;
      } catch { failed = true; }
      checks.push(failed);
    }

    // A title-less catalog row must leave the stored title alone.
    {
      const { db, q } = await fresh();
      let failed = false;
      try {
        await db.exec(`
          insert into products_master(company_entity_id, sku, product_title)
          values ('${CO_A}', 'TEE-1', 'A Tee');
          insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
            sku, product_title, shopify_status, last_seen_at)
          values ('${CO_A}', '${ONLINE}', '300', 'TEE-1', null, 'active', '2026-11-04T00:00:00Z');`);
        await db.exec(mutated);
        failed = (await titleOf(q, CO_A, 'TEE-1')).product_title !== 'A Tee';
      } catch { failed = true; }
      checks.push(failed);
    }

    // Between two active stores, the published one must win.
    {
      const { db, q } = await fresh();
      await seedTwoActive(db);
      let failed = false;
      try {
        await db.exec(mutated);
        failed = (await titleOf(q, CO_A, 'TEE-TIE')).product_title !== RIGHT;
      } catch { failed = true; }
      checks.push(failed);
    }

    // Another company's row must be untouched, and a no-op run must stay a
    // no-op.
    {
      const { db, q } = await fresh();
      let failed = false;
      try {
        await db.exec(`
          insert into products_master(company_entity_id, sku, product_title)
          values ('${CO_A}', 'SHARED-SKU', 'A''s own name'),
                 ('${CO_B}', 'SHARED-SKU', 'B''s own name');
          insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
            sku, product_title, shopify_status, online_published_at, last_seen_at)
          values ('${CO_A}', '${ONLINE}', '400', 'SHARED-SKU', 'A canonical', 'active', '2026-01-01T00:00:00Z', '2026-11-04T00:00:00Z');`);
        await db.exec(mutated);
        const b = await titleOf(q, CO_B, 'SHARED-SKU');
        const [again] = await q('select public.apply_canonical_product_titles() as n');
        failed = b.product_title !== "B's own name" || Number(again.n) !== 0;
      } catch { failed = true; }
      checks.push(failed);
    }

    // No client role may execute it.
    {
      const { db, q } = await fresh();
      await seedHoodie(db);
      let failed = false;
      try {
        await db.exec(mutated);
        const [row] = await q(`
          select has_function_privilege('anon', 'public.apply_canonical_product_titles()', 'EXECUTE') as anon,
                 has_function_privilege('authenticated', 'public.apply_canonical_product_titles()', 'EXECUTE') as auth`);
        failed = row.anon || row.auth;
      } catch { failed = true; }
      checks.push(failed);
    }

    assert.ok(checks.some(Boolean), `mutation produced identical behaviour: ${name}`);
  });
}

console.log(`\n${passed} tests passed`);
