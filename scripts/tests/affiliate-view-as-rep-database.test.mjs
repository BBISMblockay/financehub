// scripts/tests/affiliate-view-as-rep-database.test.mjs
//
// View as rep (20261125030000) on real PostgreSQL (PGlite), applied TWICE
// because apply_all_post_merge.sql re-runs every migration.
//
// What this proves:
//   A  a manager of the program mints a one-hour 'preview' link for one
//      signed-up affiliate of their active company; only the hash is stored
//   B  it is refused for another company's affiliate, without program
//      management, for someone not signed up or ended, for a hash that is not
//      a sha-256, and with no signed-in user
//   C  anon cannot mint one; authenticated can
//   D  the four portal READS accept a preview link; a portal WRITE still
//      demands purpose 'portal' and refuses it
//   E  the rewrite of the reads is idempotent (a second apply changes nothing)
//
// Mutations (CI runs each and requires the suite to FAIL):
//   PREVIEW_DB_MUTATION=anongrant  anon keeps Supabase's default EXECUTE
//   PREVIEW_DB_MUTATION=nomanage   the program-management check is dropped
//   PREVIEW_DB_MUTATION=anyco      the affiliate is looked up in any company
//   PREVIEW_DB_MUTATION=unsigned   an affiliate who never signed up can be previewed
//   PREVIEW_DB_MUTATION=noread     the portal reads are not widened

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.PREVIEW_DB_MUTATION || '';
const db = new PGlite();

const CO_A = '11111111-1111-1111-1111-111111111111';
const CO_B = '22222222-2222-2222-2222-222222222222';
const PROG_A = '33333333-3333-3333-3333-333333333333';
const PROG_B = '44444444-4444-4444-4444-444444444444';
const AFF = '55555555-5555-5555-5555-555555555555';
const AFF_B = '66666666-6666-6666-6666-666666666666';
const AFF_NEW = '77777777-7777-7777-7777-777777777777';
const AFF_END = '88888888-8888-8888-8888-888888888888';
const AFF_NOTERMS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF = '99999999-9999-9999-9999-999999999999';
const HASH = 'a'.repeat(64);

// Fixtures: the helpers and tables the migration touches, as production has
// them (only the columns it reads), and one portal read and write each in the
// shape production's carry.
const readFn = (name) => `
create function ${name}(p_token_hash text) returns uuid language sql security definer set search_path = public as $$
  select t.affiliate_id from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null and t.expires_at > now() $$;`;
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function can_manage_affiliate_program(p_program uuid) returns boolean language sql as
  $$ select coalesce(current_setting('test.manage', true), '') = p_program::text $$;
create table affiliates(id uuid primary key, company_entity_id uuid not null, program_id uuid not null,
  status text not null, terms_accepted_at timestamptz);
create table affiliate_access_tokens(
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, program_id uuid not null,
  affiliate_id uuid, prospect_id uuid,
  purpose text not null check (purpose in ('signup','portal')),
  token_hash text not null unique, created_at timestamptz not null default now(), created_by uuid,
  expires_at timestamptz not null, first_used_at timestamptz, last_used_at timestamptz,
  used_count integer not null default 0, revoked_at timestamptz);
${readFn('affiliate_portal_content')}
${readFn('affiliate_portal_feed')}
${readFn('affiliate_portal_orders')}
${readFn('affiliate_portal_seeds')}
${readFn('affiliate_portal_claim')}
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated;
insert into affiliates values
  ('${AFF}', '${CO_A}', '${PROG_A}', 'active', now()),
  ('${AFF_B}', '${CO_B}', '${PROG_B}', 'active', now()),
  ('${AFF_NEW}', '${CO_A}', '${PROG_A}', 'invited', null),
  ('${AFF_END}', '${CO_A}', '${PROG_A}', 'terminated', now()),
  ('${AFF_NOTERMS}', '${CO_A}', '${PROG_A}', 'active', null);
`);

let sql = await readFile(new URL('../../supabase/migrations/20261125030000_affiliate_view_as_rep.sql', import.meta.url), 'utf8');
function mutate(from, to) {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`);
  sql = sql.split(from).join(to);
}
switch (MUT) {
  case '': break;
  case 'anongrant': mutate('revoke all on function public.affiliate_issue_preview_token(uuid, text) from public, anon;', ''); break;
  case 'nomanage': mutate('  if not found or not public.can_manage_affiliate_program(v_a.program_id) then', '  if not found then'); break;
  case 'anyco': mutate('   where a.id = p_affiliate_id and a.company_entity_id = v_co;', '   where a.id = p_affiliate_id;'); break;
  case 'unsigned': mutate(" or v_a.terms_accepted_at is null then", ' then'); break;
  case 'noread': mutate("    execute replace(def, old_p, new_p);\n", ''); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}

await db.exec(sql);
const firstReads = (await db.query(`select string_agg(pg_get_functiondef(p.oid), '' order by p.proname) d from pg_proc p
  where p.proname in ('affiliate_portal_content','affiliate_portal_feed','affiliate_portal_orders','affiliate_portal_seeds')`)).rows[0].d;
await db.exec(sql);   // apply_all re-runs it

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}
async function as(role, { uid = STAFF, company = CO_A, manage = PROG_A } = {}, fn) {
  await db.exec(`set test.uid = '${uid || ''}'; set test.company = '${company || ''}'; set test.manage = '${manage || ''}'; set role ${role};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const mint = async (aff, hash = HASH) => (await db.query('select public.affiliate_issue_preview_token($1, $2) as e', [aff, hash])).rows[0].e;
const refused = async (fn) => { try { await fn(); return false; } catch { return true; } };

await test('A: a program manager mints a one-hour preview of a signed-up affiliate, hash only', async () => {
  const exp = await as('authenticated', {}, () => mint(AFF));
  const mins = (new Date(exp).getTime() - Date.now()) / 60000;
  assert.ok(mins > 55 && mins <= 61, `expires in about an hour (${mins})`);
  const row = (await db.query('select * from affiliate_access_tokens where token_hash = $1', [HASH])).rows[0];
  assert.equal(row.purpose, 'preview');
  assert.equal(row.affiliate_id, AFF);
  assert.equal(row.company_entity_id, CO_A);
  assert.equal(row.created_by, STAFF);
});

await test('B: refused for another company, no management, not signed up, ended, a bad hash, nobody signed in', async () => {
  const h = (c) => c.repeat(64);
  // Managing the other program too, so only the company filter refuses it.
  assert.ok(await as('authenticated', { manage: PROG_B }, () => refused(() => mint(AFF_B, h('b')))), 'another company\'s affiliate');
  assert.ok(await as('authenticated', { manage: PROG_B }, () => refused(() => mint(AFF, h('c')))), 'without managing the program');
  assert.ok(await as('authenticated', {}, () => refused(() => mint(AFF_NEW, h('d')))), 'someone invited, not yet active');
  // Active but no terms on file, so only the signed-up check refuses it.
  assert.ok(await as('authenticated', {}, () => refused(() => mint(AFF_NOTERMS, h('9')))), 'someone who never signed the terms');
  assert.ok(await as('authenticated', {}, () => refused(() => mint(AFF_END, h('e')))), 'an ended affiliate');
  assert.ok(await as('authenticated', {}, () => refused(() => mint(AFF, 'not-a-hash'))), 'a hash that is not a sha-256');
  assert.ok(await as('authenticated', { uid: null }, () => refused(() => mint(AFF, h('f')))), 'nobody signed in');
  const n = (await db.query("select count(*)::int n from affiliate_access_tokens where purpose = 'preview'")).rows[0].n;
  assert.equal(n, 1, 'no refused call left a row');
});

await test('C: anon cannot mint a preview; authenticated can', async () => {
  const r = (await db.query(`select has_function_privilege('anon', 'public.affiliate_issue_preview_token(uuid,text)', 'execute') a,
    has_function_privilege('authenticated', 'public.affiliate_issue_preview_token(uuid,text)', 'execute') b`)).rows[0];
  assert.equal(r.a, false, 'anon');
  assert.equal(r.b, true, 'authenticated');
});

await test('D: the portal reads accept a preview link; a portal write still refuses it', async () => {
  for (const fn of ['affiliate_portal_content', 'affiliate_portal_feed', 'affiliate_portal_orders', 'affiliate_portal_seeds']) {
    const got = (await db.query(`select public.${fn}($1) as a`, [HASH])).rows[0].a;
    assert.equal(got, AFF, `${fn} reads for a preview`);
  }
  const claim = (await db.query('select public.affiliate_portal_claim($1) as a', [HASH])).rows[0].a;
  assert.equal(claim, null, 'a write function finds no portal link');
});

await test('E: applying again changes nothing', async () => {
  const again = (await db.query(`select string_agg(pg_get_functiondef(p.oid), '' order by p.proname) d from pg_proc p
    where p.proname in ('affiliate_portal_content','affiliate_portal_feed','affiliate_portal_orders','affiliate_portal_seeds')`)).rows[0].d;
  assert.equal(again, firstReads);
  const checks = (await db.query(`select count(*)::int n from pg_constraint where conrelid = 'affiliate_access_tokens'::regclass
    and contype = 'c' and pg_get_constraintdef(oid) ilike '%purpose%'`)).rows[0].n;
  assert.equal(checks, 1, 'one purpose check');
});

console.log(`\naffiliate-view-as-rep-database: ${passed} passed`);
