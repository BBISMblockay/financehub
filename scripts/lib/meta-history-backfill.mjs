// A newly added Meta connection's first year of history.
//
// The nightly pulls a trailing 30 days, so before this a client who connected
// Meta saw a month of data and anything older needed someone to run
// ad-platforms-sync.yml by hand with a larger days_back. Now Integrations
// marks a NEW Meta connection `meta.history_backfill_pending = true`, and the
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

export const META_HISTORY_DAYS = 365;
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

/**
 * Did every part of the import land? The campaign totals are already known
 * to have (a failure there throws before this is asked); ad-level and
 * organic report their own failure as `{ error }` without throwing, and the
 * organic sync catches a Facebook Page Insights failure separately as
 * `page_error` (Instagram may still have landed), which is just as missing.
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
