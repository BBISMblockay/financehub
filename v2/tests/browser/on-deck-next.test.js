'use strict';
/* The one-screen On Deck (/v2/on-deck-next.html). What is asserted here is the
   promise the page makes: only a draft SILO can finish on its own appears as a
   recommendation, every card answers what SILO recommends and why, what it
   needs from you and what the button does, with exactly one control, no
   department takes the grid, anything SILO has not finished is NOT surfaced
   (it sits collapsed, where it cannot read as work waiting on the reader), and
   a failed status call says so instead of inventing a status. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');
const co = 'test-company';
const seo = (over = {}) => ({ id: 'seo1', company_entity_id: co, kind: 'seo', status: 'ready', version: 2,
  title: 'Search copy · Classic tees', selection_reason: 'Selected #1 of 4 eligible seo opportunities.',
  valid_until: '2099-01-01', source_version: 'current',
  source: { url: 'https://example.test/tees', impressions: 30000, clicks: 180, position: 7, days: 26, inspection: { title: 'Tees', meta_description: 'Current copy' } },
  content: { recommend: true, subject: 'Collection search copy review', summary: 'A grounded hypothesis.', reason: 'Observed page exposure.',
    body: 'A draft for review.', missing: [], optional_context: [], tasks: [],
    proposed_title: 'Classic tees | Example', proposed_meta_description: 'Explore classic tees.' }, ...over });
const ads = (over = {}) => ({ id: 'ad1', company_entity_id: co, kind: 'ads', status: 'needs_info', version: 2,
  title: 'Draft creative · Youth caps', selection_reason: 'Selected #1 of 2 eligible ads opportunities.',
  valid_until: '2099-01-01', source_version: 'current',
  source: { objective: 'purchase', index: 1.3, evidence: 'strong', current_copy: 'Classic baseball style.' },
  content: { recommend: true, subject: 'A new angle', summary: 'Prepared variation', reason: 'Measured evidence',
    body: 'A fresh take on classic baseball style.', missing: ['Confirm the product claim against the approved brief.'], tasks: [] }, ...over });
const fixtures = (rows) => ({ profiles: [{ id: 'test-user', role: 'owner', email: 'owner@example.test' }],
  on_deck_settings: [{ company_entity_id: co, enabled: true, last_screen_at: '2026-10-15T07:00:00Z' }],
  on_deck_proposals: rows, on_deck_events: [], on_deck_attempts: [] });
const rpc = {
  on_deck_can_review: () => true,
  on_deck_review_state: () => ({ review_contract: 2, drift_warns: true, seo: true, purchasing: true, context_tasks: [], assignees: [], tasks: [],
    // Mirrors on_deck_preparation_state's own ordering (20261014120000, line 100
    // onward): a row whose evidence basis was emptied is queued for screening,
    // not failed, so the page must not read a refresh as a failure.
    proposals: window.__FIXTURE_TABLES__.on_deck_proposals.map(p => ({ id: p.id, source_current: p.source_version === 'current',
      preparation: !['preparing', 'revision', 'failed'].includes(p.status) ? { state: 'idle' }
        : p.status === 'failed' && p.source_version !== '' ? { state: 'failed', reason: 'preparation_failed' }
        : { state: 'queued', reason: p.source_version === '' ? 'screening' : 'drafting' } })) }),
  on_deck_decide: a => { const p = window.__FIXTURE_TABLES__.on_deck_proposals.find(x => x.id === a.p_id); if (a.p_action === 'refresh') { p.status = 'failed'; p.source_version = ''; } p.version++; return p; },
};
const ready = () => !document.getElementById('cards').hidden;
const shots = path.resolve(__dirname, '../../../.screenshots');
// NEXT_MUTATE breaks one guarantee at a time; each name must cost a check above.
const mutations = {
  'show-unready': ["statusOf(p).key !== 'ready'", 'false'],
  'no-department-cap': ['n >= PER_KIND', 'false'],
  'guess-status': ['} catch (e) { state.reviewFailed = true; }', '} catch (e) { state.reviewFailed = false; }'],
  'silent-refresh': ['if (await load()) message(', 'if (await load() && false) message('],
  'keep-other-company': ['      clearSurfaces();\n', ''],
  // Blake, 2026-10-16: "if silo isn't finished reviewing, don't surface it."
  // Both halves of that: unfinished work must not join the asks the reader is
  // being shown, and SILO's own progress must stay collapsed.
  'surface-unfinished': ["statusOf(p).key === 'needs_input'", "statusOf(p).key !== 'ready'"],
  'engine-expanded': ['if (rest.length) wrap.append(list(', "wrap.setAttribute('open', '');\n    if (rest.length) wrap.append(list("],
};
(async () => {
  const suite = await startSuite({ secureContext: true });
  if (process.env.NEXT_MUTATE) {
    const [from, to] = mutations[process.env.NEXT_MUTATE] || [];
    const file = path.resolve(__dirname, '../../on-deck-next.js');
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(from && source.includes(from), `mutation target not found: ${process.env.NEXT_MUTATE}`);
    await suite.context.route('**/v2/on-deck-next.js', route => route.fulfill({ contentType: 'text/javascript', body: source.replace(from, to) }));
  }
  await suite.context.route('**/v2/lib/supabase-js.min.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript().replace('all = all(args) || [];', 'all = all(args);') }));
  let n = 0, page;
  const test = async (label, fn) => { await fn(); console.log(`ok ${++n} - ${label}`); };
  const open = (rows, options = {}) => suite.open('/v2/on-deck-next.html', fixtures(rows), { rpc, ready, ...options });
  const cards = () => page.locator('#cards .odn-card');
  try {
    page = await open([seo(), ads()]);
    await test('a complete draft is the recommendation; its three answers and one button are all present', async () => {
      assert.equal(await cards().count(), 1);
      const card = cards().first(), body = await card.textContent();
      assert.match(body, /SEO/);                                   // which department
      assert.match(body, /Test clearer search copy/);              // what SILO recommends
      assert.match(body, /30,000/);                                // the evidence it rests on
      assert.match(body, /Review how this page presents/);         // why
      assert.match(body, /needs your judgement/);                  // what it needs from you
      assert.match(body, /Nothing is created until you confirm/);   // what the button does
      assert.equal(await card.locator('.od-buttons a, .od-buttons button').count(), 1);
      const href = await card.getByRole('link', { name: 'Review draft' }).getAttribute('href');
      assert.equal(new URL(href, page.url()).pathname + new URL(href, page.url()).search, '/v2/on-deck.html?proposal=seo1');
      assert.equal(await page.evaluate(() => window.__QUERIES__.some(q => /decide|request_preparation|context/.test(q.table))), false);
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'on-deck-next.png'), fullPage: true });
    });
    await test('a draft still waiting on answers is one line with one button, not a recommendation', async () => {
      assert.doesNotMatch(await page.locator('#cards').textContent(), /Youth caps/);
      const strip = page.locator('#needs');
      assert.equal(await strip.isVisible(), true);
      assert.match(await strip.textContent(), /SILO needs an answer from you/);
      const row = strip.locator('.odn-row', { hasText: 'Youth caps' });
      assert.equal(await row.getByRole('link', { name: 'Answer 1 question' }).count(), 1);
      // The explanatory paragraphs and status pills that used to sit here are
      // what made the page read as machinery.
      assert.doesNotMatch(await strip.textContent(), /not recommendations yet|cannot finish on its own/);
      assert.equal(await strip.locator('.od-rpill').count(), 0);
    });
    await test('mobile width shows the same page with no sideways scroll', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(shots, 'on-deck-next-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    });
    await page.close();

    page = await open([seo({ id: 's1' }), seo({ id: 's2', title: 'Search copy · Caps', selection_reason: 'Selected #2 of 4 eligible seo opportunities.' }),
      seo({ id: 's3', title: 'Search copy · Hoodies', selection_reason: 'Selected #3 of 4 eligible seo opportunities.' })]);
    await test('no single department takes the grid; the rest stay reviewable below it', async () => {
      assert.equal(await cards().count(), 2);
      const extra = page.locator('#cards .odn-row');
      assert.equal(await extra.count(), 1);
      assert.match(await page.locator('#cards').textContent(), /Also ready for review/);
      assert.equal(await extra.getByRole('link', { name: 'Review draft' }).count(), 1);
    });
    await page.close();

    page = await open([seo({ source_version: 'old' })]);
    await test('a draft prepared before the last sync is usable and says so', async () => {
      assert.equal(await cards().count(), 1);
      assert.match(await cards().first().textContent(), /data has refreshed since this draft/);
      assert.equal(await cards().first().getByRole('link', { name: 'Review draft' }).count(), 1);
    });
    await page.close();

    page = await open([seo({ valid_until: '2020-01-01' })]);
    await test('an expired draft is not surfaced; its one control, inside SILO’s progress, queues a fresh one', async () => {
      assert.equal(await cards().count(), 0);
      assert.match(await page.locator('#cards').textContent(), /Nothing is ready for you to act on/);
      assert.equal(await page.locator('#needs').isVisible(), false);
      const engine = page.locator('#engine');
      assert.match(await engine.textContent(), /What SILO is still working on \(1\)/);
      assert.match(await engine.textContent(), /Evidence expired/);
      if (!await engine.locator('details').evaluate(d => d.open)) await engine.locator('summary').click();
      await engine.getByRole('button', { name: 'Refresh evidence' }).click();
      await page.waitForFunction(() => window.__FIXTURE_TABLES__.on_deck_proposals[0].source_version === '');
      assert.match(await page.locator('#status').textContent(), /Fresh screening requested/);
      await page.waitForFunction(() => /Queued to prepare/.test(document.getElementById('engine').textContent));
      assert.match(await engine.textContent(), /Waiting for the scheduler to screen/);
    });
    await page.close();

    // A lifecycle status of 'preparing' is also what a row paused on exhausted
    // credit looks like, so neither may be surfaced as work the reader can act on.
    page = await open([seo({ status: 'preparing' })], { rpc: { ...rpc,
      on_deck_review_state: () => ({ review_contract: 2, drift_warns: true, seo: true, purchasing: true, context_tasks: [], assignees: [], tasks: [],
        proposals: [{ id: 'seo1', source_current: true, preparation: { state: 'paused', reason: 'credit_exhausted' } }] }) } });
    await test('a draft SILO has not finished is not surfaced at all; it sits collapsed', async () => {
      assert.equal(await cards().count(), 0);
      assert.equal(await page.locator('#needs').isVisible(), false);
      const engine = page.locator('#engine');
      assert.match(await engine.textContent(), /What SILO is still working on \(1\)/);
      assert.match(await engine.textContent(), /Paused/);
      assert.match(await engine.textContent(), /AI credit is exhausted/);
      assert.equal(await engine.locator('.odn-row').first().isVisible(), false, 'SILO’s progress is expanded by default');
      await engine.locator('summary').click();
      assert.equal(await engine.locator('.odn-row').first().isVisible(), true);
      assert.match(await engine.textContent(), /Last screened/);
    });
    await page.close();

    page = await open([seo()]);
    await test('a company change takes the previous company’s recommendations off the screen', async () => {
      assert.equal(await cards().count(), 1);
      await page.evaluate(() => { window.__FIXTURE_SERVER_COMPANY__ = { id: 'other-company' }; });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(() => /Active company changed/.test(document.getElementById('status').textContent));
      for (const id of ['cards', 'needs', 'engine', 'done']) {
        assert.equal(await page.locator('#' + id).isVisible(), false, id + ' is still on screen');
        assert.equal(await page.locator('#' + id).textContent(), '', id + ' still carries the previous company’s content');
      }
      assert.equal(await page.locator('a', { hasText: 'Review draft' }).count(), 0);
    });
    await page.close();

    page = await open([seo()], { rpc: { ...rpc, on_deck_review_state: () => { throw new Error('status unavailable'); } } });
    await test('a failed status call says so and offers a retry instead of inventing a status', async () => {
      assert.equal(await cards().count(), 0);
      assert.match(await page.locator('#status').textContent(), /could not load the status/);
      assert.equal(await page.locator('#status').getByRole('button', { name: 'Retry' }).count(), 1);
      assert.equal(await page.locator('#needs').isVisible(), false);
      assert.match(await page.locator('#engine').textContent(), /Status unavailable/);
    });
    await page.close();
    console.log(`\n# on-deck-next: ${n} checks passed`);
  } finally { await suite.close(); }
})().catch(e => { console.error(e); process.exit(1); });
