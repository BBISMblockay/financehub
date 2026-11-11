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
      the strip is where someone moving between them is told so. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before PERFORMANCE_SUITE_PAGES existed.
  const pages = () => window.SiloNav?.PERFORMANCE_SUITE_PAGES || [];
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
    // A gauge: how the whole thing is doing.
    'reports/marketing-overview': '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    // A magnifier: the drill-down.
    'reports/marketing-explorer': '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    // A page with lines: the written report.
    'reports/wow-report': '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/><path d="M9 12h6"/><path d="M9 16h6"/>',
    // Joined points: the path to a purchase.
    'reports/silo-attribution': '<circle cx="5" cy="17" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="19" cy="15" r="2"/><path d="M6.3 15.4l4.4-5.8"/><path d="M13.6 9.4l3.9 4.2"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function build(active) {
    const shown = visible(active);
    const nav = document.createElement('nav');
    nav.className = 'perf-suite-nav';
    nav.dataset.perfSuite = '';
    // Which tabs this strip was drawn with, so refresh() can tell a changed
    // set from an unchanged one without re-reading the DOM's links.
    nav.dataset.perfSuiteTabs = shown.map(([id]) => id).join(',');
    nav.setAttribute('aria-label', 'Performance');
    const label = document.createElement('span');
    label.className = 'perf-suite-label';
    label.textContent = 'Performance';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'perf-suite-links';
    for (const [id, title, path, basis] of shown) {
      const link = document.createElement('a');
      link.href = '/v2/' + path;
      link.title = basis ? `${title}: ${basis}` : title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'perf-suite-text';
      text.textContent = title;
      link.append(text);
      if (basis) {
        const b = document.createElement('span');
        b.className = 'perf-suite-basis';
        b.textContent = basis;
        link.append(b);
      }
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    return nav;
  }

  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-perf-suite]')) return;
    main.firstElementChild.after(build(active));
  }

  // Called again once the company (and so the nav profile) is known. Replaces
  // the strip only when the set of tabs actually changed, so a normal load --
  // cache already correct -- never flickers it.
  function refresh(main, active) {
    if (!contains(active)) return;
    const existing = main.querySelector('[data-perf-suite]');
    if (!existing) { mount(main, active); return; }
    const wanted = visible(active).map(([id]) => id).join(',');
    if (wanted === existing.dataset.perfSuiteTabs) return;
    existing.replaceWith(build(active));
  }

  window.SiloPerformanceSuite = { contains, mount, refresh };
})();
