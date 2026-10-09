'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const draft = { recommend: true, subject: 'Collection search copy review', summary: 'A grounded hypothesis, no assumed lift.', body: 'A draft for review.', reason: 'Observed page exposure.', missing: ['Confirm the product claim against the approved brief.'], optional_context: ['No comparative CTR benchmark is recorded.'], proposed_title: 'Classic tees | Example', proposed_meta_description: 'Explore classic tees.', tasks: [] };
const tables = () => ({ profiles: [{ id: 'test-user', email: 'owner@example.test', role: 'admin' }], on_deck_settings: [{ enabled: true }], on_deck_proposals: [{ id: 'search', company_entity_id: 'test-company', kind: 'seo', title: 'Search copy · Classic tees', status: 'needs_info', version: 2, valid_until: '2099-01-01', source_version: 'current', selection_reason: 'Selected #1 from page evidence.', source: { url: 'https://example.test/tees', impressions: 30000, clicks: 180, position: 7, days: 26, inspection: { title: 'Tees', meta_description: 'Current copy' } }, content: structuredClone(draft) }], on_deck_events: [], on_deck_attempts: [] });
const rpc = {
  on_deck_can_review: () => true,
  on_deck_review_state: () => ({ seo: true, context_tasks: [{id: 'created', notes: 'Findings from task owner: approved brief revision 3.', status: 'open', owner: 'Research owner'}], proposals: window.__FIXTURE_TABLES__.on_deck_proposals.map(p => ({ id: p.id, source_current: p.source_version === 'current' })), assignees: [{ id: 'owner', name: 'Research owner' }], tasks: [{ id: 'existing', task_title: 'Existing evidence research', assigned_to_user_id: 'owner' }] }),
  on_deck_context: a => {
    const p = window.__FIXTURE_TABLES__.on_deck_proposals[0];
    if (a.p_action === 'resolve') { p.context_work.state = 'resolved'; p.context_work.resolution = a.p_note; p.status = 'failed'; p.source_version = ''; }
    else p.context_work = { state: 'open', task_id: a.p_task || 'created', title: 'Resolve product claim', assigned_to: a.p_assignee || 'owner' };
    p.version++; return p;
  },
  on_deck_decide: a => { const p = window.__FIXTURE_TABLES__.on_deck_proposals[0]; if (a.p_action === 'approve') { p.status = 'completed'; p.output = { label: 'SEO draft created', url: '/v2/seo-tasks.html', id: 'seo-task' }; } if (a.p_action === 'refresh') { p.status = 'failed'; p.source_version = ''; } p.version++; return p; },
};
(async () => {
 const suite = await startSuite({ secureContext: true });
 await suite.context.route('**/v2/lib/supabase-js.min.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript().replace('all = all(args) || [];', 'all = all(args);') }));
 const ready = () => document.getElementById('workspace') && !document.getElementById('workspace').hidden;
 let checks = 0;
 const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };
 try {
  let page = await suite.open('/v2/on-deck.html?proposal=search', tables(), { rpc, ready });
  await test('blocked opportunity opens exact proposal and creates owned work without approving', async () => {
   await page.getByRole('button', { name: 'Create or link context task' }).click();
   await page.getByRole('button', { name: 'Confirm context task' }).click();
   assert.match(await page.locator('#context-error').textContent(), /Choose an owner/);
   await page.getByLabel('Owner', { exact: true }).selectOption('owner');
   await page.getByRole('button', { name: 'Confirm context task' }).click();
   await page.waitForFunction(() => !document.getElementById('context-dialog').open);
   assert.equal(await page.getByRole('link', { name: 'Open context task' }).getAttribute('href'), 'https://127.0.0.1/v2/tasks.html?task=created'.replace('https://127.0.0.1', new URL(page.url()).origin));
   assert.equal(await page.getByRole('button', { name: 'Create draft SEO task', exact: true }).isDisabled(), true);
   const calls = await page.evaluate(() => window.__QUERIES__.filter(x => x.table === 'rpc:on_deck_context'));
   assert.equal(calls.length, 1); assert.equal(calls[0].args.p_assignee, 'owner'); assert.equal(calls[0].args.p_version, 2);
   const shots = path.resolve(__dirname, '../../../.screenshots'); fs.mkdirSync(shots, { recursive: true });
   await page.screenshot({ path: path.join(shots, 'on-deck-context-owned.png'), fullPage: true });
  });
  await test('findings persist then require a fresh draft; optional enrichment does not block reviewed output', async () => {
   await page.getByRole('button', { name: 'Record findings and refresh draft' }).click();
   assert.match(await page.getByLabel('Findings and supporting evidence').inputValue(), /Findings from task owner/);
   await page.setViewportSize({ width: 390, height: 844 });
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
   await page.screenshot({ path: path.resolve(__dirname, '../../../.screenshots/on-deck-context-mobile.png'), fullPage: true });
   await page.setViewportSize({ width: 1280, height: 900 });
   await page.getByLabel('Findings and supporting evidence').fill('Approved product brief revision 3 confirms the claim.');
   await page.getByRole('button', { name: 'Save findings and queue fresh draft' }).click();
   await page.waitForFunction(() => !document.getElementById('context-dialog').open);
   assert.match(await page.locator('#detail').textContent(), /Fresh preparation is queued/);
   assert.match(await page.locator('#detail').textContent(), /revision 3/);
   // Only the provider transport is simulated here; SQL persistence is tested separately.
   await page.evaluate(() => { const p = window.__FIXTURE_TABLES__.on_deck_proposals[0]; p.status = 'ready'; p.source_version = 'current'; p.content.missing = []; p.version++; });
   await page.getByRole('button', { name: 'Refresh', exact: true }).click();
   await page.locator('[data-view=review]').click();
   await page.getByRole('button', { name: 'Create draft SEO task', exact: true }).click();
   await page.getByRole('button', { name: 'Confirm · Create draft SEO task' }).click();
   await page.waitForFunction(() => window.__FIXTURE_TABLES__.on_deck_proposals[0].status === 'completed');
  }); await page.close();
  page = await suite.open('/v2/on-deck.html?proposal=search', tables(), { rpc, ready });
  await test('existing owned work can be linked instead of creating another task', async () => {
   await page.getByRole('button', { name: 'Create or link context task' }).click();
   await page.getByLabel('Or link existing owned work').selectOption('existing');
   await page.getByRole('button', { name: 'Confirm context task' }).click();
   await page.waitForFunction(() => !document.getElementById('context-dialog').open);
   const call = await page.evaluate(() => window.__QUERIES__.find(x => x.table === 'rpc:on_deck_context'));
   assert.equal(call.args.p_action, 'link'); assert.equal(call.args.p_task, 'existing');
  }); await page.close();
  const stale = tables(); Object.assign(stale.on_deck_proposals[0], { status: 'ready', source_version: 'old' }); stale.on_deck_proposals[0].content.missing = [];
  page = await suite.open('/v2/on-deck.html?proposal=search', stale, { rpc, ready });
  await test('stale evidence is explicit before editing or approving; refresh queues it', async () => {
   assert.match(await page.locator('#detail').textContent(), /Source evidence changed/);
   assert.equal(await page.getByRole('button', { name: 'Create draft SEO task', exact: true }).isDisabled(), true);
   assert.equal(await page.getByRole('button', { name: 'Edit draft', exact: true }).isDisabled(), true);
   await page.getByRole('button', { name: 'Refresh evidence' }).click();
   await page.waitForFunction(() => window.__FIXTURE_TABLES__.on_deck_proposals[0].source_version === '');
  }); await page.close();
  const longNotes=tables(); longNotes.on_deck_proposals[0].context_work={state:'open',task_id:'created',title:'Resolve claim'};
  const clippedRpc={...rpc,on_deck_review_state:()=>({seo:true,proposals:[{id:'search',source_current:true}],assignees:[],tasks:[],context_tasks:[{id:'created',notes:'Old request text',notes_truncated:true}]})};
  page=await suite.open('/v2/on-deck.html?proposal=search',longNotes,{rpc:clippedRpc,ready});
  await test('truncated task notes require reading full task, never import partial findings',async()=>{
   await page.getByRole('button',{name:'Record findings and refresh draft'}).click(); assert.match(await page.locator('#context-explanation').textContent(),/exceed the import limit/); assert.equal(await page.getByLabel('Findings and supporting evidence').inputValue(),'');
  }); await page.close();

  for(const mode of ['stale','expired']) {
   const blocked=tables();if(mode==='stale')blocked.on_deck_proposals[0].source_version='old';else blocked.on_deck_proposals[0].valid_until='2000-01-01';
   page=await suite.open('/v2/on-deck.html?proposal=search',blocked,{rpc,ready});
   await test(mode+' context cannot be newly assigned',async()=>{assert.equal(await page.getByRole('button',{name:'Create or link context task'}).isDisabled(),true);assert.equal(await page.evaluate(()=>window.__QUERIES__.some(q=>q.table==='rpc:on_deck_context')),false);});await page.close();
  }
  const untouched=tables();untouched.on_deck_proposals[0].context_work={state:'open',task_id:'created',title:'Resolve claim'};
  const requestRpc={...rpc,on_deck_review_state:()=>({seo:true,proposals:[{id:'search',source_current:false}],assignees:[],tasks:[],context_tasks:[{id:'created',notes:'Required findings: generated request only',notes_are_request:true}]})};
  page=await suite.open('/v2/on-deck.html?proposal=search',untouched,{rpc:requestRpc,ready});
  await test('original request is not prefilled as findings; existing stale work can be resolved',async()=>{await page.getByRole('button',{name:'Record findings and refresh draft'}).click();assert.equal(await page.getByLabel('Findings and supporting evidence').inputValue(),'');assert.match(await page.locator('#context-explanation').textContent(),/no importable findings/);});await page.close();
  console.log(`${checks} action-loop browser checks passed`);
 } finally { await suite.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
