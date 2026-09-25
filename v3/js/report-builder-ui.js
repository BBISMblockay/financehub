/* ==========================================================================
   SILO v3 — report builder, page wiring
   --------------------------------------------------------------------------
   DOM and state for /v3/report-builder.html. The SQL composition and every
   safety rule live in report-builder.js, which is pure and unit-tested; this
   file only turns clicks into config and config into a preview.
   ========================================================================== */
(function () {
  'use strict';

  const RB = window.SiloReportBuilder;
  const cfgWin = window.__SILO_CONFIG__ || {};
  const SUPABASE_URL = cfgWin.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = cfgWin.SUPABASE_ANON_KEY || '';
  const el = (id) => document.getElementById(id);
  const esc = (s) => window.SiloChart.esc(s);

  function setStatus(msg, type = 'info', ms = 0) {
    const s = el('status');
    s.className = `bcn-status bcn-status--${type}`;
    s.textContent = msg;
    s.hidden = false;
    if (ms) setTimeout(() => { s.hidden = true; }, ms);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    setStatus('Missing Supabase config — pages/config.js did not load.', 'neg');
    return;
  }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let catalog = [];          // [{relname, relkind, columns:[{name,type}], description}]
  let source = null;         // the selected catalog row
  let tab = 'build';
  let showAllColumns = false;
  let lastRun = null;        // { sql, resolvedSql, rows, offset }
  const PAGE_CAP = 1000;     // must match chat_run_readonly_query's per-page cap
  // Edit mode. Null on /v3/report-builder.html with no ?id=, which is the
  // create path and behaves exactly as it always has.
  let editing = null;        // { id, source, createdBy, canWrite, usage, declaredKeys }
  // True once the SQL has been hand-edited away from what the guided config
  // generates. Tracked because builder_config is scaffolding, not the source
  // of truth: reopening a report guided when its SQL has since diverged would
  // silently regenerate a query nobody asked for.
  let sqlIsHandWritten = false;
  // Which of the collapsed editor <details> a person opened BY HAND. A
  // re-render replaces the DOM (and would forget the <details> element's own
  // open/closed state along with it), so this is the thing that actually
  // persists across renders; renderBuild()'s own "open when empty" default
  // is layered on top of it, never instead of it.
  const secManualOpen = new Set();
  const cfg = {
    columns: [], summarise: false, dimensions: [], measures: [],
    dateColumn: '', dateRange: '', filters: [], sortColumn: '', sortDir: 'desc', limit: 100,
    // [{key, type, label, default, options}] — declared here, substituted at
    // run time by v3/js/report-params.js. Lives on cfg (not on `source`) so
    // it survives switching tables and applies to the SQL tab too.
    parameters: [],
  };

  // ── Source rail ──────────────────────────────────────────────────────
  // A friendly first line, the real identifier underneath it -- so someone
  // can search "current inventory" OR "inventory_on_hand_current_v" and land
  // on the same result, and the technical name is never hidden, just not
  // the first thing read.
  function renderSourceList() {
    const q = (el('srcSearch').value || '').trim().toLowerCase();
    const match = (r) => !q
      || RB.fuzzyScore(q, [RB.friendlyRelName(r.relname), r.relname, r.description || '']) > 0;
    const visible = catalog.filter(match);
    if (!visible.length) {
      el('srcList').innerHTML = `<div class="v3-empty">Nothing matches “${esc(q)}”.</div>`;
      return;
    }
    const card = (r) => `
        <button type="button" class="rb-src${source && source.relname === r.relname ? ' is-active' : ''}"
                data-rel="${esc(r.relname)}" title="${esc(r.description || '')}">
          <span class="rb-src-friendly">${esc(RB.friendlyRelName(r.relname))}</span>
          <span class="rb-src-name">${esc(r.relname)}</span>
          ${r.description ? `<span class="rb-src-desc">${esc(r.description)}</span>` : ''}
          <span class="rb-src-kind">${esc(r.relkind)} · ${RB.businessColumns(r.columns).length} cols</span>
        </button>`;
    const section = (label, rows) => rows.length
      ? `<div class="rb-group-label">${label} · ${rows.length}</div>` + rows.map(card).join('')
      : '';

    // "Start here" first. Eight sales rollups alphabetised together is a
    // choice nobody can make; these are the ones whose own descriptions say
    // to prefer them. Everything else is grouped by business area below it,
    // still fully listed and still searchable by name or description.
    const starred = visible.filter((r) => r.report_priority === 1);
    const rest = visible.filter((r) => r.report_priority !== 1);
    const areaOrder = [...RB.BUSINESS_AREAS, { id: 'other', label: 'More' }];
    const byArea = (id) => rest.filter((r) => RB.businessArea(r.relname).id === id);

    el('srcList').innerHTML =
      section('Start here', starred)
      + areaOrder.map((a) => section(a.label, byArea(a.id))).join('')
      + `<div class="rb-rail-foot">Sales, product, inventory, marketing, launches and purchasing.
           Finance and HR tables are deliberately not offered here.</div>`;
  }

  function selectSource(relname) {
    source = catalog.find((r) => r.relname === relname) || null;
    cfg.columns = []; cfg.dimensions = []; cfg.measures = [];
    cfg.dateColumn = ''; cfg.dateRange = ''; cfg.filters = [];
    cfg.sortColumn = ''; cfg.summarise = false;
    // No automatic date column or window. A source's date-typed columns are
    // not interchangeable -- sales_by_product_title_daily_v's day_date is
    // when a sale happened, but inventory_on_hand_current_v's first dateish
    // column is est_oos_date, a FORECAST, and the next is a sync timestamp.
    // Silently filtering "last 30 days" on a projected stock-out date (or
    // pinning a single-snapshot view to a rolling window at all) produced a
    // wrong report before anyone touched the Date range control. The catalog
    // carries no per-source signal for "this is the event date" -- so rather
    // than guess, this is left unset until someone picks a column on purpose.
    // Pre-select the business columns rather than emitting `select *`: the
    // point of hiding plumbing is that the PREVIEW stops being full of ids.
    cfg.columns = RB.businessColumns(source.columns).map((c) => c.name);
    showChart = true;
    secManualOpen.clear();
    renderSourceList();
    renderBuild();
    if (tab === 'sql') el('sqlText').value = RB.buildSql(source, cfg) || '';
  }

  // ── Build pane ───────────────────────────────────────────────────────
  // Plumbing is hidden unless asked for. Everything below works off this,
  // so the chips, the dropdowns and the sort list all stay consistent.
  const usableCols = () => showAllColumns
    ? (source.columns || [])
    : RB.businessColumns(source.columns);
  const hiddenCount = () => (source.columns || []).length - RB.businessColumns(source.columns).length;
  const numericCols = () => usableCols().filter((c) => RB.NUMERIC_PG.test(c.type));
  const dateCols = () => usableCols().filter((c) => RB.DATEISH_PG.test(c.type));

  /** Keys of the parameters declared well enough to be usable in a filter. */
  const declaredKeys = () =>
    window.SiloReportParams.normalizeDeclarations(cfg.parameters).map((d) => d.key);

  function opts(list, sel, blank) {
    return (blank ? `<option value="">${esc(blank)}</option>` : '')
      + list.map((c) => `<option value="${esc(c.name || c)}"${(c.name || c) === sel ? ' selected' : ''}>${esc(c.name || c)}</option>`).join('');
  }

  function renderBuild() {
    if (!source) return;
    const cols = usableCols();
    const aliasList = cfg.measures.map(RB.measureAlias).filter(Boolean);

    // A plain total is [agg] of [column]. A calculation is the same twice
    // with an operator between -- rendered as one row rather than a
    // different section, because it IS a measure and belongs in the list
    // whose order becomes the select list.
    const measureRows = cfg.measures.map((m, i) => {
      const calc = RB.calcFor(m);
      return `
      <div class="rb-rule${calc ? ' rb-rule--calc' : ''}">
        <select class="bcn-field" data-m-agg="${i}">${opts(RB.AGGREGATES, m.agg)}</select>
        <span class="rb-note">of</span>
        <select class="bcn-field" data-m-col="${i}">${opts(numericCols(), m.column)}</select>
        ${calc ? `
        <select class="bcn-field rb-calc-op" data-m-calc="${i}">
          ${RB.CALCS.map((c) => `<option value="${c.id}"${c.id === m.calc ? ' selected' : ''}>${c.symbol} ${esc(c.label)}</option>`).join('')}
        </select>
        <select class="bcn-field" data-m-agg2="${i}">${opts(RB.AGGREGATES, m.agg2)}</select>
        <span class="rb-note">of</span>
        <select class="bcn-field" data-m-col2="${i}">${opts(numericCols(), m.column2)}</select>` : ''}
        <span class="rb-note">as</span>
        <input class="bcn-field bcn-field--mono" data-m-alias="${i}" value="${esc(m.alias || '')}"
               placeholder="${esc(RB.measureAlias(Object.assign({}, m, { alias: '' })))}" />
        <button type="button" class="rb-x" data-m-del="${i}" aria-label="Remove">✕</button>
      </div>`;
    }).join('');

    const filterRows = cfg.filters.map((f, i) => {
      const op = RB.OPERATORS.find((o) => o.id === f.op) || RB.OPERATORS[0];
      return `
      <div class="rb-rule">
        <select class="bcn-field" data-f-col="${i}">${opts(cols, f.column, 'Column…')}</select>
        <select class="bcn-field" data-f-op="${i}">
          ${RB.OPERATORS.map((o) => `<option value="${o.id}"${o.id === f.op ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        ${op.noValue ? '' : `<input class="bcn-field" data-f-val="${i}" value="${esc(f.value || '')}"
               placeholder="${esc(declaredKeys().length ? `value, or {{${declaredKeys()[0]}}}` : 'value')}" />`}
        <button type="button" class="rb-x" data-f-del="${i}" aria-label="Remove">✕</button>
      </div>`;
    }).join('');

    const mvNote = source.relkind === 'matview'
      ? `<div class="rb-warn"><strong>${esc(source.relname)} is a materialized view.</strong>
           Postgres does not apply row-level security to those, so
           <code>company_entity_id = active_company_id()</code> is added automatically and cannot be removed.
           ${(source.columns || []).some((c) => c.name === 'company_entity_id') ? ''
             : ' This one has no company column, so it cannot be scoped — prefer a view.'}</div>`
      : '';

    // Everything below the summarise toggle used to be always open -- a
    // full field-type grid, every total's raw agg/column/alias row, every
    // filter row, all visible whether or not there was anything in them.
    // The chip bar reads the same config back as a compact summary and the
    // rail's field browser adds a field with one click, so none of that
    // needs to stay open by default any more. Each <details> below opens
    // itself the moment it has a reason to (nothing in it yet, or you just
    // added something to it) and otherwise stays closed; a manual toggle
    // is tracked in secOpen and survives the next re-render.
    const secOpen = (key, emptyCondition) => secManualOpen.has(key) || emptyCondition;
    // Open while EITHER half is unset, not just the column: picking a
    // column and having the range collapse out from under you before you
    // can pick a range too is a worse bug than leaving it open one render
    // longer than strictly necessary.
    const dateOpen = secOpen('secDate', !cfg.dateColumn || !cfg.dateRange);
    const measuresOpen = secOpen('secMeasures', !cfg.measures.length);
    const filtersOpen = secOpen('secFilters', !cfg.filters.length);

    el('buildBody').innerHTML = `
      ${mvNote}
      <div class="rb-section rb-source-head">
        <span class="rb-section-title rb-source-title">${esc(RB.friendlyRelName(source.relname))}</span>
        <details class="rb-details">
          <summary>${source.description
            ? esc(source.description.split(/(?<=[.!?])\s+/)[0]) + (/[.!?]\s+\S/.test(source.description) ? ' — details' : '')
            : 'Details'}</summary>
          ${source.description ? `<p class="rb-note">${esc(source.description)}</p>` : ''}
          <span class="rb-note rb-mono-hint">${esc(source.relname)} · ${esc(source.relkind)}</span>
        </details>
      </div>

      <div class="rb-section">
        <label class="rb-col" style="align-self:flex-start">
          <input type="checkbox" id="chkSummarise" ${cfg.summarise ? 'checked' : ''} />
          Summarise (group and total) ${cfg.summarise ? '· on' : '· off'}
        </label>
      </div>

      ${dateCols().length ? `
      <details class="rb-editor" id="secDate"${dateOpen ? ' open' : ''}>
        <summary>Date range${cfg.dateColumn ? ` · ${esc((RB.DATE_RANGES.find((r) => r.id === cfg.dateRange) || {}).label || 'custom')}` : ' · none'}</summary>
        <div class="rb-editor-body">
          <div class="rb-row">
            <div class="bcn-field-group">
              <label class="bcn-label" for="selDateCol">Date column</label>
              <select class="bcn-field" id="selDateCol">${opts(dateCols(), cfg.dateColumn, 'None')}</select>
            </div>
            <div class="bcn-field-group">
              <label class="bcn-label" for="selDateRange">Range</label>
              <select class="bcn-field" id="selDateRange">
                ${RB.DATE_RANGES.map((r) => `<option value="${r.id}"${r.id === cfg.dateRange ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
              </select>
            </div>
          </div>
          ${!cfg.dateColumn ? '<p class="rb-note">No date window yet — pick a column and a range on purpose. Nothing is filtered by default.</p>' : ''}
        </div>
      </details>` : ''}

      <details class="rb-editor" id="secFilters"${filtersOpen ? ' open' : ''}>
        <summary>Filters${cfg.filters.length ? ` · ${cfg.filters.length}` : ''}</summary>
        <div class="rb-editor-body">
          ${filterRows || '<p class="rb-note">No filters.</p>'}
          <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddFilter" style="align-self:flex-start">+ Add a filter</button>
        </div>
      </details>

      ${cfg.summarise ? `
      <details class="rb-editor" id="secMeasures"${measuresOpen ? ' open' : ''}>
        <summary>Totals${cfg.measures.length ? ` · ${cfg.measures.length}` : ''}</summary>
        <div class="rb-editor-body">
          ${measureRows || '<p class="rb-note">No totals yet — add one.</p>'}
          <div class="rb-row">
            <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddMeasure">+ Add a total</button>
            <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddCalc">+ Add a calculation</button>
          </div>
          <p class="rb-note">A calculation is one total over another — ROAS is sales ÷ spend, and no column holds it.
            Division is guarded, so a zero denominator leaves the cell empty rather than failing the query.</p>
        </div>
      </details>` : ''}

      <details class="rb-editor" id="secSort">
        <summary>Sort and limit</summary>
        <div class="rb-editor-body">
          <div class="rb-row">
            <div class="bcn-field-group">
              <label class="bcn-label" for="selSort">Sort by</label>
              <select class="bcn-field" id="selSort">
                ${opts(cfg.summarise ? cols.map((c) => c.name).concat(aliasList) : cols, cfg.sortColumn, 'Query order')}
              </select>
            </div>
            <div class="bcn-field-group">
              <label class="bcn-label" for="selSortDir">Direction</label>
              <select class="bcn-field" id="selSortDir">
                <option value="desc"${cfg.sortDir === 'desc' ? ' selected' : ''}>Highest first</option>
                <option value="asc"${cfg.sortDir === 'asc' ? ' selected' : ''}>Lowest first</option>
              </select>
            </div>
            <div class="bcn-field-group">
              <label class="bcn-label" for="inpLimit">Limit</label>
              <input class="bcn-field bcn-field--mono" id="inpLimit" type="number" min="0" max="1000" value="${Number(cfg.limit) || 0}" />
            </div>
          </div>
        </div>
      </details>

      <details class="rb-editor" id="secGenSql">
        <summary>SQL this generates</summary>
        <div class="rb-editor-body">
          <pre class="rb-generated" id="genSql">${esc(RB.buildSql(source, cfg) || '-- choose at least one total to summarise')}</pre>
        </div>
      </details>`;
    // toggle does not reliably bubble, so each <details> gets its own
    // listener rather than one delegated on #buildBody -- there are at
    // most six of these, so the cost of re-attaching every render is nothing.
    el('buildBody').querySelectorAll('details.rb-editor[id]').forEach((d) => {
      d.addEventListener('toggle', () => {
        if (d.open) secManualOpen.add(d.id); else secManualOpen.delete(d.id);
      });
    });
    renderChipBar();
    renderFieldBrowser();
    markStale();
  }

  // ── Compact chip summary ────────────────────────────────────────────
  // The always-open field cloud above still IS the editor -- these are a
  // compact READOUT of what it currently holds, with click-to-remove and
  // click-to-reorder, so the current shape of the report is legible without
  // scrolling a long form. Clicking a chip's label (not its buttons) just
  // scrolls the real control into view; nothing here is a second source of
  // truth for cfg.
  const AGG_LABELS = { sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count' };
  const colLabel = (n) => window.SiloChart.columnLabel(n);

  function measureChipLabel(m) {
    const calc = RB.calcFor(m);
    if (calc) return `${colLabel(m.column)} ${calc.symbol} ${colLabel(m.column2)}`;
    // Sum is the overwhelmingly common case and the chip is read many times
    // for every once it is edited, so it stays terse -- "Net Sales", not
    // "Sum of Net Sales". A non-default aggregation is the one thing worth
    // spending the extra word on, since silently reading "Net Sales" as a
    // sum when it is actually an average would be a wrong number, not a
    // cosmetic slip.
    if (m.agg === 'sum') return colLabel(m.column);
    return `${AGG_LABELS[m.agg] || m.agg} of ${colLabel(m.column)}`;
  }

  function filterChipLabel(f) {
    const op = RB.OPERATORS.find((o) => o.id === f.op) || RB.OPERATORS[0];
    const val = String(f.value || '').slice(0, 22) + (String(f.value || '').length > 22 ? '…' : '');
    // "is" is the overwhelmingly common operator, so the chip reads as
    // "Location Tag: online" rather than "Location Tag is online" -- every
    // other operator keeps its word (greater than, contains, ...) because
    // dropping THOSE would change what the chip claims, not just how it
    // reads.
    if (op.noValue) return `${colLabel(f.column || '…')} ${op.label}`;
    if (op.id === 'eq') return `${colLabel(f.column || '…')}: ${val}`;
    return `${colLabel(f.column || '…')} ${op.label} ${val}`;
  }

  function dateRangeChipLabel() {
    const range = RB.DATE_RANGES.find((r) => r.id === cfg.dateRange);
    return `${(range && range.label) || cfg.dateRange} · ${colLabel(cfg.dateColumn)}`;
  }

  /** One removable, and sometimes reorderable, pill. `move` is omitted for
      groups where order carries no meaning (filters, parameters). */
  function chip(label, { zone, index, move } = {}) {
    return `<span class="rb-chip" data-chip-jump="${esc(zone)}">
        ${move ? `<button type="button" class="rb-chip-move" data-chip-move="${zone}:${index}" data-dir="-1"
            ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(label)} earlier">‹</button>` : ''}
        <span class="rb-chip-label">${esc(label)}</span>
        ${move ? `<button type="button" class="rb-chip-move" data-chip-move="${zone}:${index}" data-dir="1"
            ${index === move - 1 ? 'disabled' : ''} aria-label="Move ${esc(label)} later">›</button>` : ''}
        <button type="button" class="rb-chip-x" data-chip-x="${zone}:${index}" aria-label="Remove ${esc(label)}">✕</button>
      </span>`;
  }

  function chipGroup(label, chips, { zone, addLabel }) {
    return `<div class="rb-chipgroup" data-drop-zone="${esc(zone)}">
        <span class="rb-chipgroup-label">${esc(label)}</span>
        <div class="rb-chips">${chips.join('') || '<span class="rb-chip-empty">Drop a field here, or click +</span>'}</div>
        <button type="button" class="rb-chip-add" data-chip-add="${zone}" title="${esc(addLabel)}" aria-label="${esc(addLabel)}">+</button>
      </div>`;
  }

  function renderChipBar() {
    const bar = el('chipBar');
    if (!bar) return;
    const groups = [];

    // Rows/Values/Filters need a picked catalog source -- they read cfg
    // against its column list. A hand-written or unrestorable SQL report
    // (no `source`) still gets its Parameters chips, though: a parameter
    // declaration is orthogonal to how the query was authored, and a
    // "Customize a copy" of a system report is exactly the case where
    // there is no source AND the parameters are the one thing worth
    // reaching without diving into the SQL dock.
    if (source) {
      const rowsChips = cfg.summarise
        ? cfg.dimensions.map((d, i) => chip(colLabel(d), { zone: 'dims', index: i, move: cfg.dimensions.length }))
        : cfg.columns.map((c, i) => chip(colLabel(c), { zone: 'cols', index: i }));
      groups.push(chipGroup(cfg.summarise ? 'Rows' : 'Columns', rowsChips, {
        zone: cfg.summarise ? 'dims' : 'cols',
        addLabel: cfg.summarise ? 'Choose a group-by column' : 'Choose which columns to show',
      }));
      if (cfg.summarise) {
        const valueChips = cfg.measures.map((m, i) => chip(measureChipLabel(m), { zone: 'measures', index: i, move: cfg.measures.length }));
        groups.push(chipGroup('Values', valueChips, { zone: 'measures', addLabel: 'Add a total' }));
      }
      const filterChips = cfg.filters.map((f, i) => chip(filterChipLabel(f), { zone: 'filters', index: i }));
      if (cfg.dateColumn && cfg.dateRange) filterChips.unshift(chip(dateRangeChipLabel(), { zone: 'daterange' }));
      groups.push(chipGroup('Filters', filterChips, { zone: 'filters', addLabel: 'Add a filter' }));
    }

    if (cfg.parameters.length) {
      const paramChips = cfg.parameters.map((p, i) => chip(p.label || p.key || 'Untitled', { zone: 'params', index: i }));
      groups.push(chipGroup('Parameters', paramChips, { zone: 'params', addLabel: 'Add a parameter' }));
    }
    bar.hidden = !groups.length;
    bar.innerHTML = groups.join('');
  }

  function moveItem(arr, from, dir) {
    const to = from + dir;
    if (to < 0 || to >= arr.length) return;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
  }

  // Rows/Columns have no collapsed editor of their own any more -- picking
  // a dimension or a detail column happens in the rail's field browser, so
  // that is where a "Rows" chip or its "+" points. Measures/Filters/Date
  // point at their own collapsed <details>, opened on arrival rather than
  // merely scrolled to, since a chip pointing at something still hidden
  // would read as broken.
  const SECTION_FOR_ZONE = { dims: 'fieldBrowser', cols: 'fieldBrowser', measures: 'secMeasures',
    filters: 'secFilters', daterange: 'secDate', params: 'paramsSection' };
  // Measures/Filters/Date live inside the Build tab's collapsed editors;
  // Rows/Columns live in the always-visible rail; Parameters live outside
  // the Build/SQL tabs entirely (they apply to a report however it was
  // authored). Only the first group needs the tab switched to reach it.
  const ZONE_NEEDS_BUILD_TAB = new Set(['measures', 'filters', 'daterange']);

  function revealSection(zone) {
    if (ZONE_NEEDS_BUILD_TAB.has(zone)) document.querySelector('[data-tab="build"]').click();
    const target = document.getElementById(SECTION_FOR_ZONE[zone]);
    if (!target) return;
    if (target.tagName === 'DETAILS' && !target.open) {
      target.open = true;
      secManualOpen.add(target.id);
    }
    if (zone === 'dims' || zone === 'cols') {
      const rail = document.querySelector('.rb-rail');
      if (rail && rail.classList.contains('is-collapsed')) el('btnToggleRail')?.click();
      el('fieldSearch')?.focus();
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  el('chipBar')?.addEventListener('click', (e) => {
    const moveBtn = e.target.closest('[data-chip-move]');
    if (moveBtn) {
      const [zone, idx] = moveBtn.dataset.chipMove.split(':');
      const arr = zone === 'dims' ? cfg.dimensions : zone === 'measures' ? cfg.measures : null;
      if (arr) { moveItem(arr, Number(idx), Number(moveBtn.dataset.dir)); renderBuild(); }
      return;
    }
    const xBtn = e.target.closest('[data-chip-x]');
    if (xBtn) {
      const [zone, idx] = xBtn.dataset.chipX.split(':');
      const i = Number(idx);
      if (zone === 'dims') cfg.dimensions.splice(i, 1);
      else if (zone === 'cols') cfg.columns.splice(i, 1);
      else if (zone === 'measures') cfg.measures.splice(i, 1);
      else if (zone === 'filters') cfg.filters.splice(i, 1);
      else if (zone === 'daterange') { cfg.dateColumn = ''; cfg.dateRange = ''; }
      else if (zone === 'params') { cfg.parameters.splice(i, 1); renderParams(); return; }
      renderBuild();
      return;
    }
    const addBtn = e.target.closest('[data-chip-add]');
    if (addBtn) {
      const zone = addBtn.dataset.chipAdd;
      if (zone === 'measures') { addMeasure(); return; }
      if (zone === 'filters') { addFilter(); return; }
      if (zone === 'params') { addParam(); return; }
      // Rows/Columns has no "blank" item to add -- a dimension is picked
      // from what already exists, not created. Jump to where it is picked.
      revealSection(zone);
      return;
    }
    const jump = e.target.closest('[data-chip-jump]');
    if (jump && !e.target.closest('button')) revealSection(jump.dataset.chipJump);
  });

  // ── Field browser (rail) ─────────────────────────────────────────────
  // A second, always-available way to add a field: browse instead of
  // search. Click is the primary interaction (works with a keyboard or a
  // finger); dragging a row onto a chip group performs the exact same add,
  // it is not a second definition of what "add" means.
  function fieldInUse(name, kind) {
    if (kind === 'dim') return cfg.dimensions.includes(name);
    if (kind === 'measure') return cfg.measures.some((m) => !RB.calcFor(m) && m.column === name && m.agg === 'sum');
    return cfg.columns.includes(name);
  }

  function toggleField(name, kind, { addOnly } = {}) {
    if (kind === 'dim') {
      const on = cfg.dimensions.includes(name);
      if (on && !addOnly) cfg.dimensions = cfg.dimensions.filter((d) => d !== name);
      else if (!on) cfg.dimensions = cfg.dimensions.concat(name);
    } else if (kind === 'measure') {
      const idx = cfg.measures.findIndex((m) => !RB.calcFor(m) && m.column === name && m.agg === 'sum');
      if (idx >= 0 && !addOnly) cfg.measures.splice(idx, 1);
      else if (idx < 0) cfg.measures.push({ column: name, agg: 'sum', alias: '' });
    } else {
      const on = cfg.columns.includes(name);
      if (on && !addOnly) cfg.columns = cfg.columns.filter((x) => x !== name);
      else if (!on) cfg.columns = cfg.columns.concat(name);
    }
    renderBuild();
  }

  function fieldIcon(type) {
    if (RB.DATEISH_PG.test(type)) return '\u{1F4C5}';
    if (RB.NUMERIC_PG.test(type)) return '#';
    return 'Aa';
  }

  function fieldRow(c, kind) {
    const on = fieldInUse(c.name, kind);
    return `<button type="button" class="rb-field-row${on ? ' is-on' : ''}" draggable="true"
              data-field="${esc(c.name)}" data-field-kind="${kind}" title="${esc(c.name)}">
        <span class="rb-field-icon">${fieldIcon(c.type)}</span>
        <span class="rb-field-name">${esc(colLabel(c.name))}</span>
        ${on ? '<span class="rb-field-on" aria-hidden="true">✓</span>' : ''}
      </button>`;
  }

  function renderFieldBrowser() {
    const wrap = el('fieldBrowser');
    if (!wrap) return;
    if (!source) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const q = (el('fieldSearch') && el('fieldSearch').value || '').trim().toLowerCase();
    const cols = usableCols().filter((c) => !q || RB.fuzzyScore(q, [colLabel(c.name), c.name]) > 0);
    const section = (label, rows, kind) => rows.length
      ? `<div class="rb-group-label">${esc(label)}</div>${rows.map((c) => fieldRow(c, kind)).join('')}`
      : '';
    const toggleHtml = hiddenCount()
      ? `<button type="button" class="rb-linkbtn" id="btnToggleCols">
           ${showAllColumns
             ? `Hide ${hiddenCount()} technical column${hiddenCount() === 1 ? '' : 's'}`
             : `Show ${hiddenCount()} technical column${hiddenCount() === 1 ? '' : 's'} (ids, sync stamps)`}
         </button>` : '';
    el('fieldBrowserList').innerHTML = (cfg.summarise
      ? section('Group by', cols, 'dim') + section('Measures', cols.filter((c) => RB.NUMERIC_PG.test(c.type)), 'measure')
      : section('Columns', cols, 'col')) + toggleHtml;
  }

  el('fieldSearch')?.addEventListener('input', renderFieldBrowser);
  el('fieldBrowserList')?.addEventListener('click', (e) => {
    if (e.target.closest('#btnToggleCols')) {
      showAllColumns = !showAllColumns;
      // Keep only selections that still exist in the visible set, so hiding
      // plumbing cannot silently leave a hidden column in the query.
      const allowed = new Set(usableCols().map((c) => c.name));
      cfg.columns = cfg.columns.filter((c) => allowed.has(c));
      if (!cfg.columns.length) cfg.columns = usableCols().map((c) => c.name);
      renderBuild();
      return;
    }
    const row = e.target.closest('[data-field]');
    if (row) toggleField(row.dataset.field, row.dataset.fieldKind);
  });
  el('fieldBrowserList')?.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-field]');
    if (!row) return;
    e.dataTransfer.setData('text/plain', JSON.stringify({ name: row.dataset.field, kind: row.dataset.fieldKind }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  // The zone a field's kind may land in. A measure dropped on Rows, or a
  // dimension dropped on Values, is silently ignored rather than coerced --
  // guessing which list the person meant would be worse than nothing.
  const DROP_ACCEPTS = { dim: new Set(['dims', 'cols']), measure: new Set(['measures']), col: new Set(['cols']) };
  el('chipBar')?.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-drop-zone]');
    if (zone) e.preventDefault();
  });
  el('chipBar')?.addEventListener('dragenter', (e) => {
    const zone = e.target.closest('[data-drop-zone]');
    if (zone) zone.classList.add('is-drop-target');
  });
  el('chipBar')?.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop-zone]');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('is-drop-target');
  });
  el('chipBar')?.addEventListener('drop', (e) => {
    const zoneEl = e.target.closest('[data-drop-zone]');
    if (!zoneEl) return;
    e.preventDefault();
    zoneEl.classList.remove('is-drop-target');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
    if (!payload || !payload.name) return;
    const zone = zoneEl.dataset.dropZone;
    if (!(DROP_ACCEPTS[payload.kind] || new Set()).has(zone)) return;
    toggleField(payload.name, payload.kind, { addOnly: true });
  });

  // ── Parameters ───────────────────────────────────────────────────────
  const P = window.SiloReportParams;

  // The dashboard's own date slicer control -- same presets, same "resolves
  // to" hint -- so a date parameter looks familiar the moment someone meets
  // it here, rather than as a bare text field expecting a relative token
  // nobody would guess. window.SiloFilterBar is loaded by every v3 page.
  const FB = window.SiloFilterBar;
  function paramDateHint(p) {
    const iso = P.resolveDateExpr(p.default);
    if (!iso) return '';
    if (p.date_basis === 'company') return 'Company calendar';
    return iso;
  }
  function paramFriendlyControl(p, i) {
    if (p.type !== 'date' || !FB) return '';
    const isPreset = FB.DATE_PRESETS.some((x) => x.value === p.default);
    const iso = P.resolveDateExpr(p.default);
    const isCustom = !isPreset && !!iso;
    return `<div class="rb-param-date">
        <select class="bcn-field" data-param-preset="${i}">
          ${FB.DATE_PRESETS.map((x) => `<option value="${x.value}"${x.value === p.default ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
          <option value="__custom"${isCustom ? ' selected' : ''}>Specific date…</option>
        </select>
        <input class="bcn-field" type="date" data-param-date="${i}" value="${isCustom ? esc(iso) : ''}" ${isCustom ? '' : 'hidden'} />
        ${!isCustom && iso ? `<span class="rb-note bcn-mono">${esc(paramDateHint(p))}</span>` : ''}
      </div>`;
  }

  function renderParams() {
    const rows = cfg.parameters.map((p, i) => {
      const isEnum = p.type === 'enum';
      const friendly = paramFriendlyControl(p, i);
      // A freshly added parameter (no key yet) opens straight to the
      // advanced editor -- addParam() below focuses the key field, which
      // cannot receive focus while collapsed. Anything already configured
      // stays closed: the friendly control above it is the normal way to
      // read or change a date parameter day to day.
      return `<div class="rb-param" data-param-row="${i}">
          <div class="rb-param-summary">
            <span class="rb-param-name">${esc(p.label || p.key || 'Untitled parameter')}</span>
            ${friendly}
            ${!friendly && p.default ? `<span class="rb-note bcn-mono">default ${esc(p.default)}</span>` : ''}
            <button type="button" class="dw-icon-btn" data-remove-param="${i}"
                    title="Remove this parameter" aria-label="Remove this parameter">✕</button>
          </div>
          <details class="rb-param-advanced"${p.key ? '' : ' open'}>
            <summary>Key, type &amp; default</summary>
            <div class="rb-param-fields">
              <div class="bcn-field-group">
                <label class="bcn-label">Key</label>
                <input class="bcn-field bcn-field--mono" data-p="key" data-i="${i}"
                       value="${esc(p.key || '')}" placeholder="date_from" />
              </div>
              <div class="bcn-field-group">
                <label class="bcn-label">Label</label>
                <input class="bcn-field" data-p="label" data-i="${i}"
                       value="${esc(p.label || '')}" placeholder="From" />
              </div>
              <div class="bcn-field-group">
                <label class="bcn-label">Type</label>
                <select class="bcn-field" data-p="type" data-i="${i}">
                  ${P.TYPES.map((t) => `<option value="${t}"${t === p.type ? ' selected' : ''}>${t}</option>`).join('')}
                </select>
              </div>
              ${isEnum ? `<div class="bcn-field-group bcn-field-group--wide">
                <label class="bcn-label">Choices (comma separated)</label>
                <input class="bcn-field bcn-field--mono" data-p="options" data-i="${i}"
                       value="${esc((p.options || []).join(', '))}" placeholder="day, week, month, ytd" />
              </div>` : ''}
              <div class="bcn-field-group">
                <label class="bcn-label">Default</label>
                ${p.type === 'date' && p.date_basis === 'company' ? '<span class="bcn-hint">Relative dates follow the company calendar.</span>' : ''}
                <input class="bcn-field bcn-field--mono" data-p="default" data-i="${i}"
                       value="${esc(p.default || '')}"
                       placeholder="${p.type === 'date' ? 'today-27d' : ''}" />
              </div>
            </div>
          </details>
        </div>`;
    }).join('');

    el('paramList').innerHTML = rows
      || '<div class="v3-empty">No parameters. This report runs exactly as written.</div>';

    // A date parameter accepts relative tokens, and nobody guesses that.
    if (cfg.parameters.some((p) => p.type === 'date')) {
      el('paramList').insertAdjacentHTML('beforeend',
        `<p class="rb-note">A date default can be ${esc(P.DATE_HINT)}. A relative default keeps the report
         rolling — a fixed date freezes it on the day you saved it.</p>`);
    }
    checkParams();
    renderChipBar();
  }

  function checkParams() {
    const sql = currentSql() || '';
    const { errors, warnings } = RB.validateParameters(sql, cfg.parameters);
    el('paramWarn').innerHTML = errors.map((m) => `<div class="rb-warn rb-warn--bad">${esc(m)}</div>`)
      .concat(warnings.map((m) => `<div class="rb-warn">${esc(m)}</div>`)).join('');
    return errors;
  }

  // ── Running ──────────────────────────────────────────────────────────
  function currentSql() {
    if (tab === 'sql') return (el('sqlText').value || '').trim();
    return source ? RB.buildSql(source, cfg) : null;
  }

  /**
   * How many rows does this query ACTUALLY return?
   *
   * Only asked when the preview came back full, because otherwise the answer
   * is already known exactly -- a page that returns fewer rows than the cap
   * IS the whole result, and spending a second query to confirm what we just
   * counted would be waste on the great majority of reports.
   *
   * Wrapped as `select count(*) from (<sql>) z`, which survives the runner's
   * single-statement check for every shape a report takes: a plain SELECT, a
   * WITH/CTE chain (what the guided builder and an agent both tend to write),
   * and a query carrying its own ORDER BY. Verified against all three on prod
   * before this shipped. The trailing semicolon strip is load-bearing -- the
   * runner rejects semicolons outright, and hand-written SQL frequently ends
   * with one.
   *
   * Returns null on ANY failure, including the 30s timeout, and null must
   * stay null all the way to the column: reporting the page size as the total
   * would turn "we could not measure this" into a confident 1,000, which is
   * the exact class of wrong number this whole feature exists to prevent.
   */
  async function countRows(resolvedSql) {
    const inner = String(resolvedSql || '').trim().replace(/;+\s*$/, '');
    if (!inner) return null;
    try {
      const { data, error } = await sb.rpc('chat_run_readonly_query',
        { query: `select count(*) as n from (${inner}) z`, p_offset: 0 });
      if (error) return null;
      const n = Array.isArray(data) && data.length ? Number(data[0].n) : null;
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The report's true row count, or null when it genuinely is not known.
   * Exact whenever the preview fit inside one page; otherwise whatever the
   * count query managed. Never lastRun.rows.length on a capped run -- that is
   * a floor, not a total.
   */
  function knownTotal() {
    if (!lastRun) return null;
    if (lastRun.total != null) return lastRun.total;
    if (lastRun.firstPageRows != null && lastRun.firstPageRows < PAGE_CAP) return lastRun.firstPageRows;
    return null;
  }

  // ── Chart preview ────────────────────────────────────────────────────
  // The same primitives dashboard-renderer.js draws a tile with -- recommend
  // a shape, validate it can actually be drawn, shape the rows, hand ECharts
  // the option -- without pulling in GridStack or the widget/dashboard
  // object model a single report preview has no use for. Table stays the
  // one thing that always renders; the chart is an addition above it, never
  // a replacement, so "Load more" and the raw grid keep working exactly as
  // they always have.
  let previewChart = null;   // the live ECharts instance, disposed on every re-render
  let showChart = true;      // the reader's own toggle, reset per fresh Preview

  function disposePreviewChart() {
    if (previewChart) { try { previewChart.dispose(); } catch (e) { /* already gone */ } previewChart = null; }
  }

  function chartRecommendation(rows, semantics) {
    if (!window.echarts || !rows.length) return null;
    let rec = window.SiloChart.recommend(rows, semantics);
    if (window.SiloReportPreview) rec = window.SiloReportPreview.preferPrimary(rec, currentMetadata(rows), rows);
    if (!rec || !rec.visual_type || rec.visual_type === 'table') return null;
    if (rec.visual_type !== 'kpi') {
      const valid = window.SiloChart.validateVisual(rec.visual_type, rows, rec.visual_config, semantics);
      if (!valid.ok) return null;
    }
    return rec;
  }

  function renderPreviewChart(rows) {
    disposePreviewChart();
    const host = el('previewChart');
    const toggle = el('btnPreviewMode');
    if (!host || !toggle) return;
    const semantics = mapSemantics(currentMetadata(rows));
    const rec = chartRecommendation(rows, semantics);
    if (!rec) { host.hidden = true; toggle.hidden = true; return; }
    toggle.hidden = false;
    toggle.textContent = showChart ? 'Show table only' : 'Show chart';
    host.hidden = !showChart;
    if (!showChart) return;
    if (rec.visual_type === 'kpi') {
      host.innerHTML = window.SiloChart.kpiHtml(rows, rec.visual_config, semantics);
      return;
    }
    const shaped = window.SiloChart.shape(rows, rec.visual_config, semantics);
    if (!shaped) { host.hidden = true; toggle.hidden = true; return; }
    // A caption earns the chart its place as the page's main visual, the
    // same way a saved report's title tells you what a dashboard tile is
    // before you read a single number off it.
    const title = shaped.xField ? `${colLabel(shaped.yField)} by ${colLabel(shaped.xField)}` : colLabel(shaped.yField);
    host.innerHTML = `<div class="rb-chart-title">${esc(title)}</div><div class="dw-chart" data-role="chart"></div>`;
    previewChart = window.echarts.init(host.querySelector('[data-role="chart"]'), null, { renderer: 'canvas' });
    previewChart.setOption(window.SiloChart.optionFor(rec.visual_type, shaped, rec.visual_config));
  }

  /**
   * Is what is on screen still what the current configuration would run?
   * Compact and non-blocking -- previewing on every keystroke would burn a
   * query per character and race itself; this just says "this may be
   * out of date" so Run/Preview stays a deliberate, visible action.
   */
  function markStale() {
    const bar = el('staleBar');
    if (!bar) return;
    if (!lastRun) { bar.hidden = true; return; }
    const cur = (currentSql() || '').trim();
    bar.hidden = !cur || cur === (lastRun.sql || '').trim();
  }

  /** Re-render the preview table + meta line from lastRun's accumulated rows. */
  function renderPreview(ms, opts) {
    const rows = lastRun.rows;
    const usedParams = P.tokensIn(lastRun.sql).length;
    const hasMore = rows.length > 0 && rows.length % PAGE_CAP === 0 && !(opts && opts.exhausted);
    // Say the TOTAL, not the number fetched -- "1,000 rows" next to a result
    // that is really 7,231 is the misreading this exists to stop.
    const total = knownTotal();
    const capped = total != null && total > PAGE_CAP;
    el('previewMeta').textContent =
      (capped
        ? `${total.toLocaleString()} rows · showing ${rows.length.toLocaleString()}`
        : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`
          + (total == null && rows.length >= PAGE_CAP ? '+ (could not measure the total)' : ''))
      + (ms != null ? ` · ${ms}ms` : '')
      + (usedParams ? ` · ran with default ${usedParams === 1 ? 'parameter' : 'parameters'}` : '');
    el('previewBody').innerHTML = rows.length
      ? sizeWarningHtml()
        + window.SiloChart.tableHtml(rows, { limit: 50 }, mapSemantics(currentMetadata(rows)))
        + (hasMore
            ? `<div class="rb-preview-more">
                 <button type="button" class="bcn-btn bcn-btn--ghost" id="btnLoadMorePreview">Load next ${PAGE_CAP} rows</button>
                 <span class="rb-note">Fetched in pages of ${PAGE_CAP} — each page is its own query against live data.</span>
               </div>`
            : '')
      : '<div class="dw-empty">Ran fine — 0 rows.</div>';
    renderPreviewChart(rows);
    markStale();
  }

  /**
   * The one thing the author could not previously find out at authoring time.
   *
   * Deliberately not blocking and deliberately not phrased as an error: an
   * export-shaped report is a legitimate thing to build, and a builder that
   * refuses it sends the author to a duplicate. It states the number and what
   * a tile will do with it, and leaves the decision where it belongs.
   */
  function sizeWarningHtml() {
    const total = knownTotal();
    if (total == null || total <= PAGE_CAP) return '';
    return `<div class="rb-warn">This report returns <strong>${total.toLocaleString()} rows</strong>. `
      + `A dashboard tile shows ${PAGE_CAP.toLocaleString()} at a time — a table lets the reader page `
      + `through the rest, but a chart or KPI is drawn from the first page alone. `
      + `If this is meant to be read on a board, aggregate it or take a top-N here; `
      + `at this size it is shaped like an export.</div>`;
  }

  // Bumped on every call; a response that lands after a NEWER call has
  // already started is dropped rather than drawn over whatever that newer
  // call already rendered. Genuine cancellation of the in-flight fetch is
  // not available through this client -- this is the same "ignore the stale
  // answer" guard already used for the row count below, applied to the
  // query itself so two rapid clicks (or Preview during a still-running
  // Load more) cannot land out of order.
  let previewSeq = 0;

  async function preview() {
    const sql = currentSql();
    if (!sql) { setStatus('Nothing to run yet — pick a source, or type some SQL.', 'neg', 4000); return; }

    // The report STORES the template; the preview RUNS the resolved query.
    // Keeping both is the point: saving the resolved SQL would bake today's
    // values in and the dashboard's slicers would have nothing to move.
    const errors = checkParams();
    if (errors.length) { setStatus(errors[0], 'neg', 6000); return; }
    const resolved = P.substitute(sql, cfg.parameters, {});
    if (resolved.error) { setStatus(resolved.error, 'neg', 6000); return; }

    const seq = ++previewSeq;
    el('previewBody').innerHTML = '<div class="dw-loading">Running…</div>';
    el('previewMeta').textContent = '';
    if (el('staleBar')) el('staleBar').hidden = true;
    el('btnPreview').disabled = true;
    const runBtn = el('btnRunQuery');
    if (runBtn) runBtn.disabled = true;
    const t0 = performance.now();
    const { data, error } = await sb.rpc('chat_run_readonly_query', { query: resolved.sql, p_offset: 0 });
    const ms = Math.round(performance.now() - t0);
    if (seq !== previewSeq) return; // superseded by a newer Preview/Run click
    el('btnPreview').disabled = false;
    if (runBtn) runBtn.disabled = false;
    if (error) {
      lastRun = null;
      el('previewBody').innerHTML = `<div class="dw-empty dw-empty--error"><strong>Query failed.</strong> ${esc(error.message)}</div>`
        + (P.tokensIn(sql).length
            ? `<pre class="rb-generated">${esc(resolved.sql)}</pre>` : '');
      el('previewMeta').textContent = `failed in ${ms}ms`;
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    // `sql` is the template that gets saved; `resolved.sql` is what just ran.
    // Every fresh Preview restarts pagination at page 1 -- a stale second
    // page from a prior query would otherwise linger onto a new one.
    lastRun = { sql, resolvedSql: resolved.sql, rows, firstPageRows: rows.length, total: null };
    renderPreview(ms);

    // Measure the real total only when the page came back full. Rendering
    // first and counting after keeps the preview as fast as it was -- the
    // count is a second query and this one is already on screen when it runs.
    if (rows.length >= PAGE_CAP) {
      const token = lastRun;
      const total = await countRows(resolved.sql);
      // A newer Preview may have replaced this run while the count was in
      // flight; a stale total is worse than none.
      if (lastRun === token) {
        lastRun.total = total;
        renderPreview(ms);
      }
    }
  }

  /**
   * Fetch the next page of the CURRENT preview and append it. Uses the
   * already-resolved SQL from the last Preview run, not a fresh substitution
   * -- Load more continues the same query, it does not re-evaluate defaults.
   */
  async function loadMorePreview() {
    if (!lastRun || !lastRun.resolvedSql) return;
    const btn = el('btnLoadMorePreview');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    const t0 = performance.now();
    const { data, error } = await sb.rpc('chat_run_readonly_query',
      { query: lastRun.resolvedSql, p_offset: lastRun.rows.length });
    const ms = Math.round(performance.now() - t0);
    if (error) {
      setStatus(`Could not load the next page: ${error.message}`, 'neg', 6000);
      if (btn) { btn.disabled = false; btn.textContent = `Load next ${PAGE_CAP} rows`; }
      return;
    }
    const newRows = Array.isArray(data) ? data : [];
    lastRun.rows = lastRun.rows.concat(newRows);
    renderPreview(ms, { exhausted: newRows.length < PAGE_CAP });
  }

  // metadataFromCatalog returns {col:{semantic}}; the adapter wants {col:semantic}.
  function mapSemantics(md) {
    if (!md) return null;
    const out = {};
    for (const [k, v] of Object.entries(md)) out[k] = v.semantic;
    return out;
  }

  /**
   * What this report's columns mean, catalog first and CALCULATIONS on top.
   *
   * The order matters. A calculated column exists in no catalog, so the
   * grounded layer has nothing to say about it and inference over the
   * returned rows would fall back to reading its name -- which gets
   * `net_sales_pct_of_total` wrong, printing 12.4% as $12.40. The
   * calculation knows what it produced, so it wins.
   */
  function currentMetadata(rows) {
    if (!source) return null;
    const md = RB.metadataFromCatalog(source, null, rows) || {};
    Object.assign(md, RB.metadataForMeasures(source, cfg.summarise ? cfg.measures : []));
    return Object.keys(md).length ? md : null;
  }

  // ── Editing an existing report ───────────────────────────────────────
  /**
   * Load a saved report into the builder.
   *
   * Three outcomes, and the page must be honest about which one you are in
   * BEFORE you start typing:
   *   - yours (or you are exec/owner): a real edit, saved over the original
   *   - someone else's, or a central `system` definition: read-only, and the
   *     only way forward is Save as a copy
   *   - not found: it was deleted, or it belongs to another company
   *
   * The gate below mirrors silo_chat_saved_reports_update, but it is UX
   * only -- RLS is the boundary, and confirmSave() handles a refusal even
   * when this guess says yes (membership owner_admin passes is_exec_or_owner
   * without carrying a profile role that says so).
   */
  async function loadForEdit(id, user, profile) {
    const { data: rep, error } = await sb.from('silo_chat_saved_reports')
      .select('id, title, description, visibility, source, company_entity_id, created_by, '
            + 'queries_run, parameters, columns_metadata, builder_config')
      .eq('id', id).maybeSingle();
    if (error || !rep) {
      setStatus('That report could not be opened — it may have been deleted, or it belongs to '
        + 'another company. Everything below is a new report.', 'neg', 9000);
      return;
    }

    const isGlobal = rep.source === 'system' || !rep.company_entity_id;
    const roleIsExec = ['owner', 'executive'].includes(String(profile?.role || ''));
    const canWrite = !isGlobal && (rep.created_by === user.id || roleIsExec);

    // Blast radius. Fetched before anything is editable so the count is on
    // screen while you decide, not after you have already typed.
    let usage = null;
    const { data: u } = await sb.rpc('saved_report_usage', { p_report_id: id });
    if (Array.isArray(u) && u.length) usage = u[0];

    const queries = Array.isArray(rep.queries_run) ? rep.queries_run : [];
    const qi = RB.defaultQueryIndex(queries);
    cfg.parameters = Array.isArray(rep.parameters) ? rep.parameters.map((d) => ({
      key: d.key || '', label: d.label || '', type: d.type || 'text',
      default: d.default == null ? '' : String(d.default), options: d.options || [],
      date_basis: d.date_basis,
    })) : [];

    editing = {
      id, source: rep.source, createdBy: rep.created_by, canWrite, usage,
      queryCount: queries.length,
      // What this report declared when it was opened. The parameter-removal
      // warning needs the BEFORE picture; cfg.parameters is the after.
      declaredKeys: cfg.parameters.map((d) => d.key).filter(Boolean),
    };

    el('saveName').value = rep.title || '';
    el('saveDesc').value = rep.description || '';
    el('saveVis').value = rep.visibility || 'company';
    el('pageTitle').textContent = canWrite ? 'Edit report' : 'Report (read-only)';
    el('pageSub').textContent = rep.title || '';
    el('statusBadge').textContent = canWrite ? 'Editing' : 'Read-only';
    el('statusBadge').className = canWrite ? 'bcn-pill' : 'bcn-pill bcn-pill--accent';
    // The chrome mounts before we know which report this is, so the trail
    // still reads "New report". Left alone it is the page contradicting
    // itself in two places a foot apart.
    const crumb = document.querySelector('.silo-crumbs .crumb-last');
    if (crumb) crumb.textContent = canWrite ? 'Edit report' : 'Report';
    el('btnSave').textContent = canWrite ? 'Save changes' : 'Save as a copy';

    // Guided config restores the guided tab; anything else opens as SQL,
    // because that is genuinely what the report is. A builder_config naming
    // a table this user cannot report on is treated as absent rather than
    // half-restored.
    const bc = rep.builder_config;
    const restorable = bc && bc.relname && bc.cfg && catalog.some((r) => r.relname === bc.relname);
    if (restorable) {
      selectSource(bc.relname);
      Object.assign(cfg, bc.cfg, { parameters: cfg.parameters });
      renderBuild();
      el('sqlText').value = RB.buildSql(source, cfg) || '';
    } else {
      document.querySelector('[data-tab="sql"]').click();
      el('sqlText').value = queries[qi] || '';
      sqlIsHandWritten = true;
      checkSql();
    }
    renderParams();

    if (!canWrite) {
      setStatus(isGlobal
        ? 'This is a central SILO report — it is shared by every company and cannot be edited here. '
          + 'Change it and save it as your own copy.'
        : 'This report belongs to someone else. You can run it and change it, but saving makes '
          + 'your own copy — theirs is untouched.', 'info', 12000);
    } else if (queries.length > 1) {
      setStatus(`This was saved from a chat answer with ${queries.length} queries. You are editing `
        + `query ${qi + 1}; saving replaces the report with that one query.`, 'info', 12000);
    }
    preview();
  }

  /** Columns tiles name that this report no longer returns. The concrete breakage. */
  function droppedColumns() {
    if (!editing?.usage || !lastRun) return [];
    const have = new Set(Object.keys((lastRun.rows || [])[0] || {}));
    // No rows means we cannot tell what it returns, so we claim nothing.
    if (!have.size) return [];
    return (editing.usage.referenced_columns || []).filter((c) => !have.has(c));
  }

  /** Parameters a dashboard still supplies that this edit would undeclare. */
  function droppedParameters() {
    if (!editing?.usage) return [];
    const now = new Set(declaredKeys());
    const supplied = new Set(editing.usage.supplied_parameters || []);
    return (editing.declaredKeys || []).filter((k) => !now.has(k) && supplied.has(k));
  }

  /**
   * What saving will do to everything else. Rendered into the save dialog.
   *
   * Warnings here are deliberately not blocking. Removing a column that a
   * tile draws is sometimes exactly the intent -- the tile is wrong, not the
   * report -- and a builder that refuses the edit just sends the person back
   * to saving a duplicate, which is the behaviour this whole change exists
   * to stop.
   */
  function renderImpact() {
    const box = el('impactPanel');
    // The size note belongs on a NEW report as much as an edit -- a first
    // save is exactly when an oversized report becomes everyone's problem --
    // so it is rendered before the edit-only impact block returns early.
    const size = sizeWarningHtml();
    if (!editing || !editing.canWrite) { box.innerHTML = size; return; }
    const u = editing.usage || { widget_count: 0, dashboard_count: 0, max_query_index: 0 };
    const n = u.widget_count || 0;
    const parts = [];
    if (size) parts.push(size);

    parts.push(n === 0
      ? '<div class="rb-impact">No dashboard uses this report yet — this edit affects nothing else.</div>'
      : `<div class="rb-impact"><strong>${n} tile${n === 1 ? '' : 's'}</strong> across `
        + `${u.dashboard_count} dashboard${u.dashboard_count === 1 ? '' : 's'} draw${n === 1 ? 's' : ''} `
        + 'this report. Saving changes every one of them.</div>');

    const dropped = droppedColumns();
    if (dropped.length) {
      parts.push(`<div class="rb-warn rb-warn--bad">Tiles reference `
        + `${dropped.map((c) => `<code>${esc(c)}</code>`).join(', ')}, which this version no longer `
        + `returns. Those tiles will render empty until someone re-points them.</div>`);
    }
    const lostParams = droppedParameters();
    if (lostParams.length) {
      parts.push(`<div class="rb-warn rb-warn--bad">A dashboard still supplies `
        + `${lostParams.map((c) => `<code>${esc(c)}</code>`).join(', ')}. Undeclaring a parameter a `
        + 'board sets leaves that slicer controlling nothing.</div>');
    }
    if ((u.max_query_index || 0) > 0 && editing.queryCount > 1) {
      parts.push(`<div class="rb-warn">A tile draws query #${u.max_query_index + 1} of this report. `
        + 'Saving writes a single-query report, so that tile will have nothing to draw.</div>');
    }
    box.innerHTML = parts.join('');
  }

  // ── Saving ───────────────────────────────────────────────────────────
  function openSave() {
    if (!lastRun) { setStatus('Preview it first — saving a report nobody has run is how a broken tile gets shared.', 'neg', 6000); return; }
    el('saveName').value = source && !el('saveName').value ? source.relname.replace(/_/g, ' ') : el('saveName').value;
    el('saveTitle').textContent = editing && editing.canWrite ? 'Save changes' : 'Save report';
    el('btnConfirmSave').textContent = editing && editing.canWrite ? 'Save changes' : 'Save';
    // The copy button is the way out of a read-only report, and the second
    // option on one you own -- "I meant to fork this" is a normal thing to
    // realise at the save step.
    el('btnSaveCopy').hidden = !editing;
    renderImpact();
    el('saveBackdrop').classList.add('open');
    el('saveName').focus();
    el('saveName').select();
  }

  /**
   * The report as it now stands, ready for insert or update.
   *
   * builder_config is written only when the guided tab actually produced the
   * SQL being saved. Storing it alongside hand-edited SQL would mean the
   * next edit reopens guided and regenerates a query that is not the one
   * this report runs -- scaffolding overwriting the building.
   */
  function reportPayload() {
    const declared = P.normalizeDeclarations(cfg.parameters);
    return {
      title: (el('saveName').value || '').trim(),
      description: (el('saveDesc').value || '').trim() || null,
      queries_run: [lastRun.sql],
      visibility: el('saveVis').value,
      columns_metadata: currentMetadata(lastRun.rows),
      parameters: declared.length ? declared : null,
      builder_config: (tab === 'build' && source && !sqlIsHandWritten)
        ? { relname: source.relname, cfg: JSON.parse(JSON.stringify(cfg)) }
        : null,
      // Null when the size genuinely could not be measured. Writing the page
      // size instead would record 1,000 for a 7,231-row report, and a wrong
      // number in the column that exists to catch wrong numbers is worse than
      // an empty one. The timestamp goes with it or neither means anything.
      row_estimate: knownTotal(),
      row_estimate_at: knownTotal() == null ? null : new Date().toISOString(),
    };
  }

  async function confirmSave() {
    if (editing && !editing.canWrite) return saveAsCopy();
    const payload = reportPayload();
    if (!payload.title) { el('saveName').focus(); return; }
    el('btnConfirmSave').disabled = true;

    if (editing) {
      // The TEMPLATE is saved, not the query that previewed. `source` is
      // deliberately not sent: the update policy's WITH CHECK pins it to
      // ask_silo/manual, and an Ask SILO report stays an Ask SILO report
      // when its owner corrects a label -- rewriting the provenance would
      // hide where the SQL came from.
      const { data, error } = await sb.from('silo_chat_saved_reports')
        .update(payload).eq('id', editing.id).select('id');
      el('btnConfirmSave').disabled = false;
      if (error) { setStatus('Could not save: ' + error.message, 'neg', 8000); return; }
      // No error and no row means RLS refused it rather than the request
      // failing -- the update matched nothing this user may write. Offer
      // the copy instead of leaving them at a button that does nothing.
      if (!data || !data.length) {
        editing.canWrite = false;
        el('btnSaveCopy').hidden = false;
        renderImpact();
        setStatus('You do not have permission to change this report — only its creator or an '
          + 'executive can. Save it as your own copy instead.', 'neg', 12000);
        return;
      }
      el('saveBackdrop').classList.remove('open');
      const n = editing.usage?.widget_count || 0;
      setStatus(`Saved. ${n ? `${n} tile${n === 1 ? '' : 's'} now draw${n === 1 ? 's' : ''} the updated report.`
        : 'No dashboard uses it yet.'}`, 'pos', 7000);
      el('btnSave').textContent = 'Saved ✓';
      el('statusBadge').textContent = 'Saved';
      el('statusBadge').className = 'bcn-pill bcn-pill--pos';
      setTimeout(() => { el('btnSave').textContent = 'Save changes'; }, 4000);
      window.__lastSavedReportId = editing.id;
      return;
    }

    const { data, error } = await sb.from('silo_chat_saved_reports').insert({
      // source='manual' has been allowed for clients since 20260828130000 --
      // company-scoped, never global. Nothing new was needed for this page.
      source: 'manual',
      question: null,
      answer: null,
      ...payload,
    }).select('id').single();
    el('btnConfirmSave').disabled = false;
    if (error) { setStatus('Could not save: ' + error.message, 'neg', 6000); return; }
    el('saveBackdrop').classList.remove('open');
    setStatus(`Saved "${payload.title}". It is now available to every dashboard.`, 'pos', 6000);
    el('btnSave').textContent = 'Saved ✓';
    el('statusBadge').textContent = 'Saved';
    el('statusBadge').className = 'bcn-pill bcn-pill--pos';
    setTimeout(() => { el('btnSave').textContent = 'Save report'; }, 4000);
    window.__lastSavedReportId = data.id;
  }

  /**
   * Fork rather than overwrite. The only path forward on a central `system`
   * definition or someone else's report, and always available on your own.
   *
   * The copy is a NEW report by this user, so it is `manual` regardless of
   * where the original came from -- a hand-edited fork of an Ask SILO answer
   * is not an Ask SILO answer, and claiming it was would misattribute the
   * SQL. Once saved the page becomes an editor for the copy, so the next
   * save updates it rather than minting a third.
   */
  async function saveAsCopy() {
    const payload = reportPayload();
    if (!payload.title) { el('saveName').focus(); return; }
    if (editing && payload.title === el('pageSub').textContent) payload.title += ' (copy)';
    el('btnSaveCopy').disabled = true;
    const { data, error } = await sb.from('silo_chat_saved_reports')
      .insert({ source: 'manual', question: null, answer: null, ...payload })
      .select('id').single();
    el('btnSaveCopy').disabled = false;
    if (error) { setStatus('Could not save the copy: ' + error.message, 'neg', 8000); return; }
    el('saveBackdrop').classList.remove('open');
    editing = { id: data.id, source: 'manual', createdBy: null, canWrite: true,
                usage: null, queryCount: 1, declaredKeys: declaredKeys() };
    el('pageTitle').textContent = 'Edit report';
    el('pageSub').textContent = payload.title;
    el('btnSave').textContent = 'Save changes';
    el('statusBadge').textContent = 'Saved';
    el('statusBadge').className = 'bcn-pill bcn-pill--pos';
    history.replaceState(null, '', `/v3/report-builder.html?id=${data.id}`);
    setStatus(`Saved "${payload.title}" as your own copy. The original is untouched.`, 'pos', 8000);
    window.__lastSavedReportId = data.id;
  }

  // ── Command / field search ───────────────────────────────────────────
  // Deterministic, not natural language: every candidate is a concrete
  // action this page can already take, matched by the same word-substring
  // scorer as the source rail (RB.fuzzyScore). Typing "revenue by creative"
  // finds "Group by Creative" because both words land somewhere in that
  // candidate's own text -- there is no model in this loop.
  function commandCandidates() {
    if (!source) return [];
    const cols = usableCols();
    const out = [];
    for (const c of cols) {
      const label = colLabel(c.name);
      if (cfg.summarise) {
        const has = cfg.dimensions.includes(c.name);
        out.push({
          text: [has ? `Remove ${label} from Group by` : `Group by ${label}`, c.name],
          run: () => { cfg.dimensions = has ? cfg.dimensions.filter((d) => d !== c.name) : cfg.dimensions.concat(c.name); renderBuild(); },
        });
        if (RB.NUMERIC_PG.test(c.type)) {
          const already = cfg.measures.some((m) => !RB.calcFor(m) && m.column === c.name && m.agg === 'sum');
          if (!already) out.push({
            text: [`Add total (sum) of ${label}`, c.name],
            run: () => { cfg.measures.push({ column: c.name, agg: 'sum', alias: '' }); renderBuild(); },
          });
        }
      } else {
        const has = cfg.columns.includes(c.name);
        out.push({
          text: [has ? `Hide column ${label}` : `Show column ${label}`, c.name],
          run: () => { cfg.columns = has ? cfg.columns.filter((x) => x !== c.name) : cfg.columns.concat(c.name); renderBuild(); },
        });
      }
      out.push({
        text: [`Filter by ${label}`, c.name],
        run: () => {
          cfg.filters.push({ column: c.name, op: 'eq', value: '' });
          renderBuild();
          document.querySelector('[data-tab="build"]').click();
          const last = el('paneBuild').querySelectorAll('[data-f-val], [data-f-col]');
          if (last.length) last[last.length - 1].focus();
        },
      });
    }
    out.push({ text: [cfg.summarise ? 'Turn off Summarise' : 'Turn on Summarise, group and total'],
      run: () => { cfg.summarise = !cfg.summarise; renderBuild(); } });
    out.push({ text: ['Add a calculation, one total divided by another, ROAS'], run: addCalc });
    out.push({ text: ['Add a parameter, turn a value into a dashboard control'], run: addParam });
    out.push({ text: ['Run the query, preview'], run: preview });
    if (lastRun && chartRecommendation(lastRun.rows, mapSemantics(currentMetadata(lastRun.rows)))) {
      out.push({ text: [showChart ? 'Switch to table only' : 'Switch to chart'],
        run: () => { showChart = !showChart; renderPreviewChart(lastRun.rows); } });
    }
    return out;
  }

  let cmdActive = -1;
  function renderCommandResults(query) {
    const box = el('cmdResults');
    if (!box) return;
    const q = query.trim();
    if (!q) { box.hidden = true; box.innerHTML = ''; cmdActive = -1; return; }
    const scored = commandCandidates()
      .map((c) => ({ c, score: RB.fuzzyScore(q, c.text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (!scored.length) {
      box.innerHTML = '<div class="rb-cmd-empty">No matching field or action.</div>';
      box.hidden = false;
      cmdActive = -1;
      return;
    }
    box.innerHTML = scored.map((x, i) => `
      <button type="button" class="rb-cmd-result${i === 0 ? ' is-active' : ''}" data-cmd="${i}">
        ${esc(x.c.text[0])}
      </button>`).join('');
    box._commands = scored.map((x) => x.c);
    box.hidden = false;
    cmdActive = 0;
  }

  function runCommand(box, i) {
    const cmds = box._commands || [];
    const cmd = cmds[i];
    if (!cmd) return;
    cmd.run();
    el('cmdSearch').value = '';
    box.hidden = true;
    box.innerHTML = '';
  }

  el('cmdSearch')?.addEventListener('input', (e) => renderCommandResults(e.target.value));
  el('cmdSearch')?.addEventListener('focus', (e) => { if (e.target.value.trim()) renderCommandResults(e.target.value); });
  el('cmdSearch')?.addEventListener('keydown', (e) => {
    const box = el('cmdResults');
    if (!box || box.hidden) return;
    const items = box.querySelectorAll('[data-cmd]');
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdActive = Math.min(cmdActive + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdActive = Math.max(cmdActive - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); runCommand(box, cmdActive); return; }
    else if (e.key === 'Escape') { box.hidden = true; return; }
    else return;
    items.forEach((n, i) => n.classList.toggle('is-active', i === cmdActive));
  });
  el('cmdResults')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b) runCommand(el('cmdResults'), Number(b.dataset.cmd));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.rb-cmd')) { const box = el('cmdResults'); if (box) box.hidden = true; }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); el('cmdSearch')?.focus(); }
  });

  // ── Rail collapse ────────────────────────────────────────────────────
  el('btnToggleRail')?.addEventListener('click', () => {
    const rail = document.querySelector('.rb-rail');
    const open = rail.classList.toggle('is-collapsed') === false;
    el('btnToggleRail').setAttribute('aria-expanded', String(open));
  });

  // ── Wiring ───────────────────────────────────────────────────────────
  el('srcSearch').addEventListener('input', renderSourceList);
  el('srcList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rel]');
    if (!b) return;
    if (tab === 'sql') {
      // In the SQL tab a click inserts the name at the caret rather than
      // wiping what you have typed.
      const ta = el('sqlText');
      const at = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, at) + b.dataset.rel + ta.value.slice(ta.selectionEnd ?? at);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = at + b.dataset.rel.length;
      source = catalog.find((r) => r.relname === b.dataset.rel) || source;
      renderSourceList();
      checkSql();
      return;
    }
    selectSource(b.dataset.rel);
  });

  document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
    tab = btn.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('bcn-tab--active', b === btn));
    el('paneBuild').hidden = tab !== 'build';
    el('paneSql').hidden = tab !== 'sql';
    // Carry the guided query across, so "Build then tweak" works.
    if (tab === 'sql' && source && !el('sqlText').value.trim()) {
      el('sqlText').value = RB.buildSql(source, cfg) || '';
      checkSql();
    }
    markStale();
  }));

  function checkSql() {
    const warn = RB.checkRawSqlScope(el('sqlText').value, catalog);
    el('sqlWarn').innerHTML = warn ? `<div class="rb-warn">${esc(warn)}</div>` : '';
    // A {{token}} typed into the SQL has to be reconciled against the
    // declarations as it is typed, or the mismatch is only discovered at
    // Preview -- by which point the person has moved on from the token.
    checkParams();
  }
  el('sqlText').addEventListener('input', () => {
    // The moment the SQL stops matching what the guided config generates,
    // builder_config is stale scaffolding and must not be saved -- otherwise
    // the next edit reopens guided and regenerates a query this report does
    // not run. Compared rather than assumed, so clicking into the tab and
    // clicking back out does not count as hand-writing.
    sqlIsHandWritten = !source || el('sqlText').value.trim() !== (RB.buildSql(source, cfg) || '').trim();
    checkSql();
    markStale();
  });

  // ── Parameters wiring ────────────────────────────────────────────────
  // Named so the chip bar's own "+" button can trigger exactly this, rather
  // than duplicating what a fresh parameter defaults to.
  function addParam() {
    // Defaults chosen so a fresh parameter is immediately valid and
    // immediately useful: a rolling date is what nearly every report wants.
    cfg.parameters.push({ key: '', label: '', type: 'date', default: 'today', options: [] });
    renderParams();
    const inputs = el('paramList').querySelectorAll('[data-p="key"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }
  el('btnAddParam').addEventListener('click', addParam);

  el('paramList').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.p === undefined) return;
    const p = cfg.parameters[Number(t.dataset.i)];
    if (!p) return;
    if (t.dataset.p === 'options') {
      p.options = t.value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (t.dataset.p === 'key') {
      // Keys are snake_case identifiers, so the field enforces that rather
      // than letting a space or a capital become a token that never matches.
      p.key = t.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (p.key !== t.value) t.value = p.key;
    } else {
      p[t.dataset.p] = t.value;
    }
    // Text inputs re-check without a full re-render, so the caret stays put.
    checkParams();
    if (tab === 'build' && source) renderBuild();
  });

  el('paramList').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.paramPreset !== undefined) {
      // The friendly date control writes into the same `default` field the
      // advanced editor shows -- one value, two ways to set it, never two
      // sources of truth. "Specific date…" just reveals the date input
      // below it rather than writing anything yet.
      const p = cfg.parameters[Number(t.dataset.paramPreset)];
      if (!p) return;
      if (t.value !== '__custom') p.default = t.value;
      renderParams();
      if (t.value === '__custom') {
        const input = el('paramList').querySelector(`[data-param-date="${t.dataset.paramPreset}"]`);
        if (input) input.focus();
      }
      return;
    }
    if (t.dataset.paramDate !== undefined) {
      const p = cfg.parameters[Number(t.dataset.paramDate)];
      if (p && t.value) { p.default = t.value; renderParams(); }
      return;
    }
    if (t.dataset.p !== 'type') return;
    const p = cfg.parameters[Number(t.dataset.i)];
    if (!p) return;
    p.type = t.value;
    // Switching to/from enum adds or removes the choices field, and the
    // old default rarely survives a type change, so this one re-renders.
    if (p.type === 'enum' && !(p.options || []).length) p.options = [];
    if (p.type === 'date' && !p.default) p.default = 'today';
    renderParams();
  });

  el('paramList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove-param]');
    if (!b) return;
    cfg.parameters.splice(Number(b.dataset.removeParam), 1);
    renderParams();
    if (tab === 'build' && source) renderBuild();
  });

  el('buildBody').addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'chkSummarise') {
      // No default total. The first numeric column in a table's own column
      // order is an accident of how it was built, not a deliberate choice --
      // it summed retail_price (a per-unit price) across every SKU row on
      // inventory_on_hand_current_v the moment Summarise was ticked, before
      // anyone asked for a total of anything. "+ Add a total" is one click
      // away and already the only way to add a SECOND one.
      cfg.summarise = t.checked;
    }
    else if (t.id === 'selDateCol') cfg.dateColumn = t.value;
    else if (t.id === 'selDateRange') cfg.dateRange = t.value;
    else if (t.id === 'selSort') cfg.sortColumn = t.value;
    else if (t.id === 'selSortDir') cfg.sortDir = t.value;
    else if (t.dataset.mAgg !== undefined) cfg.measures[+t.dataset.mAgg].agg = t.value;
    else if (t.dataset.mCol !== undefined) cfg.measures[+t.dataset.mCol].column = t.value;
    else if (t.dataset.mCalc !== undefined) cfg.measures[+t.dataset.mCalc].calc = t.value;
    else if (t.dataset.mAgg2 !== undefined) cfg.measures[+t.dataset.mAgg2].agg2 = t.value;
    else if (t.dataset.mCol2 !== undefined) cfg.measures[+t.dataset.mCol2].column2 = t.value;
    else if (t.dataset.fCol !== undefined) cfg.filters[+t.dataset.fCol].column = t.value;
    else if (t.dataset.fOp !== undefined) cfg.filters[+t.dataset.fOp].op = t.value;
    else return;
    renderBuild();
  });

  el('buildBody').addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'inpLimit') cfg.limit = Math.max(0, Math.min(1000, Number(t.value) || 0));
    else if (t.dataset.mAlias !== undefined) cfg.measures[+t.dataset.mAlias].alias = t.value;
    else if (t.dataset.fVal !== undefined) cfg.filters[+t.dataset.fVal].value = t.value;
    else return;
    // Refresh only the generated SQL and the chip readout: a full re-render
    // would steal focus mid-type, but the chips are separate elements and
    // updating them costs nothing a typing cursor can notice.
    const gen = el('genSql');
    if (gen) gen.textContent = RB.buildSql(source, cfg) || '-- choose at least one total to summarise';
    renderChipBar();
    markStale();
  });

  // Named for the same reason addParam is: the chip bar's "+ Add a total" /
  // "+ Add a filter" buttons call these directly rather than re-deriving
  // what a fresh row defaults to.
  function addFilter() {
    cfg.filters.push({ column: '', op: 'eq', value: '' });
    // Force the editor open even though the list is no longer empty --
    // otherwise the row that was just added renders and immediately
    // collapses out of sight, which reads as the click having done nothing.
    secManualOpen.add('secFilters');
    renderBuild();
  }
  function addMeasure() {
    const n = numericCols()[0];
    cfg.measures.push({ column: n ? n.name : '', agg: 'sum', alias: '' });
    secManualOpen.add('secMeasures');
    renderBuild();
  }
  function addCalc() {
    // Seed with two DIFFERENT columns where possible: a ratio of a column
    // to itself is always 1, which reads as a broken feature.
    const nums = numericCols();
    cfg.measures.push({
      calc: 'ratio', agg: 'sum', column: nums[0] ? nums[0].name : '',
      agg2: 'sum', column2: (nums[1] || nums[0] || {}).name || '', alias: '',
    });
    secManualOpen.add('secMeasures');
    renderBuild();
  }

  // #btnToggleCols now lives in the field browser (renderFieldBrowser's own
  // listener handles it) -- everything else here is still #buildBody's.
  el('buildBody').addEventListener('click', (e) => {
    if (e.target.closest('#btnAddFilter')) { addFilter(); return; }
    if (e.target.closest('#btnAddMeasure')) { addMeasure(); return; }
    if (e.target.closest('#btnAddCalc')) { addCalc(); return; }
    const fd = e.target.closest('[data-f-del]');
    if (fd) { cfg.filters.splice(+fd.dataset.fDel, 1); renderBuild(); return; }
    const md = e.target.closest('[data-m-del]');
    if (md) { cfg.measures.splice(+md.dataset.mDel, 1); renderBuild(); }
  });

  el('btnPreview').addEventListener('click', preview);
  // The dock's own Run button is the same action under a different label --
  // one engine, one button behind both, so Preview and Run can never drift
  // into running something different from what is on screen.
  el('btnRunQuery')?.addEventListener('click', preview);
  el('btnPreviewMode')?.addEventListener('click', () => {
    if (!lastRun) return;
    showChart = !showChart;
    renderPreviewChart(lastRun.rows);
  });
  // Delegated: the button is injected into previewBody's innerHTML fresh on
  // every render, so a direct listener would be thrown away with it.
  el('previewBody').addEventListener('click', (e) => {
    if (e.target.closest('#btnLoadMorePreview')) loadMorePreview();
  });
  el('btnSave').addEventListener('click', openSave);
  el('btnConfirmSave').addEventListener('click', confirmSave);
  el('btnSaveCopy').addEventListener('click', saveAsCopy);
  el('btnCancelSave').addEventListener('click', () => el('saveBackdrop').classList.remove('open'));
  el('btnCloseSave').addEventListener('click', () => el('saveBackdrop').classList.remove('open'));
  el('saveBackdrop').addEventListener('click', (e) => { if (e.target.id === 'saveBackdrop') el('saveBackdrop').classList.remove('open'); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el('saveBackdrop').classList.remove('open');
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); preview(); }
  });

  // ── Boot ─────────────────────────────────────────────────────────────
  (async function boot() {
    const sess = await sb.auth.getSession();
    if (!sess?.data?.session) { window.location.href = '/pages/login.html'; return; }
    const user = sess.data.session.user;
    await window.__SILO_CONFIG__?.ensureActiveCompany?.(sb);
    const { data: profile } = await sb.from('profiles').select('name, email, role').eq('id', user.id).single();
    if (window.SiloChrome) {
      window.SiloChrome.mount({
        appEl: '#silo-app', active: 'reports/builder',
        user: { email: profile?.email || user.email, role: profile?.role },
        crumbs: ['Reports', 'Report builder'], supabaseClient: sb,
      });
    }

    // reportable, not is_hidden. is_hidden means "keep this out of Ask
    // SILO's model index"; this means "this is a commercial reporting
    // surface". Ask SILO still needs payroll and comp tables to answer
    // headcount questions -- the workbench does not. It is an allowlist, so
    // a newly synced table stays out until someone opts it in.
    const { data, error } = await sb.from('silo_chat_schema_catalog')
      .select('relname, relkind, columns, description, report_priority')
      .eq('reportable', true)
      .order('relname');
    if (error) { setStatus('Could not load the schema catalog: ' + error.message, 'neg'); return; }
    catalog = (data || []).filter((r) => (r.columns || []).length);
    renderSourceList();
    renderParams();
    setStatus(`${catalog.length} sales, product, inventory and marketing sources available.`, 'info', 5000);

    const params = new URLSearchParams(location.search);

    // ?id= opens an existing report for editing. It comes first: a report
    // brings its own source, SQL and parameters, and letting ?source= or
    // ?sql= also run would half-overwrite what was just loaded.
    const editId = params.get('id');
    if (editId) {
      if (window.SiloChrome) el('pageSub').textContent = 'Loading…';
      await loadForEdit(editId, user, profile);
      return;
    }

    const want = params.get('source');
    if (want && catalog.some((r) => r.relname === want)) selectSource(want);

    // Arrived from a saved report's query picker: open that query in the SQL
    // tab so a multi-query chat answer can be cut down to the one useful
    // query, tidied, and saved as a clean single-query report.
    const seedSql = params.get('sql');
    if (seedSql) {
      document.querySelector('[data-tab="sql"]').click();
      el('sqlText').value = seedSql;
      checkSql();
      const from = params.get('from');
      setStatus(from
        ? `Opened a query from "${from}". Tidy it up and save it as its own report.`
        : 'Query loaded — preview it, then save it as its own report.', 'info', 8000);
      preview();
    }
  })().catch((err) => setStatus('Something went wrong: ' + err.message, 'neg'));

  window.__siloReportBuilder = { get cfg() { return cfg; }, get source() { return source; },
                                get lastRun() { return lastRun; }, get catalog() { return catalog; },
                                get editing() { return editing; },
                                preview, renderParams, checkParams, currentSql,
                                reportPayload, renderImpact, droppedColumns, droppedParameters };
})();
