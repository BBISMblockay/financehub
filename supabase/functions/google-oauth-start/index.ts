import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseOrigins, pickOrigin, returnUrl } from './google-oauth-lib.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/google-oauth-callback';
// Set together with the SILO Google client's keys; see google-oauth-lib.mjs.
const REDIRECT_ORIGINS = parseOrigins(Deno.env.get('GOOGLE_OAUTH_REDIRECT_ORIGINS'));

// One Google Cloud OAuth client covers every Google platform here — only the
// scope differs. access_type=offline + prompt=consent guarantee a
// refresh_token comes back even on a repeat authorization by the same Google
// account (Google otherwise omits it after the first consent).
//
// An EXISTING refresh token does not carry a newly added scope: a connection
// authorized before a scope was listed here keeps working for what it was
// granted and returns 403 for anything else. Adding a platform therefore
// needs one fresh consent round-trip per connection, not just this line.
const SCOPES: Record<string, string> = {
  google_ads: 'https://www.googleapis.com/auth/adwords',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  // webmasters.readonly is read-only Search Console (performance data + the
  // verified-site list). The read-only variant is the whole grant we want —
  // the writable `webmasters` scope additionally permits submitting sitemaps
  // and adding/removing properties, none of which SILO does.
  search_console: 'https://www.googleapis.com/auth/webmasters.readonly',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!CLIENT_ID) {
    return new Response(JSON.stringify({ error: 'GOOGLE_CLIENT_ID not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { company_entity_id, platform } = await req.json();
  if (!company_entity_id || !platform) {
    return new Response(JSON.stringify({ error: 'company_entity_id and platform required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const scope = SCOPES[platform];
  if (!scope) {
    return new Response(JSON.stringify({ error: `Unsupported platform: ${platform}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Verify the caller administers the company they named rather than trusting
  // the id the browser sent: this function runs with the service-role key, so
  // RLS is not doing it. Same rule as quickbooks-oauth-start.
  const { data: membership } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', company_entity_id)
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
      && profile.active_company_id === company_entity_id
      && ['owner', 'admin', 'executive'].includes(String(profile.role));
  }
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Admin access required for this company' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Google must send the person back to an address the client lists. With
  // REDIRECT_ORIGINS set, that is the return page on the site they clicked
  // Connect on; otherwise the legacy callback URL.
  const origin = pickOrigin(req.headers.get('Origin'), REDIRECT_ORIGINS);
  const redirectUri = origin ? returnUrl(origin) : CALLBACK_URL;

  const nonce = crypto.randomUUID();

  const { error: stateErr } = await supabase.from('ad_platform_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    platform,
  });

  if (stateErr) {
    return new Response(JSON.stringify({ error: stateErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: nonce,
  }).toString();

  return new Response(JSON.stringify({ url: authorizeUrl }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
