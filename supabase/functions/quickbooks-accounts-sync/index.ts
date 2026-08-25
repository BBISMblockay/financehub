// Pulls the QBO chart of accounts into quickbooks_accounts, refreshing the
// OAuth token first if it is close to expiry. Doubles as the connection test:
// it is the cheapest call that proves the grant still works end to end, so
// there is no separate test-quickbooks-connection function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = Deno.env.get('QBO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('QBO_CLIENT_SECRET') ?? '';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const apiBase = (env: string) =>
  env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

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

// QBO access tokens last an hour and the refresh token ROTATES on every use,
// so the new one has to be persisted immediately -- dropping it strands the
// connection until a human reconnects. Refresh a minute early to avoid racing
// expiry mid-sync.
async function ensureAccessToken(supabase: any, conn: Conn): Promise<string> {
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  if (conn.access_token && expiresAt - Date.now() > 60_000) return conn.access_token;

  if (!conn.refresh_token) throw new Error('no_refresh_token_reconnect_required');
  if (
    conn.refresh_token_expires_at
    && Date.parse(conn.refresh_token_expires_at) < Date.now()
  ) {
    throw new Error('refresh_token_expired_reconnect_required');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
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
    throw new Error(`token_refresh_failed: ${detail.slice(0, 180)}`);
  }

  const tok = await res.json();
  if (!tok.access_token) throw new Error('token_refresh_returned_no_access_token');

  const now = Date.now();
  const { error } = await supabase
    .from('quickbooks_connections')
    .update({
      access_token: tok.access_token,
      // Intuit returns the rotated refresh token here; fall back to the old
      // one only if it genuinely omitted it.
      refresh_token: tok.refresh_token ?? conn.refresh_token,
      token_expires_at: new Date(now + Number(tok.expires_in ?? 3600) * 1000).toISOString(),
      refresh_token_expires_at: new Date(
        now + Number(tok.x_refresh_token_expires_in ?? 8726400) * 1000,
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conn.id);

  // A rotated token we failed to store is worse than a failed sync: the next
  // run would present a refresh token Intuit has already retired.
  if (error) throw new Error(`token_persist_failed: ${error.message}`);

  return tok.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'QBO client not configured' }, 500);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const { connection_id } = await req.json().catch(() => ({}));
  if (!connection_id) return json({ error: 'connection_id required' }, 400);

  const { data: conn, error: connErr } = await supabase
    .from('quickbooks_connections')
    .select(
      'id, company_entity_id, realm_id, environment, access_token, refresh_token, token_expires_at, refresh_token_expires_at',
    )
    .eq('id', connection_id)
    .single();

  if (connErr || !conn) return json({ error: 'Connection not found' }, 404);

  // Same admin gate as quickbooks-oauth-start: the service-role client above
  // bypasses the table's RLS, so authorization is re-checked by hand.
  const { data: membership } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', conn.company_entity_id)
    .eq('user_id', user.id)
    .maybeSingle();

  let allowed = membership ? ['owner_admin', 'admin'].includes(membership.role) : false;
  if (!membership) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, active_company_id')
      .eq('id', user.id)
      .maybeSingle();
    allowed = !!profile
      && profile.active_company_id === conn.company_entity_id
      && ['owner', 'admin', 'executive'].includes(String(profile.role));
  }
  if (!allowed) return json({ error: 'Admin access required for this company' }, 403);

  const recordFailure = async (msg: string) => {
    await supabase.from('quickbooks_connections').update({
      last_tested_at: new Date().toISOString(),
      last_test_status: 'error',
      last_test_success: false,
      last_test_error: msg.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', conn.id);
  };

  let accessToken: string;
  try {
    accessToken = await ensureAccessToken(supabase, conn as Conn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordFailure(msg);
    return json({ error: msg }, 502);
  }

  // Paginate: QBO caps a query at 1000 rows and has no cursor, only
  // STARTPOSITION (1-indexed). `Active in (true, false)` is required to see
  // archived accounts at all -- the default query returns active ones only,
  // and an archived account still needs to be visible so a mapping pointing
  // at one can be flagged rather than silently blank.
  const PAGE = 1000;
  const runStartedAt = new Date().toISOString();
  const accounts: any[] = [];
  let startPosition = 1;

  try {
    for (;;) {
      const query =
        `select * from Account where Active in (true, false) startposition ${startPosition} maxresults ${PAGE}`;
      const res = await fetch(
        `${apiBase(conn.environment)}/v3/company/${conn.realm_id}/query?query=${
          encodeURIComponent(query)
        }&minorversion=75`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`account_query_failed_${res.status}: ${detail.slice(0, 180)}`);
      }

      const body = await res.json();
      const page = body?.QueryResponse?.Account ?? [];
      accounts.push(...page);
      if (page.length < PAGE) break;
      startPosition += PAGE;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordFailure(msg);
    return json({ error: msg }, 502);
  }

  if (accounts.length) {
    const rows = accounts.map((a) => ({
      connection_id: conn.id,
      company_entity_id: conn.company_entity_id,
      qbo_account_id: String(a.Id),
      name: a.Name ?? String(a.Id),
      fully_qualified_name: a.FullyQualifiedName ?? null,
      account_type: a.AccountType ?? null,
      account_sub_type: a.AccountSubType ?? null,
      classification: a.Classification ?? null,
      currency: a.CurrencyRef?.value ?? null,
      is_active: a.Active !== false,
      synced_at: runStartedAt,
    }));

    const { error: upsertErr } = await supabase
      .from('quickbooks_accounts')
      .upsert(rows, { onConflict: 'connection_id,qbo_account_id' });

    if (upsertErr) {
      await recordFailure(`account_upsert_failed: ${upsertErr.message}`);
      return json({ error: upsertErr.message }, 500);
    }

    // Drop accounts that vanished from QBO entirely (deleted, not archived --
    // archived ones still come back above with Active=false). Scoped by the
    // run timestamp so a partial page never wipes the rest.
    await supabase
      .from('quickbooks_accounts')
      .delete()
      .eq('connection_id', conn.id)
      .lt('synced_at', runStartedAt);
  }

  await supabase.from('quickbooks_connections').update({
    accounts_synced_at: runStartedAt,
    last_tested_at: runStartedAt,
    last_test_status: 'ok',
    last_test_success: true,
    last_test_error: null,
    updated_at: runStartedAt,
  }).eq('id', conn.id);

  return json({ ok: true, accounts: accounts.length });
});
