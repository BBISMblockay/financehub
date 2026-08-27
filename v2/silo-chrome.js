/* ========================================================================
   SILO chrome v2 — sidebar + utility bar.
   Every SILO page mounts this once. Active branch auto-expands.

   Include on each page (after beacon.css + inline styles):
     <link rel="stylesheet" href="silo-brand.css" />
     <link rel="stylesheet" href="beacon-mirrors-unified.css" />
     <link rel="stylesheet" href="v2-mobile.css" />
     <script src="v2-shell.js" defer></script>
     <script src="nav-config.js"></script>
     <script src="silo-chrome.js"></script>
     <script>
       SiloChrome.mount({
         appEl: '#silo-app',
         active: 'planning/revenue-projections',
         user: { email: 'drew@baseballism.com', role: 'OWNER' },
         crumbs: ['Planning', 'Revenue projections'],
         supabaseClient,  // optional — used for sign-out
       });
     </script>
   ======================================================================== */

(function () {
  const Nav = window.SiloNav;
  if (!Nav) {
    console.error('SiloChrome: load nav-config.js before silo-chrome.js');
    return;
  }

  const { resolveNavProfile, navSectionsForCompany } = Nav;

  const ICONS = {
    hub:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    finance:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    inventory:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><line x1="12" y1="11" x2="12" y2="21"/></svg>',
    sales:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>',
    purchasing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 13.5a2 2 0 0 0 2 1.5h7.5a2 2 0 0 0 2-1.5L21 7H6"/></svg>',
    wholesale:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-7h6v7"/><line x1="3" y1="21" x2="21" y2="21"/></svg>',
    planning:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="3" y="4" width="18" height="17" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>',
    people:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="9" cy="8" r="3.5"/><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="6" r="2.5"/><path d="M16 13c3 0 6 2 6 5"/></svg>',
    ops:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    search:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="11" cy="11" r="6.5"/><line x1="20" y1="20" x2="16" y2="16"/></svg>',
    bell:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M6 8a6 6 0 1 1 12 0c0 4 2 5 2 7H4c0-2 2-3 2-7z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
    sun:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    moon:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    collapse:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>',
  };

  const LS_COLLAPSED     = 'silo.sidebar.collapsed';
  const LS_THEME         = 'silo.theme';

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Accordion nav: exactly one section open at a time. Nothing persists —
  // each page load opens only the section containing the active page, so the
  // menu always "resets" instead of accumulating expanded sections. (The old
  // silo.nav.sections.open localStorage set grew forever; it is abandoned.)

  function getActiveCompany() {
    try {
      return window.__SILO_CONFIG__?.getActiveCompany?.() || null;
    } catch {
      return null;
    }
  }

  // Department-based nav filtering. The department comes from profiles and
  // is cached per session; the first render of a fresh session shows the
  // unfiltered nav (null department = no filtering) and re-renders once the
  // profile fetch lands. Hiding is UX only — the data behind finance links
  // is gated by department-aware RLS, not by this menu.
  const SS_DEPT = 'silo:nav:department';
  function getCachedDepartment() {
    try { return sessionStorage.getItem(SS_DEPT) || null; } catch { return null; }
  }
  async function resolveDepartment(sb) {
    const cached = getCachedDepartment();
    if (cached) return cached;
    if (!sb) return null;
    try {
      const sess = await sb.auth.getSession();
      const uid = sess?.data?.session?.user?.id;
      if (!uid) return null;
      const { data } = await sb.from('profiles').select('department').eq('id', uid).single();
      const dept = String(data?.department || 'unknown').toLowerCase();
      try { sessionStorage.setItem(SS_DEPT, dept); } catch {}
      return dept;
    } catch {
      return null;
    }
  }

  // Grant-based nav unlocks (nav-config.js item.grantTable) — e.g.
  // silo_chat_managers, so someone granted Ask SILO access via
  // backend.html sees the link without an exec/owner profiles.role. Same
  // session-cache-then-resolve shape as department, but the first paint
  // uses an EMPTY set (fails closed — roles already decided visibility,
  // this can only add a "yes" once confirmed) instead of failing open.
  const SS_GRANTS = 'silo:nav:grantIds';
  function getCachedGrantIds() {
    try {
      const raw = sessionStorage.getItem(SS_GRANTS);
      return raw ? new Set(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }
  async function resolveGrantIds(sb) {
    const cached = getCachedGrantIds();
    if (cached) return cached;
    const grantItems = (Nav.NAV_ITEMS || []).filter((i) => i.grantTable);
    if (!grantItems.length || !sb) return new Set();
    try {
      const sess = await sb.auth.getSession();
      const uid = sess?.data?.session?.user?.id;
      if (!uid) return new Set();
      const ids = new Set();
      for (const item of grantItems) {
        const { data } = await sb.from(item.grantTable).select('id').eq('user_id', uid).maybeSingle();
        if (data) ids.add(item.id);
      }
      try { sessionStorage.setItem(SS_GRANTS, JSON.stringify([...ids])); } catch {}
      return ids;
    } catch {
      return new Set();
    }
  }

  // Sidebar user avatar — same session-cache-then-resolve pattern as
  // department above, so the first paint (initials) never blocks on a
  // network round trip and only re-renders once the real photo is known.
  const SS_AVATAR = 'silo:nav:avatarUrl';
  function getCachedAvatarUrl() {
    try { return sessionStorage.getItem(SS_AVATAR) || null; } catch { return null; }
  }
  async function resolveAvatarUrl(sb) {
    if (!sb) return null;
    try {
      const sess = await sb.auth.getSession();
      const uid = sess?.data?.session?.user?.id;
      if (!uid) return null;
      const { data } = await sb.from('profiles').select('avatar_url').eq('id', uid).single();
      const url = data?.avatar_url || '';
      try { sessionStorage.setItem(SS_AVATAR, url); } catch {}
      return url || null;
    } catch {
      return null;
    }
  }

  function renderNavSections(active, department, role, grantIds) {
    const company = getActiveCompany();
    const NAV_SECTIONS = navSectionsForCompany(company, department ?? getCachedDepartment(), role, grantIds ?? getCachedGrantIds());
    // Determine which section contains the active item
    const activeSection = NAV_SECTIONS.find(s => s.items.some(i => i.id === active))?.section || null;

    return NAV_SECTIONS.map(sec => {
      const isOpen = sec.section === activeSection;
      const links = sec.items.map(item => {
        const isActive = item.id === active;
        const ext = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a class="silo-sb-link${isActive ? ' silo-sb-link--active' : ''}" href="${escHtml(item.href)}" data-nav-id="${escHtml(item.id)}"${ext}>
            <span class="silo-sb-link-label">${escHtml(item.label)}</span>
            ${item.external ? '<span class="silo-sb-link-ext" aria-hidden="true">EXT</span>' : ''}
          </a>`;
      }).join('');
      return `
        <div class="silo-sb-section${isOpen ? ' silo-sb-section--open' : ''}" data-section="${escHtml(sec.section)}">
          <button class="silo-sb-section-label" type="button" data-silo-action="section-toggle" data-section="${escHtml(sec.section)}" aria-expanded="${isOpen}">
            <span>${escHtml(sec.section)}</span>
            <svg class="silo-sb-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="silo-sb-links">${links}</div>
        </div>
      `;
    }).join('');
  }

  function renderSidebar(opts) {
    const { active, user } = opts;
    const company = getActiveCompany();
    // Company name doubles as the switcher — the picker self-loads
    // memberships and returns here via ?next= after set_active_company.
    const switchHref = '/v2/company-picker.html?next='
      + encodeURIComponent(window.location.pathname + window.location.search);
    const companyLine = company?.title
      ? `<a href="${escHtml(switchHref)}" title="Switch company" style="color:inherit;text-decoration:none;">${escHtml(company.title)} <span style="opacity:.55" aria-hidden="true">⇄</span></a>`
      : 'v2.0 · prod';

    return `
      <aside class="silo-sidebar" role="navigation" aria-label="SILO menu">
        <div class="silo-sb-brand">
          <div style="display:flex; align-items:center; gap:9px; min-width:0;">
            <div class="silo-sb-logo">S</div>
            <div class="silo-sb-brand-text">
              <div class="silo-sb-name">SILO</div>
              <div class="silo-sb-ver">${companyLine}</div>
            </div>
          </div>
          <button class="silo-sb-collapse" type="button" data-silo-action="collapse" aria-label="Collapse sidebar">
            ${ICONS.collapse}
          </button>
        </div>

        <div class="silo-sb-search">
          <div class="silo-sb-search-inner" data-silo-action="search" role="button" tabindex="0">
            <span class="silo-sb-search-icon">${ICONS.search}</span>
            <span>Jump to…</span>
            <span class="kbd">⌘K</span>
          </div>
        </div>

        <nav class="silo-sb-nav" id="siloSbNav">
          ${renderNavSections(active, undefined, user && user.role)}
        </nav>

        <div class="silo-sb-footer">
          <div class="silo-sb-user">
            ${renderSidebarAvatar(user, opts.avatarUrl)}
            <div class="silo-sb-user-text">
              <span class="silo-sb-user-name">${escHtml(shortName(user && user.email))}</span>
              <span class="silo-sb-user-role">${escHtml(user && user.role || 'Member')} · RLS</span>
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  // Falls back to the old plain-initials markup if avatar.js isn't loaded
  // on a given page yet — never a hard dependency.
  function renderSidebarAvatar(user, avatarUrl) {
    if (window.SiloAvatar) {
      return window.SiloAvatar.html({ email: user && user.email, avatarUrl: avatarUrl || null }, 'sm', 'silo-sb-avatar');
    }
    return `<div class="silo-sb-avatar">${escHtml((user && user.email || 'U').slice(0, 2).toUpperCase())}</div>`;
  }

  function shortName(email) {
    if (!email) return 'Signed in';
    const local = email.split('@')[0] || email;
    return local.length > 18 ? local.slice(0, 16) + '…' : local;
  }

  function renderUtility(opts) {
    const crumbs = (opts.crumbs || []).map((c, i, a) => {
      const last = i === a.length - 1;
      return `<span class="${last ? 'crumb-last' : ''}">${escHtml(c)}</span>${last ? '' : '<span class="crumb-sep">/</span>'}`;
    }).join('');
    return `
      <div class="silo-utility">
        <button class="silo-icon-btn silo-nav-toggle" type="button" data-silo-action="nav-toggle" aria-label="Open menu" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="14" height="14"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
        </button>
        <div class="silo-crumbs">${crumbs}</div>
        <div class="silo-utility-spacer"></div>
        <div class="silo-utility-divider"></div>
        <span class="bcn-pill" data-silo-rls>RLS · ${escHtml(opts.user && opts.user.role || 'MEMBER')}</span>
        <button class="silo-icon-btn" type="button" data-silo-action="theme" aria-label="Toggle theme" data-silo-theme-icon>${ICONS.moon}</button>
        <button class="silo-icon-btn" type="button" data-silo-action="bell" aria-label="Notifications">${ICONS.bell}</button>
        <button class="silo-icon-btn" type="button" data-silo-action="signout" aria-label="Sign out" title="Sign out">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
            <path d="M15 16l4-4-4-4"/><line x1="19" y1="12" x2="9" y2="12"/><path d="M11 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>
          </svg>
        </button>
      </div>
    `;
  }

  /* ---- Command palette (the sidebar's "Jump to…" / ⌘K) -------------------
     Fed by the SAME navSectionsForCompany() call renderNavSections() uses, so
     profile / department / role / grantTable filtering applies unchanged — a
     page deliberately kept out of nav-config.js (parked, or still in testing)
     is not reachable here either. This is a faster route to the menu, never a
     route around it, and it is still UX only: RLS remains the boundary. */
  let paletteEl = null;
  let paletteRole = null;
  let paletteItems = [];
  let paletteCursor = 0;

  function paletteSource() {
    const sections = navSectionsForCompany(
      getActiveCompany(), getCachedDepartment(), paletteRole, getCachedGrantIds()
    );
    const out = [];
    for (const sec of sections) {
      for (const item of sec.items) out.push({ ...item, section: sec.section });
    }
    return out;
  }

  // Lower score sorts first; ties keep nav order. Label-prefix beats
  // label-substring beats a section-name hit, and a subsequence match
  // ("pobld" → "PO Builder") is the last resort. -1 means no match.
  function paletteScore(item, q) {
    if (!q) return 0;
    const label = item.label.toLowerCase();
    const at = label.indexOf(q);
    if (at === 0) return 0;
    if (at > 0) return 1;
    if ((label + ' ' + item.section.toLowerCase()).includes(q)) return 2;
    let i = 0;
    for (const ch of label) if (ch === q[i]) i++;
    return i === q.length ? 3 : -1;
  }

  function paletteFilter(q) {
    const scored = [];
    paletteSource().forEach((item, idx) => {
      const score = paletteScore(item, q);
      if (score >= 0) scored.push({ item, score, idx });
    });
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.map((s) => s.item);
  }

  function paletteHighlight(label, q) {
    const at = q ? label.toLowerCase().indexOf(q) : -1;
    if (at < 0) return escHtml(label);
    return escHtml(label.slice(0, at))
      + '<mark>' + escHtml(label.slice(at, at + q.length)) + '</mark>'
      + escHtml(label.slice(at + q.length));
  }

  function paletteRenderList() {
    const listEl = paletteEl.querySelector('.silo-palette-list');
    const q = paletteEl.querySelector('.silo-palette-input').value.trim().toLowerCase();
    paletteItems = paletteFilter(q);
    if (paletteCursor >= paletteItems.length) paletteCursor = 0;
    if (!paletteItems.length) {
      listEl.innerHTML = '<div class="silo-palette-empty">No menu item matches that.</div>';
      return;
    }
    listEl.innerHTML = paletteItems.map((item, i) => {
      const on = i === paletteCursor;
      const ext = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a class="silo-palette-item${on ? ' silo-palette-item--on' : ''}" href="${escHtml(item.href)}" data-palette-idx="${i}" role="option" aria-selected="${on}"${ext}>
          <span class="silo-palette-item-label">${paletteHighlight(item.label, q)}</span>
          <span class="silo-palette-item-section">${escHtml(item.section)}</span>
        </a>`;
    }).join('');
    const onEl = listEl.querySelector('.silo-palette-item--on');
    if (onEl && onEl.scrollIntoView) onEl.scrollIntoView({ block: 'nearest' });
  }

  function paletteMove(delta) {
    if (!paletteItems.length) return;
    paletteCursor = (paletteCursor + delta + paletteItems.length) % paletteItems.length;
    paletteRenderList();
  }

  function paletteGo(item) {
    closePalette();
    if (item.external) window.open(item.href, '_blank', 'noopener');
    else window.location.href = item.href;
  }

  function ensurePalette() {
    if (paletteEl) return paletteEl;
    paletteEl = el(`
      <div class="silo-palette" hidden>
        <div class="silo-palette-box" role="dialog" aria-modal="true" aria-label="Jump to page">
          <div class="silo-palette-field">
            <span class="silo-palette-icon" aria-hidden="true">${ICONS.search}</span>
            <input class="silo-palette-input" type="text" placeholder="Jump to…" autocomplete="off" spellcheck="false"
                   role="combobox" aria-expanded="true" aria-controls="siloPaletteList" aria-autocomplete="list" />
            <span class="silo-palette-esc">ESC</span>
          </div>
          <div class="silo-palette-list" id="siloPaletteList" role="listbox" aria-label="Menu items"></div>
        </div>
      </div>
    `);
    document.body.appendChild(paletteEl);

    const input = paletteEl.querySelector('.silo-palette-input');
    input.addEventListener('input', () => { paletteCursor = 0; paletteRenderList(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); paletteMove(1); }
      else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); paletteMove(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const item = paletteItems[paletteCursor];
        if (item) paletteGo(item);
      } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });

    paletteEl.addEventListener('click', (e) => {
      // A click on a row lets the anchor navigate on its own; closing here
      // just keeps the overlay from flashing during the page swap.
      if (e.target.closest('.silo-palette-item')) { closePalette(); return; }
      if (!e.target.closest('.silo-palette-box')) closePalette();
    });

    paletteEl.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.silo-palette-item');
      if (!row) return;
      const idx = Number(row.getAttribute('data-palette-idx'));
      if (idx === paletteCursor) return;
      paletteCursor = idx;
      paletteEl.querySelectorAll('.silo-palette-item').forEach((n, i) => {
        n.classList.toggle('silo-palette-item--on', i === idx);
        n.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      });
    });

    return paletteEl;
  }

  function isPaletteOpen() { return !!paletteEl && !paletteEl.hidden; }

  function openPalette() {
    ensurePalette();
    paletteEl.hidden = false;
    const input = paletteEl.querySelector('.silo-palette-input');
    input.value = '';
    paletteCursor = 0;
    paletteRenderList();
    input.focus();
  }

  function closePalette() {
    if (paletteEl) paletteEl.hidden = true;
  }

  function mount(opts) {
    opts = opts || {};
    const appEl = typeof opts.appEl === 'string' ? document.querySelector(opts.appEl) : opts.appEl;
    if (!appEl) { console.error('SiloChrome.mount: appEl not found'); return; }

    // The palette filters by the same role the sidebar renders with.
    paletteRole = (opts.user && opts.user.role) || null;

    // restore collapsed state
    const collapsed = localStorage.getItem(LS_COLLAPSED) === '1';
    appEl.setAttribute('data-collapsed', collapsed ? 'true' : 'false');

    // restore theme
    const theme = localStorage.getItem(LS_THEME) || 'light';
    document.documentElement.setAttribute('data-theme', theme);

    opts.avatarUrl = opts.avatarUrl || getCachedAvatarUrl();
    const sidebar = el(renderSidebar(opts));
    const backdrop = el('<div class="silo-nav-backdrop" data-silo-nav-backdrop hidden></div>');
    appEl.prepend(sidebar);
    appEl.prepend(backdrop);

    const mainEl = appEl.querySelector('.silo-main');
    if (mainEl) {
      const util = el(renderUtility(opts));
      mainEl.prepend(util);
      updateThemeIcon();
    }

    // First render of a session may predate the department fetch — re-render
    // the nav once it resolves so gated links appear/disappear correctly.
    if (!getCachedDepartment() && opts.supabaseClient) {
      resolveDepartment(opts.supabaseClient).then((dept) => {
        if (!dept) return;
        const navEl = sidebar.querySelector('#siloSbNav');
        if (navEl) navEl.innerHTML = renderNavSections(opts.active, dept, opts.user && opts.user.role);
      });
    }

    // Same deal for grant-based unlocks (e.g. Ask SILO access granted via
    // backend.html without an exec/owner role) — first paint can't know
    // about a grant yet, so re-render once resolveGrantIds confirms one.
    if (!getCachedGrantIds() && opts.supabaseClient) {
      resolveGrantIds(opts.supabaseClient).then((grantIds) => {
        if (!grantIds || !grantIds.size) return;
        const navEl = sidebar.querySelector('#siloSbNav');
        if (navEl) navEl.innerHTML = renderNavSections(opts.active, getCachedDepartment(), opts.user && opts.user.role, grantIds);
      });
    }

    // Same deal for the sidebar avatar: first paint uses whatever was
    // cached this session (often nothing, on a fresh sign-in), then swaps
    // in the real photo once the profile fetch lands.
    if (!getCachedAvatarUrl() && opts.supabaseClient) {
      resolveAvatarUrl(opts.supabaseClient).then((avatarUrl) => {
        if (!avatarUrl) return;
        const userEl = sidebar.querySelector('.silo-sb-user');
        if (userEl) {
          const existing = userEl.querySelector('.silo-sb-avatar');
          if (existing) existing.outerHTML = renderSidebarAvatar(opts.user, avatarUrl);
        }
      });
    }

    function setNavOpen(open) {
      appEl.classList.toggle('silo-nav-open', !!open);
      backdrop.hidden = !open;
      const toggle = appEl.querySelector('[data-silo-action="nav-toggle"]');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
    }

    sidebar.addEventListener('click', (e) => {
      const collapseBtn = e.target.closest('[data-silo-action="collapse"]');
      if (collapseBtn) {
        e.preventDefault();
        toggleCollapse(appEl);
        return;
      }
      if (e.target.closest('[data-silo-action="search"]')) {
        e.preventDefault();
        setNavOpen(false);   // mobile: the box lives inside the drawer
        openPalette();
        return;
      }
      // Clicking anywhere on the collapsed rail expands it
      if (appEl.getAttribute('data-collapsed') === 'true') {
        toggleCollapse(appEl);
        return;
      }
      const sectionBtn = e.target.closest('[data-silo-action="section-toggle"]');
      if (sectionBtn) {
        e.preventDefault();
        const name = sectionBtn.getAttribute('data-section');
        const sectionEl = sidebar.querySelector(`.silo-sb-section[data-section="${name}"]`);
        const wasOpen = sectionEl && sectionEl.classList.contains('silo-sb-section--open');
        // Accordion: close every section, then open the clicked one (unless
        // it was already open — then it just closes).
        sidebar.querySelectorAll('.silo-sb-section').forEach(el => {
          el.classList.remove('silo-sb-section--open');
          const btn = el.querySelector('[data-silo-action="section-toggle"]');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        });
        if (sectionEl && !wasOpen) {
          sectionEl.classList.add('silo-sb-section--open');
          sectionBtn.setAttribute('aria-expanded', 'true');
        }
        return;
      }
      if (e.target.closest('.silo-sb-link')) {
        setNavOpen(false);
      }
    });

    sidebar.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.closest('[data-silo-action="search"]')) return;
      e.preventDefault();
      setNavOpen(false);
      openPalette();
    });

    backdrop.addEventListener('click', () => setNavOpen(false));

    if (mainEl) {
      mainEl.addEventListener('click', (e) => {
        const t = e.target.closest('[data-silo-action]');
        if (!t) return;
        const action = t.getAttribute('data-silo-action');
        if (action === 'nav-toggle') { e.preventDefault(); setNavOpen(!appEl.classList.contains('silo-nav-open')); }
        if (action === 'theme') { e.preventDefault(); toggleTheme(); }
        if (action === 'signout') { e.preventDefault(); signOut(opts); }
        if (action === 'bell') { e.preventDefault(); /* notifications hook */ }
      });
    }

    document.addEventListener('keydown', (e) => {
      // A page that handles ⌘K itself wins, and a second mount on the same
      // document can't undo the first one's work (both listeners see the
      // same event, so without this the second would close what the first
      // just opened).
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && isPaletteOpen()) {
        closePalette();
        return;
      }
      if (e.key === 'Escape' && appEl.classList.contains('silo-nav-open')) {
        setNavOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (isPaletteOpen()) { closePalette(); return; }
        setNavOpen(false);
        openPalette();
      }
    });

    return {};
  }

  function toggleCollapse(appEl) {
    const next = appEl.getAttribute('data-collapsed') !== 'true';
    appEl.setAttribute('data-collapsed', next ? 'true' : 'false');
    localStorage.setItem(LS_COLLAPSED, next ? '1' : '0');
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(LS_THEME, next);
    updateThemeIcon();
  }

  function updateThemeIcon() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const btn = document.querySelector('[data-silo-theme-icon]');
    if (btn) btn.innerHTML = cur === 'light' ? ICONS.moon : ICONS.sun;
  }

  async function signOut(opts) {
    try {
      if (opts && opts.supabaseClient) {
        await opts.supabaseClient.auth.signOut();
      }
    } catch (e) { console.warn('signOut error:', e); }
    window.location.href = '/pages/login.html';
  }

  window.SiloChrome = { mount, resolveNavProfile, navSectionsForCompany };
})();
