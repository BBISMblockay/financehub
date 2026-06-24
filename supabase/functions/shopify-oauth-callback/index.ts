import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLIENT_ID = Deno.env.get('SHOPIFY_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '';
const SILO_APP_URL = Deno.env.get('SILO_APP_URL') ?? 'https://bbismblockay.github.io/financehub';
const API_VERSION = '2025-01';

async function verifyHmac(params: URLSearchParams, hmac: string): Promise<boolean> {
  const pairs: string[] = [];
  params.forEach((v, k) => {
    if (k !== 'hmac') pairs.push(`${k}=${v}`);
  });
  pairs.sort();
  const message = pairs.join('&');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CLIENT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return computed === hmac;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  const code  = params.get('code');
  const shop  = params.get('shop');
  const state = params.get('state');
  const hmac  = params.get('hmac');

  const errorRedirect = (msg: string) =>
    Response.redirect(`${SILO_APP_URL}/v2/integrations.html?oauth_error=${encodeURIComponent(msg)}`, 302);

  if (!code || !shop || !state || !hmac) return errorRedirect('missing_params');
  if (!CLIENT_ID || !CLIENT_SECRET) return errorRedirect('server_misconfigured');

  // Verify HMAC
  const valid = await verifyHmac(params, hmac);
  if (!valid) return errorRedirect('invalid_hmac');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Look up + consume state (CSRF check)
  const { data: stateRow, error: stateErr } = await supabase
    .from('shopify_oauth_states')
    .select('*')
    .eq('nonce', state)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateErr || !stateRow) return errorRedirect('invalid_or_expired_state');

  // Delete immediately (one-time use)
  await supabase.from('shopify_oauth_states').delete().eq('nonce', state);

  // Ensure the shop matches what we started with
  if (stateRow.shop_domain !== shop) return errorRedirect('shop_mismatch');

  // Exchange code for access token
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
  });

  if (!tokenRes.ok) return errorRedirect('token_exchange_failed');
  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  if (!accessToken) return errorRedirect('no_access_token');

  // Fetch shop info
  const shopRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/shop.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });
  const shopJson = shopRes.ok ? await shopRes.json() : {};
  const shopInfo = shopJson.shop ?? {};

  // Parse scopes granted
  const scopesGranted: string[] = (tokenData.scope ?? '').split(',').filter(Boolean);

  // Upsert into shopify_connections
  const { error: upsertErr } = await supabase
    .from('shopify_connections')
    .upsert({
      company_entity_id: stateRow.company_entity_id,
      shop_domain: shop,
      access_token: accessToken,
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
