// klaviyo-oauth-callback -- finish a Klaviyo OAuth grant.
//
// Called by Klaviyo in the admin's browser, so it carries NO Supabase JWT: it
// must be listed in NO_JWT_FUNCTIONS in deploy-edge-function.yml, or it
// rejects Klaviyo's redirect before the handler runs. Everything it trusts
// comes from the single-use state row it consumes, never from the query
// string beyond the code and the nonce.
//
// The token exchange goes to a.klaviyo.com; www.klaviyo.com has been blocked
// for token traffic since 2025-03-31. Basic auth carries the client id and
// secret, and the PKCE verifier comes from the state row.
//
// There is one klaviyo_connections row per company, so a grant for a company
// that already has a row UPDATES it (upsert on company_entity_id) rather than
// leaving two rows fighting over the same tables. Switching a key-based
// connection to OAuth is exactly that case and must keep working.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLIENT_ID = Deno.env.get('KLAVIYO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('KLAVIYO_CLIENT_SECRET') ?? '';
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/klaviyo-oauth-callback';
const TOKEN_URL = 'https://a.klaviyo.com/oauth/token';

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');

  const errorRedirect = (msg: string) =>
    Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  // Klaviyo sends `error` when the admin declines or the request was malformed.
  const denied = params.get('error');
  if (denied) return errorRedirect(`klaviyo_${denied}`);
  if (!code || !state) return errorRedirect('missing_params');
  if (!CLIENT_ID || !CLIENT_SECRET) return errorRedirect('server_misconfigured');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Consume the state in ONE statement: a read-then-delete lets two callbacks
  // race on one nonce. Same shape as the Meta and TikTok callbacks.
  const { data: consumed, error: stateErr } = await supabase
    .from('klaviyo_oauth_states')
    .delete()
    .eq('nonce', state)
    .gt('expires_at', new Date().toISOString())
    .select('*');
  if (stateErr || !Array.isArray(consumed) || consumed.length !== 1) {
    return errorRedirect('invalid_or_expired_state');
  }
  const stateRow = consumed[0];

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: stateRow.code_verifier,
      redirect_uri: CALLBACK_URL,
    }).toString(),
  });

  if (!tokenRes.ok) return errorRedirect('token_exchange_failed');
  const tokenJson = await tokenRes.json().catch(() => null);
  const accessToken: string | undefined = tokenJson?.access_token;
  const refreshToken: string | undefined = tokenJson?.refresh_token;
  if (!accessToken || !refreshToken) return errorRedirect('no_access_token');

  // Klaviyo's access tokens last about an hour, but expires_in is what is
  // authoritative; the sync refreshes on this stamp, not on a constant.
  const expiresIn = Number(tokenJson?.expires_in);
  const expiresAt = new Date(Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000));

  const { data: saved, error: saveErr } = await supabase
    .from('klaviyo_connections')
    .upsert({
      company_entity_id: stateRow.company_entity_id,
      auth_mode: 'oauth',
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expires_at: expiresAt.toISOString(),
      oauth_scope: tokenJson?.scope ?? null,
      // A fresh grant clears any earlier "needs reconnecting" mark; that is
      // exactly what reconnecting means.
      reauth_required_at: null,
      // The key, if there was one, is no longer how this connection
      // authenticates. Leaving it would keep a credential nothing reads.
      api_key: null,
      is_active: true,
      // Connecting is not consent to sync: the admin still has to enable it,
      // and run Test connection so a conversion metric is chosen.
      sync_enabled: false,
      display_name: 'Klaviyo',
      updated_at: new Date().toISOString(),
      created_by: stateRow.user_id,
    }, { onConflict: 'company_entity_id' })
    .select('id')
    .single();

  if (saveErr || !saved) return errorRedirect(`save_failed: ${saveErr?.message ?? 'no row'}`);

  return Response.redirect(
    `${SILO_APP_URL}/v2/integrations.html?oauth_connected=1&platform=klaviyo&connection_id=${encodeURIComponent(saved.id)}`,
    302,
  );
});
