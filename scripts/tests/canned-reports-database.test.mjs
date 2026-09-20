// Execute the deployed templates, not hand-rewritten approximations, in isolated Postgres.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(readFileSync('v3/js/report-params.js', 'utf8'), ctx);
const P = ctx.window.SiloReportParams;
const migration = readFileSync('supabase/migrations/20260920075344_canned_report_accuracy.sql','utf8');
const before = JSON.parse(readFileSync('scripts/tests/fixtures/canned-reports-before.json','utf8'));
const prefix = { sales:'5110de50', inventory:'c1000000', owner:'c3000000' };
const id = (family,n) => `${prefix[family]}-0000-4000-a000-00000000000${n}`;
await db.exec(`
create function active_company_id() returns uuid language sql as $$ select '00000000-0000-4000-a000-000000000001'::uuid $$;
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
create function silo_business_timezone() returns text language sql as $$ select 'America/Los_Angeles'::text $$;
set test.today='2026-09-20';
create table silo_chat_saved_reports(id uuid primary key,title text,description text,queries_run jsonb,parameters jsonb,columns_metadata jsonb,source text,company_entity_id uuid);
create table silo_report_tieouts(id uuid default gen_random_uuid(),report_id uuid,name text,kind text,check_sql text,tolerance numeric,enabled boolean default true,note text,unique(report_id,name));
create table sales_by_day_verification_v(day_date date,location_tag text,company_entity_id uuid default active_company_id(),total_net_sales numeric,total_quantity_sold numeric,total_refunds numeric default 0);
create table sales_by_product_title_daily_v(day_date date,product_title text,product_type text,location_tag text,net_sales numeric,units_sold numeric,orders numeric);
create table shopify_orders(order_id bigint,company_entity_id uuid default active_company_id(),shopify_processed_at timestamptz,cancelled_at timestamptz,subtotal_price numeric,resolved_channel_name text);
create view shopify_orders_v as select * from shopify_orders where company_entity_id=active_company_id();
create table marketing_kpis_daily(day_date date,platform text,spend numeric,conversion_value numeric,conversions numeric,clicks numeric);
create view v_marketing_mer_daily as select day_date,sum(spend) ad_spend from marketing_kpis_daily where platform<>'ga4' group by 1;
create table locations(company_entity_id uuid default active_company_id(),store_type text,location_code text,location_name text);
create table demand_coverage_by_type_v(product_type text,has_inventory boolean,has_purchase_history boolean,units_on_hand numeric,units_on_order numeric,units_12m numeric,units_3m numeric,units_per_week_12m numeric,weeks_of_cover numeric,momentum_pct numeric);
create table inventory_workboard_v(product_title text,product_type text,total_available_quantity numeric,total_available_inventory_value numeric,last_sold_date date,velocity_matched boolean,sold_30 numeric);
create table inventory_on_hand_current_v(company_entity_id uuid default active_company_id(),product_type text,total_available_quantity numeric);
create table sales_monthly_product_type_rollup_v(product_type text,month_start date,units numeric);
insert into sales_by_day_verification_v(day_date,location_tag,total_net_sales,total_quantity_sold) values
('2026-09-19','online',100,10),('2026-09-19','online',20,2),('2026-09-18','retail',50,5),('2026-09-20','online',999,999),('2025-09-19','online',80,8);
insert into sales_by_product_title_daily_v values
('2026-09-19','A','Tees','online',120,12,3),('2026-09-18','B','Tees','retail',50,5,1),('2026-09-20','A','Tees','online',999,999,999);
insert into shopify_orders(order_id,shopify_processed_at,subtotal_price,resolved_channel_name) values
(1,'2026-09-19 06:59:59+00',50,'Online'),(2,'2026-09-19 07:00:00+00',60,'Online'),(3,'2026-09-20 06:59:59+00',60,'Online'),(4,'2026-09-20 07:00:00+00',999,'Online');
insert into shopify_orders(order_id,shopify_processed_at,cancelled_at,subtotal_price,resolved_channel_name) values
(5,'2026-09-19 15:00:00+00','2026-09-19 16:00:00+00',999,'Online');
insert into marketing_kpis_daily values
('2026-09-19','meta',10,20,1,10),('2026-09-19','meta',0,40,3,0),('2026-09-19','ga4',0,1000,1000,1000),('2026-09-18','meta',5,10,1,1);
insert into locations(store_type,location_code,location_name) values('online','online','Web'),('online','online','Duplicate label');
insert into demand_coverage_by_type_v values
('No PO',true,false,100,0,52,5,1,100,-10),('Incoming',true,true,10,1000,520,130,10,101,0),('Unknown',true,false,40,0,null,null,null,null,null);
insert into inventory_on_hand_current_v(product_type,total_available_quantity) values('No PO',100),('Incoming',10),('Unknown',40);
insert into inventory_workboard_v values
('Selling','Tees',250,2500,null,true,0),('Selling','Tees',0,0,'2026-09-19',true,1),
('Partial','Tees',250,2500,null,true,0),('Partial','Tees',5,50,null,false,0),
('Quiet','Tees',250,2500,'2026-01-01',true,0),('Null velocity','Tees',250,2500,null,true,null),
('Offsetting','Tees',250,2500,null,true,1),('Offsetting','Tees',0,0,null,true,-1);
insert into sales_monthly_product_type_rollup_v values('No PO','2026-08-01',5),('Incoming','2026-08-01',130);
`);
for (const r of before) await db.query('insert into silo_chat_saved_reports values($1,$2,$3,$4,$5,$6,$7,null)',[r.id,r.title,r.description,r.queries_run,r.parameters,r.columns_metadata,'system']);
await db.query("insert into silo_chat_saved_reports values(gen_random_uuid(),'Private copy','untouched','[\"select 1\"]','[]','{}','manual',active_company_id())");
await db.exec(migration);
const afterFirst = (await db.query('select * from silo_chat_saved_reports order by id')).rows;
await db.exec(migration);
assert.deepEqual((await db.query('select * from silo_chat_saved_reports order by id')).rows,afterFirst,'migration is idempotent and preserves IDs');
assert.equal(afterFirst.find(r=>r.source==='manual').description,'untouched');
const verifyFile=readFileSync('supabase/verify_v2_schema.sql','utf8');
const verify=verifyFile.split('-- Canned report accuracy definitions (fixture-tested).')[1].split('-- End canned report accuracy definitions.')[0];
assert.equal((await db.query(verify)).rows[0].canned_report_accuracy,'ok');
await db.exec('update silo_report_tieouts set tolerance=60000');
assert.match((await db.query(verify)).rows[0].canned_report_accuracy,/WEAK/,'wide tolerance cannot pass verification');
await db.exec(migration);
const run = async (family,n,values={}) => {
 const r=(await db.query('select * from silo_chat_saved_reports where id=$1',[id(family,n)])).rows[0];
 const resolved=P.substitute(r.queries_run[0],r.parameters,values); assert.ok(!resolved.error,resolved.error);
 return (await db.query(resolved.sql)).rows;
};
const n = v => v===null?null:Number(v);
let rows=await run('sales','1');
assert.deepEqual(rows.map(r=>[r.day_date.toISOString().slice(0,10),n(r.net_sales),n(r.orders)]),[['2026-09-18',50,1],['2026-09-19',120,2]]);
assert.equal(n((await run('sales','1',{date_from:'2026-09-19',date_to:'2026-09-19'}))[0].orders),2);
assert.equal(n((await run('sales','2'))[0].units_sold),12,'exclude partial current day');
assert.equal(n((await run('sales','3')).find(r=>r.location_tag==='online').net_sales),120);
assert.equal(n((await run('owner','1'))[0].orders),2);
assert.equal(n((await run('owner','1'))[0].net_sales_ly),80);
await db.exec("insert into sales_by_day_verification_v(day_date,location_tag,total_net_sales,total_quantity_sold) values('2024-12-29','online',30,3)");
assert.equal(n((await run('owner','1',{as_of:'2026-01-03'})).find(r=>r.period==='Last 7 days').net_sales_ly),30,'last-year week can cross the prior year boundary');
assert.equal((await run('owner','2')).length,2);
assert.equal(n((await run('owner','3'))[0].orders),3);
rows=await run('owner','4'); assert.equal(rows.length,1); assert.equal(n(rows[0].platform_claimed_value),70); assert.equal(n(rows[0].claimed_conversions),5);
rows=await run('owner','5'); assert.equal(n(rows[0].actually_sold_online),120,'duplicate location labels cannot multiply sales'); assert.equal(rows[0].real_online_roas,null,'mismatched daily coverage cannot produce pooled ROAS');
rows=await run('owner','6'); assert.equal(rows[0].online_net_sales,null);assert.equal(rows[0].mer,null);assert.equal(n(rows[1].mer),12);
rows=await run('inventory','1'); assert.equal(n(rows[0].units_on_hand),150);assert.equal(rows[0].weeks_of_cover,null,'unknown demand cannot manufacture cover');
rows=await run('inventory','5');assert.equal(rows.length,3,'no PO history or minimum-volume gate');
rows=await run('inventory','6');assert.deepEqual(rows.map(r=>r.product_type),['Incoming']);assert.equal(n(rows[0].weeks_on_hand),1);assert.equal(n(rows[0].weeks_of_cover),101);
assert.deepEqual((await run('inventory','7')).map(r=>r.product_type),['No PO']);
assert.deepEqual((await run('inventory','8')).map(r=>r.product_title),['Quiet']);
assert.equal((await run('inventory','9')).length,3);
assert.equal(n((await run('inventory','a'))[0].units_sold),12);
// Execute every generated check; mutations must produce a real discrepancy.
const checks=(await db.query('select * from silo_report_tieouts')).rows;
for(const c of checks) assert.equal((await db.query(c.check_sql)).rows.length,1,c.name);
const thin=checks.find(c=>c.report_id===id('inventory','6'));
let check=(await db.query(thin.check_sql)).rows[0];assert.equal(n(check.left_value),n(check.right_value));
await db.exec("update inventory_on_hand_current_v set total_available_quantity=999 where product_type='Incoming'");
check=(await db.query(thin.check_sql)).rows[0];assert.notEqual(n(check.left_value),n(check.right_value),'live inventory drift is caught');
const titleCheck=checks.find(c=>c.report_id===id('sales','2'));
let values=Object.values((await db.query(titleCheck.check_sql)).rows[0]);assert.equal(n(values[0]),n(values[1]));
await db.exec("update sales_by_product_title_daily_v set net_sales=net_sales+1 where day_date='2026-09-19'");
values=Object.values((await db.query(titleCheck.check_sql)).rows[0]);assert.notEqual(n(values[0]),n(values[1]),'one-dollar rollup drift fails');
await db.query("update silo_chat_saved_reports set queries_run='[\"select 1\"]' where id=$1",[id('inventory','6')]);
assert.equal((await db.query(thin.check_sql)).rows[0].left_value,null,'changed definitions cannot pass stale checks');
// Company date arithmetic runs in Postgres even when browser and DB calendars differ.
await db.exec("set test.today='2024-03-01'");
const dateDecl={key:'d',type:'date',date_basis:'company'};
let literal=P.toLiteral(dateDecl,'today-1d').literal;
assert.equal((await db.query(`select ${literal}::text d`)).rows[0].d,'2024-02-29');
assert.equal((await db.query(`select ${P.toLiteral(dateDecl,'month_end').literal}::text d`)).rows[0].d,'2024-03-31');
// Spring-forward day is 23 hours; fall-back day is 25, both include all local orders.
for (const [day,start,end] of [['2026-03-08','2026-03-08 08:00+00','2026-03-09 07:00+00'],['2026-11-01','2026-11-01 07:00+00','2026-11-02 08:00+00']]) {
 await db.exec('truncate shopify_orders');
 await db.query("insert into shopify_orders(order_id,shopify_processed_at,subtotal_price) values(1,$1::timestamptz,1),(2,$2::timestamptz-interval '1 second',1),(3,$2::timestamptz,1)",[start,end]);
 assert.equal(n((await run('owner','3',{date_from:day,date_to:day}))[0].orders),2,day);
}
await db.close();
console.log('Canned report database tests passed: 16 templates, idempotency, calendar boundaries, missing data and drift mutations.');
