// The channel-resolver hoist (20261012180000), executed in a real PostgreSQL
// (PGlite). The migration rewrites five DEPLOYED function bodies by assertion-
// guarded text substitution, so what has to be proved is: it hoists every site
// it claims, the hoisted predicate selects the same rows as the bare one, it is
// idempotent, and it REFUSES rather than guesses when a body has drifted from
// the shape it expects.
//
// The bug being fixed is a performance one and cannot be measured here -- PGlite
// has neither production's row counts nor its plan costs. What is measurable here
// is the part that could silently change a number, and the call-count itself:
// a counting resolver proves the bare form runs once per scanned row and the
// hoisted form runs once per statement, which is the whole claim.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/wow-channel-hoist-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MIGRATION = readFileSync('supabase/migrations/20261012180000_wow_channel_tags_hoist.sql', 'utf8');
const VERIFY = readFileSync('supabase/verify_v2_schema.sql', 'utf8');

// The verify check's own predicate, lifted verbatim from verify_v2_schema.sql so
// the test cannot drift from what production actually runs.
const BARE_RE = (() => {
  const m = VERIFY.match(/pg_get_functiondef\(p\.oid\) ~ '(\(=\\s\*any[^']*)'/);
  assert.ok(m, 'verify_v2_schema.sql no longer carries the bare-resolver regex');
  return m[1];
})();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

// Each case gets its own database: the migration rewrites functions by name, so
// one shared instance would let an earlier case's rewrite satisfy a later one.
async function fresh() {
  const db = new PGlite();
  const q = async (sql) => (await db.query(sql)).rows;
  await db.exec(`
    create table locations(company_entity_id uuid, location_code text, store_type text);
    create table sales_by_day(company_entity_id uuid, day_date date, location_tag text,
      shop_domain text, total_net_sales numeric, synced_at timestamptz);
    create function active_company_id() returns uuid language sql stable
      as $$ select '00000000-0000-4000-a000-000000000001'::uuid $$;

    -- Counts its own invocations, so "once per row" versus "once per statement"
    -- is an observation rather than an inference. It MUST stay STABLE -- that
    -- declaration is the whole reason the bare call is not folded to a constant
    -- and the hoisted one becomes an InitPlan -- which rules out a counter
    -- table, because a stable function may not write one. A session setting is
    -- not a database write, so it counts without changing the volatility the
    -- planner sees.
    create function silo_channel_location_tags(p_channel text) returns text[]
      language plpgsql stable as $$
      begin
        perform set_config('test.calls',
          (coalesce(current_setting('test.calls', true), '0')::bigint + 1)::text, false);
        return case when p_channel = 'online' then array['online'] else array[]::text[] end;
      end $$;
  `);
  await db.exec(`
    insert into sales_by_day(company_entity_id, day_date, location_tag, shop_domain, total_net_sales, synced_at)
    select '00000000-0000-4000-a000-000000000001'::uuid,
           date '2026-10-01' + (i % 5),
           case when i % 4 = 0 then 'chicago' else 'online' end,
           'shop.example', 10, now()
    from generate_series(1, 200) i;
  `);
  return { db, q };
}

// Stand-ins for the five production functions, carrying the bare shape the
// migration expects to find and nothing else it needs to understand.
const bareBody = (n) => Array.from({ length: n }, (_, i) => `
  select coalesce(sum(s.total_net_sales), 0) as v${i}
  from public.sales_by_day s
  where s.company_entity_id = public.active_company_id()
    and ${i % 2 === 0 ? 's.location_tag' : 'lower(btrim(s.location_tag))'} = any(public.silo_channel_location_tags('online'))`)
  .join('\n  union all\n');

async function withFunctions(db, { reportSites = 3 } = {}) {
  await db.exec(`
    create function wow_report(p_report_date date, p_grain text) returns numeric language sql stable
      as $$ select sum(v) from (${bareBody(reportSites)}) t(v) $$;
    create function wow_data_through() returns numeric language sql stable
      as $$ select sum(v) from (${bareBody(1)}) t(v) $$;
    create function wow_kpi_compare(p_report_date date, p_grain text) returns numeric language sql stable
      as $$ select sum(v) from (${bareBody(1)}) t(v) $$;
    create function wow_online_shop_domains() returns numeric language sql stable
      as $$ select sum(v) from (${bareBody(1)}) t(v) $$;
    create function wow_paid_media_reality(p_report_date date, p_grain text) returns numeric language sql stable
      as $$ select sum(v) from (${bareBody(1)}) t(v) $$;
  `);
}

const bareCount = async (q) => Number((await q(`
  select count(*) n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prokind = 'f'
    and pg_get_functiondef(p.oid) ~ '${BARE_RE.replace(/'/g, "''")}'`))[0].n);

// Counted by plain substring arithmetic rather than a regex: the token being
// counted is itself full of regex metacharacters.
const hoistedSites = async (q) => Number((await q(`
  select coalesce(sum((length(d) - length(replace(d, t, ''))) / length(t)), 0) n
  from (select pg_get_functiondef(p.oid) d, '= any((select public.silo_channel_location_tags(' t
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.prokind = 'f' and p.proname like 'wow%') z`))[0].n);

const resolverCalls = async (q, sql) => {
  await q(`select set_config('test.calls', '0', false)`);
  const v = (await q(sql))[0];
  const n = Number((await q(`select current_setting('test.calls')::bigint n`))[0].n);
  return { value: Object.values(v)[0], calls: n };
};

await test('the bare form is what verify_v2_schema.sql calls CRITICAL, and the hoisted form is not', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  assert.equal(await bareCount(q), 5, 'all five stand-ins should trip the verify check before the migration');
  await db.exec(MIGRATION);
  assert.equal(await bareCount(q), 0, 'no function should trip it after');
});

await test('every site the migration claims is hoisted: 3 in wow_report, 1 in each of the other four', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  assert.equal(await hoistedSites(q), 0);
  await db.exec(MIGRATION);
  assert.equal(await hoistedSites(q), 7);
});

await test('the rewritten functions return exactly what they returned before', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  const before = (await q(`select wow_report('2026-10-05','week') r, wow_data_through() d,
    wow_kpi_compare('2026-10-05','week') k, wow_online_shop_domains() o,
    wow_paid_media_reality('2026-10-05','week') p`))[0];
  await db.exec(MIGRATION);
  const after = (await q(`select wow_report('2026-10-05','week') r, wow_data_through() d,
    wow_kpi_compare('2026-10-05','week') k, wow_online_shop_domains() o,
    wow_paid_media_reality('2026-10-05','week') p`))[0];
  assert.deepEqual(after, before);
  assert.ok(Number(before.r) > 0, 'the fixture must actually select rows, or this proves nothing');
});

await test('bare runs the resolver once per scanned row; hoisted runs it once per site', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  const bare = await resolverCalls(q, `select wow_report('2026-10-05','week') v`);
  // Three sites over a 200-row fixture, plus whatever the planner takes while
  // costing each predicate. The exact total is a planner detail; that it scales
  // with the row count is the bug.
  assert.ok(bare.calls >= 600, `bare should be evaluated per row per site, saw ${bare.calls}`);
  await db.exec(MIGRATION);
  const hoisted = await resolverCalls(q, `select wow_report('2026-10-05','week') v`);
  assert.ok(hoisted.calls <= 6, `hoisted should be evaluated per site, saw ${hoisted.calls}`);
  assert.ok(hoisted.calls * 20 < bare.calls, 'and the gap must grow with the table, not be a constant');
  assert.equal(String(hoisted.value), String(bare.value), 'and must still answer the same');
});

await test('an empty channel still selects no rows, never every row', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  // wow_data_through stands in for the unconfigured channel: it is the target
  // the migration expects to carry a single site, so swapping its body keeps
  // every other assertion satisfied. All five must stay present -- the
  // migration refuses a database missing one.
  await db.exec(`create or replace function wow_data_through() returns numeric language sql stable
    as $$ select count(*)::numeric from public.sales_by_day s
          where s.location_tag = any(public.silo_channel_location_tags('wholesale')) $$;`);
  const before = (await q(`select wow_data_through() n`))[0].n;
  await db.exec(MIGRATION);
  const after = (await q(`select wow_data_through() n`))[0].n;
  assert.equal(Number(before), 0);
  assert.equal(Number(after), 0, 'an unconfigured channel must stay empty, not become everything');
});

await test('re-running the migration changes nothing and does not raise', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  await db.exec(MIGRATION);
  const once = await hoistedSites(q);
  await db.exec(MIGRATION);
  assert.equal(await hoistedSites(q), once);
  assert.equal(await bareCount(q), 0);
});

await test('a body whose site count has drifted is refused, not guessed at', async () => {
  const { db } = await fresh();
  await withFunctions(db, { reportSites: 2 });
  await assert.rejects(() => db.exec(MIGRATION), /carries 2 bare resolver calls, expected 3/);
});

await test('a function that resolves no channel at all is refused', async () => {
  const { db } = await fresh();
  await withFunctions(db);
  // The shape a hand-edit could leave behind: the predicate gone entirely.
  await db.exec(`create or replace function wow_data_through() returns numeric language sql stable
    as $$ select coalesce(sum(total_net_sales), 0) from public.sales_by_day $$;`);
  await assert.rejects(() => db.exec(MIGRATION), /resolves no channel at all/);
});

await test('a database missing one of the five targets is refused', async () => {
  const { db, q } = await fresh();
  await withFunctions(db);
  await db.exec('drop function wow_data_through()');
  await assert.rejects(() => db.exec(MIGRATION),
    /public\.wow_data_through matched 0 function\(s\), expected exactly 1/);
  // And nothing was recorded against the four that are present.
  assert.equal(await hoistedSites(q), 0);
  assert.equal(await bareCount(q), 4);
});

await test('a second signature of a target is refused rather than half-rewritten', async () => {
  const { db } = await fresh();
  await withFunctions(db);
  await db.exec(`create function wow_data_through(p_unused text) returns numeric language sql stable
    as $$ select coalesce(sum(s.total_net_sales), 0) from public.sales_by_day s
          where lower(btrim(s.location_tag)) = any(public.silo_channel_location_tags('online')) $$;`);
  await assert.rejects(() => db.exec(MIGRATION),
    /public\.wow_data_through matched 2 function\(s\), expected exactly 1/);
});

await test('a refusal leaves every body as it was', async () => {
  const { db, q } = await fresh();
  await withFunctions(db, { reportSites: 2 });
  await assert.rejects(() => db.exec(MIGRATION));
  assert.equal(await hoistedSites(q), 0, 'the DO block is one transaction: a raise must roll back the rewrites it already did');
  assert.equal(await bareCount(q), 5);
});

console.log(`\n${passed} checks passed`);
