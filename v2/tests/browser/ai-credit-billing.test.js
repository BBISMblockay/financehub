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
  purchases: [{ at: '2026-09-25T12:00:00Z', credit_micros: 50000000, pack: '$50 credit' }],
  on_deck: { enabled: true, cap_state: 'within', attempts_this_month: 12 },
};
const packs = [{ pack_key: 'p50', title: '$50 credit', unit_amount_cents: 5000, credit_micros: 50000000, is_active: true, sort_order: 1 }];
const withCredit = (summary, packRows = packs) => ({ ...tables(), ai_credit_packs: packRows });
// Fixture functions are serialised into the page, so the value is inlined.
const rpcFor = (summary) => ({ ai_credit_summary: summary === 'error'
  ? () => ({ __error: { message: 'Could not find the function public.ai_credit_summary', code: 'PGRST202' } })
  : Function('return () => (' + JSON.stringify(summary) + ')')() });

(async () => {
  const suite = await startSuite();
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  const open = (summary, packRows) => suite.open('/v2/billing.html', withCredit(summary, packRows), {
    rpc: rpcFor(summary),
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
      assert.match(await page.locator('#current').textContent(), /Included AI credit\s*\$30\.00/);
    });
    await check('usage by feature reconciles to the total, failures marked free', async () => {
      const usage = await page.locator('#usage').textContent();
      assert.match(usage, /Ask SILO.*84 answers.*3 failed, not charged.*\$12\.60/s);
      assert.match(usage, /On Deck.*12 background runs.*1 in progress.*\$2\.60/s);
      assert.match(usage, /Total AI credit used\s*\$15\.20/);
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
      assert.match(await page.locator('#credit').textContent(), /Credit is used up\. Ask SILO and On Deck are paused; everything else in SILO keeps working/);
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
