// Local PostgreSQL tests for the final product-level RPC path. No production writes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const migration=await readFile(new URL('../../supabase/migrations/20260926082115_product_workflow_preview.sql',import.meta.url),'utf8');
let spread=await readFile(new URL('../../supabase/migrations/20260927074820_product_studio_variant_spread.sql',import.meta.url),'utf8');
const mutations={
  membership:["if jsonb_array_length(p_content->'lines') <> jsonb_array_length(p_source->'variants')", "if false and jsonb_array_length(p_content->'lines') <> jsonb_array_length(p_source->'variants')"],
  evidence:["if (basis-'observed_at') is distinct from (fresh-'observed_at') then",'if false then'],
  identity:["if public.product_workflow_variant_identity(family) is distinct from public.product_workflow_variant_identity(b.source_snapshot) then",'if false then'],
};
if(process.env.MUTATE){const [a,b]=mutations[process.env.MUTATE]||[];assert.ok(a&&spread.includes(a));spread=spread.replaceAll(a,b);}
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
await db.exec(migration);
await db.exec(`create table public.shopify_product_skus(company_entity_id uuid,shop_domain text,shopify_product_id text,shopify_variant_id text,sku text,product_title text,variant_title text,last_seen_at timestamptz default now());
 alter table public.shopify_product_skus enable row level security;
 create policy scoped on public.shopify_product_skus for select to authenticated using(company_entity_id=public.active_company_id());
 grant select on public.shopify_product_skus to authenticated;
`);
await db.exec(spread); await db.exec(spread);
const content={source_updated_at:'2026-09-26T00:00:00Z',title:'Reviewed tee',design_intent:'A summer baseball tee',audience:'Players',marketing_angle:'Everyday practice',draft_copy:'Suggested, not approved',factory_id:FACTORY,lines:[{size:'M',qty:90,unit_cost:5,retail_price:20}]};
const save=async(id=ID,version=0,status='draft',body=content,kind='concept',source=CONCEPT,co=A)=>(await one('select public.save_product_workflow_brief($1,$2,$3,$4,$5,$6,$7) b',[co,id,version,kind,source,body,status])).b;
const handoff=async(id,version,target='po',date=null,co=A)=>(await one('select public.handoff_product_workflow_brief($1,$2,$3,$4,$5) b',[co,id,version,target,date])).b;

const SMALL='77777777-7777-4777-8777-777777777778';
const group={shop_domain:'first.myshopify.com',shopify_product_id:'100'};
await db.query(`insert into public.products_master(id,company_entity_id,sku,product_title,product_type,variant_title) values($1,$2,'SKU-S','Product','Tee','S')`,[SMALL,A]);
await db.query(`insert into public.shopify_product_skus(company_entity_id,shop_domain,shopify_product_id,shopify_variant_id,sku,product_title,variant_title) values
 ($1,'first.myshopify.com','100','1001','SKU-1','Product','M'),($1,'first.myshopify.com','100','1002','SKU-S','Product','S'),
 ($1,'second.myshopify.com','200','2001','SKU-1','Product','M'),($2,'first.myshopify.com','100','1001','SKU-1','Foreign','M')`,[A,B]);
const source=async(g=group,co=A,id=PRODUCT)=>(await one('select public.product_workflow_catalog_source($1,$2,$3) b',[co,id,g])).b;
const basis=async(h=90)=>(await one('select public.product_workflow_product_basis($1,$2,$3,$4) b',[A,PRODUCT,group,h])).b;
const identity=s=>s.variants.map(v=>Object.fromEntries(['id','sku','product_title','product_type','variant_title','mapped_variant_title','mapped_product_title','shopify_variant_id'].map(k=>[k,v[k]??null])));
const preset=async()=>{const s=await source();return {...content,catalog_scope:'product',catalog_group:group,source_variant_identity:identity(s),source_variant_versions:s.variants.map(v=>({id:v.id,updated_at:v.updated_at})),lines:s.variants.map(v=>({product_master_id:v.id,size:'forged size',sku:'forged sku',qty:10,unit_cost:5}))};};
await user();
await test('migration idempotent, scoped reads and private helpers, no anonymous access',async()=>{
 for(const sig of ['product_workflow_catalog_source(uuid,uuid,jsonb)','product_workflow_catalog_search(uuid,text)','product_workflow_product_basis(uuid,uuid,jsonb,integer)','product_workflow_variant_identity(jsonb)','product_workflow_check_spread(jsonb,jsonb)','product_workflow_check_restock_spread(uuid,jsonb,jsonb)']) {
   assert.equal((await one("select has_function_privilege('anon',$1,'execute') ok",['public.'+sig])).ok,false);
   if(sig.includes('check_')||sig.includes('identity'))assert.equal((await one("select has_function_privilege('authenticated',$1,'execute') ok",['public.'+sig])).ok,false);
 }
 await fail(()=>source(group,B),/company/);await fail(()=>source(group,A,FOREIGN),/not found/);
 await user(VIEWER);await fail(()=>basis(),/permission/);await fail(()=>save(),/permission/);await user();
});
await test('search groups before limit, separates same-name stores, SKU match retrieves all siblings',async()=>{
 const rows=(await one('select public.product_workflow_catalog_search($1,$2) b',[A,'SKU-S'])).b;
 assert.equal(rows.length,1);assert.equal(rows[0].variant_count,2);assert.equal((await source()).variants.length,2);
 const all=(await one('select public.product_workflow_catalog_search($1,$2) b',[A,'Product'])).b;
 assert.equal(all.length,2);assert.deepEqual(new Set(all.map(x=>x.catalog_group.shop_domain)),new Set(['first.myshopify.com','second.myshopify.com']));
});
await test('missing, duplicate, foreign-only and ambiguous mapping fail closed; no scalar fallback for mapped SKU',async()=>{
 await fail(()=>source(null),/Choose the mapped/);
 await db.exec('reset role');
 await db.query("insert into public.shopify_product_skus values($1,'first.myshopify.com','100','bad','MISSING','Product','XXL',now())",[A]);await user();
 await fail(()=>source(),/incomplete/);
 await db.exec('reset role');await db.exec("update public.shopify_product_skus set sku='SKU-1' where shopify_variant_id='bad'");await user();await fail(()=>source(),/duplicated/);
 await db.exec('reset role');await db.exec("update public.shopify_product_skus set shopify_product_id='another' where shopify_variant_id='bad'");await user();await fail(()=>source(),/multiple products/);
 await db.exec('reset role');await db.exec("delete from public.shopify_product_skus where shopify_variant_id='bad'");await user();
});
await test('save rejects omitted, duplicate and foreign variants, stale sibling preset and changed product group',async()=>{
 const c=await preset();
 await fail(()=>save(randomUUID(),0,'draft',{...c,lines:c.lines.slice(0,1)},'product',PRODUCT),/each SKU/);
 await fail(()=>save(randomUUID(),0,'draft',{...c,lines:[c.lines[0],c.lines[0]]},'product',PRODUCT),/each SKU/);
 await fail(()=>save(randomUUID(),0,'draft',{...c,lines:[c.lines[0],{...c.lines[1],product_master_id:FOREIGN}]},'product',PRODUCT),/each SKU/);
 await fail(()=>save(randomUUID(),0,'draft',{...c,source_variant_identity:[]},'product',PRODUCT),/variants changed/);
 const id=randomUUID(), saved=await save(id,0,'draft',c,'product',PRODUCT);
 assert.deepEqual(await save(id,0,'draft',c,'product',PRODUCT),saved);
 await fail(()=>save(id,saved.version,'draft',{...c,catalog_group:null},'product',PRODUCT),/group cannot change/);
});
await test('one product yields canonical SKU PO lines; retry reuses output and legacy concept spread remains supported',async()=>{
 const c=await preset(),id=randomUUID();let b=await save(id,0,'reviewed',c,'product',PRODUCT);b=await handoff(id,b.version);
 const lines=(await db.query('select * from public.po_lines where po_header_id=$1 order by product_master_id',[b.po_header_id])).rows;
 assert.equal(lines.length,2);assert.deepEqual(lines.map(x=>x.product_master_id),[PRODUCT,SMALL]);assert.deepEqual(lines.map(x=>x.sku_snapshot),['SKU-1','SKU-S']);assert.deepEqual(lines.map(x=>x.variant_title_snapshot),['M','S']);
 assert.equal((await one('select status from public.po_headers where id=$1',[b.po_header_id])).status,'Draft');
 assert.equal((await handoff(id,1)).po_header_id,b.po_header_id);
 await fail(()=>save(id,b.version,'draft',c,'product',PRODUCT),/frozen/);
 const cid=randomUUID();let concept=await save(cid,0,'reviewed',{...content,lines:[{size:'Navy / S',qty:20},{size:'Navy / M',qty:30}]});concept=await handoff(cid,concept.version);
 assert.equal((await one('select sum(qty)::int n from public.po_lines where po_header_id=$1',[concept.po_header_id])).n,50);
});
await test('identity drift on a sibling blocks review and handoff; sync timestamp alone is permitted',async()=>{
 const c=await preset(),id=randomUUID();let b=await save(id,0,'reviewed',c,'product',PRODUCT);
 await db.exec('reset role');await db.query("update public.products_master set variant_title='CHANGED' where id=$1",[SMALL]);await user();
 await fail(()=>handoff(id,b.version),/source changed/);
 await db.exec('reset role');await db.query("update public.products_master set variant_title='S',updated_at=now() where id=$1",[SMALL]);await user();
 b=await handoff(id,b.version);assert.ok(b.po_header_id);
});
await db.exec('reset role');
await db.query(`insert into public.sales_by_day values($1,'SKU-1','2026-09-25',900,'Product'),($1,'SKU-S','2026-09-25',90,'Product');
`,[A]);
await db.query(`insert into public.inventory_on_hand_current_v values($1,'SKU-1',100,now()),($1,'SKU-S',1000,now())`,[A]);
await user();
await test('per-SKU math never nets excess small sizes against medium demand; zeros survive brief, not PO',async()=>{
 const c=await preset();c.restock={lead_days:0,cover_days:90,safety_units:0,bases:await basis()};c.lines[0].qty=800;c.lines[1].qty=0;
 const id=randomUUID();let b=await save(id,0,'reviewed',c,'restock',PRODUCT);assert.equal(b.content.lines.length,2);
 b=await handoff(id,b.version);const lines=(await db.query('select * from public.po_lines where po_header_id=$1',[b.po_header_id])).rows;
 assert.equal(lines.length,1);assert.equal(lines[0].product_master_id,PRODUCT);assert.equal(lines[0].qty,800);
});
await test('every sibling needs fresh evidence; manual overrides and unknown demand require a note',async()=>{
 const c=await preset();c.restock={lead_days:0,cover_days:90,safety_units:0,bases:await basis()};c.lines[0].qty=800;c.lines[1].qty=0;
 let bad=structuredClone(c);bad.restock.bases[1].on_hand=999;
 await fail(()=>save(randomUUID(),0,'reviewed',bad,'restock',PRODUCT),/evidence changed/);
 bad=structuredClone(c);bad.restock.bases.pop();await fail(()=>save(randomUUID(),0,'reviewed',bad,'restock',PRODUCT),/every SKU/);
 bad=structuredClone(c);bad.lines[0].qty=0;await fail(()=>save(randomUUID(),0,'reviewed',bad,'restock',PRODUCT),/decision note/);
 bad=structuredClone(c);bad.lines[1].qty=null;await fail(()=>save(randomUUID(),0,'reviewed',bad,'restock',PRODUCT),/Choose units/);
 await db.exec('reset role');await db.exec("delete from public.sales_by_day where sku='SKU-S'");await user();
 c.restock.bases=await basis();await fail(()=>save(randomUUID(),0,'reviewed',c,'restock',PRODUCT),/decision note/);
 c.decision_note='No known small demand. Deliberately skip this size.';const b=await save(randomUUID(),0,'reviewed',c,'restock',PRODUCT);assert.equal(b.content.lines[1].qty,0);
});
await test('second-line failure rolls back PO and all lines; retry creates one whole spread',async()=>{
 await db.exec('reset role');await db.exec(`create function public.test_spread_failure() returns trigger language plpgsql as $$ begin if new.sku_snapshot='SKU-S' then raise exception 'second line failure'; end if; return new; end $$; create trigger test_failure before insert on public.po_lines for each row execute function public.test_spread_failure();`);await user();
 const c=await preset(),id=randomUUID();let b=await save(id,0,'reviewed',c,'product',PRODUCT);const before=(await one('select count(*)::int n from public.po_headers')).n;
 await fail(()=>handoff(id,b.version),/second line failure/);assert.equal((await one('select count(*)::int n from public.po_headers')).n,before);assert.equal((await one('select po_header_id from public.product_workflow_briefs where id=$1',[id])).po_header_id,null);
 await db.exec('reset role');await db.exec('drop trigger test_failure on public.po_lines');await user();b=await handoff(id,b.version);assert.equal((await one('select count(*)::int n from public.po_lines where po_header_id=$1',[b.po_header_id])).n,2);
});
await test('31 siblings are retrieved as one complete product, never a client row cap',async()=>{
 await db.exec('reset role');
 for(let i=0;i<31;i++){const id=randomUUID();await db.query("insert into public.products_master(id,company_entity_id,sku,product_title,variant_title) values($1,$2,$3,'Big spread',$4)",[id,A,'BIG-'+i,''+i]);await db.query("insert into public.shopify_product_skus values($1,'first.myshopify.com','big',$2,$3,'Big spread',$4,now())",[A,'big-'+i,'BIG-'+i,''+i]);}
 await user();const rows=(await one('select public.product_workflow_catalog_search($1,$2) b',[A,'BIG-1'])).b;assert.equal(rows.length,1);assert.equal(rows[0].variant_count,31);assert.equal((await source(rows[0].catalog_group,A,rows[0].id)).variants.length,31);
});
await test('deployed verifier checks new RPC grants and writer integration',async()=>{
 const verifier=await readFile(new URL('../../supabase/verify_v2_schema.sql',import.meta.url),'utf8');
 const sql=verifier.slice(verifier.indexOf('-- Product Studio variant spread checks.'),verifier.indexOf('-- End Product Studio variant spread checks.'));
 for(const statement of sql.split(';').filter(x=>x.trim()))for(const row of (await db.query(statement)).rows)assert.equal(row.status,'ok');
});
console.log(`${checks} product spread database scenarios passed.`);await db.close();
