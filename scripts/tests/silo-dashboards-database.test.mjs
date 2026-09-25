// SILO dashboards (20260925120000) against a REAL PostgreSQL (PGlite): one
// global board every company can read, that NO client can change -- an
// exec/owner included -- and that any member can copy into a board they own.
//
// The fixture is production's dashboards / dashboard_widgets definition as
// read from pg_policies / pg_constraint on 2026-09-25, so the migration is
// tested against the policies it actually alters.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/silo-dashboards-database.test.mjs
//
// Mutations (each must fail at least one assertion):
//   SILO_DASH_MUTATION=widget-policies-open  skip tightening the widget write policies
//   SILO_DASH_MUTATION=select-closed         skip widening dashboards_select
//   SILO_DASH_MUTATION=no-scope-check        skip the source/scope CHECK
//   SILO_DASH_MUTATION=no-prune              skip removing tiles dropped from the definition
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const mutation = process.env.SILO_DASH_MUTATION || '';
assert.ok(['', 'widget-policies-open', 'select-closed', 'no-scope-check', 'no-prune'].includes(mutation),
  `Unknown mutation ${mutation}`);

const root = new URL('../../', import.meta.url);
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const A = randomUUID(); const B = randomUUID();
const owner = randomUUID();   // profile role 'owner' -> is_exec_or_owner()
const memberA = randomUUID(); const memberB = randomUUID();
const SILO = '5110da5b-0000-4000-a000-000000000001';

// Run fn as an authenticated user with an active company.
async function as(uid, fn) {
  await db.exec('set role authenticated');
  await q("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
}

await db.exec(`
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role authenticated; create role anon;
grant usage on schema public, auth to authenticated;
grant execute on function auth.uid() to authenticated;

create table public.entities (id uuid primary key, entity_type text default 'company', title text);
create table public.profiles (id uuid primary key, name text, role text, active_company_id uuid);
create function public.active_company_id() returns uuid language sql stable security definer as $$
  select active_company_id from public.profiles where id = auth.uid() $$;
create function public.is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('owner','executive')) $$;
grant execute on function public.active_company_id(), public.is_exec_or_owner() to authenticated;

create function public.stamp_company_entity_id() returns trigger language plpgsql as $$
begin if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if; return new; end $$;
create function public.stamp_created_by() returns trigger language plpgsql as $$
begin if new.created_by is null then new.created_by := auth.uid(); end if; return new; end $$;

create table public.silo_chat_saved_reports (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid, created_by uuid,
  title text, source text, visibility text default 'company', queries_run text[] default '{}');

create table public.dashboards (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid references public.profiles(id),
  name text not null, description text,
  visibility text not null default 'company' check (visibility in ('company','private')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  filter_state jsonb not null default '{}'::jsonb check (jsonb_typeof(filter_state) = 'object'));
create table public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.dashboards(id) on delete cascade,
  company_entity_id uuid references public.entities(id),
  created_by uuid references public.profiles(id),
  report_id uuid references public.silo_chat_saved_reports(id) on delete set null,
  query_index integer not null default 0 check (query_index >= 0),
  title text, visual_type text not null,
  visual_config jsonb not null default '{}'::jsonb, layout jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create trigger stamp_company_entity_id before insert on public.dashboards for each row execute function public.stamp_company_entity_id();
create trigger stamp_created_by before insert on public.dashboards for each row execute function public.stamp_created_by();
create trigger stamp_company_entity_id before insert on public.dashboard_widgets for each row execute function public.stamp_company_entity_id();
create trigger stamp_created_by before insert on public.dashboard_widgets for each row execute function public.stamp_created_by();

alter table public.dashboards enable row level security;
alter table public.dashboard_widgets enable row level security;
grant select, insert, update, delete on public.dashboards, public.dashboard_widgets to authenticated;
grant select on public.silo_chat_saved_reports, public.profiles to authenticated;

-- Production's policies, verbatim (pg_policies, 2026-09-25).
create policy dashboards_select on public.dashboards for select
  using ((company_entity_id = active_company_id()) and ((visibility = 'company') or (created_by = auth.uid())));
create policy dashboards_insert on public.dashboards for insert
  with check ((company_entity_id = active_company_id()) and ((created_by = auth.uid()) or (created_by is null)));
create policy dashboards_update on public.dashboards for update
  using ((company_entity_id = active_company_id()) and ((created_by = auth.uid()) or is_exec_or_owner()))
  with check ((company_entity_id = active_company_id()) and ((created_by = auth.uid()) or is_exec_or_owner()));
create policy dashboards_delete on public.dashboards for delete
  using ((company_entity_id = active_company_id()) and ((created_by = auth.uid()) or is_exec_or_owner()));
create policy dashboard_widgets_select on public.dashboard_widgets for select
  using (exists (select 1 from dashboards d where d.id = dashboard_widgets.dashboard_id));
create policy dashboard_widgets_insert on public.dashboard_widgets for insert
  with check ((company_entity_id = active_company_id()) and (exists (select 1 from dashboards d
    where d.id = dashboard_widgets.dashboard_id and ((d.created_by = auth.uid()) or is_exec_or_owner()))));
create policy dashboard_widgets_update on public.dashboard_widgets for update
  using (exists (select 1 from dashboards d where d.id = dashboard_widgets.dashboard_id and ((d.created_by = auth.uid()) or is_exec_or_owner())))
  with check (exists (select 1 from dashboards d where d.id = dashboard_widgets.dashboard_id and ((d.created_by = auth.uid()) or is_exec_or_owner())));
create policy dashboard_widgets_delete on public.dashboard_widgets for delete
  using (exists (select 1 from dashboards d where d.id = dashboard_widgets.dashboard_id and ((d.created_by = auth.uid()) or is_exec_or_owner())));

create view public.dashboards_v with (security_invoker = true) as
select d.id, d.company_entity_id, d.created_by, p.name as created_by_name, d.name, d.description,
       d.visibility, d.filter_state, d.created_at, d.updated_at,
       (select count(*) from dashboard_widgets w where w.dashboard_id = d.id) as widget_count
  from dashboards d left join profiles p on p.id = d.created_by;
grant select on public.dashboards_v to authenticated;
`);

// The global system reports the board names.
for (const id of ['c3000000-0000-4000-a000-000000000001', '5110de50-0000-4000-a000-000000000001',
  'c3000000-0000-4000-a000-000000000003', '5110de50-0000-4000-a000-000000000002',
  '5110de50-0000-4000-a000-000000000003', 'c1000000-0000-4000-a000-000000000001',
  'c1000000-0000-4000-a000-000000000006', '5110de50-0000-4000-a000-000000000004']) {
  await q(`insert into public.silo_chat_saved_reports (id, source, company_entity_id, title) values ($1,'system',null,'r')`, [id]);
}
await q(`insert into public.entities (id, title) values ($1,'A'),($2,'B')`, [A, B]);
await q(`insert into public.profiles (id, name, role, active_company_id) values
         ($1,'Owner','owner',$4),($2,'Member A','user',$4),($3,'Member B','user',$5)`, [owner, memberA, memberB, A, B]);

// A company board that already exists, to prove nothing about it changes.
const boardA = (await one(`insert into public.dashboards (company_entity_id, created_by, name) values ($1,$2,'A board') returning id`, [A, memberA])).id;

// ── Apply ───────────────────────────────────────────────────────────────────
let sql = await readFile(new URL('supabase/migrations/20260925120000_silo_dashboards.sql', root), 'utf8');
const cut = (re, what) => { const before = sql; sql = sql.replace(re, ''); assert.notEqual(sql, before, `${mutation} must find ${what}`); };
if (mutation === 'widget-policies-open') cut(/alter policy dashboard_widgets_insert[\s\S]*?(?=-- ── 3\.)/, 'the widget policies');
if (mutation === 'select-closed') cut(/alter policy dashboards_select[\s\S]*?\);\n/, 'the select policy');
if (mutation === 'no-scope-check') cut(/alter table public\.dashboards\n  add constraint dashboards_source_matches_scope[\s\S]*?;\n/, 'the scope CHECK');
if (mutation === 'no-prune') cut(/-- A re-run after a tile is dropped[\s\S]*$/, 'the prune');
await db.exec(sql);

await test('applies twice, and a re-run removes a tile dropped from the definition', async () => {
  await q(`insert into public.dashboard_widgets (dashboard_id, visual_type, title) values ($1,'section','stale')`, [SILO]);
  await db.exec(sql);
  const n = (await one(`select count(*)::int n from public.dashboard_widgets where dashboard_id=$1`, [SILO])).n;
  assert.equal(n, 12, 'exactly the twelve defined tiles');
  const board = await one(`select source, company_entity_id, created_by from public.dashboards where id=$1`, [SILO]);
  assert.deepEqual(board, { source: 'system', company_entity_id: null, created_by: null });
});

await test('every company sees the SILO board and its tiles, created by SILO', async () => {
  for (const uid of [memberA, memberB, owner]) {
    const rows = await as(uid, () => q(`select id, created_by_name, source from public.dashboards_v where id=$1`, [SILO]));
    assert.equal(rows.length, 1, 'visible');
    assert.equal(rows[0].created_by_name, 'SILO');
    assert.equal(rows[0].source, 'system');
    const w = await as(uid, () => one(`select count(*)::int n from public.dashboard_widgets where dashboard_id=$1`, [SILO]));
    assert.equal(w.n, 12);
  }
});

await test("company boards stay company-scoped: B cannot see A's board", async () => {
  assert.equal((await as(memberB, () => q(`select 1 from public.dashboards where id=$1`, [boardA]))).length, 0);
  assert.equal((await as(memberA, () => q(`select 1 from public.dashboards where id=$1`, [boardA]))).length, 1);
  const own = await as(memberA, () => one(`select created_by_name, source from public.dashboards_v where id=$1`, [boardA]));
  assert.deepEqual(own, { created_by_name: 'Member A', source: 'user' });
});

await test('nobody, an exec/owner included, can edit or delete the SILO board', async () => {
  for (const uid of [owner, memberA]) {
    const upd = await as(uid, () => q(`update public.dashboards set name='mine now' where id=$1 returning id`, [SILO]));
    assert.equal(upd.length, 0, 'update reaches no row');
    const del = await as(uid, () => q(`delete from public.dashboards where id=$1 returning id`, [SILO]));
    assert.equal(del.length, 0, 'delete reaches no row');
  }
  assert.equal((await one(`select name from public.dashboards where id=$1`, [SILO])).name, 'Overview');
});

await test("nobody, an exec/owner included, can change the SILO board's tiles", async () => {
  const upd = await as(owner, () => q(`update public.dashboard_widgets set title='x' where dashboard_id=$1 returning id`, [SILO]));
  assert.equal(upd.length, 0, 'exec/owner update reaches no tile');
  const del = await as(owner, () => q(`delete from public.dashboard_widgets where dashboard_id=$1 returning id`, [SILO]));
  assert.equal(del.length, 0, 'exec/owner delete reaches no tile');
  await assert.rejects(
    () => as(owner, () => q(`insert into public.dashboard_widgets (dashboard_id, visual_type, title) values ($1,'section','Mine')`, [SILO])),
    /row-level security/, 'exec/owner cannot add a tile to the SILO board');
  assert.equal((await one(`select count(*)::int n from public.dashboard_widgets where dashboard_id=$1`, [SILO])).n, 12);
});

await test('a client cannot forge a SILO board, or turn its own board into one', async () => {
  await assert.rejects(
    () => as(owner, () => q(`insert into public.dashboards (name, source) values ('Fake','system')`)),
    /dashboards_source_matches_scope|row-level security/, 'a stamped company plus source=system is refused');
  await assert.rejects(
    () => as(memberA, () => q(`update public.dashboards set source='system' where id=$1`, [boardA])),
    /dashboards_source_matches_scope/, 'a company board cannot be relabelled system');
  await assert.rejects(
    () => q(`insert into public.dashboards (name, company_entity_id, source) values ('Orphan', null, 'user')`),
    /dashboards_source_matches_scope/, 'even a service-role write cannot make a global user board');
});

await test('any member can save a copy: a private board they own in their company', async () => {
  const copy = await as(memberB, async () => {
    const d = await one(`insert into public.dashboards (name, visibility, filter_state)
                         values ('Overview (copy)','private','{"date_from":"today-28d"}') returning id, company_entity_id, created_by, source`);
    await q(`insert into public.dashboard_widgets (dashboard_id, report_id, query_index, title, visual_type, visual_config, layout, sort_order)
             select $1, report_id, query_index, title, visual_type, visual_config, layout, sort_order
               from public.dashboard_widgets where dashboard_id = $2`, [d.id, SILO]);
    return d;
  });
  assert.equal(copy.company_entity_id, B);
  assert.equal(copy.created_by, memberB);
  assert.equal(copy.source, 'user');
  assert.equal((await one(`select count(*)::int n from public.dashboard_widgets where dashboard_id=$1 and company_entity_id=$2`, [copy.id, B])).n, 12);
  // Owned, so editable by its maker -- and invisible to a colleague elsewhere.
  const upd = await as(memberB, () => q(`update public.dashboard_widgets set title='Mine' where dashboard_id=$1 returning id`, [copy.id]));
  assert.equal(upd.length, 12);
  assert.equal((await as(memberA, () => q(`select 1 from public.dashboards where id=$1`, [copy.id]))).length, 0);
});

await test("an exec/owner still edits their own company's boards", async () => {
  const upd = await as(owner, () => q(`update public.dashboards set name='A board!' where id=$1 returning id`, [boardA]));
  assert.equal(upd.length, 1);
});

console.log(`\n1..${passed}${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
