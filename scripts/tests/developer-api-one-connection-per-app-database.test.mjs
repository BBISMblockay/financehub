// One live connection per person per application (20261102180000), executed
// in a real PostgreSQL (PGlite) with the migration's own SQL.
//
// Proves:
//   * reconnecting an application under a BRAND NEW dynamic client_id -- which
//     is what Cursor, Claude, Codex, ChatGPT and Grok all do on every connect
//     -- replaces that person's connection instead of adding another;
//   * the key is per USER: a second person in the same company connecting the
//     same application is a second live connection, untouched;
//   * one person can hold Claude AND Cursor AND Codex at the same time;
//   * ephemeral localhost ports (Codex) and per-install paths do not defeat it;
//   * an unreadable or non-uuid client registration dedupes NOTHING, so the
//     failure mode is today's behaviour and never a wrong collapse;
//   * the duplicates that already existed collapse to the one that was used;
//   * app_key is frozen, and the unique index refuses a second live row even
//     to a writer that bypasses silo_api_consent();
//   * silo_api_prior_company() answers for a reconnect under a new client_id,
//     own grants only;
//   * silo_api_app_key() is reachable by no client role.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/developer-api-one-connection-per-app-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const MIGRATION = readFileSync(
  'supabase/migrations/20261102180000_developer_api_one_connection_per_app.sql', 'utf8');

const CO_A = '00000000-0000-4000-a000-00000000000a';
const CO_B = '00000000-0000-4000-a000-00000000000b';
const TRAVIS = '00000000-0000-4000-b000-000000000001';
const SAMMIE = '00000000-0000-4000-b000-000000000002';

// Client registrations, copied in shape from production 2026-11-02: one
// application, many client ids, and redirect URIs that move.
const CURSOR_1 = '00000000-0000-4000-c000-000000000001';
const CURSOR_2 = '00000000-0000-4000-c000-000000000002';
const CURSOR_3 = '00000000-0000-4000-c000-000000000003';
const CLAUDE_1 = '00000000-0000-4000-c000-000000000011';
const CLAUDE_2 = '00000000-0000-4000-c000-000000000012';
const CODEX_1   = '00000000-0000-4000-c000-000000000021';
const CODEX_2   = '00000000-0000-4000-c000-000000000022';
const NAMELESS  = '00000000-0000-4000-c000-000000000031';
const GROK      = '00000000-0000-4000-c000-000000000051';
const GONE      = '00000000-0000-4000-c000-000000000041';

const CURSOR_URIS = 'https://www.cursor.com/agents/mcp/oauth/callback,http://localhost:8787/callback';

// Pre-existing grants, written before the migration runs: three live Cursor
// rows for one person, only the newest ever used. This is the production state
// the migration was written for.
const G_OLD_1 = '00000000-0000-4000-d000-000000000001';
const G_OLD_2 = '00000000-0000-4000-d000-000000000002';
const G_OLD_3 = '00000000-0000-4000-d000-000000000003';
// And the shape the first review of #1095 asked for: a WORKING connection
// whose last use is older than a never-used duplicate's consent. Ranking by
// coalesce(last_used_at, consented_at) revokes the working one.
const G_USED  = '00000000-0000-4000-d000-000000000011';
const G_FRESH = '00000000-0000-4000-d000-000000000012';

await db.exec(`
create schema auth;
create role anon;
create role authenticated;
create role silo_integration;
create role silo_revoked;

create table auth.oauth_clients(
  id uuid primary key, client_name text, redirect_uris text, deleted_at timestamptz);
insert into auth.oauth_clients values
  ('${CURSOR_1}', 'Cursor', '${CURSOR_URIS}', null),
  ('${CURSOR_2}', 'Cursor', '${CURSOR_URIS}', null),
  ('${CURSOR_3}', 'Cursor', '${CURSOR_URIS}', null),
  ('${CLAUDE_1}', 'Claude', 'https://claude.ai/api/mcp/auth_callback', null),
  ('${CLAUDE_2}', 'Claude', 'https://claude.ai/api/mcp/auth_callback', null),
  -- Codex: a fresh localhost PORT and a per-install path token every launch.
  ('${CODEX_1}', 'Codex', 'http://127.0.0.1:59105/callback/FhTdkr4QLGqV', null),
  ('${CODEX_2}', 'Codex', 'http://127.0.0.1:59065/callback/ZZtopQ9z', null),
  ('${NAMELESS}', '  ', '', null),
  -- Registered, never consented by anyone: the no-history case.
  ('${GROK}', 'Grok', 'https://grok.com/connectors-oauth-exchange-code/', null),
  ('${GONE}', 'Cursor', '${CURSOR_URIS}', now());

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.sub', true), '')::uuid $$;
create function public.silo_api_claims() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'sub', nullif(current_setting('test.sub', true), ''),
    'aal', coalesce(nullif(current_setting('test.aal', true), ''), 'aal2')) $$;
create function public.silo_api_is_integration() returns boolean language sql stable as $$
  select current_setting('test.integration', true) = 'on' $$;
create function public.active_company_id() returns uuid language sql stable as $$
  select nullif(current_setting('test.company', true), '')::uuid $$;

create table public.entities(id uuid primary key);
insert into public.entities values ('${CO_A}'), ('${CO_B}');
create table public.entity_memberships(user_id uuid, entity_id uuid, role text);
insert into public.entity_memberships values
  ('${TRAVIS}', '${CO_A}', 'admin'),
  ('${TRAVIS}', '${CO_B}', 'admin'),
  ('${SAMMIE}', '${CO_A}', 'admin');

-- silo_api_grants as 20261020030000 leaves it, with the rule that never fired.
create table public.silo_api_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  user_id uuid not null,
  company_entity_id uuid not null references public.entities(id),
  auth_session_id uuid,
  generation integer not null default 1,
  scopes text[] not null default '{}',
  consented_aal text,
  consented_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index silo_api_grants_one_live
  on public.silo_api_grants (client_id, user_id) where revoked_at is null;

create function public.silo_api_grants_frozen() returns trigger
language plpgsql set search_path = '' as $fn$
begin
  if new.client_id is distinct from old.client_id
     or new.user_id is distinct from old.user_id then
    raise exception 'silo_api_grant_frozen: a granted authorization cannot be changed; approve a new one'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;
create trigger silo_api_grants_frozen before update on public.silo_api_grants
  for each row execute function public.silo_api_grants_frozen();

insert into public.silo_api_grants
  (id, client_id, user_id, company_entity_id, scopes, consented_at, last_used_at)
values
  ('${G_OLD_1}', '${CURSOR_1}', '${TRAVIS}', '${CO_A}', '{reports:read}',
   now() - interval '3 days', null),
  ('${G_OLD_2}', '${CURSOR_2}', '${TRAVIS}', '${CO_A}', '{reports:read}',
   now() - interval '2 days', null),
  ('${G_OLD_3}', '${CURSOR_3}', '${TRAVIS}', '${CO_A}', '{reports:read}',
   now() - interval '1 day', now() - interval '1 hour'),
  -- Sammie's Claude: used at T-3h, and a duplicate consented at T-2h that
  -- nothing has ever touched. The working one must survive.
  ('${G_USED}', '${CLAUDE_1}', '${SAMMIE}', '${CO_A}', '{reports:read}',
   now() - interval '5 hours', now() - interval '3 hours'),
  ('${G_FRESH}', '${CLAUDE_2}', '${SAMMIE}', '${CO_A}', '{reports:read}',
   now() - interval '2 hours', null);
`);

// The migration, DO-block guards and all. It runs as one statement batch, the
// way `supabase db push` applies it.
await db.exec(MIGRATION);

const as = async (user, company, opts = {}) => {
  await db.exec(`select set_config('test.sub', '${user}', false),
                        set_config('test.company', '${company}', false),
                        set_config('test.aal', '${opts.aal || 'aal2'}', false),
                        set_config('test.integration', '${opts.integration ? 'on' : 'off'}', false)`);
};
const consent = async (clientId) =>
  (await q(`select public.silo_api_consent('${clientId}', array['reports:read','data:read']) as id`))[0].id;
const live = async (user) => q(`select id, client_id, app_key, generation, company_entity_id
  from public.silo_api_grants where user_id = '${user}' and revoked_at is null
  order by consented_at`);

await test('the duplicates that already existed collapsed to the one that was used', async () => {
  const rows = await q(`select id, revoked_at is null as is_live from public.silo_api_grants
    where user_id = '${TRAVIS}' order by consented_at`);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.is_live), [false, false, true]);
  assert.equal(rows[2].id, G_OLD_3, 'the survivor is the one with a last_used_at');
});

await test('a working connection outlives a newer duplicate nobody has used', async () => {
  // The whole point: last use ranks ahead of consent time. Ordering by
  // coalesce(last_used_at, consented_at) picks G_FRESH -- consented an hour
  // after G_USED was last used -- and permanently revokes the one that works.
  const rows = await q(`select id, revoked_at is null as is_live
    from public.silo_api_grants where user_id = '${SAMMIE}' order by id`);
  assert.deepEqual(rows, [
    { id: G_USED, is_live: true },
    { id: G_FRESH, is_live: false },
  ]);
});

await test('the collapsed rows all carry the same application key', async () => {
  const keys = await q(`select distinct app_key from public.silo_api_grants
    where user_id = '${TRAVIS}'`);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].app_key, 'cursor|localhost,www.cursor.com');
});

await test('reconnecting under a new client_id replaces, it does not add', async () => {
  await as(TRAVIS, CO_A);
  await consent(CURSOR_1);
  let rows = await live(TRAVIS);
  assert.equal(rows.length, 1, 'the migration survivor was replaced, not joined');
  // A fresh dynamic registration: a client_id SILO has never seen on a grant.
  await consent(CURSOR_2);
  rows = await live(TRAVIS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, CURSOR_2);
  assert.equal(rows[0].generation, 3, 'generation counts the application, not the registration');
});

await test('a reconnect for another company moves the one connection', async () => {
  await as(TRAVIS, CO_B);
  await consent(CURSOR_3);
  const rows = await live(TRAVIS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_entity_id, CO_B);
});

await test('another person in the same company keeps their own connection', async () => {
  await as(SAMMIE, CO_A);
  const before = (await live(SAMMIE)).length;   // their surviving Claude
  await consent(CURSOR_1);
  assert.equal((await live(SAMMIE)).length, before + 1, 'Cursor joins, Claude stays');
  assert.equal((await live(TRAVIS)).length, 1, 'Travis was not touched');
  // And Sammie reconnecting does not touch Travis either.
  await consent(CURSOR_2);
  assert.equal((await live(SAMMIE)).length, before + 1);
  assert.equal((await live(TRAVIS)).length, 1);
});

await test('one person holds Claude and Cursor and Codex at once', async () => {
  await as(TRAVIS, CO_A);
  await consent(CLAUDE_1);
  await consent(CODEX_1);
  const rows = await live(TRAVIS);
  assert.deepEqual(rows.map((r) => r.app_key).sort(), [
    'claude|claude.ai', 'codex|127.0.0.1', 'cursor|localhost,www.cursor.com',
  ]);
});

await test('an ephemeral localhost port and a per-install path still dedupe', async () => {
  await as(TRAVIS, CO_A);
  await consent(CODEX_2);
  const rows = await live(TRAVIS);
  assert.equal(rows.filter((r) => r.app_key === 'codex|127.0.0.1').length, 1);
  assert.equal(rows.length, 3, 'Claude and Cursor are still there');
});

await test('a registration SILO cannot read dedupes nothing', async () => {
  await as(SAMMIE, CO_A);
  const before = (await live(SAMMIE)).length;
  // Deleted registration, and a client_id that is not a uuid at all.
  await consent(GONE);
  await consent('not-a-uuid');
  await consent(NAMELESS);
  const rows = await live(SAMMIE);
  assert.equal(rows.length, before + 3, 'each unreadable registration is its own connection');
  for (const r of rows.filter((x) => [GONE, 'not-a-uuid', NAMELESS].includes(x.client_id))) {
    assert.match(r.app_key, /^client:/);
  }
  // Repeating the SAME unreadable registration still replaces.
  await consent('not-a-uuid');
  assert.equal((await live(SAMMIE)).length, before + 3);
});

await test('the unique index refuses a second live row to any writer', async () => {
  const key = (await q(`select app_key from public.silo_api_grants
    where id = (select id from public.silo_api_grants where user_id = '${TRAVIS}'
                and revoked_at is null limit 1)`))[0].app_key;
  await assert.rejects(
    () => db.exec(`insert into public.silo_api_grants
      (client_id, app_key, user_id, company_entity_id, scopes)
      values ('${CURSOR_3}', '${key}', '${TRAVIS}', '${CO_A}', '{reports:read}')`),
    /silo_api_grants_one_live_app|duplicate key/);
});

await test('app_key is frozen', async () => {
  await assert.rejects(
    () => db.exec(`update public.silo_api_grants set app_key = 'cursor|evil.example'
                   where user_id = '${TRAVIS}' and revoked_at is null`),
    /cannot be changed/);
});

await test('silo_api_prior_company answers a reconnect under a new client_id', async () => {
  await as(TRAVIS, CO_A);
  // Travis's Cursor connection was last approved for company B, under a
  // client_id that is not the one the reconnect arrives with.
  const co = (await q(`select public.silo_api_prior_company('${CURSOR_1}') as co`))[0].co;
  assert.equal(co, CO_B);
  // It is scoped to the caller: Sammie's own history answers for Sammie.
  await as(SAMMIE, CO_A);
  assert.equal((await q(`select public.silo_api_prior_company('${CURSOR_3}') as co`))[0].co, CO_A);
  // No history at all: NULL, not an error and not somebody else's company.
  assert.equal((await q(`select public.silo_api_prior_company('${GROK}') as co`))[0].co, null);
});

await test('a connection can neither approve nor read a history', async () => {
  await as(TRAVIS, CO_A, { integration: true });
  await assert.rejects(() => db.exec(`select public.silo_api_consent('${CURSOR_1}')`),
    /integration_not_allowed/);
  await assert.rejects(() => db.exec(`select public.silo_api_prior_company('${CURSOR_1}')`),
    /integration_not_allowed/);
});

await test('consent still refuses a session that has not done two-factor', async () => {
  await as(TRAVIS, CO_A, { aal: 'aal1' });
  await assert.rejects(() => db.exec(`select public.silo_api_consent('${CURSOR_1}')`),
    /mfa_required/);
});

await test('consent still keeps its default scope argument', async () => {
  await as(TRAVIS, CO_A);
  const id = (await q(`select public.silo_api_consent('${CURSOR_1}') as id`))[0].id;
  const row = (await q(`select scopes from public.silo_api_grants where id = '${id}'`))[0];
  assert.deepEqual(row.scopes, ['reports:read']);
});

await test('silo_api_app_key is reachable by no client role', async () => {
  const rows = await q(`select
    has_function_privilege('authenticated', 'public.silo_api_app_key(text)', 'execute') as a,
    has_function_privilege('anon', 'public.silo_api_app_key(text)', 'execute') as b,
    has_function_privilege('silo_integration', 'public.silo_api_app_key(text)', 'execute') as c,
    has_function_privilege('silo_revoked', 'public.silo_api_app_key(text)', 'execute') as d,
    has_function_privilege('authenticated', 'public.silo_api_prior_company(text)', 'execute') as e,
    has_function_privilege('silo_integration', 'public.silo_api_prior_company(text)', 'execute') as f`);
  assert.deepEqual(rows[0], { a: false, b: false, c: false, d: false, e: true, f: false });
});

await test('the migration is idempotent', async () => {
  await as(TRAVIS, CO_A);
  const before = await live(TRAVIS);
  await db.exec(MIGRATION);
  assert.deepEqual(await live(TRAVIS), before);
});

console.log(`\n${passed} passed`);
