// Demand Planner candidate runner — the orchestration half.
//
// Source specification: saved report f98754f7-47a6-4eeb-8a8b-eece9a069432
// ("SILO - Demand Model Workbench"), frozen candidate Candidate_YoY_Shift_v1.
//
// WHAT IS DELIBERATELY NOT HERE: the forecast arithmetic. The ratio, the
// clamp, the windows and the rounding are defined exactly once, in
// `public.forecast_yoy_shift_v1` (migration 20260917140000), and this module
// calls it. A JavaScript copy would be a second definition of the number a
// planner acts on, and the two would drift the first time either side was
// touched -- the same reason `card_coding_effective_lines` exists rather than
// a second expansion of a split transaction in the browser.
//
// So this file owns only what a runner owns: which cutoffs to attempt, in
// what order, what to do when one is refused, and how to report the run. It
// is pure -- no network, no clock of its own -- so the unit suite can drive
// every branch.
//
// NO sync_jobs ROW. Every other scheduled job here logs to `sync_jobs`
// because its work leaves no other trace. This one's work IS the trace: a
// ledger row carries its own `executed_at`, and a cutoff that never ran is
// visible as an absent row at that cutoff. A second bookkeeping table that
// could disagree with the ledger would make "did this cutoff run" harder to
// answer, not easier.

export const DEFAULT_CANDIDATE_ID = 'Candidate_YoY_Shift_v1';
// There is deliberately NO default category. The candidate id names the METHOD,
// which is a property of this code; the category names a slice of one tenant's
// catalogue, which is not. `Youth` sat here as a default until 2026-09-17 and
// made a component meant to serve any company read as Baseballism's.
// Callers enumerate categories from forecastable_product_types(company).
export const DEFAULT_HORIZON_DAYS = 30;
export const DEFAULT_CLAMP_LOW = 0.60;
export const DEFAULT_CLAMP_HIGH = 1.80;

// The cutoff of the first frozen run in the source report. Earlier cutoffs are
// backtest territory and must not be written to the ledger as though they had
// been forecast at the time -- see scripts/forecast-candidate-backtest.mjs,
// which scores them without writing anything.
export const FIRST_FROZEN_CUTOFF = '2026-09-01';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${label}: expected a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** First of the month containing `iso`. */
export function monthStart(iso) {
  assertIsoDate(iso, 'monthStart');
  return `${iso.slice(0, 7)}-01`;
}

export function isMonthStart(iso) {
  return DATE_RE.test(iso) && iso.endsWith('-01');
}

/** Calendar month arithmetic on YYYY-MM-01 strings, in UTC only. */
export function addMonths(monthIso, n) {
  assertIsoDate(monthIso, 'addMonths');
  const year = Number(monthIso.slice(0, 4));
  const month = Number(monthIso.slice(5, 7));
  const total = year * 12 + (month - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

/** The day before `iso`. */
export function previousDay(iso) {
  assertIsoDate(iso, 'previousDay');
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Which cutoffs this run may attempt.
 *
 * A cutoff at month M may only be frozen once the source has complete data
 * through the day BEFORE M -- otherwise the t-1 month is still landing, the
 * recent window understates, and the ledger freezes that understatement with
 * no second chance. The database enforces the same rule in
 * record_forecast_candidate_run(); this is the caller not bothering to ask.
 *
 * `maturedThrough` is forecast_actuals_matured_through(): null means the
 * source has never been measured, which yields NO cutoffs rather than all of
 * them.
 *
 * This deliberately still walks historical cutoffs -- a catch-up after a
 * dropped monthly run is the whole point -- and it does NOT itself decide
 * whether a cutoff is too old to freeze. That decision belongs to the database,
 * which refuses any cutoff whose horizon has already closed ('expired') and
 * backs the refusal with a CHECK a service-role job cannot dodge. Putting the
 * rule here as well would be a second definition of "prospective", and the one
 * that mattered would be the one nobody re-read.
 */
export function plannedCutoffs({ startCutoff, maturedThrough, maxCutoffs = 60 }) {
  if (!isMonthStart(startCutoff)) {
    throw new Error(`plannedCutoffs: startCutoff must be the first of a month, got ${startCutoff}`);
  }
  if (maturedThrough == null) return [];
  assertIsoDate(maturedThrough, 'plannedCutoffs.maturedThrough');

  const out = [];
  let cutoff = startCutoff;
  while (out.length < maxCutoffs) {
    // Complete data through cutoff - 1 day.
    if (previousDay(cutoff) > maturedThrough) break;
    out.push(cutoff);
    cutoff = addMonths(cutoff, 1);
  }
  return out;
}

/** The actions record_forecast_candidate_run() can report, and what each means. */
export const ACTIONS = Object.freeze({
  inserted: 'a new forecast was frozen',
  existing: 'already frozen; returned untouched and NOT recalculated',
  existing_voided: 'already frozen and since voided; left alone',
  deferred: 'source not synced far enough for this cutoff yet',
  expired: 'the horizon closed before this run; a forecast written now would not be prospective',
  skipped: 'the candidate is not computable at this cutoff (missing month, non-positive denominator)',
});

export function blankSummary() {
  return { attempted: 0, inserted: 0, existing: 0, existing_voided: 0, deferred: 0, expired: 0, skipped: 0, failed: 0 };
}

/**
 * Drive one candidate across its eligible cutoffs.
 *
 * IDEMPOTENT BY CONSTRUCTION, on both sides: the unique index refuses a second
 * row for the same (company, candidate, category, horizon, cutoff), and the
 * RPC short-circuits on an existing row WITHOUT recomputing, so a re-run
 * cannot quietly replace a frozen number with one today's data would give.
 *
 * A single cutoff failing does not abort the run -- later cutoffs are
 * independent decisions, and stopping would make one transient error hide
 * every subsequent month. The failures are counted and returned, and the
 * caller decides the exit code.
 */
/**
 * The categories a company actually plans for.
 *
 * `override` (FC_SKU_CATEGORY) wins, so a manual single-category run is
 * unchanged. Otherwise they are resolved from the database, never guessed:
 * forecastable_product_types() applies the human override where somebody set
 * one and the evidence -- inventory-tracked, or purchased -- otherwise.
 *
 * Lives here rather than in the runner script so it is reachable from a test.
 * It exists because removing the tenant-specific default left the driver
 * handing an empty category to a core that requires one: every company would
 * have thrown before recording a single forecast, and the scheduled workflow
 * would have exited 1 without writing anything.
 */
export async function resolveCategories(client, companyEntityId, override = '') {
  if (override && String(override).trim()) {
    return { categories: [String(override).trim()], needsReview: [] };
  }
  if (!companyEntityId) throw new Error('resolveCategories: companyEntityId is required');
  const { data, error } = await client.rpc('forecastable_product_types', {
    p_company_entity_id: companyEntityId,
  });
  if (error) throw new Error(`could not resolve categories: ${error.message}`);
  const rows = data || [];
  const categories = rows.filter((r) => r && r.is_forecastable)
    .map((r) => r.product_type).filter(Boolean);
  // NOT the same as "excluded". A type with no inventory row, no purchase
  // history and no human override is UNRESOLVED: a brand-new merchandise line
  // whose inventory link has not landed yet is indistinguishable from a fee
  // line on the evidence alone. It is not forecast -- forecasting a fee line is
  // the defect this classification exists to prevent -- but it is returned so
  // the caller can say so out loud. A forecast omitted from a cutoff that has
  // since closed cannot be recreated, so a silent exclusion is permanent, and a
  // run that quietly dropped one would look exactly like a successful run.
  const needsReview = rows.filter((r) => r && r.needs_review)
    .map((r) => r.product_type).filter(Boolean);
  return { categories, needsReview };
}

export async function runForecastCandidate({
  client,
  companyEntityId,
  startCutoff = FIRST_FROZEN_CUTOFF,
  candidateId = DEFAULT_CANDIDATE_ID,
  skuCategory,
  horizonDays = DEFAULT_HORIZON_DAYS,
  clampLow = DEFAULT_CLAMP_LOW,
  clampHigh = DEFAULT_CLAMP_HIGH,
  maxCutoffs = 60,
  dryRun = false,
  logger = console,
} = {}) {
  if (!companyEntityId) throw new Error('runForecastCandidate: companyEntityId is required');
  // Required, and checked rather than defaulted. A category that arrives
  // undefined used to become 'Youth'; now it stops the run, because forecasting
  // the wrong slice of a catalogue silently is worse than forecasting nothing.
  if (!skuCategory || !String(skuCategory).trim()) {
    throw new Error('runForecastCandidate: skuCategory is required (no tenant-specific default)');
  }

  const maturedResult = await client.rpc('forecast_actuals_matured_through', {
    p_company_entity_id: companyEntityId,
  });
  if (maturedResult.error) {
    throw new Error(`forecast_actuals_matured_through failed: ${maturedResult.error.message}`);
  }
  const maturedThrough = maturedResult.data ?? null;

  const cutoffs = plannedCutoffs({ startCutoff, maturedThrough, maxCutoffs });
  const summary = blankSummary();
  const results = [];

  logger.log(
    `forecast candidate ${candidateId} / ${skuCategory} / ${horizonDays}d: source complete through `
    + `${maturedThrough ?? 'never measured'}; ${cutoffs.length} cutoff(s) to attempt`
    + `${dryRun ? ' (DRY RUN, nothing will be written)' : ''}`,
  );

  for (const cutoff of cutoffs) {
    summary.attempted += 1;
    if (dryRun) {
      results.push({ cutoff, action: 'dry_run', reason: 'dry run; no RPC issued' });
      logger.log(`  ${cutoff}  dry_run`);
      continue;
    }
    const { data, error } = await client.rpc('record_forecast_candidate_run', {
      p_company_entity_id: companyEntityId,
      p_cutoff_date: cutoff,
      p_sku_category: skuCategory,
      p_candidate_id: candidateId,
      p_horizon_days: horizonDays,
      p_clamp_low: clampLow,
      p_clamp_high: clampHigh,
    });
    if (error) {
      summary.failed += 1;
      results.push({ cutoff, action: 'failed', reason: error.message });
      logger.error(`  ${cutoff}  FAILED: ${error.message}`);
      continue;
    }
    const row = Array.isArray(data) ? data[0] : data;
    const action = row?.action ?? 'failed';
    if (action in summary) summary[action] += 1;
    else summary.failed += 1;
    results.push({
      cutoff,
      action,
      forecastQty: row?.forecast_qty ?? null,
      ledgerId: row?.ledger_id ?? null,
      reason: row?.reason ?? null,
    });
    const qty = row?.forecast_qty != null ? ` forecast ${row.forecast_qty}` : '';
    const why = row?.reason ? ` — ${row.reason}` : '';
    logger.log(`  ${cutoff}  ${action}${qty}${why}`);
  }

  return { maturedThrough, cutoffs, summary, results };
}

/** One line a human can read in an Actions log without opening the database. */
export function formatSummary(summary) {
  return [
    `attempted ${summary.attempted}`,
    `inserted ${summary.inserted}`,
    `already frozen ${summary.existing + summary.existing_voided}`,
    `deferred ${summary.deferred}`,
    `expired ${summary.expired}`,
    `not computable ${summary.skipped}`,
    `failed ${summary.failed}`,
  ].join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Backtest parameter binding
// ─────────────────────────────────────────────────────────────────────────────
// `chat_run_readonly_query` EXECUTEs the text it is handed, so a value reaching
// it unchecked would be REWRITING the query rather than parameterising it. Bind
// parameters are not available there -- the RPC takes one text argument by
// design, because it exists to run SQL nobody wrote in advance -- so every
// substituted value is validated against an exact shape first and refused
// otherwise. Same stance as v3/js/report-params.js, which errors on an
// undeclared token rather than passing it through.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MONTH_START_RE = /^\d{4}-\d{2}-01$/;

export function bindBacktestSql(template, { company, from, to } = {}) {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error('bindBacktestSql: template is required');
  }
  if (!UUID_RE.test(String(company))) throw new Error(`bindBacktestSql: company is not a uuid: ${company}`);
  if (!MONTH_START_RE.test(String(from))) throw new Error(`bindBacktestSql: from must be a month start: ${from}`);
  if (!MONTH_START_RE.test(String(to))) throw new Error(`bindBacktestSql: to must be a month start: ${to}`);
  if (String(to) < String(from)) throw new Error(`bindBacktestSql: to (${to}) is before from (${from})`);
  // Longest token first: ':from_cutoff' starts with ':from', so replacing the
  // short one first would leave '_cutoff' dangling after a quoted literal.
  // Ordering it this way means adding a token later cannot corrupt one already
  // here.
  return template
    .replaceAll(':from_cutoff', `'${from}'`)
    .replaceAll(':to_cutoff', `'${to}'`)
    .replaceAll(':company', `'${company}'`);
}
