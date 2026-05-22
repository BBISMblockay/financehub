/**
 * v2/hub-viewer.js — Finance / employee hub content area (SiloChrome + Beacon iframe card)
 * Usage:
 *   <main class="silo-main" data-hub='{"hub":"finance","title":"...","active":"finance/menu",...}'></main>
 */
(function () {
  const LOGIN = '/pages/login.html';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function embedSrc(src) {
    if (window.__SILO_EMBED__?.appendEmbedParam) return window.__SILO_EMBED__.appendEmbedParam(src);
    try {
      const u = new URL(src, window.location.origin);
      if (u.origin !== window.location.origin) return src;
      u.searchParams.set('embed', '1');
      return u.pathname + u.search + u.hash;
    } catch (_) {
      return src;
    }
  }

  function flattenRoutes(sections) {
    const map = new Map();
    (sections || []).forEach(sec => {
      (sec.items || []).forEach(item => {
        map.set(item.id, { ...item, section: sec.section });
      });
    });
    return map;
  }

  function renderShell(main, cfg) {
    main.innerHTML = `
      <header class="bcn-header">
        <div style="flex:1;min-width:0;">
          <div class="bcn-header-title"><h1>${esc(cfg.title)}</h1></div>
          <div class="bcn-header-sub">${esc(cfg.subtitle || '')}</div>
        </div>
        <div class="bcn-header-actions">
          <button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--mono" data-hub-reload>RELOAD</button>
          <button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--mono" data-hub-popout>POP OUT</button>
        </div>
      </header>
      <div class="hub-viewer-main">
        <section class="hub-viewer-body" aria-label="Tool viewer">
          <div class="bcn-card hub-viewer-card">
            <header class="bcn-card-header bcn-card-header--dark">
              <span class="bcn-pill bcn-pill--dark">TOOL</span>
              <h2 id="hubViewerTitle">${esc(cfg.title)}</h2>
              <span class="hub-viewer-status" data-hub-status data-state="idle">SELECT A TOOL</span>
            </header>
            <div class="bcn-card-body">
              <div class="hub-viewer-empty" id="hubEmpty">
                <div>
                  <h2>Choose from the menu</h2>
                  <p>Use the SILO sidebar (☰ on mobile) — same sections and order as the finance department console. Full v2 tools open as their own page; legacy tools load here with Beacon styling.</p>
                </div>
              </div>
              <div class="ts-loading" data-hub-loading hidden>
                <div class="ts-spin"></div>
                <div>Loading tool…</div>
              </div>
              <div class="ts-error" data-hub-error hidden>
                <div class="ts-error-title">Could not load this tool</div>
                <div class="ts-error-sub" data-hub-error-msg></div>
                <button type="button" class="bcn-btn bcn-btn--primary bcn-btn--mono" data-hub-retry>TRY AGAIN</button>
              </div>
              <iframe class="hub-viewer-frame" data-hub-frame title="Tool" hidden></iframe>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function parseConfig(main) {
    const raw = main.getAttribute('data-hub');
    if (!raw) return null;
    try {
      const cfg = JSON.parse(raw);
      const table = window.SILO_HUB_ROUTES?.[cfg.hub];
      if (table) cfg.routes = table;
      return cfg;
    } catch (e) {
      console.error('hub-viewer: invalid data-hub JSON', e);
      return null;
    }
  }

  async function bootAuth(supabaseClient) {
    if (!supabaseClient) return { user: null };
    const { data } = await supabaseClient.auth.getSession();
    const u = data?.session?.user;
    if (!u) return { user: null };
    let role = 'MEMBER';
    try {
      const { data: prof } = await supabaseClient
        .from('profiles')
        .select('role')
        .eq('id', u.id)
        .maybeSingle();
      if (prof?.role) role = String(prof.role).toUpperCase();
    } catch (_) {}
    return { user: { email: u.email, role }, supabaseClient };
  }

  function initHub(main, cfg) {
    const routeMap = flattenRoutes(cfg.routes);
    const titleEl = main.querySelector('#hubViewerTitle');
    const statusEl = main.querySelector('[data-hub-status]');
    const emptyEl = main.querySelector('#hubEmpty');
    const loadingEl = main.querySelector('[data-hub-loading]');
    const errEl = main.querySelector('[data-hub-error]');
    const errMsg = main.querySelector('[data-hub-error-msg]');
    const frame = main.querySelector('[data-hub-frame]');
    let current = null;
    let loaded = false;
    let watchdog = null;

    function setStatus(state, label) {
      if (statusEl) {
        statusEl.dataset.state = state;
        statusEl.textContent = label;
      }
    }

    function showEmpty(show) {
      if (emptyEl) emptyEl.hidden = !show;
      if (frame) frame.hidden = show;
    }

    function navigate(item) {
      if (!item) return;
      current = item;

      if (titleEl) titleEl.textContent = item.label;
      document.title = `SILO · ${item.label}`;

      if (item.v2Href) {
        const url = new URL(item.v2Href, window.location.origin);
        url.searchParams.set('from', cfg.hub || 'hub');
        window.location.href = url.pathname + url.search + url.hash;
        return;
      }

      if (item.external || !item.src) {
        window.open(item.src || item.external, '_blank', 'noopener,noreferrer');
        setStatus('ready', 'OPENED EXTERNALLY');
        return;
      }

      showEmpty(false);
      loadingEl.hidden = false;
      errEl.hidden = true;
      setStatus('loading', 'LOADING');
      loaded = false;
      clearTimeout(watchdog);
      frame.hidden = false;
      frame.src = embedSrc(item.src);

      watchdog = setTimeout(() => {
        if (loaded) return;
        loadingEl.hidden = true;
        errEl.hidden = false;
        if (errMsg) errMsg.textContent = `${item.src} did not respond within 15 seconds.`;
        setStatus('error', 'TIMED OUT');
      }, 15000);
    }

    frame?.addEventListener('load', () => {
      if (!current?.src) return;
      loaded = true;
      clearTimeout(watchdog);
      loadingEl.hidden = true;
      errEl.hidden = true;
      setStatus('ready', 'READY');
    });

    function reload() {
      if (current) navigate(current);
    }

    main.querySelector('[data-hub-reload]')?.addEventListener('click', reload);
    main.querySelector('[data-hub-retry]')?.addEventListener('click', reload);
    main.querySelector('[data-hub-popout]')?.addEventListener('click', () => {
      if (!current) return;
      const url = current.v2Href || current.src;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });

    const routeId = new URLSearchParams(location.search).get('route');
    if (routeId && routeMap.has(routeId)) {
      navigate(routeMap.get(routeId));
    } else if (cfg.defaultRoute && routeMap.has(cfg.defaultRoute)) {
      navigate(routeMap.get(cfg.defaultRoute));
    }

    return { navigate, routeMap };
  }

  async function init() {
    const app = document.getElementById('silo-app');
    const main = app?.querySelector('.silo-main');
    if (!main) return console.error('hub-viewer: missing #silo-app .silo-main');

    const cfg = parseConfig(main);
    if (!cfg) return;

    document.title = `SILO · ${cfg.title}`;
    renderShell(main, cfg);

    const cfg2 = window.__SILO_CONFIG__ || {};
    let supabaseClient = null;
    if (cfg2.SUPABASE_URL && cfg2.SUPABASE_ANON_KEY && window.supabase?.createClient) {
      supabaseClient = window.supabase.createClient(cfg2.SUPABASE_URL, cfg2.SUPABASE_ANON_KEY);
    }

    const { user } = await bootAuth(supabaseClient);
    if (!user && cfg2.REQUIRE_AUTH !== false) {
      location.href = `${LOGIN}?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }

    if (window.SiloChrome) {
      window.SiloChrome.mount({
        appEl: '#silo-app',
        active: cfg.active || 'hub',
        crumbs: cfg.crumbs || [cfg.title],
        user: user || { email: 'Signed out', role: 'MEMBER' },
        supabaseClient,
      });
    }

    initHub(main, cfg);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
