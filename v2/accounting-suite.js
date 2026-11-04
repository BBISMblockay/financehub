/* Accounting workspace chrome — page subtitles and books context only.
   Cross-page navigation lives in the sidebar (ACCOUNTING_PAGES). */
(function () {
  'use strict';
  const pages = () => window.SiloNav?.ACCOUNTING_PAGES || [];
  function contains(active) { return pages().some(([id]) => id === active); }

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

  function ensureContextBar(main) {
    main?.querySelector?.('[data-accounting-close]')?.remove?.();
    main?.querySelector?.('[data-accounting-suite]')?.remove?.();
    let bar = main?.querySelector?.('[data-accounting-context]');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'accounting-context';
    bar.dataset.accountingContext = '';
    bar.setAttribute('aria-label', 'Accounting context');
    const books = document.createElement('span');
    books.className = 'accounting-context-books';
    books.dataset.accountingBooks = '';
    books.hidden = true;
    const queue = document.createElement('a');
    queue.className = 'accounting-context-queue';
    queue.href = '/v2/on-deck.html';
    queue.textContent = 'Period review';
    bar.append(books, queue);
    bar._booksEl = books;
    const anchor = main?.firstElementChild;
    if (anchor && typeof anchor.after === 'function') anchor.after(bar);
    return bar;
  }

  async function applyBooksContext(bar, db, company) {
    const el = bar?._booksEl
      || (bar?.querySelector && bar.querySelector('[data-accounting-books]'));
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
    if (!contains(active) || !main) return;
    const bar = ensureContextBar(main);
    applyPageHelp(main, active);
    if (opts?.supabaseClient && bar) {
      const co = window.__SILO_CONFIG__?.getActiveCompany?.();
      if (co?.id) applyBooksContext(bar, opts.supabaseClient, co);
      else window.__SILO_CONFIG__?.ensureActiveCompany?.(opts.supabaseClient)
        .then(c => c?.id && applyBooksContext(bar, opts.supabaseClient, c));
    }
  }

  window.SiloAccounting = { contains, mount };
})();
