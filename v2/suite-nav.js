/* One generic suite tab strip, for the suites whose tabs are plain pages:
   Inventory, Requests, Planning and Team (2026-11-13).

   Same shape as purchasing-suite.js / performance-suite.js -- a strip of REAL
   links across REAL pages, so every existing URL, bookmark and deep link keeps
   working and no page is implemented twice -- but driven by SiloNav.SUITES
   rather than one file per suite, so a fifth suite is a few lines of data.

   A tab's visibility is not decided here. Every tab is also a NAV_ITEMS row
   (marked `tabOf`), and the strip shows exactly the tabs whose row
   navSectionsForCompany() returns -- so TikTok Live Schedule and the Team
   pages stay grandfathered-only, Request Manager and Mailroom keep their
   department gates, and the module switches still apply, with no second copy
   of any gate. That is discovery, not access: each page's own checks and RLS
   are the boundary, and a direct URL was never a leak. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before SUITES existed.
  const suites = () => window.SiloNav?.SUITES || [];
  function suiteOf(active) {
    return suites().find((s) => s.pages.some(([id]) => id === active)) || null;
  }
  function contains(active) { return !!suiteOf(active); }
  function rowOf(active) { return suiteOf(active)?.row || active; }

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
    const suite = suiteOf(active);
    if (!suite) return [];
    const ok = allowed();
    return suite.pages.filter(([id]) => id === active || ok.has(id));
  }

  /* Same drawing as the other strips: 24-unit box, 1.6 stroke, round caps,
     currentColor. Keyed by tab id with a neutral fallback. */
  const ICONS = {
    // Stacked boxes: what is on the shelf.
    'inventory/workboard': '<path d="M3 8l9-4 9 4v8l-9 4-9-4z"/><path d="M3 8l9 4 9-4"/><path d="M12 12v8"/>',
    // A tag: the catalogue.
    'inventory/products': '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    // A spark: the concept being shaped.
    'purchasing/product-studio': '<path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3z"/><path d="M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    // A form: the request being raised.
    'finance/payment-request': '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    // A tray with a tick: the queue being worked.
    'finance/request-manager': '<path d="M3 14h5l1.5 3h5L16 14h5"/><path d="M5 14V5h14v9"/><polyline points="9 9 11 11 15 7"/>',
    // An envelope: what arrived.
    'finance/mailroom': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    // A checklist: the work.
    'planning/tasks': '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><polyline points="3.5 6 4.5 7 6.5 5"/><polyline points="3.5 12 4.5 13 6.5 11"/><polyline points="3.5 18 4.5 19 6.5 17"/>',
    // A calendar: the dates.
    'planning/calendar': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    // A play mark: the live slot.
    'planning/live-schedule': '<circle cx="12" cy="12" r="9"/><path d="M10 9l5 3-5 3z"/>',
    // A person with a star: the review.
    'team/reviews': '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M18 3.5l1.1 2.4 2.4.6-2.4 1.6-.3 2.6-1.8-1.6-2.5.6 1-2.4-1.2-2.2 2.5.4z"/>',
    // A single person: your own.
    'team/my-review': '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
    // A coin: what is paid.
    'team/comp-requests': '<circle cx="12" cy="12" r="8"/><path d="M12 7v10"/><path d="M14.5 9.5a2.5 2.5 0 0 0-5 .6c0 2.4 5 1.4 5 3.8a2.5 2.5 0 0 1-5 .6"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function build(active) {
    const suite = suiteOf(active);
    const shown = visible(active);
    const nav = document.createElement('nav');
    nav.className = 'suite-nav';
    nav.dataset.suiteNav = suite.key;
    // Which tabs this strip was drawn with, so refresh() can tell a changed
    // set from an unchanged one without re-reading the DOM's links.
    nav.dataset.suiteNavTabs = shown.map(([id]) => id).join(',');
    nav.setAttribute('aria-label', suite.label);
    const label = document.createElement('span');
    label.className = 'suite-nav-label';
    label.textContent = suite.label;
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'suite-nav-links';
    for (const [id, title, href] of shown) {
      const link = document.createElement('a');
      link.href = href;
      link.title = title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'suite-nav-text';
      text.textContent = title;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    return nav;
  }

  function mount(main, active) {
    if (!contains(active) || !main || main.querySelector('[data-suite-nav]')) return;
    main.firstElementChild?.after(build(active));
  }

  // Called again once the company (and so the nav profile) is known. Replaces
  // the strip only when the set of tabs actually changed, so a normal load --
  // cache already correct -- never flickers it.
  function refresh(main, active) {
    if (!contains(active) || !main) return;
    const existing = main.querySelector('[data-suite-nav]');
    if (!existing) { mount(main, active); return; }
    const wanted = visible(active).map(([id]) => id).join(',');
    if (wanted === existing.dataset.suiteNavTabs) return;
    existing.replaceWith(build(active));
  }

  window.SiloSuiteNav = { contains, rowOf, mount, refresh };
})();
