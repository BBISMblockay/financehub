// Gross Sales and Discounts by Location (20261030110000), executed in a real
// PostgreSQL (PGlite): the deployed SQL out of the migration, run over a
// fixture whose answers are known by hand.
//
// What it holds down:
//   - the six measures per location, and that the location slicer filters;
//   - the discount rate is discounts/gross and is NULL, not 0, where gross is 0;
//   - the Shopify-API / Better-Reports dedupe, which is the whole reason the
//     report reads sales_by_day_verification_v and not sales_by_day. The
//     fixture carries a cutover day present in both sources, so a report that
//     read the base table would report it twice;
//   - both tie-outs pass as shipped, and each one FAILS when the thing it
//     watches is broken.
//
// Which rows a person may see is not tested here: the view is
// security_invoker over an RLS table and that boundary is production's own.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/gross-sales-discounts-by-location-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const num = (v) => (v === null || v === undefined ? null : Number(v));

const CO = '00000000-0000-4000-a000-000000000001';
const REPORT = '5110de50-0000-4000-a000-000000000005';

// today = 2026-10-30, so the report's default window is 2026-10-20 .. 2026-10-29.
await db.exec(`
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
set test.today = '2026-10-30';
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;

create table silo_chat_saved_reports (
  id uuid primary key, company_entity_id uuid, created_by uuid, source text, visibility text,
  title text, description text, question text, answer text, queries_run text[], parameters jsonb default '[]',
  columns_metadata jsonb default '{}'
);
create table silo_report_tieouts (
  report_id uuid, name text, kind text, check_sql text, tolerance numeric, note text
);

create table sales_by_day (
  company_entity_id uuid, day_date date, location_tag text, source text, sku text,
  total_gross_sales numeric, total_discounts numeric, total_refunds numeric,
  total_net_sales numeric, total_quantity_sold numeric
);

-- The same shape as production's view (20260629120000): all columns, minus a
-- better_reports row whenever a shopify_api row exists for the same
-- company+location+day.
create view sales_by_day_verification_v as
select s.* from sales_by_day s
where not (
  s.source = 'better_reports'
  and exists (select 1 from sales_by_day api
               where api.company_entity_id = s.company_entity_id
                 and api.location_tag = s.location_tag
                 and api.day_date = s.day_date
                 and api.source = 'shopify_api')
);
`);

// Fixture, all inside the default window unless marked.
//   online        : gross 1000, disc 100, ref 50, net 850, units 40
//   scottsdale    : gross  400, disc  40, ref  0, net 360, units 10
//   cooperstown   : gross    0, disc   0, ref  0, net   0, units  0  -> rate NULL
//   texas         : a CUTOVER day in both sources; only the shopify_api row counts
//   allen         : OUTSIDE the window, must never appear
await db.exec(`
insert into sales_by_day (company_entity_id, day_date, location_tag, source, sku,
                          total_gross_sales, total_discounts, total_refunds, total_net_sales, total_quantity_sold) values
  ('${CO}', '2026-10-21', 'online',      'shopify_api',    'A',  600, 60, 50, 490, 24),
  ('${CO}', '2026-10-22', 'online',      'shopify_api',    'B',  400, 40,  0, 360, 16),
  ('${CO}', '2026-10-23', 'scottsdale',  'shopify_api',    'A',  400, 40,  0, 360, 10),
  ('${CO}', '2026-10-24', 'cooperstown', 'shopify_api',    'A',    0,  0,  0,   0,  0),
  ('${CO}', '2026-10-25', 'texas',       'shopify_api',    'A',  200, 20,  0, 180,  8),
  ('${CO}', '2026-10-25', 'texas',       'better_reports', 'A',  999, 99, 99, 801, 99),
  ('${CO}', '2026-10-05', 'allen',       'shopify_api',    'A', 5000,  1,  1,   1,  1);
`);

await db.exec(readFileSync('supabase/migrations/20261030110000_gross_sales_discounts_by_location_report.sql', 'utf8'));

const FROM = `'2026-10-20'::date`;
const TO = `'2026-10-29'::date`;
const sqlOf = async () => (await q(`select queries_run[1] as s from silo_chat_saved_reports where id = '${REPORT}'`))[0].s;
const runReport = async (location = `'all'`) => {
  const s = (await sqlOf())
    .replaceAll('{{date_from}}', FROM).replaceAll('{{date_to}}', TO).replaceAll('{{location}}', location);
  return q(s);
};
// The guard is an md5 of the row as written; PGlite has the same row, but the
// substitution below keeps each tie-out assertion about the thing it watches
// rather than about the guard, which gets its own test.
const unguard = (sql) => sql.replace(
  /\(select md5\(queries_run::text \|\| parameters::text\) = '[0-9a-f]+' from public\.silo_chat_saved_reports where id = '[^']+'\)/,
  'true');
const tieouts = async () => q(`select name, check_sql, tolerance from silo_report_tieouts where report_id = '${REPORT}' order by name`);
const evalCheck = async (sql) => {
  const r = (await q(unguard(sql).replaceAll('public.', '')))[0];
  return { left: num(r.left_value), right: num(r.right_value) };
};

await test('the report is registered as a system report with one SELECT and three parameters', async () => {
  const r = (await q(`select source, company_entity_id, visibility, title, parameters, queries_run from silo_chat_saved_reports where id = '${REPORT}'`))[0];
  assert.equal(r.source, 'system');
  assert.equal(r.company_entity_id, null);
  assert.equal(r.title, 'Gross Sales and Discounts by Location');
  assert.equal(r.queries_run.length, 1);
  assert.ok(!r.queries_run[0].includes(';'), 'report SQL must not contain a semicolon');
  assert.match(r.queries_run[0].trim(), /^(select|with)\s/i);
  const keys = r.parameters.map((p) => p.key);
  assert.deepEqual(keys, ['date_from', 'date_to', 'location']);
  assert.equal(r.parameters.find((p) => p.key === 'date_from').default, 'today-10d');
  const loc = r.parameters.find((p) => p.key === 'location');
  assert.equal(loc.type, 'text', 'location must be text, not enum: locations are per company');
  assert.equal(loc.options_source, 'location');
  assert.equal(loc.default, 'all');
});

await test('it reads the deduplicated view, not sales_by_day', async () => {
  assert.match(await sqlOf(), /sales_by_day_verification_v/);
});

await test('each location reports gross, discounts, refunds, net and units', async () => {
  const rows = await runReport();
  const by = Object.fromEntries(rows.map((r) => [r.location_tag, r]));
  assert.deepEqual(Object.keys(by).sort(), ['cooperstown', 'online', 'scottsdale', 'texas']);

  assert.equal(num(by.online.gross_sales), 1000);
  assert.equal(num(by.online.discounts), 100);
  assert.equal(num(by.online.refunds), 50);
  assert.equal(num(by.online.net_sales), 850);
  assert.equal(num(by.online.units_sold), 40);
  assert.equal(num(by.online.discount_rate), 0.1);

  assert.equal(num(by.scottsdale.gross_sales), 400);
  assert.equal(num(by.scottsdale.discount_rate), 0.1);
});

await test('gross sales orders the rows, highest first', async () => {
  const rows = await runReport();
  const gross = rows.map((r) => num(r.gross_sales));
  assert.deepEqual(gross, [...gross].sort((a, b) => b - a));
  assert.equal(rows[0].location_tag, 'online');
});

await test('a location with no gross sales has a blank discount rate, not zero', async () => {
  const by = Object.fromEntries((await runReport()).map((r) => [r.location_tag, r]));
  assert.equal(num(by.cooperstown.gross_sales), 0);
  assert.equal(by.cooperstown.discount_rate, null, '0% would read as "sold at full price"');
});

await test('a cutover day counted in both sources is reported once, from the Shopify API row', async () => {
  const by = Object.fromEntries((await runReport()).map((r) => [r.location_tag, r]));
  assert.equal(num(by.texas.gross_sales), 200, 'the better_reports duplicate must be dropped');
  assert.equal(num(by.texas.discounts), 20);
  assert.equal(num(by.texas.units_sold), 8);
});

await test('days outside the window are excluded', async () => {
  const rows = await runReport();
  assert.equal(rows.find((r) => r.location_tag === 'allen'), undefined);
});

await test('the location slicer narrows to one location, and the default does not filter', async () => {
  const one = await runReport(`'scottsdale'`);
  assert.equal(one.length, 1);
  assert.equal(one[0].location_tag, 'scottsdale');
  assert.equal((await runReport()).length, 4);
  assert.equal((await runReport(`'nowhere'`)).length, 0, 'an unknown location matches no rows rather than erroring');
});

await test('both tie-outs are written and reconcile as shipped', async () => {
  const checks = await tieouts();
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((c) => c.name), [
    'Gross less discounts less refunds equals net',
    'Location gross agrees with canonical gross',
  ]);
  for (const c of checks) {
    assert.equal(num(c.tolerance), 0.01);
    const { left, right } = await evalCheck(c.check_sql);
    assert.ok(left !== null && right !== null, `${c.name} returned NO DATA`);
    assert.ok(Math.abs(left - right) <= 0.01, `${c.name}: ${left} vs ${right}`);
  }
});

await test('MUTATION: a report that loses the dedupe fails the canonical-gross tie-out', async () => {
  const c = (await tieouts()).find((x) => x.name === 'Location gross agrees with canonical gross');
  const broken = unguard(c.check_sql).replaceAll('public.', '')
    .replace(/from sales_by_day_verification_v\n/, 'from sales_by_day\n');
  const r = (await q(broken))[0];
  assert.notEqual(num(r.left_value), num(r.right_value), 'double-counted gross must not reconcile');
  assert.equal(num(r.right_value), 1600, 'the deduplicated window is 1000 + 400 + 0 + 200');
  assert.equal(num(r.left_value), 2599, 'reading the base table adds the 999 better_reports duplicate');
});

await test('MUTATION: a gross that no longer describes the same transactions fails the internal tie-out', async () => {
  const c = (await tieouts()).find((x) => x.name === 'Gross less discounts less refunds equals net');
  await db.exec(`update sales_by_day set total_gross_sales = total_gross_sales + 10 where location_tag = 'online' and source = 'shopify_api'`);
  const { left, right } = await evalCheck(c.check_sql);
  assert.ok(Math.abs(left - right) > 0.01, `columns still add up after a 20 shift: ${left} vs ${right}`);
  await db.exec(`update sales_by_day set total_gross_sales = total_gross_sales - 10 where location_tag = 'online' and source = 'shopify_api'`);
  const ok = await evalCheck(c.check_sql);
  assert.ok(Math.abs(ok.left - ok.right) <= 0.01, 'fixture should reconcile again');
});

await test('MUTATION: editing the report without regenerating its tie-outs reports NO DATA', async () => {
  const before = (await tieouts()).map((c) => c.check_sql);
  await db.exec(`update silo_chat_saved_reports set parameters = parameters || '[{"key":"x"}]'::jsonb where id = '${REPORT}'`);
  for (const sql of before) {
    const r = (await q(sql.replaceAll('public.', '')))[0];
    assert.equal(num(r.left_value), null, 'a stale guard must yield NO DATA, never a stale pass');
  }
});

await test('the migration is idempotent: a second apply leaves one report and two tie-outs', async () => {
  await db.exec(readFileSync('supabase/migrations/20261030110000_gross_sales_discounts_by_location_report.sql', 'utf8'));
  assert.equal(num((await q(`select count(*) c from silo_chat_saved_reports where id = '${REPORT}'`))[0].c), 1);
  assert.equal(num((await q(`select count(*) c from silo_report_tieouts where report_id = '${REPORT}'`))[0].c), 2);
  // and the re-apply restored the parameters the mutation above corrupted
  const params = (await q(`select parameters from silo_chat_saved_reports where id = '${REPORT}'`))[0].parameters;
  assert.deepEqual(params.map((p) => p.key), ['date_from', 'date_to', 'location']);
  for (const c of await tieouts()) {
    const { left, right } = await evalCheck(c.check_sql);
    assert.ok(left !== null && Math.abs(left - right) <= 0.01, `${c.name} broken after re-apply`);
  }
});

console.log(`\n${passed} passed`);
await db.close();
