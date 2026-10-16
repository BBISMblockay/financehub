import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const db=new PGlite(),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
try {
 await db.exec(await read('./on-deck-bootstrap.sql'));
 await db.exec(`create table public.on_deck_settings(company_entity_id uuid,updated_at timestamptz); alter table public.seo_tasks add column updated_at timestamptz; create sequence timezone_calls;`);
 await db.exec(`create or replace function public.silo_company_timezone(uuid) returns text language plpgsql volatile as $$begin perform nextval('public.timezone_calls'); return current_setting('test.zone'); end $$;`);
 const source=await read('../../supabase/migrations/20261008212803_on_deck_action_loop.sql');
 const legacy=source.match(/create or replace function public\.on_deck_source_version\([\s\S]*?end \$\$;/)[0];
 let fixed=await read('../../supabase/migrations/20261009171424_on_deck_source_date_once.sql');
 if(process.env.DATE_MUTATE==='per-row') fixed=fixed.replace('day_date>=company_today-90','day_date>=(now() at time zone public.silo_company_timezone(p_company))::date-90');
 assert.equal((fixed.match(/silo_company_timezone\(p_company\)/g)||[]).length,process.env.DATE_MUTATE ? 2:1);
 // Fixture clock substitution lets the actual bodies run at local-midnight/DST boundaries.
 const clock=s=>s.replaceAll('now()',"current_setting('test.clock')::timestamptz");
 await db.exec(clock(legacy.replaceAll('on_deck_source_version','old_source_version')));
 await db.exec(clock(legacy));
 await db.exec('revoke all on function public.on_deck_source_version(uuid,text) from public,anon,authenticated; grant execute on function public.on_deck_source_version(uuid,text) to service_role;');
 await db.exec(clock(fixed));await db.exec(clock(fixed));
 for(const zone of ['America/Los_Angeles','America/New_York','Asia/Tokyo','UTC']) for(const time of ['2026-03-08T07:59:59Z','2026-03-08T08:00:00Z','2026-11-01T08:30:00Z']) {
  await db.query("select set_config('test.zone',$1,false),set_config('test.clock',$2,false)",[zone,time]);
  const today=(await db.query("select ($1::timestamptz at time zone $2)::date::text d",[time,zone])).rows[0].d;
  await db.exec('truncate public.sales_by_day');
  await db.query("insert into public.sales_by_day(company_entity_id,sku,day_date,synced_at) select $1,'test',$2::date+day_offset,'2026-01-01'::timestamptz+day_offset*interval '1 hour' from generate_series(-91,1) as day_offset",[A,today]);
  await db.query("insert into public.sales_by_day(company_entity_id,sku,day_date,synced_at) values($1,'foreign',$2::date,'2099-01-01')",[B,today]);
  for(const kind of ['restock','launch','seo','ads']) {
   const r=(await db.query('select public.old_source_version($1,$2) old,public.on_deck_source_version($1,$2) fixed',[A,kind])).rows[0];assert.equal(r.fixed,r.old,zone+' '+time+' '+kind);
  }
 }
 await db.query("insert into public.sales_by_day(company_entity_id,sku,day_date) select $1,'bulk',current_setting('test.clock')::timestamptz::date from generate_series(1,20000)",[A]);
 await db.exec('alter sequence timezone_calls restart with 1');
 await db.query("select public.on_deck_source_version($1,'restock')",[A]);
 assert.equal(Number((await db.query('select last_value from timezone_calls')).rows[0].last_value),1,'company timezone must be resolved once independent of sales row count');
 for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_function_privilege($1,'public.on_deck_source_version(uuid,text)','execute') ok",[role])).rows[0].ok,false);
 assert.equal((await db.query("select has_function_privilege('service_role','public.on_deck_source_version(uuid,text)','execute') ok")).rows[0].ok,true);

 // 20261016170000: the seo and restock branches stop reading the two
 // multi-million-row fact tables and take their freshness from the sync_jobs row
 // the importer already writes. Everything above still describes the date fix;
 // what follows is what the cheap version must and must not change.
 const cheapFile=await read('../../supabase/migrations/20261016170000_on_deck_source_version_cheap.sql');
 let cheap=cheapFile.match(/create or replace function public\.on_deck_source_version\([\s\S]*?end \$\$;/)[0];
 // CHEAP_MUTATE puts a scan back: every assertion below must then fail.
 const cheapMutations={
  'restock-scans-sales':["(select concat(count(*),':',max(updated_at)) from public.po_lines where company_entity_id=p_company),","(select concat(count(*),':',max(updated_at)) from public.po_lines where company_entity_id=p_company),\n (select concat(count(*),':',max(synced_at)) from public.sales_by_day where company_entity_id=p_company and day_date>=company_today-90),"],
  'seo-scans-search-console':["(select max(finished_at)::text from public.sync_jobs where company_entity_id=p_company and status='success' and job_type='search_console_daily')","(select concat(count(*),':',max(synced_at)) from public.search_console_page_daily where company_entity_id=p_company)"],
 };
 if(process.env.CHEAP_MUTATE){const[a,b]=cheapMutations[process.env.CHEAP_MUTATE]||[];assert.ok(a&&cheap.includes(a),'unknown CHEAP_MUTATE');cheap=cheap.replaceAll(a,b);}
 assert.equal((cheap.match(/silo_company_timezone\(p_company\)/g)||[]).length,1,'the company date is still resolved once per call');
 await db.exec(clock(cheap));

 // The two branches that did NOT change must still agree with the legacy body,
 // across every zone and DST boundary above.
 for(const zone of ['America/Los_Angeles','Asia/Tokyo']) for(const time of ['2026-03-08T07:59:59Z','2026-03-08T08:00:00Z']) {
  await db.query("select set_config('test.zone',$1,false),set_config('test.clock',$2,false)",[zone,time]);
  for(const kind of ['launch','ads']) {
   const r=(await db.query('select public.old_source_version($1,$2) old,public.on_deck_source_version($1,$2) now',[A,kind])).rows[0];
   assert.equal(r.now,r.old,'unchanged branch moved: '+zone+' '+time+' '+kind);
  }
 }

 // seo and restock: the fact rows no longer move the fingerprint, the sync does.
 await db.query("select set_config('test.zone','America/Los_Angeles',false),set_config('test.clock','2026-03-08T08:00:00Z',false)");
 const v=kind=>db.query('select public.on_deck_source_version($1,$2) v',[A,kind]).then(r=>r.rows[0].v);
 const seoBefore=await v('seo'), restockBefore=await v('restock');
 await db.query("insert into public.search_console_page_daily(company_entity_id,site_url,day_date,page) select $1,'https://example.test',current_setting('test.clock')::timestamptz::date,'https://example.test/p'||i from generate_series(1,500) i",[A]);
 await db.query("insert into public.sales_by_day(company_entity_id,sku,day_date) select $1,'cheap'||i,current_setting('test.clock')::timestamptz::date from generate_series(1,500) i",[A]);
 assert.equal(await v('seo'),seoBefore,'fact rows alone must not move the seo fingerprint');
 assert.equal(await v('restock'),restockBefore,'fact rows alone must not move the restock fingerprint');
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'search_console_daily','success',current_setting('test.clock')::timestamptz)",[A]);
 assert.notEqual(await v('seo'),seoBefore,'a Search Console sync must still read as a refresh');
 assert.equal(await v('restock'),restockBefore,'a Search Console sync is not a restock refresh');
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'incremental_sales','success',current_setting('test.clock')::timestamptz)",[A]);
 assert.notEqual(await v('restock'),restockBefore,'a sales sync must still read as a refresh');
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'search_console_daily','error',current_setting('test.clock')::timestamptz+interval '1 day')",[A]);
 const seoAfter=await v('seo');
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'search_console_daily','success',current_setting('test.clock')::timestamptz+interval '2 days')",[B]);
 assert.equal(await v('seo'),seoAfter,'a failed run, and another company\u2019s run, are not this company\u2019s refresh');

 // Behaviour is asserted above; this is the standing guarantee that the two
 // multi-million-row tables are not read at all, which is what blew the 8s budget.
 for(const table of ['search_console_page_daily','sales_by_day'])
  assert.equal(cheap.includes(table),false,table+' is still being scanned by the fingerprint');
 for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_function_privilege($1,'public.on_deck_source_version(uuid,text)','execute') ok",[role])).rows[0].ok,false,'the cheap version must stay off the browser');
 console.log('48 date/zone/branch equivalence checks, 20000-row constant-call regression, retained grants and 13 sync-token checks passed');
} finally {await db.close();}
