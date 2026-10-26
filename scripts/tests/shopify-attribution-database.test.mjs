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
const discounts=files.find(n=>n.endsWith('_attribution_discount_codes.sql'));
if(report&&discounts){
 let sql=await readFile(new URL('../../supabase/migrations/'+discounts,import.meta.url),'utf8');
 if(process.env.ATTRIBUTION_DB_MUTATION==='discounts')sql=sql.replaceAll("jsonb_typeof(o.evidence->'order'->'discountCodes')='array'","true");
 await db.exec(sql);await db.exec(sql);
}
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
if(report){
 // The Attribution page's own projection, run against the real view. Its unit tests feed the
 // loader mock rows, so this is the only place that SQL executes: every column it keeps must
 // match `select *`, and an allocation holding none of the kept keys must stay an empty object,
 // which is what keeps such an order reading as backfilled rather than "Model not backfilled".
 const {LEDGER_SELECT}=await import('../../v2/silo-attribution-report.js');
 const scope=` where company_entity_id='${co}'::uuid and connection_id='${conn}'::uuid and window_days=30 and day='2026-09-01'::date order by order_id`;
 const projected=(await db.query(LEDGER_SELECT+scope)).rows,full=(await db.query('select * from silo_attribution_ledger_v'+scope)).rows;
 assert.ok(projected.length&&projected.length===full.length,'the projection must return the same rows as select *');
 for(const [i,row] of projected.entries())for(const key of Object.keys(row))assert.deepEqual(row[key],full[i][key],`projected ${key} differs from select *`);
 for(const dropped of ['currency','shop_timezone'])assert.ok(!(dropped in projected[0]),`${dropped} is read from the daily controls, not from every ledger row`);
 await db.exec('reset role; set role service_role');
 await db.query(`update shopify_attribution_orders set evidence=evidence||'{"allocations":{"30":{"model_version":"1"}}}'::jsonb`);
 await db.exec("reset role; set role authenticated");await db.query("select set_config('test.company',$1,false)",[co]);
 assert.deepEqual((await db.query(LEDGER_SELECT+scope)).rows[0].allocation,{},'an allocation with no kept keys must stay an empty object');
 await db.exec('reset role; set role service_role');
 await db.query(`update shopify_attribution_orders set evidence=evidence-'allocations'`);
 assert.equal((await db.query(LEDGER_SELECT+scope)).rows[0].allocation,null,'a missing allocation must stay null');
 await db.exec("reset role; set role authenticated");await db.query("select set_config('test.company',$1,false)",[co]);
}
if(report){
 // The journey read's SQL projection, run against the real view's table: the page classifies the
 // visits it gets back, so what must hold is that the projected journey yields the same visits,
 // with the same classification, as the whole stored blob. Visits repeated as firstVisit and
 // lastVisit collapse, a moment that is not a CustomerVisit is dropped in SQL instead of in the
 // page, and no field classify() reads is left behind.
 const {journeyQuery}=await import('../../v2/silo-attribution-overview.js');
 const {journeyVisits,classify}=await import('../../v2/silo-attribution-model.js');
 const visit=(n,extra={})=>({id:'gid://shopify/CustomerVisit/'+n,occurredAt:`2026-09-0${n}T10:00:00Z`,source:'https://facebook.com/',sourceType:null,referrerUrl:'https://facebook.com/',landingPage:'https://shop.test/products/cap',utmParameters:{source:'facebook',medium:'paid',campaign:'fall',content:'ad-1',term:''},__typename:'CustomerVisit',...extra});
 // Visit 5 classifies from its referrer alone and visit 6 from its sourceType, so a field
 // dropped from the projection changes a channel rather than nothing.
 const nodes=[visit(1),visit(2),visit(3,{__typename:'CustomerPageView'}),{occurredAt:'2026-09-04T10:00:00Z'},
  visit(5,{source:'',referrerUrl:'https://l.facebook.com/',utmParameters:{source:'',medium:'',campaign:'',content:'',term:''}}),
  visit(6,{source:'',referrerUrl:'',sourceType:'SEO',utmParameters:{source:'',medium:'',campaign:'',content:'',term:''}})];
 // firstVisit and lastVisit are STALE copies that disagree with the nodes: journeyVisits() keeps
 // the last copy of a repeated id (Map.set), so the SQL dedup has to keep the last one too, or a
 // visit would classify differently in the page than it does here.
 const stale=utm=>({...visit(1),utmParameters:{source:utm,medium:'paid',campaign:'',content:'',term:''}});
 const order={id:'gid://shopify/Order/1',name:'#1',createdAt:'2026-09-05T10:00:00Z',sourceName:'web',customerJourneySummary:{ready:true,firstVisit:stale('google'),lastVisit:{...visit(2),utmParameters:{source:'redo',medium:'sms',campaign:'',content:'',term:''}},moments:{pageInfo:{hasNextPage:false},nodes}}};
 await db.exec('reset role; set role service_role');
 const orderId=(await db.query('select order_id from shopify_attribution_orders limit 1')).rows[0].order_id;
 await db.query('update shopify_attribution_orders set evidence=$1::jsonb where order_id=$2',[JSON.stringify({order,own_hosts:['shop.test']}),orderId]);
 await db.exec('reset role; set role authenticated');await db.query("select set_config('test.company',$1,false)",[co]);
 const projected=(await db.query(journeyQuery(co,conn,[orderId]))).rows;
 assert.equal(projected.length,1,'the projection must return the order');
 const shape=o=>journeyVisits(o).map(v=>({id:v.id,at:v.occurredAt,landing:v.landingPage,...classify(v,{ownHosts:['shop.test']})}));
 assert.deepEqual(shape(projected[0].order_evidence),shape(order),'the projected journey must classify identically to the whole blob');
 assert.equal(shape(projected[0].order_evidence).length,4,'four visits survive: a repeat, a non-visit moment and a moment without an id are dropped');
 // Visit 1 keeps the nodes copy (Meta Ads, not the stale google firstVisit) and visit 2 keeps the
 // lastVisit copy (Redo SMS, not the nodes copy), in both the projection and the whole blob.
 assert.deepEqual(shape(projected[0].order_evidence).map(v=>v.channel),['Meta Ads','Redo SMS','Meta Social — Unspecified','Organic Search']);
 // Deduped in SQL, not left to the page: the repeats are what made this payload worth trimming.
 assert.equal(projected[0].order_evidence.customerJourneySummary.moments.nodes.length,4,'the visits must already be deduped in SQL');
 assert.equal(projected[0].order_evidence.customerJourneySummary.ready,true);
 assert.equal(projected[0].order_evidence.customerJourneySummary.moments.pageInfo.hasNextPage,false);
 assert.deepEqual(projected[0].own_hosts,['shop.test']);
 const text=JSON.stringify(projected[0].order_evidence);
 for(const dropped of ['sourceName','__typename','firstVisit','lastVisit'])assert.ok(!text.includes(dropped),`${dropped} is not read by the rollup and must not be sent`);
}
if(report&&discounts){
 // Codes ride along on the evidence the journey fetch already stores, so the view must report
 // three states apart: an array of codes, an order collected with none, and evidence written
 // before the sync captured codes at all. The last is NOT "no code used" -- coalescing it to an
 // empty array would turn every pre-change order into a sale that bought nothing on a code.
 const codes=async()=>{
  await db.exec('reset role; set role authenticated');await db.query("select set_config('test.company',$1,false)",[co]);
  const rows=(await db.query("select distinct discount_codes, discount_code from silo_attribution_ledger_v where day='2026-09-01'::date")).rows;
  assert.equal(rows.length,1,'one order, one code shape');
  return rows[0];
 };
 const setEvidence=async order=>{
  await db.exec('reset role; set role service_role');
  await db.query('update shopify_attribution_orders set evidence=jsonb_set(evidence,$1,$2::jsonb)',['{order}',JSON.stringify(order)]);
 };
 await setEvidence({name:'#1',discountCodes:['TEAM50','PRESTON30']});
 assert.deepEqual((await codes()).discount_codes,['TEAM50','PRESTON30'],'every applied code is kept');
 assert.equal((await codes()).discount_code,'TEAM50','the first code applied is the one to group on');
 await setEvidence({name:'#1',discountCodes:[]});
 assert.deepEqual((await codes()).discount_codes,[],'an order collected with no code is an empty array');
 assert.equal((await codes()).discount_code,null,'no code to group on');
 await setEvidence({name:'#1'});
 assert.equal((await codes()).discount_codes,null,'evidence from before the change is NOT MEASURED, not empty');
 assert.equal((await codes()).discount_code,null);
 // A non-array value is malformed evidence, not a code list to read through.
 await setEvidence({name:'#1',discountCodes:'TEAM50'});
 assert.equal((await codes()).discount_codes,null,'a malformed discountCodes must read as not measured');
 await setEvidence({name:'#1',discountCodes:['TEAM50']});
 await db.exec('reset role; set role authenticated');await db.query("select set_config('test.company',$1,false)",[co]);
 // The page's own projection must be unaffected by the new columns.
 const {LEDGER_SELECT}=await import('../../v2/silo-attribution-report.js');
 const projected=(await db.query(LEDGER_SELECT+" where day='2026-09-01'::date and window_days=30")).rows[0];
 for(const added of ['discount_codes','discount_code'])assert.ok(!(added in projected),`${added} must not be added to the Attribution page's payload`);
}
await db.exec('reset role; set role authenticated');await db.query("select set_config('test.company',$1,false)",[co]);
await assert.rejects(publish(),/permission denied/);
await assert.rejects(db.exec('delete from shopify_attribution_orders'),/permission denied/);
await db.query("select set_config('test.company',$1,false)",[other]);
assert.equal((await db.query('select * from shopify_attribution_days')).rows.length,0);
assert.equal((await db.query('select * from shopify_attribution_orders')).rows.length,0);
// The journey read goes through the reporting engine now, so prove that path is RLS-bounded too.
if(report){const {journeyQuery}=await import('../../v2/silo-attribution-overview.js');assert.equal((await db.query(journeyQuery(co,conn,['1','2']))).rows.length,0,'another company must read no journeys');}
if(report)assert.equal((await db.query('select * from silo_attribution_ledger_v')).rows.length,0);
await db.exec('reset role; set role anon');await assert.rejects(db.query('select * from shopify_attribution_days'),/permission denied/);
await db.close();console.log('Attribution DB: atomic replacement, stale writes, RLS and grants passed');
