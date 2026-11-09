// klaviyo-oauth-start -- begin a Klaviyo OAuth grant for the caller's company.
//
// Klaviyo requires PKCE for confidential clients as well as public ones, and a
// FRESH verifier per authorization request. The verifier is generated here,
// stored in klaviyo_oauth_states (service-role only) and never sent to the
// browser: the browser gets only the authorize URL carrying the S256
// challenge. The authorization code Klaviyo issues expires in 5 minutes, which
// the 10-minute state row always outlives.
//
// Authorize is on www.klaviyo.com; the token exchange in the callback is on
// a.klaviyo.com, because Klaviyo blocked token traffic through www on
// 2025-03-31. Do not "tidy" the two onto one host.
//
// Secrets: KLAVIYO_CLIENT_ID (and KLAVIYO_CLIENT_SECRET in the callback).
// Without them this returns 500 rather than sending the admin to a Klaviyo
// error page.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mayConnect } from './google-oauth-lib.mjs';
import { checkMfaSession } from './mfa-gate.mjs';
import { checkIntegrationToken } from './integration-gate.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = Deno.env.get('KLAVIYO_CLIENT_ID') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/klaviyo-oauth-callback';
const AUTHORIZE_URL = 'https://www.klaviyo.com/oauth/authorize';

// Read-only: this integration reports on Klaviyo, it never sends. Klaviyo
// cannot widen a grant after the fact, so a later write feature means a new
// scope and a re-consent, which is the honest shape.
const SCOPES = [
  'campaigns:read',
  'flows:read',
  'metrics:read',
  'segments:read',
  'lists:read',
  // The account's own name, IANA timezone and preferred currency. Without it
  // SILO has to compute a measurement window in the company's business
  // timezone rather than the Klaviyo account's, and takes the currency of
  // Klaviyo's SMS sending cost on faith -- which it then has to label as
  // assumed wherever the money is shown. Adding it is why an existing
  // connection must re-consent: Klaviyo cannot widen a grant in place.
  'accounts:read',
].join(' ');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/** A PKCE verifier: 43-128 characters from the unreserved set. 32 random
 * bytes base64url-encoded gives 43, the shortest Klaviyo accepts. */
function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

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

  if (!CLIENT_ID && req.method !== 'GET') return json({ error: 'KLAVIYO_CLIENT_ID not configured' }, 500);

  // Third-party tokens (20261020030000): everything below runs with the
  // service role, which the Data API's pre-request hook never sees. This check
  // is pure, so it comes before the network round trip the MFA gate makes.
  const integ = checkIntegrationToken(req.headers.get('Authorization'));
  if (!integ.ok) return json({ error: integ.message, code: integ.code }, integ.status);

  // GET is the availability probe the Integrations page makes on load, so it
  // can hide a "Connect with Klaviyo" button that cannot work. It answers one
  // boolean about this DEPLOYMENT's own configuration: it creates no state,
  // issues no authorize URL and names no company, so it deliberately stops
  // short of the MFA gate rather than spending a step to learn nothing. A
  // workspace with no Klaviyo app registered is the normal case, not an error.
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
  // RLS is not doing it. The callback trusts the state's company, so this is
  // the only gate. Same rule as the Google, Meta, TikTok and Shopify starts.
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
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);

  const { error: stateErr } = await supabase.from('klaviyo_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    code_verifier: verifier,
  });
  if (stateErr) return json({ error: stateErr.message }, 500);

  const authorizeUrl = `${AUTHORIZE_URL}?` + new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: SCOPES,
    state: nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString();

  return json({ url: authorizeUrl });
});
