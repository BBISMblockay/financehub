/* Accounting navigation only. Each destination retains its page and data logic. */
(function () {
  'use strict';
  const pages = window.SiloNav.ACCOUNTING_PAGES;
  function contains(active) { return pages.some(([id])=>id===active); }
  function mount(main, active) {
    if (!contains(active) || main.querySelector('[data-accounting-suite]')) return;
    const nav=document.createElement('nav');
    nav.className='accounting-suite';nav.dataset.accountingSuite='';
    nav.setAttribute('aria-label','Accounting workspace');
    const label=document.createElement('span');label.className='accounting-suite-label';label.textContent='Accounting';nav.append(label);
    const links=document.createElement('div');links.className='accounting-suite-links';
    for(const [id,title,path] of pages) {
      const link=document.createElement('a');link.href='/v2/'+path;link.textContent=title;
      if(id===active)link.setAttribute('aria-current','page');
      links.append(link);
    }
    nav.append(links);main.firstElementChild.after(nav);
  }
  window.SiloAccounting={contains,mount};
})();
