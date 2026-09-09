// scripts/lib/sync-plan.mjs — what this run was ASKED to do, and how to judge it.
//
// WHY THIS EXISTS.
//
// On 2026-09-09 a manual backfill (GHA run #354) was dispatched with
// `sessions_days: 730` and `skip_sessions: true` in the same form. Those two
// inputs contradict each other. The orchestrator resolved the contradiction
// silently in favour of the skip: no sync_jobs row, no log line, no warning
// that a 730-day parameter had been supplied for a stage that would never
// run. The run finished GREEN in two minutes having written nothing, and the
// only way to discover that was to query the tables by hand and find them
// byte-identical.
//
// The landing-page stage failed in the same run and was also reported green,
// because its failure is deliberately non-fatal -- correct for a nightly,
// where a ShopifyQL wobble must not take sales down with it, and wrong for a
// manual backfill, whose entire purpose is the stage that failed.
//
// Both are the same defect: the run's OUTCOME did not describe the run. So
// the decision of what to run, and the judgement of whether the run did it,
// are pulled out here as pure functions over an env-shaped object. No
// network, no database, no process.env -- so a test can drive the exact
// input combination that produced run #354 and assert on the answer.

/** The stages a run can be asked for, in execution order.
 *
 * `skipEnv` is opt-OUT (present and 'true' means don't). `enableEnv` is
 * opt-IN (absent or not 'true' means don't) -- collections is the one stage
 * built that way, deliberately, see shopify-sync.mjs.
 *
 * `daysEnv` is the tell. A days value is not a preference, it is a REQUEST:
 * nobody types 730 into a form for a stage they want skipped. Where one is
 * supplied alongside a skip, this module calls the pair contradictory and
 * refuses to let the run pass quietly.
 */
export const SYNC_STAGES = [
  { jobType: 'history_import', skipEnv: 'SHOPIFY_SKIP_SALES', modes: ['history', 'full'] },
  { jobType: 'incremental_sales', skipEnv: 'SHOPIFY_SKIP_SALES', modes: ['incremental'] },
  { jobType: 'payouts_sync', skipEnv: 'SHOPIFY_SKIP_PAYOUTS', modes: ['incremental', 'full'] },
  { jobType: 'sessions_sync', skipEnv: 'SHOPIFY_SKIP_SESSIONS', daysEnv: 'SHOPIFY_SESSIONS_DAYS', modes: ['incremental', 'full'] },
  { jobType: 'landing_pages_sync', skipEnv: 'SHOPIFY_SKIP_LANDING_PAGES', daysEnv: 'SHOPIFY_LANDING_PAGES_DAYS', modes: ['incremental', 'full'] },
  { jobType: 'collections_sync', enableEnv: 'SHOPIFY_COLLECTIONS_ENABLED', modes: ['incremental', 'full'] },
  { jobType: 'discount_codes_sync', skipEnv: 'SHOPIFY_SKIP_DISCOUNT_CODES', daysEnv: 'SHOPIFY_DISCOUNT_CODES_DAYS', modes: ['incremental', 'full'] },
  { jobType: 'draft_orders_sync', skipEnv: 'SHOPIFY_SKIP_DRAFT_ORDERS', modes: ['incremental', 'full'] },
  { jobType: 'inventory_snapshot', skipEnv: 'SHOPIFY_SKIP_INVENTORY', modes: ['incremental', 'full'] },
  { jobType: 'catalog_sync', skipEnv: 'SHOPIFY_SKIP_CATALOG', modes: ['incremental', 'full'] },
];

const isTrue = (v) => String(v ?? '').trim().toLowerCase() === 'true';
const supplied = (v) => String(v ?? '').trim() !== '';

/** Is this run a hand-dispatched backfill, as opposed to a cron?
 *
 * The distinction decides the failure policy, not the work: a nightly that
 * loses its analytics stage should still deliver sales, while a manual
 * backfill that loses the stage it was run for has failed, whatever else it
 * managed. The workflow passes github.event_name through so this is a fact
 * about the trigger rather than a guess from the inputs.
 */
export function isManualRun(env = {}) {
  const kind = String(env.SHOPIFY_RUN_KIND ?? '').trim().toLowerCase();
  if (kind) return kind === 'workflow_dispatch' || kind === 'manual';
  // No RUN_KIND at all means the caller is not the workflow -- a local run or
  // the edge function. Treat it as manual: somebody is watching, and the
  // stricter policy is the safer default when the trigger is unknown.
  return true;
}

/**
 * Decide, per stage, whether it runs and — when it does not — exactly why.
 *
 * Returns one entry per stage with:
 *   enabled            will it run
 *   skipReason         plain-English why not (null when enabled)
 *   parameterSupplied  a days value was given for this stage
 *   contradiction      a days value was given AND the stage is off
 *   requested          this run was asked for this stage, by either the skip
 *                      flag or a supplied parameter. This is the flag the
 *                      exit-code policy reads.
 */
export function buildSyncPlan(env = {}) {
  const mode = String(env.SHOPIFY_SYNC_MODE || 'incremental').toLowerCase();
  const manual = isManualRun(env);

  const stages = SYNC_STAGES.map((stage) => {
    const parameterSupplied = Boolean(stage.daysEnv) && supplied(env[stage.daysEnv]);
    const parameterValue = stage.daysEnv ? (env[stage.daysEnv] ?? null) : null;
    const inMode = stage.modes.includes(mode);

    const base = {
      jobType: stage.jobType,
      daysEnv: stage.daysEnv ?? null,
      parameterSupplied,
      parameterValue: parameterSupplied ? String(parameterValue) : null,
    };

    if (!inMode) {
      return {
        ...base,
        // 'mode' vs 'flag' decides whether a skip is worth a durable job row.
        // A stage the MODE never runs is skipped on every run of that mode and
        // recording it would bury the interesting rows; a stage turned off by
        // its own flag is a choice somebody made for this run.
        gate: 'mode',
        enabled: false,
        // A days value for a stage this MODE never runs is the same class of
        // contradiction as one paired with a skip flag, and is easier to hit
        // by accident (the mode is a dropdown, the days are a text box).
        contradiction: parameterSupplied,
        requested: parameterSupplied,
        skipReason: parameterSupplied
          ? `sync_mode=${mode} does not run ${stage.jobType}, but ${stage.daysEnv}=${parameterValue} was supplied`
          : `sync_mode=${mode} does not run ${stage.jobType}`,
      };
    }

    const off = stage.skipEnv ? isTrue(env[stage.skipEnv]) : !isTrue(env[stage.enableEnv]);
    if (!off) {
      return { ...base, gate: 'flag', enabled: true, contradiction: false, requested: true, skipReason: null };
    }

    const gate = stage.skipEnv ? `${stage.skipEnv}=true` : `${stage.enableEnv} is not 'true'`;
    return {
      ...base,
      gate: 'flag',
      enabled: false,
      contradiction: parameterSupplied,
      requested: parameterSupplied,
      skipReason: parameterSupplied
        ? `${gate}, but ${stage.daysEnv}=${parameterValue} was supplied — contradictory inputs, the skip won`
        : gate,
    };
  });

  return { mode, manual, stages };
}

/** Should this not-run stage get a durable sync_jobs row?
 *
 * Always for a contradiction — whoever triggered it, a run that was handed
 * "do 730 days" and "don't do it" needs a record saying which won.
 *
 * Otherwise only on manual runs, and only for a stage turned off by its own
 * flag. The 2-hourly refresh turns four stages off by design, twelve times a
 * day, across every connection: writing that down is ~900 rows a day that say
 * nothing and bury the rows that say something. A stage the MODE never runs
 * gets no row for the same reason.
 */
export function shouldRecordSkippedJob(stage, { manual } = {}) {
  if (!stage || stage.enabled) return false;
  if (stage.contradiction) return true;
  return Boolean(manual) && stage.gate === 'flag';
}

/** States a stage can end in. `partial` is the one that did not exist before:
 * a stage that wrote real rows and did not finish what it was asked for. It
 * is deliberately NOT a success — the data is legitimate and keeping it is the
 * point, but the WINDOW was not covered, and a run that reports success there
 * is telling the next person the backfill happened. */
export const STAGE_STATES = ['success', 'partial', 'error', 'skipped', 'scope_skipped'];
const NOT_DONE = new Set(['partial', 'error', 'skipped']);

/**
 * Turn the run's stage outcomes into an exit code.
 *
 * MANUAL: any stage that was requested and did not complete fails the run.
 *   That covers all three shapes of the 2026-09-09 failure — a stage that
 *   errored, a stage that wrote part of its window, and a stage that was
 *   skipped despite a parameter asking for it.
 *
 * SCHEDULED: unchanged, deliberately. The nightly's non-fatal policy is
 *   correct — an analytics stage failing must not mark the run that
 *   successfully synced every sale as failed, because a red nightly that is
 *   routinely red stops being read. sales-freshness-check.yml is the alarm
 *   for the feeds that genuinely cannot be allowed to lapse.
 *
 * `scope_skipped` never fails a run either way: a connection lacking a
 * Shopify scope is a configuration fact about that store, not a failure of
 * this run, and it does not become true or false based on who triggered it.
 */
export function runOutcomeReport({ manual, outcomes = [] }) {
  const failures = outcomes.filter((o) => o.requested && NOT_DONE.has(o.state));
  const exitCode = manual && failures.length ? 1 : 0;

  const lines = failures.map((o) => {
    const where = o.shopDomain ? `${o.shopDomain} ` : '';
    return `  ${where}${o.jobType}: ${o.state}${o.detail ? ` — ${o.detail}` : ''}`;
  });

  const summary = failures.length
    ? (manual
      ? `${failures.length} requested step(s) did not complete:\n${lines.join('\n')}`
      : `${failures.length} requested step(s) did not complete (non-fatal on a scheduled run):\n${lines.join('\n')}`)
    : null;

  return { exitCode, failures, summary };
}
