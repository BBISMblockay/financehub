// Pure helpers for windsor-broker. No network, no database: everything here
// can be executed by node, and scripts/tests/windsor-broker.test.mjs does.
//
// The tenant boundary for Windsor data is the mapping from a Windsor account
// to a SILO company. SILO holds ONE Windsor owner key, so anything that reads
// with it can see every client's accounts; which company a row belongs to is
// decided here, and only ever from the authorization link SILO itself minted
// for that company -- never from a field in Windsor's payload alone.

export const WINDSOR_ONBOARD = 'https://onboard.windsor.ai';
export const WINDSOR_CONNECTORS = 'https://connectors.windsor.ai';

// Windsor data source ids are lowercase snake_case (`facebook_ads`,
// `klaviyo`, `tiktok`). Anything else is refused before it is put in a URL.
const ID_RE = /^[a-z0-9_]{1,64}$/;
const FIELD_RE = /^[a-z0-9_.]{1,64}$/i;

export const DATE_PRESETS = ['last_7d', 'last_14d', 'last_30d'];
export const MAX_FIELDS = 30;
export const PREVIEW_MAX_ROWS = 200;
export const MAX_LINKS_PER_RECONCILE = 25;

/** A data source id, or null for "any source". Throws nothing: returns
 *  { ok, value } so the handler can answer 400 with a reason. */
export function parseSource(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const s = String(raw).trim().toLowerCase();
  if (!ID_RE.test(s)) return { ok: false, reason: 'source must be a Windsor data source id, e.g. klaviyo' };
  return { ok: true, value: s };
}

// Windsor data source id -> connectors.windsor.ai endpoint name, where the two
// differ. Server-owned on purpose: the endpoint a preview reads must be
// derived from the account's STORED source, never chosen by the caller.
// Empty until the live trial shows a source whose endpoint name differs.
export const CONNECTOR_FOR_SOURCE = Object.freeze({});

// Extra `options` a connector needs for a preview to match Windsor's own
// screen. TikTok sends no daily rows for days its ads did not deliver unless
// inactive campaigns are included (seen live 2026-11-02; Windsor's UI adds it).
const PREVIEW_OPTIONS = Object.freeze({ tiktok: { include_inactive: 'true' } });

/** The `options` query value for a connector's preview, or null. */
export function previewOptions(connector) {
  const o = PREVIEW_OPTIONS[connector];
  return o ? JSON.stringify({ [connector]: o }) : null;
}

/** The data endpoint for a stored data source id. `all` multiplexes every
 *  source on the team, so it is refused even if it were ever stored. */
export function connectorForSource(dsId) {
  const r = parseSource(dsId);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, reason: 'connector required' };
  const c = CONNECTOR_FOR_SOURCE[r.value] ?? r.value;
  if (c === 'all') return { ok: false, reason: 'the all connector reads every client at once and is not allowed' };
  return { ok: true, value: c };
}

/** Comma-separated field list -> array. account_id is always requested,
 *  because a returned row is kept only when its account_id is the one the
 *  caller's company owns (filterRowsToAccount). */
export function parseFields(raw) {
  const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'fields required' };
  if (parts.length > MAX_FIELDS) return { ok: false, reason: `at most ${MAX_FIELDS} fields` };
  for (const p of parts) if (!FIELD_RE.test(p)) return { ok: false, reason: `not a field name: ${p.slice(0, 64)}` };
  const out = [...new Set(['account_id', ...parts])];
  if (out.length > MAX_FIELDS) return { ok: false, reason: `at most ${MAX_FIELDS} fields including account identity` };
  return { ok: true, value: out };
}

export function parseDatePreset(raw) {
  const p = raw ? String(raw) : 'last_7d';
  return DATE_PRESETS.includes(p) ? { ok: true, value: p } : { ok: false, reason: 'unsupported date range' };
}

/** Build a Windsor URL. The api_key travels in the query string because
 *  Windsor accepts it nowhere else (X-Api-Key and Bearer both answer "Not
 *  authorized"), so a URL built here is a secret: never log it, never return
 *  it, and pass anything Windsor says back through redact() first. */
export function windsorUrl(base, path, params) {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Strip the owner key (and any api_key= value) out of text going back to a
 *  browser, and keep it short. */
export function redact(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('***');
  s = s.replace(/(api_key=)[^&\s"']+/gi, '$1***');
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Windsor answers JSON for most endpoints, but generate-co-user-url's shape
 *  is undocumented: accept JSON or a bare URL. */
export function parseBody(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}

/** Describe a body's SHAPE (keys, query parameter names) without its
 *  values, so an unexpected response can be shown to an admin without
 *  handing them a live link token or anything else Windsor put in it. */
export function describeShape(body) {
  if (body === null || body === undefined) return 'empty';
  if (typeof body === 'string') {
    try {
      const u = new URL(body);
      return `url ${u.origin}${u.pathname} params [${[...u.searchParams.keys()].join(', ')}]`;
    } catch { return `text (${body.length} chars)`; }
  }
  if (Array.isArray(body)) return `array (${body.length})`;
  if (typeof body === 'object') {
    const keys = Object.keys(body);
    const nested = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? ` data{${Object.keys(body.data).join(', ')}}` : '';
    return `object {${keys.join(', ')}}${nested}`;
  }
  return typeof body;
}

const TOKEN_PARAMS = ['access_token', 'token', 'co_user_token'];
const URL_KEYS = ['url', 'link', 'co_user_url', 'authorization_url', 'auth_url'];

/** Pull { url, token } out of generate-co-user-url's answer. The token is
 *  what every later step keys on, so if it cannot be found the link is NOT
 *  recorded and NOT handed out: a client who connected through it would land
 *  on SILO's Windsor team with nothing tying them to a company. */
export function extractLink(body) {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const inner = obj?.data && typeof obj.data === 'object' && !Array.isArray(obj.data) ? obj.data : null;
  const pick = (o, keys) => {
    if (!o) return null;
    for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k];
    return null;
  };
  const url = typeof body === 'string' ? body : (pick(obj, URL_KEYS) ?? pick(inner, URL_KEYS));
  let token = pick(obj, TOKEN_PARAMS) ?? pick(inner, TOKEN_PARAMS);
  let parsed = null;
  if (url) { try { parsed = new URL(url); } catch { parsed = null; } }
  if (!parsed || parsed.protocol !== 'https:') return { ok: false };
  if (!token) for (const p of TOKEN_PARAMS) { const v = parsed.searchParams.get(p); if (v) { token = v; break; } }
  if (!token || token.length < 8 || token.length > 512) return { ok: false };
  return { ok: true, url: parsed.toString(), token };
}

/** The list a Windsor endpoint returned, or null when it is not a list. */
export function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const k of ['data', 'results', 'accounts', 'linked_accounts']) if (Array.isArray(body[k])) return body[k];
  }
  return null;
}

/** What co-user-linked-accounts actually returns (seen live 2026-11-02): one
 *  entry per link, `{ link: { access_token, issued_at, expires_at, revoked_at },
 *  accounts: [{ datasource, account_id, account_name, is_deactivated, ... }] }`.
 *  Each account takes its token from its own group's `link`, never from the
 *  request. A flat row (the shape the docs describe) passes through as is. */
export function flattenLinkedAccounts(rows) {
  const out = [];
  for (const r of rows ?? []) {
    if (r && typeof r === 'object' && !Array.isArray(r) && r.link && typeof r.link === 'object' && Array.isArray(r.accounts)) {
      const groupToken = typeof r.link.access_token === 'string' ? r.link.access_token : null;
      for (const a of r.accounts) {
        out.push(a && typeof a === 'object' && !Array.isArray(a) ? { ...a, access_token: groupToken } : a);
      }
    } else out.push(r);
  }
  return out;
}

/** Sort co-user-linked-accounts rows, fetched for ONE link token, into the
 *  ones SILO may attribute to that link's company and the ones it may not.
 *
 *  A row is accepted only when it carries the SAME access_token the request
 *  filtered on. Windsor documents the filter; this does not rely on it. If
 *  the filter were ignored, every client on the team would come back here,
 *  and trusting the request rather than the row would file all of them under
 *  whichever company asked. A row with no token at all (Windsor shows
 *  `co_user_member_name` for links not minted through the API) is likewise
 *  unattributable and is reported, not guessed. */
export function partitionLinkedAccounts(rows, token) {
  const accepted = [];
  const rejected = { token_mismatch: 0, token_missing: 0, malformed: 0, deactivated: 0 };
  const seen = new Set();
  for (const r of flattenLinkedAccounts(rows)) {
    if (!r || typeof r !== 'object') { rejected.malformed += 1; continue; }
    const ds = String(r.datasource ?? r.ds_id ?? r.data_source ?? '').trim().toLowerCase();
    const acct = r.account_id === undefined || r.account_id === null ? '' : String(r.account_id).trim();
    if (!ID_RE.test(ds) || !acct || acct.length > 256) { rejected.malformed += 1; continue; }
    const rowToken = typeof r.access_token === 'string' ? r.access_token : null;
    if (!rowToken) { rejected.token_missing += 1; continue; }
    if (rowToken !== token) { rejected.token_mismatch += 1; continue; }
    // Re-authorizing through a newer link leaves the account under the old
    // link marked deactivated; the live copy arrives under the new link.
    if (r.is_deactivated === true) { rejected.deactivated += 1; continue; }
    const key = `${ds}\u0000${acct}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof r.account_name === 'string' ? r.account_name.slice(0, 256) : null;
    accepted.push({ ds_id: ds, account_id: acct, account_name: name });
  }
  return { accepted, rejected };
}

/** Decide what to write for accepted accounts given what is already mapped.
 *  `existing` is every stored row for those (ds_id, account_id) pairs, in ANY
 *  company. An account already mapped to another company is a conflict and is
 *  left exactly as it is: the first company to connect it keeps it until it is
 *  unlinked. */
export function planUpserts(accepted, existing, companyId) {
  const byKey = new Map(existing.map((e) => [`${e.ds_id}\u0000${e.account_id}`, e]));
  const inserts = [];
  const touches = [];
  const conflicts = [];
  for (const a of accepted) {
    const e = byKey.get(`${a.ds_id}\u0000${a.account_id}`);
    if (!e) inserts.push(a);
    else if (e.company_entity_id === companyId) touches.push({ id: e.id, account_name: a.account_name });
    else conflicts.push({ ds_id: a.ds_id, account_id: a.account_id });
  }
  return { inserts, touches, conflicts };
}

/** Facebook ids come back with and without `act_`; Windsor documents both as
 *  the same account. Nothing else is normalised. */
const normAccount = (v, source) => source === 'facebook'
  ? String(v ?? '').trim().replace(/^act_/, '') : String(v ?? '').trim();

/** Keep only rows for the one account the caller's company owns. A row with
 *  no account_id cannot be attributed and is dropped, not passed through:
 *  `select_accounts` is meant to restrict the read, but the boundary must not
 *  rest on a vendor parameter alone. */
export function filterRowsToAccount(rows, accountId, source) {
  const want = normAccount(accountId, source);
  const kept = [];
  let foreign = 0;
  let unattributed = 0;
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object' || r.account_id === undefined || r.account_id === null || r.account_id === '') {
      unattributed += 1; continue;
    }
    if (normAccount(r.account_id, source) !== want) { foreign += 1; continue; }
    kept.push(r);
  }
  return { kept, foreign, unattributed };
}

// ── Mapping a connector's fields onto SILO's measures ───────────────────────
// Shared by the nightly sync (scripts/lib/windsor-sync-core.mjs) and the
// broker's field_catalog action, so the page shows exactly the choice the
// sync will make.

// Connectors with a hand-made dataset in the sync. Their fields are fixed in
// code; a company's mapping does not apply to them.
export const FIXED_SOURCES = Object.freeze(['tiktok', 'klaviyo']);

// SILO syncs these directly. Through Windsor they would be a second copy under
// a different identity and be counted twice in marketing_kpis_daily, so they
// go to windsor_metrics_daily instead.
export const DIRECT_SYNC_SOURCES = Object.freeze(['facebook', 'google_ads', 'googleanalytics4', 'ga4']);

// Where Windsor's connector id is not the platform name SILO shows.
const AD_PLATFORM_NAMES = Object.freeze({ bing: 'microsoft_ads', tiktok: 'tiktok_ads' });
const PLATFORM_RE = /^[a-z][a-z0-9_]{1,63}$/;

// SILO's common measures and the Windsor field ids that mean them, best
// first. The first one a connector has is used, unless the company chose
// another (windsor_field_mappings).
export const STANDARD_FIELDS = Object.freeze({
  impressions: ['impressions'],
  clicks: ['clicks', 'link_clicks'],
  spend: ['spend', 'cost', 'amount_spent'],
  // Names seen in Windsor's live field lists (2026-11-03): Pinterest
  // total_conversions / total_conversions_value, Snapchat conversion_purchases
  // / conversion_purchases_value, LinkedIn conversionvalueinlocalcurrency.
  conversions: ['conversions', 'purchases', 'total_purchases', 'website_purchases', 'checkout_conversions',
    'total_conversions', 'conversion_purchases'],
  revenue: ['revenue', 'conversion_value', 'purchase_value', 'total_purchase_value', 'conversions_value',
    'total_conversion_value', 'total_conversions_value', 'conversion_purchases_value', 'conversionvalueinlocalcurrency',
    'total_sales', 'sales'],
  sends: ['sent_emails', 'emails_sent', 'sends', 'recipients'],
  delivered: ['received_emails', 'delivered', 'emails_delivered'],
  opens: ['opens', 'emails_opened', 'unique_opens'],
  sessions: ['sessions'],
  users: ['users', 'active_users', 'total_users'],
  orders: ['orders', 'total_orders', 'orders_count', 'order_count'],
});
// The measures marketing_kpis_daily has columns for.
export const AD_MEASURES = Object.freeze(['impressions', 'clicks', 'spend', 'conversions', 'revenue']);
export const NUMERIC_TYPES = Object.freeze(['NUMERIC', 'PERCENT']);

export function isAdLike(dsId, ids) {
  return !DIRECT_SYNC_SOURCES.includes(dsId)
    && ids.has('spend') && ids.has('impressions') && ids.has('clicks')
    && (ids.has('campaign_id') || ids.has('campaign'));
}

export function adPlatformName(dsId) {
  const name = AD_PLATFORM_NAMES[dsId] ?? (String(dsId).endsWith('_ads') ? dsId : `${dsId}_ads`);
  return PLATFORM_RE.test(name) ? name : null;
}

/** Which field fills each measure for this connector.
 *  `catalog` is Windsor's field list ([{ id, type }]); `overrides` is the
 *  company's choices ({ measure: field_id | null }, null = leave blank). An
 *  override naming a field the connector does not list as numeric is not
 *  used, and is reported in `ignored`. */
export function chooseMeasures(dsId, catalog, overrides = {}) {
  const ids = new Set((catalog || []).map((f) => f.id));
  const numeric = new Set((catalog || []).filter((f) => NUMERIC_TYPES.includes(String(f.type || '').toUpperCase())).map((f) => f.id));
  const kind = FIXED_SOURCES.includes(dsId) ? 'fixed' : isAdLike(dsId, ids) ? 'ad' : 'metrics';
  const measures = kind === 'ad' ? AD_MEASURES : Object.keys(STANDARD_FIELDS);
  const auto = {};
  const chosen = {};
  const ignored = [];
  for (const m of measures) {
    auto[m] = STANDARD_FIELDS[m].find((c) => ids.has(c)) ?? null;
    chosen[m] = auto[m];
    if (kind === 'fixed' || !Object.prototype.hasOwnProperty.call(overrides, m)) continue;
    const o = overrides[m];
    if (o === null) chosen[m] = null;
    else if (numeric.has(o)) chosen[m] = o;
    else ignored.push(m);
  }
  return { kind, measures, auto, chosen, ignored };
}


/** Where this source's rows would be stored, and whether they can be stored at
 *  all. ONE source of truth: the sync's `autoDataset` builds from it, the
 *  broker decides whether sync may be switched on from it, and the connections
 *  page shows what it says, so the page can never offer a toggle the sync
 *  would refuse, nor hide one it would accept.
 *
 *  A row needs a day and an account to be placed, so a field list without
 *  `date` and `account_id` cannot be stored however many measures it carries.
 *  An ad-like source also needs a name that is a valid platform. A connector
 *  SILO already syncs natively is never ad-like (`isAdLike`), so it goes to
 *  windsor_metrics_daily and can never double-count against that sync. */
export function syncPlacement(dsId, catalog, overrides = {}) {
  const ids = new Set((catalog || []).map((f) => f.id));
  if (FIXED_SOURCES.includes(dsId)) {
    return { ok: true, kind: 'fixed', table: null, reason: 'its own SILO table (fields fixed by SILO)' };
  }
  if (!ids.has('date') || !ids.has('account_id')) {
    return { ok: false, kind: null, table: null,
      reason: 'Windsor lists no date and account for this source, so a row cannot be placed' };
  }
  if (isAdLike(dsId, ids)) {
    const platform = adPlatformName(dsId);
    if (!platform) {
      return { ok: false, kind: 'ad', table: null,
        reason: "this source's name cannot be used as a SILO platform" };
    }
    // marketing_kpis_daily's conversions and conversion_value are NOT NULL, so
    // a source that cannot report them would be written as ZERO, and the
    // marketing pages sum those columns across every paid platform to get CPA
    // and ROAS: a platform with spend and a fabricated zero drags both towards
    // nothing, and nobody reading the page can tell. A marker in `extra` does
    // not help, because those reads do not select it. So a source that cannot
    // fill them does not belong in that table; it goes to
    // windsor_metrics_daily, where a measure the source does not report is
    // NULL and means exactly that. (#1148 review cycle 1 P2.)
    const { chosen } = chooseMeasures(dsId, catalog, overrides);
    const missing = ['conversions', 'revenue'].filter((m) => !chosen[m]);
    if (missing.length) {
      return { ok: true, kind: 'metrics', table: 'windsor_metrics_daily', unmeasured: missing,
        reason: `windsor_metrics_daily (no ${missing.join(' or ')} field, which marketing_kpis_daily cannot record as unmeasured)` };
    }
    return { ok: true, kind: 'ad', table: 'marketing_kpis_daily', platform,
      reason: `marketing_kpis_daily as ${platform}` };
  }
  return { ok: true, kind: 'metrics', table: 'windsor_metrics_daily', reason: 'windsor_metrics_daily' };
}

export const IDENTITY_ERROR = 'The source returned rows whose account identity could not be verified. No data from this response was used. Verify the selector-to-resource relationship before retrying.';

/** Validate EVERY response, including metric batches, before merging or writing.
 * A selector is not evidence of ownership of a differently identified resource.
 * Do not include returned IDs or values in this error (they may be another tenant's).
 */
export function assertAccountRows(rows, accountId, source) {
  const { foreign, unattributed } = filterRowsToAccount(rows, accountId, source);
  if (foreign || unattributed) throw Object.assign(new Error(IDENTITY_ERROR), { code: 'identity_unverified' });
}

export function readableName(id) {
  return String(id).replace(/[_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function normalizeFields(list) {
  const seen = new Set();
  return list.filter((f) => {
    if (!f || typeof f.id !== 'string' || !FIELD_RE.test(f.id) || seen.has(f.id)) return false;
    seen.add(f.id); return true;
  }).map((f) => ({ id: f.id, name: typeof f.name === 'string' && f.name.trim() ? f.name.slice(0, 120) : readableName(f.id),
    type: String(f.type || '').toUpperCase(), table: typeof f.table === 'string' ? f.table.slice(0, 80) : null }));
}

/** Conservative preview: identity/date plus a few measures from one report table.
 * Never add all dimensions: they change a source's row grain.
 */
export function previewDefaults(catalog) {
  const ids = new Set(catalog.map((f) => f.id));
  if (!ids.has('account_id')) return [];
  const numeric = catalog.filter((f) => NUMERIC_TYPES.includes(f.type));
  const table = numeric[0]?.table;
  return ['account_id', ...['date', 'account_name'].filter((id) => ids.has(id)),
    ...numeric.filter((f) => f.table === table).slice(0, 5).map((f) => f.id)]
    .filter((id, i, all) => all.indexOf(id) === i);
}

const SOURCE_NAMES = { youtube: 'YouTube', tiktok: 'TikTok', googleanalytics4: 'Google Analytics 4',
  google_ads: 'Google Ads', facebook: 'Meta Ads', bing: 'Microsoft Ads', linkedin: 'LinkedIn',
  klaviyo: 'Klaviyo', shopify: 'Shopify', hubspot: 'HubSpot' };

export function normalizeConnectors(list) {
  const seen = new Set();
  return list.flatMap((item) => {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !ID_RE.test(id) || id === 'all' || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: SOURCE_NAMES[id] || (typeof item?.name === 'string' ? item.name.slice(0, 120) : readableName(id)) }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
