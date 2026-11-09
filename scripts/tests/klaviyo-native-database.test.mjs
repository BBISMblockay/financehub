// scripts/tests/klaviyo-native-database.test.mjs
//
// The database half of the native Klaviyo integration (20261109040000), on
// real PostgreSQL (PGlite). The migration is EXECUTED here, twice, because
// apply_all_post_merge.sql re-runs every migration and because the two CHECK
// constraints it extends are rewritten in place.
//
// Asserted:
//   * company A never sees company B's Klaviyo rows;
//   * a non-admin cannot even READ the connection row -- it carries a live API
//     key or OAuth tokens;
//   * no client role can write a data table: every row is a number Klaviyo
//     reported, and a hand-authored one would be a figure Klaviyo never gave;
//   * the PKCE verifier is invisible to anon AND to authenticated;
//   * the two views are security_invoker, so RLS applies through them;
//   * the performance grain is unique and its `channel` is NOT NULL, because
//     NULLs in a unique index are distinct and would let one measurement be
//     inserted again on every run;
//   * both queues accept 'klaviyo' afterwards, and the appends are idempotent;
//   * the verify_v2_schema block, executed verbatim, says ok -- and does not
//     under any mutation below.
//
// Mutations this suite must catch (CI runs each and requires a failure):
//   KLAVIYO_DB_MUTATION=rls          RLS left off klaviyo_flow_daily
//   KLAVIYO_DB_MUTATION=company      a data policy drops the company filter
//   KLAVIYO_DB_MUTATION=credential   authenticated reads the connection without being admin
//   KLAVIYO_DB_MUTATION=writes       authenticated keeps write grants on the data tables
//   KLAVIYO_DB_MUTATION=verifier     authenticated keeps SELECT on klaviyo_oauth_states
//   KLAVIYO_DB_MUTATION=invoker      a view is definer, so RLS stops applying through it
//   KLAVIYO_DB_MUTATION=grain        the performance grain is not unique
//   KLAVIYO_DB_MUTATION=nullchannel  channel is nullable, so the grain stops holding
//   KLAVIYO_DB_MUTATION=jobtype      sync_jobs never learns the klaviyo job type
//   KLAVIYO_DB_MUTATION=bootstrap    the first-sync queue never learns klaviyo

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.KLAVIYO_DB_MUTATION || '';
const db = new PGlite();

// The fixture: only auth/company plumbing and the two tables the migration
// extends. Everything Klaviyo comes from the repository SQL.
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
-- The two live constraints the migration appends to, spelled as production
-- spells them: an ARRAY of literals, which is what the append parses.
create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid, job_type text not null, status text,
  started_at timestamptz, finished_at timestamptz, result jsonb, error text,
  constraint sync_jobs_job_type_check check (job_type = any (array['shopify'::text, 'redo_marketing'::text, 'windsor_sync'::text]))
);
create table integration_bootstrap_jobs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null, connection_id uuid,
  integration text not null check (integration in ('shopify', 'redo')),
  status text not null default 'pending'
);
-- Supabase's own default privileges: the reason the migration must revoke.
-- Applied to the fixture tables explicitly, since default privileges only
-- reach objects created after this statement.
grant all on sync_jobs, integration_bootstrap_jobs, silo_chat_schema_catalog, entities
  to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated;
`);

let migration = await readFile(
  new URL('../../supabase/migrations/20261109040000_klaviyo_native_integration.sql', import.meta.url), 'utf8');
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation ${MUT}: pattern not found`);
  migration = migration.split(from).join(to);
};
if (MUT === 'rls') mutate('alter table public.klaviyo_flow_daily enable row level security;', '');
if (MUT === 'company') {
  mutate("'create policy %I on public.%I for select to authenticated '\n      'using (company_entity_id = (select public.active_company_id()))',",
    "'create policy %I on public.%I for select to authenticated using (true)',");
}
if (MUT === 'credential') {
  mutate('using (company_entity_id = (select public.active_company_id()) and public.is_admin_user());\n\ndrop policy if exists klaviyo_connections_admin_write',
    'using (company_entity_id = (select public.active_company_id()));\n\ndrop policy if exists klaviyo_connections_admin_write');
}
if (MUT === 'writes') mutate("    execute format('revoke all on public.%I from anon, authenticated', t);", "    execute format('revoke all on public.%I from anon', t);");
if (MUT === 'verifier') mutate('revoke all on public.klaviyo_oauth_states from anon, authenticated;', 'revoke all on public.klaviyo_oauth_states from anon;');
if (MUT === 'invoker') mutate('create or replace view public.klaviyo_flow_daily_v\nwith (security_invoker = true) as', 'create or replace view public.klaviyo_flow_daily_v\nwith (security_invoker = false) as');
if (MUT === 'grain') {
  mutate("  constraint klaviyo_message_performance_grain_key\n    unique (company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end),",
    '');
}
if (MUT === 'nullchannel') mutate("  channel text not null default '',\n  timeframe_start timestamptz not null,", '  channel text,\n  timeframe_start timestamptz not null,');
if (MUT === 'jobtype') mutate("    members, 'klaviyo'\n  );\nend $$;\n\n-- ── The insert-stamp backstop", "    members, 'windsor_sync'\n  );\nend $$;\n\n-- ── The insert-stamp backstop");
if (MUT === 'bootstrap') {
  mutate("    'alter table public.integration_bootstrap_jobs add constraint %I check (integration = any (array[%s, %L::text]))',\n    cname, members, 'klaviyo'",
    "    'alter table public.integration_bootstrap_jobs add constraint %I check (integration = any (array[%s, %L::text]))',\n    cname, members, 'shopify'");
}

// Twice: apply_all_post_merge.sql re-runs every migration, and the two CHECK
// appends rewrite a constraint in place -- a second pass must be a no-op, not
// a duplicated value or a raised exception.
await db.exec(migration);
await db.exec(migration);

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
await db.query('insert into entities values($1),($2)', [A, B]);

// ── The verify block, executed verbatim ───────────────────────────────────
const verifySql = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const start = verifySql.indexOf("select 'Klaviyo native integration' as check_name,");
assert.ok(start >= 0, 'Klaviyo verify block missing');
let block = verifySql.slice(start);
const next = /\nselect '[^']+' as check_name,/.exec(block.slice(1));
if (next) block = block.slice(0, next.index + 1);
block = block.split('\n').reduceRight((acc, l) => (acc.length || !/^\s*(--.*)?$/.test(l) ? [l, ...acc] : acc), []).join('\n').trim();
assert.ok(block.endsWith(';'), 'could not extract the verify block');
const verifyStatus = (await db.query(block)).rows[0].status;
if (MUT) assert.notEqual(verifyStatus, 'ok', `verify reports ok under the ${MUT} mutation`);
else assert.equal(verifyStatus, 'ok', `a correctly applied migration must verify ok (got ${verifyStatus})`);

// ── Both queues accept the new vocabulary ─────────────────────────────────
await db.exec('set role service_role');
await db.query("insert into sync_jobs(company_entity_id, job_type, status) values($1,'klaviyo','running')", [A]);
await db.query("insert into sync_jobs(company_entity_id, job_type, status) values($1,'windsor_sync','running')", [A]);
await assert.rejects(
  () => db.query("insert into sync_jobs(company_entity_id, job_type, status) values($1,'not_a_job','running')", [A]),
  'the append must EXTEND the job-type list, not replace it with anything goes');
await db.query("insert into integration_bootstrap_jobs(company_entity_id, integration) values($1,'klaviyo')", [A]);
await db.query("insert into integration_bootstrap_jobs(company_entity_id, integration) values($1,'shopify')", [A]);
await assert.rejects(
  () => db.query("insert into integration_bootstrap_jobs(company_entity_id, integration) values($1,'nope')", [A]),
  'an unknown integration must still fail at enqueue');

// ── The service role writes both companies' rows ──────────────────────────
for (const co of [A, B]) {
  await db.query(
    "insert into klaviyo_connections(company_entity_id, api_key, conversion_metric_id, is_active, sync_enabled) values($1,$2,'M1',true,true)",
    [co, `pk_secret_${co.slice(-1)}`]);
  await db.query(
    "insert into klaviyo_messages(company_entity_id, kind, klaviyo_id, name, channel) values($1,'campaign',$2,'A campaign','email')",
    [co, `msg-${co.slice(-1)}`]);
  await db.query(
    `insert into klaviyo_message_performance(company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end, delivered, bounced)
     values($1,'campaign',$2,'email','2026-11-01T00:00:00+00','2026-11-02T23:59:59+00',100,null)`,
    [co, `msg-${co.slice(-1)}`]);
  await db.query(
    "insert into klaviyo_flow_daily(company_entity_id, klaviyo_id, channel, day_date, delivered) values($1,$2,'email','2026-11-01',10)",
    [co, `fmsg-${co.slice(-1)}`]);
}

// ── The grain holds, and holds BECAUSE channel cannot be null ─────────────
await assert.rejects(
  () => db.query(
    `insert into klaviyo_message_performance(company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end, delivered)
     values($1,'campaign','msg-a','email','2026-11-01T00:00:00+00','2026-11-02T23:59:59+00',999)`, [A]),
  'the same message, channel and window twice is one measurement, not two');
// A report that came back without a send_channel writes '' -- which the unique
// index can compare. A NULL could not, and would insert again every run.
await db.query(
  `insert into klaviyo_message_performance(company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end, delivered)
   values($1,'flow_message','fmsg-a','','2026-11-01T00:00:00+00','2026-11-02T23:59:59+00',5)`, [A]);
await assert.rejects(
  () => db.query(
    `insert into klaviyo_message_performance(company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end, delivered)
     values($1,'flow_message','fmsg-a','','2026-11-01T00:00:00+00','2026-11-02T23:59:59+00',6)`, [A]),
  'a channel-less row must collide with itself too, or one measurement multiplies per run');
// Another WINDOW over the same message is a different measurement and allowed.
await db.query(
  `insert into klaviyo_message_performance(company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end, delivered)
   values($1,'campaign','msg-a','email','2026-01-01T00:00:00+00','2026-01-31T23:59:59+00',50)`, [A]);

// NULL is stored as NULL, not coerced to 0 by a default somewhere.
const stored = await db.query("select bounced from klaviyo_message_performance where company_entity_id = $1 and delivered = 100", [A]);
assert.equal(stored.rows[0].bounced, null, 'an unreported statistic must stay null in the column too');

// ── A member of company A, through the views ──────────────────────────────
await db.exec('reset role');
await db.exec(`set role authenticated; set "test.company" = '${A}'; set "test.admin" = 'false';`);

const seenPerf = await db.query('select company_entity_id from klaviyo_message_performance_v');
assert.ok(seenPerf.rows.length > 0, 'a member must see their own company through the view');
assert.deepEqual([...new Set(seenPerf.rows.map((r) => r.company_entity_id))], [A],
  'the view must show one company only');
const seenDaily = await db.query('select company_entity_id from klaviyo_flow_daily_v');
assert.deepEqual([...new Set(seenDaily.rows.map((r) => r.company_entity_id))], [A]);

// The credential is invisible to a non-admin, and so is the PKCE verifier.
const conn = await db.query('select id from klaviyo_connections');
assert.equal(conn.rows.length, 0, 'the connection row carries a live credential: admin only, even to read');
await assert.rejects(() => db.query('select * from klaviyo_oauth_states'),
  'the PKCE verifier must be unreadable by any client role');

// No client may author a Klaviyo number.
await assert.rejects(
  () => db.query("insert into klaviyo_flow_daily(company_entity_id, klaviyo_id, channel, day_date, delivered) values($1,'x','email','2026-11-03',1)", [A]),
  'a hand-authored row would be a figure Klaviyo never reported');
await assert.rejects(
  () => db.query('update klaviyo_message_performance set delivered = 1'),
  'nor may one be edited');
await assert.rejects(
  () => db.query('delete from klaviyo_messages'), 'nor deleted');

// ── An admin of company A ────────────────────────────────────────────────
await db.exec(`set "test.admin" = 'true';`);
const adminConn = await db.query('select company_entity_id, api_key from klaviyo_connections');
assert.equal(adminConn.rows.length, 1, 'an admin sees their own connection');
assert.equal(adminConn.rows[0].company_entity_id, A, 'and only their own');
// An admin may change their own row (the Integrations card does), but cannot
// reach another company's.
await db.query("update klaviyo_connections set display_name = 'Klaviyo' where company_entity_id = $1", [A]);
const otherTouched = await db.query("update klaviyo_connections set api_key = 'stolen' where company_entity_id = $1 returning id", [B]);
assert.equal(otherTouched.rows.length, 0, 'an admin of A must not be able to write B\'s credential');

await db.exec('reset role');

// ── anon sees nothing at all ─────────────────────────────────────────────
await db.exec('set role anon');
for (const rel of ['klaviyo_connections', 'klaviyo_messages', 'klaviyo_message_performance',
  'klaviyo_flow_daily', 'klaviyo_message_performance_v', 'klaviyo_flow_daily_v', 'klaviyo_oauth_states']) {
  await assert.rejects(() => db.query(`select 1 from ${rel}`), `anon must not be able to read ${rel}`);
}
await db.exec('reset role');

// ── The catalog describes the views, not the base tables ─────────────────
const catalogued = (await db.query('select relname from silo_chat_schema_catalog order by relname')).rows.map((r) => r.relname);
assert.deepEqual(catalogued, ['klaviyo_flow_daily_v', 'klaviyo_message_performance_v'],
  'bots and Ask SILO must be pointed at the views, where RLS applies and the names are joined');

console.log(MUT ? `ok (mutation ${MUT} was caught)` : 'ok');
