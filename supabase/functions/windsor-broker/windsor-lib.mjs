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

/** A connector for the data endpoint. `all` multiplexes every source on the
 *  team, which is exactly the read this broker must never make on a
 *  company's behalf, so it is refused by name. */
export function parseConnector(raw) {
  const r = parseSource(raw);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, reason: 'connector required' };
  if (r.value === 'all') return { ok: false, reason: 'the all connector reads every client at once and is not allowed' };
  return r;
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
  const rejected = { token_mismatch: 0, token_missing: 0, malformed: 0 };
  const seen = new Set();
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object') { rejected.malformed += 1; continue; }
    const ds = String(r.datasource ?? r.ds_id ?? r.data_source ?? '').trim().toLowerCase();
    const acct = r.account_id === undefined || r.account_id === null ? '' : String(r.account_id).trim();
    if (!ID_RE.test(ds) || !acct || acct.length > 256) { rejected.malformed += 1; continue; }
    const rowToken = typeof r.access_token === 'string' ? r.access_token : null;
    if (!rowToken) { rejected.token_missing += 1; continue; }
    if (rowToken !== token) { rejected.token_mismatch += 1; continue; }
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
const normAccount = (v) => String(v ?? '').trim().replace(/^act_/, '');

/** Keep only rows for the one account the caller's company owns. A row with
 *  no account_id cannot be attributed and is dropped, not passed through:
 *  `select_accounts` is meant to restrict the read, but the boundary must not
 *  rest on a vendor parameter alone. */
export function filterRowsToAccount(rows, accountId) {
  const want = normAccount(accountId);
  const kept = [];
  let foreign = 0;
  let unattributed = 0;
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object' || r.account_id === undefined || r.account_id === null || r.account_id === '') {
      unattributed += 1; continue;
    }
    if (normAccount(r.account_id) !== want) { foreign += 1; continue; }
    kept.push(r);
  }
  return { kept, foreign, unattributed };
}
