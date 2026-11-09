// Where Google sends a person back after they approve SILO, and the rules for
// trusting it. Kept byte-identical in google-oauth-start/ and
// google-oauth-callback/ (each function deploys its own directory);
// scripts/tests/google-oauth-redirect.test.mjs fails if the two copies drift.
//
// Two modes, chosen by the GOOGLE_OAUTH_REDIRECT_ORIGINS secret:
//   - unset (legacy): Google returns straight to the google-oauth-callback
//     function on supabase.co, the only redirect URI the original Google
//     client knows.
//   - set, e.g. "https://get-silo.com,https://silo-baseballism.com": Google
//     returns to <origin>/oauth/google.html on the site the person started
//     from, which forwards to the callback. The SILO Google client lists only
//     those addresses, so the secret is set in the same sitting as the new
//     GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET -- deploying this code alone
//     changes nothing.

export const RETURN_PATH = '/oauth/google.html';

/** "https://a.com, https://b.com/" -> ['https://a.com', 'https://b.com'].
 *  Only https origins with no path survive; anything else is dropped. */
export function parseOrigins(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const v = part.trim();
    if (!v) continue;
    let u;
    try { u = new URL(v); } catch { continue; }
    if (u.protocol !== 'https:' || (u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password) continue;
    const origin = u.origin.toLowerCase();
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The allowed origin matching the page the person clicked Connect on, or the
 *  first allowed origin when the request came from anywhere else. Never an
 *  origin outside the list. */
export function pickOrigin(requestOrigin, allowed) {
  if (!allowed?.length) return null;
  const o = String(requestOrigin ?? '').trim().toLowerCase().replace(/\/$/, '');
  return allowed.includes(o) ? o : allowed[0];
}

/** The origin the return page reported, only if it is one of the allowed ones. */
export function acceptReturnOrigin(value, allowed) {
  if (!allowed?.length) return null;
  const o = String(value ?? '').trim().toLowerCase().replace(/\/$/, '');
  return allowed.includes(o) ? o : null;
}

export function returnUrl(origin) {
  return `${origin}${RETURN_PATH}`;
}

/**
 * May this caller connect Google accounts for this company? The function runs
 * with the service-role key, so this IS the authorization.
 *   - A disabled account never may: deactivation keeps memberships on
 *     purpose (CLAUDE.md), so the active flag is checked FIRST, and a
 *     disabled former admin with a still-valid session is refused.
 *   - Then the membership role for that company (owner_admin / admin), or,
 *     with no membership row, the legacy profile role for the active company
 *     -- the is_admin_user() precedence quickbooks-oauth-start follows.
 *   - Any lookup error refuses: an unknown answer is not a yes.
 */
export function mayConnect({ profile, profileError, membership, membershipError, companyId }) {
  if (profileError || membershipError) return false;
  if (!profile || profile.is_active !== true) return false;
  if (membership) return ['owner_admin', 'admin'].includes(String(membership.role));
  return profile.active_company_id === companyId
    && ['owner', 'admin', 'executive'].includes(String(profile.role));
}

/**
 * May this OAuth flow write its tokens onto `conn`? Asked twice: by the start
 * function before it records the connection on the state, and by the callback
 * before it updates the row, because the state names a row by id and a row
 * can move or vanish in the ten minutes between. The row must be the one the
 * state names, in the company the flow was authorised for, on the platform
 * the scope was requested for -- a GA4 grant written onto an Ads row would
 * test fine and then fail every nightly.
 */
export function mayReconnect(state, conn) {
  if (!state?.connection_id || !conn) return false;
  return conn.id === state.connection_id
    && conn.company_entity_id === state.company_entity_id
    && conn.platform === state.platform;
}
