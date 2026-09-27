/* Provider pushback: when a model call is retried, and what is recorded.
 *
 * Pure decisions, no network. The handler-level behaviour (a 429 retried then
 * answered, a persistent 429 reported as busy) is in handler.test.mjs.
 *
 * Run: node supabase/functions/silo-chat/provider.test.mjs
 */
import {
  retryDecision, parseRetryAfter, pickUsage, sumUsage, providerErrorCode, isSpendLimit, isSpendLimitResponse,
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

console.log('\n-- a spend cap is not "busy" --');

const SPEND_BODY = '{"type":"error","error":{"type":"rate_limit_error","message":"x","details":{"error_code":"enforced_spend_limit_reached"}}}';
test('the error code is read from details first, then the error type', () => {
  eq(providerErrorCode(SPEND_BODY), 'enforced_spend_limit_reached', 'details.error_code');
  eq(providerErrorCode('{"type":"error","error":{"type":"overloaded_error"}}'), 'overloaded_error', 'type');
  eq(providerErrorCode('not json'), null, 'non-JSON');
  eq(providerErrorCode(''), null, 'empty');
});
test('a spend-capped 429 is never retried, even with time and attempts left', () => {
  const code = providerErrorCode(SPEND_BODY);
  eq(isSpendLimit(code), true, 'recognised');
  const d = retryDecision({ status: 429, errorCode: code, attempt: 0, now: NOW, capAt: 0, jitter: noJitter });
  eq(d.retry, false, 'retried');
  eq(d.reason, 'spend_limit', 'reason');
});
const ORG_LIMIT = '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}';
const WS_LIMIT = '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}';
test('a configured organisation or workspace spend limit (400) is a spend limit', () => {
  eq(isSpendLimitResponse(400, ORG_LIMIT), true, 'organisation limit');
  eq(isSpendLimitResponse(400, WS_LIMIT), true, 'workspace limit');
  eq(isSpendLimitResponse(429, SPEND_BODY), true, 'usage-tier cap');
});
test('an ordinary 400 or rate limit is not a spend limit', () => {
  eq(isSpendLimitResponse(400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}'), false, 'bad request');
  eq(isSpendLimitResponse(400, 'bad request'), false, 'non-JSON 400');
  eq(isSpendLimitResponse(429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), false, 'rate limit');
  eq(isSpendLimitResponse(500, ORG_LIMIT), false, 'the prefix only counts on a 400');
});
test('an ordinary rate-limit 429 still retries', () => {
  eq(retryDecision({ status: 429, errorCode: 'rate_limit_error', attempt: 0, now: NOW, jitter: noJitter }).retry, true, 'rate limit');
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
