// ad-platform-sync-run -- "Sync now" for ONE Google Ads or GA4 connection,
// from /v2/integrations.html.
//
// Until this existed, Google data reached SILO only through the scheduled
// ad-platforms-sync workflow, so connecting an account and seeing its numbers
// were hours apart. This runs the SAME code the nightly runs --
// runConnectionSync from scripts/lib/ad-platforms-sync-core.mjs, copied
// verbatim into ./lib and pinned there by scripts/tests/ad-platform-sync-run.test.mjs
// -- so a manual sync writes exactly the rows the nightly would, upserted on
// the same identity hash. Overlapping with the nightly is therefore harmless.
//
// Read-only against Google: googleAds:search and GA4 runReport. Nothing is
// ever written to the user's Google account.
//
// Authorization is the page's own: the connection must be readable through
// the CALLER's RLS, and ad_platform_connections' select policy is
// `company_entity_id = active_company_id() AND is_admin_user()` -- an active
// admin of the company that owns the row. The token columns are then read
// with the service role, exactly as test-ad-platform-connection does.
//
// Search Console is deliberately not offered: its sync fills three tables
// page by page and refreshes a materialized view, which does not fit an
// interactive request. It stays nightly.

export const SYNC_RUN_PLATFORMS = ['google_ads', 'ga4'];
export const JOB_TYPES = { google_ads: 'google_ads_kpis', ga4: 'ga4_kpis' };
const ACCOUNT_FIELD = { google_ads: 'google_customer_id', ga4: 'ga4_property_id' };
const ACCOUNT_NOUN = { google_ads: 'Google Ads account', ga4: 'GA4 property' };

// The request must finish inside the gateway's 150s. The nightly default is
// 30 days; a connection configured wider is clamped rather than refused, and
// the response names the window actually synced.
export const DEFAULT_DAYS_BACK = 30;
export const MAX_DAYS_BACK = 90;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

/** Can this connection be synced now, and over how many days? Pure. */
export function planSyncRun(conn) {
  if (!conn) return { ok: false, status: 404, error: 'Connection not found' };
  if (!SYNC_RUN_PLATFORMS.includes(conn.platform)) {
    return { ok: false, status: 400, error: 'Sync now is available for Google Ads and GA4 connections' };
  }
  if (conn.is_active !== true) return { ok: false, status: 409, error: 'This connection is inactive' };
  if (!conn.refresh_token) return { ok: false, status: 409, error: 'No Google authorization stored. Click Reconnect on this row.' };
  if (!conn[ACCOUNT_FIELD[conn.platform]]) {
    return { ok: false, status: 409, error: `Choose a ${ACCOUNT_NOUN[conn.platform]} on this row first` };
  }
  const configured = Number(conn.days_back);
  const days = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_DAYS_BACK;
  return { ok: true, daysBack: Math.min(days, MAX_DAYS_BACK) };
}

/**
 * @param deps.service        service-role Supabase client
 * @param deps.userClientFor  (authHeader) => Supabase client carrying the caller's JWT
 * @param deps.googleEnv      { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN }
 * @param deps.runConnectionSync  the shared sync core's function
 */
export function createHandler({ service, userClientFor, googleEnv, runConnectionSync, now = () => new Date() }) {
  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const { data: auth, error: authErr } = await service.auth.getUser(token);
    const user = auth?.user;
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    let body;
    try { body = await req.json(); } catch { body = null; }
    const connectionId = typeof body?.connection_id === 'string' ? body.connection_id : '';
    if (!connectionId) return json({ error: 'connection_id required' }, 400);

    // The authorization: visible through the caller's own RLS, or not at all.
    const { data: visible, error: visErr } = await userClientFor(authHeader)
      .from('ad_platform_connections').select('id').eq('id', connectionId).maybeSingle();
    if (visErr || !visible) return json({ error: 'Connection not found' }, 404);

    const { data: conn, error: connErr } = await service
      .from('ad_platform_connections').select('*').eq('id', connectionId).maybeSingle();
    if (connErr || !conn) return json({ error: 'Connection not found' }, 404);

    const plan = planSyncRun(conn);
    if (!plan.ok) return json({ ok: false, error: plan.error }, plan.status);
    if (!googleEnv.GOOGLE_CLIENT_ID || !googleEnv.GOOGLE_CLIENT_SECRET
        || (conn.platform === 'google_ads' && !googleEnv.GOOGLE_ADS_DEVELOPER_TOKEN)) {
      return json({ ok: false, error: 'Google sync is not configured on the server' }, 503);
    }

    const { data: job, error: jobErr } = await service.from('sync_jobs').insert({
      company_entity_id: conn.company_entity_id,
      job_type: JOB_TYPES[conn.platform],
      status: 'running',
      started_at: now().toISOString(),
      created_by: user.id,
      params: { trigger: 'manual', ad_connection_id: conn.id, days_back: plan.daysBack },
    }).select('id').single();
    if (jobErr || !job) return json({ ok: false, error: 'Could not record the sync job' }, 500);

    try {
      const result = await runConnectionSync(service, googleEnv, conn, {
        batchId: `manual-${job.id}`,
        daysBackOverride: plan.daysBack,
        onTokenRefresh: async (accessToken, expiresAt) => {
          await service.from('ad_platform_connections')
            .update({ access_token: accessToken, token_expires_at: expiresAt, updated_at: now().toISOString() })
            .eq('id', conn.id);
        },
      });
      await service.from('ad_platform_connections')
        .update({ meta: { ...(conn.meta || {}), last_sync_at: result.synced_at }, updated_at: now().toISOString() })
        .eq('id', conn.id);
      await service.from('sync_jobs')
        .update({ status: 'success', finished_at: now().toISOString(), result })
        .eq('id', job.id);
      return json({
        ok: true,
        platform: result.platform,
        window: result.window,
        rows_fetched: result.rows_fetched,
        kpi_rows_upserted: result.kpi_rows_upserted,
        synced_at: result.synced_at,
      });
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 500);
      await service.from('sync_jobs')
        .update({ status: 'error', finished_at: now().toISOString(), error: message.slice(0, 2000) })
        .eq('id', job.id);
      return json({ ok: false, error: message }, 502);
    }
  };
}
