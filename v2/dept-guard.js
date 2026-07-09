/* ========================================================================
   SILO department page guard — soft redirect for finance-only pages.

   Usage (after config.js and the supabase UMD script):
     <script src="dept-guard.js" data-departments="exec,finance"></script>

   Checks the signed-in user's profiles.department and redirects anyone
   outside the allowed list to Home. Owners always pass. This is a UX
   guard against deep links / bookmarks, NOT security — the data behind
   these pages is gated by department-aware RLS. Fails open on any error
   (no session yet, network, missing profile) so it can never lock a
   legitimate user out; RLS is the enforcement layer.
   ======================================================================== */
(function () {
  const script = document.currentScript;
  const ALLOWED = String(script?.dataset?.departments || 'exec,finance')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const REDIRECT = script?.dataset?.redirect || '/v2/finance.html';
  // Pages with no auth flow of their own (legacy Sheets-backed pages) set
  // data-require-session — anonymous visitors go to login instead of
  // falling through.
  const REQUIRE_SESSION = script?.dataset?.requireSession === 'true';
  const SS_DEPT = 'silo:nav:department';

  function cached() {
    try { return sessionStorage.getItem(SS_DEPT) || null; } catch { return null; }
  }

  async function check() {
    const cfg = window.__SILO_CONFIG__ || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase?.createClient) return;

    let dept = cached();
    let role = null;

    if (!dept) {
      const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      const sess = await sb.auth.getSession();
      const uid = sess?.data?.session?.user?.id;
      if (!uid) {
        if (REQUIRE_SESSION) {
          window.location.replace('/pages/login.html?next='
            + encodeURIComponent(window.location.pathname + window.location.search));
        }
        return; // signed-in flow is otherwise the page's own concern
      }
      const { data, error } = await sb.from('profiles').select('department, role').eq('id', uid).single();
      if (error || !data) return; // fail open; RLS is the real gate
      dept = String(data.department || 'unknown').toLowerCase();
      role = String(data.role || '').toLowerCase();
      try { sessionStorage.setItem(SS_DEPT, dept); } catch {}
    }

    if (role === 'owner' || ALLOWED.includes(dept)) return;
    window.location.replace(REDIRECT);
  }

  check().catch(() => {});
})();
