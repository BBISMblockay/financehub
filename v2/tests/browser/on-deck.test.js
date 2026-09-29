'use strict';
const assert = require('assert/strict');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const fs = require('fs');
const path = require('path');
const company = 'test-company';
const draft = { recommend: true, subject: 'The next inning starts here', summary: 'A fall collection built for baseball days.', body: 'From the last pitch to the next first inning. Meet the fall collection.\nExplore the collection.', reason: 'Upcoming launch with a defined audience.', missing: [], tasks: [{ title: 'Review launch email', detail: 'Confirm imagery and approved claims.' }] };
const proposal = { id: 'launch1', company_entity_id: company, kind: 'launch', title: 'Prepare launch campaign · Fall baseball', selection_reason: 'Launch in seven days, with product readiness and an audience defined. Selected #1 of 4 qualified launch opportunities.', status: 'ready', version: 2, updated_at: '2026-09-29T07:30:00Z', valid_until: '2099-01-01', source: { title: 'Fall baseball', launch_date: '2026-10-06', audience: 'Players and lifelong fans', design_intent: 'Baseball for the everyday.', readiness: [{ product: 'The Dugout Crew', status: 'Photo review' }, { product: 'Extra Innings Tee', status: 'Ready' }] }, content: draft };
const tables = () => ({ profiles: [{ id: 'test-user', email: 'blake@example.test', role: 'admin' }], entity_memberships: [{ entity_id: company, user_id: 'test-user', role: 'owner_admin' }], on_deck_settings: [{ company_entity_id: company, enabled: true, monthly_cap_usd: 100, buy_budget: 25000, workflows: ['restock', 'launch', 'seo', 'ads'], last_screen_at: '2026-09-29T07:00:00Z', diagnostics: { qualified: 8, shortlisted: 3, held: { 'Insufficient evidence': 14 } } }], on_deck_proposals: [structuredClone(proposal), { ...structuredClone(proposal), id: 'seo1', kind: 'seo', title: 'Improve search presentation · Dugout Crew', source: { url: 'https://store.example/products/dugout', impressions: 4300, clicks: 72, position: 8.3, days: 28, inspection: { title: 'The Dugout Crew', meta_description: 'A classic baseball crew.' } } }], on_deck_events: [{ proposal_id: 'launch1', event_type: 'revised', created_at: '2026-09-29T07:30:00Z', detail: { previous_content: { ...draft, body: 'Previous launch copy.' }, instruction: 'Make the story clearer.' } }], on_deck_attempts: [{ proposal_id: 'launch1', cost_usd: 0.018, state: 'succeeded', created_at: '2026-09-29T07:30:00Z' }] });
const rpc = {
 on_deck_can_review: () => true,
 on_deck_stats: () => ({ spent: 3.42, unknown_or_reserved: 0.25, actions: 5, minutes: 42, attempts: 20, failed_attempts: 1, edited_actions: 2, dismissed: 3, workflow_spend: { launch: 1.32, seo: 2.1 } }),
 on_deck_decide: args => {
   const p = window.__FIXTURE_TABLES__.on_deck_proposals.find(p => p.id === args.p_id);
   if (args.p_action === 'approve') { p.status = 'completed'; p.output = { label: 'Launch tasks created — copy is not published', url: '/v2/launch-calendar.html', ids: ['task1'] }; }
   if (args.p_action === 'revise') { p.status = 'revision'; p.revision_request = args.p_note; }
   if (args.p_action === 'edit') { p.content = args.p_content; p.status = p.content.missing.length ? 'needs_info' : 'ready'; }
   if (args.p_action === 'dismiss') { p.status = 'dismissed'; p.dismiss_reason = args.p_note; }
   p.version++; return p;
 },
};
(async () => {
 const suite = await startSuite({ secureContext: true });
 // This preview has boolean RPCs. Preserve false; the older gallery harness
 // converts every falsy fixture result to an array. Scope this fix to this suite.
 await suite.context.route('**/v2/lib/supabase-js.min.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript().replace('all = all(args) || [];', 'all = all(args);') }));
 let checks = 0;
 const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };
 const ready = () => document.getElementById('workspace') && !document.getElementById('workspace').hidden;
 try {
  let page = await suite.open('/v2/on-deck.html', tables(), { rpc, ready });
  await test('real page loads company-scoped lineup, costs and existing SILO chrome', async () => {
   await page.waitForSelector('.od-card'); assert.equal(await page.locator('.od-card').count(), 2);
   assert.match(await page.locator('#spend').textContent(), /3.42/); assert.match(await page.locator('#saved').textContent(), /42 min/);
   const queries = await page.evaluate(() => window.__QUERIES__.filter(q => q.table === 'on_deck_proposals'));
   assert.ok(queries.every(q => q.filters.some(f => f.op === 'eq' && f.col === 'company_entity_id' && f.val === 'test-company')));
   assert.equal(await page.locator('a[href="/v2/on-deck.html"]').count(), 0);
  });
  await test('draft shows actual copy, prior revision comparison and action destination', async () => {
   await page.getByRole('button', { name: 'Prepared draft', exact: true }).click();
   assert.match(await page.locator('.od-paper').textContent(), /next first inning/);
   await page.getByText('Compare with previous draft', { exact: true }).click(); assert.match(await page.locator('.od-diff').textContent(), /Previous launch copy/);
   assert.match(await page.locator('#rail').textContent(), /No publishing or messages/);
  });
  await test('approval asks for confirmation and sends exact displayed version once', async () => {
   await page.getByRole('button', { name: 'Approve copy & create tasks', exact: true }).click();
   assert.match(await page.locator('#decision-explanation').textContent(), /version 2/);
   await page.getByRole('button', { name: 'Confirm & create draft work' }).click();
   await page.waitForFunction(() => window.__FIXTURE_TABLES__.on_deck_proposals[0].status === 'completed');
   await page.waitForFunction(() => !document.getElementById('decision-dialog').open);
   const calls = await page.evaluate(() => window.__QUERIES__.filter(q => q.table === 'rpc:on_deck_decide'));
   assert.equal(calls.length, 1); assert.equal(calls[0].args.p_version, 2); assert.equal(calls[0].args.p_action, 'approve');
   await page.locator('[data-view=completed]').click(); assert.match(await page.locator('#detail').textContent(), /copy is not published/);
  });
  await page.close();
  page = await suite.open('/v2/on-deck.html', tables(), { rpc, ready });
  await test('revision is a real queued version, blocking approval while preparing', async () => {
   await page.getByLabel('Revision instructions').fill('Make the first line more specific to the fall collection.');
   await page.getByRole('button', { name: 'Request revision', exact: true }).click();
   await page.waitForFunction(() => window.__FIXTURE_TABLES__.on_deck_proposals[0].status === 'revision');
   await page.locator('[data-view=preparing]').click();
   await page.waitForSelector('.od-card[aria-pressed=true]');
   assert.equal(await page.getByRole('button', { name: 'Approve copy & create tasks', exact: true }).isDisabled(), true);
  });
  await page.close();
  const malicious = tables(); malicious.on_deck_proposals[0].title = '<img src=x onerror="window.__XSS__=true">'; malicious.on_deck_proposals[0].content.body = '<script>window.__XSS__=true</script>'; malicious.on_deck_proposals[0].source.audience = '<svg onload="window.__XSS__=true">';
  page = await suite.open('/v2/on-deck.html', malicious, { rpc, ready });
  await test('untrusted titles, evidence and generated drafts render as text', async () => {
   await page.getByRole('button', { name: 'Prepared draft', exact: true }).click(); assert.equal(await page.evaluate(() => !!window.__XSS__), false); assert.equal(await page.locator('#detail script,#queue img').count(), 0); assert.match(await page.locator('.od-paper').textContent(), /<script>/);
  });
  await page.close();
  page = await suite.open('/v2/on-deck.html', tables(), { rpc, ready });
  await test('desktop and narrow mobile remain usable without horizontal page overflow', async () => {
   await page.getByRole('button', { name: 'Prepared draft', exact: true }).click();
   const dir = path.resolve(__dirname, '../../../.screenshots'); fs.mkdirSync(dir, { recursive: true });
   await page.screenshot({ path: path.join(dir, 'on-deck-desktop.png'), fullPage: true });
   await page.setViewportSize({ width: 390, height: 844 });
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   await page.waitForFunction(() => document.querySelector('.silo-sidebar').getBoundingClientRect().right <= 0);
   assert.equal(await page.evaluate(() => innerWidth), 390);
   assert.equal(await page.evaluate(() => document.getElementById('detail').getBoundingClientRect().right <= innerWidth), true);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
   await page.screenshot({ path: path.join(dir, 'on-deck-mobile.png'), fullPage: true });
   await page.locator('#detail').scrollIntoViewIfNeeded();
   await page.screenshot({ path: path.join(dir, 'on-deck-mobile-detail.png'), fullPage: true });
  });
  await page.close();
  const empty = tables(); empty.on_deck_proposals = []; empty.on_deck_settings = [];
  page = await suite.open('/v2/on-deck.html', empty, { rpc, ready });
  await test('new store empty state is honest and no prep charge or fake cards appears', async () => { assert.equal(await page.locator('.od-card').count(), 0); assert.equal(await page.locator('#prepare').isDisabled(), true); assert.match(await page.locator('#status').textContent(), /preparation is off/); });
  await page.close();
  page = await suite.open('/v2/on-deck.html', tables(), { rpc: { ...rpc, on_deck_can_review: () => false }, ready: () => /requires an active company/.test(document.getElementById('status').textContent) });
  await test('restricted membership sees no proposal data or enabled actions', async () => { assert.equal(await page.locator('#workspace').isHidden(), true); assert.equal(await page.locator('#prepare').isDisabled(), true); assert.equal(await page.evaluate(() => window.__QUERIES__.some(q => q.table === 'on_deck_proposals')), false); });
  await page.close();
  page = await suite.open('/v2/on-deck.html', tables(), { rpc, broken: ['on_deck_settings'], ready: () => /not installed|failed|error|broken|unreadable/i.test(document.getElementById('status').textContent) });
  await test('unavailable data leaves mutations disabled', async () => { assert.equal(await page.locator('#prepare').isDisabled(), true); assert.equal(await page.locator('#workspace').isHidden(), true); });
  await page.close();
  console.log(`${checks} browser checks passed`);
 } finally { await suite.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
