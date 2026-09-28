// Connect a Shopify store through the store's OWN Dev Dashboard app.
//
// For a store SILO's Shopify app cannot install on (anything outside
// Baseballism's Shopify organization until the public app is approved), and
// which can no longer make a "Develop apps" custom app (Shopify ended those on
// 2026-01-01). The store owner creates an app in the Dev Dashboard, in THEIR
// organization, installs it on their store and gives SILO its client id and
// secret. SILO mints a 24-hour token with the client-credentials grant, which
// Shopify allows only when app and store share an organization.
//
// Safe by construction:
//   - The caller must administer the company they name, with an ACTIVE
//     account (mayConnect -- the google-oauth-start rule). The function runs
//     with the service role, so RLS is not doing this.
//   - Nothing is saved until Shopify has accepted the pair: the mint IS the
//     validation, so a typo never leaves a connection that fails every night.
//   - The secret goes only into shopify_client_credentials (service role
//     only); shopify_connections, which every member can read, never holds it.
//   - A store already connected another way is refused, not overwritten --
//     swapping how a working store authenticates is a deliberate removal.
//   - If the credential row cannot be written, the connection just created is
//     deleted again, so no connection exists without its credentials.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mayConnect, mintClientCredentialsToken, normalizeShopDomain, ShopifyTokenError } from './shopify-auth-lib.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const companyId = String(body?.company_entity_id ?? '').trim();
  const shop = normalizeShopDomain(body?.shop_domain);
  const clientId = String(body?.client_id ?? '').trim();
  const clientSecret = String(body?.client_secret ?? '').trim();
  if (!companyId) return json({ ok: false, error: 'company_entity_id required' }, 400);
  if (!shop) return json({ ok: false, error: 'Enter the store\'s myshopify.com address, e.g. your-store.myshopify.com' }, 400);
  if (!clientId || !clientSecret) return json({ ok: false, error: 'Client ID and client secret are both required' }, 400);

  const { data: profile, error: profileError } = await admin
    .from('profiles').select('role, active_company_id, is_active').eq('id', user.id).maybeSingle();
  const { data: membership, error: membershipError } = await admin
    .from('entity_memberships').select('role').eq('entity_id', companyId).eq('user_id', user.id).maybeSingle();
  if (!mayConnect({ profile, profileError, membership, membershipError, companyId })) {
    return json({ ok: false, error: 'Admin access required for this company' }, 403);
  }

  // Shopify decides whether the pair is good -- before anything is written.
  let minted;
  try {
    minted = await mintClientCredentialsToken({ shop, clientId, clientSecret });
  } catch (err) {
    const e = err as ShopifyTokenError;
    return json({ ok: false, error: e.message ?? String(err), same_org_refusal: Boolean(e.sameOrgRefusal) }, 400);
  }

  // The token and the credentials that renew it are written in ONE
  // transaction (shopify_save_client_credentials_connection): a token from a
  // new app beside an old app's secret works until the next refresh and then
  // fails, so they can never be saved apart. The function refuses a store
  // already connected another way.
  const { data: saved, error: saveErr } = await admin.rpc('shopify_save_client_credentials_connection', {
    p_company: companyId,
    p_shop: shop,
    p_client_id: clientId,
    p_client_secret: clientSecret,
    p_access_token: minted.accessToken,
    p_expires_at: minted.expiresAt,
    p_user: user.id,
  });
  if (saveErr && /not_client_credentials/.test(saveErr.message ?? '')) {
    return json({
      ok: false,
      error: `${shop} is already connected another way. Remove that connection first if you want to switch it to this app.`,
    }, 409);
  }
  const connectionId = Array.isArray(saved) ? saved[0]?.connection_id : saved?.connection_id;
  if (saveErr || !connectionId) {
    return json({ ok: false, error: `Save failed: ${saveErr?.message ?? 'no row'}` }, 500);
  }

  return json({ ok: true, connection_id: connectionId, shop_domain: shop, scopes: minted.scopes });
});
