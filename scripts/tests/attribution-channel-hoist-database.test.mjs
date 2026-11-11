// Attribution vs Sales channel-resolver hoist (20261111053000), executed in a
// real PostgreSQL (PGlite) over the report exactly as 20260925150000 installs
// it, with that migration's own tie-outs.
//
// The bug is a performance one and cannot be measured here (PGlite has neither
// production's rows nor its plans). What is proved: the rewrite hoists every
// bare site in the report AND its tie-outs, the report and every check return
// exactly what they returned before, the checks still pin the report (a moved
// fingerprint without a re-pin would read STALE every night), the resolver
// now runs once per statement instead of once per row, re-running is a no-op,
// and a drifted body is refused rather than guessed at.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/attribution-channel-hoist-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const REPORTS = readFileSync('supabase/migrations/20260925150000_marketing_inventory_reports.sql', 'utf8');
const MIGRATION = readFileSync('supabase/migrations/20261111053000_attribution_report_channel_hoist.sql', 'utf8');
const VERIFY = readFileSync('supabase/verify_v2_schema.sql', 'utf8');
const ATTR = 'c3000000-0000-4000-a000-000000000005';

// The verify check's own stored-SQL predicate, lifted verbatim.
const STORED_BARE_RE = (() => {
  const m = VERIFY.match(/-- stored-sql-bare-resolver\n[\s\S]*?~ '(\(=\\s\*any[^']*)'/);
  assert.ok(m, 'verify_v2_schema.sql no longer carries the stored-SQL bare-resolver check');
  return m[1];
})();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

async function fresh() {
  const db = new PGlite();
  const q = async (sql) => (await db.query(sql)).rows;
  await db.exec(`
    create function active_company_id() returns uuid language sql stable
      as $$ select '00000000-0000-4000-a000-000000000001'::uuid $$;
    create function silo_business_today() returns date language sql stable as $$ select date '2026-09-20' $$;
    -- Counts its own calls; MUST stay STABLE, which is the whole reason the
    -- bare call is not folded and the hoisted one becomes an InitPlan.
    create function silo_channel_location_tags(p_channel text) returns text[]
      language plpgsql stable as $$
      begin
        perform set_config('test.calls',
          (coalesce(current_setting('test.calls', true), '0')::bigint + 1)::text, false);
        return case when p_channel = 'online' then array['online'] else array[]::text[] end;
      end $$;
    create table silo_chat_saved_reports(id uuid primary key, title text, description text, queries_run text[],
      parameters jsonb default '[]', columns_metadata jsonb, source text, company_entity_id uuid, visibility text);
    create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text,
      check_sql text, tolerance numeric, enabled boolean default true, note text, unique(report_id, name));
    insert into silo_chat_saved_reports(id, title, source, queries_run) values ('${ATTR}', 'Attribution vs Sales', 'system', array['select 1']);
    create table marketing_kpis_daily(company_entity_id uuid default active_company_id(), day_date date, platform text,
      spend numeric, conversions numeric default 0, conversion_value numeric);
    create table sales_by_day(company_entity_id uuid default active_company_id(), day_date date, location_tag text, total_net_sales numeric);
    create view sales_by_day_verification_v as select * from sales_by_day where company_entity_id = active_company_id();
    insert into marketing_kpis_daily(day_date, platform, spend, conversion_value, conversions)
      select date '2026-08-23' + (i % 28), case when i % 3 = 0 then 'google_ads' when i % 3 = 1 then 'meta_ads' else 'ga4' end,
             10 + i, 30 + 2 * i, 1 from generate_series(0, 83) i;
    insert into sales_by_day(day_date, location_tag, total_net_sales)
      select date '2026-08-23' + (i % 28), case when i % 4 = 0 then 'chicago' else 'online' end, 5 + i
        from generate_series(0, 399) i;
  `);
  await db.exec(REPORTS);
  return { db, q };
}

const count = (text, tok) => (text.length - text.split(tok).join('').length) / tok.length;
const BARE = "any (public.silo_channel_location_tags('online'))";
const HOISTED = "any ((select public.silo_channel_location_tags('online'))::text[])";

const state = async (q) => {
  const [r] = await q(`select queries_run, md5(queries_run::text || parameters::text) h from silo_chat_saved_reports where id = '${ATTR}'`);
  const checks = await q(`select name, check_sql, tolerance from silo_report_tieouts where report_id = '${ATTR}' order by name`);
  return { queries: r.queries_run, hash: r.h, checks };
};
const sub = (sql) => sql.replaceAll('{{date_from}}', '((select silo_business_today()) - 28)').replaceAll('{{date_to}}', '((select silo_business_today()) - 1)');
const results = async (q, s) => ({
  report: await Promise.all(s.queries.map(async (sql) => q(sub(sql)))),
  checks: await Promise.all(s.checks.map(async (c) => (await q(c.check_sql))[0])),
});
const calls = async (q, sql) => {
  await q(`select set_config('test.calls', '0', false)`);
  await q(sql);
  return Number((await q(`select current_setting('test.calls')::bigint n`))[0].n);
};
const storedBare = async (q) => Number((await q(`
  select (select count(*) from silo_chat_saved_reports s, unnest(s.queries_run) x where x ~ '${STORED_BARE_RE.replace(/'/g, "''")}')
       + (select count(*) from silo_report_tieouts where check_sql ~ '${STORED_BARE_RE.replace(/'/g, "''")}') n`))[0].n);

await test('as installed, the report carries 2 bare sites and its three checks 5', async () => {
  const { q } = await fresh();
  const s = await state(q);
  assert.equal(s.queries.reduce((n, x) => n + count(x, BARE), 0), 2);
  assert.equal(s.checks.length, 3);
  assert.equal(s.checks.reduce((n, c) => n + count(c.check_sql, BARE), 0), 5);
  assert.ok(await storedBare(q) > 0, 'the verify check must see the bare shape');
});

await test('after the migration nothing is bare and every site is hoisted', async () => {
  const { db, q } = await fresh();
  await db.exec(MIGRATION);
  const s = await state(q);
  assert.equal(s.queries.reduce((n, x) => n + count(x, BARE), 0), 0);
  assert.equal(s.queries.reduce((n, x) => n + count(x, HOISTED), 0), 2);
  assert.equal(s.checks.reduce((n, c) => n + count(c.check_sql, HOISTED), 0), 5);
  assert.equal(await storedBare(q), 0, 'the verify check passes');
});

await test('the report and every tie-out return exactly what they returned before', async () => {
  const { db, q } = await fresh();
  const before = await results(q, await state(q));
  assert.ok(before.checks.every((c) => c.left_value !== null), 'every check reconciles before (not NO DATA)');
  await db.exec(MIGRATION);
  const after = await results(q, await state(q));
  assert.deepEqual(after, before);
});

await test('the checks are re-pinned to the new fingerprint, so they are not STALE', async () => {
  const { db, q } = await fresh();
  const old = await state(q);
  await db.exec(MIGRATION);
  const s = await state(q);
  assert.notEqual(s.hash, old.hash, 'the report text changed, so its fingerprint moved');
  for (const c of s.checks) {
    assert.ok(c.check_sql.includes(s.hash), `${c.name} pins the new fingerprint`);
    assert.ok(!c.check_sql.includes(old.hash), `${c.name} no longer pins the old one`);
    assert.notEqual((await q(c.check_sql))[0].left_value, null, `${c.name} reads as live, not NO DATA`);
  }
});

await test('the resolver runs once per statement instead of once per row', async () => {
  const { db, q } = await fresh();
  const sql = sub((await state(q)).queries[1]);
  const bareCalls = await calls(q, sql);
  assert.ok(bareCalls >= 300, `bare: once per online-window row (${bareCalls})`);
  await db.exec(MIGRATION);
  const hoistedCalls = await calls(q, sub((await state(q)).queries[1]));
  assert.equal(hoistedCalls, 1);
});

await test('re-running is a no-op', async () => {
  const { db, q } = await fresh();
  await db.exec(MIGRATION);
  const once = await state(q);
  await db.exec(MIGRATION);
  assert.deepEqual(await state(q), once);
});

await test('a body that has drifted is refused, and nothing changes', async () => {
  const { db, q } = await fresh();
  await db.exec(`update silo_chat_saved_reports set queries_run = queries_run || array['select 1 where ''x'' = ${BARE.replace(/'/g, "''")}'] where id = '${ATTR}'`);
  const before = await state(q);
  await assert.rejects(db.exec(MIGRATION), /expected 2/);
  assert.deepEqual(await state(q), before);
});

await test('no report installed: a notice, not a failure', async () => {
  const { db, q } = await fresh();
  await db.exec(`delete from silo_report_tieouts; delete from silo_chat_saved_reports`);
  await db.exec(MIGRATION);
  assert.equal((await q('select count(*)::int n from silo_chat_saved_reports'))[0].n, 0);
});

console.log(`\n${passed} passed`);
