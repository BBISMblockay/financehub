// amazon-oauth-start -- mint the CSRF nonce and the Login-with-Amazon
// authorize URL for a new Amazon Ads connection, from /v2/integrations.html.
//
// Login with Amazon, not an Amazon-Ads-specific OAuth: the Ads API is
// authorized through an LwA security profile, and Amazon's own LwA docs state
// that applications are NOT region-specific -- one authorize host and one
// token host serve all three Ads regions. Which REGION a profile lives in is
// discovered after the grant, by asking all three Ads hosts which profiles
// this authorization can reach (amazon-oauth-callback).
//
// Shape, gates and ordering are tiktok-oauth-start's, deliberately: the CSRF
// state table, the mayConnect admin check (this runs with the service role,
// so RLS is not doing it, and the callback trusts the state's company), the
// integration-token gate and the two-step-login gate. The one addition is the
// GET availability probe, which klaviyo-oauth-start introduced for the same
// reason it is needed here: a workspace whose deployment has no Amazon LwA
// client registered must not be shown a Connect button that can only fail.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mayConnect } from './google-oauth-lib.mjs';
import { checkMfaSession } from './mfa-gate.mjs';
import { checkIntegrationToken } from './integration-gate.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = Deno.env.get('AMAZON_ADS_CLIENT_ID') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/amazon-oauth-callback';

// Read-only reporting and campaign reads. Amazon publishes no narrower
// reporting-only scope: campaign_management is the scope the Sponsored Ads
// reporting endpoints are served under, and SILO only ever GETs reports and
// POSTs report REQUESTS with it -- it creates and changes nothing in the
// advertiser's account.
const SCOPE = 'advertising::campaign_management';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  if (!CLIENT_ID && req.method !== 'GET') {
    return json({ error: 'AMAZON_ADS_CLIENT_ID not configured' }, 500);
  }

  // Third-party tokens (20261020030000): everything below runs with the
  // service role, which the Data API's pre-request hook never sees. This
  // check is pure, so it comes before the network round trip the two-step
  // gate makes. See supabase/functions/CLAUDE.md.
  const integ = checkIntegrationToken(req.headers.get('Authorization'));
  if (!integ.ok) return json({ error: integ.message, code: integ.code }, integ.status);

  // The availability probe: one boolean about this DEPLOYMENT's own
  // configuration. It creates no state, issues no authorize URL and names no
  // company, so it stops short of the MFA gate rather than spending a step to
  // learn nothing.
  if (req.method === 'GET') return json({ configured: Boolean(CLIENT_ID) });

  // Two-step login: what follows runs with the service role, which the Data
  // API's gate (20261014000000) never sees. mfa-gate.mjs asks as the caller.
  const mfa = await checkMfaSession({
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
    authorization: req.headers.get('Authorization'),
  });
  if (!mfa.ok) return json({ error: mfa.message, code: mfa.code }, mfa.status);

  const { company_entity_id } = await req.json();
  if (!company_entity_id) return json({ error: 'company_entity_id required' }, 400);

  // Verify the caller administers the company they named rather than trusting
  // the id the browser sent: this function runs with the service-role key, so
  // RLS is not doing it. Same rule as the Google, Meta, TikTok, Shopify and
  // QuickBooks start functions. The callback trusts the state's company, so
  // this is the only gate.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, active_company_id, is_active')
    .eq('id', user.id)
    .maybeSingle();
  const { data: membership, error: membershipError } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', company_entity_id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!mayConnect({ profile, profileError, membership, membershipError, companyId: company_entity_id })) {
    return json({ error: 'Admin access required for this company' }, 403);
  }

  const nonce = crypto.randomUUID();

  const { error: stateErr } = await supabase.from('ad_platform_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    platform: 'amazon_ads',
  });
  if (stateErr) return json({ error: stateErr.message }, 500);

  const authorizeUrl = 'https://www.amazon.com/ap/oa?' + new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: CALLBACK_URL,
    state: nonce,
  }).toString();

  return json({ url: authorizeUrl });
});
