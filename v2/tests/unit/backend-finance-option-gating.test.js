/* The panels must not offer a department or role the database will refuse.
 *
 * 20261019180000 makes admin_update_profile refuse profiles.department in
 * ('finance','exec') and profiles.role = 'executive' to anybody who is not an
 * owner or an executive of the workspace being written, and refuse owner to
 * anybody who is not an owner. create_org_invite has refused finance, exec and
 * owner to non-owners since 20261008120000.
 *
 * Both dropdowns offered every value to everybody, so an ordinary admin could
 * pick finance, hit Save, and get a privilege error with no way to see it
 * coming. The server stays the boundary -- this is only about not offering it.
 *
 * backend.html's applyGrantCapability() is EXECUTED here against fake selects,
 * not pattern-matched, because what matters is which option ends up disabled.
 * The settings-team.html half is asserted on source: its gating lives inside a
 * row-renderer template string that cannot be lifted without rewriting the
 * page, so these assertions protect it from being deleted rather than proving
 * it renders. The database half -- the part that is actually the boundary -- is
 * proved behaviourally in
 * scripts/tests/admin-profile-owner-escalation-database.test.mjs. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('backend-finance-option-gating');
const backend = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'backend.html'), 'utf8');
const team = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'settings-team.html'), 'utf8');

const grab = (startMarker, endMarker) => {
  const i = backend.indexOf(startMarker);
  if (i < 0) throw new Error(`${startMarker} not found in v2/backend.html`);
  const j = backend.indexOf(endMarker, i);
  if (j <= i) throw new Error(`${endMarker} not found after ${startMarker}`);
  return backend.slice(i, j);
};

const applySrc = grab('function applyGrantCapability(){', '// ====== Boot / UI wiring ======');

// ── A harness standing in for the three selects ──────────────────────────────
function harness({ finance, owner }) {
  const selects = {
    dlgDept: ['', 'ops', 'finance', 'logistics', 'marketing', 'retail', 'exec'],
    dlgRole: ['viewer', 'member', 'admin', 'executive', 'owner'],
    invDept: ['ops', 'finance', 'logistics', 'marketing', 'retail', 'exec'],
  };
  const options = {};
  const nodes = {};
  for (const [id, values] of Object.entries(selects)) {
    options[id] = {};
    values.forEach((v) => { options[id][v] = { value: v, disabled: false, title: '' }; });
    nodes[id] = {
      querySelector(sel) {
        const m = /^option\[value="(.*)"\]$/.exec(sel);
        if (!m) throw new Error(`unexpected selector: ${sel}`);
        return options[id][m[1]] || null;
      },
    };
  }

  const ctx = { el: (id) => nodes[id] || null, console, String };
  ctx.globalThis = ctx;
  vm.runInNewContext(
    `let CAN_GRANT_FINANCE = ${finance}; let CAN_GRANT_OWNER = ${owner};\n`
    + applySrc + '\nthis.applyGrantCapability = applyGrantCapability;',
    ctx);
  ctx.applyGrantCapability();
  return options;
}

const state = (opt) => (opt.disabled ? 'disabled' : 'offered');

// ── 1. A plain admin: neither owner nor executive ────────────────────────────
{
  const o = harness({ finance: false, owner: false });
  r.test('a plain admin is not offered finance or exec in the user dialog', () => {
    r.eq(state(o.dlgDept.finance), 'disabled');
    r.eq(state(o.dlgDept.exec), 'disabled');
    r.ok(/owner or executive/i.test(o.dlgDept.finance.title),
      'and the option says who can: ' + o.dlgDept.finance.title);
  });

  r.test('nor the executive or owner roles', () => {
    r.eq(state(o.dlgRole.executive), 'disabled');
    r.eq(state(o.dlgRole.owner), 'disabled');
  });

  r.test('nor finance or exec on a new invite', () => {
    r.eq(state(o.invDept.finance), 'disabled');
    r.eq(state(o.invDept.exec), 'disabled');
  });

  r.test('everything they may actually do is left alone', () => {
    r.eq(state(o.dlgDept.ops), 'offered');
    r.eq(state(o.dlgDept.logistics), 'offered');
    r.eq(state(o.dlgDept.marketing), 'offered');
    r.eq(state(o.dlgRole.admin), 'offered');
    r.eq(state(o.dlgRole.member), 'offered');
    r.eq(state(o.dlgRole.viewer), 'offered');
    r.eq(state(o.invDept.ops), 'offered');
  });
}

// ── 2. An executive: finance yes, owner no ───────────────────────────────────
{
  const o = harness({ finance: true, owner: false });
  r.test('an executive can grant finance, exec and the executive role', () => {
    r.eq(state(o.dlgDept.finance), 'offered');
    r.eq(state(o.dlgDept.exec), 'offered');
    r.eq(state(o.dlgRole.executive), 'offered');
  });

  r.test('but still not owner, and still not finance on an invite', () => {
    r.eq(state(o.dlgRole.owner), 'disabled');
    r.eq(state(o.invDept.finance), 'disabled',
      'create_org_invite is owner-only on finance, which is a stricter rule on purpose');
  });
}

// ── 3. An owner: everything ──────────────────────────────────────────────────
{
  const o = harness({ finance: true, owner: true });
  r.test('an owner is offered every option', () => {
    for (const [id, opts] of Object.entries(o)) {
      for (const [value, opt] of Object.entries(opts)) {
        r.eq(state(opt), 'offered', `${id}.${value || '(blank)'}`);
      }
    }
  });
}

// ── 4. It fails towards today's behaviour, not towards a hole ────────────────
r.test('both flags start false and the read only ever widens them', () => {
  r.has(backend, 'let CAN_GRANT_FINANCE = false;');
  r.has(backend, 'let CAN_GRANT_OWNER = false;');
  r.has(backend, 'exec.status === "fulfilled" && exec.value?.data === true');
  r.has(backend, 'await loadGrantCapability();',
    'the capability read must actually run at boot');
});

// ── 5. Workspace Settings, the other panel that writes department ────────────
r.test('settings-team computes owner-or-exec and keeps it false by default', () => {
  r.has(team, 'let _canGrantFinance = false;');
  r.has(team, '_canGrantFinance = _isOwner || !!canExec;');
});

r.test('its department dropdown disables finance and exec for everybody else', () => {
  r.has(team, "const restricted = (d === 'finance' || d === 'exec')");
  r.has(team, "&& !_canGrantFinance && d !== (p?.department || 'ops')",
    "the person's own current department must stay selectable");
});

r.test('its Finance checkbox still lets an admin REMOVE finance', () => {
  r.has(team, '&& (_canGrantFinance || finChecked)',
    'granting needs authority; taking it away does not');
});

const out = r.summary();
if (out.fail) process.exitCode = 1;
