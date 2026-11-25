'use strict';
// Billing → AI credit, on the real page with a synthetic database.
// Every number below is a fixture. The point is that each STATE reads as
// itself: unavailable, not switched on, preview, never granted, exhausted and
// active are six different sentences, and none of them is a fake "$0.00".
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite } = require('../lib/harness');
const { tables } = require('../lib/payments-fixtures');

const active = {
  state: 'active', account_exists: true, available_micros: 64800000, included_micros: 14800000,
  purchased_micros: 50000000, pending_micros: 0, plan_included_micros: 30000000, plan_key: 'growth',
  is_admin: true, can_top_up: true, packs_configured: true,
  period: { start: '2026-09-19T12:00:00Z', end: '2026-10-19T12:00:00Z', source: 'subscription' },
  included_granted_this_period: 30000000, used_this_period_micros: 15200000,
  usage_by_feature: [
    { feature: 'ask_silo', charged_micros: 12600000, succeeded: 84, free_failures: 3, pending: 0, unpriced: 0 },
    { feature: 'on_deck', charged_micros: 2600000, succeeded: 12, free_failures: 0, pending: 1, unpriced: 0 },
  ],
  included_expires_at: '2026-10-19T12:00:00Z',
  purchases: [{ at: '2026-09-25T12:00:00Z', credit_micros: 50000000, pack: '$50 credit' }],
  on_deck: { enabled: true, cap_state: 'within', attempts_this_month: 12 },
};
const packs = [{ pack_key: 'p50', title: '$50 credit', unit_amount_cents: 5000, credit_micros: 50000000, is_active: true, sort_order: 1 }];
// Connected AI app calls (silo_api_call_log): three tool calls in the period,
// one of them failed, a handshake that is not a tool call, and one call from
// before the period.
const mcpCalls = [
  { id: 'm1', company_entity_id: 'test-company', tool: 'silo_api_query', outcome: 'ok', created_at: '2026-09-20T10:00:00Z' },
  { id: 'm2', company_entity_id: 'test-company', tool: 'silo_api_list_reports', outcome: 'ok', created_at: '2026-10-01T10:00:00Z' },
  { id: 'm3', company_entity_id: 'test-company', tool: 'silo_api_query', outcome: 'error', created_at: '2026-10-02T10:00:00Z' },
  { id: 'm4', company_entity_id: 'test-company', tool: 'silo_api_connect', outcome: 'ok', created_at: '2026-10-02T09:59:00Z' },
  { id: 'm5', company_entity_id: 'test-company', tool: 'silo_api_query', outcome: 'ok', created_at: '2026-09-01T10:00:00Z' },
];
const withCredit = (summary, packRows = packs, calls = mcpCalls) => ({ ...tables(), ai_credit_packs: packRows, silo_api_call_log: calls });
// Fixture functions are serialised into the page, so the value is inlined.
const rpcFor = (summary, exec = true) => ({ ai_credit_summary: summary === 'error'
  ? () => ({ __error: { message: 'Could not find the function public.ai_credit_summary', code: 'PGRST202' } })
  : Function('return () => (' + JSON.stringify(summary) + ')')(),
  is_exec_or_owner: Function('return () => ' + JSON.stringify(exec))() });

(async () => {
  const suite = await startSuite();
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  const open = (summary, packRows, opts = {}) => suite.open('/v2/billing.html', withCredit(summary, packRows, opts.calls), {
    rpc: rpcFor(summary, opts.exec !== false),
    ...(opts.broken ? { broken: opts.broken } : {}),
    ready: () => !document.querySelector('#credit .bil-empty'),
  });
  try {
    let page = await open(active);
    await check('active: balance, period use, buckets and the shared-balance note', async () => {
      const text = await page.locator('#credit').textContent();
      assert.match(text, /\$64\.80/);
      assert.match(text, /\$15\.20 used of \$80\.00 available this period/);
      assert.match(text, /Included credit left\s*\$14\.80/);
      assert.match(text, /Top-up credit left\s*\$50\.00/);
      assert.match(text, /draw from the same credit balance/);
      assert.match(text, /Expires Oct 19, 2026 · does not roll over/);
      assert.match(text, /Top-up credit left.*Rolls over/s);
      assert.match(await page.locator('#current').textContent(), /Included AI credit\s*\$30\.00/);
    });
    await check('usage by feature reconciles to the total, failures marked free', async () => {
      const usage = await page.locator('#usage').textContent();
      assert.match(usage, /Ask SILO.*84 answers.*3 failed, not charged.*\$12\.60/s);
      assert.match(usage, /On Deck.*12 background runs.*1 in progress.*\$2\.60/s);
      assert.match(usage, /Card coding.*0 suggestion batches.*\$0\.00/s);
      assert.match(usage, /Invoice reading.*0 documents read.*\$0\.00/s);
      assert.match(usage, /Total AI credit used\s*\$15\.20/);
    });
    await check('connected AI apps: a count for the period, never a charge', async () => {
      const row = (await page.locator('[data-usage="mcp"]').textContent()).replace(/\s+/g, ' ');
      assert.match(row, /Connected AI apps/);
      assert.match(row, /3 tool calls · 1 failed/, 'the handshake and the call before the period are not counted');
      assert.match(row, /Not charged/);
      assert.doesNotMatch(row, /\$/, 'no dollar figure beside credit');
      assert.doesNotMatch(row, /your connections only/, 'an owner sees the whole company');
      assert.match(await page.locator('#usage').textContent(), /Total AI credit used\s*\$15\.20/, 'and the total is unchanged');
    });
    await check('On Deck cap shows its state, never a dollar amount beside credit', async () => {
      const cap = await page.locator('#cap').textContent();
      assert.match(cap, /Within cap/);
      assert.match(cap, /Adding credit does not raise this limit/);
      assert.doesNotMatch(cap, /\$/);
    });
    const dir = path.resolve(__dirname, '../../../.screenshots'); fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'billing-ai-credit-desktop.png'), fullPage: true });
    await check('top-up sends only the pack key; the server picks price and credit', async () => {
      const sent = [];
      await page.route('**/functions/v1/stripe-billing', (route) => {
        sent.push(JSON.parse(route.request().postData() || '{}'));
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'stubbed: no Stripe here' }) });
      });
      await page.getByRole('button', { name: /\$50 credit/ }).click();
      await page.waitForFunction(() => /stubbed/.test(document.getElementById('status').textContent));
      assert.equal(sent.length, 1);
      assert.deepEqual(Object.keys(sent[0]).sort(), ['action', 'pack_key', 'request_id']);
      assert.equal(sent[0].action, 'topup');
      assert.equal(sent[0].pack_key, 'p50');
      assert.equal(await page.getByRole('button', { name: /\$50 credit/ }).isDisabled(), false, 'the button recovers after a failure');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForFunction(() => document.querySelector('.silo-sidebar').getBoundingClientRect().right <= 0);
    await page.evaluate(() => { document.getElementById('status').hidden = true; });
    await check('phone width: no horizontal page overflow', async () => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `page overflows by ${over}px`);
    });
    await page.screenshot({ path: path.join(dir, 'billing-ai-credit-mobile.png'), fullPage: true });
    await page.close();

    page = await open('error');
    await check('unavailable: an unreadable summary is never painted as a balance', async () => {
      const text = await page.locator('#credit').textContent();
      assert.match(text, /Unavailable/);
      assert.doesNotMatch(text, /\$0\.00/);
      assert.equal(await page.locator('#usageCard').isVisible(), false);
      assert.match(await page.locator('#current').textContent(), /Growth/, 'the rest of Billing still renders');
    });
    await page.close();

    page = await open({ state: 'unconfigured', can_top_up: true, packs_configured: false });
    await check('not switched on: says so, offers nothing to buy', async () => {
      const text = await page.locator('#credit').textContent();
      assert.match(text, /Not switched on/);
      assert.equal(await page.locator('[data-pack]').count(), 0);
    });
    await page.close();

    page = await open({ ...active, available_micros: null, included_micros: null, purchased_micros: null, account_exists: false, used_this_period_micros: 0, usage_by_feature: [], purchases: [] });
    await check('never granted is not $0.00', async () => {
      const text = await page.locator('#credit').textContent();
      assert.match(text, /No credit yet/);
      assert.doesNotMatch(text, /Included credit left\s*\$0\.00/);
    });
    await page.close();

    page = await open({ ...active, available_micros: 0, included_micros: 0, purchased_micros: 0, used_this_period_micros: 80000000 });
    await check('exhausted: AI pauses, the rest of SILO keeps working', async () => {
      assert.match(await page.locator('#credit').textContent(), /Credit is used up\. AI features are paused; everything else in SILO keeps working/);
    });
    await page.close();

    page = await open({ ...active, state: 'preview' });
    await check('preview: priced but labelled not deducted', async () => {
      assert.match(await page.locator('#credit').textContent(), /Preview · not deducted/);
      assert.match(await page.locator('#usage').textContent(), /priced \(not deducted\)/);
    });
    await page.close();

    page = await open({ ...active, can_top_up: false, is_admin: false, usage_by_feature: undefined, on_deck: undefined, period: undefined, purchases: undefined });
    await check('a member sees the balance, not usage detail, and cannot buy', async () => {
      assert.equal(await page.locator('[data-pack]').count(), 0);
      assert.match(await page.locator('#credit').textContent(), /A workspace owner can add credit/);
      assert.equal(await page.locator('#usageCard').isVisible(), false);
      assert.equal(await page.locator('#capCard').isVisible(), false);
    });
    await page.close();

    page = await open(active, packs, { exec: false });
    await check('connected AI apps: an admin who is not an owner is told it is their own connections', async () => {
      assert.match(await page.locator('[data-usage="mcp"]').textContent(), /your connections only/);
    });
    await page.close();

    page = await open(active, packs, { broken: ['silo_api_call_log'] });
    await check('connected AI apps: an unreadable log leaves the row out, never a 0', async () => {
      assert.equal(await page.locator('[data-usage="mcp"]').count(), 0);
      assert.match(await page.locator('#usage').textContent(), /Ask SILO/, 'the rest of usage still renders');
    });
    await page.close();

    // Affiliate Studio (20261125040000): one usage line, the company's own
    // limits, the last nightly run -- customer dollars only.
    const studio = { month_micros: 4250000, month_cap_micros: 20000000, nightly_enabled: true, night_max_customers: 300, night_max_micros: 3000000,
      can_edit: true, month_start: '2026-10-01T07:00:00Z',
      last_night: { started_at: '2026-10-05T14:30:00Z', status: 'done', checked: 300, likely: 4, to_check: 6, note: null } };
    const withStudio = { ...active, usage_by_feature: [...active.usage_by_feature, { feature: 'affiliate_research', charged_micros: 4250000, succeeded: 40, free_failures: 0, pending: 0, unpriced: 0 }] };
    const studioRpc = (sum) => ({ ...rpcFor(withStudio),
      affiliate_studio_spend_summary: Function('return () => (' + JSON.stringify(sum) + ')')(),
      affiliate_studio_set_spend: Function('return (args) => { window.__studioSaved = args; return (' + JSON.stringify({ ...sum, nightly_enabled: false, month_cap_micros: null }) + '); }')() });
    page = await suite.open('/v2/billing.html', withCredit(withStudio), { rpc: studioRpc(studio), ready: () => !document.querySelector('#credit .bil-empty') && !document.getElementById('studioCard').hidden });
    await check('Affiliate Studio: one usage line for Find and Discovery, in customer dollars', async () => {
      const usage = (await page.locator('#usage').textContent()).replace(/\s+/g, ' ');
      assert.match(usage, /Affiliate Studio\s*Find creators, Discovery and Ask SILO in Studio \$4\.25/);
      assert.equal((usage.match(/Affiliate Studio/g) || []).length, 1, 'never split into Find and Discovery');
      const card = (await page.locator('#studio').textContent()).replace(/\s+/g, ' ');
      assert.match(card, /Used this month\s*\$4\.25 of a \$20\.00 cap/);
      assert.match(card, /300 checked · 4 Likely · 6 to check/);
      assert.doesNotMatch(card, /provider|multiplier|markup|rate/i, 'nothing about what SILO pays');
      assert.equal(await page.locator('#stNightly').isChecked(), true);
      assert.equal(await page.locator('#stCust').inputValue(), '300');
      assert.equal(await page.locator('#stNight').inputValue(), '3');
      assert.equal(await page.locator('#stMonth').inputValue(), '20');
    });
    await page.locator('#studioCard').screenshot({ path: path.join(dir, 'billing-affiliate-studio.png') });
    await check('Affiliate Studio: an owner saves the limits in dollars; a blank cap is no cap', async () => {
      await page.locator('#stNightly').uncheck();
      await page.locator('#stCust').fill('150');
      await page.locator('#stNight').fill('1.5');
      await page.locator('#stMonth').fill('');
      await page.locator('#stSave').click();
      await page.waitForFunction(() => /limits saved/.test(document.getElementById('status').textContent));
      assert.deepEqual(await page.evaluate(() => window.__studioSaved), { p_nightly: false, p_night_customers: 150, p_night_usd: 1.5, p_month_usd: null });
      assert.match(await page.locator('#studio').textContent(), /No monthly cap/);
    });
    await check('Affiliate Studio: before the Discovery update, no Discovery fields and none sent', async () => {
      assert.equal(await page.locator('#stDisc').count(), 0);
      assert.doesNotMatch(await page.locator('#studio').textContent(), /new creators/);
    });
    await page.close();
    // Nightly Discovery (20261125100000): its own switch and limits, modest
    // by default; the last run shows counts only.
    const disc = { ...studio, discovery_nightly_enabled: false, discovery_night_creators: 10, discovery_night_max_micros: 1000000,
      last_discovery: { started_at: '2026-10-06T13:20:00Z', status: 'ok', new: 7, program: 'Coaches' } };
    page = await suite.open('/v2/billing.html', withCredit(withStudio), { rpc: studioRpc(disc), ready: () => !document.querySelector('#credit .bil-empty') && !document.getElementById('studioCard').hidden });
    await check('Affiliate Studio: nightly Discovery has its own switch and limits, saved with the rest', async () => {
      const card = (await page.locator('#studio').textContent()).replace(/\s+/g, ' ');
      assert.match(card, /Last night · new creators\s*Oct 6, 2026 · 7 new · Coaches/);
      // Each switch sits under its own heading: customers (Find), then new creators (Discovery).
      const form = (await page.locator('#studioForm').textContent()).replace(/\s+/g, ' ');
      assert.match(form, /Your customers · Find\s*Check my customers for creators every night.*New creators · Discovery\s*Discover new creators every night.*All Affiliate Studio use/);
      assert.doesNotMatch(card, /provider|multiplier|markup|rate/i);
      assert.equal(await page.locator('#stDisc').isChecked(), false);
      assert.equal(await page.locator('#stDiscN').inputValue(), '10');
      assert.equal(await page.locator('#stDiscUsd').inputValue(), '1');
      await page.locator('#stDisc').check();
      await page.locator('#stDiscN').fill('20');
      await page.locator('#stDiscUsd').fill('2.5');
      await page.locator('#stSave').click();
      await page.waitForFunction(() => /limits saved/.test(document.getElementById('status').textContent));
      assert.deepEqual(await page.evaluate(() => window.__studioSaved), { p_nightly: true, p_night_customers: 300, p_night_usd: 3, p_month_usd: 20,
        p_discovery: true, p_discovery_creators: 20, p_discovery_usd: 2.5 });
    });
    await page.locator('#studioCard').screenshot({ path: path.join(dir, 'billing-affiliate-studio.png') });
    await page.close();
    page = await suite.open('/v2/billing.html', withCredit(withStudio), { rpc: studioRpc({ ...studio, can_edit: false }), ready: () => !document.querySelector('#credit .bil-empty') && !document.getElementById('studioCard').hidden });
    await check('Affiliate Studio: anyone else reads the limits, cannot change them', async () => {
      assert.equal(await page.locator('#stSave').count(), 0);
      assert.equal(await page.locator('#stCust').isDisabled(), true);
      assert.match(await page.locator('#studio').textContent(), /owner or admin can change these/);
    });
    await page.close();
    page = await open(active);
    await check('Affiliate Studio: a database without it leaves the card out', async () => {
      assert.equal(await page.locator('#studioCard').isHidden(), true);
    });
    await page.close();

    page = await open(active, [{ ...packs[0], title: '<img src=x onerror="window.__XSS__=true">' }]);
    await check('untrusted pack titles render as text', async () => {
      assert.equal(await page.evaluate(() => !!window.__XSS__), false);
      assert.equal(await page.locator('#credit img').count(), 0);
      assert.match(await page.locator('[data-pack]').textContent(), /<img/);
    });
    await page.close();
  } finally {
    await suite.close();
  }
  console.log(`${passed} AI credit billing checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
