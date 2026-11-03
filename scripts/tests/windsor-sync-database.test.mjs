// scripts/tests/windsor-sync-database.test.mjs
//
// The database half of the Windsor sync (20261103060000), on real PostgreSQL
// (PGlite), applied on top of the broker migration (20261102220000) and
// twice, as apply_all_post_merge.sql does. Asserted here: company A never
// reads company B's Klaviyo rows, no client role can write them, sync_jobs
// accepts windsor_sync while still refusing anything else, and the verify
// block reports ok.
//
// Mutations this suite must catch (CI runs each and requires a failure):
//   WINDSOR_SYNC_DB_MUTATION=rls       RLS left off klaviyo_performance_daily
//   WINDSOR_SYNC_DB_MUTATION=company   the select policy drops the company filter
//   WINDSOR_SYNC_DB_MUTATION=writes    authenticated keeps write grants
//   WINDSOR_SYNC_DB_MUTATION=anyrls      RLS left off windsor_metrics_daily
//   WINDSOR_SYNC_DB_MUTATION=anycompany  windsor_metrics_daily's select policy drops the company filter
//   WINDSOR_SYNC_DB_MUTATION=anywrites   authenticated keeps write grants on windsor_metrics_daily
//   WINDSOR_SYNC_DB_MUTATION=mapcompany  windsor_field_mappings' policy drops the company filter
//   WINDSOR_SYNC_DB_MUTATION=mapadmin    windsor_field_mappings' policy drops the admin check
//   WINDSOR_SYNC_DB_MUTATION=rewind      a changed mapping does not re-pull history
//   WINDSOR_SYNC_DB_MUTATION=mapgen      a changed mapping does not move the generation
//
// 20261103080000 (any connector) is applied on top, twice, and pinned the same
// way, plus: marketing_kpis_daily accepts a new ad platform name and still
// refuses a malformed one.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.WINDSOR_SYNC_DB_MUTATION || '';
const db = new PGlite();

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create table entities(id uuid primary key);
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function is_admin_user() returns boolean language sql as
  $$ select coalesce(nullif(current_setting('test.admin', true), '')::boolean, false) $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create table sync_jobs(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  job_type text not null, status text not null default 'pending');
alter table sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array['test_connection'::text, 'redo_marketing'::text, 'seo_serp_weekly'::text]));
create table silo_chat_schema_catalog(relname text primary key, relkind text, columns jsonb,
  description text, keywords text[]);
create table marketing_kpis_daily(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  platform text not null, row_hash text not null unique);
alter table marketing_kpis_daily add constraint marketing_kpis_daily_platform_check
  check (platform = any (array['google_ads'::text, 'meta_ads'::text, 'tiktok_ads'::text, 'ga4'::text]));
alter default privileges in schema public grant all on tables to anon, authenticated;
`);

const broker = await readFile(new URL('../../supabase/migrations/20261102220000_windsor_connections.sql', import.meta.url), 'utf8');
let migration = await readFile(new URL('../../supabase/migrations/20261103060000_windsor_sync.sql', import.meta.url), 'utf8');
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation ${MUT}: pattern not found`);
  migration = migration.replace(from, to);
};
if (MUT === 'rls') mutate('alter table public.klaviyo_performance_daily enable row level security;', '');
if (MUT === 'company') mutate('using (company_entity_id = (select public.active_company_id()));', 'using (true);');
if (MUT === 'writes') mutate('revoke all on public.klaviyo_performance_daily from anon, authenticated;', 'revoke all on public.klaviyo_performance_daily from anon;');
let anyMigration = await readFile(new URL('../../supabase/migrations/20261103080000_windsor_any_connector.sql', import.meta.url), 'utf8');
const mutateAny = (from, to) => {
  assert.ok(anyMigration.includes(from), `mutation ${MUT}: pattern not found`);
  anyMigration = anyMigration.replace(from, to);
};
if (MUT === 'anyrls') mutateAny('alter table public.windsor_metrics_daily enable row level security;', '');
if (MUT === 'anycompany') mutateAny('  for select to authenticated\n  using (company_entity_id = (select public.active_company_id()));', '  for select to authenticated\n  using (true);');
if (MUT === 'mapcompany') mutateAny("  using (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()))\n  with check (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()));",
  "  using ((select public.is_admin_user()))\n  with check ((select public.is_admin_user()));");
if (MUT === 'mapadmin') mutateAny("  using (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()))\n  with check (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()));",
  "  using (company_entity_id = (select public.active_company_id()))\n  with check (company_entity_id = (select public.active_company_id()));");
if (MUT === 'rewind') mutateAny('     set history_from = null', '     set history_from = history_from');
if (MUT === 'mapgen') mutateAny('         mapping_generation = mapping_generation + 1', '         mapping_generation = mapping_generation');
if (MUT === 'anywrites') mutateAny('revoke all on public.windsor_metrics_daily from anon, authenticated;', 'revoke all on public.windsor_metrics_daily from anon;');

await db.exec(broker);
await db.exec(migration);
await db.exec(anyMigration);
await db.exec(broker);
await db.exec(migration);
await db.exec(anyMigration);

// ── The verify block, executed verbatim ───────────────────────────────────
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
async function verifyStatusOf(name) {
  const start = verifySql.indexOf(`select '${name}' as check_name,`);
  assert.ok(start >= 0, `${name} verify block missing`);
  let block = verifySql.slice(start);
  const next = /\nselect '[^']+' as check_name,/.exec(block.slice(1));
  if (next) block = block.slice(0, next.index + 1);
  block = block.split('\n').reduceRight((acc, l) => (acc.length || !/^\s*(--.*)?$/.test(l) ? [l, ...acc] : acc), []).join('\n').trim();
  assert.ok(block.endsWith(';'), `could not extract the ${name} verify block`);
  return (await db.query(block)).rows[0].status;
}
const verifyStatus = await verifyStatusOf('Windsor sync');
const anyStatus = await verifyStatusOf('Windsor any connector');
const ANY_MUTS = ['anyrls', 'anycompany', 'anywrites', 'mapcompany', 'mapadmin', 'rewind', 'mapgen'];
if (MUT && !ANY_MUTS.includes(MUT)) assert.notEqual(verifyStatus, 'ok', `verify reports ok under the ${MUT} mutation`);
else assert.equal(verifyStatus, 'ok', `a correctly applied migration must verify ok (got ${verifyStatus})`);
if (ANY_MUTS.includes(MUT)) assert.notEqual(anyStatus, 'ok', `any-connector verify reports ok under the ${MUT} mutation`);
else assert.equal(anyStatus, 'ok', `a correctly applied any-connector migration must verify ok (got ${anyStatus})`);

// marketing_kpis_daily: a new ad platform name is accepted, a malformed one is not.
await db.query("insert into marketing_kpis_daily(company_entity_id, platform, row_hash) values(gen_random_uuid(), 'pinterest_ads', 'p1')");
await db.query("insert into marketing_kpis_daily(company_entity_id, platform, row_hash) values(gen_random_uuid(), 'meta_ads', 'p2')");
await assert.rejects(db.query("insert into marketing_kpis_daily(company_entity_id, platform, row_hash) values(gen_random_uuid(), 'Pinterest Ads', 'p3')"));

// sync_jobs: the live list survived and windsor_sync was appended once.
const def = (await db.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'sync_jobs_job_type_check'")).rows[0].d;
assert.match(def, /redo_marketing/);
assert.match(def, /seo_serp_weekly/);
assert.equal(def.split('windsor_sync').length - 1, 1, 'appended exactly once across two applies');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
await db.query('insert into entities values($1),($2)', [A, B]);

await db.query("insert into sync_jobs(company_entity_id, job_type) values($1, 'windsor_sync')", [A]);
await assert.rejects(db.query("insert into sync_jobs(company_entity_id, job_type) values($1, 'nonsense')", [A]));
await db.exec('set role service_role');
for (const [co, acct] of [[A, 'KA'], [B, 'KB']]) {
  await db.query(
    "insert into klaviyo_performance_daily(company_entity_id, account_id, report, day_date, row_hash, revenue) values($1,$2,'account','2026-11-01',$3, 10)",
    [co, acct, `h-${acct}`]);
}
await assert.rejects(db.query(
  "insert into klaviyo_performance_daily(company_entity_id, account_id, report, day_date, row_hash) values($1,'KA','totals','2026-11-01','h-x')", [A]),
  'report is one of account / campaign / flow');
await db.exec('reset role');

async function asUser(company, fn) {
  await db.exec('begin');
  try {
    await db.query("select set_config('test.company', $1, true)", [company]);
    await db.exec('set local role authenticated');
    return await fn();
  } finally { await db.exec('rollback'); }
}

const seen = await asUser(A, () => db.query('select account_id from klaviyo_performance_daily order by 1'));
assert.deepEqual(seen.rows.map((r) => r.account_id), ['KA'], 'A reads only its own Klaviyo rows');

await db.exec('set role service_role');
for (const [co, acct] of [[A, 'YA'], [B, 'YB']]) {
  await db.query(
    "insert into windsor_metrics_daily(company_entity_id, ds_id, account_id, day_date, object_type, row_hash, orders) values($1,'yotpo',$2,'2026-11-01','account',$3, 5)",
    [co, acct, `w-${acct}`]);
}
await assert.rejects(db.query(
  "insert into windsor_metrics_daily(company_entity_id, ds_id, account_id, day_date, object_type, row_hash) values($1,'yotpo','YA','2026-11-01','ad','w-x')", [A]),
  'object_type is account or campaign');
await db.exec('reset role');
const seenAny = await asUser(A, () => db.query('select account_id from windsor_metrics_daily order by 1'));
assert.deepEqual(seenAny.rows.map((r) => r.account_id), ['YA'], 'A reads only its own windsor_metrics_daily rows');
await assert.rejects(asUser(A, () => db.query(
  "insert into windsor_metrics_daily(company_entity_id, ds_id, account_id, day_date, object_type, row_hash) values($1,'yotpo','YA','2026-11-02','account','w-y')", [A])),
  'no client role writes windsor_metrics_daily');
const privAny = (await db.query(`select
  has_table_privilege('anon', 'public.windsor_metrics_daily', 'select') anon_select,
  has_table_privilege('authenticated', 'public.windsor_metrics_daily', 'insert') auth_insert,
  has_table_privilege('authenticated', 'public.windsor_metrics_daily', 'update') auth_update,
  has_table_privilege('authenticated', 'public.windsor_metrics_daily', 'delete') auth_delete`)).rows[0];
assert.deepEqual(privAny, { anon_select: false, auth_insert: false, auth_update: false, auth_delete: false });

await assert.rejects(asUser(A, () => db.query(
  "insert into klaviyo_performance_daily(company_entity_id, account_id, report, day_date, row_hash) values($1,'KA','account','2026-11-02','h-y')", [A])),
  'no client role writes Klaviyo rows');

const priv = (await db.query(`select
  has_table_privilege('anon', 'public.klaviyo_performance_daily', 'select') anon_select,
  has_table_privilege('authenticated', 'public.klaviyo_performance_daily', 'insert') auth_insert,
  has_table_privilege('authenticated', 'public.klaviyo_performance_daily', 'update') auth_update,
  has_table_privilege('authenticated', 'public.klaviyo_performance_daily', 'delete') auth_delete`)).rows[0];
assert.deepEqual(priv, { anon_select: false, auth_insert: false, auth_update: false, auth_delete: false },
  'a client write must be a permission denial, not an RLS no-op');

// ── windsor_field_mappings ─────────────────────────────────────────────────
// Mapping rows exist for both companies' Windsor accounts.
await db.query("insert into windsor_links(id, company_entity_id, access_token) values('11111111-1111-1111-1111-111111111111',$1,'tok-a'),('22222222-2222-2222-2222-222222222222',$2,'tok-b')", [A, B]);
const linkCols = (await db.query("select column_name from information_schema.columns where table_name = 'windsor_linked_accounts'")).rows.map((r) => r.column_name);
assert.ok(linkCols.includes('history_from'));
await db.exec('set role service_role');
for (const [co, id, link] of [[A, 'PA', '11111111-1111-1111-1111-111111111111'], [B, 'PB', '22222222-2222-2222-2222-222222222222']]) {
  await db.query("insert into windsor_linked_accounts(company_entity_id, link_id, ds_id, account_id, history_from) values($1,$3,'pinterest',$2,'2025-01-01')", [co, id, link]);
}
await db.exec('reset role');

async function asAdmin(company, admin, fn) {
  await db.exec('begin');
  try {
    await db.query("select set_config('test.company', $1, true)", [company]);
    await db.query("select set_config('test.admin', $1, true)", [String(admin)]);
    await db.exec('set local role authenticated');
    const out = await fn();
    await db.exec('commit');
    return out;
  } catch (e) { await db.exec('rollback'); throw e; }
}
await asAdmin(A, true, () => db.query("insert into windsor_field_mappings(company_entity_id, ds_id, measure, field_id) values($1,'pinterest','conversions','total_conversions')", [A]));
const hist = (await db.query("select company_entity_id, history_from, mapping_generation from windsor_linked_accounts where ds_id = 'pinterest' order by account_id")).rows;
if (MUT === 'rewind') assert.notEqual(hist[0].history_from, null, 'rewind mutation leaves history');
assert.equal(hist[0].history_from, null, "A's mapping change re-pulls A's Pinterest history");
assert.notEqual(hist[1].history_from, null, "B's history is untouched");
assert.equal(Number(hist[0].mapping_generation), 1, "A's mapping generation moves, so a run under the old mapping cannot save its cursor");
assert.equal(Number(hist[1].mapping_generation), 0, "B's generation is untouched");
await assert.rejects(asAdmin(A, true, () => db.query("insert into windsor_field_mappings(company_entity_id, ds_id, measure, field_id) values($1,'pinterest','spend','cost')", [B])),
  'an admin of A cannot set B\'s mapping');
await assert.rejects(asAdmin(A, false, () => db.query("insert into windsor_field_mappings(company_entity_id, ds_id, measure, field_id) values($1,'pinterest','spend','cost')", [A])),
  'a non-admin cannot set a mapping');
await assert.rejects(asAdmin(A, true, () => db.query("insert into windsor_field_mappings(company_entity_id, ds_id, measure, field_id) values($1,'pinterest','net_sales','x')", [A])),
  'only SILO measures can be mapped');
const bSees = await asAdmin(B, true, () => db.query('select count(*)::int n from windsor_field_mappings'));
assert.equal(bSees.rows[0].n, 0, 'B never sees A\'s mapping');
assert.equal((await db.query("select has_function_privilege('authenticated', 'public.windsor_field_mappings_rewind()', 'execute') x")).rows[0].x, false);

console.log('windsor-sync-database: ok');

// Consent rollout: only already-successful fixed datasets continue. New and
// unsupported connections never become enabled through migration replay.
await db.exec(`create function public.refresh_chat_schema_catalog() returns integer language sql as $$ select 0 $$;`);
for (const [ds, acct, status] of [['tiktok', 'live-t', 'success'], ['klaviyo', 'live-k', 'success'], ['youtube', 'unknown-y', 'success'], ['tiktok', 'untested-t', null]]) {
  await db.query("insert into windsor_linked_accounts(company_entity_id,link_id,ds_id,account_id,last_sync_status) values($1,'11111111-1111-1111-1111-111111111111',$2,$3,$4)", [A, ds, acct, status]);
}
let consent = await readFile(new URL('../../supabase/migrations/20261103201000_windsor_sync_consent.sql', import.meta.url), 'utf8');
if (MUT === 'consentdefault') consent = consent.replace('boolean not null default false', 'boolean not null default true');
if (MUT === 'consentbackfill') consent = consent.replace("and last_sync_status = 'success'", "and false");
if (MUT === 'consentreplay') consent += "\nupdate windsor_linked_accounts set sync_enabled=true where ds_id in ('tiktok','klaviyo') and last_sync_status='success';";
await db.exec(consent);
const enabled = async () => (await db.query('select account_id from windsor_linked_accounts where sync_enabled order by account_id')).rows.map(r => r.account_id);
assert.deepEqual(await enabled(), ['live-k', 'live-t']);
await db.query("update windsor_linked_accounts set sync_enabled=false where account_id='live-t'");
await db.exec(consent);
assert.deepEqual(await enabled(), ['live-k'], 'migration replay never resumes a paused account');
await db.query("insert into windsor_linked_accounts(company_entity_id,link_id,ds_id,account_id) values($1,'11111111-1111-1111-1111-111111111111','klaviyo','new-k')", [A]);
assert.deepEqual(await enabled(), ['live-k'], 'even new fixed sources default paused');
assert.equal(await verifyStatusOf('Windsor sync consent'), 'ok');
await assert.rejects(asAdmin(A, true, () => db.query("update windsor_linked_accounts set sync_enabled=true")), /permission denied/);
const ownConsent = await asAdmin(B, true, () => db.query('select account_id,sync_enabled from windsor_linked_accounts'));
assert.deepEqual(ownConsent.rows.map(r => r.account_id), ['PB']);
assert.equal(ownConsent.rows[0].sync_enabled, false);
console.log('windsor consent: defaults, backfill, replay and tenant permissions passed');

await db.close();
