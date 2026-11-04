// One canonical product title per (company, SKU) (20261104193000), executed in
// a real PostgreSQL (PGlite): the migration verbatim, over the pre-migration
// objects it expects to find.
//
// The defect being closed moved money between rows rather than losing it, so
// totals alone cannot catch it. What these tests pin is WHICH title a SKU gets
// and that one product therefore lands on ONE row: the production case was a
// youth hoodie whose three wholesale-carried sizes took the wholesale
// catalog's word order, splitting 430 units into 151 + 279.
//
// The migration also drops and recreates two views to swap the matview
// underneath them, which is the part that can break a live report outright --
// so the swap is run here, not reasoned about.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/product-title-canonical-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MIGRATION = readFileSync(
  'supabase/migrations/20261104193000_product_title_canonical.sql', 'utf8');
const VERIFY = readFileSync('supabase/verify_v2_schema.sql', 'utf8');

const CO_A = '00000000-0000-4000-a000-00000000000a';
const CO_B = '00000000-0000-4000-a000-00000000000b';

const ONLINE = 'shop-online.myshopify.com';
const MLB = 'shop-mlb.myshopify.com';
const WHOLESALE = 'shop-wholesale.myshopify.com';

const RIGHT = 'Short Sleeve Youth Hoodie - New York Yankees';
const WRONG = 'Short Sleeve Hoodie Youth - New York Yankees';

// The verify arm for this rollup, lifted verbatim out of verify_v2_schema.sql
// so the test runs what production runs rather than a paraphrase.
const VERIFY_BLOCK = (() => {
  const marker = 'end as sales_by_product_title_daily_v;';
  const end = VERIFY.indexOf(marker);
  assert.ok(end > 0, 'verify_v2_schema.sql no longer carries the sales_by_product_title_daily_v check');
  const start = VERIFY.lastIndexOf('\nselect\n', end);
  assert.ok(start > 0, 'could not find the start of the sales_by_product_title_daily_v check');
  return VERIFY.slice(start, end + marker.length);
})();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

/* A database holding what the migration expects to find: the base tables, the
 * PRE-migration matview (title from products_master alone, which is the
 * defect), both views that read it, and the refresh function. */
async function fresh() {
  const db = new PGlite();
  const q = async (sql) => (await db.query(sql)).rows;

  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    -- Production shape: Supabase grants every new relation in public to these
    -- three roles by default, so "create view" during the swap re-grants them
    -- whatever the old ACL said. Without this line the anon assertions below
    -- pass trivially.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

    create function active_company_id() returns uuid language sql stable as
      $$ select current_setting('test.company')::uuid $$;
    create function silo_business_today() returns date language sql stable as
      $$ select current_setting('test.today')::date $$;
    set test.company = '${CO_A}';
    set test.today = '2026-11-04';

    create table sales_by_day(
      id bigserial, company_entity_id uuid, shop_domain text, location_tag text,
      day_date date, product_name text, sku text, product_type text,
      total_quantity_sold integer default 0, total_orders integer default 0,
      total_gross_sales numeric default 0, total_discounts numeric default 0,
      total_refunds numeric default 0, total_net_sales numeric default 0);

    create table products_master(
      company_entity_id uuid, sku text, product_title text, product_type text,
      shop_domain text, shopify_status text,
      constraint products_master_company_sku_key unique (company_entity_id, sku));

    create table shopify_product_skus(
      company_entity_id uuid, shop_domain text, shopify_product_id text,
      shopify_variant_id text, sku text, product_handle text, product_title text,
      variant_title text, shopify_status text, online_published_at timestamptz,
      last_seen_at timestamptz);

    -- Only what product_type_forecastable_v names, so the recreation in the
    -- migration has to actually resolve.
    create table inventory_on_hand_current_mv(
      company_entity_id uuid, product_type text, total_available_quantity numeric);
    create table po_lines(company_entity_id uuid, product_type_snapshot text);
    create table product_type_profile(
      company_entity_id uuid, product_type text, is_forecastable boolean, classification_note text);

    create materialized view public.sales_by_product_title_daily_mv as
    select
      s.company_entity_id,
      coalesce(pm.product_title, s.product_name)             as product_title,
      case when pm.sku is not null then 'products_master'
           else 'sales_fallback' end                         as title_source,
      coalesce(pm.product_type, s.product_type)              as product_type,
      s.location_tag,
      s.day_date,
      count(distinct s.sku)                                  as variant_skus,
      sum(s.total_quantity_sold)                             as units_sold,
      sum(s.total_orders)                                    as orders,
      sum(s.total_gross_sales)                               as gross_sales,
      sum(s.total_discounts)                                 as discounts,
      sum(s.total_refunds)                                   as refunds,
      sum(s.total_net_sales)                                 as net_sales
    from public.sales_by_day s
    left join public.products_master pm
      on pm.sku = s.sku and pm.company_entity_id = s.company_entity_id
    group by 1, 2, 3, 4, 5, 6;

    create unique index sales_by_product_title_daily_mv_key
      on public.sales_by_product_title_daily_mv
         (company_entity_id, product_title, title_source, product_type, location_tag, day_date)
      nulls not distinct;
    create index sales_by_product_title_daily_mv_day_idx
      on public.sales_by_product_title_daily_mv (company_entity_id, day_date);

    revoke all on public.sales_by_product_title_daily_mv from public, anon, authenticated;

    create view public.sales_by_product_title_daily_v with (security_invoker = false) as
    select company_entity_id, product_title, title_source, product_type, location_tag,
           day_date, variant_skus, units_sold, orders, gross_sales, discounts, refunds, net_sales
    from public.sales_by_product_title_daily_mv
    where company_entity_id = public.active_company_id();
    revoke all on public.sales_by_product_title_daily_v from anon;
    grant select on public.sales_by_product_title_daily_v to authenticated;

    create view public.product_type_forecastable_v with (security_invoker = false) as
    with co as (select active_company_id() as cid)
    select s.product_type, round(s.units_365d) as units_365d
      from (select s1.product_type, sum(s1.units_sold) as units_365d
              from sales_by_product_title_daily_mv s1, co
             where s1.company_entity_id = co.cid and s1.product_type is not null
               and s1.day_date >= (silo_business_today() - 365)
             group by s1.product_type) s;
    -- Production's ACL on this one is SELECT alone for authenticated, not the
    -- defaults' full set -- so the replay has something narrower to restore.
    revoke all on public.product_type_forecastable_v from anon, authenticated;
    grant select on public.product_type_forecastable_v to authenticated;

    -- Depth 2. Production's reorder_plan_v reads the WRAPPER, not the matview,
    -- and exists in no migration in this repo -- which is how the first apply
    -- died on "cannot drop view sales_by_product_title_daily_v because other
    -- objects depend on it". Shape, depth and grants are what matter here, not
    -- its real body.
    create view public.reorder_plan_v with (security_invoker = true) as
    select company_entity_id, product_title, sum(units_sold) as units_90d
      from public.sales_by_product_title_daily_v
     group by company_entity_id, product_title;
    comment on view public.reorder_plan_v is 'hand-applied in production; carried across the swap';
    grant select on public.reorder_plan_v to authenticated;
    grant select on public.reorder_plan_v to anon;

    create function public.refresh_sales_by_product_title_mv() returns void
      language plpgsql security definer set search_path = public as $$
    begin
      refresh materialized view public.sales_by_product_title_daily_mv;
    end; $$;
  `);

  return { db, q };
}

/* The hoodie, as production carries it: one online product with four youth
 * sizes, three of which the wholesale catalog also carries under a swapped
 * word order -- and wholesale sorts after the storefront, so products_master
 * kept the wholesale wording for those three. */
async function seedHoodie(db, { company = CO_A } = {}) {
  const sizes = [['YS', 33], ['YM', 78], ['YL', 168], ['YXL', 151]];
  for (const [size, units] of sizes) {
    await db.exec(`
      insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
        product_name, sku, product_type, total_quantity_sold, total_orders,
        total_gross_sales, total_discounts, total_refunds, total_net_sales)
      values ('${company}', '${ONLINE}', 'online', '2025-11-20', '${RIGHT}',
              'HOODIE-${size}', 'Youth Sweatshirt', ${units}, ${units}, ${units * 42},
              ${units}, 0, ${units * 41});
      insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
        shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
      values ('${company}', '${ONLINE}', 'p-online', 'v-online-${size}', 'HOODIE-${size}',
              '${RIGHT}', 'draft', null, '2026-11-04 17:07:00+00');
    `);
  }
  // The three sizes the wholesale catalog also carries, plus the MLB store,
  // which has them PUBLISHED under the right title.
  for (const size of ['YS', 'YM', 'YL']) {
    await db.exec(`
      insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
        shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
      values ('${company}', '${MLB}', 'p-mlb', 'v-mlb-${size}', 'HOODIE-${size}',
              '${RIGHT}', 'active', '2025-08-04 18:58:50+00', '2026-11-04 17:18:00+00'),
             ('${company}', '${WHOLESALE}', 'p-wh', 'v-wh-${size}', 'HOODIE-${size}',
              '${WRONG}', 'draft', null, '2026-11-04 17:28:00+00');
    `);
  }
  // products_master as the per-store sync leaves it: last store to write wins.
  await db.exec(`
    insert into products_master(company_entity_id, sku, product_title, product_type, shop_domain, shopify_status)
    values ('${company}', 'HOODIE-YS', '${WRONG}', 'Youth Sweatshirt', '${WHOLESALE}', 'draft'),
           ('${company}', 'HOODIE-YM', '${WRONG}', 'Youth Sweatshirt', '${WHOLESALE}', 'draft'),
           ('${company}', 'HOODIE-YL', '${WRONG}', 'Youth Sweatshirt', '${WHOLESALE}', 'draft'),
           ('${company}', 'HOODIE-YXL', '${RIGHT}', 'Youth Sweatshirt', '${ONLINE}', 'draft');
  `);
}

const titles = async (q) => q(`
  select product_title, title_source, variant_skus, units_sold, net_sales
    from sales_by_product_title_daily_v order by units_sold desc, product_title`);

// ─── the defect, before and after ────────────────────────────────────────────
await test('before the migration, one product is split across two titles', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec('refresh materialized view public.sales_by_product_title_daily_mv');
  const rows = await titles(q);
  assert.equal(rows.length, 2, 'the pre-migration rollup should show the split this migration exists to fix');
  assert.deepEqual(rows.map((r) => [r.product_title, Number(r.units_sold)]),
    [[WRONG, 279], [RIGHT, 151]]);
});

await test('after the migration, the product is one row at its published title', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec('refresh materialized view public.sales_by_product_title_daily_mv');
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.equal(rows.length, 1, `expected one row, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].product_title, RIGHT);
  assert.equal(Number(rows[0].units_sold), 430);
  assert.equal(Number(rows[0].variant_skus), 4);
  assert.equal(rows[0].title_source, 'products_master');
});

await test('the rollup still ties to sales_by_day to the cent', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec('refresh materialized view public.sales_by_product_title_daily_mv');
  await db.exec(MIGRATION);
  const [row] = await q(`
    select (select sum(units_sold) from sales_by_product_title_daily_mv) as mv_units,
           (select sum(total_quantity_sold) from sales_by_day) as raw_units,
           (select sum(net_sales) from sales_by_product_title_daily_mv) as mv_net,
           (select sum(total_net_sales) from sales_by_day) as raw_net,
           (select sum(gross_sales) from sales_by_product_title_daily_mv) as mv_gross,
           (select sum(total_gross_sales) from sales_by_day) as raw_gross`);
  assert.equal(Number(row.mv_units), Number(row.raw_units));
  assert.equal(Number(row.mv_net), Number(row.raw_net));
  assert.equal(Number(row.mv_gross), Number(row.raw_gross));
});

// ─── the resolution order ────────────────────────────────────────────────────
await test('a published store copy beats a draft that synced more recently', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
      product_name, sku, total_quantity_sold, total_net_sales)
    values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'order line name', 'SKU-1', 5, 50);
    insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
      shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
    values ('${CO_A}', '${MLB}', 'p1', 'v1', 'SKU-1', 'Published Name', 'active',
            '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
           ('${CO_A}', '${WHOLESALE}', 'p2', 'v2', 'SKU-1', 'Draft Name', 'draft',
            null, '2026-11-04 23:59:00+00');
  `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => r.product_title), ['Published Name']);
});

await test('a null shopify_status does not outrank an active one', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
      product_name, sku, total_quantity_sold, total_net_sales)
    values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'order line name', 'SKU-1', 5, 50);
    insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
      shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
    values ('${CO_A}', '${MLB}', 'p1', 'v1', 'SKU-1', 'Published Name', 'active',
            '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
           ('${CO_A}', '${WHOLESALE}', 'p2', 'v2', 'SKU-1', 'Unknown Status Name', null,
            null, '2026-11-04 23:59:00+00');
  `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => r.product_title), ['Published Name']);
});

await test("a variant row with no product title cannot rename the SKU (the 'x-redo' shape)", async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
      product_name, sku, total_quantity_sold, total_net_sales)
    values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'x-redo', 'x-redo', 9, 90);
    insert into products_master(company_entity_id, sku, product_title, shop_domain)
    values ('${CO_A}', 'x-redo', 'x-redo', '${ONLINE}');
    insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
      shopify_variant_id, sku, product_title, shopify_status, last_seen_at)
    values ('${CO_A}', '${ONLINE}', 'p1', 'v1', 'x-redo', null, null, '2026-11-04 17:07:00+00');
  `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => [r.product_title, r.title_source]), [['x-redo', 'products_master']]);
});

await test('products_master still resolves a SKU no store catalog carries', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
      product_name, sku, total_quantity_sold, total_net_sales)
    values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'stale order line name', 'SKU-1', 3, 30);
    insert into products_master(company_entity_id, sku, product_title, shop_domain)
    values ('${CO_A}', 'SKU-1', 'Catalog Name', '${ONLINE}');
  `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => [r.product_title, r.title_source]), [['Catalog Name', 'products_master']]);
});

await test('a SKU in no catalog at all keeps its order-line name, flagged', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
      product_name, sku, total_quantity_sold, total_net_sales)
    values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'Only On The Order', 'SKU-X', 2, 20);
  `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => [r.product_title, r.title_source]),
    [['Only On The Order', 'sales_fallback']]);
});

await test('another company\'s catalog cannot title this company\'s sales', async () => {
  const { db, q } = await fresh();
  await db.exec(`
    insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
      product_name, sku, total_quantity_sold, total_net_sales)
    values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'Our Order Line', 'SHARED-SKU', 4, 40);
    insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
      shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
    values ('${CO_B}', '${MLB}', 'p1', 'v1', 'SHARED-SKU', 'Their Product', 'active',
            '2025-01-01 00:00:00+00', '2026-11-04 00:00:00+00');
  `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => [r.product_title, r.title_source]),
    [['Our Order Line', 'sales_fallback']]);
});

await test('a refresh resolves the same titles again (the tiebreaks are total)', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const before = await titles(q);
  await db.query('select public.refresh_sales_by_product_title_mv()');
  const after = await titles(q);
  assert.deepEqual(after, before);
});

// ─── the swap itself ────────────────────────────────────────────────────────
await test('the swap leaves both views, the grants and the refresh function intact', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const [row] = await q(`
    select to_regclass('public.sales_by_product_title_daily_mv') is not null as mv,
           to_regclass('public.sales_by_product_title_daily_v') is not null as title_v,
           to_regclass('public.product_type_forecastable_v') is not null as forecast_v,
           to_regclass('public.sales_by_product_title_daily_mv_new') is null as temp_gone,
           has_table_privilege('authenticated','public.sales_by_product_title_daily_v','select') as v_readable,
           has_table_privilege('authenticated','public.sales_by_product_title_daily_mv','select') as mv_readable,
           has_table_privilege('anon','public.sales_by_product_title_daily_v','select') as anon_readable,
           exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='refresh_sales_by_product_title_mv') as refresh_fn,
           (select count(*) from pg_indexes
             where schemaname='public' and tablename='sales_by_product_title_daily_mv') as idx`);
  assert.equal(row.mv, true);
  assert.equal(row.title_v, true);
  assert.equal(row.forecast_v, true, 'product_type_forecastable_v was dropped and not recreated');
  assert.equal(row.temp_gone, true, 'the temporary matview was left behind');
  assert.equal(row.v_readable, true);
  assert.equal(row.mv_readable, false, 'the matview carries no RLS; a grant on it is a cross-tenant read');
  assert.equal(row.anon_readable, false);
  assert.equal(row.refresh_fn, true);
  assert.equal(Number(row.idx), 2, 'both indexes should survive the rename');
});

await test('a hand-applied view two levels down survives the swap, with its grants and comment', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const [row] = await q(`
    select to_regclass('public.reorder_plan_v') is not null as present,
           has_table_privilege('authenticated','public.reorder_plan_v','select') as auth_select,
           has_table_privilege('anon','public.reorder_plan_v','select') as anon_select,
           obj_description('public.reorder_plan_v'::regclass) as cmt,
           coalesce((select option_value from pg_options_to_table(
                      (select c.reloptions from pg_class c where c.oid='public.reorder_plan_v'::regclass))
                     where option_name='security_invoker'), 'true') as invoker`);
  assert.equal(row.present, true, 'reorder_plan_v was dropped and not recreated');
  assert.equal(row.auth_select, true, 'reorder_plan_v lost its grant to authenticated');
  assert.equal(row.anon_select, true, 'the replay must put back the grants it found, not the defaults');
  assert.equal(row.cmt, 'hand-applied in production; carried across the swap');
  assert.equal(row.invoker, 'true', 'the replay must preserve security_invoker, or an invoker view silently becomes a definer one');
});

await test('the carried view reads the NEW rollup, not a stale copy', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const rows = await q('select product_title, units_90d from reorder_plan_v order by units_90d desc');
  assert.equal(rows.length, 1, `expected the un-split product, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].product_title, RIGHT);
  assert.equal(Number(rows[0].units_90d), 430);
});

await test('the recreated product_type_forecastable_v still answers', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const rows = await q('select * from product_type_forecastable_v');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_type, 'Youth Sweatshirt');
  assert.equal(Number(rows[0].units_365d), 430);
});

await test('the view keeps its column names and ORDER', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const cols = (await q(`select column_name from information_schema.columns
    where table_schema='public' and table_name='sales_by_product_title_daily_v'
    order by ordinal_position`)).map((r) => r.column_name);
  assert.deepEqual(cols, ['company_entity_id', 'product_title', 'title_source', 'product_type',
    'location_tag', 'day_date', 'variant_skus', 'units_sold', 'orders', 'gross_sales',
    'discounts', 'refunds', 'net_sales']);
});

await test('verify_v2_schema reports ok once the canonical join is in place', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  await db.exec(MIGRATION);
  const [row] = await q(VERIFY_BLOCK);
  assert.equal(row.sales_by_product_title_daily_v, 'ok');
});

await test('verify_v2_schema goes red when the canonical join is gone', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);
  const [row] = await q(VERIFY_BLOCK);   // pre-migration: products_master only
  assert.match(String(row.sales_by_product_title_daily_v), /canonical title join is gone/);
});

await test('an untitled variant row never costs a SKU its catalog title', async () => {
      const { db, q } = await fresh();
      await db.exec(`
        insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
          product_name, sku, total_quantity_sold, total_net_sales)
        values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'Order Line Spelling', 'SKU-N', 7, 70);
        insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
          shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
        values ('${CO_A}', '${MLB}', 'p1', 'v1', 'SKU-N', null, 'active',
                '2025-01-01 00:00:00+00', '2026-11-04 00:00:00+00'),
               ('${CO_A}', '${ONLINE}', 'p2', 'v2', 'SKU-N', 'Catalog Spelling', 'draft',
                null, '2026-01-01 00:00:00+00');
      `);
  await db.exec(MIGRATION);
  const rows = await titles(q);
  assert.deepEqual(rows.map((r) => [r.product_title, r.title_source]),
    [['Catalog Spelling', 'products_master']]);
});

await test('the recreated views carry the ACL they had, not the creation defaults', async () => {
  const { db, q } = await fresh();
  await seedHoodie(db);

  // What the swap has to restore, read before it runs.
  const acl = async () => q(`
    select c.relname,
           coalesce((select string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
                       from aclexplode(c.relacl) a
                      where a.grantee = 'anon'::regrole), '') as anon,
           coalesce((select string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
                       from aclexplode(c.relacl) a
                      where a.grantee = 'authenticated'::regrole), '') as authenticated
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('sales_by_product_title_daily_v', 'product_type_forecastable_v', 'reorder_plan_v')
     order by c.relname`);

  const before = await acl();
  await db.exec(MIGRATION);
  const after = await acl();

  assert.deepEqual(after, before,
    'a recreated view came back with Supabase\'s default grants layered on top of its old ACL');

  // Stated explicitly, so the intent survives a fixture change: anon was
  // revoked on both wrappers and must stay revoked; reorder_plan_v's anon
  // grant is real and must survive; and authenticated held SELECT alone on
  // product_type_forecastable_v, not the defaults' full set.
  const [row] = await q(`
    select has_table_privilege('anon','public.sales_by_product_title_daily_v','select') as anon_title_v,
           has_table_privilege('anon','public.product_type_forecastable_v','select')    as anon_forecast_v,
           has_table_privilege('anon','public.reorder_plan_v','select')                 as anon_reorder_v,
           has_table_privilege('authenticated','public.product_type_forecastable_v','insert') as auth_insert,
           has_table_privilege('anon','public.sales_by_product_title_daily_mv','select') as anon_mv`);
  assert.equal(row.anon_title_v, false, 'anon regained the company-filtered wrapper');
  assert.equal(row.anon_forecast_v, false, 'anon regained product_type_forecastable_v');
  assert.equal(row.anon_reorder_v, true, 'the intentional anon grant on reorder_plan_v was stripped');
  assert.equal(row.auth_insert, false, 'the creation defaults left authenticated more than the SELECT it had');
  assert.equal(row.anon_mv, false, 'the matview carries no RLS; anon must not reach it');
});

// ─── mutations: break the fix, the tests must notice ────────────────────────
const MUTATIONS = [
  ['the canonical join removed (back to products_master alone)',
   'left join canonical_title ct\n  on ct.sku = s.sku\n and ct.company_entity_id = s.company_entity_id',
   'left join canonical_title ct\n  on false'],
  ['the company key dropped from the canonical join',
   'left join canonical_title ct\n  on ct.sku = s.sku\n and ct.company_entity_id = s.company_entity_id',
   'left join canonical_title ct\n  on ct.sku = s.sku'],
  ['the published-copy preference dropped',
   "    (coalesce(ps.shopify_status, '') = 'active') desc,\n    (ps.online_published_at is not null) desc,\n    ps.last_seen_at desc nulls last,",
   '    ps.last_seen_at desc nulls last,'],
  ['the null-status guard dropped (null would outrank active)',
   "    (coalesce(ps.shopify_status, '') = 'active') desc,\n    (ps.online_published_at is not null) desc,",
   "    (ps.shopify_status = 'active') desc,\n    (ps.online_published_at is not null) desc,"],
  ['the untitled-variant filter dropped',
   "  where ps.sku is not null\n    and ps.product_title is not null",
   '  where ps.sku is not null'],
  // The failure production actually hit: a closure that stops at depth 1
  // cannot drop the wrapper, because reorder_plan_v still reads it.
  ['the dependency closure capped at depth 1 (the production apply failure)',
   '       and closure.lvl < 10',
   '       and closure.lvl < 1'],
  // The replay grants but never revokes, so Supabase's default privileges on
  // a freshly created view survive underneath the captured ACL.
  ['the creation-default grants left in place before the ACL replay',
   "                 and a.grantee <> c.relowner",
   '                 and false'],
  ['the dependent views never recreated',
   "  -- Shallowest first, each exactly as it was found.\n  for dep in select d from jsonb_array_elements(deps) d order by (d->>'lvl')::int loop",
   "  -- Shallowest first, each exactly as it was found.\n  for dep in select d from jsonb_array_elements(deps) d where false loop"],
];

for (const [name, from, to] of MUTATIONS) {
  await test(`mutation caught: ${name}`, async () => {
    assert.ok(MIGRATION.includes(from), `mutation target not found: ${name}`);
    const mutated = MIGRATION.replace(from, to);
    assert.notEqual(mutated, MIGRATION);

    const checks = [];

    // The hoodie must stop landing on one row at the published title.
    {
      const { db, q } = await fresh();
      await seedHoodie(db);
      await db.exec('refresh materialized view public.sales_by_product_title_daily_mv');
      let failed = false;
      try {
        await db.exec(mutated);
        const rows = await titles(q);
        failed = !(rows.length === 1 && rows[0].product_title === RIGHT && Number(rows[0].units_sold) === 430);
      } catch { failed = true; }   // the migration's own assertions may refuse it
      checks.push(failed);
    }

    // Cross-company isolation and the x-redo shape have their own arms, since
    // two of the mutations are invisible in the hoodie fixture alone.
    {
      const { db, q } = await fresh();
      await db.exec(`
        insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
          product_name, sku, total_quantity_sold, total_net_sales)
        values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'Our Order Line', 'SHARED-SKU', 4, 40),
               ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'x-redo', 'x-redo', 9, 90);
        insert into products_master(company_entity_id, sku, product_title, shop_domain)
        values ('${CO_A}', 'x-redo', 'x-redo', '${ONLINE}');
        insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
          shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
        values ('${CO_B}', '${MLB}', 'p1', 'v1', 'SHARED-SKU', 'Their Product', 'active',
                '2025-01-01 00:00:00+00', '2026-11-04 00:00:00+00'),
               ('${CO_A}', '${ONLINE}', 'p2', 'v2', 'x-redo', null, null, null, '2026-11-04 17:07:00+00');
      `);
      let failed = false;
      try {
        await db.exec(mutated);
        const got = (await titles(q)).map((r) => r.product_title).sort();
        failed = JSON.stringify(got) !== JSON.stringify(['Our Order Line', 'x-redo']);
      } catch { failed = true; }
      checks.push(failed);
    }

    // A store copy with no status must not outrank a published one.
    {
      const { db, q } = await fresh();
      await db.exec(`
        insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
          product_name, sku, total_quantity_sold, total_net_sales)
        values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'order line name', 'SKU-1', 5, 50);
        insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
          shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
        values ('${CO_A}', '${MLB}', 'p1', 'v1', 'SKU-1', 'Published Name', 'active',
                '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
               ('${CO_A}', '${WHOLESALE}', 'p2', 'v2', 'SKU-1', 'Unknown Status Name', null,
                null, '2026-11-04 23:59:00+00');
      `);
      let failed = false;
      try {
        await db.exec(mutated);
        const got = (await titles(q)).map((r) => r.product_title);
        failed = JSON.stringify(got) !== JSON.stringify(['Published Name']);
      } catch { failed = true; }
      checks.push(failed);
    }

    // An untitled variant row must not win the pick and blank the title.
    {
      const { db, q } = await fresh();
      await db.exec(`
        insert into sales_by_day(company_entity_id, shop_domain, location_tag, day_date,
          product_name, sku, total_quantity_sold, total_net_sales)
        values ('${CO_A}', '${ONLINE}', 'online', '2026-11-01', 'Order Line Spelling', 'SKU-N', 7, 70);
        insert into shopify_product_skus(company_entity_id, shop_domain, shopify_product_id,
          shopify_variant_id, sku, product_title, shopify_status, online_published_at, last_seen_at)
        values ('${CO_A}', '${MLB}', 'p1', 'v1', 'SKU-N', null, 'active',
                '2025-01-01 00:00:00+00', '2026-11-04 00:00:00+00'),
               ('${CO_A}', '${ONLINE}', 'p2', 'v2', 'SKU-N', 'Catalog Spelling', 'draft',
                null, '2026-01-01 00:00:00+00');
      `);
      let failed = false;
      try {
        await db.exec(mutated);
        const got = (await titles(q)).map((r) => [r.product_title, r.title_source]);
        failed = JSON.stringify(got) !== JSON.stringify([['Catalog Spelling', 'products_master']]);
      } catch { failed = true; }
      checks.push(failed);
    }

    // The recreated views must not come back with the creation defaults.
    {
      const { db, q } = await fresh();
      await seedHoodie(db);
      let failed = false;
      try {
        await db.exec(mutated);
        const [row] = await q(`
          select has_table_privilege('anon','public.sales_by_product_title_daily_v','select') as a1,
                 has_table_privilege('anon','public.product_type_forecastable_v','select') as a2,
                 has_table_privilege('authenticated','public.product_type_forecastable_v','insert') as a3,
                 has_table_privilege('anon','public.reorder_plan_v','select') as keep`);
        failed = row.a1 || row.a2 || row.a3 || !row.keep;
      } catch { failed = true; }
      checks.push(failed);
    }

    // Every view in the closure must come back, readable and reading the new rollup.
    {
      const { db, q } = await fresh();
      await seedHoodie(db);
      let failed = false;
      try {
        await db.exec(mutated);
        const [row] = await q(`
          select to_regclass('public.reorder_plan_v') is not null as reorder_v,
                 to_regclass('public.sales_by_product_title_daily_v') is not null as title_v,
                 to_regclass('public.product_type_forecastable_v') is not null as forecast_v`);
        failed = !(row.reorder_v && row.title_v && row.forecast_v);
        if (!failed) {
          const rows = await q('select product_title from reorder_plan_v');
          failed = !(rows.length === 1 && rows[0].product_title === RIGHT);
        }
      } catch { failed = true; }
      checks.push(failed);
    }

    assert.ok(checks.some(Boolean), `mutation produced identical behaviour: ${name}`);
  });
}

console.log(`\n${passed} tests passed`);
