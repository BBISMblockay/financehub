// Tenant boundary regressions for SECURITY DEFINER functions, executed against
// a real PostgreSQL (PGlite).
//
// WHAT THIS PROTECTS
// RLS is not the only tenant boundary in SILO, and for SECURITY DEFINER
// functions it is not a boundary at all: a definer function runs as its OWNER,
// so RLS on everything it touches is bypassed and the EXECUTE grant is the
// whole control. Supabase's default privileges on the `public` schema grant
// EXECUTE to `public` -- and therefore to anon and authenticated -- on every
// newly created function unless it is revoked explicitly, so the insecure state
// is the DEFAULT and arrives without anyone writing a line of SQL to cause it.
//
// The 2026-09-17 audit found three live instances, each confirmed callable as
// `anon` (the key in pages/config.js, i.e. the public internet) against a
// company the caller had no relationship to:
//   * purge_better_reports_overlap  -- DELETEs another tenant's sales_by_day
//   * backfill_company_entity_batch -- stamps unclaimed rows with ANY company id
//   * attach_stamp_company_entity_id_triggers -- DDL across every tenant table
// 20260917210000_tenant_boundary_hardening.sql revokes all three (plus an
// unauthenticated 300s matview refresh) and adds an in-body guard.
//
// ASSERTION 2 IS THE ONE THAT MATTERS MOST and is the reason this file is a
// behavioural test and not just a grep. The obvious in-body guard --
//     if current_user in ('anon', 'authenticated') then raise ...
// -- is INERT. Inside a SECURITY DEFINER function `current_user` and
// `session_user` are BOTH the function's owner, whoever called it, so that
// guard never fires. It reads in review like a working control, it passes a
// "does the guard exist" grep, and it protects nothing. The first draft of the
// migration shipped exactly that, and only a mutation test -- re-grant EXECUTE,
// then call as each role -- caught it. `current_setting('role', true)` is what
// actually survives the definer boundary, because PostgREST sets that GUC per
// request with SET LOCAL ROLE.
//
// So: assertion 1 pins the fix, assertion 2 pins the trap. If someone later
// "simplifies" the guard back to current_user, assertion 2 is what fails.
//
// Run: node scripts/tests/tenant-boundary.test.mjs
//   (needs: npm ci --prefix scripts/tests/finance-db --ignore-scripts)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const MIGRATION = 'supabase/migrations/20260917210000_tenant_boundary_hardening.sql';
const BASEBALLISM = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';

// The four primitives the migration puts out of reach of browser sessions.
// Each takes the company it acts on as an ARGUMENT rather than reading
// active_company_id(), which is precisely why a client must not reach them:
// there is no point at which the caller's own tenancy constrains the target.
const SERVICE_ROLE_ONLY = [
  'purge_better_reports_overlap',
  'backfill_company_entity_batch',
  'attach_stamp_company_entity_id_triggers',
  'refresh_demand_coverage_base_mv',
];

let run = 0;
let failures = 0;
async function test(name, fn) {
  run += 1;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err && err.message}`);
  }
}

/** Call fn() as `role` in a rolled-back transaction; return its value or 'REFUSED'. */
async function callAs(db, role, sql) {
  await db.exec('begin');
  try {
    await db.exec(`set local role ${role}`);
    const res = await db.query(sql);
    return res.rows[0] ? Object.values(res.rows[0])[0] : null;
  } catch (err) {
    if (String(err && err.message).includes('service-role only')) return 'REFUSED';
    throw err;
  } finally {
    await db.exec('rollback');
  }
}

const db = new PGlite();
await db.exec('create role anon; create role authenticated; create role service_role;');

// The guard as shipped, and the guard as it is tempting to write.
await db.exec(`
  create function public.guard_role_guc() returns text language plpgsql security definer as $f$
  begin
    if coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
      raise exception 'service-role only' using errcode = '42501';
    end if;
    return 'ran';
  end;$f$;

  create function public.guard_current_user() returns text language plpgsql security definer as $f$
  begin
    if current_user in ('anon', 'authenticated') then
      raise exception 'service-role only' using errcode = '42501';
    end if;
    return 'ran';
  end;$f$;
`);

// Reproduce the hazard the migration defends against: EXECUTE is held by the
// client roles. The guard has to hold anyway.
await db.exec(`
  grant execute on function public.guard_role_guc() to anon, authenticated, service_role;
  grant execute on function public.guard_current_user() to anon, authenticated, service_role;
`);

console.log('tenant-boundary');

await test('role-GUC guard refuses anon and authenticated even with EXECUTE granted', async () => {
  assert.equal(await callAs(db, 'anon', 'select public.guard_role_guc()'), 'REFUSED',
    'anon reached a service-role-only function');
  assert.equal(await callAs(db, 'authenticated', 'select public.guard_role_guc()'), 'REFUSED',
    'an authenticated session reached a service-role-only function');
});

await test('role-GUC guard still lets the service-role callers through', async () => {
  // Every real caller is a service-role path (shopify-sync.mjs,
  // sync-silo-inventory-sales.mjs, backfill-company-entity-large-tables.mjs,
  // and the shopify-sync-run edge function's admin client). A guard that broke
  // them would be reverted within a day and the hole would come back with it.
  assert.equal(await callAs(db, 'service_role', 'select public.guard_role_guc()'), 'ran');
});

await test('current_user guard is INERT under SECURITY DEFINER (do not write it)', async () => {
  // This is not a bug being asserted -- it is the trap being pinned. If this
  // assertion ever fails because anon is refused, Postgres changed its
  // semantics and the shipped guard should be revisited. Until then, any guard
  // written with current_user protects nothing.
  assert.equal(await callAs(db, 'anon', 'select public.guard_current_user()'), 'ran',
    'current_user now discriminates under SECURITY DEFINER; re-check the shipped guard');
  assert.equal(await callAs(db, 'authenticated', 'select public.guard_current_user()'), 'ran');
});

await test('current_user and session_user are both the OWNER inside a definer function', async () => {
  await db.exec(`
    create function public.whoami() returns text language plpgsql security definer as $f$
    begin
      return format('%s/%s/%s', current_user, session_user,
                    coalesce(current_setting('role', true), '<none>'));
    end;$f$;
    grant execute on function public.whoami() to anon;
  `);
  const seen = await callAs(db, 'anon', 'select public.whoami()');
  const [currentUser, sessionUser, roleGuc] = String(seen).split('/');
  assert.notEqual(currentUser, 'anon', 'current_user leaked the caller; guard assumptions change');
  assert.notEqual(sessionUser, 'anon', 'session_user leaked the caller');
  assert.equal(roleGuc, 'anon', 'the role GUC is the only signal that survives; it must');
});

// ── Static assertions against the shipped migration ─────────────────────────
// The behavioural tests above prove the MECHANISM. These prove the migration
// actually uses it, so the two cannot drift apart.
const sql = await readFile(new URL(MIGRATION, root), 'utf8');

await test('migration revokes the client roles on every service-role-only primitive', async () => {
  for (const fn of SERVICE_ROLE_ONLY) {
    for (const role of ['anon', 'authenticated']) {
      const pattern = new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role};`);
      assert.match(sql, pattern, `${fn} is not revoked from ${role}`);
    }
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`),
      `${fn} lost its service_role grant, which would break the nightly sync`);
  }
});

await test('migration guards read the role GUC, never current_user', async () => {
  assert.ok(sql.includes("current_setting('role', true)"),
    'the shipped guard does not read the role GUC');
  assert.ok(!/if\s+current_user\s+in\s*\(/.test(sql),
    'the shipped guard uses current_user, which is inert under SECURITY DEFINER');
});

await test('destructive purge carries no default company', async () => {
  // A default target on a DELETE means a mistyped call silently becomes a call
  // against production's largest tenant. It used to default to Baseballism.
  const decl = sql.slice(sql.indexOf('create function public.purge_better_reports_overlap'));
  const signature = decl.slice(0, decl.indexOf(')'));
  assert.ok(!/default/i.test(signature),
    'purge_better_reports_overlap has a default argument again');
});

await test('no RPC resolves an ambiguous tenant by naming Baseballism', async () => {
  // active_company_id() returns NULL rather than guessing, which is right. The
  // bug was callers coalescing that NULL to a literal company. Membership is a
  // grant of access to a tenant's data, so an unknown tenant must stop the
  // call. The uuid may still appear in PROSE here; what must not appear is a
  // coalesce that falls back to it.
  const coalesceToBaseballism = new RegExp(`coalesce\\([^;]*'${BASEBALLISM}'`, 'i');
  assert.ok(!coalesceToBaseballism.test(sql),
    'a membership-granting RPC still falls back to Baseballism');
  assert.ok(sql.includes('no active company: cannot resolve which organization'),
    'the fail-closed branch is missing');
});


await test('the approver-company guard resolves once, fails closed, and compares with IS DISTINCT FROM', () => {
  // Three separate properties, because only the first is load-bearing today and
  // the other two are what keep it that way.
  //
  // With the null check present, `<>` and `IS DISTINCT FROM` behave
  // identically -- v_actor_company cannot be null -- so a mutation reverting
  // only the operator does NOT fail the behavioural test above. That is
  // correct, not a gap in it, and it is exactly why the operator is pinned
  // here instead: it is the belt that keeps the guard sound if the null check
  // is ever moved or removed, and a belt nobody checks decays silently.
  const fn = sql.slice(sql.indexOf('create or replace function public.approve_access_request'));
  // Strip -- comment lines first. The comments in this migration deliberately
  // QUOTE the old, broken guard to explain it, so an unstripped search finds
  // the bug in the prose and reports the fix as missing. (It did, first run.)
  const body = fn.slice(0, fn.indexOf('$function$;'))
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  assert.ok(/v_actor_company\s*:=\s*public\.active_company_id\(\)/.test(body),
    'the approver company is no longer resolved into a variable');
  assert.ok(body.indexOf('v_actor_company :=') < body.indexOf('from public.access_requests'),
    'the approver company must be resolved BEFORE the request is read');
  assert.ok(/company_entity_id is distinct from v_actor_company/.test(body),
    'the cross-tenant guard compares with <>, which is NULL (not TRUE) against a null company');
  assert.ok(!/company_entity_id <> public\.active_company_id\(\)/.test(body),
    'the guard calls active_company_id() inline again instead of using the resolved value');
});

// ── approve_access_request: the null-active-company hole ────────────────────
// Raised by the cycle-1 independent review on PR #722, against the FIRST
// version of this migration -- which closed the coalesce-to-Baseballism rung
// and left this one open.
//
// The guard read `v_req.company_entity_id <> public.active_company_id()`. In
// SQL `x <> null` is NULL, not TRUE, so for an approver with no active company
// the whole condition is NULL, the IF does not fire, and the guard PASSES.
// That state is reachable: is_admin() falls back to the global profiles.role
// whenever there is no membership row for the active company, which includes
// active_company_id() being null. coalesce() then selected the REQUEST's
// company -- Tenant B -- so the RPC granted a Tenant B membership to someone
// Tenant B never approved. The fail-closed check added elsewhere in the same
// migration does not catch it, because the company it resolves is non-null.
//
// This runs the REAL function text out of the migration file against a minimal
// fixture, so the test cannot drift from what ships.
const fx = new PGlite();
await fx.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('test.uid', true), '')::uuid
  $f$;
  create type app_role as enum ('owner','admin','executive','user');
  create table public.entities (id uuid primary key, title text);
  create table public.profiles (
    id uuid primary key, email text, name text, role app_role,
    department text, is_active boolean default true, active_company_id uuid,
    created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.entity_memberships (
    entity_id uuid, user_id uuid, role text, primary key (entity_id, user_id));
  create table public.access_requests (
    id uuid primary key, user_id uuid, email text, full_name text,
    department text, requested_role text, status text default 'pending',
    company_entity_id uuid);
`);
// active_company_id() and is_admin() copied from the live definitions.
await fx.exec(`
  create function public.active_company_id() returns uuid language sql stable as $f$
    select active_company_id from public.profiles where id = auth.uid();
  $f$;
  create function public.is_admin() returns boolean language sql stable as $f$
    select exists (
      select 1 from public.profiles p
      left join public.entity_memberships em
        on em.user_id = p.id and em.entity_id = p.active_company_id
      where p.id = auth.uid() and coalesce(p.is_active, true) = true
        and case when em.role is not null
              then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
              else lower(p.role::text) in ('owner','admin','executive')
            end);
  $f$;
`);

const TENANT_A = '11111111-1111-4111-a111-111111111111';
const TENANT_B = '22222222-2222-4222-a222-222222222222';
const ADMIN_NO_CO = '33333333-3333-4333-a333-333333333333';
const ADMIN_A = '44444444-4444-4444-a444-444444444444';
const ADMIN_B = '55555555-5555-4555-a555-555555555555';
const APPLICANT = '66666666-6666-4666-a666-666666666666';
const REQ_B = '77777777-7777-4777-a777-777777777777';

await fx.exec(`
  insert into public.entities values ('${TENANT_A}','Tenant A'), ('${TENANT_B}','Tenant B');
  insert into public.profiles (id, email, role, active_company_id) values
    ('${ADMIN_NO_CO}','noco@x','admin', null),
    ('${ADMIN_A}','a@x','admin','${TENANT_A}'),
    ('${ADMIN_B}','b@x','admin','${TENANT_B}');
  insert into public.entity_memberships values
    ('${TENANT_A}','${ADMIN_A}','admin'), ('${TENANT_B}','${ADMIN_B}','admin');
  insert into public.access_requests (id, user_id, email, full_name, company_entity_id)
    values ('${REQ_B}','${APPLICANT}','applicant@x','Applicant','${TENANT_B}');
`);

// Load the shipped function body out of the migration, verbatim.
const fnStart = sql.indexOf('create or replace function public.approve_access_request');
const fnEnd = sql.indexOf('$function$;', fnStart) + '$function$;'.length;
await fx.exec(sql.slice(fnStart, fnEnd));

async function approveAs(uid) {
  await fx.exec('begin');
  try {
    await fx.query(`select set_config('test.uid', '${uid}', true)`);
    await fx.query(`select public.approve_access_request('${REQ_B}')`);
    return 'GRANTED';
  } catch (err) {
    return String(err && err.message);
  } finally {
    await fx.exec('rollback');
  }
}

await test('an admin with NO active company cannot approve another tenant\'s request', async () => {
  const outcome = await approveAs(ADMIN_NO_CO);
  assert.notEqual(outcome, 'GRANTED',
    'a caller with no active company was granted a membership in Tenant B');
  assert.match(outcome, /no active company/,
    `expected the fail-closed branch, got: ${outcome}`);
});

await test('an admin of Tenant A cannot approve a Tenant B request', async () => {
  const outcome = await approveAs(ADMIN_A);
  assert.notEqual(outcome, 'GRANTED', 'cross-tenant approval succeeded');
  assert.match(outcome, /not authorized/, `expected 'not authorized', got: ${outcome}`);
});

await test('the legitimate path still works: Tenant B admin approves a Tenant B request', async () => {
  // The fix must not cost the real workflow. A guard that refuses everything
  // would pass the two assertions above and be useless.
  const outcome = await approveAs(ADMIN_B);
  assert.equal(outcome, 'GRANTED', `Tenant B's own admin was refused: ${outcome}`);
});



// ── profiles: the tenant boundary must not be self-writable ────────────────
// Raised by the cycle-2 independent review on PR #722, and larger than the
// escalation it was reported as. `authenticated` held UPDATE on all eleven
// columns of profiles, and RLS cannot restrict COLUMNS -- `using (id =
// auth.uid())` says which ROW may be written, nothing more. So any signed-in
// user could set their own `active_company_id` to any company and their own
// `role` to 'owner'.
//
// That is not one escalation, it is the whole model: active_company_id() is
// `select active_company_id from profiles where id = auth.uid()`, and every
// company-scoped policy in SILO reads it. Measured on production in a
// rolled-back transaction: one UPDATE took a Test Company user from 5,271
// visible sales rows to 1,164,910 of Baseballism's, with is_admin() true.
//
// Column privileges are the only mechanism that expresses this, so that is what
// is asserted -- against a fixture built the same way the migration grants.
const pf = new PGlite();
await pf.exec('create role anon; create role authenticated;');
await pf.exec(`
  create table public.profiles (
    id uuid primary key, name text, email text, role text, department text,
    is_active boolean, created_at timestamptz, updated_at timestamptz,
    default_page text, active_company_id uuid, avatar_url text);
`);
// Start from the pre-fix state, then apply exactly what the migration applies.
await pf.exec('grant select, insert, update on public.profiles to authenticated;');

const GRANTS = sql.slice(sql.indexOf('revoke update on public.profiles from authenticated;'));
await pf.exec(GRANTS.slice(0, GRANTS.indexOf('revoke insert, update on public.profiles from anon;')
  + 'revoke insert, update on public.profiles from anon;'.length));

async function can(role, column, priv) {
  const r = await pf.query(
    `select has_column_privilege('${role}','public.profiles','${column}','${priv}') as v`);
  return r.rows[0].v;
}

await test('a user cannot write the columns the authorization model reads', async () => {
  // active_company_id is the one every RLS policy in SILO resolves through.
  assert.equal(await can('authenticated', 'active_company_id', 'UPDATE'), false,
    'active_company_id is self-writable: one UPDATE repoints every RLS policy at another tenant');
  // role is what is_admin()/is_exec_or_owner() fall back to when there is no
  // membership for the active company -- exactly the state a forged company
  // produces, so these two compose into full admin in another tenant.
  assert.equal(await can('authenticated', 'role', 'UPDATE'), false, 'role is self-writable');
  assert.equal(await can('authenticated', 'is_active', 'UPDATE'), false, 'is_active is self-writable');
  assert.equal(await can('authenticated', 'department', 'UPDATE'), false,
    'department is self-writable, and several policies gate on department = finance');
});

await test('a user can still edit the things the profile page actually edits', async () => {
  // v2/profile.html writes {name, default_page, updated_at} on save and
  // {avatar_url, updated_at} on avatar upload. A lockdown that broke these
  // would be reverted wholesale, taking the fix with it.
  for (const column of ['name', 'default_page', 'avatar_url', 'updated_at']) {
    assert.equal(await can('authenticated', column, 'UPDATE'), true,
      `${column} is no longer self-editable; v2/profile.html save would fail`);
  }
});

await test('the same escalation is closed on the INSERT path', async () => {
  // profiles_insert_own permits a self-insert. The row normally already exists,
  // but an insert naming its own role and company is the same bug by another
  // door.
  assert.equal(await can('authenticated', 'role', 'INSERT'), false);
  assert.equal(await can('authenticated', 'active_company_id', 'INSERT'), false);
  assert.equal(await can('authenticated', 'id', 'INSERT'), true, 'a self-insert must still name itself');
});

await test('anon cannot write profiles at all', async () => {
  assert.equal(await can('anon', 'name', 'UPDATE'), false);
  assert.equal(await can('anon', 'name', 'INSERT'), false);
});


console.log(`\n${run - failures}/${run} passed`);
if (failures) process.exit(1);
