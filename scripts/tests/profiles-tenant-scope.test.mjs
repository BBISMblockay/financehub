/* Tenant isolation for profiles, executed against a real PostgreSQL (PGlite)
   with the ACTUAL migration file and real role switching — not a mock.

   Guards the bug this fixed: while active in one company, a user who is
   owner/admin of another company could read every profile in the database,
   which surfaced as the wrong people in assignee dropdowns. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/20260913054723_profiles_active_company_scope.sql', root), 'utf8');

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const scalar = async (sql, params = []) => Object.values((await q(sql, params))[0] ?? {})[0];

const ACME = '11111111-1111-1111-1111-111111111111';
const TESTCO = '22222222-2222-2222-2222-222222222222';
const OWNER = '33333333-3333-3333-3333-333333333333';   // owner of ACME, also a TESTCO member
const STAFF = '44444444-4444-4444-4444-444444444444';   // ACME only
const TESTER = '55555555-5555-5555-5555-555555555555';  // TESTCO only

// Minimum schema the policy depends on, plus the two helpers it calls. Both are
// reproduced with the same DEFINER / row_security posture as production.
await db.exec(`
  create schema if not exists auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.entities(id uuid primary key, title text);
  create table public.profiles(
    id uuid primary key, name text, email text, is_active boolean not null default true,
    active_company_id uuid references public.entities(id));
  create table public.entity_memberships(
    user_id uuid not null, entity_id uuid not null references public.entities(id),
    role text not null, primary key(user_id, entity_id));

  create function public.active_company_id() returns uuid
    language sql stable security definer set search_path = public, pg_temp as $$
      select active_company_id from public.profiles where id = auth.uid() $$;

  create function public.is_owner_admin() returns boolean
    language sql stable security definer set search_path = public, pg_temp
    set row_security = off as $$
      select exists(select 1 from public.entity_memberships m
                    where m.user_id = auth.uid() and m.role in ('owner','admin')) $$;

  alter table public.profiles enable row level security;
  -- Supabase provides both roles; the migration revokes from anon by name.
  create role anon;
  create role authenticated;
  grant usage on schema public, auth to authenticated;
  grant select, update on public.profiles to authenticated;
`);

await q(`insert into public.entities values ($1,'Acme'), ($2,'Test Company')`, [ACME, TESTCO]);
await q(`insert into public.profiles(id,name,active_company_id) values
  ($1,'Owner',$4), ($2,'Staff',$4), ($3,'Tester',$5)`, [OWNER, STAFF, TESTER, ACME, TESTCO]);
await q(`insert into public.entity_memberships values
  ($1,$4,'owner'), ($2,$4,'member'), ($1,$5,'owner'), ($3,$5,'member')`,
  [OWNER, STAFF, TESTER, ACME, TESTCO]);

await db.exec(migration);

async function as(user, fn) {
  await db.exec('set role authenticated');
  await q(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const visibleTo = user => as(user, async () =>
  (await q('select name from public.profiles order by name')).map(r => r.name));

test('the migration applies cleanly and is idempotent', async () => {
  await db.exec(migration);
  assert.equal(await scalar(
    `select count(*)::int from pg_policy where polrelid='public.profiles'::regclass and polcmd='r'`), 1,
    'exactly one SELECT policy — leaving an unscoped one in place would keep the leak open, since policies are OR\'d');
});

test('an owner of another company sees only their ACTIVE company while switched', async () => {
  // The reported bug: OWNER is owner of Acme and active in Acme, so is_owner_admin()
  // is true. Before the fix that alone returned every profile in the database.
  assert.deepEqual(await visibleTo(OWNER), ['Owner', 'Staff']);
  assert.ok(!(await visibleTo(OWNER)).includes('Tester'), 'a Test-Company-only person must not appear in Acme');

  await q('update public.profiles set active_company_id=$2 where id=$1', [OWNER, TESTCO]);
  assert.deepEqual(await visibleTo(OWNER), ['Owner', 'Tester'],
    'switched to Test Company, Acme staff must disappear');
  await q('update public.profiles set active_company_id=$2 where id=$1', [OWNER, ACME]);
});

test('a plain member sees their own company and nothing else', async () => {
  assert.deepEqual(await visibleTo(STAFF), ['Owner', 'Staff']);
  assert.deepEqual(await visibleTo(TESTER), ['Owner', 'Tester']);
});

test('everyone can always read their own row', async () => {
  // A profile with no membership anywhere must not lose access to itself.
  // Its active_company_id is NULL, not a company it happens to sit next to:
  // set_active_company() validates membership before writing that column, so
  // "no membership" and "no active company" are the same state in production.
  // active_company_id() then returns null and shares_active_company() is false
  // for every row — the self clause is the only thing keeping them logged in.
  const ORPHAN = '66666666-6666-6666-6666-666666666666';
  await q('insert into public.profiles(id,name) values ($1,$2)', [ORPHAN, 'Orphan']);
  assert.deepEqual(await visibleTo(ORPHAN), ['Orphan']);
  await q('delete from public.profiles where id=$1', [ORPHAN]);
});

test('an unauthenticated caller reads nothing', async () => {
  assert.deepEqual(await as('', async () =>
    (await q('select name from public.profiles')).map(r => r.name)), []);
});

test('cross-tenant UPDATE is refused; self-edit and same-company admin still work', async () => {
  // An RLS refusal on UPDATE is a success with zero rows, not an error.
  //
  // Counted with affectedRows and NO `returning` on purpose. Asking for
  // RETURNING makes Postgres apply the SELECT policy to the same statement, so
  // a `returning` version of this test passes on the read guard while claiming
  // to prove the write guard — it stayed green when the UPDATE policy was
  // deliberately weakened back to a bare is_owner_admin().
  const updated = async (sql, params) => (await db.query(sql, params)).affectedRows;

  // An UPDATE whose WHERE reads a column also has the SELECT policy applied to
  // locating the row, so every filtered statement below is guarded twice and
  // cannot, on its own, prove the UPDATE policy does anything. An unqualified
  // UPDATE setting a literal reads no existing column, so the UPDATE policy is
  // the ONLY thing standing in front of it — measured: with the policy weakened
  // back to a bare is_owner_admin() this rewrites 3 rows including Tester.
  // (Setting a LITERAL matters: `set name = name` would reference an existing
  // column and pull the SELECT policy back into the statement.)
  await as(OWNER, async () => {
    assert.equal(await updated(`update public.profiles set email='rewritten@acme.test'`), 2,
      'an unqualified update must reach the active company only, never every tenant');
  });
  assert.equal(await scalar('select email from public.profiles where id=$1', [TESTER]), null,
    'the Test-Company profile was not touched');

  await as(OWNER, async () => {
    assert.equal(await updated(`update public.profiles set name='hijacked' where id=$1`, [TESTER]), 0,
      'an Acme owner must not rewrite a Test-Company-only profile');
    assert.equal(await updated(`update public.profiles set name='Owner' where id=$1`, [OWNER]), 1,
      'self-edit still works');
    assert.equal(await updated(`update public.profiles set name='Staff' where id=$1`, [STAFF]), 1,
      'an owner still administers their own company');
  });
  assert.equal(await scalar('select name from public.profiles where id=$1', [TESTER]), 'Tester');
});

after(() => db.close());
