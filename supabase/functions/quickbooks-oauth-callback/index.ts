// PUBLIC (deploy with verify_jwt off): Intuit redirects the browser here after
// consent. The single-use nonce in `state` is what authenticates the round
// trip -- it carries the company and user we started with.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CALLBACK_URL =
  'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/quickbooks-oauth-callback';
const SILO_APP_URL =
  Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';

// One token endpoint for both environments -- only the API host differs.
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

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

const apiBase = (env: string) =>
  env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');

  const errorRedirect = (msg: string) =>
    Response.redirect(
      `${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`,
      302,
    );

  if (url.searchParams.get('error')) {
    return errorRedirect(url.searchParams.get('error') as string);
  }
  if (!code || !state || !realmId) return errorRedirect('missing_code_state_or_realm');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: stateRow, error: stateErr } = await supabase
    .from('quickbooks_oauth_states')
    .select('company_entity_id, user_id, environment')
    .eq('nonce', state)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateErr || !stateRow) return errorRedirect('invalid_or_expired_state');

  // One-time use: burn the nonce before doing anything else.
  await supabase.from('quickbooks_oauth_states').delete().eq('nonce', state);

  const env = stateRow.environment === 'production' ? 'production' : 'sandbox';
  const { id: clientId, secret: clientSecret } = creds(env);
  if (!clientId || !clientSecret) return errorRedirect(credsMissing(env));

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URL,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    return errorRedirect(`token_exchange_failed: ${detail.slice(0, 180)}`);
  }

  const tok = await tokenRes.json();
  if (!tok.access_token || !tok.refresh_token) return errorRedirect('no_tokens_returned');

  const now = Date.now();
  // expires_in is seconds (3600); x_refresh_token_expires_in is the ~100-day
  // refresh window. Both are recorded so the sync can tell "needs refresh"
  // from "needs a human to reconnect".
  const tokenExpiresAt = new Date(now + Number(tok.expires_in ?? 3600) * 1000).toISOString();
  const refreshExpiresAt = new Date(
    now + Number(tok.x_refresh_token_expires_in ?? 8726400) * 1000,
  ).toISOString();

  // Company name is cosmetic, so a failure here must not fail the connect.
  let companyName: string | null = null;
  try {
    const infoRes = await fetch(
      `${apiBase(env)}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`,
      { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } },
    );
    if (infoRes.ok) {
      const info = await infoRes.json();
      companyName = info?.CompanyInfo?.CompanyName ?? null;
    }
  } catch { /* cosmetic only */ }

  const { error: upsertErr } = await supabase
    .from('quickbooks_connections')
    .upsert({
      company_entity_id: stateRow.company_entity_id,
      realm_id: realmId,
      company_name: companyName,
      environment: env,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_expires_at: tokenExpiresAt,
      refresh_token_expires_at: refreshExpiresAt,
      is_active: true,
      last_tested_at: new Date().toISOString(),
      last_test_status: 'connected',
      last_test_success: true,
      last_test_error: null,
      created_by: stateRow.user_id,
      updated_by: stateRow.user_id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_entity_id,realm_id' });

  if (upsertErr) return errorRedirect(`save_failed: ${upsertErr.message}`);

  return Response.redirect(`${SILO_APP_URL}/v2/integrations.html?qbo_connected=1`, 302);
});
