/* ========================================================================
   SILO v2 — tool-shell.js
   Mounts a Beacon shell around an existing /financehub tool page.

   Usage (in /v2/<tool>.html):
     <body>
       <div id="silo-app" class="silo-app">
         <main class="silo-main" data-tool='{...}'></main>
       </div>
       <script src="../pages/config.js"></script>
       <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
       <script src="silo-chrome.js"></script>
       <script src="tool-shell.js"></script>
     </body>

   data-tool JSON config keys:
     title    – string  shown as <h1>
     subtitle – string  shown under the title
     src      – string  path to the underlying tool (iframe src)
     active   – string  silo-chrome NAV active id  (e.g. "people/payroll")
     crumbs   – string[] breadcrumbs (e.g. ["People","Payroll"])
   ======================================================================== */

(function () {
  const LOGIN_PATH = '/pages/login.html';

  function embedSrc(src) {
    if (window.__SILO_EMBED__ && typeof window.__SILO_EMBED__.appendEmbedParam === 'function') {
      return window.__SILO_EMBED__.appendEmbedParam(src);
    }
    try {
      const u = new URL(src, window.location.origin);
      if (u.origin !== window.location.origin) return src;
      u.searchParams.set('embed', '1');
      return u.pathname + u.search + u.hash;
    } catch (_) {
      return src;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderHeader(cfg) {
    return `
      <header class="ts-header">
        <div class="ts-header-block">
          <div class="ts-header-title">
            <h1>${esc(cfg.title)}</h1>
            <span class="ts-header-status-pill" data-state="loading" data-ts-status>LOADING</span>
          </div>
          <div class="ts-header-sub">${esc(cfg.subtitle || '')}</div>
        </div>
        <div class="ts-header-actions">
          <button class="bcn-btn bcn-btn--mono" type="button" data-ts-reload title="Reload tool">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>
            RELOAD
          </button>
          <button class="bcn-btn bcn-btn--ghost bcn-btn--mono" type="button" data-ts-popout title="Open in a new tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M14 4h6v6"/><path d="M10 14L20 4"/><path d="M20 14v6H4V4h6"/></svg>
            POP OUT
          </button>
        </div>
      </header>
      <section class="ts-body">
        <div class="ts-card">
          <div class="ts-loading" data-ts-loading>
            <div class="ts-spin"></div>
            <div>Loading ${esc(cfg.title)}</div>
          </div>
          <div class="ts-error" hidden data-ts-error>
            <div class="ts-error-title">Could not load this tool</div>
            <div class="ts-error-sub" data-ts-error-msg>The tool did not respond.</div>
            <button class="bcn-btn" type="button" data-ts-retry>Try again</button>
          </div>
          <iframe class="ts-frame" data-ts-frame title="${esc(cfg.title)}" loading="eager"></iframe>
        </div>
      </section>
    `;
  }

  function parseConfig(mainEl) {
    const raw = mainEl.getAttribute('data-tool');
    if (!raw) {
      console.error('tool-shell: missing data-tool on .silo-main');
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('tool-shell: invalid JSON in data-tool', e);
      return null;
    }
  }

  async function bootSupabase() {
    const cfg = window.__SILO_CONFIG__ || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return { user: null, supabaseClient: null };
    if (!window.supabase || !window.supabase.createClient) return { user: null, supabaseClient: null };

    const supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    try {
      const { data } = await supabaseClient.auth.getSession();
      const u = data && data.session && data.session.user;
      if (!u) return { user: null, supabaseClient };

      let role = 'MEMBER';
      try {
        const { data: profile } = await supabaseClient
          .from('profiles').select('role,app_role,user_role').eq('id', u.id).maybeSingle();
        if (profile) role = (profile.role || profile.app_role || profile.user_role || 'MEMBER').toUpperCase();
      } catch (_) {}

      return {
        supabaseClient,
        user: { id: u.id, email: u.email, role },
      };
    } catch (e) {
      console.warn('tool-shell: session lookup failed', e);
      return { user: null, supabaseClient };
    }
  }

  function wireFrame(mainEl, cfg) {
    const frame   = mainEl.querySelector('[data-ts-frame]');
    const loading = mainEl.querySelector('[data-ts-loading]');
    const errBox  = mainEl.querySelector('[data-ts-error]');
    const errMsg  = mainEl.querySelector('[data-ts-error-msg]');
    const status  = mainEl.querySelector('[data-ts-status]');
    const reload  = mainEl.querySelector('[data-ts-reload]');
    const popout  = mainEl.querySelector('[data-ts-popout]');
    const retry   = mainEl.querySelector('[data-ts-retry]');

    let watchdog = null;
    let loaded = false;

    function setStatus(state, label) {
      status.dataset.state = state;
      status.textContent = label;
    }

    function load() {
      loaded = false;
      errBox.hidden = true;
      loading.hidden = false;
      setStatus('loading', 'LOADING');
      frame.src = embedSrc(cfg.src);
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (loaded) return;
        loading.hidden = true;
        errBox.hidden = false;
        errMsg.textContent = `${cfg.src} did not respond within 15 seconds. The tool may be slow or require sign-in.`;
        setStatus('error', 'TIMED OUT');
      }, 15000);
    }

    frame.addEventListener('load', () => {
      loaded = true;
      clearTimeout(watchdog);
      loading.hidden = true;
      errBox.hidden = true;
      setStatus('ready', 'READY');
    });

    reload.addEventListener('click', load);
    retry.addEventListener('click', load);
    popout.addEventListener('click', () => window.open(cfg.src, '_blank', 'noopener,noreferrer'));

    load();
  }

  async function init() {
    const appEl = document.getElementById('silo-app');
    if (!appEl) return console.error('tool-shell: missing #silo-app');
    const mainEl = appEl.querySelector('.silo-main');
    if (!mainEl) return console.error('tool-shell: missing .silo-main');

    const cfg = parseConfig(mainEl);
    if (!cfg) return;

    document.title = `SILO · ${cfg.title}`;

    // Render chrome inside .silo-main before SiloChrome.mount so utility bar is prepended on top.
    mainEl.innerHTML = renderHeader(cfg);

    const { user, supabaseClient } = await bootSupabase();

    if (!window.SiloChrome) {
      console.error('tool-shell: SiloChrome global missing — include silo-chrome.js first');
      return;
    }

    window.SiloChrome.mount({
      appEl: '#silo-app',
      active: cfg.active,
      crumbs: cfg.crumbs || [],
      user: user || { email: 'Signed out', role: 'MEMBER' },
      supabaseClient,
    });

    wireFrame(mainEl, cfg);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
