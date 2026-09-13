/* Account tiles + period bar for the Transactions workspace.

   PRESENTATION ONLY. The two <select> elements bank-workspace.js renders stay
   the source of truth: this module reads their <option>s, draws the tiles and
   the period control, and on a click sets select.value and dispatches a
   'change' event — the same event a real select fires. Nothing here talks to
   Supabase, and bank-workspace.js needs no knowledge of it.

   The selects are re-rendered wholesale by bank-workspace.js on every state
   change, so a MutationObserver is what keeps the tiles in step; hooking
   render() would couple the two modules and miss the disabled-state changes. */
(function () {
  'use strict';

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Two letters from the account name, for the institution mark.
  function initials(name) {
    const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return '••';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  // Stable hue per account so a given bank keeps its colour between renders.
  // Deliberately derived, never stored: Plaid does not always supply a logo and
  // the page's CSP blocks remote images anyway.
  //
  // Restricted to cool hues on purpose. A freely derived hue hands some accounts
  // a red or green mark, which then sits inches from the red/green/amber sync
  // dot and reads as a status it is not. These carry identity only.
  const MARK_HUES = [245, 262, 280, 300, 225, 205, 190, 320];
  function hue(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 4096;
    return MARK_HUES[h % MARK_HUES.length];
  }

  function relative(iso, now) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const mins = Math.floor((now - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  // A green dot must mean "this account is actually current".
  function tone(health) {
    if (['synced-recently', 'csv'].includes(health)) return 'ok';
    if (['syncing', 'lease-held'].includes(health)) return 'busy';
    return 'warn';
  }

  function create({ document: doc = document, now = () => Date.now() } = {}) {
    const el = id => doc.getElementById(id);
    const account = el('workspaceAccount');
    const period = el('workspacePeriod');
    const tiles = el('workspaceTiles');
    const bar = el('workspacePeriodBar');
    if (!account || !period || !tiles || !bar) return null;

    let expanded = false;
    let popoverOpen = false;

    function options(select) {
      return Array.from(select.options || []).filter(o => o.value !== '');
    }

    function renderTiles() {
      const opts = options(account);
      const stamp = now();
      if (!opts.length) {
        tiles.innerHTML = '';
        el('workspaceAccountMeta').textContent = '';
        el('workspaceAccountExpand').hidden = true;
        return;
      }
      const pending = opts.reduce((n, o) => n + (Number(o.dataset.pending) || 0), 0);
      el('workspaceAccountMeta').textContent =
        opts.length + (opts.length === 1 ? ' account' : ' accounts')
        + ' · ' + pending + ' to categorize';
      // The toggle only earns its place once one row cannot hold them all.
      el('workspaceAccountExpand').hidden = opts.length <= 4;
      el('workspaceAccountExpand').textContent = expanded ? 'Show less' : 'Show all';
      el('workspaceAccountExpand').setAttribute('aria-expanded', String(expanded));

      tiles.classList.toggle('is-expanded', expanded);
      tiles.innerHTML = opts.map(o => {
        const d = o.dataset;
        const n = Number(d.pending) || 0;
        const rel = relative(d.synced, stamp);
        return `<button type="button" class="wtile${o.selected ? ' is-on' : ''}"
          role="radio" aria-checked="${o.selected ? 'true' : 'false'}" data-value="${esc(o.value)}"
          ${account.disabled ? 'disabled' : ''}>
          <span class="wtile-top">
            <span class="wtile-mark" aria-hidden="true" style="--wtile-hue:${hue(d.name || o.text)}">${esc(initials(d.name || o.text))}</span>
            <span class="wtile-id">
              <span class="wtile-name">${esc(d.name || o.text)}</span>
              <span class="wtile-mask">${d.mask ? '••••' + esc(d.mask) : esc(d.institution || '')}</span>
            </span>
          </span>
          <span class="wtile-bal"><small>${esc(d.balanceLabel || 'Balance')}</small>${esc(d.balance || d.balanceFallback || '')}</span>
          <span class="wtile-ft">
            <span class="wtile-sync" title="${esc(d.healthLabel || '')}">
              <i class="wtile-dot" data-tone="${tone(d.health)}"></i>${esc(rel || d.healthLabel || '')}</span>
            <span class="wtile-pending${n ? '' : ' is-clear'}">${n ? n + ' to categorize' : 'All done'}</span>
          </span>
        </button>`;
      }).join('');
    }

    function renderPeriod() {
      const opts = options(period);
      const current = opts.find(o => o.selected) || opts[0];
      if (!opts.length) {
        bar.innerHTML = '<span class="wper-empty">No transactions yet — sync or upload a statement.</span>';
        return;
      }
      const idx = opts.indexOf(current);
      // Months are the unit an accounting period is chosen in; a day grid is the
      // exception, so it is not the resting state.
      bar.innerHTML = `
        <button type="button" class="wper-step" data-step="-1" ${idx >= opts.length - 1 ? 'disabled' : ''}
          aria-label="Previous period">&lsaquo;</button>
        <button type="button" class="wper-label" aria-haspopup="true" aria-expanded="${popoverOpen}"
          ${period.disabled ? 'disabled' : ''}>
          ${esc(current.dataset.label || current.text)}
          <span class="wper-sub">${esc(current.dataset.status || '')}${Number(current.dataset.pending) ? ' · ' + esc(current.dataset.pending) + ' to categorize' : ''}</span>
          <span class="wper-caret" aria-hidden="true">▾</span>
        </button>
        <button type="button" class="wper-step" data-step="1" ${idx <= 0 ? 'disabled' : ''}
          aria-label="Next period">&rsaquo;</button>
        <div class="wper-pop" role="listbox" ${popoverOpen ? '' : 'hidden'}>
          <div class="wper-pop-grid">
            ${opts.map(o => {
              const start = o.dataset.start || '';
              const m = /^(\d{4})-(\d{2})/.exec(start);
              const short = m ? MONTHS[Number(m[2]) - 1] + ' ’' + m[1].slice(2) : (o.dataset.label || o.text);
              const n = Number(o.dataset.pending) || 0;
              return `<button type="button" class="wper-cell${o.selected ? ' is-on' : ''}${n ? ' has-pending' : ''}"
                role="option" aria-selected="${o.selected ? 'true' : 'false'}" data-value="${esc(o.value)}"
                title="${esc(o.dataset.label || o.text)}${n ? ' · ' + n + ' to categorize' : ''}">
                ${esc(short)}<i class="wper-bar"></i></button>`;
            }).join('')}
          </div>
          <div class="wper-pop-ft"><span>Amber marks a period with rows to categorize</span></div>
        </div>`;
    }

    function render() { renderTiles(); renderPeriod(); }

    // Setting .value then firing 'change' is exactly what the native control
    // does, so bank-workspace.js's existing listeners handle it unchanged.
    function pick(select, value) {
      if (select.disabled || select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    tiles.addEventListener('click', (e) => {
      const t = e.target.closest('[data-value]');
      if (t && !t.disabled) pick(account, t.dataset.value);
    });

    el('workspaceAccountExpand').addEventListener('click', () => { expanded = !expanded; renderTiles(); });

    bar.addEventListener('click', (e) => {
      // renderPeriod() replaces the node that was clicked, so by the time the
      // document-level close handler runs, closest('#workspacePeriodBar') is
      // evaluated against a detached element and returns null — which closed the
      // popover on the very click that opened it. Stop it here instead.
      e.stopPropagation();
      const cell = e.target.closest('.wper-cell');
      if (cell) { popoverOpen = false; pick(period, cell.dataset.value); renderPeriod(); return; }
      if (e.target.closest('.wper-label')) { popoverOpen = !popoverOpen; renderPeriod(); return; }
      const step = e.target.closest('[data-step]');
      if (step && !step.disabled) {
        const opts = options(period);
        const i = opts.findIndex(o => o.selected);
        const next = opts[i + Number(step.dataset.step) * -1];
        if (next) pick(period, next.value);
      }
    });

    doc.addEventListener('click', (e) => {
      if (popoverOpen && !e.target.closest('#workspacePeriodBar')) { popoverOpen = false; renderPeriod(); }
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popoverOpen) { popoverOpen = false; renderPeriod(); }
    });

    const observer = new MutationObserver(render);
    observer.observe(account, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    observer.observe(period, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    render();
    return { render, expand(v) { expanded = !!v; renderTiles(); } };
  }

  window.SiloTransactionTiles = { create, initials, hue, relative, tone };
})();
