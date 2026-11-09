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
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/klaviyo-silo-reports-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.KLAVIYO_REPORTS_MUTATION || '';
assert.ok(['', 'sum-windows', 'narrowest-window', 'sms-opens', 'zero-not-blank',
  'trend-unbounded', 'split-sums-windows', 'no-guard'].includes(MUT), `Unknown mutation ${MUT}`);

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
 -- A window that ends BEFORE the period: out of range entirely.
 ('campaign', 'camp1', 'email', '2026-08-12T00:00:00+00:00', '2026-10-11T23:59:59+00:00',
  'MET1', 7777, 7777, 7777, 7777, 7777, 7777.00, 7777, null);

-- Flow days: three inside the period, one outside.
insert into klaviyo_flow_daily(klaviyo_id, channel, day_date, conversion_metric_id,
  recipients, delivered, clicks_unique, conversions, conversion_value, text_message_spend)
values ('fmsg1', 'sms', '2026-11-06', 'MET1', 50, 49, 3, 1, 25.00, 3.00),
       ('fmsg1', 'sms', '2026-11-07', 'MET1', 60, 59, 4, 2, 40.50, 3.50),
       ('fmsg1', 'sms', '2026-11-08', 'MET1', 70, 69, 3, 1, 34.00, 4.00),
       ('fmsg1', 'sms', '2026-10-01', 'MET1', 999, 999, 999, 999, 9999.00, 99.00);
`);

// ── the migration under test, with the mutation applied ─────────────────────
let sql = readFileSync('supabase/migrations/20261109210000_klaviyo_silo_reports.sql', 'utf8');
const DISTINCT = 'distinct on (kind, klaviyo_id, channel)';
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
  // camp1, fmsg1 and campQuiet -- three messages, five stored rows.
  assert.equal(rows.length, 3, 'one row per message and channel, not one per stored window');
  const camp = rows.find((r) => r.klaviyo_id === 'camp1');
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
  assert.deepEqual(rows.map((r) => r.klaviyo_id), ['camp1', 'fmsg1', 'campQuiet']);
});

await test('a window ending before the period is not in it', async () => {
  const rows = await run(PERF);
  assert.ok(rows.every((r) => num(r.sends) !== 7777), 'the out-of-range window leaked in');
});

await test('SMS has no open rate, and a flow message carries its flow', async () => {
  const [flow] = (await run(PERF)).filter((r) => r.klaviyo_id === 'fmsg1');
  assert.equal(flow.open_rate, null, 'Klaviyo reports no opens for SMS: blank, never 0%');
  assert.equal(num(flow.click_rate), 5.1);
  assert.equal(num(flow.order_rate), 2.02);
  assert.equal(flow.flow, 'Welcome');
  assert.equal(num(flow.sending_cost), 12.34);
  assert.equal(flow.kind, 'flow_message');
});

await test('a message that delivered nothing in the window has blank rates, not 0%', async () => {
  const [quiet] = (await run(PERF)).filter((r) => r.klaviyo_id === 'campQuiet');
  assert.equal(num(quiet.delivered), 0);
  assert.equal(quiet.delivery_rate, null);
  assert.equal(quiet.open_rate, null);
  assert.equal(quiet.click_rate, null);
  assert.equal(quiet.order_rate, null);
  assert.equal(num(quiet.attributed_revenue), 50, 'its conversions still landed inside the window');
});

await test('the trend is flows only, by day, inside its own bounds', async () => {
  const rows = await run(TREND);
  assert.deepEqual(rows.map((r) => day(r.day_date)), ['2026-11-06', '2026-11-07', '2026-11-08']);
  assert.deepEqual(rows.map((r) => num(r.attributed_revenue)), [25, 40.5, 34]);
  assert.deepEqual(rows.map((r) => num(r.attributed_orders)), [1, 2, 1]);
  assert.equal(num(rows[2].sends), 70);
  assert.equal(num(rows[1].sending_cost), 3.5);
  // No campaign can appear: Klaviyo has no campaign series endpoint, so
  // camp1's 1,234.56 is absent here on purpose.
  assert.ok(rows.every((r) => num(r.attributed_revenue) < 100), 'a campaign total leaked into the daily trend');
});

await test('a custom window respects its own bounds', async () => {
  const rows = await run(TREND, { date_from: '2026-11-07', date_to: '2026-11-08' });
  assert.deepEqual(rows.map((r) => day(r.day_date)), ['2026-11-07', '2026-11-08']);
});

await test('Email vs SMS splits the same measurements and agrees with Performance', async () => {
  const rows = await run(SPLIT);
  assert.deepEqual(rows.map((r) => r.channel), ['Email', 'SMS']);
  const email = rows[0]; const sms = rows[1];
  assert.equal(num(email.messages), 2, 'camp1 and campQuiet, each once');
  assert.equal(num(email.sends), 1000);
  assert.equal(num(email.attributed_revenue), 1284.56);
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

await test('every report carries a tie-out, and every tie-out passes', async () => {
  assert.equal(checks.length, 3);
  assert.equal(new Set(checks.map((c) => c.report_id)).size, 3, 'one per report');
  assert.ok(checks.some((c) => c.kind === 'sanity'));
  assert.ok(checks.filter((c) => c.kind === 'reconciliation').length >= 2);
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
  await db.exec(`update silo_chat_saved_reports set queries_run = array['select 2'] where id = '${PERF}'`);
  const c = checks.find((x) => x.report_id === PERF);
  const [r] = await q(c.check_sql.replace(/with report as materialized \([\s\S]*?\) select/, 'with report as materialized (select 1) select'));
  assert.equal(r.left_value, null, 'the md5 guard must blank a tie-out whose report was edited');
});

console.log(`\n${passed} passed`);
