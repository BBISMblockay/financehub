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
  // Secure context: the page mints request ids with crypto.randomUUID, which
  // plain http withholds, and deferred delivery is matched by that id.
  const suite = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });

  // Every POST to the chat function, in order, as the page sent it.
  const sent = [];
  // Scripted replies, one per call: 'unverified' = the 503 the server returns
  // when it cannot confirm which company the question belongs to.
  let script = [];
  // Deferred answers the route has promised; the test delivers them.
  const pendingDeliveries = [];

  await suite.context.route('**/functions/v1/silo-chat', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    sent.push(body);
    const next = script.shift() || { answer: 'OK.' };
    // Deferred delivery (what the page asks for now): 202 pending, and the
    // finished response is dropped into silo_chat_responses a moment later by
    // the test itself, playing the server.
    if (next && next.deferred) {
      pendingDeliveries.push({ request_id: body.request_id, ...next.deferred });
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ pending: true, request_id: body.request_id }),
      });
    }
    // A long answer as keepalive-lib.mjs sends it: status committed at 200,
    // heartbeat whitespace first, the REAL status inside the body.
    if (next && next.streamed) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '     ' + JSON.stringify({ ...next.streamed }),
      });
    }
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

  // ── 3b. a long answer streamed past the gateway (keepalive-lib.mjs) ──
  script = [{ streamed: { answer: 'Channel split: online $6.1M.', http_status: 200 } }];
  await ask('executive summary of the business?');
  r.ok('a streamed answer (leading heartbeat whitespace) is rendered',
    /Channel split: online \$6\.1M/.test(await page.textContent('#log')));

  // The real status must be read from the BODY. A 503 "couldn't confirm which
  // company" offers Try again because of its STATUS (the page keys the retry
  // on it); the body deliberately carries no `retryable` flag here, so if the
  // status were read from the 200 the stream committed, no retry would show.
  script = [{ streamed: {
    error: "Couldn't confirm which company this question belongs to, so it wasn't run.",
    company_unverified: true, http_status: 503,
  } }];
  const retriesBefore = await page.locator('#log .ac-retry-btn:not([disabled])').count();
  await ask('and returns?');
  r.ok('a streamed 503 is shown', /couldn.t confirm which company/i.test(await page.textContent('#log')));
  r.test('...and handled as a 503 from its body: Try again is offered', async () =>
    r.eq(await page.locator('#log .ac-retry-btn:not([disabled])').count(), retriesBefore + 1));
  script = [{ answer: 'Returns were 4%.' }];
  await page.click('#log .ac-retry-btn:not([disabled])');
  await page.waitForTimeout(900);
  r.ok('the retry answers it', /Returns were 4%/.test(await page.textContent('#log')));

  // ── 3c. a deferred answer: "pending" now, collected from the table later ──
  const deliver = async () => {
    const d = pendingDeliveries.shift();
    await page.evaluate((row) => {
      const t = window.__FIXTURE_TABLES__;
      (t.silo_chat_responses = t.silo_chat_responses || []).push(row);
    }, { request_id: d.request_id, http_status: d.http_status, response: d.response });
  };
  script = [{ deferred: { http_status: 200, response: { answer: 'Deferred: online $6.1M, retail $2.6M.', queries_run: [] } } }];
  await ask('full executive summary?');
  r.ok('the page asked for deferred delivery', sent[sent.length - 1].async === true);
  r.ok('nothing is shown while the answer is pending',
    !/Deferred: online/.test(await page.textContent('#log')));
  await deliver();
  await page.waitForTimeout(2600);
  r.ok('the collected answer is rendered', /Deferred: online \$6\.1M/.test(await page.textContent('#log')));

  script = [{ deferred: { http_status: 503, response: {
    error: "Couldn't confirm which company this question belongs to, so it wasn't run.",
    company_unverified: true,
  } } }];
  const retriesBeforeDeferred = await page.locator('#log .ac-retry-btn:not([disabled])').count();
  await ask('and inventory?');
  await deliver();
  await page.waitForTimeout(2600);
  r.test('a collected 503 is handled by its stored status: Try again is offered', async () =>
    r.eq(await page.locator('#log .ac-retry-btn:not([disabled])').count(), retriesBeforeDeferred + 1));
  script = [{ answer: 'Inventory is fine.' }];
  await page.click('#log .ac-retry-btn:not([disabled])');
  await page.waitForTimeout(900);

  // ── 4. a question arriving by link (SEO Studio) is placed, never sent ──
  const before = sent.length;
  const linked = await suite.open('/v2/silo-chat.html?q=' + encodeURIComponent('Draft SEO improvements for /collections/backpacks'), {}, {
    ready: () => !!document.getElementById('input') && document.getElementById('input').value.length > 0,
  });
  await linked.waitForTimeout(600);
  const linkedValue = await linked.inputValue('#input');
  r.test('the linked question fills the composer', () =>
    r.eq(linkedValue, 'Draft SEO improvements for /collections/backpacks'));
  r.ok('nothing is sent until the person presses send', sent.length === before);
  r.ok('the question is taken out of the address bar, so a reload does not refill it',
    !(await linked.evaluate(() => location.search)).includes('q='));
  await linked.close();

  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
