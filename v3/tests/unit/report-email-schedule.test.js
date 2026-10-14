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
const U = g.SiloReportEmailScheduleUI;
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

  // ── outside recipients ──────────────────────────────────────────────────
  {
    const { emails, invalid } = S.parseEmailList('A@B.com, a@b.com;  x@y.co\nbuyer@store.co.uk');
    assert.deepEqual(emails, ['a@b.com', 'x@y.co', 'buyer@store.co.uk'],
      'commas, semicolons and newlines all separate; case and duplicates collapse');
    assert.deepEqual(invalid, []);
  }
  for (const bad of ['nope', 'bad@', '@nope.com', 'two@at@signs.com', 'no@tld']) {
    assert.deepEqual(S.parseEmailList(bad).emails, [], `${bad} is not an address`);
    assert.equal(S.parseEmailList(bad).invalid.length, 1, `${bad} is reported, not dropped`);
  }
  assert.deepEqual(S.parseEmailList('').emails, []);
  assert.deepEqual(S.parseEmailList(null).emails, []);

  // readRecipients turns the box into {kind:'email'} entries, and refuses a
  // typo where it can still be corrected rather than at send time.
  const fakeRoot = (vals) => ({
    querySelector: (sel) => {
      if (sel === '#resAdmins') return { checked: !!vals.admins };
      if (sel === '#resExternal') return { value: vals.external || '' };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-dept]') return (vals.depts || []).map((d) => ({ checked: true, getAttribute: () => d }));
      if (sel === '[data-profile]') return (vals.profiles || []).map((p) => ({ checked: true, getAttribute: () => p }));
      return [];
    },
  });
  assert.deepEqual(U.readRecipients(fakeRoot({ admins: true, external: 'cpa@firm.com' })),
    [{ kind: 'workspace_admins' }, { kind: 'email', value: 'cpa@firm.com' }]);
  assert.deepEqual(U.readRecipients(fakeRoot({ external: 'a@b.com, c@d.com' })),
    [{ kind: 'email', value: 'a@b.com' }, { kind: 'email', value: 'c@d.com' }],
    'outside addresses alone are a valid list -- no silent fallback to admins');
  assert.deepEqual(U.readRecipients(fakeRoot({})), [{ kind: 'workspace_admins' }],
    'an empty form still has a recipient');
  assert.throws(() => U.readRecipients(fakeRoot({ external: 'typo@' })), /Not an email address/);

  // The panel round-trips what is stored, so editing does not silently drop
  // the outside addresses already on a schedule.
  {
    const html = U.renderPanel({ title: 'R', scheduleId: 'S1', members: [],
      recipients: [{ kind: 'workspace_admins' }, { kind: 'email', value: 'cpa@firm.com' }] });
    assert.ok(html.includes('cpa@firm.com'), 'stored addresses are prefilled');
    assert.ok(/Edit scheduled email/.test(html), 'an existing schedule says it is being edited');
    assert.ok(!/Edit scheduled email/.test(U.renderPanel({ title: 'R', members: [] })));
  }

  assert.equal(S.recipientSummary([{ kind: 'workspace_admins' }, { kind: 'department', value: 'finance' },
    { kind: 'profile', id: 'u1' }, { kind: 'email', value: 'cpa@firm.com' }], [{ id: 'u1', name: 'Jess' }]),
    'All workspace admins · finance department · Jess · cpa@firm.com',
    'the manage table says who in words, not raw JSON');
  assert.equal(S.recipientSummary([], []), 'No one');

  // ── the manage table ────────────────────────────────────────────────────
  {
    const html = U.renderManageTable([{
      id: 'S1', target_title: 'Wholesale Tracking', target_kind: 'report',
      cadence_preset: 'weekdays_0700', recipients: [{ kind: 'profile', id: 'u1' }],
      last_run_at: '2026-10-14T05:14:28Z', last_run_status: 'succeeded',
      next_run_at: '2026-10-14T14:00:00Z', is_active: true, is_paused: false,
    }], [{ id: 'u1', name: 'Blake' }]);
    assert.ok(html.includes('Every weekday'), 'the cadence is a label, not weekdays_0700');
    assert.ok(!html.includes('weekdays_0700'), 'and the raw preset never reaches the page');
    assert.ok(html.includes('Blake'), 'recipients are named');
    assert.ok(!html.includes('{"kind"'), 'no raw JSON in a cell');
    assert.ok(html.includes('bcn-th-left'), 'headers are left-aligned -- Beacon th defaults to right');
    for (const attr of ['data-edit', 'data-run', 'data-dup', 'data-del']) {
      assert.ok(html.includes(attr), `${attr} action is present`);
    }
    const never = U.renderManageTable([{ id: 'S2', target_title: 'X', cadence_preset: 'daily_0600', recipients: [] }], []);
    assert.ok(never.includes('Not sent yet'), 'a schedule that has never run says so');
  }

  // ── the panel edits the schedule a report already has ───────────────────
  // Two Saves used to mean two schedules, both firing the same morning,
  // because the panel only ever inserted.
  {
    const existing = {
      id: 'S1', report_id: 'R1', cadence_preset: 'monday_0700', timezone: 'America/New_York',
      subject_template: 'Weekly', allow_member_subscribe: true, is_active: true,
      recipients: [{ kind: 'email', value: 'cpa@firm.com' }],
    };
    const asked = [];
    const sb = {
      from(table) {
        const q = {
          select() { return q; },
          eq(col, val) { asked.push([table, col, val]); return q; },
          order() { return q; }, limit() { return q; }, in() { return q; },
          maybeSingle: async () => ({ data: { role: 'owner_admin' }, error: null }),
          then(res, rej) {
            return Promise.resolve(
              table === 'report_email_schedules_v' ? { data: [existing], error: null }
                : { data: [], error: null },
            ).then(res, rej);
          },
        };
        return q;
      },
    };
    const rootStub = { querySelector: () => null, querySelectorAll: () => [] };
    let html = '';
    const host = {
      hidden: true,
      set innerHTML(v) { html = v; },
      get innerHTML() { return html; },
      querySelector: (sel) => (sel === '.res-panel' ? rootStub : null),
    };
    const ctx = { reportId: 'R1', title: 'Wholesale Tracking', timezone: 'America/Los_Angeles' };
    await M.openReportPanel({ sb, userId: 'u1', companyId: 'C1', hostEl: host, onStatus: () => {}, context: ctx });
    assert.ok(asked.some(([t, c, v]) => t === 'report_email_schedules_v' && c === 'report_id' && v === 'R1'),
      'the panel looks for a schedule this report already has');
    assert.ok(html.includes('cpa@firm.com'), 'and opens on it, outside addresses and all');
    assert.ok(html.includes('Weekly'), 'with its stored subject');
    assert.ok(/Edit scheduled email/.test(html), 'and says it is editing, not creating');
    assert.equal(host.hidden, false);
  }
  // A report with no schedule yet opens a blank panel, not an error.
  {
    const sb = {
      from(table) {
        const q = {
          select() { return q; }, eq() { return q; }, order() { return q; },
          limit() { return q; }, in() { return q; },
          maybeSingle: async () => ({ data: { role: 'admin' }, error: null }),
          then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
        };
        return q;
      },
    };
    const rootStub = { querySelector: () => null, querySelectorAll: () => [] };
    let html = '';
    const host = {
      hidden: true,
      set innerHTML(v) { html = v; },
      get innerHTML() { return html; },
      querySelector: (sel) => (sel === '.res-panel' ? rootStub : null),
    };
    await M.openReportPanel({ sb, userId: 'u1', companyId: 'C1', hostEl: host, onStatus: () => {},
      context: { reportId: 'R9', title: 'New one' } });
    assert.ok(/Email CSV on schedule/.test(html) && !/Edit scheduled email/.test(html));
  }

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
