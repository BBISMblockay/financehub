// Marketing and inventory SILO reports (20260925150000), executed in a real
// PostgreSQL (PGlite): the deployed SQL from the migration, with parameters
// substituted by the browser's own report-params.js, over fixtures whose
// answers are known. Covers grain, totals, missing data, expired
// thumbnails and image fallbacks, and runs every tie-out the migration
// writes.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/marketing-inventory-reports-database.test.mjs
// Set DUMP_TIEOUTS=<file> to write the generated tie-out SQL (guard
// replaced by `true`) for a read-only reconciliation against production.
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(readFileSync('v3/js/report-params.js', 'utf8'), ctx);
const P = ctx.window.SiloReportParams;
const migration = readFileSync('supabase/migrations/20260925150000_marketing_inventory_reports.sql', 'utf8');

const ATTR = 'c3000000-0000-4000-a000-000000000005';
const CREATIVE = 'c3000000-0000-4000-a000-00000000000a';
const INV = 'c1000000-0000-4000-a000-000000000001';
const OVER = 'c1000000-0000-4000-a000-000000000007';

// Meta's `oe` is the expiry as hex epoch seconds.
const oe = (iso) => Math.floor(Date.parse(iso) / 1000).toString(16);
const LIVE = `https://scontent.xx.fbcdn.net/v/t45/a1.jpg?stp=c0.5000x0.5000f_dst-emg0_p64x64&_nc_cat=1&oe=${oe('2100-01-01T00:00:00Z')}`;
const DEAD = `https://scontent.xx.fbcdn.net/v/t45/a2.jpg?stp=p64x64&oe=${oe('2020-01-01T00:00:00Z')}`;

await db.exec(`
create function active_company_id() returns uuid language sql as $$ select '00000000-0000-4000-a000-000000000001'::uuid $$;
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
create function silo_channel_location_tags(text) returns text[] language sql as $$ select case when $1 = 'online' then array['online'] else array[]::text[] end $$;
set test.today = '2026-09-20';

create table silo_chat_saved_reports(id uuid primary key, title text, description text, queries_run text[], parameters jsonb default '[]',
  columns_metadata jsonb, source text, company_entity_id uuid, visibility text);
create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text, check_sql text,
  tolerance numeric, enabled boolean default true, note text, unique(report_id, name));
insert into silo_chat_saved_reports(id, title, source, queries_run) values
 ('${ATTR}', 'Attribution vs Sales', 'system', array['select 1']),
 ('${INV}', 'Inventory Summary', 'system', array['select 1']),
 ('${OVER}', 'Overstock', 'system', array['select 1']);

create table marketing_kpis_daily(company_entity_id uuid default active_company_id(), day_date date, platform text, campaign_id text,
  campaign_name text, spend numeric, impressions bigint default 0, clicks bigint default 0, conversions numeric default 0, conversion_value numeric);
create table sales_by_day(company_entity_id uuid default active_company_id(), day_date date, location_tag text, total_net_sales numeric);
create view sales_by_day_verification_v as select * from sales_by_day where company_entity_id = active_company_id();
create table meta_ad_performance_daily(company_entity_id uuid default active_company_id(), day_date date, campaign_id text, campaign_name text,
  ad_id text, ad_name text, spend numeric, impressions bigint default 0, clicks bigint default 0, conversions numeric default 0, conversion_value numeric);
create table meta_ad_creatives(company_entity_id uuid default active_company_id(), ad_id text, thumbnail_url text, object_type text, preview_shareable_link text);

create table demand_coverage_by_type_v(product_type text, has_inventory boolean, units_on_hand numeric, units_on_order numeric,
  units_12m numeric, units_3m numeric, units_per_week_12m numeric, units_per_week_3m numeric, weeks_of_cover numeric, momentum_pct numeric);
create table sales_monthly_product_type_rollup_v(product_type text, month_start date, units numeric);
create table inventory_on_hand_current_v(company_entity_id uuid default active_company_id(), variant_sku text, product_type text,
  product_title text, variant_title text, product_image_url text, total_available_quantity numeric);
create table v_po_incoming_lines(sku text, product_type text, product_title text, variant_title text, qty numeric, status text, expected_arrival_date date);
create table po_headers(id int primary key, status text);
create table po_lines(company_entity_id uuid default active_company_id(), po_header_id int, sku_snapshot text, qty numeric);
create table sales_velocity_by_sku_location_v(variant_sku text, location_tag text, qty_365d numeric, qty_90d numeric, last_sold_date date);
create table products_master(company_entity_id uuid default active_company_id(), sku text, image_url text);

-- Window with defaults: 2026-08-23 .. 2026-09-19.
insert into marketing_kpis_daily(day_date, platform, campaign_id, campaign_name, spend, conversion_value, conversions, clicks, impressions) values
 ('2026-09-01','meta_ads','C1','Fall drop',100,300,3,15,1500),
 ('2026-09-02','meta_ads','C1','Fall drop',50,100,1,5,500),
 ('2026-09-01','google_ads','G1','Brand search',20,60,2,40,400),
 ('2026-09-01','ga4',null,null,0,999,9,0,0),
 ('2026-09-20','meta_ads','C1','Fall drop',999,999,9,9,9);
insert into sales_by_day(day_date, location_tag, total_net_sales) values
 ('2026-09-01','online',400),('2026-09-02','online',100),('2026-09-01','retail',5000),('2026-09-20','online',999);
insert into meta_ad_performance_daily(day_date, campaign_id, campaign_name, ad_id, ad_name, spend, conversion_value, conversions, clicks, impressions) values
 ('2026-09-01','C1','Fall drop','A1','Hero video',60,200,2,10,1000),
 ('2026-09-01','C1','Fall drop','A2','Carousel',40,100,1,5,500),
 ('2026-09-02','C1','Fall drop','A1','Hero video',50,100,1,5,500),
 ('2026-09-02','C1','Fall drop','A3',null,0,0,0,0,10),
 ('2026-09-20','C1','Fall drop','A1','Hero video',999,999,9,9,9);
insert into meta_ad_creatives(ad_id, thumbnail_url, object_type, preview_shareable_link) values
 ('A1','${LIVE}','VIDEO','https://fb.me/adpreview1'),
 ('A2','${DEAD}','SHARE','https://fb.me/adpreview2');

insert into demand_coverage_by_type_v values
 ('Tees',true,100,50,520,100,10,7.7,15.0,-23.1),
 ('Parts',true,10,0,null,null,null,null,null,null),
 ('Toddler Pack',true,20,0,null,null,null,null,null,null),
 ('Gift Wrap',true,5,0,null,null,null,null,null,null),
 ('Jersey',true,3,0,-1,null,0,null,null,null),
 ('Bags',false,0,30,null,null,null,null,null,null),
 ('Retired',true,0,0,null,null,null,null,null,null),
 ('Tube',true,1000,0,52,null,1,null,1000.0,null),
 ('Pins',true,600,0,520,260,10,20,60.0,100.0),
 ('Boxers',true,129,3000,82,12,1.6,0.9,1984.2,-41.5);
insert into sales_monthly_product_type_rollup_v values ('Toddler Pack','2026-09-01',7),('Tees','2026-08-01',40);
insert into inventory_on_hand_current_v(variant_sku, product_type, product_title, variant_title, product_image_url, total_available_quantity) values
 ('TEE-S','Tees','Tee','S','https://cdn.shopify.com/tee.jpg',60),
 ('TEE-M','Tees','Tee','M',null,40),
 ('PART-1','Parts','Part',null,'',10),
 ('TOD-1','Toddler Pack','Toddler',null,null,20),
 ('GIFT-1','Gift Wrap','Gift wrap',null,null,5),
 ('JER-1','Jersey','Jersey',null,null,3),
 ('TUBE-1','Tube','Tube',null,null,1000),
 ('PIN-1','Pins','Pin',null,null,600),
 ('BOX-1','Boxers','Boxer',null,null,129),
 ('NOTYPE-1','','Mystery',null,null,7);
insert into v_po_incoming_lines values
 ('TEE-L','Tees','Tee','L',50,'In Production','2026-10-15'),
 ('BAG-1','Bags','Bag',null,30,'Sent to Factory','2026-11-01'),
 ('BOX-1','Boxers','Boxer',null,3000,'Confirmed','2026-10-01'),
 ('TEE-S','Tees','Tee','S',999,'Draft','2026-12-01'),
 ('TEE-S','Tees','Tee','S',888,'Received','2026-08-01');
insert into po_headers values (1,'In Production'),(2,'Sent to Factory'),(3,'Confirmed'),(4,'Draft'),(5,'Received');
insert into po_lines(po_header_id, sku_snapshot, qty) values (1,'TEE-L',50),(2,'BAG-1',30),(3,'BOX-1',3000),(4,'TEE-S',999),(5,'TEE-S',888);
insert into sales_velocity_by_sku_location_v values
 ('TEE-S','online',400,100,'2026-09-18'),('TEE-M','online',120,30,'2026-09-17'),
 ('GIFT-1','online',12,3,'2026-09-02'),('JER-1','online',-1,0,'2025-10-26'),
 ('PART-1','online',0,0,'2024-04-09'),('TOD-1','online',7,7,'2026-09-10'),
 ('TUBE-1','online',52,0,'2026-02-01'),('PIN-1','online',520,260,'2026-09-19'),('BOX-1','online',82,12,'2026-09-01');
insert into products_master(sku, image_url) values ('TEE-M','https://cdn.shopify.com/tee-m.jpg'),('PART-1','');
`);

await db.exec(migration);

const report = async (id) => (await q(`select * from silo_chat_saved_reports where id = '${id}'`))[0];
async function run(id, index, values = {}) {
  const r = await report(id);
  const out = P.substitute(r.queries_run[index], r.parameters, P.defaultsFor(P.normalizeDeclarations(r.parameters), values));
  assert.ok(out.sql, out.error);
  // Relative date tokens resolve against the SERVER's today via
  // silo_business_today(), which the fixture pins.
  return q(out.sql.replace(/;\s*$/, ''));
}
const num = (v) => (v === null || v === undefined ? null : Number(v));

await test('the migration keeps the existing reports and adds exactly one', async () => {
  const rows = await q('select id, title from silo_chat_saved_reports order by id');
  assert.deepEqual(rows.map((r) => r.id).sort(), [INV, OVER, ATTR, CREATIVE].sort());
  assert.equal((await report(CREATIVE)).source, 'system');
  assert.equal((await report(CREATIVE)).company_entity_id, null);
});

await test('every {{token}} in every query is declared', async () => {
  for (const id of [ATTR, CREATIVE, INV, OVER]) {
    const r = await report(id);
    const keys = new Set(P.normalizeDeclarations(r.parameters).map((d) => d.key));
    for (const sql of r.queries_run) for (const t of P.tokensIn(sql)) assert.ok(keys.has(t), `${r.title}: {{${t}}}`);
  }
});

await test('every rate is declared a 0-1 fraction, never a guessed percent', async () => {
  for (const id of [ATTR, CREATIVE, INV, OVER]) {
    const meta = (await report(id)).columns_metadata;
    for (const [k, v] of Object.entries(meta)) if (k !== '_queries') assert.notEqual(v.semantic, 'percent', `${id} ${k}`);
  }
});

await test('every _queries entry names a real query', async () => {
  for (const id of [ATTR, CREATIVE, INV]) {
    const r = await report(id);
    const entries = r.columns_metadata._queries;
    assert.equal(entries.length, r.queries_run.length, r.title);
    entries.forEach((e, i) => { assert.equal(e.index, i); assert.ok(e.title); });
  }
});

await test('Attribution: one row per ad platform, GA4 excluded, window respected', async () => {
  const rows = await run(ATTR, 0);
  assert.deepEqual(rows.map((r) => r.platform), ['meta_ads', 'google_ads']);
  const meta = rows[0];
  assert.deepEqual([num(meta.spend), num(meta.platform_credited_revenue), num(meta.claimed_roas)], [150, 400, 2.67]);
  assert.equal(num(meta.share_of_platform_claims), 0.8696, 'a 0-1 fraction, declared so');
  assert.equal(num(meta.claim_as_pct_of_online_sales), 0.8, 'a claim against ALL online sales, never an allocation');
  assert.equal(num(rows[1].claim_as_pct_of_online_sales), 0.12);
  assert.ok(!Object.keys(meta).some((k) => /real/.test(k)), 'no column claims to be real ROAS');
});

await test('Attribution: platform rows add to the combined summary', async () => {
  const [s] = await run(ATTR, 1);
  const rows = await run(ATTR, 0);
  assert.equal(num(s.ad_spend), rows.reduce((a, r) => a + num(r.spend), 0));
  assert.equal(num(s.platforms_claim), rows.reduce((a, r) => a + num(r.platform_credited_revenue), 0));
  assert.deepEqual([num(s.online_net_sales), num(s.online_sales_per_ad_dollar), num(s.claim_ratio), num(s.days_missing_a_source)],
    [500, 2.94, 0.92, 0]);
});

await test('Attribution: a day missing from one source blanks every cross-source figure', async () => {
  await db.exec(`insert into sales_by_day(day_date, location_tag, total_net_sales) values ('2026-09-03','online',50)`);
  const [s] = await run(ATTR, 1);
  assert.equal(s.online_sales_per_ad_dollar, null);
  assert.equal(s.claim_ratio, null);
  assert.equal(num(s.days_missing_a_source), 1);
  assert.equal(num(s.claimed_roas), 2.71, 'a same-source ratio is unaffected');
  for (const r of await run(ATTR, 0)) assert.equal(r.claim_as_pct_of_online_sales, null);
  await db.exec(`delete from sales_by_day where day_date = '2026-09-03'`);
});

await test('Creative: Meta at ad grain, Google at campaign grain and labelled so', async () => {
  const rows = await run(CREATIVE, 2);
  const meta = rows.filter((r) => r.platform === 'meta_ads');
  assert.deepEqual(meta.map((r) => r.ad_id).sort(), ['A1', 'A2', 'A3'], 'one row per ad, days collapsed');
  const google = rows.filter((r) => r.platform === 'google_ads');
  assert.equal(google.length, 1);
  assert.equal(google[0].grain, 'Campaign (no ad-level data)');
  assert.equal(google[0].ad, 'Brand search (Google campaign)', 'named as a campaign, never passed off as an ad');
  assert.equal(google[0].thumbnail, null);
  assert.match(google[0].media_status, /campaign level/);
});

await test('Creative: a live thumbnail is kept, an expired one is withheld with its reason', async () => {
  const rows = await run(CREATIVE, 2);
  const by = Object.fromEntries(rows.filter((r) => r.ad_id).map((r) => [r.ad_id, r]));
  assert.equal(by.A1.thumbnail, LIVE);
  assert.equal(by.A1.ad_preview, 'https://fb.me/adpreview1');
  assert.equal(by.A1.format, 'Video');
  assert.equal(by.A2.thumbnail, null, 'an expired signed URL would draw a broken image');
  assert.match(by.A2.media_status, /expired/);
  assert.equal(by.A2.ad_preview, 'https://fb.me/adpreview2', 'the preview link survives the thumbnail');
  assert.equal(by.A3.media_status, 'Creative not synced');
  assert.equal(by.A3.ad, 'A3', 'an unnamed ad falls back to its id');
  assert.equal(num(by.A1.ctr), 0.01, 'CTR is a 0-1 fraction: 15 clicks / 1,500 impressions');
});

await test('Creative: platform, campaign, ad and daily views all total the same spend', async () => {
  const sums = [];
  for (const i of [0, 1, 2, 3]) sums.push((await run(CREATIVE, i)).reduce((a, r) => a + num(r.spend), 0));
  assert.deepEqual(sums, [170, 170, 170, 170]);
  const byPlat = await run(CREATIVE, 0);
  assert.equal(num(byPlat.find((r) => r.platform === 'meta_ads').ads), 2, 'ads with spend');
});

await test('Creative: the platform filter narrows every query', async () => {
  for (const i of [0, 1, 2, 3]) {
    const rows = await run(CREATIVE, i, { platform: 'google_ads' });
    assert.ok(rows.length && rows.every((r) => r.platform === 'google_ads'), `query ${i}`);
  }
  const bad = P.substitute('select {{platform}}', (await report(CREATIVE)).parameters, { platform: "x' or 1=1" });
  assert.ok(bad.error, 'an undeclared option is refused');
});

await test('Inventory total: legacy columns unchanged, measured cover with its exclusions', async () => {
  const [t] = await run(INV, 0);
  assert.equal(num(t.units_on_hand), 1867);
  assert.equal(num(t.units_on_order), 3080);
  assert.equal(t.weeks_of_cover, null, 'portfolio cover stays blank while stock is unmeasured');
  assert.equal(t.weeks_on_hand, null);
  // measured types: Tees, Tube, Pins, Boxers -> (100+50+1000+600+129+3000)/(1174/52)
  assert.equal(num(t.weeks_of_cover_measured), Math.round((4879 / (1174 / 52)) * 10) / 10);
  assert.equal(num(t.units_without_measured_demand), 10 + 20 + 5 + 3 + 30);
  assert.equal(num(t.types_without_measured_demand), 5);
});

await test('Inventory by type: every unmeasured type says why', async () => {
  const rows = await run(INV, 1);
  const status = Object.fromEntries(rows.map((r) => [r.product_type, r.demand_status]));
  assert.deepEqual(status, {
    Parts: 'No sales in 12 months', 'Toddler Pack': 'First sales this month', 'Gift Wrap': 'Sold under another product type',
    Jersey: 'Net returns (12 months)', Bags: 'On order; no sales under this type name',
    Tees: 'Measured', Tube: 'Measured', Pins: 'Measured', Boxers: 'Measured',
  });
  assert.ok(!('Retired' in status), 'a type with nothing on hand or on order is not listed');
  assert.equal(num(rows.find((r) => r.product_type === 'Toddler Pack').units_this_month), 7);
  const [t] = await run(INV, 0);
  assert.equal(rows.reduce((a, r) => a + num(r.units_on_hand), 0), num(t.units_on_hand));
  assert.equal(rows.reduce((a, r) => a + num(r.units_on_order), 0), num(t.units_on_order));
  assert.ok(!('image' in rows[0]), 'type totals carry no photo');
});

await test('Inventory by SKU: grain, incoming only from open POs, image fallback', async () => {
  const rows = await run(INV, 2);
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
  assert.equal(by['TEE-S'].image, 'https://cdn.shopify.com/tee.jpg', 'Shopify inventory image first');
  assert.equal(by['TEE-M'].image, 'https://cdn.shopify.com/tee-m.jpg', 'products_master when inventory has none');
  assert.equal(by['PART-1'].image, null, 'blank strings are not images');
  assert.equal(num(by['TEE-S'].units_on_order), 0, 'Draft and Received are not incoming');
  assert.equal(num(by['TEE-L'].units_on_order), 50);
  assert.equal(by['TEE-L'].demand_status, 'On order, never sold');
  assert.equal(by['JER-1'].demand_status, 'Net returns (365 days)');
  assert.equal(by['PART-1'].demand_status, 'No sales in 365 days');
  assert.equal(by['NOTYPE-1'].product_type, '(no product type)');
  assert.equal(by['NOTYPE-1'].demand_status, 'No sales recorded');
  assert.equal(num(by['TEE-S'].weeks_on_hand), 7.8);
  assert.equal(by['PART-1'].weeks_on_hand, null, 'no demand, no cover -- never zero, never infinite');
  const typed = rows.filter((r) => r.product_type !== '(no product type)');
  const [t] = await run(INV, 0);
  assert.equal(typed.reduce((a, r) => a + num(r.units_on_hand), 0), num(t.units_on_hand), 'SKU rows sum back to the total');
});

await test('Overstock: every type over the threshold, declining as a filter', async () => {
  const all = await run(OVER, 0);
  assert.deepEqual(all.map((r) => r.product_type), ['Tube', 'Boxers', 'Pins']);
  assert.deepEqual(all.map((r) => r.demand_trend), ['No sales in last 3 months', 'Declining', 'Not declining']);
  assert.equal(num(all.find((r) => r.product_type === 'Boxers').units_on_order), 3000, 'incoming shown separately');
  assert.equal(num(all.find((r) => r.product_type === 'Boxers').weeks_on_hand), 81.8, 'on-hand cover excludes incoming');
  assert.deepEqual((await run(OVER, 0, { trend: 'declining' })).map((r) => r.product_type), ['Tube', 'Boxers']);
  assert.deepEqual((await run(OVER, 0, { min_weeks: '70' })).map((r) => r.product_type), ['Tube', 'Boxers']);
});

const checks = await q('select report_id, name, kind, check_sql, tolerance from silo_report_tieouts order by report_id, name');
await test('every edited or new report has a reconciliation tie-out, and every tie-out passes', async () => {
  for (const id of [ATTR, CREATIVE, INV, OVER]) {
    assert.ok(checks.some((c) => c.report_id === id && c.kind === 'reconciliation'), id);
  }
  for (const c of checks) {
    const [r] = await q(c.check_sql);
    assert.notEqual(r.left_value, null, `${c.name}: NO DATA`);
    assert.ok(Math.abs(num(r.left_value) - num(r.right_value)) <= num(c.tolerance), `${c.name}: ${r.left_value} vs ${r.right_value}`);
  }
});

await test('a changed definition turns its tie-outs to NO DATA', async () => {
  await db.exec(`update silo_chat_saved_reports set queries_run = queries_run || array['select 2'] where id = '${OVER}'`);
  const c = checks.find((x) => x.report_id === OVER);
  assert.equal((await q(c.check_sql))[0].left_value, null);
});

if (process.env.DUMP_TIEOUTS) {
  const guard = /\(select md5\(queries_run::text \|\| parameters::text\) = '[0-9a-f]{32}' from public\.silo_chat_saved_reports where id = '[0-9a-f-]{36}'\)/g;
  writeFileSync(process.env.DUMP_TIEOUTS, JSON.stringify(checks.map((c) => ({ ...c, check_sql: c.check_sql.replace(guard, 'true') })), null, 1));
}
console.log(`\n${passed} passed`);
