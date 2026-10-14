/* pages/mfa.js — two-step login (authenticator-app codes) for SILO.
 *
 * Shared by pages/login.html (code step after sign-in), pages/set-password.html
 * (code step before a password change) and v2/profile.html (turn it on/off).
 * Exposes window.SiloMfa; every function takes the page's own Supabase client.
 *
 * Opt-in by design: an account with no verified factor never sees a code step,
 * so nothing changes for anyone until they turn it on in My profile.
 *
 * These pages are the front door. The server enforces the code too
 * (20261014000000): the Data API, Storage and the edge functions refuse a
 * password-only (aal1) session of an enrolled account. See
 * docs/ops/two-step-login.md.
 *
 * My profile offers setup only when pages/config.js sets
 * MFA_ENROLLMENT_OPEN: true (and Supabase Auth TOTP enrollment is enabled).
 * The code steps on login and set-password are live regardless, because they
 * only ever act for an account that already holds a verified factor.
 */
(function (root) {
  'use strict';

  // Supabase answers a wrong or expired TOTP with this code (older clients:
  // the message only).
  function isWrongCode(err) {
    if (!err) return false;
    return err.code === 'mfa_verification_failed' || /invalid totp|verification failed/i.test(err.message || '');
  }

  // "123 456", "123-456" and a pasted code with stray whitespace all count.
  function normalizeCode(raw) {
    const code = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
    return /^\d{6}$/.test(code) ? code : null;
  }

  // The `aal` claim of an access token, or null. Only used as a fallback
  // when the client cannot answer getAuthenticatorAssuranceLevel().
  function jwtAal(token) {
    try {
      const part = String(token || '').split('.')[1];
      if (!part) return null;
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = typeof atob === 'function'
        ? atob(pad)
        : Buffer.from(pad, 'base64').toString('binary');
      return JSON.parse(json).aal || null;
    } catch (_) {
      return null;
    }
  }

  // Whether My profile may offer setup. Read at call time so a page that
  // loads config.js after this file still gets the right answer.
  function enrollmentOpen() {
    const cfg = (typeof window !== 'undefined' && window.__SILO_CONFIG__) || {};
    return cfg.MFA_ENROLLMENT_OPEN === true;
  }

  function hasVerifiedFactor(user) {
    return (user && Array.isArray(user.factors) ? user.factors : [])
      .some((f) => f && f.status === 'verified');
  }

  // True when the signed-in account has two-step login on and this session
  // has not entered a code yet. False with no session or no factor.
  //
  // If the assurance call itself fails, decide from the session: someone
  // with no verified factor is let through exactly as before this file
  // existed, and someone WITH one is asked for a code.
  async function needsCode(client) {
    try {
      const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!error && data) return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
    } catch (_) { /* fall through */ }
    const { data } = await client.auth.getSession();
    const session = data && data.session;
    if (!session || !hasVerifiedFactor(session.user)) return false;
    return jwtAal(session.access_token) !== 'aal2';
  }

  async function verifiedFactors(client) {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    return ((data && data.totp) || []).filter((f) => f.status === 'verified');
  }

  // Raises the current session to aal2. Tries each verified authenticator,
  // so an account that somehow holds two still signs in with either.
  async function verifyCode(client, rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) throw new Error('Enter the 6-digit code from your authenticator app.');
    const factors = await verifiedFactors(client);
    if (!factors.length) throw new Error('This account has no authenticator app set up.');
    let lastErr = null;
    for (const f of factors) {
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: f.id, code });
      if (!error) return true;
      lastErr = error;
      if (!isWrongCode(error)) break;
    }
    if (isWrongCode(lastErr)) {
      throw new Error("That code didn't match. Codes change every 30 seconds — enter the one showing now.");
    }
    throw lastErr || new Error('Could not verify the code.');
  }

  // The verified authenticator, or null when two-step login is off.
  async function status(client) {
    const factors = await verifiedFactors(client);
    return factors[0] || null;
  }

  // Step 1 of turning it on: returns the QR code (an SVG data URI) and the
  // text secret for manual entry. An abandoned earlier attempt leaves an
  // unverified factor behind, which would collide with this one's name, so
  // those are cleared first.
  async function startEnrollment(client) {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    const stale = ((data && data.all) || [])
      .filter((f) => f.factor_type === 'totp' && f.status !== 'verified');
    // Supabase reports failures in `{ error }`, not by throwing. A leftover
    // that cannot be removed would make enroll() fail on the duplicate name
    // anyway, so stop here with a reason the person can act on.
    for (const f of stale) {
      let res;
      try { res = await client.auth.mfa.unenroll({ factorId: f.id }); } catch (e) { res = { error: e }; }
      if (res && res.error) {
        throw new Error('Could not clear an earlier unfinished setup (' + (res.error.message || 'unknown error') + '). Reload and try again.');
      }
    }
    const res = await client.auth.mfa.enroll({
      factorType: 'totp',
      issuer: 'SILO',
      friendlyName: 'Authenticator app',
    });
    if (res.error) throw res.error;
    return {
      factorId: res.data.id,
      qrCode: res.data.totp && res.data.totp.qr_code,
      secret: res.data.totp && res.data.totp.secret,
    };
  }

  // Step 2: the first code proves the app was set up. Success turns two-step
  // login on and raises this session to aal2.
  async function confirmEnrollment(client, factorId, rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) throw new Error('Enter the 6-digit code from your authenticator app.');
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      if (isWrongCode(error)) {
        throw new Error("That code didn't match. Check the app shows SILO, then enter the code showing now.");
      }
      throw error;
    }
    return true;
  }

  // Abandoning setup: remove the unverified factor so it cannot linger.
  // Throws when Supabase refuses, so the caller can keep the setup open
  // instead of showing Off over a factor that still exists.
  async function cancelEnrollment(client, factorId) {
    if (!factorId) return true;
    let res;
    try { res = await client.auth.mfa.unenroll({ factorId }); } catch (e) { res = { error: e }; }
    if (res && res.error) {
      throw new Error('Could not cancel setup (' + (res.error.message || 'unknown error') + '). Try again.');
    }
    return true;
  }

  // Supabase only lets an aal2 session remove a verified factor.
  async function disable(client, factorId) {
    const { error } = await client.auth.mfa.unenroll({ factorId });
    if (error) {
      if (/aal2/i.test(error.message || '') || error.code === 'insufficient_aal') {
        throw new Error('Sign out and back in with your code, then turn it off.');
      }
      throw error;
    }
    return true;
  }

  const api = {
    enrollmentOpen,
    normalizeCode,
    jwtAal,
    hasVerifiedFactor,
    isWrongCode,
    needsCode,
    verifyCode,
    status,
    startEnrollment,
    confirmEnrollment,
    cancelEnrollment,
    disable,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SiloMfa = api;
})(typeof window !== 'undefined' ? window : null);
