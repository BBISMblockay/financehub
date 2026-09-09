import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
const GOOGLE_ADS_DEVELOPER_TOKEN = Deno.env.get('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '';
// Google retires Ads API majors ~12 months after release (monthly releases
// since 2026) — a sunset version 404s with an HTML error page. Keep in sync
// with GOOGLE_ADS_API_VERSION in scripts/lib/ad-platforms-sync-core.mjs.
const GOOGLE_ADS_API_VERSION = 'v24';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    access_token: data.access_token as string,
    expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
  };
}

async function testGoogleAds(conn: Record<string, unknown>, accessToken: string) {
  if (!GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN not configured');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (conn.google_login_customer_id) {
    headers['login-customer-id'] = String(conn.google_login_customer_id).replace(/-/g, '');
  }
  // No customer id configured yet → just list accessible customers so the
  // admin can pick one; with an id, run a trivial GAQL query as a real probe.
  if (!conn.google_customer_id) {
    const res = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
      { headers },
    );
    if (!res.ok) throw new Error(`listAccessibleCustomers ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return { accessible_customers: data.resourceNames ?? [] };
  }
  const cid = String(conn.google_customer_id).replace(/-/g, '');
  const res = await fetch(
    `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cid}/googleAds:search`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' }),
    },
  );
  if (!res.ok) throw new Error(`Google Ads search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const customer = data.results?.[0]?.customer ?? {};
  return { customer_id: customer.id, customer_name: customer.descriptiveName };
}

async function testGa4(conn: Record<string, unknown>, accessToken: string) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (!conn.ga4_property_id) {
    const res = await fetch(
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=50',
      { headers },
    );
    if (!res.ok) throw new Error(`GA4 accountSummaries ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const properties = (data.accountSummaries ?? []).flatMap((a: Record<string, unknown>) =>
      ((a.propertySummaries as Record<string, unknown>[]) ?? []).map((p) => ({
        property: p.property, display_name: p.displayName, account: a.displayName,
      })),
    );
    return { properties };
  }
  const prop = String(conn.ga4_property_id).replace(/^properties\//, '');
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
        metrics: [{ name: 'sessions' }],
      }),
    },
  );
  if (!res.ok) throw new Error(`GA4 runReport ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { property_id: prop };
}

/** Search Console. With no site configured, returns the VERIFIED PROPERTY
 * LIST — which is the answer to "is www.baseballism.com actually verified",
 * and in which form. Search Console has two property kinds that are not
 * interchangeable: a URL prefix ('https://www.baseballism.com/') covers one
 * scheme+host+path, a domain property ('sc-domain:baseballism.com') covers
 * every subdomain and both schemes. They report different traffic, so the
 * identifier is offered verbatim rather than normalised.
 *
 * permissionLevel comes back per site; siteUnverifiedUser means the account
 * can see the property exists but cannot read its data, which would otherwise
 * surface later as an empty report rather than a permissions problem. */
async function testSearchConsole(conn: Record<string, unknown>, accessToken: string) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (!conn.search_console_site_url) {
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers });
    if (!res.ok) throw new Error(`Search Console sites.list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const sites = (data.siteEntry ?? []).map((s: Record<string, unknown>) => ({
      site_url: s.siteUrl,
      permission_level: s.permissionLevel,
      readable: s.permissionLevel !== 'siteUnverifiedUser',
    }));
    return { sites };
  }
  const site = encodeURIComponent(String(conn.search_console_site_url));
  // A 3-day window ending 3 days ago: Search Console lags real time, so
  // "yesterday" can legitimately return zero rows on a healthy property and
  // would make a working connection look broken. Zero rows is not a failure
  // here either way — the test is that the API accepts the property and the
  // scope, which a 200 establishes.
  const end = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ startDate: start, endDate: end, dimensions: ['date'], rowLimit: 5 }),
    },
  );
  if (!res.ok) throw new Error(`Search Console searchAnalytics ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    site_url: conn.search_console_site_url,
    days_with_data_in_probe_window: (data.rows ?? []).length,
    probe_window: `${start}..${end}`,
  };
}

/** Best-effort: list Pages the token can manage, with each Page's linked
 * Instagram business account, so the Facebook Page ID / Instagram Business
 * Account ID fields can be filled from a real list instead of Graph API
 * Explorer. Returns [] rather than throwing when the token lacks
 * pages_read_engagement/instagram_basic (expected until that's granted) —
 * this is a nice-to-have on top of the ad-account test, never the reason
 * Test fails. */
async function discoverMetaPages(token: string): Promise<Array<Record<string, unknown>>> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/me/accounts?` + new URLSearchParams({
        fields: 'id,name,instagram_business_account{id,username}',
        limit: '50',
        access_token: token,
      }).toString(),
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).map((p: Record<string, unknown>) => ({
      page_id: p.id,
      page_name: p.name,
      instagram_business_account_id: (p.instagram_business_account as Record<string, unknown>)?.id ?? null,
      instagram_username: (p.instagram_business_account as Record<string, unknown>)?.username ?? null,
    }));
  } catch {
    return [];
  }
}

async function testMetaAds(conn: Record<string, unknown>) {
  const token = String(conn.access_token || '');
  if (!token) throw new Error('No access token stored — paste a System User token first');
  const pages = await discoverMetaPages(token);
  const pagesExtra = pages.length ? { pages } : {};

  if (!conn.meta_ad_account_id) {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/me/adaccounts?fields=id,name,currency&limit=50&access_token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) throw new Error(`Meta adaccounts ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return { ad_accounts: data.data ?? [], ...pagesExtra };
  }
  const acct = String(conn.meta_ad_account_id);
  const res = await fetch(
    `https://graph.facebook.com/v25.0/${acct}?fields=id,name,currency,account_status&access_token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) throw new Error(`Meta account ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { account_id: data.id, account_name: data.name, currency: data.currency, ...pagesExtra };
}

async function testTiktokAds(conn: Record<string, unknown>) {
  const token = String(conn.access_token || '');
  if (!token) throw new Error('No access token stored — reconnect via OAuth');
  if (!conn.tiktok_advertiser_id) {
    // advertiser ids were captured at OAuth time into meta.advertiser_ids
    const ids = (conn.meta as Record<string, unknown>)?.advertiser_ids ?? [];
    return { advertiser_ids: ids, note: 'set tiktok_advertiser_id to one of these' };
  }
  const res = await fetch(
    `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?` +
      new URLSearchParams({ advertiser_ids: JSON.stringify([String(conn.tiktok_advertiser_id)]) }),
    { headers: { 'Access-Token': token } },
  );
  if (!res.ok) throw new Error(`TikTok advertiser/info ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`TikTok advertiser/info: ${data.message}`);
  const info = data.data?.list?.[0] ?? {};
  return { advertiser_id: info.advertiser_id, advertiser_name: info.name };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization') ?? '';
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user }, error: authErr } = await service.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const { connection_id } = await req.json();
  if (!connection_id) return json({ error: 'connection_id required' }, 400);

  // RLS-scoped read via the caller's JWT proves the caller can see this
  // connection (active-company check); the token columns themselves are read
  // with service role below.
  const rlsClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: visible } = await rlsClient
    .from('ad_platform_connections')
    .select('id')
    .eq('id', connection_id)
    .maybeSingle();
  if (!visible) return json({ error: 'Connection not found' }, 404);

  const { data: conn, error: connErr } = await service
    .from('ad_platform_connections')
    .select('*')
    .eq('id', connection_id)
    .single();
  if (connErr || !conn) return json({ error: 'Connection not found' }, 404);

  let result: Record<string, unknown> = {};
  let ok = true;
  let errMsg: string | null = null;

  try {
    if (conn.platform === 'google_ads' || conn.platform === 'ga4' || conn.platform === 'search_console') {
      if (!conn.refresh_token) throw new Error('No refresh token stored — reconnect via OAuth');
      const fresh = await refreshGoogleToken(conn.refresh_token);
      await service.from('ad_platform_connections').update({
        access_token: fresh.access_token,
        token_expires_at: fresh.expires_at,
        updated_at: new Date().toISOString(),
      }).eq('id', conn.id);
      if (conn.platform === 'google_ads') result = await testGoogleAds(conn, fresh.access_token);
      else if (conn.platform === 'ga4') result = await testGa4(conn, fresh.access_token);
      else result = await testSearchConsole(conn, fresh.access_token);
    } else if (conn.platform === 'meta_ads') {
      result = await testMetaAds(conn);
    } else if (conn.platform === 'tiktok_ads') {
      result = await testTiktokAds(conn);
    } else {
      throw new Error(`Unknown platform: ${conn.platform}`);
    }
  } catch (err) {
    ok = false;
    errMsg = String((err as Error)?.message ?? err).slice(0, 500);
  }

  await service.from('ad_platform_connections').update({
    last_tested_at: new Date().toISOString(),
    last_test_status: ok ? 'ok' : 'error',
    last_test_success: ok,
    last_test_error: errMsg,
    updated_at: new Date().toISOString(),
  }).eq('id', conn.id);

  return json({ ok, error: errMsg, ...result });
});
