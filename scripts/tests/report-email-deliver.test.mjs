// Scheduled CSV email delivery: cadence math, the claim that stops a double
// send, CSV paging, failure classification, and the structural facts the
// feature depends on (no change to the shared report engine, the cron workflow
// actually installs its dependency, the vendored copies stay byte-identical).
//
// No network, no database, no install -- this runs in the "Sync logic tests"
// unit job.
//
// Run: node scripts/tests/report-email-deliver.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  cadenceLabel,
  claimSchedule,
  computeNextRunAt,
  defaultQueryIndex,
  fetchAllRows,
  isTransientDeliveryError,
  queryIndicesForSchedule,
  renderSubject,
  rowsToCsv,
  sanitizeFilename,
  zonedTimeToInstant,
} from '../lib/report-email-deliver-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let ran = 0;
async function test(name, fn) {
  ran += 1;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

// ── Cadence math ─────────────────────────────────────────────────────────
// The bug this pins: building the instant with Date.UTC() from zone-local
// y/m/d labels 7:00 Los Angeles as 07:00 UTC -- midnight Pacific. Every
// expectation below is the WALL CLOCK time the cadence promises, converted by
// hand, so reverting the fix makes each one off by the zone's offset.
await test('7:00 Pacific is 14:00 UTC in PDT and 15:00 UTC in PST', () => {
  // Wed 2026-10-14, PDT (UTC-7): next weekday slot is Thu 15th 07:00 PDT.
  assert.equal(
    computeNextRunAt('weekdays_0700', 'America/Los_Angeles', new Date('2026-10-14T20:00:00Z')),
    '2026-10-15T14:00:00.000Z',
  );
  // Sat 2026-11-07, PST (UTC-8): 07:00 PST is 15:00 UTC.
  assert.equal(
    computeNextRunAt('daily_0600', 'America/Los_Angeles', new Date('2026-11-07T20:00:00Z')),
    '2026-11-08T14:00:00.000Z', // 06:00 PST
  );
  assert.equal(
    computeNextRunAt('weekdays_0700', 'America/Los_Angeles', new Date('2026-11-09T20:00:00Z')),
    '2026-11-10T15:00:00.000Z',
  );
});

await test('the DST change is crossed on the zone, not by adding 86400000', () => {
  // US DST ends 2026-11-01. From Fri Oct 30 the next weekday slot is Mon Nov 2,
  // which is PST: 07:00 local = 15:00 UTC, not 14:00.
  assert.equal(
    computeNextRunAt('weekdays_0700', 'America/Los_Angeles', new Date('2026-10-30T20:00:00Z')),
    '2026-11-02T15:00:00.000Z',
  );
  // And the 1st of the month lands on the DST boundary day itself.
  assert.equal(
    computeNextRunAt('month_first_0700', 'America/Los_Angeles', new Date('2026-10-14T20:00:00Z')),
    '2026-11-01T15:00:00.000Z',
  );
});

await test('other zones get their own offset, not Pacific and not UTC', () => {
  assert.equal(
    computeNextRunAt('weekdays_0700', 'America/New_York', new Date('2026-10-14T20:00:00Z')),
    '2026-10-15T11:00:00.000Z', // 07:00 EDT
  );
  assert.equal(
    computeNextRunAt('daily_0600', 'UTC', new Date('2026-10-14T20:00:00Z')),
    '2026-10-15T06:00:00.000Z',
  );
  assert.equal(zonedTimeToInstant(2026, 10, 15, 7, 0, 'Asia/Tokyo').toISOString(), '2026-10-14T22:00:00.000Z');
});

await test('weekdays skips the weekend, monday lands on a Monday, and a slot is never today', () => {
  // Fri 2026-10-16 20:00Z is Fri 13:00 PDT -> next weekday is Mon the 19th.
  assert.equal(
    computeNextRunAt('weekdays_0700', 'America/Los_Angeles', new Date('2026-10-16T20:00:00Z')),
    '2026-10-19T14:00:00.000Z',
  );
  // From a Monday, the next Monday slot is seven days out, never the same day.
  assert.equal(
    computeNextRunAt('monday_0700', 'America/Los_Angeles', new Date('2026-10-19T08:00:00Z')),
    '2026-10-26T14:00:00.000Z',
  );
  for (const preset of ['weekdays_0700', 'daily_0600', 'monday_0700', 'month_first_0700']) {
    const from = new Date('2026-10-14T05:00:00Z'); // 22:00 Oct 13 Pacific
    assert.ok(
      new Date(computeNextRunAt(preset, 'America/Los_Angeles', from)) > from,
      `${preset} must be strictly in the future`,
    );
  }
});

await test('December rolls the year over for the monthly slot', () => {
  assert.equal(
    computeNextRunAt('month_first_0700', 'America/Los_Angeles', new Date('2026-12-20T20:00:00Z')),
    '2027-01-01T15:00:00.000Z',
  );
});

await test('an unknown preset still returns a usable instant, never undefined', () => {
  const got = computeNextRunAt('something_new', 'America/Los_Angeles', new Date('2026-10-14T20:00:00Z'));
  assert.equal(got, '2026-10-15T14:00:00.000Z');
});

// The browser carries its own copy of these four functions so the "next run"
// preview matches what the runner will do. Two implementations that disagree
// means the UI shows one time and the email arrives at another, which no single
// test of either copy would catch.
await test('v3/js/report-email-schedule.js computes exactly the same instants', () => {
  const src = read('v3/js/report-email-schedule.js');
  const g = {};
  // The file is an IIFE over `typeof window !== 'undefined' ? window : globalThis`,
  // so handing it an undefined `window` and our own `globalThis` captures it.
  // eslint-disable-next-line no-new-func
  new Function('globalThis', 'window', src)(g, undefined);
  const browser = g.SiloReportEmailSchedule?.computeNextRunAt;
  assert.equal(typeof browser, 'function', 'the browser copy must export computeNextRunAt');

  const zones = ['America/Los_Angeles', 'America/New_York', 'UTC', 'Asia/Tokyo'];
  const presets = ['weekdays_0700', 'daily_0600', 'monday_0700', 'month_first_0700'];
  const froms = [
    '2026-10-14T20:00:00Z', '2026-10-30T20:00:00Z', '2026-11-01T09:00:00Z',
    '2026-11-09T20:00:00Z', '2026-12-31T23:30:00Z', '2027-03-08T10:00:00Z',
    '2026-02-28T20:00:00Z',
  ];
  let checked = 0;
  for (const tz of zones) {
    for (const preset of presets) {
      for (const f of froms) {
        const from = new Date(f);
        assert.equal(
          browser(preset, tz, from),
          computeNextRunAt(preset, tz, from),
          `${preset} ${tz} ${f}`,
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, zones.length * presets.length * froms.length);
  assert.ok(checked >= 100, 'the fixture matrix must actually cover something');
});

// ── The claim that stops a double send ───────────────────────────────────
function fakeDb(updateResult) {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, filters: {}, payload: null };
      const chain = {
        update(payload) { state.payload = payload; return chain; },
        eq(col, val) { state.filters[col] = val; return chain; },
        select() { calls.push(state); return Promise.resolve(updateResult); },
      };
      return chain;
    },
  };
}

await test('claiming swaps on the CURRENT next_run_at and advances it', async () => {
  const db = fakeDb({ data: [{ id: 's1' }], error: null });
  const row = {
    id: 's1', next_run_at: '2026-10-14T14:00:00.000Z',
    cadence_preset: 'weekdays_0700', timezone: 'America/Los_Angeles',
  };
  const now = new Date('2026-10-14T14:06:00Z');
  assert.equal(await claimSchedule(db, row, now), true);
  const call = db.calls[0];
  assert.equal(call.table, 'report_email_schedules');
  assert.equal(call.filters.id, 's1');
  assert.equal(
    call.filters.next_run_at, row.next_run_at,
    'without the compare-and-swap on the OLD next_run_at two runs both claim the row',
  );
  assert.equal(call.payload.next_run_at, '2026-10-15T14:00:00.000Z');
});

await test('a lost race is zero rows, not an error, and the row is skipped', async () => {
  // An RLS- or race-refused UPDATE succeeds with zero rows (supabase/CLAUDE.md).
  for (const data of [[], null]) {
    const db = fakeDb({ data, error: null });
    assert.equal(
      await claimSchedule(db, { id: 's1', next_run_at: 'x', cadence_preset: 'daily_0600' }, new Date()),
      false,
      'zero rows means another run owns this slot',
    );
  }
  const errDb = fakeDb({ data: null, error: { message: 'boom' } });
  await assert.rejects(
    () => claimSchedule(errDb, { id: 's1', next_run_at: 'x', cadence_preset: 'daily_0600' }, new Date()),
    /boom/,
  );
});

// ── Export paging ────────────────────────────────────────────────────────
await test('paging sends only the two arguments the live RPC takes', async () => {
  const seen = [];
  const sb = { rpc: async (fn, args) => { seen.push([fn, args]); return { data: [], error: null }; } };
  await fetchAllRows(sb, 'select 1');
  assert.deepEqual(seen, [['chat_run_readonly_query', { query: 'select 1', p_offset: 0 }]]);
  assert.ok(
    !Object.keys(seen[0][1]).includes('p_limit'),
    'p_limit would resolve to no function: the live signature is (text, integer)',
  );
  assert.equal(EXPORT_PAGE_SIZE, 1000, 'the live engine caps every page at 1000 rows');
});

await test('paging walks p_offset by the page size and stops on a short page', async () => {
  const offsets = [];
  const page = (n) => Array.from({ length: n }, (_, i) => ({ i }));
  const pages = [page(1000), page(1000), page(37)];
  const sb = {
    rpc: async (_fn, args) => {
      offsets.push(args.p_offset);
      return { data: pages.shift() ?? [], error: null };
    },
  };
  const rows = await fetchAllRows(sb, 'select 1');
  assert.deepEqual(offsets, [0, 1000, 2000]);
  assert.equal(rows.length, 2037);
});

await test('a runaway export is refused instead of filling the worker', async () => {
  const page = Array.from({ length: 1000 }, (_, i) => ({ i }));
  const sb = { rpc: async () => ({ data: page, error: null }) };
  await assert.rejects(() => fetchAllRows(sb, 'select 1', 2500), /exceeds 2,500 rows/);
  assert.equal(MAX_EXPORT_ROWS, 200000);
});

await test('an RPC error aborts the export rather than emailing a partial CSV', async () => {
  let n = 0;
  const sb = {
    rpc: async () => {
      n += 1;
      if (n === 1) return { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null };
      return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    },
  };
  await assert.rejects(() => fetchAllRows(sb, 'select 1'), /statement timeout/);
});

// ── What pauses a schedule and what does not ─────────────────────────────
await test('only the schedule\'s own faults are permanent; the world\'s are not', () => {
  for (const transient of [
    'resend 429', 'resend 503', 'HTTP 500', 'fetch failed', 'socket hang up',
    'canceling statement due to statement timeout',
    'SUPABASE_JWT_SECRET not configured for scheduled delivery',
    'invalid session', 'storage upload: timeout',
    // Two-step login refusing SILO's own scheduled token is SILO's fault, not
    // the schedule's: it paused the only live schedule on 2026-10-15.
    'Enter the code from your authenticator app to continue.',
    'mfa_required',
  ]) {
    assert.equal(isTransientDeliveryError(transient), true, `transient: ${transient}`);
  }
  for (const permanent of [
    'Report has no query at index 3', 'Report not found', 'No recipients resolved',
    'Dashboard has no exportable report widgets',
    'Export exceeds 200,000 rows; narrow the report or its filters',
    'Missing value for parameter start_date',
  ]) {
    assert.equal(isTransientDeliveryError(permanent), false, `permanent: ${permanent}`);
  }
});

await test('the handler pauses on a permanent fault only, and never writes next_run_at', () => {
  const src = read('supabase/functions/report-email-deliver/handler.mjs');
  assert.match(src, /is_paused: trigger !== 'test' && !transient/);
  assert.match(src, /const transient = isTransientDeliveryError\(msg\)/);
  // next_run_at is the sync script's lease. A second writer here hands the slot
  // back to the next run, which then delivers the same export again.
  assert.doesNotMatch(src, /next_run_at:/, 'the edge function must not write next_run_at');
  assert.doesNotMatch(src, /computeNextRunAt/, 'cadence math belongs to whoever claims the row');
});

await test('the export run restores the creator\'s active company', () => {
  const src = read('supabase/functions/report-email-deliver/handler.mjs');
  // profiles.active_company_id is persisted, not per-session: without the
  // restore, a creator in two companies finds SILO repointed every morning.
  assert.match(src, /previousCompanyId/);
  assert.match(src, /active_company_id: previousCompanyId/);
  assert.match(src, /} finally \{\s*\n\s*await run\.restore\(\);/);
  const setIdx = src.indexOf("set_active_company");
  const guardIdx = src.indexOf('if (previousCompanyId !== schedule.company_entity_id)');
  assert.ok(guardIdx > -1 && guardIdx < setIdx, 'skip the write when it already matches');
});

await test('the scheduled run\'s minted token claims aal2, and only the scheduled run mints one', () => {
  const src = read('supabase/functions/report-email-deliver/handler.mjs');
  // Two-step login (20261014000000): the PostgREST pre-request hook refuses
  // every Data API request from a session that is not aal2 when the user holds
  // a verified factor, and a token with NO `aal` claim is aal1. Drop this claim
  // and every unattended delivery for an enrolled creator fails on its first
  // read and the schedule is paused -- which is what happened on 2026-10-15.
  const payload = src.slice(src.indexOf('const payload = b64url({'), src.indexOf('const sigInput'));
  assert.match(payload, /aal: 'aal2'/, 'the minted token must assert aal2');
  assert.match(payload, /role: 'authenticated'/);
  assert.match(payload, /silo_minted: 'report-email-schedule'/,
    'the claim that tells a scheduled run from a human session in the logs');
  assert.match(payload, /exp: now \+ expSeconds/);
  assert.match(src, /signCreatorJwt\(secret, url, schedule\.created_by\)/);
  // A caller's own token is never replaced by a minted one: the manual and test
  // paths run as the human who clicked, with the session they actually hold.
  assert.match(src, /let token = userJwt;\s*\n\s*if \(!token\) \{/);
  assert.match(src, /isCron \? null : userJwt/, 'the cron path is the only one that mints');
});

await test('the admin check fails closed on an error, not only on a missing row', () => {
  const src = read('supabase/functions/report-email-deliver/handler.mjs');
  // This caller-token PostgREST read is the two-step-login gate for this
  // function (supabase/functions/CLAUDE.md): an error must abort.
  assert.match(src, /const \{ data: mem, error: memErr \}/);
  assert.match(src, /if \(memErr\) \{/);
  const authIdx = src.indexOf("error: 'authorization required'");
  const readIdx = src.indexOf("from('report_email_schedules')\n      .select('*')");
  assert.ok(authIdx > -1 && readIdx > -1 && authIdx < readIdx, 'refuse before reading the schedule');
});

await test('text an admin typed is escaped before it goes in an HTML email', () => {
  const src = read('supabase/functions/report-email-deliver/handler.mjs');
  assert.match(src, /\$\{escHtml\(title\)\}/);
  assert.match(src, /function escHtml/);
});

// ── Structural facts the feature rests on ────────────────────────────────
await test('the migration leaves the shared report engine alone', () => {
  const sql = read('supabase/migrations/20261013180000_report_email_schedules.sql');
  // verify_v2_schema.sql asserts chat_run_readonly_query has pronargs = 2, a
  // '30s' timeout and the literal 'limit 1000'. A p_limit overload fails all
  // three on the daily drift check, with messages that point nowhere near it.
  assert.doesNotMatch(sql, /create (or replace )?function public\.chat_run_readonly_query/i);
  assert.doesNotMatch(sql, /drop function if exists public\.chat_run_readonly_query/i);
  assert.doesNotMatch(sql, /p_limit integer/);

  const verify = read('supabase/verify_v2_schema.sql');
  assert.match(verify, /p\.pronargs = 2/, 'the 2-argument assertion is what the overload broke');
  assert.match(verify, /like '%30s%'/);
  assert.match(verify, /like '%limit 1000%'/);
});

await test('the migration re-maps Ask SILO\'s schema catalog and is applied in order', () => {
  const sql = read('supabase/migrations/20261013180000_report_email_schedules.sql');
  assert.match(sql, /select public\.refresh_chat_schema_catalog\(\);/);
  assert.match(sql, /select public\.attach_stamp_company_entity_id_triggers\(\);/);

  const apply = read('supabase/apply_all_post_merge.sql');
  assert.ok(apply.includes('\\i migrations/20261013180000_report_email_schedules.sql'));
  assert.ok(
    apply.trimEnd().endsWith('\\i migrations/20260922170000_record_report_catalog_cleanup.sql'),
    '20260922170000 must stay the LAST include (supabase/CLAUDE.md)',
  );
  assert.ok(read('supabase/README.md').includes('Scheduled report CSV email:'));
  assert.ok(read('supabase/verify_v2_schema.sql').includes("'Scheduled report CSV email' as check_name"));
});

await test('the cron workflow installs its dependency before running the script', () => {
  const wf = read('.github/workflows/report-email-sync.yml');
  // The first version had no install step at all, so the very first scheduled
  // run would have died on ERR_MODULE_NOT_FOUND for @supabase/supabase-js.
  const runs = wf.split('\n').filter((l) => /^\s*(- )?run:/.test(l));
  assert.ok(runs.some((l) => /npm install/.test(l)), 'the workflow must install dependencies');
  assert.ok(!runs.some((l) => /npm ci/.test(l)), 'there is no root package-lock.json');
  assert.match(read('scripts/report-email-sync.mjs'), /from '@supabase\/supabase-js'/);
  // Slots cover 6:00 and 7:00 company-time under both PDT and PST.
  assert.match(wf, /cron: '5 13,14,15,18,23 \* \* \*'/);
  // A concurrency group with cancel-in-progress:false silently drops a QUEUED
  // scheduled run, and the claim already makes overlap harmless.
  assert.ok(!/^concurrency:/m.test(wf), 'no concurrency group (scripts/CLAUDE.md)');
});

await test('no workflow in this repo runs on a Node older than 22', () => {
  // @supabase/supabase-js 2.117 declares engines node >= 22, and on 20 the
  // failure is not the version warning you would expect -- createClient throws
  // "Node.js detected but native WebSocket not found" before the first query,
  // so the job dies having done nothing. There is no root package-lock.json,
  // so `npm install` always resolves the newest supabase-js and any workflow
  // pinned to 20 breaks the moment it next runs, whatever worked before.
  // Caught on the first real run of report-email-sync, 2026-10-14; the same
  // one-line defect was sitting in one-time-sales-backfill.yml.
  const dir = join(ROOT, '.github', 'workflows');
  const stale = [];
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const m of text.matchAll(/node-version:\s*['"]?(\d+)/g)) {
      if (Number(m[1]) < 22) stale.push(`${name} -> ${m[1]}`);
    }
  }
  assert.deepEqual(stale, [], `pin these to 22 or later: ${stale.join(', ')}`);
});

await test('report-email-deliver keeps verify_jwt ON: both callers send a JWT', () => {
  const deploy = read('.github/workflows/deploy-edge-function.yml');
  const line = deploy.split('\n').find((l) => l.includes('NO_JWT_FUNCTIONS='));
  assert.ok(line, 'NO_JWT_FUNCTIONS line is gone');
  assert.ok(
    !line.includes('report-email-deliver'),
    'the cron sends the service-role key and the browser sends the user session; '
    + 'listing it here would make a JWT-minting function publicly reachable for nothing',
  );
  // And both callers do send one.
  assert.match(read('scripts/report-email-sync.mjs'), /Authorization: `Bearer \$\{key\}`/);
  assert.match(read('v3/js/report-email-schedule.js'), /Authorization: `Bearer \$\{sess\.access_token\}`/);
});

await test('company roles come from the membership, not the legacy global role', () => {
  const src = read('v3/js/report-email-schedule.js');
  const memIdx = src.indexOf("from('entity_memberships')");
  const profIdx = src.indexOf("from('profiles')");
  assert.ok(memIdx > -1 && profIdx > -1 && memIdx < profIdx,
    'the per-company membership decides; profiles.role is only the no-membership fallback');
  assert.ok(!/\['owner', 'executive'\]/.test(src),
    'a global executive is not an admin of every company, and is_entity_admin() does not agree');
});

await test('the vendored copies are byte-identical to their originals', () => {
  // supabase/functions/CLAUDE.md: "Verbatim copies are pinned by tests."
  const original = read('scripts/lib/report-email-deliver-core.mjs');
  const copy = read('supabase/functions/report-email-deliver/lib/report-email-deliver-core.mjs');
  const IMPORT = "import { SiloReportParams } from '../../supabase/functions/silo-chat/report-params-lib.mjs';";
  const COPY_IMPORT = "import { SiloReportParams } from './report-params-lib.mjs';";
  assert.ok(original.includes(IMPORT), 'the original import line moved');
  assert.ok(copy.includes(COPY_IMPORT), 'the vendored import line moved');
  assert.equal(
    copy.replace(COPY_IMPORT, IMPORT), original,
    'edit scripts/lib/report-email-deliver-core.mjs and re-copy it; never edit only the copy',
  );
  assert.equal(
    read('supabase/functions/report-email-deliver/lib/report-params-lib.mjs'),
    read('supabase/functions/silo-chat/report-params-lib.mjs'),
    'report-params-lib.mjs is vendored from silo-chat and must stay byte-exact',
  );
});

// ── The helpers the first version did test ───────────────────────────────
await test('query selection, CSV shaping, subject and labels', () => {
  assert.equal(defaultQueryIndex(['select 1 from information_schema.tables', 'select 2 as n']), 1);
  assert.equal(defaultQueryIndex([]), 0);
  assert.deepEqual(
    queryIndicesForSchedule({ target_kind: 'report', query_indices: [0, 2] }, { queries_run: ['a', 'b', 'c'] }),
    [0, 2],
  );
  assert.equal(queryIndicesForSchedule({ target_kind: 'dashboard' }, {}), null);
  assert.match(renderSubject(null, { title: 'Daily Sales', company: 'Acme', date: '2026-10-13' }), /Daily Sales/);
  assert.equal(cadenceLabel('weekdays_0700'), 'Weekdays 7:00');
  const csv = rowsToCsv([{ a: 1, b: 'x,y' }, { a: null, b: 'he said "hi"' }]);
  assert.equal(csv, 'a,b\n1,"x,y"\n,"he said ""hi"""');
  assert.equal(rowsToCsv([]), '');
  assert.equal(sanitizeFilename('Q3 / Sales: north'), 'Q3_Sales_north');
});

console.log(`\n${ran - failures}/${ran} passed`);
if (failures) process.exit(1);
