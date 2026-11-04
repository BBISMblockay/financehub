/* Accounting workspace tab strip. Cross-page links live here; sidebar mirrors them. */
(function () {
  'use strict';
  const pages = () => window.SiloNav?.ACCOUNTING_PAGES || [];
  function contains(active) { return pages().some(([id]) => id === active); }

  const ICONS = {
    'finance/invoicing': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    'finance/card-coding': '<path d="M4 4h16v16H4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    'finance/accounting-export': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><line x1="12" y1="7" x2="12" y2="15"/><path d="M14.5 9H11a1.8 1.8 0 0 0 0 3.5h2a1.8 1.8 0 0 1 0 3.5H9.5"/>',
    'finance/qbo-reports': '<line x1="3" y1="21" x2="21" y2="21"/><rect x="5" y="11" width="4" height="10"/><rect x="11" y="6" width="4" height="15"/><rect x="17" y="14" width="4" height="7"/>',
    'finance/schedules': '<rect x="3" y="4" width="18" height="17" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><path d="M12 12v3l2 1.5"/>',
    'finance/fixed-assets': '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 16l9 4 9-4"/>',
    'finance/books': '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H11v16H5.5A2.5 2.5 0 0 0 3 21.5z"/><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H13v16h5.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
    'finance/cash-forecast': '<path d="M3 17l5-5 4 3 6-7"/><polyline points="14 8 18 8 18 12"/><line x1="3" y1="21" x2="21" y2="21"/>',
  };
  const FALLBACK = '<path d="M14 3H6v18h12V7z"/><polyline points="14 3 14 7 18 7"/>';
  const svg = (id) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" focusable="false">'
    + (ICONS[id] || FALLBACK) + '</svg>';

  const COMPACT_KEY = 'silo:accounting-nav-compact';
  function compactPreference() {
    try { return window.localStorage?.getItem(COMPACT_KEY) === '1'; } catch { return false; }
  }
  function rememberCompact(on) {
    try { window.localStorage?.setItem(COMPACT_KEY, on ? '1' : '0'); } catch {}
  }

  const FRIENDLY_TITLE = {
    'finance/card-coding': 'Bank activity',
    'finance/accounting-export': 'Shopify journal',
    'finance/qbo-reports': 'Financial reports',
  };

  const SHOPIFY_JOURNAL_HINT = 'In your SILO books already — post to QuickBooks by period.';

  const PAGE_HELP = {
    'finance/books': { subtitle: 'Opening balances, chart of accounts, and book settings.' },
    'finance/card-coding': { subtitle: 'Categorize bank and card activity for this period.' },
    'finance/accounting-export': { subtitle: SHOPIFY_JOURNAL_HINT },
    'finance/invoicing': { subtitle: 'Create invoices and see what customers owe.' },
    'finance/qbo-reports': { subtitle: 'Run financial reports from your connected books.' },
    'finance/schedules': { subtitle: 'Recurring entries and amortization over time.' },
    'finance/fixed-assets': { subtitle: 'Track capital assets and depreciation.' },
    'finance/cash-forecast': { subtitle: 'See cash ahead from history and what is planned.' },
  };

  function removeInsetBand(main) {
    const band = main?.querySelector?.('[data-accounting-close]');
    if (band?.remove) band.remove();
  }

  function applyPageHelp(main, active) {
    const help = PAGE_HELP[active];
    if (!help) return;
    const intro = typeof document.getElementById === 'function'
      ? document.getElementById('booksIntro') : null;
    if (intro && active === 'finance/books') { intro.textContent = help.subtitle; return; }
    const header = main.querySelector && main.querySelector('.bcn-header');
    if (!header || typeof header.querySelector !== 'function') return;
    let sub = header.querySelector('[data-accounting-sub]')
      || header.querySelector('.bcn-header-sub');
    if (!sub) {
      sub = document.createElement('p');
      sub.className = 'bcn-header-sub';
      const title = header.querySelector('.bcn-header-title');
      if (title) title.after(sub);
      else header.querySelector(':scope > div')?.append(sub);
    }
    sub.dataset.accountingSub = '';
    sub.textContent = help.subtitle;
  }

  function refreshNav(main, nav, active) {
    removeInsetBand(main);
    const linkNodes = nav?.querySelectorAll?.('.accounting-suite-links a');
    if (linkNodes) {
      for (const link of linkNodes) {
        const href = link.getAttribute?.('href') || link.href || '';
        const id = pages().find(([, , path]) => href === `/v2/${path}`)?.[0];
        if (id === active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    }
    applyPageHelp(main, active);
  }

  function buildNav(active) {
    const nav = document.createElement('nav');
    nav.className = 'accounting-suite';
    nav.dataset.accountingSuite = '';
    nav.setAttribute('aria-label', 'Accounting workspace');
    const label = document.createElement('span');
    label.className = 'accounting-suite-label';
    label.textContent = 'Accounting';
    nav.append(label);
    const links = document.createElement('div');
    links.className = 'accounting-suite-links';
    for (const [id, title, path] of pages()) {
      const link = document.createElement('a');
      link.href = `/v2/${path}`;
      const display = FRIENDLY_TITLE[id] || title;
      link.dataset.label = display;
      if (id === 'finance/accounting-export') link.dataset.accountingHint = SHOPIFY_JOURNAL_HINT;
      link.title = link.dataset.accountingHint || display;
      link.innerHTML = svg(id);
      const text = document.createElement('span');
      text.className = 'accounting-suite-text';
      text.textContent = display;
      link.append(text);
      if (id === active) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    nav.append(links);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'accounting-suite-compact';
    const apply = (on) => {
      nav.classList.toggle('accounting-suite--compact', on);
      toggle.setAttribute('aria-pressed', String(on));
      toggle.setAttribute('aria-label', on
        ? 'Show accounting navigation labels'
        : 'Show accounting navigation as icons only');
      toggle.title = toggle.getAttribute('aria-label');
    };
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true" focusable="false">'
      + '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/>'
      + '<line x1="4" y1="18" x2="14" y2="18"/></svg>';
    toggle.addEventListener('click', () => {
      const on = !nav.classList.contains('accounting-suite--compact');
      apply(on);
      rememberCompact(on);
    });
    apply(compactPreference());
    nav.append(toggle);
    return nav;
  }

  function mount(main, active) {
    if (!contains(active) || !main) return;
    removeInsetBand(main);
    main.querySelector?.('[data-accounting-context]')?.remove?.();
    const existing = main.querySelector?.('[data-accounting-suite]');
    if (existing) {
      refreshNav(main, existing, active);
      return;
    }
    const nav = buildNav(active);
    const anchor = main.firstElementChild;
    if (anchor && typeof anchor.after === 'function') anchor.after(nav);
    applyPageHelp(main, active);
  }

  window.SiloAccounting = { contains, mount };
})();
