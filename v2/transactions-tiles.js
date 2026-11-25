/* Account control + period bar for the Transactions workspace.

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

  function create({ document: doc = document, now = () => Date.now(), info = () => {} } = {}) {
    const el = id => doc.getElementById(id);
    const account = el('workspaceAccount');
    const period = el('workspacePeriod');
    const tiles = el('workspaceTiles');
    const bar = el('workspacePeriodBar');
    if (!account || !period || !tiles || !bar) return null;

    let acctOpen = false;
    let popoverOpen = false;

    function options(select) {
      return Array.from(select.options || []).filter(o => o.value !== '');
    }

    // ONE dropdown, at every width. The rail of tiles that used to live here
    // side-scrolled, so an account off the right edge was invisible and the
    // register below had to give up a band of height to accounts nobody was
    // looking at. The selected account keeps every fact the tile carried —
    // balance, sync state, count — on a single line.
    function renderTiles() {
      const opts = options(account);
      const stamp = now();
      if (!opts.length) {
        tiles.innerHTML = '';
        el('workspaceAccountMeta').textContent = '';
        return;
      }
      const pending = opts.reduce((n, o) => n + (Number(o.dataset.pending) || 0), 0);
      el('workspaceAccountMeta').textContent =
        opts.length + (opts.length === 1 ? ' account' : ' accounts')
        + ' · ' + pending + ' to categorize across imports';

      const current = opts.find(o => o.selected) || opts[0];

      function facts(o) {
        const d = o.dataset;
        const n = Number(d.pending) || 0;
        const rel = relative(d.synced, stamp);
        const t = tone(d.health);
        return {
          name: d.name || o.text,
          mask: d.mask ? '••••' + d.mask : (d.institution || ''),
          bal: d.balance || d.balanceFallback || '',
          balLabel: d.balanceLabel || 'Balance',
          tone: t,
          sync: t === 'ok' ? (rel || d.healthLabel || '') : (d.healthLabel || rel),
          health: d.healthLabel || '',
          pending: n,
        };
      }

      const c = facts(current);
      tiles.innerHTML = `<div class="wacct">
        <button type="button" class="wacct-label" data-account-open aria-haspopup="listbox"
          aria-expanded="${acctOpen}" ${account.disabled ? 'disabled' : ''}>
          <span class="wtile-mark" aria-hidden="true" style="--wtile-hue:${hue(c.name)}">${esc(initials(c.name))}</span>
          <span class="wacct-id">
            <span class="wtile-name">${esc(c.name)}</span>
            <span class="wacct-line">
              ${c.mask ? `<span class="wtile-mask">${esc(c.mask)}</span>` : ''}
              <span class="wtile-sync" title="${esc(c.health)}"><i class="wtile-dot" data-tone="${c.tone}"></i>${esc(c.sync)}</span>
            </span>
          </span>
          <span class="wacct-right">
            <span class="wacct-bal"><small>${esc(c.balLabel)}</small>${esc(c.bal)}</span>
            <span title="Uncategorized across all imports for this account" class="wtile-pending${c.pending ? '' : ' is-clear'}">${c.pending ? c.pending + ' to categorize' : 'All done'}</span>
          </span>
          <span class="wper-caret" aria-hidden="true">▾</span>
        </button>
        <button type="button" class="wtile-info" data-account-info="${esc(current.value)}"
          aria-label="Account details for ${esc(c.name)}" ${account.disabled ? 'disabled' : ''}>i</button>
        <div class="wacct-pop" role="listbox" aria-label="Account" ${acctOpen ? '' : 'hidden'}>
          ${opts.map(o => {
            const f = facts(o);
            return `<button type="button" class="wacct-opt${o.selected ? ' is-on' : ''}" role="option"
              aria-selected="${o.selected ? 'true' : 'false'}" data-value="${esc(o.value)}">
              <span class="wtile-mark" aria-hidden="true" style="--wtile-hue:${hue(f.name)}">${esc(initials(f.name))}</span>
              <span class="wacct-id">
                <span class="wtile-name">${esc(f.name)}</span>
                <span class="wacct-line">
                  ${f.mask ? `<span class="wtile-mask">${esc(f.mask)}</span>` : ''}
                  <span class="wtile-sync" title="${esc(f.health)}"><i class="wtile-dot" data-tone="${f.tone}"></i>${esc(f.sync)}</span>
                </span>
              </span>
              <span class="wacct-right">
                <span class="wacct-bal">${esc(f.bal)}</span>
                <span class="wtile-pending${f.pending ? '' : ' is-clear'}">${f.pending ? f.pending + ' to categorize' : 'All done'}</span>
              </span>
            </button>`;
          }).join('')}
        </div>
      </div>`;
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
      // Same reason as the period bar below: renderTiles() replaces the clicked
      // node, so the document-level closer would see a detached element and
      // shut the list on the click that opened it.
      e.stopPropagation();
      const details = e.target.closest('[data-account-info]');
      if(details) { if(!account.disabled) info(details.dataset.accountInfo); return; }
      const opt = e.target.closest('[data-value]');
      if (opt && !opt.disabled) { acctOpen = false; renderTiles(); pick(account, opt.dataset.value); return; }
      const label = e.target.closest('[data-account-open]');
      if (label && !label.disabled) { acctOpen = !acctOpen; renderTiles(); }
    });

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
      if (acctOpen && !e.target.closest('#workspaceTiles')) { acctOpen = false; renderTiles(); }
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (popoverOpen) { popoverOpen = false; renderPeriod(); }
      if (acctOpen) { acctOpen = false; renderTiles(); }
    });

    const observer = new MutationObserver(render);
    observer.observe(account, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    observer.observe(period, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    render();
    return { render };
  }

  window.SiloTransactionTiles = { create, initials, hue, relative, tone };
})();
