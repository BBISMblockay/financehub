/* keepalive-lib.mjs assertions. Pure: real timers at millisecond scale, no
 * network, no model.
 *
 * Run: node supabase/functions/silo-chat/keepalive.test.mjs
 */
import { withKeepAlive, finalBody } from './keepalive-lib.mjs';

let failed = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { failed++; console.error(`FAIL ${name}\n  ${err.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const REQ = new Request('https://x.test/', { method: 'POST' });

await test('a fast answer is returned untouched, status and all', async () => {
  const h = withKeepAlive(async () => json({ error: 'switched company', company_changed: true }, 409), { firstByteMs: 50 });
  const res = await h(REQ);
  eq(res.status, 409, 'status');
  const body = await res.json();
  eq(body.company_changed, true, 'body');
  assert(!('http_status' in body), 'a fast response was rewritten');
});

await test('a slow answer is streamed as 200 with the real status in the body', async () => {
  const h = withKeepAlive(async () => { await sleep(60); return json({ error: 'busy', provider_busy: true }, 503); },
    { firstByteMs: 10, heartbeatMs: 15 });
  const res = await h(REQ);
  eq(res.status, 200, 'committed status');
  const text = await res.text();
  assert(/^\s+\{/.test(text), `expected leading heartbeat whitespace, got ${JSON.stringify(text.slice(0, 20))}`);
  const body = JSON.parse(text);
  eq(body.http_status, 503, 'real status carried in the body');
  eq(body.provider_busy, true, 'original body kept');
});

await test('heartbeats keep arriving while the work runs', async () => {
  const h = withKeepAlive(async () => { await sleep(80); return json({ answer: 'done' }); },
    { firstByteMs: 5, heartbeatMs: 10 });
  const text = await (await h(REQ)).text();
  const spaces = text.length - text.trimStart().length;
  assert(spaces >= 4, `only ${spaces} heartbeat byte(s) over ~75ms at 10ms intervals`);
  eq(JSON.parse(text).answer, 'done', 'answer');
  eq(JSON.parse(text).http_status, 200, 'status');
});

await test('a slow success parses with res.json() exactly like before', async () => {
  const h = withKeepAlive(async () => { await sleep(30); return json({ answer: 'ok', queries_run: ['select 1'] }); },
    { firstByteMs: 5, heartbeatMs: 5 });
  const body = await (await h(REQ)).json();
  eq(body.answer, 'ok', 'answer');
  eq(body.queries_run.length, 1, 'queries_run');
});

await test('work that throws after streaming began still ends in valid JSON with a 500', async () => {
  const h = withKeepAlive(async () => { await sleep(30); throw new Error('kaboom'); }, { firstByteMs: 5, heartbeatMs: 5 });
  const body = await (await h(REQ)).json();
  eq(body.http_status, 500, 'status');
  assert(body.error, 'no error message');
});

await test('work that throws before the first byte is rethrown, as before', async () => {
  const h = withKeepAlive(async () => { throw new Error('early'); }, { firstByteMs: 50 });
  let threw = false;
  try { await h(REQ); } catch (e) { threw = e.message === 'early'; }
  assert(threw, 'an early throw was swallowed');
});

await test('the work is handed to waitUntil so the worker outlives a dropped connection', async () => {
  const seen = [];
  const h = withKeepAlive(async () => json({ answer: 'x' }), { firstByteMs: 50, waitUntil: (p) => seen.push(p) });
  await h(REQ);
  eq(seen.length, 1, 'waitUntil calls');
  assert(typeof seen[0].then === 'function', 'not a promise');
});

await test('finalBody wraps a non-JSON body instead of breaking the page', async () => {
  const body = JSON.parse(finalBody('<html>gateway</html>', 502));
  eq(body.http_status, 502, 'status');
  assert(/gateway/.test(body.error), 'text lost');
  eq(JSON.parse(finalBody('[1,2]', 200)).http_status, 200, 'array body');
});

console.log(`keepalive: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
