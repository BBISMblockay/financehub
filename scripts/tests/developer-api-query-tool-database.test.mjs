// Developer API / MCP query tool (20261030110000), executed in a real
// PostgreSQL (PGlite) with the migration's own functions.
//
// Proves: describe_tables shows exactly the catalog Ask SILO is shown (hidden
// rows out) and only the grant company's live notes, never rows; query runs
// one SELECT as the person under RLS for the grant's company, READ ONLY, 1000
// rows a page, and refuses hidden relations, non-public schemas, SECURITY
// DEFINER functions and set_config by name; both need data:read; consent now
// offers data:read; the path allowlist admits the two new RPCs and nothing
// else new.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/developer-api-query-tool-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const MIGRATION = readFileSync('supabase/migrations/20261030110000_developer_api_query_tool.sql', 'utf8');

const A = '00000000-0000-4000-a000-00000000000a';
const B = '00000000-0000-4000-a000-00000000000b';
const ME = '00000000-0000-4000-b000-000000000001';

await db.exec(`
create schema auth;
create role silo_api_exec;
create role silo_integration;
create role silo_revoked;
create role anon;
create role authenticated;
create role service_role;
grant authenticated to silo_api_exec;      -- as on production
grant silo_api_exec to silo_integration;   -- so the fixture can call as the integration role
create function auth.uid() returns uuid language sql stable as $$ select current_setting('test.uid')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role') $$;
create function public.active_company_id() returns uuid language sql stable as $$ select current_setting('test.company')::uuid $$;
create function public.silo_company_timezone(uuid) returns text language sql stable as $$ select 'America/Los_Angeles' $$;
create function public.silo_api_is_integration() returns boolean language sql stable as $$ select current_setting('test.role') = 'silo_integration' $$;
create function public.silo_api_claims() returns jsonb language sql stable as $$ select '{"aal":"aal2"}'::jsonb $$;
create table public.touches(at timestamptz default now());
create function public.silo_api_touch_grant() returns void language sql as $$ insert into public.touches default values $$;
-- The real one reads the live grant row; the fixture reads a setting.
create function public.silo_api_require_scope(p text) returns void language plpgsql as $$
begin
  if not (p = any(string_to_array(current_setting('test.scopes'), ','))) then
    raise exception 'insufficient_scope: This connection is not allowed to do that.';
  end if;
end $$;
set test.uid = '${ME}';
set test.company = '${A}';
set test.role = 'silo_integration';
set test.scopes = 'reports:read,data:read';

create table public.profiles(id uuid primary key, name text);
insert into public.profiles values ('${ME}', 'Me Person');
create table public.entity_memberships(user_id uuid, entity_id uuid, role text);
insert into public.entity_memberships values ('${ME}', '${A}', 'admin');
create table public.silo_api_grants(
  id uuid primary key default gen_random_uuid(), client_id text, user_id uuid, company_entity_id uuid,
  auth_session_id uuid, generation int, scopes text[], consented_aal text, consented_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz);

create table public.silo_chat_schema_catalog(
  relname text primary key, relkind text, columns jsonb, description text, keywords text[], is_hidden boolean default false);
alter table public.silo_chat_schema_catalog enable row level security;
create policy silo_chat_schema_catalog_select on public.silo_chat_schema_catalog for select using (auth.role() = 'authenticated');

create table public.silo_chat_notes(id uuid primary key default gen_random_uuid(), note text, category text,
  effective_until date, created_at timestamptz default now(), created_by uuid, company_entity_id uuid);
alter table public.silo_chat_notes enable row level security;
create policy n on public.silo_chat_notes for select using (company_entity_id = active_company_id());
insert into public.silo_chat_notes(note, category, effective_until, created_by, company_entity_id) values
  ('Net sales exclude tax.', 'definitions', null, '${ME}', '${A}'),
  ('Old promo rule.', 'promo', current_date - 1, '${ME}', '${A}'),
  ('B company rule.', 'definitions', null, '${ME}', '${B}');

create table public.orders(company_entity_id uuid, amount numeric);
alter table public.orders enable row level security;
create policy o on public.orders for select using (company_entity_id = active_company_id());
insert into public.orders select '${A}', g from generate_series(1, 1200) g;
insert into public.orders values ('${B}', 999999);
create view public.orders_v with (security_invoker = true) as select * from public.orders;

create table public.plaid_accounts(company_entity_id uuid, account_number text);
alter table public.plaid_accounts enable row level security;
create policy p on public.plaid_accounts for select using (company_entity_id = active_company_id());
insert into public.plaid_accounts values ('${A}', '1234');

create table public.writes(v int);
create function public.write_something() returns int language sql volatile as $$ insert into public.writes values (1) returning v $$;
-- A SECURITY DEFINER function that ignores the grant's company.
create function public.count_orders_for(p uuid) returns bigint language sql security definer as $$
  select count(*) from public.orders where company_entity_id = p $$;
create function public.silo_business_timezone() returns text language sql security definer as $$ select 'America/Los_Angeles' $$;

insert into public.silo_chat_schema_catalog(relname, relkind, columns, description, keywords, is_hidden) values
  ('orders', 'table', '[{"name":"company_entity_id","type":"uuid"},{"name":"amount","type":"numeric"}]', 'Every order.', array['sales'], false),
  ('orders_v', 'view', '[{"name":"amount","type":"numeric"}]', 'Orders, reconciled.', null, false),
  ('silo_api_grants', 'table', '[]', 'Connections.', null, false),
  ('plaid_accounts', 'table', '[]', 'Bank accounts.', null, true),
  ('silo_chat_schema_catalog', 'table', '[]', null, null, true);

grant usage on schema auth to silo_api_exec, silo_integration;
grant select on all tables in schema public to authenticated;
grant insert on public.touches, public.writes to authenticated;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema auth to authenticated;
`);
await db.exec(readFileSync('supabase/migrations/20261030100000_readonly_query_refuse_identity_switch.sql', 'utf8'));
await db.exec(MIGRATION);

const asIntegration = async (sql) => {
  await db.exec('begin; set local role silo_integration');
  try { const r = await q(sql); await db.exec('commit'); return r; } catch (e) { await db.exec('rollback'); throw e; }
};
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const describe = async (args = '') => (await asIntegration(`select public.silo_api_describe_tables(${args}) as j`))[0].j;
const query = async (sql, offset = 0) => (await asIntegration(`select public.silo_api_query(${lit(sql)}, ${offset}) as j`))[0].j;

await test('the fixture is honest: the catalog\'s own policy hides it from an integration', async () => {
  assert.equal((await asIntegration('select count(*)::int as n from public.silo_chat_schema_catalog'))[0].n, 0);
});

await test('describe_tables with no arguments: every visible name, grouped, and a notes count -- no hidden ones', async () => {
  const j = await describe();
  assert.deepEqual(j.tables, ['orders', 'silo_api_grants']);
  assert.deepEqual(j.views, ['orders_v']);
  assert.equal(j.notes_count, 1, 'live notes of the grant company only');
  assert.match(j.how_to, /tables/);
});

await test('describe_tables cards: columns and description for visible names; hidden ones are "not found"', async () => {
  const j = await describe(`p_tables => array['Orders ', 'plaid_accounts', 'nope']`);
  assert.deepEqual(j.tables.map((t) => t.name), ['orders']);
  assert.equal(j.tables[0].columns[1].name, 'amount');
  assert.deepEqual(j.not_found, ['nope', 'plaid_accounts']);
  await assert.rejects(describe(`p_tables => array[]::text[]`), /invalid_tables/);
  await assert.rejects(describe(`p_tables => array['a','b','c','d','e','f','g','h','i','j','k']`), /invalid_tables/);
});

await test('describe_tables search: by name, description, keyword or column, literal, never hidden', async () => {
  assert.deepEqual((await describe(`p_search => 'reconciled'`)).tables.map((t) => t.name), ['orders_v']);
  assert.deepEqual((await describe(`p_search => 'sales'`)).tables.map((t) => t.name), ['orders']);
  assert.deepEqual((await describe(`p_search => 'amount'`)).tables.map((t) => t.name), ['orders', 'orders_v']);
  assert.equal((await describe(`p_search => 'bank'`)).total, 0, 'a hidden table was found by search');
  assert.equal((await describe(`p_search => '%%'`)).total, 0, '% is literal');
  await assert.rejects(describe(`p_search => 'x'`), /invalid_search/);
});

await test('describe_tables notes: the grant company\'s live notes only', async () => {
  const j = await describe(`p_notes => true`);
  assert.deepEqual(j.notes.map((n) => n.note), ['Net sales exclude tax.']);
  assert.equal(j.notes[0].added_by, 'Me Person');
  const text = JSON.stringify(await describe());
  assert.ok(!/company_entity_id": "?999999|account_number|1234/.test(text), 'describe returned rows');
});

await test('query runs as the person: the grant company\'s rows only, in select-list order', async () => {
  const j = await query(`select count(*)::int as n, sum(amount)::int as total from orders`);
  assert.deepEqual(j.rows, [{ n: 1200, total: 720600 }]);
  assert.equal(j.company_entity_id, A);
  assert.deepEqual(Object.keys((await query(`select 2 as b, 1 as a`)).rows[0]), ['b', 'a']);
  assert.equal((await query(`select count(*)::int as n from orders_v`)).rows[0].n, 1200, 'a security_invoker view keeps RLS');
});

await test('query pages 1000 rows at a time and says when there may be more', async () => {
  const p1 = await query(`select amount from orders order by amount`);
  assert.equal(p1.row_count, 1000);
  assert.equal(p1.has_more, true);
  const p2 = await query(`select amount from orders order by amount`, 1000);
  assert.equal(p2.row_count, 200);
  assert.equal(p2.has_more, false);
  assert.equal(Number(p2.rows[0].amount), 1001);
  await assert.rejects(query('select 1', -1), /invalid_offset/);
});

await test('query refuses what Ask SILO\'s catalog hides, other schemas, and definer functions -- by name', async () => {
  for (const [sql, why] of [
    ['select * from plaid_accounts', /plaid_accounts is not available/],
    ['select * from "plaid_accounts"', /plaid_accounts is not available/],
    ['select count(*) from silo_api_grants', /silo_api_grants is not available/],
    ['select * from silo_chat_schema_catalog', /silo_chat_schema_catalog is not available/],
    ['select * from auth.users', /the auth schema is not available/],
    ['select * from "auth"."users"', /the auth schema is not available/],
    ['select * from storage .objects', /the storage schema is not available/],
    [`select public.count_orders_for('${B}')`, /count_orders_for is not available/],
  ]) {
    await assert.rejects(query(sql), why, sql);
  }
});

await test('...and the shared guard: set_config, SQL-text functions, writes, non-SELECT, two statements', async () => {
  await assert.rejects(query(`select set_config('test.company', '${B}', true)`), /query_not_allowed: the query calls set_config/);
  await assert.rejects(query(`select query_to_xml('select 1', true, false, '')`), /calls query_to_xml/);
  await assert.rejects(query(`select write_something()`), /read-only transaction/);
  assert.equal((await q('select count(*)::int as n from writes'))[0].n, 0);
  await assert.rejects(query(`update orders set amount = 0`), /only a single SELECT or WITH/);
  await assert.rejects(query(`select 1; select 2`), /no semicolon/);
  assert.deepEqual((await query(`-- a comment\nselect 1 as n;`)).rows, [{ n: 1 }], 'comment and trailing semicolon tolerated');
});

await test('names that are only allowed helpers, catalog metadata or look-alikes still run', async () => {
  const j = await query(`select active_company_id() as co, silo_company_timezone(active_company_id()) as tz, silo_business_timezone() as btz,
    (select count(*)::int from information_schema.tables where table_name = 'orders') as meta, 1 as plaid_accounts_count`);
  assert.deepEqual(j.rows, [{ co: A, tz: 'America/Los_Angeles', btz: 'America/Los_Angeles', meta: 1, plaid_accounts_count: 1 }]);
});

await test('the touch runs before read only and commits', async () => {
  await db.exec('truncate touches');
  await query('select 1');
  assert.equal((await q('select count(*)::int as n from touches'))[0].n, 1);
});

await test('both tools need data:read; reports:read alone is refused', async () => {
  await db.exec(`set test.scopes = 'reports:read'`);
  try {
    await assert.rejects(query('select 1'), /insufficient_scope/);
    await assert.rejects(describe(), /insufficient_scope/);
    assert.equal((await q('select count(*)::int as n from touches'))[0].n, 1, 'a refused call touched the grant');
  } finally { await db.exec(`set test.scopes = 'reports:read,data:read'`); }
});

await test('consent offers data:read alongside reports:read, and still drops anything unknown', async () => {
  await db.exec(`set test.role = 'authenticated'`);
  try {
    await q(`select public.silo_api_consent('client-1', array['reports:read', 'data:read', 'admin:all'])`);
    const g = (await q(`select scopes from silo_api_grants where client_id = 'client-1' and revoked_at is null`))[0];
    assert.deepEqual(g.scopes.sort(), ['data:read', 'reports:read']);
  } finally { await db.exec(`set test.role = 'silo_integration'`); }
});

await test('the path allowlist admits the two new RPCs and still nothing else', async () => {
  const allowed = async (p) => (await q(`select set_config('request.path', ${lit(p)}, false), public.silo_api_path_allowed() as ok`))[0].ok;
  for (const p of ['/rpc/silo_api_query', '/rpc/silo_api_describe_tables', '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports']) {
    assert.equal(await allowed(p), true, p);
  }
  for (const p of ['/rpc/chat_run_readonly_query', '/rpc/silo_api_refused_name', '/orders', '']) {
    assert.equal(await allowed(p), false, p);
  }
});

await test('ownership and grants: the runner is silo_api_exec\'s; the guard is reachable only through it', async () => {
  const rows = await q(`select proname, pg_get_userbyid(proowner) as owner, prosecdef,
      has_function_privilege('silo_integration', oid, 'execute') as integ,
      has_function_privilege('anon', oid, 'execute') as anon,
      has_function_privilege('silo_revoked', oid, 'execute') as revoked
    from pg_proc where proname in ('silo_api_query', 'silo_api_describe_tables', 'silo_api_refused_name') order by 1`);
  const by = Object.fromEntries(rows.map((r) => [r.proname, r]));
  assert.equal(by.silo_api_query.owner, 'silo_api_exec');
  assert.notEqual(by.silo_api_describe_tables.owner, 'silo_api_exec', 'describe must be able to read the catalog');
  for (const r of rows) assert.equal(r.prosecdef, true, r.proname);
  assert.deepEqual([by.silo_api_query.integ, by.silo_api_query.anon, by.silo_api_query.revoked], [true, false, false]);
  assert.deepEqual([by.silo_api_describe_tables.integ, by.silo_api_describe_tables.anon, by.silo_api_describe_tables.revoked], [true, false, false]);
  // silo_integration inherits silo_api_exec in this fixture, so ask of the grant itself.
  const acl = (await q(`select proacl::text as a from pg_proc where proname = 'silo_api_refused_name'`))[0].a;
  assert.ok(/silo_api_exec=X/.test(acl) && !/authenticated=|silo_integration=|anon=/.test(acl), acl);
});

await test('a re-run is a no-op', async () => {
  await db.exec(MIGRATION);
  assert.equal((await query('select count(*)::int as n from orders')).rows[0].n, 1200);
});

console.log(`\n${passed} passed`);
