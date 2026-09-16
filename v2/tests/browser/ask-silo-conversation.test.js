/* What Ask SILO actually SENDS as the conversation.
 *
 * The chat page keeps `history` in memory and posts it whole on every turn, so
 * a bug here is not a rendering bug: it changes the question the model is
 * asked. Two ways that has gone wrong, both fixed on PR #712 and both asserted
 * against the real page here rather than against the helper that does it:
 *
 *   1. A question that failed with NO answer stays in `history` on purpose, so
 *      "Try again" can resend it. If the user gives up and types something
 *      ELSE, that abandoned turn used to ride along -- two consecutive user
 *      turns in one request, which Ask SILO can answer, or blend into the
 *      answer to the new one. (Cycle-2 review finding, P2.)
 *   2. Retry must resend the SAME question, so the fix for (1) must not make
 *      the retry button send nothing or send the wrong turn.
 *
 * The edge function is stubbed at the network boundary and every posted body
 * recorded, so the assertions are about the request that would really go out.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('ask-silo-conversation');

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 900 } });

  // Every POST to the chat function, in order, as the page sent it.
  const sent = [];
  // Scripted replies, one per call: 'unverified' = the 503 the server returns
  // when it cannot confirm which company the question belongs to.
  let script = [];

  await suite.context.route('**/functions/v1/silo-chat', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    sent.push(body);
    const next = script.shift() || { answer: 'OK.' };
    if (next === 'unverified') {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: "Couldn't confirm which company this question belongs to, so it wasn't run.",
          company_unverified: true,
          retryable: true,
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(next) });
  });

  const page = await suite.open('/v2/silo-chat.html', {}, {
    ready: () => !!document.getElementById('input'),
  });

  const ask = async (text) => {
    await page.fill('#input', text);
    await page.click('#btnSend');
    await page.waitForTimeout(500);
  };
  const userTurns = (body) => (body.history || []).filter((m) => m.role === 'user').map((m) => m.content);

  // ── 1. an abandoned question does not ride along on the next one ──
  script = ['unverified'];
  await ask('sales last week?');
  r.ok('the failed question was sent once', sent.length === 1);
  r.ok('the error is shown rather than an answer',
    /couldn.t confirm which company/i.test(await page.textContent('#log')));

  script = [{ answer: 'Inventory exposure is $412,500.' }];
  await ask('inventory exposure?');
  r.ok('a second request went out', sent.length === 2);
  r.test('only the new question is sent, not the abandoned one',
    () => r.eq(userTurns(sent[1]), ['inventory exposure?']));

  // ── 2. retry still resends the question it belongs to ──
  script = ['unverified'];
  await ask('what did MLB do in September?');
  r.ok('the third request carried only that question',
    JSON.stringify(userTurns(sent[2])).includes('MLB'));

  script = [{ answer: 'MLB did $55,463.' }];
  await page.click('#log .ac-retry-btn:not([disabled])');
  await page.waitForTimeout(900);
  r.ok('retry sent a fourth request', sent.length === 4);
  r.test('retry resends the same question, and only it',
    () => r.eq(userTurns(sent[3]), ['inventory exposure?', 'what did MLB do in September?']));
  r.ok('the answer is rendered', /55,463/.test(await page.textContent('#log')));

  // ── 3. the abandoned turn's retry button cannot resend the new question ──
  script = ['unverified'];
  await ask('returns by reason?');
  script = [{ answer: 'Top sellers are...' }];
  await ask('top sellers?');
  const liveRetries = await page.locator('#log .ac-retry-btn:not([disabled])').count();
  r.test('the abandoned question\'s retry button is disabled once it is abandoned',
    () => r.eq(liveRetries, 0));

  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
