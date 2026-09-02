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
  let lastRun = null;        // { sql, rows }
  const cfg = {
    columns: [], summarise: false, dimensions: [], measures: [],
    dateColumn: '', dateRange: '', filters: [], sortColumn: '', sortDir: 'desc', limit: 100,
  };

  // ── Source rail ──────────────────────────────────────────────────────
  function renderSourceList() {
    const q = (el('srcSearch').value || '').trim().toLowerCase();
    const match = (r) => !q || r.relname.toLowerCase().includes(q)
      || String(r.description || '').toLowerCase().includes(q);
    const visible = catalog.filter(match);
    if (!visible.length) {
      el('srcList').innerHTML = `<div class="v3-empty">Nothing matches “${esc(q)}”.</div>`;
      return;
    }
    const card = (r) => `
        <button type="button" class="rb-src${source && source.relname === r.relname ? ' is-active' : ''}"
                data-rel="${esc(r.relname)}">
          <span class="rb-src-name">${esc(r.relname)}</span>
          ${r.description ? `<span class="rb-src-desc">${esc(r.description)}</span>` : ''}
          <span class="rb-src-kind">${esc(r.relkind)} · ${window.SiloReportBuilder.businessColumns(r.columns).length} cols</span>
        </button>`;
    const section = (label, rows) => rows.length
      ? `<div class="rb-group-label">${label} · ${rows.length}</div>` + rows.map(card).join('')
      : '';

    // "Start here" first. Eight sales rollups alphabetised together is a
    // choice nobody can make; these are the ones whose own descriptions say
    // to prefer them. Everything else is still listed below and searchable.
    const starred = visible.filter((r) => r.report_priority === 1);
    const rest = visible.filter((r) => r.report_priority !== 1);
    const byKind = (kind) => rest.filter((r) => r.relkind === kind);

    el('srcList').innerHTML =
      section('Start here', starred)
      + section('More views', byKind('view'))
      + section('Tables', byKind('table'))
      + section('Materialized', byKind('matview'))
      + `<div class="rb-rail-foot">Sales, product, inventory, marketing, launches and purchasing.
           Finance and HR tables are deliberately not offered here.</div>`;
  }

  function selectSource(relname) {
    source = catalog.find((r) => r.relname === relname) || null;
    cfg.columns = []; cfg.dimensions = []; cfg.measures = [];
    cfg.dateColumn = ''; cfg.dateRange = ''; cfg.filters = [];
    cfg.sortColumn = ''; cfg.summarise = false;
    const dateCol = usableCols().find((c) => RB.DATEISH_PG.test(c.type));
    if (dateCol) { cfg.dateColumn = dateCol.name; cfg.dateRange = '30'; }
    // Pre-select the business columns rather than emitting `select *`: the
    // point of hiding plumbing is that the PREVIEW stops being full of ids.
    cfg.columns = RB.businessColumns(source.columns).map((c) => c.name);
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

  function opts(list, sel, blank) {
    return (blank ? `<option value="">${esc(blank)}</option>` : '')
      + list.map((c) => `<option value="${esc(c.name || c)}"${(c.name || c) === sel ? ' selected' : ''}>${esc(c.name || c)}</option>`).join('');
  }

  function renderBuild() {
    if (!source) return;
    const cols = usableCols();
    const aliasList = cfg.measures.map((m) => m.alias || `${m.agg}_${m.column}`);

    const colChips = cols.map((c) => `
      <label class="rb-col${cfg.columns.includes(c.name) ? ' is-on' : ''}">
        <input type="checkbox" data-col="${esc(c.name)}" ${cfg.columns.includes(c.name) ? 'checked' : ''} />
        ${esc(c.name)}<span class="rb-col-type">${esc(c.type)}</span>
      </label>`).join('');

    const dimChips = cols.map((c) => `
      <label class="rb-col${cfg.dimensions.includes(c.name) ? ' is-on' : ''}">
        <input type="checkbox" data-dim="${esc(c.name)}" ${cfg.dimensions.includes(c.name) ? 'checked' : ''} />
        ${esc(c.name)}<span class="rb-col-type">${esc(c.type)}</span>
      </label>`).join('');

    const measureRows = cfg.measures.map((m, i) => `
      <div class="rb-rule">
        <select class="bcn-field" data-m-agg="${i}">${opts(RB.AGGREGATES, m.agg)}</select>
        <span class="rb-note">of</span>
        <select class="bcn-field" data-m-col="${i}">${opts(numericCols(), m.column)}</select>
        <span class="rb-note">as</span>
        <input class="bcn-field bcn-field--mono" data-m-alias="${i}" value="${esc(m.alias || '')}"
               placeholder="${esc(m.agg + '_' + m.column)}" />
        <button type="button" class="rb-x" data-m-del="${i}" aria-label="Remove">✕</button>
      </div>`).join('');

    const filterRows = cfg.filters.map((f, i) => {
      const op = RB.OPERATORS.find((o) => o.id === f.op) || RB.OPERATORS[0];
      return `
      <div class="rb-rule">
        <select class="bcn-field" data-f-col="${i}">${opts(cols, f.column, 'Column…')}</select>
        <select class="bcn-field" data-f-op="${i}">
          ${RB.OPERATORS.map((o) => `<option value="${o.id}"${o.id === f.op ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        ${op.noValue ? '' : `<input class="bcn-field" data-f-val="${i}" value="${esc(f.value || '')}" placeholder="value" />`}
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

    el('buildBody').innerHTML = `
      ${mvNote}
      <div class="rb-section">
        <span class="rb-section-title">${esc(source.relname)}${source.description ? '' : ''}</span>
        ${source.description ? `<p class="rb-note">${esc(source.description)}</p>` : ''}
      </div>

      <div class="rb-section">
        <label class="rb-col" style="align-self:flex-start">
          <input type="checkbox" id="chkSummarise" ${cfg.summarise ? 'checked' : ''} />
          Summarise (group and total) ${cfg.summarise ? '· on' : '· off'}
        </label>
      </div>

      ${cfg.summarise ? `
      <div class="rb-section">
        <span class="rb-section-title">Group by</span>
        <div class="rb-cols">${dimChips}</div>
      </div>
      <div class="rb-section">
        <span class="rb-section-title">Totals</span>
        ${measureRows || '<p class="rb-note">No totals yet — add one.</p>'}
        <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddMeasure" style="align-self:flex-start">+ Add a total</button>
      </div>` : `
      <div class="rb-section">
        <span class="rb-section-title">Columns · ${cfg.columns.length ? cfg.columns.length + ' selected' : 'all'}</span>
        <div class="rb-cols">${colChips}</div>
        ${hiddenCount() ? `<button type="button" class="rb-linkbtn" id="btnToggleCols">
            ${showAllColumns
              ? `Hide ${hiddenCount()} technical column${hiddenCount() === 1 ? '' : 's'}`
              : `Show ${hiddenCount()} technical column${hiddenCount() === 1 ? '' : 's'} (ids, sync stamps)`}
          </button>` : ''}
      </div>`}

      ${dateCols().length ? `
      <div class="rb-section">
        <span class="rb-section-title">Date range</span>
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
      </div>` : ''}

      <div class="rb-section">
        <span class="rb-section-title">Filters</span>
        ${filterRows || '<p class="rb-note">No filters.</p>'}
        <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddFilter" style="align-self:flex-start">+ Add a filter</button>
      </div>

      <div class="rb-section">
        <span class="rb-section-title">Sort and limit</span>
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
            <input class="bcn-field bcn-field--mono" id="inpLimit" type="number" min="0" max="500" value="${Number(cfg.limit) || 0}" />
          </div>
        </div>
      </div>

      <div class="rb-section">
        <span class="rb-section-title">Generated SQL</span>
        <pre class="rb-generated" id="genSql">${esc(RB.buildSql(source, cfg) || '-- choose at least one total to summarise')}</pre>
      </div>`;
  }

  // ── Running ──────────────────────────────────────────────────────────
  function currentSql() {
    if (tab === 'sql') return (el('sqlText').value || '').trim();
    return source ? RB.buildSql(source, cfg) : null;
  }

  async function preview() {
    const sql = currentSql();
    if (!sql) { setStatus('Nothing to run yet — pick a source, or type some SQL.', 'neg', 4000); return; }
    el('previewBody').innerHTML = '<div class="dw-loading">Running…</div>';
    el('previewMeta').textContent = '';
    const t0 = performance.now();
    const { data, error } = await sb.rpc('chat_run_readonly_query', { query: sql });
    const ms = Math.round(performance.now() - t0);
    if (error) {
      lastRun = null;
      el('previewBody').innerHTML = `<div class="dw-empty dw-empty--error"><strong>Query failed.</strong> ${esc(error.message)}</div>`;
      el('previewMeta').textContent = `failed in ${ms}ms`;
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    lastRun = { sql, rows };
    el('previewMeta').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} · ${ms}ms`
      + (rows.length >= 500 ? ' · hit the 500-row cap' : '');
    el('previewBody').innerHTML = rows.length
      ? window.SiloChart.tableHtml(rows, { limit: 50 },
          source ? mapSemantics(RB.metadataFromCatalog(source, sql, rows)) : null)
      : '<div class="dw-empty">Ran fine — 0 rows.</div>';
  }

  // metadataFromCatalog returns {col:{semantic}}; the adapter wants {col:semantic}.
  function mapSemantics(md) {
    if (!md) return null;
    const out = {};
    for (const [k, v] of Object.entries(md)) out[k] = v.semantic;
    return out;
  }

  // ── Saving ───────────────────────────────────────────────────────────
  function openSave() {
    if (!lastRun) { setStatus('Preview it first — saving a report nobody has run is how a broken tile gets shared.', 'neg', 6000); return; }
    el('saveName').value = source && !el('saveName').value ? source.relname.replace(/_/g, ' ') : el('saveName').value;
    el('saveBackdrop').classList.add('open');
    el('saveName').focus();
    el('saveName').select();
  }

  async function confirmSave() {
    const title = (el('saveName').value || '').trim();
    if (!title) { el('saveName').focus(); return; }
    el('btnConfirmSave').disabled = true;
    const md = source ? RB.metadataFromCatalog(source, lastRun.sql, lastRun.rows) : null;
    const { data, error } = await sb.from('silo_chat_saved_reports').insert({
      // source='manual' has been allowed for clients since 20260828130000 --
      // company-scoped, never global. Nothing new was needed for this page.
      source: 'manual',
      title,
      description: (el('saveDesc').value || '').trim() || null,
      question: null,
      answer: null,
      queries_run: [lastRun.sql],
      visibility: el('saveVis').value,
      columns_metadata: md,
    }).select('id').single();
    el('btnConfirmSave').disabled = false;
    if (error) { setStatus('Could not save: ' + error.message, 'neg', 6000); return; }
    el('saveBackdrop').classList.remove('open');
    setStatus(`Saved "${title}". It is now available to every dashboard.`, 'pos', 6000);
    el('btnSave').textContent = 'Saved ✓';
    setTimeout(() => { el('btnSave').textContent = 'Save report'; }, 4000);
    window.__lastSavedReportId = data.id;
  }

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
  }));

  function checkSql() {
    const warn = RB.checkRawSqlScope(el('sqlText').value, catalog);
    el('sqlWarn').innerHTML = warn ? `<div class="rb-warn">${esc(warn)}</div>` : '';
  }
  el('sqlText').addEventListener('input', checkSql);

  el('buildBody').addEventListener('change', (e) => {
    const t = e.target;
    const toggle = (arr, v) => arr.includes(v) ? arr.filter((x) => x !== v) : arr.concat(v);
    if (t.dataset.col !== undefined) cfg.columns = toggle(cfg.columns, t.dataset.col);
    else if (t.dataset.dim !== undefined) cfg.dimensions = toggle(cfg.dimensions, t.dataset.dim);
    else if (t.id === 'chkSummarise') {
      cfg.summarise = t.checked;
      if (cfg.summarise && !cfg.measures.length) {
        const n = numericCols()[0];
        if (n) cfg.measures = [{ column: n.name, agg: 'sum', alias: '' }];
      }
    }
    else if (t.id === 'selDateCol') cfg.dateColumn = t.value;
    else if (t.id === 'selDateRange') cfg.dateRange = t.value;
    else if (t.id === 'selSort') cfg.sortColumn = t.value;
    else if (t.id === 'selSortDir') cfg.sortDir = t.value;
    else if (t.dataset.mAgg !== undefined) cfg.measures[+t.dataset.mAgg].agg = t.value;
    else if (t.dataset.mCol !== undefined) cfg.measures[+t.dataset.mCol].column = t.value;
    else if (t.dataset.fCol !== undefined) cfg.filters[+t.dataset.fCol].column = t.value;
    else if (t.dataset.fOp !== undefined) cfg.filters[+t.dataset.fOp].op = t.value;
    else return;
    renderBuild();
  });

  el('buildBody').addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'inpLimit') cfg.limit = Math.max(0, Math.min(500, Number(t.value) || 0));
    else if (t.dataset.mAlias !== undefined) cfg.measures[+t.dataset.mAlias].alias = t.value;
    else if (t.dataset.fVal !== undefined) cfg.filters[+t.dataset.fVal].value = t.value;
    else return;
    // Refresh only the generated SQL: re-rendering would steal focus mid-type.
    const gen = el('genSql');
    if (gen) gen.textContent = RB.buildSql(source, cfg) || '-- choose at least one total to summarise';
  });

  el('buildBody').addEventListener('click', (e) => {
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
    if (e.target.closest('#btnAddFilter')) {
      cfg.filters.push({ column: '', op: 'eq', value: '' }); renderBuild(); return;
    }
    if (e.target.closest('#btnAddMeasure')) {
      const n = numericCols()[0];
      cfg.measures.push({ column: n ? n.name : '', agg: 'sum', alias: '' }); renderBuild(); return;
    }
    const fd = e.target.closest('[data-f-del]');
    if (fd) { cfg.filters.splice(+fd.dataset.fDel, 1); renderBuild(); return; }
    const md = e.target.closest('[data-m-del]');
    if (md) { cfg.measures.splice(+md.dataset.mDel, 1); renderBuild(); }
  });

  el('btnPreview').addEventListener('click', preview);
  el('btnSave').addEventListener('click', openSave);
  el('btnConfirmSave').addEventListener('click', confirmSave);
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
        appEl: '#silo-app', active: 'reports/dashboards',
        user: { email: profile?.email || user.email, role: profile?.role },
        crumbs: ['Reports', 'New report'], supabaseClient: sb,
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
    setStatus(`${catalog.length} sales, product, inventory and marketing sources available.`, 'info', 5000);

    const params = new URLSearchParams(location.search);
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
                                get lastRun() { return lastRun; }, get catalog() { return catalog; }, preview };
})();
