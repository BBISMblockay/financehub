// scripts/tests/shopify-customers-consent-database.test.mjs
//
// Shopify customer marketing consent (20261124020000) on real PostgreSQL
// (PGlite), applied TWICE because apply_all_post_merge.sql re-runs every
// migration.
//
// What this proves:
//   A  the stored shape: a consent STATE is kept verbatim, the subscribed
//      booleans are derived from it, and an unmeasured state stays NULL in
//      both -- "not measured" is never "not subscribed"
//   B  the cross-store view picks a real consent EVENT: a measured unsubscribe
//      outranks a store that has no consent but was edited later, and the
//      state, its level, its date and the store that recorded it all come from
//      that one record
//   C  the rollup onto the past-customer lookup carries the same choice, is
//      idempotent, and matches on email only
//   D  a full refresh takes consent back OFF a profile whose email no longer
//      has a customer record (an email change or removal), and leaves the
//      order totals alone
//   E  one company never reads another's customers, and no browser role can
//      write the table or call the rollup
//
// Mutations (CI runs each and requires the suite to FAIL):
//   CONSENT_MUTATION=rls        RLS left off shopify_customers
//   CONSENT_MUTATION=company    the select policy drops the company filter
//   CONSENT_MUTATION=funcgrant  the rollup stays callable by the browser
//   CONSENT_MUTATION=clientwrite a browser role keeps Supabase's default write
//   CONSENT_MUTATION=coalesce   the view ranks on coalesce(consent, updated_at)
//
// Not a mutation, and worth saying why: taking the consent DATE from max()
// rather than from the chosen record is equivalent once a measured state
// outranks an unmeasured one, because the chosen record is then the measured
// one with the latest date. It was a real defect only under the coalesce
// ranking above, which `coalesce` covers. The date is read from the chosen
// record anyway, so the two can never disagree even if that ranking changes.
//   CONSENT_MUTATION=noclear    a full refresh leaves orphaned consent behind
//   CONSENT_MUTATION=boolean    an unmeasured state becomes "not subscribed"
//
// Run: node scripts/tests/shopify-customers-consent-database.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.CONSENT_MUTATION || '';
const db = new PGlite();

const CO_A = '11111111-1111-1111-1111-111111111111';
const CO_B = '22222222-2222-2222-2222-222222222222';

// `set local` only holds inside a transaction, so every role-scoped read runs
// in one and is rolled back after.
const asCompany = async (company, sql) => {
  await db.exec('begin');
  try {
    await db.exec(`set local test.company = '${company}'; set local role authenticated`);
    return await db.query(sql);
  } finally { await db.exec('rollback'); }
};

const refusedAs = async (role, company, sql) => {
  await db.exec('begin');
  try {
    await db.exec(`set local test.company = '${company}'; set local role ${role}`);
    await db.query(sql);
    return null;
  } catch (err) {
    return String(err?.message || err);
  } finally { await db.exec('rollback'); }
};

const countAs = async (role, company, sql) => {
  await db.exec('begin');
  try {
    await db.exec(`set local test.company = '${company}'; set local role ${role}`);
    return (await db.query(sql)).rows;
  } finally { await db.exec('rollback'); }
};

// ── fixtures: only what this feature reads, as production has it ────────────

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create table entities(id uuid primary key);
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function stamp_company_entity_id() returns trigger language plpgsql as
  $$ begin if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
     return new; end $$;
create function attach_stamp_company_entity_id_triggers() returns void language plpgsql as $$
declare t text; v_oid oid;
begin
  foreach t in array array['shopify_customers','company_customer_profiles'] loop
    v_oid := to_regclass('public.' || t);
    if v_oid is not null
       and not exists (select 1 from pg_trigger where tgrelid = v_oid and tgname = 'stamp_company_entity_id') then
      execute format('create trigger stamp_company_entity_id before insert on public.%I
                        for each row execute function public.stamp_company_entity_id()', t);
    end if;
  end loop;
end $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
create table shopify_connections(id uuid primary key default gen_random_uuid());
create table sync_jobs(
  id bigint generated by default as identity primary key,
  company_entity_id uuid, connection_id uuid, job_type text not null,
  status text not null default 'running', result jsonb);
-- The past-customer lookup as 20261123210000 leaves it (the columns this
-- feature touches). My migration ALTERs it, so it has to exist first.
create table company_customer_profiles(
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references entities(id) on delete cascade,
  customer_key text not null, customer_id text, email_lc text,
  name_lc text, order_count integer not null default 0,
  lifetime_spend numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (company_entity_id, customer_key));
insert into entities(id) values ('${CO_A}'), ('${CO_B}');
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated;
`);

let migration = await readFile(new URL('../../supabase/migrations/20261124020000_shopify_customer_marketing_consent.sql', import.meta.url), 'utf8');

if (MUT === 'rls') migration = migration.replace('alter table public.shopify_customers enable row level security;', '');
if (MUT === 'company') migration = migration.replace('using (company_entity_id = public.active_company_id())', 'using (true)');
if (MUT === 'funcgrant') migration = migration.replace(/revoke all on function public\.refresh_company_customer_consent[^;]*;/, '');
if (MUT === 'clientwrite') migration = migration.replace('revoke insert, update, delete on public.shopify_customers from authenticated;', '');
if (MUT === 'coalesce') {
  migration = migration.replaceAll('(c.email_consent_state is not null) desc, c.email_consent_updated_at desc nulls last, c.shopify_updated_at desc nulls last',
    'coalesce(c.email_consent_updated_at, c.shopify_updated_at) desc nulls last');
}
if (MUT === 'noclear') migration = migration.replace('if p_since is null then', 'if false then');
if (MUT === 'boolean') {
  migration = migration.replace('case when email_consent_state is null then null\n         else email_consent_state = \'subscribed\' end',
    "(coalesce(email_consent_state, 'not_subscribed') = 'subscribed')");
}

// Applied twice, like apply_all_post_merge.sql does.
await db.exec(migration);
await db.exec(migration);

// ── A. the stored shape ─────────────────────────────────────────────────────

await db.exec(`
insert into shopify_customers(company_entity_id, shop_domain, customer_id, email, email_consent_state, email_consent_opt_in_level, email_consent_updated_at, sms_consent_state, shopify_updated_at)
values ('${CO_A}', 'a.myshopify.com', '1', 'Yes@Example.com', 'subscribed', 'single_opt_in', '2026-06-01', 'not_subscribed', '2026-06-01'),
       ('${CO_A}', 'a.myshopify.com', '2', 'quiet@example.com', null, null, null, null, '2026-06-01');
`);

{
  const { rows } = await db.query(`select email_lc, email_consent_state, email_subscribed, sms_subscribed
                                     from shopify_customers where company_entity_id = '${CO_A}' order by customer_id`);
  assert.equal(rows[0].email_lc, 'yes@example.com', 'email_lc is generated and lowercased');
  assert.equal(rows[0].email_consent_state, 'subscribed');
  assert.equal(rows[0].email_subscribed, true);
  assert.equal(rows[0].sms_subscribed, false);
  assert.equal(rows[1].email_consent_state, null);
  assert.equal(rows[1].email_subscribed, null, 'not measured is NULL, never false');
  assert.equal(rows[1].sms_subscribed, null);
}

// ── B. the view picks one real consent event ────────────────────────────────

// Store A recorded an explicit unsubscribe on 1 January. Store B has no
// consent at all and was edited on 2 January. The unsubscribe is the fact
// about this person.
await db.exec(`
insert into shopify_customers(company_entity_id, shop_domain, customer_id, email, email_consent_state, email_consent_opt_in_level, email_consent_updated_at, shopify_updated_at)
values ('${CO_A}', 'a.myshopify.com', '10', 'both@example.com', 'unsubscribed', 'single_opt_in', '2026-01-01', '2026-01-01');
insert into shopify_customers(company_entity_id, shop_domain, customer_id, email, email_consent_state, email_consent_updated_at, shopify_updated_at)
values ('${CO_A}', 'b.myshopify.com', '11', 'both@example.com', null, null, '2026-01-02');
`);

{
  const { rows } = await asCompany(CO_A, `select email_consent_state, email_consent_opt_in_level, email_consent_updated_at, consent_shop_domain, store_records
                                            from shopify_customer_consent_v where email_lc = 'both@example.com'`);
  assert.equal(rows.length, 1, 'one row per person per company');
  assert.equal(rows[0].email_consent_state, 'unsubscribed',
    'a measured consent outranks a store that has none but was edited later');
  assert.equal(rows[0].email_consent_opt_in_level, 'single_opt_in');
  assert.equal(rows[0].consent_shop_domain, 'a.myshopify.com',
    'the store named is the one that recorded the consent that is shown');
  assert.equal(new Date(rows[0].email_consent_updated_at).toISOString().slice(0, 10), '2026-01-01',
    'the date belongs to the same record as the state');
  assert.equal(rows[0].store_records, 2);
}

// A later measured event does win.
await db.exec(`
update shopify_customers set email_consent_state = 'subscribed', email_consent_updated_at = '2026-03-01', shopify_updated_at = '2026-03-01'
 where company_entity_id = '${CO_A}' and shop_domain = 'b.myshopify.com' and customer_id = '11';
`);
{
  const { rows } = await asCompany(CO_A, `select email_consent_state, consent_shop_domain from shopify_customer_consent_v where email_lc = 'both@example.com'`);
  assert.equal(rows[0].email_consent_state, 'subscribed');
  assert.equal(rows[0].consent_shop_domain, 'b.myshopify.com');
}

// ── C. the rollup onto the lookup ───────────────────────────────────────────

await db.exec(`
insert into company_customer_profiles(company_entity_id, customer_key, email_lc, order_count, lifetime_spend)
values ('${CO_A}', 'both@example.com', 'both@example.com', 3, 120),
       ('${CO_A}', 'quiet@example.com', 'quiet@example.com', 1, 40),
       ('${CO_A}', 'cid:999', null, 1, 10);
`);

{
  const { rows } = await db.query(`select public.refresh_company_customer_consent('${CO_A}') as r`);
  assert.ok(rows[0].r.profiles_updated >= 1);

  const { rows: profiles } = await db.query(`select customer_key, email_consent_state, consent_updated_at, consent_checked_at, order_count
                                               from company_customer_profiles where company_entity_id = '${CO_A}' order by customer_key`);
  const byKey = Object.fromEntries(profiles.map((p) => [p.customer_key, p]));
  assert.equal(byKey['both@example.com'].email_consent_state, 'subscribed');
  assert.equal(byKey['both@example.com'].order_count, 3, 'the rollup never touches order totals');
  assert.equal(byKey['quiet@example.com'].email_consent_state, null, 'a customer with no measured consent stays NULL');
  assert.ok(byKey['quiet@example.com'].consent_checked_at, 'and is recorded as having been looked at');
  assert.equal(byKey['cid:999'].email_consent_state, null, 'a profile with no email cannot be matched at all');
}

// Idempotent: a second refresh changes nothing.
{
  const before = (await db.query(`select customer_key, email_consent_state, consent_updated_at from company_customer_profiles where company_entity_id = '${CO_A}' order by customer_key`)).rows;
  const { rows } = await db.query(`select public.refresh_company_customer_consent('${CO_A}') as r`);
  assert.equal(rows[0].r.profiles_updated, 0, 'nothing changed, so nothing is rewritten');
  const after = (await db.query(`select customer_key, email_consent_state, consent_updated_at from company_customer_profiles where company_entity_id = '${CO_A}' order by customer_key`)).rows;
  assert.deepEqual(after, before);
}

// ── D. an email that no longer has a customer record ────────────────────────

// The person changed their email. Their orders -- and so their old profile
// row -- keep the old address, which the join can never reach again.
await db.exec(`
update shopify_customers set email = 'moved@example.com'
 where company_entity_id = '${CO_A}' and email_lc = 'both@example.com';
`);

{
  const { rows } = await db.query(`select public.refresh_company_customer_consent('${CO_A}') as r`);
  assert.equal(rows[0].r.profiles_cleared, 1, 'the orphaned profile is reconciled on a full refresh');

  const { rows: p } = await db.query(`select email_consent_state, sms_consent_state, consent_updated_at, consent_checked_at, order_count, lifetime_spend
                                        from company_customer_profiles
                                       where company_entity_id = '${CO_A}' and customer_key = 'both@example.com'`);
  assert.equal(p[0].email_consent_state, null, 'consent nobody can confirm any more goes back to not measured');
  assert.equal(p[0].sms_consent_state, null);
  assert.equal(p[0].consent_updated_at, null);
  assert.ok(p[0].consent_checked_at);
  assert.equal(p[0].order_count, 3, 'order history is untouched');
  assert.equal(Number(p[0].lifetime_spend), 120);
}

// An INCREMENTAL refresh does not clear: it has not looked at every customer.
await db.exec(`
update company_customer_profiles set email_consent_state = 'subscribed'
 where company_entity_id = '${CO_A}' and customer_key = 'both@example.com';
`);
{
  await db.query(`select public.refresh_company_customer_consent('${CO_A}', now() - interval '1 hour')`);
  const { rows } = await db.query(`select email_consent_state from company_customer_profiles
                                    where company_entity_id = '${CO_A}' and customer_key = 'both@example.com'`);
  assert.equal(rows[0].email_consent_state, 'subscribed',
    'a windowed refresh must not blank what it did not look at');
}

// ── E. tenancy and grants ───────────────────────────────────────────────────

await db.exec(`
insert into shopify_customers(company_entity_id, shop_domain, customer_id, email, email_consent_state, shopify_updated_at)
values ('${CO_B}', 'c.myshopify.com', '50', 'other@example.com', 'subscribed', '2026-06-01');
`);

{
  const { rows } = await asCompany(CO_A, 'select count(*)::int as n from shopify_customers');
  assert.equal(rows[0].n, 4, "a company reads only its own customers");

  const { rows: viewRows } = await asCompany(CO_A, `select count(*)::int as n from shopify_customer_consent_v where email_lc = 'other@example.com'`);
  assert.equal(viewRows[0].n, 0, 'and the view is security_invoker, so RLS applies through it');
}

{
  const writeErr = await refusedAs('authenticated', CO_A,
    `insert into shopify_customers(company_entity_id, shop_domain, customer_id) values ('${CO_A}', 'a.myshopify.com', '999')`);
  assert.match(String(writeErr), /permission denied|row-level security/i, 'only the sync writes this table');

  const rpcErr = await refusedAs('authenticated', CO_A, `select public.refresh_company_customer_consent('${CO_A}')`);
  assert.match(String(rpcErr), /permission denied/i, 'the rollup is not callable from a browser');

  // RLS already refuses that insert, so the revoke is defence in depth -- and
  // it has to be asserted on its own or it can be deleted without any test
  // noticing (which is how this check earned its place).
  const { rows: priv } = await db.query(`select
      has_table_privilege('authenticated', 'public.shopify_customers', 'insert') as ins,
      has_table_privilege('authenticated', 'public.shopify_customers', 'update') as upd,
      has_table_privilege('authenticated', 'public.shopify_customers', 'delete') as del,
      has_table_privilege('authenticated', 'public.shopify_customers', 'select') as sel`);
  assert.equal(priv[0].ins, false, 'no browser-role INSERT privilege');
  assert.equal(priv[0].upd, false, 'no browser-role UPDATE privilege');
  assert.equal(priv[0].del, false, 'no browser-role DELETE privilege');
  assert.equal(priv[0].sel, true, 'reads go through the policy');
}

// anon keeps no default read either.
{
  const rows = await countAs('anon', CO_A, 'select count(*)::int as n from shopify_customers');
  assert.equal(rows[0].n, 0, 'anon reads nothing: the policy is granted to authenticated only');
}

console.log(MUT ? `shopify-customers-consent-database: PASSED under mutation ${MUT} (it should not)` : 'shopify-customers-consent-database: all checks passed');
