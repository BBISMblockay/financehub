// Unit tests for the Demand Planner candidate RUNNER -- scripts/lib/forecast-candidate-core.mjs.
// No network, no database, nothing installed.
//
// Note what is NOT tested here, on purpose: the forecast arithmetic. The
// ratio, the clamp, the windows and the rounding live exactly once, in
// public.forecast_yoy_shift_v1, and are driven against a real PostgreSQL by
// scripts/tests/forecast-candidate-database.test.mjs. A JavaScript re-check of
// them would be asserting against a second implementation that production
// never runs.
//
// What IS here is what the runner alone decides: which cutoffs to attempt,
// what a refusal does to the rest of the run, and that the backtest binder
// refuses anything it cannot prove is safe to interpolate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  resolveCategories,
  addMonths,
  previousDay,
  monthStart,
  isMonthStart,
  plannedCutoffs,
  runForecastCandidate,
  runMethodCompetition,
  formatSummary,
  formatCompetitionSummary,
  blankSummary,
  blankCompetitionSummary,
  COMPETITION_METHODS,
  COMPETITION_HORIZON_MONTHS,
  COMPETITION_EVIDENCE_MONTHS,
  bindBacktestSql,
  FIRST_FROZEN_CUTOFF,
} from '../lib/forecast-candidate-core.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
async function atest(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

// ── Calendar arithmetic ─────────────────────────────────────────────────────
test('addMonths crosses year boundaries in both directions', () => {
  assert.equal(addMonths('2026-09-01', -12), '2025-09-01');
  assert.equal(addMonths('2026-09-01', -15), '2025-06-01');
  assert.equal(addMonths('2026-01-01', -1), '2025-12-01');
  assert.equal(addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(addMonths('2026-09-01', 0), '2026-09-01');
  assert.equal(addMonths('2024-03-01', -26), '2022-01-01');
});

test('previousDay crosses month and year boundaries', () => {
  assert.equal(previousDay('2026-09-01'), '2026-08-31');
  assert.equal(previousDay('2026-03-01'), '2026-02-28');
  assert.equal(previousDay('2024-03-01'), '2024-02-29', 'leap year');
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
});

test('monthStart and isMonthStart', () => {
  assert.equal(monthStart('2026-09-17'), '2026-09-01');
  assert.equal(isMonthStart('2026-09-01'), true);
  assert.equal(isMonthStart('2026-09-02'), false);
  assert.throws(() => monthStart('2026-9-1'), /YYYY-MM-DD/);
});

// ── Which cutoffs may be attempted ──────────────────────────────────────────
test('a cutoff is eligible exactly when the day before it has synced', () => {
  // The frozen first run: source complete through 2026-08-31 is precisely
  // enough for a 2026-09-01 cutoff, and not enough for 2026-10-01.
  assert.deepEqual(
    plannedCutoffs({ startCutoff: '2026-09-01', maturedThrough: '2026-08-31' }),
    ['2026-09-01']);
  // One day short: the t-1 month is still landing.
  assert.deepEqual(
    plannedCutoffs({ startCutoff: '2026-09-01', maturedThrough: '2026-08-30' }),
    [], 'a partially synced t-1 month must not be frozen');
  // A full extra month.
  assert.deepEqual(
    plannedCutoffs({ startCutoff: '2026-09-01', maturedThrough: '2026-09-30' }),
    ['2026-09-01', '2026-10-01']);
});

test('never measured yields no cutoffs, not every cutoff', () => {
  assert.deepEqual(plannedCutoffs({ startCutoff: '2026-09-01', maturedThrough: null }), []);
  assert.deepEqual(plannedCutoffs({ startCutoff: '2026-09-01', maturedThrough: undefined }), []);
});

test('the cutoff cap bounds a long backfill', () => {
  const many = plannedCutoffs({ startCutoff: '2020-01-01', maturedThrough: '2026-08-31', maxCutoffs: 5 });
  assert.equal(many.length, 5);
  assert.deepEqual(many, ['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01', '2020-05-01']);
});

test('a start cutoff that is not a month start is refused', () => {
  assert.throws(() => plannedCutoffs({ startCutoff: '2026-09-15', maturedThrough: '2026-08-31' }),
    /first of a month/);
});

test('the default start cutoff is the first frozen run in the source report', () => {
  assert.equal(FIRST_FROZEN_CUTOFF, '2026-09-01');
});

// ── Driving the run ─────────────────────────────────────────────────────────
function fakeClient({ maturedThrough = '2026-10-31', responses = {}, defaultAction = 'inserted' } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (fn === 'forecast_actuals_matured_through') return { data: maturedThrough, error: null };
      if (fn === 'record_forecast_candidate_run') {
        const canned = responses[args.p_cutoff_date];
        if (canned instanceof Error) return { data: null, error: { message: canned.message } };
        return { data: [canned || { action: defaultAction, forecast_qty: '7735', ledger_id: 'id-' + args.p_cutoff_date, reason: null }], error: null };
      }
      throw new Error(`unstubbed rpc ${fn}`);
    },
  };
}
const quiet = { log() {}, error() {} };

await atest('a run attempts every eligible cutoff and tallies the outcomes', async () => {
  // Complete through 2026-11-29: enough for the November cutoff (which needs
  // October to be whole) and one day short of December's.
  const client = fakeClient({ maturedThrough: '2026-11-29' });
  const { cutoffs, summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', startCutoff: '2026-09-01',
    skuCategory: 'Widgets', logger: quiet });
  assert.deepEqual(cutoffs, ['2026-09-01', '2026-10-01', '2026-11-01']);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.inserted, 3);
  assert.equal(summary.failed, 0);
  const writes = client.calls.filter((c) => c.fn === 'record_forecast_candidate_run');
  assert.equal(writes.length, 3);
  assert.equal(writes[0].args.p_candidate_id, 'Candidate_YoY_Shift_v1');
  // The category is whatever the CALLER named. Deliberately a non-Baseballism
  // value: this used to assert 'Youth', which passed only because the module
  // carried one tenant's catalogue as a default.
  assert.equal(writes[0].args.p_sku_category, 'Widgets');
  assert.equal(writes[0].args.p_horizon_days, 30);
  assert.equal(writes[0].args.p_clamp_low, 0.60);
  assert.equal(writes[0].args.p_clamp_high, 1.80);
});

await atest('a re-run reports every cutoff as already frozen and writes nothing new', async () => {
  const client = fakeClient({ maturedThrough: '2026-10-30', defaultAction: 'existing' });
  const { summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', startCutoff: '2026-09-01',
    skuCategory: 'Widgets', logger: quiet });
  assert.equal(summary.attempted, 2);
  assert.equal(summary.existing, 2);
  assert.equal(summary.inserted, 0);
});

await atest('one cutoff failing does not abandon the rest of the run', async () => {
  // Later cutoffs are independent decisions. Aborting on the first error would
  // let one transient failure hide every month after it -- and this job runs
  // monthly, so "it will catch up next time" is a month away.
  const client = fakeClient({
    maturedThrough: '2026-11-29',
    responses: { '2026-10-01': new Error('statement timeout') },
  });
  const { summary, results } = await runForecastCandidate({
    client, companyEntityId: 'co-1', skuCategory: 'Widgets', startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.attempted, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.inserted, 2);
  assert.equal(results[1].action, 'failed');
  assert.match(results[1].reason, /statement timeout/);
  assert.equal(results[2].action, 'inserted', 'the cutoff after the failure still ran');
});

await atest('deferred, expired and skipped are counted separately and none is a failure', async () => {
  // Three different things: "not yet", "too late to be prospective", and "not
  // computable here". A run that collapsed them would make a stalled sync, a
  // dropped monthly run and a broken model all look alike in the log.
  const client = fakeClient({
    maturedThrough: '2026-11-29',
    responses: {
      '2026-09-01': { action: 'expired', forecast_qty: null, ledger_id: null, reason: 'horizon ... already fully synced' },
      '2026-10-01': { action: 'deferred', forecast_qty: null, ledger_id: null, reason: 'source is synced through ...' },
      '2026-11-01': { action: 'skipped', forecast_qty: null, ledger_id: null, reason: 'prior-year window ...' },
    },
  });
  const { summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', skuCategory: 'Widgets', startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.expired, 1);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0, 'a refusal is not an error');
});

await atest('the planner still offers historical cutoffs; the database refuses the closed ones', async () => {
  // The catch-up range is deliberately NOT trimmed here. A dropped monthly run
  // is what catch-up is for, and "is this still prospective" is decided once,
  // in the database, backed by a CHECK a service-role job cannot dodge --
  // re-deciding it here would be a second definition of the word.
  const client = fakeClient({
    maturedThrough: '2026-11-29',
    responses: {
      '2026-09-01': { action: 'expired', forecast_qty: null, ledger_id: null, reason: 'expired' },
      '2026-10-01': { action: 'expired', forecast_qty: null, ledger_id: null, reason: 'expired' },
    },
  });
  const { cutoffs, summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', skuCategory: 'Widgets', startCutoff: '2026-09-01', logger: quiet });
  assert.deepEqual(cutoffs, ['2026-09-01', '2026-10-01', '2026-11-01'], 'all three are attempted');
  assert.equal(summary.expired, 2);
  assert.equal(summary.inserted, 1);
});

await atest('an unrecognised action is counted as a failure, not silently dropped', async () => {
  const client = fakeClient({
    maturedThrough: '2026-08-31',
    responses: { '2026-09-01': { action: 'something_new', forecast_qty: null, ledger_id: null, reason: null } },
  });
  const { summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', skuCategory: 'Widgets', startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.failed, 1);
});

await atest('a dry run plans the cutoffs and issues no write', async () => {
  const client = fakeClient({ maturedThrough: '2026-11-29' });
  const { cutoffs, summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', skuCategory: 'Widgets', startCutoff: '2026-09-01', dryRun: true, logger: quiet });
  assert.equal(cutoffs.length, 3);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.inserted, 0);
  assert.equal(client.calls.filter((c) => c.fn === 'record_forecast_candidate_run').length, 0);
});

await atest('an unmeasured source writes nothing at all', async () => {
  const client = fakeClient({ maturedThrough: null });
  const { cutoffs, summary } = await runForecastCandidate({
    client, companyEntityId: 'co-1', skuCategory: 'Widgets', startCutoff: '2026-09-01', logger: quiet });
  assert.deepEqual(cutoffs, []);
  assert.equal(summary.attempted, 0);
  assert.equal(client.calls.filter((c) => c.fn === 'record_forecast_candidate_run').length, 0);
});

await atest('a failure reading the maturity clock stops the run rather than guessing', async () => {
  const client = {
    async rpc(fn) {
      if (fn === 'forecast_actuals_matured_through') return { data: null, error: { message: 'boom' } };
      throw new Error('should not reach the writer');
    },
  };
  await assert.rejects(
    () => runForecastCandidate({ client, companyEntityId: 'co-1', skuCategory: 'Widgets', logger: quiet }),
    /forecast_actuals_matured_through failed: boom/);
});

await atest('with no override the driver resolves categories from the database', async () => {
  const calls = [];
  const client = { rpc: async (fn, args) => { calls.push({ fn, args }); return { data: [
    { product_type: 'Tees',    is_forecastable: true },
    { product_type: 'Fees',    is_forecastable: false },
    { product_type: 'Hats',    is_forecastable: true },
  ], error: null }; } };
  const got = await resolveCategories(client, 'co-1', '');
  assert.deepEqual(got.categories, ['Tees', 'Hats'], 'non-forecastable types must not be forecast');
  assert.deepEqual(got.needsReview, [], 'a classified type is not review-required');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'forecastable_product_types');
  assert.equal(calls[0].args.p_company_entity_id, 'co-1');
});

await atest('an explicit category overrides the database and asks it nothing', async () => {
  let asked = false;
  const client = { rpc: async () => { asked = true; return { data: [], error: null }; } };
  assert.deepEqual((await resolveCategories(client, 'co-1', 'Widgets')).categories, ['Widgets']);
  assert.equal(asked, false, 'an explicit category must not cost a round trip');
});

await atest('a company with no forecastable category resolves to an empty list, not a guess', async () => {
  const client = { rpc: async () => ({ data: [{ product_type: 'Fees', is_forecastable: false }], error: null }) };
  assert.deepEqual((await resolveCategories(client, 'co-1', '')).categories, []);
});

await atest('an untracked sold category is reported as review-required, not silently dropped', async () => {
  // REGRESSION. A brand-new merchandise type that records sales before its
  // inventory link or PO history lands is indistinguishable, on the evidence
  // alone, from a fee line. It must not be forecast -- but it must not vanish
  // either: the ledger's frozen-before-outcome CHECK means a forecast missed at
  // a cutoff that has since closed can NEVER be recreated, so a silent
  // exclusion is permanent and a run that dropped one looks like a clean run.
  const client = { rpc: async () => ({ data: [
    { product_type: 'Tees',    is_forecastable: true,  needs_review: false },
    { product_type: 'Fees',    is_forecastable: false, needs_review: false }, // confirmed by a person
    { product_type: 'BrandNew', is_forecastable: false, needs_review: true },  // cannot tell yet
  ], error: null }) };
  const got = await resolveCategories(client, 'co-1', '');
  assert.deepEqual(got.categories, ['Tees'], 'an unresolved type is still not forecast');
  assert.deepEqual(got.needsReview, ['BrandNew'],
    'an unresolved type must be surfaced; a confirmed exclusion must not be');
  assert.ok(!got.needsReview.includes('Fees'),
    'a type a person already ruled on is settled, not review-required');
});

await atest('a failure resolving categories stops the run rather than forecasting nothing quietly', async () => {
  const client = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  await assert.rejects(() => resolveCategories(client, 'co-1', ''), /could not resolve categories: boom/);
});

await atest('a missing category is refused rather than defaulted to one tenant', async () => {
  const client = fakeClient({ maturedThrough: '2026-11-29' });
  await assert.rejects(
    () => runForecastCandidate({
      client, companyEntityId: 'co-1', startCutoff: '2026-09-01', logger: quiet }),
    /skuCategory is required/);
  assert.equal(client.calls.filter((c) => c.fn === 'record_forecast_candidate_run').length, 0);
});

await atest('a blank category is refused too', async () => {
  const client = fakeClient({ maturedThrough: '2026-11-29' });
  await assert.rejects(
    () => runForecastCandidate({
      client, companyEntityId: 'co-1', startCutoff: '2026-09-01',
      skuCategory: '   ', logger: quiet }),
    /skuCategory is required/);
});

await atest('a missing company is refused before any call is made', async () => {
  await assert.rejects(() => runForecastCandidate({ client: fakeClient(), logger: quiet }),
    /companyEntityId is required/);
});

test('the summary reads as one line', () => {
  const s = blankSummary();
  s.attempted = 3; s.inserted = 1; s.existing = 1; s.deferred = 1;
  s.expired = 1;
  assert.equal(formatSummary(s),
    'attempted 3, inserted 1, already frozen 1, deferred 1, expired 1, not computable 0, failed 0');
});

// ── Backtest parameter binding ──────────────────────────────────────────────
const TEMPLATE = 'select * from f(:company::uuid, :from_cutoff::date, :to_cutoff::date) where x = :company::uuid';
const CO = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';

test('binding substitutes every occurrence and quotes each value', () => {
  const out = bindBacktestSql(TEMPLATE, { company: CO, from: '2026-03-01', to: '2026-08-01' });
  assert.equal(out,
    `select * from f('${CO}'::uuid, '2026-03-01'::date, '2026-08-01'::date) where x = '${CO}'::uuid`);
  assert.ok(!out.includes(':company'), 'no token may survive');
  assert.ok(!out.includes(':from_cutoff'));
});

test('the longer token is replaced first, so :from_cutoff is never half-substituted', () => {
  // ':from_cutoff' begins with ':from'. Replacing the short token first would
  // leave "'2026-03-01'_cutoff" -- a syntax error at best.
  const out = bindBacktestSql(':from_cutoff :to_cutoff', { company: CO, from: '2026-03-01', to: '2026-08-01' });
  assert.equal(out, "'2026-03-01' '2026-08-01'");
});

test('binding refuses anything it cannot prove is a uuid or a month start', () => {
  const ok = { company: CO, from: '2026-03-01', to: '2026-08-01' };
  assert.throws(() => bindBacktestSql(TEMPLATE, { ...ok, company: "' or true--" }), /not a uuid/);
  assert.throws(() => bindBacktestSql(TEMPLATE, { ...ok, company: `${CO}'; drop table x;--` }), /not a uuid/);
  assert.throws(() => bindBacktestSql(TEMPLATE, { ...ok, from: '2026-03-15' }), /month start/);
  assert.throws(() => bindBacktestSql(TEMPLATE, { ...ok, to: "2026-08-01'; delete from y;--" }), /month start/);
  assert.throws(() => bindBacktestSql(TEMPLATE, { ...ok, from: '2026-08-01', to: '2026-03-01' }), /is before/);
  assert.throws(() => bindBacktestSql('', ok), /template is required/);
  assert.throws(() => bindBacktestSql(TEMPLATE, {}), /not a uuid/);
});

// ── The competition runner ──────────────────────────────────────────────────
// The property worth a test here is the ORDER: the selection is recorded
// before any method's forecast is frozen. Nothing in the database can tell the
// two orderings apart -- the evidence CHECK passes either way -- so this is one
// of the few guarantees that lives in the runner, and a test is the only thing
// holding it.
function fakeCompetitionClient({ maturedThrough = '2026-09-29', selected = 'run_rate_v1',
                                 methodResponses = {} } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (fn === 'forecast_actuals_matured_through') return { data: maturedThrough, error: null };
      if (fn === 'select_forecast_method') {
        if (selected instanceof Error) return { data: null, error: { message: selected.message } };
        return { data: [{ selected_method: selected, evidence_from: '2025-03-01',
                          evidence_to: '2026-08-31', windows: 13, wape: '0.389' }], error: null };
      }
      if (fn === 'record_forecast_method_run') {
        const canned = methodResponses[args.p_method];
        if (canned instanceof Error) return { data: null, error: { message: canned.message } };
        return { data: [canned || { action: 'inserted', forecast_qty: '100',
                                    ledger_id: `${args.p_method}-${args.p_cutoff_date}-${args.p_horizon_months}`,
                                    reason: null }], error: null };
      }
      throw new Error(`unstubbed rpc ${fn}`);
    },
  };
}

await atest('the competition records the selection BEFORE freezing any method at that cutoff', async () => {
  const client = fakeCompetitionClient();
  await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'Youth',
    startCutoff: '2026-09-01', logger: quiet });

  const ordered = client.calls
    .filter((c) => c.fn === 'select_forecast_method' || c.fn === 'record_forecast_method_run')
    .map((c) => `${c.fn}:${c.args.p_cutoff_date || c.args.p_effective_from_cutoff}:${c.args.p_horizon_months}`);
  // One cutoff, two horizons: select 3m, three methods at 3m, select 6m, three
  // methods at 6m. A selection appearing after its own horizon's forecasts
  // would mean the pick was made in a run that had already seen them.
  assert.deepEqual(ordered, [
    'select_forecast_method:2026-09-01:3',
    'record_forecast_method_run:2026-09-01:3',
    'record_forecast_method_run:2026-09-01:3',
    'record_forecast_method_run:2026-09-01:3',
    'select_forecast_method:2026-09-01:6',
    'record_forecast_method_run:2026-09-01:6',
    'record_forecast_method_run:2026-09-01:6',
    'record_forecast_method_run:2026-09-01:6',
  ]);
});

await atest('the competition covers every method at every horizon, and marks the selected one', async () => {
  const client = fakeCompetitionClient();
  const { summary, results } = await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'Youth',
    startCutoff: '2026-09-01', logger: quiet });

  assert.equal(summary.cutoffs, 1);
  assert.equal(summary.selections_recorded, COMPETITION_HORIZON_MONTHS.length);
  assert.equal(summary.inserted, COMPETITION_METHODS.length * COMPETITION_HORIZON_MONTHS.length);
  assert.equal(summary.failed, 0);

  for (const horizon of COMPETITION_HORIZON_MONTHS) {
    const atHorizon = results.filter((r) => r.horizon === horizon && r.method);
    assert.deepEqual(atHorizon.map((r) => r.method).sort(), [...COMPETITION_METHODS].sort());
    assert.deepEqual(atHorizon.filter((r) => r.selected).map((r) => r.method), ['run_rate_v1']);
  }
  // The evidence window is fixed by the module, not by the caller, so a run
  // cannot try several until a preferred method wins.
  for (const call of client.calls.filter((c) => c.fn === 'select_forecast_method')) {
    assert.equal(call.args.p_evidence_months, COMPETITION_EVIDENCE_MONTHS);
  }
});

await atest('an unresolved selection still freezes every method', async () => {
  // No method could be scored over the evidence window. Recording a pick anyway
  // would be a guess; NOT freezing the forecasts would mean the evidence that
  // would eventually allow a pick never accrues.
  const client = fakeCompetitionClient({ selected: null });
  const { summary } = await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'New Line',
    startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.selections_recorded, 0);
  assert.equal(summary.selections_unresolved, COMPETITION_HORIZON_MONTHS.length);
  assert.equal(summary.inserted, COMPETITION_METHODS.length * COMPETITION_HORIZON_MONTHS.length);
  assert.equal(summary.failed, 0);
});

await atest('a failed selection does not cost the cutoff its forecasts', async () => {
  const client = fakeCompetitionClient({ selected: new Error('scorer exploded') });
  const { summary } = await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'Youth',
    startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.failed, COMPETITION_HORIZON_MONTHS.length, 'the selection failures are counted');
  // A cutoff with forecasts and no selection is recoverable evidence; a cutoff
  // with neither is a hole nothing can fill once it closes.
  assert.equal(summary.inserted, COMPETITION_METHODS.length * COMPETITION_HORIZON_MONTHS.length);
});

await atest('one method failing does not cost the others', async () => {
  const client = fakeCompetitionClient({
    methodResponses: { seasonal_naive_v1: new Error('timeout') } });
  const { summary, results } = await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'Youth',
    startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.failed, COMPETITION_HORIZON_MONTHS.length);
  assert.equal(summary.inserted, 2 * COMPETITION_HORIZON_MONTHS.length);
  assert.ok(results.some((r) => r.method === 'run_rate_v1' && r.action === 'inserted'));
});

await atest('an ineligible method is reported as not computable, never as a number', async () => {
  const client = fakeCompetitionClient({
    methodResponses: { blend_v1: { action: 'skipped', forecast_qty: null, ledger_id: null,
                                   reason: 'blend needs both halves' } } });
  const { summary, results } = await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'Youth',
    startCutoff: '2026-09-01', logger: quiet });
  assert.equal(summary.skipped, COMPETITION_HORIZON_MONTHS.length);
  assert.equal(summary.failed, 0);
  for (const r of results.filter((x) => x.method === 'blend_v1')) {
    assert.equal(r.action, 'skipped');
    assert.equal(r.forecastQty, null);
    assert.equal(r.ledgerId, null);
  }
});

await atest('a dry run issues no writes at all', async () => {
  const client = fakeCompetitionClient();
  const { summary } = await runMethodCompetition({
    client, companyEntityId: 'co-1', skuCategory: 'Youth',
    startCutoff: '2026-09-01', dryRun: true, logger: quiet });
  assert.deepEqual(client.calls.map((c) => c.fn), ['forecast_actuals_matured_through']);
  assert.equal(summary.inserted, 0);
  assert.equal(summary.selections_recorded, 0);
});

test('the competition refuses a run with no category, rather than defaulting to one', () => {
  assert.rejects(() => runMethodCompetition({ client: fakeCompetitionClient(), companyEntityId: 'co-1', logger: quiet }),
    /skuCategory is required/);
  assert.rejects(() => runMethodCompetition({ client: fakeCompetitionClient(), skuCategory: 'Youth', logger: quiet }),
    /companyEntityId is required/);
});

test('the competition summary names every outcome it counts', () => {
  const blank = blankCompetitionSummary();
  const line = formatCompetitionSummary(blank);
  for (const key of ['cutoffs', 'selections', 'unresolved', 'inserted', 'deferred', 'expired', 'failed']) {
    assert.ok(line.includes(key), `summary line should mention ${key}: ${line}`);
  }
  // "already frozen" pools existing and existing_voided; both must be visible
  // in the count, because a voided row is still a row nothing will recompute.
  assert.match(formatCompetitionSummary({ ...blank, existing: 2, existing_voided: 1 }),
    /already frozen 3/);
});

// ── The shipped SQL file must survive chat_run_readonly_query's guard ───────
// That RPC strips LEADING comments and ONE trailing semicolon, requires the
// remainder to begin with select/with, and then REJECTS the statement outright
// if a semicolon survives anywhere. It also wraps the text as
// `select ... from (<text>) user_query limit 1000`, so a file ending in a `--`
// comment would comment out the wrapper's own tail. None of that is visible
// when reading the .sql file on its own.
const backtestSql = await readFile(new URL('../sql/forecast_candidate_backtest.sql', import.meta.url), 'utf8');

test('the backtest SQL is shaped the way the read-only RPC requires', () => {
  const bound = bindBacktestSql(backtestSql, { company: CO, from: '2026-03-01', to: '2026-08-01' });
  // Same normalisation the RPC performs, in the same order.
  let trimmed = bound.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim();
  assert.match(trimmed, /^(select|with)\s/i, 'must begin with SELECT or WITH after comment stripping');
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1).trim();
  assert.ok(!trimmed.includes(';'), 'a surviving semicolon is rejected outright by the RPC');
  assert.ok(!/--[^\n]*$/.test(trimmed),
    'the file must not end on a line comment; the RPC appends its own LIMIT after this text');
});

console.log(`\n# ${passed} assertions passed`);
