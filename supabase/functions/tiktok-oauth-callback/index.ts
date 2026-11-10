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

  // Consume the state in ONE statement, scoped to this platform: a read-then-
  // delete lets two callbacks race on one nonce, and an unscoped read would
  // accept a Google or Meta state here. Same shape as meta-oauth-callback.
  const { data: consumed, error: stateErr } = await supabase
    .from('ad_platform_oauth_states')
    .delete()
    .eq('nonce', state)
    .eq('platform', 'tiktok_ads')
    .gt('expires_at', new Date().toISOString())
    .select('*');

  if (stateErr || !Array.isArray(consumed) || consumed.length !== 1) return errorRedirect('invalid_or_expired_state');
  const stateRow = consumed[0];

  // TikTok's /oauth2/access_token/ takes app_id, secret and auth_code and
  // NOTHING else: grant_type belongs to the other endpoint (/oauth/token/,
  // which uses client_id/client_secret/code). JSON is the only content type
  // this one accepts.
  const tokenRes = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: APP_ID,
      secret: APP_SECRET,
      auth_code: authCode,
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
  const advertiserIds: string[] = (Array.isArray(data.advertiser_ids) ? data.advertiser_ids : []).map(String);

  // The token response carries ids and no names, and TikTok's own docs point
  // at /oauth2/advertiser/get/ for the authoritative list -- so ask for it,
  // and the picker can show "Acme Supply Co" instead of 19 digits nobody can
  // tell apart. A failure here is not a failed connection: the grant is good,
  // so the ids from the token response still stand and the names are simply
  // absent.
  let advertisers: Array<{ advertiser_id: string; advertiser_name?: string }> = [];
  try {
    const listRes = await fetch(
      'https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?'
        + new URLSearchParams({ app_id: APP_ID, secret: APP_SECRET }),
      { headers: { 'Access-Token': accessToken } },
    );
    const listJson = await listRes.json();
    if (listJson?.code === 0 && Array.isArray(listJson?.data?.list)) {
      advertisers = listJson.data.list
        .map((a: Record<string, unknown>) => ({
          advertiser_id: String(a.advertiser_id ?? ''),
          advertiser_name: a.advertiser_name == null ? undefined : String(a.advertiser_name),
        }))
        .filter((a: { advertiser_id: string }) => a.advertiser_id);
    }
  } catch (_err) {
    advertisers = [];
  }
  const ids = advertisers.length ? advertisers.map((a) => a.advertiser_id) : advertiserIds;
  // The advertiser is NOT chosen here, even when the grant names exactly one.
  // Integrations' account picker makes that choice on the way back, and
  // choosing is what switches the nightly sync on, queues the 90-day backfill
  // and pulls the first window (chooseAccount in v2/integrations.html). A row
  // that arrived with its advertiser already filled in skipped all three and
  // sat there testing OK while importing nothing. The picker auto-selects a
  // lone advertiser without asking, so a single-account grant still takes one
  // click to connect.
  const onlyName = ids.length === 1
    ? advertisers.find((a) => a.advertiser_id === ids[0])?.advertiser_name ?? null
    : null;

  const { data: inserted, error: insertErr } = await supabase.from('ad_platform_connections').insert({
    company_entity_id: stateRow.company_entity_id,
    platform: 'tiktok_ads',
    display_name: onlyName || 'TikTok Ads account',
    access_token: accessToken,
    tiktok_advertiser_id: null,
    is_active: true,
    // Sync stays OFF until an advertiser is chosen and proved: choosing the
    // account is what switches it on (ad-account-picker.js patchFor), the
    // same rule every other ad platform follows.
    sync_enabled: false,
    created_by: stateRow.user_id,
    meta: { advertiser_ids: ids, advertisers, scope: Array.isArray(data.scope) ? data.scope : null },
  }).select('id').single();

  if (insertErr || !inserted) return errorRedirect(`save_failed: ${insertErr?.message ?? 'no row'}`);

  // The id lets Integrations act on exactly this row, never on another
  // TikTok row of whichever workspace the tab has open now.
  return Response.redirect(
    `${SILO_APP_URL}/v2/integrations.html?oauth_connected=1&platform=tiktok_ads&connection_id=${encodeURIComponent(inserted.id)}`,
    302,
  );
});
