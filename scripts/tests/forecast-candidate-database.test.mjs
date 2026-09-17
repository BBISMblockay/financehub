// Demand Planner candidate regressions against a REAL PostgreSQL (PGlite):
// the committed migration, role switching and RLS -- not a mock, and not
// always the service role.
//
// Source specification: saved report f98754f7-47a6-4eeb-8a8b-eece9a069432,
// frozen candidate Candidate_YoY_Shift_v1.
//
// What earns its place here:
//   * the FROZEN RUN reproduced from Baseballism's real Youth series -- the
//     spec's 115,699 / 59,124 / 4,297 -> 7,735, computed by the shipped
//     function rather than asserted from a series built to produce it;
//   * the RETROSPECTIVE 20.2% / -13.9%, reproduced by executing the shipped
//     scripts/sql/forecast_candidate_backtest.sql over that same real series,
//     together with the two longer windows that score far worse -- the spread
//     is the reason the candidate is being evaluated prospectively at all;
//   * the properties no diff shows: that a frozen row cannot be edited even by
//     the service role, that re-running does not recompute, that a month
//     landing after a cutoff cannot change a forecast made at it, and that
//     three cycles out of order are not three consecutive cycles.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/forecast-candidate-database.test.mjs
//
// Mutations (each must fail at least one assertion):
//   FC_DB_MUTATION=no-clamp             ratio clamp removed
//   FC_DB_MUTATION=lookahead            window reads month_start <= cutoff
//   FC_DB_MUTATION=zero-denominator-ok  non-positive denominator no longer refused
//   FC_DB_MUTATION=absent-is-zero       missing months no longer make a cutoff ineligible
//   FC_DB_MUTATION=append-only-off      immutability trigger removed
//   FC_DB_MUTATION=recompute-on-rerun   re-running upserts instead of returning the frozen row
//   FC_DB_MUTATION=no-tenant-check      the tenant gate always passes
//   FC_DB_MUTATION=pooled-only-gate     per-cycle "consistently improve" gate dropped
//   FC_DB_MUTATION=runs-need-not-be-consecutive  any 3 scorable cycles count as a run
//   FC_DB_MUTATION=absent-baseline-passes        a missing baseline counts as beaten
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import {
  YOUTH_MONTHLY_DEMAND,
  SYNCED_THROUGH,
  FROZEN_FIRST_RUN,
  RETROSPECTIVE_SCORES,
} from './fixtures/youth-monthly-demand.mjs';
import { bindBacktestSql, runForecastCandidate, formatSummary } from '../lib/forecast-candidate-core.mjs';

const root = new URL('../../', import.meta.url);
const MIGRATION = 'supabase/migrations/20260917140000_forecast_candidate_ledger.sql';
const MUTATIONS = {
  'no-clamp': [['least(p_clamp_high, greatest(p_clamp_low, v_raw))', 'v_raw']],
  // BOTH bounds, because the guard is deliberately two-layered: the base CTE
  // and each window's own predicate. Mutating either alone still refuses the
  // cutoff month, which is the redundancy working -- so a mutation that claims
  // to remove the look-ahead guard has to remove all of it.
  lookahead: [
    ['and r.month_start < p_cutoff_date', 'and r.month_start <= p_cutoff_date'],
    ['where month_start >= v_recent_start and month_start < p_cutoff_date),\n    (select count(*)::integer      from visible where month_start >= v_recent_start and month_start < p_cutoff_date)',
     'where month_start >= v_recent_start and month_start <= p_cutoff_date),\n    (select count(*)::integer      from visible where month_start >= v_recent_start and month_start <= p_cutoff_date)'],
  ],
  'zero-denominator-ok': [['if v_prior <= 0 then', 'if false then']],
  'absent-is-zero': [['if v_recent_n <> 3 then', 'if false then'], ['if v_prior_n <> 3 then', 'if false then']],
  // Neuter the trigger body rather than the CREATE TRIGGER: a BEFORE TRUNCATE
  // trigger cannot be FOR EACH ROW, so mutating the header fails to apply the
  // migration at all and every assertion "passes" by never running.
  'append-only-off': [['begin\n  if tg_op = \'DELETE\' then', 'begin\n  return case when tg_op = \'DELETE\' then old else new end;\n  if tg_op = \'DELETE\' then']],
  'recompute-on-rerun': [['  if found then\n    return query select', '  if false then\n    return query select']],
  'no-tenant-check': [['and p_company_entity_id = public.active_company_id();', 'and true;']],
  'pooled-only-gate': [['(bc.wape is not null and a.worst_cycle_wape is not null and a.worst_cycle_wape < bc.wape) as g_every', '(bc.wape is not null and a.pooled_wape is not null and a.pooled_wape < bc.wape) as g_every']],
  'runs-need-not-be-consecutive': [['(s.cutoff_date - (row_number() over (order by s.cutoff_date) * interval \'1 month\'))::date as island', "date '2000-01-01' as island"]],
  'absent-baseline-passes': [['coalesce(b.n, 0) >= p_min_cycles as g_cycles', 'coalesce(b.n, 0) >= p_min_cycles as g_cycles'], ['(bc.wape is not null and bp.wape is not null and a.pooled_wape is not null\n        and a.pooled_wape < bc.wape and a.pooled_wape < bp.wape) as g_pooled', '(coalesce(a.pooled_wape < bc.wape, true) and coalesce(a.pooled_wape < bp.wape, true)) as g_pooled'], ['(bc.wape is not null and a.worst_cycle_wape is not null and a.worst_cycle_wape < bc.wape) as g_every', 'coalesce(a.worst_cycle_wape < bc.wape, true) as g_every']],
};
const mutation = process.env.FC_DB_MUTATION || '';
assert.ok(mutation === '' || mutation in MUTATIONS, `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
const scalar = async (sql, params = []) => Object.values(await first(sql, params))[0];
const num = (v) => (v === null || v === undefined ? null : Number(v));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); if (error.query) delete error.query; throw error; }
}
async function refused(fn, pattern, label) {
  let message = null;
  try { await fn(); } catch (error) { message = error.message; }
  assert.ok(message !== null, `${label}: expected a refusal, got success`);
  assert.match(message, pattern, `${label}: ${message}`);
}
async function asRole(role, user, fn) {
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
}
const asService = (fn) => asRole('service_role', '', fn);

// ── Schema ──────────────────────────────────────────────────────────────────
await db.exec('create extension if not exists pgcrypto;');
await db.exec(await readFile(new URL('scripts/tests/forecast-db-bootstrap.sql', root), 'utf8'));

let migrationSql = await readFile(new URL(MIGRATION, root), 'utf8');
for (const [from, to] of MUTATIONS[mutation] || []) {
  assert.ok(migrationSql.includes(from), `mutation ${mutation}: anchor not found: ${from.slice(0, 60)}`);
  migrationSql = migrationSql.replace(from, to);
}
await db.exec(migrationSql);

// ── Fixtures ────────────────────────────────────────────────────────────────
const BASEBALLISM = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const OTHER_CO = randomUUID();
const SYNTH_CO = randomUUID();
const planner = randomUUID();
const outsider = randomUUID();

async function makeCompany(id, title, ownerId) {
  await q('insert into public.entities (id, title) values ($1, $2) on conflict do nothing', [id, title]);
  if (ownerId) {
    await q('insert into auth.users (id) values ($1) on conflict do nothing', [ownerId]);
    await q('insert into public.profiles (id, email, role, active_company_id) values ($1, $2, $3, $4)',
      [ownerId, `${ownerId}@example.test`, 'admin', id]);
  }
}
async function sale(company, day, productType, units) {
  await q('insert into public.sales_by_day (company_entity_id, day_date, product_type, total_quantity_sold) values ($1,$2,$3,$4)',
    [company, day, productType, units]);
}
const refresh = () => db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');

await makeCompany(BASEBALLISM, 'Baseballism', planner);
await makeCompany(OTHER_CO, 'Other Co', outsider);
await makeCompany(SYNTH_CO, 'Synthetic Co', null);

// The migration's baseline seed runs before entities exist in this fixture, so
// apply the same two rows here. Values are copied from the migration itself.
await q(`insert into public.forecast_model_baselines
 (company_entity_id, baseline_key, sku_category, horizon_days, wape, bias, measurement_windows, measured_from, measured_to, source_report_id, note)
 values ($1,'portfolio','ALL TESTED TYPES',30,0.3450,-0.0530,216,'2026-03-01','2026-09-01','f98754f7-47a6-4eeb-8a8b-eece9a069432','portfolio holdout'),
        ($1,'category','Youth',30,0.4290,-0.2600,6,'2026-03-01','2026-09-01','f98754f7-47a6-4eeb-8a8b-eece9a069432','Youth holdout')`,
  [BASEBALLISM]);

// Baseballism's REAL Youth series, one sale row per month (the rollup is by
// month, so the day inside it only has to fall in the right month).
for (const [monthStart, units] of YOUTH_MONTHLY_DEMAND) {
  await sale(BASEBALLISM, `${monthStart.slice(0, 8)}05`, 'Youth', units);
}
// Production's sync coverage on the day the series was read.
await sale(BASEBALLISM, SYNCED_THROUGH, 'Youth', 0);
// A different tenant with a different Youth series, so a leak would be visible
// as a wrong NUMBER and not merely as a wrong row count.
for (const [monthStart] of YOUTH_MONTHLY_DEMAND) {
  await sale(OTHER_CO, `${monthStart.slice(0, 8)}05`, 'Youth', 777);
}
await refresh();

// ── 1. The frozen run, reproduced from real source data ─────────────────────
await test('frozen run reproduces the specification exactly from real source data', async () => {
  const r = await asService(() => first(
    `select eligible, recent_demand, prior_demand, prior_year_target_demand,
            raw_ratio, clamped_ratio, ratio_was_clamped, forecast_qty,
            recent_window_start, recent_window_end, prior_window_start, prior_window_end, prior_year_target_month
       from public.forecast_yoy_shift_v1($1, $2, 'Youth')`,
    [BASEBALLISM, FROZEN_FIRST_RUN.cutoff]));
  assert.equal(r.eligible, true);
  assert.equal(num(r.recent_demand), FROZEN_FIRST_RUN.recentDemand);
  assert.equal(num(r.prior_demand), FROZEN_FIRST_RUN.priorDemand);
  assert.equal(num(r.prior_year_target_demand), FROZEN_FIRST_RUN.priorYearTargetDemand);
  // The raw ratio EXCEEDS the cap, which is the fact the frozen 1.80 records.
  assert.ok(num(r.raw_ratio) > 1.80, `raw ratio ${r.raw_ratio} should exceed the cap`);
  assert.equal(num(r.clamped_ratio), FROZEN_FIRST_RUN.clampedRatio);
  assert.equal(r.ratio_was_clamped, true);
  assert.equal(num(r.forecast_qty), FROZEN_FIRST_RUN.forecastQty);
});

// ── 2. Exact date-window boundaries ─────────────────────────────────────────
await test('windows are t-3..t-1, t-15..t-13 and t-12, to the exact month', async () => {
  const r = await asService(() => first(
    `select recent_window_start, recent_window_end, prior_window_start, prior_window_end, prior_year_target_month
       from public.forecast_yoy_shift_v1($1, '2026-09-01', 'Youth')`, [BASEBALLISM]));
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  assert.equal(iso(r.recent_window_start), '2026-06-01');      // t-3
  assert.equal(iso(r.recent_window_end), '2026-09-01');        // exclusive: t
  assert.equal(iso(r.prior_window_start), '2025-06-01');       // t-15
  assert.equal(iso(r.prior_window_end), '2025-09-01');         // exclusive: t-12
  assert.equal(iso(r.prior_year_target_month), '2025-09-01');  // t-12
});

await test('a month one step outside a window is excluded, one step inside is counted', async () => {
  // A synthetic company so the real series stays untouched. 24 months of 10.
  for (let i = 0; i < 26; i++) {
    const m = new Date(Date.UTC(2024, 6 + i, 5));
    await sale(SYNTH_CO, m.toISOString().slice(0, 10), 'Boundary', 10);
  }
  await sale(SYNTH_CO, '2026-08-31', 'Boundary', 0);
  await refresh();
  const cutoff = '2026-07-01';
  const base = await asService(() => first(
    'select recent_demand, prior_demand from public.forecast_yoy_shift_v1($1, $2, $3)', [SYNTH_CO, cutoff, 'Boundary']));
  assert.equal(num(base.recent_demand), 30, 'three months of 10 in t-3..t-1');

  // 2026-03-31 is the last day of t-4: outside the recent window.
  await sale(SYNTH_CO, '2026-03-31', 'Boundary', 500);
  await refresh();
  assert.equal(num((await asService(() => first(
    'select recent_demand from public.forecast_yoy_shift_v1($1, $2, $3)', [SYNTH_CO, cutoff, 'Boundary']))).recent_demand),
    30, 'a month before t-3 must not enter the recent window');

  // 2026-04-01 is the first day of t-3: inside.
  await sale(SYNTH_CO, '2026-04-01', 'Boundary', 7);
  await refresh();
  assert.equal(num((await asService(() => first(
    'select recent_demand from public.forecast_yoy_shift_v1($1, $2, $3)', [SYNTH_CO, cutoff, 'Boundary']))).recent_demand),
    37, 'the first day of t-3 is inside the recent window');
});

// ── 3. No look-ahead leakage ────────────────────────────────────────────────
await test('nothing at or after the cutoff can change the forecast made at it', async () => {
  const before = await asService(() => first(
    'select recent_demand, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)', [SYNTH_CO, '2026-07-01', 'Boundary']));
  // A very large sale ON the cutoff day, and another a month later.
  await sale(SYNTH_CO, '2026-07-01', 'Boundary', 99999);
  await sale(SYNTH_CO, '2026-08-15', 'Boundary', 99999);
  await refresh();
  const after = await asService(() => first(
    'select recent_demand, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)', [SYNTH_CO, '2026-07-01', 'Boundary']));
  assert.equal(num(after.recent_demand), num(before.recent_demand), 'the cutoff month must not enter its own inputs');
  assert.equal(num(after.forecast_qty), num(before.forecast_qty));
});

await test('the ledger refuses a row whose windows reach past its cutoff', async () => {
  await refused(() => asService(() => q(
    `insert into public.forecast_candidate_ledger
      (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days, forecast_qty,
       horizon_start_date, horizon_end_date, recent_window_start, recent_window_end, recent_demand,
       prior_window_start, prior_window_end, prior_demand, prior_year_target_month, prior_year_target_demand,
       raw_ratio, clamped_ratio, ratio_clamp_low, ratio_clamp_high, ratio_was_clamped,
       method_version, candidate_spec, source_relation)
     values ($1,'Leaky','2026-09-01','Youth',30,10,'2026-09-01','2026-10-01',
             '2026-06-01','2026-10-01',1,'2025-06-01','2025-09-01',1,'2025-09-01',1,
             1,1,0.6,1.8,false,'v','{}'::jsonb,'x')`, [SYNTH_CO])),
    /forecast_ledger_no_lookahead/, 'look-ahead window accepted by the table');
});

// ── 4. Ratio clamping at both limits ────────────────────────────────────────
async function clampSeries(category, priorUnits, recentUnits) {
  // 26 months so both windows are fully populated, then override the two
  // windows that decide the ratio.
  for (let i = 0; i < 26; i++) {
    const m = new Date(Date.UTC(2024, 6 + i, 5));
    await sale(SYNTH_CO, m.toISOString().slice(0, 10), category, 10);
  }
  for (const mo of ['2025-04', '2025-05', '2025-06']) await sale(SYNTH_CO, `${mo}-20`, category, priorUnits - 10);
  for (const mo of ['2026-04', '2026-05', '2026-06']) await sale(SYNTH_CO, `${mo}-20`, category, recentUnits - 10);
  await refresh();
}

await test('ratio clamps at the 1.80 ceiling and the forecast uses the clamped value', async () => {
  await clampSeries('ClampHigh', 100, 100000);
  const r = await asService(() => first(
    'select raw_ratio, clamped_ratio, ratio_was_clamped, prior_year_target_demand, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'ClampHigh']));
  assert.ok(num(r.raw_ratio) > 1.80, `raw ${r.raw_ratio}`);
  assert.equal(num(r.clamped_ratio), 1.80);
  assert.equal(r.ratio_was_clamped, true);
  assert.equal(num(r.forecast_qty), Math.round(num(r.prior_year_target_demand) * 1.80));
});

await test('ratio clamps at the 0.60 floor and the forecast uses the clamped value', async () => {
  await clampSeries('ClampLow', 100000, 100);
  const r = await asService(() => first(
    'select raw_ratio, clamped_ratio, ratio_was_clamped, prior_year_target_demand, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'ClampLow']));
  assert.ok(num(r.raw_ratio) < 0.60, `raw ${r.raw_ratio}`);
  assert.equal(num(r.clamped_ratio), 0.60);
  assert.equal(r.ratio_was_clamped, true);
  assert.equal(num(r.forecast_qty), Math.round(num(r.prior_year_target_demand) * 0.60));
});

await test('an extreme raw ratio is stored, not overflowed', async () => {
  // The raw ratio is unbounded: one unit in the prior-year window against
  // millions in the recent one. The clamp keeps the FORECAST sane, but the raw
  // value is kept as evidence of how far outside the band the series was, so
  // its column has to be wide enough to hold it. At numeric(12,6) this INSERT
  // failed with a numeric overflow.
  for (let i = 0; i < 26; i++) {
    const m = new Date(Date.UTC(2024, 6 + i, 5));
    await sale(SYNTH_CO, m.toISOString().slice(0, 10), 'Extreme', 10);
  }
  for (const mo of ['2025-04', '2025-05', '2025-06']) await sale(SYNTH_CO, `${mo}-20`, 'Extreme', -9);
  for (const mo of ['2026-04', '2026-05', '2026-06']) await sale(SYNTH_CO, `${mo}-20`, 'Extreme', 3000000);
  await sale(SYNTH_CO, '2026-09-02', 'Extreme', 0);
  await refresh();
  const r = await asService(() => first(
    'select raw_ratio, clamped_ratio, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'Extreme']));
  assert.ok(num(r.raw_ratio) > 1000000, `raw ratio ${r.raw_ratio} should be enormous`);
  assert.equal(num(r.clamped_ratio), 1.80);
  const w = await asService(() => first(
    "select action, reason from public.record_forecast_candidate_run($1, '2026-07-01', 'Extreme')", [SYNTH_CO]));
  assert.equal(w.action, 'inserted', `the ledger must accept it: ${w.reason}`);
  assert.equal(num(await asService(() => scalar(
    "select raw_ratio from public.forecast_candidate_ledger where sku_category = 'Extreme'"))), num(r.raw_ratio));
});

await test('a ratio inside the bounds is not clamped', async () => {
  await clampSeries('ClampNone', 100, 120);
  const r = await asService(() => first(
    'select raw_ratio, clamped_ratio, ratio_was_clamped from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'ClampNone']));
  assert.equal(r.ratio_was_clamped, false);
  assert.equal(num(r.clamped_ratio), num(r.raw_ratio));
  assert.ok(num(r.raw_ratio) > 0.60 && num(r.raw_ratio) < 1.80);
});

// ── 5. Zero denominator, absent months, negative base ───────────────────────
await test('a zero-sum prior-year window is refused, never clamped to the ceiling', async () => {
  for (let i = 0; i < 26; i++) {
    const m = new Date(Date.UTC(2024, 6 + i, 5));
    await sale(SYNTH_CO, m.toISOString().slice(0, 10), 'ZeroDenom', i >= 9 && i <= 11 ? 0 : 10);
  }
  await refresh();
  const r = await asService(() => first(
    'select eligible, ineligible_reason, prior_demand, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'ZeroDenom']));
  assert.equal(num(r.prior_demand), 0, 'the window is recorded and sums to zero');
  assert.equal(r.eligible, false, 'a zero denominator must not produce a forecast');
  assert.equal(r.forecast_qty, null);
  assert.match(r.ineligible_reason, /positive denominator/);
});

await test('a negative prior-year window is refused too', async () => {
  for (let i = 0; i < 26; i++) {
    const m = new Date(Date.UTC(2024, 6 + i, 5));
    await sale(SYNTH_CO, m.toISOString().slice(0, 10), 'NegDenom', i >= 9 && i <= 11 ? -5 : 10);
  }
  await refresh();
  const r = await asService(() => first(
    'select eligible, ineligible_reason from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'NegDenom']));
  assert.equal(r.eligible, false);
  assert.match(r.ineligible_reason, /positive denominator/);
});

await test('a MISSING month makes a cutoff ineligible; it is never summed as zero', async () => {
  // 2024-01-01's prior-year window is 2022-10..2022-12 and the real series has
  // no 2022-10 at all. Two of three months are present and sum to 1,551 -- a
  // rule that summed what was there would happily forecast from it.
  const r = await asService(() => first(
    'select eligible, ineligible_reason, prior_demand from public.forecast_yoy_shift_v1($1, $2, \'Youth\')',
    [BASEBALLISM, '2024-01-01']));
  assert.equal(r.eligible, false, 'a two-of-three window must not be forecast from');
  assert.match(r.ineligible_reason, /prior-year window .* has 2 of 3 months recorded/);
});

await test('a RECORDED zero base is kept as zero, not treated as missing', async () => {
  for (let i = 0; i < 26; i++) {
    const m = new Date(Date.UTC(2024, 6 + i, 5));
    // i == 12 is 2025-07, which is t-12 for the 2026-07-01 cutoff.
    await sale(SYNTH_CO, m.toISOString().slice(0, 10), 'ZeroBase', i === 12 ? 0 : 10);
  }
  await refresh();
  const r = await asService(() => first(
    'select eligible, prior_year_target_demand, forecast_qty from public.forecast_yoy_shift_v1($1, $2, $3)',
    [SYNTH_CO, '2026-07-01', 'ZeroBase']));
  assert.equal(r.eligible, true, 'a recorded zero is data');
  assert.equal(num(r.prior_year_target_demand), 0);
  assert.equal(num(r.forecast_qty), 0, 'zero times any ratio is zero, and that is the answer');
});

// ── 6. Idempotent ledger writes ─────────────────────────────────────────────
await test('re-running a cutoff returns the frozen row and does not recompute', async () => {
  const one = await asService(() => first(
    "select action, forecast_qty, ledger_id from public.record_forecast_candidate_run($1, '2026-09-01')", [BASEBALLISM]));
  assert.equal(one.action, 'inserted');
  assert.equal(num(one.forecast_qty), FROZEN_FIRST_RUN.forecastQty);

  // Move the world underneath it. It has to be the PRIOR-YEAR TARGET month
  // that moves, not the recent window: the recent window's ratio is already
  // above the 1.80 cap, so adding to it changes nothing a recomputation would
  // show, and a test perturbing it would pass against a version that DID
  // recompute. Found by mutation testing, not by reading the test.
  await sale(BASEBALLISM, '2025-09-20', 'Youth', 1000);
  await refresh();
  const wouldBeNow = await asService(() => first(
    "select forecast_qty from public.forecast_yoy_shift_v1($1, '2026-09-01', 'Youth')", [BASEBALLISM]));
  assert.notEqual(num(wouldBeNow.forecast_qty), FROZEN_FIRST_RUN.forecastQty,
    'the fixture must actually change the answer, or this test proves nothing');

  const two = await asService(() => first(
    "select action, forecast_qty, ledger_id, reason from public.record_forecast_candidate_run($1, '2026-09-01')", [BASEBALLISM]));
  assert.equal(two.action, 'existing');
  assert.equal(two.ledger_id, one.ledger_id);
  assert.equal(num(two.forecast_qty), FROZEN_FIRST_RUN.forecastQty, 'a re-run must not restate a frozen forecast');
  assert.match(two.reason, /^frozen at /, 'the short-circuit path, not a recompute that happened to collide');
  assert.equal(num(await asService(() => scalar(
    'select count(*)::int from public.forecast_candidate_ledger where company_entity_id = $1', [BASEBALLISM]))), 1);
  // The stored provenance is frozen too, not just the headline number.
  assert.equal(num(await asService(() => scalar(
    "select prior_year_target_demand from public.forecast_candidate_ledger where cutoff_date = '2026-09-01'"))),
    FROZEN_FIRST_RUN.priorYearTargetDemand);

  // Put the series back.
  await q("delete from public.sales_by_day where company_entity_id = $1 and day_date = '2025-09-20'", [BASEBALLISM]);
  await refresh();
});

await test('a duplicate identity is refused by the unique index, even for the service role', async () => {
  const row = await asService(() => first(
    'select * from public.forecast_candidate_ledger where company_entity_id = $1 limit 1', [BASEBALLISM]));
  await refused(() => asService(() => q(
    `insert into public.forecast_candidate_ledger
      (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days, forecast_qty,
       horizon_start_date, horizon_end_date, recent_window_start, recent_window_end, recent_demand,
       prior_window_start, prior_window_end, prior_demand, prior_year_target_month, prior_year_target_demand,
       raw_ratio, clamped_ratio, ratio_clamp_low, ratio_clamp_high, ratio_was_clamped,
       method_version, candidate_spec, source_relation)
     values ($1,$2,$3,$4,$5,999,$3,'2026-10-01','2026-06-01','2026-09-01',1,
             '2025-06-01','2025-09-01',1,'2025-09-01',1,1,1,0.6,1.8,false,'v','{}'::jsonb,'x')`,
    [row.company_entity_id, row.candidate_id, row.cutoff_date, row.sku_category, row.horizon_days])),
    /forecast_candidate_ledger_identity_uq|duplicate key/, 'duplicate cutoff accepted');
});

await test('a cutoff whose prior month is not fully synced is deferred, not frozen early', async () => {
  const r = await asService(() => first(
    "select action, reason from public.record_forecast_candidate_run($1, '2026-10-01')", [BASEBALLISM]));
  assert.equal(r.action, 'deferred', 'October needs complete September data');
  assert.match(r.reason, /synced through/);
  assert.equal(num(await asService(() => scalar(
    "select count(*)::int from public.forecast_candidate_ledger where cutoff_date = '2026-10-01'"))), 0);
});

await test('an ineligible cutoff writes no row at all', async () => {
  const r = await asService(() => first(
    "select action, reason from public.record_forecast_candidate_run($1, '2024-01-01')", [BASEBALLISM]));
  assert.equal(r.action, 'skipped');
  assert.equal(num(await asService(() => scalar(
    "select count(*)::int from public.forecast_candidate_ledger where cutoff_date = '2024-01-01'"))), 0,
    'a skipped cutoff must be ABSENT, not a row of nulls');
});

// ── 7. Immutability of frozen runs ──────────────────────────────────────────
await test('a frozen forecast cannot be updated or deleted, even by the service role', async () => {
  const id = await asService(() => scalar("select id from public.forecast_candidate_ledger where cutoff_date = '2026-09-01'"));
  await refused(() => asService(() => q('update public.forecast_candidate_ledger set forecast_qty = 1 where id = $1', [id])),
    /append-only/, 'forecast_qty was editable');
  await refused(() => asService(() => q('update public.forecast_candidate_ledger set cutoff_date = $2 where id = $1', [id, '2026-08-01'])),
    /append-only/, 'cutoff_date was editable');
  await refused(() => asService(() => q('delete from public.forecast_candidate_ledger where id = $1', [id])),
    /append-only/, 'the row was deletable');
  assert.equal(num(await asService(() => scalar('select forecast_qty from public.forecast_candidate_ledger where id = $1', [id]))),
    FROZEN_FIRST_RUN.forecastQty);
});

await test('voiding is the one permitted mutation, requires a reason, and cannot smuggle an edit', async () => {
  const id = await asService(() => scalar("select id from public.forecast_candidate_ledger where cutoff_date = '2026-09-01'"));
  await refused(() => asService(() => q('select public.void_forecast_candidate_run($1, $2)', [id, 'from a job'])),
    /permission denied/, 'the service role could void a frozen forecast');
  await refused(() => asRole('authenticated', outsider, () => q(
    'select public.void_forecast_candidate_run($1, $2)', [id, 'not mine'])),
    /not authorized/, 'another tenant could void this forecast');
  await refused(() => asRole('authenticated', planner, () => q(
    'select public.void_forecast_candidate_run($1, $2)', [id, '  '])),
    /reason is required/, 'voided with a blank reason');
  // An UPDATE that sets voided_at AND changes a number is refused outright.
  await refused(() => asService(() => q(
    'update public.forecast_candidate_ledger set voided_at = now(), void_reason = $2, forecast_qty = 1 where id = $1',
    [id, 'sneaky'])), /may not alter any other column/, 'a void carried an edit');

  assert.equal(await asRole('authenticated', planner, () => scalar(
    'select public.void_forecast_candidate_run($1, $2)', [id, 'test void'])), true);
  const row = await asService(() => first('select forecast_qty, void_reason from public.forecast_candidate_ledger where id = $1', [id]));
  assert.equal(num(row.forecast_qty), FROZEN_FIRST_RUN.forecastQty, 'a void keeps the numbers');
  assert.equal(row.void_reason, 'test void');
  await refused(() => asRole('authenticated', planner, () => q(
    'select public.void_forecast_candidate_run($1, $2)', [id, 'again'])),
    /already voided/, 'a voided row was voided twice');

  // Leave the ledger clean for the tests below. Note what this took: the
  // trigger has to be DISABLED, which needs table ownership -- the service
  // role cannot do it. That is the immutability guarantee holding even here.
  await q('alter table public.forecast_candidate_ledger disable trigger forecast_candidate_ledger_append_only');
  await q('delete from public.forecast_candidate_ledger');
  await q('alter table public.forecast_candidate_ledger enable trigger forecast_candidate_ledger_append_only');
  assert.equal(num(await scalar('select count(*)::int from public.forecast_candidate_ledger')), 0);
});

// ── 8. Tenant isolation ─────────────────────────────────────────────────────
await test('a signed-in user cannot evaluate or list cycles for another company', async () => {
  // These two ARE reachable from a browser, so they carry the tenant gate.
  await refused(() => asRole('authenticated', outsider, () => q(
    'select * from public.evaluate_forecast_candidate($1)', [BASEBALLISM])),
    /not authorized/, 'cross-tenant evaluation allowed');
  await refused(() => asRole('authenticated', outsider, () => q(
    'select * from public.forecast_candidate_cycles($1)', [BASEBALLISM])),
    /not authorized/, 'cross-tenant cycle listing allowed');
  // ...including for the caller's own company id spelled differently: the gate
  // compares against active_company_id(), not against anything passed in.
  const mine = await asRole('authenticated', outsider, () => first(
    'select cycles_written from public.evaluate_forecast_candidate($1)', [OTHER_CO]));
  assert.equal(Number(mine.cycles_written), 0, 'their own company is allowed and simply has no rows');
});

await test('the engine functions are not reachable from a browser at all', async () => {
  // Authorization here is the EXECUTE grant, not an in-function check. That
  // distinction is the fix for a real hole: these were SECURITY DEFINER and
  // asked pg_has_role(current_user, 'service_role') -- which inside a definer
  // function is the OWNER, so it answered yes for every signed-in user.
  for (const call of [
    "select * from public.forecast_yoy_shift_v1($1, '2026-09-01', 'Youth')",
    'select public.forecast_actuals_matured_through($1)',
    "select * from public.record_forecast_candidate_run($1, '2026-09-01')",
  ]) {
    await refused(() => asRole('authenticated', planner, () => q(call, [BASEBALLISM])),
      /permission denied/, `authenticated could call: ${call}`);
    await refused(() => asRole('anon', '', () => q(call, [BASEBALLISM])),
      /permission denied/, `anon could call: ${call}`);
  }
});

await test('each tenant computes from its OWN series', async () => {
  const other = await asService(() => first(
    "select eligible, recent_demand from public.forecast_yoy_shift_v1($1, '2026-09-01', 'Youth')", [OTHER_CO]));
  assert.equal(num(other.recent_demand), 777 * 3, 'Other Co has its own series, not Baseballism\'s');
  assert.notEqual(num(other.recent_demand), FROZEN_FIRST_RUN.recentDemand);
});

await test('ledger RLS hides another company\'s rows and grants no client writes', async () => {
  await asService(() => q("select * from public.record_forecast_candidate_run($1, '2026-09-01')", [BASEBALLISM]));
  assert.equal(num(await asRole('authenticated', planner, () => scalar(
    'select count(*)::int from public.forecast_candidate_ledger'))), 1,
    'the owner sees their own row -- and only it, though other tenants have rows too');
  assert.equal(num(await asRole('authenticated', outsider, () => scalar(
    'select count(*)::int from public.forecast_candidate_ledger'))), 0, 'another tenant sees nothing');
  assert.equal(num(await asRole('authenticated', outsider, () => scalar(
    'select count(*)::int from public.forecast_candidate_ledger_v'))), 0, 'the view leaks nothing either');
  // A hard permission denial, not RLS. With RLS alone an UPDATE the policies
  // reject SUCCEEDS WITH ZERO ROWS, which reads exactly like a write that
  // worked -- so the table revokes INSERT/UPDATE/DELETE from `authenticated`
  // outright, undoing Supabase's default `grant all` on a new public table.
  for (const write of [
    "update public.forecast_candidate_ledger set void_reason = 'x'",
    'delete from public.forecast_candidate_ledger',
    `insert into public.forecast_candidate_ledger (company_entity_id, candidate_id, cutoff_date,
       sku_category, horizon_days, forecast_qty, horizon_start_date, horizon_end_date,
       recent_window_start, recent_window_end, recent_demand, prior_window_start, prior_window_end,
       prior_demand, prior_year_target_month, prior_year_target_demand, raw_ratio, clamped_ratio,
       ratio_clamp_low, ratio_clamp_high, ratio_was_clamped, method_version, candidate_spec, source_relation)
     values ('${BASEBALLISM}','Hand','2026-09-01','Youth',30,1,'2026-09-01','2026-10-01',
             '2026-06-01','2026-09-01',1,'2025-06-01','2025-09-01',1,'2025-09-01',1,1,1,0.6,1.8,
             false,'v','{}'::jsonb,'x')`,
  ]) {
    await refused(() => asRole('authenticated', planner, () => q(write)),
      /permission denied/, `a client could write to the ledger: ${write.slice(0, 40)}`);
  }
  assert.equal(num(await asRole('anon', '', () => scalar(
    "select count(*)::int from pg_catalog.pg_class where relname = 'forecast_candidate_ledger'"))), 1);
  await refused(() => asRole('anon', '', () => q('select count(*) from public.forecast_candidate_ledger')),
    /permission denied/, 'anon could read the ledger');
});

// ── 9. Status labelling ─────────────────────────────────────────────────────
await test('an unmatured cycle is labelled PROSPECTIVE — NOT SCORED', async () => {
  const row = await asRole('authenticated', planner, () => first(
    'select cutoff_date, status_label from public.forecast_candidate_ledger_v'));
  assert.equal(row.status_label, 'PROSPECTIVE — NOT SCORED');
  const cycle = await asRole('authenticated', planner, () => first(
    'select status_label, actual_qty, cycle_wape, matured, scorable from public.forecast_candidate_cycles($1)', [BASEBALLISM]));
  assert.equal(cycle.status_label, 'PROSPECTIVE — NOT SCORED');
  assert.equal(cycle.matured, false);
  assert.equal(cycle.scorable, false);
  assert.equal(cycle.actual_qty, null, 'a partial month must not be shown as an actual');
  assert.equal(cycle.cycle_wape, null, 'an unmatured cycle carries no error');
});

await test('evaluation of an unscored candidate recommends nothing and says why', async () => {
  const e = await asRole('authenticated', planner, () => first('select * from public.evaluate_forecast_candidate($1)', [BASEBALLISM]));
  assert.equal(e.recommendation, 'INSUFFICIENT_DATA');
  assert.equal(e.consecutive_scorable_cycles, 0);
  assert.equal(e.requires_planner_approval, true);
  assert.match(e.rationale, /No scorable cycle yet/);
});

// ── 10. Three-cycle gating, WAPE and bias ───────────────────────────────────
// The scorer is exercised independently of the forecaster: ledger rows are
// inserted directly with chosen forecasts, and actuals are seeded to match, so
// each gate can be driven to a known value. (Direct INSERT is service-role
// only, and the append-only trigger governs UPDATE/DELETE, not INSERT.)
const GATE_PLANNER = {};
async function gateScenario(name, cycles, { baselineWape = 0.50, portfolioWape = 0.60, withBaselines = true } = {}) {
  const co = randomUUID();
  const user = randomUUID();
  GATE_PLANNER[co] = user;
  await makeCompany(co, name, user);
  if (withBaselines) {
    await q(`insert into public.forecast_model_baselines
      (company_entity_id, baseline_key, sku_category, horizon_days, wape, bias, measurement_windows, measured_from, measured_to)
      values ($1,'portfolio','ALL TESTED TYPES',30,$3,0,10,'2026-01-01','2026-06-01'),
             ($1,'category','Youth',30,$2,0,10,'2026-01-01','2026-06-01')`, [co, baselineWape, portfolioWape]);
  }
  for (const { cutoff, forecast, actual } of cycles) {
    await sale(co, `${cutoff.slice(0, 8)}10`, 'Youth', actual);
    await q(`insert into public.forecast_candidate_ledger
      (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days, forecast_qty,
       horizon_start_date, horizon_end_date, recent_window_start, recent_window_end, recent_demand,
       prior_window_start, prior_window_end, prior_demand, prior_year_target_month, prior_year_target_demand,
       raw_ratio, clamped_ratio, ratio_clamp_low, ratio_clamp_high, ratio_was_clamped,
       method_version, candidate_spec, source_relation)
      values ($1,'Candidate_YoY_Shift_v1',$2,'Youth',30,$3,
              $2,($2::date + interval '1 month')::date,
              ($2::date - interval '3 months')::date, $2, 1,
              ($2::date - interval '15 months')::date, ($2::date - interval '12 months')::date, 1,
              ($2::date - interval '12 months')::date, 1,
              1,1,0.60,1.80,false,'yoy_shift_v1','{}'::jsonb,'sales_monthly_product_type_rollup_mv')`,
      [co, cutoff, forecast]);
  }
  // Sync coverage well past every cycle, so all of them are matured.
  await sale(co, '2026-08-31', 'Youth', 0);
  await sale(co, '2026-09-05', 'Youth', 0);
  await refresh();
  return co;
}
// Evaluation is AUTHENTICATED-only and scoped to the caller's own active
// company, so each scenario is read by its own signed-in planner -- which is
// how a planner would actually meet this number.
const evaluate = (co) => asRole('authenticated', GATE_PLANNER[co], () => first(
  'select * from public.evaluate_forecast_candidate($1)', [co]));

await test('three consecutive winning cycles produce a promotion RECOMMENDATION, never a promotion', async () => {
  const co = await gateScenario('pass', [
    { cutoff: '2026-01-01', forecast: 100, actual: 100 },
    { cutoff: '2026-02-01', forecast: 110, actual: 100 },
    { cutoff: '2026-03-01', forecast: 90, actual: 100 },
  ]);
  const e = await evaluate(co);
  assert.equal(e.consecutive_scorable_cycles, 3);
  // pooled WAPE = (0 + 10 + 10) / 300
  assert.equal(Number(num(e.pooled_wape).toFixed(6)), Number((20 / 300).toFixed(6)));
  // pooled bias = (0 + 10 - 10) / 300 = 0; mean of per-cycle bias = 0 too
  assert.equal(num(e.pooled_bias), 0);
  assert.equal(num(e.mean_bias), 0);
  assert.equal(num(e.worst_cycle_wape), 0.10);
  assert.equal(e.gate_min_cycles, true);
  assert.equal(e.gate_beats_category_every_cycle, true);
  assert.equal(e.gate_beats_both_pooled, true);
  assert.equal(e.gate_bias_within_tolerance, true);
  assert.equal(e.recommendation, 'RECOMMEND_PROMOTION_FOR_PLANNER_APPROVAL');
  assert.equal(e.requires_planner_approval, true);
  assert.match(e.rationale, /Promotion is never automatic/);
});

await test('two cycles are not three: no recommendation regardless of accuracy', async () => {
  const co = await gateScenario('two', [
    { cutoff: '2026-01-01', forecast: 100, actual: 100 },
    { cutoff: '2026-02-01', forecast: 100, actual: 100 },
  ]);
  const e = await evaluate(co);
  assert.equal(e.consecutive_scorable_cycles, 2);
  assert.equal(num(e.pooled_wape), 0, 'perfect, and still not promotable');
  assert.equal(e.gate_min_cycles, false);
  assert.equal(e.recommendation, 'INSUFFICIENT_DATA');
});

await test('three cycles with a gap are not three CONSECUTIVE cycles', async () => {
  const co = await gateScenario('gap', [
    { cutoff: '2026-01-01', forecast: 100, actual: 100 },
    { cutoff: '2026-02-01', forecast: 100, actual: 100 },
    { cutoff: '2026-04-01', forecast: 100, actual: 100 },
  ]);
  const e = await evaluate(co);
  assert.equal(e.cycles_scorable, 3);
  assert.equal(e.consecutive_scorable_cycles, 2, 'the run breaks at the missing March');
  assert.equal(e.recommendation, 'INSUFFICIENT_DATA');
});

await test('one bad cycle blocks promotion even when the POOLED score still wins', async () => {
  // 0%, 55%, 55% against a 50% baseline: pooled is 36.7% and mean bias is 0,
  // so a gate that only looked at pooled figures would promote this.
  const co = await gateScenario('inconsistent', [
    { cutoff: '2026-01-01', forecast: 100, actual: 100 },
    { cutoff: '2026-02-01', forecast: 155, actual: 100 },
    { cutoff: '2026-03-01', forecast: 45, actual: 100 },
  ]);
  const e = await evaluate(co);
  assert.equal(e.consecutive_scorable_cycles, 3);
  assert.ok(num(e.pooled_wape) < 0.50, `pooled ${e.pooled_wape} beats the baseline`);
  assert.equal(num(e.mean_bias), 0, 'the two misses cancel in the mean');
  assert.equal(num(e.worst_cycle_wape), 0.55);
  assert.equal(e.gate_beats_both_pooled, true);
  assert.equal(e.gate_beats_category_every_cycle, false, 'consistency is judged per cycle');
  assert.equal(e.recommendation, 'HOLD');
});

await test('a persistent directional bias blocks promotion even when WAPE wins', async () => {
  const co = await gateScenario('biased', [
    { cutoff: '2026-01-01', forecast: 120, actual: 100 },
    { cutoff: '2026-02-01', forecast: 120, actual: 100 },
    { cutoff: '2026-03-01', forecast: 120, actual: 100 },
  ]);
  const e = await evaluate(co);
  assert.equal(num(e.pooled_wape), 0.20);
  assert.equal(num(e.mean_bias), 0.20);
  assert.equal(e.gate_beats_category_every_cycle, true);
  assert.equal(e.gate_bias_within_tolerance, false, '+20% is outside +/-10%');
  assert.equal(e.recommendation, 'HOLD');
});

await test('bias tolerance is inclusive at exactly +/-10%', async () => {
  const co = await gateScenario('edge', [
    { cutoff: '2026-01-01', forecast: 110, actual: 100 },
    { cutoff: '2026-02-01', forecast: 110, actual: 100 },
    { cutoff: '2026-03-01', forecast: 110, actual: 100 },
  ]);
  const e = await evaluate(co);
  assert.equal(num(e.mean_bias), 0.10);
  assert.equal(e.gate_bias_within_tolerance, true, 'the boundary is inside the tolerance');
});

await test('an absent baseline is never treated as beaten', async () => {
  const co = await gateScenario('nobaseline', [
    { cutoff: '2026-01-01', forecast: 100, actual: 100 },
    { cutoff: '2026-02-01', forecast: 100, actual: 100 },
    { cutoff: '2026-03-01', forecast: 100, actual: 100 },
  ], { withBaselines: false });
  const e = await evaluate(co);
  assert.equal(e.consecutive_scorable_cycles, 3);
  assert.equal(num(e.pooled_wape), 0, 'a perfect candidate');
  assert.equal(e.category_baseline_wape, null);
  assert.equal(e.gate_beats_category_every_cycle, false);
  assert.equal(e.gate_beats_both_pooled, false);
  assert.equal(e.recommendation, 'HOLD');
  assert.match(e.rationale, /NOT RECORDED/);
});

await test('a voided cycle is excluded from scoring and breaks the run, visibly', async () => {
  const co = await gateScenario('voided', [
    { cutoff: '2026-01-01', forecast: 100, actual: 100 },
    { cutoff: '2026-02-01', forecast: 100, actual: 100 },
    { cutoff: '2026-03-01', forecast: 100, actual: 100 },
  ]);
  const mid = await asService(() => scalar(
    "select id from public.forecast_candidate_ledger where company_entity_id = $1 and cutoff_date = '2026-02-01'", [co]));
  await asRole('authenticated', GATE_PLANNER[co], () => q(
    'select public.void_forecast_candidate_run($1, $2)', [mid, 'computed from a bad sync']));
  const e = await evaluate(co);
  assert.equal(e.cycles_voided, 1);
  assert.equal(e.cycles_scorable, 2);
  assert.equal(e.consecutive_scorable_cycles, 1, 'the void breaks the run');
  assert.equal(e.recommendation, 'INSUFFICIENT_DATA');
  assert.match(e.rationale, /1 voided forecast\(s\) excluded/);
});

await test('a cycle whose month has not finished syncing is not scored', async () => {
  const co = randomUUID();
  const reader = randomUUID();
  await makeCompany(co, 'Unmatured', reader);
  await sale(co, '2026-03-10', 'Youth', 100);
  await q(`insert into public.forecast_candidate_ledger
    (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days, forecast_qty,
     horizon_start_date, horizon_end_date, recent_window_start, recent_window_end, recent_demand,
     prior_window_start, prior_window_end, prior_demand, prior_year_target_month, prior_year_target_demand,
     raw_ratio, clamped_ratio, ratio_clamp_low, ratio_clamp_high, ratio_was_clamped,
     method_version, candidate_spec, source_relation)
    values ($1,'Candidate_YoY_Shift_v1','2026-03-01','Youth',30,100,'2026-03-01','2026-04-01',
            '2025-12-01','2026-03-01',1,'2024-12-01','2025-03-01',1,'2025-03-01',1,
            1,1,0.60,1.80,false,'yoy_shift_v1','{}'::jsonb,'x')`, [co]);
  // Coverage stops mid-March: the month is not complete.
  await sale(co, '2026-03-15', 'Youth', 0);
  await refresh();
  const c = await asRole('authenticated', reader, () => first(
    'select status_label, matured, scorable, actual_qty from public.forecast_candidate_cycles($1)', [co]));
  assert.equal(c.matured, false, 'a half-synced month must not be graded');
  assert.equal(c.status_label, 'PROSPECTIVE — NOT SCORED');
  assert.equal(c.actual_qty, null);
});

// ── 11. The retrospective backtest, through the shipped SQL file ────────────
const backtestTemplate = await readFile(new URL('scripts/sql/forecast_candidate_backtest.sql', root), 'utf8');
for (const [range, expected] of Object.entries(RETROSPECTIVE_SCORES)) {
  const [from, to] = range.split('..');
  await test(`retrospective backtest ${range} reproduces ${expected.wapePct}% WAPE / ${expected.biasPct}% bias`, async () => {
    const sql = bindBacktestSql(backtestTemplate, { company: BASEBALLISM, from, to });
    const r = await asService(() => first(sql));
    assert.equal(Number(r.cutoffs_scored), expected.cutoffs);
    assert.equal(Number(r.wape_pct), expected.wapePct);
    assert.equal(Number(r.bias_pct), expected.biasPct);
    assert.equal(r.caveat, 'RETROSPECTIVE — NOT PROSPECTIVE PERFORMANCE');
  });
}

await test('the backtest binder refuses anything that is not a uuid or a month start', async () => {
  assert.throws(() => bindBacktestSql(backtestTemplate, { company: "' or true--", from: '2026-01-01', to: '2026-02-01' }), /not a uuid/);
  assert.throws(() => bindBacktestSql(backtestTemplate, { company: BASEBALLISM, from: '2026-01-15', to: '2026-02-01' }), /month start/);
  assert.throws(() => bindBacktestSql(backtestTemplate, { company: BASEBALLISM, from: '2026-02-01', to: '2026-01-01' }), /is before/);
});

await test('the 6-window retrospective figure is NOT stable across windows', async () => {
  // The whole argument for the prospective ledger in one assertion: the same
  // unchanged rule scores 20.2% over the six cutoffs the specification quotes
  // and nearly 50% over the long run. A backtest is not evidence.
  const short = RETROSPECTIVE_SCORES['2026-03-01..2026-08-01'].wapePct;
  const long = RETROSPECTIVE_SCORES['2024-01-01..2026-08-01'].wapePct;
  assert.ok(long > short * 2, `long-window WAPE ${long}% should be far worse than ${short}%`);
});

// ── 12. The REAL runner against the REAL database ───────────────────────────
// The core passing against a stub and the SQL passing against a fixture is
// exactly the state in which an orchestrator bug ships here before (a
// temporal-dead-zone reference in a callback no test executed, 2026-09-09).
// This drives scripts/lib/forecast-candidate-core.mjs's actual entry point
// through a client that issues real SQL, so the wiring itself is executed.
function pgliteClient() {
  return {
    async rpc(fn, args) {
      try {
        if (fn === 'forecast_actuals_matured_through') {
          const row = await first('select public.forecast_actuals_matured_through($1) as v', [args.p_company_entity_id]);
          const v = row.v;
          return { data: v ? new Date(v).toISOString().slice(0, 10) : null, error: null };
        }
        if (fn === 'record_forecast_candidate_run') {
          const rows = await q(
            'select * from public.record_forecast_candidate_run($1,$2,$3,$4,$5,$6,$7)',
            [args.p_company_entity_id, args.p_cutoff_date, args.p_sku_category, args.p_candidate_id,
             args.p_horizon_days, args.p_clamp_low, args.p_clamp_high]);
          return { data: rows, error: null };
        }
        throw new Error(`unexpected rpc ${fn}`);
      } catch (error) {
        return { data: null, error: { message: error.message } };
      }
    },
  };
}

await test('the runner, executed for real, freezes each eligible cutoff exactly once', async () => {
  const co = randomUUID();
  await makeCompany(co, 'Runner Co', null);
  // 40 months of flat demand ending 2026-08, so several cutoffs are eligible.
  for (let i = 0; i < 40; i++) {
    const m = new Date(Date.UTC(2023, 4 + i, 5));
    if (m > new Date(Date.UTC(2026, 7, 5))) break;
    await sale(co, m.toISOString().slice(0, 10), 'Youth', 100);
  }
  await sale(co, '2026-08-31', 'Youth', 0);
  await refresh();
  // August's own last day is synced, but nothing in September is -- so August
  // is not yet provably FINAL and the newest freezable cutoff is 2026-08-01.
  assert.equal(new Date(await scalar('select public.forecast_actuals_matured_through($1)', [co]))
    .toISOString().slice(0, 10), '2026-07-31',
    'a newest month with no later month is treated as still filling');
  // Production's shape: a partial current month, which is what makes the
  // previous one provably complete.
  await sale(co, '2026-09-02', 'Youth', 40);
  await refresh();

  await db.exec('set role service_role');
  let out;
  try {
    out = await runForecastCandidate({
      client: pgliteClient(), companyEntityId: co, startCutoff: '2026-06-01', logger: { log() {}, error() {} },
    });
  } finally { await db.exec('reset role'); }

  assert.equal(out.maturedThrough, '2026-08-31');
  assert.deepEqual(out.cutoffs, ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);
  assert.equal(out.summary.inserted, 4);
  assert.equal(out.summary.failed, 0);
  assert.equal(num(await scalar(
    'select count(*)::int from public.forecast_candidate_ledger where company_entity_id = $1', [co])), 4);

  // ...and again. The second run must write nothing and recompute nothing.
  await db.exec('set role service_role');
  let again;
  try {
    again = await runForecastCandidate({
      client: pgliteClient(), companyEntityId: co, startCutoff: '2026-06-01', logger: { log() {}, error() {} },
    });
  } finally { await db.exec('reset role'); }
  assert.equal(again.summary.inserted, 0);
  assert.equal(again.summary.existing, 4);
  assert.ok(again.results.every((r) => /^frozen at /.test(r.reason)), 'every cutoff took the short-circuit');
  assert.equal(num(await scalar(
    'select count(*)::int from public.forecast_candidate_ledger where company_entity_id = $1', [co])), 4);
  assert.equal(formatSummary(again.summary),
    'attempted 4, inserted 0, already frozen 4, deferred 0, not computable 0, failed 0');
});

// ── 13. Re-appliability ─────────────────────────────────────────────────────
// apply_all_post_merge.sql promises every migration is safe to re-run, and
// this repo has broken that promise before (a view depending on a generated
// column made a drop-then-add fail on the second pass). Re-run the real file
// against the database these tests just built, with rows in it.
await test('the migration re-applies over a populated database without damage', async () => {
  const before = await first(`select
    (select count(*)::int from public.forecast_candidate_ledger) as ledger,
    (select count(*)::int from public.forecast_model_baselines) as baselines`);
  // A baseline somebody has since re-measured by hand must survive: the seed is
  // ON CONFLICT DO NOTHING, never DO UPDATE.
  await q("update public.forecast_model_baselines set wape = 0.9999 where company_entity_id = $1 and baseline_key = 'category'", [BASEBALLISM]);

  await db.exec(migrationSql);

  const after = await first(`select
    (select count(*)::int from public.forecast_candidate_ledger) as ledger,
    (select count(*)::int from public.forecast_model_baselines) as baselines,
    (select wape from public.forecast_model_baselines where company_entity_id = '${BASEBALLISM}' and baseline_key = 'category') as wape`);
  assert.equal(after.ledger, before.ledger, 'a re-apply must not touch frozen forecasts');
  assert.equal(after.baselines, before.baselines, 'a re-apply must not duplicate baselines');
  assert.equal(num(after.wape), 0.9999, 'a re-apply must not overwrite a re-measured baseline');
  // ...and the objects still work afterwards.
  assert.equal(num(await asService(() => scalar(
    "select forecast_qty from public.forecast_yoy_shift_v1($1, '2026-09-01', 'Youth')", [BASEBALLISM]))),
    FROZEN_FIRST_RUN.forecastQty);
});

console.log(`\n# ${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
