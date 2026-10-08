/* ========================================================================
   SILO Home cards for STANDARD-profile workspaces, built from the sidebar.

   Home (/v2/finance.html) used to carry its own hand-written list of links,
   and for a standard company it drifted from the sidebar: no Marketing, no
   Ask SILO or Dashboards, no Setup or Accounting, purchasing filed under
   Planning, and Workspace Settings offered to members the sidebar hides it
   from. The sidebar already applies every rule that decides what a person
   may discover (nav profile, department, role, grants), so Home now reads
   the sidebar silo-chrome.js rendered instead of keeping a second list.

   Grandfathered (Baseballism) Home is NOT built here: it keeps its own
   static cards in finance.html, unchanged.

   Reading the rendered sidebar rather than calling SiloNav directly is on
   purpose: the role silo-chrome.js passes is resolved in mount() (profile
   owner/executive outranks membership, then the active company's membership
   role), and repeating that here would be a second definition that drifts
   exactly the way the hand-written list did.
   ======================================================================== */
(function (global) {
  // Home itself is never a card link.
  const SKIP_IDS = new Set(['finance/menu']);

  /** The sidebar's sections, as rendered, as Home cards. */
  function homeCardsFromNav(navEl) {
    if (!navEl) return [];
    const cards = [];
    navEl.querySelectorAll('.silo-sb-section').forEach((section) => {
      const title = section.getAttribute('data-section') || '';
      const links = [];
      // A featured section (Ask SILO) is one a.silo-sb-feature, not a list.
      section.querySelectorAll('a.silo-sb-link, a.silo-sb-feature').forEach((a) => {
        const id = a.getAttribute('data-nav-id') || '';
        if (SKIP_IDS.has(id)) return;
        const labelEl = a.querySelector('.silo-sb-link-label, .silo-sb-feature-label');
        const label = (labelEl ? labelEl.textContent : a.textContent).trim();
        const href = a.getAttribute('href') || '';
        if (!label || !href) return;
        links.push({ id, label, href, external: a.getAttribute('target') === '_blank' });
      });
      if (title && links.length) cards.push({ title, links });
    });
    return cards;
  }

  /** Same markup as finance.html's static cards, built with DOM APIs. */
  function renderHomeCards(container, cards) {
    const doc = container.ownerDocument;
    container.replaceChildren(...cards.map((card) => {
      const cardEl = doc.createElement('div');
      cardEl.className = 'fin-card';
      cardEl.setAttribute('data-home-section', card.title);
      const head = doc.createElement('div');
      head.className = 'fin-card-head';
      const h2 = doc.createElement('h2');
      h2.textContent = card.title;
      head.appendChild(h2);
      const list = doc.createElement('div');
      list.className = 'fin-links';
      card.links.forEach((link) => {
        const a = doc.createElement('a');
        a.className = 'fin-link';
        a.href = link.href;
        a.textContent = link.label;
        a.setAttribute('data-nav-id', link.id);
        if (link.external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        list.appendChild(a);
      });
      cardEl.append(head, list);
      return cardEl;
    }));
  }

  function signature(cards) {
    return JSON.stringify(cards.map((c) => [c.title, c.links.map((l) => l.href)]));
  }

  /**
   * Keep Home in step with the sidebar. silo-chrome.js repaints the nav as
   * the department, grants and role resolve (and on badge changes), so Home
   * re-renders on each repaint whose links actually differ.
   */
  function mirrorSidebar(navEl, container) {
    if (!navEl || !container) return null;
    let last = null;
    const sync = () => {
      const cards = homeCardsFromNav(navEl);
      const sig = signature(cards);
      if (sig === last) return;
      last = sig;
      renderHomeCards(container, cards);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(navEl, { childList: true, subtree: true });
    return observer;
  }

  global.SiloHome = { homeCardsFromNav, renderHomeCards, mirrorSidebar };
})(window);
