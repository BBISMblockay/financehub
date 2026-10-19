'use strict';
// The Backend users panel must send p_role ONLY when the operator moved the role
// dropdown.
//
// Why this is a test and not a style preference: the list this dialog is built
// from (admin_list_profiles) returns the GLOBAL profiles.role, which is not the
// same thing as the person's membership role in the active workspace. The global
// column is written only for somebody who belongs to no other company, so a
// multi-company user promoted through Workspace Settings keeps a global role of
// 'admin' while their membership here says 'owner_admin'. On production when
// this was written that was 7 owner memberships across 5 people.
//
// Resending that stale value on every save asked the database to DEMOTE a real
// owner because somebody fixed a typo in their name. It used to do exactly that,
// silently; 20261019180000 refuses it instead, which turns a silent demotion
// into a failed save. Neither is acceptable, so the form has to stop sending a
// role nobody chose. Found by independent review on PR #1022.
//
// The dialog is an inline script in a monolithic page, so this reads the source.
// The database half is proved behaviourally in
// scripts/tests/admin-profile-owner-escalation-database.test.mjs ('the stale
// global role is still refused when it is actually sent' and 'the same rename
// goes through once the form sends p_role => null').
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const src = fs.readFileSync(path.join(root, 'v2/backend.html'), 'utf8');

const save = (() => {
  const i = src.indexOf('async function saveUserDialog()');
  assert.ok(i > 0, 'saveUserDialog must still exist in v2/backend.html');
  const j = src.indexOf('async function disableUserDialog()', i);
  assert.ok(j > i, 'disableUserDialog must still follow it');
  return src.slice(i, j);
})();

// 1. The baseline is captured when the dialog opens, from the control itself
//    rather than from the row, so a value the browser normalised still matches.
const open = (() => {
  const i = src.indexOf('function openUserDialog(');
  assert.ok(i > 0, 'openUserDialog must still exist');
  return src.slice(i, i + 2000);
})();
assert.match(open, /el\("dlgRole"\)\.value\s*=/,
  'the dialog must still populate the role control');
assert.match(open, /DLG_ROLE_OPENED_WITH\s*=\s*el\("dlgRole"\)\.value/,
  'opening the dialog must record the role it opened with, read back from the control');

// 2. Save compares against that baseline and passes null when nothing changed.
assert.match(save, /roleChanged\s*=\s*!!roleNow\s*&&\s*roleNow\s*!==\s*DLG_ROLE_OPENED_WITH/,
  'Save must decide from a comparison with the opening value');
assert.match(save, /p_role:\s*\(roleChanged\s*\?\s*roleNow\s*:\s*null\)/,
  'p_role must be null unless the dropdown was actually changed');

// 3. The old unconditional form must be gone. This is the regression: it reads
//    the control and ships whatever is in it.
assert.doesNotMatch(save, /p_role:\s*\(String\(el\("dlgRole"\)/,
  'Save must not send the role control unconditionally any more');

// 4. A second save in the same dialog must not re-send the first change.
assert.match(save, /if\s*\(roleChanged\)\s*DLG_ROLE_OPENED_WITH\s*=\s*roleNow/,
  'after a successful save the baseline must move to what was stored');

// 5. The other two callers are unaffected and must stay that way: Disable sends
//    only p_is_active, and settings-team sends p_role: null. Both therefore
//    reach none of the owner guards.
const disable = (() => {
  const i = src.indexOf('async function disableUserDialog()');
  assert.ok(i > 0, 'disableUserDialog must still exist');
  const j = src.indexOf('\n    async function ', i + 10);
  return src.slice(i, j > i ? j : i + 1200);
})();
assert.match(disable, /admin_update_profile",\s*\{\s*p_user_id:\s*DLG_UID,\s*p_is_active:\s*false\s*\}/,
  'Disable must keep sending p_is_active alone, with no role');
assert.doesNotMatch(disable, /p_role/, 'Disable must not grow a role argument');

const team = fs.readFileSync(path.join(root, 'v2/settings-team.html'), 'utf8');
assert.match(team, /p_role:\s*null/,
  'settings-team setDepartment must keep sending p_role: null');

console.log('backend user-role payload: 9 assertions passed');
