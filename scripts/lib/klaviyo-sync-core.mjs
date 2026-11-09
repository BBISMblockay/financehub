// Klaviyo native sync: campaigns and flows (email + SMS) straight from
// Klaviyo's own API into klaviyo_messages / klaviyo_message_performance /
// klaviyo_flow_daily.
//
// Built against Klaviyo's published contract as read on 2026-11-09
// (developers.klaviyo.com). Plan and the open questions it lists:
// /mnt/project-files/specs/klaviyo-native-integration-2026-11-09.md
//
//   GET  https://a.klaviyo.com/api/campaigns      (+ include=campaign-messages)
//   GET  https://a.klaviyo.com/api/flows
//   POST https://a.klaviyo.com/api/campaign-values-reports/
//   POST https://a.klaviyo.com/api/flow-values-reports/
//   POST https://a.klaviyo.com/api/flow-series-reports/
//
// Every request carries a pinned `revision` header and one of:
//   Authorization: Klaviyo-API-Key pk_...     (a private key an admin pasted)
//   Authorization: Bearer <access_token>      (OAuth, refreshed here)
//
// The shapes that drive this file, and why:
//
//  * THERE IS NO CAMPAIGN SERIES ENDPOINT. Campaign numbers are window totals
//    per campaign message, so they land in klaviyo_message_performance with
//    the window's own bounds in the key. Only flows have a daily series.
//  * `POST /api/campaign-values-reports/` is the tightest limit in Klaviyo's
//    API: 1/s, **2 per minute**, 225 per day. So ONE request must cover every
//    campaign (group_by, never a per-campaign loop) and successive calls are
//    spaced by MIN_INTERVAL_MS rather than discovered through 429s.
//  * `conversion_metric_id` is REQUIRED on every report and is per account. It
//    is stamped on every row written: rows measured against different
//    conversion metrics are different measurements.
//  * Reporting windows are capped at ONE YEAR, a custom range's UTC offset is
//    IGNORED in favour of the account's own timezone, and `end` rounds up to
//    the current hour -- hence 23:59:59 and the account timezone on the
//    connection row.
//  * Rates come back as fractions and are NOT stored. Counts only; pool over
//    the window, then divide. NULL is "not reported", never zero.
//
// Order of operations, and why: fetch EVERYTHING for the window first, then
// write messages, then performance, then retire rows this run did not return.
// A failure anywhere in the fetch throws before a single write, so a partial
// fetch can never sweep away rows it simply never reached.

export const KLAVIYO_API_BASE = 'https://a.klaviyo.com/api';
export const KLAVIYO_TOKEN_URL = 'https://a.klaviyo.com/oauth/token';
export const KLAVIYO_JOB_TYPE = 'klaviyo';

// Klaviyo versions by date. A revision is stable for a year, then deprecated
// for a year, then falls forward. ONE constant so a bump is one line; the
// connection test is what proves the pinned value is still accepted.
export const KLAVIYO_REVISION = '2026-10-15';

// Klaviyo refuses a reporting range longer than a year.
export const MAX_RANGE_DAYS = 365;

// Per-endpoint minimum spacing, in ms, derived from Klaviyo's documented
// steady limits rather than from 429s. campaign-values is 2/minute.
export const MIN_INTERVAL_MS = Object.freeze({
  'campaign-values-reports': 30_000,
  'flow-values-reports': 2_000,
  'flow-series-reports': 2_000,
  // GET /api/flows is 3/s, and resolving flow-message names is one request per
  // flow -- an account with fifty flows would otherwise burst straight past it.
  flows: 334,
  // GET /api/campaigns is 10/s; paging a large account hits that unaided.
  campaigns: 100,
});

const PAGE_SIZE_CAMPAIGNS = 100;
const PAGE_SIZE_FLOWS = 50;
const MAX_PAGES = 200;
// Flow-message names need one call per flow. Bounded so a pathological account
// cannot turn a nightly into an hour of metadata requests; names are a nicety,
// and a missing one is recorded as null rather than guessed.
const MAX_FLOW_DETAIL_REQUESTS = 100;
const MAX_RETRIES = 5;
const FALLBACK_TZ = 'America/Los_Angeles';
// Refresh an OAuth token this long before it expires, so a long run does not
// have one die mid-window.
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The statistics asked for on every campaign and flow report.
 *
 * Counts and money only -- no rate. Klaviyo returns rates as fractions and a
 * rate is a count over a count, so storing one would be storing a division we
 * cannot redo after pooling windows. */
export const REPORT_STATISTICS = Object.freeze([
  'recipients',
  'delivered',
  'opens',
  'opens_unique',
  'clicks',
  'clicks_unique',
  'conversions',
  'conversion_uniques',
  'conversion_value',
  'average_order_value',
  'revenue_per_recipient',
  'unsubscribes',
  'unsubscribe_uniques',
  'bounced',
  'bounced_or_failed',
  'failed',
  'spam_complaints',
  'text_message_spend',
  'text_message_credit_usage_amount',
  'message_segment_count_sum',
]);

/** Statistic name -> the column it lands in. A statistic absent from here is
 * kept in `metrics` under Klaviyo's own name, so a new Klaviyo statistic is
 * never silently dropped. */
export const STATISTIC_COLUMNS = Object.freeze({
  recipients: 'recipients',
  delivered: 'delivered',
  opens: 'opens',
  opens_unique: 'opens_unique',
  clicks: 'clicks',
  clicks_unique: 'clicks_unique',
  conversions: 'conversions',
  conversion_uniques: 'conversion_uniques',
  conversion_value: 'conversion_value',
  average_order_value: 'average_order_value',
  revenue_per_recipient: 'revenue_per_recipient',
  unsubscribes: 'unsubscribes',
  unsubscribe_uniques: 'unsubscribe_uniques',
  bounced: 'bounced',
  bounced_or_failed: 'bounced_or_failed',
  failed: 'failed',
  spam_complaints: 'spam_complaints',
  text_message_spend: 'text_message_spend',
  text_message_credit_usage_amount: 'text_message_credit_usage_amount',
  message_segment_count_sum: 'message_segment_count_sum',
});

/** The channels klaviyo_messages.channel accepts, lowercased as Klaviyo's
 * send_channel reports them. A channel outside this set is stored as null on
 * the message rather than rejected: an unknown channel is still a real send,
 * and the CHECK constraint would otherwise fail the whole batch. */
export const KNOWN_CHANNELS = Object.freeze(['email', 'sms', 'push-notification', 'whatsapp']);

export class KlaviyoApiError extends Error {
  constructor(message, { status = null, code = null, detail = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'KlaviyoApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

/** The OAuth grant is gone (Klaviyo answers `400 invalid_grant` once an app is
 * uninstalled or a refresh token has been unused for 90 days). A state to
 * record and stop asking about, never an outage to retry. */
export class KlaviyoReauthRequired extends Error {
  constructor(message) {
    super(message);
    this.name = 'KlaviyoReauthRequired';
  }
}

/** The key or grant is valid but lacks a scope: Klaviyo answers 403. A
 * configuration state for that company, not an outage -- recorded `skipped`.
 * Klaviyo's own docs: 400/401 mean the key is missing or invalid, 403 means it
 * lacks the scope, so the two are distinguishable and are kept apart here. */
export function isScopeError(err) {
  return err instanceof KlaviyoApiError && err.status === 403;
}

/** The credential itself is rejected. Also a configuration state: a pasted key
 * that was revoked or mistyped is not something a retry fixes. */
export function isCredentialError(err) {
  return err instanceof KlaviyoApiError && (err.status === 401 || err.status === 400)
    && err.code === 'authentication_error';
}

// ── dates and windows ──────────────────────────────────────────────────────

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
 * The window to pull: the trailing `daysBack` days ending YESTERDAY in the
 * account's timezone (today is partial and would be restated tomorrow).
 * Explicit start/end win.
 */
export function resolveWindow({ now = new Date(), timeZone, daysBack = 60, startDate = '', endDate = '' }) {
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if ((startDate && !isDay(startDate)) || (endDate && !isDay(endDate))) {
    throw new Error(`start/end must be YYYY-MM-DD (got "${startDate}", "${endDate}")`);
  }
  const end = endDate || addDays(dayInZone(now, timeZone || FALLBACK_TZ), -1);
  const days = Number(daysBack);
  if (!startDate && !(Number.isInteger(days) && days >= 1)) {
    throw new Error(`daysBack must be a positive integer (got "${daysBack}")`);
  }
  const start = startDate || addDays(end, -(days - 1));
  if (Date.parse(`${start}T00:00:00Z`) > Date.parse(`${end}T00:00:00Z`)) {
    throw new Error(`window start ${start} is after end ${end}`);
  }
  return { startDate: start, endDate: end };
}

/** Cut a window into <= MAX_RANGE_DAYS chunks, newest first, so a backfill
 * delivers the days anybody is looking at before the oldest history. */
export function chunkWindow({ startDate, endDate }, maxDays = MAX_RANGE_DAYS) {
  const chunks = [];
  let end = endDate;
  while (Date.parse(`${end}T00:00:00Z`) >= Date.parse(`${startDate}T00:00:00Z`)) {
    const chunkStart = addDays(end, -(maxDays - 1));
    const start = Date.parse(`${chunkStart}T00:00:00Z`) < Date.parse(`${startDate}T00:00:00Z`)
      ? startDate : chunkStart;
    chunks.push({ startDate: start, endDate: end });
    if (start === startDate) break;
    end = addDays(start, -1);
  }
  return chunks;
}

/**
 * The `timeframe` a report is asked for.
 *
 * `end` is 23:59:59 because Klaviyo rounds the end UP to the current hour, so
 * a bare midnight would ask for a day that has not happened. The +00:00 offset
 * is written for readability only: Klaviyo IGNORES a custom range's offset and
 * reads the datetimes in the ACCOUNT's timezone, which is why the window above
 * is computed in that same zone.
 */
export function reportTimeframe({ startDate, endDate }) {
  return { start: `${startDate}T00:00:00+00:00`, end: `${endDate}T23:59:59+00:00` };
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/** The Authorization header for whichever auth mode the connection uses. */
export function authHeader(connection) {
  if (connection?.auth_mode === 'oauth') {
    if (!connection.access_token) throw new KlaviyoApiError('OAuth connection has no access token', { status: 401, code: 'authentication_error' });
    return `Bearer ${connection.access_token}`;
  }
  if (!connection?.api_key) throw new KlaviyoApiError('Connection has no API key', { status: 401, code: 'authentication_error' });
  return `Klaviyo-API-Key ${connection.api_key}`;
}

/** The endpoint key MIN_INTERVAL_MS is looked up by: the first path segment. */
function endpointKey(path) {
  return String(path).replace(/^\/+/, '').split(/[/?]/)[0];
}

/**
 * One Klaviyo request, with Klaviyo's own retry rules.
 *
 * 429 and 503 both carry `Retry-After` in seconds, and Klaviyo is explicit
 * that "immediate retries will always receive a 429", so the header is obeyed
 * rather than guessed at; jitter spreads two companies syncing at once.
 * A 4xx that is not 429 is NOT retried -- a scope or credential problem is a
 * state to record, and retrying it only burns the account's quota.
 */
export async function klaviyoRequest({
  connection, path, method = 'GET', body = null, query = null,
  fetchImpl = fetch, sleep = defaultSleep, log = () => {},
  clock = { last: new Map() }, now = () => Date.now(), random = Math.random,
}) {
  const url = new URL(`${KLAVIYO_API_BASE}/${String(path).replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  // Space calls to an endpoint by its documented steady limit, so the tight
  // ones (campaign-values: 2/minute) are respected by construction.
  const key = endpointKey(path);
  const minGap = MIN_INTERVAL_MS[key];
  if (minGap) {
    const since = now() - (clock.last.get(key) ?? -Infinity);
    if (since < minGap) await sleep(minGap - since);
  }

  for (let attempt = 0; ; attempt += 1) {
    if (minGap) clock.last.set(key, now());
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: authHeader(connection),
        revision: KLAVIYO_REVISION,
        accept: 'application/vnd.api+json',
        ...(body ? { 'content-type': 'application/vnd.api+json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers?.get?.('Retry-After')) || 0;
      if (attempt >= MAX_RETRIES) {
        throw new KlaviyoApiError(`${method} ${path} still ${res.status} after ${MAX_RETRIES} retries`, {
          status: res.status, code: 'rate_limited', retryAfter,
        });
      }
      // Klaviyo: a retry before Retry-After has elapsed always 429s again. The
      // fallback below it is exponential only because a 503 need not carry one.
      const waitMs = retryAfter > 0
        ? (retryAfter * 1000) + Math.floor(random() * 500)
        : Math.min(60_000, 2 ** attempt * 1000) + Math.floor(random() * 500);
      log(`[klaviyo] ${res.status} on ${method} ${path}; waiting ${waitMs}ms (attempt ${attempt + 1})`);
      await sleep(waitMs);
      continue;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }

    if (!res.ok) {
      const first = json?.errors?.[0] || {};
      // Klaviyo's own meaning for these: 400/401 the key is missing or
      // invalid, 403 the key lacks the scope. Kept apart so the caller can
      // record a configuration state instead of failing a run.
      const code = res.status === 403
        ? 'insufficient_scope'
        : (res.status === 401 || res.status === 400) && /api key|authenticat|credential/i.test(`${first.detail || ''}${first.title || ''}`)
          ? 'authentication_error'
          : String(first.code || first.title || `http_${res.status}`);
      throw new KlaviyoApiError(
        `${method} ${path} failed: ${res.status} ${first.detail || first.title || text.slice(0, 300)}`,
        { status: res.status, code, detail: first.detail || null },
      );
    }

    // A rate-limit budget worth seeing in the log before it runs out.
    const remaining = res.headers?.get?.('RateLimit-Remaining');
    if (remaining !== null && remaining !== undefined && Number(remaining) <= 2) {
      log(`[klaviyo] ${key}: RateLimit-Remaining ${remaining}, reset ${res.headers?.get?.('RateLimit-Reset')}`);
    }
    return json;
  }
}

/** Every page of a GET collection, following `links.next` as Klaviyo gives it
 * (a cursor, never an offset). `included` is concatenated across pages. */
export async function fetchAllPages({ connection, path, query = {}, ...rest }) {
  const data = [];
  const included = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await klaviyoRequest({
      connection, path, query: { ...query, ...(cursor ? { 'page[cursor]': cursor } : {}) }, ...rest,
    });
    if (Array.isArray(json?.data)) data.push(...json.data);
    if (Array.isArray(json?.included)) included.push(...json.included);
    const next = json?.links?.next;
    if (!next) return { data, included };
    // links.next is a full URL; the cursor inside it is what the next request
    // needs. If Klaviyo ever stops putting it there, stop rather than loop.
    try {
      cursor = new URL(next).searchParams.get('page[cursor]');
    } catch (_) {
      cursor = null;
    }
    if (!cursor) return { data, included };
  }
  throw new KlaviyoApiError(`${path} did not finish paging within ${MAX_PAGES} pages`, { status: null, code: 'too_many_pages' });
}

// ── OAuth token refresh ────────────────────────────────────────────────────

/**
 * Give back a connection whose access token is good for the next few minutes,
 * refreshing it if not, and persist the new token.
 *
 * Klaviyo's rules this obeys: access tokens last about an hour but
 * `expires_in` is authoritative; a refresh issues a new access token without
 * revoking the old one (so a concurrent run is not broken by this); refresh is
 * capped at 10/minute; and `400 invalid_grant` means the install is GONE --
 * recorded on the row so the nightly stops asking and the UI can say
 * "reconnect", rather than retried into that cap.
 */
export async function ensureAccessToken({
  supabase, connection, clientId, clientSecret,
  fetchImpl = fetch, now = () => new Date(), log = () => {},
}) {
  if (connection.auth_mode !== 'oauth') return connection;
  if (connection.reauth_required_at) {
    throw new KlaviyoReauthRequired('Klaviyo OAuth grant was rejected earlier; reconnect the account');
  }
  const expiresAt = connection.token_expires_at ? Date.parse(connection.token_expires_at) : 0;
  if (connection.access_token && expiresAt - now().getTime() > TOKEN_REFRESH_SKEW_MS) return connection;
  if (!connection.refresh_token) {
    throw new KlaviyoReauthRequired('Klaviyo OAuth connection has no refresh token; reconnect the account');
  }
  if (!clientId || !clientSecret) {
    throw new Error('KLAVIYO_CLIENT_ID / KLAVIYO_CLIENT_SECRET are not configured, so an OAuth connection cannot be refreshed');
  }

  const res = await fetchImpl(KLAVIYO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.refresh_token }).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave null */ }

  if (!res.ok) {
    if (res.status === 400 && json?.error === 'invalid_grant') {
      await supabase.from('klaviyo_connections')
        .update({ reauth_required_at: now().toISOString(), last_test_success: false, last_test_error: 'Klaviyo rejected the refresh token (invalid_grant) — reconnect the account', updated_at: now().toISOString() })
        .eq('id', connection.id);
      throw new KlaviyoReauthRequired('Klaviyo rejected the refresh token (invalid_grant); the app has been uninstalled or the token went 90 days unused');
    }
    throw new KlaviyoApiError(`Klaviyo token refresh failed: ${res.status} ${text.slice(0, 300)}`, { status: res.status, code: 'token_refresh_failed' });
  }
  if (!json?.access_token) {
    throw new KlaviyoApiError('Klaviyo token refresh returned no access_token', { status: res.status, code: 'token_refresh_failed' });
  }

  const expiresIn = Number(json.expires_in);
  const newExpiry = new Date(now().getTime() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000));
  const patch = {
    access_token: json.access_token,
    // Klaviyo may rotate the refresh token; keep the old one when it does not.
    refresh_token: json.refresh_token || connection.refresh_token,
    token_expires_at: newExpiry.toISOString(),
    oauth_scope: json.scope || connection.oauth_scope || null,
    reauth_required_at: null,
    updated_at: now().toISOString(),
  };
  const { error } = await supabase.from('klaviyo_connections').update(patch).eq('id', connection.id);
  if (error) throw new Error(`klaviyo_connections token update failed: ${error.message}`);
  log('[klaviyo] refreshed the OAuth access token');
  return { ...connection, ...patch };
}

// ── metadata: campaigns, their messages, and flows ────────────────────────

function lowerChannel(value) {
  const c = String(value || '').toLowerCase().trim();
  return KNOWN_CHANNELS.includes(c) ? c : null;
}

/**
 * Every campaign and its messages.
 *
 * Klaviyo's campaign filters are documented for name, archived, created_at and
 * updated_at; whether a filter on `messages.channel` is REQUIRED is the one
 * thing the docs did not settle, and a required filter would make an
 * unfiltered call 400. So the unfiltered call is tried once and, if Klaviyo
 * refuses it with a 400, the same read is done per channel instead. Either way
 * the caller gets one list; the fallback costs one extra request, and only on
 * an account where it was needed.
 *
 * Archived campaigns are NOT filtered out, for Redo's reason: an old campaign
 * keeps attributing conversions inside a window, so dropping it would make the
 * window's totals disagree with Klaviyo's own.
 */
export async function fetchCampaignMessages({ connection, log = () => {}, ...rest }) {
  const query = {
    include: 'campaign-messages',
    'page[size]': PAGE_SIZE_CAMPAIGNS,
  };
  try {
    return await fetchAllPages({ connection, path: 'campaigns', query, log, ...rest });
  } catch (err) {
    if (!(err instanceof KlaviyoApiError) || err.status !== 400) throw err;
    log(`[klaviyo] campaigns refused an unfiltered read (${err.message}); asking per channel`);
    const data = [];
    const included = [];
    for (const channel of ['email', 'sms']) {
      const page = await fetchAllPages({
        connection, path: 'campaigns', log, ...rest,
        query: { ...query, filter: `equals(messages.channel,'${channel}')` },
      });
      data.push(...page.data);
      included.push(...page.included);
    }
    return { data, included };
  }
}

/** The campaign messages as klaviyo_messages rows, keyed by Klaviyo's message
 * id. A campaign may hold several messages (an A/B test), which is why the
 * message is the row and the campaign is its parent. */
export function campaignMessageRows({ campaigns = [], included = [], companyEntityId, connectionId, syncedAt, syncBatchId }) {
  const campaignById = new Map(campaigns.map((c) => [String(c.id), c]));
  // Which campaign each message belongs to, from the campaign's own
  // relationships: the included message does not name its campaign.
  const campaignForMessage = new Map();
  for (const c of campaigns) {
    const rel = c?.relationships?.['campaign-messages']?.data;
    for (const m of Array.isArray(rel) ? rel : []) {
      if (m?.id) campaignForMessage.set(String(m.id), String(c.id));
    }
  }
  const rows = [];
  for (const item of included) {
    if (item?.type !== 'campaign-message') continue;
    const def = item?.attributes?.definition || {};
    const campaignId = campaignForMessage.get(String(item.id)) || null;
    const campaign = campaignId ? campaignById.get(campaignId) : null;
    const cdef = campaign?.attributes?.definition || {};
    rows.push({
      company_entity_id: companyEntityId,
      connection_id: connectionId,
      kind: 'campaign',
      klaviyo_id: String(item.id),
      parent_id: campaignId,
      parent_name: cdef.name ?? null,
      name: def.name ?? cdef.name ?? null,
      subject: def?.content?.subject ?? null,
      channel: lowerChannel(def.channel ?? def?.content?.channel ?? cdef.channel),
      status: def.status ?? cdef.status ?? null,
      send_time: def?.send_options?.send_time ?? campaign?.attributes?.send_time ?? null,
      trigger_type: null,
      archived: typeof cdef.archived === 'boolean' ? cdef.archived : null,
      created_at_remote: campaign?.attributes?.created_at ?? null,
      updated_at_remote: campaign?.attributes?.updated_at ?? null,
      tags: [],
      attributes: { definition: def, campaign: cdef },
      synced_at: syncedAt,
      sync_batch_id: syncBatchId,
    });
  }
  return rows;
}

/** Every flow, by id. Flows are 50 to a page and 3 requests a second. */
export async function fetchFlows({ connection, ...rest }) {
  const { data } = await fetchAllPages({
    connection, path: 'flows', query: { 'page[size]': PAGE_SIZE_FLOWS }, ...rest,
  });
  return data;
}

/**
 * Flow-message names, for the flows that actually appeared in the report.
 *
 * Klaviyo's path for a flow's messages is the one endpoint the docs did not
 * settle, so this is best-effort BY DESIGN: the first refusal ends the attempt
 * for the whole run and every name stays null. A null name is honest; an
 * invented one would not be, and no number depends on it.
 */
export async function fetchFlowMessageNames({ connection, flowIds = [], log = () => {}, ...rest }) {
  const names = new Map();
  let asked = 0;
  for (const flowId of flowIds) {
    if (asked >= MAX_FLOW_DETAIL_REQUESTS) {
      log(`[klaviyo] stopped asking for flow message names after ${MAX_FLOW_DETAIL_REQUESTS} flows`);
      break;
    }
    asked += 1;
    let json;
    try {
      json = await klaviyoRequest({
        connection, path: `flows/${encodeURIComponent(flowId)}/flow-actions`,
        query: { include: 'flow-messages' }, log, ...rest,
      });
    } catch (err) {
      log(`[klaviyo] flow message names unavailable (${err?.message || err}); names will be null`);
      return names;
    }
    for (const item of Array.isArray(json?.included) ? json.included : []) {
      if (item?.type !== 'flow-message') continue;
      names.set(String(item.id), item?.attributes?.name ?? item?.attributes?.definition?.name ?? null);
    }
  }
  return names;
}

// ── reports ────────────────────────────────────────────────────────────────

/** A values or series report body. `group_by` always carries the ids Klaviyo
 * requires when grouping at all, plus send_channel so email and SMS are never
 * added together by accident. */
export function reportBody({ type, statistics, timeframe, conversionMetricId, groupBy, interval = null }) {
  return {
    data: {
      type,
      attributes: {
        statistics,
        timeframe,
        conversion_metric_id: conversionMetricId,
        group_by: groupBy,
        ...(interval ? { interval } : {}),
      },
    },
  };
}

/**
 * The rows of a report, whichever of Klaviyo's two spellings the response uses.
 *
 * Deliberately tolerant: the reporting responses are the part of the contract
 * read from docs rather than measured, so both `results`/`groupings`/
 * `statistics` and `data`/`dimensions`/`measurements` are accepted. A response
 * matching NEITHER throws rather than returning nothing, because "no rows" and
 * "a shape this code cannot read" must not look the same in sync_jobs.
 */
export function reportRows(json) {
  const attrs = json?.data?.attributes || {};
  const raw = Array.isArray(attrs.results) ? attrs.results
    : Array.isArray(attrs.data) ? attrs.data
      : null;
  if (!raw) {
    throw new KlaviyoApiError('Klaviyo report response had neither results nor data', { status: null, code: 'unreadable_report' });
  }
  const dateTimes = Array.isArray(attrs.date_times) ? attrs.date_times : null;
  const rows = raw.map((r) => ({
    groupings: r?.groupings || r?.dimensions || {},
    statistics: r?.statistics || r?.measurements || {},
  }));
  return { rows, dateTimes };
}

/** Split a report row's statistics into typed columns and the `metrics`
 * remainder. `undefined` is dropped; an explicit null is KEPT, because
 * "Klaviyo reported nothing here" is a fact and is not zero. */
export function splitStatistics(statistics, pick = (v) => v) {
  const columns = {};
  const metrics = {};
  for (const [name, value] of Object.entries(statistics || {})) {
    const picked = pick(value);
    if (picked === undefined) continue;
    const column = STATISTIC_COLUMNS[name];
    if (column) columns[column] = picked;
    else metrics[name] = picked;
  }
  return { columns, metrics };
}

function groupingValue(groupings, ...names) {
  for (const n of names) {
    const v = groupings?.[n];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return null;
}

/** Campaign window totals -> klaviyo_message_performance rows. */
export async function fetchCampaignValues({
  connection, timeframe, conversionMetricId, companyEntityId, connectionId, syncedAt, syncBatchId, ...rest
}) {
  const json = await klaviyoRequest({
    connection, path: 'campaign-values-reports/', method: 'POST', ...rest,
    body: reportBody({
      type: 'campaign-values-report',
      statistics: REPORT_STATISTICS,
      timeframe,
      conversionMetricId,
      groupBy: ['campaign_id', 'campaign_message_id', 'send_channel'],
    }),
  });
  const { rows } = reportRows(json);
  const out = [];
  for (const row of rows) {
    const messageId = groupingValue(row.groupings, 'campaign_message_id');
    if (!messageId) continue;
    const { columns, metrics } = splitStatistics(row.statistics);
    out.push({
      company_entity_id: companyEntityId,
      connection_id: connectionId,
      kind: 'campaign',
      klaviyo_id: messageId,
      channel: groupingValue(row.groupings, 'send_channel') || '',
      timeframe_start: timeframe.start,
      timeframe_end: timeframe.end,
      conversion_metric_id: conversionMetricId,
      ...columns,
      metrics,
      source: 'klaviyo',
      synced_at: syncedAt,
      sync_batch_id: syncBatchId,
    });
  }
  return out;
}

/** Flow window totals -> klaviyo_message_performance rows, so a flow's window
 * figure never has to be re-derived by summing its days. */
export async function fetchFlowValues({
  connection, timeframe, conversionMetricId, companyEntityId, connectionId, syncedAt, syncBatchId, ...rest
}) {
  const json = await klaviyoRequest({
    connection, path: 'flow-values-reports/', method: 'POST', ...rest,
    body: reportBody({
      type: 'flow-values-report',
      statistics: REPORT_STATISTICS,
      timeframe,
      conversionMetricId,
      groupBy: ['flow_id', 'flow_message_id', 'send_channel'],
    }),
  });
  const { rows } = reportRows(json);
  const out = [];
  const flowForMessage = new Map();
  for (const row of rows) {
    const messageId = groupingValue(row.groupings, 'flow_message_id');
    if (!messageId) continue;
    const flowId = groupingValue(row.groupings, 'flow_id');
    if (flowId) flowForMessage.set(messageId, flowId);
    const { columns, metrics } = splitStatistics(row.statistics);
    out.push({
      company_entity_id: companyEntityId,
      connection_id: connectionId,
      kind: 'flow_message',
      klaviyo_id: messageId,
      channel: groupingValue(row.groupings, 'send_channel') || '',
      timeframe_start: timeframe.start,
      timeframe_end: timeframe.end,
      conversion_metric_id: conversionMetricId,
      ...columns,
      metrics,
      source: 'klaviyo',
      synced_at: syncedAt,
      sync_batch_id: syncBatchId,
    });
  }
  return { rows: out, flowForMessage };
}

/**
 * The flow series at interval `daily` -> klaviyo_flow_daily rows.
 *
 * Each statistic comes back as an ARRAY over `date_times`, so a statistic
 * whose array is shorter than the dates is read as "not reported" for the days
 * it does not cover -- never as zero, and never shifted onto the wrong day.
 */
export async function fetchFlowSeries({
  connection, timeframe, conversionMetricId, companyEntityId, connectionId, syncedAt, syncBatchId, ...rest
}) {
  const json = await klaviyoRequest({
    connection, path: 'flow-series-reports/', method: 'POST', ...rest,
    body: reportBody({
      type: 'flow-series-report',
      statistics: REPORT_STATISTICS,
      timeframe,
      conversionMetricId,
      groupBy: ['flow_id', 'flow_message_id', 'send_channel'],
      interval: 'daily',
    }),
  });
  const { rows, dateTimes } = reportRows(json);
  if (!dateTimes) {
    throw new KlaviyoApiError('Klaviyo flow series response carried no date_times', { status: null, code: 'unreadable_report' });
  }
  const days = dateTimes.map((d) => String(d).slice(0, 10));
  const out = [];
  const flowForMessage = new Map();
  for (const row of rows) {
    const messageId = groupingValue(row.groupings, 'flow_message_id');
    if (!messageId) continue;
    const flowId = groupingValue(row.groupings, 'flow_id');
    if (flowId) flowForMessage.set(messageId, flowId);
    const channel = groupingValue(row.groupings, 'send_channel') || '';
    days.forEach((day, i) => {
      const { columns, metrics } = splitStatistics(row.statistics, (v) => (Array.isArray(v) ? v[i] : undefined));
      // A day for which this message reported no statistic at all is a day
      // Klaviyo did not cover; writing a row of nulls would claim it did.
      if (!Object.keys(columns).length && !Object.keys(metrics).length) return;
      out.push({
        company_entity_id: companyEntityId,
        connection_id: connectionId,
        klaviyo_id: messageId,
        channel,
        day_date: day,
        conversion_metric_id: conversionMetricId,
        ...columns,
        metrics,
        source: 'klaviyo',
        synced_at: syncedAt,
        sync_batch_id: syncBatchId,
      });
    });
  }
  return { rows: out, flowForMessage, days };
}

/** Flow messages as klaviyo_messages rows, built from what the reports named
 * plus whatever flow metadata was readable. */
export function flowMessageRows({
  flowForMessage, flows = [], messageNames = new Map(), companyEntityId, connectionId, syncedAt, syncBatchId,
}) {
  const flowById = new Map(flows.map((f) => [String(f.id), f]));
  const rows = [];
  for (const [messageId, flowId] of flowForMessage.entries()) {
    const flow = flowId ? flowById.get(String(flowId)) : null;
    const attrs = flow?.attributes || {};
    rows.push({
      company_entity_id: companyEntityId,
      connection_id: connectionId,
      kind: 'flow_message',
      klaviyo_id: String(messageId),
      parent_id: flowId ? String(flowId) : null,
      parent_name: attrs.name ?? null,
      name: messageNames.get(String(messageId)) ?? null,
      subject: null,
      channel: null,
      status: attrs.status ?? null,
      send_time: null,
      trigger_type: attrs.trigger_type ?? null,
      archived: typeof attrs.archived === 'boolean' ? attrs.archived : null,
      created_at_remote: attrs.created ?? null,
      updated_at_remote: attrs.updated ?? null,
      tags: [],
      attributes: flow ? { flow: attrs } : {},
      synced_at: syncedAt,
      sync_batch_id: syncBatchId,
    });
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
 * One window (<= MAX_RANGE_DAYS) for one connection, fetched then written.
 *
 * Nothing is written until every fetch has succeeded, so a failure halfway
 * leaves the previous run's rows exactly as they were. `dryRun` stops before
 * the first write and returns the counts it would have written, which is what
 * makes a first run against a live account safe to look at.
 */
export async function syncKlaviyoWindow({
  supabase, connection, companyEntityId, connectionId = null,
  startDate, endDate, syncedAt, syncBatchId = null, dryRun = false,
  fetchImpl = fetch, sleep = defaultSleep, log = () => {}, clock = { last: new Map() },
}) {
  if (daysBetweenInclusive(startDate, endDate) > MAX_RANGE_DAYS) {
    throw new Error(`window ${startDate}..${endDate} exceeds Klaviyo's ${MAX_RANGE_DAYS}-day reporting limit; chunk it`);
  }
  const conversionMetricId = connection.conversion_metric_id;
  if (!conversionMetricId) {
    throw new Error('klaviyo_connections.conversion_metric_id is not set; every Klaviyo report requires it');
  }
  const timeframe = reportTimeframe({ startDate, endDate });
  const http = { fetchImpl, sleep, log, clock };
  const stamp = { companyEntityId, connectionId, syncedAt, syncBatchId };

  // ── 1. fetch everything ──────────────────────────────────────────────────
  const campaignPage = await fetchCampaignMessages({ connection, ...http });
  const flows = await fetchFlows({ connection, ...http });
  const campaignPerf = await fetchCampaignValues({
    connection, timeframe, conversionMetricId, ...stamp, ...http,
  });
  const flowValues = await fetchFlowValues({
    connection, timeframe, conversionMetricId, ...stamp, ...http,
  });
  const flowSeries = await fetchFlowSeries({
    connection, timeframe, conversionMetricId, ...stamp, ...http,
  });

  // Every flow message either report named, with its flow.
  const flowForMessage = new Map([...flowValues.flowForMessage, ...flowSeries.flowForMessage]);
  const flowIds = [...new Set([...flowForMessage.values()].filter(Boolean))];
  const messageNames = await fetchFlowMessageNames({ connection, flowIds, ...http });

  const messageRows = [
    ...campaignMessageRows({ campaigns: campaignPage.data, included: campaignPage.included, ...stamp }),
    ...flowMessageRows({ flowForMessage, flows, messageNames, ...stamp }),
  ];
  const performanceRows = [...campaignPerf, ...flowValues.rows];
  const dailyRows = flowSeries.rows;

  const counts = {
    window: { startDate, endDate },
    campaigns_returned: campaignPage.data.length,
    flows_returned: flows.length,
    messages_upserted: messageRows.length,
    performance_rows_upserted: performanceRows.length,
    flow_daily_rows_upserted: dailyRows.length,
    flow_message_names_resolved: messageNames.size,
  };

  if (dryRun) {
    log(`[klaviyo] DRY RUN ${startDate}..${endDate}: ${JSON.stringify(counts)}`);
    return { ...counts, dry_run: true, stale_performance_removed: 0, stale_flow_daily_removed: 0 };
  }

  // ── 2. write ─────────────────────────────────────────────────────────────
  await upsertChunked(supabase, 'klaviyo_messages', messageRows, 'company_entity_id,kind,klaviyo_id');
  await upsertChunked(supabase, 'klaviyo_message_performance', performanceRows,
    'company_entity_id,kind,klaviyo_id,channel,timeframe_start,timeframe_end');
  await upsertChunked(supabase, 'klaviyo_flow_daily', dailyRows,
    'company_entity_id,klaviyo_id,channel,day_date', 1000);

  // ── 3. retire what this run did not return ───────────────────────────────
  // Only rows older than THIS run's timestamp, so an overlapping newer run's
  // rows are never swept. Performance rows are scoped to this exact timeframe:
  // another window's totals are a different measurement, not a stale one.
  const { data: perfRemoved, error: perfSweepErr } = await supabase
    .from('klaviyo_message_performance')
    .delete()
    .eq('company_entity_id', companyEntityId)
    .eq('timeframe_start', timeframe.start)
    .eq('timeframe_end', timeframe.end)
    .lt('synced_at', syncedAt)
    .select('id');
  if (perfSweepErr) throw new Error(`klaviyo_message_performance sweep failed: ${perfSweepErr.message}`);

  const { data: dailyRemoved, error: dailySweepErr } = await supabase
    .from('klaviyo_flow_daily')
    .delete()
    .eq('company_entity_id', companyEntityId)
    .gte('day_date', startDate)
    .lte('day_date', endDate)
    .lt('synced_at', syncedAt)
    .select('id');
  if (dailySweepErr) throw new Error(`klaviyo_flow_daily sweep failed: ${dailySweepErr.message}`);

  const result = {
    ...counts,
    stale_performance_removed: (perfRemoved || []).length,
    stale_flow_daily_removed: (dailyRemoved || []).length,
  };
  log(`[klaviyo] ${startDate}..${endDate}: ${result.campaigns_returned} campaigns, ${result.flows_returned} flows, `
    + `${result.performance_rows_upserted} performance rows, ${result.flow_daily_rows_upserted} flow-days, `
    + `${result.stale_performance_removed}/${result.stale_flow_daily_removed} stale removed`);
  return result;
}

// ── one connection, end to end ─────────────────────────────────────────────

/** The account's own timezone, which is the one Klaviyo reads a custom
 * reporting range in. Falls back to the company's business timezone, then to
 * the same constant Redo's sync uses -- a window is better computed in a near
 * zone than in none. */
export async function syncTimezone(supabase, connection) {
  if (connection.account_timezone) return connection.account_timezone;
  const { data } = await supabase
    .from('company_settings')
    .select('business_timezone')
    .eq('company_entity_id', connection.company_entity_id);
  return data?.[0]?.business_timezone || FALLBACK_TZ;
}

/**
 * Sync one klaviyo_connections row and record it in sync_jobs. Every outcome
 * is distinguishable from the stored record alone:
 *
 *   not configured    -> no sync_jobs row, { skipped: 'not_configured' }
 *   needs reconnect   -> status 'skipped', error names the grant
 *   missing scope     -> status 'skipped', error names the scope
 *   credential wrong  -> status 'skipped', error names the key
 *   any other error   -> status 'error', and rethrown so the run fails
 *   success           -> status 'success', result carries per-chunk counts
 *
 * Chunks written before a failure stay written and are listed in `result`, so
 * a partial backfill says how far it got.
 */
export async function syncKlaviyoConnection({
  supabase, connection, daysBack = 60, startDate = '', endDate = '', dryRun = false,
  clientId = '', clientSecret = '',
  now = () => new Date(), fetchImpl = fetch, sleep = defaultSleep, log = () => {},
}) {
  const co = connection.company_entity_id;
  const hasCredential = connection.auth_mode === 'oauth'
    ? Boolean(connection.access_token || connection.refresh_token)
    : Boolean(connection.api_key);
  if (!hasCredential) {
    log(`[skip] ${co}: klaviyo_connections has no credential for auth_mode ${connection.auth_mode}`);
    return { company: co, skipped: 'not_configured' };
  }
  if (!connection.conversion_metric_id) {
    log(`[skip] ${co}: klaviyo_connections has no conversion_metric_id; run Test connection in Integrations`);
    return { company: co, skipped: 'no_conversion_metric' };
  }

  const timeZone = await syncTimezone(supabase, connection);
  const window = resolveWindow({ now: now(), timeZone, daysBack, startDate, endDate });

  const { data: job, error: jobErr } = await supabase
    .from('sync_jobs')
    .insert({ company_entity_id: co, job_type: KLAVIYO_JOB_TYPE, status: 'running', started_at: now().toISOString() })
    .select('id')
    .single();
  if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);
  const finish = (patch) => supabase.from('sync_jobs')
    .update({ finished_at: now().toISOString(), ...patch })
    .eq('id', job.id);

  const chunks = [];
  // One clock across every chunk, so the 2-per-minute campaign report is
  // spaced correctly across a multi-chunk backfill and not just within one.
  const clock = { last: new Map() };
  try {
    const live = await ensureAccessToken({ supabase, connection, clientId, clientSecret, fetchImpl, now, log });
    for (const chunk of chunkWindow(window)) {
      chunks.push(await syncKlaviyoWindow({
        supabase, connection: live, companyEntityId: co, connectionId: connection.id,
        ...chunk, syncedAt: now().toISOString(), syncBatchId: job.id,
        dryRun, fetchImpl, sleep, log, clock,
      }));
    }
    const result = { window, time_zone: timeZone, dry_run: dryRun, chunks };
    await finish({ status: 'success', result });
    if (!dryRun) {
      await supabase.from('klaviyo_connections')
        .update({ last_synced_at: now().toISOString(), updated_at: now().toISOString() })
        .eq('id', connection.id);
    }
    return { company: co, ...result };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 2000);
    const partial = { window, time_zone: timeZone, dry_run: dryRun, chunks };
    // Three configuration states, each recorded as `skipped` rather than
    // failing the whole run: one company's bad key is not an outage for the
    // others, and a retry fixes none of them.
    if (err instanceof KlaviyoReauthRequired) {
      await finish({ status: 'skipped', result: partial, error: `Klaviyo connection needs reconnecting: ${message}` });
      log(`[skip] ${co}: ${message}`);
      return { company: co, skipped: 'reauth_required', chunks };
    }
    if (isScopeError(err)) {
      await finish({ status: 'skipped', result: partial, error: `Klaviyo key lacks a scope: ${message}` });
      log(`[skip] ${co}: ${message} -- the key needs campaigns:read, flows:read and metrics:read`);
      return { company: co, skipped: 'insufficient_scope', chunks };
    }
    if (isCredentialError(err)) {
      await finish({ status: 'skipped', result: partial, error: `Klaviyo rejected the credential: ${message}` });
      log(`[skip] ${co}: ${message}`);
      return { company: co, skipped: 'bad_credential', chunks };
    }
    await finish({ status: 'error', result: partial, error: message });
    throw err;
  }
}
