import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/google-oauth-callback';
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  const code = params.get('code');
  const state = params.get('state');
  const oauthError = params.get('error');

  const errorRedirect = (msg: string) =>
    Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  if (oauthError) return errorRedirect(oauthError);
  if (!code || !state) return errorRedirect('missing_params');
  if (!CLIENT_ID || !CLIENT_SECRET) return errorRedirect('server_misconfigured');

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

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: CALLBACK_URL,
    }).toString(),
  });

  if (!tokenRes.ok) return errorRedirect('token_exchange_failed');
  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  const refreshToken: string | undefined = tokenData.refresh_token;
  if (!accessToken) return errorRedirect('no_access_token');
  // Google only returns refresh_token on the FIRST consent for a given
  // client+account; prompt=consent (set in google-oauth-start) forces a
  // fresh one every time, so a missing refresh_token here means the OAuth
  // consent screen itself didn't grant offline access — treat as fatal
  // rather than silently storing an access-only connection that dies in 1h.
  if (!refreshToken) return errorRedirect('no_refresh_token_reauth_required');

  const expiresAt = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();

  const { error: insertErr } = await supabase.from('ad_platform_connections').insert({
    company_entity_id: stateRow.company_entity_id,
    platform: stateRow.platform,
    display_name: stateRow.platform === 'ga4' ? 'GA4 property' : 'Google Ads account',
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: expiresAt,
    is_active: true,
    sync_enabled: false,
    created_by: stateRow.user_id,
  });

  if (insertErr) return errorRedirect(`save_failed: ${insertErr.message}`);

  return Response.redirect(
    `${SILO_APP_URL}/v2/integrations.html?oauth_connected=1&platform=${stateRow.platform}`,
    302,
  );
});
