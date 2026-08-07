import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const APP_ID = Deno.env.get('TIKTOK_APP_ID') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/tiktok-oauth-callback';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!APP_ID) {
    return new Response(JSON.stringify({ error: 'TIKTOK_APP_ID not configured' }), {
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

  const { company_entity_id } = await req.json();
  if (!company_entity_id) {
    return new Response(JSON.stringify({ error: 'company_entity_id required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const nonce = crypto.randomUUID();

  const { error: stateErr } = await supabase.from('ad_platform_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    platform: 'tiktok_ads',
  });

  if (stateErr) {
    return new Response(JSON.stringify({ error: stateErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authorizeUrl = `https://business-api.tiktok.com/portal/auth?` + new URLSearchParams({
    app_id: APP_ID,
    redirect_uri: CALLBACK_URL,
    state: nonce,
  }).toString();

  return new Response(JSON.stringify({ url: authorizeUrl }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
