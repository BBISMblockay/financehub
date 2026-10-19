// admin_update_profile must not let an 'admin' become an owner.
//
// What was wrong (production, found 2026-10-14, still open when re-checked
// 2026-10-19): admin_update_profile is SECURITY DEFINER, EXECUTE to
// `authenticated`, gated only on is_admin() -- which passes for membership role
// 'admin' -- and maps p_role='owner' onto membership 'owner_admin' through an
// upsert carrying `do update set role = excluded.role`. Nothing looked at WHO
// the target was, so an admin calling it with their OWN user id became an
// owner. 53 'admin' memberships across 40 people could do it. The same gap let
// an admin demote an existing owner.
//
// The fixture installs the real 20261009120000 definition first and asserts the
// hole is there, so the assertions after 20261019180000 prove that migration
// closed it rather than that the fixture never had it.
//
// The regression this guards against is as important as the fix: v2/backend.html
// sends EVERY field on EVERY save, so ordinary edits re-send the role the person
// already has. A guard keyed on "p_role names owner" rather than on an actual
// change would turn renaming an owner into a privilege error. Both no-op cases
// are asserted below.
//
// Mutations (each must make a specific assertion fail):
//   ESC_MUTATION=no-grant-guard     (drops the "only an owner can grant owner access" branch)
//   ESC_MUTATION=no-demote-guard    (drops the "only an owner can change another owner" branch)
//   ESC_MUTATION=no-last-owner      (drops the last-owner count check)
//   ESC_MUTATION=guard-on-supplied  (guards on p_role being supplied instead of on a real change)
//   ESC_MUTATION=no-advisory-lock   (drops the shared membership lock)
//
// Run: node scripts/tests/admin-profile-owner-escalation-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = ['no-grant-guard', 'no-demote-guard', 'no-last-owner',
  'guard-on-supplied', 'no-advisory-lock'];
const mutation = process.env.ESC_MUTATION || '';
assert.ok(mutation === '' || MUTATIONS.includes(mutation), `Unknown escalation mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

// The verify statement under test, read from the file rather than retyped: a
// check that drifts from what the drift run executes proves nothing.
const VERIFY_MARKER = "select 'admin_update_profile cannot grant or strip owner' as check_name";
let VERIFY_SQL = '';
const verifyStatement = () => VERIFY_SQL;

// The EXACT strings the check searches prosrc for -- not paraphrases. Getting
// one wrong here makes an earlier branch fire and the mutation prove nothing,
// which is what happened on the first draft of this test.
const NEEDLES = [
  'is_owner_admin_of_active_company()',
  "where em.entity_id = v_company_id and em.role = 'owner_admin'",
  'silo-workspace-membership|',
];
// A body carrying every one of them EXCEPT one, so each case isolates a single
// property of the check. The check reads prosrc, so a comment carrying the
// string is indistinguishable from a real call -- which is the point: these
// cases test the CHECK, not the function.
const stubBody = (omit) => NEEDLES.filter((n) => n !== omit)
  .map((n) => `-- ${n}\n`).join('') + ' return;';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const refused = async (fn, pattern, what) => {
  await assert.rejects(fn, pattern, what);
  passed += 1; console.log(`ok ${passed} - refused: ${what}`);
};

async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}

const membershipRole = async (company, user) => (await one(
  `select role from public.entity_memberships where entity_id=$1 and user_id=$2`,
  [company, user]))?.role;
const profileRole = async (user) => (await one(
  `select role::text as role from public.profiles where id=$1`, [user]))?.role;

// ── Cast ─────────────────────────────────────────────────────────────────────
const blake = randomUUID();        // owner_admin of Baseballism
const coOwner = randomUUID();      // a SECOND owner_admin, so demotion is testable
const bbAdmin = randomUUID();      // plain admin of Baseballism -- the attacker
const bbMember = randomUUID();     // ordinary member
const soloOwner = randomUUID();    // the only owner of the other tenant
const bbism = randomUUID();
const blockay = randomUUID();

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));
await db.exec(await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8'));

await q(`insert into auth.users(id,email) values
  ($1,'blake@baseballism.com'),($2,'coowner@baseballism.com'),($3,'admin@baseballism.com'),
  ($4,'member@baseballism.com'),($5,'owner@blockay.com')`,
  [blake, coOwner, bbAdmin, bbMember, soloOwner]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values
  ($1,'finance_hub','company','baseballism','seed','Baseballism'),
  ($2,'finance_hub','company','blockay-ops','seed','Blockay Ops')`, [bbism, blockay]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blake, bbism]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [coOwner, bbism]);
await q(`update public.profiles set role='admin', department='finance', active_company_id=$2 where id=$1`, [bbAdmin, bbism]);
await q(`update public.profiles set role='user', department='ops', active_company_id=$2 where id=$1`, [bbMember, bbism]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [soloOwner, blockay]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$2,'owner_admin'),($1,$3,'owner_admin'),($1,$4,'admin'),($1,$5,'member'),($6,$7,'owner_admin')`,
  [bbism, blake, coOwner, bbAdmin, bbMember, blockay, soloOwner]);

// ── 0. The definition in production today, and the hole it leaves ────────────
await db.exec(await readFile(
  new URL('supabase/migrations/20261009120000_workspace_admin_member_scope.sql', root), 'utf8'));

await test('BEFORE the fix: a plain admin can make themselves an owner', async () => {
  assert.equal(await membershipRole(bbism, bbAdmin), 'admin', 'fixture should start them as admin');
  await as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [bbAdmin, 'owner']));
  assert.equal(await membershipRole(bbism, bbAdmin), 'owner_admin',
    'the hole this migration closes should be present in the fixture');
});

await test('BEFORE the fix: a plain admin can demote a real owner', async () => {
  await q(`update public.entity_memberships set role='admin' where entity_id=$1 and user_id=$2`, [bbism, bbAdmin]);
  await as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [blake, 'member']));
  assert.equal(await membershipRole(bbism, blake), 'member', 'demotion hole should be present too');
  await q(`update public.entity_memberships set role='owner_admin' where entity_id=$1 and user_id=$2`, [bbism, blake]);
  await q(`update public.profiles set role='owner' where id=$1`, [blake]);
});

// Production revokes EXECUTE from anon on this function; PGlite starts from
// PostgreSQL's default of EXECUTE to PUBLIC, which anon inherits. Mirror
// production here so the assertion at the end tests something real: that
// `create or replace` does NOT resurrect the anon grant. (It would if the
// migration dropped and recreated the function instead -- Supabase's default
// privileges re-grant EXECUTE on a NEW public function to anon and
// authenticated. See supabase/CLAUDE.md.)
// Revoking from anon alone is not enough and is a trap worth naming: PostgreSQL
// grants EXECUTE to PUBLIC on a new function, anon inherits it that way, and a
// revoke aimed at anon removes a grant that was never made to anon. PUBLIC has
// to lose it, and authenticated has to get it back explicitly.
await db.exec(`
  revoke execute on function public.admin_update_profile(uuid,text,text,text,boolean,text) from public;
  revoke execute on function public.admin_update_profile(uuid,text,text,text,boolean,text) from anon;
  grant  execute on function public.admin_update_profile(uuid,text,text,text,boolean,text) to authenticated;`);

// ── 1. The migration under test ──────────────────────────────────────────────
let sql = await readFile(
  new URL('supabase/migrations/20261019180000_admin_update_profile_owner_escalation.sql', root), 'utf8');

if (mutation === 'no-grant-guard') {
  sql = sql.replace(/if v_membership_role = 'owner_admin'[\s\S]*?end if;\n\n/,
    '');
} else if (mutation === 'no-demote-guard') {
  sql = sql.replace(/if not public\.is_owner_admin_of_active_company\(\) then\n\s*raise exception 'only an owner can change another owner';\n\s*end if;/,
    '');
} else if (mutation === 'no-last-owner') {
  sql = sql.replace(/if \(select count\(\*\) from public\.entity_memberships em\n[\s\S]*?end if;/,
    '');
} else if (mutation === 'guard-on-supplied') {
  // The defect the comment in the migration warns about: key the guard on
  // "a role was supplied" rather than on the role actually changing.
  sql = sql.replace('if v_membership_role is distinct from v_current_membership_role then',
    'if true then');
} else if (mutation === 'no-advisory-lock') {
  sql = sql.replace(/perform pg_advisory_xact_lock\([\s\S]*?\);/, '');
}
await db.exec(sql);

// ── 2. The escalation is closed ──────────────────────────────────────────────
await refused(
  () => as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [bbAdmin, 'owner'])),
  /only an owner can grant owner access/,
  'an admin promoting THEMSELVES to owner');

await test('the admin is still just an admin afterwards', async () => {
  assert.equal(await membershipRole(bbism, bbAdmin), 'admin');
});

await refused(
  () => as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [bbMember, 'owner'])),
  /only an owner can grant owner access/,
  'an admin promoting SOMEBODY ELSE to owner');

await refused(
  () => as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [blake, 'member'])),
  /only an owner can change another owner/,
  'an admin demoting an owner');

await test('the owner is still an owner afterwards', async () => {
  assert.equal(await membershipRole(bbism, blake), 'owner_admin');
});

// ── 3. What an owner may still do ────────────────────────────────────────────
await test('an owner can still promote somebody to owner', async () => {
  await as(blake, () => q('select public.admin_update_profile($1, null, null, $2)', [bbMember, 'owner']));
  assert.equal(await membershipRole(bbism, bbMember), 'owner_admin');
  assert.equal(await profileRole(bbMember), 'owner', 'the legacy global role follows for a single-org member');
});

await test('an owner can still demote another owner while others remain', async () => {
  await as(blake, () => q('select public.admin_update_profile($1, null, null, $2)', [bbMember, 'member']));
  assert.equal(await membershipRole(bbism, bbMember), 'member');
});

await refused(
  () => as(soloOwner, () => q('select public.admin_update_profile($1, null, null, $2)', [soloOwner, 'member'])),
  /must keep at least one owner/,
  'the only owner of a workspace demoting themselves');

// ── 4. The regression guard: ordinary saves must keep working ────────────────
// v2/backend.html sends every field on every save, so these re-send a role the
// person already holds. None of them is a change, so none may be refused.
await test('an admin can rename an OWNER, re-sending p_role=owner unchanged', async () => {
  await as(bbAdmin, () => q(
    'select public.admin_update_profile($1, $2, $3, $4, $5, $6)',
    [blake, 'Blake Renamed', 'exec', 'owner', true, null]));
  assert.equal((await one('select name from public.profiles where id=$1', [blake]))?.name, 'Blake Renamed');
  assert.equal(await membershipRole(bbism, blake), 'owner_admin', 'unchanged');
});

await test('an admin can edit their OWN profile, re-sending their own role', async () => {
  await as(bbAdmin, () => q(
    'select public.admin_update_profile($1, $2, $3, $4, $5, $6)',
    [bbAdmin, 'Admin Renamed', 'finance', 'admin', true, null]));
  assert.equal((await one('select name from public.profiles where id=$1', [bbAdmin]))?.name, 'Admin Renamed');
  assert.equal(await membershipRole(bbism, bbAdmin), 'admin', 'unchanged');
});

await test('setDepartment (p_role => null) is untouched by the guards', async () => {
  await as(bbAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'ops2']));
  assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department, 'ops2');
});

await test('an admin can still make an ordinary role change', async () => {
  await as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [bbMember, 'admin']));
  assert.equal(await membershipRole(bbism, bbMember), 'admin');
});

// ── 5. Structural: the shared lock key, and the grants ───────────────────────
await test('it takes the SAME advisory lock key as set_workspace_member_role', async () => {
  const src = (await one(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='admin_update_profile'`))?.prosrc || '';
  assert.match(src, /silo-workspace-membership\|/,
    'a third function that changes owner roles must share the per-company membership lock');
});

await test('the function is still callable by authenticated and not by anon', async () => {
  const r = await one(`select
    has_function_privilege('authenticated','public.admin_update_profile(uuid,text,text,text,boolean,text)','execute') as a,
    has_function_privilege('anon','public.admin_update_profile(uuid,text,text,text,boolean,text)','execute') as n`);
  assert.equal(r.a, true, 'create or replace must not have dropped the authenticated grant');
  assert.equal(r.n, false, 'anon must not be able to call it');
});

VERIFY_SQL = await (async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf(VERIFY_MARKER);
  assert.ok(start > 0, 'the owner-escalation check must still exist in verify_v2_schema.sql');
  // It must stay OUT of the three fixture-claimed spans further down the file,
  // each of which asserts a statement count. See the note above the marker.
  const claimed = verify.indexOf('-- \u2500\u2500 Workspace Settings administration (20260920120000)');
  assert.ok(claimed > start,
    'the check must stay above the workspace-settings/admin-scope claimed region');
  return verify.slice(start).split(/;\s*\n/)[0] + ';';
})();

// ── 5b. The LIMIT of these guards, pinned so it cannot be mistaken ───────────
// These guards are about owner_admin and nothing else. 'executive' and 'admin'
// BOTH map to membership 'admin', so an admin sending p_role='executive' for
// themselves makes no membership change at all and the guards above are not
// reached by design -- while the legacy global profiles.role becomes
// 'executive', which is_exec_or_owner() accepts on its own. That is a separate
// finding, filed in docs/ops/bugs.md and NOT fixed here, because refusing it
// changes what the Backend users panel is allowed to do. This test pins the
// current behaviour so the gap is machine-checked rather than only described:
// if it is ever closed, this is the assertion that must be inverted.
await test('OPEN, see bugs.md: an admin can still self-assign the global executive role', async () => {
  await as(bbAdmin, () => q(
    'select public.admin_update_profile($1, null, null, $2, null, null)', [bbAdmin, 'executive']));
  assert.equal(await profileRole(bbAdmin), 'executive',
    'documents the open gap -- the guards above are about owner_admin only');
  assert.equal(await membershipRole(bbism, bbAdmin), 'admin',
    'and the membership is unchanged, which is exactly why the guards do not fire');

  // Put it back, so the ordering of this file does not matter to later tests.
  await as(blake, () => q(
    'select public.admin_update_profile($1, null, null, $2, null, null)', [bbAdmin, 'admin']));
  assert.equal(await profileRole(bbAdmin), 'admin');
});

// ── 6. The verify_v2_schema check, actually executed ─────────────────────────
// deployment-drift-check.yml runs verify_v2_schema.sql against production daily.
// A check that cannot return 'ok' against a correct schema is worse than no
// check -- it is red forever and nobody reads it -- and a check that reads 'ok'
// no matter what is worse still. So the statement is extracted by its own marker
// and run here, then re-run against a function with each guard stripped out.
await test('the verify_v2_schema check returns ok against the fixed schema', async () => {
  const row = await one(verifyStatement());
  assert.equal(row.check_name, 'admin_update_profile cannot grant or strip owner');
  assert.equal(row.status, 'ok', row.status);
});

await test('the verify check goes CRITICAL when each guard is taken away', async () => {
  // A whole-function replacement per case, because the check reads prosrc: a
  // partial edit would leave the string it looks for behind and read 'ok'.
  const cases = [
    [NEEDLES[0], /does not check owner authority/],
    [NEEDLES[1], /no last-owner guard/],
    [NEEDLES[2], /does not take the shared per-company owner lock/],
  ];
  for (const [needle, expected] of cases) {
    await db.exec('begin');
    await db.exec(`create or replace function public.admin_update_profile(
        p_user_id uuid, p_name text default null, p_department text default null,
        p_role text default null, p_is_active boolean default null, p_notes text default null)
      returns void language plpgsql security definer set search_path to 'public','pg_temp'
      as $stub$ begin ${stubBody(needle)} end; $stub$`);
    assert.match((await one(verifyStatement())).status, expected, `removing ${needle}`);
    await db.exec('rollback');
  }
  assert.equal((await one(verifyStatement())).status, 'ok', 'the rollbacks restored the real function');
});

console.log(`\nadmin_update_profile owner escalation: ${passed}/${passed} passed`);
await db.close();
