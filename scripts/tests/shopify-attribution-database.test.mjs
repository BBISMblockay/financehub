import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create table entities(id uuid primary key); create table shopify_connections(id uuid primary key,company_entity_id uuid references entities);
create function active_company_id() returns uuid language sql as $$ select nullif(current_setting('test.company',true),'')::uuid $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;`);
const files=await readdir(new URL('../../supabase/migrations/',import.meta.url));
const coverageSql=await readFile(new URL('../../supabase/migrations/'+files.find(n=>n.endsWith('_attribution_coverage.sql')),import.meta.url),'utf8');
await db.exec(coverageSql);await db.exec(coverageSql);
assert.equal((await db.query("select relrowsecurity from pg_class where oid='shopify_attribution_coverage'::regclass")).rows[0].relrowsecurity,true);
for(const role of ['anon','authenticated']) {
 await db.exec('set role '+role);
 await assert.rejects(db.query('select * from shopify_attribution_coverage'),/permission denied/);
 await assert.rejects(db.query("insert into shopify_attribution_coverage(connection_id) values(null)"),/permission denied/);
 await db.exec('reset role');
}
let migration=await readFile(new URL('../../supabase/migrations/'+files.find(n=>n.endsWith('_silo_attribution_evidence.sql')),import.meta.url),'utf8');
if(process.env.ATTRIBUTION_DB_MUTATION==='rls')migration=migration.replaceAll('enable row level security','disable row level security');
if(process.env.ATTRIBUTION_DB_MUTATION==='reconciliation')migration=migration.replace('n <> p_net or t <> p_total','false');
await db.exec(migration);await db.exec(migration);
await db.exec("create table marketing_kpis_daily(company_entity_id uuid,platform text,campaign_id text,campaign_name text,day_date date,synced_at timestamptz); alter table marketing_kpis_daily enable row level security; grant select on marketing_kpis_daily to authenticated,service_role;");
const report=files.find(n=>n.endsWith('_silo_attribution_report.sql'));
if(report)await db.exec(await readFile(new URL('../../supabase/migrations/'+report,import.meta.url),'utf8'));
const co='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',conn='00000000-0000-0000-0000-000000000003';
await db.query('insert into entities values($1),($2)',[co,other]);await db.query('insert into shopify_connections values($1,$2)',[conn,co]);
await db.exec('grant select on shopify_connections to service_role');
const publish=(net=-100,stamp='2026-10-01T00:00:00Z',id='1')=>db.query(`select publish_shopify_attribution_day($1,'2026-09-01','USD','America/Los_Angeles',$2::jsonb,$3::jsonb,$4,-100,$5) as ok`,[conn,JSON.stringify([{order_id:id,net_cents:-100,total_cents:-100}]),JSON.stringify([{order_id:id,evidence:{order:{customerJourneySummary:{ready:true}}}}]),net,stamp]);
await db.exec('set role service_role');assert.equal((await publish()).rows[0].ok,true);
if(report){
 await db.exec('reset role');
 await db.query("insert into marketing_kpis_daily values($1,'google','123','Spring','2026-03-01','2026-03-02'),($1,'google','123','Fall','2026-09-01','2026-09-02'),($1,'google','123','','2026-10-01','2026-10-02')",[co]);
 await db.exec('set role service_role');
 assert.equal((await db.query('select campaign_name from silo_attribution_campaigns_v')).rows[0].campaign_name,'Fall');
}
assert.equal((await publish(-100,'2026-09-01T00:00:00Z','2')).rows[0].ok,false);
await assert.rejects(publish(0,'2026-10-02T00:00:00Z'),/mismatch/);
assert.equal((await db.query('select ledger from shopify_attribution_days')).rows[0].ledger[0].order_id,'1');
assert.equal((await publish(-100,'2026-10-02T00:00:00Z','2')).rows[0].ok,true);
assert.equal((await db.query('select ledger from shopify_attribution_days')).rows[0].ledger.length,1);
await db.exec('reset role; set role authenticated');await db.query("select set_config('test.company',$1,false)",[co]);
assert.equal((await db.query('select * from shopify_attribution_days')).rows.length,1);
if(report){const rows=(await db.query('select window_days,sum(net_cents) as net from silo_attribution_ledger_v group by window_days')).rows;assert.equal(rows.length,4);for(const r of rows)assert.equal(Number(r.net),-100);}
await assert.rejects(publish(),/permission denied/);
await assert.rejects(db.exec('delete from shopify_attribution_orders'),/permission denied/);
await db.query("select set_config('test.company',$1,false)",[other]);
assert.equal((await db.query('select * from shopify_attribution_days')).rows.length,0);
assert.equal((await db.query('select * from shopify_attribution_orders')).rows.length,0);
if(report)assert.equal((await db.query('select * from silo_attribution_ledger_v')).rows.length,0);
await db.exec('reset role; set role anon');await assert.rejects(db.query('select * from shopify_attribution_days'),/permission denied/);
await db.close();console.log('Attribution DB: atomic replacement, stale writes, RLS and grants passed');
