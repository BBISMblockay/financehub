// 20261014060000_report_email_external_recipients.sql against real PostgreSQL
// (PGlite), read from disk. Proves:
//   - it applies, twice (create or replace only)
//   - {"kind":"email"} resolves to that address with a null profile_id,
//     trimmed and lower-cased
//   - a malformed address is skipped without failing the rest of the list
//   - the three existing kinds still resolve, and an unknown kind is ignored
//   - a caller who is not an admin of the schedule's company is refused
//   - verify_v2_schema.sql's check reads MISSING before the migration and ok
//     after it
//
// Stand-ins: auth.uid() / auth.role() and is_entity_admin(), which Supabase
// and the base migration supply in production; the four tables the resolver
// reads, with only the columns it names. The base migration is not applied
// here -- this suite is about the replacement function, and
// report-email-deliver.test.mjs covers the rest of the feature.
//
// Mutations: REPORT_EMAIL_DB_MUTATION=no-email-branch | no-validation | no-auth-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.REPORT_EMAIL_DB_MUTATION || '';
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const COMPANY = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const SCHED = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

let sql = await readFile(
  new URL('../../supabase/migrations/20261014060000_report_email_external_recipients.sql', import.meta.url), 'utf8');
if (MUT === 'no-email-branch') sql = sql.replace("elsif v_kind = 'email' then", "elsif v_kind = '__never__' then");
if (MUT === 'no-validation') sql = sql.replace(/v_email is not null and v_email ~ '[^']*'/, 'v_email is not null');
if (MUT === 'no-auth-check') sql = sql.replace(/if auth\.uid\(\) is not null[\s\S]*?end if;/, '');

const verifyAll = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const V = verifyAll.slice(verifyAll.indexOf("select 'Scheduled report CSV email' as check_name"));
const CHECK = V.slice(0, V.indexOf(';\n') + 1);

// Supabase's own functions, and the gate the resolver calls. is_entity_admin
// answers for one company only, so "a caller who is not an admin HERE" is a
// real case rather than a constant.
await db.exec(`
  do $do$ begin
    create role anon; create role authenticated; create role service_role;
  exception when duplicate_object then null; end $do$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('test.uid', true), '')::uuid $f$;
  create or replace function auth.role() returns text language sql stable as $f$
    select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $f$;
  create or replace function public.is_entity_admin(p_entity uuid) returns boolean language sql stable as $f$
    select p_entity::text = coalesce(current_setting('test.admin_of', true), '') $f$;
  create table public.entity_memberships (entity_id uuid, user_id uuid, role text);
  create table public.profiles (id uuid primary key, email text, is_active boolean, department text);
  create table public.report_email_schedules (
    id uuid primary key, company_entity_id uuid, recipients jsonb, allow_member_subscribe boolean default false);
  create table public.report_email_subscriptions (schedule_id uuid, profile_id uuid);
  insert into public.profiles values ('${STAFF}', 'staff@co.test', true, 'finance');
  insert into public.entity_memberships values ('${COMPANY}', '${STAFF}', 'admin');
`);

await test("verify reads MISSING before the migration", async () => {
  // The base migration is not applied here, so the check stops at its first
  // condition. That is the point: it is MISSING, never ok.
  assert.notEqual((await q(CHECK))[0].status, 'ok');
});

await test('the migration applies, and applies twice', async () => {
  await db.exec(sql);
  await db.exec(sql);
});

const resolve = async (recipients, { uid = null, role = 'service_role', adminOf = COMPANY, company = COMPANY } = {}) => {
  await db.exec(`delete from public.report_email_schedules;`);
  await q(`insert into public.report_email_schedules (id, company_entity_id, recipients) values ($1, $2, $3::jsonb)`,
    [SCHED, company, JSON.stringify(recipients)]);
  await q(`select set_config('test.uid', $1, false), set_config('test.role', $2, false), set_config('test.admin_of', $3, false)`,
    [uid || '', role, adminOf || '']);
  return (await q(`select email, profile_id from public.resolve_report_email_recipients($1) order by email`, [SCHED]));
};

await test('an outside address resolves, trimmed and lower-cased, with no profile', async () => {
  assert.deepEqual(await resolve([{ kind: 'email', value: '  CPA@Firm.COM ' }]),
    [{ email: 'cpa@firm.com', profile_id: null }]);
});

await test('a malformed address is skipped, the rest of the list still sends', async () => {
  assert.deepEqual(await resolve([
    { kind: 'email', value: 'typo@' },
    { kind: 'email' },
    { kind: 'email', value: '' },
    { kind: 'email', value: 'two@at@signs.com' },
    { kind: 'email', value: 'no@tld' },
    { kind: 'email', value: 'ok@x.io' },
  ]), [{ email: 'ok@x.io', profile_id: null }]);
});

await test('the three existing kinds are untouched and an unknown kind is ignored', async () => {
  assert.deepEqual(await resolve([{ kind: 'workspace_admins' }]),
    [{ email: 'staff@co.test', profile_id: STAFF }]);
  assert.deepEqual(await resolve([{ kind: 'department', value: 'finance' }]),
    [{ email: 'staff@co.test', profile_id: STAFF }]);
  assert.deepEqual(await resolve([{ kind: 'profile', id: STAFF }]),
    [{ email: 'staff@co.test', profile_id: STAFF }]);
  assert.deepEqual(await resolve([{ kind: 'webhook', value: 'https://evil.test' }]), []);
});

await test('outside and inside recipients mix in one schedule', async () => {
  assert.deepEqual(await resolve([{ kind: 'workspace_admins' }, { kind: 'email', value: 'buyer@store.co.uk' }]),
    [{ email: 'buyer@store.co.uk', profile_id: null }, { email: 'staff@co.test', profile_id: STAFF }]);
});

await test('a signed-in caller who is not an admin of THAT company is refused', async () => {
  await assert.rejects(
    () => resolve([{ kind: 'email', value: 'cpa@firm.com' }], { uid: STAFF, role: 'authenticated', adminOf: OTHER }),
    /not authorized/);
  // The same caller, admin of the schedule's company, is allowed.
  assert.equal((await resolve([{ kind: 'email', value: 'cpa@firm.com' }],
    { uid: STAFF, role: 'authenticated', adminOf: COMPANY })).length, 1);
});

await test('verify reads ok once the base tables and this function are in place', async () => {
  // Stand in for the base migration's structural half: the check looks at
  // RLS, the four policies and the anon grants, none of which this migration
  // owns. What it owns is the last condition, the 'email' branch.
  await db.exec(`
    alter table public.report_email_schedules enable row level security;
    create table if not exists public.report_email_runs (id uuid primary key, company_entity_id uuid);
    alter table public.report_email_runs enable row level security;
    alter table public.report_email_subscriptions enable row level security;
    create or replace function public.active_company_id() returns uuid language sql stable as $f$ select null::uuid $f$;
    do $do$ begin
      execute 'create policy p_sel on public.report_email_schedules for select using (company_entity_id = active_company_id())';
      execute 'create policy p_ins on public.report_email_schedules for insert with check (company_entity_id = active_company_id())';
      execute 'create policy p_upd on public.report_email_schedules for update using (company_entity_id = active_company_id())';
      execute 'create policy p_del on public.report_email_schedules for delete using (company_entity_id = active_company_id())';
    end $do$;
    create or replace view public.report_email_schedules_v as select * from public.report_email_schedules;
    create or replace function public.pause_all_report_email_schedules() returns integer language sql as $f$ select 0 $f$;
    create or replace function public.duplicate_report_email_schedule(uuid) returns uuid language sql as $f$ select null::uuid $f$;
  `);
  assert.equal((await q(CHECK))[0].status, 'ok');
});

await db.close();
console.log(`\nReport email outside recipients: ${passed} checks passed.`);
