/* SEO suite navigation only: Studio, Search performance and Keywords as one
   tab strip across their own pages. Same shape as workspace-settings.js and
   accounting-suite.js -- a strip of REAL links across REAL pages, so every
   existing URL and bookmark keeps working and no page is implemented twice. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before SEO_SUITE_PAGES existed.
  const pages = () => window.SiloNav?.SEO_SUITE_PAGES || [];
  function contains(active) { return pages().some(([id]) => id === active); }

  /* Same drawing as the other strips: 24-unit box, 1.6 stroke, round caps,
     currentColor. Keyed by tab id with a neutral fallback. */
  const ICONS = {
    // A page with a pencil: the page being worked on.
    'seo/studio': '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/><path d="M9 16l6-6 1.5 1.5-6 6H9z"/>',
    // A rising line: how search is performing.
    'seo/performance': '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
    // A magnifier: the searches tracked.
    'seo/keywords': '<circle cx="11" cy="11" r="6"/><line x1="20" y1="20" x2="15.5" y2="15.5"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-seo-suite]')) return;
    const nav = document.createElement('nav');
    nav.className = 'seo-suite-nav';
    nav.dataset.seoSuite = '';
    nav.setAttribute('aria-label', 'SEO');
    const label = document.createElement('span');
    label.className = 'seo-suite-label';
    label.textContent = 'SEO';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'seo-suite-links';
    for (const [id, title, path] of pages()) {
      const link = document.createElement('a');
      link.href = '/v2/' + path;
      link.title = title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'seo-suite-text';
      text.textContent = title;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    main.firstElementChild.after(nav);
  }

  window.SiloSeoSuite = { contains, mount };
})();
