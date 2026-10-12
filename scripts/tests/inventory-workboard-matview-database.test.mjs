// Materializing inventory_workboard_v (20261012210000), executed in a real
// PostgreSQL (PGlite).
//
// The change is meant to be speed-only, so the thing worth proving is that it
// is: the matview must return exactly what the two-wrapper-view join returned,
// per company. The speed itself cannot be measured here -- PGlite has neither
// production's 67,605 rows nor its plan costs -- and was measured on production
// instead (see the migration header).
//
// What CAN be proved here is the part that could silently change a number, and
// it is not hypothetical. Today both sides of the join are already scoped to one
// company, because the view reads the company-filtered wrapper views. A matview
// has no caller, so it is built across every company -- and then
// company_entity_id has to be part of every join key or one tenant's inventory
// matches another tenant's sales velocity. These tests build the SAME fixture
// both ways and show the difference, so the join key is a demonstrated
// requirement rather than a remark in a comment.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/inventory-workboard-matview-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MIGRATION = readFileSync(
  'supabase/migrations/20261012210000_inventory_workboard_matview.sql', 'utf8');
const VERIFY = readFileSync('supabase/verify_v2_schema.sql', 'utf8');

const CO_A = '00000000-0000-4000-a000-00000000000a';
const CO_B = '00000000-0000-4000-a000-00000000000b';

// The verify block for this matview, lifted verbatim out of
// verify_v2_schema.sql, so the test runs what production runs rather than a
// paraphrase of it. Everything from the `select` that opens the block to its
// `end as inventory_workboard_mv;`.
const VERIFY_BLOCK = (() => {
  const end = VERIFY.indexOf('end as inventory_workboard_mv;');
  assert.ok(end > 0, 'verify_v2_schema.sql no longer carries the inventory_workboard_mv check');
  const start = VERIFY.lastIndexOf('\nselect\n', end);
  assert.ok(start > 0, 'could not find the start of the inventory_workboard_mv check');
  return VERIFY.slice(start, end + 'end as inventory_workboard_mv;'.length);
})();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

/* A database carrying the objects the migration expects to find, plus the view
 * as it exists BEFORE the migration: security_invoker over the two
 * company-filtered wrapper views. `activeCo` is what active_company_id()
 * returns, which is how the pre-migration view scopes itself at all. */
async function fresh({ activeCo = CO_A } = {}) {
  const db = new PGlite();
  const q = async (sql) => (await db.query(sql)).rows;

  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    create table inventory_on_hand_current_mv_src(
      id bigint, location_tag text, source text, location text, product_title text,
      variant_title text, variant_sku text, shop_domain text, variant_barcode text,
      est_oos_date date, variant_created_at date, product_type text, product_image text,
      product_image_url text, retail_price numeric, total_available_quantity integer,
      total_available_inventory_value numeric, qty_sold_30d integer,
      avg_qty_sold_per_day numeric, est_days_before_oos numeric,
      snapshot_at timestamptz, row_hash text, location_name text, sync_batch_id text,
      company_entity_id uuid);

    create table sales_velocity_src(
      company_entity_id uuid, location_tag text, variant_sku text, product_name text,
      qty_7d bigint, qty_30d bigint, qty_90d bigint, qty_120d bigint, qty_365d bigint,
      avg_day_7 numeric, avg_day_30 numeric, avg_day_90 numeric, avg_day_120 numeric,
      avg_day_365 numeric, last_sold_date date);

    create materialized view inventory_on_hand_current_mv as
      select * from inventory_on_hand_current_mv_src;
    create unique index inventory_on_hand_current_mv_id_idx
      on inventory_on_hand_current_mv (id);

    create materialized view sales_velocity_by_sku_location_mv as
      select * from sales_velocity_src;
    -- The real one. It is what makes the company-keyed join single-valued, and
    -- its absence from the three-column join is where the extra rows come from.
    create unique index sales_velocity_mv_co_loc_sku_name
      on sales_velocity_by_sku_location_mv
      (company_entity_id, location_tag, variant_sku, product_name);

    create function active_company_id() returns uuid language sql stable
      as $$ select '${activeCo}'::uuid $$;
    create function refresh_chat_schema_catalog() returns void language sql
      as $$ select null::void $$;

    create view inventory_on_hand_current_v with (security_invoker = false) as
      select * from inventory_on_hand_current_mv
      where company_entity_id = active_company_id();
    create view sales_velocity_by_sku_location_v with (security_invoker = false) as
      select location_tag, variant_sku, product_name, qty_7d, qty_30d, qty_90d,
             qty_120d, qty_365d, avg_day_7, avg_day_30, avg_day_90, avg_day_120,
             avg_day_365, last_sold_date
      from sales_velocity_by_sku_location_mv
      where company_entity_id = active_company_id();
  `);

  // The pre-migration view, verbatim in shape: reads the wrapper views, so the
  // join carries NO company key because it does not need one.
  await db.exec(`
    create view inventory_workboard_v with (security_invoker = true) as
      select i.id, i.location_tag, i.source, i.location, i.product_title,
        i.variant_title, i.variant_sku, i.shop_domain, i.variant_barcode,
        i.est_oos_date, i.variant_created_at, i.product_type, i.product_image,
        i.product_image_url, i.retail_price, i.total_available_quantity,
        i.total_available_inventory_value, i.qty_sold_30d, i.avg_qty_sold_per_day,
        i.est_days_before_oos, i.snapshot_at, i.row_hash, i.location_name,
        i.sync_batch_id, i.company_entity_id,
        coalesce(t.qty_7d, a.qty_7d, 0::bigint) as qty_7d,
        coalesce(t.qty_30d, a.qty_30d, 0::bigint) as sold_30,
        coalesce(t.qty_90d, a.qty_90d, 0::bigint) as qty_90d,
        coalesce(t.qty_120d, a.qty_120d, 0::bigint) as qty_120d,
        coalesce(t.qty_365d, a.qty_365d, 0::bigint) as qty_365d,
        coalesce(t.avg_day_7, a.avg_day_7, 0::numeric) as avg_day_7,
        coalesce(t.avg_day_30, a.avg_day_30, 0::numeric) as avg_day_30,
        coalesce(t.avg_day_90, a.avg_day_90, 0::numeric) as avg_day_90,
        coalesce(t.avg_day_120, a.avg_day_120, 0::numeric) as avg_day_120,
        coalesce(t.avg_day_365, a.avg_day_365, 0::numeric) as avg_day_365,
        coalesce(t.last_sold_date, a.last_sold_date) as last_sold_date,
        case when coalesce(t.avg_day_30, a.avg_day_30, 0::numeric) > 0::numeric
               then round(coalesce(i.total_available_quantity, 0)::numeric / coalesce(t.avg_day_30, a.avg_day_30), 1)
             when coalesce(t.avg_day_7, a.avg_day_7, 0::numeric) > 0::numeric
               then round(coalesce(i.total_available_quantity, 0)::numeric / coalesce(t.avg_day_7, a.avg_day_7), 1)
             else null::numeric end as days_oos,
        case when coalesce(t.avg_day_30, a.avg_day_30, 0::numeric) > 0::numeric then '30d'::text
             when coalesce(t.avg_day_7, a.avg_day_7, 0::numeric) > 0::numeric then '7d'::text
             else 'none'::text end as velocity_basis,
        t.variant_sku is not null or a.variant_sku is not null as velocity_matched,
        case when t.variant_sku is not null then 'title'::text
             when a.variant_sku is not null then 'sku_fallback'::text
             else 'none'::text end as velocity_source
      from inventory_on_hand_current_v i
        left join sales_velocity_by_sku_location_v t
          on t.location_tag = lower(trim(both from i.location_tag))
         and t.variant_sku = trim(both from i.variant_sku)
         and t.product_name = trim(both from i.product_title)
        left join (
          select location_tag, variant_sku, count(*) as name_variants,
                 max(qty_7d) qty_7d, max(qty_30d) qty_30d, max(qty_90d) qty_90d,
                 max(qty_120d) qty_120d, max(qty_365d) qty_365d,
                 max(avg_day_7) avg_day_7, max(avg_day_30) avg_day_30,
                 max(avg_day_90) avg_day_90, max(avg_day_120) avg_day_120,
                 max(avg_day_365) avg_day_365, max(last_sold_date) last_sold_date
          from sales_velocity_by_sku_location_v
          group by location_tag, variant_sku
        ) a
          on a.location_tag = lower(trim(both from i.location_tag))
         and a.variant_sku = trim(both from i.variant_sku)
         and a.name_variants = 1;
    grant select on inventory_workboard_v to authenticated;
  `);
  return { db, q };
}

/* Two companies holding the SAME (location_tag, variant_sku, product_title),
 * which is the collision the company join key exists for. Company A has sales
 * history for it; company B has none of its own. Plus rows that exercise the
 * other branches: a SKU-fallback match, a title that does not match at all, a
 * SKU whose fallback is ambiguous (two name variants, so name_variants <> 1),
 * and a row with no velocity anywhere. */
async function seed(db) {
  await db.exec(`
    insert into inventory_on_hand_current_mv_src
      (id, location_tag, variant_sku, product_title, total_available_quantity, company_entity_id, location_name) values
      -- the collision: identical keys in both companies
      (1, 'Online', 'SKU-1', 'Tee', 100, '${CO_A}', 'Web'),
      (2, 'Online', 'SKU-1', 'Tee', 7,   '${CO_B}', 'Web'),
      -- A: untrimmed/uppercased input, so the lower(trim()) keys matter
      (3, '  WAREHOUSE ', ' SKU-2 ', ' Cap ', 50, '${CO_A}', 'WH'),
      -- A: title drift, so only the SKU fallback can match
      (4, 'online', 'SKU-3', 'Hoodie (2026)', 30, '${CO_A}', 'Web'),
      -- A: SKU with two name variants in velocity, so the fallback is refused
      (5, 'online', 'SKU-4', 'Nothing matches', 40, '${CO_A}', 'Web'),
      -- A: nothing anywhere
      (6, 'online', 'SKU-9', 'Orphan', 5, '${CO_A}', 'Web'),
      -- B: its own row, with its own velocity
      (7, 'online', 'SKU-B', 'Bat', 20, '${CO_B}', 'Web');

    insert into sales_velocity_src
      (company_entity_id, location_tag, variant_sku, product_name,
       qty_7d, qty_30d, qty_90d, qty_120d, qty_365d,
       avg_day_7, avg_day_30, avg_day_90, avg_day_120, avg_day_365, last_sold_date) values
      ('${CO_A}', 'online', 'SKU-1', 'Tee',    14, 60, 180, 240, 730, 2, 2, 2, 2, 2, '2026-10-01'),
      ('${CO_A}', 'warehouse', 'SKU-2', 'Cap',  7, 30,  90, 120, 365, 1, 1, 1, 1, 1, '2026-09-30'),
      ('${CO_A}', 'online', 'SKU-3', 'Hoodie',  7, 15,  45,  60, 180, 1, 0.5, 0.5, 0.5, 0.5, '2026-09-20'),
      -- two name variants for SKU-4, so name_variants = 2 and the fallback is refused
      ('${CO_A}', 'online', 'SKU-4', 'Sock A',  7, 10,  30,  40, 120, 1, 1, 1, 1, 1, '2026-09-10'),
      ('${CO_A}', 'online', 'SKU-4', 'Sock B',  3,  5,  15,  20,  60, 1, 1, 1, 1, 1, '2026-09-11'),
      ('${CO_B}', 'online', 'SKU-B', 'Bat',     1,  3,   9,  12,  36, 0.5, 0.1, 0.1, 0.1, 0.1, '2026-08-01');
    refresh materialized view inventory_on_hand_current_mv;
    refresh materialized view sales_velocity_by_sku_location_mv;
  `);
}

/* The migration with company_entity_id taken out of both velocity join keys
 * and out of the fallback aggregate -- the cross-tenant shape the guards exist
 * to refuse. Written as a rewrite of the real migration rather than a copy, so
 * it cannot drift away from what ships. */
function crossTenant(sql) {
  const out = sql
    .replace(/on t\.company_entity_id = i\.company_entity_id\n\s*and /, 'on ')
    .replace(/on a\.company_entity_id = i\.company_entity_id\n\s*and /, 'on ')
    .replace(/select sales_velocity_by_sku_location_mv\.company_entity_id,\n\s*/, 'select ')
    .replace(/group by sales_velocity_by_sku_location_mv\.company_entity_id,\n\s*/, 'group by ');
  assert.notEqual(out, sql, 'the cross-tenant rewrite did not apply to the migration');
  assert.ok(!/company_entity_id = i\.company_entity_id/.test(out),
    'the rewrite left a company join key behind, so it is not testing the cross-tenant shape');
  return out;
}

const VELOCITY_COLS = `qty_7d, sold_30, qty_90d, qty_120d, qty_365d,
  avg_day_7, avg_day_30, avg_day_90, avg_day_120, avg_day_365,
  last_sold_date, days_oos, velocity_basis, velocity_matched, velocity_source`;

const fingerprint = (rel) => `
  select count(*)::int as rows, md5(coalesce(string_agg(h, '' order by id), '')) as fp
  from (select id, md5(row(${VELOCITY_COLS})::text) as h from ${rel}) q`;

// 1. The point of the change: for the active company, the matview returns
//    exactly what the two-wrapper-view join returned. Same rows, same
//    velocity-derived values, byte for byte.
await test('the matview returns the pre-migration view byte for byte', async () => {
  const { db, q } = await fresh();
  await seed(db);
  const before = (await q(fingerprint('inventory_workboard_v')))[0];
  assert.equal(before.rows, 5, 'company A has five inventory rows in the fixture');

  await db.exec(MIGRATION);

  const after = (await q(fingerprint('inventory_workboard_v')))[0];
  assert.equal(after.rows, before.rows, 'the row count must not move');
  assert.equal(after.fp, before.fp,
    'every velocity-derived column of every row must be identical to the pre-migration view');
  await db.close();
});

// 2. Each fixture branch still resolves the way it did -- a matching
//    fingerprint on an all-'none' fixture would prove nothing.
await test('each velocity branch is exercised and resolves as before', async () => {
  const { db, q } = await fresh();
  await seed(db);
  const before = await q(`select id, velocity_source, velocity_basis, sold_30, days_oos
                            from inventory_workboard_v order by id`);
  await db.exec(MIGRATION);
  const after = await q(`select id, velocity_source, velocity_basis, sold_30, days_oos
                           from inventory_workboard_v order by id`);
  assert.deepEqual(after, before);

  const by = Object.fromEntries(after.map((r) => [r.id, r]));
  assert.equal(by[1].velocity_source, 'title', 'the title+sku+location match');
  assert.equal(by[3].velocity_source, 'title', 'the untrimmed/uppercased keys still match');
  assert.equal(by[4].velocity_source, 'sku_fallback', 'title drift falls back to the SKU');
  assert.equal(by[5].velocity_source, 'none', 'two name variants refuse the fallback');
  assert.equal(by[6].velocity_source, 'none', 'nothing anywhere stays unmatched');
  assert.equal(by[6].velocity_basis, 'none');
  assert.equal(Number(by[6].sold_30), 0, 'no velocity anywhere means zero sold');
  assert.equal(by[6].days_oos, null, 'unknown demand is null cover, never zero');
  await db.close();
});

// 3. The company join key, from the other tenant's side. Company B's single
//    colliding row must stay unmatched: the sales belong to company A.
await test('a colliding key does not borrow the other company\'s velocity', async () => {
  const { db, q } = await fresh({ activeCo: CO_B });
  await seed(db);
  const before = await q(`select id, velocity_source, sold_30 from inventory_workboard_v order by id`);
  assert.deepEqual(before.map((r) => [r.id, r.velocity_source]), [[2, 'none'], [7, 'title']],
    'before the migration, B sees no velocity on the colliding row and its own on its own row');

  await db.exec(MIGRATION);

  const after = await q(`select id, velocity_source, sold_30 from inventory_workboard_v order by id`);
  assert.deepEqual(after, before, 'and that must not change');
  await db.close();
});

// 4. The counter-test, and the reason the migration guards the join keys
//    STRUCTURALLY rather than by counting rows. Build the same matview without
//    company in the keys: the migration must refuse it.
await test('the migration refuses a matview built without company in the join keys', async () => {
  const { db } = await fresh();
  await seed(db);
  const naive = crossTenant(MIGRATION);

  await assert.rejects(() => db.exec(naive),
    /does not carry company_entity_id in its velocity join keys/,
    'the structural guard must refuse the cross-tenant shape');
  await db.close();
});

// 4b. ...and why a row count cannot be that guard. This fixture's borrowed
//     match is UNIQUE across the two companies, so the cross-tenant build has
//     exactly the right number of rows and the only symptom is company B's row
//     carrying company A's sales. Counting would have passed it. This is the
//     case that made the structural check necessary rather than belt-and-braces;
//     on production the counts did differ (67,605 -> 68,931), which is luck
//     about the data, not a property of the mistake.
await test('a cross-tenant build can have the right row count and the wrong numbers', async () => {
  const { db, q } = await fresh({ activeCo: CO_B });
  await seed(db);

  // Built directly, bypassing the migration's guards, purely to show the
  // consequence they exist to prevent.
  await db.exec(`
    create materialized view wrong_mv as
      select i.id, i.company_entity_id,
             coalesce(t.qty_30d, 0::bigint) as sold_30,
             t.variant_sku is not null as velocity_matched
        from inventory_on_hand_current_mv i
        left join sales_velocity_by_sku_location_mv t
          on t.location_tag = lower(trim(both from i.location_tag))
         and t.variant_sku = trim(both from i.variant_sku)
         and t.product_name = trim(both from i.product_title);`);

  const counts = (await q(`select (select count(*) from wrong_mv) a,
                                  (select count(*) from inventory_on_hand_current_mv) b`))[0];
  assert.equal(Number(counts.a), Number(counts.b),
    'the row count is identical, so a count-based guard would pass this');

  // Company B's colliding row (id 2) has no sales of its own. Cross-tenant, it
  // picks up company A's 60.
  const borrowed = (await q(`select sold_30, velocity_matched from wrong_mv where id = 2`))[0];
  assert.equal(Number(borrowed.sold_30), 60, 'company B borrowed company A\'s 30-day sales');
  assert.equal(borrowed.velocity_matched, true);

  // What the shipped matview does with the same row.
  await db.exec(MIGRATION);
  const correct = (await q(`select sold_30, velocity_source from inventory_workboard_v where id = 2`))[0];
  assert.equal(Number(correct.sold_30), 0, 'company B has no sales for that SKU and must read zero');
  assert.equal(correct.velocity_source, 'none');
  await db.close();
});

// 4c. The row-count guards still earn their place: they catch the duplication
//     case, where the borrowed key exists in more than one company's velocity
//     rows. That is what fired on production.
await test('the row-count guard catches the duplicating cross-tenant case', async () => {
  const { db } = await fresh();
  await seed(db);
  // Give company B a velocity row on company A's colliding key, so the
  // three-column join matches TWO rows for every inventory row carrying it.
  await db.exec(`
    insert into sales_velocity_src
      (company_entity_id, location_tag, variant_sku, product_name, qty_30d, avg_day_30)
      values ('${CO_B}', 'online', 'SKU-1', 'Tee', 5, 1);
    refresh materialized view sales_velocity_by_sku_location_mv;`);

  // Strip the structural guard so the row-count guard is the one under test.
  const noStructural = crossTenant(MIGRATION)
    .replace(/if \(select count\(\*\) from regexp_matches\(def, 'company_entity_id', 'g'\)\) < 4 then[\s\S]*?end if;/, '');
  await assert.rejects(() => db.exec(noStructural),
    /duplicated or dropped rows|differ per company/,
    'the row-count guard must refuse a join that multiplies inventory rows');
  await db.close();
});

// 5. Row count per company must equal the inventory snapshot's: the velocity
//    joins may neither duplicate nor drop a row. This is the invariant the
//    nightly dead-stock tie-out reconciles.
await test('row counts match the inventory snapshot, per company and in total', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  // No FULL JOIN here either: `is not distinct from` is not a joinable
  // condition, which is how the same shape was caught in the migration.
  const diff = await q(`
    select co::text as co, m, v from (
      select co,
             (select count(*) from inventory_workboard_mv w
               where w.company_entity_id is not distinct from co) as m,
             (select count(*) from inventory_on_hand_current_mv o
               where o.company_entity_id is not distinct from co) as v
        from (select company_entity_id as co from inventory_workboard_mv
              union select company_entity_id from inventory_on_hand_current_mv) cos
    ) q where m <> v`);
  assert.deepEqual(diff, [], 'no company may differ');
  const tot = (await q(`select (select count(*) from inventory_workboard_mv) a,
                               (select count(*) from inventory_on_hand_current_mv) b`))[0];
  assert.equal(tot.a, tot.b);
  await db.close();
});

// 6. The tenant boundary moved into this view's body, so both halves have to
//    hold: definer (or the caller gets 42501 on the matview) AND the filter
//    (or every company's inventory is visible to everyone).
await test('the wrapper is definer, filters by company, and the matview is not granted out', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);

  const opts = (await q(`select coalesce((select option_value from pg_options_to_table(c.reloptions)
                                          where option_name='security_invoker'), 'true') as si
                           from pg_class c join pg_namespace n on n.oid=c.relnamespace
                          where n.nspname='public' and c.relname='inventory_workboard_v'`))[0];
  assert.equal(opts.si, 'false', 'an invoker view over a matview raises 42501 for every user');

  const def = (await q(`select definition from pg_views
                         where schemaname='public' and viewname='inventory_workboard_v'`))[0];
  assert.match(def.definition, /active_company_id\(\)/,
    'without this filter the matview has no tenant boundary at all');

  const grants = (await q(`
    select has_table_privilege('anon','public.inventory_workboard_mv','SELECT') as anon_mv,
           has_table_privilege('authenticated','public.inventory_workboard_mv','SELECT') as auth_mv,
           has_table_privilege('authenticated','public.inventory_workboard_v','SELECT') as auth_v,
           has_function_privilege('authenticated','public.refresh_inventory_workboard_mv()','EXECUTE') as auth_refresh,
           has_function_privilege('anon','public.refresh_inventory_workboard_mv()','EXECUTE') as anon_refresh,
           has_function_privilege('service_role','public.refresh_inventory_workboard_mv()','EXECUTE') as svc_refresh`))[0];
  assert.equal(grants.anon_mv, false, 'the matview carries no RLS, so anon must not reach it');
  assert.equal(grants.auth_mv, false, 'nor authenticated');
  assert.equal(grants.auth_v, true, 'the page reads through the wrapper, which must stay granted');
  assert.equal(grants.auth_refresh, false, 'a browser must not be able to kick a 300s refresh');
  assert.equal(grants.anon_refresh, false);
  assert.equal(grants.svc_refresh, true, 'the nightly sync calls it as service_role');
  await db.close();
});

// 7. The refresh actually propagates, and CONCURRENTLY works from inside the
//    function (it needs the unique index the migration creates). Without this
//    the page would freeze at whatever the migration populated while
//    inventory_on_hand_current_v moved on -- two answers to "what is on hand",
//    and a red dead-stock tie-out with no sign that a refresh was the cause.
await test('the refresh function propagates a change to the inputs', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  assert.equal(Number((await q('select sold_30 from inventory_workboard_v where id = 1'))[0].sold_30), 60);

  await db.exec(`
    update sales_velocity_src set qty_30d = 99
      where company_entity_id = '${CO_A}' and variant_sku = 'SKU-1';
    insert into inventory_on_hand_current_mv_src
      (id, location_tag, variant_sku, product_title, total_available_quantity, company_entity_id)
      values (8, 'online', 'SKU-NEW', 'New', 1, '${CO_A}');
    refresh materialized view sales_velocity_by_sku_location_mv;
    refresh materialized view inventory_on_hand_current_mv;`);

  // Stale until refreshed -- that is what makes the refresh load-bearing.
  assert.equal(Number((await q('select sold_30 from inventory_workboard_v where id = 1'))[0].sold_30), 60);
  assert.deepEqual(await q('select id from inventory_workboard_v where id = 8'), []);

  await db.query('select refresh_inventory_workboard_mv()');

  assert.equal(Number((await q('select sold_30 from inventory_workboard_v where id = 1'))[0].sold_30), 99);
  assert.equal((await q('select count(*)::int n from inventory_workboard_v where id = 8'))[0].n, 1);
  await db.close();
});

// 8. Idempotent: applying it twice must not fail and must not change the rows.
await test('re-running the migration is a no-op', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  const once = (await q(fingerprint('inventory_workboard_v')))[0];
  await db.exec(MIGRATION);
  const twice = (await q(fingerprint('inventory_workboard_v')))[0];
  assert.deepEqual(twice, once);
  await db.close();
});

// 9. ...but it must NOT quietly accept a matview of that name built some other
//    way. Recording the migration against a cross-tenant matview is worse than
//    failing, because nothing downstream would ever say so.
await test('it refuses a pre-existing matview that does not join on company', async () => {
  const { db } = await fresh();
  await seed(db);
  await db.exec(`create materialized view public.inventory_workboard_mv as
                   select 1::bigint as id, 0::bigint as sold_30;`);
  await assert.rejects(() => db.exec(MIGRATION),
    /does not carry company_entity_id in its velocity join keys/,
    'it must refuse rather than record itself against a foreign definition');
  await db.close();
});

// 10. The verify check -- the production copy of it -- must fire before the
//     migration and clear after. A check that cannot go red is not a check.
await test('verify_v2_schema.sql reports MISSING before and ok after', async () => {
  const { db, q } = await fresh();
  await seed(db);
  const before = (await q(VERIFY_BLOCK))[0].inventory_workboard_mv;
  assert.match(before, /^MISSING/, `expected MISSING before the migration, got: ${before}`);

  await db.exec(MIGRATION);

  const after = (await q(VERIFY_BLOCK))[0].inventory_workboard_mv;
  assert.equal(after, 'ok', `expected ok after the migration, got: ${after}`);
  await db.close();
});

// 11. And it must catch each way the tenant boundary can be lost afterwards --
//     these are the states that would put another company's inventory on the
//     page, so each one has to be CRITICAL or BROKEN rather than 'ok'.
await test('verify catches a lost filter, a lost definer flag and a leaked grant', async () => {
  for (const [label, sql, expect] of [
    // security_invoker is kept false here on purpose: `create or replace view`
    // resets it to the default, and verify checks the definer flag BEFORE the
    // filter, so without this the sub-case would be caught by the wrong branch
    // and would not exercise the filter check at all.
    ['the active_company_id() filter is dropped',
     `create or replace view public.inventory_workboard_v with (security_invoker = false) as
        select id, location_tag, source, location, product_title, variant_title,
          variant_sku, shop_domain, variant_barcode, est_oos_date, variant_created_at,
          product_type, product_image, product_image_url, retail_price,
          total_available_quantity, total_available_inventory_value, qty_sold_30d,
          avg_qty_sold_per_day, est_days_before_oos, snapshot_at, row_hash,
          location_name, sync_batch_id, company_entity_id, qty_7d, sold_30, qty_90d,
          qty_120d, qty_365d, avg_day_7, avg_day_30, avg_day_90, avg_day_120,
          avg_day_365, last_sold_date, days_oos, velocity_basis, velocity_matched,
          velocity_source
        from public.inventory_workboard_mv;`,
     /^CRITICAL .* active_company_id/],
    ['the view goes back to security_invoker',
     `alter view public.inventory_workboard_v set (security_invoker = true);`,
     /^BROKEN .* security_invoker/],
    ['the matview is granted to authenticated',
     `grant select on public.inventory_workboard_mv to authenticated;`,
     /^BROKEN .* granted to anon or authenticated/],
    ['the refresh function becomes client-callable',
     `grant execute on function public.refresh_inventory_workboard_mv() to authenticated;`,
     /^BROKEN .* executable by anon or authenticated/],
    ['the refresh function is dropped',
     `drop function public.refresh_inventory_workboard_mv();`,
     /^MISSING .* refresh_inventory_workboard_mv/],
    ['the unique index is dropped',
     `drop index public.inventory_workboard_mv_id_idx;`,
     /^MISSING .* unique index/],
  ]) {
    const { db, q } = await fresh();
    await seed(db);
    await db.exec(MIGRATION);
    assert.equal((await q(VERIFY_BLOCK))[0].inventory_workboard_mv, 'ok', `${label}: clean first`);
    await db.exec(sql);
    const got = (await q(VERIFY_BLOCK))[0].inventory_workboard_mv;
    assert.match(got, expect, `${label}: verify did not catch it, it said: ${got}`);
    await db.close();
  }
});

// 12. The column contract. Every caller names columns by hand -- the report
//     tie-outs, the logistics reports, the insights engine, the canned-report
//     accuracy checks, /v2/inventory.html's 28-column projection -- so a
//     dropped or reordered column is a broken caller, not a cosmetic change.
await test('the view keeps its 40 columns, in order, with the same types', async () => {
  const { db, q } = await fresh();
  await seed(db);
  const cols = (r) => q(`select column_name, data_type from information_schema.columns
                          where table_schema='public' and table_name='${r}'
                          order by ordinal_position`);
  const before = await cols('inventory_workboard_v');
  assert.equal(before.length, 40, 'the fixture view should carry all 40 columns');
  await db.exec(MIGRATION);
  assert.deepEqual(await cols('inventory_workboard_v'), before);
  await db.close();
});

console.log(`\n${passed} checks passed`);
