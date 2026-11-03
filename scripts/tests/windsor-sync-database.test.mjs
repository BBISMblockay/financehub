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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.WINDSOR_SYNC_DB_MUTATION || '';
const db = new PGlite();

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
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

await db.exec(broker);
await db.exec(migration);
await db.exec(broker);
await db.exec(migration);

// ── The verify block, executed verbatim ───────────────────────────────────
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const start = verifySql.indexOf("select 'Windsor sync' as check_name,");
assert.ok(start >= 0, 'Windsor sync verify block missing');
let block = verifySql.slice(start);
const next = /\nselect '[^']+' as check_name,/.exec(block.slice(1));
if (next) block = block.slice(0, next.index + 1);
block = block.split('\n').reduceRight((acc, l) => (acc.length || !/^\s*(--.*)?$/.test(l) ? [l, ...acc] : acc), []).join('\n').trim();
assert.ok(block.endsWith(';'), 'could not extract the verify block');
const verifyStatus = (await db.query(block)).rows[0].status;
if (MUT) assert.notEqual(verifyStatus, 'ok', `verify reports ok under the ${MUT} mutation`);
else assert.equal(verifyStatus, 'ok', `a correctly applied migration must verify ok (got ${verifyStatus})`);

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

console.log('windsor-sync-database: ok');
