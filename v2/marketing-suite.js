/* Ad Studio suite navigation only: Ad Studio and Testing & schedule as one tab
   strip across their own pages. Same shape as seo-suite.js, workspace-settings.js
   and accounting-suite.js -- a strip of REAL links across REAL pages, so every
   existing URL and bookmark keeps working and no page is implemented twice.

   One difference from the other strips: a tab may carry its own profiles list
   (AD_STUDIO_SUITE_PAGES' fourth element), because Testing & schedule is
   Baseballism-only for now while the row itself is not. That is discovery, not
   access -- marketing_tests RLS is the boundary and a direct URL is not a leak. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before AD_STUDIO_SUITE_PAGES existed.
  const pages = () => window.SiloNav?.AD_STUDIO_SUITE_PAGES || [];
  function contains(active) { return pages().some(([id]) => id === active); }

  // Fails to the SMALLER strip, exactly as resolveNavProfile(null) does: a
  // deep-linked tab has no cached company (sessionStorage is per-tab, the auth
  // session is not), so a narrowed tab is hidden for one paint and restored by
  // refresh() once silo-chrome.js has resolved the real company.
  function profile() {
    const co = window.__SILO_CONFIG__?.getActiveCompany?.() || null;
    return window.SiloNav?.resolveNavProfile?.(co) || 'standard';
  }

  // The page you are LOOKING AT is always in its own strip: hiding the tab for
  // the open page would leave no way back out of it.
  function visible(active) {
    const p = profile();
    return pages().filter(([id, , , profiles]) => id === active || !profiles || profiles.includes(p));
  }

  /* Same drawing as the other strips: 24-unit box, 1.6 stroke, round caps,
     currentColor. Keyed by tab id with a neutral fallback. */
  const ICONS = {
    // A frame with a spark: the creative being made.
    'ads/studio': '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 14l3-3 2.5 2.5L17 10"/>',
    // A beaker: what is being tried and read.
    'ads/testing': '<path d="M9 3h6"/><path d="M10 3v5l-4.5 9A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 8V3"/><path d="M7.5 15h9"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function build(active) {
    const shown = visible(active);
    const nav = document.createElement('nav');
    nav.className = 'ads-suite-nav';
    nav.dataset.adsSuite = '';
    // Which tabs this strip was drawn with, so refresh() can tell a changed
    // set from an unchanged one without re-reading the DOM's links.
    nav.dataset.adsSuiteTabs = shown.map(([id]) => id).join(',');
    nav.setAttribute('aria-label', 'Ad Studio');
    const label = document.createElement('span');
    label.className = 'ads-suite-label';
    label.textContent = 'Ad Studio';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'ads-suite-links';
    for (const [id, title, path] of shown) {
      const link = document.createElement('a');
      link.href = '/v2/' + path;
      link.title = title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'ads-suite-text';
      text.textContent = title;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    return nav;
  }

  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-ads-suite]')) return;
    main.firstElementChild.after(build(active));
  }

  // Called again once the company (and so the nav profile) is known. Replaces
  // the strip only when the set of tabs actually changed, so a normal load --
  // cache already correct -- never flickers it.
  function refresh(main, active) {
    if (!contains(active)) return;
    const existing = main.querySelector('[data-ads-suite]');
    if (!existing) { mount(main, active); return; }
    const wanted = visible(active).map(([id]) => id).join(',');
    if (wanted === existing.dataset.adsSuiteTabs) return;
    existing.replaceWith(build(active));
  }

  window.SiloAdStudioSuite = { contains, mount, refresh };
})();
