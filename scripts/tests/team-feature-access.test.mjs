// Team settings feature-access helpers: must match DB gate semantics.
// Run: node --test scripts/tests/team-feature-access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../v2/team-feature-access.js', import.meta.url), 'utf8');
const ctx = { globalThis: {}, window: null };
ctx.window = ctx.globalThis;
vm.runInNewContext(src, ctx);
const {
  targetIsExecOrOwner,
  targetHasFinanceAccess,
  financeInheritedFromWorkspace,
  departmentChangeBlocked,
} = ctx.globalThis.SiloTeamFeatureAccess;

test('workspace owner_admin inherits exec gates even when global profile is user', () => {
  const p = { role: 'user', department: 'ops', is_active: true };
  assert.equal(targetIsExecOrOwner('owner_admin', p), true);
  assert.equal(targetHasFinanceAccess('owner_admin', p), true);
  assert.equal(financeInheritedFromWorkspace('owner_admin', p), true);
});

test('global owner who is only a member here does not inherit exec or finance', () => {
  const p = { role: 'owner', department: 'ops', is_active: true };
  assert.equal(targetIsExecOrOwner('member', p), false);
  assert.equal(targetHasFinanceAccess('member', p), false);
  assert.equal(financeInheritedFromWorkspace('member', p), false);
});

test('executive profile inherits exec; finance still follows department unless owner_admin', () => {
  const p = { role: 'executive', department: 'marketing', is_active: true };
  assert.equal(targetIsExecOrOwner('admin', p), true);
  assert.equal(targetHasFinanceAccess('admin', p), false);
});

test('finance department grants finance without workspace owner role', () => {
  const p = { role: 'user', department: 'finance', is_active: true };
  assert.equal(targetHasFinanceAccess('member', p), true);
  assert.equal(financeInheritedFromWorkspace('member', p), false);
});

test('department edits blocked when user has another org membership', () => {
  assert.equal(departmentChangeBlocked(true), true);
  assert.equal(departmentChangeBlocked(false), false);
});
