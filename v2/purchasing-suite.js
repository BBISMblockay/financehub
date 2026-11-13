/* Purchasing suite navigation only: Overview, PO Builder, PO Report, Landed
   Cost and Factories as one tab strip across their own pages. Same shape as
   performance-suite.js, marketing-suite.js and seo-suite.js -- a strip of REAL
   links across REAL pages, so every existing URL, bookmark and deep link keeps
   working and no page is implemented twice.

   A tab's visibility is not decided here. Every tab is also a NAV_ITEMS row
   (marked `tabOf`), and the strip shows exactly the tabs whose row
   navSectionsForCompany() returns -- so the Purchasing module switch and every
   per-row gate still apply, with no second copy of any of them. That is
   discovery, not access: each page's own checks and RLS are the boundary, and
   a direct URL was never a leak. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before PURCHASING_SUITE_PAGES existed.
  const pages = () => window.SiloNav?.PURCHASING_SUITE_PAGES || [];
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
    // A gauge: how the whole thing stands.
    'purchasing/home': '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    // A page with a pencil: the order being written.
    'purchasing/po-builder': '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/><path d="M9 16l6-6 1.5 1.5-6 6H9z"/>',
    // A box in motion: what is on its way in.
    'purchasing/po-report': '<path d="M3 8l9-4 9 4v8l-9 4-9-4z"/><path d="M3 8l9 4 9-4"/><path d="M12 12v8"/>',
    // A tag with a value: what the order costs landed.
    'purchasing/po-costing': '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    // A plant with a stack: where it is made.
    'purchasing/factories': '<path d="M3 21V10l5 3V10l5 3V10l5 3v8z"/><path d="M18 13V3h3v10"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function build(active) {
    const shown = visible(active);
    const nav = document.createElement('nav');
    nav.className = 'purch-suite-nav';
    nav.dataset.purchSuite = '';
    // Which tabs this strip was drawn with, so refresh() can tell a changed
    // set from an unchanged one without re-reading the DOM's links.
    nav.dataset.purchSuiteTabs = shown.map(([id]) => id).join(',');
    nav.setAttribute('aria-label', 'Purchasing');
    const label = document.createElement('span');
    label.className = 'purch-suite-label';
    label.textContent = 'Purchasing';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'purch-suite-links';
    for (const [id, title, path] of shown) {
      const link = document.createElement('a');
      link.href = '/v2/' + path;
      link.title = title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'purch-suite-text';
      text.textContent = title;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    return nav;
  }

  function mount(main, active) {
    if (!contains(active) || !main || main.querySelector('[data-purch-suite]')) return;
    main.firstElementChild?.after(build(active));
  }

  // Called again once the company (and so the nav profile) is known. Replaces
  // the strip only when the set of tabs actually changed, so a normal load --
  // cache already correct -- never flickers it.
  function refresh(main, active) {
    if (!contains(active) || !main) return;
    const existing = main.querySelector('[data-purch-suite]');
    if (!existing) { mount(main, active); return; }
    const wanted = visible(active).map(([id]) => id).join(',');
    if (wanted === existing.dataset.purchSuiteTabs) return;
    existing.replaceWith(build(active));
  }

  window.SiloPurchasingSuite = { contains, mount, refresh };
})();
