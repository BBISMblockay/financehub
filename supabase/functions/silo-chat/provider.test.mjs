/* Provider pushback: when a model call is retried, and what is recorded.
 *
 * Pure decisions, no network. The handler-level behaviour (a 429 retried then
 * answered, a persistent 429 reported as busy) is in handler.test.mjs.
 *
 * Run: node supabase/functions/silo-chat/provider.test.mjs
 */
import {
  retryDecision, parseRetryAfter, pickUsage, sumUsage,
  RETRYABLE_STATUSES, BUSY_STATUSES, MAX_PROVIDER_RETRIES, MAX_RETRY_WAIT_MS, RETRY_HEADROOM_MS,
} from './provider-lib.mjs';

let failures = 0;
let run = 0;
function test(name, fn) {
  run++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const NOW = 1_000_000;
const noJitter = () => 0;

console.log('\n-- which failures are retried --');

test('rate limited, overloaded, 5xx and a dropped connection are retried', () => {
  for (const status of [0, 429, 500, 502, 503, 504, 529]) {
    eq(retryDecision({ status, attempt: 0, now: NOW, jitter: noJitter }).retry, true, `status ${status}`);
  }
});
test('a request the API rejected is never retried', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    eq(retryDecision({ status, attempt: 0, now: NOW }), { retry: false, waitMs: 0, reason: 'not_retryable' }, `status ${status}`);
  }
});
test('busy is 429 and 529 only -- a 5xx is broken, not busy', () => {
  eq([...BUSY_STATUSES].sort(), [429, 529], 'busy statuses');
  for (const s of BUSY_STATUSES) assert(RETRYABLE_STATUSES.has(s), `${s} is busy but not retryable`);
});
test(`at most ${MAX_PROVIDER_RETRIES} retries per call`, () => {
  eq(retryDecision({ status: 429, attempt: MAX_PROVIDER_RETRIES - 1, now: NOW, jitter: noJitter }).retry, true, 'last allowed');
  eq(retryDecision({ status: 429, attempt: MAX_PROVIDER_RETRIES, now: NOW }).reason, 'retries_exhausted', 'one too many');
});

console.log('\n-- how long it waits --');

test('the provider\'s retry-after is honoured, in seconds or as a date', () => {
  eq(retryDecision({ status: 429, retryAfter: '4', attempt: 0, now: NOW }).waitMs, 4000, 'seconds');
  eq(parseRetryAfter('2.5'), 2500, 'fractional seconds');
  eq(parseRetryAfter(new Date(NOW + 7000).toUTCString(), NOW), 7000, 'http date');
  eq(parseRetryAfter(''), null, 'empty');
  eq(parseRetryAfter('soon'), null, 'garbage');
});
test('without retry-after it backs off 1s then 3s, plus jitter', () => {
  eq(retryDecision({ status: 529, attempt: 0, now: NOW, jitter: noJitter }).waitMs, 1000, 'first');
  eq(retryDecision({ status: 529, attempt: 1, now: NOW, jitter: noJitter }).waitMs, 3000, 'second');
  eq(retryDecision({ status: 529, attempt: 0, now: NOW, jitter: () => 200 }).waitMs, 1200, 'jitter added');
});
test('a provider asking for a long wait is not waited on inside a request', () => {
  eq(retryDecision({ status: 429, retryAfter: String(MAX_RETRY_WAIT_MS / 1000 + 1), attempt: 0, now: NOW }).reason,
    'retry_after_too_long', 'long retry-after');
});

console.log('\n-- it never spends the time the request needs to answer --');

test('a retry that would land past the cap is refused', () => {
  const capAt = NOW + 1000 + RETRY_HEADROOM_MS - 1;
  eq(retryDecision({ status: 429, attempt: 0, now: NOW, capAt, jitter: noJitter }).reason, 'no_time_left', 'just past');
  eq(retryDecision({ status: 429, attempt: 0, now: NOW, capAt: capAt + 1, jitter: noJitter }).retry, true, 'just fits');
});
test('no cap means no time limit on the decision', () => {
  eq(retryDecision({ status: 429, attempt: 0, now: NOW, capAt: 0, jitter: noJitter }).retry, true, 'uncapped');
});

console.log('\n-- usage is recorded as measured, never estimated --');

test('the four usage fields are kept; absent ones stay null', () => {
  eq(pickUsage({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 }),
    { input: 120, output: 30, cache_read: 6000, cache_write: 0 }, 'full');
  eq(pickUsage({ input_tokens: 5 }), { input: 5, output: null, cache_read: null, cache_write: null }, 'partial');
  eq(pickUsage(undefined), null, 'missing usage');
});
test('totals sum what was reported and leave never-reported fields null', () => {
  eq(sumUsage([{ input: 1, output: 2, cache_read: null, cache_write: 3 }, null, { input: 4, output: 5, cache_read: null, cache_write: 0 }]),
    { input: 5, output: 7, cache_read: null, cache_write: 3 }, 'totals');
  eq(sumUsage([]), { input: null, output: null, cache_read: null, cache_write: null }, 'empty');
});

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
