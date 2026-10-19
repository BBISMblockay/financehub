// admin_update_profile must not let an 'admin' become an owner, or hand
// themselves finance authority.
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
//   ESC_MUTATION=helper-authority   (asks the ACTIVE-company helper instead of
//                                    the captured company -- the first version
//                                    of this fix, and the P1 the independent
//                                    review caught)
//   ESC_MUTATION=no-finance-guard    (drops the finance/exec department refusal)
//   ESC_MUTATION=no-executive-guard  (drops the global 'executive' role refusal)
//   ESC_MUTATION=finance-guard-on-supplied
//                                   (refuses a department that was merely
//                                    RE-SENT, which breaks ordinary saves for
//                                    the 20 people already in finance or exec)
//   ESC_MUTATION=finance-helper-authority
//                                   (asks is_exec_or_owner(), which reads
//                                    profiles.active_company_id, instead of the
//                                    company the call captured)
//   ESC_MUTATION=finance-stepping-stone
//                                   (asks "do they already hold authority"
//                                    against the REFUSED set instead of the set
//                                    the gate admits, which makes the 'admin'
//                                    department a stepping stone to finance --
//                                    the first version of this guard, found
//                                    re-reading the diff)
//
// The finance half: 'admin' and 'executive' both map to membership 'admin', so
// an admin granting either profiles.department in ('finance','exec') or
// profiles.role = 'executive' changes no membership and reaches none of the
// owner guards -- while can_manage_journal_entries() admits the department on
// its own and is_exec_or_owner() admits the role on its own. Closed on Blake's
// instruction of 2026-10-19: "only owner and exec can make admin have finance".
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
  'guard-on-supplied', 'no-advisory-lock', 'helper-authority',
  'no-finance-guard', 'no-executive-guard', 'finance-guard-on-supplied',
  'finance-helper-authority', 'finance-stepping-stone'];
const mutation = process.env.ESC_MUTATION || '';
assert.ok(mutation === '' || MUTATIONS.includes(mutation), `Unknown escalation mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

// The verify statement under test, read from the file rather than retyped: a
// check that drifts from what the drift run executes proves nothing.
const VERIFY_MARKER = "select 'Owner grants are bound to the company being written' as check_name";
let VERIFY_SQL = '';
const verifyStatement = () => VERIFY_SQL;

// The EXACT strings the check searches prosrc for -- not paraphrases. Getting
// one wrong here makes an earlier branch fire and the mutation prove nothing,
// which is what happened on the first draft of this test.
const NEEDLES = [
  'is_owner_admin_of_company(',
  "where em.entity_id = v_company_id and em.role = 'owner_admin'",
  'silo-workspace-membership|',
  'is_exec_or_owner_of_company(v_company_id)',
  "in ('finance', 'exec', 'admin')",
  "<> coalesce(v_current_department, '')",
  "v_role::text = 'executive'",
];
// A body carrying every one of them EXCEPT one, so each case isolates a single
// property of the check. Each needle is emitted as a dollar-quoted `perform`
// rather than as a comment: the finance branches of the check strip -- comments
// before matching (they have to -- the real function's comments name
// is_exec_or_owner() while explaining why it is not used), so a commented
// needle would read as absent and the wrong branch would fire. Dollar quoting
// also means a needle containing single quotes needs no escaping. These cases
// test the CHECK, not the function.
// pg_advisory_xact_lock is always present: the lock branch of the check counts
// functions carrying BOTH that call and the key string, and it sits ABOVE the
// finance branches -- so a stub missing it fires the lock message for every
// case and the later cases would prove nothing. 'silo-workspace-membership|'
// is the omittable half of that pair.
const stubBody = (omit) => NEEDLES.filter((n) => n !== omit)
  .concat('pg_advisory_xact_lock')
  .map((n) => ` perform $n$${n}$n$;\n`).join('') + ' return;';

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
const crossOwner = randomUUID();   // admin in Baseballism, owner_admin in Blockay (review P1)
const mixedOwner = randomUUID();   // owner_admin here, global profiles.role 'admin' (review P2)
const plainAdmin = randomUUID();   // admin of Baseballism, department 'ops' -- the finance attacker.
                                   // bbAdmin cannot play this part: the fixture
                                   // already puts them IN finance, and the guard
                                   // (correctly) lets somebody re-send what they
                                   // already have.
const execUser = randomUUID();     // membership admin, global role 'executive' -- the
                                   // "and exec" half of the rule, so the tests show who
                                   // the guard still lets through
const bbism = randomUUID();
const blockay = randomUUID();
const thirdco = randomUUID();     // crossOwner's own company, kept out of blockay
                                  // so soloOwner stays its ONLY owner

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));
await db.exec(await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8'));

await q(`insert into auth.users(id,email) values
  ($1,'blake@baseballism.com'),($2,'coowner@baseballism.com'),($3,'admin@baseballism.com'),
  ($4,'member@baseballism.com'),($5,'owner@blockay.com'),
  ($6,'cross@baseballism.com'),($7,'mixed@baseballism.com'),
  ($8,'plain@baseballism.com'),($9,'exec@baseballism.com')`,
  [blake, coOwner, bbAdmin, bbMember, soloOwner, crossOwner, mixedOwner, plainAdmin, execUser]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values
  ($1,'finance_hub','company','baseballism','seed','Baseballism'),
  ($2,'finance_hub','company','blockay-ops','seed','Blockay Ops'),
  ($3,'finance_hub','company','thirdco','seed','Third Co')`, [bbism, blockay, thirdco]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blake, bbism]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [coOwner, bbism]);
await q(`update public.profiles set role='admin', department='finance', active_company_id=$2 where id=$1`, [bbAdmin, bbism]);
await q(`update public.profiles set role='user', department='ops', active_company_id=$2 where id=$1`, [bbMember, bbism]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [soloOwner, blockay]);
// crossOwner's global role says 'admin'; their real authority differs per
// company -- admin in Baseballism, owner_admin in Third Co.
await q(`update public.profiles set role='admin', department='ops', active_company_id=$2 where id=$1`, [crossOwner, bbism]);
// mixedOwner is the state the review's P2 is about, and 7 memberships across 5
// people are in it on production: membership owner_admin here, global role
// 'admin', and a second company, which is why the global column was never
// rewritten when they were promoted.
await q(`update public.profiles set role='admin', department='ops', active_company_id=$2 where id=$1`, [mixedOwner, bbism]);
await q(`update public.profiles set role='admin', department='ops', active_company_id=$2 where id=$1`, [plainAdmin, bbism]);
await q(`update public.profiles set role='executive', department='exec', active_company_id=$2 where id=$1`, [execUser, bbism]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$2,'owner_admin'),($1,$3,'owner_admin'),($1,$4,'admin'),($1,$5,'member'),($6,$7,'owner_admin'),
  ($1,$8,'admin'),($10,$8,'owner_admin'),
  ($1,$9,'owner_admin'),($10,$9,'member'),
  ($1,$11,'admin'),($1,$12,'admin')`,
  [bbism, blake, coOwner, bbAdmin, bbMember, blockay, soloOwner, crossOwner, mixedOwner, thirdco,
   plainAdmin, execUser]);

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

// The two Workspace Settings functions this migration also replaces. Loaded in
// their production form first, so the assertions below prove the migration
// changed them rather than that it created them.
await db.exec(await readFile(
  new URL('supabase/migrations/20260920120000_workspace_settings_admin.sql', root), 'utf8'));

await test('BEFORE the fix: the sibling functions ask the ACTIVE-company helper', async () => {
  const rows = await q(`select p.proname,
      regexp_replace(p.prosrc,'[[:space:]]+',' ','g') ilike '%is_owner_admin_of_active_company%' as mutable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('set_workspace_member_role','remove_workspace_member')
   order by p.proname`);
  assert.equal(rows.length, 2, 'both siblings must be installed');
  for (const r of rows) {
    assert.equal(r.mutable, true,
      `${r.proname} should start with the defect, or the fixture proves nothing`);
  }
});

// ── 1. The migration under test ──────────────────────────────────────────────
let sql = await readFile(
  new URL('supabase/migrations/20261019180000_admin_update_profile_owner_escalation.sql', root), 'utf8');

if (mutation === 'no-grant-guard') {
  sql = sql.replace(/if v_membership_role = 'owner_admin'[\s\S]*?end if;\n\n/,
    '');
} else if (mutation === 'no-demote-guard') {
  sql = sql.replace(/if not public\.is_owner_admin_of_company\(v_company_id\) then\n\s*raise exception 'only an owner can change another owner';\n\s*end if;/,
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
  // Non-global replace, and admin_update_profile is the FIRST function in the
  // file, so this strips its lock and leaves the two siblings' alone.
  sql = sql.replace(/perform pg_advisory_xact_lock\([\s\S]*?\);/, '');
} else if (mutation === 'no-finance-guard') {
  sql = sql.replace(/if lower\(trim\(coalesce\(p_department[\s\S]*?end if;\n/, '');
} else if (mutation === 'no-executive-guard') {
  sql = sql.replace(/if v_role::text = 'executive'[\s\S]*?end if;\n/, '');
} else if (mutation === 'finance-guard-on-supplied') {
  // The same defect as guard-on-supplied, on the department: refuse because the
  // field was SENT rather than because it changed. This is the one that breaks
  // the live app rather than leaving a hole, so it has its own case.
  sql = sql.replace(
    "       and lower(trim(coalesce(p_department, ''))) <> coalesce(v_current_department, '')\n"
    + "       and coalesce(v_current_department, '') not in ('finance', 'exec')\n", '');
} else if (mutation === 'finance-stepping-stone') {
  sql = sql.replace("and coalesce(v_current_department, '') not in ('finance', 'exec')\n",
    "and coalesce(v_current_department, '') not in ('finance', 'exec', 'admin')\n");
} else if (mutation === 'finance-helper-authority') {
  // is_exec_or_owner() joins membership on profiles.active_company_id, which is
  // session state the caller can change mid-call -- cycle 1's P1, one column over.
  sql = sql.replaceAll('public.is_exec_or_owner_of_company(v_company_id)',
    'public.is_exec_or_owner()');
} else if (mutation === 'helper-authority') {
  // Exactly the first version of this migration: authority asked about the
  // caller's CURRENT active company rather than the company being written.
  sql = sql.replaceAll('public.is_owner_admin_of_company(v_company_id)',
    'public.is_owner_admin_of_active_company()');
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

// ── 5a. Review cycle 1, P1: authority follows the company, not the session ───
// The first version of this fix asked is_owner_admin_of_active_company(), which
// re-reads profiles.active_company_id on every call. The lock, the current-role
// read and the upsert all use the company captured at the top, so the two could
// disagree: set_active_company() takes no membership lock, a plpgsql function is
// VOLATILE so each of its queries takes a fresh snapshot, and an admin can make
// the call wait on the lock by saving from the users panel in another request.
//
// Reproduced deterministically instead of with two connections: active_company_id()
// is replaced by a counter that answers Baseballism for the two calls the
// function makes before the guard, then Third Co -- exactly what the resumed
// call would see after a committed switch. crossOwner is 'admin' in Baseballism
// and 'owner_admin' in Third Co, so the stale answer grants authority they do
// not have where it counts.
//
// Under ESC_MUTATION=helper-authority this refusal does not happen and the
// attacker ends up owner_admin of Baseballism.
const withDriftingActiveCompany = async (first, then, fn) => {
  // DDL takes no bind parameters, so the two ids are interpolated. Both are
  // randomUUID() values this file generated, and both are checked to look like
  // uuids before they reach the statement.
  for (const id of [first, then]) {
    assert.match(id, /^[0-9a-f-]{36}$/, 'test company ids must be plain uuids');
  }
  await db.exec('begin');
  try {
    await db.exec(`create or replace function public.active_company_id() returns uuid
             language plpgsql volatile security definer set search_path to 'public','pg_temp'
             as $drift$
             declare n int := coalesce(nullif(current_setting('silo.test_drift', true),''),'0')::int;
             begin
               perform set_config('silo.test_drift', (n+1)::text, true);
               return case when n < 2 then '${first}'::uuid else '${then}'::uuid end;
             end; $drift$`);
    // A refused call aborts the transaction, so everything after it fails with
    // "current transaction is aborted" until the savepoint is unwound -- and
    // that includes the `reset role` in as()'s finally, which would otherwise
    // replace the refusal with that message. This does the role switch itself,
    // between the savepoint and the call, so the real error survives.
    const attempt = async (user, sql, params) => {
      await db.exec('savepoint drift');
      await db.exec('set role authenticated');
      await q("select set_config('request.jwt.claim.sub',$1,false)", [user]);
      let msg = null;
      try { await q(sql, params); } catch (e) { msg = (e && e.message) || String(e); }
      await db.exec('rollback to savepoint drift');
      await db.exec('reset role');
      return msg;
    };
    return await fn(attempt);
  } finally {
    await db.exec('rollback');
  }
};

await test('an active-company switch mid-call cannot grant owner in the locked company', async () => {
  assert.equal(await membershipRole(bbism, crossOwner), 'admin', 'fixture precondition');
  assert.equal(await membershipRole(thirdco, crossOwner), 'owner_admin', 'fixture precondition');

  await withDriftingActiveCompany(bbism, thirdco, async (attempt) => {
    const msg = await attempt(crossOwner,
      'select public.admin_update_profile($1, null, null, $2)', [crossOwner, 'owner']);
    assert.match(msg || '(not refused at all)', /only an owner can grant owner access/,
      'a company switch committed mid-call must not confer owner authority');
    assert.equal(await membershipRole(bbism, crossOwner), 'admin',
      'and nothing may have been written');
  });
});

await test('the three owner-role functions ask about a named company, never the session', async () => {
  const rows = await q(`select p.proname,
      regexp_replace(p.prosrc,'[[:space:]]+',' ','g') ilike '%is_owner_admin_of_company(%' as bound,
      regexp_replace(p.prosrc,'[[:space:]]+',' ','g') ilike '%is_owner_admin_of_active_company%' as mutable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('admin_update_profile','set_workspace_member_role','remove_workspace_member')
   order by p.proname`);
  assert.equal(rows.length, 3, 'all three must be installed');
  for (const r of rows) {
    assert.equal(r.bound, true, `${r.proname} must ask is_owner_admin_of_company(<captured company>)`);
    assert.equal(r.mutable, false, `${r.proname} must not re-read the caller's active company`);
  }
});

await test('the helper is scoped to its argument and is not reachable by anon', async () => {
  // Owner of Third Co, asked about Baseballism, is not an owner of Baseballism.
  const r = await as(crossOwner, () => one(
    `select public.is_owner_admin_of_company($1) as here,
            public.is_owner_admin_of_company($2) as there`, [bbism, thirdco]));
  assert.equal(r.here, false);
  assert.equal(r.there, true);
  const g = await one(`select
    has_function_privilege('anon','public.is_owner_admin_of_company(uuid)','execute') as a,
    has_function_privilege('authenticated','public.is_owner_admin_of_company(uuid)','execute') as u`);
  assert.equal(g.a, false, 'anon must not reach it');
  assert.equal(g.u, true, 'the panel must');
});

// ── 5c. Review cycle 1, P2: the mixed-role owner the old form would demote ───
// admin_list_profiles returns the GLOBAL profiles.role, which the dialog loads
// and used to resend on every save. For a multi-company user promoted through
// Workspace Settings the global column still says 'admin' while the membership
// says 'owner_admin' -- 7 memberships across 5 people on production. The old
// payload therefore asked to demote a real owner during a rename: silently
// before this migration, and as a hard refusal after it. The database keeps the
// refusal; v2/backend.html now sends p_role => null when the dropdown was not
// touched, which is what these two tests pin.
await test('the stale global role is still refused when it is actually sent', async () => {
  assert.equal(await membershipRole(bbism, mixedOwner), 'owner_admin', 'fixture precondition');
  assert.equal(await profileRole(mixedOwner), 'admin', 'global role disagrees, on purpose');

  let msg = null;
  try {
    await as(bbAdmin, () => q(
      'select public.admin_update_profile($1, $2, $3, $4, $5, $6)',
      [mixedOwner, 'Renamed By Admin', 'ops', 'admin', true, null]));
  } catch (e) { msg = e.message; }
  assert.match(msg || '(not refused)', /only an owner can change another owner/,
    'refusing is correct -- the alternative is silently demoting an owner');
  assert.equal(await membershipRole(bbism, mixedOwner), 'owner_admin', 'still an owner');
});

await test('the same rename goes through once the form sends p_role => null', async () => {
  await as(bbAdmin, () => q(
    'select public.admin_update_profile($1, $2, $3, null, $4, null)',
    [mixedOwner, 'Renamed By Admin', 'ops', true]));
  assert.equal((await one('select name from public.profiles where id=$1', [mixedOwner]))?.name,
    'Renamed By Admin', 'the rename must land');
  assert.equal(await membershipRole(bbism, mixedOwner), 'owner_admin',
    'and the membership must be untouched -- the upsert does nothing on conflict');
});

// ── 5d. Finance authority: the second half of the same hole ─────────────
// 'executive' and 'admin' BOTH map to membership 'admin', so an admin sending
// p_role='executive' -- or p_department='finance' -- changes no membership and
// the owner guards above are never reached. Both columns carry authority on
// their own: can_manage_journal_entries() admits `p.department in
// ('finance','exec')`, and is_exec_or_owner() admits
// `lower(p.role::text) = 'executive'`, which gates 27 functions and 80+ RLS
// policies. Until 2026-10-19 this file PINNED that gap as open (the test was
// named "OPEN, see bugs.md: an admin can still self-assign the global executive
// role"); Blake's rule -- "only owner and exec can make admin have finance" --
// closed it, so that assertion is inverted here, which is exactly what the note
// on it said to do.
await refused(
  () => as(plainAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [plainAdmin, 'finance'])),
  /only an owner or executive can grant the finance department/,
  'an admin putting THEMSELVES in finance');

await test('and their department is unchanged afterwards', async () => {
  assert.equal((await one('select department from public.profiles where id=$1', [plainAdmin]))?.department,
    'ops', 'nothing may have been written');
});

await refused(
  () => as(plainAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'finance'])),
  /only an owner or executive can grant the finance department/,
  'an admin putting SOMEBODY ELSE in finance');

await refused(
  () => as(plainAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [plainAdmin, 'exec'])),
  /only an owner or executive can grant the exec department/,
  "the 'exec' department, which carries the same journal authority");

await refused(
  () => as(plainAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [plainAdmin, '  FiNaNcE '])),
  /only an owner or executive can grant the finance department/,
  'padding and capitals do not get past it (the stored value would still be finance)');

await refused(
  () => as(bbAdmin, () => q(
    'select public.admin_update_profile($1, null, null, $2, null, null)', [bbAdmin, 'executive'])),
  /only an owner or executive can grant executive access/,
  'an admin self-assigning the global executive role (was OPEN until 2026-10-19)');

await test('the admin keeps the role they had', async () => {
  assert.equal(await profileRole(bbAdmin), 'admin',
    'is_exec_or_owner() must not have become reachable');
});

// ── Who the rule still lets through ───────────────────────────────────
await test('an OWNER can put somebody in finance', async () => {
  await as(blake, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'finance']));
  assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department,
    'finance');
});

await test('an EXECUTIVE can too -- that is the "and exec" half of the rule', async () => {
  assert.equal(await profileRole(execUser), 'executive', 'fixture precondition');
  assert.equal(await membershipRole(bbism, execUser), 'admin', 'with no owner membership anywhere');
  await as(execUser, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [plainAdmin, 'finance']));
  assert.equal((await one('select department from public.profiles where id=$1', [plainAdmin]))?.department,
    'finance');
});

// ── The regression half: ordinary saves for people already in finance ─────
// 20 of 55 profiles on production are already finance or exec. The panel posts
// every field on every save, so every edit to those people re-sends their own
// department. ESC_MUTATION=finance-guard-on-supplied is the version that breaks
// this, and it breaks the app rather than leaving a hole.
await test('a plain admin can still rename somebody who is ALREADY in finance', async () => {
  await as(plainAdmin, () => q(
    'select public.admin_update_profile($1, $2, $3, null, null, null)',
    [bbMember, 'Member Renamed', 'finance']));
  assert.equal((await one('select name from public.profiles where id=$1', [bbMember]))?.name,
    'Member Renamed', 'a rename must not need owner authority');
  assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department,
    'finance', 'and the department is unchanged');
});

await test('a plain admin can still move somebody OUT of finance', async () => {
  // Deliberate: the rule is about GRANTING authority. Taking it away is not an
  // escalation, any owner or exec can put it back, and refusing it would stop an
  // admin from offboarding somebody. Said out loud here because it is a choice.
  await as(plainAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'logistics']));
  assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department,
    'logistics');
});

await test("the 'admin' department is not a stepping stone to finance", async () => {
  // Found re-reading the diff, not by review: the first version of this guard
  // asked "is their current department in the REFUSED set", which includes
  // 'admin' -- a value that grants nothing. Somebody parked there would have
  // counted as already holding authority, and a plain admin could have walked
  // them on to 'finance'. The question is now asked against ('finance','exec'),
  // the set can_manage_journal_entries() actually admits.
  await q(`update public.profiles set department='admin' where id=$1`, [bbMember]);
  let msg = null;
  try {
    await as(plainAdmin, () => q(
      'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'finance']));
  } catch (e) { msg = e.message; }
  assert.match(msg || '(not refused)', /only an owner or executive can grant the finance department/,
    "the 'admin' department confers no authority, so this is still a grant");
  assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department,
    'admin', 'and nothing may have been written');

  // Moving between two departments that BOTH already carry authority is not a
  // grant, so it stays allowed -- that is what the narrower set buys.
  await q(`update public.profiles set department='finance' where id=$1`, [bbMember]);
  await as(plainAdmin, () => q(
    'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'exec']));
  assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department,
    'exec');
  await q(`update public.profiles set department='logistics' where id=$1`, [bbMember]);
});

await test('a multi-company person is unaffected: the columns are not written at all', async () => {
  // mixedOwner belongs to two companies, so this function never writes their
  // global department or role. The guard must not fire on a value that goes
  // nowhere, or saving them would start failing.
  const before = (await one('select department from public.profiles where id=$1', [mixedOwner]))?.department;
  await as(plainAdmin, () => q(
    'select public.admin_update_profile($1, $2, $3, null, null, null)',
    [mixedOwner, 'Mixed Renamed', 'finance']));
  assert.equal((await one('select department from public.profiles where id=$1', [mixedOwner]))?.department,
    before, 'unchanged, exactly as before this migration');
  assert.equal((await one('select name from public.profiles where id=$1', [mixedOwner]))?.name,
    'Mixed Renamed', 'and the save still goes through');
});

// ── Cycle 1's lesson, applied to the new guard ────────────────────────
// is_exec_or_owner() joins membership on profiles.active_company_id, so it asks
// about session state -- the same mistake the review caught in the owner guard,
// one column over. Here the stored column says Third Co (where crossOwner is an
// owner) while the call captured Baseballism (where they are a plain admin),
// which is the state a committed switch leaves behind while the call waits on
// the shared lock. Under ESC_MUTATION=finance-helper-authority the grant lands.
await test('an active-company switch mid-call cannot confer finance authority', async () => {
  assert.equal(await membershipRole(bbism, crossOwner), 'admin', 'fixture precondition');
  assert.equal(await membershipRole(thirdco, crossOwner), 'owner_admin', 'fixture precondition');

  await withDriftingActiveCompany(bbism, thirdco, async (attempt) => {
    await q('update public.profiles set active_company_id=$2 where id=$1', [crossOwner, thirdco]);
    const msg = await attempt(crossOwner,
      'select public.admin_update_profile($1, null, $2, null, null, null)', [bbMember, 'finance']);
    assert.match(msg || '(not refused at all)',
      /only an owner or executive can grant the finance department/,
      'authority must be asked about the company being written');
    assert.equal((await one('select department from public.profiles where id=$1', [bbMember]))?.department,
      'logistics', 'and nothing may have been written');
  });
});

await test('the finance guard asks the company-bound helper, never the session one', async () => {
  const raw = (await one(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='public' and p.proname='admin_update_profile'`))?.prosrc || '';
  // CODE only. prosrc carries the comments too, and this function's comments
  // discuss is_exec_or_owner() by name on purpose -- asserting over the raw
  // body fires on the prose that explains the fix. The same mistake cost a
  // debugging round on the verify check in this PR's first cycle.
  const code = raw.split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  assert.match(code, /is_exec_or_owner_of_company\(/, 'it must ask about a named company');
  assert.doesNotMatch(code, /is_exec_or_owner\(\)/,
    'and never is_exec_or_owner(), which reads profiles.active_company_id');
});

await test('the finance helper is scoped to its argument and is not reachable by anon', async () => {
  const r = await as(crossOwner, () => one(
    `select public.is_exec_or_owner_of_company($1) as here,
            public.is_exec_or_owner_of_company($2) as there`, [bbism, thirdco]));
  assert.equal(r.here, false, 'a plain admin in Baseballism');
  assert.equal(r.there, true, 'an owner in Third Co');
  const g = await one(`select
    has_function_privilege('anon','public.is_exec_or_owner_of_company(uuid)','execute') as a,
    has_function_privilege('authenticated','public.is_exec_or_owner_of_company(uuid)','execute') as u`);
  assert.equal(g.a, false, 'anon must not reach it');
  assert.equal(g.u, true, 'the panel must');
});

// ── 6. The verify_v2_schema check, actually executed ─────────────────────────
// deployment-drift-check.yml runs verify_v2_schema.sql against production daily.
// A check that cannot return 'ok' against a correct schema is worse than no
// check -- it is red forever and nobody reads it -- and a check that reads 'ok'
// no matter what is worse still. So the statement is extracted by its own marker
// and run here, then re-run against a function with each guard stripped out.
await test('the verify_v2_schema check returns ok against the fixed schema', async () => {
  const row = await one(verifyStatement());
  assert.equal(row.check_name, 'Owner grants are bound to the company being written');
  assert.equal(row.status, 'ok', row.status);
});

await test('the verify check goes CRITICAL when each guard is taken away', async () => {
  // A whole-function replacement per case, because the check reads prosrc: a
  // partial edit would leave the string it looks for behind and read 'ok'.
  const cases = [
    [NEEDLES[0], /does not check owner authority for the company it writes/],
    [NEEDLES[1], /no last-owner guard/],
    [NEEDLES[2], /does not take the shared per-company owner lock/],
    [NEEDLES[3], /does not gate finance authority on owner-or-exec/],
    [NEEDLES[4], /does not refuse the finance, exec and admin departments/],
    [NEEDLES[5], /refuses a department that was only re-sent/],
    [NEEDLES[6], /does not refuse a self-granted global executive role/],
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
