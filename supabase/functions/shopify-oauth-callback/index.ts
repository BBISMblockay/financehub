import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appCredentials, normalizeShopDomain, verifyOAuthHmac } from './shopify-auth-lib.mjs';

const ENV = {
  SHOPIFY_PUBLIC_CLIENT_ID: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_ID'),
  SHOPIFY_PUBLIC_CLIENT_SECRET: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_SECRET'),
  SHOPIFY_CLIENT_ID: Deno.env.get('SHOPIFY_CLIENT_ID'),
  SHOPIFY_CLIENT_SECRET: Deno.env.get('SHOPIFY_CLIENT_SECRET'),
};
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://silo-baseballism.com';
const API_VERSION = '2025-01';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  const code  = params.get('code');
  const shop  = normalizeShopDomain(params.get('shop'));
  const state = params.get('state');
  const hmac  = params.get('hmac');

  const errorRedirect = (msg: string) =>
    Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  if (!code || !shop || !state || !hmac) return errorRedirect('missing_params');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // The state row says which of SILO's two Shopify apps started this flow, and
  // so which secret signed the callback and must exchange the code. It is read
  // BEFORE the signature is checked only to choose the secret; nothing is
  // acted on until the signature verifies.
  const { data: stateRow, error: stateErr } = await supabase
    .from('shopify_oauth_states')
    .select('*')
    .eq('nonce', state)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateErr || !stateRow) return errorRedirect('invalid_or_expired_state');

  const creds = appCredentials(ENV, stateRow.oauth_app);
  if (!creds) return errorRedirect('server_misconfigured');

  const valid = await verifyOAuthHmac(params, creds.clientSecret);
  if (!valid) return errorRedirect('invalid_hmac');

  await supabase.from('shopify_oauth_states').delete().eq('nonce', state);

  if (stateRow.shop_domain !== shop) return errorRedirect('shop_mismatch');

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
  });

  if (!tokenRes.ok) return errorRedirect('token_exchange_failed');
  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  if (!accessToken) return errorRedirect('no_access_token');

  const shopRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/shop.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });
  const shopJson = shopRes.ok ? await shopRes.json() : {};
  const shopInfo = shopJson.shop ?? {};

  const scopesGranted: string[] = (tokenData.scope ?? '').split(',').filter(Boolean);

  const { error: upsertErr } = await supabase
    .from('shopify_connections')
    .upsert({
      company_entity_id: stateRow.company_entity_id,
      shop_domain: shop,
      access_token: accessToken,
      // An OAuth token does not expire; clearing these also turns a store
      // that was on client credentials into a plain OAuth connection.
      auth_method: 'oauth',
      oauth_app: creds.app,
      token_expires_at: null,
      shop_name: shopInfo.name ?? null,
      shop_currency: shopInfo.currency ?? null,
      scopes_granted: scopesGranted,
      scopes_missing: [],
      scopes_checked_at: new Date().toISOString(),
      last_tested_at: new Date().toISOString(),
      last_test_status: 'ok',
      last_test_success: true,
      is_active: true,
      sync_enabled: false,
      created_by: stateRow.user_id,
    }, { onConflict: 'company_entity_id,shop_domain' });

  if (upsertErr) return errorRedirect(`save_failed: ${upsertErr.message}`);

  return Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_connected=1`, 302);
});
