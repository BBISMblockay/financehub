// The campaign audience on the Klaviyo performance report (20261111190000),
// executed in a real PostgreSQL (PGlite) over the report exactly as
// 20261109210000 installs it, with that migration's own tie-outs.
//
// What is proved here:
//   * the migration runs, and re-running it changes nothing (idempotent);
//   * an audience id resolves to its name, an id with no stored name shows as
//     the id, a list and a segment sharing an id are named once, and a message
//     Klaviyo reported no audience for stays NULL rather than reading as
//     "sent to nobody";
//   * the report's GRAIN is untouched -- one row per message, channel and
//     conversion metric, even for a message sent to several lists and measured
//     over several windows;
//   * all three tie-outs pin the report as it now stands (a moved fingerprint
//     without a re-pin reads STALE every night) and return OK on seeded data;
//   * the Marketing tile lists the new column, and a tenant's own clone of
//     that tile is left alone;
//   * and the mutation that matters: with the audience resolved by a LATERAL
//     JOIN instead of a per-row subquery, the two original tie-outs still pass
//     -- the report's DISTINCT ON hides the fan-out behind a correct row count
//     -- and ONLY the third one catches it. That asymmetry is the reason the
//     third check exists, so it is pinned by a test rather than by a comment.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/klaviyo-report-audience-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
// The nightly runner's OWN staleness query, imported rather than restated, so
// this test cannot disagree with the job that decides red or green.
import { CATALOG_SQL } from '../lib/report-tieouts-nightly.mjs';

const REPORTS = readFileSync('supabase/migrations/20261109210000_klaviyo_silo_reports.sql', 'utf8');
const TILES = readFileSync('supabase/migrations/20261109230000_klaviyo_dashboard_tiles.sql', 'utf8');
const MIGRATION = readFileSync('supabase/migrations/20261111190000_klaviyo_report_audience.sql', 'utf8');
const VERIFY = readFileSync('supabase/verify_v2_schema.sql', 'utf8');

const PERF = 'c9000000-0000-4000-a000-000000000001';
const TILE = 'd0000000-0000-4000-a00c-000000000013';
const CO = '00000000-0000-4000-a000-000000000001';

// The verify check for this change, lifted verbatim so the test cannot drift
// from the check that runs on production.
const VERIFY_CHECK = (() => {
  const i = VERIFY.indexOf("select 'Klaviyo report audience' as check_name,");
  assert.ok(i > 0, 'verify_v2_schema.sql no longer carries the Klaviyo report audience check');
  const j = VERIFY.indexOf('end as status;', i);
  return VERIFY.slice(i, j + 'end as status;'.length);
})();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

// The view as 20261109040000 installs it -- WITHOUT the audience columns, so
// the migration under test is seen to add them rather than assumed to.
const VIEW_BEFORE = `
create or replace view klaviyo_message_performance_v with (security_invoker = true) as
select p.id, p.company_entity_id, p.connection_id, p.kind, p.klaviyo_id,
       coalesce(nullif(p.channel, ''), m.channel) as channel,
       m.name as message_name, m.subject, m.parent_id, m.parent_name, m.status,
       m.send_time, m.trigger_type, m.archived,
       p.timeframe_start, p.timeframe_end, p.conversion_metric_id,
       p.recipients, p.delivered, p.opens, p.opens_unique, p.clicks, p.clicks_unique,
       p.conversions, p.conversion_uniques, p.conversion_value, p.average_order_value,
       p.revenue_per_recipient, p.unsubscribes, p.unsubscribe_uniques, p.bounced,
       p.bounced_or_failed, p.failed, p.spam_complaints, p.text_message_spend,
       p.text_message_credit_usage_amount, p.message_segment_count_sum,
       p.metrics, p.source, p.synced_at
  from klaviyo_message_performance p
  left join klaviyo_messages m on m.company_entity_id = p.company_entity_id
       and m.kind = p.kind and m.klaviyo_id = p.klaviyo_id;`;

async function fresh() {
  const db = new PGlite();
  const q = async (sql) => (await db.query(sql)).rows;
  await db.exec(`
    create function active_company_id() returns uuid language sql stable
      as $$ select '${CO}'::uuid $$;
    create function silo_business_today() returns date language sql stable as $$ select date '2026-11-11' $$;

    create table silo_chat_saved_reports(id uuid primary key, title text, description text,
      queries_run text[], parameters jsonb default '[]', columns_metadata jsonb,
      source text, company_entity_id uuid, visibility text);
    create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text,
      check_sql text, tolerance numeric, enabled boolean default true, note text, unique(report_id, name));

    create table klaviyo_messages(
      company_entity_id uuid default active_company_id(), kind text, klaviyo_id text,
      name text, subject text, channel text, parent_id text, parent_name text, status text,
      send_time timestamptz, trigger_type text, archived boolean, audiences jsonb);
    create table klaviyo_message_performance(
      id uuid default gen_random_uuid(), company_entity_id uuid default active_company_id(),
      connection_id uuid, kind text, klaviyo_id text, channel text,
      timeframe_start timestamptz, timeframe_end timestamptz, conversion_metric_id text,
      recipients bigint, delivered bigint, opens bigint, opens_unique bigint,
      clicks bigint, clicks_unique bigint, conversions numeric, conversion_uniques numeric,
      conversion_value numeric, average_order_value numeric, revenue_per_recipient numeric,
      unsubscribes bigint, unsubscribe_uniques bigint, bounced bigint, bounced_or_failed bigint,
      failed bigint, spam_complaints bigint, text_message_spend numeric,
      text_message_credit_usage_amount numeric, message_segment_count_sum numeric,
      metrics jsonb, source text, synced_at timestamptz default now());
    create table klaviyo_audiences(
      company_entity_id uuid default active_company_id(), kind text, klaviyo_id text, name text);
    create table klaviyo_flow_daily(
      company_entity_id uuid default active_company_id(), klaviyo_id text, channel text,
      day_date date, conversion_metric_id text, recipients bigint, delivered bigint,
      conversions numeric, conversion_value numeric, text_message_spend numeric,
      flow_name text, message_name text);
    create view klaviyo_flow_daily_v with (security_invoker = true) as
      select * from klaviyo_flow_daily;
    ${VIEW_BEFORE}

    -- The dashboard tile the migration edits, plus a tenant's own clone of it
    -- pointing at the same system report, which must NOT be touched.
    create table dashboard_widgets(id uuid primary key, dashboard_id uuid, company_entity_id uuid,
      created_by uuid, report_id uuid, query_index int, visual_type text, title text,
      visual_config jsonb, layout jsonb, sort_order int, updated_at timestamptz default now());
    -- The system tile itself comes from 20261109230000, loaded below. Only a
    -- tenant's own clone of it is hand-made here, to prove it is left alone.
    insert into dashboard_widgets(id, dashboard_id, company_entity_id, report_id, query_index, visual_type, title, visual_config)
    values ('d0000000-0000-4000-a00c-0000000000ff', '5110da5b-0000-4000-a000-0000000000aa', '${CO}'::uuid, '${PERF}', 0, 'table',
            'My own Klaviyo table', '{"columns":["message","sends"]}'::jsonb);

    -- Ask SILO's map, and the refresh the migration calls. The real one
    -- rewrites columns and preserves description/keywords/is_hidden; this one
    -- does the part the migration depends on.
    create table silo_chat_schema_catalog(relname text primary key, relkind text, columns text[],
      description text, keywords text[], is_hidden boolean default false,
      reportable boolean default true, report_priority int, auto_refreshed_at timestamptz, updated_at timestamptz);
    insert into silo_chat_schema_catalog(relname, relkind, description, keywords) values
      ('klaviyo_audiences', 'r', null, null),
      ('klaviyo_message_performance_v', 'v', 'Klaviyo email and SMS performance per message, straight from Klaviyo''s own API.',
       array['klaviyo', 'email', 'sms']);
    create function refresh_chat_schema_catalog() returns void language plpgsql as $$
    begin
      update silo_chat_schema_catalog c
         set columns = (select array_agg(a.attname::text order by a.attnum)
                          from pg_attribute a where a.attrelid = ('public.' || c.relname)::regclass
                           and a.attnum > 0 and not a.attisdropped),
             auto_refreshed_at = now();
    end $$;
  `);
  await db.exec(REPORTS);
  await db.exec(TILES);
  return { db, q };
}

// One message sent to three audiences and measured over TWO windows, one
// measured under a second conversion metric, one flow message with no audience
// of its own, and one campaign whose audience ids are not in klaviyo_audiences.
async function seed(db) {
  await db.exec(`
    insert into klaviyo_audiences(kind, klaviyo_id, name) values
      ('list', 'WmHUSt', 'Sample Data List'),
      ('list', 'VIP123', 'VIP Buyers'),
      ('segment', 'VIP123', 'VIP Buyers'),   -- same id both kinds: one name, not two
      ('segment', 'SUPP01', 'Unengaged 180d'),
      ('list', 'NEWS01', 'Newsletter');
    insert into klaviyo_messages(kind, klaviyo_id, name, parent_name, status, audiences) values
      ('campaign', 'c1', 'Spring Sale', null, 'Sent',
        '{"name":"Audience 1","included":["VIP123","NEWS01","WmHUSt"],"excluded":["SUPP01"]}'),
      ('campaign', 'c2', 'Unnamed Lists', null, 'Sent',
        '{"name":null,"included":["zz-never-synced"],"excluded":[]}'),
      ('flow', 'f1', 'Welcome 2', 'Welcome Flow', 'live', null);
    insert into klaviyo_message_performance
      (kind, klaviyo_id, channel, timeframe_start, timeframe_end, conversion_metric_id,
       recipients, delivered, opens_unique, clicks_unique, conversions, conversion_value,
       unsubscribe_uniques, text_message_spend)
    values
      -- c1 measured twice: the WIDER window must win, the narrower must not be summed
      ('campaign','c1','email','2026-10-05','2026-11-05','metric-A', 1000, 950, 400, 100, 12, 2400.00, 5, 0),
      ('campaign','c1','email','2026-10-25','2026-11-05','metric-A', 1000, 950, 380,  90, 10, 2000.00, 4, 0),
      -- same message under a SECOND conversion metric: a separate labelled row
      ('campaign','c1','email','2026-10-05','2026-11-05','metric-B', 1000, 950, 400,  95,  7, 1500.00, 5, 0),
      ('campaign','c2','sms',  '2026-10-05','2026-11-05','metric-A',  200, 190, null, 20,  3,  450.00, 2, 4.50),
      ('flow',    'f1','sms',  '2026-10-05','2026-11-05','metric-A',   50,  48, null,  6,  2,  300.00, 1, 1.25);
  `);
}

const sub = (sql) => sql
  .replaceAll('{{date_from}}', "((select silo_business_today()) - 28)")
  .replaceAll('{{date_to}}', "((select silo_business_today()) - 1)");

const reportRows = async (q) => {
  const [r] = await q(`select queries_run from silo_chat_saved_reports where id = '${PERF}'`);
  return q(sub(r.queries_run[0]));
};
const tieouts = async (q) =>
  q(`select name, check_sql, tolerance from silo_report_tieouts where report_id = '${PERF}' order by name`);
const verdicts = async (q) => {
  const out = {};
  for (const c of await tieouts(q)) {
    const [row] = await q(c.check_sql);
    const l = row.left_value === null ? null : Number(row.left_value);
    const r = row.right_value === null ? null : Number(row.right_value);
    out[c.name] = (l === null || r === null) ? 'NO DATA'
      : Math.abs(l - r) <= Number(c.tolerance) ? 'OK' : 'MISMATCH';
  }
  return out;
};
const verifyStatus = async (q) => (await q(VERIFY_CHECK))[0].status;

// Every enabled tie-out ANYWHERE, with whether the fingerprint it pins still
// matches the report it pins -- the nightly runner's own query. A row with
// stale = true turns that night's run red, whether or not the company has any
// Klaviyo data, because STALE is decided from fingerprints and not from rows.
const stalePins = async (q) =>
  (await q(CATALOG_SQL)).filter((r) => r.stale).map((r) => `${r.report_title} / ${r.check_name}`);

// Which reports' SQL a check quotes a fingerprint for -- the set a report edit
// has to refresh, which is NOT the same as the set the report owns.
const pinnedBy = async (q, name) => (await q(`
  select array(select m[1] from regexp_matches(check_sql,
    'where id = ''(c9000000-0000-4000-a000-[0-9a-f]+)''', 'g') m) ids
    from silo_report_tieouts where name = '${name.replace(/'/g, "''")}'`))[0].ids;
const tileColumns = async (q, id = TILE) =>
  (await q(`select visual_config -> 'columns' as c from dashboard_widgets where id = '${id}'`))[0].c;

await test('before the migration the view has no audience columns and the report cannot show one', async () => {
  const { db, q } = await fresh();
  await seed(db);
  const cols = await q(`select column_name from information_schema.columns
    where table_name = 'klaviyo_message_performance_v' and column_name like 'audience%'`);
  assert.equal(cols.length, 0);
  const [r] = await q(`select queries_run[1] s from silo_chat_saved_reports where id = '${PERF}'`);
  assert.ok(!r.s.includes('audience'));
  assert.equal(await verifyStatus(q), 'MISSING — klaviyo_message_performance_v has no audience columns; run 20261111190000_klaviyo_report_audience.sql');
  await db.close();
});

await test('the migration runs, verify goes ok, and a second run changes nothing', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  assert.equal(await verifyStatus(q), 'ok');

  const snap = async () => JSON.stringify({
    report: await q(`select queries_run, parameters, columns_metadata, description from silo_chat_saved_reports where id = '${PERF}'`),
    checks: await tieouts(q),
    tile: await tileColumns(q),
    clone: await tileColumns(q, 'd0000000-0000-4000-a00c-0000000000ff'),
    catalog: await q(`select relname, description, keywords from silo_chat_schema_catalog order by relname`),
    view: await q(`select pg_get_viewdef('klaviyo_message_performance_v'::regclass, true) d`),
    rows: await reportRows(q),
  });
  const first = await snap();
  await db.exec(MIGRATION);
  assert.equal(await snap(), first, 're-running the migration changed something');
  assert.equal(await verifyStatus(q), 'ok');
  await db.close();
});

await test('the view stays security_invoker and only APPENDS its new columns', async () => {
  const { db, q } = await fresh();
  const before = await q(`select column_name, ordinal_position from information_schema.columns
    where table_name = 'klaviyo_message_performance_v' order by ordinal_position`);
  await db.exec(MIGRATION);
  const after = await q(`select column_name, ordinal_position from information_schema.columns
    where table_name = 'klaviyo_message_performance_v' order by ordinal_position`);
  assert.deepEqual(after.slice(0, before.length), before, 'an existing column moved or changed name');
  assert.deepEqual(after.slice(before.length).map((c) => c.column_name),
    ['audience_name', 'audience_included', 'audience_excluded', 'audiences']);
  const [opt] = await q(`select coalesce((select option_value from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'), 'false') v
    from pg_class c where c.relname = 'klaviyo_message_performance_v'`);
  assert.equal(opt.v, 'true', 'the replace dropped security_invoker, so RLS would stop applying');
  await db.close();
});

await test('an audience resolves to its name; an unknown id shows as the id; no audience stays NULL', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  const rows = await q(`select klaviyo_id, audience_name, audience_included, audience_excluded
    from klaviyo_message_performance_v where conversion_metric_id = 'metric-A' order by klaviyo_id`);
  const by = Object.fromEntries(rows.map((r) => [r.klaviyo_id, r]));

  // Three ids, one of them held as BOTH a list and a segment: named once.
  assert.equal(by.c1.audience_included, 'Newsletter, Sample Data List, VIP Buyers');
  assert.equal(by.c1.audience_excluded, 'Unengaged 180d');
  assert.equal(by.c1.audience_name, 'Audience 1');

  // An id klaviyo_audiences has no row for reads as the id, never as blank:
  // the lists/segments read needs its own scopes and can be refused.
  assert.equal(by.c2.audience_included, 'zz-never-synced');
  assert.equal(by.c2.audience_excluded, null, 'an empty excluded array must be NULL, not an empty string');

  // A flow message has no audience of its own. NULL is "not reported".
  assert.equal(by.f1.audience_included, null);
  assert.equal(by.f1.audience_excluded, null);
  assert.equal(by.f1.audience_name, null);
  await db.close();
});

await test('a malformed audiences object is NULL, not an error', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  await db.exec(`update klaviyo_messages set audiences = '{"included":"not-an-array"}' where klaviyo_id = 'c1'`);
  const [r] = await q(`select audience_included, audience_excluded from klaviyo_message_performance_v
    where klaviyo_id = 'c1' limit 1`);
  assert.equal(r.audience_included, null);
  assert.equal(r.audience_excluded, null);
  await db.close();
});

await test('the grain holds: one row per message, channel and metric, audiences and windows notwithstanding', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  const rows = await reportRows(q);
  // c1 under two metrics, c2, f1 -- four rows, though c1/metric-A was measured twice
  assert.equal(rows.length, 4);
  const c1a = rows.find((r) => r.klaviyo_id === 'c1' && r.conversion_metric_id === 'metric-A');
  assert.equal(Number(c1a.window_days), 32, 'the WIDER window must win');
  assert.equal(Number(c1a.attributed_revenue), 2400, 'the two windows were summed');
  assert.equal(c1a.audience, 'Newsletter, Sample Data List, VIP Buyers');
  assert.equal(c1a.audience_excluded, 'Unengaged 180d');
  assert.equal(rows.find((r) => r.klaviyo_id === 'f1').audience, null);
  // SMS has no opens: blank, never 0%
  assert.equal(rows.find((r) => r.klaviyo_id === 'f1').open_rate, null);
  await db.close();
});

await test('all three tie-outs pin the report as written and return OK', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  const checks = await tieouts(q);
  assert.deepEqual(checks.map((c) => c.name).sort(), [
    'Attributed revenue agrees with the base tables, ranked a different way',
    'One row per message, channel and metric, never one per window',
    'The audience lookup does not multiply the measured rows',
  ]);
  const [{ h }] = await q(`select md5(queries_run::text || parameters::text) h
    from silo_chat_saved_reports where id = '${PERF}'`);
  for (const c of checks) {
    assert.ok(c.check_sql.includes(`'${h}'`), `${c.name} pins a stale fingerprint`);
  }
  assert.deepEqual(await verdicts(q), {
    'Attributed revenue agrees with the base tables, ranked a different way': 'OK',
    'One row per message, channel and metric, never one per window': 'OK',
    'The audience lookup does not multiply the measured rows': 'OK',
  });
  await db.close();
});

await test('with no Klaviyo data at all the report is empty and the checks read NO DATA, not a failure', async () => {
  const { db, q } = await fresh();
  await db.exec(MIGRATION);
  assert.deepEqual(await reportRows(q), []);
  for (const v of Object.values(await verdicts(q))) {
    assert.ok(v === 'OK' || v === 'NO DATA', `an empty workspace produced ${v}`);
  }
  assert.equal(await verifyStatus(q), 'ok');
  await db.close();
});

await test('the Marketing tile lists Audience after Channel; a tenant clone is untouched', async () => {
  const { db, q } = await fresh();
  await db.exec(MIGRATION);
  assert.deepEqual(await tileColumns(q),
    ['message', 'channel', 'audience', 'conversion_metric_id', 'window_days', 'sends', 'attributed_orders', 'attributed_revenue']);
  const [t] = await q(`select visual_config from dashboard_widgets where id = '${TILE}'`);
  assert.equal(t.visual_config.limit, 15, 'the tile lost its row limit');
  assert.ok(String(t.visual_config.empty_message).startsWith('No Klaviyo measurements'), 'the tile lost its empty message');
  assert.deepEqual(await tileColumns(q, 'd0000000-0000-4000-a00c-0000000000ff'), ['message', 'sends'],
    "a tenant's own copy of the tile was rewritten");
  await db.close();
});

await test('the catalog describes klaviyo_audiences and the view\'s new columns', async () => {
  const { db, q } = await fresh();
  await db.exec(MIGRATION);
  const rows = Object.fromEntries((await q(
    `select relname, description, keywords from silo_chat_schema_catalog`)).map((r) => [r.relname, r]));
  // Ask SILO's index line is the first sentence truncated at 140 characters.
  const first = rows.klaviyo_audiences.description.split('. ')[0];
  assert.ok(first.length < 140, `the first sentence is ${first.length} characters and would be cut mid-thought`);
  assert.ok(rows.klaviyo_audiences.keywords.includes('audience'));
  assert.ok(/no profile count/i.test(rows.klaviyo_audiences.description), 'the catalog must say audience size is unanswerable');
  assert.ok(rows.klaviyo_message_performance_v.description.includes('audience_included'));
  assert.ok(rows.klaviyo_message_performance_v.keywords.includes('segment'));
  assert.ok(rows.klaviyo_message_performance_v.keywords.includes('klaviyo'), 'the existing keywords were dropped');
  // No dated staleness verdicts in catalog text: these rows are global across
  // tenants and nothing rewrites them when a feed resumes.
  assert.ok(!/20\d\d-\d\d-\d\d/.test(rows.klaviyo_audiences.description));
  await db.close();
});

await test('the fixture reproduces the cross-report dependency this change has to respect', async () => {
  const { db, q } = await fresh();
  // Before the migration: two checks owned by OTHER reports pin ...001 as well
  // as their own. If this ever stops being true the regression below is
  // testing nothing, so it is asserted rather than assumed.
  assert.deepEqual(await pinnedBy(q, 'Channel totals add up to Email & SMS Performance'),
    ['c9000000-0000-4000-a000-000000000003', PERF]);
  assert.deepEqual(await pinnedBy(q, 'Totals by conversion metric add up to Email & SMS Performance'),
    ['c9000000-0000-4000-a000-000000000004', PERF]);
  assert.deepEqual(await stalePins(q), [], 'the fixture started stale');
  await db.close();
});

await test('REGRESSION: editing the report leaves NO stale fingerprint anywhere', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  // The failure this guards: refreshing only the checks report ...001 OWNS
  // leaves the two cross-report checks pinning a hash that no longer exists,
  // and the nightly goes red the first night after the apply.
  assert.deepEqual(await stalePins(q), []);
  // Re-pinned, and still pinning BOTH reports -- a refresh that dropped the
  // companion's own guard would be a different regression.
  assert.deepEqual(await pinnedBy(q, 'Channel totals add up to Email & SMS Performance'),
    ['c9000000-0000-4000-a000-000000000003', PERF]);
  assert.deepEqual(await pinnedBy(q, 'Totals by conversion metric add up to Email & SMS Performance'),
    ['c9000000-0000-4000-a000-000000000004', PERF]);
  // And they still reconcile: both sides read the CURRENT report SQL.
  for (const name of ['Channel totals add up to Email & SMS Performance',
                      'Totals by conversion metric add up to Email & SMS Performance']) {
    const [c] = await q(`select check_sql, tolerance from silo_report_tieouts where name = '${name.replace(/'/g, "''")}'`);
    assert.ok(c.check_sql.includes('audience_included'), `${name} still embeds the pre-edit report SQL`);
    const [row] = await q(c.check_sql);
    assert.notEqual(row.left_value, null, `${name} reads NO DATA, so it has stopped reconciling`);
    assert.ok(Math.abs(Number(row.left_value) - Number(row.right_value)) <= Number(c.tolerance),
      `${name} no longer reconciles`);
  }
  // The companion reports keep their OTHER checks: ...004's KPI-shape check
  // does not reference ...001 and must survive untouched.
  const kpi = await q(`select name from silo_report_tieouts
    where report_id = 'c9000000-0000-4000-a000-000000000004' order by name`);
  assert.deepEqual(kpi.map((r) => r.name), [
    'The KPI query returns one row, or none when nothing was measured',
    'Totals by conversion metric add up to Email & SMS Performance',
  ].sort());
  await db.close();
});

// ── Mutations ──────────────────────────────────────────────────────────────

await test('MUTATION ownedonly: refreshing only the edited report\'s own checks goes STALE', async () => {
  const { db, q } = await fresh();
  await seed(db);
  // The migration as first written: the two cross-report deletes removed, so
  // their checks keep the pre-edit fingerprint.
  const broken = MIGRATION
    .replace(/delete from public\.silo_report_tieouts\n where report_id = 'c9000000-0000-4000-a000-000000000003'[\s\S]*?;\n/, '')
    .replace(/delete from public\.silo_report_tieouts\n where report_id = 'c9000000-0000-4000-a000-000000000004'[\s\S]*?;\n/, '')
    .replace(/  insert into public\.silo_report_tieouts \(report_id, name, kind, check_sql, tolerance, note\)\n  values \('c9000000-0000-4000-a000-000000000003',[\s\S]*?in either report\.'\);\n/, '')
    .replace(/  insert into public\.silo_report_tieouts \(report_id, name, kind, check_sql, tolerance, note\)\n  values \('c9000000-0000-4000-a000-000000000004',[\s\S]*?in either report\.'\);\n/, '');
  assert.ok(!broken.includes("values ('c9000000-0000-4000-a000-000000000003',"), 'the mutation did not apply');
  await db.exec(broken);
  assert.deepEqual((await stalePins(q)).sort(), [
    'Email & SMS Totals (Klaviyo) / Totals by conversion metric add up to Email & SMS Performance',
    'Email vs SMS (Klaviyo) / Channel totals add up to Email & SMS Performance',
  ], 'the stale-pin guard did not fire');
  await db.close();
});


await test('MUTATION lateraljoin: a joined audience is caught ONLY by the third tie-out', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);

  // The same view, with audience_included resolved by a lateral join instead
  // of a per-row subquery -- the shape the third check exists to forbid.
  await db.exec(`
    create or replace view klaviyo_message_performance_v with (security_invoker = true) as
    select p.id, p.company_entity_id, p.connection_id, p.kind, p.klaviyo_id,
           coalesce(nullif(p.channel, ''), m.channel) as channel,
           m.name as message_name, m.subject, m.parent_id, m.parent_name, m.status,
           m.send_time, m.trigger_type, m.archived,
           p.timeframe_start, p.timeframe_end, p.conversion_metric_id,
           p.recipients, p.delivered, p.opens, p.opens_unique, p.clicks, p.clicks_unique,
           p.conversions, p.conversion_uniques, p.conversion_value, p.average_order_value,
           p.revenue_per_recipient, p.unsubscribes, p.unsubscribe_uniques, p.bounced,
           p.bounced_or_failed, p.failed, p.spam_complaints, p.text_message_spend,
           p.text_message_credit_usage_amount, p.message_segment_count_sum,
           p.metrics, p.source, p.synced_at,
           m.audiences ->> 'name' as audience_name,
           coalesce(a.name, g.gid) as audience_included,
           null::text as audience_excluded,
           m.audiences
      from klaviyo_message_performance p
      left join klaviyo_messages m on m.company_entity_id = p.company_entity_id
           and m.kind = p.kind and m.klaviyo_id = p.klaviyo_id
      left join lateral jsonb_array_elements_text(
             case when jsonb_typeof(m.audiences -> 'included') = 'array'
                  then m.audiences -> 'included' else '[]'::jsonb end) as g(gid) on true
      left join klaviyo_audiences a on a.company_entity_id = m.company_entity_id
           and a.klaviyo_id = g.gid;`);

  // The damage: the row count and the revenue are still right, and the
  // campaign is labelled with ONE of its three lists.
  const rows = await reportRows(q);
  assert.equal(rows.length, 4, 'the fan-out should have been hidden by DISTINCT ON');
  const c1a = rows.find((r) => r.klaviyo_id === 'c1' && r.conversion_metric_id === 'metric-A');
  assert.equal(Number(c1a.attributed_revenue), 2400);
  assert.ok(['Newsletter', 'Sample Data List', 'VIP Buyers'].includes(c1a.audience));
  assert.notEqual(c1a.audience, 'Newsletter, Sample Data List, VIP Buyers',
    'the mutation did not actually change the audience shown');

  const v = await verdicts(q);
  assert.equal(v['One row per message, channel and metric, never one per window'], 'OK',
    'this check is expected NOT to catch it -- that is why the third one exists');
  assert.equal(v['Attributed revenue agrees with the base tables, ranked a different way'], 'OK',
    'this check is expected NOT to catch it -- that is why the third one exists');
  assert.equal(v['The audience lookup does not multiply the measured rows'], 'MISMATCH',
    'the join guard did not fire');
  assert.ok((await verifyStatus(q)).startsWith('BROKEN'), `verify did not report it: ${await verifyStatus(q)}`);
  await db.close();
});

await test('MUTATION dropguard: without the third tie-out verify reports WEAK', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  await db.exec(`delete from silo_report_tieouts
    where report_id = '${PERF}' and name = 'The audience lookup does not multiply the measured rows'`);
  assert.ok((await verifyStatus(q)).startsWith('WEAK'), await verifyStatus(q));
  await db.close();
});

await test('MUTATION nopin: a report edited without regenerating its checks reads NO DATA', async () => {
  const { db, q } = await fresh();
  await seed(db);
  await db.exec(MIGRATION);
  await db.exec(`update silo_chat_saved_reports
    set queries_run = array[replace(queries_run[1], 'as audience,', 'as audience ,')]
    where id = '${PERF}'`);
  for (const [name, v] of Object.entries(await verdicts(q))) {
    assert.equal(v, 'NO DATA', `${name} went on checking the old shape`);
  }
  await db.close();
});

await test('MUTATION noaudience: a report that stops selecting the audience is reported MISSING', async () => {
  const { db, q } = await fresh();
  await db.exec(MIGRATION);
  await db.exec(`update silo_chat_saved_reports
    set queries_run = array[replace(replace(queries_run[1],
          'audience_included as audience,', ''), 'audience_included, audience_excluded,', '')]
    where id = '${PERF}'`);
  assert.ok((await verifyStatus(q)).startsWith('MISSING'), await verifyStatus(q));
  await db.close();
});

console.log(`\n${passed} passed`);
