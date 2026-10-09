import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { curate } from '../lib/on-deck-core.mjs';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const db = new PGlite();
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333', VIEWER = '44444444-4444-4444-8444-444444444444', DISABLED = '55555555-5555-4555-8555-555555555555';
const PRODUCT = '66666666-6666-4666-8666-666666666666', PRODUCT2 = '77777777-7777-4777-8777-777777777777', LAUNCH = '88888888-8888-4888-8888-888888888888';
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const rpc = async (fn, args = []) => (await one(`select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args)).result;
const root = () => db.exec('reset role');
const user = async (id = ADMIN, company = A) => { await root(); await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('test.company',$2,false)", [id, company]); await db.exec('set role authenticated'); };
const service = async () => { await root(); await db.exec("select set_config('request.jwt.claim.sub','',false),set_config('test.company','',false); set role service_role"); };
let checks = 0;
const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };
await db.exec(await read('./on-deck-bootstrap.sql'));
await db.exec(`insert into public.entities values('${A}'),('${B}'); insert into auth.users values('${ADMIN}'),('${VIEWER}'),('${DISABLED}'); insert into public.profiles values('${ADMIN}','admin',true),('${VIEWER}','viewer',true),('${DISABLED}','admin',false); insert into public.entity_memberships values('${A}','${ADMIN}','owner_admin'),('${A}','${VIEWER}','viewer'),('${A}','${DISABLED}','admin');
insert into public.products_master(id,company_entity_id,sku,product_title,variant_title,unit_cost,msrp,lead_time_days,reorderable,is_evergreen) values('${PRODUCT}','${A}','TEE-S','Tee','Small',5,30,30,true,true),('${PRODUCT2}','${A}','TEE-M','Tee','Medium',5,30,30,true,true);
insert into public.shopify_product_skus(company_entity_id,shop_domain,shopify_product_id,shopify_variant_id,sku,product_title,variant_title) values('${A}','shop','123','1','TEE-S','Tee','Small'),('${A}','shop','123','2','TEE-M','Tee','Medium');
insert into public.launch_calendar(id,company_entity_id,title,launch_date,design_intent,audience,status) values('${LAUNCH}','${A}','Fall',current_date+7,'Fall baseball tee','Fans','planned');
insert into public.launch_product_readiness(company_entity_id,launch_id,product_title,readiness_status) values('${A}','${LAUNCH}','Tee','ready');`);
for (const path of ['../../supabase/migrations/20260926082115_product_workflow_preview.sql', '../../supabase/migrations/20260927074820_product_studio_variant_spread.sql']) await db.exec(await read(path));
let migration = await read('../../supabase/migrations/20260929074429_on_deck_preview.sql');
const mutations = {
 'company-read': ['company_entity_id=(select public.active_company_id()) and (select public.on_deck_can_review())', '(select public.on_deck_can_review())'],
 'budget': ['if spent+0.25>s.monthly_cap_usd then', 'if false then'],
 'version': ["if r.version is distinct from p_version then raise exception 'Proposal changed.", "if false then raise exception 'Proposal changed."],
 'source': ["if r.valid_until<now() or r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind) then", 'if false then'],
 'idempotency': ["if p_action='approve' and r.status='completed' and r.output is not null then", 'if false then'],
 'active-user': ['p.id=auth.uid() and p.is_active and', 'p.id=auth.uid() and'],
};
if (process.env.MUTATE) { const [before, after] = mutations[process.env.MUTATE] || []; assert.ok(before && migration.includes(before)); migration = migration.replace(before, after); }
await db.exec(migration); await db.exec(migration);
// The verifier checks this index, so install it as production has it.
await db.exec(await read('../../supabase/migrations/20260929171502_on_deck_inventory_lookup_index.sql'));
const draft = { proposed_title: 'Baseball tees | Example', proposed_meta_description: 'Explore classic baseball tees.', recommend: true, subject: 'Fall tee', summary: 'Baseball all season', body: 'Made for the next inning.', reason: 'A prepared draft for review', missing: [], tasks: [{ title: 'Review fall launch copy', detail: 'Confirm claims before publishing.' }] };
const epoch = kind => rpc('on_deck_source_version', [A, kind]);
const stage = async (kind, key = randomUUID()) => rpc('on_deck_stage', [A, { kind, key, title: `${kind} proposal`, score: 1, reason: 'Strongest evidence', source_id: kind === 'launch' ? LAUNCH : kind === 'restock' ? PRODUCT : null,
 source: kind === 'restock' ? { catalog_group: { shop_domain: 'shop', shopify_product_id: '123' }, vetting: {} } : kind === 'ads' ? { objective: 'purchase', ad_id: 'ad-1', baseline: { metric: 'roas', value: 3 } } : { url: 'https://store.example/products/tee' } }, await epoch(kind)]);
const get = async id => (await one('select to_jsonb(p) p from public.on_deck_proposals p where id=$1', [id])).p;
const reserve = (p, request = randomUUID()) => rpc('on_deck_reserve', [p.id, p.version, request]);
const finish = (request, content = draft, input = 1000, output = 100, error = null) => rpc('on_deck_finish', [request, content, input, output, error]);
const ready = async kind => { await service(); const id = await stage(kind); assert.ok(id); const p = await get(id), claim = await reserve(p); assert.ok(claim.claimed); await finish(claim.run); return get(id); };
const decide = (p, action, note = null, content = null, minutes = null) => rpc('on_deck_decide', [p.id, p.version, action, note, content, minutes]);
await root();
await db.exec('alter table public.seo_tasks add column updated_at timestamptz default now(); alter table public.profiles add column name text; alter table public.profiles add column email text; alter table public.launch_tasks add column assigned_to_user_id uuid;');
let loop = await read('../../supabase/migrations/20261008212803_on_deck_action_loop.sql');
const changes = {
 'context-company': ["where id=p_id and company_entity_id=public.active_company_id() for update", "where id=p_id for update"],
 'context-owner': ["if not exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=p_assignee", "if false and not exists(select 1 from public.profiles p join public.entity_memberships m on m.user_id=p.id where p.id=p_assignee"],
 'seo-fields': ["r.content->>'proposed_title',r.content->>'proposed_meta_description'", "r.content->>'subject',r.content->>'summary'"],
 'request-evidence': ["if md5(btrim(p_note))=r.context_work->>'request_notes_hash' then", 'if false then'],
 'context-freshness': ["if r.valid_until<=now() or r.source_version is distinct from public.on_deck_source_version(r.company_entity_id,r.kind) then", 'if false then'],
 'evidence-recency': ['order by updated_at desc nulls last,id limit 10', 'order by id limit 10'],
 'duplicate-titles': ["if p_kind='launch' and exists(select 1 from jsonb_array_elements(p_content->'tasks') t group by lower(btrim(t->>'title')) having count(*)>1) then", 'if false then'],
 'edit-expiry': ["if r.valid_until<=now() or r.source_version<>", "if r.source_version<>"],
 'linked-context': ["and not exists(select 1 from public.on_deck_proposals p where p.company_entity_id=p_company and p.context_work->>'task_id'=t.id::text and p.status not in ('completed','dismissed','screened'))", ""],
 'launch-reuse': ["if oid is null then", "if true then"]
};
if (process.env.LOOP_MUTATE) { const [a,b]=changes[process.env.LOOP_MUTATE]; assert.ok(loop.includes(a)); loop=loop.replace(a,b); }
await db.exec(loop); await db.exec(loop);
await user(); await rpc('on_deck_configure', [true,100,10000,['seo','ads','launch','restock']]);
const context = (p, action, owner=null, task=null, note=null) => rpc('on_deck_context',[p.id,p.version,action,owner,task,note]);
await test('missing context creates one owned task; unknown outcome replay returns it; no approval', async () => {
 let p=await ready('seo'); await user(); p=await decide(p,'edit','Facts require a documented product claim.',{...draft,missing:['Confirm the supported product claim before drafting it.']});
 await assert.rejects(()=>context(p,'create',DISABLED),/active company/);
 const opened=await context(p,'create',ADMIN); const replay=await context(p,'create',ADMIN);
 assert.equal(opened.context_work.task_id,replay.context_work.task_id); assert.equal(opened.status,'needs_info'); assert.equal(opened.output,null);
 const task=await one('select * from public.launch_tasks where id=$1',[opened.context_work.task_id]); assert.equal(task.assigned_to_user_id,ADMIN); assert.equal(task.company_entity_id,A); assert.ok(task.notes.includes(p.id));
 await assert.rejects(()=>decide(opened,'approve'),/prepared/);
 for (const [id,co] of [[ADMIN,B],[VIEWER,A],[DISABLED,A]]) {await user(id,co); await assert.rejects(()=>context(opened,'resolve',null,null,'Evidence from approved product brief.'),/Company admin|unavailable/);}
 await root(); await db.query(`insert into public.entity_memberships values($1,$2,'admin')`,[B,ADMIN]); await user(ADMIN,B); await assert.rejects(()=>context(opened,'resolve',null,null,'Evidence from approved product brief.'),/unavailable/); await user();
 const resolved=await context(opened,'resolve',null,null,'Verified claim in the approved product brief, revision 3.');
 assert.equal(resolved.status,'failed'); assert.equal(resolved.context_work.state,'resolved'); assert.equal(resolved.content.missing.length,1);
 assert.equal((await context(opened,'resolve',null,null,'Verified claim in the approved product brief, revision 3.')).version,resolved.version);
 await service(); const next=await rpc('on_deck_stage',[A,{kind:'seo',key:resolved.source_key,title:'SEO draft',score:1,reason:'Current evidence',source:resolved.source},await epoch('seo')]); assert.equal(next,p.id);
 p=await get(next); assert.equal(p.status,'preparing'); assert.ok(p.context_work.resolution.includes('revision 3'));
 const claim=await reserve(p); await finish(claim.run); p=await get(p.id); assert.equal(p.status,'ready');
 await user(); const done=await decide(p,'approve'); const target=await one('select * from public.seo_tasks where id=$1',[done.output.id]);
 assert.equal(target.proposed_title,draft.proposed_title); assert.equal(target.proposed_meta_description,draft.proposed_meta_description); assert.equal(target.approval_status,'draft');
 assert.equal((await decide(p,'approve')).output.id,done.output.id);
});
await test('link existing public owned task, reject foreign/private/unowned tasks, keep assignment', async () => {
 let p=await ready('ads'); await user(); p=await decide(p,'edit','Need verified audience facts.',{...draft,missing:['Verify target audience for this claim']});
 await root(); const ids=[]; for(const [co,privateTask,owner] of [[B,false,ADMIN],[A,true,ADMIN],[A,false,null],[A,false,ADMIN]]) ids.push((await one(`insert into public.launch_tasks(company_entity_id,task_title,status,is_private,assigned_to_user_id) values($1,'Existing research','open',$2,$3) returning id`,[co,privateTask,owner])).id);
 await user(); for(const id of ids.slice(0,3)) await assert.rejects(()=>context(p,'link',null,id),/public task|owner/);
 const linked=await context(p,'link',null,ids[3]); assert.equal(linked.context_work.task_id,ids[3]);
 await service(); const before=linked.version; await rpc('on_deck_stage',[A,{kind:'ads',key:linked.source_key,title:'New',score:1,reason:'New',source:{}},await epoch('ads')]); assert.equal((await get(p.id)).version,before);
 await user(); await decide(linked,'dismiss','Not pursuing this opportunity now.');
});
await test('freshness readout and legacy SEO mapping fail closed; optional enrichment does not block', async () => {
 let p=await ready('seo'); await user(); p=await decide(p,'edit','Retain optional measurement context.',{...draft,optional_context:['No comparative CTR benchmark is recorded.']}); assert.equal(p.status,'ready');
 await service(); await db.query(`insert into public.page_inspections(company_entity_id,requested_url,title) values($1,'https://example.test/new','New')`,[A]); await user();
 const state=await rpc('on_deck_review_state'); assert.equal(state.proposals.find(x=>x.id===p.id).source_current,false);
 await assert.rejects(()=>decide(p,'approve'),/Evidence changed/); await decide(p,'refresh'); await service();
 p=await ready('seo'); const legacy={...draft}; delete legacy.proposed_title; delete legacy.proposed_meta_description; await user(); p=await decide(p,'edit','Legacy draft retained for review.',legacy); await assert.rejects(()=>decide(p,'approve'),/structured/); await decide(p,'dismiss','Legacy draft replaced by fresh preparation.');
});
await test('launch handoff reuses existing matching work and retries without duplicates', async () => {
 await root(); const old=await one(`insert into public.launch_tasks(company_entity_id,launch_id,task_title,status,notes,assigned_to_user_id) values($1,$2,$3,'open','Keep my notes',$4) returning id`,[A,LAUNCH,draft.tasks[0].title,ADMIN]);
 const p=await ready('launch'); await user(); const done=await decide(p,'approve'); assert.deepEqual(done.output.ids,[old.id]); assert.deepEqual((await decide(p,'approve')).output.ids,[old.id]);
 const task=await one('select * from public.launch_tasks where id=$1',[old.id]); assert.ok(task.notes.startsWith('Keep my notes')); assert.ok(task.notes.includes(draft.body)); assert.equal(task.notes.split('On Deck approved draft:').length,2); assert.equal(task.assigned_to_user_id,ADMIN);
});
await test('saved evidence reader is service-only, scoped and excludes private work',async()=>{
 await user(); await assert.rejects(()=>rpc('on_deck_context_evidence',[A,'seo',{url:'https://store.example/products/tee'}]),/permission denied/);
 await service(); const evidence=await rpc('on_deck_context_evidence',[A,'seo',{url:'https://store.example/products/tee'}]); assert.ok(evidence.seo_work.length>0);
 assert.equal((await rpc('on_deck_context_evidence',[B,'seo',{url:'https://store.example/products/tee'}])).seo_work.length,0);
 for(const role of ['anon','authenticated']) assert.equal((await one(`select has_function_privilege($1,'public.on_deck_context_evidence(uuid,text,jsonb)','execute') ok`,[role])).ok,false);
});

await test('launch context resolution survives real facts and screening; member notes reach reviewer', async () => {
 await root(); await db.query('delete from public.launch_tasks where launch_id=$1',[LAUNCH]); // remove prior scenario's campaign task
 let p=await ready('launch'); await root(); await db.query("update public.on_deck_proposals set title='Prepare launch campaign - Example' where id=$1",[p.id]);
 await db.query("update public.entity_memberships set role='member' where entity_id=$1 and user_id=$2",[A,VIEWER]); await user(); p=await get(p.id);
 p=await decide(p,'edit','Channel confirmation is necessary.',{...draft,missing:['Confirm the channel for this launch copy.']});
 const work=await context(p,'create',VIEWER); await root();
 await db.query('update public.launch_tasks set notes=$1 where id=$2',['Findings: the approved launch plan specifies email. Source: launch brief revision 4.',work.context_work.task_id]); await user();
 const view=await rpc('on_deck_review_state'); assert.ok(view.context_tasks.find(t=>t.id===work.context_work.task_id).notes.includes('revision 4'));
 p=await context(work,'resolve',null,null,'Approved launch brief revision 4 specifies email.'); await service();
 const facts=(await db.query('select * from public.on_deck_launch_facts($1,0)',[A])).rows.map(x=>x.on_deck_launch_facts);
 assert.ok(facts[0].tasks.every(t=>!t.title.startsWith('Resolve context:')));
 const shortlist=curate({launches:facts,settings:{workflows:['launch']}}).shortlist; assert.equal(shortlist.length,1);
 const candidate=shortlist[0]; candidate.key=p.source_key;
 assert.equal(await rpc('on_deck_stage',[A,candidate,await epoch('launch')]),p.id);
 assert.equal((await get(p.id)).status,'preparing'); const claim=await reserve(await get(p.id)); await finish(claim.run); await user(); await decide(await get(p.id),'dismiss','Fixture launch finished its resolution test.');
});
await test('task insertion failure rolls back link and event; retry safely creates one task', async()=>{
 let p=await ready('ads'); await user(); p=await decide(p,'edit','Need a verified claim source.',{...draft,missing:['Verify the claim source']}); await root();
 await db.exec("alter table public.launch_tasks add constraint reject_context_fixture check(task_type is distinct from 'on_deck_context') not valid");
 await user(); await assert.rejects(()=>context(p,'create',ADMIN),/reject_context_fixture/); assert.deepEqual((await get(p.id)).context_work,{});
 await root(); await db.exec('alter table public.launch_tasks drop constraint reject_context_fixture'); await user(); const work=await context(p,'create',ADMIN);
 assert.ok(work.context_work.task_id); assert.equal((await context(p,'create',ADMIN)).context_work.task_id,work.context_work.task_id); await decide(work,'dismiss','Fixture completed rollback and retry checks.');
});
await test('new saved evidence invalidates SEO and ad freshness fingerprints',async()=>{
 await service(); const seoBefore=await epoch('seo'),adBefore=await epoch('ads');
 await db.query("insert into public.seo_tasks(company_entity_id,title,target_url,approval_status) values($1,'Existing copy','https://example.test/tees','draft')",[A]); assert.notEqual(await epoch('seo'),seoBefore);
 await db.query("insert into public.page_inspections(company_entity_id,requested_url,title) values($1,'https://example.test/landing','Landing copy')",[A]); assert.notEqual(await epoch('ads'),adBefore);
});

await test('completed launch work cannot capture a new handoff',async()=>{
 await root(); await db.query('delete from public.launch_tasks where launch_id=$1',[LAUNCH]);
 const old=await one("insert into public.launch_tasks(company_entity_id,launch_id,task_title,status,notes) values($1,$2,$3,'done','Completed work') returning id",[A,LAUNCH,draft.tasks[0].title]);
 const p=await ready('launch'); await user(); const done=await decide(p,'approve'); assert.notEqual(done.output.ids[0],old.id);
 assert.equal((await one('select status from public.launch_tasks where id=$1',[done.output.ids[0]])).status,'open');
});
await test('long context notes explicitly disclose truncated import',async()=>{
 let p=await ready('ads'); await user(); p=await decide(p,'edit','Need verified evidence.',{...draft,missing:['Verify evidence']}); const work=await context(p,'create',ADMIN); await root();
 await db.query('update public.launch_tasks set notes=$1 where id=$2',['Old notes '.repeat(500)+'APPENDED FINDING',work.context_work.task_id]); await user();
 const task=(await rpc('on_deck_review_state')).context_tasks.find(t=>t.id===work.context_work.task_id); assert.equal(task.notes_truncated,true); assert.equal(task.notes.length,4000);
});
await test('expired edit is rejected atomically even when the source fingerprint is current',async()=>{
 let p=await ready('seo'); await root(); await db.query("update public.on_deck_proposals set valid_until=now()-interval '1 second' where id=$1",[p.id]); await user();
 await assert.rejects(()=>decide(p,'edit','Keep reviewed content.',draft),/expired/); assert.equal((await get(p.id)).version,p.version); await decide(p,'dismiss','Expiry fixture finished.');
});
await test('linked launch research survives resolution and campaign screening',async()=>{
 await root(); await db.query('delete from public.launch_tasks where launch_id=$1',[LAUNCH]);
 const task=await one("insert into public.launch_tasks(company_entity_id,launch_id,task_title,task_type,status,assigned_to_user_id) values($1,$2,'Audience evidence','marketing','open',$3) returning id",[A,LAUNCH,ADMIN]); await service();
 const initialFacts=(await db.query('select * from public.on_deck_launch_facts($1,0)',[A])).rows.map(x=>x.on_deck_launch_facts);
 const initial=curate({launches:initialFacts,settings:{workflows:['launch']}}).shortlist[0];assert.ok(initial);
 const id=await rpc('on_deck_stage',[A,initial,await epoch('launch')]);assert.ok(id);const claim=await reserve(await get(id));await finish(claim.run);
 let p=await get(id); await user(); p=await decide(p,'edit','Campaign audience evidence needed.',{...draft,missing:['Confirm campaign audience']});
 p=await context(p,'link',null,task.id); await root();await db.query("update public.launch_tasks set task_title='Research campaign audience' where id=$1",[task.id]);await user();
 p=await context(p,'resolve',null,null,'Approved brief confirms baseball fans as the audience.'); await service();
 const facts=(await db.query('select * from public.on_deck_launch_facts($1,0)',[A])).rows.map(x=>x.on_deck_launch_facts);
 const shortlist=curate({launches:facts,settings:{workflows:['launch']}}).shortlist; assert.equal(shortlist.length,1);
 const candidate=shortlist[0]; candidate.key=p.source_key; assert.equal(await rpc('on_deck_stage',[A,candidate,await epoch('launch')]),p.id);
});

await test('new campaign work makes stale pre-link proposals requalify instead of assigning obsolete work',async()=>{
 await root();await db.query('delete from public.launch_tasks where launch_id=$1',[LAUNCH]);
 let p=await ready('launch');await user();p=await decide(p,'edit','Missing campaign audience.',{...draft,missing:['Confirm campaign audience']});await root();
 const task=await one("insert into public.launch_tasks(company_entity_id,launch_id,task_title,status,assigned_to_user_id) values($1,$2,'Research campaign audience','open',$3) returning id",[A,LAUNCH,ADMIN]);await user();
 await assert.rejects(()=>context(p,'link',null,task.id),/Evidence changed/);p=await decide(p,'refresh');assert.equal(p.user_edited,false);assert.deepEqual(p.context_work,{});await service();
 const facts=(await db.query('select * from public.on_deck_launch_facts($1,0)',[A])).rows.map(x=>x.on_deck_launch_facts);
 assert.equal(curate({launches:facts,settings:{workflows:['launch']}}).shortlist.length,0); // worker retires unedited unqualified proposals
});

await test('unchanged request notes cannot resolve created or linked context work',async()=>{
 await root(); await db.exec("update public.on_deck_proposals set status='dismissed'");
 for(const action of ['create','link']) {
  let p=await ready('ads'); await user(); p=await decide(p,'edit','Need verified evidence.',{...draft,missing:['Verify audience evidence']});
  let id=null; if(action==='link'){await root(); id=(await one("insert into public.launch_tasks(company_entity_id,task_title,status,notes,assigned_to_user_id) values($1,'Existing research','open','Prior request text',$2) returning id",[A,ADMIN])).id;await user();}
  const work=await context(p,action,action==='create'?ADMIN:null,id); const task=await one('select notes from public.launch_tasks where id=$1',[work.context_work.task_id]);
  const state=await rpc('on_deck_review_state'); assert.equal(state.context_tasks.find(t=>t.id===work.context_work.task_id).notes_are_request,true);
  await assert.rejects(()=>context(work,'resolve',null,null,'  '+task.notes+'  '),/actual findings/);
  assert.equal((await get(p.id)).context_work.state,'open');
  const resolved=await context(work,'resolve',null,null,'Approved brief revision 5 confirms the audience and documents its source.'); assert.equal(resolved.context_work.state,'resolved');
  await decide(resolved,'dismiss','Fixture finished its evidence check.');
 }
});
await test('new context assignment rejects expired and changed evidence without writes',async()=>{
 let p=await ready('ads'); await user(); p=await decide(p,'edit','Need verified evidence.',{...draft,missing:['Verify current claim']}); await root();
 const task=await one("insert into public.launch_tasks(company_entity_id,task_title,status,assigned_to_user_id) values($1,'Existing evidence','open',$2) returning id",[A,ADMIN]);
 const before=(await one('select count(*) n from public.launch_tasks')).n;
 await db.query("update public.on_deck_proposals set valid_until=now()-interval '1 second' where id=$1",[p.id]); await user();
 for(const action of ['create','link']) await assert.rejects(()=>context(p,action,ADMIN,task.id),/expired/);
 await root(); await db.query("update public.on_deck_proposals set valid_until=now()+interval '1 day',source_version='obsolete' where id=$1",[p.id]); await user();
 for(const action of ['create','link']) await assert.rejects(()=>context(p,action,ADMIN,task.id),/Evidence changed/);
 assert.equal((await one('select count(*) n from public.launch_tasks')).n,before); assert.deepEqual((await get(p.id)).context_work,{});
 await root(); await db.query('update public.on_deck_proposals set source_version=$1 where id=$2',[await epoch('ads'),p.id]);await user();
 const work=await context(p,'create',ADMIN); await root();await db.query("update public.on_deck_proposals set valid_until=now()-interval '1 second' where id=$1",[p.id]); await user();
 assert.equal((await context(p,'create',ADMIN)).context_work.task_id,work.context_work.task_id); // unknown-outcome replay creates nothing
 const resolved=await context(work,'resolve',null,null,'Verified current claim from the approved source document.'); assert.equal(resolved.context_work.state,'resolved'); await decide(resolved,'dismiss','Fixture complete.');
});
await test('bounded evidence prioritizes newest records and discloses omitted collections and notes',async()=>{
 await root(); await db.query('delete from public.launch_tasks where launch_id=$1',[LAUNCH]);
 for(let i=0;i<22;i++) await db.query("insert into public.launch_tasks(id,company_entity_id,launch_id,task_title,status,notes,updated_at) values($1,$2,$3,$4,'open',$5,$6)",['eeeeeeee-0000-4000-8000-'+String(i).padStart(12,'0'),A,LAUNCH,'Research '+i,i===21?'Old request '.repeat(100)+'DECISIVE CORRECTION':'Complete note',new Date(Date.UTC(2026,0,i+1)).toISOString()]);
 for(let i=0;i<12;i++) await db.query("insert into public.seo_tasks(id,company_entity_id,title,target_url,approval_status,updated_at) values($1,$2,$3,'https://example.test/recency','draft',$4)",['dddddddd-0000-4000-8000-'+String(i).padStart(12,'0'),A,'Saved SEO '+i,new Date(Date.UTC(2026,0,i+1)).toISOString()]);
 await service(); const seo=await rpc('on_deck_context_evidence',[A,'seo',{url:'https://example.test/recency'}]); assert.equal(seo.seo_work.length,10);assert.equal(seo.seo_work[0].title,'Saved SEO 11');assert.equal(seo.seo_work_truncated,true);
 const launch=await rpc('on_deck_context_evidence',[A,'launch',{id:LAUNCH}]);assert.equal(launch.launch_work.length,20);assert.equal(launch.launch_work[0].task_title,'Research 21');assert.equal(launch.launch_work_truncated,true);assert.equal(launch.launch_work[0].notes_truncated,true);assert.equal(launch.launch_work[0].notes,null);assert.match(launch.limits,/withheld/);
 const empty=await rpc('on_deck_context_evidence',[B,'launch',{id:LAUNCH}]);assert.equal(empty.launch_work.length,0);assert.equal(empty.launch_work_truncated,false);
});
await test('duplicate normalized launch titles are refused before writes or receipts',async()=>{
 await root();await db.exec("update public.on_deck_proposals set status='dismissed'");
 const duplicate={...draft,tasks:[{title:'Write email',detail:'A'},{title:' write email ',detail:'B'}]};
 const p=await ready('launch');await user();await assert.rejects(()=>decide(p,'edit','Review duplicate title fixture.',duplicate),/Invalid draft/);
 await root();await db.query('update public.on_deck_proposals set content=$1 where id=$2',[duplicate,p.id]);await user();
 const count=(await one('select count(*) n from public.launch_tasks')).n;await assert.rejects(()=>decide(p,'approve'),/missing information/);assert.equal((await one('select count(*) n from public.launch_tasks')).n,count);assert.equal((await get(p.id)).output,null);
});

console.log(checks + " action-loop database checks passed"); await db.close();
