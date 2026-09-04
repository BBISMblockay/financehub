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
  const cfg = {
    columns: [], summarise: false, dimensions: [], measures: [],
    dateColumn: '', dateRange: '', filters: [], sortColumn: '', sortDir: 'desc', limit: 100,
    // [{key, type, label, default, options}] — declared here, substituted at
    // run time by v3/js/report-params.js. Lives on cfg (not on `source`) so
    // it survives switching tables and applies to the SQL tab too.
    parameters: [],
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
        <div class="rb-row">
          <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddMeasure">+ Add a total</button>
          <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddCalc">+ Add a calculation</button>
        </div>
        <p class="rb-note">A calculation is one total over another — ROAS is sales ÷ spend, and no column holds it.
          Division is guarded, so a zero denominator leaves the cell empty rather than failing the query.</p>
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
            <input class="bcn-field bcn-field--mono" id="inpLimit" type="number" min="0" max="1000" value="${Number(cfg.limit) || 0}" />
          </div>
        </div>
      </div>

      <div class="rb-section">
        <span class="rb-section-title">Generated SQL</span>
        <pre class="rb-generated" id="genSql">${esc(RB.buildSql(source, cfg) || '-- choose at least one total to summarise')}</pre>
      </div>`;
  }

  // ── Parameters ───────────────────────────────────────────────────────
  const P = window.SiloReportParams;

  function renderParams() {
    const rows = cfg.parameters.map((p, i) => {
      const isEnum = p.type === 'enum';
      return `<div class="rb-param" data-param-row="${i}">
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
            <input class="bcn-field bcn-field--mono" data-p="default" data-i="${i}"
                   value="${esc(p.default || '')}"
                   placeholder="${p.type === 'date' ? 'today-27d' : ''}" />
          </div>
          <button type="button" class="dw-icon-btn" data-remove-param="${i}"
                  title="Remove this parameter" aria-label="Remove this parameter">✕</button>
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

  /** Re-render the preview table + meta line from lastRun's accumulated rows. */
  function renderPreview(ms, opts) {
    const rows = lastRun.rows;
    const usedParams = P.tokensIn(lastRun.sql).length;
    const hasMore = rows.length > 0 && rows.length % PAGE_CAP === 0 && !(opts && opts.exhausted);
    el('previewMeta').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}`
      + (ms != null ? ` · ${ms}ms` : '')
      + (usedParams ? ` · ran with default ${usedParams === 1 ? 'parameter' : 'parameters'}` : '');
    el('previewBody').innerHTML = rows.length
      ? window.SiloChart.tableHtml(rows, { limit: 50 }, mapSemantics(currentMetadata(rows)))
        + (hasMore
            ? `<div class="rb-preview-more">
                 <button type="button" class="bcn-btn bcn-btn--ghost" id="btnLoadMorePreview">Load next ${PAGE_CAP} rows</button>
                 <span class="rb-note">Fetched in pages of ${PAGE_CAP} — each page is its own query against live data.</span>
               </div>`
            : '')
      : '<div class="dw-empty">Ran fine — 0 rows.</div>';
  }

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

    el('previewBody').innerHTML = '<div class="dw-loading">Running…</div>';
    el('previewMeta').textContent = '';
    const t0 = performance.now();
    const { data, error } = await sb.rpc('chat_run_readonly_query', { query: resolved.sql, p_offset: 0 });
    const ms = Math.round(performance.now() - t0);
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
    lastRun = { sql, resolvedSql: resolved.sql, rows };
    renderPreview(ms);
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
    if (!editing || !editing.canWrite) { box.innerHTML = ''; return; }
    const u = editing.usage || { widget_count: 0, dashboard_count: 0, max_query_index: 0 };
    const n = u.widget_count || 0;
    const parts = [];

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
    history.replaceState(null, '', `/v3/report-builder.html?id=${data.id}`);
    setStatus(`Saved "${payload.title}" as your own copy. The original is untouched.`, 'pos', 8000);
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
  });

  // ── Parameters wiring ────────────────────────────────────────────────
  el('btnAddParam').addEventListener('click', () => {
    // Defaults chosen so a fresh parameter is immediately valid and
    // immediately useful: a rolling date is what nearly every report wants.
    cfg.parameters.push({ key: '', label: '', type: 'date', default: 'today', options: [] });
    renderParams();
    const inputs = el('paramList').querySelectorAll('[data-p="key"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

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
    if (e.target.closest('#btnAddCalc')) {
      // Seed with two DIFFERENT columns where possible: a ratio of a column
      // to itself is always 1, which reads as a broken feature.
      const nums = numericCols();
      cfg.measures.push({
        calc: 'ratio', agg: 'sum', column: nums[0] ? nums[0].name : '',
        agg2: 'sum', column2: (nums[1] || nums[0] || {}).name || '', alias: '',
      });
      renderBuild();
      return;
    }
    const fd = e.target.closest('[data-f-del]');
    if (fd) { cfg.filters.splice(+fd.dataset.fDel, 1); renderBuild(); return; }
    const md = e.target.closest('[data-m-del]');
    if (md) { cfg.measures.splice(+md.dataset.mDel, 1); renderBuild(); }
  });

  el('btnPreview').addEventListener('click', preview);
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
