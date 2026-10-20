/**
 * The daily "is every client's data actually arriving?" pass.
 *
 * WHY THIS EXISTS. SILO had exactly one independent alarm
 * (scripts/check-sales-freshness.mjs) and it asks a narrower question than
 * anyone assumed: it covers two feeds, and it only looks at connections with
 * `sync_enabled = true`. A store nobody ever switched on is invisible to it --
 * so a connected Shopify store can sit at zero rows in `sales_by_day` for
 * weeks while the Integrations page says "Connected", and nothing anywhere
 * says otherwise. Today the person who notices a feed that never started is
 * the client.
 *
 * This file is the DECISIONS; scripts/reconcile-integrations.mjs is the IO.
 * Keeping them apart is what lets every rule below be executed in a test
 * rather than inferred from a log. Three questions per connection, in order:
 *
 *   1. EXPIRY    -- is its authorisation about to run out?
 *   2. COVERAGE  -- has this connection ever produced anything at all?
 *   3. FRESHNESS -- if it has, is what it produced recent enough for its feed?
 *
 * WHY IT IS A SEPARATE SCRIPT from the freshness alarm. That alarm's own
 * header says it "deliberately does no work beyond one query: anything
 * heavier is another thing that can break", and it is the thing that catches
 * a dropped nightly. Seven feeds, a coverage probe per connection and a write
 * path do not belong inside it. This pass runs on its own schedule and can
 * fail without taking the nightly alarm down with it.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE, both Blake's, both already load-bearing
 * in v2/integration-enrolment.js:
 *
 *   - Never infer consent to enable a store. Missing history is not
 *     permission. The ONLY connection this pass may start is one with no
 *     import evidence at all AND no pause recorded against it. Everything
 *     else it reports.
 *   - Preserve explicit pauses. A pause stamp outranks every other signal
 *     here, including "it has produced nothing", because a store switched off
 *     before its first import is still a store somebody switched off.
 */

/** How far ahead an expiring authorisation is worth warning about. Thirty
 *  days is enough to tell a person, reach the client, and get them to
 *  re-authorise before the link dies. */
export const EXPIRY_WARN_DAYS = 30;

/**
 * Every feed that has a connection table behind it.
 *
 * `maxLagDays` is per feed because the feeds are not comparable. Sales are
 * complete through the last finished Pacific day, so 1 is healthy. Search
 * Console serves final data two days back and yesterday is simply ABSENT, not
 * zero, so 1 there would be red every morning -- and an alarm that is red
 * every morning is an alarm nobody reads, which is how the gaps this pass
 * exists to find went unnoticed behind a check that had been red for thirty
 * consecutive runs. SERP runs on Mondays, so a week plus slack.
 *
 * `match` is how a data row is tied back to ONE connection, and it differs by
 * table for real reasons: `sales_by_day` and `inventory_on_hand` carry
 * `shop_domain` and no connection id, the ad and Plaid tables carry
 * `connection_id`, and the SERP and Redo tables are company-grained only.
 * A company-grained feed cannot distinguish two connections of the same kind,
 * so every connection of that kind in one company shares its verdict.
 *
 * `eventDriven` marks a feed where NO rows is a normal business state rather
 * than a fault: a store with no returns has no returns. Those are never
 * judged on lag.
 */
export const INTEGRATION_FEEDS = [
  {
    label: 'sales',
    connTable: 'shopify_connections',
    table: 'sales_by_day',
    match: { connColumn: 'shop_domain', dataColumn: 'shop_domain' },
    // Two companies can hold the same storefront, and production holds three
    // such pairs. The probe is scoped to the connection's own company, so a
    // second company's copy reads as empty -- which is true, and must never
    // become a reason to import somebody else's store into it.
    identityColumn: 'shop_domain',
    dayColumn: 'day_date',
    // Judged on when the SYNC last ran, not on the newest day in the table.
    // `sales_by_day` holds a row per day that had sales, so a store with no
    // orders since March has a six-month-old newest day while syncing fine
    // every morning -- ten of production's 24 stores look like that today.
    // The data answers "has anything ever arrived"; the stamp answers "is
    // this connection still being synced", which is the question here.
    stamp: { on: 'connection', metaKey: 'last_sales_sync_at' },
    maxLagDays: 1,
    integration: 'shopify',
    workflow: 'shopify-sync.yml',
  },
  {
    // One snapshot, overwritten every run (the table holds no history, by
    // decision -- supabase/CLAUDE.md), so the watermark is when it was taken,
    // not a business day.
    label: 'inventory',
    connTable: 'shopify_connections',
    table: 'inventory_on_hand',
    match: { connColumn: 'shop_domain', dataColumn: 'shop_domain' },
    identityColumn: 'shop_domain',
    timestampColumn: 'snapshot_at',
    // No per-connection inventory stamp exists, and none is needed: the
    // snapshot is written every run for every store, so the table's own
    // watermark IS the attempt.
    stamp: { on: 'data' },
    maxLagDays: 2,
    integration: 'shopify',
    workflow: 'shopify-sync.yml',
  },
  {
    label: 'marketing',
    connTable: 'ad_platform_connections',
    // Search Console lives in the same connection table but produces a
    // different feed (lib/freshness-quiet.mjs calls it NOT_A_PRODUCER here).
    excludePlatforms: ['search_console'],
    table: 'marketing_kpis_daily',
    match: { connColumn: 'id', dataColumn: 'connection_id' },
    dayColumn: 'day_date',
    stamp: { on: 'connection', metaKey: 'last_sync_at' },
    maxLagDays: 1,
    // The bootstrap plan is the connection's own platform (google_ads,
    // meta_ads, tiktok_ads, ga4), not one value.
    integrationFromPlatform: true,
    workflow: 'ad-platforms-sync.yml',
  },
  {
    label: 'search_console',
    connTable: 'ad_platform_connections',
    onlyPlatforms: ['search_console'],
    table: 'search_console_site_daily',
    match: { connColumn: 'id', dataColumn: 'connection_id' },
    dayColumn: 'day_date',
    stamp: { on: 'connection', metaKey: 'last_sync_at' },
    maxLagDays: 3,
    integration: 'search_console',
    workflow: 'ad-platforms-sync.yml',
  },
  {
    label: 'seo_serp',
    connTable: 'seo_serp_schedules',
    table: 'seo_serp_runs',
    match: { connColumn: 'company_entity_id', dataColumn: 'company_entity_id' },
    dayColumn: 'observed_on',
    // A schedule records its own last run; a run row only exists where
    // keywords were actually bought.
    stamp: { on: 'connection', column: 'last_run_on' },
    maxLagDays: 9,
    // Starting a SERP run SPENDS MONEY at DataForSEO, and there is no SERP
    // entry in BOOTSTRAP_PLANS anyway. Nothing here may queue one, whatever
    // the flag says.
    neverAutoStart: true,
    workflow: 'seo-serp-sync.yml',
  },
  {
    // Webhook-driven: a store with no returns this week is not broken, so
    // this feed is judged on whether anything has EVER arrived, never on lag.
    label: 'redo',
    connTable: 'redo_connections',
    table: 'redo_returns',
    match: { connColumn: 'company_entity_id', dataColumn: 'company_entity_id' },
    eventDriven: true,
    // A connection that has taken a webhook has produced something even if no
    // return row survived the filter.
    activityColumn: 'last_event_at',
    integration: 'redo',
    workflow: 'redo-marketing-sync.yml',
  },
  {
    label: 'banking',
    connTable: 'plaid_connections',
    table: 'plaid_accounts',
    match: { connColumn: 'id', dataColumn: 'connection_id' },
    timestampColumn: 'last_synced_at',
    // plaid_accounts.last_synced_at is itself the attempt stamp.
    stamp: { on: 'data' },
    maxLagDays: 2,
    // There is no Plaid entry in BOOTSTRAP_PLANS, so there is nothing to
    // queue: this feed is reported, never started.
    neverAutoStart: true,
    workflow: 'plaid-sync.yml',
  },
  {
    // Not a daily feed at all. QuickBooks refreshes its token only when
    // somebody uses the connection, and production's connections were
    // authorised in one sitting, so they expire within days of each other.
    // The risk is nobody being told before they do.
    label: 'quickbooks',
    connTable: 'quickbooks_connections',
    expiryColumn: 'refresh_token_expires_at',
    neverAutoStart: true,
  },
];

/** Whole days from `fromIso` back to `toIso`, both YYYY-MM-DD. */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/** Does this connection belong to this feed? */
export function feedCovers(feed, connection) {
  if (!feed || !connection) return false;
  const platform = connection.platform || null;
  if (feed.onlyPlatforms && !feed.onlyPlatforms.includes(platform)) return false;
  if (feed.excludePlatforms && feed.excludePlatforms.includes(platform)) return false;
  return true;
}

/** Is this connection one a person switched off, or one nobody ever started?
 *
 * The distinction is the whole feature, and it is decided by EVIDENCE, never
 * by a flag that latches. `everProduced` is "has this connection ever written
 * a row anywhere"; `meta.sync_paused_at` is "a person switched this off".
 * Unknown evidence -- a probe that errored -- must read as paused, so that a
 * store with years of history behind a failed probe is never offered to the
 * auto-start.
 */
export function coverageState({ connection, everProduced, lastAttempt = null }) {
  const row = connection || {};
  // plaid_connections carries `status`; the rest carry `is_active`.
  const inactive = row.is_active === false || (row.status != null && row.status !== 'active');
  if (inactive) return 'inactive';
  if (row.meta?.sync_paused_at) return 'paused';
  if (row.last_test_status === 'error' || row.last_test_success === false) return 'connection_failed';
  // Switched off WITH history behind it is a pause somebody meant, exactly
  // as v2/integration-enrolment.js reads it: offering to start that is
  // offering to re-import a store somebody turned off.
  if (everProduced === true) return row.sync_enabled === false ? 'paused' : 'covered';
  if (everProduced === false) {
    // A connection carrying a sync stamp has been synced before, whatever it
    // produced, so this is not a first import and a bootstrap would not be
    // the fix. Production's Meta "App Review test" account is exactly this:
    // switched off, no KPI rows, and a last_sync_at from 2026-10-08.
    if (lastAttempt) return 'synced_but_empty';
    return row.sync_enabled === false ? 'never_imported' : 'enabled_but_empty';
  }
  // null/undefined: we could not tell. The safe answer acts on nothing.
  return 'unknown';
}

/**
 * May this pass START this connection's first import by itself?
 *
 * Deliberately narrow, and deliberately its own function so the rule can be
 * read in one place and broken in a mutation test. Four conditions, all
 * required: the operator has switched auto-start on, the feed can be started
 * at all, there is a bootstrap plan to start, and nothing has ever been
 * imported while nobody paused it.
 *
 * `enabled_but_empty` is NOT startable. Its sync is already on, so the import
 * it is missing is a sync failure, not a missing enrolment, and queueing a
 * bootstrap would paper over whatever is actually breaking.
 */
export function mayAutoStart({ feed, coverage, autoStart, duplicate = false }) {
  if (!autoStart) return { start: false, reason: 'auto-start is off' };
  // The same storefront connected under two companies: which tenant is meant
  // to hold it is a question for a person, and importing it into the wrong
  // one puts another company's sales in their books.
  if (duplicate) return { start: false, reason: 'another company already syncs this connection' };
  if (feed?.neverAutoStart) return { start: false, reason: `${feed.label} is never started automatically` };
  if (!feed?.integration && !feed?.integrationFromPlatform) {
    return { start: false, reason: `${feed?.label} has no bootstrap plan` };
  }
  if (coverage !== 'never_imported') return { start: false, reason: `coverage is ${coverage}` };
  return { start: true, reason: 'connected, never imported, not paused' };
}

/** Which bootstrap plan a connection on this feed belongs to. */
export function integrationFor(feed, connection) {
  if (feed?.integrationFromPlatform) return connection?.platform || null;
  return feed?.integration || null;
}

/** When this connection last ATTEMPTED its sync, where the attempt is
 *  recorded on the connection row (`meta.last_sales_sync_at` and friends,
 *  the same stamps lib/freshness-quiet.mjs reads). */
export function lastAttemptIso(feed, connection) {
  const stamp = feed?.stamp;
  if (!stamp || stamp.on !== 'connection' || !connection) return null;
  if (stamp.metaKey) return connection.meta?.[stamp.metaKey] || null;
  if (stamp.column) return connection[stamp.column] || null;
  return null;
}

/** A failure only the ACCOUNT OWNER can fix, recorded by the ad sync from
 *  lib/ad-sync-client-errors.mjs and cleared on the next success. A dead
 *  client account is not SILO breaking, and one of them used to turn two
 *  workflows red on every run (scripts/CLAUDE.md). */
export function clientBlock(connection) {
  const block = connection?.meta?.client_side_block;
  return block && (block.reason || block.at) ? block : null;
}

/**
 * The freshness half, for a connection we know HAS produced something.
 *
 * Judged on the connection's own attempt stamp where it has one, and on the
 * data table's watermark where it does not. Event-driven and expiry-only
 * feeds are never stale.
 */
export function freshnessState({ feed, newestIso, stampIso, today }) {
  if (!feed || feed.eventDriven || feed.expiryColumn) return { state: 'n/a', lag: null };
  const onConnection = feed.stamp?.on === 'connection';
  const measured = onConnection ? stampIso : newestIso;
  // A stamp that has never been written is a sync that has never run, even
  // where data exists: on a duplicate connection, the row that is actually
  // syncing is the one carrying the stamp.
  if (!measured) return { state: onConnection ? 'never_synced' : 'empty', lag: null };
  const lag = daysBetween(today, measured);
  if (lag === null) return { state: 'unknown', lag: null };
  return { state: lag <= feed.maxLagDays ? 'ok' : 'stale', lag, measured: measured.slice(0, 10) };
}

/** Days until this authorisation runs out, or n/a when it does not expire. */
export function expiryState({ expiresAt, now = new Date() }) {
  if (!expiresAt) return { state: 'n/a', days: null };
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return { state: 'n/a', days: null };
  const days = Math.floor((ms - now.getTime()) / 86400000);
  if (days < 0) return { state: 'expired', days };
  if (days <= EXPIRY_WARN_DAYS) return { state: 'expiring', days };
  return { state: 'ok', days };
}

/**
 * One connection, one verdict.
 *
 * `severity` is what the exit code is built from, and the split matters:
 *
 *   action   a person must do something, or this pass just did
 *   warn     worth seeing in the summary, nobody is blocked
 *   ok       nothing to say
 */
export function reconcileConnection({
  feed, connection, everProduced, newestIso, today, autoStart = false, duplicate = false,
  now = new Date(),
}) {
  const stampIso = lastAttemptIso(feed, connection);
  const coverage = coverageState({ connection, everProduced, lastAttempt: stampIso });
  const blocked = clientBlock(connection);
  const expiry = feed?.expiryColumn
    ? expiryState({ expiresAt: connection?.[feed.expiryColumn], now })
    : { state: 'n/a', days: null };
  const fresh = coverage === 'covered'
    ? freshnessState({ feed, newestIso, stampIso, today })
    : { state: 'n/a', lag: null };
  const auto = mayAutoStart({ feed, coverage, autoStart, duplicate });
  const base = { coverage, expiry, fresh, autoStart: auto };

  // An authorisation that dies next week is the most actionable thing this
  // pass can find, whatever the data looks like -- but only for a connection
  // somebody is still using.
  if (coverage !== 'inactive' && coverage !== 'paused') {
    if (expiry.state === 'expired') {
      return { ...base, state: 'expired', severity: 'action',
        detail: `authorisation expired ${-expiry.days}d ago, the client must re-authorise` };
    }
    if (expiry.state === 'expiring') {
      return { ...base, state: 'expiring', severity: 'action',
        detail: `authorisation expires in ${expiry.days}d, the client must re-authorise before then` };
    }
  }

  if (coverage === 'inactive') {
    return { ...base, state: 'inactive', severity: 'ok', detail: 'not active' };
  }
  if (coverage === 'paused') {
    return { ...base, state: 'paused', severity: 'ok', detail: `paused ${connection.meta.sync_paused_at}` };
  }
  // A dead client account is the client's to fix and SILO's to report once,
  // never a red check every morning -- that is the whole lesson of the
  // freshness alarm sitting red for thirty runs.
  if (blocked) {
    return { ...base, state: 'client_blocked', severity: 'warn',
      detail: `the account owner must fix this: ${String(blocked.reason || 'blocked').slice(0, 120)}${blocked.at ? ` (since ${String(blocked.at).slice(0, 10)})` : ''}` };
  }
  if (coverage === 'connection_failed') {
    return { ...base, state: 'connection_failed', severity: 'warn',
      detail: connection.last_test_error ? String(connection.last_test_error).slice(0, 120) : 'its last connection test failed' };
  }
  if (coverage === 'unknown') {
    return { ...base, state: 'unknown', severity: 'warn',
      detail: 'could not tell whether anything has ever imported, treated as paused' };
  }
  if (coverage === 'never_imported' && duplicate) {
    return { ...base, state: 'duplicate_elsewhere', severity: 'warn',
      detail: `another company already syncs ${connection?.[feed.identityColumn] || 'this connection'}: which tenant owns it is a decision for a person` };
  }
  if (coverage === 'never_imported') {
    return { ...base, state: 'never_imported', severity: 'action',
      detail: auto.start
        ? 'connected, never imported: queueing its first import'
        : 'connected, never imported: nothing has ever come from this connection' };
  }
  if (coverage === 'enabled_but_empty') {
    return { ...base, state: 'enabled_but_empty', severity: 'action',
      detail: 'sync is on and nothing has ever arrived: the sync is failing, not the enrolment' };
  }
  if (coverage === 'synced_but_empty') {
    return { ...base, state: 'synced_but_empty', severity: 'action',
      detail: `it last synced ${String(stampIso).slice(0, 10)} and has produced nothing: a first import is not the fix` };
  }
  if (fresh.state === 'never_synced') {
    return { ...base, state: 'never_synced', severity: 'action',
      detail: 'it holds data but has never recorded a sync of its own' };
  }
  if (fresh.state === 'stale') {
    return { ...base, state: 'stale', severity: 'action',
      detail: `last sync ${fresh.measured} (${fresh.lag}d ago, tolerance ${feed.maxLagDays}d)` };
  }
  return { ...base, state: 'ok', severity: 'ok',
    detail: fresh.lag === null ? 'producing' : `last sync ${fresh.measured} (${fresh.lag}d)` };
}

/** The column a probe orders by to find the newest row, or null for a feed
 *  that has no ordering (Redo asks only whether anything ever arrived). */
export function probeColumn(feed) {
  return feed?.dayColumn || feed?.timestampColumn || null;
}

/**
 * What one probe of a feed's table means.
 *
 * Split out of the query so the fail-safe can be tested rather than trusted:
 * an error answers NEITHER question and must return null, which coverageState
 * reads as "could not tell" and treats as paused. A probe that fails can
 * never be the reason something gets started.
 */
export function interpretProbe({ feed, connection, row, error }) {
  if (!feed?.table) return { everProduced: true, newestIso: null };
  if (error) return { everProduced: null, newestIso: null, note: error.message || String(error) };
  const order = probeColumn(feed);
  if (!row) {
    // An event-driven connection that has taken a webhook has produced
    // something even when no row survived the filter.
    if (feed.activityColumn && connection?.[feed.activityColumn]) {
      return { everProduced: true, newestIso: null };
    }
    return { everProduced: false, newestIso: null };
  }
  return { everProduced: true, newestIso: order ? String(row[order]).slice(0, 10) : null };
}

/**
 * May this pass queue a FIRST import, given what the bootstrap queue already
 * holds for this connection?
 *
 * Every refusal lives here rather than in the IO, so the one rule that keeps
 * this pass from re-importing a client's store can be executed in a test:
 *
 *   - A queue we could not READ is a queue we must not write. The likeliest
 *     read error is the migration not being applied, and inserting blind
 *     would lose the guard below entirely.
 *   - Any prior job at all -- running, done, partial, failed, cancelled --
 *     means this is not a first import. Re-queueing a failed one every
 *     morning is a paid retry loop against a credential that will never
 *     work; re-queueing a finished one re-imports a store somebody has.
 */
export function planFirstImport({ priorJob = null, priorError = null, dryRun = false } = {}) {
  if (priorError) return { queue: false, reason: `queue unreadable: ${priorError.message || priorError}` };
  if (priorJob) return { queue: false, reason: `a ${priorJob.status} bootstrap job already exists (${priorJob.created_at})` };
  if (dryRun) return { queue: false, reason: 'dry run: would have queued a first import' };
  return { queue: true, reason: 'queued its first import' };
}

/** Exit 1 when something still needs a person: a verdict this pass acted on
 *  by queueing the import is not one of those. */
export function reconcileExitCode(verdicts) {
  return (verdicts || []).some((v) => v.severity === 'action' && !v.autoStart?.start) ? 1 : 0;
}
