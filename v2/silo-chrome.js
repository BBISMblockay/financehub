/* ========================================================================
   SILO chrome v2 — sidebar + utility bar.
   Every SILO page mounts this once. Active branch auto-expands.

   Include on each page (after beacon.css + inline styles):
     <link rel="stylesheet" href="beacon-mirrors-unified.css" />
     <link rel="stylesheet" href="v2-mobile.css" />
     <script src="v2-shell.js" defer></script>
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
  const NAV = [
    { id: 'hub', label: 'Hub', icon: 'hub', href: '/index.html' },

    { id: 'finance', label: 'Finance', icon: 'finance', children: [
      { id: 'finance/cashflow',   label: 'Cash flow',     href: '/cashflow.html' },
      { id: 'finance/executive',  label: 'Executive',     href: '/v2/executive.html' },
      { id: 'finance/ap',         label: 'AP report',     href: '/ap-report.html' },
      { id: 'finance/recon',      label: 'Recon',         href: '/recon.html' },
      { id: 'finance/finance',    label: 'Finance home',  href: '/v2/finance.html' },
      { id: 'finance/backend',    label: 'Backend hub',   href: '/v2/backend.html' },
    ]},

    { id: 'inventory', label: 'Inventory', icon: 'inventory', children: [
      { id: 'inventory/workboard',  label: 'Workboard',       href: '/v2/inventory.html' },
      { id: 'inventory/products',   label: 'Product manager', href: '/pages/product-manager.html' },
      { id: 'inventory/tags',       label: 'Product tags',    href: '/pages/product-tags.html' },
    ]},

    { id: 'sales', label: 'Sales', icon: 'sales', children: [
      { id: 'sales/verification',   label: 'Sales verification', href: '/pages/sales-verification.html' },
      { id: 'sales/reports',        label: 'Sales reports',      href: '/pages/sales-reports.html' },
    ]},

    { id: 'purchasing', label: 'Purchasing', icon: 'purchasing', children: [
      { id: 'purchasing/po-builder',  label: 'PO builder',  href: '/v2/po-builder.html' },
      { id: 'purchasing/po-report',   label: 'PO report',   href: '/v2/po-report.html' },
      { id: 'purchasing/requests',    label: 'Requests',    href: '/v2/purchase_request.html' },
      { id: 'purchasing/req-mgr',     label: 'Request mgr', href: '/v2/request_manager.html' },
    ]},

    { id: 'wholesale', label: 'Wholesale', icon: 'wholesale', children: [
      { id: 'wholesale/customers',   label: 'Customers / AR', href: '/pages/baseballismwholesale.html' },
      { id: 'wholesale/queue',       label: 'Wholesale',      href: '/pages/wholesale.html' },
    ]},

    { id: 'planning', label: 'Planning', icon: 'planning', children: [
      { id: 'planning/launch-calendar',    label: 'Launch calendar',    href: '/v2/launch-calendar.html' },
      { id: 'planning/revenue-projections',label: 'Revenue projections',href: '/v2/projections.html' },
      { id: 'planning/scenarios',          label: 'Scenarios',          href: '/pages/planning-scenarios.html' },
      { id: 'planning/planner',            label: 'PO planner',         href: '/v2/planner.html' },
      { id: 'planning/sheets-calendar',    label: 'Marketing calendar', href: '/v2/calendar.html' },
    ]},

    { id: 'people', label: 'People', icon: 'people', children: [
      { id: 'people/payroll',     label: 'Payroll',       href: '/payroll.html' },
      { id: 'people/employees',   label: 'Employee hub',  href: '/v2/employeehub.html' },
      { id: 'people/access',      label: 'Dept access',   href: '/v2/department-access.html' },
    ]},

    { id: 'ops', label: 'Ops', icon: 'ops', children: [
      { id: 'ops/mailroom',  label: 'Mailroom',   href: '/mailroom.html' },
      { id: 'ops/calendar',  label: 'Calendar',   href: '/v2/calendar.html' },
      { id: 'ops/status',    label: 'App status', href: '/app-status.html' },
    ]},
  ];

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
    chev:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="9 6 15 12 9 18"/></svg>',
    collapse:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>',
  };

  const LS_COLLAPSED = 'silo.sidebar.collapsed';
  const LS_THEME     = 'silo.theme';

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function activeParts(activeId) {
    if (!activeId) return { top: null, child: null };
    const [top, ...rest] = activeId.split('/');
    return { top, child: rest.length ? `${top}/${rest.join('/')}` : null };
  }

  function renderSidebar(opts) {
    const { active, user } = opts;
    const { top: activeTop, child: activeChild } = activeParts(active);

    const items = NAV.map(item => {
      const isActiveTop = item.id === activeTop;
      const open = isActiveTop && item.children;
      const childHtml = item.children ? item.children.map(c => `
        <a class="silo-sb-child${c.id === activeChild ? ' silo-sb-child--active' : ''}"
           href="${escHtml(c.href)}">${escHtml(c.label)}</a>
      `).join('') : '';
      return `
        <div class="silo-sb-group" data-id="${escHtml(item.id)}">
          <a class="silo-sb-item${isActiveTop ? ' silo-sb-item--active' : ''}"
             data-open="${open ? 'true' : 'false'}"
             href="${escHtml(item.href || (item.children && item.children[0] && item.children[0].href) || '#')}"
             data-has-children="${item.children ? 'true' : 'false'}">
            <span class="silo-sb-item-icon">${ICONS[item.icon] || ''}</span>
            <span class="silo-sb-item-label">${escHtml(item.label)}</span>
            ${item.children ? `<span class="silo-sb-item-caret">${ICONS.chev}</span>` : ''}
          </a>
          ${item.children ? `<div class="silo-sb-children" ${open ? '' : 'hidden'}>${childHtml}</div>` : ''}
        </div>
      `;
    }).join('');

    return `
      <aside class="silo-sidebar" role="navigation">
        <div class="silo-sb-brand">
          <div style="display:flex; align-items:center; gap:9px; min-width:0;">
            <div class="silo-sb-logo">S</div>
            <div class="silo-sb-brand-text">
              <div class="silo-sb-name">SILO</div>
              <div class="silo-sb-ver">v2.0 · prod</div>
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

        <nav class="silo-sb-nav">
          <div class="silo-sb-section-label">Workboards</div>
          ${items}
        </nav>

        <div class="silo-sb-footer">
          <div class="silo-sb-health" data-silo-health>
            <div><span class="bcn-dot bcn-dot--pos"></span>SUPABASE</div>
            <div><span class="bcn-dot bcn-dot--pos"></span>SHOPIFY</div>
            <div><span class="bcn-dot bcn-dot--warn"></span>AR · 6H</div>
            <div><span class="bcn-dot bcn-dot--pos"></span>SHEETS</div>
          </div>
          <div class="silo-sb-user">
            <div class="silo-sb-avatar">${escHtml((user && user.email || 'U').slice(0,2).toUpperCase())}</div>
            <div class="silo-sb-user-text">
              <span class="silo-sb-user-name">${escHtml(shortName(user && user.email))}</span>
              <span class="silo-sb-user-role">${escHtml(user && user.role || 'Member')} · RLS</span>
            </div>
          </div>
        </div>
      </aside>
    `;
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
        <div class="silo-crumbs">${crumbs}</div>
        <div class="silo-utility-spacer"></div>
        <div class="silo-status" data-silo-utility-status>
          <span><span class="bcn-dot bcn-dot--pos"></span>SUPABASE OK</span>
          <span><span class="bcn-dot bcn-dot--pos"></span>SHOPIFY 200</span>
          <span><span class="bcn-dot bcn-dot--warn"></span>AR · 6H STALE</span>
          <span style="color:var(--bcn-ink-4)" data-silo-last-sync>LAST SYNC ${nowHHMM()}</span>
        </div>
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

  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  function mount(opts) {
    opts = opts || {};
    const appEl = typeof opts.appEl === 'string' ? document.querySelector(opts.appEl) : opts.appEl;
    if (!appEl) { console.error('SiloChrome.mount: appEl not found'); return; }

    // restore collapsed state
    const collapsed = localStorage.getItem(LS_COLLAPSED) === '1';
    appEl.setAttribute('data-collapsed', collapsed ? 'true' : 'false');

    // restore theme
    const theme = localStorage.getItem(LS_THEME) || 'light';
    document.documentElement.setAttribute('data-theme', theme);

    // render sidebar (prepend to app), utility goes inside main
    const sidebar = el(renderSidebar(opts));
    appEl.prepend(sidebar);

    const mainEl = appEl.querySelector('.silo-main');
    if (mainEl) {
      const util = el(renderUtility(opts));
      mainEl.prepend(util);
      updateThemeIcon();
    }

    // wire interactions
    sidebar.addEventListener('click', (e) => {
      const collapseBtn = e.target.closest('[data-silo-action="collapse"]');
      if (collapseBtn) {
        e.preventDefault();
        toggleCollapse(appEl);
        return;
      }
      const item = e.target.closest('.silo-sb-item');
      if (item && item.dataset.hasChildren === 'true') {
        // let click follow link but also expand if it's not the active group
        const group = item.closest('.silo-sb-group');
        const sublist = group && group.querySelector('.silo-sb-children');
        if (sublist && !item.classList.contains('silo-sb-item--active')) {
          // soft-toggle: expand on click without navigating, if caret was clicked
          if (e.target.closest('.silo-sb-item-caret')) {
            e.preventDefault();
            const open = item.getAttribute('data-open') === 'true';
            item.setAttribute('data-open', open ? 'false' : 'true');
            if (open) sublist.setAttribute('hidden',''); else sublist.removeAttribute('hidden');
          }
        }
      }
    });

    if (mainEl) {
      mainEl.addEventListener('click', (e) => {
        const t = e.target.closest('[data-silo-action]');
        if (!t) return;
        const action = t.getAttribute('data-silo-action');
        if (action === 'theme') { e.preventDefault(); toggleTheme(); }
        if (action === 'signout') { e.preventDefault(); signOut(opts); }
        if (action === 'bell') { e.preventDefault(); /* notifications hook */ }
      });
    }

    // ⌘K -> alert for now (real palette later)
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        // hook here for the future command palette
        const searchEl = sidebar.querySelector('[data-silo-action="search"]');
        searchEl && searchEl.focus && searchEl.focus();
      }
    });

    return {
      setLastSync(text) {
        const el = mainEl && mainEl.querySelector('[data-silo-last-sync]');
        if (el) el.textContent = text;
      },
      setHealth(items) {
        // items: [{ label, state: 'pos'|'neg'|'warn' }, …]
        const host = sidebar.querySelector('[data-silo-health]');
        if (!host) return;
        host.innerHTML = items.map(i => `
          <div><span class="bcn-dot bcn-dot--${escHtml(i.state)}"></span>${escHtml(i.label)}</div>
        `).join('');
      },
    };
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

  window.SiloChrome = { mount };
})();
