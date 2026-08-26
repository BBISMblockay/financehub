// PUBLIC (deploy with verify_jwt off): Intuit redirects the browser here after
// consent. The single-use nonce in `state` is what authenticates the round
// trip -- it carries the company and user we started with.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CALLBACK_URL =
  'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/quickbooks-oauth-callback';
const SILO_APP_URL =
  Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';

// Intuit publishes its OAuth endpoints in a discovery document. Reading them
// from there rather than hardcoding means an endpoint move is picked up instead
// of failing silently. Cached per isolate; if discovery is unreachable we fall
// back to the currently published values, so a discovery outage degrades to
// today's behaviour rather than breaking the integration.
const DISCOVERY_URL = (env: string) =>
  env === 'production'
    ? 'https://developer.api.intuit.com/.well-known/openid_configuration'
    : 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration';

const FALLBACK_ENDPOINTS = {
  authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
  token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
};

const _discovery = new Map<string, typeof FALLBACK_ENDPOINTS>();

async function endpoints(env: string): Promise<typeof FALLBACK_ENDPOINTS> {
  const cached = _discovery.get(env);
  if (cached) return cached;

  try {
    const res = await fetch(DISCOVERY_URL(env), { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const doc = await res.json();
      const resolved = {
        authorization_endpoint: doc.authorization_endpoint
          ?? FALLBACK_ENDPOINTS.authorization_endpoint,
        token_endpoint: doc.token_endpoint ?? FALLBACK_ENDPOINTS.token_endpoint,
      };
      _discovery.set(env, resolved);
      return resolved;
    }
  } catch {
    // Discovery is an optimisation, never a hard dependency.
  }

  return FALLBACK_ENDPOINTS;
}

// Intuit stamps a trace id on every response. Carrying it into the error we
// store means their support can locate the exact request, instead of us trying
// to reproduce a month-end failure after the fact.
const tid = (res: Response) => {
  const t = res.headers.get('intuit_tid');
  return t ? ` [intuit_tid: ${t}]` : '';
};

// ONE key pair. QBO_ENVIRONMENT declares which Intuit environment those keys
// belong to -- sandbox or production -- because a client id does not say so
// itself. Moving to production means overwriting the two secrets and flipping
// this one word, rather than carrying a second pair.
//
// The declaration is not decoration: the connection's `environment` picks the
// API host independently of the keys, so production keys aimed at the sandbox
// host (or the reverse) fail as an opaque token error. Every entry point below
// refuses that mismatch by name instead.
const configuredEnv = () =>
  Deno.env.get('QBO_ENVIRONMENT') === 'production' ? 'production' : 'sandbox';

const CLIENT_ID = () => Deno.env.get('QBO_CLIENT_ID') ?? '';
const CLIENT_SECRET = () => Deno.env.get('QBO_CLIENT_SECRET') ?? '';

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
  const clientId = CLIENT_ID();
  const clientSecret = CLIENT_SECRET();
  if (!clientId || !clientSecret) {
    return errorRedirect('QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured');
  }
  // The keys could have been flipped to the other environment mid-handshake.
  if (env !== configuredEnv()) {
    return errorRedirect(
      `environment_changed: this connect started for ${env} but QBO_ENVIRONMENT is now ${configuredEnv()}`,
    );
  }

  const { token_endpoint } = await endpoints(env);
  const tokenRes = await fetch(token_endpoint, {
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
    return errorRedirect(`token_exchange_failed: ${detail.slice(0, 180)}${tid(tokenRes)}`);
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
