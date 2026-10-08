/* Meta Ads OAuth (Facebook Login for Business) -- the decisions both edge
 * functions make, kept here so node can test them.
 *
 * Canonical copy: scripts/lib/meta-oauth-lib.mjs. meta-oauth-start,
 * meta-oauth-callback and meta-oauth-review each carry a byte-identical copy
 * (pinned by scripts/tests/meta-oauth.test.mjs). Edit here, then re-copy.
 *
 * ADDITIVE: the pasted System User token path in Integrations is unchanged;
 * nothing links to meta-oauth-start until it is switched on.
 *
 * How the login works: a "configuration" made in the Meta App Dashboard
 * (Facebook Login for Business -> Configurations) names the permissions, the
 * asset types and the TOKEN TYPE. SILO asks for a BUSINESS INTEGRATION SYSTEM
 * USER token: it does not expire and belongs to the client's business, which
 * is what an overnight sync needs. The dialog is opened with config_id (and
 * no scope parameter -- the configuration carries them) and returns a code,
 * exchanged server to server. If the configuration was instead set to a
 * user token, the exchange returns one with expires_in; it is then swapped
 * for a long-lived (~60 day) token and its expiry recorded, so the
 * difference is visible on the row rather than discovered by a failed sync.
 */

/** Keep equal to META_API_VERSION in scripts/lib/ad-platforms-sync-core.mjs. */
export const META_GRAPH_VERSION = 'v25.0';

/** What the Facebook Login for Business configuration requests (configuration
 *  2293747398051309, 2026-10-08): the six reporting permissions, each matched
 *  to SILO's actual Graph calls in docs/ops/public-app-review.md 2.2. Listed
 *  here so the review kit and the tests agree on one list; the dialog itself
 *  takes them from config_id. business_management is NOT requested: no SILO
 *  call uses the Business Manager API. Meta's Instagram media and Page
 *  references say a business system user MAY need it; the first live
 *  "Verify permissions" run decides (the pasted-token path still uses it). */
export const META_PERMISSIONS = [
  'ads_read',
  'pages_show_list', 'pages_read_engagement', 'read_insights',
  'instagram_basic', 'instagram_manage_insights',
];

export function authorizeUrl({ appId, configId, redirectUri, state }) {
  const u = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('config_id', configId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('override_default_response_type', 'true');
  return u.toString();
}

export function codeExchangeUrl({ appId, appSecret, redirectUri, code }) {
  const u = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('client_secret', appSecret);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code', code);
  return u.toString();
}

export function longLivedExchangeUrl({ appId, appSecret, token }) {
  const u = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
  u.searchParams.set('grant_type', 'fb_exchange_token');
  u.searchParams.set('client_id', appId);
  u.searchParams.set('client_secret', appSecret);
  u.searchParams.set('fb_exchange_token', token);
  return u.toString();
}

/** A token response's expiry as an ISO string, or null for a token that does
 *  not expire (a system user token carries no expires_in). */
export function tokenExpiry(tokenData, nowMs = Date.now()) {
  const s = Number(tokenData?.expires_in);
  return Number.isFinite(s) && s > 0 ? new Date(nowMs + s * 1000).toISOString() : null;
}

/** Same rule as google-oauth-lib's mayConnect (pinned equal by test): a
 *  disabled account never may; then the membership role for that company;
 *  without a membership, the legacy profile role for the active company; any
 *  lookup error refuses. */
export function mayConnect({ profile, profileError, membership, membershipError, companyId }) {
  if (profileError || membershipError) return false;
  if (!profile || profile.is_active !== true) return false;
  if (membership) return ['owner_admin', 'admin'].includes(String(membership.role));
  return profile.active_company_id === companyId
    && ['owner', 'admin', 'executive'].includes(String(profile.role));
}

/** May this flow write its token onto `conn`? The row the state names, in the
 *  same company, on meta_ads. Asked by start AND by the callback. */
export function mayReconnect(state, conn) {
  if (!state?.connection_id || !conn) return false;
  return conn.id === state.connection_id
    && conn.company_entity_id === state.company_entity_id
    && conn.platform === state.platform;
}

/** The `meta` jsonb for a NEW connection. history_backfill_pending is what the
 *  pasted-token insert in Integrations stamps, so a first sync through OAuth
 *  imports the same year of history. A connection made through the App Review
 *  test page is marked review_test: the review gates below act ONLY on rows
 *  carrying it, so they can never reach a pasted-token connection. */
export function newConnectionMeta({ clientBusinessId, tokenType, nowIso, reviewTest = false }) {
  return {
    history_backfill_pending: true,
    oauth: {
      connected_via: 'facebook_login_for_business',
      token_type: tokenType,
      client_business_id: clientBusinessId ?? null,
      connected_at: nowIso,
      ...(reviewTest ? { review_test: true } : {}),
    },
  };
}

/* ── App Review test mode (/testing/meta-oauth.html) ──────────────────────
 * Isolation is enforced HERE, on the server, never by the page:
 *   - the workspace must be named in the META_REVIEW_COMPANY_IDS secret (unset
 *     or empty refuses everything) AND be the caller's active workspace, AND
 *     the caller must pass mayConnect for it;
 *   - every connection-level action needs a row of that workspace marked
 *     meta.oauth.review_test (isReviewConnection), so a pasted-token row --
 *     even in an allowed workspace -- is never touched.
 * The state nonce keeps its full crypto.randomUUID() and is validated by the
 * database row exactly like any other state; the 'rt_' prefix only says which
 * page to return to and that the stricter checks above must ALSO pass. It
 * grants nothing on its own. */
export const REVIEW_RETURN_TO = 'review_test';
export const REVIEW_NONCE_PREFIX = 'rt_';
export const REVIEW_PAGE_PATH = '/testing/meta-oauth.html';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The allow-list secret as a list of workspace ids; anything that is not a
 *  uuid is dropped, so a typo narrows the list rather than widening it. */
export function reviewCompanyIds(raw) {
  return String(raw ?? '').split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter((v) => UUID_RE.test(v));
}

export function reviewNonce(uuid) {
  if (!UUID_RE.test(String(uuid))) throw new Error('review nonce needs a random uuid');
  return `${REVIEW_NONCE_PREFIX}${uuid}`;
}

export function isReviewState(nonce) {
  const s = String(nonce ?? '');
  return s.startsWith(REVIEW_NONCE_PREFIX) && UUID_RE.test(s.slice(REVIEW_NONCE_PREFIX.length));
}

/** May this caller use review mode for companyId? Allow-listed, the caller's
 *  ACTIVE workspace, and an admin of it (mayConnect). */
export function mayUseReviewWorkspace({ allowlist, companyId, profile, profileError, membership, membershipError }) {
  const id = String(companyId ?? '').toLowerCase();
  if (!id || !Array.isArray(allowlist) || !allowlist.includes(id)) return false;
  if (String(profile?.active_company_id ?? '').toLowerCase() !== id) return false;
  return mayConnect({ profile, profileError, membership, membershipError, companyId });
}

/** Is `conn` a review-test Meta connection of companyId? */
export function isReviewConnection(conn, companyId) {
  return Boolean(conn && companyId)
    && conn.platform === 'meta_ads'
    && conn.company_entity_id === companyId
    && conn.meta?.oauth?.review_test === true;
}

/** Error codes the callback may put in the redirect; anything else is generic. */
export const CALLBACK_ERRORS = [
  'access_denied', 'missing_params', 'server_misconfigured', 'invalid_or_expired_state',
  'token_exchange_failed', 'no_access_token', 'reconnect_target_missing', 'save_failed',
  'review_not_allowed',
];
export function callbackError(code) {
  return CALLBACK_ERRORS.includes(code) ? code : 'token_exchange_failed';
}
