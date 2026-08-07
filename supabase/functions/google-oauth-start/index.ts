import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/google-oauth-callback';

// Same Google Cloud OAuth client covers both platforms — only the scope
// differs. Google Ads needs the `adwords` scope; GA4 reads use the
// analytics.readonly scope. access_type=offline + prompt=consent guarantee
// a refresh_token comes back even on a repeat authorization by the same
// Google account (Google otherwise omits it after the first consent).
const SCOPES: Record<string, string> = {
  google_ads: 'https://www.googleapis.com/auth/adwords',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
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
    redirect_uri: CALLBACK_URL,
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
