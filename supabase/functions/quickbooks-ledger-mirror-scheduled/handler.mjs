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
// After a month's ledger lines are stored, the same call reads QuickBooks' own
// summary of that month (ProfitAndLoss for the month, TrialBalance at its end
// and at the day before it starts) and stores one row per account: what moved
// in the month and where it stood. That is the second, independent reading the
// account-by-account check compares SILO's books with
// (quickbooks_balance_check_v). A report that cannot be fetched or understood
// stores no balances and the reason, never a guess: the month then reads "not
// checked". It never undoes the ledger read.
//
// READ ONLY toward QuickBooks: five GETs (the account list and the
// GeneralLedger, ProfitAndLoss and two TrialBalance reports). The only QuickBooks-side effect is the OAuth token
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

// types: {"<account id>": "<AccountType>"} for every account, active or not: an
// old month still carries accounts that were made inactive since. computed: the
// ids of accounts QuickBooks works out itself (retained earnings), whose
// movement no report states.
async function accountTypes(fetchImpl, base, realm, token) {
  const types = {}, computed = new Set();
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
    const query = `select Id, AccountType, AccountSubType from Account where Active in (true, false) startposition ${page * ACCOUNT_PAGE + 1} maxresults ${ACCOUNT_PAGE}`;
    const body = await quickbooksGet(fetchImpl,
      `${base}/v3/company/${encodeURIComponent(realm)}/query?query=${encodeURIComponent(query)}&minorversion=75`, token);
    const rows = body?.QueryResponse?.Account;
    if (rows != null && !Array.isArray(rows)) throw new ReadError('quickbooks_read_failed');
    for (const row of rows || []) {
      if (typeof row?.Id === 'string' && typeof row?.AccountType === 'string') {
        types[row.Id] = row.AccountType;
        if (row.AccountSubType === 'RetainedEarnings') computed.add(row.Id);
      }
    }
    if (!rows || rows.length < ACCOUNT_PAGE) return { types, computed };
  }
  throw new ReadError('quickbooks_read_failed');
}

// ── QuickBooks' own balances, one row per account ───────────────────────────
// Money is carried in whole cents, so nothing here depends on how a fraction
// happens to round.
const unreadable = () => new ReadError('balances_unreadable');
function cents(value) {
  if (value === '' || value == null) return 0;
  if (typeof value !== 'string' || !/^-?\d{1,15}(\.\d{1,2})?$/.test(value)) throw unreadable();
  const [whole, part = ''] = value.replace('-', '').split('.');
  const n = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  return value.startsWith('-') ? -n : n;
}
const columns = report => (Array.isArray(report?.Columns?.Column) ? report.Columns.Column.length : -1);
const rowsOf = node => {
  const rows = node?.Rows?.Row;
  if (rows == null) return [];
  if (!Array.isArray(rows)) throw unreadable();
  return rows;
};

// A ProfitAndLoss report for one period (one money column) ->
// { accounts: Map id -> { name, amount }, net }: each account's amount as the
// report prints it (income and expense both positive), and the report's own
// net income. An account can be a plain row or the header of a group of
// sub-accounts; a row that carries money but no account is not understood.
export function parseProfitAndLoss(report) {
  if (columns(report) !== 2) throw unreadable();
  const accounts = new Map();
  let net = null;
  const take = (cols, heading) => {
    if (!Array.isArray(cols)) throw unreadable();
    const id = cols[0]?.id, amount = cents(cols[1]?.value);
    if (typeof id !== 'string' || !id) { if (amount !== 0) throw unreadable(); return; }
    // A group's heading names its parent account; it counts only when it
    // carries the parent's own amount.
    if (heading && amount === 0) return;
    if (accounts.has(id)) throw unreadable();
    accounts.set(id, { name: String(cols[0]?.value ?? ''), amount });
  };
  const walk = (rows, depth) => {
    if (depth > 12) throw unreadable();
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw unreadable();
      if (row.Header?.ColData?.[0]?.id) take(row.Header.ColData, true);
      if (row.ColData) take(row.ColData);
      if (row.group === 'NetIncome') {
        if (net !== null) throw unreadable();
        net = cents(row.Summary?.ColData?.[1]?.value);
      }
      walk(rowsOf(row), depth + 1);
    }
  };
  const top = rowsOf(report);
  walk(top, 0);
  // A period with nothing in it has no rows and no net income line.
  if (net === null) { if (top.length) throw unreadable(); net = 0; }
  return { accounts, net };
}

// A TrialBalance report at one date (Debit and Credit columns) ->
// Map id -> { name, balance }, balance = debit - credit. The report's own
// grand total must equal the rows and must balance.
export function parseTrialBalance(report) {
  if (columns(report) !== 3) throw unreadable();
  const accounts = new Map();
  let debit = 0, credit = 0, total = null;
  const top = rowsOf(report);
  for (const row of top) {
    if (!row || typeof row !== 'object') throw unreadable();
    if (row.group === 'GrandTotal') {
      if (total !== null) throw unreadable();
      total = [cents(row.Summary?.ColData?.[1]?.value), cents(row.Summary?.ColData?.[2]?.value)];
      continue;
    }
    const cols = row.ColData;
    if (!Array.isArray(cols) || row.Rows) throw unreadable();
    const id = cols[0]?.id, d = cents(cols[1]?.value), c = cents(cols[2]?.value);
    if (typeof id !== 'string' || !id || accounts.has(id)) throw unreadable();
    debit += d; credit += c;
    accounts.set(id, { name: String(cols[0]?.value ?? ''), balance: d - c });
  }
  if (total === null) { if (top.length) throw unreadable(); return accounts; }
  if (total[0] !== debit || total[1] !== credit || debit !== credit) throw unreadable();
  return accounts;
}

// How a profit-and-loss account's printed amount turns into +debit / -credit.
const PNL_SIGN = { Income: -1, 'Other Income': -1, 'Cost of Goods Sold': 1, Expense: 1, 'Other Expense': 1 };

// The three reports -> [{ id, name, type, activity, ending }], +debit / -credit
// in units of currency. A profit-and-loss account's movement is the
// ProfitAndLoss amount (a TrialBalance states those year to date, so it is not
// used for them); every other account's movement is its TrialBalance balance
// at the end less its balance the day before the month. A computed account
// (retained earnings) gets its ending balance and no movement. An account the
// account list does not know is not understood.
export function accountBalances({ types, computed, profitAndLoss, endBalances, startBalances }) {
  const out = [];
  let moved = 0;
  for (const [id, { name, amount }] of profitAndLoss.accounts) {
    if (amount === 0) continue;
    const type = types[id], sign = PNL_SIGN[type];
    if (!sign) throw unreadable();
    moved += sign * amount;
    out.push({ id, name, type, activity: (sign * amount) / 100, ending: null });
  }
  // The accounts must add up to the report's own bottom line.
  if (moved !== -profitAndLoss.net) throw unreadable();
  for (const id of new Set([...endBalances.keys(), ...startBalances.keys()])) {
    const type = types[id];
    if (typeof type !== 'string' || !type) throw unreadable();
    if (PNL_SIGN[type]) continue;
    const end = endBalances.get(id)?.balance ?? 0, start = startBalances.get(id)?.balance ?? 0;
    const name = (endBalances.get(id) || startBalances.get(id)).name;
    if (computed.has(id)) { out.push({ id, name, type, activity: null, ending: end / 100 }); continue; }
    if (end === 0 && start === 0) continue;
    out.push({ id, name, type, activity: (end - start) / 100, ending: end / 100 });
  }
  if (out.some(row => !row.name)) throw unreadable();
  return out;
}

// 'YYYY-MM-DD' moved by whole days, in calendar terms only.
const shiftDay = (value, days) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

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

    let report, types, computed, access, reportUrl;
    try {
      const { data: conn, error } = await db.from('quickbooks_connections')
        .select('id, company_entity_id, realm_id, environment, access_token, refresh_token, token_expires_at, refresh_token_expires_at, is_active')
        .eq('id', work.qbo_connection_id).eq('company_entity_id', work.company_entity_id).maybeSingle();
      if (error) throw new ReadError('connection_unreadable');
      if (!conn || conn.is_active === false || !conn.realm_id) throw new ReadError('reconnect_required');
      const configured = env('QBO_ENVIRONMENT') === 'production' ? 'production' : 'sandbox';
      if (conn.environment !== configured) throw new ReadError('environment_mismatch');
      access = await accessToken({ db, conn, env, fetchImpl, now });
      const base = apiBase(conn.environment);
      ({ types, computed } = await accountTypes(fetchImpl, base, conn.realm_id, access));
      reportUrl = (name, start, end) => `${base}/v3/company/${encodeURIComponent(conn.realm_id)}/reports/${name}?${
        new URLSearchParams({ start_date: start, end_date: end, accounting_method: work.accounting_basis, minorversion: '75' })}`;
      report = await quickbooksGet(fetchImpl, reportUrl('GeneralLedger', work.period_start, work.read_through), access);
    } catch (e) {
      return fail(e instanceof ReadError ? e.code : 'quickbooks_read_failed');
    }

    try {
      const { data, error } = await db.rpc('quickbooks_ledger_mirror_read_store', {
        p_company: work.company_entity_id, p_connection: work.qbo_connection_id,
        p_period_start: work.period_start, p_read_through: work.read_through,
        p_report: report, p_account_types: types });
      if (error || !data || typeof data !== 'object') throw new Error();
      const lines = Number.isInteger(data.lines) && data.lines >= 0 ? data.lines : 0;
      // A refusal is already on the month's row, with its reason; only the
      // fact of it leaves here.
      if (data.ok !== true) return reply({ done: false, ok: false, changed: false, lines: 0, error_code: 'report_refused', ...more });
      // The token names THIS read: a newer read of the month makes the
      // database ignore whatever this one goes on to say about balances.
      const balances = uuid(data.read_token) ? await readBalances(data.read_token) : false;
      return reply({ done: false, ok: true, changed: data.changed === true, lines, balances, ...more });
    } catch {
      return fail('store_failed');
    }

    // The month's lines are stored. Now QuickBooks' own balances for the same
    // days. Whatever happens here is recorded on the month and reported as one
    // boolean; it never turns a good ledger read into a failed one.
    async function readBalances(readToken) {
      let rows = null, code = null;
      try {
        const before = shiftDay(work.period_start, -1);
        const profitAndLoss = parseProfitAndLoss(await quickbooksGet(fetchImpl,
          reportUrl('ProfitAndLoss', work.period_start, work.read_through), access));
        const endBalances = parseTrialBalance(await quickbooksGet(fetchImpl,
          reportUrl('TrialBalance', work.period_start, work.read_through), access));
        const startBalances = parseTrialBalance(await quickbooksGet(fetchImpl,
          reportUrl('TrialBalance', `${before.slice(0, 8)}01`, before), access));
        rows = accountBalances({ types, computed, profitAndLoss, endBalances, startBalances });
      } catch (e) {
        code = e instanceof ReadError ? e.code : 'balances_unreadable';
      }
      try {
        const { data, error } = await db.rpc('quickbooks_ledger_mirror_balances_store', {
          p_company: work.company_entity_id, p_connection: work.qbo_connection_id,
          p_period_start: work.period_start, p_read_through: work.read_through,
          p_token: readToken, p_rows: rows, p_error: code });
        return !error && data?.ok === true;
      } catch { return false; }
    }
  };
}
