/* Accounting workspace — page subtitles only. Nav is the sidebar; no extra strip. */
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

  function stripLegacyChrome(main) {
    if (!main?.querySelector) return;
    for (const sel of ['[data-accounting-close]', '[data-accounting-suite]', '[data-accounting-context]']) {
      const el = main.querySelector(sel);
      if (el?.remove) el.remove();
    }
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

  function mount(main, active) {
    if (!contains(active) || !main) return;
    stripLegacyChrome(main);
    applyPageHelp(main, active);
  }

  window.SiloAccounting = { contains, mount };
})();
