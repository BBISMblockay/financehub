// Backend admin RPCs, scoped to the active company's members, executed as real
// roles against the real migration.
//
// What was wrong (production, 2026-10-09): admin_list_profiles, admin_counts
// and admin_update_profile reached "members of my active company, PLUS every
// profile with no membership anywhere". So every tenant's Backend hub listed
// every stranded signup by name and email -- two founders who had been sent a
// company-creation invite and lost it on the email-confirmation round trip
// among them -- and admin_update_profile let any company's admin set a role on
// such a profile, which upserts a membership into the ADMIN's company.
//
// The fixture first installs production's definitions verbatim and asserts the
// hole is there, so the assertions after the migration prove the migration
// closed it rather than that the fixture never had it.
//
// Mutations (each must make a specific assertion fail):
//   SCOPE_MUTATION=list-keeps-unclaimed     (admin_list_profiles regains the no-membership branch)
//   SCOPE_MUTATION=counts-keeps-unclaimed   (admin_counts regains it)
//   SCOPE_MUTATION=update-claims-unclaimed  (admin_update_profile's old guard is restored)
//   SCOPE_MUTATION=accounts-any-admin       (platform_list_accounts gated by is_admin())
//   SCOPE_MUTATION=accounts-anon            (platform_list_accounts left executable by anon)
//
// Run: node scripts/tests/workspace-admin-scope-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const MUTATIONS = ['list-keeps-unclaimed', 'counts-keeps-unclaimed', 'update-claims-unclaimed',
  'accounts-any-admin', 'accounts-anon'];
const mutation = process.env.SCOPE_MUTATION || '';
assert.ok(mutation === '' || MUTATIONS.includes(mutation), `Unknown scope mutation: ${mutation}`);

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
const ids = (rows) => rows.map((r) => r.id).sort();

// ── Cast ─────────────────────────────────────────────────────────────────────
const blake = randomUUID();         // platform admin; owner_admin of Baseballism
const bbAdmin = randomUUID();       // plain admin of Baseballism
const blockayOwner = randomUUID();  // owner_admin of another tenant
const founder = randomUUID();       // sent a founding invite, has an account, never redeemed
const unconfirmed = randomUUID();   // signed up, never confirmed
const teamInvitee = randomUUID();   // has a pending team invite to Blockay
const lapsed = randomUUID();        // founding invite EXPIRED -- not "pending" any more
const bbism = randomUUID();
const blockay = randomUUID();

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));
await db.exec(`
  alter table auth.users add column created_at timestamptz not null default now();
  alter table auth.users add column email_confirmed_at timestamptz;
  alter table auth.users add column last_sign_in_at timestamptz;
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
`);
await db.exec(await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8'));

await q(`insert into auth.users(id,email,email_confirmed_at,created_at) values
  ($1,'blake@baseballism.com',now(),now()-interval '300 days'),
  ($2,'admin@baseballism.com',now(),now()-interval '200 days'),
  ($3,'owner@blockay.com',now(),now()-interval '30 days'),
  ($4,'founder@newco.com',now(),now()-interval '2 days'),
  ($5,'nobody@unconfirmed.com',null,now()-interval '1 day'),
  ($6,'teammate@blockay.com',now(),now()-interval '3 days'),
  ($7,'late@oldco.com',now(),now()-interval '40 days')`,
  [blake, bbAdmin, blockayOwner, founder, unconfirmed, teamInvitee, lapsed]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values
  ($1,'finance_hub','company','baseballism','seed','Baseballism'),
  ($2,'finance_hub','company','blockay-ops','seed','Blockay Ops')`, [bbism, blockay]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blake, bbism]);
await q(`update public.profiles set role='admin', department='finance', active_company_id=$2 where id=$1`, [bbAdmin, bbism]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`, [blockayOwner, blockay]);
await q(`update public.profiles set name='Stranded Founder' where id=$1`, [founder]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$2,'owner_admin'),($1,$3,'admin'),($4,$5,'owner_admin')`,
  [bbism, blake, bbAdmin, blockay, blockayOwner]);
await q(`insert into public.platform_admins(user_id,note) values ($1,'seed') on conflict (user_id) do nothing`, [blake]);
await q(`insert into public.platform_invites(email,token_hash,status,expires_at) values
  ('Founder@NewCo.com','h1','pending',now()+interval '10 days'),
  ('late@oldco.com','h2','pending',now()-interval '1 day')`);
await q(`insert into public.org_invites(entity_id,email,token_hash) values ($1,'teammate@blockay.com','h3')`, [blockay]);

// ── 0. Production's definitions, and the hole they leave ───────────────────
// admin_list_profiles verbatim from pg_get_functiondef on production,
// 2026-10-09; admin_update_profile reduced to production's guard and the
// membership upsert it guards.
await db.exec(`
create or replace function public.admin_list_profiles() returns setof public.profiles
language plpgsql security definer set search_path to 'public' as $f$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
  select p.* from public.profiles p
  where exists (select 1 from public.entity_memberships em
                where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id)
  order by coalesce(p.updated_at, p.created_at) desc nulls last, p.email asc;
end; $f$;
create or replace function public.admin_update_profile(p_user_id uuid, p_name text default null,
  p_department text default null, p_role text default null, p_is_active boolean default null,
  p_notes text default null) returns void
language plpgsql security definer set search_path to 'public' as $f$
declare v_company_id uuid := public.active_company_id();
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;
  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_company_id, p_user_id, 'member') on conflict (entity_id, user_id) do nothing;
end; $f$;
`);

await test('BEFORE: another tenant\'s admin sees, and can claim, an account that belongs to no company', async () => {
  const seen = await as(blockayOwner, () => q('select id from public.admin_list_profiles()'));
  assert.ok(ids(seen).includes(founder), 'the stranded founder was listed in an unrelated tenant');
  await db.exec('begin');
  try {
    await as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [founder, 'member']));
    const m = await one('select entity_id from public.entity_memberships where user_id=$1', [founder]);
    assert.equal(m.entity_id, bbism, 'one call made a stranger a member of the caller\'s company');
  } finally { await db.exec('rollback'); }
});

// ── Apply the migration under test ──────────────────────────────────────────
let sql = await readFile(new URL('supabase/migrations/20261009120000_workspace_admin_member_scope.sql', root), 'utf8');
const swap = (from, to) => {
  assert.ok(sql.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`);
  sql = sql.replace(from, to);
};
if (mutation === 'list-keeps-unclaimed') {
  swap(`where em.user_id = p.id and em.entity_id = public.active_company_id())
  order by`, `where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id)
  order by`);
} else if (mutation === 'counts-keeps-unclaimed') {
  swap(`where em.user_id = p.id and em.entity_id = public.active_company_id());

  return json_build_object(`, `where em.user_id = p.id and em.entity_id = public.active_company_id())
     or not exists (select 1 from public.entity_memberships em where em.user_id = p.id);

  return json_build_object(`);
} else if (mutation === 'update-claims-unclaimed') {
  swap(`  if not exists (select 1 from public.entity_memberships em
                 where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then`,
  `  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then`);
} else if (mutation === 'accounts-any-admin') {
  swap('if not public.is_platform_admin() then', 'if not public.is_admin() then');
} else if (mutation === 'accounts-anon') {
  swap('revoke all on function public.platform_list_accounts() from public, anon;', '');
}
await db.exec(sql);
// Twice on a clean run: create-or-replace is what makes it re-runnable.
if (!mutation) await db.exec(sql);

// ── 1. The Users panel is this company's members ───────────────────────────
await test('a Baseballism admin lists exactly Baseballism\'s members', async () => {
  const rows = await as(bbAdmin, () => q('select id from public.admin_list_profiles()'));
  assert.deepEqual(ids(rows), [blake, bbAdmin].sort());
});

await test('another tenant lists only its own members, and no stranded account', async () => {
  const rows = await as(blockayOwner, () => q('select id from public.admin_list_profiles()'));
  assert.deepEqual(ids(rows), [blockayOwner]);
});

await test('the backend count agrees with the list', async () => {
  const c = await as(bbAdmin, () => one('select public.admin_counts() as c'));
  assert.equal(c.c.profiles_count, 2);
});

await test('an admin with no resolved company sees nobody, not everybody', async () => {
  await q('update public.profiles set active_company_id=null where id=$1', [bbAdmin]);
  try {
    // is_admin() still passes on the global profile role -- the scope, not the
    // gate, has to be what returns nothing.
    const rows = await as(bbAdmin, () => q('select id from public.admin_list_profiles()'));
    assert.deepEqual(rows, []);
  } finally {
    await q('update public.profiles set active_company_id=$2 where id=$1', [bbAdmin, bbism]);
  }
});

// ── 2. Editing a profile never adds anyone to a company ────────────────────
await refused(
  () => as(bbAdmin, () => q('select public.admin_update_profile($1, null, null, $2)', [founder, 'member'])),
  /not authorized/,
  'a company admin setting a role on an account that belongs to no company');

await test('and the refused call left no membership behind', async () => {
  const m = await q('select 1 from public.entity_memberships where user_id=$1', [founder]);
  assert.equal(m.length, 0);
});

await refused(
  () => as(blockayOwner, () => q('select public.admin_update_profile($1, $2)', [bbAdmin, 'renamed'])),
  /not authorized/,
  'one tenant editing another tenant\'s member');

await test('editing one of your own members still works', async () => {
  await as(blake, () => q('select public.admin_update_profile($1, null, $2)', [bbAdmin, 'ops']));
  const p = await one('select department from public.profiles where id=$1', [bbAdmin]);
  assert.equal(p.department, 'ops');
});

// ── 3. Silo Admin: every account, with why it has no company ───────────────
await test('the platform admin sees every account, stranded ones first, each with a reason', async () => {
  const rows = await as(blake, () => q('select * from public.platform_list_accounts()'));
  assert.equal(rows.length, 7, 'one row per auth user');
  const by = Object.fromEntries(rows.map((r) => [r.user_id, r]));
  assert.equal(by[founder].state, 'founder_invite_pending',
    'invite matched case-insensitively on email');
  assert.ok(by[founder].founder_invite_expires_at, 'and its expiry is carried for follow-up');
  assert.equal(by[founder].name, 'Stranded Founder');
  assert.equal(by[unconfirmed].state, 'unconfirmed');
  assert.equal(by[teamInvitee].state, 'team_invite_pending');
  assert.equal(by[lapsed].state, 'no_company', 'an expired founding invite is not pending');
  assert.equal(by[lapsed].founder_invite_expires_at, null);
  assert.equal(by[blockayOwner].state, 'member');
  assert.deepEqual(by[blake].companies.map((c) => c.title), ['Baseballism']);
  const firstMember = rows.findIndex((r) => r.state === 'member');
  assert.ok(rows.slice(firstMember).every((r) => r.state === 'member'),
    'accounts with no company sort ahead of members');
});

await refused(
  () => as(bbAdmin, () => q('select * from public.platform_list_accounts()')),
  /not authorized/,
  'a company admin reading every account on the platform');

await refused(
  () => as(blockayOwner, () => q('select * from public.platform_list_accounts()')),
  /not authorized/,
  'a company OWNER reading every account on the platform');

await refused(
  () => as(null, () => q('select * from public.platform_list_accounts()'), 'anon'),
  /permission denied/,
  'anon calling platform_list_accounts at all');

// ── 4. The verify check, actually executed ─────────────────────────────────
await test('the verify_v2_schema check passes here, and fails when each guard is broken', async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf('-- ── Workspace admin RPCs are member-scoped (20261009120000)');
  const end = verify.indexOf('-- ── A SECOND claimed region');
  assert.ok(start > 0 && end > start, 'the check must sit above the onboarding fixture\'s claimed region');
  const stmts = verify.slice(start, end).split(/;\s*\n/)
    .filter((x) => /^\s*(--[^\n]*\n)*\s*select/i.test(x));
  assert.equal(stmts.length, 1);
  const stmt = stmts[0] + ';';
  const status = async () => (await one(stmt)).status;

  assert.equal(await status(), 'ok');

  await db.exec('begin');
  await db.exec(`create or replace function public.admin_counts() returns json language plpgsql
    security definer as $c$ begin
      perform 1 from public.profiles p
      where exists (select 1 from public.entity_memberships em where em.user_id = p.id)
         or not exists (select 1 from public.entity_memberships em where em.user_id = p.id);
      return '{}'::json; end; $c$`);
  assert.match(await status(), /still shows accounts that belong to no company/);
  await db.exec('rollback');

  await db.exec('begin');
  await db.exec(`create or replace function public.admin_update_profile(p_user_id uuid, p_name text default null,
    p_department text default null, p_role text default null, p_is_active boolean default null,
    p_notes text default null) returns void language plpgsql security definer as $u$ begin
      if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
         and false then raise exception 'not authorized'; end if; end; $u$`);
  assert.match(await status(), /can pull an account with no company/);
  await db.exec('rollback');

  await db.exec('grant execute on function public.platform_list_accounts() to anon');
  assert.match(await status(), /anon can execute/);
  await db.exec('revoke execute on function public.platform_list_accounts() from anon');

  await db.exec('begin');
  await db.exec('drop function public.platform_list_accounts()');
  assert.match(await status(), /MISSING/);
  await db.exec('rollback');

  assert.equal(await status(), 'ok', 'and back to ok once every break is undone');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
