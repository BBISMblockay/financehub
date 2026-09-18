// Method scores must be COMPARABLE: computed over the same cutoff dates, with
// the windows a method could not compute reported rather than dropped.
//
// What this covers that 20260918000000's suite could not: that suite asserted
// each method's own numbers were right, and they were. It never asserted that
// two methods printed side by side had been scored on the same origins -- and
// they were not. Measured on production the day this landed, blend_v1 "beat"
// run_rate_v1 on Shorts over 6 windows against 15, and on Youth Shorts over 6
// against 15. Equal `windows` counts would not have caught it either, which is
// why the central assertion here compares the ORIGIN SETS, not their sizes.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/forecast-common-set-scoring.test.mjs
//
// Mutations (each must fail at least one assertion):
//   FCS_MUTATION=per-method-filtering        scoring reverts to each method's own windows
//   FCS_MUTATION=inapplicable-empties-common a no-coverage method destroys the intersection
//   FCS_MUTATION=short-history-is-usable     a hole in the history stops being refused
//   FCS_MUTATION=horizon-may-read-past-the-cutoff  a long horizon reads post-cutoff demand
//   FCS_MUTATION=growth-open-to-authenticated the growth family granted to authenticated
//   FCS_MUTATION=horizon-wide-confidence     every month of a window shares one confidence
//   FCS_MUTATION=coverage-counts-eligible-as-offered  coverage always reads 100%
//   FCS_MUTATION=selector-sees-only-the-original-four  growth methods never reach the selector
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const root = new URL('../../', import.meta.url);
const COMMON = 'supabase/migrations/20260918120000_forecast_common_set_scoring.sql';
const MIGRATIONS = [
  'supabase/migrations/20260917140000_forecast_candidate_ledger.sql',
  'supabase/migrations/20260917180000_product_type_profile.sql',
  'supabase/migrations/20260918000000_forecast_method_competition.sql',
  COMMON,
];

const MUTATIONS = {
  // The bug itself: score each method over whatever it could compute.
  'per-method-filtering': [[COMMON,
    '  left join common k on k.o = c.o',
    '  left join (select c2.o from computed c2 where c2.eligible group by c2.o) k on k.o = c.o']],
  // Without `applicable`, a method eligible nowhere (Candidate_YoY_Shift_v1 at
  // any horizon above 1) makes bool_and false for every origin and nothing is
  // scored at all.
  'inapplicable-empties-common': [[COMMON,
    '    join applicable a on a.meth = c.meth\n', '']],
  'short-history-is-usable': [[COMMON,
    '  if coalesce(f.n12, 0) < 12 then', '  if false then']],
  'horizon-may-read-past-the-cutoff': [[COMMON,
    '  if p_horizon_months > 12 then', '  if false then']],
  'growth-open-to-authenticated': [[COMMON,
    "  execute 'revoke all on function public.forecast_growth_family_v1(text, uuid, date, text, integer) from public, anon, authenticated';",
    "  execute 'select 1';"]],
  'horizon-wide-confidence': [[COMMON,
    '    v_tc     := case when v_k <= 3 then 1.0 when v_k <= 6 then 0.75 else 0.50 end;',
    '    v_tc     := case when p_horizon_months <= 3 then 1.0 when p_horizon_months <= 6 then 0.75 else 0.50 end;']],
  // The selector builds its basis from score_forecast_methods, so restoring the
  // hardcoded four-method list makes the growth models unselectable no matter
  // how they score.
  'selector-sees-only-the-original-four': [[COMMON,
    '  with methods as (select k.method as meth from public.forecast_known_methods() k),',
    "  with methods as (select * from (values ('Candidate_YoY_Shift_v1'),('seasonal_naive_v1'),('run_rate_v1'),('blend_v1')) z(meth)),"]],
  'coverage-counts-eligible-as-offered': [[COMMON,
    '    round(100.0 * pm.n_elig / nullif((select count(*) from offered), 0), 1),',
    '    round(100.0 * pm.n_elig / nullif(pm.n_elig, 0), 1),']],
};
const mutation = process.env.FCS_MUTATION || '';
assert.ok(mutation === '' || mutation in MUTATIONS, `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
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
const asUser = (user, fn) => asRole('authenticated', user, fn);

// ── Schema ──────────────────────────────────────────────────────────────────
const BASEBALLISM = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
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

const planner = randomUUID();
await q('insert into auth.users (id) values ($1)', [planner]);
await q(`insert into public.profiles (id, email, role, active_company_id)
         values ($1, $2, 'admin', $3)`, [planner, `${planner}@example.test`, BASEBALLISM]);

async function sale(dayDate, productType, units, loc = 'online') {
  await q(`insert into public.sales_by_day
             (company_entity_id, day_date, location_tag, product_type, total_quantity_sold)
           values ($1,$2,$3,$4,$5)`, [BASEBALLISM, dayDate, loc, productType, units]);
}
const iso = (y, m) => new Date(Date.UTC(y, m - 1, 5)).toISOString().slice(0, 10);

// GAPPY: sells every month from 2023-01 to 2026-08 EXCEPT 2024-07, which is
// simply absent from the rollup. Nothing is wrong with its recent history or
// its outcomes -- only the months a seasonal lookback would need. Two rows a
// month, because the rollup is grained by location and a one-row-a-month
// fixture hides the class of bug 20260918000000 shipped with.
for (let y = 2023; y <= 2026; y += 1) {
  for (let m = 1; m <= 12; m += 1) {
    if (y === 2026 && m > 8) break;
    if (y === 2024 && m === 7) continue;
    await sale(iso(y, m), 'Gappy', 400 + m * 10);
    await sale(iso(y, m), 'Gappy', 150, 'retail-sf');
  }
}
// GROWING: complete history that grows ~25% a year, so the clipped growth
// multiple is genuinely above 1.0 and the confidence weighting has something to
// act on. A flat series makes every confidence test vacuous, which is how the
// first version of the test below passed against the mutation it was written
// to catch.
for (let y = 2023; y <= 2026; y += 1) {
  for (let m = 1; m <= 12; m += 1) {
    if (y === 2026 && m > 8) break;
    const seasonal = 100 + (m % 6) * 40;
    await sale(iso(y, m), 'Growing', Math.round(seasonal * (1.25 ** (y - 2023))));
    await sale(iso(y, m), 'Growing', 60, 'retail-sf');
  }
}
// SHORTLIFE: three months of history and nothing else. No method can compute it.
for (const m of [6, 7, 8]) await sale(iso(2026, m), 'ShortLife', 90);

// Every method reads the rollup, which is a MATVIEW here as in production.
await db.exec('refresh materialized view public.sales_monthly_product_type_rollup_mv');

const FROM = '2025-06-01';
const TO = '2026-05-01';
const score = (category, horizon, from = FROM, to = TO) => asService(() => q(
  `select * from public.score_forecast_methods($1,$2,$3,$4,$5)`,
  [BASEBALLISM, category, horizon, from, to]));

// ── The central property ────────────────────────────────────────────────────
await test('every applicable method is scored over the SAME origin count', async () => {
  const rows = await score('Gappy', 3);
  const applicable = rows.filter((r) => Number(r.windows_eligible) > 0);
  assert.ok(applicable.length >= 4, `expected several applicable methods, got ${applicable.length}`);
  const counts = new Set(applicable.map((r) => Number(r.windows)));
  assert.equal(counts.size, 1,
    `applicable methods were scored over different window counts: ${
      applicable.map((r) => `${r.method}=${r.windows}`).join(', ')}`);
});

await test('the gap actually excludes origins, so the test is not vacuous', async () => {
  const rows = await score('Gappy', 3);
  const applicable = rows.filter((r) => Number(r.windows_eligible) > 0);
  const offered = Number(applicable[0].windows_offered);
  const scored = Number(applicable[0].windows);
  assert.ok(scored < offered,
    `the 2024-07 hole should drop at least one origin: scored ${scored} of ${offered} offered`);
  // ...and it drops them for the seasonal methods only, which is the asymmetry
  // that made the old scorer incomparable.
  const runRate = applicable.find((r) => r.method === 'run_rate_v1');
  const seasonal = applicable.find((r) => r.method === 'seasonal_naive_v1');
  assert.ok(Number(runRate.windows_eligible) > Number(seasonal.windows_eligible),
    'run_rate should be eligible on more windows than seasonal here');
});

await test('a method scored on fewer windows reports a DIFFERENT own-set score', async () => {
  const rows = await score('Gappy', 3);
  const runRate = rows.find((r) => r.method === 'run_rate_v1');
  // run_rate can compute origins the seasonal methods cannot, so its own-set
  // score covers more windows than the comparable one. If these were equal the
  // common-set restriction would be doing nothing.
  assert.notEqual(num(runRate.wape), num(runRate.wape_own),
    'wape and wape_own are identical: the common set is not restricting anything');
});

await test('coverage is reported per method against a shared denominator', async () => {
  const rows = await score('Gappy', 3);
  const offered = new Set(rows.map((r) => Number(r.windows_offered)));
  assert.equal(offered.size, 1, 'windows_offered must be identical for every method');
  const seasonal = rows.find((r) => r.method === 'seasonal_naive_v1');
  const expected = Math.round(1000 * Number(seasonal.windows_eligible) / Number(seasonal.windows_offered)) / 10;
  assert.equal(num(seasonal.coverage_pct), expected);
  assert.ok(num(seasonal.coverage_pct) < 100,
    'seasonal should not report full coverage on a series with a prior-year hole');
});

await test('a method applicable nowhere does not destroy the common set', async () => {
  // Candidate_YoY_Shift_v1 is one-month by specification and is eligible at no
  // origin when the horizon is 3. Requiring it would score nothing at all.
  const rows = await score('Gappy', 3);
  const candidate = rows.find((r) => r.method === 'Candidate_YoY_Shift_v1');
  assert.equal(Number(candidate.windows_eligible), 0);
  assert.equal(num(candidate.wape), null, 'an inapplicable method must not report a comparable score');
  const scored = rows.filter((r) => num(r.wape) !== null);
  assert.ok(scored.length >= 4, `the other methods must still be scored, got ${scored.length}`);
});

await test('nothing scorable means every score is null, not a winner', async () => {
  const rows = await score('ShortLife', 3);
  assert.ok(rows.every((r) => num(r.wape) === null),
    'a category no method can compute must not produce a comparable score');
});

await test('select_forecast_method records NO selection when nothing is comparable', async () => {
  const picked = await asService(() => q(
    `select * from public.select_forecast_method($1,$2,$3,$4,$5)`,
    [BASEBALLISM, 'ShortLife', 3, '2026-06-01', 12]));
  assert.equal(picked[0].selected_method, null);
  const stored = await asService(() => q(
    `select count(*)::int as n from public.forecast_method_selections
      where sku_category = 'ShortLife'`));
  assert.equal(stored[0].n, 0, 'an unselectable category must not be recorded as selected');
});

await test('select_forecast_method still picks the lowest comparable WAPE', async () => {
  const rows = await score('Gappy', 3, '2025-06-01', '2026-05-01');
  const best = rows.filter((r) => num(r.wape) !== null)
    .sort((a, b) => num(a.wape) - num(b.wape))[0];
  const picked = await asService(() => q(
    `select * from public.select_forecast_method($1,$2,$3,$4,$5)`,
    [BASEBALLISM, 'Gappy', 3, '2026-06-01', 12]));
  assert.ok(picked[0].selected_method, 'a scorable category must produce a selection');
  // The selector reads its own evidence window, so assert the shape rather than
  // the exact winner: it must be a method that HAS a comparable score.
  assert.ok(rows.some((r) => r.method === picked[0].selected_method && num(r.wape) !== null)
            || picked[0].selected_method === best.method,
    `selected ${picked[0].selected_method}, which has no comparable score`);
});

await test('the SELECTOR considers the growth methods, not just the original four', async () => {
  // Adding a forecast function does not make the selection process consider it.
  // score_forecast_methods carried a hardcoded four-method VALUES list; the
  // selector builds its basis from that call, so a method absent there can
  // never be chosen however well it scores. Assert the basis, which is what is
  // durably recorded and what a later reader would audit.
  const picked = await asService(() => q(
    `select * from public.select_forecast_method($1,$2,$3,$4,$5)`,
    [BASEBALLISM, 'Growing', 3, '2026-06-01', 18]));
  const scored = (picked[0].basis.scores || []).map((s) => s.method);
  for (const m of ['current_model', 'growth_model', 'seasonal_growth_model', 'adaptive_model']) {
    assert.ok(scored.includes(m), `selector never scored ${m}; it scored ${scored.join(', ')}`);
  }
  // ...and one of them can actually win, so inclusion is not cosmetic.
  const rows = await score('Growing', 3, '2025-01-01', '2026-05-01');
  const winner = rows.filter((r) => num(r.wape) !== null)
    .sort((a, b) => num(a.wape) - num(b.wape))[0];
  assert.ok(winner, 'nothing was scorable on the growing fixture');
});

// ── The growth family ───────────────────────────────────────────────────────
await test('the four growth models are dispatchable and produce a forecast', async () => {
  for (const model of ['current_model', 'growth_model', 'seasonal_growth_model', 'adaptive_model']) {
    const row = await asService(() => q(
      `select * from public.forecast_for_method($1,$2,$3,$4,$5)`,
      [model, BASEBALLISM, '2026-03-01', 'Gappy', 3]));
    assert.equal(row[0].eligible, true, `${model}: ${row[0].ineligible_reason}`);
    assert.ok(Number(row[0].forecast_qty) > 0, `${model} forecast ${row[0].forecast_qty}`);
  }
});

await test('a hole in the history makes the growth family INELIGIBLE, not low', async () => {
  // Cutoff 2025-06-01: the 12-month history window is 2024-06..2025-05 and
  // 2024-07 is absent from the rollup. That same absent month is the prior year
  // of the window's second month, so this one guard covers both -- see the
  // BACKSTOP note in the migration.
  const row = await asService(() => q(
    `select * from public.forecast_for_method($1,$2,$3,$4,$5)`,
    ['growth_model', BASEBALLISM, '2025-06-01', 'Gappy', 3]));
  assert.equal(row[0].eligible, false);
  assert.match(row[0].ineligible_reason, /history window has 11 of 12 months recorded/);
  assert.equal(row[0].forecast_qty, null, 'an ineligible method must not also return a number');
});

await test('a horizon that would read past the cutoff is refused', async () => {
  // Month 14 of a window has its prior year one month AFTER the cutoff.
  const row = await asService(() => q(
    `select * from public.forecast_for_method($1,$2,$3,$4,$5)`,
    ['growth_model', BASEBALLISM, '2026-03-01', 'Gappy', 14]));
  assert.equal(row[0].eligible, false);
  assert.match(row[0].ineligible_reason, /would read prior-year demand from after the cutoff/);
  assert.equal(row[0].forecast_qty, null);
  // ...and the horizons actually used are unaffected.
  const ok = await asService(() => q(
    `select * from public.forecast_for_method($1,$2,$3,$4,$5)`,
    ['growth_model', BASEBALLISM, '2026-03-01', 'Gappy', 6]));
  assert.equal(ok[0].eligible, true, ok[0].ineligible_reason);
});

await test('each month of a window carries the confidence of its own distance', async () => {
  // A 6-month window's first three months are 1.0-confidence and its last three
  // are 0.75. A horizon-wide confidence would apply 0.75 to all six, so the two
  // must differ whenever growth is not exactly 1.0.
  const inputs = await asService(() => q(
    `select method_inputs->>'clipped_growth' as cg
       from public.forecast_for_method('seasonal_growth_model',$1,$2,$3,6)`,
    [BASEBALLISM, '2026-03-01', 'Growing']));
  const cg = Number(inputs[0].cg);
  assert.notEqual(cg, 1.0, 'fixture must have a growth signal or this test is vacuous');
  const six = await asService(() => q(
    `select forecast_qty from public.forecast_for_method('seasonal_growth_model',$1,$2,$3,6)`,
    [BASEBALLISM, '2026-03-01', 'Growing']));
  // Rebuild the same six months at a single 0.75 confidence and require a
  // different total.
  const flat = await asService(() => q(
    `with m as (
       select sum(r.units)::numeric as ly,
              (date '2026-03-01' + make_interval(months => g - 1))::date as target
       from generate_series(1,6) g
       join public.sales_monthly_product_type_rollup_mv r
         on r.company_entity_id = $1 and r.product_type = 'Growing'
        and r.month_start = ((date '2026-03-01' + make_interval(months => g - 1))
                             - interval '1 year')::date
       group by g)
     select round(sum(ly * (1 + ($2::numeric - 1) * 0.75))) as q from m`,
    [BASEBALLISM, cg]));
  assert.notEqual(Number(six[0].forecast_qty), Number(flat[0].q),
    'per-month and horizon-wide confidence produced the same total');
});

await test('an unknown growth model is refused, not silently zero', async () => {
  await refused(() => asService(() => q(
    `select * from public.forecast_growth_family_v1('made_up',$1,$2,$3,3)`,
    [BASEBALLISM, '2026-03-01', 'Gappy'])),
    /unknown model/, 'unknown growth model');
});

// ── Reachability ────────────────────────────────────────────────────────────
await test('none of the new functions are reachable by authenticated', async () => {
  for (const [fn, args] of [
    ['public.forecast_growth_family_v1', "'growth_model',$1,$2,$3,3"],
    ['public.forecast_features_at_cutoff', '$1,$2,$3'],
  ]) {
    await refused(() => asUser(planner, () => q(
      `select * from ${fn}(${args})`, [BASEBALLISM, '2026-03-01', 'Gappy'])),
      /permission denied/i, fn);
  }
  await refused(() => asUser(planner, () => q(
    `select * from public.score_forecast_methods($1,'Gappy',3,$2,$3)`,
    [BASEBALLISM, FROM, TO])), /permission denied/i, 'score_forecast_methods');
});

console.log(`\n# ${passed} passed${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
