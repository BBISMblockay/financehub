/* queryWithRetry / makePacer: the Management API throttle handling.
 *
 * The second live run of the drift check lost 28 of 148 statements to HTTP
 * 429 and reported "could not run" -- a red run about the transport, not the
 * database. These pin the retry shape with a fake fetch and a fake clock.
 * No network. Run: node scripts/tests/management-api.test.mjs
 */
import { queryWithRetry, makePacer } from '../lib/management-api.mjs';

let failures = 0, count = 0;
async function test(name, fn) {
  count++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const eq = (a, e, what) => { if (a !== e) throw new Error(`${what}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what); };

const resp = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
function fakeFetch(sequence) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return sequence.shift() ?? resp(500, 'exhausted'); };
  return { fetch, calls };
}
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };
const base = { sleep, token: 'tok', ref: 'ref', query: 'select 1' };

console.log('\n-- queryWithRetry --');

await test('a 429 is retried and the eventual 200 is returned', async () => {
  sleeps.length = 0;
  const { fetch, calls } = fakeFetch([resp(429, '{"message":"ThrottlerException"}'), resp(200, '[{"a":1}]')]);
  const r = await queryWithRetry({ ...base, fetch });
  eq(calls.length, 2, 'fetch calls');
  eq(r.retries, 1, 'retries reported');
  eq(JSON.stringify(r.rows), '[{"a":1}]', 'rows');
});

await test('Retry-After is honoured, in seconds', async () => {
  sleeps.length = 0;
  const { fetch } = fakeFetch([resp(429, '', { 'retry-after': '7' }), resp(200, '[]')]);
  await queryWithRetry({ ...base, fetch });
  eq(sleeps[0], 7000, 'waited retry-after seconds');
});

await test('without Retry-After the backoff doubles', async () => {
  sleeps.length = 0;
  const { fetch } = fakeFetch([resp(429, ''), resp(429, ''), resp(429, ''), resp(200, '[]')]);
  await queryWithRetry({ ...base, fetch, baseBackoffMs: 1000 });
  eq(JSON.stringify(sleeps), '[1000,2000,4000]', 'backoff sequence');
});

await test('gives up after maxRetries and reports the 429 as an error', async () => {
  const { fetch, calls } = fakeFetch([resp(429, 'x'), resp(429, 'x'), resp(429, 'x')]);
  const r = await queryWithRetry({ ...base, fetch, maxRetries: 2, baseBackoffMs: 1 });
  eq(calls.length, 3, 'initial + 2 retries');
  ok(r.error?.startsWith('HTTP 429'), `error names the status: ${r.error}`);
  eq(r.retries, 2, 'retries reported');
});

await test('a non-429 failure is not retried', async () => {
  const { fetch, calls } = fakeFetch([resp(400, 'bad sql'), resp(200, '[]')]);
  const r = await queryWithRetry({ ...base, fetch });
  eq(calls.length, 1, 'one call');
  ok(r.error?.startsWith('HTTP 400'), 'error surfaced');
});

await test('the request body is { query } only -- no read_only flag', async () => {
  const { fetch, calls } = fakeFetch([resp(200, '[]')]);
  await queryWithRetry({ ...base, fetch });
  eq(calls[0].init.body, '{"query":"select 1"}', 'body');
});

console.log('\n-- makePacer --');

await test('calls closer than the gap wait for the remainder; spaced calls do not wait', async () => {
  let t = 1000;
  const waits = [];
  const pace = makePacer(500, async (ms) => { waits.push(ms); t += ms; }, () => t);
  await pace();            // first call: no wait
  t += 100; await pace();  // 100ms later: wait 400
  t += 900; await pace();  // 900ms later: no wait
  eq(JSON.stringify(waits), '[400]', 'waits');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
