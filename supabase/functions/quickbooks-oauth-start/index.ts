// Begins the QuickBooks Online OAuth handshake: mints a single-use CSRF nonce
// and hands the browser Intuit's consent URL. The realm (QBO company) is NOT
// chosen here -- Intuit's consent screen lets the user pick which company to
// grant, and returns its realmId to the callback.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CALLBACK_URL =
  'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/quickbooks-oauth-callback';

// Accounting scope covers the chart of accounts, reports, and JournalEntry.
// com.intuit.quickbooks.payment is deliberately NOT requested -- SILO has no
// reason to move money through Intuit.
const SCOPES = 'com.intuit.quickbooks.accounting';

// Sandbox and production are DIFFERENT Intuit key pairs on the same app -- a
// Development client id cannot mint a token for a production company, and vice
// versa. Pick the pair from the environment rather than assuming one, and say
// which pair is missing so a misconfiguration is self-diagnosing.
function creds(env: string): { id: string; secret: string } {
  return env === 'production'
    ? {
      id: Deno.env.get('QBO_CLIENT_ID_PROD') ?? '',
      secret: Deno.env.get('QBO_CLIENT_SECRET_PROD') ?? '',
    }
    : {
      id: Deno.env.get('QBO_CLIENT_ID') ?? '',
      secret: Deno.env.get('QBO_CLIENT_SECRET') ?? '',
    };
}

const credsMissing = (env: string) =>
  env === 'production'
    ? 'QBO_CLIENT_ID_PROD / QBO_CLIENT_SECRET_PROD not configured'
    : 'QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const { company_entity_id, environment } = await req.json().catch(() => ({}));
  if (!company_entity_id) return json({ error: 'company_entity_id required' }, 400);

  const env = environment === 'production' ? 'production' : 'sandbox';
  const { id: clientId } = creds(env);
  if (!clientId) return json({ error: credsMissing(env) }, 500);

  // Verify the caller actually administers the company they named, rather
  // than trusting the id the browser sent. This function runs with the
  // service-role key, so RLS is not doing it for us.
  const { data: membership } = await supabase
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', company_entity_id)
    .eq('user_id', user.id)
    .maybeSingle();

  let allowed = membership
    ? ['owner_admin', 'admin'].includes(membership.role)
    : false;

  // Profile-role fallback for users with no membership row, matching the
  // is_admin_user() precedence documented in CLAUDE.md.
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

  if (!allowed) return json({ error: 'Admin access required for this company' }, 403);

  const nonce = crypto.randomUUID();
  const { error: stateErr } = await supabase.from('quickbooks_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    environment: env,
  });
  if (stateErr) return json({ error: stateErr.message }, 500);

  const authorizeUrl = 'https://appcenter.intuit.com/connect/oauth2?' + new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: CALLBACK_URL,
    state: nonce,
  }).toString();

  return json({ url: authorizeUrl });
});
