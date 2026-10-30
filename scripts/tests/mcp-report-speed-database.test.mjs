// MCP report speed (20261030070000), executed in a real PostgreSQL (PGlite).
//
// Proves the policy rewrite changes HOW a policy is evaluated and never WHAT
// it admits: the same rows per company and per person before and after, the
// company and role checks evaluated once per query, a VOLATILE gate left
// bare, an already-wrapped call not wrapped twice, a re-run a no-op. And the
// touch takes its lock with SKIP LOCKED, and the integration role gets 30s.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/mcp-report-speed-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const MIGRATION = readFileSync('supabase/migrations/20261030070000_mcp_report_speed.sql', 'utf8');

const A = '00000000-0000-4000-a000-00000000000a';
const B = '00000000-0000-4000-a000-00000000000b';
const ME = '00000000-0000-4000-b000-000000000001';
const YOU = '00000000-0000-4000-b000-000000000002';

await db.exec(`
create schema auth;
create table calls(fn text);
-- Each gate logs a call, so a test can count how often a policy evaluates it.
-- VOLATILE on the counting wrapper only; the real functions are STABLE, and
-- the rewrite keys on names, not on this fixture's volatility.
create function auth.uid() returns uuid language sql as $$ select current_setting('test.uid')::uuid $$;
create function log_call(f text) returns boolean language sql volatile as $$ insert into calls values (f) returning true $$;
create function active_company_id() returns uuid language plpgsql stable as $$
  begin perform log_call('active_company_id'); return current_setting('test.company')::uuid; end $$;
create function is_admin_user() returns boolean language sql stable as $$ select current_setting('test.admin')::boolean $$;
create function current_user_can_manage_payment_requests() returns boolean language sql volatile as $$ select false $$;
set test.uid = '${ME}';
set test.company = '${A}';
set test.admin = 'false';

create role silo_integration;
create role silo_revoked;
create role silo_api_exec;
create role anon;
create role authenticated;
create role reader;

create table payment_requests(id serial primary key, company_entity_id uuid, created_by uuid, note text);
alter table payment_requests enable row level security;
create policy payment_requests_active_select on payment_requests for select
  using ((company_entity_id = active_company_id()) and ((created_by = auth.uid()) or current_user_can_manage_payment_requests() or is_admin_user()));
create policy payment_requests_insert_own on payment_requests for insert
  with check ((company_entity_id = active_company_id()) and (created_by = auth.uid()));

create table shopify_order_lines(id serial primary key, company_entity_id uuid, qty int);
alter table shopify_order_lines enable row level security;
create policy shopify_order_lines_active_select on shopify_order_lines for select using (company_entity_id = active_company_id());

-- Already in subselect form: must not be wrapped again.
create table sales_by_day(id serial primary key, company_entity_id uuid);
alter table sales_by_day enable row level security;
create policy sales_by_day_active_select on sales_by_day for select using (company_entity_id = (select active_company_id()));

-- A table NOT on the list keeps its bare call.
create table not_listed(id serial primary key, company_entity_id uuid);
alter table not_listed enable row level security;
create policy not_listed_select on not_listed for select using (company_entity_id = active_company_id());

insert into payment_requests(company_entity_id, created_by, note) values
  ('${A}', '${ME}', 'mine A'), ('${A}', '${YOU}', 'yours A'), ('${B}', '${ME}', 'mine B');
insert into shopify_order_lines(company_entity_id, qty) select case when g % 2 = 0 then '${A}'::uuid else '${B}'::uuid end, 1 from generate_series(1, 200) g;
insert into sales_by_day(company_entity_id) values ('${A}'), ('${B}');

create table silo_api_grants(id uuid primary key, last_used_at timestamptz, updated_at timestamptz);
create function silo_api_grant() returns setof silo_api_grants language sql stable as $$ select * from public.silo_api_grants $$;

grant usage on schema auth to reader;
grant select, insert on all tables in schema public to reader;
grant usage on all sequences in schema public to reader;
grant execute on all functions in schema public to reader;
grant execute on all functions in schema auth to reader;
`);

const asReader = async (sql) => {
  await db.exec('set role reader');
  try { return await q(sql); } finally { await db.exec('reset role'); }
};
const visible = async () => ({
  pr: (await asReader('select note from payment_requests order by note')).map((r) => r.note),
  lines: Number((await asReader('select count(*) as n from shopify_order_lines'))[0].n),
});
const policy = async (table, name) => (await q(`select pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as wc
  from pg_policy where polrelid = '${table}'::regclass and polname = '${name}'`))[0];
const countCalls = async (sql) => {
  await db.exec('truncate calls');
  await asReader(sql);
  return Number((await q(`select count(*) as n from calls where fn = 'active_company_id'`))[0].n);
};

const before = {
  member: await visible(),
  callsPerLineScan: await countCalls('select count(*) from shopify_order_lines'),
};
await db.exec(`set test.admin = 'true'`);
before.admin = await visible();
await db.exec(`set test.admin = 'false'`);

await db.exec(MIGRATION);

await test('before: the bare policy evaluates the company check once per row', async () => {
  assert.ok(before.callsPerLineScan >= 200, `expected one call per row, got ${before.callsPerLineScan}`);
});

await test('after: once per query', async () => {
  assert.equal(await countCalls('select count(*) from shopify_order_lines'), 1);
});

await test('the same rows, for the same person and company, before and after', async () => {
  assert.deepEqual(await visible(), before.member);
  assert.deepEqual(before.member, { pr: ['mine A'], lines: 100 });
  await db.exec(`set test.admin = 'true'`);
  assert.deepEqual(await visible(), before.admin);
  assert.deepEqual(before.admin.pr, ['mine A', 'yours A']);
  await db.exec(`set test.admin = 'false'; set test.company = '${B}'`);
  assert.deepEqual(await visible(), { pr: ['mine B'], lines: 100 });
  await db.exec(`set test.company = '${A}'`);
});

await test('stable gates are wrapped; the VOLATILE one is left exactly as it was', async () => {
  const p = await policy('payment_requests', 'payment_requests_active_select');
  assert.match(p.qual, /\(\s*SELECT active_company_id\(\) AS active_company_id\)/);
  assert.match(p.qual, /\(\s*SELECT auth\.uid\(\) AS uid\)/);
  assert.match(p.qual, /\(\s*SELECT is_admin_user\(\) AS is_admin_user\)/);
  assert.match(p.qual, /(?<!SELECT )current_user_can_manage_payment_requests\(\)/);
});

await test('WITH CHECK is rewritten too, and still refuses another company or person', async () => {
  const p = await policy('payment_requests', 'payment_requests_insert_own');
  assert.match(p.wc, /SELECT active_company_id\(\)/);
  await asReader(`insert into payment_requests(company_entity_id, created_by, note) values ('${A}', '${ME}', 'ok')`);
  await assert.rejects(asReader(`insert into payment_requests(company_entity_id, created_by, note) values ('${B}', '${ME}', 'no')`), /row-level security/);
  await assert.rejects(asReader(`insert into payment_requests(company_entity_id, created_by, note) values ('${A}', '${YOU}', 'no')`), /row-level security/);
  await db.exec(`delete from payment_requests where note = 'ok'`);
});

await test('an already-wrapped call is not wrapped twice; a table off the list is untouched', async () => {
  const s = await policy('sales_by_day', 'sales_by_day_active_select');
  assert.equal((s.qual.match(/SELECT/g) || []).length, 1);
  const n = await policy('not_listed', 'not_listed_select');
  assert.equal(n.qual, '(company_entity_id = active_company_id())');
});

await test('a re-run changes nothing', async () => {
  const snap = await q(`select polname, pg_get_expr(polqual, polrelid) as a, pg_get_expr(polwithcheck, polrelid) as b from pg_policy order by 1`);
  await db.exec(MIGRATION);
  assert.deepEqual(await q(`select polname, pg_get_expr(polqual, polrelid) as a, pg_get_expr(polwithcheck, polrelid) as b from pg_policy order by 1`), snap);
});

await test('recording a connection\'s use takes its lock with SKIP LOCKED', async () => {
  const [{ d }] = await q(`select pg_get_functiondef('public.silo_api_touch_grant()'::regprocedure) as d`);
  assert.match(d, /for update skip locked/i);
  assert.match(d, /interval '1 hour'/);
  await db.exec(`insert into silo_api_grants values ('11111111-1111-4111-8111-111111111111', null, null)`);
  await q('select public.silo_api_touch_grant()');
  assert.notEqual((await q('select last_used_at from silo_api_grants'))[0].last_used_at, null);
});

await test('the integration role gets 30s', async () => {
  const [{ cfg }] = await q(`select rolconfig as cfg from pg_roles where rolname = 'silo_integration'`);
  assert.ok(cfg.includes('statement_timeout=30s'), JSON.stringify(cfg));
});

console.log(`\n${passed} passed`);
