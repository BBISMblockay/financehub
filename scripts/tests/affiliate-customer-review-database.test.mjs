// scripts/tests/affiliate-customer-review-database.test.mjs
//
// Customer find decisions (20261125210000) on real PostgreSQL (PGlite),
// applied TWICE because apply_all_post_merge.sql re-runs every migration.
//
// What this proves:
//   A  a Studio manager marks finds Not a fit / Shortlisted / Do not contact,
//      by customer_key, in the ACTIVE company only; anyone else is refused
//   B  Restore (NULL) undoes Not a fit only; Do not contact is final here
//   C  bad decisions, no active company and too many keys are refused
//   D  the backfill: a find already added to a program is Shortlisted, one on
//      the do-not-contact list by email is Archive, other companies untouched
//   E  grants: anon cannot call it
//
// Mutations (CI runs each and requires the suite to FAIL):
//   CUST_REVIEW_DB_MUTATION=anongrant    anon keeps Supabase's default EXECUTE
//   CUST_REVIEW_DB_MUTATION=nomanager    the Studio manager gate is dropped
//   CUST_REVIEW_DB_MUTATION=nocompany    the active-company filter is dropped
//   CUST_REVIEW_DB_MUTATION=restoreall   Restore also undoes Shortlisted / Do not contact
//   CUST_REVIEW_DB_MUTATION=nobackfill   the backfill of finds already in a program is dropped

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.CUST_REVIEW_DB_MUTATION || '';
const db = new PGlite();

const CO_A = '11111111-1111-1111-1111-111111111111';
const CO_B = '22222222-2222-2222-2222-222222222222';
const MGR = '99999999-9999-9999-9999-999999999999';

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function can_manage_affiliate_programs() returns boolean language sql as
  $$ select coalesce(current_setting('test.mgr', true), '') = 'yes' $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
create table affiliate_customer_social(
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, customer_key text not null,
  email_lc text, status text not null, unique (company_entity_id, customer_key));
create table affiliate_prospects(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  source text, contact_email text);
create table affiliate_suppressions(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  kind text, value_normalized text);
alter table affiliate_customer_social enable row level security;
create policy affiliate_customer_social_select on affiliate_customer_social for select using (company_entity_id = active_company_id());
grant select on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
insert into affiliate_customer_social (company_entity_id, customer_key, email_lc, status) values
  ('${CO_A}', 'a1', 'a1@x.test', 'found'), ('${CO_A}', 'a2', 'a2@x.test', 'found'), ('${CO_A}', 'a3', 'a3@x.test', 'below'),
  ('${CO_A}', 'added', 'added@x.test', 'found'), ('${CO_A}', 'dnc', 'dnc@x.test', 'found'),
  ('${CO_B}', 'a1', 'a1@x.test', 'found'), ('${CO_B}', 'added', 'added@x.test', 'found');
insert into affiliate_prospects (company_entity_id, source, contact_email) values
  ('${CO_A}', 'customer', 'Added@x.test'), ('${CO_A}', 'serp', 'a2@x.test');
insert into affiliate_suppressions (company_entity_id, kind, value_normalized) values
  ('${CO_A}', 'email', 'DNC@x.test'), ('${CO_A}', 'domain', 'x.test');
`);

let sql = await readFile(new URL('../../supabase/migrations/20261125210000_affiliate_customer_review.sql', import.meta.url), 'utf8');
function mutate(from, to) {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`);
  sql = sql.split(from).join(to);
}
switch (MUT) {
  case '': break;
  case 'anongrant': mutate('revoke all on function public.affiliate_customer_social_review(text[], text) from anon;', ''); break;
  case 'nomanager': mutate('if not public.can_manage_affiliate_programs() then', 'if false then'); break;
  case 'nocompany': mutate('where company_entity_id = v_co and customer_key = any(p_keys) and review = \'not_fit\';', 'where customer_key = any(p_keys) and review = \'not_fit\';');
    mutate("where company_entity_id = v_co and customer_key = any(p_keys)\n        and review is distinct from p_review", "where customer_key = any(p_keys)\n        and review is distinct from p_review"); break;
  case 'restoreall': mutate("and review = 'not_fit';", 'and review is not null;'); break;
  case 'nobackfill': mutate("  set review = 'shortlisted', reviewed_at = now()\n  where s.review is null", "  set review = 'shortlisted', reviewed_at = now()\n  where false and s.review is null"); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}
await db.exec(sql);
await db.exec(sql);   // apply_all re-runs it

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}
async function as(role, { uid = MGR, company = CO_A, mgr = true } = {}, fn) {
  await db.exec(`set test.uid = '${uid || ''}'; set test.company = '${company || ''}'; set test.mgr = '${mgr ? 'yes' : 'no'}'; set role ${role};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const refused = async (fn) => { try { await fn(); return false; } catch { return true; } };
const review = (keys, r) => db.query('select public.affiliate_customer_social_review($1::text[], $2) as n', [keys, r]);
const state = async (co, key) => (await db.query(`select review, reviewed_by from affiliate_customer_social where company_entity_id = '${co}' and customer_key = '${key}'`)).rows[0];

await test('D: the backfill shortlists finds already in a program and archives do-not-contact emails, per company', async () => {
  assert.equal((await state(CO_A, 'added')).review, 'shortlisted', 'added as a customer prospect, any letter case');
  assert.equal((await state(CO_A, 'a2')).review, null, 'a creator prospect with the same email is not a customer add');
  assert.equal((await state(CO_A, 'dnc')).review, 'suppressed', 'on the list by email');
  assert.equal((await state(CO_A, 'a1')).review, null, 'a domain entry alone does not archive (the page still hides them from outreach)');
  assert.equal((await state(CO_B, 'added')).review, null, 'another company is untouched');
});

await test('A: a Studio manager decides finds in the active company only; anyone else is refused', async () => {
  const n = (await as('authenticated', {}, () => review(['a1', 'a3'], 'not_fit'))).rows[0].n;
  assert.equal(n, 2);
  assert.equal((await state(CO_A, 'a1')).review, 'not_fit');
  assert.equal((await state(CO_A, 'a1')).reviewed_by, MGR, 'who decided is kept');
  assert.equal((await state(CO_B, 'a1')).review, null, 'the same customer_key in another company is untouched');
  assert.ok(await as('authenticated', { mgr: false }, () => refused(() => review(['a2'], 'not_fit'))), 'not a Studio manager');
  assert.equal((await state(CO_A, 'a2')).review, null);
  assert.equal((await as('authenticated', {}, () => review(['a2'], 'shortlisted'))).rows[0].n, 1);
  assert.equal((await state(CO_A, 'a2')).review, 'shortlisted');
});

await test('B: Restore undoes Not a fit only; Do not contact is final here', async () => {
  assert.equal((await as('authenticated', {}, () => review(['a1', 'a2', 'dnc'], null))).rows[0].n, 1, 'only the Not a fit one');
  assert.equal((await state(CO_A, 'a1')).review, null);
  assert.equal((await state(CO_A, 'a2')).review, 'shortlisted', 'Shortlisted stays');
  assert.equal((await state(CO_A, 'dnc')).review, 'suppressed', 'Do not contact stays');
  assert.equal((await as('authenticated', {}, () => review(['dnc'], 'not_fit'))).rows[0].n, 0, 'a decision cannot overwrite Do not contact');
  assert.equal((await state(CO_A, 'dnc')).review, 'suppressed');
});

await test('C: bad decisions, no active company and too many keys are refused', async () => {
  assert.ok(await as('authenticated', {}, () => refused(() => review(['a1'], 'maybe'))), 'unknown decision');
  assert.ok(await as('authenticated', { company: null }, () => refused(() => review(['a1'], 'not_fit'))), 'no active company');
  const many = Array.from({ length: 1001 }, (_, i) => `k${i}`);
  assert.ok(await as('authenticated', {}, () => refused(() => review(many, 'not_fit'))), 'over 1000 keys');
  assert.equal((await as('authenticated', {}, () => review([], 'not_fit'))).rows[0].n, 0, 'nothing ticked is a no-op');
});

await test('E: anon cannot call it, and the table stays read-only to the browser', async () => {
  const r = await db.query("select has_function_privilege('anon', 'public.affiliate_customer_social_review(text[],text)', 'execute') as a, has_function_privilege('authenticated', 'public.affiliate_customer_social_review(text[],text)', 'execute') as b");
  assert.equal(r.rows[0].a, false, 'anon');
  assert.equal(r.rows[0].b, true, 'a signed-in user calls it (the manager gate decides)');
  assert.ok(await as('authenticated', {}, () => refused(() => db.query(`update affiliate_customer_social set review = 'not_fit'`))), 'no direct update');
});

console.log(`\naffiliate-customer-review-database: ${passed} passed`);
