/* Accounting navigation only. Each destination retains its page and data logic. */
(function () {
  'use strict';
  // Tolerate a cached nav-config from before ACCOUNTING_PAGES was added.
  const pages = () => window.SiloNav?.ACCOUNTING_PAGES || [];
  function contains(active) { return pages().some(([id])=>id===active); }

  /* Same drawing as the sidebar's icons in silo-chrome.js -- 24-unit box,
     1.6 stroke, round caps, currentColor -- so the two navs read as one
     system. They live here rather than in silo-chrome.js because that file is
     framework (CLAUDE.md: do not add logic to it) and these are this nav's
     data, the same way nav-config.js owns the sidebar's links.

     Keyed by nav id, with a neutral fallback: a destination added to
     ACCOUNTING_PAGES without an icon gets a plain page mark rather than a
     ragged row of some-with-some-without. */
  const ICONS = {
    'finance/invoicing': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    // Ledger lines: the register.
    'finance/card-coding': '<path d="M4 4h16v16H4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    // Receipt with a currency mark: sales and the journal built from them.
    'finance/accounting-export': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><line x1="12" y1="7" x2="12" y2="15"/><path d="M14.5 9H11a1.8 1.8 0 0 0 0 3.5h2a1.8 1.8 0 0 1 0 3.5H9.5"/>',
    // Bars: reports.
    'finance/qbo-reports': '<line x1="3" y1="21" x2="21" y2="21"/><rect x="5" y="11" width="4" height="10"/><rect x="11" y="6" width="4" height="15"/><rect x="17" y="14" width="4" height="7"/>',
    // Calendar with a clock hand: something recognised over time.
    'finance/schedules': '<rect x="3" y="4" width="18" height="17" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><path d="M12 12v3l2 1.5"/>',
    // A depreciating block: fixed assets.
    'finance/fixed-assets': '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 16l9 4 9-4"/>',
    // An open book: the chart of accounts and setup.
    'finance/books': '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H11v16H5.5A2.5 2.5 0 0 0 3 21.5z"/><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H13v16h5.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
    // A trend over a note: cash ahead of today.
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

  /* Plain-language labels on the tab strip; URLs and nav ids stay the same. */
  const FRIENDLY_TITLE = {
    'finance/card-coding': 'Bank activity',
    'finance/accounting-export': 'Sales journals',
    'finance/qbo-reports': 'Financial reports',
  };

  /* Where this page sits in a typical month-end path — orientation only. */
  const CLOSE_STEPS = [
    { key: 'setup', label: 'Setup', href: '/v2/accounting-books.html',
      pages: ['finance/books'], blurb: 'Opening balances and book settings.' },
    { key: 'activity', label: 'Bank activity', href: '/v2/transactions.html',
      pages: ['finance/card-coding'], blurb: 'Categorize bank and card lines for the period.' },
    { key: 'sales', label: 'Sales journals', href: '/v2/accounting-export.html',
      pages: ['finance/accounting-export'], blurb: 'Turn sales into journal entries.' },
    { key: 'invoicing', label: 'Invoicing', href: '/v2/invoicing.html',
      pages: ['finance/invoicing'], blurb: 'Send invoices and track payments.' },
    { key: 'close', label: 'Reports & cash', href: '/v2/qbo-reports.html',
      pages: ['finance/qbo-reports', 'finance/cash-forecast', 'finance/schedules', 'finance/fixed-assets'],
      blurb: 'Review statements, schedules, and cash ahead.' },
  ];

  const PAGE_HELP = {
    'finance/books': { subtitle: 'Opening balances, chart of accounts, and book settings.' },
    'finance/card-coding': { subtitle: 'Categorize bank and card activity for this period.' },
    'finance/accounting-export': { subtitle: 'Build and review sales journal entries by period.' },
    'finance/invoicing': { subtitle: 'Create invoices and see what customers owe.' },
    'finance/qbo-reports': { subtitle: 'Run financial reports from your connected books.' },
    'finance/schedules': { subtitle: 'Recurring entries and amortization over time.' },
    'finance/fixed-assets': { subtitle: 'Track capital assets and depreciation.' },
    'finance/cash-forecast': { subtitle: 'See cash ahead from history and what is planned.' },
  };

  function stepForPage(active) {
    for (const step of CLOSE_STEPS) if (step.pages.includes(active)) return step;
    return null;
  }

  function applyPageHelp(main, active) {
    const help = PAGE_HELP[active];
    if (!help) return;
    const intro = typeof document.getElementById === 'function'
      ? document.getElementById('booksIntro') : null;
    if (intro && active === 'finance/books') { intro.textContent = help.subtitle; return; }
    const header = main.querySelector && main.querySelector('.bcn-header');
    if (!header || typeof header.querySelector !== 'function') return;
    let sub = header.querySelector('[data-accounting-sub]');
    if (!sub) {
      sub = document.createElement('p');
      sub.className = 'bcn-header-sub';
      sub.dataset.accountingSub = '';
      const title = header.querySelector('.bcn-header-title');
      if (title) title.after(sub);
      else header.querySelector(':scope > div')?.append(sub);
    }
    sub.textContent = help.subtitle;
  }

  function mountCloseBand(main, nav, active) {
    const findBand = () => (main.querySelector && main.querySelector('[data-accounting-close]')) || null;
    let band = findBand();
    if (!band) {
      band = document.createElement('section');
      band.className = 'accounting-close';
      band.dataset.accountingClose = '';
      band.setAttribute('aria-label', 'Month-end path');
      const head = document.createElement('div');
      head.className = 'accounting-close-head';
      head.innerHTML = '<span class="accounting-close-label">Month-end path</span>'
        + '<span class="accounting-close-books" data-accounting-books hidden></span>'
        + '<a class="accounting-close-queue" href="/v2/on-deck.html">Review queue</a>';
      const list = document.createElement('ol');
      list.className = 'accounting-close-steps';
      const stepEls = [];
      for (const step of CLOSE_STEPS) {
        const item = document.createElement('li');
        item.className = 'accounting-close-step';
        item.dataset.step = step.key;
        const link = document.createElement('a');
        link.href = step.href;
        link.textContent = step.label;
        item.append(link);
        list.append(item);
        stepEls.push(item);
      }
      band._booksEl = head.querySelector('[data-accounting-books]');
      band.append(head, list);
      const here = document.createElement('p');
      here.className = 'accounting-close-here';
      here.dataset.accountingCloseHere = '';
      band.append(here);
      band._stepEls = stepEls;
      band._hereEl = here;
      if (typeof nav.after === 'function') nav.after(band);
    }
    const current = stepForPage(active);
    const here = band._hereEl
      || (band.querySelector && band.querySelector('[data-accounting-close-here]'));
    const idx = current ? CLOSE_STEPS.indexOf(current) : -1;
    const steps = band._stepEls
      || (band.querySelectorAll && band.querySelectorAll('.accounting-close-step'));
    if (steps) {
      for (let i = 0; i < steps.length; i++) {
        const el = steps[i];
        if (!el?.classList) continue;
        el.classList.toggle('is-current', CLOSE_STEPS[i] === current);
        el.classList.toggle('is-past', idx >= 0 && i < idx);
      }
    }
    if (here && current) {
      here.textContent = `You are on ${current.label} — ${current.blurb}`;
    } else if (here) here.textContent = '';
  }

  async function applyBooksContext(band, db, company) {
    const el = band?._booksEl
      || (band?.querySelector && band.querySelector('[data-accounting-books]'));
    if (!el || !db || !company?.id) return;
    try {
      const { data, error } = await db.from('accounting_settings')
        .select('bookkeeping_mode,silo_takeover_on').maybeSingle();
      if (error) throw error;
      if (data?.bookkeeping_mode === 'qbo') {
        el.textContent = 'QuickBooks keeps the books';
        el.hidden = false;
        return;
      }
      if (data?.silo_takeover_on) {
        el.textContent = `SILO keeps the books from ${data.silo_takeover_on}`;
        el.hidden = false;
        return;
      }
      el.textContent = 'SILO keeps the books';
      el.hidden = false;
    } catch {
      el.hidden = true;
    }
  }

  function mount(main, active, opts) {
    if (!contains(active)) return;
    const existing = main.querySelector('[data-accounting-suite]');
    if (existing) {
      const band = main.querySelector('[data-accounting-close]')
        || (existing._closeBand);
      mountCloseBand(main, existing, active);
      applyPageHelp(main, active);
      const closeBand = main.querySelector('[data-accounting-close]');
      if (closeBand && opts?.supabaseClient) {
        const co = window.__SILO_CONFIG__?.getActiveCompany?.();
        if (co?.id) applyBooksContext(closeBand, opts.supabaseClient, co);
        else window.__SILO_CONFIG__?.ensureActiveCompany?.(opts.supabaseClient)
          .then(c => c?.id && applyBooksContext(closeBand, opts.supabaseClient, c));
      }
      return;
    }
    const nav=document.createElement('nav');
    nav.className='accounting-suite';nav.dataset.accountingSuite='';
    nav.setAttribute('aria-label','Accounting workspace');
    const label=document.createElement('span');label.className='accounting-suite-label';label.textContent='Accounting';nav.append(label);
    const links=document.createElement('div');links.className='accounting-suite-links';
    for(const [id,title,path] of pages()) {
      const link=document.createElement('a');
      link.href='/v2/'+path;
      // data-label feeds the compact-mode tooltip; the text node stays in the
      // DOM in both modes, so the link's accessible name never depends on
      // which mode it is in.
      const display = FRIENDLY_TITLE[id] || title;
      link.dataset.label=display;
      link.title=display;
      link.innerHTML=svg(id);
      const text=document.createElement('span');
      text.className='accounting-suite-text';
      text.textContent=display;
      link.append(text);
      if(id===active)link.setAttribute('aria-current','page');
      links.append(link);
    }
    nav.append(links);

    /* Compact is a per-person display choice, so it is remembered locally and
       never in the URL. It is refused on a coarse pointer by the stylesheet
       rather than here: hiding a label behind hover is unusable on a
       touchscreen, and a control whose effect silently does not apply is
       worse than one that is simply not offered. */
    const toggle=document.createElement('button');
    toggle.type='button';
    toggle.className='accounting-suite-compact';
    const apply=(on)=>{
      nav.classList.toggle('accounting-suite--compact',on);
      toggle.setAttribute('aria-pressed',String(on));
      toggle.setAttribute('aria-label',on?'Show accounting navigation labels':'Show accounting navigation as icons only');
      toggle.title=toggle.getAttribute('aria-label');
    };
    toggle.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true" focusable="false">'
      + '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>';
    toggle.addEventListener('click',()=>{
      const on=!nav.classList.contains('accounting-suite--compact');
      apply(on);rememberCompact(on);
    });
    apply(compactPreference());
    nav.append(toggle);

    main.firstElementChild.after(nav);
    mountCloseBand(main, nav, active);
    applyPageHelp(main, active);
    const band = main.querySelector('[data-accounting-close]');
    if (band && opts?.supabaseClient) {
      const co = window.__SILO_CONFIG__?.getActiveCompany?.();
      if (co?.id) applyBooksContext(band, opts.supabaseClient, co);
      else window.__SILO_CONFIG__?.ensureActiveCompany?.(opts.supabaseClient)
        .then(c => c?.id && applyBooksContext(band, opts.supabaseClient, c));
    }
  }
  window.SiloAccounting={contains,mount};
})();
