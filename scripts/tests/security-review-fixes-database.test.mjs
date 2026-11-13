// 20261113010000_security_review_fixes.sql, run against a real PostgreSQL.
//
// Four findings from the read-only security review of 2026-11-12. The fixture
// installs the PRE-migration state for each one and asserts the hole is there
// first, so what follows proves the migration closed it rather than that the
// fixture never had it.
//
//   PART 1  the shared read-only report engine refuses outbound HTTP
//   PART 2  ar_sync_status_v stops disclosing the retired sheet URLs
//   PART 3  plaintext OAuth tokens stop being SELECTable by the browser roles
//   PART 4  one SELECT policy stops being role-less
//
// The two assertions worth keeping whatever else changes:
//
//   * PART 1 must refuse net.http_post AND must NOT refuse a query that merely
//     builds a URL ('http://' || handle). A bare \mhttp\M pattern does both
//     wrong at once -- \m matches at the word start and \M before the ':' --
//     and would refuse any report with a link column. The `bare-http` mutation
//     is that exact near-miss.
//   * PART 3 must revoke the TABLE grant and re-grant per column. A
//     `revoke select (access_token) ... from authenticated` on its own is a
//     NO-OP while the table-level grant stands, which is how the first draft
//     of this migration was written. The `column-revoke-only` mutation is that
//     draft, and it must fail.
//
// Mutations (each must make a specific assertion fail):
//   SEC_MUTATION=no-net              (drops \mnet\s*\. from the guard)
//   SEC_MUTATION=no-extensions-http  (drops extensions\s*\.\s*http)
//   SEC_MUTATION=bare-http           (uses \mhttp\M instead of the _suffix list)
//   SEC_MUTATION=view-denylist       (payload - 'sources' instead of an allowlist)
//   SEC_MUTATION=view-anon           (skips the anon revoke on the view)
//   SEC_MUTATION=view-keeps-payload  (passes the stored payload straight through)
//   SEC_MUTATION=column-revoke-only  (the no-op column revoke; the first draft)
//   SEC_MUTATION=no-regrant          (revokes the table grant and never re-grants)
//   SEC_MUTATION=policy-roleless     (skips the alter policy)
//
// Run: node scripts/tests/security-review-fixes-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUTATIONS = ['no-net', 'no-extensions-http', 'bare-http', 'view-denylist', 'view-anon',
  'view-keeps-payload', 'column-revoke-only', 'no-regrant', 'policy-roleless'];
const mutation = process.env.SEC_MUTATION || '';
assert.ok(mutation === '' || MUTATIONS.includes(mutation), `Unknown mutation: ${mutation}`);

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
let n = 0;
const t = (name) => console.log(`ok ${++n} - ${name}`);

/** Run sql as a role, always restoring the session role. */
async function asRole(role, sql) {
  await db.query(`set role ${role}`);
  try { return await db.query(sql); } finally { await db.query('reset role'); }
}
async function deniedAs(role, sql) {
  try { await asRole(role, sql); return null; } catch (e) { return e.message; }
}

// ── The pre-migration world ────────────────────────────────────────────────
// Only what the migration touches. The three connection tables carry the
// column sets and the Supabase default table-level grants read live from
// production on 2026-11-12; RLS is deliberately left OFF on them so that a
// successful select proves a GRANT and never a policy.
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  -- silo_api_exec owns silo_api_query (SECURITY DEFINER) and is a member of
  -- authenticated with inheritance, holding no grant of its own. That is what
  -- makes the MCP path inherit whatever authenticated ends up with.
  create role silo_api_exec in role authenticated;

  create table public.job_sync_state (
    key text primary key,
    status text,
    started_at timestamptz,
    completed_at timestamptz,
    last_success_at timestamptz,
    updated_at timestamptz,
    payload jsonb,
    error_text text
  );
  alter table public.job_sync_state enable row level security;   -- deny-all, zero policies

  create table public.quickbooks_connections (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, realm_id text,
    company_name text, environment text, access_token text, refresh_token text,
    token_expires_at timestamptz, refresh_token_expires_at timestamptz, is_active boolean,
    location_tracking_enabled boolean
  );
  create table public.klaviyo_connections (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, display_name text,
    auth_mode text, api_key text, access_token text, refresh_token text, is_active boolean
  );
  create table public.ad_platform_connections (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, platform text,
    display_name text, access_token text, refresh_token text, is_active boolean
  );

  grant all on public.quickbooks_connections  to anon, authenticated, service_role;
  grant all on public.klaviyo_connections     to authenticated, service_role;
  grant all on public.ad_platform_connections to anon, authenticated, service_role;

  -- shopify_connections is NOT one of the three this migration changes: it was
  -- closed by 20260928120000 and is here in the state that migration left it,
  -- because verify_v2_schema.sql's credential check covers all four and would
  -- otherwise report a table absent rather than exercising the rule.
  create table public.shopify_connections (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, shop_domain text,
    access_token text, token_expires_at timestamptz, is_active boolean
  );
  grant all on public.shopify_connections to anon, authenticated, service_role;
  revoke select on public.shopify_connections from anon, authenticated;
  grant select (id, company_entity_id, shop_domain, token_expires_at, is_active)
    on public.shopify_connections to authenticated;

  -- active_company_id() and is_admin_user() stand in for the real gates; only
  -- the policy's ROLES matter to this file.
  create function public.active_company_id() returns uuid language sql stable as $$ select null::uuid $$;
  create function public.is_admin_user() returns boolean language sql stable as $$ select true $$;
  alter table public.ad_platform_connections enable row level security;
  create policy ad_platform_connections_admin_select on public.ad_platform_connections
    for select using (company_entity_id = public.active_company_id() and public.is_admin_user());
  alter table public.ad_platform_connections disable row level security;

  -- The guard exactly as 20261030100000 left it.
  create function public.silo_sql_refused_function(p_sql text)
  returns text language sql immutable set search_path = '' as $g$
    select case
      when p_sql is null then null
      when lower(p_sql) ~ 'u&' then 'a U& escaped identifier'
      else substring(lower(p_sql) from
        '(\\mset_config\\M|\\m[a-z_]*_to_xml[a-z_]*\\M|\\mts_stat\\M|\\mts_rewrite\\M|\\mindex_advisor\\M|\\mhypopg_[a-z_]+\\M|\\mgraphql\\M|\\mdblink[a-z_]*\\M|\\mrealtime\\s*\\.)')
    end
  $g$;

  -- ar_sync_status_v as it stood: the whole stored payload, readable by anon.
  create view public.ar_sync_status_v as
    select key, status, started_at, completed_at, last_success_at, updated_at, payload, error_text
    from public.job_sync_state where key = 'ar_google_sheets_sync';
  alter view public.ar_sync_status_v set (security_invoker = false);
  grant select on public.ar_sync_status_v to anon, authenticated, service_role;
`);

// The real production row, shortened. The two things that matter are that
// payload.sources holds a URL and that the four keys the Ops panel reads sit
// beside it -- the URL itself is a PLACEHOLDER on a .invalid host, never the
// real one. scripts/tests/ar-sync-source-urls.test.mjs (from PR #984) fails
// the build if a real publish-to-web sheet URL is committed anywhere in the
// tree, and it caught the first version of this fixture. Keeping the guard
// strict matters more than fixture realism: what is under test is that a
// value stored in payload.sources never reaches a reader, and any distinctive
// string proves that.
const STORED_PAYLOAD = {
  stale: true,
  sources: ['https://docs.example.invalid/spreadsheets/d/e/REDACTED-SHEET-ID/pub?gid=0&single=true&output=csv'],
  source_stats: { google_sheet_1: { rows: 10 } },
  company_entity_id: '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7',
  sync_run_id: 'run-1',
  invoice_count: 7,
  staleness_days: 31,
  newest_order_date: '2026-09-11',
  stale_threshold_days: 7,
};
await q(`insert into public.job_sync_state
   (key, status, last_success_at, updated_at, payload, error_text)
   values ('ar_google_sheets_sync', 'success', now(), now(), $1::jsonb, null)`,
[JSON.stringify(STORED_PAYLOAD)]);

// ── The holes are really there before the migration ────────────────────────
{
  const r = await one(`select
      public.silo_sql_refused_function('select net.http_post(''https://x.invalid'', ''{}''::jsonb)') as net,
      public.silo_sql_refused_function('select extensions.http_get(''http://169.254.169.254/'')') as ext,
      public.silo_sql_refused_function('select pg_sleep(30)') as sleep,
      public.silo_sql_refused_function('select set_config(''request.jwt.claims'', ''{}'', true)') as oldguard`);
  assert.equal(r.net, null, 'pre-migration: net.http_post was allowed');
  assert.equal(r.ext, null, 'pre-migration: extensions.http_get was allowed');
  assert.equal(r.sleep, null, 'pre-migration: pg_sleep was allowed');
  assert.equal(r.oldguard, 'set_config', 'pre-migration: the 20261030100000 guard is installed');
  t('before: the guard refuses set_config but allows outbound HTTP and sleep');
}
{
  const r = await asRole('anon', `select payload from public.ar_sync_status_v`);
  assert.ok(JSON.stringify(r.rows[0].payload).includes('docs.example.invalid'),
    'pre-migration: anon could read the sheet URLs out of the view');
  t('before: anon reads the retired sheet URLs out of ar_sync_status_v');
}
{
  const r = await asRole('authenticated', `select access_token from public.quickbooks_connections`);
  assert.ok(Array.isArray(r.rows), 'pre-migration: authenticated could select the token column');
  t('before: authenticated may select quickbooks_connections.access_token');
}

// ── Apply the migration, optionally mutated ────────────────────────────────
let SQL = await readFile(new URL('supabase/migrations/20261113010000_security_review_fixes.sql', root), 'utf8');
const NEW_PATTERN = "|\\mnet\\s*\\.|\\mextensions\\s*\\.\\s*http|\\mhttp_(get|post|put|patch|delete|head|header|set_curlopt|reset_curlopt|list_curlopt)\\M|\\mpg_sleep(_for|_until)?\\M";
assert.ok(SQL.includes(NEW_PATTERN), 'the migration no longer carries the pattern this test mutates');

const mutate = {
  'no-net': (s) => s.replace('|\\mnet\\s*\\.', ''),
  'no-extensions-http': (s) => s.replace('|\\mextensions\\s*\\.\\s*http', ''),
  'bare-http': (s) => s.replace(
    '|\\mextensions\\s*\\.\\s*http|\\mhttp_(get|post|put|patch|delete|head|header|set_curlopt|reset_curlopt|list_curlopt)\\M',
    '|\\mhttp\\M'),
  'view-denylist': (s) => s.replace(/jsonb_build_object\([\s\S]*?\) as payload/, "payload - 'sources' as payload"),
  'view-anon': (s) => s.replace('revoke all on public.ar_sync_status_v from anon;', ''),
  'view-keeps-payload': (s) => s.replace(/jsonb_build_object\([\s\S]*?\) as payload/, 'payload'),
  'column-revoke-only': (s) => s.replace(
    /execute format\('revoke select on public\.%I from anon, authenticated', t\);\n\s*execute format\('grant select \(%s\) on public\.%I to authenticated', cols, t\);/,
    `execute format('revoke select (access_token) on public.%I from anon, authenticated', t);`),
  'no-regrant': (s) => s.replace(
    /\n\s*execute format\('grant select \(%s\) on public\.%I to authenticated', cols, t\);/, ''),
  'policy-roleless': (s) => s.replace(/alter policy ad_platform_connections_admin_select[\s\S]*?to authenticated;/, ''),
};
if (mutation) {
  const before = SQL;
  SQL = mutate[mutation](SQL);
  assert.notEqual(SQL, before, `mutation ${mutation} changed nothing -- it no longer matches the migration`);
}
await db.exec(SQL);

// ── PART 1: the guard ──────────────────────────────────────────────────────
{
  const r = await one(`select
      public.silo_sql_refused_function('select net.http_post(''https://x.invalid'', ''{}''::jsonb)') as net,
      public.silo_sql_refused_function('select net . http_get(''https://x.invalid'')') as net_spaced,
      public.silo_sql_refused_function('select extensions.http_get(''http://169.254.169.254/'')') as ext,
      public.silo_sql_refused_function('select http_post(''x'', ''y'')') as bare_post,
      public.silo_sql_refused_function('select pg_sleep(30)') as sleep,
      public.silo_sql_refused_function('select pg_sleep_for(''1 min'')') as sleep_for`);
  assert.ok(r.net, 'net.http_post must be refused');
  assert.ok(r.net_spaced, 'net . http_get with whitespace must be refused');
  assert.ok(r.ext, 'extensions.http_get must be refused');
  assert.ok(r.bare_post, 'an unqualified http_post must be refused');
  assert.ok(r.sleep, 'pg_sleep must be refused');
  assert.ok(r.sleep_for, 'pg_sleep_for must be refused');
  t('PART 1: outbound HTTP and sleep are refused, qualified or not');
}
{
  // What the two SCHEMA patterns uniquely cover. Everything above is caught by
  // the bare-name list as well, so these are the assertions that make
  // `\mnet\s*\.` and `extensions\s*\.\s*http` carry their weight -- the first
  // mutation run had both surviving because every case was double-covered.
  const r = await one(`select
      public.silo_sql_refused_function('select net.http_collect_response(1)') as collect,
      public.silo_sql_refused_function('select * from net._http_response') as response_table,
      public.silo_sql_refused_function('select extensions.http((''GET'', ''http://x/'', null, null, null)::extensions.http_request)') as http_composite`);
  assert.ok(r.collect, 'net.http_collect_response must be refused (only the net. pattern catches it)');
  assert.ok(r.response_table, 'reading net._http_response must be refused -- that is where a reply lands');
  assert.ok(r.http_composite, 'extensions.http() must be refused (only the extensions.http pattern catches it)');
  t('PART 1: the whole pg_net schema and extensions.http() are refused');
}
{
  // The near-miss: a report that merely builds a URL must still run. This is
  // what a bare \mhttp\M pattern breaks.
  const r = await one(`select
      public.silo_sql_refused_function('select ''http://shop.example/'' || handle as link from products') as url_literal,
      public.silo_sql_refused_function('select ''https://shop.example/p'' as link') as https_literal,
      public.silo_sql_refused_function('select extensions.similarity(a, b) from t') as similarity,
      public.silo_sql_refused_function('select 1 as offset_config') as offset_config,
      public.silo_sql_refused_function('select net_sales from sales_by_day') as net_sales,
      public.silo_sql_refused_function('select sum(net_revenue) from orders where channel = ''internet''') as netish`);
  assert.equal(r.url_literal, null, "a report building 'http://...' must NOT be refused");
  assert.equal(r.https_literal, null, "a report building 'https://...' must NOT be refused");
  assert.equal(r.similarity, null, 'extensions.similarity() must NOT be refused');
  assert.equal(r.offset_config, null, 'a column named offset_config must NOT be refused');
  assert.equal(r.net_sales, null, 'a column named net_sales must NOT be refused');
  assert.equal(r.netish, null, 'net_revenue / an ordinary report must NOT be refused');
  t('PART 1: ordinary reports, URL literals and extensions.similarity still run');
}
{
  const r = await one(`select
      public.silo_sql_refused_function('select set_config(''request.jwt.claims'', ''{}'', true)') as a,
      public.silo_sql_refused_function('select query_to_xml(''x'', true, false, '''')') as b,
      public.silo_sql_refused_function('select realtime . x()') as c,
      public.silo_sql_refused_function('select dblink(''a'',''b'')') as d,
      public.silo_sql_refused_function(null) as e`);
  for (const [k, v] of Object.entries({ a: 'set_config', b: 'query_to_xml', c: 'realtime .', d: 'dblink' })) {
    assert.ok(r[k] && r[k].includes(v.split(' ')[0]), `20261030100000's guard still refuses ${v}`);
  }
  assert.equal(r.e, null, 'null in, null out');
  t('PART 1: everything 20261030100000 refused is still refused');
}

// ── PART 2: the view ───────────────────────────────────────────────────────
{
  const row = await one(`select * from public.ar_sync_status_v`);
  const keys = Object.keys(row.payload).sort();
  assert.deepEqual(keys, ['newest_order_date', 'stale', 'stale_threshold_days', 'staleness_days'],
    'payload is exactly the four keys v2/backend.html reads');
  // Every field the Ops panel renders, by name. UX must not change.
  assert.equal(row.payload.stale, true);
  assert.equal(row.payload.newest_order_date, '2026-09-11');
  assert.equal(row.payload.staleness_days, 31);
  assert.equal(row.payload.stale_threshold_days, 7);
  assert.ok('last_success_at' in row && 'error_text' in row && 'status' in row,
    'the top-level columns the panel reads survive');
  t('PART 2: the view still serves every field the Ops panel renders, and nothing else');
}
{
  const txt = JSON.stringify(await q(`select * from public.ar_sync_status_v`));
  assert.ok(!txt.includes('docs.example.invalid'), 'the sheet URLs must not come through the view');
  assert.ok(!txt.includes('3bd934c9'), 'company_entity_id must not come through the view');
  assert.ok(!txt.includes('google_sheet_1'), 'source_stats must not come through the view');
  t('PART 2: no sheet URL, company id or source_stats reaches a reader');
}
{
  // The allowlist, not a denylist: a key added to the stored payload later is
  // not disclosed by default. `view-denylist` fails here and nowhere else.
  await q(`update public.job_sync_state
             set payload = payload || '{"sftp_password":"hunter2"}'::jsonb
           where key = 'ar_google_sheets_sync'`);
  const txt = JSON.stringify(await q(`select * from public.ar_sync_status_v`));
  assert.ok(!txt.includes('hunter2'), 'a NEW payload key must not be disclosed by default');
  await q(`update public.job_sync_state set payload = payload - 'sftp_password'
           where key = 'ar_google_sheets_sync'`);
  t('PART 2: payload is an allowlist -- a newly stored key is not disclosed');
}
{
  const stored = await one(`select payload from public.job_sync_state where key = 'ar_google_sheets_sync'`);
  assert.ok(!('sources' in stored.payload), 'the stored sources key is cleared by the migration');
  assert.equal(stored.payload.stale, true, 'the rest of the stored payload is untouched');
  assert.equal(stored.payload.invoice_count, 7, 'the rest of the stored payload is untouched');
  // Idempotent: applying twice changes nothing.
  await db.exec(`update public.job_sync_state set payload = payload - 'sources'
                 where key = 'ar_google_sheets_sync' and payload ? 'sources'`);
  const again = await one(`select payload from public.job_sync_state where key = 'ar_google_sheets_sync'`);
  assert.deepEqual(again.payload, stored.payload, 're-running the cleanup is a no-op');
  t('PART 2: the retired URLs are cleared from the stored row, idempotently');
}
{
  const msg = await deniedAs('anon', `select * from public.ar_sync_status_v`);
  assert.ok(msg && /permission denied/i.test(msg), `anon must not read the view (got: ${msg})`);
  const ok = await asRole('authenticated', `select key from public.ar_sync_status_v`);
  assert.equal(ok.rows.length, 1, 'authenticated still reads it -- v2/backend.html is its only reader');
  t('PART 2: anon loses the view, the admin page keeps it');
}
{
  const v = await one(`select c.reloptions::text opts from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'ar_sync_status_v'`);
  assert.ok(v.opts.includes('security_invoker=false'),
    'the view must stay definer or it silently returns zero rows (20260805030000)');
  t('PART 2: security_invoker stays false');
}

// ── PART 3: the token columns ──────────────────────────────────────────────
const SECRETS = {
  quickbooks_connections: ['access_token', 'refresh_token'],
  klaviyo_connections: ['access_token', 'refresh_token', 'api_key'],
  ad_platform_connections: ['access_token', 'refresh_token'],
};
{
  for (const [table, cols] of Object.entries(SECRETS)) {
    for (const col of cols) {
      for (const role of ['anon', 'authenticated', 'silo_api_exec']) {
        const can = await one(
          `select has_column_privilege($1, $2, $3, 'select') as ok`, [role, `public.${table}`, col]);
        assert.equal(can.ok, false, `${role} must not select ${table}.${col}`);
      }
      const svc = await one(
        `select has_column_privilege('service_role', $1, $2, 'select') as ok`, [`public.${table}`, col]);
      assert.equal(svc.ok, true, `service_role must keep ${table}.${col} -- every sync reads it`);
    }
  }
  t('PART 3: no browser role may select a credential; service_role still can');
}
{
  // The behaviour, not just the catalog: select('*') is what PostgREST sends.
  const msg = await deniedAs('authenticated', `select * from public.quickbooks_connections`);
  assert.ok(msg && /permission denied/i.test(msg),
    `select * must be refused once a column is revoked (got: ${msg})`);
  t('PART 3: select * is refused -- which is why the QBO card had to name its columns first');
}
{
  // ...and the named columns the pages actually use still work.
  const qbo = await asRole('authenticated',
    `select id, company_entity_id, realm_id, company_name, environment, token_expires_at,
            refresh_token_expires_at, is_active, location_tracking_enabled
       from public.quickbooks_connections`);
  assert.ok(Array.isArray(qbo.rows), 'the QBO card columns still select');
  const ad = await asRole('authenticated',
    `select id, platform, display_name, is_active from public.ad_platform_connections`);
  assert.ok(Array.isArray(ad.rows), 'loadAdConnections columns still select');
  const kl = await asRole('authenticated',
    `select id, display_name, auth_mode, is_active from public.klaviyo_connections`);
  assert.ok(Array.isArray(kl.rows), 'loadKlaviyoConnection columns still select');
  t('PART 3: every column the three cards name is still readable');
}
{
  // Writes must survive: the admin pastes a Meta token and a Klaviyo key into
  // v2/integrations.html, which writes straight to these columns.
  await asRole('authenticated',
    `insert into public.ad_platform_connections (platform, display_name, access_token)
     values ('meta_ads', 'Meta Ads account', 'EAAG-pasted-by-the-admin')`);
  await asRole('authenticated',
    `insert into public.klaviyo_connections (display_name, auth_mode, api_key)
     values ('Klaviyo', 'api_key', 'pk_pasted_by_the_admin')`);
  await asRole('authenticated',
    `update public.klaviyo_connections set api_key = 'pk_rotated' where auth_mode = 'api_key'`);
  const stored = await one(`select api_key from public.klaviyo_connections where auth_mode = 'api_key'`);
  assert.equal(stored.api_key, 'pk_rotated', 'the credential was written and can be rotated');
  t('PART 3: a credential can still be pasted in and rotated -- write without read');
}
{
  // A column added later is granted by the apply-time list, not left dark.
  await db.exec(`alter table public.quickbooks_connections add column minorversion text`);
  await db.exec(SQL.match(/do \$\$[\s\S]*?end \$\$;/)[0]);
  const can = await one(
    `select has_column_privilege('authenticated', 'public.quickbooks_connections', 'minorversion', 'select') as ok`);
  assert.equal(can.ok, true, 'a column added later is granted when the block is re-run');
  const still = await one(
    `select has_column_privilege('authenticated', 'public.quickbooks_connections', 'access_token', 'select') as ok`);
  assert.equal(still.ok, false, 're-running must not re-grant the credential');
  t('PART 3: the grant list is computed at apply time and stays credential-free');
}

// ── PART 4: the policy ─────────────────────────────────────────────────────
{
  const p = await one(`select (select array_agg(r.rolname::text) from pg_roles r where r.oid = any(p.polroles)) roles
     from pg_policy p join pg_class c on c.oid = p.polrelid
     where c.relname = 'ad_platform_connections' and p.polname = 'ad_platform_connections_admin_select'`);
  assert.deepEqual(p.roles, ['authenticated'],
    'the SELECT policy must name authenticated, not PUBLIC');
  t('PART 4: the ad-platform SELECT policy is scoped to authenticated');
}

// ── Re-appliable ───────────────────────────────────────────────────────────
// apply_all_post_merge.sql promises every migration can run again, and this
// one carries a data UPDATE and two grant rewrites, each of which has a wrong
// version that only shows on a second pass.
{
  await db.exec(SQL);
  const row = await one(`select * from public.ar_sync_status_v`);
  assert.deepEqual(Object.keys(row.payload).sort(),
    ['newest_order_date', 'stale', 'stale_threshold_days', 'staleness_days'],
    'the view is unchanged by a second apply');
  assert.equal(
    (await one(`select has_column_privilege('authenticated', 'public.klaviyo_connections', 'api_key', 'select') as ok`)).ok,
    false, 'a second apply must not hand the credential back');
  assert.equal(
    (await one(`select has_column_privilege('authenticated', 'public.klaviyo_connections', 'display_name', 'select') as ok`)).ok,
    true, 'a second apply must not take the ordinary columns away');
  const stored = await one(`select payload from public.job_sync_state where key = 'ar_google_sheets_sync'`);
  assert.ok(!('sources' in stored.payload) && stored.payload.invoice_count === 7,
    'a second apply leaves the stored row alone');
  t('the whole migration is re-appliable');
}

// ── verify_v2_schema.sql's own checks, read from the file ──────────────────
// Not retyped: a check that drifts from what the daily drift run executes
// proves nothing. Each of these four returns CRITICAL/MISSING against
// production today (run read-only 2026-11-12, before the migration is
// applied), so this asserts the other half -- that they go green once it is.
{
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const names = ['readonly_query_egress_guard', 'ar_sync_status_v_no_credentials',
    'connection_credentials_not_browser_readable', 'ad_platform_select_policy_roles'];
  for (const name of names) {
    const marker = `end as ${name};`;
    const end = verify.indexOf(marker);
    assert.ok(end > 0, `verify_v2_schema.sql no longer defines ${name}`);
    const start = verify.lastIndexOf('\nselect\n  case', end);
    assert.ok(start > 0, `could not find the start of the ${name} check`);
    const sql = verify.slice(start, end + marker.length);
    const row = await one(sql);
    assert.equal(row[name], 'ok', `verify_v2_schema.sql ${name} is not ok after the migration: ${row[name]}`);
  }
  t(`verify_v2_schema.sql's ${names.length} new checks all return ok after the migration`);
}

console.log(`\n${n} checks passed${mutation ? ` (mutation: ${mutation} -- SHOULD HAVE FAILED)` : ''}`);
if (mutation) { console.error('\nFAILED: the mutation did not break any assertion'); process.exit(1); }
