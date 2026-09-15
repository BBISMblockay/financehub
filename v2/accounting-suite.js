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

  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-accounting-suite]')) return;
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
      link.dataset.label=title;
      link.title=title;
      link.innerHTML=svg(id);
      const text=document.createElement('span');
      text.className='accounting-suite-text';
      text.textContent=title;
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
  }
  window.SiloAccounting={contains,mount};
})();
