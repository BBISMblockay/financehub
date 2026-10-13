// Which Shopify connections the Integrations page may offer to enrol, and --
// the part that matters -- which it must leave alone.
//
// Audited live on 2026-10-13. Four connections had `sync_enabled = false`
// with `last_test_success = true`, and they fall into two groups that the
// row itself cannot tell apart:
//
//   suticompany        0 sync_jobs ever, 0 rows in sales_by_day   stranded
//   baseballismmlb     0 sync_jobs ever                           stranded
//   baseballismchicago 1,526 sync_jobs, last 2026-09-20           paused on purpose
//   baseballismdsg     1,545 sync_jobs, last 2026-09-20           paused on purpose
//
// Offering "Start first import" on either of the last two would re-import a
// store somebody switched off. So the gate is evidence from sync_jobs, and
// an absent or failed probe reads as paused, never as fresh.
//
// The module is a browser IIFE (it hangs SiloEnrolment on window), so it is
// executed in a vm sandbox the way integration-bootstrap.test.mjs does it.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(new URL('../../v2/integration-enrolment.js', import.meta.url), 'utf8'),
  sandbox,
);
const {
  enrolmentState, describeState, withPauseStamp, withoutPauseStamp, needsEvidence,
  jobCountsAsQueued, NON_IMPORT_JOB_TYPES,
  pauseConnection, resumeConnection, enrolConnection, stampPause,
} = sandbox.window.SiloEnrolment;

const tested = (over = {}) => ({ last_test_status: 'ok', sync_enabled: false, meta: {}, ...over });

test('a store that tested OK and never ran a job is the one to offer', () => {
  // suticompany: tested 2026-10-08, zero sync_jobs, zero sales rows.
  assert.equal(enrolmentState(tested(), false), 'never_imported');
  assert.equal(describeState('never_imported').offerStart, true);
  assert.equal(describeState('never_imported').attention, true,
    'a connected store holding no data at all is not simply "Connected"');
});

test('a store with sync history behind it is paused, not stranded', () => {
  // baseballismchicago / baseballismdsg: ~1,500 jobs each, switched off.
  assert.equal(enrolmentState(tested(), true), 'paused');
  assert.equal(describeState('paused').offerStart, false,
    'offering Start here would re-import a store somebody deliberately switched off');
});

test('evidence we do not have never reads as fresh', () => {
  for (const unknown of [null, undefined]) {
    assert.equal(enrolmentState(tested(), unknown), 'paused',
      'a failed sync_jobs probe must fall back to the safe state, not the actionable one');
  }
  assert.equal(describeState(enrolmentState(tested(), null)).offerStart, false);
});

test('an explicit pause outranks the evidence', () => {
  // Switched off by a person after one failed import: zero jobs, but the
  // stamp says somebody meant it.
  const stamped = tested({ meta: { sync_paused_at: '2026-10-10T12:00:00Z' } });
  assert.equal(enrolmentState(stamped, false), 'paused');
  assert.equal(needsEvidence(stamped), false, 'a stamped row has its answer; do not probe it');
});

test('a syncing store and a failed one are neither', () => {
  assert.equal(enrolmentState(tested({ sync_enabled: true }), false), 'syncing');
  assert.equal(enrolmentState({ last_test_status: 'error', sync_enabled: false }, false), 'needs_attention');
  assert.equal(enrolmentState({ last_test_status: null, sync_enabled: false }, false), 'not_tested');
  for (const state of ['syncing', 'needs_attention', 'not_tested']) {
    assert.equal(describeState(state).offerStart, false);
  }
});

test('only the rows whose state is still open are probed', () => {
  assert.equal(needsEvidence(tested()), true);
  assert.equal(needsEvidence(tested({ sync_enabled: true })), false);
  assert.equal(needsEvidence({ last_test_status: 'error', sync_enabled: false }), false);
});

test('stamping a pause keeps everything else in meta', () => {
  // The history import writes history_backfill to this same column, so a
  // stamp that replaced meta would roll a running import back to its start.
  const live = { history_backfill: { status: 'running', cursor: '2026-03-01' }, scopes_fetch_error: null };
  const paused = withPauseStamp(live, { at: '2026-10-13T17:00:00Z', by: 'user-1' });
  assert.deepEqual(paused.history_backfill, live.history_backfill);
  assert.equal(paused.sync_paused_at, '2026-10-13T17:00:00Z');
  assert.equal(paused.sync_paused_by, 'user-1');

  const resumed = withoutPauseStamp(paused);
  assert.equal(resumed.sync_paused_at, null, 'switching sync back on is un-pausing');
  assert.equal(resumed.sync_paused_by, null);
  assert.deepEqual(resumed.history_backfill, live.history_backfill);

  // A row whose meta is null must not throw on the way to being stamped.
  assert.equal(withPauseStamp(null, { at: 'x' }).sync_paused_at, 'x');
  assert.equal(withoutPauseStamp(undefined).sync_paused_at, null);
});

test('a stamped pause survives a round trip through the state machine', () => {
  const stamped = tested({ meta: withPauseStamp({}, { at: '2026-10-13T17:00:00Z' }) });
  assert.equal(enrolmentState(stamped, false), 'paused');
  const unstamped = tested({ meta: withoutPauseStamp(stamped.meta) });
  assert.equal(enrolmentState(unstamped, false), 'never_imported',
    'un-pausing a store that never imported leaves it offerable again');
});

// ── Cycle-1 review findings ───────────────────────────────────────────────

// P1. The queue keeps done/partial/error/cancelled rows as the record of what
// was imported, and the unique index that stops a duplicate covers
// ('pending','running') only. So a terminal row claims nothing and blocks
// nothing -- a store whose first job was cancelled before it ran still has no
// import, and reporting "already queued" for it would promise work that will
// never happen.
test('only an open queue row means an import is coming', () => {
  for (const status of ['pending', 'running']) {
    assert.equal(jobCountsAsQueued({ status }), true, `${status} is claimable`);
  }
  for (const status of ['done', 'partial', 'error', 'cancelled']) {
    assert.equal(jobCountsAsQueued({ status }), false,
      `${status} is a record of the past, not an import on its way`);
  }
  assert.equal(jobCountsAsQueued(null), false);
  assert.equal(jobCountsAsQueued(undefined), false);
});

// P2. A connection test writes a sync_jobs row and imports nothing. The
// bootstrap runner excludes the same job_type from the same question; without
// it, a legacy store whose only row is a successful test reads as "has
// synced" and never gets offered its first import.
test('a connection test is not evidence of an import', () => {
  assert.ok(NON_IMPORT_JOB_TYPES.includes('test_connection'));
  // Pinned to the runner, which asks the same question of the same table.
  const runner = fs.readFileSync(
    new URL('../lib/integration-bootstrap-runner.mjs', import.meta.url), 'utf8',
  );
  for (const jobType of NON_IMPORT_JOB_TYPES) {
    assert.match(runner, new RegExp(`neq\\('job_type', '${jobType}'\\)`),
      `the runner excludes ${jobType} from its own prior-sync check; the page must exclude the same`);
  }
  // And the page's probe must carry the exclusion, or the evidence it feeds
  // enrolmentState() is wrong before the rule above ever runs.
  const page = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const probe = page.slice(page.indexOf('async function loadEnrolmentEvidence'));
  assert.match(probe.slice(0, 1200), /neq\('job_type', 'test_connection'\)/);
});

// ── Cycle-2 review findings: run the interleavings, don't assert the shape ──
//
// Cycle 1's corrections were checked with regexes over the page, which prove
// a guard exists and nothing about what happens when two admins write at
// once. These drive the real functions against the fake PostgREST, which
// applies `.eq()`/`.is()` filters -- including JSON paths -- inside the
// UPDATE, exactly as the server does.

const CONN = 'conn-1';
const seed = (meta = {}, syncEnabled = false) => {
  const db = createFakeSupabase();
  db.from('shopify_connections').insert({
    id: CONN, sync_enabled: syncEnabled, meta, updated_at: null, last_test_status: 'ok',
  });
  return db;
};
const rowOf = (db) => db.tables.get('shopify_connections')[0];

/** Run `hook` once, after this db's next write has landed.
 *
 * pauseConnection is two statements. The question cycle 2 raised is what a
 * stale Start click does if it arrives BETWEEN them, and the only way to
 * answer it is to put the click there.
 */
function interleaveAfterFirstWrite(db, hook) {
  const realFrom = db.from.bind(db);
  let fired = false;
  db.from = (table) => {
    const builder = realFrom(table);
    const realUpdate = builder.update.bind(builder);
    builder.update = (patch) => {
      const chain = realUpdate(patch);
      const realThen = chain.then.bind(chain);
      chain.then = (resolve, reject) => realThen(async (value) => {
        if (!fired) { fired = true; await hook(); }
        return resolve(value);
      }, reject);
      return chain;
    };
    return builder;
  };
}

test('a stale Start landing BETWEEN the pause\'s two writes still loses', async () => {
  // The order of pauseConnection's two statements is the whole defence: the
  // note goes first, so the enrolment condition sees it. Written the other
  // way round -- flag first, note second -- this click lands in the middle
  // and the store ends up ON with a pause recorded against it.
  const db = seed();
  interleaveAfterFirstWrite(db, async () => {
    await enrolConnection(db, { connectionId: CONN });
  });
  const res = await pauseConnection(db, { connectionId: CONN, userId: 'user-b', at: 'T0' });
  assert.equal(res.ok, true);
  assert.equal(rowOf(db).sync_enabled, false,
    'a pause half-applied must never be observable as "switched on with a pause stamp"');
  assert.equal(rowOf(db).meta.sync_paused_at, 'T0');
});

test('a stale Start cannot land inside a pause and leave the store switched on', async () => {
  // Admin B pauses while admin A's page still shows the Start button. The
  // pause is two writes; A's click is one. Whatever the order, the store
  // must end up OFF -- that is the decision B just made about their spend.
  const db = seed();
  // B's first write (the note), then A's stale click, then B's second.
  const stamp = await stampPause(db, { table: 'shopify_connections', connectionId: CONN, at: 'T1' });
  assert.equal(stamp.stamped, true);
  const stale = await enrolConnection(db, { connectionId: CONN });
  assert.equal(stale.enabled, false, 'the stamp is already on the row, so the enable must match nothing');
  await db.from('shopify_connections').update({ sync_enabled: false }).eq('id', CONN);
  assert.equal(rowOf(db).sync_enabled, false);
});

test('and if the click gets in first, the pause still wins', async () => {
  const db = seed();
  // A's click lands before B has written anything.
  assert.equal((await enrolConnection(db, { connectionId: CONN })).enabled, true);
  // B's pause follows in full. Its disable is the last write, so the row is
  // off -- never "on with a pause recorded", which is what the two-write
  // order is chosen to prevent.
  const paused = await pauseConnection(db, { connectionId: CONN, userId: 'user-b', at: 'T2' });
  assert.equal(paused.ok, true);
  assert.equal(rowOf(db).sync_enabled, false);
  assert.equal(rowOf(db).meta.sync_paused_at, 'T2');
});

test('an import that moves during a pause keeps its progress', async () => {
  // The pause note replaces the whole meta object -- the browser cannot
  // patch two JSONB keys -- so the UPDATE pins the import's own fields. A
  // window that lands between the read and the write must not be rolled
  // back to where the pause found it.
  const db = seed({ history_backfill: { status: 'running', cursor: '2026-03-01', windows_done: 3 } });
  const moved = { status: 'running', cursor: '2026-05-01', windows_done: 5 };

  // Interleave: read the row as stampPause does, let a window land, then
  // let the pinned write go out.
  const { data: fresh } = await db.from('shopify_connections').select('meta').eq('id', CONN).maybeSingle();
  rowOf(db).meta = { history_backfill: moved };
  const { query, pinned } = sandbox.window.SiloEnrolment.pinImportState(
    db.from('shopify_connections')
      .update({ meta: { ...fresh.meta, sync_paused_at: 'T3' } })
      .eq('id', CONN),
    fresh.meta.history_backfill,
  );
  assert.equal(pinned, true);
  const { data } = await query.select('id');
  assert.equal((data || []).length, 0, 'the pinned update must match nothing once the import has moved');
  assert.deepEqual(rowOf(db).meta.history_backfill, moved, 'the newer plan stands');
  assert.equal(rowOf(db).meta.sync_paused_at, undefined, 'and no stamp was written over it');
});

test('a pause during a quiet import preserves the import exactly', async () => {
  const bf = { status: 'running', cursor: '2026-03-01', windows_done: 3 };
  const db = seed({ history_backfill: bf, last_order_sync_at: 'yesterday' });
  const res = await pauseConnection(db, { connectionId: CONN, userId: 'user-b', at: 'T4' });
  assert.equal(res.stamped, true);
  assert.equal(rowOf(db).sync_enabled, false);
  assert.deepEqual(rowOf(db).meta.history_backfill, bf, 'nothing about the import changed');
  assert.equal(rowOf(db).meta.last_order_sync_at, 'yesterday', 'and nothing else in meta was lost');
  assert.equal(rowOf(db).meta.sync_paused_at, 'T4');
});

test('a failed disable takes the pause note back', async () => {
  // A stamp with the sync still ON reads as paused while the nightly keeps
  // running -- the one state worse than no stamp at all.
  const db = seed({}, true);
  const realFrom = db.from.bind(db);
  let updates = 0;
  db.from = (table) => {
    const builder = realFrom(table);
    const realUpdate = builder.update.bind(builder);
    builder.update = (patch) => {
      const u = realUpdate(patch);
      // Fail only the sync_enabled write, which is the second update.
      if ('sync_enabled' in patch && ++updates === 1) {
        return { ...u, eq: () => ({ then: (r) => r({ error: { message: 'boom' } }) }) };
      }
      return u;
    };
    return builder;
  };
  const res = await pauseConnection(db, { connectionId: CONN, userId: 'user-b', at: 'T5' });
  assert.equal(res.ok, false);
  assert.equal(rowOf(db).sync_enabled, true, 'the setting did not change');
  assert.ok(!rowOf(db).meta.sync_paused_at, 'so the note must not be left behind either');
});

test('enrolling refuses a store that is already on, and resume clears the note', async () => {
  const on = seed({}, true);
  assert.equal((await enrolConnection(on, { connectionId: CONN })).enabled, false);

  const paused = seed({ sync_paused_at: 'T6', sync_paused_by: 'user-b' }, false);
  assert.equal((await enrolConnection(paused, { connectionId: CONN })).enabled, false,
    'a paused store is not enrolled by a button click');
  const resumed = await resumeConnection(paused, { connectionId: CONN, at: 'T7' });
  assert.equal(resumed.ok, true);
  assert.equal(rowOf(paused).sync_enabled, true);
  assert.equal(rowOf(paused).meta.sync_paused_at, null, 'resuming takes the note off');
  // And now it is enrollable again if it never imported.
  assert.equal(enrolmentState(rowOf(paused), false), 'syncing');
});

test('a row that cannot be re-read is not stamped from a guess', async () => {
  const db = createFakeSupabase();
  const res = await stampPause(db, { table: 'shopify_connections', connectionId: 'missing', at: 'T8' });
  assert.equal(res.stamped, false);
  assert.equal(res.reason, 'unreadable');
});
