// Redo marketing reporting sync: campaigns and automations (email + SMS)
// into redo_marketing_messages / redo_marketing_daily.
//
// Source: Redo's Reporting API, GraphQL only (the v2.2 REST API the returns
// sync uses has no marketing endpoints):
//
//   POST https://api.getredo.com/v3/account/{storeId}/graphql
//   Authorization: Bearer <redo_connections.api_secret>
//
// Measured against the live API on 2026-09-24 (see the migration
// 20260924120000_redo_marketing_reporting.sql for the full list):
//   * every rate is a count over `delivered`, so only counts are stored;
//   * series[].byChannel summed per day equals Redo's own totals exactly;
//   * paused automations still send, so `enabled` is never filtered on.
//
// Order of operations, and why:
//   1. fetch EVERY page of campaigns and automations for the window;
//   2. only then upsert (messages, then daily rows);
//   3. only then retire daily rows inside the window that this run did not
//      return (a day Redo restated to nothing).
// A failure anywhere in (1) throws before anything is written, so a partial
// fetch can never sweep away rows it simply did not reach. The database
// drops an upsert older than the stored row (redo_marketing_reject_stale_write),
// so an overlapping older run cannot overwrite a newer one's numbers.

export const REDO_GRAPHQL_BASE = 'https://api.getredo.com/v3/account';
export const REDO_MARKETING_JOB_TYPE = 'redo_marketing';
// Redo's default. Stored on every row; changing it would make rows from
// different runs measure different things, so it is a constant, not an input.
export const ATTRIBUTION_WINDOW_DAYS = 5;
// Redo refuses a range over 400 days per request.
export const MAX_RANGE_DAYS = 400;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

export class RedoApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'RedoApiError';
    this.status = status;
    this.code = code;
  }
}

/** The token is valid but lacks a scope: a configuration state, not an outage. */
export function isScopeError(err) {
  return err instanceof RedoApiError && err.code === 'INSUFFICIENT_SCOPE';
}

// ── dates ──────────────────────────────────────────────────────────────────

/** YYYY-MM-DD of `date` as seen in `timeZone`. */
export function dayInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function addDays(isoDay, n) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * The window to pull. Default: the trailing `daysBack` days ending YESTERDAY
 * in the store's timezone (today is partial). Explicit start/end win.
 */
export function resolveWindow({ now = new Date(), timeZone, daysBack = 30, startDate = '', endDate = '' }) {
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if ((startDate && !isDay(startDate)) || (endDate && !isDay(endDate))) {
    throw new Error(`start/end must be YYYY-MM-DD (got "${startDate}", "${endDate}")`);
  }
  const end = endDate || addDays(dayInZone(now, timeZone), -1);
  const days = Number(daysBack);
  if (!startDate && !(Number.isInteger(days) && days >= 1)) {
    throw new Error(`days_back must be a positive integer (got "${daysBack}")`);
  }
  const start = startDate || addDays(end, -(days - 1));
  if (start > end) throw new Error(`window start ${start} is after end ${end}`);
  return { startDate: start, endDate: end };
}

/**
 * Split a window into request-sized chunks, NEWEST FIRST, so a backfill that
 * fails part-way has already kept the most recent (most-read) history.
 */
export function chunkWindow({ startDate, endDate }, maxDays = MAX_RANGE_DAYS) {
  const chunks = [];
  let chunkEnd = endDate;
  while (chunkEnd >= startDate) {
    let chunkStart = addDays(chunkEnd, -(maxDays - 1));
    if (chunkStart < startDate) chunkStart = startDate;
    chunks.push({ startDate: chunkStart, endDate: chunkEnd });
    chunkEnd = addDays(chunkStart, -1);
  }
  return chunks;
}

// ── GraphQL ────────────────────────────────────────────────────────────────

const POINT = `
  recipients sends delivered failures uniqueOpens uniqueClicks unsubscribes
  orders newCustomerOrders returningCustomerOrders
  revenue { amount currency } newCustomerRevenue { amount currency }
  returningCustomerRevenue { amount currency } spend { amount currency }`;

const SERIES = `
  analytics {
    messaging(startDate: $start, endDate: $end, attributionWindowDays: $window) {
      series { date byChannel { channel ${POINT} } }
    }
  }`;

export const CAMPAIGNS_QUERY = `
query SiloRedoCampaigns($start: Date!, $end: Date!, $window: Int!, $first: Int!, $after: String) {
  campaigns(first: $first, after: $after, orderBy: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyId name channel status sentAt scheduledAt tags createdAt updatedAt
      emailVariants { position abTestWeight template { subject previewText } }
      ${SERIES}
    }
  }
}`;

// No send-date filter either (`sentAfter`), and that one was MEASURED, not
// assumed: over 2026-08-24..09-22, campaigns sent as early as 2026-07-14
// still carried 42 attributed orders ($4,309) -- far outside the documented
// 5-day window, presumably because a late click restarts it. Cost is driven
// by the date range, not the page count, so every campaign is fetched.
// No `enabled` argument on purpose: paused automations still attribute
// revenue inside a window (measured).
export const AUTOMATIONS_QUERY = `
query SiloRedoAutomations($start: Date!, $end: Date!, $window: Int!, $first: Int!, $after: String) {
  marketingAutomations(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyId name category enabled description createdAt updatedAt
      ${SERIES}
    }
  }
}`;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function redoGraphql({
  token, storeId, query, variables, fetchImpl = fetch, sleep = defaultSleep, maxThrottleRetries = 5,
}) {
  const url = `${REDO_GRAPHQL_BASE}/${encodeURIComponent(storeId)}/graphql`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }

    if (res.status === 401) {
      throw new RedoApiError('Redo rejected the token (401): wrong token or store id, or the token was revoked', { status: 401 });
    }
    const errors = body?.errors || [];
    const throttled = res.status === 429 || errors.some((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled) {
      if (attempt >= maxThrottleRetries) {
        throw new RedoApiError(`Redo throttled the request ${attempt + 1} times`, { status: res.status, code: 'THROTTLED' });
      }
      // The budget refills continuously (500/s measured); a few seconds is plenty.
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new RedoApiError(`Redo GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
    }
    if (!body) throw new RedoApiError(`Redo returned non-JSON: ${text.slice(0, 200)}`, { status: res.status });
    if (errors.length) {
      const scope = errors.find((e) => e?.extensions?.code === 'INSUFFICIENT_SCOPE');
      const first = scope || errors[0];
      throw new RedoApiError(
        `Redo GraphQL error${first?.extensions?.code ? ` ${first.extensions.code}` : ''}: ${first?.message || 'unknown'}`,
        { status: res.status, code: first?.extensions?.code || null },
      );
    }
    return { data: body.data, cost: body.extensions?.cost?.actualQueryCost ?? null };
  }
}

async function fetchAllNodes({ field, query, variables, ...conn }) {
  const nodes = [];
  let after = null;
  let cost = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, cost: c } = await redoGraphql({ ...conn, query, variables: { ...variables, first: PAGE_SIZE, after } });
    cost += c || 0;
    const connection = data?.[field];
    if (!connection) throw new RedoApiError(`Redo returned no ${field} connection`);
    nodes.push(...(connection.nodes || []));
    if (!connection.pageInfo?.hasNextPage) return { nodes, pages: page, cost };
    after = connection.pageInfo.endCursor;
    if (!after) throw new RedoApiError(`Redo said ${field} has another page but gave no cursor`);
  }
  // Refuse to treat a runaway pager as a complete list: the sweep depends on it.
  throw new RedoApiError(`${field}: more than ${MAX_PAGES} pages; refusing to treat a truncated list as complete`);
}

// ── mapping ────────────────────────────────────────────────────────────────

/** Redo money is an exact decimal string. Keep it a string; Postgres numeric parses it. */
function amount(money) {
  const raw = money?.amount;
  if (raw == null || raw === '') return '0';
  if (!/^-?\d+(\.\d+)?$/.test(String(raw))) throw new RedoApiError(`unparseable Redo amount "${raw}"`);
  return String(raw);
}

export function mapMessageRow({ companyEntityId, connectionId, kind, node, syncedAt }) {
  const variants = Array.isArray(node.emailVariants) ? node.emailVariants : [];
  const firstVariant = [...variants].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
  return {
    company_entity_id: companyEntityId,
    connection_id: connectionId ?? null,
    kind,
    redo_id: node.id,
    legacy_id: node.legacyId ?? null,
    name: node.name,
    channel: kind === 'campaign' ? (node.channel ?? null) : null,
    status: node.status ?? null,
    sent_at: node.sentAt ?? null,
    scheduled_at: node.scheduledAt ?? null,
    tags: node.tags ?? [],
    subject: firstVariant?.template?.subject ?? null,
    preview_text: firstVariant?.template?.previewText ?? null,
    email_variants: variants,
    category: kind === 'automation' ? (node.category ?? null) : null,
    enabled: kind === 'automation' ? (node.enabled ?? null) : null,
    description: node.description ?? null,
    redo_created_at: node.createdAt ?? null,
    redo_updated_at: node.updatedAt ?? null,
    synced_at: syncedAt,
    updated_at: syncedAt,
  };
}

export function mapDailyRows({ companyEntityId, connectionId, kind, node, syncedAt, attributionWindowDays = ATTRIBUTION_WINDOW_DAYS }) {
  const rows = [];
  for (const point of node.analytics?.messaging?.series || []) {
    for (const ch of point.byChannel || []) {
      rows.push({
        company_entity_id: companyEntityId,
        connection_id: connectionId ?? null,
        kind,
        redo_id: node.id,
        channel: ch.channel,
        day_date: point.date,
        recipients: ch.recipients ?? 0,
        sends: ch.sends ?? 0,
        delivered: ch.delivered ?? 0,
        failures: ch.failures ?? 0,
        unique_opens: ch.uniqueOpens ?? 0,
        unique_clicks: ch.uniqueClicks ?? 0,
        unsubscribes: ch.unsubscribes ?? 0,
        orders: ch.orders ?? 0,
        new_customer_orders: ch.newCustomerOrders ?? 0,
        returning_customer_orders: ch.returningCustomerOrders ?? 0,
        revenue: amount(ch.revenue),
        new_customer_revenue: amount(ch.newCustomerRevenue),
        returning_customer_revenue: amount(ch.returningCustomerRevenue),
        revenue_currency: ch.revenue?.currency ?? null,
        spend: amount(ch.spend),
        spend_currency: ch.spend?.currency || 'USD',
        attribution_window_days: attributionWindowDays,
        synced_at: syncedAt,
      });
    }
  }
  return rows;
}

// ── writes ─────────────────────────────────────────────────────────────────

async function upsertChunked(supabase, table, rows, onConflict, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

/**
 * Pull one window (<= MAX_RANGE_DAYS) for one company and write it.
 * Returns counts for the sync_jobs record.
 */
export async function syncRedoMarketingWindow({
  supabase, companyEntityId, connectionId = null, token, storeId,
  startDate, endDate, syncedAt, fetchImpl = fetch, sleep = defaultSleep, log = () => {},
}) {
  if (daysBetweenInclusive(startDate, endDate) > MAX_RANGE_DAYS) {
    throw new Error(`window ${startDate}..${endDate} exceeds Redo's ${MAX_RANGE_DAYS}-day limit; chunk it`);
  }
  const conn = { token, storeId, fetchImpl, sleep };
  const variables = { start: startDate, end: endDate, window: ATTRIBUTION_WINDOW_DAYS };

  // 1. Fetch everything. Nothing is written until both lists are complete.
  const campaigns = await fetchAllNodes({
    ...conn, field: 'campaigns', query: CAMPAIGNS_QUERY, variables,
  });
  const automations = await fetchAllNodes({
    ...conn, field: 'marketingAutomations', query: AUTOMATIONS_QUERY, variables,
  });

  const messageRows = [];
  const dailyRows = [];
  for (const [kind, list] of [['campaign', campaigns.nodes], ['automation', automations.nodes]]) {
    for (const node of list) {
      messageRows.push(mapMessageRow({ companyEntityId, connectionId, kind, node, syncedAt }));
      dailyRows.push(...mapDailyRows({ companyEntityId, connectionId, kind, node, syncedAt })
        // Redo's series is bounded by the window already; this is a guard,
        // since the sweep below trusts that every row is inside it.
        .filter((r) => r.day_date >= startDate && r.day_date <= endDate));
    }
  }

  // 2. Write.
  await upsertChunked(supabase, 'redo_marketing_messages', messageRows, 'company_entity_id,kind,redo_id');
  await upsertChunked(supabase, 'redo_marketing_daily', dailyRows, 'company_entity_id,kind,redo_id,channel,day_date', 1000);

  // 3. Retire rows inside this window that this run did not return. Only
  // rows OLDER than this run: a newer overlapping run's rows are untouched.
  const { data: removed, error: sweepErr } = await supabase
    .from('redo_marketing_daily')
    .delete()
    .eq('company_entity_id', companyEntityId)
    .gte('day_date', startDate)
    .lte('day_date', endDate)
    .lt('synced_at', syncedAt)
    .select();
  if (sweepErr) throw new Error(`redo_marketing_daily sweep failed: ${sweepErr.message}`);

  const result = {
    window: { startDate, endDate },
    campaigns_returned: campaigns.nodes.length,
    automations_returned: automations.nodes.length,
    daily_rows_upserted: dailyRows.length,
    stale_rows_removed: (removed || []).length,
    api_cost: campaigns.cost + automations.cost,
  };
  log(`[redo-marketing] ${startDate}..${endDate}: ${result.campaigns_returned} campaigns, `
    + `${result.automations_returned} automations, ${result.daily_rows_upserted} daily rows, `
    + `${result.stale_rows_removed} stale removed, cost ${result.api_cost}`);
  return result;
}

// ── one connection, end to end ─────────────────────────────────────────────

const FALLBACK_TZ = 'America/Los_Angeles';

async function businessTimezone(supabase, companyEntityId) {
  const { data } = await supabase
    .from('company_settings')
    .select('business_timezone')
    .eq('company_entity_id', companyEntityId);
  return data?.[0]?.business_timezone || FALLBACK_TZ;
}

/**
 * Sync one redo_connections row and record it in sync_jobs. Every outcome is
 * distinguishable from the stored record alone:
 *   not configured  -> no sync_jobs row, returns { skipped: 'not_configured' }
 *   missing scope   -> status 'skipped', error names the scope problem
 *   any other error -> status 'error' (and rethrown, so the run fails)
 *   success         -> status 'success', result carries per-chunk counts
 * Chunks already written before a failure stay written and are listed in
 * `result`, so a partial backfill says how far it got.
 */
export async function syncRedoMarketingConnection({
  supabase, connection, daysBack = 60, startDate = '', endDate = '',
  now = () => new Date(), fetchImpl = fetch, sleep = defaultSleep, log = () => {},
}) {
  const co = connection.company_entity_id;
  const storeId = connection.meta?.redo_store_id;
  if (!connection.api_secret || !storeId) {
    log(`[skip] ${co}: redo_connections has no api_secret or meta.redo_store_id`);
    return { company: co, skipped: 'not_configured' };
  }

  const timeZone = await businessTimezone(supabase, co);
  const window = resolveWindow({ now: now(), timeZone, daysBack, startDate, endDate });

  const { data: job, error: jobErr } = await supabase
    .from('sync_jobs')
    .insert({ company_entity_id: co, job_type: REDO_MARKETING_JOB_TYPE, status: 'running', started_at: now().toISOString() })
    .select('id')
    .single();
  if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);
  const finish = (patch) => supabase.from('sync_jobs')
    .update({ finished_at: now().toISOString(), ...patch })
    .eq('id', job.id);

  const chunks = [];
  try {
    for (const chunk of chunkWindow(window)) {
      // One timestamp per chunk: the sweep retires rows older than it.
      chunks.push(await syncRedoMarketingWindow({
        supabase, companyEntityId: co, connectionId: connection.id,
        token: connection.api_secret, storeId, ...chunk,
        syncedAt: now().toISOString(), fetchImpl, sleep, log,
      }));
    }
    const result = { window, time_zone: timeZone, chunks };
    await finish({ status: 'success', result });
    return { company: co, ...result };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 2000);
    const partial = { window, time_zone: timeZone, chunks };
    if (isScopeError(err)) {
      await finish({ status: 'skipped', result: partial, error: `Redo token lacks a marketing scope: ${message}` });
      log(`[skip] ${co}: ${message} -- give the Redo token READ on Campaigns, Marketing automations and both analytics scopes`);
      return { company: co, skipped: 'insufficient_scope', chunks };
    }
    await finish({ status: 'error', result: partial, error: message });
    throw err;
  }
}
