/* Revenue projection suite navigation only: the projection and the scenarios
   built on it as one tab strip across their own pages. Same shape as
   purchasing-suite.js and performance-suite.js -- a strip of REAL links across
   REAL pages, so every existing URL, bookmark and deep link keeps working and
   no page is implemented twice.

   A tab's visibility is not decided here. Each tab is also a NAV_ITEMS row
   (the scenarios marked `tabOf`), and the strip shows exactly the tabs whose
   row navSectionsForCompany() returns -- so the module switch and every
   per-row gate still apply, with no second copy of either. That is discovery,
   not access: each page's own checks and RLS are the boundary, and a direct
   URL was never a leak. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before PROJECTIONS_SUITE_PAGES existed.
  const pages = () => window.SiloNav?.PROJECTIONS_SUITE_PAGES || [];
  function contains(active) { return pages().some(([id]) => id === active); }

  // Fails to the SMALLER strip, as resolveNavProfile(null) does: a deep-linked
  // tab has no cached company (sessionStorage is per-tab, the auth session is
  // not), so a narrowed tab is hidden for one paint and restored by refresh()
  // once silo-chrome.js has resolved the real company.
  function allowed() {
    const co = window.__SILO_CONFIG__?.getActiveCompany?.() || null;
    const ids = new Set();
    try {
      for (const sec of window.SiloNav?.navSectionsForCompany?.(co) || []) {
        for (const item of sec.items) ids.add(item.id);
      }
    } catch { /* no nav: only the open page's own tab is drawn */ }
    return ids;
  }

  // The page you are LOOKING AT is always in its own strip: hiding the tab for
  // the open page would leave no way back out of it.
  function visible(active) {
    const ok = allowed();
    return pages().filter(([id]) => id === active || ok.has(id));
  }

  /* Same drawing as the other strips: 24-unit box, 1.6 stroke, round caps,
     currentColor. Keyed by tab id with a neutral fallback. */
  const ICONS = {
    // A rising line: the projection itself.
    'planning/revenue-projections': '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="21 12 21 7 16 7"/>',
    // Two branching paths: the scenarios built on it.
    'planning/scenarios': '<path d="M6 3v6a3 3 0 0 0 3 3h9"/><path d="M6 21v-6"/><polyline points="15 9 18 12 15 15"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function build(active) {
    const shown = visible(active);
    const nav = document.createElement('nav');
    nav.className = 'proj-suite-nav';
    nav.dataset.projSuite = '';
    // Which tabs this strip was drawn with, so refresh() can tell a changed
    // set from an unchanged one without re-reading the DOM's links.
    nav.dataset.projSuiteTabs = shown.map(([id]) => id).join(',');
    nav.setAttribute('aria-label', 'Projections');
    const label = document.createElement('span');
    label.className = 'proj-suite-label';
    label.textContent = 'Projections';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'proj-suite-links';
    for (const [id, title, path] of shown) {
      const link = document.createElement('a');
      link.href = '/v2/' + path;
      link.title = title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'proj-suite-text';
      text.textContent = title;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    return nav;
  }

  function mount(main, active) {
    if (!contains(active) || !main || main.querySelector('[data-proj-suite]')) return;
    main.firstElementChild?.after(build(active));
  }

  // Called again once the company (and so the nav profile) is known. Replaces
  // the strip only when the set of tabs actually changed, so a normal load --
  // cache already correct -- never flickers it.
  function refresh(main, active) {
    if (!contains(active) || !main) return;
    const existing = main.querySelector('[data-proj-suite]');
    if (!existing) { mount(main, active); return; }
    const wanted = visible(active).map(([id]) => id).join(',');
    if (wanted === existing.dataset.projSuiteTabs) return;
    existing.replaceWith(build(active));
  }

  window.SiloProjectionsSuite = { contains, mount, refresh };
})();
