// Actual report migrations + PostgreSQL RLS/trigger/RPC execution, local only.
// No network, live records or credentials. Dependency install:
// npm ci --prefix scripts/tests/finance-db --ignore-scripts
// node scripts/tests/saved-report-archive-database.test.mjs
//
// Each mutation must fail an ordinary behavior assertion:
// REPORT_ARCHIVE_MUTATION=no-owner-trigger|no-identity-trigger|archive-hidden|
//   usage-definer|no-active-guard|no-membership-guard|retimestamp-retry|no-system-guard
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const MIGRATION = '20260930203350_saved_report_archive.sql';
const mutations = {
  'no-owner-trigger': (s) => s.replace('or old.created_by is distinct from auth.uid()', 'or false'),
  'no-identity-trigger': (s) => s.replace(/if new.created_by is distinct from old.created_by\s+or new.company_entity_id is distinct from old.company_entity_id then/, 'if false then'),
  'archive-hidden': (s) => s.replace('left join public.profiles p on p.id = r.created_by;', 'left join public.profiles p on p.id = r.created_by where r.archived_at is null;'),
  'usage-definer': (s) => s.replace('stable\nsecurity invoker', 'stable\nsecurity definer'),
  'no-active-guard': (s) => s.replaceAll('p.is_active is true', 'true'),
  'no-membership-guard': (s) => s.replaceAll('join public.entity_memberships em', 'left join public.entity_memberships em'),
  'retimestamp-retry': (s) => s.replace('if (v_report.archived_at is not null) is distinct from p_archived then', 'if true then'),
  'no-system-guard': (s) => s.replace("if old.source = 'system' and new.source is distinct from old.source then", 'if false then'),
};
const mutation = process.env.REPORT_ARCHIVE_MUTATION || '';
assert.ok(!mutation || mutations[mutation], `Unknown mutation: ${mutation}`);
let migration = await read(`supabase/migrations/${MIGRATION}`);
if (mutation) {
  const changed = mutations[mutation](migration);
  assert.notEqual(changed, migration, 'mutation must alter the implementation');
  migration = changed;
}

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
let passed = 0;
const test = async (name, fn) => { await fn(); console.log(`ok ${++passed} - ${name}`); };
async function as(uid, fn, role = 'authenticated') {
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
}
const archive = (id, state = true) => one('select * from public.set_saved_report_archived($1, $2)', [id, state]);
const usage = async (id) => (await one('select public.saved_report_archive_usage($1) as result', [id])).result;
const denied = (fn) => assert.rejects(fn, (e) => e.code === '42501');
const patch = (id, fields, params = []) => q(`update public.silo_chat_saved_reports set ${fields} where id = $1 returning id`, [id, ...params]);
async function noPatch(id, fields, params = []) {
  try { assert.deepEqual(await patch(id, fields, params), []); }
  catch (e) { if (e.code !== '42501') throw e; }
}
const report = (id) => one('select to_jsonb(r) as data from public.silo_chat_saved_reports r where id = $1', [id]).then((r) => r.data);

// Only unrelated auth/company primitives are synthetic. The real reporting
// migrations supply report/dashboard tables, constraints, policies, grants,
// views and saved_report_usage. Helpers mirror the live preflight 2026-09-30.
await db.exec(`
  create schema auth;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.entities (id uuid primary key, title text);
  create type public.app_role as enum ('owner','admin','executive','user');
  create table public.profiles (
    id uuid primary key, name text, role public.app_role, is_active boolean default true,
    active_company_id uuid references public.entities(id));
  create table public.entity_memberships (
    entity_id uuid references public.entities(id), user_id uuid references public.profiles(id), role text,
    primary key (entity_id, user_id));
  create function public.active_company_id() returns uuid language sql stable security definer set search_path = public as $$
    select active_company_id from public.profiles where id = auth.uid() $$;
  create function public.is_exec_or_owner() returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles p
      left join public.entity_memberships em on em.user_id = p.id and em.entity_id = p.active_company_id
      where p.id = auth.uid() and coalesce(p.is_active, true) = true
      and case when em.role is not null then em.role = 'owner_admin' or lower(p.role::text) = 'executive'
        else lower(p.role::text) in ('owner','executive') end) $$;
  alter table public.profiles enable row level security;
  create policy profiles_select on public.profiles for select to authenticated
    using (id = auth.uid() or active_company_id = public.active_company_id());
  alter table public.entity_memberships enable row level security;
  create policy memberships_select_own on public.entity_memberships for select to authenticated using (user_id = auth.uid());
  revoke all on public.profiles, public.entity_memberships from anon, authenticated;
  grant select on public.profiles, public.entity_memberships to authenticated;
  create function public.stamp_created_by() returns trigger language plpgsql as $$
    begin new.created_by := coalesce(new.created_by, auth.uid()); return new; end $$;
  create function public.stamp_company_entity_id() returns trigger language plpgsql as $$
    begin new.company_entity_id := coalesce(new.company_entity_id, public.active_company_id()); return new; end $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function public.attach_stamp_company_entity_id_triggers() returns void language plpgsql as $$
  declare t text;
  begin
    foreach t in array array['silo_chat_saved_reports','dashboards','dashboard_widgets'] loop
      if to_regclass('public.' || t) is not null then
        execute format('drop trigger if exists stamp_company_entity_id on public.%I', t);
        execute format('create trigger stamp_company_entity_id before insert on public.%I for each row execute function public.stamp_company_entity_id()', t);
      end if;
    end loop;
  end $$;
`);
for (const file of [
  '20260818050000_silo_chat_saved_reports.sql',
  '20260821090000_silo_chat_saved_reports_visibility.sql',
  '20260828120000_v3_dashboards.sql',
  '20260828130000_saved_report_source.sql',
  '20260828140000_saved_report_column_semantics.sql',
  '20260903100000_report_parameters.sql',
  '20260904100000_saved_report_edit.sql',
  '20260907140000_report_row_estimate.sql',
]) await db.exec(await read(`supabase/migrations/${file}`));
// Current dashboard policies/views, without the unrelated catalog seed rows.
const dashboardMigration = await read('supabase/migrations/20260925120000_silo_dashboards.sql');
await db.exec(dashboardMigration.slice(0, dashboardMigration.indexOf('-- ── 4.')));

const A = randomUUID(), B = randomUUID();
const creator = randomUUID(), coworker = randomUUID(), executive = randomUUID();
const owner = randomUUID(), admin = randomUUID(), outsider = randomUUID();
const inactive = randomUUID(), noMembership = randomUUID();
const users = [
  [creator, A, 'user', true, 'member'], [coworker, A, 'user', true, 'member'],
  [executive, A, 'executive', true, 'member'], [owner, A, 'owner', true, 'owner_admin'],
  [admin, A, 'admin', true, 'admin'], [outsider, B, 'user', true, 'member'],
  [inactive, A, 'user', false, 'member'], [noMembership, A, 'user', true, null],
];
await q('insert into public.entities values ($1, $2), ($3, $4)', [A, 'Company A', B, 'Company B']);
for (const [id, company, role, active, membership] of users) {
  await q('insert into public.profiles values ($1, $2, $3, $4, $5)', [id, role, role, active, company]);
  if (membership) await q('insert into public.entity_memberships values ($1, $2, $3)', [company, id, membership]);
}
async function addReport(createdBy, company, visibility = 'company', source = 'manual') {
  const id = randomUUID();
  await q(`insert into public.silo_chat_saved_reports
    (id, company_entity_id, created_by, title, source, visibility, question, answer, queries_run,
     description, columns_metadata, parameters, builder_config, row_estimate, row_estimate_at)
    values ($1,$2,$3,'Report',$4,$5,'Question','Answer',array['select 42 as value','select 7 as value'],
      'Description','{"value":{"semantic":"count"}}','[{"key":"date_from"}]',
      '{"relname":"test","cfg":{"measures":["value"]}}',42,'2026-09-01T00:00:00Z')`,
  [id, company, createdBy, source, visibility]);
  return id;
}
const shared = await addReport(creator, A);
const privateReport = await addReport(creator, A, 'private', 'ask_silo');
const otherPrivate = await addReport(coworker, A, 'private');
const otherCompany = await addReport(outsider, B);
const inactiveReport = await addReport(inactive, A);
const membershipReport = await addReport(noMembership, A);
const globalSystem = await addReport(null, null, 'company', 'system');
const companySystem = await addReport(creator, A, 'company', 'system');
const unownedReport = await addReport(null, A);
const legacyArchived = await addReport(creator, A);
async function addDashboard(user, company, name, visibility) {
  const id = randomUUID();
  await q('insert into public.dashboards (id,company_entity_id,created_by,name,visibility) values ($1,$2,$3,$4,$5)', [id,company,user,name,visibility]);
  return id;
}
const ownBoard = await addDashboard(creator, A, 'My daily board', 'private');
const sharedBoard = await addDashboard(coworker, A, 'Team board', 'company');
const hiddenBoard = await addDashboard(coworker, A, 'Private acquisition planning', 'private');
const foreignBoard = await addDashboard(outsider, B, 'Other tenant confidential', 'private');
async function addWidget(dashboard, company, rep, index = 0) {
  await q(`insert into public.dashboard_widgets
    (dashboard_id,company_entity_id,created_by,report_id,query_index,title,visual_type,visual_config,layout,sort_order)
    values ($1,$2,$3,$4,$5,'Tile','table','{"columns":["value"]}','{"x":0,"y":0,"w":6,"h":4}',2)`,
  [dashboard, company, creator, rep, index]);
}
await addWidget(ownBoard, A, shared);
await addWidget(sharedBoard, A, shared);
await addWidget(sharedBoard, A, shared, 1);
await addWidget(hiddenBoard, A, shared);
await addWidget(ownBoard, A, privateReport);
await addWidget(foreignBoard, B, otherCompany);
// A bad cross-tenant reference must not leak foreign names or inflate counts.
await addWidget(foreignBoard, B, shared);
const initialWidgets = await q('select * from public.dashboard_widgets order by id');
const initialShared = await report(shared);
const initialPrivate = await report(privateReport);
const initialReports = await q('select id from public.silo_chat_saved_reports order by id');

// Reproduce the actual live drift BEFORE migration, not just a clean install.
await db.exec(`alter table public.silo_chat_saved_reports add column archived_at timestamptz;`);
await q("update public.silo_chat_saved_reports set archived_at = '2026-09-29T12:00:00Z' where id = $1", [legacyArchived]);
const oldView = await one("select pg_get_viewdef('public.silo_chat_saved_reports_v'::regclass) as sql");
await db.exec(`create or replace view public.silo_chat_saved_reports_v with (security_invoker = true) as ${oldView.sql.trim().replace(/;$/, '')} where r.archived_at is null;`);
await db.exec(migration);

await test('pre-existing archive timestamp survives and the invoker view exposes archived rows', async () => {
  const row = await as(creator, () => one('select archived_at from public.silo_chat_saved_reports_v where id = $1', [legacyArchived]));
  assert.equal(row?.archived_at?.toISOString(), '2026-09-29T12:00:00.000Z');
});
await test('usage has complete counts and only RLS-visible dashboard names, without duplicate boards', async () => {
  const result = await as(creator, () => usage(shared));
  assert.deepEqual(result, { dashboard_count: 3, widget_count: 4, hidden_dashboard_count: 1,
    dashboards: [{ id: ownBoard, name: 'My daily board' }, { id: sharedBoard, name: 'Team board' }] });
  assert.ok(!JSON.stringify(result).includes(hiddenBoard));
  assert.ok(!JSON.stringify(result).includes('Private acquisition'));
  assert.ok(!JSON.stringify(result).includes(foreignBoard));
});
await test('zero dependencies is a measured zero, not a failed lookup', async () => {
  assert.deepEqual(await as(creator, () => usage(legacyArchived)), {
    dashboard_count: 0, widget_count: 0, hidden_dashboard_count: 0, dashboards: [],
  });
});
await test('creator can archive both private Ask SILO and shared manual reports', async () => {
  for (const id of [shared, privateReport]) {
    const result = await as(creator, () => archive(id));
    assert.equal(result.id, id);
    assert.ok(result.archived_at instanceof Date);
  }
});
await test('archive changes no report content, identity, sharing or estimate', async () => {
  for (const [id, before] of [[shared, initialShared], [privateReport, initialPrivate]]) {
    const after = await report(id);
    delete after.archived_at; delete after.updated_at; delete before.updated_at;
    assert.deepEqual(after, before);
  }
});
await test('repeat archive preserves both archived_at and updated_at', async () => {
  const before = await report(shared);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await as(creator, () => archive(shared));
  assert.deepEqual(await report(shared), before);
});
await test('existing dashboard read path retains its SQL, ids, configuration and query indexes', async () => {
  assert.deepEqual(await q('select * from public.dashboard_widgets order by id'), initialWidgets);
  const tiles = await as(coworker, () => q('select report_id, query_sql, query_index from public.dashboard_widgets_v where dashboard_id = $1 order by query_index', [sharedBoard]));
  assert.deepEqual(tiles, [
    { report_id: shared, query_sql: 'select 42 as value', query_index: 0 },
    { report_id: shared, query_sql: 'select 7 as value', query_index: 1 },
  ]);
});
await test('archived report read visibility still respects company/private RLS', async () => {
  assert.equal((await as(coworker, () => q('select id from public.silo_chat_saved_reports_v where id = $1', [shared]))).length, 1);
  assert.deepEqual(await as(coworker, () => q('select id from public.silo_chat_saved_reports_v where id = $1', [privateReport])), []);
  assert.deepEqual(await as(outsider, () => q('select id from public.silo_chat_saved_reports_v where id = $1', [shared])), []);
});
await test('creator can restore private/shared reports and retry restore without touching updated_at', async () => {
  for (const id of [shared, privateReport]) {
    assert.deepEqual(await as(creator, () => archive(id, false)), { id, archived_at: null });
    const before = await report(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await as(creator, () => archive(id, false));
    assert.deepEqual(await report(id), before);
  }
});
for (const [name, user] of [['coworker',coworker],['admin',admin],['executive',executive],['company owner',owner],['cross-tenant user',outsider]]) {
  await test(`${name} cannot archive, restore or inspect dependencies for someone else's report`, async () => {
    for (const id of [shared, privateReport]) {
      await as(user, async () => {
        await denied(() => archive(id));
        await denied(() => archive(id, false));
        await denied(() => usage(id));
        await noPatch(id, 'archived_at = now()');
      });
    }
  });
}
await test('direct PATCH restore by an executive is also blocked', async () => {
  await as(creator, () => archive(shared));
  await as(executive, () => denied(() => patch(shared, 'archived_at = null')));
  assert.ok((await report(shared)).archived_at);
  await as(creator, () => archive(shared, false));
});
await test('an executive still edits ordinary shared content under the existing policy', async () => {
  assert.equal((await as(executive, () => patch(shared, "description = 'Reviewed'"))).length, 1);
  await q('update public.silo_chat_saved_reports set description = $2 where id = $1', [shared, initialShared.description]);
});
await test('creator and executive cannot transfer ownership or tenant, including claim-then-archive', async () => {
  for (const user of [creator, executive, owner]) {
    await as(user, async () => {
      await denied(() => patch(shared, 'created_by = $2', [user === creator ? coworker : user]));
      await denied(() => patch(shared, 'company_entity_id = $2', [B]));
      await denied(() => patch(shared, 'created_by = $2, archived_at = now()', [user === creator ? coworker : user]));
    });
  }
  assert.equal((await report(shared)).created_by, creator);
  assert.equal((await report(shared)).company_entity_id, A);
});
await test('inactive creator cannot archive, restore, PATCH or inspect dependencies', async () => {
  await as(inactive, async () => {
    await denied(() => archive(inactiveReport));
    await denied(() => archive(inactiveReport, false));
    await denied(() => usage(inactiveReport));
    await denied(() => patch(inactiveReport, 'archived_at = now()'));
  });
});
await test('creator without active-company membership cannot use either RPC or direct PATCH', async () => {
  await as(noMembership, async () => {
    await denied(() => archive(membershipReport));
    await denied(() => usage(membershipReport));
    await denied(() => patch(membershipReport, 'archived_at = now()'));
  });
});
await test('company switch denies owning a report outside the active company', async () => {
  await q('insert into public.entity_memberships values ($1,$2,$3)', [B, creator, 'member']);
  await q('update public.profiles set active_company_id=$2 where id=$1', [creator, B]);
  await as(creator, async () => { await denied(() => archive(shared)); await denied(() => usage(shared)); });
  await q('update public.profiles set active_company_id=$2 where id=$1', [creator, A]);
});
await test('system, unowned, foreign, missing and private colleague reports are unavailable', async () => {
  for (const id of [globalSystem, companySystem, unownedReport, otherCompany, otherPrivate, randomUUID()]) {
    await as(creator, async () => {
      await denied(() => archive(id)); await denied(() => archive(id, false)); await denied(() => usage(id));
      await noPatch(id, 'archived_at = now()');
    });
  }
});
await test('unowned and company-system reports cannot be claimed and archived by an executive', async () => {
  for (const id of [unownedReport, companySystem]) await as(executive, () => denied(() => patch(id, "created_by=$2, source='manual', archived_at=now()", [executive])));
});
await test('a company-system report cannot be demoted first and then archived by its creator', async () => {
  await as(creator, () => denied(() => patch(companySystem, "source='manual'")));
  assert.equal((await report(companySystem)).source, 'system');
});
await test('anonymous callers cannot execute either RPC or read the view', async () => {
  await as(null, async () => {
    await denied(() => archive(shared)); await denied(() => usage(shared));
    await denied(() => q('select * from public.silo_chat_saved_reports_v'));
  }, 'anon');
  await as(null, async () => { await denied(() => archive(shared)); await denied(() => usage(shared)); });
});
await test('null archive intent is rejected rather than interpreted as restore', async () => {
  await as(creator, () => assert.rejects(() => archive(shared, null), (e) => e.code === '22004'));
});
await test('client cannot insert an already archived report; ordinary insert still stamps ownership', async () => {
  await as(creator, async () => {
    await denied(() => q("insert into public.silo_chat_saved_reports (title,source,archived_at) values ('New','manual',now())"));
    const row = await one("insert into public.silo_chat_saved_reports (title,source) values ('New','manual') returning id,created_by,company_entity_id,archived_at");
    assert.equal(row.created_by, creator); assert.equal(row.company_entity_id, A); assert.equal(row.archived_at, null);
  });
});
await test('direct owner PATCH uses the server timestamp and cannot retimestamp an archived report', async () => {
  await as(creator, () => patch(shared, "archived_at='1999-01-01T00:00:00Z'"));
  const before = await report(shared);
  assert.notEqual(before.archived_at.slice(0,4), '1999');
  await as(creator, () => patch(shared, "archived_at='2000-01-01T00:00:00Z'"));
  assert.equal((await report(shared)).archived_at, before.archived_at);
  await as(creator, () => archive(shared, false));
});
await test('trusted service maintenance is preserved without accepting a forged JWT role claim', async () => {
  await as(executive, async () => {
    await q("select set_config('request.jwt.claim.role','service_role',false)");
    await denied(() => patch(shared, 'archived_at=now()'));
    await q("select set_config('request.jwt.claim.role','',false)");
  });
  await as(null, () => patch(legacyArchived, 'archived_at=null'), 'service_role');
  assert.equal((await report(legacyArchived)).archived_at, null);
});
await test('migration rerun preserves archive state, report identities, widgets and invoker/grant boundaries', async () => {
  await as(creator, () => archive(shared));
  const before = await report(shared);
  await db.exec(migration);
  assert.deepEqual(await report(shared), before);
  for (const row of initialReports) assert.ok(await report(row.id));
  assert.deepEqual(await q('select * from public.dashboard_widgets order by id'), initialWidgets);
  const functions = await q(`select proname,prosecdef,has_function_privilege('anon',oid,'execute') as anon,
    has_function_privilege('authenticated',oid,'execute') as authenticated from pg_proc
    where proname in ('set_saved_report_archived','saved_report_archive_usage','guard_saved_report_archive') order by proname`);
  assert.deepEqual(functions, [
    { proname: 'guard_saved_report_archive', prosecdef: false, anon: false, authenticated: false },
    { proname: 'saved_report_archive_usage', prosecdef: false, anon: false, authenticated: true },
    { proname: 'set_saved_report_archived', prosecdef: false, anon: false, authenticated: true },
  ]);
});

// Exact production verification section, so it cannot drift from these tests.
const verify = await read('supabase/verify_v2_schema.sql');
const start = verify.indexOf('-- Report archive management');
const end = verify.indexOf('-- End report archive management', start);
assert.ok(start >= 0 && end > start, 'verification markers present');
await test('schema verification executes against the migrated database and reports ok', async () => {
  const results = await db.exec(verify.slice(start, end));
  for (const result of results) for (const row of result.rows || []) assert.equal(row.status, 'ok', JSON.stringify(row));
});
await test('apply-all includes archive before the mandatory final catalog-cleanup include', async () => {
  const apply = await read('supabase/apply_all_post_merge.sql');
  assert.ok(apply.includes(`\\i migrations/${MIGRATION}`));
  assert.ok(apply.indexOf(`\\i migrations/${MIGRATION}`) < apply.indexOf('\\i migrations/20260922170000_record_report_catalog_cleanup.sql'));
});
await test('clean schema without archived_at also applies and accepts a creator archive', async () => {
  // Synthetic-only reset of the additive column, after all preservation tests.
  // This is the fresh-rebuild path, unlike production's pre-existing column.
  await db.exec('drop view public.silo_chat_saved_reports_v; alter table public.silo_chat_saved_reports drop column archived_at;');
  await db.exec(migration);
  assert.equal((await report(shared)).archived_at, null);
  assert.ok((await as(creator, () => archive(shared))).archived_at instanceof Date);
  assert.deepEqual(await q('select * from public.dashboard_widgets order by id'), initialWidgets);
});
console.log(`\n${passed} saved-report archive database tests passed`);
await db.close();
