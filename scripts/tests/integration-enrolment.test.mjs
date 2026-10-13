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

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(new URL('../../v2/integration-enrolment.js', import.meta.url), 'utf8'),
  sandbox,
);
const {
  enrolmentState, describeState, withPauseStamp, withoutPauseStamp, needsEvidence,
  jobCountsAsQueued, NON_IMPORT_JOB_TYPES,
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

// P1. The enable must carry its conditions INSIDE the statement: another
// admin pausing the store while the page sits open must not be overridden by
// a click on a button rendered before that pause existed.
test('enrolling is a conditional update, not a read-then-write', () => {
  const page = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const fn = page.slice(
    page.indexOf('async function startFirstImport'),
    page.indexOf('async function toggleSyncEnabled'),
  );
  assert.match(fn, /\.update\(\{ sync_enabled: true[\s\S]*?\.eq\('sync_enabled', false\)/,
    'the update must refuse a store somebody already switched on');
  assert.match(fn, /\.is\('meta->>sync_paused_at', null\)/,
    'the update must refuse a store somebody just paused');
  assert.match(fn, /if \(!\(enabled \|\| \[\]\)\.length\)/,
    'zero rows back means the state moved: nothing further may run against it');
  assert.match(fn, /requeueTerminal: true/,
    'a terminal queue row must be requeued, not reported as an import on its way');
});

// P1. meta is shared with the history import, which writes history_backfill
// to it. A stamp built from a snapshot would put an old plan back.
test('the pause stamp never writes over a running import', () => {
  const page = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('async function toggleSyncEnabled'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  assert.match(body, /history_backfill\?\.status === 'running'/,
    'the stamp has to stand down while an import is in flight');
  assert.match(body, /if \(!readErr && fresh && !importRunning\)/,
    'a row that could not be re-read must not be written from a stale snapshot');
});
