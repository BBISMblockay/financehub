// Business-timezone sweep, reporting half (20260924130300), against a REAL
// PostgreSQL (PGlite): the store comp summary anchors on each company's OWN
// last completed day, and the Org Calendar's live-session slots land on the
// company's clock. Neither surface had any database coverage before this.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/business-timezone-reporting-database.test.mjs
//
// Mutations (each must fail at least one assertion):
//   TZ_REPORTING_MUTATION=comp-pacific      the comp summary anchors on Pacific again
//   TZ_REPORTING_MUTATION=calendar-pacific  the calendar rewrite is skipped
//
// Why these two timezones: Etc/GMT-14 (UTC+14) and Etc/GMT+12 (UTC-12) are 26
// hours apart, so their calendar dates ALWAYS differ, and at every instant at
// least one of them is on a different date from Pacific. A mutation back to a
// Pacific anchor is therefore caught whatever time of day CI runs -- a pair of
// real US zones would only disagree with Pacific for a few hours a day.
// silo_company_timezone() honours whatever company_settings stores; the
// allowlist that keeps real companies to US zones is onboarding's job.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const mutation = process.env.TZ_REPORTING_MUTATION || '';
assert.ok(['', 'comp-pacific', 'calendar-pacific'].includes(mutation), `Unknown mutation ${mutation}`);

const root = new URL('../../', import.meta.url);
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const AHEAD = randomUUID();   // Etc/GMT-14
const BEHIND = randomUUID();  // Etc/GMT+12
const PACIFIC = randomUUID(); // no settings row: the fallback
const member = randomUUID();

// ── Fixture: only what the two surfaces read ────────────────────────────────
await db.exec(`
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role authenticated; create role anon; create role service_role;
grant usage on schema public, auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
create table public.entities (id uuid primary key, entity_type text not null default 'company', title text);
create table public.profiles (id uuid primary key, name text, active_company_id uuid);
create table public.entity_memberships (entity_id uuid, user_id uuid);
create table public.company_settings (company_entity_id uuid primary key, business_timezone text not null);
create function public.active_company_id() returns uuid language sql stable security definer as $$
  select active_company_id from public.profiles where id = auth.uid() $$;
grant execute on function public.active_company_id() to authenticated;

-- Stands in for the view: the function only reads these columns by name.
create table public.sales_by_day_verification_v (
  company_entity_id uuid, location_tag text, day_date date, sku text, product_name text,
  total_quantity_sold numeric, total_net_sales numeric, total_refunds numeric,
  total_sales numeric, total_discounts numeric);

create table public.live_sessions (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid, slot_start timestamptz,
  claimed_by uuid, payee_name text, live_location text, status text);
grant select on public.live_sessions, public.profiles, public.entities to authenticated;
alter table public.live_sessions enable row level security;
create policy live_sessions_select on public.live_sessions for select to authenticated
  using (company_entity_id = public.active_company_id());

-- The live-session branch exactly as production's calendar_events_v renders
-- it (pg_get_viewdef, 2026-09-24), plus one untouched branch to prove the
-- rewrite leaves the rest alone.
create view public.calendar_events_v with (security_invoker = true) as
 SELECT 'live:'::text || ls.id::text AS event_id,
    (ls.slot_start AT TIME ZONE 'America/Los_Angeles'::text)::date AS start_on,
    (ls.slot_start AT TIME ZONE 'America/Los_Angeles'::text)::time without time zone AS start_time,
    ls.company_entity_id
   FROM live_sessions ls
     LEFT JOIN profiles p ON p.id = ls.claimed_by
UNION ALL
 SELECT 'fixed:'::text || e.id::text, '2026-01-01'::date, NULL::time without time zone, e.id
   FROM entities e WHERE false;
grant select on public.calendar_events_v to authenticated;
`);

// The summary table, typed from the columns the function inserts.
{
  const fn = await readFile(new URL('supabase/migrations/20260924130300_business_timezone_reporting.sql', root), 'utf8');
  const list = fn.slice(fn.indexOf('insert into public.sales_verification_store_comp_summary ('));
  const cols = list.slice(list.indexOf('(') + 1, list.indexOf(')')).split(',').map((c) => c.trim()).filter(Boolean);
  assert.ok(cols.length > 50, 'the summary column list must be found');
  const type = (c) => (c === 'company_entity_id' ? 'uuid' : c === 'location_tag' ? 'text'
    : c === 'refreshed_at' ? 'timestamptz' : /date$/.test(c) ? 'date' : 'numeric');
  await db.exec(`create table public.sales_verification_store_comp_summary (${cols.map((c) => `${c} ${type(c)}`).join(', ')})`);
}

// ── Apply the sweep ─────────────────────────────────────────────────────────
let core = await readFile(new URL('supabase/migrations/20260924130000_business_timezone_core.sql', root), 'utf8');
let reporting = await readFile(new URL('supabase/migrations/20260924130300_business_timezone_reporting.sql', root), 'utf8');
if (mutation === 'comp-pacific') {
  const before = reporting;
  reporting = reporting.replace('(now() at time zone public.silo_company_timezone(e.id))::date as today',
    () => "(now() at time zone 'America/Los_Angeles')::date as today");
  assert.notEqual(reporting, before, 'comp-pacific must find the anchor');
}
if (mutation === 'calendar-pacific') {
  const before = reporting;
  reporting = reporting.replace('if v_new <> v_def then', () => 'if false then');
  assert.notEqual(reporting, before, 'calendar-pacific must find the rewrite');
}
await db.exec(core);
await db.exec(reporting);
if (!mutation) { await db.exec(core); await db.exec(reporting); }

await q(`insert into public.entities (id, title) values ($1,'Ahead'),($2,'Behind'),($3,'Pacific')`, [AHEAD, BEHIND, PACIFIC]);
await q(`insert into public.company_settings values ($1,'Etc/GMT-14'),($2,'Etc/GMT+12')`, [AHEAD, BEHIND]);

const todayIn = async (tz) => iso((await one(`select (now() at time zone $1)::date as d`, [tz])).d);
const shift = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

await test('the sweep applies, and applies twice', async () => {
  assert.ok(await one(`select 1 from pg_proc where proname='silo_company_timezone'`));
});

await test("the comp summary anchors each company on ITS OWN last completed day", async () => {
  const expected = {};
  for (const [co, tz] of [[AHEAD, 'Etc/GMT-14'], [BEHIND, 'Etc/GMT+12'], [PACIFIC, 'America/Los_Angeles']]) {
    const today = await todayIn(tz);
    // Today (partial), yesterday (the right anchor) and the day before (what a
    // wrong, earlier boundary would pick). Plus a day in the FUTURE of every
    // zone, which no boundary may ever anchor on.
    for (const day of [shift(today, -2), shift(today, -1), today, shift(today, 3)]) {
      await q(`insert into public.sales_by_day_verification_v
               (company_entity_id, location_tag, day_date, sku, product_name, total_quantity_sold, total_net_sales,
                total_refunds, total_sales, total_discounts)
               values ($1,'store',$2,'SKU','Tee',1,10,0,10,0)`, [co, day]);
    }
    expected[co] = shift(today, -1);
  }
  await q('select public.refresh_sales_verification_store_comp_summary()');
  const rows = await q('select company_entity_id, as_of_date from public.sales_verification_store_comp_summary');
  const got = Object.fromEntries(rows.map((r) => [r.company_entity_id, iso(r.as_of_date)]));
  assert.equal(got[AHEAD], expected[AHEAD], 'UTC+14 company');
  assert.equal(got[BEHIND], expected[BEHIND], 'UTC-12 company');
  assert.equal(got[PACIFIC], expected[PACIFIC], 'a company with no settings row keeps the Pacific anchor it always had');
});

await test("a live-session slot lands on the company's own date and time", async () => {
  // 2026-09-02T10:30Z is 00:30 on Sep 3 at UTC+14, 22:30 on Sep 1 at UTC-12,
  // and 03:30 on Sep 2 in Pacific (PDT).
  const AT = '2026-09-02T10:30:00Z';
  await q('insert into auth.users (id) values ($1)', [member]);
  await q('insert into public.profiles (id, name, active_company_id) values ($1, $2, $3)', [member, 'M', AHEAD]);
  await q('insert into public.entity_memberships values ($1, $2)', [AHEAD, member]);
  for (const co of [AHEAD, BEHIND, PACIFIC]) {
    await q('insert into public.live_sessions (company_entity_id, slot_start, status) values ($1, $2, $3)', [co, AT, 'claimed']);
  }
  const all = await q("select company_entity_id, start_on, start_time from public.calendar_events_v where event_id like 'live:%'");
  const by = Object.fromEntries(all.map((r) => [r.company_entity_id, [iso(r.start_on), r.start_time]]));
  assert.deepEqual(by[AHEAD], ['2026-09-03', '00:30:00']);
  assert.deepEqual(by[BEHIND], ['2026-09-01', '22:30:00']);
  assert.deepEqual(by[PACIFIC], ['2026-09-02', '03:30:00'], 'Pacific companies see exactly what they saw before');

  // Through RLS, as a signed-in member: the security_invoker view calls the
  // DEFINER helper per row, and sees only the member's own company.
  await db.exec('set role authenticated');
  await q("select set_config('request.jwt.claim.sub', $1, false)", [member]);
  try {
    const mine = await q("select start_on, start_time from public.calendar_events_v where event_id like 'live:%'");
    assert.equal(mine.length, 1);
    assert.deepEqual([iso(mine[0].start_on), mine[0].start_time], ['2026-09-03', '00:30:00']);
  } finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
});

await test('the rewrite left no Pacific literal and kept the view security_invoker', async () => {
  const def = (await one(`select pg_get_viewdef('public.calendar_events_v'::regclass, true) as d`)).d;
  assert.ok(!def.includes('America/Los_Angeles'), 'no branch names Pacific');
  assert.ok(def.includes("'fixed:'"), 'the other branches are untouched');
  const opts = (await one(`select reloptions from pg_class where oid='public.calendar_events_v'::regclass`)).reloptions;
  assert.deepEqual(opts, ['security_invoker=true']);
});

console.log(`\n1..${passed}${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
