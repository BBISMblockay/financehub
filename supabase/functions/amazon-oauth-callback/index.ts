// amazon-oauth-callback -- Login with Amazon redirects the browser here with
// an authorization code; this exchanges it, finds which Amazon Ads profiles
// the grant can reach, and inserts the connection row.
//
// NO JWT: Amazon redirects the BROWSER here, so this must be in
// NO_JWT_FUNCTIONS in deploy-edge-function.yml. The CSRF state consumed below
// is what authorizes the write, exactly as in tiktok-oauth-callback.
//
// WHAT IS DIFFERENT FROM EVERY OTHER AD PLATFORM: the region. Amazon Ads has
// three independent API hosts and a profile exists in exactly one of them, so
// "which accounts can this authorization reach" cannot be answered by one
// call. All three are asked, and each profile is stored with the region that
// answered for it -- that pair, profile plus region, is what the nightly sync
// needs to make a single request. A region that answers 401/403 is not an
// error: it means this advertiser simply has no accounts there, which is the
// normal case for a seller in one marketplace.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLIENT_ID = Deno.env.get('AMAZON_ADS_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('AMAZON_ADS_CLIENT_SECRET') ?? '';
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/amazon-oauth-callback';

// Amazon's LwA token endpoint is not region-specific ("you can create, verify,
// and refresh tokens using any regional LWA endpoint"); the ADS hosts below
// are. Keep this list in step with AMAZON_ADS_HOSTS in
// scripts/lib/ad-platforms-sync-core.mjs, which the nightly sync reads.
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const ADS_HOSTS: Record<string, string> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};

type Profile = {
  profile_id: string;
  region: string;
  country_code: string | null;
  currency_code: string | null;
  timezone: string | null;
  account_name: string | null;
  account_type: string | null;
};

/** Every profile this access token can reach, across all three regions.
 *
 * A region that refuses is skipped rather than failing the connection: an
 * advertiser with no European accounts gets a 401 or an empty list from the
 * EU host, and that is an answer, not a fault. Only a grant that reaches NO
 * profile anywhere is a problem worth reporting, and the caller decides that.
 */
async function listProfiles(accessToken: string): Promise<{ profiles: Profile[]; errors: string[] }> {
  const profiles: Profile[] = [];
  const errors: string[] = [];
  for (const [region, host] of Object.entries(ADS_HOSTS)) {
    try {
      const res = await fetch(`${host}/v2/profiles`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': CLIENT_ID,
        },
      });
      if (!res.ok) {
        errors.push(`${region} ${res.status}`);
        continue;
      }
      const list = await res.json();
      if (!Array.isArray(list)) {
        errors.push(`${region} unexpected body`);
        continue;
      }
      for (const p of list) {
        const info = (p?.accountInfo ?? {}) as Record<string, unknown>;
        if (p?.profileId == null) continue;
        profiles.push({
          profile_id: String(p.profileId),
          region,
          country_code: p.countryCode == null ? null : String(p.countryCode),
          currency_code: p.currencyCode == null ? null : String(p.currencyCode),
          timezone: p.timezone == null ? null : String(p.timezone),
          // Amazon's own spec says name is "not currently populated for
          // sellers", so a nameless profile is expected and the picker falls
          // back to country and id rather than showing a blank row.
          account_name: info.name == null ? null : String(info.name),
          account_type: info.type == null ? null : String(info.type),
        });
      }
    } catch (err) {
      errors.push(`${region} ${String((err as Error)?.message ?? err).slice(0, 80)}`);
    }
  }
  return { profiles, errors };
}

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');

  const errorRedirect = (msg: string) =>
    Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  // Amazon reports a declined consent screen as error/error_description, and
  // sends no code. Saying "declined" beats "missing_params", which reads like
  // a SILO bug for something the person chose.
  if (params.get('error')) return errorRedirect(`amazon_declined: ${params.get('error')}`);
  if (!code || !state) return errorRedirect('missing_params');
  if (!CLIENT_ID || !CLIENT_SECRET) return errorRedirect('server_misconfigured');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Consume the state in ONE statement, scoped to this platform: a read-then-
  // delete lets two callbacks race on one nonce, and an unscoped read would
  // accept a Google, Meta or TikTok state here.
  const { data: consumed, error: stateErr } = await supabase
    .from('ad_platform_oauth_states')
    .delete()
    .eq('nonce', state)
    .eq('platform', 'amazon_ads')
    .gt('expires_at', new Date().toISOString())
    .select('*');

  if (stateErr || !Array.isArray(consumed) || consumed.length !== 1) {
    return errorRedirect('invalid_or_expired_state');
  }
  const stateRow = consumed[0];

  // redirect_uri must match the one the authorize request carried, byte for
  // byte, or Amazon refuses the exchange.
  const tokenRes = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URL,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  if (!tokenRes.ok) return errorRedirect('token_exchange_failed');
  const tokenJson = await tokenRes.json();
  const accessToken: string = tokenJson?.access_token;
  const refreshToken: string = tokenJson?.refresh_token;
  if (!accessToken) return errorRedirect('no_access_token');
  // The refresh token is the durable credential -- Amazon's access tokens last
  // an hour, and the nightly sync mints a fresh one from the refresh token on
  // every run. A grant that returns none would test fine today and stop
  // syncing within the hour, so it is refused here, where it can still be
  // explained, rather than silently.
  if (!refreshToken) return errorRedirect('no_refresh_token');

  const { profiles, errors } = await listProfiles(accessToken);
  if (!profiles.length) {
    // The grant is real but reaches no advertising account. That is a fact
    // about the Amazon account, not a SILO failure, and the person needs to
    // hear which thing to fix.
    return errorRedirect(
      `no_amazon_ads_profiles${errors.length ? `: ${errors.join(', ')}` : ''}`,
    );
  }

  const only = profiles.length === 1 ? profiles[0] : null;

  const { data: inserted, error: insertErr } = await supabase.from('ad_platform_connections').insert({
    company_entity_id: stateRow.company_entity_id,
    platform: 'amazon_ads',
    display_name: only?.account_name || 'Amazon Ads account',
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: new Date(Date.now() + (Number(tokenJson?.expires_in) || 3600) * 1000).toISOString(),
    // The profile is NOT chosen here, even when the grant names exactly one.
    // Integrations' account picker makes that choice on the way back, and
    // choosing is what switches the nightly sync on and queues the first
    // import. A row that arrived with its profile already filled in would
    // skip both and sit there testing OK while importing nothing.
    amazon_profile_id: null,
    amazon_region: null,
    is_active: true,
    sync_enabled: false,
    created_by: stateRow.user_id,
    meta: { amazon_profiles: profiles, ...(errors.length ? { profile_list_errors: errors } : {}) },
  }).select('id').single();

  if (insertErr || !inserted) return errorRedirect(`save_failed: ${insertErr?.message ?? 'no row'}`);

  // The id lets Integrations act on exactly this row, never on another Amazon
  // row of whichever workspace the tab has open now.
  return Response.redirect(
    `${SILO_APP_URL}/v2/integrations.html?oauth_connected=1&platform=amazon_ads&connection_id=${encodeURIComponent(inserted.id)}`,
    302,
  );
});
