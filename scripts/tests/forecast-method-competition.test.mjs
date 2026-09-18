// The forecast COMPETITION against a real PostgreSQL (PGlite): several methods
// frozen side by side, and the selection between them recorded before the
// cutoff it governs.
//
// 20260917140000 proved one method prospectively. This suite covers what
// 20260918000000 adds, and the properties it covers are the ones a diff cannot
// show:
//
//   * a SELECTION whose evidence reaches its own cutoff is refused by the
//     table, not by the job -- a service-role writer cannot dodge a CHECK, and
//     a selection that could have been made after seeing its own result is
//     indistinguishable from no record at all;
//   * a selection cannot be edited or deleted afterwards;
//   * every method reports inputs_through_date and the LEDGER binds it, so the
//     no-look-ahead guarantee no longer depends on one method's provenance
//     columns being populated;
//   * an absent month makes a method INELIGIBLE rather than contributing zero
//     -- "not recorded" and "sold none" are different facts and only one of
//     them is a collapse in demand;
//   * the scorer refuses a null company rather than returning "no methods
//     could be scored", which reads identically to a category with no history;
//   * none of the new service-role functions are reachable by `authenticated`.
//
// The numbers are computed by the shipped functions over Baseballism's REAL
// 86-month Youth series (scripts/tests/fixtures/youth-monthly-demand.mjs, read
// from production on 2026-09-17), not over a series built to produce them.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/forecast-method-competition.test.mjs
//
// Mutations (each must fail at least one assertion):
//   FMC_MUTATION=evidence-may-reach-cutoff   selection CHECK dropped
//   FMC_MUTATION=selection-editable          append-only trigger dropped
//   FMC_MUTATION=ledger-inputs-may-reach-cutoff  ledger CHECK dropped
//   FMC_MUTATION=absent-months-are-zero      run rate sums whatever is present
//   FMC_MUTATION=blend-invents-halves        blend falls back to one half
//   FMC_MUTATION=candidate-writable-here     the two-writers refusal dropped
//   FMC_MUTATION=scorer-open-to-authenticated  the scorer granted to authenticated
//   FMC_MUTATION=rows-counted-as-months      the scorer counts rollup ROWS as months
//   FMC_MUTATION=rerun-reports-recomputed-winner  a re-run returns today's winner
//   FMC_MUTATION=forward-record-pooled-by-category  fwd_ metrics pooled across methods
//   FMC_MUTATION=stored-selection-lost-when-nothing-scores  the pre-score read removed
//   FMC_MUTATION=seasonal-window-one-month-late  the live blend's seasonal window slips
//   FMC_MUTATION=backtest-velocity-reads-its-own-outcome  m3 includes the outcome's first month
//   FMC_MUTATION=forecast-function-open-to-anon  a method function ships without its revoke
//   FMC_MUTATION=blend-floors-the-combined-figure  a negative half cancels a positive one
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { YOUTH_MONTHLY_DEMAND, SYNCED_THROUGH } from './fixtures/youth-monthly-demand.mjs';
import { runMethodCompetition, COMPETITION_METHODS, COMPETITION_HORIZON_MONTHS }
  from '../lib/forecast-candidate-core.mjs';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const root = new URL('../../', import.meta.url);
const MIGRATIONS = [
  'supabase/migrations/20260917140000_forecast_candidate_ledger.sql',
  'supabase/migrations/20260917180000_product_type_profile.sql',
  'supabase/migrations/20260918000000_forecast_method_competition.sql',
];
const COMPETITION = MIGRATIONS[2];

// Each mutation is [file, from, to]. Anchors are asserted present, so a
// mutation silently going stale fails loudly rather than testing nothing.
const MUTATIONS = {
  'evidence-may-reach-cutoff': [[COMPETITION,
    'constraint fms_evidence_precedes_cutoff check (evidence_to < effective_from_cutoff),', '']],
  'selection-editable': [[COMPETITION,
    "returns trigger language plpgsql as $fn$\nbegin\n  if tg_op = 'DELETE' then",
    "returns trigger language plpgsql as $fn$\nbegin\n  return coalesce(new, old);\n  if tg_op = 'DELETE' then"]],
  'ledger-inputs-may-reach-cutoff': [[COMPETITION,
    'check (inputs_through_date < cutoff_date);', 'check (inputs_through_date is not null);']],
  'absent-months-are-zero': [[COMPETITION, '  if v_n <> 3 then', '  if false then']],
  'blend-invents-halves': [[COMPETITION,
    '  if not s.eligible or not r.eligible then', '  if not s.eligible and not r.eligible then']],
  'candidate-writable-here': [[COMPETITION,
    "  if p_method = 'Candidate_YoY_Shift_v1' then\n    raise exception 'record_forecast_method_run: Candidate_YoY_Shift_v1",
    "  if false then\n    raise exception 'record_forecast_method_run: Candidate_YoY_Shift_v1"]],
  // Both of these are the review's P1s. Each must fail an assertion, or the
  // fix is not actually being tested.
  'rows-counted-as-months': [[COMPETITION,
    "  monthly as (\n    select r.month_start, sum(r.units)::numeric as units",
    "  monthly as (\n    select r.month_start, r.location, sum(r.units)::numeric as units"],
    [COMPETITION, "    group by r.month_start\n  ),\n  actuals as (",
     "    group by r.month_start, r.location\n  ),\n  actuals as ("]],
  // Both read-backs removed, not just one: since the pre-score read landed, the
  // conflict path alone is unreachable on an ordinary re-run, and a mutation
  // that patches only it can no longer fail. A mutation that cannot fail is
  // counted as coverage while testing nothing -- the same way four ledger
  // mutations went quietly dead in #721.
  'rerun-reports-recomputed-winner': [[COMPETITION,
    "  if v_stored_method is not null then\n    return query select\n      v_stored_method, v_stored_from, v_stored_to,",
    "  if false then\n    return query select\n      v_stored_method, v_stored_from, v_stored_to,"],
    [COMPETITION, "  if v_stored_method is null then\n    select s.selected_method",
     "  if false then\n    select s.selected_method"],
    [COMPETITION, "  return query select\n    v_stored_method, v_stored_from, v_stored_to,",
     "  return query select\n    coalesce(v_stored_method, v_best_method), v_stored_from, v_stored_to,"]],
  // The two cycle-2 P-findings.
  'forward-record-pooled-by-category': [['scripts/sql/category_buy_forecast.sql',
    "  left join fwd f on f.cat = r.cat and f.method_id = r.method_id",
    "  left join fwd f on f.cat = r.cat"],
    ['scripts/sql/category_buy_forecast.sql',
     "fwd as (select cat, method_id,", "fwd as (select cat, min(method_id) as method_id,"],
    ['scripts/sql/category_buy_forecast.sql',
     "  from scored group by 1, 2),", "  from scored group by 1),"]],
  'stored-selection-lost-when-nothing-scores': [[COMPETITION,
    "  if v_stored_method is not null then\n    return query select\n      v_stored_method, v_stored_from, v_stored_to,",
    "  if false then\n    return query select\n      v_stored_method, v_stored_from, v_stored_to,"],
    [COMPETITION, "  v_basis jsonb;\n  v_best_method text;",
     "  v_basis jsonb;\n  v_best_method text; -- mutated: the early return is disabled"]],
  // The Blake-requested follow-up review's two findings.
  'seasonal-window-one-month-late': [['scripts/sql/category_buy_forecast.sql',
    "    max(cum) filter (where z.n = ix.nl-12+hp.h)  as cNh,",
    "    max(cum) filter (where z.n = ix.nl-11+hp.h)  as cNh,"],
    ['scripts/sql/category_buy_forecast.sql',
     "round(greatest(r.cNh-r.cN12, 0))", "round(greatest(r.cNh-r.cN3+r.cN3-r.cN12, 0))"]],
  'backtest-velocity-reads-its-own-outcome': [['scripts/sql/category_buy_forecast.sql',
    "(ly.cum-k.c13) as s_seas, ((k.c1-k.c4)/3.0) as m3,",
    "(ly.cum-k.c13) as s_seas, ((k.cum-k.c4)/3.0) as m3,"]],
  // A forecast function shipped without its revoke -- the defect 20260917210000
  // found four live instances of.
  // Grants anon back AFTER the revoke, leaving the authenticated revoke intact,
  // so the pre-existing "not callable by a signed-in user" test cannot catch it
  // and only the anon check can. A mutation caught by the wrong test proves
  // nothing about the test it was written for.
  'forecast-function-open-to-anon': [[COMPETITION,
    "    execute format('grant execute on function public.%I(uuid, date, text, integer) to service_role', f);",
    "    execute format('grant execute on function public.%I(uuid, date, text, integer) to service_role, anon', f);"]],
  // The blend floors their SUM instead of each half -- which the review found
  // the suite could not tell apart, because every fixture was non-negative.
  'blend-floors-the-combined-figure': [['scripts/sql/category_buy_forecast.sql',
    "         else round(0.5*round(greatest(r.cNh-r.cN12, 0))\n                  + 0.5*round(greatest((r.cN-r.cN3)/3.0*(select h from hp), 0))) end as fc_units",
    "         else round(greatest(0.5*(r.cNh-r.cN12)\n                  + 0.5*((r.cN-r.cN3)/3.0*(select h from hp)), 0)) end as fc_units"]],
  'scorer-open-to-authenticated': [[COMPETITION,
    'revoke all on function public.score_forecast_methods(uuid, text, integer, date, date) from public, anon, authenticated;\ngrant execute on function public.score_forecast_methods(uuid, text, integer, date, date) to service_role;',
    'grant execute on function public.score_forecast_methods(uuid, text, integer, date, date) to authenticated, service_role;']],
};
const mutation = process.env.FMC_MUTATION || '';
assert.ok(mutation === '' || mutation in MUTATIONS, `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
const num = (v) => (v === null || v === undefined ? null : Number(v));
const day = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 10));

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
const asUser = (user, fn) => asRole('authenticated', user, fn);

// ── Schema ──────────────────────────────────────────────────────────────────
const BASEBALLISM = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const OTHER_CO = randomUUID();
const planner = randomUUID();
const outsider = randomUUID();

await db.exec('create extension if not exists pgcrypto;');
await db.exec(await readFile(new URL('scripts/tests/forecast-db-bootstrap.sql', root), 'utf8'));
await q('insert into public.entities (id, title) values ($1, $2)', [BASEBALLISM, 'Baseballism']);
for (const path of MIGRATIONS) {
  let sql = await readFile(new URL(path, root), 'utf8');
  for (const [file, from, to] of MUTATIONS[mutation] || []) {
    if (file !== path) continue;
    assert.ok(sql.includes(from), `mutation ${mutation}: anchor not found: ${from.slice(0, 70)}`);
    sql = sql.replace(from, to);
  }
  await db.exec(sql);
}

await test('competition migration preserves populated and voided legacy ledgers on apply and retry', async () => {
  const legacy = new PGlite({ extensions: { pgcrypto } });
  try {
    await legacy.exec('create extension if not exists pgcrypto');
    await legacy.exec(await readFile(new URL('scripts/tests/forecast-db-bootstrap.sql', root), 'utf8'));
    const company = randomUUID();
    await legacy.query('insert into public.entities (id, title) values ($1, $2)', [company, 'Migration fixture']);
    for (const path of MIGRATIONS.slice(0, 2)) {
      await legacy.exec(await readFile(new URL(path, root), 'utf8'));
    }
    await legacy.query(`insert into public.forecast_candidate_ledger (
      company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days,
      forecast_qty, executed_at, horizon_start_date, horizon_end_date,
      recent_window_start, recent_window_end, recent_demand,
      prior_window_start, prior_window_end, prior_demand,
      prior_year_target_month, prior_year_target_demand, raw_ratio, clamped_ratio,
      ratio_clamp_low, ratio_clamp_high, ratio_was_clamped,
      method_version, candidate_spec, source_relation, voided_at, void_reason)
      select $1, 'Candidate_YoY_Shift_v1', '2026-09-01', category, 30,
        100, '2026-09-03T12:00:00Z', '2026-09-01', '2026-10-01',
        '2026-06-01', '2026-09-01', 300, '2025-06-01', '2025-09-01', 300,
        '2025-09-01', 100, 1, 1, 0.6, 1.8, false,
        'legacy-v1', '{"fixture":true}'::jsonb, 'fixture',
        case when category = 'Voided' then '2026-09-04T12:00:00Z'::timestamptz end,
        case when category = 'Voided' then 'fixture void' end
      from (values ('Active'), ('Voided')) categories(category)`, [company]);
    const snapshots = () => legacy.query(`select to_jsonb(l) - 'inputs_through_date' - 'method_inputs' as row
      from public.forecast_candidate_ledger l order by sku_category`);
    const before = (await snapshots()).rows;
    const sql = await readFile(new URL(COMPETITION, root), 'utf8');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await legacy.exec(sql);
      assert.deepEqual((await snapshots()).rows, before, 'all original fields must survive');
      const backfill = (await legacy.query(`select count(*)::int as n from public.forecast_candidate_ledger
        where inputs_through_date = cutoff_date - 1 and method_inputs = '{}'::jsonb`)).rows[0];
      assert.equal(backfill.n, 2);
      assert.equal((await legacy.query(`select tgenabled from pg_trigger
        where tgrelid = 'public.forecast_candidate_ledger'::regclass
        and tgname = 'forecast_candidate_ledger_append_only'`)).rows[0].tgenabled, 'O');
      await refused(() => legacy.query('update public.forecast_candidate_ledger set forecast_qty = 101'),
        /append-only|already voided/, 'forecast stays immutable');
      await refused(() => legacy.query('delete from public.forecast_candidate_ledger'),
        /append-only/, 'deletion stays forbidden');
    }
  } finally { await legacy.close(); }
});

// ── Fixtures ────────────────────────────────────────────────────────────────
async function makeUser(company, role = 'admin') {
  const id = randomUUID();
  await q('insert into auth.users (id) values ($1)', [id]);
  await q('insert into public.profiles (id, email, role, active_company_id) values ($1, $2, $3, $4)',
    [id, `${id}@example.test`, role, company]);
  return id;
}
async function sale(company, dayDate, productType, units) {
  await q(`insert into public.sales_by_day (company_entity_id, day_date, product_type, total_quantity_sold)
           values ($1,$2,$3,$4)`, [company, dayDate, productType, units]);
}
await q('insert into public.entities (id, title) values ($1, $2)', [OTHER_CO, 'Other Co']);
await makeUser(BASEBALLISM);
const plannerId = await makeUser(BASEBALLISM);
const outsiderId = await makeUser(OTHER_CO);
void planner; void outsider;

for (const [monthStart, units] of YOUTH_MONTHLY_DEMAND) {
  await sale(BASEBALLISM, `${monthStart.slice(0, 8)}05`, 'Youth', units);
}
await sale(BASEBALLISM, SYNCED_THROUGH, 'Youth', 0);
// A category with a HOLE in its recent window: present in the rollup for some
// months, absent for others. Absent is the case every method must refuse.
for (const monthStart of ['2026-04-01', '2026-06-01', '2026-08-01']) {
  await sale(BASEBALLISM, `${monthStart.slice(0, 8)}05`, 'Sporadic', 500);
}
// A category sold across THREE locations every month, which is what production
// looks like -- Youth carries 12 to 14 location rows a month there. The rollup
// is grained by location, so any code counting raw rows as months sees 3x the
// truth. Until 2026-09-18 the fixture was one row per month and this whole class
// of failure was invisible.
for (let i = 0; i < 40; i += 1) {
  const m = new Date(Date.UTC(2023, 4 + i, 5));
  if (m > new Date(Date.UTC(2026, 8, 5))) break;
  const iso = m.toISOString().slice(0, 10);
  for (const [loc, units] of [['online', 300], ['retail-sf', 120], ['wholesale-a', 80]]) {
    await q(`insert into public.sales_by_day
               (company_entity_id, day_date, location_tag, product_type, total_quantity_sold)
             values ($1,$2,$3,'Multisite',$4)`, [BASEBALLISM, iso, loc, units]);
  }
}
// A category that only started selling three months ago: its recent window is
// complete, its year-ago window does not exist. Exactly one half of the blend
// is available, which is the case the blend must refuse rather than quietly
// become a run rate under the blend's name.
for (const monthStart of ['2026-06-01', '2026-07-01', '2026-08-01']) {
  await sale(BASEBALLISM, `${monthStart.slice(0, 8)}05`, 'Fresh', 400);
}
for (const [monthStart] of YOUTH_MONTHLY_DEMAND) {
  await sale(OTHER_CO, `${monthStart.slice(0, 8)}05`, 'Youth', 777);
}
await db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');

const CUTOFF = '2026-09-01';

// ── 1. Each method, over the real series ────────────────────────────────────
// Computed by the shipped functions; pinned here so a later change to any
// window has to be argued for rather than absorbed.
await test('each method forecasts the real Youth series from data strictly before the cutoff', async () => {
  const expected = [
    // [method, horizon, forecast, the provenance fact that explains it]
    ['forecast_seasonal_naive_v1', 3, 67201, { months_present: 3 }],
    ['forecast_run_rate_v1', 3, 115699, { recent_3m_units: 115699 }],
    ['forecast_blend_v1', 3, 91450, {}],
    ['forecast_seasonal_naive_v1', 6, 123326, { months_present: 6 }],
    ['forecast_run_rate_v1', 6, 231398, { recent_3m_units: 115699 }],
    ['forecast_blend_v1', 6, 177362, {}],
  ];
  for (const [fn, horizon, qty, facts] of expected) {
    const r = await asService(() => first(
      `select * from public.${fn}($1, $2, 'Youth', $3)`, [BASEBALLISM, CUTOFF, horizon]));
    assert.equal(r.eligible, true, `${fn}/${horizon}: ${r.ineligible_reason}`);
    assert.equal(num(r.forecast_qty), qty, `${fn}/${horizon}`);
    // The whole prospective guarantee in one column: the newest day read is
    // before the cutoff, for every method, without exception.
    assert.equal(day(r.inputs_through_date), '2026-08-31', `${fn}/${horizon} inputs_through_date`);
    assert.ok(new Date(r.inputs_through_date) < new Date(CUTOFF));
    for (const [key, value] of Object.entries(facts)) {
      assert.equal(num(r.method_inputs[key]), value, `${fn}/${horizon}.${key}`);
    }
  }
  // The blend is exactly its halves, not a third opinion.
  assert.equal(Math.round(0.5 * 67201 + 0.5 * 115699), 91450);
  assert.equal(Math.round(0.5 * 123326 + 0.5 * 231398), 177362);
});

await test('the run rate refuses a window with an absent month instead of summing what is there', async () => {
  const r = await asService(() => first(
    `select * from public.forecast_run_rate_v1($1, $2, 'Sporadic', 3)`, [BASEBALLISM, CUTOFF]));
  // Jun and Aug are recorded, Jul is not. Summing 2 of 3 months and dividing by
  // 3 reports a data gap as a one-third collapse in demand.
  assert.equal(r.eligible, false);
  assert.equal(num(r.forecast_qty), null, 'an ineligible method must carry no number at all');
  assert.match(r.ineligible_reason, /2 of 3 months recorded/);
});

await test('the blend refuses unless BOTH halves are eligible', async () => {
  const r = await asService(() => first(
    `select * from public.forecast_blend_v1($1, $2, 'Sporadic', 3)`, [BASEBALLISM, CUTOFF]));
  assert.equal(r.eligible, false);
  assert.equal(num(r.forecast_qty), null);
  // A blend that silently becomes whichever half survived is a different
  // method wearing the blend's name in the ledger.
  assert.match(r.ineligible_reason, /blend needs both halves/);

  // And the harder case: the run rate IS available, only the seasonal half is
  // missing. This is the one a fallback would swallow.
  const half = await asService(() => first(
    `select * from public.forecast_blend_v1($1, $2, 'Fresh', 3)`, [BASEBALLISM, CUTOFF]));
  const runHalf = await asService(() => first(
    `select * from public.forecast_run_rate_v1($1, $2, 'Fresh', 3)`, [BASEBALLISM, CUTOFF]));
  assert.equal(runHalf.eligible, true, 'the run rate half should be available here');
  assert.equal(num(runHalf.forecast_qty), 1200);
  assert.equal(half.eligible, false, 'one half is not a blend');
  assert.equal(num(half.forecast_qty), null);
  assert.match(half.ineligible_reason, /blend needs both halves/);
});

await test('the frozen candidate is scored at its own horizon and nowhere else', async () => {
  const one = await asService(() => first(
    `select * from public.forecast_for_method('Candidate_YoY_Shift_v1', $1, $2, 'Youth', 1)`,
    [BASEBALLISM, CUTOFF]));
  assert.equal(one.eligible, true);
  // The specification's own arithmetic: 115,699 / 59,124 -> 1.957, clamped to
  // 1.80, applied to the 4,297 of September last year.
  assert.equal(num(one.forecast_qty), 7735);
  assert.equal(num(one.method_inputs.recent_demand), 115699);
  assert.equal(num(one.method_inputs.prior_demand), 59124);
  assert.equal(num(one.method_inputs.clamped_ratio), 1.8);

  const three = await asService(() => first(
    `select * from public.forecast_for_method('Candidate_YoY_Shift_v1', $1, $2, 'Youth', 3)`,
    [BASEBALLISM, CUTOFF]));
  assert.equal(three.eligible, false);
  assert.match(three.ineligible_reason, /single month only/);
});

await test('an unknown method raises rather than returning nothing', async () => {
  await refused(() => asService(() => q(
    `select * from public.forecast_for_method('made_up_v9', $1, $2, 'Youth', 3)`, [BASEBALLISM, CUTOFF])),
    /unknown method made_up_v9/, 'unknown method');
});

// ── 2. Scoring ──────────────────────────────────────────────────────────────
await test('scoring the real series ranks the methods, and no method is credited for an unfinished window', async () => {
  const rows = await asService(() => q(
    `select method, windows, round(wape, 4) wape, round(bias, 4) bias
       from public.score_forecast_methods($1, 'Youth', 6, '2024-09-01', '2026-08-31')`,
    [BASEBALLISM]));
  const byMethod = Object.fromEntries(rows.map((r) => [r.method, r]));
  // Candidate_YoY_Shift_v1 is a one-month method and must not appear here at
  // all -- an absent row is the honest answer, a scored one would mean it had
  // been stretched to a window nobody specified.
  assert.deepEqual(Object.keys(byMethod).sort(),
    ['blend_v1', 'run_rate_v1', 'seasonal_naive_v1']);
  // The last origin whose 6-month window closes inside the evidence range is
  // 2026-03-01: 19 origins from 2024-09-01, not 24.
  for (const r of rows) assert.equal(r.windows, 19, `${r.method} windows`);
  // Measured, not asserted from theory: on this series the run rate wins and
  // every method still UNDER-forecasts, which is what a category growing this
  // fast does to all three.
  assert.equal(num(byMethod.run_rate_v1.wape), 0.389);
  assert.equal(num(byMethod.blend_v1.wape), 0.5226);
  assert.equal(num(byMethod.seasonal_naive_v1.wape), 0.7424);
  for (const r of rows) assert.ok(num(r.bias) < 0, `${r.method} bias ${r.bias}`);
  // Seasonal naive's bias equals its WAPE: it is under on every single window.
  assert.equal(num(byMethod.seasonal_naive_v1.bias), -num(byMethod.seasonal_naive_v1.wape));
});

await test('the scorer refuses a null company rather than reporting no methods', async () => {
  // The distinction that matters: "you did not say which company" must not
  // render identically to "this category has no history".
  await refused(() => asService(() => q(
    `select * from public.score_forecast_methods(null, 'Youth', 6, '2024-09-01', '2026-08-31')`)),
    /a company is required/, 'null company');
});

await test('scoring is scoped to the company asked about', async () => {
  const other = await asService(() => q(
    `select method, round(wape, 4) wape from public.score_forecast_methods($1, 'Youth', 6, '2024-09-01', '2026-08-31')`,
    [OTHER_CO]));
  // Other Co's Youth is a flat 777 a month, so its run rate is exact. A leak
  // from Baseballism would show up as a wrong NUMBER, not a wrong row count.
  const run = other.find((r) => r.method === 'run_rate_v1');
  assert.equal(num(run.wape), 0, `other company run rate should be exact, got ${run.wape}`);
});

// ── 3. The selection record ─────────────────────────────────────────────────
await test('a selection is recorded with evidence that ends before the cutoff it governs', async () => {
  const r = await asService(() => first(
    `select * from public.select_forecast_method($1, 'Youth', 6, $2, 18, 'first competition')`,
    [BASEBALLISM, CUTOFF]));
  assert.equal(r.selected_method, 'run_rate_v1');
  assert.equal(day(r.evidence_from), '2025-03-01');
  assert.equal(day(r.evidence_to), '2026-08-31');
  assert.ok(new Date(r.evidence_to) < new Date(CUTOFF), 'evidence must end before the cutoff');
  assert.equal(r.windows, 13);

  const stored = await asService(() => first(
    `select selected_method, effective_from_cutoff, evidence_to, selection_basis, note
       from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Youth' and horizon_months = 6`, [BASEBALLISM]));
  assert.equal(stored.selected_method, 'run_rate_v1');
  assert.equal(day(stored.effective_from_cutoff), CUTOFF);
  assert.equal(stored.note, 'first competition');
  // Every method's score is kept, not just the winner's, so a close call reads
  // as a close call years later -- and the rule and its one knob are stored
  // beside them, because "lowest WAPE" is only checkable against the losers.
  assert.match(stored.selection_basis.rule, /lowest WAPE/);
  assert.equal(Number(stored.selection_basis.evidence_months), 18);
  assert.equal(stored.selection_basis.scores.length, 3);
  assert.equal(stored.selection_basis.scores[0].method, 'run_rate_v1',
    'the basis must be ordered so the winner is the first score');
});

await test('re-running a selection does not mint a second one', async () => {
  await asService(() => q(
    `select * from public.select_forecast_method($1, 'Youth', 6, $2, 18, 'second attempt')`,
    [BASEBALLISM, CUTOFF]));
  const n = await asService(() => first(
    `select count(*)::int c from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Youth' and horizon_months = 6`, [BASEBALLISM]));
  assert.equal(n.c, 1);
  const note = await asService(() => first(
    `select note from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Youth' and horizon_months = 6`, [BASEBALLISM]));
  assert.equal(note.note, 'first competition', 'the original selection must survive a re-run');
});

await test('the table refuses a selection whose evidence reaches its own cutoff', async () => {
  // THE constraint. Written directly, as a service-role insert, because that is
  // the path a job takes -- a check living in the job would not be here to run.
  await refused(() => asService(() => q(
    `insert into public.forecast_method_selections
       (company_entity_id, sku_category, horizon_months, selected_method,
        effective_from_cutoff, evidence_from, evidence_to, selection_basis)
     values ($1, 'Youth', 3, 'run_rate_v1', '2026-09-01', '2025-09-01', '2026-09-01', '[]'::jsonb)`,
    [BASEBALLISM])), /fms_evidence_precedes_cutoff/, 'evidence reaching the cutoff');

  // One day earlier is the boundary, and it is allowed.
  await asService(() => q(
    `insert into public.forecast_method_selections
       (company_entity_id, sku_category, horizon_months, selected_method,
        effective_from_cutoff, evidence_from, evidence_to, selection_basis)
     values ($1, 'Boundary', 3, 'run_rate_v1', '2026-09-01', '2025-09-01', '2026-08-31', '[]'::jsonb)`,
    [BASEBALLISM]));
});

await test('a recorded selection cannot be edited or deleted, even by the service role', async () => {
  await refused(() => asService(() => q(
    `update public.forecast_method_selections set selected_method = 'seasonal_naive_v1'
      where company_entity_id = $1 and sku_category = 'Youth'`, [BASEBALLISM])),
    /append-only/, 'update');
  // The DELETE branch has its own message; exercising it is what proves the
  // branch runs at all rather than erroring on its own format string.
  await refused(() => asService(() => q(
    `delete from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Youth'`, [BASEBALLISM])),
    /append-only.*cannot be deleted/s, 'delete');
});

await test('select_forecast_method records nothing when no method could be scored', async () => {
  const r = await asService(() => first(
    `select * from public.select_forecast_method($1, 'Sporadic', 6, $2, 18)`, [BASEBALLISM, CUTOFF]));
  assert.equal(r.selected_method, null, 'a pick with no evidence behind it is a guess');
  const n = await asService(() => first(
    `select count(*)::int c from public.forecast_method_selections where sku_category = 'Sporadic'`));
  assert.equal(n.c, 0);
});

await test('the governing method is the newest selection at or before a cutoff, and NULL before any', async () => {
  const before = await asService(() => first(
    `select public.forecast_method_for_cutoff($1, 'Youth', 6, '2026-08-01') m`, [BASEBALLISM]));
  assert.equal(before.m, null, 'a cutoff before any selection is governed by nothing, not by a default');

  const at = await asService(() => first(
    `select public.forecast_method_for_cutoff($1, 'Youth', 6, $2) m`, [BASEBALLISM, CUTOFF]));
  assert.equal(at.m, 'run_rate_v1');

  await asService(() => q(
    `insert into public.forecast_method_selections
       (company_entity_id, sku_category, horizon_months, selected_method,
        effective_from_cutoff, evidence_from, evidence_to, selection_basis)
     values ($1, 'Youth', 6, 'blend_v1', '2026-11-01', '2025-05-01', '2026-10-31', '[]'::jsonb)`,
    [BASEBALLISM]));
  const later = await asService(() => first(
    `select public.forecast_method_for_cutoff($1, 'Youth', 6, '2026-11-01') m`, [BASEBALLISM]));
  assert.equal(later.m, 'blend_v1');
  const unchanged = await asService(() => first(
    `select public.forecast_method_for_cutoff($1, 'Youth', 6, $2) m`, [BASEBALLISM, CUTOFF]));
  assert.equal(unchanged.m, 'run_rate_v1', 'a later selection must not reach back over an earlier cutoff');
});

// ── 4. Writing a method's forecast into the ledger ──────────────────────────
await test('a method run is frozen once, with its inputs bounded before the cutoff', async () => {
  const r = await asService(() => first(
    `select * from public.record_forecast_method_run($1, $2, 'Youth', 'run_rate_v1', 6)`,
    [BASEBALLISM, CUTOFF]));
  assert.equal(r.action, 'inserted');
  assert.equal(num(r.forecast_qty), 231398);

  const row = await asService(() => first(
    `select candidate_id, horizon_days, inputs_through_date, cutoff_date, horizon_start_date,
            horizon_end_date, method_inputs, source_relation, candidate_spec
       from public.forecast_candidate_ledger where id = $1`, [r.ledger_id]));
  assert.equal(row.candidate_id, 'run_rate_v1');
  assert.equal(day(row.inputs_through_date), '2026-08-31');
  assert.ok(new Date(row.inputs_through_date) < new Date(row.cutoff_date));
  assert.equal(day(row.horizon_end_date), '2027-03-01');
  assert.equal(Number(row.horizon_days), 181);
  assert.equal(num(row.method_inputs.recent_3m_units), 115699);
  assert.equal(row.candidate_spec.stockout_imputation, false);

  const again = await asService(() => first(
    `select * from public.record_forecast_method_run($1, $2, 'Youth', 'run_rate_v1', 6)`,
    [BASEBALLISM, CUTOFF]));
  assert.equal(again.action, 'existing');
  assert.equal(again.ledger_id, r.ledger_id);
  assert.match(again.reason, /not recalculated/);
});

await test('the ledger refuses a row whose inputs reach its own cutoff', async () => {
  // The generalised no-look-ahead guarantee, tested where it lives. The
  // original CHECK keyed on Candidate_YoY_Shift_v1's provenance columns, which
  // are nullable now -- a CHECK passes trivially on NULL, so this column is
  // what carries it for every method including ones added later.
  await refused(() => asService(() => q(
    `insert into public.forecast_candidate_ledger
       (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days,
        forecast_qty, horizon_start_date, horizon_end_date, inputs_through_date,
        method_version, candidate_spec, source_relation)
     values ($1, 'run_rate_v1', '2026-10-01', 'Youth', 181, 1, '2026-10-01', '2027-04-01',
             '2026-10-01', 'run_rate_v1', '{}'::jsonb, 'sales_monthly_product_type_rollup_mv')`,
    [BASEBALLISM])), /forecast_ledger_inputs_precede_cutoff/, 'inputs reaching the cutoff');
});

await test('the generic writer refuses the candidate, which has its own writer', async () => {
  // Two writers for one candidate would mint two rows for one forecast: this
  // one derives horizon_days from a calendar month (31 in October) where
  // record_forecast_candidate_run uses a fixed 30.
  await refused(() => asService(() => q(
    `select * from public.record_forecast_method_run($1, $2, 'Youth', 'Candidate_YoY_Shift_v1', 1)`,
    [BASEBALLISM, CUTOFF])), /written by record_forecast_candidate_run/, 'candidate via the generic writer');
});

await test('an ineligible method writes no ledger row at all', async () => {
  const r = await asService(() => first(
    `select * from public.record_forecast_method_run($1, $2, 'Sporadic', 'run_rate_v1', 6)`,
    [BASEBALLISM, CUTOFF]));
  assert.equal(r.action, 'skipped');
  assert.equal(r.ledger_id, null);
  assert.match(r.reason, /2 of 3 months recorded/);
  const n = await asService(() => first(
    `select count(*)::int c from public.forecast_candidate_ledger where sku_category = 'Sporadic'`));
  assert.equal(n.c, 0);
});

// ── 5. Who can reach any of this ────────────────────────────────────────────
await test('none of the new service-role functions are callable by a signed-in user', async () => {
  const calls = [
    [`select * from public.score_forecast_methods($1, 'Youth', 6, '2024-09-01', '2026-08-31')`, [BASEBALLISM]],
    [`select * from public.select_forecast_method($1, 'Youth', 3, '2026-12-01')`, [BASEBALLISM]],
    [`select * from public.record_forecast_method_run($1, '2026-12-01', 'Youth', 'run_rate_v1', 6)`, [BASEBALLISM]],
    [`select public.forecast_method_for_cutoff($1, 'Youth', 6, '2026-12-01')`, [BASEBALLISM]],
    [`select * from public.forecast_run_rate_v1($1, '2026-12-01', 'Youth', 6)`, [BASEBALLISM]],
    [`select * from public.forecast_seasonal_naive_v1($1, '2026-12-01', 'Youth', 6)`, [BASEBALLISM]],
    [`select * from public.forecast_blend_v1($1, '2026-12-01', 'Youth', 6)`, [BASEBALLISM]],
    [`select * from public.forecast_for_method('run_rate_v1', $1, '2026-12-01', 'Youth', 6)`, [BASEBALLISM]],
  ];
  for (const [sql, params] of calls) {
    await refused(() => asUser(plannerId, () => q(sql, params)),
      /permission denied/i, sql.slice(0, 60));
  }
});

await test('a user sees only their own company selections, and cannot write one', async () => {
  await asService(() => q(
    `insert into public.forecast_method_selections
       (company_entity_id, sku_category, horizon_months, selected_method,
        effective_from_cutoff, evidence_from, evidence_to, selection_basis)
     values ($1, 'Youth', 3, 'seasonal_naive_v1', '2026-09-01', '2025-09-01', '2026-08-31', '[]'::jsonb)`,
    [OTHER_CO]));

  const mine = await asUser(plannerId, () => q(
    `select distinct company_entity_id from public.forecast_method_selections`));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].company_entity_id, BASEBALLISM);

  const theirs = await asUser(outsiderId, () => q(
    `select selected_method from public.forecast_method_selections`));
  assert.deepEqual(theirs.map((r) => r.selected_method), ['seasonal_naive_v1']);

  // Supabase grants ALL on a new public table by default and an RLS-denied
  // write is a SUCCESS WITH ZERO ROWS, not an error -- so the revoke is what
  // has to be tested, not the missing policy.
  await refused(() => asUser(plannerId, () => q(
    `insert into public.forecast_method_selections
       (company_entity_id, sku_category, horizon_months, selected_method,
        effective_from_cutoff, evidence_from, evidence_to, selection_basis)
     values ($1, 'Youth', 12, 'blend_v1', '2027-01-01', '2025-09-01', '2026-08-31', '[]'::jsonb)`,
    [BASEBALLISM])), /permission denied/i, 'user insert');
  await refused(() => asUser(plannerId, () => q(
    `delete from public.forecast_method_selections where sku_category = 'Youth'`)),
    /permission denied/i, 'user delete');
});

await test('a category sold in several locations is scored, not discarded as incomplete', async () => {
  // THE production-grain regression. The rollup has one row per
  // (month, location, channel, product_type), so a six-month window over three
  // locations is 18 rows. Counting rows as months made months_present 18, the
  // window failed the `= p_horizon_months` test, and NOTHING was ever scored or
  // selected -- in production, with every test passing.
  const perMonth = await asService(() => first(
    `select count(*)::int rows, count(distinct month_start)::int months
       from public.sales_monthly_product_type_rollup_mv
      where company_entity_id = $1 and product_type = 'Multisite'
        and month_start = '2026-06-01'`, [BASEBALLISM]));
  assert.equal(perMonth.rows, 3, 'the fixture must carry production\'s location grain');
  assert.equal(perMonth.months, 1);

  const scores = await asService(() => q(
    `select method, windows, round(wape, 4) wape
       from public.score_forecast_methods($1, 'Multisite', 6, '2024-09-01', '2026-08-31')`,
    [BASEBALLISM]));
  assert.ok(scores.length > 0, 'a multi-location category must be scorable at all');
  for (const r of scores) assert.equal(r.windows, 19, `${r.method}: every window must be complete`);
  // Flat demand across all three locations, so the run rate is exact. A leak of
  // the location grain into the ACTUAL would show as a non-zero error here.
  const run = scores.find((r) => r.method === 'run_rate_v1');
  assert.equal(Number(run.wape), 0, `run rate should be exact on flat demand, got ${run.wape}`);

  // ...and a selection follows from it. WHICH method wins is deliberately not
  // asserted: on perfectly flat demand all three are exact, and the rule is
  // lowest WAPE with no tie-break, so a tie is resolved arbitrarily by design.
  // Pinning the winner here would be pinning that arbitrariness.
  const pick = await asService(() => first(
    `select * from public.select_forecast_method($1, 'Multisite', 6, '2026-09-01', 18)`,
    [BASEBALLISM]));
  assert.ok(pick.selected_method, 'a scorable category must produce a selection');
  // 13, not the 19 above: the selector's own evidence window is the 18 months
  // before the cutoff (2025-03-01..2026-08-31), and the last origin whose
  // six-month window closes inside it is 2026-03-01.
  assert.equal(pick.windows, 13);
});

await test('a re-run reports the SELECTION THAT IS STORED, not a freshly recomputed winner', async () => {
  // A late sales correction can move the apparent winner. The append-only
  // insert correctly does nothing on conflict -- but returning the recomputed
  // winner would have the monthly job report a method the durable record does
  // not name, which is the one thing this table exists to make impossible.
  const stored = await asService(() => first(
    `select selected_method from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Multisite' and horizon_months = 6`,
    [BASEBALLISM]));
  assert.ok(stored.selected_method, 'the previous test must have frozen a selection');

  // A step change landing after the selection was frozen. Forty times the
  // volume from January on leaves the seasonal methods reading a year that no
  // longer resembles this one, so the apparent winner moves -- which is the
  // whole premise of the test.
  await q(`update public.sales_by_day set total_quantity_sold = total_quantity_sold * 40
            where company_entity_id = $1 and product_type = 'Multisite'
              and day_date >= '2026-01-01'`, [BASEBALLISM]);
  await db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');

  const fresh = await asService(() => q(
    `select method, round(wape, 4) wape from public.score_forecast_methods(
       $1, 'Multisite', 6, '2025-03-01', '2026-08-31')`, [BASEBALLISM]));
  assert.notEqual(fresh[0].method, stored.selected_method,
    'the correction must actually change the apparent winner, or this proves nothing');

  const again = await asService(() => first(
    `select * from public.select_forecast_method($1, 'Multisite', 6, '2026-09-01', 18)`,
    [BASEBALLISM]));
  assert.equal(again.selected_method, stored.selected_method,
    'the re-run must report the frozen selection, not today\'s winner');
  // The evidence window and basis returned belong to the stored row too, so a
  // caller logging them cannot print a window the record does not carry.
  assert.equal(day(again.evidence_from), '2025-03-01');
  assert.equal(day(again.evidence_to), '2026-08-31');
  assert.equal(again.basis.scores[0].method, stored.selected_method);

  const count = await asService(() => first(
    `select count(*)::int c from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Multisite'`, [BASEBALLISM]));
  assert.equal(count.c, 1);
});

await test('a frozen selection survives an evidence window that no longer scores', async () => {
  // The other half of the same defect. The first fix read the stored row only
  // on the INSERT's conflict path -- which is never reached when today's scores
  // come back empty, because the no-winner branch returns first. A late
  // deletion or a source gap then made a re-run log "NO SELECTION" and count
  // the cutoff unresolved while the durable selection sat in the table.
  const stored = await asService(() => first(
    `select selected_method, evidence_from, evidence_to from public.forecast_method_selections
      where company_entity_id = $1 and sku_category = 'Multisite' and horizon_months = 6`,
    [BASEBALLISM]));
  assert.ok(stored.selected_method);

  // Remove the category's history entirely: nothing can be scored now.
  await q(`delete from public.sales_by_day where company_entity_id = $1 and product_type = 'Multisite'`,
    [BASEBALLISM]);
  await db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');
  const empty = await asService(() => q(
    `select * from public.score_forecast_methods($1, 'Multisite', 6, '2025-03-01', '2026-08-31')`,
    [BASEBALLISM]));
  assert.equal(empty.length, 0, 'the fixture must actually leave nothing scorable');

  const again = await asService(() => first(
    `select * from public.select_forecast_method($1, 'Multisite', 6, '2026-09-01', 18)`,
    [BASEBALLISM]));
  assert.equal(again.selected_method, stored.selected_method,
    'a re-run must report the frozen selection even when nothing scores today');
  assert.equal(day(again.evidence_from), day(stored.evidence_from));
  assert.equal(day(again.evidence_to), day(stored.evidence_to));
  assert.ok(again.basis.scores.length > 0,
    'the stored basis must come back, not an empty one recomputed from no data');
});

// ── 5b. The REAL runner against the REAL database ───────────────────────────
// The core passing against a stub and the SQL passing against a fixture is
// exactly the state in which an orchestrator bug shipped here before -- a
// temporal-dead-zone reference in a callback no test executed (2026-09-09).
// The unit suite drives runMethodCompetition against a fake client and pins the
// ORDER of its calls; this drives the same entry point through a client that
// issues real SQL, so the argument names, the return shapes and the service-role
// grants are all executed rather than assumed.
function pgliteClient() {
  return {
    async rpc(fn, args) {
      try {
        if (fn === 'forecast_actuals_matured_through') {
          const row = await first('select public.forecast_actuals_matured_through($1) as v',
            [args.p_company_entity_id]);
          return { data: row.v ? day(row.v) : null, error: null };
        }
        // Named notation throughout, and every optional argument deliberately
        // OMITTED, exactly as the real client leaves them out -- the database's
        // defaults are the single definition of them. Passing them here would
        // test a call the runner never makes.
        if (fn === 'select_forecast_method') {
          return { data: await q(
            `select * from public.select_forecast_method(
               p_company_entity_id => $1, p_sku_category => $2, p_horizon_months => $3,
               p_effective_from_cutoff => $4, p_evidence_months => $5)`,
            [args.p_company_entity_id, args.p_sku_category, args.p_horizon_months,
             args.p_effective_from_cutoff, args.p_evidence_months]), error: null };
        }
        if (fn === 'record_forecast_method_run') {
          return { data: await q(
            `select * from public.record_forecast_method_run(
               p_company_entity_id => $1, p_cutoff_date => $2, p_sku_category => $3,
               p_method => $4, p_horizon_months => $5)`,
            [args.p_company_entity_id, args.p_cutoff_date, args.p_sku_category,
             args.p_method, args.p_horizon_months]), error: null };
        }
        throw new Error(`unexpected rpc ${fn}`);
      } catch (error) {
        return { data: null, error: { message: error.message } };
      }
    },
  };
}

await test('the competition runner, executed for real, selects then freezes every method', async () => {
  const co = randomUUID();
  await q('insert into public.entities (id, title) values ($1, $2)', [co, 'Runner Co']);
  // 40 months of demand ending 2026-08, rising, so both horizons are scorable
  // over the evidence window and a selection is actually reachable.
  for (let i = 0; i < 40; i += 1) {
    const m = new Date(Date.UTC(2023, 4 + i, 5));
    if (m > new Date(Date.UTC(2026, 7, 5))) break;
    await sale(co, m.toISOString().slice(0, 10), 'Youth', 100 + i * 3);
  }
  // A partial current month is what makes the previous one provably complete.
  await sale(co, '2026-09-02', 'Youth', 40);
  await db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');

  await db.exec('set role service_role');
  let out;
  try {
    out = await runMethodCompetition({
      client: pgliteClient(), companyEntityId: co, skuCategory: 'Youth',
      startCutoff: '2026-06-01', logger: { log() {}, error() {} },
    });
  } finally { await db.exec('reset role'); }

  assert.equal(out.summary.failed, 0, JSON.stringify(out.results.filter((r) => r.action === 'failed')));
  // The catch-up range is still attempted -- a dropped monthly run is what it is
  // for -- and the database decides which cutoffs may still be frozen.
  assert.deepEqual(out.cutoffs, ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);

  const selections = await asService(() => q(
    `select sku_category, horizon_months, selected_method, effective_from_cutoff, evidence_to
       from public.forecast_method_selections where company_entity_id = $1
      order by effective_from_cutoff, horizon_months`, [co]));
  assert.equal(selections.length, out.summary.selections_recorded);
  assert.ok(selections.length > 0, 'the run should have recorded at least one selection');
  for (const s of selections) {
    // The guarantee, on rows the real runner wrote rather than the test.
    assert.ok(new Date(s.evidence_to) < new Date(s.effective_from_cutoff),
      `${s.effective_from_cutoff}/${s.horizon_months}m: evidence_to ${s.evidence_to}`);
    assert.ok(COMPETITION_HORIZON_MONTHS.includes(Number(s.horizon_months)));
    assert.ok(COMPETITION_METHODS.includes(s.selected_method));
  }

  const frozen = await asService(() => q(
    `select candidate_id, horizon_months, cutoff_date, inputs_through_date
       from public.forecast_candidate_ledger_v where company_entity_id = $1`, [co]));
  assert.equal(frozen.length, out.summary.inserted);
  for (const f of frozen) {
    assert.ok(new Date(f.inputs_through_date) < new Date(f.cutoff_date),
      `${f.candidate_id} at ${f.cutoff_date} read through ${f.inputs_through_date}`);
    assert.ok(COMPETITION_METHODS.includes(f.candidate_id));
  }
  // Every closed horizon is refused rather than backfilled, and nothing the
  // runner could not compute was written as a number.
  assert.ok(out.summary.expired > 0, 'the closed horizons must be refused');
  assert.equal(out.results.filter((r) => r.action === 'inserted' && r.forecastQty == null).length, 0);

  // Re-running writes nothing new, on either half.
  let again;
  await db.exec('set role service_role');
  try {
    again = await runMethodCompetition({
      client: pgliteClient(), companyEntityId: co, skuCategory: 'Youth',
      startCutoff: '2026-06-01', logger: { log() {}, error() {} },
    });
  } finally { await db.exec('reset role'); }
  assert.equal(again.summary.inserted, 0, 'a re-run must freeze nothing new');
  assert.equal(again.summary.failed, 0);
  const after = await asService(() => first(
    `select (select count(*)::int from public.forecast_method_selections where company_entity_id = $1) s,
            (select count(*)::int from public.forecast_candidate_ledger where company_entity_id = $1) l`, [co]));
  assert.equal(after.s, selections.length, 'a re-run must not mint a second selection');
  assert.equal(after.l, frozen.length);
});

// ── 6. The buy report's forward-performance columns ─────────────────────────
// The whole report, as the saved report runs it: one statement, bound
// parameter, executed as a signed-in user so every RLS-scoped wrapper it reads
// is under that user's own scoping. Testing only the CTE I added would have
// missed the join that decides which frozen forecast counts, which is the only
// part of this with a decision in it.
let REPORT_SQL = await readFile(new URL('scripts/sql/category_buy_forecast.sql', root), 'utf8');
for (const [file, from, to] of MUTATIONS[mutation] || []) {
  if (file !== 'scripts/sql/category_buy_forecast.sql') continue;
  assert.ok(REPORT_SQL.includes(from), `mutation ${mutation}: report anchor not found: ${from.slice(0, 70)}`);
  REPORT_SQL = REPORT_SQL.split(from).join(to);
}

// The report reads product titles, not the day-level sales table, so the
// fixture has to carry the same series through that surface too.
for (const [monthStart, units] of YOUTH_MONTHLY_DEMAND) {
  await q(`insert into public.sales_by_product_title_daily_mv
             (company_entity_id, product_type, product_title, day_date, units_sold)
           values ($1, 'Youth', 'Youth Tee', $2, $3)`,
    [BASEBALLISM, `${monthStart.slice(0, 8)}05`, units]);
}
// Inventory-tracked, so the forecastable classification keeps it.
await q(`insert into public.inventory_on_hand_current_mv
           (company_entity_id, product_type, location_tag, total_available_quantity)
         values ($1, 'Youth', 'online', 100)`, [BASEBALLISM]);

// Three MATURED cycles, written as a job in early 2025 would have written them:
// frozen a day into their own cutoff, horizons long closed, actuals since
// synced. Inserted directly because the writer refuses a closed horizon -- which
// is the correct refusal and also why a fixture cannot go through it.
const MATURED = [
  ['2025-01-01', '2025-07-01', 60000],
  ['2025-02-01', '2025-08-01', 62000],
  ['2025-03-01', '2025-09-01', 65000],
];
// The selection that governed them, effective before the first of them.
await asService(() => q(
  `insert into public.forecast_method_selections
     (company_entity_id, sku_category, horizon_months, selected_method,
      effective_from_cutoff, evidence_from, evidence_to, selection_basis)
   values ($1, 'Youth', 6, 'run_rate_v1', '2025-01-01', '2023-07-01', '2024-12-31', '{}'::jsonb)`,
  [BASEBALLISM]));
for (const [cutoff, end, qty] of MATURED) {
  for (const [method, forecast] of [['run_rate_v1', qty], ['seasonal_naive_v1', qty * 3]]) {
    await asService(() => q(
      `insert into public.forecast_candidate_ledger
         (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days,
          forecast_qty, executed_at, horizon_start_date, horizon_end_date,
          inputs_through_date, method_version, candidate_spec, source_relation)
       values ($1::uuid, $2::text, $3::date, 'Youth', ($4::date - $3::date), $5::numeric,
               ($3::date + 1)::timestamptz, $3::date, $4::date, ($3::date - 1), $2::text,
               jsonb_build_object('method', $2::text, 'horizon_months', 6),
               'sales_monthly_product_type_rollup_mv')`,
      [BASEBALLISM, method, cutoff, end, forecast]));
  }
}

// SIX accurate seasonal_naive_v1 cycles for the same category and horizon. This
// is the cycle-2 review's scenario made real: if the forward record were pooled
// per category rather than per method, these six would hand their accuracy to
// whatever method the report happens to display.
const SEASONAL_GOOD = ['2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01'];
const youthByMonth = new Map(YOUTH_MONTHLY_DEMAND);
function sixMonthActual(cutoff) {
  const end = new Date(`${cutoff}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 6);
  const endIso = end.toISOString().slice(0, 10);
  let total = 0;
  for (const [month, units] of youthByMonth) {
    if (month >= cutoff && month < endIso) total += units;
  }
  return { endIso, total };
}
for (const cutoff of SEASONAL_GOOD) {
  const { endIso, total } = sixMonthActual(cutoff);
  await asService(() => q(
    `insert into public.forecast_candidate_ledger
       (company_entity_id, candidate_id, cutoff_date, sku_category, horizon_days,
        forecast_qty, executed_at, horizon_start_date, horizon_end_date,
        inputs_through_date, method_version, candidate_spec, source_relation)
     values ($1::uuid, 'seasonal_naive_v1', $2::date, 'Youth', ($3::date - $2::date), $4::numeric,
             ($2::date + 1)::timestamptz, $2::date, $3::date, ($2::date - 1), 'seasonal_naive_v1',
             jsonb_build_object('method', 'seasonal_naive_v1', 'horizon_months', 6),
             'sales_monthly_product_type_rollup_mv')
     on conflict do nothing`,
    [BASEBALLISM, cutoff, endIso, total]));
}

// Three fixtures for the report's own arithmetic, all with enough history that
// the backtest windows exist and enough volume to clear the report's 5,000-unit
// floor. Each is inventory-tracked so the forecastable classification keeps it.
async function seedReportCategory(name, unitsFor) {
  for (let i = 0; i < 60; i += 1) {
    const m = new Date(Date.UTC(2021, 8 + i, 5));
    if (m > new Date(Date.UTC(2026, 7, 5))) break;
    const iso = m.toISOString().slice(0, 10);
    const units = unitsFor(m.getUTCMonth() + 1, iso);
    await sale(BASEBALLISM, iso, name, units);
    await q(`insert into public.sales_by_product_title_daily_mv
               (company_entity_id, product_type, product_title, day_date, units_sold)
             values ($1, $2, $2 || ' Tee', $3, $4)`, [BASEBALLISM, name, iso, units]);
  }
  await q(`insert into public.inventory_on_hand_current_mv
             (company_entity_id, product_type, location_tag, total_available_quantity)
           values ($1, $2, 'online', 100)`, [BASEBALLISM, name]);
}
// Flat: every method should forecast exactly the actual, so ANY look-ahead or
// window error shows up as a non-zero WAPE.
await seedReportCategory('Flat', () => 1000);
// Seasonal: repeating, non-flat, and year-on-year growth of exactly 1 so the
// report's rule picks the blend -- which is the branch whose seasonal window
// was wrong. A flat series cannot show that error at all.
await seedReportCategory('Seasonal', (month) => (month === 3 ? 10000 : 1000));
// Flat except one spike INSIDE a recent outcome window. A forecast issued
// before that month cannot know about it.
await seedReportCategory('Spiked', (month, iso) => (iso.startsWith('2026-05') ? 40000 : 1000));
// A NEGATIVE seasonal half. Returns exceeding sales make a month negative, and
// a whole window can follow: measured on production 2026-09-18, 226 negative
// months across 36 categories, and NINE six-month windows across six categories
// summing below zero. The year-ago window here (Sep 2025 - Feb 2026) is
// negative while the recent run rate is positive, which is the only shape in
// which flooring each half and flooring their sum give different answers.
// Growth is tuned to 1.0 so the report picks the BLEND -- the branch where the
// two floors can diverge at all.
await seedReportCategory('Returned', (month, iso) => {
  if (iso >= '2026-03') return 1000;
  if (iso >= '2025-09') return -400;
  return 300;
});
await db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');

async function runReport(horizonMonths, user = plannerId) {
  const bound = REPORT_SQL.replaceAll('{{horizon_months}}', String(Number(horizonMonths)));
  return asUser(user, () => q(bound));
}

await test('the buy report runs, and counts only the displayed method own cycles', async () => {
  const rows = await runReport(6);
  const youth = rows.find((r) => r.category === 'Youth');
  assert.ok(youth, `Youth should be in the report: ${JSON.stringify(rows.map((r) => r.category))}`);
  assert.equal(youth.method_used, 'run rate');

  // The ledger holds far more Youth rows at this horizon than these: three
  // seasonal_naive_v1 rows at the matured cutoffs plus six accurate ones. Only
  // run_rate_v1's own four (three matured plus the live 2026-09-01 one) count.
  const all = await asUser(plannerId, () => first(
    `select count(*)::int c from public.forecast_candidate_ledger_v
      where sku_category = 'Youth' and horizon_months = 6`));
  assert.ok(all.c > 4, `the fixture must hold other methods' rows too, got ${all.c}`);
  assert.equal(Number(youth.fwd_cycles_frozen), 4);
  assert.equal(Number(youth.fwd_cycles_scored), 3);
  assert.match(youth.forward_record, /3 of 4 run rate forecast\(s\) matured and scored/);
  assert.equal(youth.governing_method, 'blend_v1',
    'the CURRENT selection is what governs the next cutoff, and is reported as such');
  assert.match(youth.forward_record, /the next cutoff is set to blend_v1/);
});

await test('the forward error is pooled over actuals, and never averaged', async () => {
  const rows = await runReport(6);
  const youth = rows.find((r) => r.category === 'Youth');
  // Computed from the fixture by hand: each cycle's actual is the six months
  // of real Youth demand in its own window.
  const series = new Map(YOUTH_MONTHLY_DEMAND);
  let absErr = 0; let signed = 0; let actualTotal = 0;
  for (const [cutoff, end, forecast] of MATURED) {
    let actual = 0;
    for (const [month, units] of series) {
      if (month >= cutoff && month < end) actual += units;
    }
    absErr += Math.abs(forecast - actual);
    signed += forecast - actual;
    actualTotal += actual;
  }
  // Pooled: one ratio of totals, not the mean of three ratios. A small window
  // and a large one are not equally informative and must not weigh the same.
  assert.equal(Number(youth.fwd_err_pct), Math.round((absErr / actualTotal) * 100));
  assert.equal(Number(youth.fwd_bias_pct), Math.round((signed / actualTotal) * 100));
  assert.ok(actualTotal > 0);
});

await test('a horizon with no frozen forecasts reads as no record, never as zero error', async () => {
  const rows = await runReport(3);
  const youth = rows.find((r) => r.category === 'Youth');
  assert.ok(youth);
  assert.equal(Number(youth.fwd_cycles_frozen), 0);
  assert.equal(Number(youth.fwd_cycles_scored), 0);
  // The distinction the whole column exists for: an empty record is NULL, and a
  // 0 here would read as a perfect forecast.
  assert.equal(youth.fwd_err_pct, null);
  assert.equal(youth.fwd_bias_pct, null);
  // The empty case names the method too, so "no record" is never mistaken for
  // "no record of anything".
  assert.equal(youth.forward_record, 'no forward record for run rate');
  assert.equal(youth.governing_method, 'none recorded');
  // With no forward evidence the status must SAY it is a backtest, not inherit
  // the word "proven" from one.
  assert.doesNotMatch(youth.status, /Proven forward/);
});

await test('a former method accurate cycles never become the displayed method evidence', async () => {
  // The cycle-2 finding, staged exactly: SIX accurate seasonal_naive_v1 cycles
  // sit in the ledger for this category and horizon. Pooling the forward record
  // by category -- which the first version of this block did -- would hand all
  // six to whichever method the report happens to display, and six good cycles
  // is precisely the bar for "Proven forward". The run rate has three of its
  // own, and three is what it gets.
  // Read as a USER: status_label is derived from
  // forecast_actuals_matured_through_active(), which reads active_company_id()
  // and is null for the service role -- every row would read PROSPECTIVE there.
  const seasonal = await asUser(plannerId, () => q(
    `select cutoff_date, forecast_qty, status_label from public.forecast_candidate_ledger_v
      where sku_category = 'Youth' and horizon_months = 6
        and candidate_id = 'seasonal_naive_v1' and status_label = 'SCORABLE'`));
  assert.ok(seasonal.length >= 6,
    `the fixture must hold at least six matured seasonal cycles, got ${seasonal.length}`);

  const before = (await runReport(6)).find((r) => r.category === 'Youth');
  assert.equal(before.method_used, 'run rate');
  assert.equal(Number(before.fwd_cycles_scored), 3,
    'the six seasonal cycles must not be counted toward the run rate figure');
  assert.doesNotMatch(before.status, /Proven/);
  assert.equal(before.status, 'Forward record started - too few cycles to judge');

  // And the record line names whose cycles they are, so a reader is not left to
  // infer it from a bare count.
  assert.match(before.forward_record, /run rate forecast\(s\)/);

  // Switching the current selection to the displayed method changes nothing
  // about the evidence -- which is the whole point. Comparing the displayed
  // method to the CURRENT selection was the first fix, and it does not close
  // this hole: here the two agree and the six cycles still do not transfer.
  await asService(() => q(
    `insert into public.forecast_method_selections
       (company_entity_id, sku_category, horizon_months, selected_method,
        effective_from_cutoff, evidence_from, evidence_to, selection_basis)
     values ($1, 'Youth', 6, 'run_rate_v1', '2026-12-01', '2025-06-01', '2026-11-30', '{}'::jsonb)`,
    [BASEBALLISM]));

  const after = (await runReport(6)).find((r) => r.category === 'Youth');
  assert.equal(after.governing_method, 'run_rate_v1');
  assert.equal(Number(after.fwd_cycles_scored), 3, 'still three, and still the run rate own');
  assert.doesNotMatch(after.status, /Proven/);
  // With the selection agreeing, the record line drops the next-cutoff note.
  assert.doesNotMatch(after.forward_record, /the next cutoff is set to/);
});

await test('the displayed figure is the arithmetic of the method it names', async () => {
  // The equality the report had never been held to. Its blend read last year's
  // window one month late (October-March where forecast_blend_v1 reads
  // September-February), so the number shown was a different calculation from
  // the method whose forward record sits beside it.
  const rows = await runReport(6);
  for (const name of ['Flat', 'Seasonal', 'Spiked', 'Returned']) {
    const row = rows.find((r) => r.category === name);
    assert.ok(row, `${name} should be in the report: ${JSON.stringify(rows.map((r) => r.category))}`);
    const fn = row.method_used === 'run rate' ? 'forecast_run_rate_v1' : 'forecast_blend_v1';
    const governed = await asService(() => first(
      `select eligible, ineligible_reason, forecast_qty from public.${fn}($1, $2, $3, 6)`,
      [BASEBALLISM, CUTOFF, name]));
    assert.equal(governed.eligible, true, `${name}: ${governed.ineligible_reason}`);
    assert.equal(Number(row.forecast_units), Number(governed.forecast_qty),
      `${name} (${row.method_used}): report says ${row.forecast_units}, ${fn} says ${governed.forecast_qty}`);
  }
  // Seasonal must actually exercise the blend, or this proves nothing about the
  // branch that was wrong.
  assert.equal(rows.find((r) => r.category === 'Seasonal').method_used, 'blend');

  // And the NEGATIVE-half case, stated outright because the equality above
  // passes for the wrong reason on every non-negative fixture. Each half is
  // floored at zero SEPARATELY, exactly as forecast_blend_v1 does. Flooring
  // their sum instead lets a negative half cancel a positive one: here the
  // year-ago window is -2,400 and the run rate 6,000, so per-half gives 3,000
  // and combined gives 1,800 -- a 40% understatement of the buy, on a shape
  // production actually contains.
  const returned = rows.find((r) => r.category === 'Returned');
  assert.equal(returned.method_used, 'blend', 'the negative-half case must exercise the blend');
  assert.equal(Number(returned.forecast_units), 3000);
  const halves = await asService(() => first(
    `select (select method_inputs->>'last_year_units' from public.forecast_seasonal_naive_v1($1, $2, 'Returned', 6)) seas,
            (select forecast_qty from public.forecast_run_rate_v1($1, $2, 'Returned', 6)) rr`,
    [BASEBALLISM, CUTOFF]));
  assert.ok(Number(halves.seas) < 0, `the seasonal half must be negative, got ${halves.seas}`);
  assert.ok(Number(halves.rr) > 0);
  // The number a combined floor would produce, spelled out so the difference is
  // visible in the test rather than only in a comment.
  assert.equal(Math.round(Math.max(0.5 * Number(halves.seas) + 0.5 * Number(halves.rr), 0)), 1800);
});

await test('a flat history backtests to zero error, and a spike is never foreseen', async () => {
  const rows = await runReport(6);

  // ZERO. Any look-ahead, and any window off by a month, shows up here: the
  // recent-velocity term read four months and divided by three, which inflated
  // a 600-unit forecast to 700 and published 16.7% WAPE against a series every
  // method forecasts exactly.
  const flat = rows.find((r) => r.category === 'Flat');
  assert.equal(Number(flat.err_recent_pct), 0, `recent WAPE ${flat.err_recent_pct}%`);
  assert.equal(Number(flat.err_earlier_pct), 0, `earlier WAPE ${flat.err_earlier_pct}%`);
  assert.equal(Number(flat.bias_recent_pct), 0);
  assert.equal(Number(flat.worst_short_pct), 0);

  // The spike sits inside the outcome of several recent windows and is 40x the
  // baseline. A forecast issued before it cannot have seen it, so every one of
  // those windows must come in UNDER -- a negative bias. The old term read the
  // outcome's own first month, which pulled the forecast up toward the spike.
  const spiked = rows.find((r) => r.category === 'Spiked');
  assert.ok(Number(spiked.bias_recent_pct) < 0,
    `a forecast that cannot see the spike must under-forecast it, got bias ${spiked.bias_recent_pct}%`);
  assert.ok(Number(spiked.err_recent_pct) > 0);
});

await test('the report is bounded by the reader own company', async () => {
  // Other Co has the same category name and a different series, and the
  // outsider has no ledger rows at all. A tenant leak would show up here as
  // Baseballism's forward record under Other Co's name.
  const theirs = await runReport(6, outsiderId);
  for (const r of theirs) {
    assert.equal(Number(r.fwd_cycles_frozen), 0, `${r.category} should carry no forward record`);
    assert.equal(r.fwd_err_pct, null);
  }
});

await test('the report SQL survives chat_run_readonly_query guard', () => {
  // The RPC strips LEADING comments and ONE trailing semicolon, requires what
  // remains to start with select/with, rejects any surviving semicolon, and
  // wraps the text as `select ... from (<text>) user_query limit 1000` -- so a
  // file ending on a line comment would comment out the wrapper own tail.
  let trimmed = REPORT_SQL.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim();
  assert.match(trimmed, /^(select|with)\s/i);
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1).trim();
  assert.ok(!trimmed.includes(';'), 'a surviving semicolon is rejected outright');
  assert.ok(!/--[^\n]*$/.test(trimmed), 'must not end on a line comment');
  // Every token the report uses must be a DECLARED parameter of the saved
  // report; an undeclared one is an error there, not a passthrough.
  const tokens = [...REPORT_SQL.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tokens)], ['horizon_months']);
});

// ── 7. No forecast function is reachable without signing in ─────────────────
await test('no forecast SECURITY DEFINER function is executable by anon', async () => {
  // Supabase's default privileges grant EXECUTE on every new public function to
  // PUBLIC, which includes anon -- so a definer function is open unless its
  // migration revokes it explicitly. 20260917210000 found four functions that
  // had shipped that way, one of which deletes another tenant's sales_by_day.
  //
  // Every function this branch adds takes an explicit company id, so an anon
  // grant on any of them is a cross-tenant read with no login at all. Asserted
  // over pg_proc rather than by listing names, so a function added later is
  // covered without anyone remembering to add it here.
  const open = await q(
    `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and (p.proname like 'forecast%' or p.proname like '%forecast%'
             or p.proname like 'score_forecast%' or p.proname like 'select_forecast%')
        and p.proname <> 'forecast_candidate_may_act'`);
  // forecast_candidate_may_act is the one exception and is on 20260917210000's
  // reviewed allowlist: it answers `p_company = active_company_id()`, and
  // active_company_id() is NULL for anon, so it returns false rather than data.
  assert.deepEqual(open.map((r) => r.proname), [],
    `these are callable by anon with any company id: ${open.map((r) => r.proname).join(', ')}`);

  // And the repo-wide check that 20260917210000 added, executed against a
  // schema carrying THIS branch's migrations -- the combination neither PR's
  // own suite covers. It is an allowlist, so it goes red the day an ordinary
  // new function ships without a revoke.
  const stmt = splitSqlStatements(await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8'))
    .find((x) => /'Definer functions reachable by anon' as check_name/.test(x.text));
  assert.ok(stmt, 'the anon-definer check must still exist in verify_v2_schema.sql');
  const row = (await q(stmt.text))[0];
  assert.equal(row.status, 'ok', JSON.stringify(row));
});

console.log(`\n# ${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
