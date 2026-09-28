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

// ---- deferred delivery (the mode the page asks for) ----
const RID = '11111111-2222-4333-8444-555555555555';
const asyncReq = (extra = {}) => new Request('https://x.test/', {
  method: 'POST', body: JSON.stringify({ request_id: RID, async: true, ...extra }),
});
function recorder() {
  const stored = [];
  let resolveStored;
  const done = new Promise((r) => { resolveStored = r; });
  return {
    stored, done,
    store: async (req, id, status, body) => { stored.push({ id, status, body }); resolveStored(); },
  };
}

await test('a slow deferred request answers 202 pending, then stores the finished response', async () => {
  const rec = recorder();
  const h = withKeepAlive(async (req) => { await req.json(); await sleep(40); return json({ answer: 'full', queries_run: [] }); },
    { firstByteMs: 10, storeResponse: rec.store });
  const res = await h(asyncReq());
  eq(res.status, 202, 'status');
  const body = await res.json();
  eq(body.pending, true, 'pending');
  eq(body.request_id, RID, 'request id echoed');
  await rec.done;
  eq(rec.stored.length, 1, 'stored once');
  eq(rec.stored[0].id, RID, 'stored under the request id');
  eq(rec.stored[0].status, 200, 'stored status');
  eq(rec.stored[0].body.answer, 'full', 'stored body');
});

await test('...and a stored error keeps its real status and flags', async () => {
  const rec = recorder();
  const h = withKeepAlive(async () => { await sleep(30); return json({ error: 'busy', provider_busy: true }, 503); },
    { firstByteMs: 5, storeResponse: rec.store });
  eq((await h(asyncReq())).status, 202, 'deferred');
  await rec.done;
  eq(rec.stored[0].status, 503, 'status');
  eq(rec.stored[0].body.provider_busy, true, 'flags kept');
});

await test('...and work that throws late is stored as a 500 the page can show', async () => {
  const rec = recorder();
  const h = withKeepAlive(async () => { await sleep(30); throw new Error('kaboom'); }, { firstByteMs: 5, storeResponse: rec.store });
  eq((await h(asyncReq())).status, 202, 'deferred');
  await rec.done;
  eq(rec.stored[0].status, 500, 'status');
  assert(rec.stored[0].body.error, 'no error message');
});

await test('a FAST deferred request is answered directly and NOT stored again', async () => {
  const rec = recorder();
  const h = withKeepAlive(async () => json({ error: 'switched', company_changed: true }, 409),
    { firstByteMs: 50, storeResponse: rec.store });
  const res = await h(asyncReq());
  eq(res.status, 409, 'direct status');
  await sleep(30);
  eq(rec.stored.length, 0, 'a directly-returned answer was stored too');
});

await test('the store is what is handed to waitUntil, so the worker outlives the delivery', async () => {
  const rec = recorder();
  const seen = [];
  const h = withKeepAlive(async () => { await sleep(30); return json({ answer: 'x' }); },
    { firstByteMs: 5, storeResponse: rec.store, waitUntil: (p) => seen.push(p) });
  await h(asyncReq());
  eq(seen.length, 1, 'waitUntil calls');
  await seen[0];
  eq(rec.stored.length, 1, 'awaiting the waitUntil promise did not include the store');
});

await test('no async flag, or no valid request id: the older heartbeat stream, nothing stored', async () => {
  for (const req of [
    new Request('https://x.test/', { method: 'POST', body: JSON.stringify({ request_id: RID }) }),
    asyncReq({ request_id: 'not-a-uuid' }),
  ]) {
    const rec = recorder();
    const h = withKeepAlive(async () => { await sleep(30); return json({ answer: 'y' }); },
      { firstByteMs: 5, heartbeatMs: 5, storeResponse: rec.store });
    const res = await h(req);
    eq(res.status, 200, 'streamed');
    eq(JSON.parse(await res.text()).answer, 'y', 'answer');
    eq(rec.stored.length, 0, 'stored without being asked to defer');
  }
});

await test('a store that fails does not break anything', async () => {
  const h = withKeepAlive(async () => { await sleep(20); return json({ answer: 'z' }); },
    { firstByteMs: 5, storeResponse: async () => { throw new Error('insert refused'); } });
  eq((await h(asyncReq())).status, 202, 'deferred');
  await sleep(40);
});

await test('the handler still reads the body the deferral check peeked at', async () => {
  const rec = recorder();
  const h = withKeepAlive(async (req) => { const b = await req.json(); await sleep(20); return json({ answer: b.request_id }); },
    { firstByteMs: 5, storeResponse: rec.store });
  await h(asyncReq());
  await rec.done;
  eq(rec.stored[0].body.answer, RID, 'body was consumed by the check');
});

console.log(`keepalive: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
