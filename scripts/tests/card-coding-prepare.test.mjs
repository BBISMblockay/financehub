// The scheduled preparation runner: how it walks imports, when it stops, and
// what it refuses to believe. No network; a scripted endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCodingPreparation, MAX_REPEATS_PER_IMPORT } from '../card-coding-prepare.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const unit = (batch, over = {}) => ({ done: false, batch_id: batch, ok: true, status: 200, run_id: null, run_status: 'completed',
  suggested: 1, needs_judgment: 0, failed: 0, in_progress: 0, asked: 1, remaining: 0, ...over });
function endpoint(script) {
  const calls = [], tokens = [];
  let i = 0;
  return {
    calls, tokens,
    getToken: async (audience) => { tokens.push(audience); return `token-${tokens.length}`; },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), token: init.headers['x-silo-scheduler-token'], body: JSON.parse(init.body) });
      const next = script[i++] ?? { done: true };
      if (next instanceof Error) throw next;
      return { ok: next.httpStatus ? next.httpStatus < 400 : true, status: next.httpStatus || 200, json: async () => next };
    },
  };
}
const run = (e, extra = {}) => runCodingPreparation({ url: 'https://synthetic.supabase.co', trigger: 'background', getToken: e.getToken, fetchImpl: e.fetchImpl, ...extra });

test('stays on an import while it makes progress, then moves past it by cursor', async () => {
  const e = endpoint([unit(id(1), { remaining: 5 }), unit(id(1), { remaining: 0 }), unit(id(2)), { done: true }]);
  const result = await run(e);
  assert.deepEqual(e.calls.map((c) => c.body), [
    { after: null, batch: null, trigger: 'background' },
    { after: null, batch: id(1), trigger: 'background' },
    { after: id(1), batch: null, trigger: 'background' },
    { after: id(2), batch: null, trigger: 'background' },
  ]);
  assert.equal(result.imports, 2); assert.equal(result.suggested, 3); assert.equal(result.failed, 0);
  assert.match(e.calls[0].url, /\/functions\/v1\/card-coding-prepare-scheduled$/);
});

test('an import that prepares nothing is left behind rather than asked again', async () => {
  // Remaining rows that are claimed elsewhere or backing off: asking again
  // would spin, so the runner moves on and the next run comes back.
  const e = endpoint([unit(id(1), { suggested: 0, in_progress: 4, remaining: 4 }), { done: true }]);
  await run(e);
  assert.deepEqual(e.calls[1].body, { after: id(1), batch: null, trigger: 'background' });
});

test('repeats on one import are capped, and so is the whole run', async () => {
  // The first call plus MAX_REPEATS_PER_IMPORT repeats, then the runner must move on.
  const many = Array.from({ length: MAX_REPEATS_PER_IMPORT + 1 }, () => unit(id(1), { remaining: 100 }));
  const e = endpoint([...many, { done: true }]);
  await run(e);
  const onFirst = e.calls.filter((c) => c.body.batch === id(1)).length;
  assert.equal(onFirst, MAX_REPEATS_PER_IMPORT);
  const capped = endpoint(Array.from({ length: 50 }, (_, n) => unit(id(n + 1))));
  const result = await run(capped, { maxCalls: 5 });
  assert.equal(capped.calls.length, 5); assert.equal(result.stopped, 'call_limit');
});

test('every call carries a fresh identity token for that endpoint', async () => {
  const e = endpoint([unit(id(1)), unit(id(2)), { done: true }]);
  await run(e);
  assert.deepEqual(e.calls.map((c) => c.token), ['token-1', 'token-2', 'token-3']);
  assert.ok(e.tokens.every((aud) => aud === 'https://synthetic.supabase.co/functions/v1/card-coding-prepare-scheduled'));
});

test('failures are counted, rejections name only safe codes, and nonsense is refused', async () => {
  const e = endpoint([unit(id(1), { ok: false, error_code: 'preparation_failed', run_status: 'failed', suggested: 0, failed: 1 }), { done: true }]);
  const result = await run(e);
  assert.equal(result.failed, 1); assert.equal(result.failures_recorded, 1);
  await assert.rejects(run(endpoint([{ httpStatus: 403, error_code: 'background_preparation_disabled' }])), /\(403\): background_preparation_disabled/);
  await assert.rejects(run(endpoint([{ httpStatus: 500, error_code: 'secret sk-live-leak' }])), /\(500\): request_failed$/);
  await assert.rejects(run(endpoint([{ done: false, batch_id: 'nope' }])), /Invalid scheduled preparation response/);
  await assert.rejects(run(endpoint([unit(id(2)), unit(id(1))])), /Invalid scheduled preparation response/, 'a cursor that goes backwards');
  await assert.rejects(run(endpoint([new Error('socket hang up')])), /resumes from saved suggestions/);
  await assert.rejects(runCodingPreparation({ url: 'https://x.test', trigger: 'manual' }), /background or nightly/);
  await assert.rejects(runCodingPreparation({ url: 'http://x.test', trigger: 'nightly' }), /Invalid Supabase URL/);
});
