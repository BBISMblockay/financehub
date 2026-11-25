// scripts/tests/affiliate-studio-spend-database.test.mjs
//
// Affiliate Studio spend (20261125040000) on real PostgreSQL (PGlite),
// applied TWICE because apply_all_post_merge.sql re-runs every migration.
//
// What this proves:
//   A  an owner/admin of the active company sets the limits (dollars in,
//      micros stored); anyone else, bad values and nobody signed in are refused
//   B  "this month" is ONE Affiliate Studio figure: every settled, succeeded
//      affiliate_research operation of the company this month, in customer
//      dollars (charged where enforced, priced where in shadow) -- never
//      another feature, company, month, a failure or a hold
//   C  one scan's own spend (the nightly dollar limit) is its operations only
//   D  the Billing summary carries customer dollars, the limits and the last
//      nightly run -- no provider cost, rate or multiplier anywhere in it
//   E  grants: anon reaches nothing; the cap-check figure is service-only
//   F  a member reads only their own company's settings row (RLS)
//
// Mutations (CI runs each and requires the suite to FAIL):
//   STUDIO_SPEND_DB_MUTATION=anongrant   anon keeps Supabase's default EXECUTE on the write
//   STUDIO_SPEND_DB_MUTATION=noowner     the owner/admin gate on the write is dropped
//   STUDIO_SPEND_DB_MUTATION=allfeature  every AI feature counts toward the Studio figure
//   STUDIO_SPEND_DB_MUTATION=provider    shadow spend reads the provider's cost, not the customer price
//   STUDIO_SPEND_DB_MUTATION=authspend   a signed-in user may call the service-only figure
//   STUDIO_SPEND_DB_MUTATION=norls       the settings table is readable across companies
//   STUDIO_SPEND_DB_MUTATION=heldcount   a run's spend so far (still held) is left out of its own figure
//   STUDIO_SPEND_DB_MUTATION=heldall     another run's spend so far counts toward this run
//   STUDIO_SPEND_DB_MUTATION=discclobber saving the Find limits resets the Discovery ones
//
// 20261125100000 (nightly Discovery) is applied after it, both twice, in order.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.STUDIO_SPEND_DB_MUTATION || '';
const db = new PGlite();

const CO_A = '11111111-1111-1111-1111-111111111111';
const CO_B = '22222222-2222-2222-2222-222222222222';
const OWNER = '99999999-9999-9999-9999-999999999999';
const MEMBER = '88888888-8888-8888-8888-888888888888';
const SCAN = '33333333-3333-3333-3333-333333333333';

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function is_owner_admin_of_active_company() returns boolean language sql as
  $$ select coalesce(current_setting('test.owner', true), '') = 'yes' $$;
create function silo_company_timezone(p uuid) returns text language sql as $$ select 'America/Los_Angeles' $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
create table entities(id uuid primary key);
create table entity_memberships(entity_id uuid, user_id uuid);
create table ai_credit_reservations(
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, feature text not null,
  source_ref text, status text not null, enforced boolean not null, outcome text,
  provider_cost_micros numeric, computed_charge_micros bigint, charged_micros bigint not null default 0,
  settled_at timestamptz, usage jsonb, rate_id uuid, multiplier_bps integer);
create table ai_provider_rates(id uuid primary key, web_search_micros_per_request numeric not null default 0);
-- Stand-ins for the ledger's pricing (20261001120000): searches at the rate,
-- then the company's multiplier.
create function ai_credit_provider_cost(p_rate ai_provider_rates, p_usage jsonb) returns numeric language sql as
  $$ select coalesce((p_usage->>'web_search')::numeric, 0) * p_rate.web_search_micros_per_request $$;
create function ai_credit_customer_micros(p_provider numeric, p_bps integer) returns bigint language sql as
  $$ select round(p_provider * p_bps / 10000)::bigint $$;
create table affiliate_programs(id uuid primary key, name text);
create table affiliate_discovery_runs(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null, program_id uuid,
  started_at timestamptz not null default now(), finished_at timestamptz, status text, prospects_new int, cost_usd numeric);
create table affiliate_customer_scans(id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  status text, checked int, found int, filters jsonb not null default '{}', error_message text, cost_usd numeric,
  started_at timestamptz not null default now(), finished_at timestamptz);
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated;
insert into entities values ('${CO_A}'), ('${CO_B}');
insert into entity_memberships values ('${CO_A}', '${OWNER}'), ('${CO_A}', '${MEMBER}'), ('${CO_B}', '${OWNER}');
`);

let sql = await readFile(new URL('../../supabase/migrations/20261125040000_affiliate_studio_spend.sql', import.meta.url), 'utf8')
  + '\n' + await readFile(new URL('../../supabase/migrations/20261125100000_affiliate_studio_nightly_discovery.sql', import.meta.url), 'utf8');
function mutate(from, to) {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`);
  sql = sql.split(from).join(to);
}
switch (MUT) {
  case '': break;
  case 'anongrant': mutate('revoke all on function public.affiliate_studio_set_spend(boolean, integer, numeric, numeric, boolean, integer, numeric) from public, anon;', ''); break;
  case 'heldcount': mutate('+ (select micros from open_run) end', 'end'); break;
  case 'heldall': mutate("and x.status = 'held' and x.source_ref = p_scan::text", "and x.status = 'held'"); break;
  case 'discclobber': mutate('coalesce(p_discovery, cur.discovery_nightly_enabled, false)', 'coalesce(p_discovery, false)'); break;
  case 'noowner': mutate("  if not coalesce(public.is_owner_admin_of_active_company(), false) then\n    raise exception 'Only", "  if false then\n    raise exception 'Only"); break;
  case 'allfeature': mutate(" and x.feature = 'affiliate_research'", ''); break;
  case 'provider': mutate('else coalesce(x.computed_charge_micros, 0) end as micros', 'else coalesce(x.provider_cost_micros, 0) end as micros'); break;
  case 'authspend': mutate('revoke all on function public.affiliate_studio_spend(uuid, uuid) from public, anon, authenticated;', 'revoke all on function public.affiliate_studio_spend(uuid, uuid) from public, anon;'); break;
  case 'norls': mutate('alter table public.affiliate_studio_spend_settings enable row level security;', ''); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}

await db.exec(sql);
await db.exec(sql);   // apply_all re-runs it

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}
async function as(role, { uid = OWNER, company = CO_A, owner = true } = {}, fn) {
  await db.exec(`set test.uid = '${uid || ''}'; set test.company = '${company || ''}'; set test.owner = '${owner ? 'yes' : 'no'}'; set role ${role};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const refused = async (fn) => { try { await fn(); return false; } catch { return true; } };
const setSpend = (nightly, cust, usd, month) => db.query('select public.affiliate_studio_set_spend($1, $2, $3, $4) as s', [nightly, cust, usd, month]);

await test('A: an owner/admin sets the limits; anyone else, bad values and nobody signed in are refused', async () => {
  const s = (await as('authenticated', {}, () => setSpend(true, 250, 2.5, 40))).rows[0].s;
  assert.equal(s.nightly_enabled, true);
  assert.equal(s.night_max_customers, 250);
  assert.equal(Number(s.night_max_micros), 2_500_000, 'dollars in, micros stored');
  assert.equal(Number(s.month_cap_micros), 40_000_000);
  assert.ok(await as('authenticated', { uid: MEMBER, owner: false }, () => refused(() => setSpend(true, 300, 3, null))), 'a member who is not owner/admin');
  assert.ok(await as('authenticated', {}, () => refused(() => setSpend(true, 0, 3, null))), 'zero customers');
  assert.ok(await as('authenticated', {}, () => refused(() => setSpend(true, 300, 0, null))), 'a $0 night');
  assert.ok(await as('authenticated', {}, () => refused(() => setSpend(true, 300, 3, -1))), 'a negative cap');
  assert.ok(await as('authenticated', { company: null }, () => refused(() => setSpend(true, 300, 3, null))), 'no active company');
  const row = (await db.query(`select * from affiliate_studio_spend_settings where company_entity_id = '${CO_A}'`)).rows[0];
  assert.equal(row.night_max_customers, 250, 'no refused call changed the row');
  assert.equal(row.updated_by, OWNER);
  // Blank monthly cap = no cap.
  const s2 = (await as('authenticated', {}, () => setSpend(false, 300, 3, null))).rows[0].s;
  assert.equal(s2.month_cap_micros, null);
  assert.equal(s2.nightly_enabled, false);
});

await db.exec(`insert into ai_credit_reservations (company_entity_id, feature, source_ref, status, enforced, outcome, provider_cost_micros, computed_charge_micros, charged_micros, settled_at) values
  ('${CO_A}', 'affiliate_research', '${SCAN}', 'settled', false, 'succeeded', 100, 200, 0, now()),          -- shadow: priced 200
  ('${CO_A}', 'affiliate_research', '${SCAN}', 'settled', true,  'succeeded', 500, 1000, 1000, now()),      -- enforced: charged 1000
  ('${CO_A}', 'affiliate_research', 'other-run', 'settled', false, 'succeeded', 1, 30, 0, now()),          -- Discovery, same line
  ('${CO_A}', 'affiliate_research', '${SCAN}', 'settled', false, 'failed', 999, 999, 0, now()),             -- failed: free
  ('${CO_A}', 'affiliate_research', '${SCAN}', 'held', false, null, 999, null, 0, null),                   -- still held
  ('${CO_A}', 'affiliate_research', '${SCAN}', 'settled', false, 'succeeded', 999, 999, 0, now() - interval '70 days'), -- last month
  ('${CO_A}', 'ask_silo', null, 'settled', false, 'succeeded', 999, 999, 0, now()),                       -- another feature
  ('${CO_B}', 'affiliate_research', null, 'settled', false, 'succeeded', 999, 999, 0, now());             -- another company
insert into affiliate_customer_scans (company_entity_id, status, checked, found, filters, error_message, cost_usd, started_at) values
  ('${CO_A}', 'done', 300, 4, '{"nightly": true, "to_check": 6}', null, 1.23, now() - interval '1 hour'),
  ('${CO_A}', 'done', 25, 9, '{}', null, 0.5, now()),
  ('${CO_B}', 'done', 1, 1, '{"nightly": true}', null, 0.5, now());`);

const spend = async (co, scan = null) => (await db.query('select public.affiliate_studio_spend($1, $2) as s', [co, scan])).rows[0].s;

await test('B: this month is ONE Studio figure in customer dollars: Find and Discovery, nothing else', async () => {
  const s = await spend(CO_A);
  assert.equal(Number(s.month_micros), 1230, '200 (shadow) + 1000 (charged) + 30 (Discovery)');
  assert.equal(s.scan_micros, null);
});

await test('C: one scan\'s own spend is its operations only', async () => {
  assert.equal(Number((await spend(CO_A, SCAN)).scan_micros), 1200);
});

await test('D: the Billing summary: customer dollars, limits, last night -- never provider cost, rates or the multiplier', async () => {
  const s = (await as('authenticated', { uid: MEMBER, owner: false }, () => db.query('select public.affiliate_studio_spend_summary() as s'))).rows[0].s;
  assert.equal(Number(s.month_micros), 1230);
  assert.equal(s.can_edit, false, 'a member sees it, read-only');
  assert.equal(s.last_night.checked, 300);
  assert.equal(s.last_night.likely, 4);
  assert.equal(s.last_night.to_check, 6);
  const text = JSON.stringify(s);
  for (const w of ['provider', 'multiplier', 'bps', 'rate', 'cost_usd', '1.23']) assert.ok(!text.includes(w), `no ${w} in the summary`);
  const none = (await as('authenticated', { uid: '77777777-7777-7777-7777-777777777777', owner: false }, () => db.query('select public.affiliate_studio_spend_summary() as s'))).rows[0].s;
  assert.equal(none, null, 'not a member of the company: nothing');
});

await test('E: grants -- anon reaches nothing, the cap-check figure is service-only', async () => {
  const r = (await db.query(`select
    has_function_privilege('anon', 'public.affiliate_studio_set_spend(boolean,integer,numeric,numeric,boolean,integer,numeric)', 'execute') a1,
    has_function_privilege('anon', 'public.affiliate_studio_spend_summary()', 'execute') a2,
    has_function_privilege('anon', 'public.affiliate_studio_spend(uuid,uuid)', 'execute') a3,
    has_function_privilege('authenticated', 'public.affiliate_studio_spend(uuid,uuid)', 'execute') u3,
    has_function_privilege('authenticated', 'public.affiliate_studio_set_spend(boolean,integer,numeric,numeric,boolean,integer,numeric)', 'execute') u1,
    has_function_privilege('service_role', 'public.affiliate_studio_spend(uuid,uuid)', 'execute') s3,
    has_table_privilege('anon', 'public.affiliate_studio_spend_settings', 'select') t1,
    has_table_privilege('authenticated', 'public.affiliate_studio_spend_settings', 'insert') t2`)).rows[0];
  assert.deepEqual(r, { a1: false, a2: false, a3: false, u3: false, u1: true, s3: true, t1: false, t2: false });
});

await test('F: a member reads only their own company\'s settings row', async () => {
  await as('authenticated', { company: CO_B }, () => setSpend(true, 10, 1, null));
  const rows = (await as('authenticated', { uid: MEMBER, owner: false }, () => db.query('select company_entity_id from affiliate_studio_spend_settings'))).rows;
  assert.deepEqual(rows.map((x) => x.company_entity_id), [CO_A]);
});

// ── Nightly Discovery (20261125100000) ─────────────────────────────────
const RUN = '44444444-4444-4444-4444-444444444444';
const RATE = '55555555-5555-5555-5555-555555555555';
await test('G: Discovery has its own nightly switch and limits; saving Find alone keeps them', async () => {
  const s = (await as('authenticated', {}, () => db.query('select public.affiliate_studio_set_spend($1,$2,$3,$4,$5,$6,$7) as s', [false, 300, 3, null, true, 20, 2.5]))).rows[0].s;
  assert.equal(s.discovery_nightly_enabled, true);
  assert.equal(s.discovery_night_creators, 20);
  assert.equal(Number(s.discovery_night_max_micros), 2_500_000);
  const k = (await as('authenticated', {}, () => setSpend(true, 300, 3, null))).rows[0].s;
  assert.equal(k.discovery_nightly_enabled, true, 'a save without Discovery fields keeps them');
  assert.equal(k.discovery_night_creators, 20);
  assert.ok(await as('authenticated', {}, () => refused(() => db.query('select public.affiliate_studio_set_spend($1,$2,$3,$4,$5,$6,$7)', [false, 300, 3, null, true, 51, 1]))), 'over 50 creators');
  assert.ok(await as('authenticated', {}, () => refused(() => db.query('select public.affiliate_studio_set_spend($1,$2,$3,$4,$5,$6,$7)', [false, 300, 3, null, true, 10, 0]))), 'a $0 Discovery night');
  const fresh = await spend(CO_B);
  assert.deepEqual([fresh.discovery_nightly_enabled, fresh.discovery_night_creators, Number(fresh.discovery_night_max_micros)], [false, 10, 1_000_000], 'off and modest by default');
});

await test('H: a run still going counts what it has used so far, and only its own', async () => {
  await db.exec(`insert into ai_provider_rates values ('${RATE}', 900);
    insert into ai_credit_reservations (company_entity_id, feature, source_ref, status, enforced, usage, rate_id, multiplier_bps) values
      ('${CO_A}', 'affiliate_research', '${RUN}', 'held', false, '{"web_search": 100}', '${RATE}', 20000),
      ('${CO_A}', 'affiliate_research', 'another-run', 'held', false, '{"web_search": 999}', '${RATE}', 20000);`);
  assert.equal(Number((await spend(CO_A, RUN)).scan_micros), 180_000, '100 searches x 900 x 2, still held');
  assert.equal(Number((await spend(CO_A)).month_micros), 1230, 'the month counts settled spend only');
});

await test('I: the summary shows the last nightly Discovery, counts only', async () => {
  await db.exec(`insert into affiliate_programs values ('${SCAN}', 'Coaches');
    insert into affiliate_discovery_runs (company_entity_id, program_id, status, prospects_new, cost_usd, nightly, started_at) values
      ('${CO_A}', '${SCAN}', 'ok', 7, 0.77, true, now() - interval '1 hour'),
      ('${CO_A}', '${SCAN}', 'ok', 40, 9.99, false, now());`);
  const s = (await as('authenticated', { uid: MEMBER, owner: false }, () => db.query('select public.affiliate_studio_spend_summary() as s'))).rows[0].s;
  assert.equal(s.last_discovery.new, 7, 'the nightly one, not a press');
  assert.equal(s.last_discovery.program, 'Coaches');
  assert.ok(!JSON.stringify(s).includes('0.77'), 'never its cost');
});

console.log(`\naffiliate-studio-spend-database: ${passed} passed`);
