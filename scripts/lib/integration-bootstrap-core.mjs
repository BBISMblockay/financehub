// scripts/lib/integration-bootstrap-core.mjs -- what a newly connected
// integration's FIRST sync consists of, and how a half-finished one resumes.
//
// WHY THIS EXISTS. Connecting an integration used to leave its data to a
// button or to a nightly, and Shopify's history import is browser-driven in
// 7-day chunks with "Keep this tab open" printed next to it -- so clicking
// away mid-import stops it. Measured on production 2026-10-12:
// hhoutfitter.myshopify.com had 2,996 sales rows and zero inventory rows, and
// i09sb0-6m had 52 "successful" snapshots with no inventory at all.
//
// WHAT THIS MODULE IS, AND IS NOT. It is the PLAN and the JUDGEMENT, as pure
// functions over plain objects: which stages a given integration's first sync
// consists of, in which order, with which environment; which of them are
// still owed given what a previous attempt recorded; and what the row's
// status should become once the attempt ends. No network, no database, no
// process.env, no child processes -- so a test can drive a half-finished job,
// a dead connection or a stage that fails, and assert on the answer.
// scripts/integration-bootstrap.mjs is what claims rows and spawns the
// stages.
//
// IT REUSES THE REAL SYNCS ON PURPOSE. Every stage below is one of the
// entry-point scripts the scheduled workflows already run, scoped to one
// connection through the env vars those scripts already read
// (SHOPIFY_ONLY_CONNECTION_ID, ADS_ONLY_CONNECTION_ID, SC_CONNECTION_ID,
// REDO_COMPANY_ENTITY_ID). Nothing here is a second implementation of a sync,
// because a second implementation is a second set of numbers.

/** Shopify's first sync is two stages, not one `full` run.
 *
 * `full` mode would do the 60-day order history AND the nine other stages in
 * one process. Splitting them means the long stage is alone: if the history
 * import dies at day 40, the resume re-runs only the history, and the stock,
 * catalog and analytics that already landed are not fetched again. It also
 * means a store shows its products and stock within a minute or two while the
 * order history is still coming in, which is the point of doing this on
 * connect at all.
 *
 * The second stage runs in `incremental` mode rather than `full`, because
 * `full` includes history_import and would re-import stage 1. On a store
 * whose history just landed, the incremental sales pass is cheap.
 */
const SHOPIFY_STAGES = [
  {
    stage: 'sales_history',
    script: 'scripts/shopify-sync.mjs',
    env: (job, opts) => ({
      SHOPIFY_SYNC_MODE: 'history',
      // A first import is judged like a hand-dispatched backfill, not like a
      // nightly: a nightly that loses its analytics stage should still
      // deliver sales, while a first sync that loses the stage it exists for
      // has failed and must not report success (sync-plan.mjs, run #354).
      SHOPIFY_RUN_KIND: 'manual',
      SHOPIFY_ONLY_CONNECTION_ID: job.connection_id,
      SHOPIFY_HISTORY_DAYS: String(opts.shopifyHistoryDays),
      // The long stage runs alone -- see above.
      SHOPIFY_SKIP_PAYOUTS: 'true',
      SHOPIFY_SKIP_SESSIONS: 'true',
      SHOPIFY_SKIP_LANDING_PAGES: 'true',
      SHOPIFY_SKIP_DISCOUNT_CODES: 'true',
      SHOPIFY_SKIP_DRAFT_ORDERS: 'true',
      SHOPIFY_SKIP_INVENTORY: 'true',
      SHOPIFY_SKIP_CATALOG: 'true',
    }),
  },
  {
    stage: 'storefront',
    script: 'scripts/shopify-sync.mjs',
    env: (job, opts) => ({
      SHOPIFY_SYNC_MODE: 'incremental',
      SHOPIFY_RUN_KIND: 'manual',
      SHOPIFY_ONLY_CONNECTION_ID: job.connection_id,
      // Collections is opt-IN everywhere else because it had never run
      // against live Shopify; a store's FIRST sync is exactly when its
      // collection registry is worth building, and scripts/CLAUDE.md names
      // the first run with a single connection as its intended use.
      SHOPIFY_COLLECTIONS_ENABLED: 'true',
      SHOPIFY_SESSIONS_DAYS: String(opts.shopifySessionsDays),
      SHOPIFY_LANDING_PAGES_DAYS: String(opts.shopifyLandingPagesDays),
      SHOPIFY_DISCOUNT_CODES_DAYS: String(opts.shopifyDiscountCodesDays),
    }),
  },
];

/** One ad connection's first sync.
 *
 * ADS_SKIP_SEARCH_CONSOLE is set because Search Console is its own
 * integration row with its own (much longer) backfill, and ADS_SKIP_ORGANIC
 * is not: a newly connected Meta account's organic posts are part of what
 * someone connected it to see.
 */
const adStages = (platform) => [
  {
    stage: 'kpis',
    script: 'scripts/ad-platforms-sync.mjs',
    env: (job, opts) => ({
      ADS_ONLY_CONNECTION_ID: job.connection_id,
      ADS_ONLY_COMPANY_ID: job.company_entity_id,
      ADS_ONLY_PLATFORM: platform,
      ADS_DAYS_BACK: String(opts.adsDaysBack),
      ADS_SKIP_SEARCH_CONSOLE: 'true',
    }),
  },
];

/** Search Console's own backfill, which is the long one (16 months is the
 * most Google will return) and is why it is not folded into the ad stage. */
const SEARCH_CONSOLE_STAGES = [
  {
    stage: 'backfill',
    script: 'scripts/search-console-backfill.mjs',
    env: (job, opts) => ({
      SC_CONNECTION_ID: job.connection_id,
      SC_COMPANY_ID: job.company_entity_id,
      SC_BACKFILL_DAYS: String(opts.searchConsoleDays),
    }),
  },
];

/** Redo is webhook-driven for new returns, so its first sync is the API
 * catch-up for everything that happened BEFORE the webhook existed, plus the
 * marketing reporting sync.
 *
 * Both stages need `redo_connections.api_secret`; the webhook alone does not.
 * A connection with no secret is not an error and must not be retried as one
 * -- the drainer records both stages as skipped and the job as done, which is
 * the honest outcome: the webhook is live, the history is not available
 * without a token.
 */
const REDO_STAGES = [
  {
    stage: 'returns_backfill',
    script: 'scripts/redo-backfill.mjs',
    needs: ['api_secret'],
    env: (job, opts) => ({
      REDO_COMPANY_ENTITY_ID: job.company_entity_id,
      // Blank REDO_UPDATED_AT_MIN means full history, which is what a first
      // sync wants: the webhook covers from now on, so the gap is everything
      // before it.
      REDO_UPDATED_AT_MIN: opts.redoReturnsStart || '',
    }),
  },
  {
    stage: 'marketing',
    script: 'scripts/redo-marketing-sync.mjs',
    needs: ['api_secret'],
    env: (job, opts) => ({
      REDO_MARKETING_COMPANY_ID: job.company_entity_id,
      REDO_MARKETING_START: opts.redoMarketingStart || '',
    }),
  },
];

/** integration -> its ordered stages. An integration absent from here has no
 * plan, and planBootstrap throws rather than returning an empty one: an empty
 * plan would report a job `done` having run nothing, which is the exact
 * failure mode this whole feature exists to remove. */
export const BOOTSTRAP_PLANS = {
  shopify: SHOPIFY_STAGES,
  google_ads: adStages('google_ads'),
  ga4: adStages('ga4'),
  meta_ads: adStages('meta_ads'),
  tiktok_ads: adStages('tiktok_ads'),
  search_console: SEARCH_CONSOLE_STAGES,
  redo: REDO_STAGES,
};

export const BOOTSTRAP_DEFAULTS = {
  // 60 days, matching what a store without read_all_orders can return at all
  // (Shopify caps order history at 60 days without that scope), so the
  // default asks for exactly what is gettable rather than failing on day 61.
  shopifyHistoryDays: 60,
  shopifySessionsDays: 90,
  shopifyLandingPagesDays: 30,
  shopifyDiscountCodesDays: 30,
  adsDaysBack: 90,
  searchConsoleDays: 480,
  redoReturnsStart: '',
  redoMarketingStart: '',
};

/** The stages this job consists of, with the env each one needs.
 *
 * `connection` is that integration's own connection row where one was read
 * (used only to decide `needs`), or null. A stage whose `needs` are unmet is
 * returned with `skip` set and a reason, rather than omitted: a skipped stage
 * is a fact worth recording on the row, and omitting it would make the job
 * look complete for a different reason than it was.
 */
export function planBootstrap(job, { options = {}, connection = null } = {}) {
  const plan = BOOTSTRAP_PLANS[job?.integration];
  if (!plan) {
    throw new Error(`No bootstrap plan for integration "${job?.integration}"`);
  }
  if (!job.company_entity_id) {
    throw new Error('Bootstrap job has no company_entity_id');
  }
  // Every integration but Redo is per-connection; Redo is one row per company
  // and its scripts take the company, not a connection id.
  if (job.integration !== 'redo' && !job.connection_id) {
    throw new Error(`Bootstrap job for ${job.integration} has no connection_id`);
  }
  const opts = { ...BOOTSTRAP_DEFAULTS, ...options };
  return plan.map((s) => {
    const missing = (s.needs || []).filter((f) => !connection || !connection[f]);
    return {
      stage: s.stage,
      script: s.script,
      env: s.env(job, opts),
      skip: missing.length ? `missing ${missing.join(', ')}` : null,
    };
  });
}

/** Of the planned stages, the ones still owed.
 *
 * A stage already recorded `done` or `skipped` is finished and is not run
 * again -- that is what makes a resumed job cheap, and it is also what stops
 * a retry from paying twice for the same API calls. A stage recorded `error`
 * IS owed again: the attempt cap on the row is what ends the retrying, not
 * the stage record.
 */
export function pendingStages(job, planned) {
  const recorded = (job && job.stages) || {};
  return planned.filter((s) => {
    const st = recorded[s.stage]?.status;
    return st !== 'done' && st !== 'skipped';
  });
}

/** What the row's status becomes when an attempt ends.
 *
 * `partial` exists so that "some of it landed" is not reported as either
 * success or failure: the page must be able to say which stage is missing,
 * and the drainer must not restart from stage one.
 */
export function bootstrapOutcome(stages = {}) {
  const values = Object.values(stages);
  if (!values.length) return 'pending';
  const states = values.map((v) => v?.status);
  if (states.some((s) => s === 'running')) return 'running';
  const errored = states.filter((s) => s === 'error').length;
  const finished = states.filter((s) => s === 'done' || s === 'skipped').length;
  if (errored === 0) return 'done';
  if (finished === 0) return 'error';
  return 'partial';
}

/** Merge one stage's result into the row's stages map, without losing the
 * others. The drainer writes the whole jsonb column, so a read-modify-write
 * that dropped a sibling stage would make finished work look owed. */
export function withStageResult(stages, stage, status, detail, at = new Date()) {
  return {
    ...(stages || {}),
    [stage]: {
      status,
      at: at.toISOString(),
      ...(detail ? { detail: String(detail).slice(0, 2000) } : {}),
    },
  };
}

/** Human one-liner for the Integrations page: "4 of 9 done" and what is
 * running, derived from the same map the drainer writes. */
export function bootstrapProgress(job, planned) {
  const recorded = (job && job.stages) || {};
  const total = planned.length;
  const done = planned.filter((s) => {
    const st = recorded[s.stage]?.status;
    return st === 'done' || st === 'skipped';
  }).length;
  const running = planned.find((s) => recorded[s.stage]?.status === 'running');
  return { done, total, running: running ? running.stage : null };
}
