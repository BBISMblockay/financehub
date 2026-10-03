/**
 * "Quiet" vs "stale" for the freshness alarm (scripts/check-sales-freshness.mjs).
 *
 * The alarm exists to catch a sync that DID NOT RUN. Measuring that only by the
 * newest day_date conflates it with a company that simply had nothing to report:
 * Bat Nutz (a new store, one order ever) read STALE on every run from
 * 2026-10-02 although its sync had succeeded minutes earlier, which turned the
 * daily alarm red for a non-event -- the failure mode the scope note in the
 * alarm warns trains everyone to ignore it.
 *
 * A feed is QUIET when its data lags but EVERY enabled connection behind it
 * recorded a successful sync AFTER the last complete Pacific day ended. Both
 * stamps read here are written only on success (shopify-sync.mjs after
 * incremental_sales; ad-platforms-sync.mjs before finishJob 'success'), so a
 * dropped, failed or never-configured sync can never read as quiet.
 */
export const SYNC_STAMP = {
  shopify_connections: 'last_sales_sync_at',
  ad_platform_connections: 'last_sync_at',
};

/**
 * @param connections rows with { sync_enabled, meta } for ONE company and feed
 * @param stampKey    meta key holding the last successful sync time
 * @param dayEndedAt  Date: when the last complete Pacific day ended
 * @returns true only when at least one enabled connection exists and every
 *          enabled one synced successfully at or after dayEndedAt
 */
export function feedIsQuiet(connections, stampKey, dayEndedAt) {
  const enabled = (connections || []).filter((c) => c && c.sync_enabled !== false);
  if (!enabled.length || !(dayEndedAt instanceof Date) || Number.isNaN(+dayEndedAt)) return false;
  return enabled.every((c) => {
    const at = Date.parse(c.meta?.[stampKey] || '');
    return Number.isFinite(at) && at >= +dayEndedAt;
  });
}
