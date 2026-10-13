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
/**
 * Connections that do NOT write the feed's table. Search Console lives in
 * ad_platform_connections but writes search_console_*_daily, never
 * marketing_kpis_daily (ad-platforms-sync.mjs branches it off before
 * runConnectionSync), so its stamp says nothing about the marketing feed.
 * An exclusion list rather than an allowlist on purpose: a new campaign
 * platform is then checked by default instead of silently dropped.
 */
const NOT_A_PRODUCER = {
  ad_platform_connections: new Set(['search_console']),
};

/** Does this connection row write the table the feed checks? */
export function producesFeed(connTable, row) {
  return !!row && !NOT_A_PRODUCER[connTable]?.has(row.platform);
}

/** The connections this feed is actually judged on: sync enabled, and writing
 *  the feed's table. One definition, so every rule below asks the same
 *  question of the same rows. */
export function enabledProducers(connections, connTable = null) {
  return (connections || []).filter((c) => c && c.sync_enabled !== false
    && (!connTable || producesFeed(connTable, c)));
}

export const SYNC_STAMP = {
  shopify_connections: 'last_sales_sync_at',
  ad_platform_connections: 'last_sync_at',
};

/**
 * Where a connection records that its last failure was the CLIENT'S to fix
 * (ad-platforms-sync.mjs writes it from lib/ad-sync-client-errors.mjs, and
 * clears it on the next success). Only ad connections have one; a Shopify
 * connection has no equivalent, so its feed is judged on the sync stamp alone.
 */
export const CLIENT_BLOCK = {
  ad_platform_connections: 'client_side_block',
};

/** When this connection's last attempt ran, by whichever stamp it carries:
 *  a successful sync, or a client-side block recorded in place of one. */
function attemptedAt(conn, stampKey, blockKey) {
  const ok = Date.parse(conn?.meta?.[stampKey] || '');
  const blockedAt = blockKey ? Date.parse(conn?.meta?.[blockKey]?.at || '') : NaN;
  const blocked = Number.isFinite(blockedAt);
  if (!Number.isFinite(ok)) return blocked ? { at: blockedAt, blocked: true } : null;
  if (blocked && blockedAt > ok) return { at: blockedAt, blocked: true };
  return { at: ok, blocked: false };
}

/**
 * @param connections rows with { sync_enabled, meta } for ONE company and feed
 * @param stampKey    meta key holding the last successful sync time
 * @param dayEndedAt  Date: when the last complete Pacific day ended
 * @param connTable   when given, connections that do not write the feed's
 *                    table (producesFeed) are ignored
 * @returns true when the lag is explained -- see feedExcuse, which this
 *          wraps and which names WHICH explanation
 */
export function feedIsQuiet(connections, stampKey, dayEndedAt, connTable = null) {
  return feedExcuse(connections, stampKey, dayEndedAt, connTable) !== null;
}

/**
 * Why this feed's lag is not an alarm, or null when it IS one.
 *
 * Every enabled connection behind the feed has to be accounted for since the
 * last complete Pacific day ended, by one of two stamps:
 *
 *   'quiet'          every one of them SYNCED successfully, and still the data
 *                    lags -- so there was nothing newer to fetch.
 *   'client-blocked' at least one of them last failed for a reason only the
 *                    account owner can fix (meta.client_side_block), and the
 *                    rest synced. BlockayOps' cancelled Google Ads account
 *                    held the marketing feed at 2026-10-05 and turned this
 *                    alarm red on every run from 2026-10-07; nobody at SILO
 *                    could act on it, which is the failure mode the alarm's
 *                    own scope note warns trains everyone to ignore it.
 *
 * Both bars are the same: the stamp must be AT OR AFTER dayEndedAt. A block
 * recorded days ago is not an excuse -- a connection that has stopped being
 * attempted at all is the dropped sync this alarm exists to catch -- and
 * ad-platforms-sync.mjs clears the block on the next success, so a healed
 * connection cannot keep quietening the alarm.
 *
 * @returns 'quiet' | 'client-blocked' | null
 */
export function feedExcuse(connections, stampKey, dayEndedAt, connTable = null) {
  const enabled = enabledProducers(connections, connTable);
  if (!enabled.length || !(dayEndedAt instanceof Date) || Number.isNaN(+dayEndedAt)) return null;
  const blockKey = connTable ? CLIENT_BLOCK[connTable] : null;
  let blocked = false;
  for (const c of enabled) {
    const attempt = attemptedAt(c, stampKey, blockKey);
    if (!attempt || attempt.at < +dayEndedAt) return null;
    if (attempt.blocked) blocked = true;
  }
  return blocked ? 'client-blocked' : 'quiet';
}

/**
 * The connections whose CURRENT blocks are what `feedExcuse` read: enabled,
 * feed-producing, and whose newest stamp is a block at or after dayEndedAt.
 *
 * Reported separately so the alarm's warning names exactly the accounts that
 * explain the verdict. Filtering on "has a block stamp" alone also named a
 * connection whose sync is switched off, or whose block a later success had
 * already superseded, telling whoever read the run that two accounts needed
 * remediation when only one did (review cycle 1, #957).
 */
export function feedBlockers(connections, stampKey, dayEndedAt, connTable = null) {
  if (!(dayEndedAt instanceof Date) || Number.isNaN(+dayEndedAt)) return [];
  const blockKey = connTable ? CLIENT_BLOCK[connTable] : null;
  if (!blockKey) return [];
  return enabledProducers(connections, connTable).filter((c) => {
    const attempt = attemptedAt(c, stampKey, blockKey);
    return !!attempt && attempt.blocked && attempt.at >= +dayEndedAt;
  });
}

/**
 * Is EVERY connection that writes this feed currently blocked?
 *
 * The question a PARTIAL day has to ask. `feedExcuse` answers at company
 * level, so one blocked connection makes the whole feed `client-blocked` --
 * fine for a feed that LAGS, where the blocked account explains the gap, and
 * wrong for a partial day, where a healthy sibling producer could still
 * correct yesterday's rows and is exactly the successful-but-partial case the
 * alarm exists to catch (review cycle 2). A partial day may only be waived
 * when nothing left can correct it.
 */
export function feedFullyBlocked(connections, stampKey, dayEndedAt, connTable = null) {
  const producers = enabledProducers(connections, connTable);
  if (!producers.length) return false;
  return feedBlockers(connections, stampKey, dayEndedAt, connTable).length === producers.length;
}

/**
 * Companies expected to have this feed: those with at least one active,
 * sync-enabled connection that writes it. Matches what the syncs load
 * (ad-platforms-sync.mjs filters sync_enabled = true), so a company whose
 * only campaign connection is switched off is not alarmed on (review
 * cycle 2, #859).
 */
export function expectedCompanies(connTable, rows) {
  return [...new Set((rows || [])
    .filter((c) => c && c.sync_enabled !== false && producesFeed(connTable, c))
    .map((c) => c.company_entity_id).filter(Boolean))];
}
