import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const APP_ID = Deno.env.get('TIKTOK_APP_ID') ?? '';
const APP_SECRET = Deno.env.get('TIKTOK_APP_SECRET') ?? '';
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  // TikTok's portal redirect uses `auth_code`, not the generic OAuth `code`.
  const authCode = params.get('auth_code');
  const state = params.get('state');

  const errorRedirect = (msg: string) =>
    Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  if (!authCode || !state) return errorRedirect('missing_params');
  if (!APP_ID || !APP_SECRET) return errorRedirect('server_misconfigured');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: stateRow, error: stateErr } = await supabase
    .from('ad_platform_oauth_states')
    .select('*')
    .eq('nonce', state)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateErr || !stateRow) return errorRedirect('invalid_or_expired_state');
  await supabase.from('ad_platform_oauth_states').delete().eq('nonce', state);

  const tokenRes = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: APP_ID,
      secret: APP_SECRET,
      auth_code: authCode,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) return errorRedirect('token_exchange_failed');
  const tokenJson = await tokenRes.json();
  const data = tokenJson?.data ?? {};
  const accessToken: string = data.access_token;
  if (!accessToken) return errorRedirect('no_access_token');

  // TikTok's Marketing API access tokens have no fixed short expiry (unlike
  // Google/Meta) — no refresh_token/expires_in comes back from this
  // endpoint as of API v1.3. token_expires_at stays null; test-ad-platform-
  // connection surfaces a 401 as "reconnect required" if TikTok ever
  // revokes it.
  const advertiserIds: string[] = Array.isArray(data.advertiser_ids) ? data.advertiser_ids : [];

  const { error: insertErr } = await supabase.from('ad_platform_connections').insert({
    company_entity_id: stateRow.company_entity_id,
    platform: 'tiktok_ads',
    display_name: 'TikTok Ads account',
    access_token: accessToken,
    tiktok_advertiser_id: advertiserIds[0] ?? null,
    is_active: true,
    sync_enabled: false,
    created_by: stateRow.user_id,
    meta: { advertiser_ids: advertiserIds },
  });

  if (insertErr) return errorRedirect(`save_failed: ${insertErr.message}`);

  return Response.redirect(
    `${SILO_APP_URL}/v2/integrations.html?oauth_connected=1&platform=tiktok_ads`,
    302,
  );
});
