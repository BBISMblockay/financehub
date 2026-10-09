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
//   3. Each unsigned delivery has a once-only claim key: requested / received
//      once per sample; a size request once per trigger transition (event_id)
//      once the trigger is verified, or once per size list before that.
//   4. index.ts refuses an unsigned call without the trigger secret once it is
//      configured, and inserts the claim BEFORE it sends anything (cycle-2
//      review: concurrent requests all passed a read-then-send check).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  callerMaySend, claimKeyFor, insertEventIsFresh, rowSupportsTriggerEvent, INSERT_EVENT_WINDOW_MS,
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

test('before the secret is set, an unsigned INSERT event needs a fresh row', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(insertEventIsFresh(new Date(now - 60_000).toISOString(), now), true);
  assert.equal(insertEventIsFresh(new Date(now - INSERT_EVENT_WINDOW_MS - 1000).toISOString(), now), false);
  assert.equal(insertEventIsFresh(null, now), false);
});

test('claim keys make each delivery once-only', () => {
  const evt = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const verifiedTrigger of [true, false]) {
    assert.equal(claimKeyFor('SAMPLE_REQUESTED', { verifiedTrigger, eventId: evt, row: pending }), 'insert');
    assert.equal(claimKeyFor('SAMPLE_RECEIVED', { verifiedTrigger, eventId: evt, row: received }), 'insert');
  }
  // Verified trigger: one per transition, whatever the sizes say.
  assert.equal(claimKeyFor('SAMPLE_SIZE_REQUEST', { verifiedTrigger: true, eventId: evt, row: photo }), `evt:${evt}`);
  assert.equal(claimKeyFor('SAMPLE_SIZE_REQUEST', { verifiedTrigger: true, eventId: 'not-a-uuid', row: photo }), null);
  assert.equal(claimKeyFor('SAMPLE_SIZE_REQUEST', { verifiedTrigger: true, eventId: undefined, row: photo }), null);
  // Before the secret: one per size list, so replaying the same list is a no-op.
  const a = claimKeyFor('SAMPLE_SIZE_REQUEST', { verifiedTrigger: false, eventId: evt, row: photo });
  const b = claimKeyFor('SAMPLE_SIZE_REQUEST', { verifiedTrigger: false, eventId: 'anything', row: { ...photo, size_requests: '  m,   l ' } });
  assert.equal(a, 'sizes:m, l');
  assert.equal(claimKeyFor('SAMPLE_SIZE_REQUEST', { verifiedTrigger: false, row: { ...photo, size_requests: 'M, L, XL' } }) === a, false);
  assert.ok(b !== null);
  assert.equal(claimKeyFor('SAMPLE_ASSIGNED', { verifiedTrigger: true, eventId: evt, row: pending }), null, 'never an unsigned key for a manual event');
});

test('index.ts uses these rules, refuses a bad bearer, and checks before sending', () => {
  const s = readFileSync(new URL('../../supabase/functions/sample-notify/index.ts', import.meta.url), 'utf8');
  assert.match(s, /import \{ callerMaySend, claimKeyFor, insertEventIsFresh, rowSupportsTriggerEvent \} from '\.\/trigger-events\.mjs';/);
  assert.match(s, /if \(who\.kind === 'invalid'\) \{\s*return new Response\(JSON\.stringify\(\{ error: 'Not authenticated' \}\), \{ status: 401/);
  const order = ['if (!callerMaySend(!!jwt, type))',
    "if (verifiedTrigger && !(await secretsMatch(req.headers.get('x-silo-trigger-secret') || '', TRIGGER_SECRET)))",
    'if (!rowSupportsTriggerEvent(type, record)) return quiet();',
    'const claimKey = claimKeyFor(type, { verifiedTrigger, eventId: body?.event_id, row: record });',
    "await db.from('sample_notification_claims').insert({",
    "if (claimErr.code === '23505') return quiet();",
    'sendEmail(sender, toEmails, subject, html)'];
  let last = -1;
  for (const marker of order) {
    const at = s.indexOf(marker);
    assert.ok(at > last, `out of order or missing: ${marker}`);
    last = at;
  }
});

// The rules must stay a faithful mirror of the trigger: if notify_sample_events()
// ever sends another event type, this fails until TRIGGER_TYPES learns it. Read
// from whichever migration defines it LAST, as apply_all and production do.
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const latestTriggerSql = readdirSync(MIGRATIONS).sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  .filter((sql) => /create or replace function public\.notify_sample_events\(\)/i.test(sql))
  .pop();
const triggerBody = latestTriggerSql.slice(latestTriggerSql.search(/create or replace function public\.notify_sample_events\(\)/i));

test('TRIGGER_TYPES covers exactly what the latest notify_sample_events() sends', () => {
  const fn = triggerBody.slice(0, triggerBody.indexOf('$function$;', triggerBody.indexOf('$function$') + 10));
  const sent = new Set([...fn.matchAll(/'(SAMPLE_[A-Z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...sent].sort(), ['SAMPLE_RECEIVED', 'SAMPLE_REQUESTED', 'SAMPLE_SIZE_REQUEST']);
});

test('the latest notify_sample_events() signs every call and sends a per-transition event_id', () => {
  const fn = triggerBody.slice(0, triggerBody.indexOf('$function$;', triggerBody.indexOf('$function$') + 10));
  assert.match(fn, /'x-silo-trigger-secret', coalesce\(\s*\(select decrypted_secret from vault\.decrypted_secrets where name = 'sample_notify_trigger_secret' limit 1\), ''\)/);
  assert.equal((fn.match(/headers := v_headers/g) || []).length, 2, 'both http_post calls carry the signed headers');
  assert.equal((fn.match(/'event_id', gen_random_uuid\(\)/g) || []).length, 2, 'both calls carry an event_id');
});

console.log(`\n${passed} passed`);
