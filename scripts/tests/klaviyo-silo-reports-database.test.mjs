// The three Klaviyo SILO reports (20261109210000), executed in a real
// PostgreSQL (PGlite): the deployed SQL from the migration, parameters
// substituted by the browser's own report-params.js, over fixtures whose
// answers are known, through the REAL views lifted out of the Klaviyo
// migration rather than stand-ins -- a renamed view column must break this.
//
// What it pins is what Klaviyo's shape makes easy to get wrong:
//
//   * A campaign exists only as a TOTAL over a measurement window, and SILO
//     stores several windows for the same campaign (the nightly's trailing 60
//     days, and a backfill's year). Summing them double counts the same sends,
//     so Performance must hold each message ONCE, for the WIDEST window whose
//     end falls in the period.
//   * Klaviyo reports no opens for SMS, so an SMS open rate is blank, never 0%.
//   * A statistic Klaviyo did not report is NULL and stays blank, and a
//     message that delivered nothing inside the window (its sends were before
//     it, its conversions land inside it -- Redo's measured lesson) has blank
//     rates, never 0% and never a division error.
//   * The daily trend is FLOWS ONLY, because Klaviyo has no campaign series
//     endpoint, and it respects its own date bounds.
//   * Email vs SMS is built from the same one-window pick, so its totals agree
//     with Performance -- asserted here and by the migration's own tie-out.
//
// Mutations (CI runs each and requires a failure):
//   KLAVIYO_REPORTS_MUTATION=sum-windows        Performance aggregates every stored window
//   KLAVIYO_REPORTS_MUTATION=narrowest-window   it picks the narrowest window, not the widest
//   KLAVIYO_REPORTS_MUTATION=sms-opens          SMS gets a real open rate
//   KLAVIYO_REPORTS_MUTATION=zero-not-blank     a zero denominator reads 0% instead of blank
//   KLAVIYO_REPORTS_MUTATION=trend-unbounded    the trend ignores its date range
//   KLAVIYO_REPORTS_MUTATION=split-sums-windows the channel split aggregates every window
//   KLAVIYO_REPORTS_MUTATION=no-guard           a changed definition no longer blanks its tie-out
//   KLAVIYO_REPORTS_MUTATION=metric-mixed       two conversion metrics collapse into one row
//   KLAVIYO_REPORTS_MUTATION=trend-mixes-metrics the trend adds two metrics into one day
//   KLAVIYO_REPORTS_MUTATION=perf-no-recon      Performance keeps only its row-count sanity check
//   KLAVIYO_REPORTS_MUTATION=kpi-all-metrics    the KPI query returns a row per conversion metric
//   KLAVIYO_REPORTS_MUTATION=tile-overlap       a Klaviyo tile lands on a tile already on the board
//   KLAVIYO_REPORTS_MUTATION=tile-wrong-query   the by-metric table reads the one-metric KPI query
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/klaviyo-silo-reports-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.KLAVIYO_REPORTS_MUTATION || '';
assert.ok(['', 'sum-windows', 'narrowest-window', 'sms-opens', 'zero-not-blank',
  'trend-unbounded', 'split-sums-windows', 'no-guard',
  'metric-mixed', 'trend-mixes-metrics', 'perf-no-recon',
  'kpi-all-metrics', 'tile-overlap', 'tile-wrong-query'].includes(MUT), `Unknown mutation ${MUT}`);

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const num = (v) => (v === null || v === undefined ? null : Number(v));
const day = (v) => (v === null ? null : new Date(v).toISOString().slice(0, 10));

const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(readFileSync('v3/js/report-params.js', 'utf8'), ctx);
const P = ctx.window.SiloReportParams;

const PERF = 'c9000000-0000-4000-a000-000000000001';
const TREND = 'c9000000-0000-4000-a000-000000000002';
const SPLIT = 'c9000000-0000-4000-a000-000000000003';

// today = 2026-11-09, so the default window is today-28d .. today-1d,
// 2026-10-12 .. 2026-11-08 -- the same defaults the Redo pair ships with.
await db.exec(`
create function active_company_id() returns uuid language sql as $$ select '00000000-0000-4000-a000-000000000001'::uuid $$;
create function silo_business_today() returns date language sql as $$ select current_setting('test.today')::date $$;
set test.today = '2026-11-09';
create table silo_chat_saved_reports(id uuid primary key, title text, description text, queries_run text[],
  parameters jsonb default '[]', columns_metadata jsonb, source text, company_entity_id uuid, visibility text);
create table silo_report_tieouts(id uuid default gen_random_uuid(), report_id uuid, name text, kind text,
  check_sql text, tolerance numeric, enabled boolean default true, note text, unique(report_id, name),
  constraint silo_report_tieouts_kind_check check (kind in ('reconciliation', 'sanity')));

create table klaviyo_messages(company_entity_id uuid default active_company_id(), connection_id uuid,
  kind text, klaviyo_id text, parent_id text, parent_name text, name text, subject text, channel text,
  status text, send_time timestamptz, trigger_type text, archived boolean,
  created_at_remote timestamptz, updated_at_remote timestamptz, tags jsonb, attributes jsonb,
  synced_at timestamptz, sync_batch_id uuid);
create table klaviyo_message_performance(id uuid default gen_random_uuid(),
  company_entity_id uuid default active_company_id(), connection_id uuid, kind text, klaviyo_id text,
  channel text not null default '', timeframe_start timestamptz, timeframe_end timestamptz,
  conversion_metric_id text, recipients bigint, delivered bigint, opens bigint, opens_unique bigint,
  clicks bigint, clicks_unique bigint, conversions numeric, conversion_uniques numeric,
  conversion_value numeric, average_order_value numeric, revenue_per_recipient numeric,
  unsubscribes bigint, unsubscribe_uniques bigint, bounced bigint, bounced_or_failed bigint,
  failed bigint, spam_complaints bigint, text_message_spend numeric,
  text_message_credit_usage_amount numeric, message_segment_count_sum numeric, metrics jsonb,
  source text, synced_at timestamptz, sync_batch_id uuid);
create table klaviyo_flow_daily(id uuid default gen_random_uuid(),
  company_entity_id uuid default active_company_id(), connection_id uuid, klaviyo_id text,
  channel text not null default '', day_date date, conversion_metric_id text,
  recipients bigint, delivered bigint, opens bigint, opens_unique bigint, clicks bigint,
  clicks_unique bigint, conversions numeric, conversion_uniques numeric, conversion_value numeric,
  average_order_value numeric, revenue_per_recipient numeric, unsubscribes bigint,
  unsubscribe_uniques bigint, bounced bigint, bounced_or_failed bigint, failed bigint,
  spam_complaints bigint, text_message_spend numeric, text_message_credit_usage_amount numeric,
  message_segment_count_sum numeric, metrics jsonb, source text, synced_at timestamptz,
  sync_batch_id uuid);
`);

// The REAL view definitions, lifted from the Klaviyo migration by name, so
// this suite reads what production reads. security_invoker is dropped because
// PGlite has no roles or policies; the column list, which is what a report
// depends on, is untouched.
const klaviyoMigration = readFileSync('supabase/migrations/20261109040000_klaviyo_native_integration.sql', 'utf8');
for (const view of ['klaviyo_message_performance_v', 'klaviyo_flow_daily_v']) {
  const start = klaviyoMigration.indexOf(`create or replace view public.${view}`);
  assert.ok(start > 0, `${view} is not created by the Klaviyo migration any more`);
  // The statement ends at a semicolon that ENDS a line: the view's own
  // comments contain semicolons mid-sentence, and cutting at the first one
  // lifted half a statement.
  const tail = klaviyoMigration.slice(start);
  const end = tail.search(/;[ \t]*\r?\n/);
  assert.ok(end > 0, `${view}'s statement does not end`);
  const stmt = tail.slice(0, end + 1).replace('with (security_invoker = true)', '');
  await db.exec(stmt);
}

await db.exec(`
-- One email campaign and one SMS flow message.
insert into klaviyo_messages(kind, klaviyo_id, name, channel, status, parent_id, parent_name, trigger_type)
values ('campaign', 'camp1', 'October drop', 'email', 'sent', null, null, null),
       ('campaign', 'camp2', 'November preview', 'email', 'sent', null, null, null),
       ('flow_message', 'fmsg1', 'Welcome SMS', 'sms', 'live', 'flow1', 'Welcome', 'Added to List'),
       ('campaign', 'campQuiet', 'September teaser', 'email', 'sent', null, null, null);

-- camp1 is stored TWICE for windows that both end inside the period: the
-- year-long backfill and the nightly's trailing 60 days. The year is the
-- widest, so it is the measurement the report must show, and the 60-day row
-- must not be added to it.
insert into klaviyo_message_performance(kind, klaviyo_id, channel, timeframe_start, timeframe_end,
  conversion_metric_id, recipients, delivered, opens_unique, clicks_unique, conversions,
  conversion_value, unsubscribe_uniques, text_message_spend)
values
 ('campaign', 'camp1', 'email', '2025-11-09T00:00:00+00:00', '2026-11-08T23:59:59+00:00',
  'MET1', 1000, 980, 400, 60, 12, 1234.56, 5, null),
 ('campaign', 'camp1', 'email', '2026-09-10T00:00:00+00:00', '2026-11-08T23:59:59+00:00',
  'MET1', 100, 98, 40, 6, 1, 100.00, 1, null),
 -- opens_unique 0, not null, on purpose: Klaviyo can answer an SMS report
 -- with a zero for a statistic SMS does not have, and 0 delivered-over-opens
 -- is a 0% open rate that reads as "nobody opened it" rather than "SMS has no
 -- opens". The email-only guard is what keeps it blank, so the fixture has to
 -- be able to expose the guard's absence.
 ('flow_message', 'fmsg1', 'sms', '2026-09-10T00:00:00+00:00', '2026-11-08T23:59:59+00:00',
  'MET1', 200, 198, 0, 10, 4, 99.50, 2, 12.34),
 -- Sent before the window and still earning conversions inside it: delivered
 -- 0 with revenue above it. Its rates must be blank, never 0% or a crash.
 ('campaign', 'campQuiet', 'email', '2026-10-12T00:00:00+00:00', '2026-11-08T23:59:59+00:00',
  'MET1', 0, 0, null, null, 2, 50.00, 0, null),
 -- camp1 AGAIN, 60 days, under a DIFFERENT conversion metric: the account
 -- switched metric and the nightly measured it against MET2 while the year
 -- under MET1 survived, because the sweep is scoped to a window. These count
 -- different events, so they are two labelled rows and are never summed into
 -- one, and the widest-window pick must not silently prefer one metric's
 -- measurement as if it were the message's only one.
 ('campaign', 'camp1', 'email', '2026-09-10T00:00:00+00:00', '2026-11-08T23:59:59+00:00',
  'MET2', 150, 147, 60, 9, 3, 300.00, 2, null),
 -- A campaign that exists ONLY under the new metric.
 ('campaign', 'camp2', 'email', '2026-09-10T00:00:00+00:00', '2026-11-08T23:59:59+00:00',
  'MET2', 500, 490, 200, 30, 5, 200.00, 3, null),
 -- A window that ends BEFORE the period: out of range entirely.
 ('campaign', 'camp1', 'email', '2026-08-12T00:00:00+00:00', '2026-10-11T23:59:59+00:00',
  'MET1', 7777, 7777, 7777, 7777, 7777, 7777.00, 7777, null);

-- Flow days: three inside the period, one outside.
insert into klaviyo_flow_daily(klaviyo_id, channel, day_date, conversion_metric_id,
  recipients, delivered, clicks_unique, conversions, conversion_value, text_message_spend)
values ('fmsg1', 'sms', '2026-11-06', 'MET1', 50, 49, 3, 1, 25.00, 3.00),
       ('fmsg1', 'sms', '2026-11-07', 'MET1', 60, 59, 4, 2, 40.50, 3.50),
       ('fmsg1', 'sms', '2026-11-08', 'MET1', 70, 69, 3, 1, 34.00, 4.00),
       -- The same day under the new metric: a different event, so a second
       -- labelled row rather than 44.00 on one.
       ('fmsg1', 'sms', '2026-11-08', 'MET2', 70, 69, 1, 1, 10.00, 0),
       ('fmsg1', 'sms', '2026-10-01', 'MET1', 999, 999, 999, 999, 9999.00, 99.00);
`);

// ── the migration under test, with the mutation applied ─────────────────────
let sql = readFileSync('supabase/migrations/20261109210000_klaviyo_silo_reports.sql', 'utf8');
const DISTINCT = 'distinct on (kind, klaviyo_id, channel, conversion_metric_id)';
const WIDEST = `((timeframe_end at time zone 'UTC')::date - (timeframe_start at time zone 'UTC')::date) desc,`;
const replaceNth = (hay, needle, to, n) => {
  let i = -1;
  for (let k = 0; k <= n; k += 1) i = hay.indexOf(needle, i + 1);
  assert.ok(i > 0, `mutation ${MUT}: pattern missing`);
  return hay.slice(0, i) + to + hay.slice(i + needle.length);
};
const sub = (from, to) => {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern missing`);
  sql = sql.split(from).join(to);
};
if (MUT === 'sum-windows') sql = replaceNth(sql, DISTINCT, '', 0);
if (MUT === 'split-sums-windows') sql = replaceNth(sql, DISTINCT, '', 1);
if (MUT === 'narrowest-window') sub(WIDEST, WIDEST.replace(' desc,', ' asc,'));
if (MUT === 'sms-opens') {
  sub(`       case when lower(channel) = 'email'
            then round(100 * opens_unique::numeric / nullif(delivered, 0), 1) end as open_rate,`,
    '       round(100 * opens_unique::numeric / nullif(delivered, 0), 1) as open_rate,');
}
if (MUT === 'zero-not-blank') sub('nullif(delivered, 0)', 'greatest(delivered, 1)');
if (MUT === 'trend-unbounded') sub(' where day_date between {{date_from}} and {{date_to}}\n', '');
// The conversion metric is part of the grain: a message measured under two
// metrics is counts of two different events, so collapsing them picks one
// arbitrarily and silently loses the other.
if (MUT === 'metric-mixed') sub(DISTINCT, 'distinct on (kind, klaviyo_id, channel)');
if (MUT === 'trend-mixes-metrics') {
  sub(' group by day_date, conversion_metric_id\n', ' group by day_date\n');
  sub('       conversion_metric_id,\n       round(sum(conversion_value), 2) as attributed_revenue,\n       sum(conversions) as attributed_orders,\n       sum(recipients) as sends,\n       sum(delivered) as delivered,',
    '       max(conversion_metric_id) as conversion_metric_id,\n       round(sum(conversion_value), 2) as attributed_revenue,\n       sum(conversions) as attributed_orders,\n       sum(recipients) as sends,\n       sum(delivered) as delivered,');
}
// Performance with only its row-count sanity check is what verify_v2_schema
// reports as WEAK: a wrong money value with the row count unchanged passes.
if (MUT === 'perf-no-recon') {
  sub(`    'Attributed revenue agrees with the base tables, ranked a different way', 'reconciliation',`,
    `    'Attributed revenue agrees with the base tables, ranked a different way', 'sanity',`);
}
if (MUT === 'no-guard') sub('md5(queries_run::text || parameters::text), id)', "'ignored', id)");
await db.exec(sql);

const reports = new Map((await q('select * from silo_chat_saved_reports')).map((r) => [r.id, r]));
async function run(id, values = {}) {
  const report = reports.get(id);
  assert.ok(report, `report ${id} was not inserted`);
  const out = P.substitute(report.queries_run[0], report.parameters,
    P.defaultsFor(P.normalizeDeclarations(report.parameters), values));
  assert.ok(out.sql, out.error);
  return q(out.sql);
}

await test('three global system reports, every token declared, scoped per tenant', async () => {
  assert.equal(reports.size, 3);
  for (const id of [PERF, TREND, SPLIT]) {
    const r = reports.get(id);
    assert.equal(r.source, 'system', id);
    assert.equal(r.company_entity_id, null, id);
    assert.equal(r.visibility, 'company', id);
    const keys = new Set(P.normalizeDeclarations(r.parameters).map((d) => d.key));
    for (const s of r.queries_run) for (const t of P.tokensIn(s)) assert.ok(keys.has(t), `${id}: ${t}`);
  }
});

await test('every title and description names Klaviyo and warns that revenue is attributed', async () => {
  for (const id of [PERF, TREND, SPLIT]) {
    const r = reports.get(id);
    assert.match(r.title, /Klaviyo/, `${id} title must name the vendor, so it is never confused with Redo's`);
    assert.match(r.description, /attribut/i, id);
    assert.match(r.description, /not incremental/i, `${id}: revenue must never read as sales`);
  }
  assert.match(reports.get(TREND).title, /flows/i, 'the trend must say on its face that it is flows only');
});

await test('Performance holds each message once, for the widest window in the period', async () => {
  const rows = await run(PERF);
  // Five measurements: camp1 under two metrics, camp2, campQuiet, fmsg1 --
  // out of seven stored rows in range.
  assert.equal(rows.length, 5, 'one row per message, channel and metric, not one per stored window');
  const camp = rows.find((r) => r.klaviyo_id === 'camp1' && r.conversion_metric_id === 'MET1');
  assert.equal(num(camp.window_days), 365, 'the year-long measurement is the widest, so it is the one shown');
  assert.equal(day(camp.window_from), '2025-11-09');
  assert.equal(day(camp.window_through), '2026-11-08');
  assert.equal(num(camp.sends), 1000, 'the 60-day row must not be added to the year');
  assert.equal(num(camp.attributed_revenue), 1234.56);
  assert.equal(camp.message, 'October drop');
  assert.equal(num(camp.delivery_rate), 98);
  assert.equal(num(camp.open_rate), 40.8);
  assert.equal(num(camp.click_rate), 6.1);
  assert.equal(num(camp.order_rate), 1.22);
  assert.equal(num(camp.attributed_orders), 12);
  // Ordered by the money, like the Redo report.
  assert.deepEqual(rows.map((r) => `${r.klaviyo_id}/${r.conversion_metric_id}`),
    ['camp1/MET1', 'camp1/MET2', 'camp2/MET2', 'fmsg1/MET1', 'campQuiet/MET1']);
});

await test('a message measured under two conversion metrics is two labelled rows', async () => {
  const rows = (await run(PERF)).filter((r) => r.klaviyo_id === 'camp1');
  assert.equal(rows.length, 2, 'MET1 and MET2 measure different events: two rows, never one');
  const byMetric = new Map(rows.map((r) => [r.conversion_metric_id, r]));
  assert.equal(num(byMetric.get('MET1').attributed_revenue), 1234.56);
  assert.equal(num(byMetric.get('MET1').window_days), 365);
  assert.equal(num(byMetric.get('MET2').attributed_revenue), 300);
  assert.equal(num(byMetric.get('MET2').window_days), 60, 'the widest window WITHIN each metric');
  // And the older metric's measurement is not dropped: a campaign's best
  // measurement disappearing without explanation would be worse than two rows.
  assert.ok(byMetric.has('MET1') && byMetric.has('MET2'));
});

await test('a window ending before the period is not in it', async () => {
  const rows = await run(PERF);
  assert.ok(rows.every((r) => num(r.sends) !== 7777), 'the out-of-range window leaked in');
});

await test('SMS has no open rate, and a flow message carries its flow', async () => {
  const [flow] = (await run(PERF)).filter((r) => r.klaviyo_id === 'fmsg1' && r.conversion_metric_id === 'MET1');
  assert.equal(flow.open_rate, null, 'Klaviyo reports no opens for SMS: blank, never 0%');
  assert.equal(num(flow.click_rate), 5.1);
  assert.equal(num(flow.order_rate), 2.02);
  assert.equal(flow.flow, 'Welcome');
  assert.equal(num(flow.sending_cost), 12.34);
  assert.equal(flow.kind, 'flow_message');
});

await test('a message that delivered nothing in the window has blank rates, not 0%', async () => {
  const [quiet] = (await run(PERF)).filter((r) => r.klaviyo_id === 'campQuiet');
  assert.equal(quiet.conversion_metric_id, 'MET1');
  assert.equal(num(quiet.delivered), 0);
  assert.equal(quiet.delivery_rate, null);
  assert.equal(quiet.open_rate, null);
  assert.equal(quiet.click_rate, null);
  assert.equal(quiet.order_rate, null);
  assert.equal(num(quiet.attributed_revenue), 50, 'its conversions still landed inside the window');
});

await test('the trend is flows only, by day, inside its own bounds', async () => {
  const rows = await run(TREND);
  // 11-08 appears twice, once per conversion metric: 34.00 measured against
  // MET1 and 10.00 against MET2 are counts of different events, so adding
  // them into one 44.00 day would be the mistake.
  assert.deepEqual(rows.map((r) => `${day(r.day_date)}/${r.conversion_metric_id}`),
    ['2026-11-06/MET1', '2026-11-07/MET1', '2026-11-08/MET1', '2026-11-08/MET2']);
  assert.deepEqual(rows.map((r) => num(r.attributed_revenue)), [25, 40.5, 34, 10]);
  assert.deepEqual(rows.map((r) => num(r.attributed_orders)), [1, 2, 1, 1]);
  assert.equal(num(rows[2].sends), 70);
  assert.equal(num(rows[1].sending_cost), 3.5);
  // No campaign can appear: Klaviyo has no campaign series endpoint, so
  // camp1's 1,234.56 is absent here on purpose.
  assert.ok(rows.every((r) => num(r.attributed_revenue) < 100), 'a campaign total leaked into the daily trend');
});

await test('a custom window respects its own bounds', async () => {
  const rows = await run(TREND, { date_from: '2026-11-07', date_to: '2026-11-08' });
  assert.deepEqual(rows.map((r) => day(r.day_date)), ['2026-11-07', '2026-11-08', '2026-11-08']);
});

await test('Email vs SMS splits the same measurements and agrees with Performance', async () => {
  const rows = await run(SPLIT);
  // Channel AND metric: a metric change must not be summed into one channel.
  assert.deepEqual(rows.map((r) => `${r.channel}/${r.conversion_metric_id}`),
    ['Email/MET1', 'Email/MET2', 'SMS/MET1']);
  const email = rows[0]; const emailNew = rows[1]; const sms = rows[2];
  assert.equal(num(email.messages), 2, 'camp1 and campQuiet under MET1, each once');
  assert.equal(num(email.sends), 1000);
  assert.equal(num(email.attributed_revenue), 1284.56);
  assert.equal(num(emailNew.messages), 2, 'camp1 and camp2 under MET2');
  assert.equal(num(emailNew.attributed_revenue), 500);
  assert.equal(num(sms.messages), 1);
  assert.equal(num(sms.attributed_revenue), 99.5);
  assert.equal(num(sms.sending_cost), 12.34);
  const perf = await run(PERF);
  const perfTotal = perf.reduce((s, r) => s + num(r.attributed_revenue), 0);
  const splitTotal = rows.reduce((s, r) => s + num(r.attributed_revenue), 0);
  assert.ok(Math.abs(perfTotal - splitTotal) < 0.01, `${perfTotal} vs ${splitTotal}`);
});

const checks = await q(`select name, kind, check_sql, tolerance, report_id from silo_report_tieouts
  where report_id in ('${PERF}', '${TREND}', '${SPLIT}') order by report_id`);

await test('every report has its OWN reconciliation, and every tie-out passes', async () => {
  // verify_v2_schema reports any system report without an enabled
  // reconciliation as WEAK, per report id -- two reconciliations spread over
  // three reports is not coverage, so this asserts the rule the verifier
  // applies rather than a total.
  for (const id of [PERF, TREND, SPLIT]) {
    assert.ok(checks.some((c) => c.report_id === id && c.kind === 'reconciliation'),
      `${id} has no reconciliation of its own, which verify_v2_schema reports as WEAK`);
  }
  assert.ok(checks.some((c) => c.kind === 'sanity'), 'the row-count sanity check is still there');
  for (const c of checks) {
    const [r] = await q(c.check_sql);
    assert.notEqual(r.left_value, null, `${c.name}: NO DATA`);
    assert.ok(Math.abs(num(r.left_value) - num(r.right_value)) <= num(c.tolerance),
      `${c.name}: ${r.left_value} vs ${r.right_value}`);
  }
});

await test('the trend reconciliation catches a report that drops a day', async () => {
  // Deleting from the base table could never fail this check: the report
  // reads a view over that same table, so both sides of the comparison would
  // fall together. What it catches is the report DISAGREEING with the table,
  // so that is what is simulated -- the report half narrowed to the last two
  // days while the base half keeps the full 28.
  const c = checks.find((x) => x.report_id === TREND);
  const narrowed = c.check_sql.replace('(select public.silo_business_today()) - 28',
    '(select public.silo_business_today()) - 2');
  const [r] = await q(narrowed);
  assert.equal(num(r.right_value) - num(r.left_value), 25,
    'the day the narrowed report left behind must show up as the difference');
  // And unnarrowed it agrees, so the difference above is the narrowing and
  // not a standing disagreement.
  const [same] = await q(c.check_sql);
  assert.equal(num(same.left_value), num(same.right_value));
});

await test('a changed definition turns its tie-out to NO DATA', async () => {
  await db.exec(`create temp table saved_defn as
      select queries_run from silo_chat_saved_reports where id = '${PERF}'`);
  await db.exec(`update silo_chat_saved_reports set queries_run = array['select 2'] where id = '${PERF}'`);
  // The check runs unchanged: its embedded copy of the query still returns
  // real rows, and the guard is what blanks the answer, which is the point --
  // a tie-out must not keep reporting PASS against a definition it never saw.
  for (const c of checks.filter((x) => x.report_id === PERF)) {
    const [r] = await q(c.check_sql);
    assert.equal(r.left_value, null, `${c.name}: the md5 guard must blank a tie-out whose report was edited`);
  }
  await db.exec(`update silo_chat_saved_reports
      set queries_run = (select queries_run from saved_defn) where id = '${PERF}'`);
  for (const c of checks.filter((x) => x.report_id === PERF)) {
    const [r] = await q(c.check_sql);
    assert.notEqual(r.left_value, null, `${c.name}: and it reports again once the check is refreshed`);
  }
});

// ── The totals report and the Marketing dashboard tiles (20261109230000) ────
// The tiles are loaded beside the REAL bucket-dashboard seed, so an overlap
// with a tile that is already on that board is caught here rather than by
// someone opening the page.
await db.exec(`
create table dashboards(id uuid primary key, company_entity_id uuid, created_by uuid, name text,
  description text, visibility text, filter_state jsonb, source text);
create table dashboard_widgets(id uuid primary key, dashboard_id uuid, company_entity_id uuid,
  created_by uuid, report_id uuid, query_index int, title text, visual_type text,
  visual_config jsonb, layout jsonb, sort_order int);
`);
await db.exec(readFileSync('supabase/migrations/20260925193000_silo_bucket_dashboards.sql', 'utf8'));

const TOTALS = 'c9000000-0000-4000-a000-000000000004';
const MARKETING = '5110da5b-0000-4000-a000-000000000012';
let tiles = readFileSync('supabase/migrations/20261109230000_klaviyo_dashboard_tiles.sql', 'utf8');
const tsub = (from, to) => {
  assert.ok(tiles.includes(from), `mutation ${MUT}: pattern missing`);
  tiles = tiles.split(from).join(to);
};
// The KPI query covering every metric is the failure this report's shape
// exists to prevent: a KPI tile sums its rows.
if (MUT === 'kpi-all-metrics') tsub('  join latest l on l.conversion_metric_id = m.conversion_metric_id\n', '');
if (MUT === 'tile-overlap') tsub(`'{"x":0,"y":27,"w":7,"h":4}'::jsonb, 17`, `'{"x":0,"y":15,"w":7,"h":4}'::jsonb, 17`);
if (MUT === 'tile-wrong-query') tsub(`'c9000000-0000-4000-a000-000000000004',1,\n 'Klaviyo by conversion metric'`,
  `'c9000000-0000-4000-a000-000000000004',0,\n 'Klaviyo by conversion metric'`);
await db.exec(tiles);

const totals = (await q(`select queries_run, parameters, columns_metadata from silo_chat_saved_reports
  where id = '${TOTALS}'`))[0];
const runTotals = async (i, values = {}) => {
  const out = P.substitute(totals.queries_run[i], totals.parameters,
    P.defaultsFor(P.normalizeDeclarations(totals.parameters), values));
  assert.ok(out.sql, out.error);
  return q(out.sql);
};

await test('the KPI query is ONE row -- the latest conversion metric -- and says how many there were', async () => {
  const rows = await runTotals(0);
  assert.equal(rows.length, 1, 'a KPI tile sums its rows, so a second metric here would be added onto the card');
  const [r] = rows;
  assert.equal(r.conversion_metric_id, 'MET1', 'the newest window end, ties broken by id, not an arbitrary pick');
  assert.equal(num(r.metrics_in_period), 2, 'and the board is told there was another metric');
  assert.equal(num(r.messages), 3);
  assert.equal(num(r.sends), 1200, 'the widest window per message, never two windows summed');
  assert.equal(num(r.delivered), 1178);
  assert.equal(num(r.delivery_rate), 98.2);
  assert.equal(num(r.click_rate), 5.9);
  assert.equal(num(r.attributed_orders), 18);
  assert.equal(num(r.attributed_revenue), 1384.06);
  assert.equal(num(r.sending_cost), 12.34);
});

await test('the by-metric query holds every metric and agrees with Performance', async () => {
  const rows = await runTotals(1);
  assert.deepEqual(rows.map((r) => r.conversion_metric_id), ['MET1', 'MET2']);
  assert.equal(num(rows[0].attributed_revenue), 1384.06);
  assert.equal(num(rows[1].attributed_revenue), 500);
  const perfTotal = (await run(PERF)).reduce((a, r) => a + num(r.attributed_revenue), 0);
  assert.equal(rows.reduce((a, r) => a + num(r.attributed_revenue), 0), Math.round(perfTotal * 100) / 100,
    'every metric together is the message list, or one of them has drifted');
});

await test('both totals tie-outs pass, and the KPI one is exact', async () => {
  const cs = await q(`select name, kind, check_sql, tolerance from silo_report_tieouts
    where report_id = '${TOTALS}' order by name`);
  assert.equal(cs.length, 2);
  assert.ok(cs.some((c) => c.kind === 'reconciliation'), 'a row count alone would pass a wrong total');
  for (const c of cs) {
    const [r] = await q(c.check_sql);
    assert.notEqual(r.left_value, null, `${c.name}: NO DATA`);
    assert.ok(Math.abs(num(r.left_value) - num(r.right_value)) <= num(c.tolerance),
      `${c.name}: ${r.left_value} vs ${r.right_value}`);
  }
});

await test('every Klaviyo tile reads a report that exists, by a query that exists', async () => {
  const widgets = await q(`select id, report_id, query_index, title, visual_type, visual_config, layout, sort_order
    from dashboard_widgets where dashboard_id = '${MARKETING}' order by sort_order`);
  const mine = widgets.filter((w) => w.title.includes('Klaviyo'));
  assert.equal(mine.length, 8, 'the section, four KPI tiles, the trend, the message table and the metric table');
  for (const w of mine) {
    if (!w.report_id) continue;
    const [rep] = await q(`select queries_run, columns_metadata from silo_chat_saved_reports where id = '${w.report_id}'`);
    assert.ok(rep, `${w.title}: points at a report that does not exist`);
    assert.ok(w.query_index < rep.queries_run.length, `${w.title}: query_index ${w.query_index} is past the end`);
    const cfg = w.visual_config;
    assert.ok(cfg.empty_message, `${w.title}: a tile with no rows must say why, not render blank`);
    // A tile naming a column the report does not return is a blank card.
    for (const col of (cfg.columns || []).concat(cfg.y_field ? [cfg.y_field] : [], cfg.x_field ? [cfg.x_field] : [])) {
      assert.ok(Object.prototype.hasOwnProperty.call(rep.columns_metadata, col),
        `${w.title}: column ${col} is not in that report's columns_metadata`);
    }
  }
  // The by-metric tile must read the per-metric query, not the KPI one.
  const byMetric = mine.find((w) => w.title === 'Klaviyo by conversion metric');
  assert.equal(byMetric.query_index, 1, 'the KPI query covers one metric by design, so it cannot be this table');
  // Redo's section names its vendor now that two vendors share the board.
  const redo = widgets.find((w) => w.id === 'd0000000-0000-4000-a00c-000000000007');
  assert.equal(redo.title, 'Email and SMS (Redo)');
});

await test('no Klaviyo tile lands on top of a tile already on that board', async () => {
  const widgets = await q(`select title, layout from dashboard_widgets where dashboard_id = '${MARKETING}'`);
  const box = (w) => ({ t: w.title, x: w.layout.x, y: w.layout.y, w: w.layout.w, h: w.layout.h });
  const boxes = widgets.map(box);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j];
      const hits = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!hits, `${a.t} overlaps ${b.t}`);
      assert.ok(a.x + a.w <= 12, `${a.t} runs past the 12-column grid`);
    }
  }
  assert.equal(new Set(widgets.map((w) => `${w.title}`)).size, widgets.length, 'two tiles share a title');
});

console.log(`\n${passed} passed`);
