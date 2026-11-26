// Reads QuickBooks' general ledger back into SILO, one company-month per call.
//
// Two callers, and neither names a company, a connection or a month:
//   * the scheduler, identified by its GitHub OIDC token (x-silo-scheduler-token).
//     The database decides what is due (quickbooks_ledger_mirror_due).
//   * a signed-in finance user pressing "Mirror now" (Authorization: Bearer,
//     body {"since": "<when they pressed>"}). The FIRST thing done with that
//     token is a database call made AS the caller
//     (quickbooks_ledger_mirror_my_due), which decides who may ask and hands
//     back a month of their own active company; if it errors, nothing else
//     happens. The service role is used only after that, for the same read and
//     store the scheduler performs, because the mirror has no client write.
// What is acceptable is the database's call either way
// (quickbooks_ledger_mirror_store keeps the last good copy of a month whenever
// it refuses a report).
//
// READ ONLY toward QuickBooks: two GETs (the account list and the
// GeneralLedger report). The only QuickBooks-side effect is the OAuth token
// refresh every QuickBooks function performs. Nothing is posted, edited or
// voided; quickbooks-post-journal stays the only write path.
//
// A response carries counts and codes only -- never a company, an account
// name, an amount or a QuickBooks error body.
const CORS = { 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// How far back a month is kept in step. Older months stay as imported history.
export const MONTHS_BACK = 12;
const ACCOUNT_PAGE = 1000;
const MAX_ACCOUNT_PAGES = 20;
const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const apiBase = environment => (environment === 'production'
  ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');

class ReadError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

// The same refresh the other QuickBooks functions perform: Intuit rotates the
// refresh token on every use, so the new one is stored before anything else.
async function accessToken({ db, conn, env, fetchImpl, now }) {
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  if (conn.access_token && expiresAt - now() > 60_000) return conn.access_token;
  const id = env('QBO_CLIENT_ID'), secret = env('QBO_CLIENT_SECRET');
  if (!id || !secret) throw new ReadError('not_configured');
  if (!conn.refresh_token) throw new ReadError('reconnect_required');
  if (conn.refresh_token_expires_at && Date.parse(conn.refresh_token_expires_at) < now()) throw new ReadError('reconnect_required');
  const res = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }).toString() });
  if (!res.ok) {
    // invalid_grant is Intuit saying the refresh token is dead: only the
    // company can fix that, by connecting QuickBooks again.
    const text = await res.text().catch(() => '');
    throw new ReadError(/invalid_grant/i.test(text) ? 'reconnect_required' : 'token_refresh_failed');
  }
  const tok = await res.json().catch(() => null);
  if (!tok?.access_token) throw new ReadError('token_refresh_failed');
  const at = now();
  const { error } = await db.from('quickbooks_connections').update({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? conn.refresh_token,
    token_expires_at: new Date(at + Number(tok.expires_in ?? 3600) * 1000).toISOString(),
    refresh_token_expires_at: new Date(at + Number(tok.x_refresh_token_expires_in ?? 8726400) * 1000).toISOString(),
    updated_at: new Date(at).toISOString(),
  }).eq('id', conn.id);
  // A rotated token that was not stored strands the connection, so say so.
  if (error) throw new ReadError('token_persist_failed');
  return tok.access_token;
}

async function quickbooksGet(fetchImpl, url, token) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch { throw new ReadError('quickbooks_unreachable'); }
  if (res.status === 401 || res.status === 403) throw new ReadError('reconnect_required');
  if (res.status === 429) throw new ReadError('quickbooks_busy');
  if (!res.ok) throw new ReadError('quickbooks_read_failed');
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new ReadError('quickbooks_read_failed');
  return body;
}

// {"<account id>": "<AccountType>"} for every account, active or not: an old
// month still carries accounts that were made inactive since.
async function accountTypes(fetchImpl, base, realm, token) {
  const types = {};
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
    const query = `select Id, AccountType from Account where Active in (true, false) startposition ${page * ACCOUNT_PAGE + 1} maxresults ${ACCOUNT_PAGE}`;
    const body = await quickbooksGet(fetchImpl,
      `${base}/v3/company/${encodeURIComponent(realm)}/query?query=${encodeURIComponent(query)}&minorversion=75`, token);
    const rows = body?.QueryResponse?.Account;
    if (rows != null && !Array.isArray(rows)) throw new ReadError('quickbooks_read_failed');
    for (const row of rows || []) {
      if (typeof row?.Id === 'string' && typeof row?.AccountType === 'string') types[row.Id] = row.AccountType;
    }
    if (!rows || rows.length < ACCOUNT_PAGE) return types;
  }
  throw new ReadError('quickbooks_read_failed');
}

export function createLedgerMirrorHandler({ env, verifyIdentity, createDb, createUserDb, fetchImpl, now = Date.now }) {
  return async req => {
    // A person's browser calls this cross-origin; the scheduler never sends
    // an Origin, and the headers are harmless to it.
    const reply = (body, status = 200) => Response.json(body, { status, headers: CORS });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return reply({ error_code: 'method_not_allowed' }, 405);
    const token = req.headers.get('x-silo-scheduler-token') || '';
    const bearer = token ? '' : (/^Bearer ([\w.-]{20,8192})$/.exec(req.headers.get('authorization') || '') || [])[1] || '';
    // The scheduler header decides the path: a request carrying it is judged
    // as the scheduler and nothing else.
    if (!bearer) {
      try {
        if (!token || token.length > 16384) throw new Error();
        await verifyIdentity(token, new URL('/functions/v1/quickbooks-ledger-mirror-scheduled', env('SUPABASE_URL')).href);
      } catch { return reply({ error_code: 'scheduler_identity_rejected' }, 401); }
    }
    // The one switch: set it to stop the reader without a deploy.
    if (env('QBO_LEDGER_MIRROR_DISABLED') === 'true') return reply({ error_code: 'ledger_mirror_disabled' }, 403);
    const raw = await req.text();
    if (raw.length > 64) return reply({ error_code: 'invalid_request' }, 400);
    let input;
    try { input = raw ? JSON.parse(raw) : {}; } catch { return reply({ error_code: 'invalid_request' }, 400); }
    if (!input || Array.isArray(input) || typeof input !== 'object') return reply({ error_code: 'invalid_request' }, 400);
    const keys = Object.keys(input);
    if (bearer ? (keys.length !== 1 || keys[0] !== 'since' || typeof input.since !== 'string' || !SINCE.test(input.since))
               : keys.length) {
      return reply({ error_code: 'invalid_request' }, 400);
    }

    let db, work, remaining = null;
    if (bearer) {
      // As the caller, before anything else: the database refuses a caller who
      // is not a finance user of an active company (and Supabase refuses a
      // token it does not accept), and any refusal ends the request here.
      try {
        if (typeof createUserDb !== 'function') throw new Error();
        const { data, error } = await createUserDb(bearer).rpc('quickbooks_ledger_mirror_my_due',
          { p_since: input.since, p_months_back: MONTHS_BACK });
        if (error || !Array.isArray(data)) throw new Error();
        work = data[0] || null;
      } catch { return reply({ error_code: 'not_allowed' }, 403); }
      if (!work) return reply({ done: true });
      remaining = Number.isInteger(work.remaining) && work.remaining > 0 ? work.remaining - 1 : 0;
      try { db = createDb(); } catch { return reply({ error_code: 'work_discovery_failed' }, 503); }
    } else {
      try {
        db = createDb();
        const { data, error } = await db.rpc('quickbooks_ledger_mirror_due', { p_months_back: MONTHS_BACK, p_limit: 1 });
        if (error || !Array.isArray(data)) throw new Error();
        work = data[0] || null;
      } catch { return reply({ error_code: 'work_discovery_failed' }, 503); }
      if (!work) return reply({ done: true });
    }
    // What a person's run adds to an answer: how many months are still to go.
    const more = remaining === null ? {} : { remaining };
    if (!uuid(work.company_entity_id) || !uuid(work.qbo_connection_id) || !day(work.period_start) ||
        !day(work.read_through) || typeof work.accounting_basis !== 'string') {
      return reply({ error_code: 'work_discovery_failed' }, 503);
    }

    // Whatever goes wrong before the store, the month must be marked, or the
    // database would hand the same month back on the next call for ever.
    const fail = async code => {
      try {
        const { error } = await db.rpc('quickbooks_ledger_mirror_failed', {
          p_company: work.company_entity_id, p_connection: work.qbo_connection_id,
          p_period_start: work.period_start, p_error: code });
        if (error) throw new Error();
      } catch { return reply({ error_code: 'failure_not_recorded' }, 503); }
      return reply({ done: false, ok: false, changed: false, lines: 0, error_code: code, ...more });
    };

    let report, types;
    try {
      const { data: conn, error } = await db.from('quickbooks_connections')
        .select('id, company_entity_id, realm_id, environment, access_token, refresh_token, token_expires_at, refresh_token_expires_at, is_active')
        .eq('id', work.qbo_connection_id).eq('company_entity_id', work.company_entity_id).maybeSingle();
      if (error) throw new ReadError('connection_unreadable');
      if (!conn || conn.is_active === false || !conn.realm_id) throw new ReadError('reconnect_required');
      const configured = env('QBO_ENVIRONMENT') === 'production' ? 'production' : 'sandbox';
      if (conn.environment !== configured) throw new ReadError('environment_mismatch');
      const access = await accessToken({ db, conn, env, fetchImpl, now });
      const base = apiBase(conn.environment);
      types = await accountTypes(fetchImpl, base, conn.realm_id, access);
      const qs = new URLSearchParams({ start_date: work.period_start, end_date: work.read_through,
        accounting_method: work.accounting_basis, minorversion: '75' });
      report = await quickbooksGet(fetchImpl,
        `${base}/v3/company/${encodeURIComponent(conn.realm_id)}/reports/GeneralLedger?${qs}`, access);
    } catch (e) {
      return fail(e instanceof ReadError ? e.code : 'quickbooks_read_failed');
    }

    try {
      const { data, error } = await db.rpc('quickbooks_ledger_mirror_store', {
        p_company: work.company_entity_id, p_connection: work.qbo_connection_id,
        p_period_start: work.period_start, p_read_through: work.read_through,
        p_report: report, p_account_types: types });
      if (error || !data || typeof data !== 'object') throw new Error();
      const lines = Number.isInteger(data.lines) && data.lines >= 0 ? data.lines : 0;
      // A refusal is already on the month's row, with its reason; only the
      // fact of it leaves here.
      if (data.ok !== true) return reply({ done: false, ok: false, changed: false, lines: 0, error_code: 'report_refused', ...more });
      return reply({ done: false, ok: true, changed: data.changed === true, lines, ...more });
    } catch {
      return fail('store_failed');
    }
  };
}
