'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const co = 'test-company';
const ad = (over = {}) => ({ id: 'ad1', company_entity_id: co, kind: 'ads', status: 'ready', version: 2,
  title: 'Draft creative · Classic tee', selection_reason: 'Strong evidence on purchase performance. Selected #1 of 3 eligible ads opportunities.',
  valid_until: '2099-01-01', source: { objective: 'purchase', index: 1.3, evidence: 'strong', current_copy: 'Classic baseball style.' },
  content: { recommend: true, subject: 'A new angle', summary: 'Prepared variation', body: 'A fresh take on classic baseball style.', missing: [], tasks: [] }, ...over });
const fixtures = () => ({ profiles: [{ id: 'test-user', role: 'owner', email: 'owner@example.test' }],
  on_deck_settings: [{ company_entity_id: co, enabled: true, last_screen_at: '2026-10-08T07:00:00Z' }],
  on_deck_proposals: [ad(), ad({ id: 'ad2', title: 'Draft creative · Youth tees' }), ad({ id: 'ad3', title: 'Draft creative · Caps' }),
    ad({ id: 'ad4', title: 'Draft creative · Hoodies' }), ad({ id: 'needs', status: 'needs_info', content: { body: 'Draft', missing: ['Targeting details'] } }),
    ad({ id: 'old', valid_until: '2020-01-01' }), ad({ id: 'done', status: 'completed', output: { label: 'Ad idea created — not published', url: '/v2/ad-studio.html' } })],
  on_deck_events: [], on_deck_attempts: [] });
const rpc = { on_deck_can_review: () => true, on_deck_coding_access: () => ({ review: false, post: false }) };
const ready = () => !document.getElementById('briefing').hidden;
const shots = process.env.SILO_BRIEFING_SCREENSHOTS || path.resolve(__dirname, '../../../.screenshots');
(async () => {
  const suite = await startSuite({ secureContext: true });
  await suite.context.route('**/v2/lib/supabase-js.min.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript().replace('all = all(args) || [];', 'all = all(args);') }));
  let n = 0;
  const test = async (label, fn) => { await fn(); console.log(`ok ${++n} - ${label}`); };
  const open = (tables = fixtures(), options = {}) => suite.open('/v2/on-deck.html', tables, { rpc, ready, ...options });
  let page;
  try {
    page = await open();
    await test('default briefing presents one plus two, full queue is hidden, no mutation on login', async () => {
      assert.equal(await page.locator('#briefing [data-recommendation]').count(), 3);
      assert.equal(await page.locator('.od-hero').count(), 1); assert.equal(await page.locator('#workspace').isVisible(), false);
      assert.match(await page.locator('.od-hero').textContent(), /1\.30×/);
      assert.doesNotMatch(await page.locator('#briefing').textContent(), /Draft 2|CTR fell|sales stayed strong|revenue gain/);
      assert.equal(await page.evaluate(() => window.__QUERIES__.some(q => /decide|request_preparation/.test(q.table))), false);
    });
    await test('review button opens exact proposal draft without approving', async () => {
      await page.locator('.od-hero').getByRole('button', { name: 'Review campaign test' }).click();
      await page.waitForFunction(() => document.body.dataset.desk === 'work');
      assert.match(await page.locator('.od-paper').textContent(), /fresh take/);
      assert.equal(await page.locator('.od-card[aria-pressed=true]').textContent().then(t => /Classic tee/.test(t)), true);
      assert.equal(await page.evaluate(() => window.__QUERIES__.some(q => q.table === 'rpc:on_deck_decide')), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'detail');
    });
    await test('back to briefing and evidence use real existing detail tabs', async () => {
      await page.getByRole('button', { name: 'Briefing', exact: true }).click();
      await page.locator('.od-hero').getByRole('button', { name: 'See evidence' }).click();
      assert.equal(await page.getByRole('button', { name: 'Evidence', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('#detail').textContent(), /OBJECTIVE/);
      await page.getByRole('button', { name: 'Briefing', exact: true }).click();
    });
    await test('desktop, dark and mobile Beacon rendering stays within bounds', async () => {
      fs.mkdirSync(shots, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.screenshot({ path: path.join(shots, 'on-deck-briefing-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'Toggle theme' }).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      const surfaces = await page.locator('.od-hero').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color }));
      assert.notEqual(surfaces.bg, 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(shots, 'on-deck-briefing-dark.png'), fullPage: true });
      await page.getByRole('button', { name: 'Toggle theme' }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector('.silo-sidebar').getBoundingClientRect().right <= 0);
      assert.ok(await page.locator('.od-hero').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator('.od-hero .bcn-btn--primary').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      await page.screenshot({ path: path.join(shots, 'on-deck-briefing-mobile.png'), fullPage: true });
    });
    await page.close();
    const investigation = fixtures();
    investigation.on_deck_proposals = [{ ...ad(), id: 'search-context', kind: 'seo', status: 'needs_info', title: "Men’s T-Shirts | Baseballism Online",
      source: { impressions: 29972, clicks: 175, days: 26, position: 7.3, inspection: { title: 'Men’s T-Shirts', meta_description: 'Current copy' } },
      content: { recommend: true, body: 'Initial SEO draft', missing: ['Ranking keywords', 'CTR benchmark', 'Prior SEO tests'], tasks: [] } }];
    page = await open(investigation, { rpc: { ...rpc, on_deck_coding_access: () => ({ review: true, post: false }), on_deck_coding_items: () => [{ batch_id: 'b', source_name: 'Bank feed', stage: 'code', open_suggestions: 30 }], silo_ledger_batch_status: () => [] } });
    await test('blocked search evidence leads the briefing; bookkeeping remains quiet; investigation preserves approval gate', async () => {
      assert.match(await page.locator('.od-hero').textContent(), /29,972/);
      assert.equal(await page.locator('.od-hero .od-signal-status').textContent(), 'Needs context');
      assert.match(await page.locator('.od-secondary').textContent(), /BOOKKEEPING/);
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.screenshot({ path: path.join(shots, 'on-deck-investigation-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'Toggle theme' }).click();
      await page.screenshot({ path: path.join(shots, 'on-deck-investigation-dark.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.waitForFunction(() => document.querySelector('.silo-sidebar').getBoundingClientRect().right <= 0);
      await page.screenshot({ path: path.join(shots, 'on-deck-investigation-mobile.png'), fullPage: true });
      await page.locator('.od-hero').getByRole('button', { name: 'Investigate search opportunity' }).click();
      assert.match(await page.locator('.od-card[aria-pressed=true]').textContent(), /Men’s T-Shirts/);
      assert.equal(await page.getByRole('button', { name: 'Evidence', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByRole('button', { name: 'Create draft SEO task', exact: true }).isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__QUERIES__.some(q => /decide|request_preparation/.test(q.table))), false);
    }); await page.close();
    const handoffTables = fixtures();
    handoffTables.on_deck_proposals = [{ ...investigation.on_deck_proposals[0], version: 2, content: { ...investigation.on_deck_proposals[0].content, missing: ['Current ranking keywords driving the 175 clicks', 'Click-through rate benchmark for position ~7.3 in this vertical', 'Any prior SEO test history for this page'] } }];
    page = await open(handoffTables, { rpc: { ...rpc, on_deck_decide: args => {
      const p = window.__FIXTURE_TABLES__.on_deck_proposals[0];
      if (window.__REJECT_HANDOFF__) return { __error: { message: 'Evidence changed. Request a fresh preparation first' } };
      if (args.p_version !== p.version) return { __error: { message: 'Stale proposal version' } };
      if (args.p_action === 'edit') { p.content = args.p_content; p.status = p.content.missing.length ? 'needs_info' : 'ready'; }
      if (args.p_action === 'approve') {
        if (p.status !== 'ready' || p.content.missing.length) return { __error: { message: 'Resolve missing information first' } };
        window.__CREATED_TASK__ = { status: 'draft', body: p.content.body };
        p.status = 'completed'; p.output = { label: 'SEO draft created — publishing requires separate review', url: '/v2/seo-tasks.html' };
      } p.version++; return p;
    } } });
    await test('explicit research handoff closes the loop from blocked opportunity to separately confirmed draft task', async () => {
      await page.locator('.od-hero').getByRole('button', { name: 'Investigate search opportunity' }).click();
      await page.getByRole('button', { name: 'Prepared draft', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Create draft SEO task', exact: true }).isDisabled(), true);
      assert.match(await page.locator('.od-next-step').textContent(), /175 clicks/);
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.locator('.od-next-step').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shots, 'on-deck-task-handoff-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'Prepare draft task', exact: true }).click();
      await page.getByRole('button', { name: 'Save task prep', exact: true }).click();
      assert.match(await page.locator('#handoff-error').textContent(), /choose a research question/);
      for (const box of await page.locator('#handoff-inputs input').all()) await box.check();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector('.silo-sidebar').getBoundingClientRect().right <= 0);
      assert.ok(await page.locator('#handoff-dialog').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      await page.screenshot({ path: path.join(shots, 'on-deck-task-prep-mobile.png'), fullPage: true });
      await page.evaluate(() => { window.__REJECT_HANDOFF__ = true; });
      await page.getByRole('button', { name: 'Save task prep', exact: true }).click();
      assert.match(await page.locator('#handoff-error').textContent(), /Evidence changed/);
      assert.equal(await page.locator('#handoff-dialog').evaluate(el => el.open), true);
      assert.equal(await page.evaluate(() => window.__FIXTURE_TABLES__.on_deck_proposals[0].status), 'needs_info');
      await page.evaluate(() => { window.__REJECT_HANDOFF__ = false; });
      await page.getByRole('button', { name: 'Save task prep', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('handoff-dialog').open);
      assert.match(await page.locator('.od-paper').textContent(), /Research to complete before publishing/);
      assert.match(await page.locator('.od-card[aria-pressed=true]').textContent(), /Men’s T-Shirts/);
      assert.equal(await page.evaluate(() => window.__QUERIES__.filter(q => q.table === 'rpc:on_deck_decide').length), 2);
      await page.getByRole('button', { name: 'Create draft SEO task', exact: true }).click();
      assert.match(await page.locator('#decision-explanation').textContent(), /version 3/);
      await page.getByRole('button', { name: 'Confirm · Create draft SEO task', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('decision-dialog').open);
      assert.match(await page.locator('#detail').textContent(), /SEO draft created/);
      assert.equal(await page.evaluate(() => window.__CREATED_TASK__.status), 'draft');
      assert.match(await page.evaluate(() => window.__CREATED_TASK__.body), /prior SEO test history/);
    }); await page.close();
    const empty = fixtures(); empty.on_deck_proposals = [ad({ status: 'needs_info', source: { ...ad().source, evidence: 'weak' } }), ad({ id: 'old', valid_until: '2020-01-01' })];
    page = await open(empty);
    await test('no weak recommendation is invented for blocked or expired work', async () => {
      assert.equal(await page.locator('.od-hero').count(), 0); assert.match(await page.locator('#briefing').textContent(), /No growth opportunity/);
      await page.getByRole('button', { name: 'View all work' }).click();
      await page.locator('[data-view=needs]').click(); assert.equal(await page.locator('.od-card').count(), 1);
    }); await page.close();
    page = await open(fixtures(), { rpc: { ...rpc, on_deck_coding_access: () => ({ review: true, post: false }), on_deck_coding_items: () => [{ batch_id: 'b', source_name: 'Bank feed', stage: 'code', open_suggestions: 30 }], silo_ledger_batch_status: () => [] } });
    await test('coding refresh failure removes only coding and retains authorized proposals', async () => {
      await page.evaluate(() => { window.__FIXTURE_RPC__.on_deck_coding_items = () => { throw new Error('Bank review unavailable'); }; });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('refresh').disabled);
      assert.match(await page.locator('.od-hero').textContent(), /Classic tee/);
      assert.equal(await page.locator('#ready-cards [data-batch=b]').count(), 0);
      assert.match(await page.locator('#status').textContent(), /Bank review unavailable/);
    }); await page.close();
    page = await open();
    await test('failed refresh removes stale recommendations and displays a failure', async () => {
      await page.evaluate(() => { window.__FIXTURE_BROKEN__ = ['on_deck_proposals']; });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('refresh').disabled);
      assert.equal(await page.locator('.od-hero').count(), 0); assert.ok(await page.locator('#status').isVisible());
      assert.match(await page.locator('#briefing').textContent(), /could not be loaded/);
    }); await page.close();
    const unsafe = fixtures(); unsafe.on_deck_proposals[0].title = 'Creative · <img src=x onerror="window.__XSS__=1">';
    page = await open(unsafe);
    await test('untrusted recommendation names render only as text', async () => {
      assert.match(await page.locator('.od-hero').textContent(), /<img/);
      assert.equal(await page.locator('#briefing img').count(), 0); assert.equal(await page.evaluate(() => !!window.__XSS__), false);
    }); await page.close();
    page = await open();
    await test('expiry at click time refuses the previously featured action', async () => {
      await page.evaluate(() => { window.__FIXTURE_TABLES__.on_deck_proposals[0].valid_until = '2020-01-01'; });
      await page.locator('.od-hero').getByRole('button', { name: 'Review campaign test' }).click();
      await page.waitForFunction(() => /no longer available/.test(document.getElementById('status').textContent));
      assert.equal(await page.evaluate(() => document.body.dataset.desk), 'briefing');
    }); await page.close();
    page = await open(fixtures(), { rpc: { ...rpc, on_deck_can_review: () => false, on_deck_coding_access: () => ({ review: true, post: false }), on_deck_coding_items: () => [{ batch_id: 'b', source_name: 'Bank feed', stage: 'code', open_suggestions: 30 }], silo_ledger_batch_status: () => [] } });
    await test('finance-only session gets quiet bookkeeping without a growth hero or proposal query', async () => {
      assert.match(await page.locator('#briefing').textContent(), /30 suggested/);
      assert.equal(await page.evaluate(() => window.__QUERIES__.some(q => q.table === 'on_deck_proposals')), false);
      assert.equal(await page.locator('.od-hero').count(), 0); assert.equal(await page.locator('.od-secondary').count(), 1);
    }); await page.close();
    page = await open();
    await test('changed company invalidates the briefing on refresh', async () => {
      await page.evaluate(() => { window.__SILO_CONFIG__.ensureActiveCompany = async () => ({ id: 'other-company' }); });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('refresh').disabled);
      assert.ok(await page.locator('#briefing').isHidden()); assert.ok(await page.locator('#workspace').isHidden());
      assert.match(await page.locator('#status').textContent(), /Active company changed/);
    });
    console.log(`${n} briefing browser checks passed`);
  } finally { await suite.close(); }
})().catch(e => { console.error(e); process.exit(1); });
