/* Ask SILO and AI credit: the compact balance and what each answer cost.
 *
 * The edge function is stubbed at the network boundary; the summary RPC is a
 * fixture. Asserted on the real page:
 *   - the balance pill shows the customer balance, and HIDES when credit is
 *     not switched on (nothing changes for an unmetered workspace)
 *   - an unreadable balance says "unavailable", never $0.00
 *   - each answer shows its settled, customer-priced cost; a free one says so
 *   - out of credit (402) shows a final message with no Try again
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('ask-silo-credit');
const summaryRpc = (summary) => ({ ai_credit_summary: summary === 'error'
  ? () => ({ __error: { message: 'connection reset', code: 'PGRST000' } })
  : summary === 'missing'
    ? () => ({ __error: { message: 'Could not find the function public.ai_credit_summary', code: 'PGRST202' } })
    : Function('return () => (' + JSON.stringify(summary) + ')')() });

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });
  let script = [];
  await suite.context.route('**/functions/v1/silo-chat', async (route) => {
    const next = script.shift() || { answer: 'OK.' };
    const status = next.__status || 200;
    delete next.__status;
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(next) });
  });
  const open = (summary) => suite.open('/v2/silo-chat.html', {}, {
    rpc: summaryRpc(summary),
    ready: () => !!document.getElementById('input'),
  });
  const ask = async (page, text) => {
    await page.fill('#input', text);
    await page.click('#btnSend');
    await page.waitForTimeout(500);
  };
  const pill = async (page) => {
    await page.waitForTimeout(200);
    return page.evaluate(() => { const p = document.getElementById('creditPill'); return p.hidden ? null : p.textContent; });
  };

  const pillClass = (page) => page.evaluate(() => document.getElementById('creditPill').className);
  // The owner-admin pays, so only they see the balance at all times and what
  // each answer cost.
  const OWNER = { can_top_up: true, plan_included_micros: 30000000 };
  let page = await open({ state: 'active', available_micros: 64800000, included_micros: 14800000, purchased_micros: 50000000, pending_micros: 0, ...OWNER });
  { const v = await pill(page); r.ok('balance pill', v === 'AI credit $64.80', 'got ' + v); }
  r.ok('plenty left is green', /bcn-pill--pos/.test(await pillClass(page)));

  script = [{ answer: 'Sales were $10.', ai_credit: { status: 'charged', charged_micros: 420000 } }];
  await ask(page, 'sales last week?');
  r.ok('the answer shows what it cost', /\$0\.42 AI credit/.test(await page.textContent('#log')));
  r.ok('the cost sits inside the answer\'s details, not under every answer',
    (await page.locator('#log details.ac-queries .ac-credit-note').count()) === 1
    && (await page.locator('#log > .ac-msg > div > .ac-credit-note').count()) === 0);

  script = [{ answer: 'Hello.', ai_credit: { status: 'charged', charged_micros: 3000 } }];
  await ask(page, 'hi');
  r.ok('a sub-cent charge is shown as <$0.01, not $0.00', /<\$0\.01 AI credit/.test(await page.textContent('#log')));

  script = [{ __status: 402, error: "Your workspace is out of AI credit, so Ask SILO can't answer right now.", credit_exhausted: true, retryable: false }];
  await ask(page, 'inventory?');
  const log = await page.textContent('#log');
  r.ok('out of credit is explained', /out of AI credit/.test(log));
  r.ok('and offers no Try again', (await page.locator('#log .ac-retry-btn:not([disabled])').count()) === 0);

  const dir = path.resolve(__dirname, '../../../.screenshots'); fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'ask-silo-credit-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  r.ok('phone width: no horizontal page overflow',
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  await page.screenshot({ path: path.join(dir, 'ask-silo-credit-mobile.png'), fullPage: false });
  await page.close();

  // Owner: yellow when getting low, red when very low.
  page = await open({ state: 'active', available_micros: 5000000, ...OWNER });
  { const v = await pill(page); r.ok('owner, getting low: the balance', v === 'AI credit $5.00', 'got ' + v); }
  r.ok('owner, getting low: yellow', /ac-credit-pill--warn/.test(await pillClass(page)));
  await page.close();
  page = await open({ state: 'active', available_micros: 1500000, ...OWNER });
  r.ok('owner, very low: red', /bcn-pill--neg/.test(await pillClass(page)));
  await page.close();

  // A member: no balance and no per-answer cost while there is plenty.
  const MEMBER = { can_top_up: false, plan_included_micros: 30000000 };
  page = await open({ state: 'active', available_micros: 64800000, ...MEMBER });
  { const v = await pill(page); r.ok('member, plenty left: no pill', v === null, 'got ' + v); }
  script = [{ answer: 'Sales were $10.', ai_credit: { status: 'charged', charged_micros: 420000 } }];
  await ask(page, 'sales last week?');
  r.ok('member: no per-answer cost', !/AI credit|\$0\.42/.test(await page.textContent('#log')));
  await page.close();
  page = await open({ state: 'active', available_micros: 5000000, ...MEMBER });
  { const v = await pill(page); r.ok('member, getting low: a yellow warning without the amount', v === 'AI credit low', 'got ' + v); }
  r.ok('member, getting low: yellow', /ac-credit-pill--warn/.test(await pillClass(page)));
  await page.close();
  page = await open({ state: 'active', available_micros: 1000000, ...MEMBER });
  r.ok('member, very low: red', /bcn-pill--neg/.test(await pillClass(page)));
  await page.close();
  page = await open({ state: 'active', available_micros: 0, ...MEMBER });
  { const v = await pill(page); r.ok('member, out', v === 'AI credit: out', 'got ' + v); }
  await page.close();
  page = await open({ state: 'preview', available_micros: 0, ...MEMBER });
  { const v = await pill(page); r.ok('member, preview: nothing shown', v === null, 'got ' + v); }
  await page.close();

  page = await open({ state: 'unconfigured' });
  { const v = await pill(page); r.ok('not switched on: no pill', v === null, 'got ' + v); }
  script = [{ answer: 'Sales were $10.', ai_credit: { status: 'not_metered' } }];
  await ask(page, 'sales?');
  r.ok('an unmetered answer carries no cost line', (await page.locator('.ac-credit-note').count()) === 0);
  await page.close();

  page = await open('missing');
  { const v = await pill(page); r.ok('migration not applied: no pill', v === null, 'got ' + v); }
  await page.close();

  // An unreadable summary does not say who is asking, so the pill stays out
  // of a member's way; an owner who cannot see their balance is told so on
  // the Billing page.
  page = await open('error');
  { const v = await pill(page); r.ok('unreadable: nothing shown rather than a guessed balance', v === null, 'got ' + v); }
  await page.close();

  page = await open({ state: 'active', available_micros: null, ...OWNER });
  { const v = await pill(page); r.ok('never granted', v === 'AI credit: none yet', 'got ' + v); }
  script = [{ answer: 'Failed politely.', ai_credit: { status: 'free', charged_micros: 0 } }];
  await ask(page, 'x');
  r.ok('a free answer says No charge', /No charge/.test(await page.textContent('#log')));
  await page.close();

  page = await open({ state: 'preview', available_micros: 0, ...OWNER });
  { const v = await pill(page); r.ok('preview', v === 'AI credit: preview', 'got ' + v); }
  script = [{ answer: 'Sales were $10.', ai_credit: { status: 'preview', charged_micros: 420000 } }];
  await ask(page, 'sales?');
  r.ok('preview cost is labelled not deducted', /Preview: \$0\.42 \(not deducted\)/.test(await page.textContent('#log')));
  await page.close();

  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
