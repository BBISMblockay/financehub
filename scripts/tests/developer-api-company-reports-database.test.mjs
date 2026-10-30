// Developer API / MCP company reports (20261030090000), executed in a real
// PostgreSQL (PGlite) with the migration's own functions.
//
// Proves: the catalog and the runner reach exactly what the person sees in
// the app -- system reports, the company's shared reports and their own
// private ones, never another person's private report or another company's
// -- saved reports say verified: false, the
// catalog never returns SQL, a saved report's SQL must be one SELECT/WITH,
// and the report runs READ ONLY (a write anywhere in it fails) while the
// connection's touch, which runs first, still commits.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/developer-api-company-reports-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const MIGRATION = readFileSync('supabase/migrations/20261030090000_developer_api_company_reports.sql', 'utf8');

const A = '00000000-0000-4000-a000-00000000000a';
const B = '00000000-0000-4000-a000-00000000000b';
const ME = '00000000-0000-4000-b000-000000000001';
const YOU = '00000000-0000-4000-b000-000000000002';
const id = (n) => `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`;

await db.exec(`
create schema auth;
create role silo_api_exec;
create role silo_integration;
create role silo_revoked;
create role anon;
create role authenticated;
create role service_role;
grant silo_api_exec to silo_integration;   -- so the fixture can call as the integration role
grant authenticated to silo_api_exec;      -- as on production (checked 2026-10-30)
create function auth.uid() returns uuid language sql stable as $$ select current_setting('test.uid')::uuid $$;
create function public.active_company_id() returns uuid language sql stable as $$ select current_setting('test.company')::uuid $$;
create function public.silo_company_timezone(uuid) returns text language sql stable as $$ select 'America/Los_Angeles' $$;
create table public.touches(at timestamptz default now());
create table public.writes(v int);
create function public.silo_api_require_scope(text) returns void language sql as $$ select $$;
create function public.silo_api_touch_grant() returns void language sql as $$ insert into public.touches default values $$;
-- The real one substitutes {{key}}; identity is enough for these reports.
create function public.silo_api_substitute(text, jsonb, jsonb) returns text language sql immutable as $$ select $1 $$;
create function public.write_something() returns int language sql volatile as $$ insert into public.writes values (1) returning v $$;
set test.uid = '${ME}';
set test.company = '${A}';

create table public.profiles(id uuid primary key, name text);
insert into public.profiles values ('${ME}', 'Pat Lee'), ('${YOU}', 'Sam Roe');
create table public.silo_chat_saved_reports(id uuid primary key, company_entity_id uuid, created_by uuid, source text,
  visibility text, title text, description text, question text, answer text, queries_run text[], parameters jsonb default '[]',
  columns_metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now(),
  row_estimate int, row_estimate_at timestamptz, archived_at timestamptz);
alter table public.silo_chat_saved_reports enable row level security;
-- Production's SELECT policy, verbatim in meaning (read live 2026-10-30).
create policy silo_chat_saved_reports_select on public.silo_chat_saved_reports for select using (
  ((company_entity_id = active_company_id()) and ((visibility = 'company') or (created_by = auth.uid())))
  or ((company_entity_id is null) and (source = 'system')));
create view public.silo_chat_saved_reports_v with (security_invoker = true) as
  select r.id, r.company_entity_id, r.created_by, p.name as created_by_name, r.source, r.title, r.description,
         r.question, r.answer, r.queries_run, r.visibility, r.columns_metadata, r.parameters, r.created_at,
         r.updated_at, r.row_estimate, r.row_estimate_at, r.archived_at
    from public.silo_chat_saved_reports r left join public.profiles p on p.id = r.created_by;

create table public.orders(company_entity_id uuid, amount int);
alter table public.orders enable row level security;
create policy orders_select on public.orders for select using (company_entity_id = active_company_id());
insert into public.orders values ('${A}', 10), ('${A}', 20), ('${B}', 99);

insert into public.silo_chat_saved_reports(id, company_entity_id, created_by, source, visibility, title, queries_run, archived_at) values
  ('${id(1)}', null, null, 'system', 'company', 'System report', array['select sum(amount) as total from orders'], null),
  ('${id(2)}', '${A}', '${YOU}', 'manual', 'company', 'Shared in A', array['  -- a comment\n  with x as (select amount from orders) select count(*) as n from x;'], null),
  ('${id(3)}', '${A}', '${ME}', 'ask_silo', 'private', 'My private in A', array['select amount from orders order by 1'], null),
  ('${id(4)}', '${A}', '${YOU}', 'manual', 'private', 'Your private in A', array['select 1 as secret'], null),
  ('${id(5)}', '${B}', '${ME}', 'manual', 'company', 'Shared in B', array['select 2 as other'], null),
  ('${id(6)}', '${A}', '${ME}', 'manual', 'company', 'Archived in A', array['select 3'], now()),
  ('${id(7)}', '${A}', '${ME}', 'manual', 'company', 'Writes', array['select write_something() as v'], null),
  ('${id(8)}', '${A}', '${ME}', 'manual', 'company', 'Not a select', array['values (1)'], null),
  ('${id(9)}', '${A}', '${ME}', 'manual', 'company', 'Two statements', array['select 1; select 2'], null);

grant usage on schema auth to silo_api_exec, silo_integration;
grant select on all tables in schema public to silo_api_exec;
grant insert on public.touches, public.writes to silo_api_exec;
grant execute on all functions in schema public to silo_api_exec;
grant execute on all functions in schema auth to silo_api_exec;
grant create on schema public to silo_api_exec;
`);
// The shared read-only guard (merged in 20261030100000), as on production.
await db.exec(readFileSync('supabase/migrations/20261030100000_readonly_query_refuse_identity_switch.sql', 'utf8'));
await db.exec(MIGRATION);

const asIntegration = async (sql) => {
  await db.exec('begin; set local role silo_integration');
  try { const r = await q(sql); await db.exec('commit'); return r; } catch (e) { await db.exec('rollback'); throw e; }
};
const list = async () => (await asIntegration('select public.silo_api_list_reports() as j'))[0].j;
const listCompany = async (search) => (await asIntegration(
  `select public.silo_api_list_reports(${search === null ? 'null::text' : `'${search}'::text`}) as j`))[0].j;
const run = async (n) => (await asIntegration(`select public.silo_api_run_report('${id(n)}') as j`))[0].j;

await test('the first catalog call: SILO\'s reports in full, and how many company reports there are', async () => {
  const j = await list();
  assert.deepEqual(j.reports.map((r) => r.title), ['System report']);
  assert.equal(j.reports[0].kind, 'silo');
  assert.equal(j.reports[0].verified, true);
  assert.equal(j.company_reports.verified, false);
  assert.ok(j.reports[0].columns !== undefined && j.reports[0].parameters !== undefined);
  assert.equal(j.company_reports.count, 5, 'shared and my own private');
});

await test('the company catalog: shared and my own private reports -- not yours, not another company\'s, not archived', async () => {
  const j = await listCompany('in A');
  assert.deepEqual(j.reports.map((r) => r.title).sort(), ['My private in A', 'Shared in A']);
  assert.equal(j.total, 2);
  assert.equal(j.note, null);
  assert.equal((await listCompany('in B')).total, 0, 'another company\'s report was found');
  for (const t of ['Writes', 'Not a select', 'Two statements']) {
    assert.deepEqual((await listCompany(t)).reports.map((r) => r.title), [t]);
  }
  const by = Object.fromEntries(j.reports.map((r) => [r.title, r]));
  assert.equal(by['Shared in A'].kind, 'company');
  assert.equal(by['Shared in A'].verified, false);
  assert.equal(by['Shared in A'].sharing, 'shared');
  assert.equal(by['Shared in A'].created_by, 'Sam Roe');
  assert.equal(by['My private in A'].sharing, 'private');
  assert.equal(by['My private in A'].verified, false);
  assert.equal(by['Shared in A'].columns, undefined, 'compact: no column metadata');
});

await test('neither catalog call returns SQL', async () => {
  const text = JSON.stringify([await list(), await listCompany('in A'), await listCompany('Writes')]);
  assert.ok(!/from orders|queries_run|write_something|select 1/.test(text), 'catalog leaked SQL');
});

await test('search is required, literal, and returns the 10 most recent matches -- never a full list', async () => {
  for (const term of [null, '', '   ', 'x']) {
    await assert.rejects(listCompany(term), /search_required/, `listed with search ${JSON.stringify(term)}`);
  }
  assert.deepEqual((await listCompany('Shared')).reports.map((r) => r.title), ['Shared in A']);
  assert.deepEqual((await listCompany('private')).reports.map((r) => r.title), ['My private in A']);
  assert.equal((await listCompany('%%')).total, 0, '% is literal, not a wildcard');
  await db.exec(`insert into silo_chat_saved_reports(id, company_entity_id, created_by, source, visibility, title, queries_run, updated_at)
    select ('00000000-0000-4000-d000-' || lpad(g::text, 12, '0'))::uuid, '${A}', '${ME}', 'manual', 'company', 'Bulk ' || g, array['select 1'], now() - g * interval '1 minute'
      from generate_series(1, 45) g`);
  try {
    const p1 = await listCompany('Bulk');
    assert.equal(p1.total, 45);
    assert.equal(p1.shown, 10);
    assert.deepEqual(p1.reports.map((r) => r.title), Array.from({ length: 10 }, (_, i) => `Bulk ${i + 1}`), 'most recently updated first');
    assert.match(p1.note, /more specific/);
  } finally { await db.exec(`delete from silo_chat_saved_reports where title like 'Bulk %'`); }
});

await test('a long option list is cut to 10 and says how many there were', async () => {
  const opts = JSON.stringify(Array.from({ length: 300 }, (_, i) => `Product ${i}`));
  await db.exec(`update silo_chat_saved_reports set parameters = '[{"key":"product","type":"enum","default":"all","options":${opts}},{"key":"d","type":"date","default":"today-1d"}]'::jsonb where id = '${id(2)}'`);
  try {
    const r = (await listCompany('Shared')).reports[0];
    assert.equal(r.parameters[0].key, 'product');
    assert.equal(r.parameters[0].options.length, 10);
    assert.equal(r.parameters[0].options[0], 'Product 0');
    assert.equal(r.parameters[0].options_total, 300);
    assert.deepEqual(r.parameters[1], { key: 'd', type: 'date', default: 'today-1d' });
  } finally { await db.exec(`update silo_chat_saved_reports set parameters = '[]' where id = '${id(2)}'`); }
});

await test('a shared report runs for me, under my RLS, with a comment and trailing semicolon stripped', async () => {
  const j = await run(2);
  assert.equal(j.report.kind, 'company');
  assert.equal(j.report.verified, false);
  assert.deepEqual(j.rows, [{ n: 2 }]);
});

await test('my own private report runs; a system report still runs and says it is verified', async () => {
  assert.deepEqual((await run(3)).rows.map((r) => r.amount), [10, 20]);
  const j = await run(1);
  assert.deepEqual(j.rows, [{ total: 30 }]);
  assert.equal(j.report.verified, true);
});

await test('another person\'s private report, another company\'s, and an archived one are "not found"', async () => {
  for (const n of [4, 5, 6]) await assert.rejects(run(n), /report_not_found/, `report ${n}`);
  await db.exec(`set test.company = '${B}'`);
  try {
    assert.deepEqual((await run(5)).rows, [{ other: 2 }], 'the same report runs inside its own company');
    await assert.rejects(run(2), /report_not_found/);
  } finally { await db.exec(`set test.company = '${A}'`); }
});

await test('the functions state the private-report rule themselves, not only through the policy', async () => {
  await db.exec(`drop policy silo_chat_saved_reports_select on silo_chat_saved_reports;
    create policy wide on silo_chat_saved_reports for select using (company_entity_id = active_company_id() or company_entity_id is null)`);
  try {
    assert.ok(!(await listCompany('private')).reports.some((r) => r.title === 'Your private in A'));
    await assert.rejects(run(4), /report_not_found/);
  } finally {
    await db.exec(`drop policy wide on silo_chat_saved_reports;
      create policy silo_chat_saved_reports_select on silo_chat_saved_reports for select using (
        ((company_entity_id = active_company_id()) and ((visibility = 'company') or (created_by = auth.uid())))
        or ((company_entity_id is null) and (source = 'system')))`);
  }
});

await test('a report that writes fails: the transaction is read only', async () => {
  await assert.rejects(run(7), /read-only transaction/);
  assert.equal((await q('select count(*)::int as n from writes'))[0].n, 0);
});

await test('the touch runs before the switch to read only and commits', async () => {
  await db.exec('truncate touches');
  await run(2);
  assert.equal((await q('select count(*)::int as n from touches'))[0].n, 1);
});

await test('only one SELECT or WITH statement can run', async () => {
  await assert.rejects(run(8), /report_not_runnable/);
  await assert.rejects(run(9), /report_not_runnable/);
});

await test('a saved report that switches identity with set_config is refused, and the caller is unchanged', async () => {
  await db.exec(`insert into silo_chat_saved_reports(id, company_entity_id, created_by, source, visibility, title, queries_run) values
    ('${id(10)}', '${A}', '${ME}', 'manual', 'company', 'Identity switch',
     array['select set_config(''test.uid'', ''${YOU}'', true) as x, auth.uid() as who'])`);
  try {
    await assert.rejects(run(10), /report_not_runnable: this report calls set_config/);
    assert.equal((await q(`select current_setting('test.uid') as u`))[0].u, ME);
  } finally { await db.exec(`delete from silo_chat_saved_reports where id = '${id(10)}'`); }
});

await test('ownership and grants stay as they were; a re-run is a no-op', async () => {
  await db.exec(MIGRATION);
  const rows = await q(`select proname, pg_get_userbyid(proowner) as owner,
      has_function_privilege('silo_integration', oid, 'execute') as integ,
      has_function_privilege('authenticated', oid, 'execute') as authd,
      has_function_privilege('anon', oid, 'execute') as anon,
      has_function_privilege('silo_revoked', oid, 'execute') as revoked
    from pg_proc where proname in ('silo_api_list_reports', 'silo_api_run_report') order by 1`);
  assert.equal(rows.length, 3, 'two catalog overloads and the runner');
  for (const r of rows) {
    assert.equal(r.owner, 'silo_api_exec', r.proname);
    assert.deepEqual([r.integ, r.authd, r.anon, r.revoked], [true, true, false, false], r.proname);
  }
  assert.equal((await listCompany('in A')).total, 2);
});

console.log(`\n${passed} passed`);
