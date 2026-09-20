/* Workspace Settings navigation only. Each destination retains its page and
   data logic -- Integrations and Billing in particular are the pages that
   already existed, at their existing URLs, carrying their existing gates.

   Deliberately the same shape as accounting-suite.js rather than a new
   pattern: a strip of REAL links across REAL pages. A single-page shell would
   have meant new routes for two tabs that already have working ones, and
   losing every bookmark into them. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before WORKSPACE_SETTINGS_PAGES existed.
  const pages = () => window.SiloNav?.WORKSPACE_SETTINGS_PAGES || [];
  function contains(active) { return pages().some(([id]) => id === active); }

  /* Same drawing as the sidebar and the accounting strip -- 24-unit box, 1.6
     stroke, round caps, currentColor -- so the three navs read as one system.
     Keyed by tab id with a neutral fallback, so a tab added without an icon
     gets a plain page mark rather than a ragged row. */
  const ICONS = {
    // A building: the company itself.
    'settings/company': '<path d="M4 21V6l8-3 8 3v15"/><path d="M9 21v-5h6v5"/><line x1="8" y1="10" x2="8" y2="10.01"/><line x1="12" y1="10" x2="12" y2="10.01"/><line x1="16" y1="10" x2="16" y2="10.01"/>',
    // Two people: who is in the workspace.
    'settings/team': '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1"/><path d="M16 5.5a3 3 0 0 1 0 5.8"/><path d="M18 14.2A4.6 4.6 0 0 1 21 18.5V20"/>',
    // Two linked blocks: connections out.
    'settings/integrations': '<rect x="3" y="8" width="7" height="8" rx="1.5"/><rect x="14" y="8" width="7" height="8" rx="1.5"/><line x1="10" y1="12" x2="14" y2="12"/>',
    // A card: the subscription.
    'settings/billing': '<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="7" y1="15" x2="11" y2="15"/>',
    // A bell: who gets told.
    'settings/notifications': '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-workspace-settings]')) return;
    const nav = document.createElement('nav');
    nav.className = 'workspace-settings-nav';
    nav.dataset.workspaceSettings = '';
    nav.setAttribute('aria-label', 'Workspace settings');
    const label = document.createElement('span');
    label.className = 'workspace-settings-label';
    label.textContent = 'Workspace';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'workspace-settings-links';
    for (const [id, title, path] of pages()) {
      const link = document.createElement('a');
      link.href = '/v2/' + path;
      link.title = title;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'workspace-settings-text';
      text.textContent = title;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    main.firstElementChild.after(nav);
  }

  window.SiloWorkspaceSettings = { contains, mount };
})();
