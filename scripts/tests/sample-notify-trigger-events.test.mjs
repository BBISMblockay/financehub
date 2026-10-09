// sample-notify event rules (supabase/functions/sample-notify/trigger-events.mjs).
//
// Security audit 2026-10-08, cycle-1 review: sample-notify is public, so an
// unsigned caller who knew a sample id could post SAMPLE_RECEIVED (or any
// type) for a real row and send a false "received" email and Slack post, as
// often as they liked. Proven here:
//   1. A signed-in caller may send only SAMPLE_ASSIGNED; an unsigned one only
//      the three events the trigger sends.
//   2. An unsigned event must match the row's CURRENT state, exactly as
//      notify_sample_events() decides it.
//   3. An unsigned INSERT event is accepted once, and only for a fresh row; a
//      size request only outside a cooldown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  callerMaySend, rowSupportsTriggerEvent, unsignedEventIsFresh,
  INSERT_EVENT_WINDOW_MS, SIZE_REQUEST_COOLDOWN_MS,
} from '../../supabase/functions/sample-notify/trigger-events.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

test('each caller may send only its own events', () => {
  assert.equal(callerMaySend(true, 'SAMPLE_ASSIGNED'), true);
  for (const t of ['SAMPLE_REQUESTED', 'SAMPLE_RECEIVED', 'SAMPLE_SIZE_REQUEST', 'SAMPLE_WAREHOUSE_READY']) {
    assert.equal(callerMaySend(true, t), false, `signed-in ${t}`);
  }
  for (const t of ['SAMPLE_REQUESTED', 'SAMPLE_RECEIVED', 'SAMPLE_SIZE_REQUEST']) assert.equal(callerMaySend(false, t), true, t);
  for (const t of ['SAMPLE_ASSIGNED', 'SAMPLE_WAREHOUSE_READY', 'BOGUS']) assert.equal(callerMaySend(false, t), false, `unsigned ${t}`);
});

const pending = { assigned_to: 'u1', request_source: null, size_requests: null, sample_status: 'requested' };
const received = { ...pending, sample_status: 'pps_received' };
const photo = { assigned_to: null, request_source: 'catalog_photo_request', size_requests: 'M, L', sample_status: 'received' };

test('an unsigned event must match the row as the trigger would have judged it', () => {
  assert.equal(rowSupportsTriggerEvent('SAMPLE_REQUESTED', pending), true);
  assert.equal(rowSupportsTriggerEvent('SAMPLE_RECEIVED', pending), false, 'a pending sample is not "received"');
  assert.equal(rowSupportsTriggerEvent('SAMPLE_RECEIVED', received), true);
  assert.equal(rowSupportsTriggerEvent('SAMPLE_REQUESTED', received), false);
  assert.equal(rowSupportsTriggerEvent('SAMPLE_SIZE_REQUEST', photo), true);
  assert.equal(rowSupportsTriggerEvent('SAMPLE_SIZE_REQUEST', { ...photo, size_requests: '  ' }), false);
  assert.equal(rowSupportsTriggerEvent('SAMPLE_SIZE_REQUEST', { ...photo, request_source: 'manual' }), false);
  assert.equal(rowSupportsTriggerEvent('SAMPLE_REQUESTED', { ...pending, assigned_to: null }), false, 'unrouted rows never notify');
  assert.equal(rowSupportsTriggerEvent('SAMPLE_REQUESTED', { ...pending, size_requests: 'S' }), false);
});

test('an unsigned INSERT event is accepted once, for a fresh row only', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - INSERT_EVENT_WINDOW_MS - 1000).toISOString();
  assert.equal(unsignedEventIsFresh('SAMPLE_RECEIVED', fresh, null, now), true, 'the trigger\'s own first delivery');
  assert.equal(unsignedEventIsFresh('SAMPLE_RECEIVED', fresh, fresh, now), false, 'a replay after it was sent');
  assert.equal(unsignedEventIsFresh('SAMPLE_REQUESTED', stale, null, now), false, 'an old sample cannot be re-announced');
  assert.equal(unsignedEventIsFresh('SAMPLE_REQUESTED', null, null, now), false, 'no created_at, no send');
});

test('an unsigned size request respects the cooldown', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(unsignedEventIsFresh('SAMPLE_SIZE_REQUEST', null, null, now), true);
  assert.equal(unsignedEventIsFresh('SAMPLE_SIZE_REQUEST', null, new Date(now - 60_000).toISOString(), now), false);
  assert.equal(unsignedEventIsFresh('SAMPLE_SIZE_REQUEST', null, new Date(now - SIZE_REQUEST_COOLDOWN_MS - 1000).toISOString(), now), true);
});

test('index.ts uses these rules, refuses a bad bearer, and checks before sending', () => {
  const s = readFileSync(new URL('../../supabase/functions/sample-notify/index.ts', import.meta.url), 'utf8');
  assert.match(s, /import \{ callerMaySend, rowSupportsTriggerEvent, unsignedEventIsFresh \} from '\.\/trigger-events\.mjs';/);
  assert.match(s, /if \(who\.kind === 'invalid'\) \{\s*return new Response\(JSON\.stringify\(\{ error: 'Not authenticated' \}\), \{ status: 401/);
  const order = ['if (!callerMaySend(!!jwt, type))', 'if (!rowSupportsTriggerEvent(type, record)) return quiet();',
    'if (!unsignedEventIsFresh(type, record.created_at,', 'sendEmail(sender, toEmails, subject, html)'];
  let last = -1;
  for (const marker of order) {
    const at = s.indexOf(marker);
    assert.ok(at > last, `out of order or missing: ${marker}`);
    last = at;
  }
});

// The rules must stay a faithful mirror of the trigger: if notify_sample_events()
// ever sends another event type, this fails until TRIGGER_TYPES learns it.
test('TRIGGER_TYPES covers exactly what the latest notify_sample_events() sends', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260910160000_notify_sample_events_as_deployed.sql', import.meta.url), 'utf8');
  const sent = new Set([...sql.matchAll(/'(SAMPLE_[A-Z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...sent].sort(), ['SAMPLE_RECEIVED', 'SAMPLE_REQUESTED', 'SAMPLE_SIZE_REQUEST']);
});

console.log(`\n${passed} passed`);
