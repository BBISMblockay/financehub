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
await db.exec(await read('../../supabase/migrations/20261008212803_on_deck_action_loop.sql'));
let reviewMigration = await read('../../supabase/migrations/20261014120000_on_deck_review_action.sql');
const reviewMutations = {
 'completeness': ["jsonb_array_length(public.on_deck_draft_blockers(p_content,r.kind))>0", "false"],
 'required-input': ["if (item-'answer'-'mode') is distinct from (old-'answer'-'mode') then", "if false then"],
 'detach-company': ["where id=p_id and company_entity_id=public.active_company_id() for update", "where id=p_id for update"],
 'reviewed-title': ["left(r.content->>'subject',200)", "left(r.title,200)"],
 'approval-blockers': ["or jsonb_array_length(public.on_deck_draft_blockers(r.content,r.kind))>0", ""],
 'detach-requeue': ["if r.status='failed' and r.source_version='' then\n   update public.on_deck_settings set requested_at=now() where company_entity_id=r.company_entity_id;\n  end if;", ""],
};
// Evidence drift warns instead of blocking (20261015013000). Loaded after the
// migration it replaces, exactly as production applies it -- which is why a
// REVIEW_MUTATE must reach BOTH files: 20261015013000 redefines on_deck_context
// and on_deck_decide, so mutating only the older copy installed a clean body and
// the mutation silently survived.
let mutated = null;
let driftMigration = await read('../../supabase/migrations/20261015013000_on_deck_evidence_drift_warns.sql');
const driftMutations = {
 'drift-blocks-again': ["coalesce(r.source_version,'')=''", "r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind)"],
 'empty-basis': ["coalesce(r.source_version,'')=''", "false"],
 'expiry': ["r.valid_until<=now() or coalesce(r.source_version,'')=''", "false"],
 'drift-record': ["'evidence_drifted',r.source_version<>public.on_deck_source_version(r.company_entity_id,r.kind)", "'evidence_drifted',false"],
 'drift-flag': ["'review_contract',2,'drift_warns',true,", "'review_contract',2,"],
};
if (process.env.REVIEW_MUTATE) {
 const [a,b]=reviewMutations[process.env.REVIEW_MUTATE] || [];
 assert.ok(a, 'unknown REVIEW_MUTATE');
 const inReview=reviewMigration.includes(a), inDrift=driftMigration.includes(a);
 assert.ok(inReview || inDrift, 'mutation target is in neither migration');
 if (inReview) reviewMigration=reviewMigration.replaceAll(a,b);
 if (inDrift) driftMigration=driftMigration.replaceAll(a,b);
 mutated=a;
}
if (process.env.DRIFT_MUTATE) { const [a,b]=driftMutations[process.env.DRIFT_MUTATE] || []; assert.ok(a && driftMigration.includes(a)); driftMigration=driftMigration.replaceAll(a,b); mutated=a; }
// 20261016170000 replaces on_deck_source_version and on_deck_review_state again,
// so it is the one that must carry a mutation aimed at either of those bodies.
let cheapMigration = await read('../../supabase/migrations/20261016170000_on_deck_source_version_cheap.sql');
const cheapMutations = {
 'scan-search-console-again': ["(select max(finished_at)::text from public.sync_jobs where company_entity_id=p_company and status='success' and job_type='search_console_daily')", "(select concat(count(*),':',max(synced_at)) from public.search_console_page_daily where company_entity_id=p_company)"],
 'version-per-row': ["'source_current',p.source_version=vers->>p.kind", "'source_current',p.source_version=public.on_deck_source_version(co,p.kind)"],
 'version-map-empty': ["select distinct kind k from public.on_deck_proposals where company_entity_id=co and status not in ('completed','dismissed','screened')", "select null::text k where false"],
};
if (process.env.CHEAP_MUTATE) { const [a,b]=cheapMutations[process.env.CHEAP_MUTATE] || []; assert.ok(a && cheapMigration.includes(a), 'unknown CHEAP_MUTATE'); cheapMigration=cheapMigration.replaceAll(a,b); mutated=a; }
if (process.env.REVIEW_MUTATE || process.env.DRIFT_MUTATE) {
 // A mutation aimed at a body this migration replaces has to reach this copy too,
 // or the clean body installs over it and the mutation proves nothing.
 const [a,b]=(reviewMutations[process.env.REVIEW_MUTATE] || driftMutations[process.env.DRIFT_MUTATE] || []);
 if (a && cheapMigration.includes(a)) cheapMigration=cheapMigration.replaceAll(a,b);
}
await db.exec(reviewMigration); await db.exec(reviewMigration);
await db.exec(driftMigration); await db.exec(driftMigration);
await db.exec(cheapMigration); await db.exec(cheapMigration);
// The mutation has to be absent from what is actually INSTALLED, or the run proves
// nothing: a later migration can replace the body a mutation was applied to.
if (mutated) {
 const left=await one("select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and position($1 in p.prosrc)>0",[mutated]);
 assert.equal(Number(left.n),0,'the mutated text is still installed; the mutation did not take effect');
}
await user(); await rpc('on_deck_configure', [true,100,10000,['seo','ads','launch','restock']]);
await root(); await db.query("insert into public.entity_memberships values($1,$2,'admin')",[B,ADMIN]);
const context = (p, action, task = null, note = null) => rpc('on_deck_context',[p.id,p.version,action,null,task,note]);
const plan = c => (c.review_inputs || [...(c.missing||[]).map((label,i)=>({id:'required:'+i,label,requirement:'required',answer:'',mode:'unanswered'})),...(c.optional_context||[]).map((label,i)=>({id:'optional:'+i,label,requirement:'optional',answer:'',mode:'unanswered'}))]);
const edit = (p, c) => decide(p,'edit','Reviewed the fields and supporting evidence.',c);
await test('incomplete SEO finish and edit never become ready; manual fields complete it',async()=>{
 await service(); const id=await stage('seo'); let p=await get(id); const claim=await reserve(p);
 await finish(claim.run,{...draft,missing:[],proposed_title:'',proposed_meta_description:''}); p=await get(id); assert.equal(p.status,'needs_info');
 await user(); p=await edit(p,{...p.content,subject:'Reviewed task title',body:'Reviewed exact body'}); assert.equal(p.status,'needs_info');
 await assert.rejects(()=>decide(p,'approve'),/prepared|missing/);
 await root(); await db.query("update public.on_deck_proposals set status='ready' where id=$1",[p.id]); await user(); await assert.rejects(()=>decide(p,'approve'),/missing|Fill/);
 p=await edit(p,{...p.content,proposed_title:'Reviewed search title',proposed_meta_description:'Reviewed metadata grounded in the page.'}); assert.equal(p.status,'ready');
 const done=await decide(p,'approve'); const task=await one('select * from public.seo_tasks where id=$1',[done.output.id]);
 assert.equal(task.title,'Reviewed task title'); assert.equal(task.proposed_body,'Reviewed exact body'); assert.equal(task.proposed_title,'Reviewed search title'); assert.equal(task.approval_status,'draft'); assert.equal(done.output.url,'/v2/seo-tasks.html?task='+task.id);
 const replay=await decide(p,'approve'); assert.equal(replay.output.id,done.output.id); assert.equal((await one('select count(*) n from public.seo_tasks where id=$1',[task.id])).n,1);
});
await test('saved required answers reopen, edit and finish; optional research survives creation',async()=>{
 await service(); const id=await stage('ads'); let p=await get(id), claim=await reserve(p); await finish(claim.run,{...draft,missing:['Essential business claim'],optional_context:['CTR benchmark']}); p=await get(id); await user();
 let inputs=structuredClone(p.content.review_inputs); inputs[0].answer='Approved brief revision 4 confirms this claim.';inputs[0].mode='answered';inputs[1].mode='carry';
 p=await edit(p,{...p.content,review_inputs:inputs}); assert.equal(p.status,'ready'); assert.equal(p.content.missing.length,0);
 inputs=structuredClone(p.content.review_inputs); inputs[0].mode='unanswered'; p=await edit(p,{...p.content,review_inputs:inputs}); assert.equal(p.status,'needs_info'); assert.ok(p.content.review_inputs[0].answer.includes('revision 4'));
 inputs=structuredClone(p.content.review_inputs);inputs[0].mode='answered';inputs[0].answer='Approved brief revision 5 corrects the previous claim.';p=await edit(p,{...p.content,subject:'Reviewed ad idea',body:'Edited creative copy.',review_inputs:inputs});
 const done=await decide(p,'approve');const idea=await one('select * from public.ad_ideas where id=$1',[done.output.id]); assert.equal(idea.title,'Reviewed ad idea');assert.match(idea.body_draft,/revision 5/);assert.doesNotMatch(idea.body_draft,/revision 4/);assert.match(idea.body_draft,/Research to complete[\s\S]*CTR benchmark/);assert.equal(idea.status,'idea');assert.equal(done.output.url,'/v2/ad-studio.html?view=ideas&idea='+idea.id);
});
await test('required facts cannot be deleted, downgraded, carried or resolved without a reason',async()=>{
 await service();const id=await stage('seo');let p=await get(id),claim=await reserve(p);await finish(claim.run,{...draft,missing:['Any prior SEO test history for this page']});p=await get(id);await user();
 const original=plan(p.content);assert.equal(original[0].requirement,'required');
 await assert.rejects(()=>edit(p,{...p.content,review_inputs:[]}),/Keep all/);
 const changed=structuredClone(original);changed[0].requirement='optional';changed[0].mode='carry';await assert.rejects(()=>edit(p,{...p.content,review_inputs:changed}),/reclassified/);
 const carry=structuredClone(original);carry[0].mode='carry';await assert.rejects(()=>edit(p,{...p.content,review_inputs:carry}),/Essential/);
 const answered=structuredClone(original);answered[0].answer='Approved historic test notes.';answered[0].mode='answered';await assert.rejects(()=>decide(p,'edit','',{...p.content,review_inputs:answered}),/Explain/);
 await root(); await db.query("update public.on_deck_proposals set status='ready',content=jsonb_set(content,'{missing}','[]') where id=$1",[p.id]); await user(); await assert.rejects(()=>decide(p,'approve'),/missing/);
 assert.equal((await get(p.id)).version,p.version);await decide(p,'dismiss','Not pursuing this opportunity; evidence remains retained.');
});
await test('private/deleted links detach without disclosure or task writes and can be replaced',async()=>{
 for(const privateTask of [true,false]) {
  await service();const id=await stage('ads');let p=await get(id),claim=await reserve(p);await finish(claim.run,{...draft,missing:['Verify claim']});p=await get(id);await root();
  const t=await one("insert into public.launch_tasks(company_entity_id,task_title,status,notes,assigned_to_user_id,is_private) values($1,'Secret private title','open','Secret notes',$2,$3) returning id",[A,ADMIN,privateTask]);
  await db.query("update public.on_deck_proposals set context_work=$2 where id=$1",[p.id,{state:'open',task_id:t.id,title:'Secret private title'}]);if(!privateTask)await db.query('delete from public.launch_tasks where id=$1',[t.id]);await user();p=await get(p.id);
  const rs=await rpc('on_deck_review_state');assert.ok(!rs.context_tasks.some(x=>x.id===t.id));
  await user(ADMIN,B);await assert.rejects(()=>context(p,'detach',null,'This context link is unavailable.'),/unavailable/);await user(VIEWER,A);await assert.rejects(()=>context(p,'detach',null,'This context link is unavailable.'),/admin/);await user();
  await assert.rejects(()=>context(p,'detach',null,'short'),/Explain/); const detached=await context(p,'detach',null,'This context link is unavailable.');assert.deepEqual(detached.context_work,{});assert.equal(detached.content.body,p.content.body);assert.equal(detached.source_version,p.source_version);
  const replay=await context(p,'detach',null,'This context link is unavailable.');assert.equal(replay.version,detached.version);
  if(privateTask)assert.equal((await one('select notes from public.launch_tasks where id=$1',[t.id])).notes,'Secret notes');
  await root();const next=await one("insert into public.launch_tasks(company_entity_id,task_title,status,assigned_to_user_id) values($1,'Replacement public work','open',$2) returning id",[A,ADMIN]);await user(); const linked=await context(detached,'link',next.id);assert.equal(linked.context_work.task_id,next.id);await decide(linked,'dismiss','Stop this isolated test opportunity.');
 }
});
await test('refresh states are paused/queued/running honestly and old evidence cannot approve',async()=>{
 let p=await ready('ads');await user();p=await decide(p,'refresh');assert.equal(p.content.body,draft.body);await root();await db.query('update public.on_deck_settings set enabled=false where company_entity_id=$1',[A]);await user();let rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.reason,'disabled');assert.equal(rs.proposals.find(x=>x.id===p.id).source_current,false);await assert.rejects(()=>edit(p,p.content),/Evidence/);
 await root();await db.query('update public.on_deck_settings set enabled=true,monthly_cap_usd=100 where company_entity_id=$1',[A]);await db.query('update public.on_deck_proposals set preparation_state=$2 where id=$1',[p.id,{state:'paused',reason:'credit_exhausted',version:p.version}]);await user();rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.reason,'credit_exhausted');
 await root();await db.query("update public.on_deck_proposals set preparation_state='{}' where id=$1",[p.id]);await user();rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.state,'queued');await root();await db.query('update public.on_deck_settings set monthly_cap_usd=0 where company_entity_id=$1',[A]);await user();rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.reason,'budget_cap');await root();await db.query('update public.on_deck_settings set monthly_cap_usd=100 where company_entity_id=$1',[A]);
 const temporary=[];for(let i=0;i<20;i++){const key=randomUUID();temporary.push(key);await db.query("insert into public.on_deck_attempts(id,company_entity_id,proposal_id,proposal_version,state,reserved_usd,cost_usd) values($1,$2,$3,$4,'failed',0.25,0)",[key,A,p.id,p.version]);}await user();rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.reason,'daily_cap');await root();await db.query('delete from public.on_deck_attempts where id=any($1::uuid[])',[temporary]);
 await db.query('update public.on_deck_proposals set context_work=$2 where id=$1',[p.id,{state:'open',task_id:randomUUID()}]);await user();rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.reason,'context_open');await decide(p,'dismiss','Stop the refreshed test opportunity.');
 await service();const id=await stage('ads');p=await get(id);const claim=await reserve(p);await user();rs=await rpc('on_deck_review_state');assert.equal(rs.proposals.find(x=>x.id===p.id).preparation.state,'running');await service();await finish(claim.run);p=await get(id);await user();await decide(p,'dismiss','Stop the running test opportunity.');
});
await test('edited launch rows and restock title reach exact draft records; gates and rollback remain',async()=>{
 let p=await ready('launch');await user();p=await edit(p,{...p.content,subject:'Reviewed launch',body:'Reviewed launch copy',tasks:[{title:'New row one',detail:'Email draft'},{title:'New row two',detail:'Social draft'}]});const done=await decide(p,'approve');assert.equal(done.output.ids.length,2);assert.equal(done.output.url,'/v2/tasks.html?task='+done.output.ids[0]);for(const id of done.output.ids)assert.match((await one('select notes from public.launch_tasks where id=$1',[id])).notes,/Reviewed draft title: Reviewed launch[\s\S]*Reviewed launch copy/);const again=await decide(p,'approve');assert.deepEqual(again.output.ids,done.output.ids);
 p=await ready('restock');await user();p=await edit(p,{...p.content,subject:'Reviewed product brief'});await db.exec("select set_config('test.purchasing','false',false)");await assert.rejects(()=>decide(p,'approve','Verified demand, margin, seasonality and cash.'),/permission/);await db.exec("select set_config('test.purchasing','true',false)");const brief=await decide(p,'approve','Verified demand, margin, seasonality and cash.');assert.equal((await one('select content from public.product_workflow_briefs where id=$1',[brief.output.id])).content.title,'Reviewed product brief');
});
await test('version, expiry, source and destination permissions reject creation and edits',async()=>{
 let p=await ready('seo');await user();p=await edit(p,p.content);await assert.rejects(()=>decide({...p,version:p.version-1},'approve'),/changed/);await db.exec("select set_config('test.seo','false',false)");await assert.rejects(()=>decide(p,'approve'),/permission/);await db.exec("select set_config('test.seo','true',false)");await root();await db.query("update public.on_deck_proposals set valid_until=now()-interval '1 second' where id=$1",[p.id]);await user();await assert.rejects(()=>edit(p,p.content),/expired/);await assert.rejects(()=>decide(p,'approve'),/expired/);await decide(p,'dismiss','Expired test proposal is retained.');
 for(const role of ['anon','authenticated'])for(const fn of ['on_deck_review_content(jsonb,jsonb)','on_deck_preparation_state(public.on_deck_proposals)'])assert.equal((await one("select has_function_privilege($1,$2,'execute') ok",[role,'public.'+fn])).ok,false);
});
await test('detaching a context link invalidated by refresh requeues screening the next run',async()=>{
 const settings=()=>one('select requested_at,last_screen_at from public.on_deck_settings where company_entity_id=$1',[A]);
 const due=s=>!s.last_screen_at||new Date(s.requested_at||0)>new Date(s.last_screen_at);
 await service();const id=await stage('ads');let p=await get(id);const claim=await reserve(p);await finish(claim.run,{...draft,missing:['Verify claim']});p=await get(id);assert.equal(p.status,'needs_info');
 await root();const t=await one("insert into public.launch_tasks(company_entity_id,task_title,status,assigned_to_user_id,is_private) values($1,'Context work for requeue','open',$2,false) returning id",[A,ADMIN]);
 await user();p=await context(p,'link',t.id);assert.equal(p.context_work.state,'open');
 // Refresh invalidates the evidence and asks for a screening run.
 p=await decide(p,'refresh');assert.equal(p.status,'failed');assert.equal(p.source_version,'');assert.ok(due(await settings()));
 // That run skips this proposal while the context link is open, then records the screen.
 await service();assert.equal(await stage('ads',p.source_key),null);
 await root();await db.query('update public.on_deck_settings set last_screen_at=now() where company_entity_id=$1',[A]);
 assert.equal(due(await settings()),false,'the screening request was spent by the run that skipped this proposal');
 await user();p=await context(p,'detach',null,'The context link is no longer reachable.');
 assert.deepEqual(p.context_work,{});
 const after=await settings();assert.ok(due(after),'detach must renew the screening request so the next scheduler run re-screens it');
 const rs=await rpc('on_deck_review_state');const shown=rs.proposals.find(x=>x.id===p.id).preparation;
 assert.equal(shown.state,'queued');assert.equal(shown.reason,'screening');
 await decide(p,'dismiss','Stop the requeued test opportunity.');
});
await test('a refreshed sync warns and the draft still works; no evidence basis and expiry still block',async()=>{
 // Production 2026-10-15: all five open proposals read source_current=false
 // because a sync had run since preparation, so every Review draft was disabled.
 let p=await ready('ads');
 await root();await db.query("update public.on_deck_proposals set source_version='fingerprint-before-the-sync' where id=$1",[p.id]);
 await user();p=await get(p.id);
 const rs=await rpc('on_deck_review_state');const row=rs.proposals.find(x=>x.id===p.id);
 assert.equal(rs.drift_warns,true,'the page can tell the fix is installed');
 assert.equal(row.source_current,false,'the page is still told the data moved');
 assert.deepEqual(row.blockers,[],'nothing is outstanding on this draft');
 p=await edit(p,{...p.content,subject:'Reviewed ad copy variation'});
 assert.equal(p.status,'ready','drift must not block an edit');
 p=await decide(p,'approve','Reviewed the copy variation against the evidence shown before creating draft work.');
 assert.equal(p.status,'completed','drift must not block creation');
 const ev=await one("select detail from public.on_deck_events where proposal_id=$1 and event_type='action_confirmed'",[p.id]);
 assert.equal(ev.detail.evidence_drifted,true,'approval records that the evidence had moved');

 // A draft an explicit Refresh emptied has no evidence basis at all: still blocked.
 let q=await ready('ads');
 await root();await db.query("update public.on_deck_proposals set source_version='' where id=$1",[q.id]);
 await user();q=await get(q.id);
 await assert.rejects(()=>edit(q,q.content),/refreshed|expired/);
 await assert.rejects(()=>decide(q,'approve','Reviewed before creating draft work.'),/refreshed|expired/);
 // And the 48-hour window still closes.
 await root();await db.query("update public.on_deck_proposals set source_version='fingerprint-before-the-sync',valid_until=now()-interval '1 second' where id=$1",[q.id]);
 await user();q=await get(q.id);
 await assert.rejects(()=>decide(q,'approve','Reviewed before creating draft work.'),/expired/);
 await decide(q,'dismiss','Stop the drift test proposal.');
});

await test('the fingerprint reads the sync record, not the fact table, and is resolved once per workflow', async () => {
 // What made On Deck unusable on 2026-10-16 was COST, not correctness: the
 // fingerprint counted search_console_page_daily (1.5M rows on production) once
 // per draft, and on_deck_review_state exceeded the 8s authenticated timeout.
 await root();
 const version = kind => one('select public.on_deck_source_version($1,$2) v',[A,kind]).then(r=>r.v);
 const before = await version('seo');

 // Rows landing in the fact table no longer move it on their own...
 await db.query("insert into public.search_console_page_daily(company_entity_id,site_url,day_date,page,clicks,impressions,position) select $1,'https://example.test','2026-10-16','https://example.test/p'||i,1,10,5 from generate_series(1,500) i",[A]);
 assert.equal(await version('seo'), before, 'counting the fact table is what made this call slow');

 // ...the sync that wrote them does.
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'search_console_daily','success',now())",[A]);
 const after = await version('seo');
 assert.notEqual(after, before, 'a Search Console sync must still show as a refresh');

 // A failed run is not a refresh, and another company's sync is not this one's.
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'search_console_daily','error',now()+interval '1 hour')",[A]);
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'search_console_daily','success',now()+interval '2 hours')",[B]);
 assert.equal(await version('seo'), after, 'only this company\u2019s successful runs count');

 // restock drops the sales_by_day read; its sync token already covered it.
 const restock = await version('restock');
 await db.query("insert into public.sales_by_day(company_entity_id,sku,day_date,total_quantity_sold) select $1,'sku'||i,'2026-10-16',1 from generate_series(1,500) i",[A]);
 assert.equal(await version('restock'), restock, 'the restock branch no longer scans sales_by_day');
 await db.query("insert into public.sync_jobs(company_entity_id,job_type,status,finished_at) values($1,'incremental_sales','success',now()+interval '3 hours')",[A]);
 assert.notEqual(await version('restock'), restock, 'a sales sync must still show as a refresh');

 // One fingerprint per workflow, not one per draft. Two seo drafts, one call.
 const first=await ready('seo'), second=await ready('seo');
 assert.notEqual(first.id, second.id, 'two seo drafts are open');
 // Counting the fingerprint's own calls: every branch resolves the company
 // timezone exactly once, so this counts calls to on_deck_source_version.
 await root();
 await db.exec('create sequence if not exists public.version_calls');
 await db.exec("create or replace function public.silo_company_timezone(uuid) returns text language plpgsql stable as $$begin perform nextval('public.version_calls'); return 'America/Los_Angeles'; end $$");
 const kinds = Number((await one("select count(distinct kind) n from public.on_deck_proposals where company_entity_id=$1 and status not in ('completed','dismissed','screened')",[A])).n);
 const open = Number((await one("select count(*) n from public.on_deck_proposals where company_entity_id=$1 and status not in ('completed','dismissed','screened')",[A])).n);
 assert.ok(open > kinds, 'the fixture must hold more drafts than workflows for this to prove anything');
 await db.exec('alter sequence public.version_calls restart with 1');
 await user();
 const rs = await rpc('on_deck_review_state');
 await root();
 const calls = Number((await one('select last_value from public.version_calls')).last_value);
 assert.equal(calls, kinds, `the fingerprint must be computed once per workflow (${kinds}), not once per draft (${open})`);
 assert.equal(rs.proposals.length, open, 'every open draft is still reported');
 for (const row of rs.proposals) assert.equal(typeof row.source_current,'boolean','every draft still reports its freshness');
 assert.equal(rs.proposals.find(x=>x.id===first.id).source_current,true,'a draft prepared against the current fingerprint still reads current');
 await user();
 await decide(first,'dismiss','Stop the fingerprint test proposal.');
 await decide(second,'dismiss','Stop the second fingerprint test proposal.');
});
await db.close();
console.log(`${checks} On Deck review-to-action SQL scenarios passed (real isolated PostgreSQL via PGlite; no production or provider calls).`);
