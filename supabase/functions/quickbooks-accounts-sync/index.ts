// Pulls the QBO chart of accounts into quickbooks_accounts, refreshing the
// OAuth token first if it is close to expiry. Doubles as the connection test:
// it is the cheapest call that proves the grant still works end to end, so
// there is no separate test-quickbooks-connection function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Sandbox and production are DIFFERENT Intuit key pairs on the same app -- a
// Development client id cannot mint a token for a production company, and vice
// versa. Pick the pair from the environment rather than assuming one, and say
// which pair is missing so a misconfiguration is self-diagnosing.
function creds(env: string): { id: string; secret: string } {
  return env === 'production'
    ? {
      id: Deno.env.get('QBO_CLIENT_ID_PROD') ?? '',
      secret: Deno.env.get('QBO_CLIENT_SECRET_PROD') ?? '',
    }
    : {
      id: Deno.env.get('QBO_CLIENT_ID') ?? '',
      secret: Deno.env.get('QBO_CLIENT_SECRET') ?? '',
    };
}

const credsMissing = (env: string) =>
  env === 'production'
    ? 'QBO_CLIENT_ID_PROD / QBO_CLIENT_SECRET_PROD not configured'
    : 'QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured';

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

// QBO caps a query at 1000 rows and offers no cursor, only STARTPOSITION
// (1-indexed). `Active in (true, false)` is required to see archived rows at
// all -- the default query returns active ones only, and an archived row still
// needs to be visible so a mapping pointing at it can be flagged rather than
// silently blanking.
async function qboQueryAll(
  base: string,
  realm: string,
  token: string,
  entity: string,
): Promise<any[]> {
  const PAGE = 1000;
  const out: any[] = [];
  let startPosition = 1;

  for (;;) {
    const query = `select * from ${entity} where Active in (true, false) ` +
      `startposition ${startPosition} maxresults ${PAGE}`;
    const res = await fetch(
      `${base}/v3/company/${realm}/query?query=${encodeURIComponent(query)}&minorversion=75`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${entity.toLowerCase()}_query_failed_${res.status}: ${detail.slice(0, 180)}`);
    }

    const body = await res.json();
    const page = body?.QueryResponse?.[entity] ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
    startPosition += PAGE;
  }

  return out;
}

// Location tracking is a QBO preference (and a Plus/Advanced feature). With it
// off, Department returns nothing -- identical to "on but none created" unless
// the preference itself is read. Recording it lets the mapping UI say WHY the
// location list is empty instead of showing a blank dropdown.
async function fetchLocationTracking(
  base: string,
  realm: string,
  token: string,
): Promise<boolean | null> {
  try {
    const res = await fetch(
      `${base}/v3/company/${realm}/preferences?minorversion=75`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = await res.json();
    const track = body?.Preferences?.AccountingInfoPrefs?.TrackDepartments;
    return typeof track === 'boolean' ? track : null;
  } catch {
    // Preference read is advisory; never fail a sync over it.
    return null;
  }
}

// QBO access tokens last an hour and the refresh token ROTATES on every use,
// so the new one has to be persisted immediately -- dropping it strands the
// connection until a human reconnects. Refresh a minute early to avoid racing
// expiry mid-sync.
async function ensureAccessToken(supabase: any, conn: Conn): Promise<string> {
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  if (conn.access_token && expiresAt - Date.now() > 60_000) return conn.access_token;

  const { id: clientId, secret: clientSecret } = creds(conn.environment);
  if (!clientId || !clientSecret) throw new Error(credsMissing(conn.environment));

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

  const runStartedAt = new Date().toISOString();
  const base = apiBase(conn.environment);

  let accounts: any[];
  try {
    accounts = await qboQueryAll(base, conn.realm_id, accessToken, 'Account');
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

  // Locations (QBO API: Department). Secondary to accounts -- a failure here
  // must not fail a run that already pulled the chart of accounts, since the
  // account mapping is what the export depends on today. Reported instead as
  // locationError so the UI can say what happened.
  const trackLocations = await fetchLocationTracking(base, conn.realm_id, accessToken);
  let locationCount = 0;
  let locationError: string | null = null;

  if (trackLocations !== false) {
    try {
      const locations = await qboQueryAll(base, conn.realm_id, accessToken, 'Department');
      locationCount = locations.length;

      if (locations.length) {
        const rows = locations.map((d) => ({
          connection_id: conn.id,
          company_entity_id: conn.company_entity_id,
          qbo_location_id: String(d.Id),
          name: d.Name ?? String(d.Id),
          fully_qualified_name: d.FullyQualifiedName ?? null,
          is_active: d.Active !== false,
          synced_at: runStartedAt,
        }));

        const { error: locErr } = await supabase
          .from('quickbooks_locations')
          .upsert(rows, { onConflict: 'connection_id,qbo_location_id' });

        if (locErr) throw new Error(`location_upsert_failed: ${locErr.message}`);

        await supabase
          .from('quickbooks_locations')
          .delete()
          .eq('connection_id', conn.id)
          .lt('synced_at', runStartedAt);
      }
    } catch (e) {
      locationError = e instanceof Error ? e.message : String(e);
    }
  }

  await supabase.from('quickbooks_connections').update({
    accounts_synced_at: runStartedAt,
    location_tracking_enabled: trackLocations,
    last_tested_at: runStartedAt,
    last_test_status: 'ok',
    last_test_success: true,
    last_test_error: locationError,
    updated_at: runStartedAt,
  }).eq('id', conn.id);

  return json({
    ok: true,
    accounts: accounts.length,
    locations: locationCount,
    location_tracking_enabled: trackLocations,
    location_error: locationError,
  });
});
