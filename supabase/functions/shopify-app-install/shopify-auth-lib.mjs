// Shopify authorization rules shared by every place SILO talks to Shopify:
// the OAuth start/callback, the Dev Dashboard connect function, the privacy
// (GDPR) webhook, the Test button and every sync entry point.
//
// One file, copied BYTE-IDENTICAL into each function directory that needs it
// (each edge function deploys its own directory) and into scripts/lib for the
// node syncs. scripts/tests/shopify-auth.test.mjs fails if any copy drifts.
// Pure: no Deno or node globals beyond fetch and Web Crypto, both present in
// Node 18+ and in Deno.
//
// THREE WAYS A SHOPIFY CONNECTION GETS ITS TOKEN (shopify_connections.auth_method):
//   'oauth'              Connect with Shopify -- an offline token that never
//                        expires, issued to one of SILO's two Shopify apps.
//   'manual_token'       a shpat_ token pasted from a legacy custom app. Shopify
//                        stopped letting stores create those on 2026-01-01;
//                        existing ones keep working.
//   'client_credentials' the store's own Dev Dashboard app. SILO holds its
//                        client id + secret (shopify_client_credentials,
//                        service role only) and mints a 24-hour token, which
//                        works only when the app and the store belong to the
//                        same Shopify organization.
// NULL is a connection made before this column existed: it behaves as a
// stored token, exactly as it always has.

/** A shop's myshopify.com domain, or null. Accepts "bat-nutz" or
 *  "bat-nutz.myshopify.com" (any case); refuses anything else, because the
 *  domain is put into a URL SILO then sends a secret to. */
export function normalizeShopDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return null;
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

/** May this caller connect a store for this company? Same rule as
 *  google-oauth-lib's mayConnect: a disabled account never may (deactivation
 *  keeps memberships), then the membership role, then the legacy profile role
 *  for the active company. Any lookup error refuses. */
export function mayConnect({ profile, profileError, membership, membershipError, companyId }) {
  if (profileError || membershipError) return false;
  if (!profile || profile.is_active !== true) return false;
  if (membership) return ['owner_admin', 'admin'].includes(String(membership.role));
  return profile.active_company_id === companyId
    && ['owner', 'admin', 'executive'].includes(String(profile.role));
}

// ── SILO's two Shopify apps ─────────────────────────────────────────────────
// 'legacy': the original app, CUSTOM-distributed to Baseballism's Shopify
//   organization -- no other store can install it (reproduced 2026-09-27).
// 'public': SILO's public (unlisted) app. Only development stores can install
//   it until Shopify approves it.
// Connect uses the public app once SHOPIFY_PUBLIC_CLIENT_ID is set, and the
// legacy one until then; the callback verifies with whichever app the state
// row says started the flow. Existing connections are unaffected either way:
// an offline token keeps working whatever the env says.

/** What the public app asks for: what the sync reads, nothing else. Shopify's
 *  review rejects an app asking for scopes it does not use. read_all_orders is
 *  deliberately absent until Shopify grants it -- without it a store's history
 *  stops at 60 days, which the Test button reports (fullHistory). */
export const PUBLIC_SCOPES = [
  'read_orders',
  'read_products',
  'read_inventory',
  'read_locations',
  'read_shopify_payments_payouts',
  'read_draft_orders',
  'read_reports',
  'read_publications',
];

/** Which app starts a new Connect flow, given the env. */
export function chooseOAuthApp(env) {
  const pub = String(env?.SHOPIFY_PUBLIC_CLIENT_ID ?? '').trim();
  const pubSecret = String(env?.SHOPIFY_PUBLIC_CLIENT_SECRET ?? '').trim();
  if (pub && pubSecret) return { app: 'public', clientId: pub, clientSecret: pubSecret };
  const legacy = String(env?.SHOPIFY_CLIENT_ID ?? '').trim();
  const legacySecret = String(env?.SHOPIFY_CLIENT_SECRET ?? '').trim();
  if (legacy && legacySecret) return { app: 'legacy', clientId: legacy, clientSecret: legacySecret };
  return null;
}

/** The credentials of a named app, or null. A state row with no app is a
 *  flow started before this column existed: the legacy app. */
export function appCredentials(env, app) {
  const which = app === 'public' ? 'public' : 'legacy';
  const id = String((which === 'public' ? env?.SHOPIFY_PUBLIC_CLIENT_ID : env?.SHOPIFY_CLIENT_ID) ?? '').trim();
  const secret = String((which === 'public' ? env?.SHOPIFY_PUBLIC_CLIENT_SECRET : env?.SHOPIFY_CLIENT_SECRET) ?? '').trim();
  return id && secret ? { app: which, clientId: id, clientSecret: secret } : null;
}

/** Every app secret configured, for verifying a webhook whose app is unknown. */
export function allAppSecrets(env) {
  return [env?.SHOPIFY_PUBLIC_CLIENT_SECRET, env?.SHOPIFY_CLIENT_SECRET]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
}

// ── Signatures ──────────────────────────────────────────────────────────────

async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof message === 'string' ? enc.encode(message) : message));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The `hmac` on an OAuth callback query: hex HMAC-SHA256 of every other
 *  parameter, sorted and joined with &. */
export async function verifyOAuthHmac(params, secret) {
  const hmac = params.get('hmac');
  if (!hmac || !secret) return false;
  const pairs = [];
  params.forEach((v, k) => { if (k !== 'hmac' && k !== 'signature') pairs.push(`${k}=${v}`); });
  pairs.sort();
  return constantTimeEqual(toHex(await hmacSha256(secret, pairs.join('&'))), hmac);
}

/** X-Shopify-Hmac-Sha256 on a webhook: base64 HMAC-SHA256 of the RAW body.
 *  Returns true if any configured app secret signed it. */
export async function verifyWebhookHmac(rawBody, header, secrets) {
  const got = String(header ?? '').trim();
  if (!got || !secrets?.length) return false;
  for (const secret of secrets) {
    if (constantTimeEqual(toBase64(await hmacSha256(secret, rawBody)), got)) return true;
  }
  return false;
}

/** Which of SILO's apps signed this webhook ('public' / 'legacy'), or null.
 *  The privacy webhooks act per app: an uninstall of one app must not erase
 *  data SILO still holds for the same store through another connection. */
export async function webhookSigningApp(rawBody, header, env) {
  for (const app of ['public', 'legacy']) {
    const creds = appCredentials(env, app);
    if (creds && await verifyWebhookHmac(rawBody, header, [creds.clientSecret])) return app;
  }
  return null;
}

// ── Client-credentials tokens (the store's own Dev Dashboard app) ───────────

export class ShopifyTokenError extends Error {
  constructor(message, { status = null, sameOrgRefusal = false } = {}) {
    super(message);
    this.name = 'ShopifyTokenError';
    this.status = status;
    this.sameOrgRefusal = sameOrgRefusal;
  }
}

/** Mint a 24-hour Admin API token from a Dev Dashboard app's client id and
 *  secret. The secret never appears in an error message. */
export async function mintClientCredentialsToken({ shop, clientId, clientSecret, fetchImpl = fetch, now = Date.now() }) {
  const domain = normalizeShopDomain(shop);
  if (!domain) throw new ShopifyTokenError('Not a myshopify.com domain');
  if (!clientId || !clientSecret) throw new ShopifyTokenError('Client ID and client secret are both required');
  const res = await fetchImpl(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !json?.access_token) {
    const raw = String(json?.error_description || json?.error || json?.errors || text || '');
    // Classify BEFORE redacting: redaction rewrites the text it matches.
    const sameOrg = /cannot be performed on this shop|client credentials/i.test(raw);
    const detail = raw.replaceAll(clientSecret, '[redacted]').slice(0, 300);
    throw new ShopifyTokenError(
      sameOrg
        ? 'Shopify refused: the app must be created in the SAME Shopify organization as this store (Dev Dashboard, while signed in to the store owner\'s organization).'
        : `Shopify refused the client ID/secret (${res.status}${detail ? `: ${detail}` : ''})`,
      { status: res.status, sameOrgRefusal: sameOrg },
    );
  }
  const seconds = Number(json.expires_in) > 0 ? Number(json.expires_in) : 86399;
  return {
    accessToken: json.access_token,
    expiresAt: new Date(now + seconds * 1000).toISOString(),
    scopes: String(json.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** Refresh margin: a token with less than this left is replaced, so a sync
 *  that runs for an hour never outlives its token. */
export const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

/** Does this stored token need replacing before use? */
export function tokenNeedsRefresh(connection, now = Date.now()) {
  if (connection?.auth_method !== 'client_credentials') return false;
  if (!connection.access_token) return true;
  const exp = Date.parse(connection.token_expires_at ?? '');
  return !Number.isFinite(exp) || exp - now < TOKEN_REFRESH_MARGIN_MS;
}

/**
 * The token to use for this connection, minting a fresh one first when it is
 * a client-credentials connection whose token is missing or near expiry.
 * `admin` must be a SERVICE-ROLE client: the client secret is readable by
 * nothing else. Writes the new token back to the row and onto `connection`.
 * Every other connection is returned untouched -- this is a no-op for an
 * OAuth or pasted token.
 */
export async function ensureShopifyAccessToken(admin, connection, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!tokenNeedsRefresh(connection, now)) return connection?.access_token ?? null;
  const { data: cred, error } = await admin
    .from('shopify_client_credentials')
    .select('client_id, client_secret')
    .eq('connection_id', connection.id)
    .maybeSingle();
  if (error) throw new ShopifyTokenError(`Could not read the stored app credentials: ${error.message}`);
  if (!cred) throw new ShopifyTokenError('This connection has no stored app credentials -- reconnect it in Integrations.');
  const minted = await mintClientCredentialsToken({
    shop: connection.shop_domain, clientId: cred.client_id, clientSecret: cred.client_secret, fetchImpl, now,
  });
  const { error: updErr } = await admin
    .from('shopify_connections')
    .update({ access_token: minted.accessToken, token_expires_at: minted.expiresAt })
    .eq('id', connection.id);
  if (updErr) throw new ShopifyTokenError(`Minted a token but could not store it: ${updErr.message}`);
  connection.access_token = minted.accessToken;
  connection.token_expires_at = minted.expiresAt;
  return minted.accessToken;
}

/** Does this store let SILO read its whole order history? Without
 *  read_all_orders Shopify returns only the last 60 days of orders, with no
 *  error -- so an import silently starts two months ago. */
export function hasFullOrderHistory(scopesGranted) {
  return Array.isArray(scopesGranted) && scopesGranted.includes('read_all_orders');
}

// ── Privacy (GDPR) webhooks ─────────────────────────────────────────────────

export const COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'];

/**
 * What a compliance webhook asks SILO to do, from its topic and payload.
 * SILO holds a customer's name, email and Shopify id on shopify_orders and
 * shopify_draft_orders -- nothing else about a person. So:
 *   customers/data_request -> record it; a person answers (nothing is sent
 *                             automatically, and there is no endpoint to send to)
 *   customers/redact       -> blank those three fields on that customer's
 *                             orders and on the orders Shopify lists
 *   shop/redact            -> blank them for every order of the shop, and
 *                             delete the shop's stored app credentials/token
 * Sales figures are not personal data and are kept.
 */
export function planCompliance(topic, payload) {
  const shop = normalizeShopDomain(payload?.shop_domain);
  if (!COMPLIANCE_TOPICS.includes(topic)) return { action: 'ignore', reason: `unknown topic ${topic}` };
  if (!shop) return { action: 'ignore', reason: 'payload has no myshopify.com shop_domain' };
  if (topic === 'customers/data_request') {
    return { action: 'record_only', shop, customerId: idOrNull(payload?.customer?.id), email: payload?.customer?.email ?? null };
  }
  if (topic === 'customers/redact') {
    const customerId = idOrNull(payload?.customer?.id);
    const orderIds = (Array.isArray(payload?.orders_to_redact) ? payload.orders_to_redact : []).map(idOrNull).filter(Boolean);
    if (!customerId && !orderIds.length) return { action: 'record_only', shop, reason: 'nothing identifies the customer' };
    return { action: 'redact_customer', shop, customerId, orderIds };
  }
  return { action: 'redact_shop', shop };
}

/**
 * shop/redact arrives 48 hours after a store uninstalls ONE of SILO's apps.
 * Given that store's connections and the app that sent it, what to do:
 *   - the connections that app issued are closed (token cleared, inactive);
 *   - customer details on the store's orders are blanked ONLY if SILO keeps no
 *     other live connection to the store. If it does (Baseballism test-installs
 *     the public app and removes it while its original connection still
 *     syncs), that data is held through the other connection and stays.
 */
export function planShopRedact(connections, signingApp) {
  const list = Array.isArray(connections) ? connections : [];
  const issuedBy = (c) => (c.auth_method === 'oauth' || c.auth_method == null) && (c.oauth_app ?? 'legacy') === signingApp;
  const close = list.filter(issuedBy).map((c) => c.id);
  const stillLive = list.filter((c) => !close.includes(c.id) && c.is_active !== false && c.access_token);
  return { closeConnectionIds: close, redactOrders: stillLive.length === 0, keptBecause: stillLive.map((c) => c.id) };
}

function idOrNull(v) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : null;
}

export const REDACTED_CUSTOMER_FIELDS = { customer_name: null, customer_email: null, customer_id: null };
