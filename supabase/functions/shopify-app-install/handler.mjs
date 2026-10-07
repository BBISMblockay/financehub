// Shopify-initiated install of SILO's PUBLIC app: the App URL and its OAuth
// callback. PUBLIC (verify_jwt off): Shopify's signature is the only
// authentication, and nothing is trusted before it verifies.
//
//   launch   (?shop&hmac&timestamp[&host]) -> verify -> start OAuth at once
//   callback (?code&state&shop&hmac...)    -> verify -> exchange -> park the
//            token under a one-time claim -> /v2/shopify-install.html#claim=
//
// Design and the reasons for each step: scripts/lib/shopify-install-lib.mjs.
// The handler takes its collaborators as arguments so node can execute it
// (scripts/tests/shopify-install.test.mjs); index.ts wires the real ones.
import { normalizeShopDomain, verifyOAuthHmac, PUBLIC_SCOPES } from './shopify-auth-lib.mjs';
import {
  installRequestKind, launchIsFresh, newClaimToken, hashClaim, claimRedirect, errorRedirect,
} from './shopify-install-lib.mjs';

/** How long a parked install waits for an admin to claim it. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function createInstallHandler({ env, db, fetchImpl, now = () => Date.now() }) {
  const clientId = env.SHOPIFY_PUBLIC_CLIENT_ID;
  const clientSecret = env.SHOPIFY_PUBLIC_CLIENT_SECRET;
  const appUrl = env.SILO_APP_URL || 'https://silo-baseballism.com';
  const selfUrl = env.SHOPIFY_INSTALL_CALLBACK_URL;
  const apiVersion = env.SHOPIFY_API_VERSION || '2025-01';
  const go = (location) => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  const fail = (code) => go(errorRedirect(appUrl, code));

  return async function handle(req) {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (!clientId || !clientSecret || !selfUrl) return fail('not_configured');

    const params = new URL(req.url).searchParams;
    const kind = installRequestKind(params);
    if (kind === 'invalid') return fail('invalid_request');
    const shop = normalizeShopDomain(params.get('shop'));
    if (!shop) return fail('invalid_request');
    // Nothing below this line runs for a request Shopify did not sign.
    if (!(await verifyOAuthHmac(params, clientSecret))) return fail('invalid_signature');

    // Opportunistic tidy; a failure here never blocks an install.
    try { await db.rpc('shopify_purge_expired_installs'); } catch { /* ignore */ }

    if (kind === 'launch') {
      if (!launchIsFresh(params.get('timestamp'), now())) return fail('stale_launch');
      const nonce = crypto.randomUUID();
      const { error } = await db.from('shopify_install_states').insert({ nonce, shop_domain: shop });
      if (error) return fail('save_failed');
      const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('scope', PUBLIC_SCOPES.join(','));
      authorize.searchParams.set('redirect_uri', selfUrl);
      authorize.searchParams.set('state', nonce);
      return go(authorize.toString());
    }

    // callback
    // Consume the state in ONE statement and continue only if this request
    // is the one that deleted it: a separate read and delete would let a
    // failed delete, or a second request racing the first, exchange again.
    const { data: consumed, error: consumeErr } = await db.from('shopify_install_states')
      .delete().eq('nonce', params.get('state')).gt('expires_at', new Date(now()).toISOString())
      .select('nonce, shop_domain');
    if (consumeErr || !Array.isArray(consumed) || consumed.length !== 1) return fail('invalid_or_expired_state');
    const stateRow = consumed[0];
    if (stateRow.shop_domain !== shop) return fail('shop_mismatch');

    let tokenData;
    try {
      const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: params.get('code') }),
      });
      if (!res.ok) return fail('token_exchange_failed');
      tokenData = await res.json();
    } catch { return fail('token_exchange_failed'); }
    const accessToken = tokenData?.access_token;
    if (!accessToken) return fail('token_exchange_failed');

    let shopInfo = {};
    try {
      const res = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/shop.json`, {
        headers: { 'X-Shopify-Access-Token': accessToken },
      });
      if (res.ok) shopInfo = (await res.json())?.shop ?? {};
    } catch { /* the name is cosmetic; the install still proceeds */ }

    const claim = newClaimToken();
    // One parked token per store, newest wins (shop_domain is unique): a
    // reinstall replaces the earlier token, so an older claim link cannot
    // later write a revoked token over the live one.
    const { error: parkErr } = await db.from('shopify_pending_installs').upsert({
      claim_hash: await hashClaim(claim),
      shop_domain: shop,
      access_token: accessToken,
      scopes_granted: String(tokenData.scope ?? '').split(',').filter(Boolean),
      shop_name: shopInfo.name ?? null,
      shop_currency: shopInfo.currency ?? null,
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(now() + PENDING_TTL_MS).toISOString(),
    }, { onConflict: 'shop_domain' });
    if (parkErr) return fail('save_failed');
    return go(claimRedirect(appUrl, claim));
  };
}
