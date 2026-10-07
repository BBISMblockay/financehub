/* Shopify-initiated install of SILO's PUBLIC app (App Store rules 2.3.1-2.3.4).
 *
 * The existing "Connect with Shopify" flow starts in SILO: a signed-in admin
 * types a store domain and OAuth runs for a company already chosen. Shopify's
 * review forbids asking for the domain and requires OAuth to run immediately
 * whenever Shopify opens the app (first install, reinstall, every launch from
 * the admin). At that moment SILO knows the STORE but not the person or the
 * company, so the flow is split in two:
 *
 *   1. shopify-app-install (public): Shopify opens the App URL -> the launch
 *      signature is checked -> OAuth starts at once -> the callback exchanges
 *      the code and parks the token in shopify_pending_installs under a
 *      one-time CLAIM token, then sends the browser to /v2/shopify-install.html.
 *   2. shopify-install-claim (signed in): an admin of a SILO workspace picks
 *      which workspace the store belongs to; shopify_claim_pending_install()
 *      moves the token onto shopify_connections in one transaction.
 *
 * This file holds the decisions both functions make, so node can test them.
 * Canonical copy: scripts/lib/shopify-install-lib.mjs. Each function directory
 * that imports it carries a byte-identical copy (pinned by
 * scripts/tests/shopify-install.test.mjs). Edit here, then re-copy.
 *
 * ADDITIVE: nothing in the existing Integrations flow calls this yet. */

/** How old a launch request may be. Shopify signs `timestamp`; a replayed old
 *  launch URL would otherwise start a fresh OAuth round trip forever. */
export const LAUNCH_MAX_AGE_SEC = 300;
/** Small allowance for a Shopify clock slightly ahead of ours. */
export const LAUNCH_MAX_FUTURE_SEC = 60;

/** Is a signed launch timestamp (seconds since epoch, as a string) recent? */
export function launchIsFresh(timestamp, nowMs = Date.now()) {
  if (!/^\d{9,11}$/.test(String(timestamp ?? ''))) return false;
  const ageSec = nowMs / 1000 - Number(timestamp);
  return ageSec <= LAUNCH_MAX_AGE_SEC && ageSec >= -LAUNCH_MAX_FUTURE_SEC;
}

/** Which branch a request to shopify-app-install takes. Shopify's OAuth
 *  callback carries `code` + `state`; a launch from the App URL carries
 *  neither. Anything else is malformed. */
export function installRequestKind(params) {
  const has = (k) => !!params.get(k);
  if (!has('shop') || !has('hmac')) return 'invalid';
  if (has('code') || has('state')) return has('code') && has('state') ? 'callback' : 'invalid';
  return has('timestamp') ? 'launch' : 'invalid';
}

function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** A one-time claim token: 32 random bytes, URL-safe. Only its hash is stored. */
export function newClaimToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A claim token as the browser may hold it: exactly what newClaimToken makes. */
export function isClaimToken(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(value ?? ''));
}

/** sha256 hex of a claim token -- the only form the database ever sees. */
export async function hashClaim(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const INSTALL_PAGE = '/v2/shopify-install.html';

/** Where the browser goes after the callback. The claim travels in the URL
 *  FRAGMENT, which browsers never send to a server or in a Referer header. */
export function claimRedirect(appUrl, token) {
  return `${appUrl}${INSTALL_PAGE}#claim=${encodeURIComponent(token)}`;
}

/** Where the browser goes when the install fails. A fixed code, never a raw
 *  error message (the page maps codes to words). */
export const INSTALL_ERRORS = [
  'not_configured', 'invalid_request', 'invalid_signature', 'stale_launch',
  'invalid_or_expired_state', 'shop_mismatch', 'token_exchange_failed', 'save_failed',
];
export function errorRedirect(appUrl, code) {
  const safe = INSTALL_ERRORS.includes(code) ? code : 'invalid_request';
  return `${appUrl}${INSTALL_PAGE}#error=${safe}`;
}

/** What the claim function may do with a store for a chosen workspace, given
 *  the workspace's existing connection to that store (or null). Mirrors
 *  shopify_claim_pending_install(); the database is the authority, this is
 *  what the page is told before it asks.
 *    'connect' -- no live connection: a new one is created, sync left OFF
 *    'refresh' -- already connected through this public app: the token is
 *                 replaced (a reinstall issues a new one) and sync kept
 *    'refuse'  -- connected another way (legacy app, the store's own app, a
 *                 pasted token): never silently replaced; remove it first */
export function claimPlan(existing) {
  if (!existing || existing.is_active !== true) return 'connect';
  if (existing.auth_method === 'oauth' && existing.oauth_app === 'public') return 'refresh';
  return 'refuse';
}
