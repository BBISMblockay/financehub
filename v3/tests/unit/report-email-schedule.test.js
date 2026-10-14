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

// report-params.js and filter-bar.js come first: the period picker pairs the
// report's date declarations through them, and loading the schedule modules
// without them exercises the "no picker" path instead of the real one.
const g = loadV3(['report-params.js', 'field-semantics.js', 'metrics.js', 'chart-adapter.js',
  'filter-bar.js', 'report-email-schedule.js', 'report-email-schedule-ui.js',
  'report-email-schedule-mount.js']);
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

  // ── what Edit and Send test are allowed to write ────────────────────────
  // Both of these were found in review: an UPDATE sends only the keys it
  // carries, so a key written carelessly changes stored behaviour, and a key
  // left out preserves it.
  {
    // A panel opened from the schedules table has no query metadata, so it
    // renders no query checkboxes. That is NOT the same as "no parts picked".
    const noBoxes = { querySelectorAll: () => [] };
    assert.equal(U.readQueryIndices(noBoxes), undefined, 'no controls rendered');
    const boxes = (picked) => ({
      querySelectorAll: () => [0, 1, 2].map((i) => ({ checked: picked.includes(i), getAttribute: () => String(i) })),
    });
    assert.deepEqual(U.readQueryIndices(boxes([1])), [1]);
    assert.equal(U.readQueryIndices(boxes([])), null, 'controls rendered but none ticked is a real choice');

    // Drive the panel's own Save and Send test handlers and read the payload
    // that reaches the database.
    const openPanel = async (existing, click, formCadence) => {
      const writes = [];
      const handlers = {};
      const rootStub = {
        querySelector: (sel) => {
          if (sel === '#resSave' || sel === '#resTest') {
            return { addEventListener: (_e, fn) => { handlers[sel] = fn; } };
          }
          if (sel === '#resClose') return { addEventListener: () => {} };
          if (sel === '.res-cadence') return { value: formCadence || existing.cadence_preset };
          if (sel === '.res-subject') return { value: 'Subject' };
          if (sel === '#resSubscribe') return { checked: false };
          if (sel === '#resActive') return { checked: existing.is_active !== false };
          if (sel === '#resExternal') return { value: '' };
          if (sel === '#resAdmins') return { checked: true };
          return null;
        },
        querySelectorAll: () => [],
      };
      let html = '';
      const host = {
        hidden: true,
        set innerHTML(v) { html = v; }, get innerHTML() { return html; },
        querySelector: (sel) => (sel === '.res-panel' ? rootStub : null),
      };
      const sb = {
        auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
        rpc: async () => ({ data: null, error: null }),
        from(table) {
          const q = {
            select() { return q; }, eq() { return q; }, order() { return q; },
            limit() { return q; }, in() { return q; },
            update(payload) { writes.push(['update', payload]); return q; },
            insert(payload) { writes.push(['insert', payload]); return q; },
            maybeSingle: async () => (writes.length
              ? { data: { id: existing.id }, error: null }
              : { data: { role: 'owner_admin' }, error: null }),
            single: async () => ({ data: { id: existing.id }, error: null }),
            then(res, rej) {
              return Promise.resolve(table === 'report_email_schedules_v'
                ? { data: [existing], error: null } : { data: [], error: null }).then(res, rej);
            },
          };
          return q;
        },
      };
      g.fetch = async () => ({ ok: true, json: async () => ({}) });
      g.__SILO_CONFIG__ = { SUPABASE_URL: 'https://x.test', SUPABASE_ANON_KEY: 'k' };
      await M.openReportPanel({ sb, userId: 'u1', companyId: 'C1', hostEl: host,
        onStatus: () => {}, context: { reportId: existing.report_id, title: 'R' } });
      await handlers[click]();
      return writes;
    };

    const stored = {
      id: 'S1', report_id: 'R1', cadence_preset: 'weekdays_0700', timezone: 'America/Los_Angeles',
      subject_template: 'Subject', recipients: [{ kind: 'workspace_admins' }],
      query_indices: [1], is_active: false, is_paused: true,
      // Deliberately not a time this cadence would compute today: the point
      // is that a test send leaves the stored time alone, and a fixture that
      // happens to match what computeNextRunAt returns proves nothing.
      next_run_at: '2026-11-20T15:00:00.000Z', allow_member_subscribe: false,
    };

    const saved = await openPanel(stored, '#resSave');
    assert.equal(saved[0][0], 'update', 'an existing schedule is updated, not inserted again');
    assert.ok(!('query_indices' in saved[0][1]),
      'Save leaves a stored query subset alone when the panel rendered no query controls');
    assert.equal(saved[0][1].is_active, false, 'Save writes what the form says');
    assert.equal(saved[0][1].is_paused, false, 'and Save is the thing that resumes a schedule');

    const tested = await openPanel(stored, '#resTest');
    assert.equal(tested[0][0], 'update');
    assert.ok(!('is_active' in tested[0][1]),
      'a test must not switch an off schedule back on');
    assert.ok(!('is_paused' in tested[0][1]), 'nor resume a paused one');
    assert.ok(!('query_indices' in tested[0][1]), 'nor widen what the export covers');
    assert.equal(tested[0][1].next_run_at, stored.next_run_at,
      'nor push the next real send to tomorrow');

    // Changing the cadence and then testing DOES have to move the next run,
    // or the schedule keeps firing on the old rhythm until someone saves.
    const recadenced = await openPanel(stored, '#resTest', 'monday_0700');
    assert.notEqual(recadenced[0][1].next_run_at, stored.next_run_at);
    assert.equal(recadenced[0][1].cadence_preset, 'monday_0700');

    // A brand-new schedule still gets every column set explicitly.
    const fresh = await openPanel({ ...stored, id: undefined, report_id: 'R9', is_active: true }, '#resTest');
    assert.equal(fresh[0][0], 'insert');
    assert.equal(fresh[0][1].is_active, true);
    assert.equal(fresh[0][1].is_paused, false);
    assert.equal(fresh[0][1].query_indices, null);
  }

  // ── the period a schedule sends ─────────────────────────────────────────
  // The point of the whole feature: a recurring export must send the period
  // it is defined for, worked out on the morning it runs, not the window
  // someone happened to be looking at when they created it.
  {
    const DECLS = [
      { key: 'date_from', type: 'date', label: 'From', date_basis: 'company', default: 'today-28d' },
      { key: 'date_to', type: 'date', label: 'Through', date_basis: 'company', default: 'today-1d' },
    ];
    const keys = S.dateRangeKeys(DECLS);
    assert.deepEqual(keys, { from: 'date_from', to: 'date_to' },
      'company-calendar dates still pair into one window for the picker');

    // The filter bar deliberately does NOT pair these into a range control,
    // because it prints the resolved window and the viewer's calendar is not
    // the company's. The picker stores tokens and prints nothing, so it does.
    assert.ok(!g.SiloFilterBar.groupDeclarations(DECLS).some((x) => x.kind === 'range'),
      'the filter bar leaves company-calendar dates as single controls');

    assert.equal(S.dateRangeKeys([{ key: 'cover_weeks', type: 'number', label: 'W' }]), null,
      'a report with no date window has no period to pick');
    assert.equal(S.dateRangeKeys([]), null);
    assert.equal(S.dateRangeKeys(undefined), null);

    // Picking a period writes TOKENS, which is what makes the next send roll
    // forward. A literal date here would be the bug.
    const applied = S.applyPeriod({ platform: 'meta_ads', date_from: '2026-09-01', date_to: '2026-09-30' },
      keys, 'prior_month');
    assert.equal(applied.date_from, 'prior_month_start');
    assert.equal(applied.date_to, 'prior_month_end');
    assert.equal(applied.platform, 'meta_ads', 'a non-date parameter is left alone');

    // Every offered period must round-trip: choose it, read it back, get the
    // same id. A preset whose tokens the matcher does not recognise would
    // silently display as "use the page filters" after one save.
    for (const opt of S.periodOptions()) {
      if (opt.id === S.USE_PAGE_FILTERS) continue;
      const state = S.applyPeriod({}, keys, opt.id);
      assert.equal(S.periodIdFor(state, keys), opt.id, `${opt.id} does not round-trip`);
      for (const v of [state[keys.from], state[keys.to]]) {
        assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(v), `${opt.id} stored a fixed date: ${v}`);
        assert.ok(g.SiloReportParams.resolveDateExpr(v), `${opt.id} stored an unresolvable token: ${v}`);
      }
    }
    assert.ok(S.periodOptions().some((p) => p.id === 'prior_month' && /last month/i.test(p.label)),
      'the prior-month period Blake asked for is offered');

    // Prior month is the COMPLETE previous month on the company calendar --
    // not month-to-date, which on the 1st is a single day.
    {
      const state = S.applyPeriod({}, keys, 'prior_month');
      const P = g.SiloReportParams;
      const sub = P.substitute('select {{date_from}}, {{date_to}}', DECLS, state);
      assert.ok(!sub.error, sub.error);
      assert.ok(/silo_business_today\(\)/.test(sub.sql), sub.sql);
      assert.ok(!/prior_month/.test(sub.sql), `the token leaked into SQL: ${sub.sql}`);
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(sub.sql), `a date was frozen into SQL: ${sub.sql}`);
    }

    // Leaving the picker on "page filters" must not rewrite anything, and a
    // report with no date keys must not have parameters invented for it.
    const untouched = { date_from: '2026-09-01', date_to: '2026-09-30' };
    assert.deepEqual(S.applyPeriod(untouched, keys, S.USE_PAGE_FILTERS), untouched);
    assert.deepEqual(S.applyPeriod(untouched, keys, undefined), untouched);
    assert.deepEqual(S.applyPeriod(untouched, null, 'prior_month'), untouched,
      'no date window, no rewrite');
    assert.deepEqual(S.applyPeriod(untouched, keys, 'no_such_period'), untouched);

    // Fixed dates are named as fixed, in the panel and in the table, because
    // that is the row someone has to notice.
    assert.ok(/fixed/i.test(S.periodSummary(untouched, keys)));
    assert.equal(S.periodSummaryFromState(untouched), 'Fixed dates');
    assert.equal(S.periodSummaryFromState({ date_from: 'prior_month_start', date_to: 'prior_month_end' }),
      'Last month');
    assert.equal(S.periodSummaryFromState({}), 'Report default');
    assert.equal(S.periodSummaryFromState(null), 'Report default');
    assert.equal(S.periodSummaryFromState({ platform: 'meta_ads' }), 'Report default',
      'a non-date parameter is not a period');
    assert.equal(S.periodSummaryFromState({ date_from: 'today-28d', date_to: 'today-1d' }), 'Rolling');

    // A panel that rendered no period control reports undefined, so the save
    // path leaves parameter_state alone -- the same rule as query_indices.
    assert.equal(U.readPeriodId({ querySelector: () => null }), undefined);
    assert.equal(U.readPeriodId({ querySelector: () => ({ value: 'prior_month' }) }), 'prior_month');

    // The control renders only when there is a window to set.
    const withDates = U.renderPanel({ title: 'R', dateKeys: keys, parameter_state: {} });
    assert.ok(/res-period/.test(withDates) && /Period to send/.test(withDates));
    assert.ok(/Last month/.test(withDates), 'the prior-month option is in the markup');
    assert.ok(!/res-period/.test(U.renderPanel({ title: 'R', dateKeys: null })),
      'a report with no dates gets no period control');

    // A schedule already pinned to fixed dates says so in the panel.
    const frozenPanel = U.renderPanel({ title: 'R', dateKeys: keys, parameter_state: untouched });
    assert.ok(/2026-09-01 → 2026-09-30 \(fixed\)/.test(frozenPanel), frozenPanel);

    // The table's Period column reads parameter_state alone (no second read
    // per row), and its header count matches the stated column widths.
    const table = U.renderManageTable([{
      id: 'S1', target_title: 'Daily Sales', cadence_preset: 'monday_0700',
      parameter_state: untouched, recipients: [], is_active: true,
    }], []);
    assert.ok(/<th[^>]*>Period<\/th>/.test(table), 'the table has a Period column');
    assert.ok(/res-tag--neg">Fixed dates/.test(table), 'a frozen schedule is flagged in the table');
    const cols = (table.match(/<th[\s>]/g) || []).length;
    // table-layout is fixed, so a column with no stated width collapses.
    // Read the widths out of the stylesheet rather than trusting a number
    // written here: the two drift the moment a column is added.
    const css = fs.readFileSync(path.join(REPO_ROOT, 'v3', 'dashboard.css'), 'utf8');
    const widths = [...css.matchAll(/\.res-table th:nth-child\((\d+)\)[^{]*\{\s*width:\s*(\d+)%/g)];
    assert.equal(cols, 8, 'Report, How often, Period, Goes to, Last sent, Next, Status, Actions');
    assert.deepEqual(widths.map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7],
      'every column but the last states a width');
    const total = widths.reduce((n, m) => n + Number(m[2]), 0);
    assert.ok(total > 0 && total <= 95, `stated widths total ${total}%, leaving nothing for actions`);
  }

  // ── reopening a schedule must not adopt the page's window ───────────────
  // Found in review of the period picker. The panel's existing-schedule
  // merge restored cadence, recipients and subject from the stored row but
  // NOT parameter_state, so the period was derived from whatever the report
  // page's filter bar happened to show. Save a schedule as Last month,
  // reopen that report on a different window, change only the subject or
  // send a test, and the saved period was silently replaced.
  {
    const keys = { from: 'date_from', to: 'date_to' };
    const DECLS = [
      { key: 'date_from', type: 'date', label: 'From', date_basis: 'company', default: 'today-28d' },
      { key: 'date_to', type: 'date', label: 'Through', date_basis: 'company', default: 'today-1d' },
    ];
    const storedState = { date_from: 'prior_month_start', date_to: 'prior_month_end' };
    const pageState = { date_from: '2026-10-01', date_to: '2026-10-13' };

    // The two sentinels mean different things, and that is the whole fix.
    assert.deepEqual(S.applyPeriod(storedState, keys, S.KEEP_WINDOW, pageState), storedState,
      'keeping the window leaves the stored tokens exactly as they are');
    assert.deepEqual(S.applyPeriod(storedState, keys, S.USE_PAGE_FILTERS, pageState), pageState,
      'and the page option, picked by name, is the one thing that adopts the page');
    assert.deepEqual(
      S.applyPeriod({ ...storedState, location: 'st_louis' }, keys, S.USE_PAGE_FILTERS,
        { ...pageState, location: 'portland' }),
      { ...pageState, location: 'st_louis' },
      'only the two date keys come from the page; the rest belongs to the schedule');
    assert.deepEqual(S.applyPeriod(storedState, keys, S.USE_PAGE_FILTERS, null), storedState,
      'Edit from the schedules table has no page, so the page option cannot erase a window');

    // An existing schedule defaults to keeping its own window; a new one to
    // the page's filters, which are already what its state holds.
    assert.equal(S.periodIdFor({ date_from: '2026-01-01', date_to: '2026-01-31' }, keys,
      { editing: true }), S.KEEP_WINDOW);
    assert.equal(S.periodIdFor({ date_from: '2026-01-01', date_to: '2026-01-31' }, keys), S.USE_PAGE_FILTERS);
    assert.equal(S.periodIdFor(storedState, keys, { editing: true }), 'prior_month',
      'a stored named period is still recognised as that period');

    // The option list never offers a page the panel does not have.
    const editOpts = S.periodOptions({ editing: true, hasPageState: true });
    assert.equal(editOpts[0].id, S.KEEP_WINDOW, 'keeping the stored window is the default');
    assert.equal(editOpts[editOpts.length - 1].id, S.USE_PAGE_FILTERS);
    assert.ok(!S.periodOptions({ editing: true, hasPageState: false })
      .some((o) => o.id === S.USE_PAGE_FILTERS),
    'Edit from the schedules table is not offered filters it cannot read');
    assert.equal(S.periodOptions({ editing: false, hasPageState: true })[0].id, S.USE_PAGE_FILTERS);

    // Now the mounted panel, end to end: stored period and page period
    // differ, and neither Save nor Send test may replace the stored one.
    const stored = {
      id: 'S7', report_id: 'R7', cadence_preset: 'monday_0700', timezone: 'America/Los_Angeles',
      subject_template: 'Monthly', recipients: [{ kind: 'workspace_admins' }],
      query_indices: null, is_active: true, is_paused: false,
      next_run_at: '2026-11-02T15:00:00.000Z', allow_member_subscribe: false,
      parameter_state: storedState,
    };
    const drive = async (click, pickPeriod) => {
      const writes = [];
      const handlers = {};
      let periodValue = null;
      const rootStub = {
        querySelector: (sel) => {
          if (sel === '#resSave' || sel === '#resTest') {
            return { addEventListener: (_e, fn) => { handlers[sel] = fn; } };
          }
          if (sel === '#resClose') return { addEventListener: () => {} };
          if (sel === '.res-cadence') return { value: stored.cadence_preset };
          // The one field the person actually came to change.
          if (sel === '.res-subject') return { value: 'Monthly (renamed)' };
          if (sel === '.res-period') return { value: periodValue };
          if (sel === '#resSubscribe') return { checked: false };
          if (sel === '#resActive') return { checked: true };
          if (sel === '#resExternal') return { value: '' };
          if (sel === '#resAdmins') return { checked: true };
          return null;
        },
        querySelectorAll: () => [],
      };
      let html = '';
      const host = {
        hidden: true,
        set innerHTML(v) { html = v; }, get innerHTML() { return html; },
        querySelector: (sel) => (sel === '.res-panel' ? rootStub : null),
      };
      const sb = {
        auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
        rpc: async () => ({ data: null, error: null }),
        from(table) {
          const q = {
            select() { return q; }, eq() { return q; }, order() { return q; },
            limit() { return q; }, in() { return q; },
            update(payload) { writes.push(['update', payload]); return q; },
            insert(payload) { writes.push(['insert', payload]); return q; },
            maybeSingle: async () => (writes.length
              ? { data: { id: stored.id }, error: null }
              : { data: { role: 'owner_admin' }, error: null }),
            single: async () => ({ data: { id: stored.id }, error: null }),
            then(res, rej) {
              return Promise.resolve(table === 'report_email_schedules_v'
                ? { data: [stored], error: null } : { data: [], error: null }).then(res, rej);
            },
          };
          return q;
        },
      };
      g.fetch = async () => ({ ok: true, json: async () => ({}) });
      g.__SILO_CONFIG__ = { SUPABASE_URL: 'https://x.test', SUPABASE_ANON_KEY: 'k' };
      await M.openReportPanel({
        sb, userId: 'u1', companyId: 'C1', hostEl: host, onStatus: () => {},
        // The report preview page: it supplies the declarations and the
        // filter values currently applied, which are NOT the schedule's.
        context: { reportId: 'R7', title: 'R', parameters: DECLS, parameter_state: pageState },
      });
      // Whatever the picker is left on is what readPeriodId reports, so set
      // it after render the way the panel's own markup would have.
      periodValue = pickPeriod || S.KEEP_WINDOW;
      // Save closes the panel, which blanks innerHTML, so the markup is
      // read before the click rather than after it.
      const rendered = html;
      await handlers[click]();
      return { writes, html: rendered };
    };

    for (const click of ['#resSave', '#resTest']) {
      const { writes, html } = await drive(click);
      assert.equal(writes[0][0], 'update', `${click} updates the stored schedule`);
      assert.deepEqual(writes[0][1].parameter_state, storedState,
        `${click} kept the page's window instead of the schedule's`);
      assert.ok(/Keep the window this schedule already sends/.test(html),
        'the panel opens on keeping the stored window');
      assert.ok(/value="prior_month" selected/.test(html),
        'and shows the period the schedule is actually set to');
    }
    // Picking the page option by name is still honoured, for both buttons.
    for (const click of ['#resSave', '#resTest']) {
      const { writes } = await drive(click, S.USE_PAGE_FILTERS);
      assert.deepEqual(writes[0][1].parameter_state, pageState,
        `${click} ignored an explicit "use the page filters" choice`);
    }
    // And naming a period still wins over both.
    {
      const { writes } = await drive('#resSave', 'prior_week');
      assert.equal(writes[0][1].date_from, undefined);
      assert.equal(writes[0][1].parameter_state.date_from, 'prior_week_start');
    }
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
