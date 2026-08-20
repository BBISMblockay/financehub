/* ========================================================================
   SILO session guard — for repo-root iframe target pages that ship no auth
   check of their own (buyer.html, checkwriter.html). Those pages are
   reachable two ways: inside the v2 tool-shell iframe for an already
   signed-in user, and directly by URL for anyone, unauthenticated, since
   nothing on the page itself ever checked. This guard closes the second
   path without touching the first: the Supabase session lives in
   localStorage, shared same-origin whether the page is top-level or
   embedded in our own iframe, so an authenticated user's session is found
   immediately either way and the page proceeds untouched; a visitor with no
   session is redirected to login before the page can be used.

   Unlike v2/dept-guard.js (a UX layer on top of pages that already have
   real auth via RLS + their own mount flow, so it fails OPEN on error),
   this guard fails CLOSED on any error — missing config, SDK not loaded,
   network failure — because for these two pages it is the only auth check
   that exists.

   Usage (load after config.js and the supabase UMD script, before any
   page script that touches data):
     <script src="/pages/config.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="/pages/require-session-guard.js"></script>
   ======================================================================== */
(function () {
  function bounceToLogin() {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace('/pages/login.html?next=' + next);
  }

  async function check() {
    const cfg = window.__SILO_CONFIG__ || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase?.createClient) {
      bounceToLogin();
      return;
    }
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data } = await sb.auth.getSession();
    if (!data?.session?.user) bounceToLogin();
  }

  check().catch(bounceToLogin);
})();
