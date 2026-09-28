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
