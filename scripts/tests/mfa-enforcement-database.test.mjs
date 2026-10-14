// 20261014000000_mfa_enforcement.sql against real PostgreSQL (PGlite), read
// from disk. Proves:
//   - it applies, twice
//   - the Data API hook (silo_check_request) refuses ONLY an aal1 session of
//     a user holding a VERIFIED factor, with sqlstate PGRST and HTTP 403
//     mfa_required; aal2, no factor, an unverified factor, anon and the
//     service role all pass
//   - authenticator carries pgrst.db_pre_request = public.silo_check_request
//   - storage.objects refuses reads and writes for the same unsatisfied
//     session, whatever the bucket's own permissive policy says
//   - verify_v2_schema.sql's check reads MISSING / ok / CRITICAL correctly
//   - verify's anon/definer allowlist names both functions (the hook is anon-run)
//
// Stand-ins: auth.uid() / auth.jwt() as Supabase defines them (from the
// request.jwt.claims setting PostgREST sets before the hook runs), and the
// auth.mfa_factors columns the check reads. PostgREST itself is not run.
//
// Mutations: MFA_DB_MUTATION=any-factor | ignore-aal | no-storage-check | no-headers
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.MFA_DB_MUTATION || '';
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

let sql = await readFile(new URL('../../supabase/migrations/20261014000000_mfa_enforcement.sql', import.meta.url), 'utf8');
if (MUT === 'any-factor') sql = sql.replace("and f.status = 'verified'", '');
if (MUT === 'ignore-aal') sql = sql.replace("coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'", 'true');
if (MUT === 'no-storage-check') sql = sql.replace("using ((select public.mfa_session_satisfied()))\n  with check ((select public.mfa_session_satisfied()));", 'using (true) with check (true);');
if (MUT === 'no-headers') sql = sql.replace("json_build_object('status', 403, 'headers', json_build_object())", "json_build_object('status', 403)");
const verifyAll = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const V = verifyAll.slice(verifyAll.indexOf("select 'Two-step login enforced by the server'"));
const verify = async () => (await q(V.slice(0, V.indexOf(';\n') + 1)))[0].status;

const ENROLLED = '00000000-0000-0000-0000-0000000000e1';
const PLAIN = '00000000-0000-0000-0000-0000000000a1';
const HALF = '00000000-0000-0000-0000-0000000000b1'; // setup started, never verified

await db.exec(`
  create role anon; create role authenticated; create role service_role; create role authenticator;
  create schema auth; create schema storage;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                    nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null,
    status text not null, factor_type text not null default 'totp');
  insert into auth.mfa_factors (user_id, status) values ('${ENROLLED}', 'verified'), ('${HALF}', 'unverified');
  create table storage.objects (id bigserial primary key, bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create policy objects_member_all on storage.objects for all to authenticated using (true) with check (true);
  grant usage on schema storage to authenticated;
  grant select, insert on storage.objects to authenticated;
  grant usage, select on sequence storage.objects_id_seq to authenticated;
  insert into storage.objects (bucket_id, name) values ('receipts', 'a.pdf');
`);

/** Run fn as PostgREST would: claims set, role switched. */
async function as(claims, fn) {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false)`);
  await db.exec(`set role ${claims.role || 'anon'}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const hook = () => db.query('select public.silo_check_request()');
const session = (sub, aal) => ({ role: 'authenticated', sub, aal });

await test('verify reads MISSING before it applies', async () => {
  assert.match(await verify(), /^MISSING/);
});

await test('applies, and applies again', async () => {
  await db.exec(sql);
  await db.exec(sql);
});

await test('authenticator runs the hook before every Data API request', async () => {
  const [r] = await q(`select s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator'`);
  assert.ok(r.setconfig.includes('pgrst.db_pre_request=public.silo_check_request'));
});

await test('an enrolled user with only a password is refused: PGRST, 403, mfa_required', async () => {
  const err = await as(session(ENROLLED, 'aal1'), () => hook().then(() => null, (e) => e));
  assert.ok(err, 'refused');
  assert.equal(err.code, 'PGRST');
  // PostgREST turns this into HTTP only if MESSAGE and DETAIL parse as its
  // PgRaiseErrMessage / PgRaiseErrDetails (Error.hs, v12-v14): message needs
  // string `code` and `message`; detail needs integer `status` AND an object
  // `headers` of strings. A missing field is HTTP 500 PGRST121, not this 403.
  const message = JSON.parse(err.message);
  const detail = JSON.parse(err.detail);
  assert.equal(typeof message.code, 'string');
  assert.equal(message.code, 'mfa_required');
  assert.equal(typeof message.message, 'string');
  assert.ok(Number.isInteger(detail.status) && detail.status === 403);
  assert.ok(detail.headers && typeof detail.headers === 'object' && !Array.isArray(detail.headers), 'detail.headers is required');
  assert.ok(Object.values(detail.headers).every((v) => typeof v === 'string'));
  // A token with no aal claim at all is aal1 too.
  const noAal = await as({ role: 'authenticated', sub: ENROLLED }, () => hook().then(() => null, (e) => e));
  assert.ok(noAal, 'missing aal claim is not a pass');
});

await test('everyone else passes: aal2, no factor, unverified factor, anon, service role', async () => {
  for (const claims of [session(ENROLLED, 'aal2'), session(PLAIN, 'aal1'), session(HALF, 'aal1'),
    { role: 'anon' }, { role: 'service_role' }]) {
    await as(claims, () => hook());
  }
});

await test('storage: an unsatisfied session reads nothing and writes nothing', async () => {
  const rows = await as(session(ENROLLED, 'aal1'), () => q('select id from storage.objects'));
  assert.equal(rows.length, 0);
  const err = await as(session(ENROLLED, 'aal1'),
    () => db.query(`insert into storage.objects (bucket_id, name) values ('receipts', 'x.pdf')`).then(() => null, (e) => e));
  assert.ok(err && /row-level security/i.test(err.message), 'write refused');
  assert.equal((await as(session(ENROLLED, 'aal2'), () => q('select id from storage.objects'))).length, 1);
  assert.equal((await as(session(PLAIN, 'aal1'), () => q('select id from storage.objects'))).length, 1);
  await as(session(ENROLLED, 'aal2'), () => db.query(`insert into storage.objects (bucket_id, name) values ('receipts', 'y.pdf')`));
});

await test('verify: ok applied; CRITICAL when the hook or the storage policy is gone', async () => {
  assert.equal(await verify(), 'ok');
  await db.exec('alter role authenticator reset pgrst.db_pre_request');
  assert.match(await verify(), /CRITICAL: the Data API two-step hook is off/);
  await db.exec(sql);
  await db.exec('drop policy mfa_session_required on storage.objects');
  assert.match(await verify(), /CRITICAL: storage\.objects has no restrictive two-step policy/);
  await db.exec(sql);
  await db.exec(`create policy mfa_session_required_loose on storage.objects for all to authenticated using (true)`);
  await db.exec('drop policy mfa_session_required on storage.objects');
  await db.exec(`create policy mfa_session_required on storage.objects for all to authenticated using (true)`);
  assert.match(await verify(), /CRITICAL: storage\.objects/, 'a PERMISSIVE policy by that name is not the check');
  await db.exec('drop policy mfa_session_required on storage.objects; drop policy mfa_session_required_loose on storage.objects');
  await db.exec(sql);
  assert.equal(await verify(), 'ok');
  await db.exec(sql.replace("json_build_object('status', 403, 'headers', json_build_object())", "json_build_object('status', 403)"));
  assert.match(await verify(), /CRITICAL: silo_check_request\(\) raises without the headers/);
  await db.exec(sql);
  assert.equal(await verify(), 'ok');
});

await test('the hook and the check are callable by the API roles, and not by PUBLIC', async () => {
  for (const fn of ['public.silo_check_request()', 'public.mfa_session_satisfied()']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await q(`select has_function_privilege($1, $2, 'execute') as v`, [role, fn]))[0].v, true, `${role} ${fn}`);
    }
    const [{ acl }] = await q(`select proacl::text as acl from pg_proc where oid = $1::regprocedure`, [fn]);
    assert.doesNotMatch(acl, /(^|[{,])=X/, `${fn}: no PUBLIC execute`);
  }
});

// PostgREST runs the hook as anon for anon requests, so both functions are
// anon-executable SECURITY DEFINER by design; verify's allowlist must name them
// or the daily drift check goes CRITICAL (it did, run 212, 2026-10-14).
await test("verify's anon/definer allowlist accepts the two-step functions", async () => {
  const start = verifyAll.indexOf("select 'Definer functions reachable by anon' as check_name");
  assert.ok(start > 0, 'the anon/definer check must still exist in verify_v2_schema.sql');
  const [{ status }] = await q(verifyAll.slice(start).split(/;\s*\n/)[0] + ';');
  assert.equal(status, 'ok', `anon/definer check: ${status}`);
});

console.log(`# pass ${passed}`);
