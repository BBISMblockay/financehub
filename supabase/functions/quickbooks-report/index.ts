// Fetches a QuickBooks Online report and stores the run -- or, given
// journal_entry_id instead of report_name, fetches ONE JournalEntry by id for
// the report drill-down's "click a Journal Entry row to see its lines" view.
//
// READ ONLY. There is no write path to QuickBooks in this function and there
// is not meant to be one -- posting is a separate, deliberately unbuilt piece.
//
// Reports are stored rather than just proxied: QBO reports are slow and
// rate-limited, a stored run is the point-in-time snapshot a reconciliation
// needs, and the raw payload stays inspectable when a number looks wrong.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const configuredEnv = () =>
  Deno.env.get('QBO_ENVIRONMENT') === 'production' ? 'production' : 'sandbox';

const CLIENT_ID = () => Deno.env.get('QBO_CLIENT_ID') ?? '';
const CLIENT_SECRET = () => Deno.env.get('QBO_CLIENT_SECRET') ?? '';

const DISCOVERY_URL = (env: string) =>
  env === 'production'
    ? 'https://developer.api.intuit.com/.well-known/openid_configuration'
    : 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration';

const FALLBACK_ENDPOINTS = {
  token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
};

const _discovery = new Map<string, typeof FALLBACK_ENDPOINTS>();

async function endpoints(env: string): Promise<typeof FALLBACK_ENDPOINTS> {
  const cached = _discovery.get(env);
  if (cached) return cached;
  try {
    const res = await fetch(DISCOVERY_URL(env), { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const doc = await res.json();
      const resolved = { token_endpoint: doc.token_endpoint ?? FALLBACK_ENDPOINTS.token_endpoint };
      _discovery.set(env, resolved);
      return resolved;
    }
  } catch { /* discovery is an optimisation, never a hard dependency */ }
  return FALLBACK_ENDPOINTS;
}

const apiBase = (env: string) =>
  env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

const tid = (res: Response) => {
  const t = res.headers.get('intuit_tid');
  return t ? ` [intuit_tid: ${t}]` : '';
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// Allow-list rather than passing the caller's string through to Intuit. These
// are the reports the balance-sheet schedules actually need; anything else is
// a deliberate addition, not a URL someone can improvise.
const ALLOWED_REPORTS = new Set([
  'BalanceSheet',
  'ProfitAndLoss',
  'ProfitAndLossDetail',
  'GeneralLedger',
  'TransactionList',
  'TrialBalance',
  // Same shape as BalanceSheet/ProfitAndLoss (account rows QBO stamps an id
  // on, supports summarize_column_by) -- the generic renderer and row-click
  // drilldown in v2/qbo-reports.html need no report-specific code for it.
  'CashFlow',
]);

// Only parameters QBO documents for these reports. Anything else is dropped
// rather than forwarded.
const ALLOWED_PARAMS = new Set([
  'start_date', 'end_date', 'date_macro', 'accounting_method',
  'account', 'columns', 'summarize_column_by', 'department',
  'sort_by', 'sort_order', 'transaction_type',
]);

type Conn = {
  id: string;
  company_entity_id: string;
  realm_id: string;
  environment: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
};

async function ensureAccessToken(supabase: any, conn: Conn): Promise<string> {
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  if (conn.access_token && expiresAt - Date.now() > 60_000) return conn.access_token;

  const clientId = CLIENT_ID();
  const clientSecret = CLIENT_SECRET();
  if (!clientId || !clientSecret) {
    throw new Error('QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured');
  }
  if (!conn.refresh_token) throw new Error('no_refresh_token_reconnect_required');
  if (
    conn.refresh_token_expires_at
    && Date.parse(conn.refresh_token_expires_at) < Date.now()
  ) {
    throw new Error('refresh_token_expired_reconnect_required');
  }

  const { token_endpoint } = await endpoints(conn.environment);
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`token_refresh_failed: ${detail.slice(0, 180)}${tid(res)}`);
  }

  const tok = await res.json();
  if (!tok.access_token) throw new Error('token_refresh_returned_no_access_token');

  const now = Date.now();
  const { error } = await supabase.from('quickbooks_connections').update({
    access_token: tok.access_token,
    // Intuit rotates the refresh token on every use; failing to store the new
    // one strands the connection until a human reconnects.
    refresh_token: tok.refresh_token ?? conn.refresh_token,
    token_expires_at: new Date(now + Number(tok.expires_in ?? 3600) * 1000).toISOString(),
    refresh_token_expires_at: new Date(
      now + Number(tok.x_refresh_token_expires_in ?? 8726400) * 1000,
    ).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', conn.id);
  if (error) throw new Error(`token_persist_failed: ${error.message}`);

  return tok.access_token;
}

// QBO nests report rows arbitrarily deep. Counting leaves gives a cheap sense
// of size without imposing a parse on the stored payload.
function countRows(node: any): number {
  if (!node) return 0;
  const rows = node.Rows?.Row ?? node.Row ?? null;
  if (!Array.isArray(rows)) return node.ColData ? 1 : 0;
  return rows.reduce((n: number, r: any) => n + Math.max(1, countRows(r)), 0);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const reportName: string = body.report_name ?? '';
  const params: Record<string, string> = body.params ?? {};
  // Set instead of report_name: fetch one JournalEntry by id rather than a
  // report. Report drill-down rows carry this id on their Transaction Type
  // cell whenever the row is a Journal Entry -- confirmed against a real
  // GeneralLedger run rather than assumed from QBO's docs.
  const journalEntryId: string = body.journal_entry_id ? String(body.journal_entry_id) : '';

  if (!journalEntryId && !ALLOWED_REPORTS.has(reportName)) {
    return json({ error: `Unsupported report: ${reportName}` }, 400);
  }

  // Resolve the CALLER's company first, then that company's connection.
  // Selecting a connection before knowing the company would, with more than one
  // tenant connected, pick an arbitrary company's books -- the membership check
  // below would reject it, but only after having read another company's row.
  const { data: profile } = await supabase
    .from('profiles')
    .select('active_company_id, is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.is_active === false) {
    return json({ error: 'No active profile' }, 403);
  }

  const companyId = profile.active_company_id;
  if (!companyId) return json({ error: 'No active company set' }, 403);

  // Reports are financial statements: any active member of the company may read
  // them, no admin gate -- same stance as quickbooks_accounts. The membership
  // row is the authority; active_company_id alone is not, since it is only
  // meaningful alongside a membership.
  const { data: membership } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) {
    // Profile-only fallback for users with no membership row, matching the
    // precedence the RLS helpers use.
    const { data: anyMembership } = await supabase
      .from('entity_memberships')
      .select('entity_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();
    if (anyMembership) return json({ error: 'Not a member of this company' }, 403);
  }

  const { data: conn, error: connErr } = await supabase
    .from('quickbooks_connections')
    .select(
      'id, company_entity_id, realm_id, environment, access_token, refresh_token, token_expires_at, refresh_token_expires_at',
    )
    .eq('company_entity_id', companyId)
    .limit(1)
    .maybeSingle();

  if (connErr || !conn) return json({ error: 'No QuickBooks connection' }, 404);

  if (conn.environment !== configuredEnv()) {
    return json({
      error: `environment_mismatch: connection is ${conn.environment}, `
        + `QBO_ENVIRONMENT is ${configuredEnv()}`,
    }, 409);
  }

  const recordFailure = async (msg: string) => {
    // A JournalEntry lookup isn't a report run -- this table's whole point is
    // a point-in-time report SNAPSHOT, and logging an ad-hoc single-entity
    // fetch here (one per row a person clicks, potentially many per session)
    // would misrepresent what actually ran when someone reads this table back.
    if (journalEntryId) return;
    await supabase.from('quickbooks_report_runs').insert({
      company_entity_id: conn.company_entity_id,
      connection_id: conn.id,
      report_name: reportName,
      params,
      start_date: params.start_date ?? null,
      end_date: params.end_date ?? null,
      status: 'error',
      error_message: msg.slice(0, 500),
      created_by: user.id,
    });
  };

  let accessToken: string;
  try {
    accessToken = await ensureAccessToken(supabase, conn as Conn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordFailure(msg);
    return json({ error: msg }, 502);
  }

  if (journalEntryId) {
    try {
      const res = await fetch(
        `${apiBase(conn.environment)}/v3/company/${conn.realm_id}/journalentry/${encodeURIComponent(journalEntryId)}?minorversion=75`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return json({
          error: `journal_entry_fetch_failed_${res.status}: ${detail.slice(0, 300)}${tid(res)}`,
        }, 502);
      }
      const body2 = await res.json();
      return json({ ok: true, journal_entry: body2?.JournalEntry ?? null });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (ALLOWED_PARAMS.has(k) && v !== '' && v != null) qs.set(k, String(v));
  }
  qs.set('minorversion', '75');

  const url = `${apiBase(conn.environment)}/v3/company/${conn.realm_id}`
    + `/reports/${reportName}?${qs.toString()}`;

  let payload: any;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`report_failed_${res.status}: ${detail.slice(0, 300)}${tid(res)}`);
    }
    payload = await res.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordFailure(msg);
    return json({ error: msg }, 502);
  }

  const rowCount = countRows(payload);

  const { data: run, error: insErr } = await supabase
    .from('quickbooks_report_runs')
    .insert({
      company_entity_id: conn.company_entity_id,
      connection_id: conn.id,
      report_name: reportName,
      params,
      start_date: params.start_date ?? null,
      end_date: params.end_date ?? null,
      raw_response: payload,
      row_count: rowCount,
      status: 'ok',
      created_by: user.id,
    })
    .select('id, fetched_at')
    .single();

  if (insErr) return json({ error: `store_failed: ${insErr.message}` }, 500);

  return json({
    ok: true,
    run_id: run.id,
    fetched_at: run.fetched_at,
    report_name: reportName,
    row_count: rowCount,
    report: payload,
  });
});
