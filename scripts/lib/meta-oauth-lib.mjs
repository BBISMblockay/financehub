/* Meta Ads OAuth (Facebook Login for Business) -- the decisions both edge
 * functions make, kept here so node can test them.
 *
 * Canonical copy: scripts/lib/meta-oauth-lib.mjs. meta-oauth-start and
 * meta-oauth-callback each carry a byte-identical copy (pinned by
 * scripts/tests/meta-oauth.test.mjs). Edit here, then re-copy.
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

/** What the Facebook Login for Business configuration must request. Listed
 *  here so the review kit, the privacy policy and the test agree on one list;
 *  the dialog itself takes them from config_id. */
export const META_PERMISSIONS = [
  'ads_read', 'business_management',
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
 *  imports the same year of history. */
export function newConnectionMeta({ clientBusinessId, tokenType, nowIso }) {
  return {
    history_backfill_pending: true,
    oauth: {
      connected_via: 'facebook_login_for_business',
      token_type: tokenType,
      client_business_id: clientBusinessId ?? null,
      connected_at: nowIso,
    },
  };
}

/** Error codes the callback may put in the redirect; anything else is generic. */
export const CALLBACK_ERRORS = [
  'access_denied', 'missing_params', 'server_misconfigured', 'invalid_or_expired_state',
  'token_exchange_failed', 'no_access_token', 'reconnect_target_missing', 'save_failed',
];
export function callbackError(code) {
  return CALLBACK_ERRORS.includes(code) ? code : 'token_exchange_failed';
}
