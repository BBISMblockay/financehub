// scripts/tests/affiliate-customer-guards-database.test.mjs
//
// 20261125233000 on real PostgreSQL (PGlite), applied twice the way
// apply_all_post_merge.sql re-runs it. The two sweeps it calls are taken
// verbatim from their own migrations, so this runs the real ones.
//
// What this proves:
//   A  the customer-find references get same-company twins, and a row
//      pointing at another company's program or scan is refused
//   B  both customer tables get the three program-scope triggers
//   C  the two trigger functions are not executable by anon or authenticated
//   D  the three production verify predicates (#212 for these names, #352,
//      #357) read clean afterwards
//
// Mutations (CI runs each and requires the suite to FAIL):
//   CUST_GUARDS_DB_MUTATION=notwins    the twin sweep is not run
//   CUST_GUARDS_DB_MUTATION=noscope    the scope-trigger sweep is not run
//   CUST_GUARDS_DB_MUTATION=anonmirror the payout mirror keeps its grants

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.CUST_GUARDS_DB_MUTATION || '';
const db = new PGlite();
const CO_A = '11111111-1111-1111-1111-111111111111';
const CO_B = '22222222-2222-2222-2222-222222222222';
const mig = (f) => readFile(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8');
const between = (s, start, end) => { const i = s.indexOf(start); assert.ok(i >= 0, start); const j = s.indexOf(end, i); assert.ok(j > i, end); return s.slice(i, j + end.length); };

await db.exec(`
create role anon; create role authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function public.affiliate_manager_scoped() returns boolean language sql as $$ select false $$;
create function public.affiliate_visible_program(uuid) returns boolean language sql as $$ select true $$;
create table public.affiliate_programs(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null);
create table public.affiliate_customer_scans(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  program_id uuid references public.affiliate_programs(id));
create table public.affiliate_customer_social(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  program_id uuid references public.affiliate_programs(id), scan_id uuid references public.affiliate_customer_scans(id));
create function public.affiliate_payout_account_mirror() returns trigger language plpgsql security definer as $$ begin return new; end $$;
create function public.affiliate_person_email_follows() returns trigger language plpgsql security definer as $$ begin return new; end $$;
insert into public.affiliate_programs (id, company_entity_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '${CO_A}'), ('bbbbbbbb-0000-4000-8000-000000000001', '${CO_B}');
insert into public.affiliate_customer_scans (id, company_entity_id, program_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '${CO_A}', null), ('bbbbbbbb-0000-4000-8000-0000000000b1', '${CO_B}', null);
insert into public.affiliate_customer_social (company_entity_id, program_id, scan_id) values
  ('${CO_A}', null, 'aaaaaaaa-0000-4000-8000-0000000000a1'), ('${CO_A}', 'aaaaaaaa-0000-4000-8000-000000000001', null);
`);

// The real sweeps, from their own migrations.
const twinsSrc = between(await mig('20261111181000_affiliate_same_company_twins_function.sql'),
  'create or replace function public.attach_affiliate_same_company_twins()', 'end $fn$;');
const scopeSrc = await mig('20261121210000_affiliate_program_scoped_access.sql');
await db.exec(twinsSrc);
await db.exec(between(scopeSrc, 'create or replace function public.affiliate_program_scope_guard()', '$$;'));
await db.exec(between(scopeSrc, 'create or replace function public.attach_affiliate_program_scope_triggers()', 'end $fn$;'));

let sql = await mig('20261125233000_affiliate_customer_tables_guards.sql');
const mutate = (from, to) => { assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`); sql = sql.split(from).join(to); };
switch (MUT) {
  case '': break;
  case 'notwins': mutate('select public.attach_affiliate_same_company_twins();', ''); break;
  case 'noscope': mutate('select public.attach_affiliate_program_scope_triggers();', ''); break;
  case 'anonmirror': mutate('revoke all on function public.affiliate_payout_account_mirror() from public, anon, authenticated;', ''); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}
assert.ok(!/^\s*(begin|commit)\s*;/im.test(sql), 'no transaction control of its own (auto-apply refuses it)');
await db.exec(sql);
await db.exec(sql);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}
const refused = async (q) => { try { await db.exec(q); return false; } catch { return true; } };

await test('A: a customer-find row cannot point at another company\'s program or scan', async () => {
  assert.ok(await refused(`insert into public.affiliate_customer_social (company_entity_id, program_id) values ('${CO_A}', 'bbbbbbbb-0000-4000-8000-000000000001')`), 'program of another company');
  assert.ok(await refused(`insert into public.affiliate_customer_social (company_entity_id, scan_id) values ('${CO_A}', 'bbbbbbbb-0000-4000-8000-0000000000b1')`), 'scan of another company');
  assert.ok(await refused(`insert into public.affiliate_customer_scans (company_entity_id, program_id) values ('${CO_A}', 'bbbbbbbb-0000-4000-8000-000000000001')`), 'scan for another company\'s program');
  assert.ok(!(await refused(`insert into public.affiliate_customer_social (company_entity_id, program_id, scan_id) values ('${CO_A}', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1')`)), 'its own company still works');
  assert.ok(!(await refused(`insert into public.affiliate_customer_social (company_entity_id) values ('${CO_A}')`)), 'a company-level row (no program) still works');
});

await test('B: both customer tables carry the three program-scope triggers', async () => {
  for (const t of ['affiliate_customer_scans', 'affiliate_customer_social']) {
    const n = (await db.query(`select count(*)::int n from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname like '%\\_program\\_scope\\_%'`)).rows[0].n;
    assert.equal(n, 3, t);
  }
});

await test('C: the two trigger functions are not client-executable', async () => {
  for (const f of ['affiliate_payout_account_mirror()', 'affiliate_person_email_follows()']) for (const r of ['anon', 'authenticated']) {
    const ok = (await db.query(`select has_function_privilege('${r}', 'public.${f}', 'execute') x`)).rows[0].x;
    assert.equal(ok, false, `${r} on ${f}`);
  }
});

await test('D: the production verify predicates read clean', async () => {
  const twinless = (await db.query(`select count(*)::int n from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
      join pg_class pl on pl.oid = c.confrelid
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1 and pa.attname = 'id'
       and (cl.relname = 'affiliates' or cl.relname like 'affiliate\\_%') and (pl.relname = 'affiliates' or pl.relname like 'affiliate\\_%')
       and not exists (select 1 from pg_constraint t where t.contype = 'f' and t.conrelid = c.conrelid and t.confrelid = c.confrelid
                        and array_length(t.conkey, 1) = 2 and t.conkey[1] = c.conkey[1])`)).rows[0].n;
  assert.equal(twinless, 0, '#352');
  const unguarded = (await db.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and (c.relname = 'affiliates' or c.relname like 'affiliate\\_%')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'program_id' and not a.attisdropped)
       and (select count(*) from pg_trigger t where t.tgrelid = c.oid and t.tgname like '%\\_program\\_scope\\_%' and t.tgenabled <> 'D') <> 3`)).rows[0].n;
  assert.equal(unguarded, 0, '#357');
  const anonDefiner = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
       and p.proname in ('affiliate_payout_account_mirror', 'affiliate_person_email_follows')`)).rows[0].n;
  assert.equal(anonDefiner, 0, '#212');
});

console.log(`affiliate-customer-guards-database: ${passed} passed`);
