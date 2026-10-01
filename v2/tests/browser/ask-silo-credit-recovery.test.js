/* Ask SILO: a recovered answer still says what it cost.
 *
 * When the connection drops mid-answer, or the answer arrives deferred (202
 * pending, collected from silo_chat_responses), the page must render the
 * stored response's ai_credit exactly as a direct answer does and refetch the
 * balance. Asserted on the real page, with the edge function stubbed at the
 * network boundary and the database played by fixture tables:
 *   - a dropped connection whose finished response is in silo_chat_responses
 *     shows "$0.42 AI credit" and the pill moves to the new balance
 *   - the deferred (202 -> poll) path does the same
 *   - with no stored response, the audit-log fallback still recovers the
 *     answer and shows NO cost line (never an invented $0)
 */
'use strict';
const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('ask-silo-credit-recovery');

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });
  let page = null;
  let script = [];
  // What the "server" does with a request: drop the connection after writing
  // the stored response (and settling the charge), answer 202 pending, or
  // drop it after writing only the audit row.
  await suite.context.route('**/functions/v1/silo-chat', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const next = script.shift() || { answer: 'OK.' };
    if (next.drop || next.deferred) {
      await page.evaluate(({ rid, next }) => {
        const t = window.__FIXTURE_TABLES__;
        if (next.stored) {
          (t.silo_chat_responses = t.silo_chat_responses || []).push({ request_id: rid, http_status: 200, response: next.stored });
        }
        if (next.audit) {
          (t.silo_chat_audit_log = t.silo_chat_audit_log || []).push({ request_id: rid, status: 'ok', created_at: new Date().toISOString(), ...next.audit });
        }
        if (next.balance != null) {
          const b = next.balance;
          window.__FIXTURE_RPC__.ai_credit_summary = () => ({ state: 'active', available_micros: b, included_micros: 0, purchased_micros: b, pending_micros: 0 });
        }
      }, { rid: body.request_id, next: next.drop || next.deferred });
      if (next.drop) return route.abort('connectionreset');
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ pending: true, request_id: body.request_id }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(next) });
  });

  page = await suite.open('/v2/silo-chat.html', {}, {
    rpc: { ai_credit_summary: () => ({ state: 'active', available_micros: 64800000, included_micros: 14800000, purchased_micros: 50000000, pending_micros: 0 }) },
    ready: () => !!document.getElementById('input'),
  });
  const pill = () => page.evaluate(() => { const p = document.getElementById('creditPill'); return p.hidden ? null : p.textContent; });
  const summaryCalls = () => page.evaluate(() => window.__QUERIES__.filter((q) => q.table === 'rpc:ai_credit_summary').length);
  const lastAssistant = () => page.evaluate(() => {
    const m = [...document.querySelectorAll('#log .ac-msg--assistant')].pop();
    return m ? m.textContent : '';
  });
  const ask = async (text, waitMs) => {
    await page.fill('#input', text);
    await page.click('#btnSend');
    await page.waitForTimeout(waitMs);
  };

  await page.waitForTimeout(300);
  r.ok('starting balance', (await pill()) === 'AI credit $64.80', 'got ' + (await pill()));

  // 1. Connection dropped; the finished, charged response was stored.
  let calls = await summaryCalls();
  script = [{ drop: {
    stored: { answer: 'Recovered: sales were $10.', queries_run: ['select 1'], ai_credit: { status: 'charged', charged_micros: 420000 } },
    audit: { answer: 'Recovered: sales were $10.', queries_run: ['select 1'] },
    balance: 64380000,
  } }];
  await ask('sales last week?', 1500);
  let msg = await lastAssistant();
  r.ok('the dropped answer is recovered', /Recovered: sales were \$10\./.test(msg), msg);
  r.ok('...with its cost line', /\$0\.42 AI credit/.test(msg), msg);
  r.ok('the balance is refetched', (await summaryCalls()) > calls);
  r.ok('...and the pill shows the new balance', (await pill()) === 'AI credit $64.38', 'got ' + (await pill()));
  r.ok('the cost is kept in the conversation history', await page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const v = sessionStorage.getItem(sessionStorage.key(i)) || '';
      if (/Recovered: sales were/.test(v) && /"charged_micros":420000/.test(v)) return true;
    }
    return false;
  }));

  // 2. Deferred: 202 pending, the charged response collected by polling.
  calls = await summaryCalls();
  script = [{ deferred: {
    stored: { answer: 'Deferred: online $6.1M.', queries_run: [], ai_credit: { status: 'charged', charged_micros: 1250000 } },
    balance: 63130000,
  } }];
  await ask('full executive summary?', 3200);
  msg = await lastAssistant();
  r.ok('the deferred answer is rendered', /Deferred: online \$6\.1M\./.test(msg), msg);
  r.ok('...with its cost line', /\$1\.25 AI credit/.test(msg), msg);
  r.ok('...and the pill refreshes', (await summaryCalls()) > calls && (await pill()) === 'AI credit $63.13', 'got ' + (await pill()));

  // 3. No stored response: the audit log still recovers it, with no cost.
  calls = await summaryCalls();
  script = [{ drop: { audit: { answer: 'Audit-only: returns were 4%.', queries_run: ['select 2'] } } }];
  await ask('returns?', 1500);
  msg = await lastAssistant();
  r.ok('the audit-log fallback still recovers the answer', /Audit-only: returns were 4%\./.test(msg), msg);
  r.ok('...and shows no cost line, never an invented $0', !/AI credit|No charge/.test(msg), msg);
  r.ok('...while still refetching the balance', (await summaryCalls()) > calls);

  await page.close();
  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
