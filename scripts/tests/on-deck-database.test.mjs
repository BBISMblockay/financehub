import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const draft = { recommend: true, subject: 'Fall tee', summary: 'Baseball all season', body: 'Made for the next inning.', reason: 'A prepared draft for review', missing: [], tasks: [{ title: 'Review fall launch copy', detail: 'Confirm claims before publishing.' }] };
const epoch = kind => rpc('on_deck_source_version', [A, kind]);
const stage = async (kind, key = randomUUID()) => rpc('on_deck_stage', [A, { kind, key, title: `${kind} proposal`, score: 1, reason: 'Strongest evidence', source_id: kind === 'launch' ? LAUNCH : kind === 'restock' ? PRODUCT : null,
 source: kind === 'restock' ? { catalog_group: { shop_domain: 'shop', shopify_product_id: '123' }, vetting: {} } : kind === 'ads' ? { objective: 'purchase', ad_id: 'ad-1', baseline: { metric: 'roas', value: 3 } } : { url: 'https://store.example/products/tee' } }, await epoch(kind)]);
const get = async id => (await one('select to_jsonb(p) p from public.on_deck_proposals p where id=$1', [id])).p;
const reserve = (p, request = randomUUID()) => rpc('on_deck_reserve', [p.id, p.version, request]);
const finish = (request, content = draft, input = 1000, output = 100, error = null) => rpc('on_deck_finish', [request, content, input, output, error]);
const ready = async kind => { await service(); const id = await stage(kind); assert.ok(id); const p = await get(id), claim = await reserve(p); assert.ok(claim.claimed); await finish(claim.run); return get(id); };
const decide = (p, action, note = null, content = null, minutes = null) => rpc('on_deck_decide', [p.id, p.version, action, note, content, minutes]);
await test('RLS and grants deny anonymous, cross-company, viewer, disabled users and direct writes', async () => {
 await user(); await rpc('on_deck_configure', [true, 100, 10000, ['restock', 'launch', 'seo', 'ads']]);
 for (const role of ['anon', 'authenticated']) for (const name of ['on_deck_stage(uuid,jsonb,text)', 'on_deck_source_version(uuid,text)', 'on_deck_reserve(uuid,integer,uuid)', 'on_deck_finish(uuid,jsonb,integer,integer,text)', 'on_deck_product_facts(uuid,integer)']) assert.equal((await one('select has_function_privilege($1,$2,\'execute\') ok', [role, name])).ok, false);
 await assert.rejects(() => db.query('update public.on_deck_settings set enabled=false'), /permission denied/);
 const p = await ready('seo');
 await root(); await db.query("insert into public.on_deck_proposals(company_entity_id,kind,source_key,source,source_version,title,selection_reason) values($1,'seo','foreign','{}','v','Foreign','Foreign')", [B]);
 await user(); assert.equal((await one("select count(*)::int n from public.on_deck_proposals where company_entity_id=$1", [B])).n, 0);
 for (const [id, company] of [[ADMIN, B], [VIEWER, A], [DISABLED, A]]) { await user(id, company); assert.equal(await rpc('on_deck_can_review'), false); await assert.rejects(() => decide(p, 'approve'), /Company admin required/); assert.equal((await one('select count(*)::int n from public.on_deck_proposals')).n, 0); }
 await user(); await decide(p, 'dismiss', 'Not the right focus this month.');
});
await test('reservation replay, budget cap and unknown failures remain charged', async () => {
 await user(); await rpc('on_deck_configure', [true, 0.26, 10000, ['restock', 'launch', 'seo', 'ads']]);
 await service(); const id = await stage('seo'), p = await get(id), request = randomUUID();
 const claim = await reserve(p, request); assert.equal(claim.claimed, true); assert.equal((await reserve(p, request)).claimed, false); assert.equal((await reserve(p)).reason, 'in_progress');
 await finish(request, null, null, null, 'timeout'); await finish(request, draft, 1, 1);
 const a = await one('select * from public.on_deck_attempts where id=$1', [request]); assert.equal(Number(a.cost_usd), 0.25); assert.equal(a.state, 'unknown');
 assert.equal((await reserve(await get(id))).reason, 'budget_cap');
 await user(); await decide(await get(id), 'dismiss', 'Resolved manually after provider failure.'); await rpc('on_deck_configure', [true, 100, 10000, ['restock', 'launch', 'seo', 'ads']]);
});
await test('product approval hands off full spread to REAL draft RPC with no size decision or PO', async () => {
 const p = await ready('restock'); await user(); await assert.rejects(() => decide(p, 'approve'), /product-level vetting/);
 await db.exec("select set_config('test.purchasing','false',false)"); await assert.rejects(() => decide(p, 'approve', 'Reviewed demand, margins, seasonality, incoming stock and cash.'), /Purchasing permission/); await db.exec("select set_config('test.purchasing','true',false)");
 const done = await decide(p, 'approve', 'Reviewed demand, margins, seasonality, incoming stock and cash.'); assert.equal(done.status, 'completed');
 const brief = await one('select * from public.product_workflow_briefs where id=$1', [done.output.id]); assert.equal(brief.status, 'draft'); assert.equal(brief.content.catalog_scope, 'product'); assert.equal(brief.content.lines.length, 2); assert.ok(brief.content.lines.every(l => l.qty === null));
 assert.equal((await one('select count(*)::int n from public.po_headers')).n, 0);
 assert.deepEqual((await decide(p, 'approve')).output, done.output); assert.equal((await one('select count(*)::int n from public.product_workflow_briefs')).n, 1);
});
await test('version, expiration and changed source block approval; edits cannot forge readiness', async () => {
 const p = await ready('seo'); await user(); await assert.rejects(() => decide({ ...p, version: p.version - 1 }, 'approve'), /Proposal changed/); await assert.rejects(() => decide({ ...p, version: null }, 'approve'), /Proposal changed/);
 await assert.rejects(() => decide(p, 'edit', null, { ...draft, missing: 'none' }), /Invalid draft/);
 await service(); await db.query("insert into public.page_inspections(company_entity_id,requested_url,title) values($1,'https://store.example/products/tee','Changed')", [A]);
 await user(); await assert.rejects(() => decide(p, 'approve'), /Evidence changed/);
 await decide(p, 'dismiss', 'Source moved during review.');
 const expired = await ready('seo'); await root(); await db.query("update public.on_deck_proposals set valid_until=now()-interval '1 hour' where id=$1", [expired.id]); await user(); await assert.rejects(() => decide(expired, 'approve'), /expired/); await decide(expired, 'dismiss', 'Expired evidence.');
});
await test('SEO domain gate retained; handoff is draft, ad handoff is idea with frozen baseline', async () => {
 let p = await ready('seo'); await user(); await db.exec("select set_config('test.seo','false',false)"); await assert.rejects(() => decide(p, 'approve'), /SEO approval permission/); await db.exec("select set_config('test.seo','true',false)");
 let done = await decide(p, 'approve'); const task = await one('select * from public.seo_tasks where id=$1', [done.output.id]); assert.equal(task.proposed_body, draft.body); assert.equal(task.approval_status, 'draft');
 p = await ready('ads'); await user(); done = await decide(p, 'approve'); const idea = await one('select * from public.ad_ideas where id=$1', [done.output.id]); assert.equal(idea.status, 'idea'); assert.equal(idea.body_draft, draft.body); assert.equal(idea.baseline_snapshot.value, 3);
});
await test('launch output creation rolls back on failure and retry returns one durable receipt', async () => {
 const p = await ready('launch'); await root(); await db.exec("alter table public.launch_tasks add constraint fail_fixture check(task_title <> 'Review fall launch copy')"); await user(); await assert.rejects(() => decide(p, 'approve'), /fail_fixture/); assert.equal((await get(p.id)).status, 'ready');
 await root(); await db.exec('alter table public.launch_tasks drop constraint fail_fixture'); await user(); const done = await decide(p, 'approve'); assert.equal(done.output.ids.length, 1); assert.equal((await decide(p, 'approve')).output.ids[0], done.output.ids[0]); const task = await one('select * from public.launch_tasks where id=$1', [done.output.ids[0]]); assert.ok(task.notes.includes(draft.body)); assert.equal(task.is_private, false);
});
await test('revision failure preserves prior draft, versioned edits record history, missing evidence needs explanation', async () => {
 let p = await ready('seo'); await user(); p = await decide(p, 'revise', 'Make the headline more specific.'); await assert.rejects(() => decide(p, 'approve'), /prepared proposal/);
 await service(); const claim = await reserve(p); await finish(claim.run, null, 100, 100, 'invalid_draft'); p = await get(p.id); assert.equal(p.status, 'failed'); assert.equal(p.content.body, draft.body);
 await user(); p = await decide(p, 'edit', 'A clearer headline.', { ...draft, subject: 'More specific tee', missing: ['Confirm fabric'] }); assert.equal(p.status, 'needs_info'); await assert.rejects(() => decide(p, 'edit', '', draft), /Explain how/); p = await decide(p, 'edit', 'Fabric confirmed in current supplier specification.', draft); assert.equal(p.status, 'ready'); assert.ok((await one("select count(*)::int n from public.on_deck_events where proposal_id=$1 and event_type='edit'", [p.id])).n >= 2);
 await decide(p, 'dismiss', 'Completed manually.');
});
await test('cancelled revisions keep previous content and late provider results cannot overwrite it', async () => {
 let p = await ready('seo'); await user(); p = await decide(p, 'revise', 'Try a sharper opening.'); await service(); const claim = await reserve(p);
 await user(); const restored = await decide(p, 'cancel_revision'); assert.equal(restored.status, 'ready'); assert.equal(restored.content.body, draft.body);
 await service(); await finish(claim.run, { ...draft, body: 'Late unwanted replacement.' }); assert.equal((await get(p.id)).content.body, draft.body); assert.equal((await one('select state from public.on_deck_attempts where id=$1', [claim.run])).state, 'succeeded');
 await user(); await decide(await get(p.id), 'dismiss', 'Kept the earlier approach.');
});
await test('dismiss cooldown and bounded queue admission; client cannot invoke service source readers', async () => {
 await service(); const id = await stage('seo', 'repeat'); await user(); const p = await get(id); await decide(p, 'dismiss', 'Not useful now.'); await service(); assert.equal(await stage('seo', 'repeat'), null);
 for (let i = 0; i < 3; i++) assert.ok(await stage('seo')); assert.equal(await stage('seo'), null);
 for (let i = 0; i < 3; i++) assert.ok(await stage('ads')); assert.equal(await stage('launch'), null);
 await user(); await assert.rejects(() => rpc('on_deck_product_facts', [B, 0]), /permission denied/);
});
await test('service aggregate readers execute explicit company scope and exclude private launch tasks', async () => {
 await root(); await db.query("insert into public.launch_tasks(company_entity_id,launch_id,task_title,is_private) values($1,$2,'Secret launch task',true)", [A, LAUNCH]);
 await service(); for (const fn of ['on_deck_product_facts', 'on_deck_seo_facts', 'on_deck_ad_facts', 'on_deck_launch_facts']) { const rows = (await db.query(`select * from public.${fn}($1,0)`, [B])).rows; assert.equal(rows.length, 0); await db.query(`select * from public.${fn}($1,0)`, [A]); }
 const launch = (await db.query('select * from public.on_deck_launch_facts($1,0)', [A])).rows[0].on_deck_launch_facts; assert.ok(launch.tasks.every(t => t.title !== 'Secret launch task'));
});
await test('value is user-recorded only after action; monthly stats include failed charges', async () => {
 await user(); const p = (await one("select to_jsonb(p) p from public.on_deck_proposals p where status='completed' limit 1")).p; const done = await decide(p, 'value', 'Draft preparation saved time; no measured revenue impact.', null, 12); assert.equal(done.value_minutes, 12); const stats = await rpc('on_deck_stats'); assert.equal(stats.minutes, 12); assert.ok(Number(stats.spent) >= 0.25); assert.ok(stats.failed_attempts >= 1); assert.ok(stats.actions >= 3);
});
await test('schema verifier passes against installed migration', async () => { await root(); const full = await read('../../supabase/verify_v2_schema.sql'); const sql = full.slice(full.indexOf('-- On Deck direct-link preview:'), full.indexOf('-- End On Deck preview checks.')); for (const part of sql.split(';').filter(s => s.trim())) for (const row of (await db.query(part)).rows) assert.equal(row.status, 'ok', row.check_name); });
console.log(`${checks} database integration checks passed`); await db.close();
