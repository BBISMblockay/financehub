// scripts/tests/klaviyo-audiences-database.test.mjs
//
// Klaviyo audiences and account currency (20261110010000), on real
// PostgreSQL (PGlite). The native Klaviyo migration runs first, because this
// one extends two of its tables; then this one runs TWICE, because
// apply_all_post_merge.sql re-runs every migration.
//
// Asserted:
//   * company A never sees company B's lists and segments;
//   * no client role can write klaviyo_audiences: every row is Klaviyo's;
//   * a list and a segment may share an id (separate id spaces), but the same
//     audience twice is one row -- so a re-sync updates rather than adds;
//   * kind is only 'list' or 'segment';
//   * klaviyo_messages.audiences and klaviyo_connections.account_currency
//     exist, and a NULL currency stays NULL (it means "Klaviyo did not say");
//   * the verify block, executed verbatim, says ok -- and does not under any
//     mutation below.
//
// Mutations this suite must catch (CI runs each and requires a failure):
//   KLAVIYO_AUDIENCE_DB_MUTATION=rls       RLS left off klaviyo_audiences
//   KLAVIYO_AUDIENCE_DB_MUTATION=company   the select policy drops the company filter
//   KLAVIYO_AUDIENCE_DB_MUTATION=writes    authenticated keeps write grants
//   KLAVIYO_AUDIENCE_DB_MUTATION=identity  the identity loses `kind`
//   KLAVIYO_AUDIENCE_DB_MUTATION=currency  account_currency is not added

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.KLAVIYO_AUDIENCE_DB_MUTATION || '';
const db = new PGlite();

// The same fixture as klaviyo-native-database.test.mjs: auth and company
// plumbing, and the two queue tables the native migration extends.
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create table entities(id uuid primary key);
create function gen_random_uuid() returns uuid language sql as
  $$ select md5(random()::text || clock_timestamp()::text)::uuid $$;
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function is_admin_user() returns boolean language sql as
  $$ select coalesce(nullif(current_setting('test.admin', true), '')::boolean, false) $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create function stamp_created_by() returns trigger language plpgsql as $$ begin return new; end $$;
create table silo_chat_schema_catalog (
  relname text primary key, relkind text, columns jsonb, description text, keywords text[]
);
create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid, job_type text not null, status text,
  started_at timestamptz, finished_at timestamptz, result jsonb, error text,
  constraint sync_jobs_job_type_check check (job_type = any (array['shopify'::text, 'redo_marketing'::text]))
);
create table integration_bootstrap_jobs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null, connection_id uuid,
  integration text not null check (integration in ('shopify', 'redo')),
  status text not null default 'pending'
);
grant all on sync_jobs, integration_bootstrap_jobs, silo_chat_schema_catalog, entities
  to anon, authenticated, service_role;
-- Supabase's own default privileges: the reason the migration must revoke.
alter default privileges in schema public grant all on tables to anon, authenticated;
`);

await db.exec(await readFile(
  new URL('../../supabase/migrations/20261109040000_klaviyo_native_integration.sql', import.meta.url), 'utf8'));

let migration = await readFile(
  new URL('../../supabase/migrations/20261110010000_klaviyo_audiences.sql', import.meta.url), 'utf8');
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation ${MUT}: pattern not found`);
  migration = migration.split(from).join(to);
};
if (MUT === 'rls') mutate('alter table public.klaviyo_audiences enable row level security;', '');
if (MUT === 'company') mutate('  using (company_entity_id = (select public.active_company_id()));', '  using (true);');
if (MUT === 'writes') mutate('grant select on public.klaviyo_audiences to authenticated;', 'grant all on public.klaviyo_audiences to authenticated;');
if (MUT === 'identity') mutate('on public.klaviyo_audiences (company_entity_id, kind, klaviyo_id);', 'on public.klaviyo_audiences (company_entity_id, klaviyo_id);');
if (MUT === 'currency') {
  mutate('alter table public.klaviyo_connections\n  add column if not exists account_currency text;', '');
  mutate("comment on column public.klaviyo_connections.account_currency is", 'select');
}

await db.exec(migration);
await db.exec(migration);

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
await db.query('insert into entities values($1),($2)', [A, B]);

// ── The verify block, executed verbatim ───────────────────────────────────
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const start = verifySql.indexOf("select 'Klaviyo audiences and account currency' as check_name,");
assert.ok(start >= 0, 'Klaviyo audiences verify block missing');
let block = verifySql.slice(start);
const next = /\nselect '[^']+' as check_name,/.exec(block.slice(1));
if (next) block = block.slice(0, next.index + 1);
block = block.split('\n').reduceRight((acc, l) => (acc.length || !/^\s*(--.*)?$/.test(l) ? [l, ...acc] : acc), []).join('\n').trim();
assert.ok(block.endsWith(';'), 'could not extract the verify block');
const verifyStatus = (await db.query(block)).rows[0].status;
if (MUT) assert.notEqual(verifyStatus, 'ok', `verify reports ok under the ${MUT} mutation`);
else assert.equal(verifyStatus, 'ok', `a correctly applied migration must verify ok (got ${verifyStatus})`);

// ── The service role writes both companies' rows ──────────────────────────
await db.exec('set role service_role');
for (const co of [A, B]) {
  const tag = co.slice(-1);
  await db.query("insert into klaviyo_audiences(company_entity_id, kind, klaviyo_id, name) values($1,'list','L1',$2)", [co, `Newsletter ${tag}`]);
  // A segment may carry the same id as a list: the id spaces are separate.
  await db.query("insert into klaviyo_audiences(company_entity_id, kind, klaviyo_id, name) values($1,'segment','L1',$2)", [co, `VIP ${tag}`]);
  await db.query(
    `insert into klaviyo_messages(company_entity_id, kind, klaviyo_id, name, channel, audiences)
     values($1,'campaign',$2,'A campaign','email','{"name":null,"included":["L1"],"excluded":[]}'::jsonb)`, [co, `msg-${tag}`]);
}
await db.query("insert into klaviyo_connections(company_entity_id, api_key, account_currency) values($1,'pk_a','EUR')", [A]);
await db.query("insert into klaviyo_connections(company_entity_id, api_key, account_currency) values($1,'pk_b',null)", [B]);

// The same audience twice is one row, so the sync's upsert updates it.
await assert.rejects(
  () => db.query("insert into klaviyo_audiences(company_entity_id, kind, klaviyo_id, name) values($1,'list','L1','again')", [A]),
  'the same list twice must collide, or every sync adds every list again');
await db.query(
  `insert into klaviyo_audiences(company_entity_id, kind, klaviyo_id, name) values($1,'list','L1','Renamed')
   on conflict (company_entity_id, kind, klaviyo_id) do update set name = excluded.name`, [A]);
await assert.rejects(
  () => db.query("insert into klaviyo_audiences(company_entity_id, kind, klaviyo_id, name) values($1,'tag','T1','x')", [A]),
  'kind is list or segment, nothing else');

const currencies = (await db.query('select company_entity_id, account_currency from klaviyo_connections order by company_entity_id')).rows;
assert.deepEqual(currencies.map((r) => r.account_currency), ['EUR', null],
  'a NULL currency stays NULL: it means Klaviyo did not say, not USD');

// ── A member of company A ────────────────────────────────────────────────
await db.exec('reset role');
await db.exec(`set role authenticated; set "test.company" = '${A}'; set "test.admin" = 'false';`);
const seen = (await db.query('select company_entity_id, kind, name from klaviyo_audiences order by kind')).rows;
assert.deepEqual([...new Set(seen.map((r) => r.company_entity_id))], [A], 'a member sees their own company only');
assert.deepEqual(seen.map((r) => r.name), ['Renamed', 'VIP a']);
const msg = (await db.query('select audiences from klaviyo_messages')).rows;
assert.deepEqual(msg.map((r) => r.audiences.included), [['L1']]);

await assert.rejects(
  () => db.query("insert into klaviyo_audiences(company_entity_id, kind, klaviyo_id, name) values($1,'list','L9','x')", [A]),
  'a hand-authored list would be one Klaviyo never returned');
await assert.rejects(() => db.query("update klaviyo_audiences set name = 'x'"), 'nor may one be renamed');
await assert.rejects(() => db.query('delete from klaviyo_audiences'), 'nor deleted');
await db.exec('reset role');

// ── anon sees nothing ────────────────────────────────────────────────────
await db.exec('set role anon');
await assert.rejects(() => db.query('select 1 from klaviyo_audiences'), 'anon must not read klaviyo_audiences');
await db.exec('reset role');

console.log(MUT ? `ok (mutation ${MUT} was caught)` : 'ok');
