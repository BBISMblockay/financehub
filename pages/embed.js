/* ========================================================================
   SILO embed mode — hide app chrome when a tool loads inside v2 tool-shell
   or another SILO iframe. Append ?embed=1 (tool-shell does this automatically).

   Usage (early in <head> or before layout CSS):
     <script src="/pages/embed.js"></script>
   ======================================================================== */

(function () {
  function isEmbedded() {
    try {
      if (window.self !== window.top) return true;
    } catch (_) {
      return true;
    }
    const q = new URLSearchParams(window.location.search);
    const v = (q.get('embed') || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  function appendEmbedParam(url) {
    try {
      const u = new URL(url, window.location.origin);
      if (u.origin !== window.location.origin) return url;
      u.searchParams.set('embed', '1');
      return u.pathname + u.search + u.hash;
    } catch (_) {
      return url;
    }
  }

  const EMBED_CSS = `
html.silo-embed, html.silo-embed body {
  margin: 0;
  min-height: 100%;
  height: 100%;
  overflow: auto;
  background: transparent;
}
html.silo-embed .sidebar,
html.silo-embed aside.sidebar,
html.silo-embed nav.sidebar,
html.silo-embed #sidebar,
html.silo-embed .ps-sidebar,
html.silo-embed .ps-app > aside.ps-sidebar,
html.silo-embed .silo-sidebar,
html.silo-embed .silo-edge,
html.silo-embed .filter-rail,
html.silo-embed .mobile-toggle,
html.silo-embed [data-silo-action="collapse"] {
  display: none !important;
}
html.silo-embed .app,
html.silo-embed .wrap,
html.silo-embed .ps-app {
  display: block !important;
  grid-template-columns: 1fr !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
  height: 100% !important;
  min-height: 0 !important;
}
html.silo-embed .app > aside,
html.silo-embed .wrap > aside:first-child {
  display: none !important;
}
html.silo-embed .main,
html.silo-embed .viewer-shell,
html.silo-embed .ps-main,
html.silo-embed .ts-body {
  min-height: 100% !important;
  height: 100% !important;
}
html.silo-embed :root {
  --sidebar-w: 0px !important;
  --sidebarW: 0px !important;
}
`;

  function injectBeaconEmbedAssets() {
    const head = document.head || document.documentElement;
    if (!document.getElementById('silo-embed-beacon-css')) {
      const link = document.createElement('link');
      link.id = 'silo-embed-beacon-css';
      link.rel = 'stylesheet';
      link.href = '/pages/embed-beacon.css';
      head.appendChild(link);
    }
  }

  function applyEmbedMode() {
    if (!isEmbedded()) return false;
    const root = document.documentElement;
    root.classList.add('silo-embed');
    if (document.body) document.body.classList.add('silo-embed');
    if (!document.getElementById('silo-embed-style')) {
      const style = document.createElement('style');
      style.id = 'silo-embed-style';
      style.textContent = EMBED_CSS;
      (document.head || root).appendChild(style);
    }
    injectBeaconEmbedAssets();
    return true;
  }

  window.__SILO_EMBED__ = {
    isEmbedded,
    applyEmbedMode,
    appendEmbedParam,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyEmbedMode);
  } else {
    applyEmbedMode();
  }
  applyEmbedMode();
})();
