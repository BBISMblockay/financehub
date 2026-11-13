/* Performance suite navigation only: Overview, Explorer, Report and Attribution
   as one tab strip across their own pages. Same shape as marketing-suite.js and
   seo-suite.js -- a strip of REAL links across REAL pages, so every existing
   URL, bookmark and saved link keeps working and no page is implemented twice.

   Two differences from the other strips:

   1. A tab's visibility is not decided here. Every tab is also a NAV_ITEMS row
      (marked `tabOf`), and the strip shows exactly the tabs whose row
      navSectionsForCompany() returns -- so Report and Attribution stay
      Baseballism-only, Attribution keeps its pilot companyGate, and the
      Marketing module switch still applies, with no second copy of any gate.
      That is discovery, not access: each page's own checks and RLS are the
      boundary, and a direct URL was never a leak.
   2. Each tab names the revenue figure its page is built on. The four pages
      measure different things and their numbers must not be added together;
      the strip is where someone moving between them is told so.
   3. Overview and Explorer share one selection -- the date window, platform,
      campaign, ad set and ad -- kept in the address bar by each page. Moving
      between those two tabs carries it, so the campaign you drilled to is
      still the campaign after switching view. Report and Attribution have
      their own period models and are never handed these keys. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before PERFORMANCE_SUITE_PAGES existed.
  const pages = () => window.SiloNav?.PERFORMANCE_SUITE_PAGES || [];

  // Ad Studio and SEO are tabs of this strip, and each is itself a small suite
  // of pages (the Schedule; Search performance, Keywords, Tasks). Their inner
  // pages resolve to the tab they belong to, so the Marketing strip is drawn
  // on every marketing page -- with that tab marked current -- and the inner
  // strip draws underneath it (2026-11-13).
  function resolve(active) {
    if (window.SiloSeoSuite?.contains?.(active)) return 'reports/seo';
    if (window.SiloAdStudioSuite?.contains?.(active)) return 'reports/ad-studio';
    return active;
  }
  function contains(active) { const a = resolve(active); return pages().some(([id]) => id === a); }

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
    const a = resolve(active);
    return pages().filter(([id]) => id === a || ok.has(id));
  }

  // The keys Overview and Explorer both understand (or keep for each other).
  const CONTEXT_KEYS = ['days', 'start', 'end', 'platform', 'campaign', 'adset', 'ad'];
  const SHARES_CONTEXT = ['reports/marketing-overview', 'reports/marketing-explorer'];
  // A tab's href, with the current selection when BOTH ends share it. The
  // selection is in the REAL href, not added by a click handler, so a
  // middle-click, "Open link in new tab" and a copied link all carry it the
  // same way a plain click does. sync() below keeps it current.
  function hrefWithContext(active, id, path, search) {
    const base = '/v2/' + path;
    if (!SHARES_CONTEXT.includes(active) || !SHARES_CONTEXT.includes(id)) return base;
    const from = new URLSearchParams(search || '');
    const out = new URLSearchParams();
    for (const k of CONTEXT_KEYS) { const v = from.get(k); if (v) out.set(k, v); }
    const qs = out.toString();
    return qs ? base + '?' + qs : base;
  }

  /* Same drawing as the other strips: 24-unit box, 1.6 stroke, round caps,
     currentColor. Keyed by tab id with a neutral fallback. */
  const ICONS = {
    // A gauge: how the whole thing is doing.
    'reports/marketing-overview': '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    // A magnifier: the drill-down.
    'reports/marketing-explorer': '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    // A page with lines: the written report.
    'reports/wow-report': '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/><path d="M9 12h6"/><path d="M9 16h6"/>',
    // Joined points: the path to a purchase.
    'reports/silo-attribution': '<circle cx="5" cy="17" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="19" cy="15" r="2"/><path d="M6.3 15.4l4.4-5.8"/><path d="M13.6 9.4l3.9 4.2"/>',
    // A spark: the ads being made.
    'reports/ad-studio': '<path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3z"/><path d="M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    // A magnifier over a globe: search.
    'reports/seo': '<circle cx="11" cy="11" r="6"/><path d="M5 11h12"/><path d="M11 5c2 2.2 2 9.8 0 12"/><path d="M20 20l-4.5-4.5"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function build(active) {
    const shown = visible(active);
    // The tab that is current may be the one this page sits UNDER: an SEO
    // keyword page marks the SEO tab, not a tab of its own.
    const current = resolve(active);
    const nav = document.createElement('nav');
    nav.className = 'perf-suite-nav';
    nav.dataset.perfSuite = '';
    // Which tabs this strip was drawn with, so refresh() can tell a changed
    // set from an unchanged one without re-reading the DOM's links.
    nav.dataset.perfSuiteTabs = shown.map(([id]) => id).join(',');
    nav.setAttribute('aria-label', 'Marketing');
    const label = document.createElement('span');
    label.className = 'perf-suite-label';
    label.textContent = 'Marketing';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'perf-suite-links';
    for (const [id, title, path, basis] of shown) {
      const link = document.createElement('a');
      link.href = hrefWithContext(active, id, path, window.location?.search);
      link.dataset.perfTab = id;
      link.dataset.perfPath = path;
      link.title = basis ? `${title}: ${basis}` : title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'perf-suite-text';
      text.textContent = title;
      link.append(text);
      // The basis -- which revenue figure the tab's page is built on -- is
      // the link's tooltip, not a caption. Printed beside every tab it made
      // the strip read as four tabs with four grey footnotes rather than a
      // tab row (2026-11-13).
      if (id === current) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    // The pages call sync() whenever they rewrite the address bar. These are
    // the backstop for a rewrite that did not: every way of reaching a link
    // (pointer, keyboard focus, context menu) refreshes it first.
    for (const ev of ['pointerdown', 'mouseover', 'focusin', 'contextmenu']) {
      nav.addEventListener?.(ev, () => syncNav(nav, active));
    }
    return nav;
  }

  // Point every link at its page with the selection the address bar holds now.
  function syncNav(nav, active) {
    for (const link of nav.querySelectorAll?.('a[data-perf-tab]') || []) {
      const href = hrefWithContext(active, link.dataset.perfTab, link.dataset.perfPath, window.location?.search);
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
  }
  let mountedActive = null;
  function sync() {
    const nav = (typeof document !== 'undefined') && document.querySelector?.('[data-perf-suite]');
    if (nav && mountedActive) syncNav(nav, mountedActive);
  }

  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-perf-suite]')) return;
    mountedActive = active;
    main.firstElementChild.after(build(active));
  }

  // Called again once the company (and so the nav profile) is known. Replaces
  // the strip only when the set of tabs actually changed, so a normal load --
  // cache already correct -- never flickers it.
  function refresh(main, active) {
    if (!contains(active)) return;
    mountedActive = active;
    const existing = main.querySelector('[data-perf-suite]');
    if (!existing) { mount(main, active); return; }
    const wanted = visible(active).map(([id]) => id).join(',');
    if (wanted === existing.dataset.perfSuiteTabs) return;
    existing.replaceWith(build(active));
  }

  window.SiloPerformanceSuite = { contains, mount, refresh, sync, hrefWithContext };
})();
