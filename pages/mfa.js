/* pages/mfa.js — two-step login (authenticator-app codes) for SILO.
 *
 * Shared by pages/login.html (code step after sign-in), pages/set-password.html
 * (code step before a password change) and v2/profile.html (turn it on/off).
 * Exposes window.SiloMfa; every function takes the page's own Supabase client.
 *
 * Opt-in by design: an account with no verified factor never sees a code step,
 * so nothing changes for anyone until they turn it on in My profile.
 *
 * This is the FRONT DOOR only. A password-only session (aal1) still reads
 * whatever RLS allows if someone opens an app page directly; the database
 * check that refuses aal1 for enrolled users is a separate migration. See
 * docs/ops/two-step-login.md.
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
    for (const f of stale) {
      try { await client.auth.mfa.unenroll({ factorId: f.id }); } catch (_) { /* best effort */ }
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
  async function cancelEnrollment(client, factorId) {
    if (!factorId) return;
    try { await client.auth.mfa.unenroll({ factorId }); } catch (_) { /* best effort */ }
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
