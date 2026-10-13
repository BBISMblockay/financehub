// scripts/tests/integration-bootstrap-runner.test.mjs -- what running one
// first-connect bootstrap job does to its queue row.
//
// These are the cases that are unreachable through the real script without a
// Shopify store and a twenty-minute wait, and each one is a way this feature
// could quietly cost somebody money or data:
//
//   * a job for a connection that had ALREADY synced must not re-import 60
//     days of orders -- the Integrations page's Test button is the same
//     button on a store connected last year;
//   * a job somebody CANCELS from the page while a stage is running must stay
//     cancelled: the drainer's own terminal write must not resurrect it;
//   * a resumed job must run only what it still owes;
//   * a failed stage must not stop the stages after it, and must leave the
//     row retryable until the attempt cap;
//   * a deleted or switched-off connection is a cancelled job, not an error
//     retried every fifteen minutes.
//
// The runner takes its database and its stage launcher as arguments, so all
// of that is driven here with a fake of each. The fake db is deliberately
// literal about the PostgREST builder: a filter the runner forgets to apply
// (the `status = 'running'` guard, say) shows up as a missing filter in the
// recorded call, which is what the cancellation test asserts on.

import assert from 'node:assert/strict';
import { createRunner } from '../lib/integration-bootstrap-runner.mjs';

let count = 0;
let failures = 0;
async function test(name, fn) {
  count++;
  try { await fn(); console.log(`  ok   ${name}`); } catch (err) {
    failures++; console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

/** A fake of the slice of the Supabase client the runner uses.
 *
 * `rows` seeds the tables it reads. `writes` records every update, with the
 * filters it carried -- the guard that keeps a cancelled job cancelled is a
 * filter, so it can only be asserted by looking at them.
 */
function fakeDb({ connection = { id: 'conn-1', is_active: true }, priorSyncJobs = [], jobRow = null } = {}) {
  const writes = [];
  const reads = [];
  const builder = (table, op, payload) => {
    const filters = {};
    const self = {
      select() { return self; },
      eq(col, val) { (filters[col] = filters[col] || []).push(val); return self; },
      neq(col, val) { filters[`not.${col}`] = val; return self; },
      lt(col, val) { filters[`lt.${col}`] = val; return self; },
      limit() { return self; },
      maybeSingle() { return self.then(); },
      then(resolve, reject) {
        const out = (() => {
          if (op === 'update') {
            writes.push({ table, patch: payload, filters });
            // The real policy-free service-role update returns no error and
            // the runner does not read row counts, so neither does this.
            return { data: null, error: null };
          }
          reads.push({ table, filters });
          if (table === 'sync_jobs') return { data: priorSyncJobs, error: null };
          if (table === 'integration_bootstrap_jobs') return { data: jobRow, error: null };
          return { data: connection, error: null };
        })();
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return self;
  };
  return {
    writes,
    reads,
    from(table) {
      return {
        select: (...a) => builder(table, 'select', a),
        update: (patch) => builder(table, 'update', patch),
      };
    },
  };
}

const silent = { log() {}, error() {} };
const job = (over = {}) => ({
  id: 'job-1',
  integration: 'shopify',
  company_entity_id: 'co-1',
  connection_id: 'conn-1',
  status: 'running',
  stages: {},
  attempts: 1,
  created_at: '2026-10-13T06:00:00.000Z',
  ...over,
});

// ── A connection that has already synced is not a first connect ───────────

await test('a job for a connection with earlier sync history is cancelled, not run', async () => {
  const db = fakeDb({ priorSyncJobs: [{ id: 'sj-1' }] });
  const ran = [];
  const { runJob } = createRunner({ db, runStage: async (s) => { ran.push(s.stage); return { ok: true }; }, log: silent });
  const res = await runJob(job());
  assert.equal(res.status, 'cancelled');
  assert.deepEqual(ran, [], 'no stage may run: this would be a second paid import');
  const last = db.writes.at(-1);
  assert.equal(last.patch.status, 'cancelled');
  assert.match(last.patch.last_error, /already synced/);
});

await test('the history check ignores test_connection rows and anything queued after the job', async () => {
  const db = fakeDb({ priorSyncJobs: [] });
  const { runJob } = createRunner({ db, runStage: async () => ({ ok: true }), log: silent });
  await runJob(job());
  const read = db.reads.find((r) => r.table === 'sync_jobs');
  assert.ok(read, 'the runner must actually look for prior sync history');
  // A connection whose only sync_jobs row is the connection test has never
  // synced, and a resumed job writes sync_jobs rows of its own -- counting
  // either would cancel every job on its second attempt.
  assert.equal(read.filters['not.job_type'], 'test_connection');
  assert.equal(read.filters['lt.created_at'], '2026-10-13T06:00:00.000Z');
});

await test('redo has no connection_id, so the history check is skipped rather than matching every row', async () => {
  const db = fakeDb({ connection: { id: 'r-1', is_active: true, api_secret: 'tok' } });
  const { runJob } = createRunner({ db, runStage: async () => ({ ok: true }), log: silent });
  await runJob(job({ integration: 'redo', connection_id: null }));
  assert.equal(db.reads.filter((r) => r.table === 'sync_jobs').length, 0);
});

// ── A job cancelled from the page while a stage runs stays cancelled ───────

await test('every terminal write is guarded on the row still being running', async () => {
  const db = fakeDb();
  const { runJob } = createRunner({ db, runStage: async () => ({ ok: true }), log: silent });
  await runJob(job());
  const terminal = db.writes.filter((w) => w.patch.status && w.patch.status !== 'running');
  assert.ok(terminal.length, 'the job must end with a status write');
  for (const w of terminal) {
    assert.deepEqual(
      w.filters.status,
      ['running'],
      `a ${w.patch.status} write with no status guard would overwrite a cancellation made while the stage ran`,
    );
  }
});

await test('progress writes during a stage are not guarded, so they survive a lease renewal race', async () => {
  const db = fakeDb();
  const { runJob } = createRunner({ db, runStage: async () => ({ ok: true }), log: silent });
  await runJob(job());
  const progress = db.writes.filter((w) => w.patch.stages && !w.patch.status);
  assert.ok(progress.length >= 2, 'each stage records running then its result');
  assert.equal(progress[0].filters.status, undefined);
});

// ── Resume, failure and the attempt cap ───────────────────────────────────

await test('a resumed job runs only the stage it still owes', async () => {
  const db = fakeDb();
  const ran = [];
  const { runJob } = createRunner({ db, runStage: async (s) => { ran.push(s.stage); return { ok: true }; }, log: silent });
  const res = await runJob(job({ stages: { sales_history: { status: 'done' } } }));
  assert.deepEqual(ran, ['storefront']);
  assert.equal(res.status, 'done');
});

await test('a failed stage does not stop the next one, and the row goes back to pending', async () => {
  const db = fakeDb();
  const ran = [];
  const { runJob } = createRunner({
    db,
    runStage: async (s) => { ran.push(s.stage); return s.stage === 'sales_history' ? { ok: false, detail: 'exit code 1' } : { ok: true }; },
    log: silent,
  });
  const res = await runJob(job({ attempts: 1 }));
  assert.deepEqual(ran, ['sales_history', 'storefront'], 'losing the order history must not cost the store its stock levels');
  assert.equal(res.status, 'pending', 'attempts remain, so the failed stage is owed again');
  assert.equal(db.writes.at(-1).patch.finished_at, undefined, 'a job that will retry is not finished');
});

await test('at the attempt cap the same job settles as partial rather than retrying for ever', async () => {
  const db = fakeDb();
  const { runJob } = createRunner({
    db,
    maxAttempts: 3,
    runStage: async (s) => (s.stage === 'sales_history' ? { ok: false, detail: 'exit code 1' } : { ok: true }),
    log: silent,
  });
  const res = await runJob(job({ attempts: 3 }));
  assert.equal(res.status, 'partial');
  assert.ok(db.writes.at(-1).patch.finished_at, 'a settled job is finished');
});

// ── A connection that went away ───────────────────────────────────────────

await test('a deleted connection cancels the job instead of erroring every quarter of an hour', async () => {
  const db = fakeDb({ connection: null });
  const { runJob } = createRunner({ db, runStage: async () => ({ ok: true }), log: silent });
  const res = await runJob(job());
  assert.equal(res.status, 'cancelled');
  assert.match(db.writes.at(-1).patch.last_error, /no longer exists/);
});

await test('a switched-off connection is cancelled too', async () => {
  const db = fakeDb({ connection: { id: 'conn-1', is_active: false } });
  const { runJob } = createRunner({ db, runStage: async () => ({ ok: true }), log: silent });
  const res = await runJob(job());
  assert.equal(res.status, 'cancelled');
  assert.match(db.writes.at(-1).patch.last_error, /inactive/);
});

// ── A stage whose prerequisite is missing ────────────────────────────────

await test('Redo without an API secret records both stages skipped and ends done', async () => {
  const db = fakeDb({ connection: { id: 'r-1', is_active: true, api_secret: null } });
  const ran = [];
  const { runJob } = createRunner({ db, runStage: async (s) => { ran.push(s.stage); return { ok: true }; }, log: silent });
  const res = await runJob(job({ integration: 'redo', connection_id: null }));
  assert.deepEqual(ran, [], 'a stage with no credential must not be launched');
  assert.equal(res.status, 'done');
  const last = db.writes.at(-1);
  assert.equal(last.patch.stages.returns_backfill.status, 'skipped');
  assert.match(last.patch.stages.returns_backfill.detail, /api_secret/);
});

await test('the Shopify stages are launched with the connection id and a manual run kind', async () => {
  const db = fakeDb();
  const envs = [];
  const { runJob } = createRunner({ db, runStage: async (s, env) => { envs.push(env); return { ok: true }; }, log: silent });
  await runJob(job());
  assert.equal(envs.length, 2);
  for (const env of envs) {
    assert.equal(env.SHOPIFY_ONLY_CONNECTION_ID, 'conn-1');
    // A first import is judged like a hand-dispatched backfill: a lost stage
    // must not be reported as success.
    assert.equal(env.SHOPIFY_RUN_KIND, 'manual');
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
