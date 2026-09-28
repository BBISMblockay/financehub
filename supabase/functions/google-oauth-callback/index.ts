import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { acceptReturnOrigin, mayReconnect, parseOrigins, returnUrl } from './google-oauth-lib.mjs';

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/google-oauth-callback';
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';
// Set together with the SILO Google client's keys; see google-oauth-lib.mjs.
const REDIRECT_ORIGINS = parseOrigins(Deno.env.get('GOOGLE_OAUTH_REDIRECT_ORIGINS'));

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  const code = params.get('code');
  const state = params.get('state');
  const oauthError = params.get('error');

  // Return-page mode: the page reports which site it is on. Only an allowed
  // origin is honoured -- and the token exchange below repeats it as
  // redirect_uri, which Google checks against the authorization request, so a
  // forged value fails there too. The person is sent back to that same site.
  let redirectUri = CALLBACK_URL;
  let appUrl = SILO_APP_URL;
  let badOrigin = false;
  if (REDIRECT_ORIGINS.length) {
    const origin = acceptReturnOrigin(params.get('return_origin'), REDIRECT_ORIGINS);
    if (origin) { redirectUri = returnUrl(origin); appUrl = origin; } else { appUrl = REDIRECT_ORIGINS[0]; badOrigin = true; }
  }

  const errorRedirect = (msg: string) =>
    Response.redirect(`${appUrl}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  if (oauthError) return errorRedirect(oauthError);
  if (badOrigin) return errorRedirect('invalid_return_origin');
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
      redirect_uri: redirectUri,
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

  const DISPLAY_NAMES: Record<string, string> = {
    ga4: 'GA4 property',
    google_ads: 'Google Ads account',
    search_console: 'Search Console property',
  };

  const done = (connectionId: string, reconnected: boolean) => Response.redirect(
    `${appUrl}/v2/integrations.html?oauth_connected=1&platform=${stateRow.platform}`
      + `&connection_id=${connectionId}${reconnected ? '&reconnected=1' : ''}`,
    302,
  );

  // Reconnect: new tokens onto the row the flow was started for, re-checked
  // here (the state names it by id, and ten minutes have passed). The old
  // test result is cleared: it vouched for the previous token.
  if (stateRow.connection_id) {
    const { data: conn } = await supabase
      .from('ad_platform_connections')
      .select('id, company_entity_id, platform')
      .eq('id', stateRow.connection_id)
      .maybeSingle();
    if (!mayReconnect(stateRow, conn)) return errorRedirect('reconnect_target_missing');
    const { data: updated, error: updErr } = await supabase.from('ad_platform_connections')
      .update({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
        is_active: true,
        last_tested_at: null,
        last_test_status: null,
        last_test_success: null,
        last_test_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conn!.id)
      .eq('company_entity_id', stateRow.company_entity_id)
      .select('id');
    if (updErr) return errorRedirect(`save_failed: ${updErr.message}`);
    if (!updated?.length) return errorRedirect('reconnect_target_missing');
    return done(conn!.id, true);
  }

  const { data: inserted, error: insertErr } = await supabase.from('ad_platform_connections').insert({
    company_entity_id: stateRow.company_entity_id,
    platform: stateRow.platform,
    display_name: DISPLAY_NAMES[stateRow.platform] ?? stateRow.platform,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: expiresAt,
    is_active: true,
    sync_enabled: false,
    created_by: stateRow.user_id,
  }).select('id').single();

  if (insertErr || !inserted) return errorRedirect(`save_failed: ${insertErr?.message ?? 'no row returned'}`);

  return done(inserted.id, false);
});
