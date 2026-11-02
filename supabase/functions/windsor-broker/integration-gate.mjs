/* Third-party integration gate for edge functions.
 *
 * 20261020030000 gives a third-party OAuth client its own Postgres role, and
 * the Data API pre-request hook refuses it on every path but the report RPC.
 * That covers any function which talks to PostgREST with the caller's token --
 * directly, or through scripts/lib/mfa-gate.mjs, whose own call is an RPC and
 * so is refused for an integration, failing closed.
 *
 * It does NOT cover a function that verifies the caller with auth.getUser()
 * and then works only through the service role without asking PostgREST
 * anything as the caller. There is no such function today (see
 * scripts/tests/mfa-gate.test.mjs, which pins the sixteen that act with the
 * service role to calling that gate first), and this module is what a new one
 * calls so that it never becomes the first.
 *
 * It reads the token's payload WITHOUT verifying it, which is safe only
 * because `verify_jwt = true` has already verified the signature; a function
 * deployed with verify_jwt off must not rely on this alone.
 *
 * Fails CLOSED: an unreadable payload, a missing subject, the anon key on its
 * own (which `verify_jwt` accepts, because it is itself a valid JWT) and the
 * dead-end role are all refused.
 *
 * The MCP endpoint is the one surface that exists FOR integrations; it passes
 * allowIntegration: true and does its own scope checks in the database.
 *
 * Verbatim copy in each gated function's directory (pinned by
 * scripts/tests/integration-gate.test.mjs). Edit this one and re-copy.
 */

export const INTEGRATION_NOT_ALLOWED = 'This connection cannot use that feature.';
export const NOT_AUTHENTICATED = 'Sign in to continue.';

/** Decode a JWT payload without verifying it. Returns null if it is not one. */
export function readTokenClaims(authorization) {
  const raw = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    // atob() yields one CHARACTER per byte, so a claim containing anything
    // outside ASCII comes back mangled unless the bytes are decoded as UTF-8.
    // The gate itself only reads ASCII claims, but readTokenClaims is exported
    // and a caller reading a name or an email should get the real one.
    let json;
    if (typeof atob === 'function') {
      const bytes = Uint8Array.from(atob(pad), (ch) => ch.charCodeAt(0));
      json = new TextDecoder('utf-8').decode(bytes);
    } else {
      json = Buffer.from(pad, 'base64').toString('utf8');
    }
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string | null | undefined} authorization  the request's Authorization header
 * @param {{ allowIntegration?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, status: number, code: string, message: string }}
 */
export function checkIntegrationToken(authorization, opts = {}) {
  const claims = readTokenClaims(authorization);
  if (!claims) {
    return { ok: false, status: 401, code: 'not_authenticated', message: NOT_AUTHENTICATED };
  }
  const role = typeof claims.role === 'string' ? claims.role : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  // The project's anon key is a valid JWT with no subject, and `verify_jwt`
  // accepts it on its own. silo_revoked is the dead end stamped on a token
  // whose grant is gone.
  if (!sub || role === 'anon' || role === 'silo_revoked') {
    return { ok: false, status: 401, code: 'not_authenticated', message: NOT_AUTHENTICATED };
  }
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : '';
  if (clientId && !opts.allowIntegration) {
    return { ok: false, status: 403, code: 'integration_not_allowed', message: INTEGRATION_NOT_ALLOWED };
  }
  return { ok: true };
}
