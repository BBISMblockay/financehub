/* Scheduled report CSV email: how the panel reads people, and the rule that a
 * click on "Email CSV on schedule" always produces a panel or a reason.
 *
 * The bug this suite exists for: listMembers asked PostgREST to embed
 * profiles under entity_memberships. There is no foreign key between those
 * two tables (entity_memberships.user_id references auth.users), so the
 * request was a 400 PGRST200 for every caller, the rejection escaped the
 * click handler, and the button did nothing at all. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadV3, REPO_ROOT } = require('../lib/load');

const g = loadV3(['report-email-schedule.js', 'report-email-schedule-ui.js', 'report-email-schedule-mount.js']);
const S = g.SiloReportEmailSchedule;
const M = g.SiloReportEmailScheduleMount;

/** A Supabase stand-in that records every select string it is handed. */
function fakeDb(tables, singles = {}) {
  const selects = [];
  const db = {
    selects,
    from(table) {
      const q = {
        select(cols) { selects.push([table, cols]); return q; },
        eq() { return q; },
        in() { return q; },
        maybeSingle: async () => singles[table] || { data: null, error: null },
        then(res, rej) { return Promise.resolve(tables[table] || { data: [], error: null }).then(res, rej); },
      };
      return q;
    },
  };
  return db;
}

(async () => {
  // ── listMembers reads the two tables separately and joins in JS ──────────
  const db = fakeDb({
    entity_memberships: { data: [
      { user_id: 'u1', role: 'owner_admin' },
      { user_id: 'u2', role: 'member' },
      { user_id: 'u3', role: 'member' },   // inactive
      { user_id: 'u4', role: 'viewer' },   // no email
      { user_id: 'u5', role: 'member' },   // no profile row at all
    ], error: null },
    profiles: { data: [
      { id: 'u1', name: 'Blake', email: 'blake@example.test', department: 'finance', is_active: true },
      { id: 'u2', name: 'Jess', email: 'jess@example.test', department: 'ops' },
      { id: 'u3', name: 'Gone', email: 'gone@example.test', is_active: false },
      { id: 'u4', name: 'No Mail', email: null },
    ], error: null },
  });
  const members = await S.listMembers(db, 'C1');
  assert.deepEqual(members.map((m) => m.id), ['u1', 'u2'],
    'inactive, email-less and profile-less memberships are dropped');
  assert.equal(members[0].role, 'owner_admin', 'the role comes from the membership, not the profile');
  assert.equal(members[1].department, 'ops', 'is_active undefined still counts as active');

  assert.ok(db.selects.some(([t]) => t === 'entity_memberships'), 'reads entity_memberships');
  assert.ok(db.selects.some(([t]) => t === 'profiles'), 'reads profiles separately');
  for (const [table, cols] of db.selects) {
    assert.ok(!/\(/.test(String(cols)),
      `no PostgREST embed is possible between these tables; got ${table}:${cols}`);
  }
  for (const [, cols] of db.selects) {
    assert.ok(!/\w+\s*:/.test(String(cols)), `no embed alias; got ${cols}`);
  }

  // A company with no members never issues the second read with an empty IN.
  const empty = fakeDb({ entity_memberships: { data: [], error: null } });
  assert.deepEqual(await S.listMembers(empty, 'C1'), []);
  assert.ok(!empty.selects.some(([t]) => t === 'profiles'), 'no profiles read for an empty company');
  assert.deepEqual(await S.listMembers(db, null), [], 'no company id, no reads');

  // Either read failing surfaces as a rejection carrying a message the caller
  // can show. PostgREST errors are plain objects, not Errors, which is why
  // the mount reads e?.message rather than assuming an Error.
  const rejectsWith = async (fn, needle) => {
    try { await fn(); } catch (e) {
      assert.ok(String(e && e.message).includes(needle), `expected ${needle}, got ${e && e.message}`);
      return;
    }
    assert.fail(`expected a rejection mentioning ${needle}`);
  };
  await rejectsWith(
    () => S.listMembers(fakeDb({ entity_memberships: { data: null, error: { message: 'permission denied' } } }), 'C1'),
    'permission denied');
  await rejectsWith(
    () => S.listMembers(fakeDb({
      entity_memberships: { data: [{ user_id: 'u1', role: 'admin' }], error: null },
      profiles: { data: null, error: { message: 'profiles blocked' } },
    }), 'C1'),
    'profiles blocked');

  // ── a click never fails silently ────────────────────────────────────────
  const said = [];
  const onStatus = (msg, type) => said.push([msg, type]);
  const host = { hidden: true, innerHTML: '', querySelector: () => null };

  // Not an admin: a message, and the panel stays shut.
  said.length = 0;
  await M.openReportPanel({
    sb: fakeDb({ entity_memberships: { data: null, error: null }, profiles: { data: null, error: null } }),
    userId: 'u1', companyId: 'C1', hostEl: host, onStatus, context: { title: 'R' },
  });
  assert.equal(said.length, 1, 'the non-admin path says so');
  assert.ok(/workspace admins/i.test(said[0][0]), said[0][0]);
  assert.equal(host.hidden, true, 'nothing was mounted');

  // The members read failing: the message is the error, not silence. This is
  // the exact shape of the PGRST200 failure that made the button dead.
  said.length = 0;
  const broken = {
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; },
        maybeSingle: async () => ({ data: { role: 'owner_admin' }, error: null }),
        then(res, rej) {
          return Promise.resolve(table === 'entity_memberships'
            ? { data: null, error: { message: "Could not find a relationship between 'entity_memberships' and 'profiles' in the schema cache" } }
            : { data: [], error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  await M.openReportPanel({
    sb: broken, userId: 'u1', companyId: 'C1', hostEl: host, onStatus, context: { title: 'R' },
  });
  assert.equal(said.length, 1, 'a failed read is reported, not swallowed');
  assert.ok(/relationship/.test(said[0][0]), said[0][0]);
  assert.equal(said[0][1], 'neg');

  // A host element that is not on the page: still a message.
  said.length = 0;
  g.document.getElementById = () => null;
  await M.openReportPanel({
    sb: fakeDb(
      { entity_memberships: { data: [], error: null }, profiles: { data: [], error: null } },
      { entity_memberships: { data: { role: 'owner_admin' }, error: null } },
    ),
    userId: 'u1', companyId: 'C1', onStatus, context: { title: 'R' },
  });
  assert.equal(said.length, 1, 'a missing host is reported');
  assert.ok(/schedule panel/i.test(said[0][0]), said[0][0]);

  // The panel rendering but producing no root: still a message, and the host
  // is left closed rather than half-open.
  said.length = 0;
  const blind = { hidden: true, innerHTML: '', querySelector: () => null };
  await M.openReportPanel({
    sb: fakeDb(
      { entity_memberships: { data: [], error: null }, profiles: { data: [], error: null } },
      { entity_memberships: { data: { role: 'admin' }, error: null } },
    ),
    userId: 'u1', companyId: 'C1', hostEl: blind, onStatus, context: { title: 'R' },
  });
  assert.equal(said.length, 1, 'a panel that does not render is reported');
  assert.equal(blind.hidden, true, 'the host is closed again');
  assert.equal(blind.innerHTML, '', 'and emptied');

  // ── repo guard: nothing may embed profiles under entity_memberships ──────
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { if (!/^(node_modules|legacy|\.git)$/.test(name)) walk(full); continue; }
      if (!/\.(js|html)$/.test(name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // A .select() on entity_memberships that embeds profiles. Embedding
      // entities is fine -- entity_id does have a foreign key.
      for (const m of text.matchAll(/entity_memberships'\)[\s\S]{0,160}?\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
        if (/profiles\s*\(/.test(m[2])) offenders.push(`${path.relative(REPO_ROOT, full)}: ${m[2]}`);
      }
    }
  };
  for (const dir of ['v2', 'v3', 'pages']) walk(path.join(REPO_ROOT, dir));
  assert.deepEqual(offenders, [],
    'entity_memberships has no foreign key to profiles (user_id references auth.users); read the two tables separately');

  console.log('Scheduled report email: member list reads, non-silent failures, embed guard passed.');
})().catch((e) => { console.error(e); process.exit(1); });
