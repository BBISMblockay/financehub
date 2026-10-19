/* Backend users panel: the role is sent only when the operator chose it.
 *
 * Why this exists. The list this dialog is built from (admin_list_profiles)
 * returns the GLOBAL profiles.role, which is not the person's membership role in
 * the active workspace: the global column is written only for somebody who
 * belongs to no other company, so a multi-company user promoted through
 * Workspace Settings keeps a global role of 'admin' while their membership here
 * says 'owner_admin'. On production when this was written that was 7 owner
 * memberships across 5 people.
 *
 * Save used to ship that stale value on every save, which asked the database to
 * DEMOTE a real owner because somebody fixed a typo in their name. It did
 * exactly that, silently, until 20261019180000 started refusing it -- turning a
 * silent demotion into a failed save. Neither is acceptable, so the form stopped
 * sending a role nobody chose. Both findings came from independent review of
 * #1022: cycle 1 for the stale role, cycle 2 for the baseline being overwritten
 * by a save that was still in flight when the dialog moved on.
 *
 * The page's own openUserDialog and saveUserDialog are executed here, lifted out
 * of the HTML like marketing-explorer-preview.test.js does, because the bug
 * cycle 2 found is about ORDERING and a source pattern cannot show it. The
 * database half is proved separately in
 * scripts/tests/admin-profile-owner-escalation-database.test.mjs. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('backend-user-role-payload');
const html = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'backend.html'), 'utf8');

/** Lift one function's source out of the page, from its own header to the next
 *  sibling declaration. Throws rather than silently testing nothing. */
const grab = (startMarker, endMarker) => {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error(`${startMarker} not found in v2/backend.html`);
  const j = html.indexOf(endMarker, i);
  if (j <= i) throw new Error(`${endMarker} not found after ${startMarker}`);
  return html.slice(i, j);
};

const openSrc = grab('function openUserDialog(uid){', 'async function refreshSiloAccess(');
const saveSrc = grab('async function saveUserDialog(){', 'async function disableUserDialog(');

// ── A harness standing in for the page ───────────────────────────────────────
function harness(users) {
  const controls = {};
  const control = (id) => (controls[id] = controls[id] || { value: '', textContent: '' });
  const calls = [];
  let pending = [];

  const ctx = {
    USERS: users,
    el: (id) => control(id),
    setText: (id, v) => { control(id).textContent = v; },
    userDialog: { showModal() {}, close() {} },
    refreshSiloAccess: () => {},
    refreshSeoApprover: () => {},
    loadUsers: async () => {},
    loadHealth: async () => {},
    supabaseClient: {
      rpc: (name, payload) => {
        calls.push({ name, payload });
        let resolve;
        const p = new Promise((res) => { resolve = res; });
        pending.push(() => resolve({ error: null }));
        return p;
      },
    },
    console,
    Promise,
    String,
    JSON,
  };
  ctx.globalThis = ctx;

  vm.runInNewContext(
    'let DLG_UID = null;\nlet DLG_ROLE_OPENED_WITH = null;\nlet DLG_GENERATION = 0;\n'
    + openSrc + '\n' + saveSrc + '\n'
    + 'this.openUserDialog = openUserDialog; this.saveUserDialog = saveUserDialog;\n'
    + 'this.peek = () => ({ uid: DLG_UID, baseline: DLG_ROLE_OPENED_WITH, gen: DLG_GENERATION });',
    ctx);

  return {
    open: (uid) => ctx.openUserDialog(uid),
    setRole: (v) => { control('dlgRole').value = v; },
    setName: (v) => { control('dlgName').value = v; },
    save: () => ctx.saveUserDialog(),
    settle: async () => { const p = pending; pending = []; p.forEach((f) => f()); await new Promise((s) => setImmediate(s)); },
    calls,
    peek: () => ctx.peek(),
  };
}

// 'mixed' is the production state the whole fix is about: the row (and so the
// dialog) says admin, the workspace membership says owner_admin.
const USERS = [
  { id: 'A', email: 'a@x.com', name: 'A', department: 'ops', role: 'admin', is_active: true },
  { id: 'B', email: 'b@x.com', name: 'B', department: 'ops', role: 'admin', is_active: true },
];

const run = async () => {
  // ── 1. An untouched dropdown sends no role at all ──────────────────────────
  {
    const h = harness(USERS);
    h.open('A');
    h.setName('Renamed');
    const save = h.save();
    await h.settle();
    await save;
    r.test('a rename with an untouched role sends p_role: null', () => {
      r.eq(h.calls.length, 1);
      r.eq(h.calls[0].payload.p_role, null, 'the stale global role must not be resent');
      r.eq(h.calls[0].payload.p_name, 'Renamed');
      r.eq(h.calls[0].payload.p_user_id, 'A');
    });
  }

  // ── 2. A deliberate change is still sent ───────────────────────────────────
  {
    const h = harness(USERS);
    h.open('A');
    h.setRole('owner');
    const save = h.save();
    await h.settle();
    await save;
    r.test('moving the dropdown does send the new role', () => {
      r.eq(h.calls[0].payload.p_role, 'owner');
    });

    // ── 3. A second save must not re-send the first change ───────────────────
    h.setName('Renamed again');
    const save2 = h.save();
    await h.settle();
    await save2;
    r.test('a second save in the same dialog does not re-send the role', () => {
      r.eq(h.calls.length, 2);
      r.eq(h.calls[1].payload.p_role, null, 'the baseline must have moved to what was stored');
      r.eq(h.calls[1].payload.p_name, 'Renamed again');
    });
  }

  // ── 4. Review cycle 2: a late response must not rewrite the next dialog ────
  // Nothing disables Save or blocks a close while the RPC is in flight, so:
  // change A's role and Save, close A and open B before the response lands,
  // then let A's response arrive. Without the generation guard it writes B's
  // baseline to 'owner', and B's next rename ships p_role='admin' against an
  // owner_admin membership -- the demotion this whole change exists to stop.
  {
    const h = harness(USERS);
    h.open('A');
    h.setRole('owner');
    const slowSave = h.save();          // in flight, not resolved yet

    h.open('B');                        // operator moves on
    const afterOpen = h.peek();
    r.test('opening the next person sets their own baseline', () => {
      r.eq(afterOpen.uid, 'B');
      r.eq(afterOpen.baseline, 'admin');
    });

    await h.settle();                   // A's response lands now
    await slowSave;

    r.test("a pending save for one person leaves the next person's baseline alone", () => {
      const now = h.peek();
      r.eq(now.uid, 'B');
      r.eq(now.baseline, 'admin', "A's late response must not write B's baseline");
    });

    h.setName('B Renamed');
    const save = h.save();
    await h.settle();
    await save;
    r.test('and renaming that next person still sends no role', () => {
      const last = h.calls[h.calls.length - 1];
      r.eq(last.payload.p_user_id, 'B');
      r.eq(last.payload.p_role, null,
        'a stale baseline here would demote an owner whose global role reads admin');
      r.eq(last.payload.p_name, 'B Renamed');
    });
  }

  // ── 5. The guard itself, so it cannot be dropped silently ──────────────────
  r.test('the baseline write is conditional on the dialog not having moved on', () => {
    r.has(saveSrc, 'const savedGeneration = DLG_GENERATION;',
      'the generation must be captured before the await');
    r.has(saveSrc, 'DLG_GENERATION === savedGeneration && DLG_UID === savedUid',
      'and compared after it');
    r.not(saveSrc, 'p_role: (String(el("dlgRole")',
      'the old unconditional payload must be gone');
  });

  // ── 6. The other two callers send no role, so they reach no owner guard ────
  r.test('Disable still sends p_is_active alone', () => {
    const disable = grab('async function disableUserDialog(){', '// ====== Ops status');
    r.has(disable, 'p_user_id: DLG_UID, p_is_active: false');
    r.not(disable, 'p_role', 'Disable must not grow a role argument');
  });

  r.test('settings-team setDepartment still sends p_role: null', () => {
    const team = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'settings-team.html'), 'utf8');
    r.has(team, 'p_role: null');
  });

  const out = r.summary();
  if (out.fail) process.exitCode = 1;
};

run().catch((err) => { console.log('  FAIL harness threw\n        ' + (err && err.stack || err)); process.exitCode = 1; });
