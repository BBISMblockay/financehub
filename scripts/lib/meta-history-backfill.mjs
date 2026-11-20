// A newly added Meta connection's first two years of history.
//
// The nightly pulls a trailing 30 days, so before this a client who connected
// Meta saw a month of data and anything older needed someone to run
// ad-platforms-sync.yml by hand with a larger days_back. Now a new Meta
// connection is born carrying `meta.history_backfill_pending = true` (stamped
// by newConnectionMeta() in the OAuth callback; before 2026-11-13 the
// pasted-token form on Integrations stamped it too), and the
// next FULL scheduled run (the 2-hourly refresh skips organic, so it cannot
// finish the import and leaves the flag alone) pulls META_HISTORY_DAYS for
// that one connection: daily campaign totals, ad-level rows and Page posts.
//
// Only a connection carrying the flag is ever widened. Existing connections
// have no flag, so an established account is never re-pulled for a year.
// A failed import keeps the flag and retries on the next full run, up to
// META_HISTORY_MAX_ATTEMPTS, then gives up and records that it did -- a
// connection that can never succeed must not re-pull a year every night.
// Every write the import makes is the nightly's own idempotent upsert, so an
// import overlapping another run duplicates nothing.

// Two years, so year-over-year works on the day a company connects -- the
// same depth every other first connect asks for (BOOTSTRAP_DEFAULTS:
// adsDaysBack, shopifyHistoryDays, shopifySessionsDays are all 730). It was
// 365, and that was the one number that made a new Meta account shallower
// than its Google Ads sibling in the same workspace: measured 2026-11-20 on a
// live account, Meta still served daily insights back to November 2023, two
// years of it outside SILO. Meta's own retention is about 37 months, so 730
// is inside what the source will serve rather than at its edge.
export const META_HISTORY_DAYS = 730;
// The CAMPAIGN-grain pull above is chunked a week at a time; the AD-grain one
// is forced to one day per request (see fetchMetaAdLevelRows), so every extra
// day of depth is another round trip and 730 days would double the cost of a
// connect. Daily spend, impressions, clicks and conversions -- what a
// year-over-year read by channel needs -- come from the campaign grain, so
// the per-ad grain keeps the year it had. An explicit days_back on an
// ESTABLISHED connection is never clamped: a deliberate deep ad-level
// backfill is exactly what the dispatch input is for.
export const META_AD_LEVEL_HISTORY_DAYS = 365;
export const META_HISTORY_MAX_ATTEMPTS = 3;

/** Should this run import history for this connection, and over how many days? Pure. */
export function planMetaHistory(connection, { skipOrganic = false, daysBack = null } = {}) {
  const meta = connection?.meta || {};
  const pending = connection?.platform === 'meta_ads'
    && meta.history_backfill_pending === true
    && Number(meta.history_backfill_attempts || 0) < META_HISTORY_MAX_ATTEMPTS;
  if (!pending || skipOrganic) return { backfill: false, daysBack };
  return { backfill: true, daysBack: Math.max(Number(daysBack) || 0, META_HISTORY_DAYS) };
}

/** How deep the AD-LEVEL pass of this run should go, given the campaign-grain
 * window it was planned with. Only a first-connect import is clamped. Pure. */
export function metaAdLevelDaysBack({ backfill, daysBack }) {
  if (!backfill) return daysBack;
  const planned = Number(daysBack) || 0;
  return planned > META_AD_LEVEL_HISTORY_DAYS ? META_AD_LEVEL_HISTORY_DAYS : daysBack;
}

/**
 * Did every part of the import land? The campaign totals are already known
 * to have (a failure there throws before this is asked); ad-level and
 * organic report their own failure as `{ error }` without throwing, and the
 * organic sync catches a Facebook Page Insights failure separately as
 * `page_error` (Instagram may still have landed), which is just as missing.
 *
 * Deliberately NOT consulted here (2026-10-26): `organic.ig_account_error` and
 * `organic.page_posts_error`. The two reads behind them -- the Instagram
 * account snapshot and the Page's recent posts -- have no history to import:
 * the profile is a CURRENT reading and the post walk is a fixed, shallow
 * count, neither of which widens with daysBack. Letting either fail the import
 * would make a 365-day re-pull (one insights request per Instagram post) hinge
 * on a read a year's window would not have improved. `page_error` stays in the
 * list because the Page insight series genuinely IS the history.
 */
export function metaHistoryComplete(result) {
  return !result?.ad_level?.error && !result?.organic?.error && !result?.organic?.page_error;
}

/** The connection's `meta` after a run, given whether it was an import and how it went. Pure. */
export function metaAfterHistory(meta, { backfill, succeeded, at }) {
  const m = { ...(meta || {}) };
  if (!backfill) return m;
  if (succeeded) {
    delete m.history_backfill_attempts;
    return { ...m, history_backfill_pending: false, history_backfilled_at: at, history_backfill_days: META_HISTORY_DAYS };
  }
  const attempts = Number(m.history_backfill_attempts || 0) + 1;
  if (attempts >= META_HISTORY_MAX_ATTEMPTS) {
    return { ...m, history_backfill_pending: false, history_backfill_attempts: attempts, history_backfill_gave_up_at: at };
  }
  return { ...m, history_backfill_attempts: attempts };
}
