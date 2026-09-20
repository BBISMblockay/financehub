// Workspace Settings' membership administration, executed as real roles
// against the real migration.
//
// The Team tab's two new verbs are the whole reason this file exists, because
// both replace something that was quietly wrong:
//
//  1. CHANGING A ROLE used to mean admin_update_profile(), which writes the
//     GLOBAL profiles.role as well as the membership. profiles.role is not
//     per-company, and gates read it on its own -- can_manage_journal_entries()
//     admits on p.role / p.department with no reference to which company you
//     are in -- so an admin of company B could change what somebody may do
//     inside company A. The assertion below drives exactly that: a user who
//     belongs to BOTH companies is demoted in one, and their authority in the
//     other must not move.
//
//  2. REMOVING SOMEBODY had no implementation at all. The nearest thing,
//     admin_update_profile(p_is_active => false), sets a global flag and locks
//     the person out of every company they belong to.
//
// Plus the two safeguards that are only interesting when they REFUSE: a
// workspace may not be left without an owner, and an admin may not remove
// themselves (which would strand their own session pointing at a company they
// are no longer a member of).
//
// What this file cannot cover: PGlite is one connection, so nothing here
// exercises two callers interleaving. The FOR UPDATE on the membership row is
// there for the same reason the invite row takes one; proving it needs real
// connections, as scripts/tests/onboarding-concurrency.test.mjs does.
//
// Mutations (each must make a specific assertion fail):
//   WS_MUTATION=role-writes-global-always   (the has-other-org guard removed)
//   WS_MUTATION=allow-last-owner-demote     (the last-owner guard removed from the role change)
//   WS_MUTATION=strip-removal-guards        (ALL THREE removal guards removed -- see below)
//   WS_MUTATION=allow-self-remove           (the self-removal guard removed)
//   WS_MUTATION=admin-grants-owner          (any admin may hand out owner_admin)
//   WS_MUTATION=platform-list-any-admin     (is_admin() gates the platform company list)
//   WS_MUTATION=remove-keeps-invite         (a removed member's pending invite is left live)
//
// Run: node scripts/tests/workspace-settings-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.WS_MUTATION || '';
assert.ok(['', 'role-writes-global-always', 'allow-last-owner-demote', 'strip-removal-guards',
  'allow-self-remove', 'admin-grants-owner', 'platform-list-any-admin', 'remove-keeps-invite',
].includes(mutation), `Unknown workspace-settings mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

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
const rpc = async (name, args) =>
  Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];

// ── Cast ─────────────────────────────────────────────────────────────────────
const blake = randomUUID();      // platform admin; owner_admin of Baseballism
const bbAdmin = randomUUID();    // plain admin of Baseballism
const dual = randomUUID();       // member of BOTH companies -- the cross-tenant case
const blockayOwner = randomUUID();
const blockayMember = randomUUID();
const bbism = randomUUID();
const blockay = randomUUID();

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));

// Three tables the onboarding fixture has no reason to carry but these
// functions touch: the invite ledger a removal spends, and the two reads the
// platform list joins. Shapes copied from their own migrations.
await db.exec(`
  create table public.org_invites (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references public.entities(id) on delete cascade,
    email text not null,
    role text not null default 'user',
    department text not null default 'ops',
    token_hash text not null,
    status text not null default 'pending',
    expires_at timestamptz not null default now() + interval '14 days',
    invited_by uuid,
    created_at timestamptz not null default now()
  );
  create table public.sync_jobs (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid not null references public.entities(id) on delete cascade,
    job_type text not null,
    status text not null default 'pending',
    finished_at timestamptz,
    created_at timestamptz not null default now()
  );
  create table public.billing_subscriptions (
    company_entity_id uuid primary key references public.entities(id) on delete cascade,
    stripe_customer_id text not null,
    plan_key text,
    status text,
    created_at timestamptz not null default now()
  );
`);

await q(`insert into auth.users(id,email) values
  ($1,'blake@baseballism.com'),($2,'admin@baseballism.com'),($3,'dual@contractor.com'),
  ($4,'owner@blockay.com'),($5,'member@blockay.com')`,
  [blake, bbAdmin, dual, blockayOwner, blockayMember]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values
  ($1,'finance_hub','company','baseballism','seed','Baseballism'),
  ($2,'finance_hub','company','blockay-ops','seed','Blockay Ops')`, [bbism, blockay]);

await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blake, bbism]);
await q(`update public.profiles set role='admin', department='finance', active_company_id=$2 where id=$1`, [bbAdmin, bbism]);
// The cross-tenant case: department 'finance' is what can_manage_journal_entries()
// admits on, globally, with no reference to the active company.
await q(`update public.profiles set role='admin', department='finance', active_company_id=$2 where id=$1`, [dual, blockay]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blockayOwner, blockay]);
await q(`update public.profiles set role='user', department='ops', active_company_id=$2 where id=$1`, [blockayMember, blockay]);

await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$2,'owner_admin'),($1,$3,'admin'),($1,$4,'admin'),
  ($5,$6,'owner_admin'),($5,$7,'member'),($5,$4,'admin')`,
  [bbism, blake, bbAdmin, dual, blockay, blockayOwner, blockayMember]);

// ── Apply the migrations under test ─────────────────────────────────────────
await db.exec(await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8'));
// The migration seeds blake@baseballism.com itself; this is belt and braces
// for a fixture whose email could change out from under it.
await q(`insert into public.platform_admins(user_id,note) values ($1,'seed')
         on conflict (user_id) do nothing`, [blake]);
await q(`insert into public.company_settings(company_entity_id,business_timezone,default_currency)
         values ($1,'America/Los_Angeles','USD'),($2,'America/Los_Angeles','USD')`, [bbism, blockay]);

let sql = await readFile(new URL('supabase/migrations/20260920120000_workspace_settings_admin.sql', root), 'utf8');

if (mutation === 'role-writes-global-always') {
  sql = sql.replace('if not v_other_orgs then', 'if true then');
} else if (mutation === 'allow-last-owner-demote') {
  sql = sql.replace(/if \(select count\(\*\) from public\.entity_memberships em\n {9}where em\.entity_id = v_company and em\.role = 'owner_admin'\) <= 1 then\n {6}raise exception 'this workspace must keep at least one owner';\n {4}end if;\n {2}end if;\n\n {2}update public\.entity_memberships/,
    'end if;\n\n  update public.entity_memberships');
} else if (mutation === 'strip-removal-guards') {
  // All three of remove_workspace_member's refusals at once. Its last-owner
  // check is unreachable while the other two stand, so mutating it alone
  // changes nothing; the invariant it protects is only observable here.
  const parts = sql.split("raise exception 'this workspace must keep at least one owner';");
  assert.equal(parts.length, 3, 'both last-owner guards should be present to mutate one');
  sql = parts[0] + "raise exception 'this workspace must keep at least one owner';"
    + parts[1] + 'null;' + parts[2];
  sql = sql.replace("raise exception 'you cannot remove yourself from this workspace';", 'null;');
  sql = sql.replace("raise exception 'only an owner can remove another owner';", 'null;');
} else if (mutation === 'allow-self-remove') {
  sql = sql.replace("raise exception 'you cannot remove yourself from this workspace';", 'null;');
} else if (mutation === 'admin-grants-owner') {
  sql = sql.replace("if (v_role = 'owner_admin') and not public.is_owner_admin_of_active_company() then",
    'if false then');
} else if (mutation === 'platform-list-any-admin') {
  sql = sql.replace(/if not public\.is_platform_admin\(\) then/, 'if not public.is_admin() then');
} else if (mutation === 'remove-keeps-invite') {
  sql = sql.replace(/update public\.org_invites\n {5}set status = 'revoked'[\s\S]*?p_user_id\);/,
    'perform 1;');
}

await db.exec(sql);
// Applied twice on a clean run, because create-or-replace is the only thing
// making this file re-runnable and a fresh CREATE would hide a conflict.
if (!mutation) await db.exec(sql);

// ── 1. A role change does not reach into another company ────────────────────
await test('a workspace role change writes the membership and leaves the other company alone', async () => {
  const before = await one(`select role::text as role, department from public.profiles where id=$1`, [dual]);
  assert.equal(before.role, 'admin');

  await as(blockayOwner, () => rpc('set_workspace_member_role', [dual, 'viewer']));

  const here = await one(`select role from public.entity_memberships where entity_id=$1 and user_id=$2`, [blockay, dual]);
  const there = await one(`select role from public.entity_memberships where entity_id=$1 and user_id=$2`, [bbism, dual]);
  const profile = await one(`select role::text as role, department from public.profiles where id=$1`, [dual]);

  assert.equal(here.role, 'viewer', 'the membership in this workspace changed');
  assert.equal(there.role, 'admin', 'the membership in the other workspace did not');
  assert.equal(profile.role, 'admin',
    'the GLOBAL profile role must not move for somebody who belongs to another company');
  assert.equal(profile.department, 'finance', 'and their department is nobody else\'s to rewrite');
});

await test('for a single-company member, the global profile role is kept in step', async () => {
  const res = await as(blockayOwner, () => rpc('set_workspace_member_role', [blockayMember, 'admin']));
  assert.equal(res.global_role_updated, true);
  assert.equal((await one(`select role::text as role from public.profiles where id=$1`, [blockayMember])).role, 'admin');
  assert.equal((await one(`select role from public.entity_memberships where entity_id=$1 and user_id=$2`,
    [blockay, blockayMember])).role, 'admin');
});

// ── 2. The safeguards, which are only interesting when they refuse ──────────
// The removal's last-owner check is a BACKSTOP, and deliberately unreachable
// while the two guards in front of it hold: to reach it a caller must be an
// owner_admin removing the only owner_admin, which is themselves, which the
// self-removal guard already refused. So it cannot be mutated on its own --
// dropping it changes no outcome, and a mutation that "fails to be caught"
// would be reporting the truth. WS_MUTATION=strip-removal-guards therefore
// drops all three together, which is the state this asserts against: however
// the front guards are relaxed in future, a workspace is never left ownerless.
await test('a workspace is never left without an owner, whoever asks', async () => {
  const second = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'second@blockay.com')`, [second]);
  await q(`update public.profiles set active_company_id=$2 where id=$1`, [second, blockay]);
  await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'owner_admin')`, [blockay, second]);
  // Two owners, so one may genuinely go.
  await as(blockayOwner, () => rpc('remove_workspace_member', [second]));
  assert.equal((await q(`select 1 from public.entity_memberships where entity_id=$1 and user_id=$2`, [blockay, second])).length, 0);

  // Now the survivor, from every direction. Outcome, not message: which guard
  // refuses is an implementation detail, an ownerless workspace is not.
  for (const caller of [blockayMember, blockayOwner, blake]) {
    try { await as(caller, () => rpc('remove_workspace_member', [blockayOwner])); } catch (_) { /* expected */ }
  }
  const owners = await q(`select 1 from public.entity_memberships where entity_id=$1 and role='owner_admin'`, [blockay]);
  assert.equal(owners.length, 1, 'the workspace still has an owner');
});

await refused(
  () => as(blockayOwner, () => rpc('set_workspace_member_role', [blockayOwner, 'admin'])),
  /must keep at least one owner/,
  'demoting the only owner of a workspace');

await refused(
  () => as(blockayOwner, () => rpc('remove_workspace_member', [blockayOwner])),
  /cannot remove yourself/,
  'an admin removing themselves');

await refused(
  () => as(bbAdmin, () => rpc('set_workspace_member_role', [bbAdmin, 'owner_admin'])),
  /only an owner can grant owner access/,
  'a plain admin promoting themselves to owner');

await refused(
  () => as(blockayMember, () => rpc('set_workspace_member_role', [blockayOwner, 'member'])),
  /only an owner can change another owner|must keep at least one owner/,
  'a non-owner demoting an owner');

// ── 3. A removal is scoped to one workspace ─────────────────────────────────
await test('removing a member ends their membership here and nowhere else', async () => {
  await q(`insert into public.org_invites(entity_id,email,token_hash) values ($1,'dual@contractor.com','hash')`, [blockay]);

  const res = await as(blockayOwner, () => rpc('remove_workspace_member', [dual]));
  assert.equal(res.deactivated, false, 'they still belong to Baseballism, so nothing global changes');

  assert.equal((await q(`select 1 from public.entity_memberships where entity_id=$1 and user_id=$2`, [blockay, dual])).length, 0);
  assert.equal((await q(`select 1 from public.entity_memberships where entity_id=$1 and user_id=$2`, [bbism, dual])).length, 1,
    'their other workspace is untouched');

  const p = await one(`select is_active, active_company_id from public.profiles where id=$1`, [dual]);
  assert.equal(p.is_active, true, 'is_active is global and is not what removal means');
  assert.equal(p.active_company_id, bbism, 'their session is repointed at a company they are still in');

  const inv = await one(`select status from public.org_invites where entity_id=$1 and email='dual@contractor.com'`, [blockay]);
  assert.equal(inv.status, 'revoked',
    'a live invite would let them walk straight back in through a link already in their inbox');
});

await test('a member left with no workspace at all is deactivated, not left adoptable', async () => {
  const res = await as(blockayOwner, () => rpc('remove_workspace_member', [blockayMember]));
  assert.equal(res.deactivated, true);
  const p = await one(`select is_active, active_company_id from public.profiles where id=$1`, [blockayMember]);
  assert.equal(p.is_active, false);
  assert.equal(p.active_company_id, null);
});

// ── 4. Cross-tenant and authorization ───────────────────────────────────────
await refused(
  () => as(blockayOwner, () => rpc('set_workspace_member_role', [blake, 'viewer'])),
  /not a member of this workspace/,
  'reaching a member of another company');

await refused(
  () => as(randomUUID(), () => rpc('set_workspace_member_role', [bbAdmin, 'viewer'])),
  /not authorized/,
  'a signed-in stranger changing roles');

// ── 5. Renaming, and the platform list ──────────────────────────────────────
await test('only an owner renames the workspace, and only the title moves', async () => {
  await as(blockayOwner, () => rpc('set_workspace_company_name', ['Blockay Operations']));
  const e = await one(`select title, entity_key, meta from public.entities where id=$1`, [blockay]);
  assert.equal(e.title, 'Blockay Operations');
  assert.equal(e.entity_key, 'blockay-ops', 'entity_key is not the browser\'s to write');
  await assert.rejects(() => as(bbAdmin, () => rpc('set_workspace_company_name', ['Not Mine'])),
    /only an owner can rename/, 'an admin of another company cannot rename anything');
  assert.equal((await one(`select title from public.entities where id=$1`, [bbism])).title, 'Baseballism');
});

await test('the platform company list is platform-admin only, and shows every tenant', async () => {
  await q(`insert into public.sync_jobs(company_entity_id,job_type,status,finished_at)
           values ($1,'sync_orders','success',now()),($1,'sync_orders','error',now())`, [bbism]);
  await q(`insert into public.billing_subscriptions(company_entity_id,stripe_customer_id,plan_key,status)
           values ($1,'cus_1','growth','active')`, [blockay]);

  const rows = await as(blake, () => q(`select * from public.platform_list_companies()`));
  assert.equal(rows.length, 2, 'a platform admin sees every company, not just their own');
  const bo = rows.find((r) => r.entity_key === 'blockay-ops');
  assert.equal(bo.subscription_status, 'active');
  assert.equal(bo.plan_key, 'growth');
  assert.equal(bo.business_timezone, 'America/Los_Angeles');
  const bb = rows.find((r) => r.entity_key === 'baseballism');
  assert.ok(bb.last_sync_at, 'a successful sync is reported');
  assert.equal(Number(bb.owner_admin_count), 1);
});

await refused(
  () => as(blockayOwner, () => q(`select * from public.platform_list_companies()`)),
  /not authorized/,
  'a company OWNER reading the platform company list');

await refused(
  () => as(bbAdmin, () => q(`select * from public.platform_list_companies()`)),
  /not authorized/,
  'an ordinary admin of the platform admin\'s own company reading it');

// ── 6. The verify check, actually executed ──────────────────────────────────
// A check that sits in verify_v2_schema.sql and has never run is a check
// nobody knows the shape of. This executes it against the migrated schema, and
// then breaks each thing it guards to confirm it can go red at all.
await test('the verify_v2_schema check passes here, and fails when its guard is broken', async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf('-- ── Workspace Settings administration (20260920120000)');
  const end = verify.indexOf('-- ── A SECOND claimed region');
  assert.ok(start > 0 && end > start, 'the check must sit above the onboarding fixture\'s claimed region');
  const stmt = verify.slice(start, end).split(/;\s*\n/)
    .filter((x) => /^\s*(--[^\n]*\n)*\s*select/i.test(x))[0] + ';';

  assert.equal((await one(stmt)).status, 'ok');

  await db.exec('grant insert on public.entity_memberships to authenticated');
  assert.match((await one(stmt)).status, /can write entity_memberships directly/);
  await db.exec('revoke insert on public.entity_memberships from authenticated');

  await db.exec('grant execute on function public.remove_workspace_member(uuid) to anon');
  assert.match((await one(stmt)).status, /anon can execute/);
  await db.exec('revoke execute on function public.remove_workspace_member(uuid) from anon');

  // The lock clause, dropped: a replacement body with no advisory lock in it.
  // This is the static half of the guard -- the behavioural half is
  // scripts/tests/workspace-settings-concurrency.test.mjs, which needs two
  // real connections and so cannot live here.
  await db.exec(`create or replace function public.remove_workspace_member(p_user_id uuid)
                 returns json language sql security definer as $ws$ select '{}'::json $ws$`);
  assert.match((await one(stmt)).status, /owner-count lock is missing/);

  await db.exec('drop function public.set_workspace_company_name(text)');
  assert.match((await one(stmt)).status, /MISSING/);
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
