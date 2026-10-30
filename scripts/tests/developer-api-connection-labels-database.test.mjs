// Connect AI connection labels (20261030190000), executed in a real
// PostgreSQL (PGlite) with the migration's own function.
//
// Proves: an owner_admin sees the application name and the approver for every
// connection in their company; anyone else sees labels only for their own;
// a grant from another company, or an unknown id, is absent rather than an
// error; a connection (integration role) and an unsigned caller are refused;
// the grants are what the migration's own DO block asserts.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/developer-api-connection-labels-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const MIGRATION = readFileSync('supabase/migrations/20261030190000_developer_api_connection_labels.sql', 'utf8');

const A = '00000000-0000-4000-a000-00000000000a';
const B = '00000000-0000-4000-a000-00000000000b';
const OWNER = '00000000-0000-4000-b000-000000000001';
const MEMBER = '00000000-0000-4000-b000-000000000002';
const OUTSIDER = '00000000-0000-4000-b000-000000000003';
const CHATGPT = '8d035da1-5a5d-4cc2-9193-b2fe630c4ab2';
const CLAUDE = 'e4dd11cd-836d-4e54-a8e1-7c63adc3f02a';
const G_OWNER = '00000000-0000-4000-c000-000000000001';
const G_MEMBER = '00000000-0000-4000-c000-000000000002';
const G_OTHER_CO = '00000000-0000-4000-c000-000000000003';
const G_UNNAMED = '00000000-0000-4000-c000-000000000004';

await db.exec(`
create schema auth;
create role silo_integration;
create role silo_revoked;
create role anon;
create role authenticated;
create function public.silo_api_claims() returns jsonb language sql stable as $$
  select jsonb_build_object('sub', nullif(current_setting('test.sub', true), '')) $$;
create function public.silo_api_is_integration() returns boolean language sql stable as $$
  select current_setting('test.integration', true) = 'on' $$;

create table auth.oauth_clients(id uuid primary key, client_name text);
insert into auth.oauth_clients values ('${CHATGPT}', 'ChatGPT'), ('${CLAUDE}', 'Claude');

create table public.profiles(id uuid primary key, name text, email text);
insert into public.profiles values
  ('${OWNER}', 'Blake Owner', 'owner@example.com'),
  ('${MEMBER}', '  ', 'member@example.com'),
  ('${OUTSIDER}', 'Outsider', 'out@example.com');
create table public.entity_memberships(user_id uuid, entity_id uuid, role text);
insert into public.entity_memberships values
  ('${OWNER}', '${A}', 'owner_admin'),
  ('${MEMBER}', '${A}', 'admin'),
  ('${OUTSIDER}', '${B}', 'owner_admin');
create table public.silo_api_grants(id uuid primary key, client_id text, user_id uuid, company_entity_id uuid);
insert into public.silo_api_grants values
  ('${G_OWNER}',    '${CLAUDE}',  '${OWNER}',    '${A}'),
  ('${G_MEMBER}',   '${CHATGPT}', '${MEMBER}',   '${A}'),
  ('${G_OTHER_CO}', '${CHATGPT}', '${OUTSIDER}', '${B}'),
  ('${G_UNNAMED}',  'not-a-uuid', '${MEMBER}',   '${A}');
`);
await db.exec(MIGRATION);

const ALL = `array['${G_OWNER}','${G_MEMBER}','${G_OTHER_CO}','${G_UNNAMED}','00000000-0000-4000-c000-0000000000ff']::uuid[]`;
const labels = async (sub, ids = ALL, integration = false) => {
  await db.exec(`begin; set local test.sub = '${sub}'; set local test.integration = '${integration ? 'on' : 'off'}'; set local role authenticated`);
  try {
    const r = await q(`select * from public.silo_api_connection_labels(${ids}) order by grant_id`);
    await db.exec('commit'); return r;
  } catch (e) { await db.exec('rollback'); throw e; }
};

await test('an owner_admin sees every connection in their company, named, with who approved it', async () => {
  const r = await labels(OWNER);
  assert.deepEqual(r.map((x) => x.grant_id), [G_OWNER, G_MEMBER, G_UNNAMED]);
  const m = r.find((x) => x.grant_id === G_MEMBER);
  assert.equal(m.client_name, 'ChatGPT');
  assert.equal(m.approver_name, null, 'a blank name is null, so the page falls back to the email');
  assert.equal(m.approver_email, 'member@example.com');
  assert.equal(r.find((x) => x.grant_id === G_OWNER).approver_name, 'Blake Owner');
  assert.equal(r.find((x) => x.grant_id === G_UNNAMED).client_name, null, 'no client row: no invented name');
});

await test('another company\'s connection and an unknown id are absent, not an error', async () => {
  const r = await labels(OWNER);
  assert.ok(!r.some((x) => x.grant_id === G_OTHER_CO));
  assert.ok(!r.some((x) => x.grant_id.endsWith('0000000000ff')));
});

await test('a member who is not owner_admin sees only their own connections', async () => {
  const r = await labels(MEMBER);
  assert.deepEqual(r.map((x) => x.grant_id), [G_MEMBER, G_UNNAMED]);
});

await test('owner_admin of another company sees only their own company', async () => {
  const r = await labels(OUTSIDER);
  assert.deepEqual(r.map((x) => x.grant_id), [G_OTHER_CO]);
});

await test('a connection and an unsigned caller are refused', async () => {
  await assert.rejects(labels(OWNER, ALL, true), /integration_not_allowed/);
  await assert.rejects(labels(''), /not_authenticated/);
});

await test('empty asks return nothing; an oversized one is refused', async () => {
  assert.deepEqual(await labels(OWNER, `array[]::uuid[]`), []);
  assert.deepEqual(await labels(OWNER, `null::uuid[]`), []);
  await assert.rejects(labels(OWNER, `array(select gen_random_uuid() from generate_series(1, 501))`), /too_many/);
});

await test('grants: authenticated may call it; anon, integration and revoked may not', async () => {
  const r = (await q(`select
      has_function_privilege('authenticated', 'public.silo_api_connection_labels(uuid[])', 'execute') a,
      has_function_privilege('anon', 'public.silo_api_connection_labels(uuid[])', 'execute') n,
      has_function_privilege('silo_integration', 'public.silo_api_connection_labels(uuid[])', 'execute') i,
      has_function_privilege('silo_revoked', 'public.silo_api_connection_labels(uuid[])', 'execute') v`))[0];
  assert.deepEqual(r, { a: true, n: false, i: false, v: false });
});

await test('the migration is idempotent', async () => {
  await db.exec(MIGRATION);
  assert.equal((await labels(OWNER)).length, 3);
});

console.log(`\n${passed} passed`);
