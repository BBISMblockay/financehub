// Local PostgreSQL, no production connection. Run after npm ci --prefix scripts/tests/finance-db --ignore-scripts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
let migration = await readFile(new URL('../../supabase/migrations/20260926082115_product_workflow_preview.sql', import.meta.url),'utf8');
const mutations = {
  'catalog-drift': ["if product.updated_at is distinct from (b.source_snapshot->>'updated_at')::timestamptz then", 'if false then'],
  'restock-evidence': ["if (basis - 'observed_at') is distinct from (fresh - 'observed_at') then", 'if false then'],
  'restock-note': ["and coalesce(length(btrim(p_content->>'decision_note')),0)=0 then", 'and false then'],
  'restock-review': ["if p_status='reviewed' and p_kind='restock' then", 'if false then'],
  'source-scope': ["c.id=p_source_id and c.company_entity_id=p_company", 'c.id=p_source_id'],
  'gate': ['or not coalesce(public.po_builder_can_write(), false)', 'or false'],
  'retry': ['if output_id is not null then', 'if false then'],
  'freeze': ["if b.po_header_id is not null or b.launch_id is not null then", 'if false then'],
  'read-scope': ['using (company_entity_id = (select public.active_company_id()))', 'using (true)'],
};
if(process.env.MUTATE) {
  const [before,after] = mutations[process.env.MUTATE] || [];
  assert.ok(before && migration.includes(before),'known mutation');
  migration=migration.replace(before,after);
}
const db = new PGlite();
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const ADMIN='33333333-3333-4333-8333-333333333333', VIEWER='44444444-4444-4444-8444-444444444444';
const FACTORY='55555555-5555-4555-8555-555555555555', CONCEPT='66666666-6666-4666-8666-666666666666';
const PRODUCT='77777777-7777-4777-8777-777777777777', FOREIGN='88888888-8888-4888-8888-888888888888';
const ID='99999999-9999-4999-8999-999999999999';
let checks=0;
const one=async(sql,params)=>(await db.query(sql,params)).rows[0];
const test=async(name,fn)=>{await fn(); console.log(`ok ${++checks} - ${name}`);};
const fail=async(fn,pattern)=>assert.rejects(fn,pattern);
const user=async(id=ADMIN,co=A)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('test.company',$2,false)",[id,co]);await db.exec('set role authenticated');};
await db.exec(`
 create role anon; create role authenticated;
 create schema auth; grant usage on schema public,auth to authenticated,anon;
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create table public.entities(id uuid primary key);
 insert into public.entities values('${A}'),('${B}');
 create table public.profiles(id uuid primary key,role text);
 insert into public.profiles values('${ADMIN}','admin'),('${VIEWER}','viewer');
 create function public.active_company_id() returns uuid language sql stable as $$ select nullif(current_setting('test.company',true),'')::uuid $$;
 create function public.po_builder_can_write() returns boolean language sql stable security definer as $$ select exists(select 1 from public.profiles where id=auth.uid() and role='admin') $$;
 create function public.silo_business_today() returns date language sql stable as $$ select date '2026-09-26' $$;
 create function public.silo_business_yesterday() returns date language sql stable as $$ select date '2026-09-25' $$;
 create function public.silo_business_timezone() returns text language sql stable as $$ select 'UTC'::text $$;
 create function public.attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
 create table public.factories(id uuid primary key,company_entity_id uuid,factory_name text);
 create table public.product_concepts(id uuid primary key,company_entity_id uuid,title text,status text,suggested_factory_id uuid,parent_concept_id uuid,updated_at timestamptz default '2026-09-26T00:00:00Z');
 create table public.products_master(id uuid primary key,company_entity_id uuid,sku text,product_title text,product_type text,variant_title text,updated_at timestamptz default '2026-09-26T00:00:00Z');
 create sequence public.po_seq;
 create function public.generate_next_po_name(uuid) returns text language sql as $$ select 'FACTORY-'||nextval('public.po_seq') $$;
 create table public.po_headers(id uuid primary key default gen_random_uuid(),company_entity_id uuid,po_name text not null,factory_id uuid not null,
   order_date date,status text not null,is_new_product_po boolean,created_by uuid,internal_notes text,expected_arrival_date date);
 create table public.po_lines(id uuid primary key default gen_random_uuid(),company_entity_id uuid,po_header_id uuid references public.po_headers,
   product_master_id uuid,source_concept_id uuid,title_snapshot text,product_type_snapshot text,variant_title_snapshot text,sku_snapshot text,
   qty integer not null check(qty>=0),unit_cost numeric,retail_price numeric,line_notes text);
 create table public.po_concept_links(id uuid primary key default gen_random_uuid(),company_entity_id uuid,po_header_id uuid,concept_id uuid,created_by uuid,unique(po_header_id,concept_id));
 create table public.launch_calendar(id uuid primary key default gen_random_uuid(),company_entity_id uuid,title text not null,launch_date date not null,
   time_zone text,status text,created_by uuid,linked_po_id uuid,linked_product_id uuid,source_concept_id uuid,design_intent text,product_callouts text,
   marketing_angle text,audience text,special_callouts text,copy_dos text,copy_donts text,creative_dos text,creative_donts text,notes text,
   approved_copy text,products_unknown_at timestamptz,products_unknown_note text);
 create table public.launch_product_readiness(id uuid primary key default gen_random_uuid(),company_entity_id uuid,launch_id uuid,product_title text,product_type text,created_by uuid,notes text);
 create table public.sales_by_day(company_entity_id uuid,sku text,day_date date,total_quantity_sold integer,product_name text);
 create table public.inventory_on_hand_current_v(company_entity_id uuid,variant_sku text,total_available_quantity integer,snapshot_at timestamptz);
 grant select on all tables in schema public to authenticated;
 -- Emulate Supabase's permissive defaults; the migration must revoke them.
 alter default privileges in schema public grant all on tables to authenticated,anon;
 alter default privileges in schema public grant execute on functions to authenticated,anon;
 insert into public.factories values('${FACTORY}','${A}','Factory'),('${FOREIGN}','${B}','Other factory');
 insert into public.product_concepts(id,company_entity_id,title,status,suggested_factory_id) values('${CONCEPT}','${A}','Concept','draft','${FACTORY}'),('${FOREIGN}','${B}','Foreign concept','draft',null);
 insert into public.products_master(id,company_entity_id,sku,product_title,product_type,variant_title) values('${PRODUCT}','${A}','SKU-1','Product','Tee','M'),('${FOREIGN}','${B}','SKU-1','Other product','Tee','M');
`);
await db.exec(migration); await db.exec(migration);
const content={source_updated_at:'2026-09-26T00:00:00Z',title:'Reviewed tee',design_intent:'A summer baseball tee',audience:'Players',marketing_angle:'Everyday practice',draft_copy:'Suggested, not approved',factory_id:FACTORY,lines:[{size:'M',qty:90,unit_cost:5,retail_price:20}]};
const save=async(id=ID,version=0,status='draft',body=content,kind='concept',source=CONCEPT,co=A)=>(await one('select public.save_product_workflow_brief($1,$2,$3,$4,$5,$6,$7) b',[co,id,version,kind,source,body,status])).b;
const handoff=async(id,version,target='po',date=null,co=A)=>(await one('select public.handoff_product_workflow_brief($1,$2,$3,$4,$5) b',[co,id,version,target,date])).b;
await user();
await test('migration applies twice; anonymous cannot call any writer and direct DML is denied',async()=>{
  for(const sig of ['save_product_workflow_brief(uuid,uuid,integer,text,uuid,jsonb,text)','handoff_product_workflow_brief(uuid,uuid,integer,text,date)','product_workflow_restock_basis(uuid,uuid,integer)']) {
    assert.equal((await one("select has_function_privilege('anon',$1,'execute') ok",['public.'+sig])).ok,false);
  }
  await fail(()=>db.query("insert into public.product_workflow_briefs(id) values($1)",[ID]),/permission denied/);
  const verifier=await readFile(new URL('../../supabase/verify_v2_schema.sql',import.meta.url),'utf8');
  const checks=verifier.slice(verifier.indexOf('-- Direct-link product workflow preview.'),verifier.indexOf('-- End product workflow preview checks.'));
  for(const sql of checks.split(';').filter(s=>s.trim())) for(const row of (await db.query(sql)).rows) assert.equal(row.status,'ok');
});
await test('viewer cannot save; wrong active company and foreign concept cannot become a source',async()=>{
  await user(VIEWER);await fail(()=>save(),/permission/);await user();
  await fail(()=>save(ID,0,'draft',content,'concept',CONCEPT,B),/permission/);
  await fail(()=>save(ID,0,'draft',content,'concept',FOREIGN),/Source not found/);
  await fail(()=>save(ID,0,'draft',content,'product',FOREIGN),/Source not found/);
});
let b;
await test('first save refuses an out-of-date source preset',async()=>{
  await fail(()=>save(ID,0,'draft',{...content,source_updated_at:'2026-09-25T00:00:00Z'}),/Source changed/);
});
await test('save captures source and author; lost-response retry returns the same version',async()=>{
  b=await save();assert.equal(b.version,1);assert.equal(b.created_by,ADMIN);assert.equal(b.source_snapshot.title,'Concept');
  assert.deepEqual(await save(),b);
  await fail(()=>save(ID,0,'draft',{...content,title:'Stale edit'}),/changed/);
});
await test('company RLS hides another company’s brief and direct review/output forgery is denied',async()=>{
  await user(ADMIN,B);assert.equal((await db.query('select * from public.product_workflow_briefs')).rows.length,0);
  await fail(()=>handoff(ID,1,'po',null,B),/not found/);await user();
  await fail(()=>db.query("update public.product_workflow_briefs set status='reviewed',po_header_id=$1 where id=$2",[FACTORY,ID]),/permission denied/);
});
await test('review is explicit; a draft cannot hand off, reviewed content must be reopened to edit',async()=>{
  await fail(()=>handoff(ID,1),/Review/);
  b=await save(ID,1,'reviewed');assert.equal(b.reviewed_by,ADMIN);
  await fail(()=>save(ID,b.version,'reviewed',{...content,title:'Changed'}),/Reopen/);
  await fail(()=>handoff(ID,1),/changed/);
});
await test('PO + lines + concept link commit together, remain Draft, and repeat handoff reuses the output',async()=>{
  const originalVersion=b.version;b=await handoff(ID,b.version);
  const po=await one('select * from public.po_headers where id=$1',[b.po_header_id]);
  assert.equal(po.status,'Draft');assert.equal(po.is_new_product_po,true);
  const line=await one('select * from public.po_lines where po_header_id=$1',[po.id]);assert.equal(line.qty,90);assert.equal(line.source_concept_id,CONCEPT);
  assert.equal((await one('select count(*)::int n from public.po_concept_links where po_header_id=$1',[po.id])).n,1);
  assert.equal((await handoff(ID,originalVersion)).po_header_id,po.id);
});
await test('a handed-off brief is frozen even when requesting reopen; viewer cannot repeat an output',async()=>{
  await fail(()=>save(ID,b.version,'draft'),/frozen/);
  await user(VIEWER);await fail(()=>handoff(ID,b.version),/permission/);await user();
});
await test('launch can be scheduled after PO creation, carries brief/source, and does not approve suggested copy',async()=>{
  b=await handoff(ID,b.version,'launch','2026-11-01');
  const launch=await one('select * from public.launch_calendar where id=$1',[b.launch_id]);
  assert.equal(launch.linked_po_id,b.po_header_id);assert.equal(launch.source_concept_id,CONCEPT);
  assert.equal(launch.design_intent,content.design_intent);assert.equal(launch.audience,content.audience);
  assert.equal(launch.approved_copy,null);assert.match(launch.notes,/Suggested copy \(not approved\)/);assert.equal(launch.status,'planned');
  assert.equal((await handoff(ID,1,'launch','2026-12-01')).launch_id,b.launch_id);
  assert.equal((await one('select launch_date::text d from public.launch_calendar where id=$1',[b.launch_id])).d,'2026-11-01');
});
const id2='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
await test('foreign factory, decimal and invalid quantities cannot create a PO',async()=>{
  let x=await save(id2,0,'reviewed',{...content,factory_id:FOREIGN});await fail(()=>handoff(id2,x.version),/factory/);
  x=await save(id2,x.version,'draft',x.content);
  x=await save(id2,x.version,'reviewed',{...content,lines:[{size:'M',qty:1.5}]});await fail(()=>handoff(id2,x.version),/whole/);
});
await test('line failure rolls back header and leaves retry possible',async()=>{
  await db.exec('reset role');
  await db.exec(`create function public.test_line_failure() returns trigger language plpgsql as $$ begin if new.qty=13 then raise exception 'simulated line failure'; end if; return new; end $$;
    create trigger test_failure before insert on public.po_lines for each row execute function public.test_line_failure();`);
  await user();
  let x=await one('select * from public.product_workflow_briefs where id=$1',[id2]);
  x=await save(id2,x.version,'draft',x.content);x=await save(id2,x.version,'reviewed',{...content,lines:[{size:'M',qty:13}]});
  const before=(await one('select count(*)::int n from public.po_headers')).n;
  await fail(()=>handoff(id2,x.version),/simulated/);
  assert.equal((await one('select count(*)::int n from public.po_headers')).n,before);
  assert.equal((await one('select po_header_id from public.product_workflow_briefs where id=$1',[id2])).po_header_id,null);
});
const id3='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
await test('catalog launch attaches the existing product, never creates another catalog product',async()=>{
  const x=await save(id3,0,'reviewed',content,'product',PRODUCT);
  const out=await handoff(id3,x.version,'launch','2026-12-01');
  assert.equal((await one('select linked_product_id from public.launch_calendar where id=$1',[out.launch_id])).linked_product_id,PRODUCT);
  assert.equal((await one('select product_title from public.launch_product_readiness where launch_id=$1',[out.launch_id])).product_title,'Product');
  assert.equal((await one('select count(*)::int n from public.products_master')).n,2);
  await fail(()=>handoff(id3,out.version),/Launch already/);
});
await test('restock basis is exactly 90 company days, scoped, and excludes uncertain/ineligible incoming',async()=>{
  await db.exec('reset role');
  await db.exec(`insert into public.sales_by_day values('${A}','SKU-1','2026-06-28',900,'Product'),('${A}','SKU-1','2026-09-25',90,'Product'),('${A}','SKU-1','2026-06-27',10000,'Product'),('${A}','SKU-1','2026-09-26',10000,'Product'),('${B}','SKU-1','2026-09-25',10000,'Other');
    insert into public.inventory_on_hand_current_v values('${A}','SKU-1',100,now()),('${B}','SKU-1',10000,now());
    insert into public.po_headers(company_entity_id,po_name,factory_id,status,expected_arrival_date)
      values('${A}','Eligible','${FACTORY}','In Production','2026-10-01'),('${A}','Late','${FACTORY}','Confirmed','2027-01-01'),('${A}','Partial','${FACTORY}','Partially Received','2026-10-01'),('${A}','Draft','${FACTORY}','Draft','2026-10-01'),('${B}','Foreign','${FOREIGN}','Confirmed','2026-10-01');
    insert into public.po_lines(company_entity_id,po_header_id,sku_snapshot,qty) select company_entity_id,id,'SKU-1',50 from public.po_headers where po_name in ('Eligible','Late','Partial','Draft','Foreign');`);
  await user();
  const r=(await one('select public.product_workflow_restock_basis($1,$2,90) b',[A,PRODUCT])).b;
  assert.equal(r.units_90d,990);assert.equal(r.lookback_days,90);assert.equal(r.window_start,'2026-06-28');assert.equal(r.window_end,'2026-09-25');
  assert.equal(r.on_hand,100);assert.equal(r.incoming_units,50);assert.equal(r.uncertain_po_lines,1);
  await fail(()=>db.query('select public.product_workflow_restock_basis($1,$2,90)',[A,FOREIGN]),/not found/);
});
await test('a restock PO keeps the catalog identity and is not a new-product PO',async()=>{
  const id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const saved=await save(id,0,'reviewed',{...content,title:'Restock label',decision_note:'Partial receipt checked; ordering 90 units deliberately',restock:{lead_days:0,cover_days:90,safety_units:0,basis:(await one('select public.product_workflow_restock_basis($1,$2,90) b',[A,PRODUCT])).b}},'restock',PRODUCT);
  const out=await handoff(id,saved.version);
  assert.equal((await one('select is_new_product_po from public.po_headers where id=$1',[out.po_header_id])).is_new_product_po,false);
  const line=await one('select * from public.po_lines where po_header_id=$1',[out.po_header_id]);
  assert.equal(line.product_master_id,PRODUCT);assert.equal(line.sku_snapshot,'SKU-1');assert.equal(line.title_snapshot,'Product');
});
await test('direct restock review verifies evidence, warnings, quantity and exact retry',async()=>{
  const id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const basis=(await one('select public.product_workflow_restock_basis($1,$2,90) b',[A,PRODUCT])).b;
  const body={...content,restock:{lead_days:0,cover_days:90,safety_units:0,basis}};
  await fail(()=>save(id,0,'reviewed',content,'restock',PRODUCT),/restock/);
  await fail(()=>save(id,0,'reviewed',{...body,restock:{...body.restock,basis:null},decision_note:'Override'},'restock',PRODUCT),/evidence/);
  for(const change of [{product_id:FOREIGN},{horizon_days:30},{units_90d:9000}]) {
    await fail(()=>save(id,0,'reviewed',{...body,restock:{...body.restock,basis:{...basis,...change}}},'restock',PRODUCT),/evidence/);
  }
  await fail(()=>save(id,0,'reviewed',body,'restock',PRODUCT),/decision note/);
  const reviewed={...body,decision_note:'Reviewed excluded partial PO; deliberately buying 90'};
  const saved=await save(id,0,'reviewed',reviewed,'restock',PRODUCT);
  await db.exec('reset role');await db.exec("update public.inventory_on_hand_current_v set total_available_quantity=101");await user();
  assert.deepEqual(await save(id,0,'reviewed',reviewed,'restock',PRODUCT),saved);
  const next='ffffffff-ffff-4fff-8fff-ffffffffffff';
  await fail(()=>save(next,0,'reviewed',reviewed,'restock',PRODUCT),/evidence/);
  await db.exec('reset role');
  await db.exec("update public.po_headers set status='Received' where po_name='Partial'; update public.inventory_on_hand_current_v set total_available_quantity=100");await user();
  const clean=(await one('select public.product_workflow_restock_basis($1,$2,90) b',[A,PRODUCT])).b;
  const exact={...body,lines:[{qty:840}],restock:{...body.restock,basis:clean}};
  await fail(()=>save(next,0,'reviewed',{...exact,lines:[{qty:839}]},'restock',PRODUCT),/decision note/);
  await fail(()=>save(next,0,'reviewed',{...exact,restock:{...exact.restock,basis:{...clean,observed_at:'2020-01-01T00:00:00Z'}}},'restock',PRODUCT),/decision note/);
  assert.equal((await save(next,0,'reviewed',exact,'restock',PRODUCT)).status,'reviewed');
  const missing='acacacac-acac-4cac-8cac-acacacacacac';
  await db.exec('reset role');await db.exec('delete from public.inventory_on_hand_current_v');await user();
  const noStock=(await one('select public.product_workflow_restock_basis($1,$2,90) b',[A,PRODUCT])).b;
  const manual={...exact,restock:{...exact.restock,basis:noStock}};
  await fail(()=>save(missing,0,'reviewed',manual,'restock',PRODUCT),/decision note/);
  assert.equal((await save(missing,0,'reviewed',{...manual,decision_note:'Stock unknown; manually verified supplier requirement'},'restock',PRODUCT)).status,'reviewed');

});
await test('catalog changes after review block both new outputs but allow original output replay',async()=>{
  const id='abababab-abab-4bab-8bab-abababababab';
  const saved=await save(id,0,'reviewed',content,'product',PRODUCT);
  await db.exec('reset role');await db.query("update public.products_master set sku='RENAMED',product_title='New name',updated_at=now() where id=$1",[PRODUCT]);await user();
  await fail(()=>handoff(id,saved.version),/Catalog source changed/);
  await fail(()=>handoff(id,saved.version,'launch','2026-12-01'),/Catalog source changed/);
  assert.ok((await handoff(id3,1,'launch','2027-01-01')).launch_id);
  assert.equal((await one('select po_header_id,launch_id from public.product_workflow_briefs where id=$1',[id])).po_header_id,null);
});
await test('a collection cannot be purchased as though it were a child product',async()=>{
  const id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const saved=await save(id,0,'reviewed');
  await db.exec('reset role');
  await db.query('insert into public.product_concepts(id,company_entity_id,title,status,parent_concept_id) values($1,$2,$3,$4,$5)',[id,A,'Child','draft',CONCEPT]);
  await user();await fail(()=>handoff(id,saved.version),/collection/);
});
await test('deleted output stays a consumed handoff and cannot be silently recreated',async()=>{
  await db.exec('reset role');await db.query('delete from public.launch_calendar where id=$1',[b.launch_id]);await user();
  await fail(()=>handoff(ID,b.version,'launch','2027-01-01'),/deleted or moved/);
});
await db.close();console.log(`${checks} database scenarios passed.`);
