/* /v2/klaviyo-install.html -- start a Klaviyo OAuth grant from a cold link.
 *
 * This page is the "OAuth installation URL" on SILO's Klaviyo app listing.
 * Klaviyo wants ONE url that begins the install from either side, so it has to
 * cope with a visitor who is not signed in, has no active workspace, is not an
 * admin of the one they have, or has already connected Klaviyo.
 *
 * It owns no Klaviyo logic of its own: it calls klaviyo-oauth-start, exactly as
 * the Integrations card's button does, and forwards the browser to the
 * authorize URL that function builds. The PKCE verifier never reaches this
 * page -- it is generated and stored server-side -- so there is no secret here
 * to protect.
 *
 * The final hop is behind a CLICK and not automatic. Two reasons, and neither
 * is cosmetic: a top-level redirect to a third party straight out of a page
 * load is what a consent screen should not feel like, and the visitor arriving
 * from Klaviyo has no idea yet WHICH SILO workspace they are about to attach
 * their account to. The page names it before they go.
 *
 * Pure helpers are exported on window.SiloKlaviyoInstall for
 * scripts/tests/klaviyo-install.test.mjs. */
(function () {
  'use strict';
  const PAGE = '/v2/klaviyo-install.html';

  /** Where to send someone who is not signed in. `next` brings them back here
   * rather than to the default landing page, which is the whole point: a
   * sign-in bounce must not lose the install they came to do. */
  function loginUrl() { return '/pages/login.html?next=' + encodeURIComponent(PAGE); }

  /** Where to send someone with no active workspace. The picker returns here. */
  function pickerUrl() { return '/v2/company-picker.html?next=' + encodeURIComponent(PAGE); }

  /** The sentence for a klaviyo-oauth-start refusal.
   *
   * The function's own words are used where it has any, because it tells a
   * missing app apart from a workspace the caller does not administer and each
   * needs a different person to act. The one case worth rewording is the
   * unregistered app: `KLAVIYO_CLIENT_ID not configured` is true and useless to
   * whoever is reading it. */
  function startError(status, out) {
    if (/KLAVIYO_CLIENT_ID/.test(out?.error || '')) {
      return 'SILO’s Klaviyo app is not switched on for this deployment yet. '
        + 'You can connect Klaviyo with a private API key from Integrations instead.';
    }
    if (status === 403) {
      return 'You need to be an admin of this SILO workspace to connect Klaviyo. '
        + 'Ask an admin to open this link, or switch workspace.';
    }
    if (status === 401) return 'Your session has expired. Sign in again and reopen this link.';
    return out?.error || `Klaviyo sign-in could not be started (HTTP ${status}).`;
  }

  window.SiloKlaviyoInstall = { PAGE, loginUrl, pickerUrl, startError };
  if (typeof document === 'undefined' || !document.getElementById('kiSub')) return;

  const $ = (id) => document.getElementById(id);
  function setStatus(msg, type = 'info') {
    const el = $('status');
    el.className = `bcn-status bcn-status--${type}`;
    el.textContent = msg;
    el.hidden = false;
  }

  (async function main() {
    const cfg = window.__SILO_CONFIG__ || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
      // Deliberately the same wording as every other page: a missing config is
      // a deployment fact, not a Klaviyo problem.
      setStatus('Missing Supabase config', 'neg');
      $('kiSub').textContent = 'This SILO deployment is not configured.';
      return;
    }
    const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

    const { data: sess } = await db.auth.getSession();
    if (!sess?.session) { location.href = loginUrl(); return; }

    // ensureActiveCompany, never getActiveCompany: the second reads per-tab
    // sessionStorage and returns null in a tab opened from a link -- which is
    // every visitor arriving from Klaviyo.
    const co = await (cfg.ensureActiveCompany ? cfg.ensureActiveCompany(db) : null);
    if (!co?.id) { location.href = pickerUrl(); return; }

    $('kiSub').innerHTML = 'Klaviyo will be connected to <span class="ki-workspace"></span>.';
    $('kiSub').querySelector('.ki-workspace').textContent = co.title || 'your workspace';
    $('kiScopes').hidden = false;
    $('kiActions').hidden = false;

    const btn = $('kiConnect');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setStatus('Starting Klaviyo sign-in…', 'info');
      try {
        const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/klaviyo-oauth-start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: cfg.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${sess.session.access_token}`,
          },
          body: JSON.stringify({ company_entity_id: co.id }),
        });
        let out = null;
        try { out = await res.json(); } catch (_) { out = null; }
        if (!res.ok || !out?.url) {
          setStatus(startError(res.status, out), 'neg');
          btn.disabled = false;
          return;
        }
        window.location.href = out.url;
      } catch (err) {
        setStatus('Could not reach SILO to start Klaviyo sign-in: ' + (err?.message || err), 'neg');
        btn.disabled = false;
      }
    });
  }());
}());
