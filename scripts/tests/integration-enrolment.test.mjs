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
const { enrolmentState, describeState, withPauseStamp, withoutPauseStamp, needsEvidence } =
  sandbox.window.SiloEnrolment;

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
