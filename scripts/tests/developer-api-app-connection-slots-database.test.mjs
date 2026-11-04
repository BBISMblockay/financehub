// Up to three live connections per person per application (20261104020000),
// executed in a real PostgreSQL (PGlite) with both migrations' own SQL.
//
// Proves:
//   * one person can hold three live Claude connections at once -- claude.ai
//     web, the desktop app and a phone all register the same name and the same
//     redirect host, so before this they evicted each other on every connect;
//   * the slots are 0, 1, 2 and the live grants that existed before the
//     migration land in slot 0;
//   * a fourth connect evicts the LEAST RECENTLY USED connection, never a more
//     recently used one;
//   * an authorization that never received a token (auth_session_id null and
//     last_used_at null) is revoked by the next consent, so abandoned
//     authorize attempts do not hold slots for 30 days;
//   * a connection whose token WAS issued but which has not run a tool yet
//     (auth_session_id set, last_used_at null) survives -- judging that row on
//     last_used_at alone would revoke a connection that works;
//   * the limit is per USER and per APPLICATION: someone else's Claude and the
//     same person's Cursor are untouched;
//   * the unique index refuses a duplicate live slot even to a writer that
//     bypasses silo_api_consent(), so the cap is in the schema;
//   * slot is frozen by the silo_api_grants_frozen trigger;
//   * silo_api_app_connection_limit() is not callable by a connection.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/developer-api-app-connection-slots-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const APP_KEY = readFileSync(
  'supabase/migrations/20261102180000_developer_api_one_connection_per_app.sql', 'utf8');
const SLOTS = readFileSync(
  'supabase/migrations/20261104020000_developer_api_app_connection_slots.sql', 'utf8');

const CO_A = '00000000-0000-4000-a000-00000000000a';
const BLAKE  = '00000000-0000-4000-b000-000000000001';
const SAMMIE = '00000000-0000-4000-b000-000000000002';

// One application, a fresh client registration per connect -- which is what
// claude.ai does every single time.
const CLAUDE = (n) => `00000000-0000-4000-c000-0000000000${String(10 + n).padStart(2, '0')}`;
const CURSOR_1 = '00000000-0000-4000-c000-000000000031';
const CURSOR_2 = '00000000-0000-4000-c000-000000000032';
const CURSOR_URIS = 'https://www.cursor.com/agents/mcp/oauth/callback,http://localhost:8787/callback';

// The grant that is already live when the migration runs.
const G_PRE = '00000000-0000-4000-d000-000000000001';

const claudeRows = Array.from({ length: 12 }, (_, i) =>
  `('${CLAUDE(i)}', 'Claude', 'https://claude.ai/api/mcp/auth_callback', null)`).join(',\n  ');

await db.exec(`
create schema auth;
create role anon;
create role authenticated;
create role silo_integration;
create role silo_revoked;
create role silo_api_exec;

create table auth.oauth_clients(
  id uuid primary key, client_name text, redirect_uris text, deleted_at timestamptz);
insert into auth.oauth_clients values
  ${claudeRows},
  ('${CURSOR_1}', 'Cursor', '${CURSOR_URIS}', null),
  ('${CURSOR_2}', 'Cursor', '${CURSOR_URIS}', null);

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
insert into public.entities values ('${CO_A}');
create table public.entity_memberships(user_id uuid, entity_id uuid, role text);
insert into public.entity_memberships values
  ('${BLAKE}', '${CO_A}', 'owner_admin'),
  ('${SAMMIE}', '${CO_A}', 'admin');

-- silo_api_grants as 20261020030000 leaves it.
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
  if new.client_id is distinct from old.client_id then
    raise exception 'silo_api_grant_frozen: a granted authorization cannot be changed; approve a new one'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;
create trigger silo_api_grants_frozen before update on public.silo_api_grants
  for each row execute function public.silo_api_grants_frozen();

-- Blake's one live Claude connection on the day before: used, so it is real.
insert into public.silo_api_grants
  (id, client_id, user_id, company_entity_id, auth_session_id, scopes,
   consented_at, last_used_at)
values
  ('${G_PRE}', '${CLAUDE(0)}', '${BLAKE}', '${CO_A}',
   '00000000-0000-4000-e000-000000000001', '{reports:read}',
   now() - interval '2 days', now() - interval '2 days');
`);

// Both migrations, DO-block guards and all, as `supabase db push` applies them.
await db.exec(APP_KEY);
await db.exec(SLOTS);

const as = async (user, opts = {}) => {
  await db.exec(`select set_config('test.sub', '${user}', false),
                        set_config('test.company', '${CO_A}', false),
                        set_config('test.aal', '${opts.aal || 'aal2'}', false),
                        set_config('test.integration', '${opts.integration ? 'on' : 'off'}', false)`);
};
const consent = async (clientId) =>
  (await q(`select public.silo_api_consent('${clientId}', array['reports:read','data:read']) as id`))[0].id;
const liveFor = async (user, appKey) => q(`select id, client_id, slot, generation
  from public.silo_api_grants
  where user_id = '${user}' and app_key = '${appKey}' and revoked_at is null
  order by slot`);
// A connection that has been handed a token and then used it, which is what
// makes it a real connection rather than an abandoned authorize attempt.
const useIt = async (id, ago) => db.exec(`update public.silo_api_grants
  set auth_session_id = coalesce(auth_session_id, gen_random_uuid()),
      last_used_at = now() - interval '${ago}'
  where id = '${id}'`);

const CLAUDE_KEY = 'claude|claude.ai';
const CURSOR_KEY = 'cursor|localhost,www.cursor.com';

await test('the grant that was already live sits in slot 0', async () => {
  const rows = await liveFor(BLAKE, CLAUDE_KEY);
  assert.deepEqual(rows.map((r) => [r.id, r.slot]), [[G_PRE, 0]]);
});

await test('the limit is three, in one place', async () => {
  const [{ n }] = await q('select public.silo_api_app_connection_limit() as n');
  assert.equal(n, 3);
});

await test('three live Claude connections at once, in slots 0, 1 and 2', async () => {
  await as(BLAKE);
  const second = await consent(CLAUDE(1));
  await useIt(second, '30 minutes');
  const third = await consent(CLAUDE(2));
  await useIt(third, '5 minutes');

  const rows = await liveFor(BLAKE, CLAUDE_KEY);
  assert.equal(rows.length, 3, 'web, desktop and phone coexist');
  assert.deepEqual(rows.map((r) => r.slot), [0, 1, 2]);
  assert.deepEqual(rows.map((r) => r.client_id).sort(),
    [CLAUDE(0), CLAUDE(1), CLAUDE(2)].sort());
});

await test('generation still counts every approval for the application', async () => {
  const rows = await q(`select max(generation) as g from public.silo_api_grants
    where user_id = '${BLAKE}' and app_key = '${CLAUDE_KEY}'`);
  assert.equal(rows[0].g, 3);
});

await test('a fourth connect evicts the least recently used, not a working one', async () => {
  await as(BLAKE);
  const fourth = await consent(CLAUDE(3));
  await useIt(fourth, '1 minute');

  const rows = await liveFor(BLAKE, CLAUDE_KEY);
  assert.equal(rows.length, 3, 'still three');
  const clients = rows.map((r) => r.client_id);
  // G_PRE was last used two days ago; the other two, minutes ago.
  assert.ok(!clients.includes(CLAUDE(0)), 'the two-day-old one went');
  assert.deepEqual(clients.sort(), [CLAUDE(1), CLAUDE(2), CLAUDE(3)].sort());
  const [{ revoked }] = await q(`select revoked_at is not null as revoked
    from public.silo_api_grants where id = '${G_PRE}'`);
  assert.equal(revoked, true);
  assert.equal(rows.find((r) => r.client_id === CLAUDE(3)).slot, 0,
    'the evicted connection\'s slot is reused');
});

await test('an authorization that never received a token is revoked by the next consent', async () => {
  // Claude registers, the person approves, and the exchange never happens --
  // three of Blake's seven consents on 2026-11-03 looked exactly like this.
  // Such a row holds a slot it cannot use, and the point of rule 1 is that the
  // NEXT connect reclaims that slot instead of evicting a working connection:
  // two abandoned attempts in a row cost one slot, not two.
  await as(BLAKE);
  const before = (await liveFor(BLAKE, CLAUDE_KEY)).map((r) => r.client_id);
  const abandoned = await consent(CLAUDE(4));   // evicts the LRU, then stalls
  const kept = (await liveFor(BLAKE, CLAUDE_KEY))
    .filter((r) => r.id !== abandoned).map((r) => r.client_id);
  assert.equal(kept.length, 2);

  const next = await consent(CLAUDE(5));
  const rows = await liveFor(BLAKE, CLAUDE_KEY);
  assert.equal(rows.length, 3);
  assert.ok(!rows.some((r) => r.id === abandoned), 'the unbound row went first');
  assert.ok(rows.some((r) => r.id === next));
  // Nothing that had actually been used was touched to make room this time.
  assert.deepEqual(rows.map((r) => r.client_id).filter((c) => c !== CLAUDE(5)).sort(),
    kept.sort());
  assert.ok(before.length === 3);
  await useIt(next, '2 minutes');
});

await test('a connection whose token was issued but which has not run a tool survives', async () => {
  // last_used_at is written on first DATA use, so a connection that has been
  // handed a token but has not run a tool yet reads NULL there and is still
  // somebody's working connection. Rule 1 must look at auth_session_id, not at
  // last_used_at. Tested on Cursor, which has a free slot, so rule 2 cannot
  // mask the answer.
  await as(BLAKE);
  const bound = await consent(CURSOR_1);
  await db.exec(`update public.silo_api_grants
    set auth_session_id = gen_random_uuid() where id = '${bound}'`);

  const fresh = await consent(CURSOR_2);
  const rows = await liveFor(BLAKE, CURSOR_KEY);
  assert.equal(rows.length, 2, 'the bound, not-yet-used connection survived');
  assert.deepEqual(rows.map((r) => [r.id, r.slot]), [[bound, 0], [fresh, 1]]);
});

await test('the limit is per person: nobody else\'s Claude is touched', async () => {
  await as(SAMMIE);
  const mine = await consent(CLAUDE(7));
  await useIt(mine, '1 minute');
  const rows = await liveFor(SAMMIE, CLAUDE_KEY);
  assert.deepEqual(rows.map((r) => [r.id, r.slot]), [[mine, 0]]);
  assert.equal((await liveFor(BLAKE, CLAUDE_KEY)).length, 3);
});

await test('the limit is per application: Cursor has its own slots', async () => {
  assert.equal((await liveFor(BLAKE, CURSOR_KEY)).length, 2);
  assert.equal((await liveFor(BLAKE, CLAUDE_KEY)).length, 3, 'Claude untouched');
});

await test('eviction ranks real use ahead of a newer consent', async () => {
  // The review-cycle-1 trap from #1095, now in the eviction path:
  // coalesce(last_used_at, consented_at) compares a never-used row's consent
  // time against another row's actual USE, so it keeps the connection nobody
  // has touched and permanently revokes the one that works.
  await as(SAMMIE);
  const old = (await liveFor(SAMMIE, CLAUDE_KEY))[0].id;   // used a minute ago
  await useIt(old, '2 days');
  const recent = await consent(CLAUDE(9));
  await useIt(recent, '1 minute');
  const unused = await consent(CLAUDE(10));                // consented newest
  await db.exec(`update public.silo_api_grants
    set auth_session_id = gen_random_uuid() where id = '${unused}'`);
  assert.equal((await liveFor(SAMMIE, CLAUDE_KEY)).length, 3);

  const fourth = await consent(CLAUDE(11));
  const ids = (await liveFor(SAMMIE, CLAUDE_KEY)).map((r) => r.id);
  assert.ok(!ids.includes(unused), 'the one nobody has used is what goes');
  assert.ok(ids.includes(old), 'a connection used two days ago still works');
  assert.deepEqual(ids.sort(), [old, recent, fourth].sort());
});

await test('an abandoned authorization is cleaned even when slots are free', async () => {
  // Rule 1 is not just the eviction order in disguise: an unbound row must go
  // when there is nothing to make room for. Otherwise a few stalled connects
  // fill a person's three slots with authorizations that no client holds, and
  // they sit there for the 30-day idle window.
  await as(SAMMIE);
  const stalled = await consent(CURSOR_1);
  const real = await consent(CURSOR_2);
  const rows = await liveFor(SAMMIE, CURSOR_KEY);
  assert.deepEqual(rows.map((r) => r.id), [real],
    'the stalled authorization did not keep a slot');
  assert.equal(rows[0].slot, 0, 'and its slot was reused, not skipped');
});

await test('the schema, not only the function, is what caps the number', async () => {
  const [{ slot }] = await q(`select slot from public.silo_api_grants
    where user_id = '${BLAKE}' and app_key = '${CLAUDE_KEY}' and revoked_at is null
    order by slot limit 1`);
  await assert.rejects(
    db.exec(`insert into public.silo_api_grants
      (client_id, app_key, slot, user_id, company_entity_id, scopes, consented_aal)
      values ('bypass-1', '${CLAUDE_KEY}', ${slot}, '${BLAKE}', '${CO_A}',
              '{reports:read}', 'aal2')`),
    /silo_api_grants_one_live_slot|duplicate key/);
});

await test('the old one-live-per-application index is gone', async () => {
  const rows = await q(`select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'silo_api_grants'
      and indexname in ('silo_api_grants_one_live_app', 'silo_api_grants_one_live_slot',
                        'silo_api_grants_one_live')
    order by indexname`);
  assert.deepEqual(rows.map((r) => r.indexname),
    ['silo_api_grants_one_live', 'silo_api_grants_one_live_slot']);
});

await test('slot is frozen', async () => {
  const [{ id }] = await q(`select id from public.silo_api_grants
    where user_id = '${BLAKE}' and app_key = '${CLAUDE_KEY}' and revoked_at is null
    order by slot limit 1`);
  await assert.rejects(
    db.exec(`update public.silo_api_grants set slot = 7 where id = '${id}'`),
    /silo_api_grant_frozen/);
});

await test('slot cannot be put outside the range the index can police', async () => {
  await assert.rejects(
    db.exec(`insert into public.silo_api_grants
      (client_id, app_key, slot, user_id, company_entity_id, scopes, consented_aal)
      values ('bypass-2', 'other|example.com', 42, '${BLAKE}', '${CO_A}',
              '{reports:read}', 'aal2')`),
    /silo_api_grants_slot_range/);
});

await test('a connection cannot read or raise the limit', async () => {
  for (const role of ['anon', 'silo_integration', 'silo_revoked']) {
    const [{ ok }] = await q(`select has_function_privilege('${role}',
      'public.silo_api_app_connection_limit()', 'execute') as ok`);
    assert.equal(ok, false, `${role} can call silo_api_app_connection_limit`);
  }
});

await test('a connection still cannot consent at all', async () => {
  await as(BLAKE, { integration: true });
  await assert.rejects(consent(CLAUDE(8)), /integration_not_allowed/);
});

await test('two-factor approval is still required', async () => {
  await as(BLAKE, { aal: 'aal1' });
  await assert.rejects(consent(CLAUDE(8)), /mfa_required/);
});

await test('the 90-day ceiling is still what consent writes', async () => {
  await as(BLAKE);
  const id = await consent(CLAUDE(8));
  const [{ days }] = await q(`select round(extract(epoch from (expires_at - consented_at))
    / 86400.0) as days from public.silo_api_grants where id = '${id}'`);
  assert.equal(Number(days), 90);
});

await test('the migration is idempotent', async () => {
  // apply_all_post_merge.sql re-runs every file. A second apply must not
  // renumber live connections -- the slots in use are the allocator's, not a
  // usage ranking, and the frozen trigger refuses a slot change outright.
  const before = await q(`select id, slot from public.silo_api_grants
    where revoked_at is null order by id`);
  await db.exec(SLOTS);
  const after = await q(`select id, slot from public.silo_api_grants
    where revoked_at is null order by id`);
  assert.deepEqual(after, before);
});

console.log(`\n${passed} tests passed`);
await db.close();
