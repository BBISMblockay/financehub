/* ==========================================================================
   SILO v3 — dashboard builder
   --------------------------------------------------------------------------
   Edit mode. Layers interaction on top of SiloDashboardRenderer; it never
   draws a widget itself, so view mode and edit mode can never drift apart.

   Editing is buffered, not live: adding, configuring and removing widgets
   change local state and mark the dashboard dirty, and one Save writes the
   whole set. Widget ids are minted client-side (crypto.randomUUID) precisely
   so that buffered set can go back as a single upsert keyed on ids that
   already exist locally -- no insert-then-collect-ids round trip, and a
   re-Save after a failure is idempotent rather than duplicating tiles.
   ========================================================================== */
(function (global) {
  'use strict';

  const esc = (s) => window.SiloChart.esc(s);
  const el = (id) => document.getElementById(id);

  // How each authoring surface is named in the picker. The renderer never
  // branches on these -- they are labels, not behaviour.
  const SOURCE_LABEL = { ask_silo: 'Ask SILO', system: 'SILO report', manual: 'Manual' };

  // A system/manual report has a description; an Ask SILO save has the
  // question that produced it. Same slot, different provenance.
  const reportSubtitle = (r) => r.description || r.question || '';

  // A system definition is global (company_entity_id null) and reusable
  // across tenants, so "Company"/"Only you" would be a lie for it.
  function scopePill(r) {
    if (r.source === 'system' || r.company_entity_id == null) {
      return '<span class="bcn-pill bcn-pill--accent">Global</span>';
    }
    return `<span class="bcn-pill${r.visibility === 'private' ? '' : ' bcn-pill--accent'}">${r.visibility === 'private' ? 'Only you' : 'Company'}</span>`;
  }

  const VISUALS = [
    { id: 'table', label: 'Table', hint: 'Every column, as returned' },
    { id: 'kpi',   label: 'KPI',   hint: 'One number, big' },
    { id: 'bar',   label: 'Bar',   hint: 'Compare categories' },
    { id: 'line',  label: 'Line',  hint: 'Change over time' },
    { id: 'donut', label: 'Donut', hint: 'Parts of a whole' },
  ];

  const SORTS = [
    { id: 'desc',   label: 'Measure: highest → lowest' },
    { id: 'asc',    label: 'Measure: lowest → highest' },
    { id: 'x_asc',  label: 'Dimension: A → Z' },
    { id: 'x_desc', label: 'Dimension: Z → A' },
    { id: 'none',   label: "Query's own order" },
  ];

  function create(options) {
    const sb = options.sb;
    const runtime = options.runtime;
    const dashboard = options.dashboard;
    const setStatus = options.setStatus;
    const onDirtyChange = options.onDirtyChange || function () {};
    const onWidgetsChange = options.onWidgetsChange || function () {};

    let dirty = false;
    const deletedIds = new Set();
    let inspectingId = null;
    let reportsCache = [];
    let reportFilter = '';
    let pickedReport = null;      // report awaiting a query choice
    let uid = () => (crypto.randomUUID ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        }));

    function markDirty(v) {
      const next = v !== false;
      if (next === dirty) return;
      dirty = next;
      onDirtyChange(dirty);
    }
    function isDirty() { return dirty; }

    // ── Add-widget modal: pick a saved report, then which of its queries ──
    async function openAddWidget() {
      reportFilter = '';
      pickedReport = null;
      el('addBackdrop').classList.add('open');
      el('addBody').innerHTML = '<div class="v3-empty">Loading saved reports…</div>';
      // Deliberately NOT filtered by source. A dashboard widget does not
      // care where its dataset was authored -- an Ask SILO save, a central
      // system definition and a hand-defined report are all just "a report
      // with SQL and column metadata" to the renderer. Ask SILO's own modal
      // filters to source='ask_silo'; this one must not.
      const { data, error } = await sb
        .from('silo_chat_saved_reports_v')
        .select('id, title, description, question, queries_run, visibility, source, company_entity_id, created_by_name, created_at')
        .order('created_at', { ascending: false });
      if (error) {
        el('addBody').innerHTML = `<div class="v3-empty">Couldn't load reports: ${esc(error.message)}</div>`;
        return;
      }
      reportsCache = data || [];
      renderReportList();
    }
    function closeAddWidget() {
      el('addBackdrop').classList.remove('open');
      pickedReport = null;
    }

    function renderReportList() {
      const q = reportFilter.trim().toLowerCase();
      const usable = reportsCache.filter((r) => (r.queries_run || []).length > 0);
      const visible = usable.filter((r) => !q
        || String(r.title || '').toLowerCase().includes(q)
        || String(r.question || '').toLowerCase().includes(q));

      const skipped = reportsCache.length - usable.length;
      const toolbar = `
        <div class="v3-picker-toolbar">
          <input type="search" class="bcn-field" id="reportSearch" placeholder="Filter saved reports…" value="${esc(reportFilter)}" />
          <span class="v3-picker-count">${visible.length} of ${usable.length}</span>
          <a class="bcn-btn bcn-btn--ghost" href="/v3/report-builder.html">+ New report</a>
        </div>`;

      if (!usable.length) {
        el('addBody').innerHTML = toolbar + `<div class="v3-empty">
          No saved report has stored SQL yet. A widget can be built on any saved report —
          an answer pinned from <a href="/v2/silo-chat.html">Ask SILO</a> (ask a question, then
          <strong>Save report</strong> under the answer), a central SILO definition, or one you
          <a href="/v3/report-builder.html">build from any table or view</a>.
        </div>`;
        return;
      }

      const cards = visible.map((r) => {
        const n = (r.queries_run || []).length;
        return `<button type="button" class="v3-report-card" data-report="${esc(r.id)}">
          <span class="v3-report-title">${esc(r.title)}</span>
          <span class="v3-report-question">${esc(reportSubtitle(r))}</span>
          <span class="v3-report-foot">
            <span class="bcn-pill bcn-pill--dark">${esc(SOURCE_LABEL[r.source] || r.source || 'Report')}</span>
            ${scopePill(r)}
            <span class="bcn-pill">${n} quer${n === 1 ? 'y' : 'ies'}</span>
            ${r.created_by_name ? `<span class="v3-report-meta">${esc(r.created_by_name)}</span>` : ''}
          </span>
        </button>`;
      }).join('');

      // A private report on a company dashboard renders blank for everyone
      // else -- the RLS that hides the report hides its SQL too. Say so at
      // the point of choosing rather than letting someone discover it from
      // a colleague's screenshot.
      const liveVisibility = el('dashVisibility') ? el('dashVisibility').value : dashboard.visibility;
      const privacyNote = liveVisibility === 'company'
        && visible.some((r) => r.visibility === 'private' && r.source !== 'system')
        ? `<div class="v3-picker-note">A report marked <strong>Only you</strong> stays private: on this company dashboard its tile will be blank for everyone else.</div>`
        : '';

      const skipNote = skipped
        ? `<div class="v3-picker-note">${skipped} saved report${skipped === 1 ? '' : 's'} hidden — no stored SQL to run.</div>`
        : '';

      el('addBody').innerHTML = toolbar + privacyNote + skipNote
        + (visible.length ? `<div class="v3-report-grid">${cards}</div>` : `<div class="v3-empty">Nothing matches “${esc(reportFilter)}”.</div>`);

      const input = el('reportSearch');
      if (input && reportFilter) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }

    // A saved answer often ran several queries to get where it got. The
    // widget draws exactly one dataset, so when there is a choice the user
    // makes it -- silently taking queries_run[0] is wrong roughly as often
    // as it is right.
    //
    // Showing raw SQL made that choice unmakeable for anyone who does not
    // read SQL, which is most of the people this is for. So each query can
    // be RUN here, in place: you pick by the columns and rows it actually
    // returns. Lazily, one at a time -- a report with five queries should
    // not fire five 30-second statements the moment a modal opens.
    function queryHeadline(sql) {
      const from = /\bfrom\s+([a-z0-9_."]+)/i.exec(sql);
      const cols = /select\s+([\s\S]*?)\s+from\b/i.exec(sql);
      const list = cols ? cols[1].replace(/\s+/g, ' ').trim() : '';
      return {
        from: from ? from[1].replace(/"/g, '') : '(subquery)',
        cols: list.length > 90 ? list.slice(0, 88) + '…' : (list || '…'),
      };
    }

    function renderQueryPicker(report) {
      pickedReport = report;
      const queries = report.queries_run || [];
      const suggested = window.SiloReportBuilder.defaultQueryIndex(queries);
      const items = queries.map((sql, i) => {
        const h = queryHeadline(sql);
        const probe = window.SiloReportBuilder.isSchemaProbe(sql);
        return `
        <div class="v3-query-card v3-query-card--static${probe ? ' v3-query-card--probe' : ''}" data-qi="${i}">
          <div class="v3-query-head">
            <span class="v3-query-label">Query ${i + 1}</span>
            <span class="v3-query-from">from ${esc(h.from)}</span>
            ${probe ? '<span class="v3-query-badge v3-query-badge--probe">schema lookup — not an answer</span>'
                    : (i === suggested && queries.length > 1
                       ? '<span class="v3-query-badge">likely the answer</span>' : '')}
          </div>
          <div class="v3-query-cols">${esc(h.cols)}</div>
          <div class="v3-query-result" data-result="${i}"></div>
          <div class="v3-query-actions">
            <button type="button" class="bcn-btn bcn-btn--ghost" data-run="${i}">Preview</button>
            <button type="button" class="bcn-btn bcn-btn--primary" data-query-index="${i}">Use this one</button>
            <button type="button" class="bcn-btn bcn-btn--ghost" data-refine="${i}">Refine in report builder</button>
          </div>
          <details class="v3-query-sql-wrap"><summary>SQL</summary><pre class="v3-query-sql">${esc(sql)}</pre></details>
        </div>`;
      }).join('');
      el('addBody').innerHTML = `
        <button type="button" class="v3-back" data-act="back">← All reports</button>
        <div class="v3-picker-head">
          <div class="v3-report-title">${esc(report.title)}</div>
          <div class="v3-report-question">${esc(reportSubtitle(report))}</div>
        </div>
        <div class="v3-picker-note">${queries.length > 3 ? `
          <strong>This answer was an analysis, not a dataset.</strong> It took ${queries.length} queries, and the
          written answer is a synthesis across all of them — so no single query reproduces it, and a widget can
          only ever draw one. <strong>Preview</strong> to find the query carrying the number you actually want to
          track, then either use it directly or <strong>Refine in report builder</strong> to turn it into a clean
          report of its own.` : `
          This report ran ${queries.length} queries. A widget draws one dataset — <strong>Preview</strong> them to
          see what each returns, then pick. If none is right on its own, <strong>Refine in report builder</strong>
          opens it as editable SQL you can save as its own report.`}
        </div>
        <div class="v3-query-list">${items}</div>`;
    }

    /** Run one of a report's queries in place, so the choice is informed. */
    async function previewQuery(index) {
      const sql = (pickedReport.queries_run || [])[index];
      const out = el('addBody').querySelector(`[data-result="${index}"]`);
      if (!sql || !out) return;
      out.innerHTML = `<span class="v3-query-running">Running…</span>`;
      const { data, error } = await sb.rpc('chat_run_readonly_query', { query: sql });
      if (error) {
        out.innerHTML = `<span class="v3-query-err">Failed: ${esc(error.message)}</span>`;
        return;
      }
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) { out.innerHTML = `<span class="v3-query-err">Ran fine — 0 rows, so it would draw an empty tile.</span>`; return; }
      const cols = Object.keys(rows[0]);
      out.innerHTML = `
        <div class="v3-query-meta">${rows.length} row${rows.length === 1 ? '' : 's'} · ${cols.length} column${cols.length === 1 ? '' : 's'}</div>
        <div class="v3-query-chips">${cols.map((c) => `<span class="bcn-pill">${esc(c)}</span>`).join('')}</div>
        ${window.SiloChart.tableHtml(rows.slice(0, 3), {})}`;
    }

    async function addWidgetFromReport(report, queryIndex) {
      closeAddWidget();
      const widget = {
        id: uid(),
        dashboard_id: dashboard.id,
        report_id: report.id,
        query_index: queryIndex,
        title: report.title,
        visual_type: 'table',
        visual_config: {},
        layout: { w: 6, h: 4 },
        sort_order: runtime.getWidgets().length,
        // Denormalised for the renderer; dashboard_widgets_v supplies these
        // on reload, they are not columns on the table.
        report_title: report.title,
        report_question: report.question,
        report_visibility: report.visibility,
        report_query_count: (report.queries_run || []).length,
        query_sql: (report.queries_run || [])[queryIndex] || null,
        _new: true,
      };
      markDirty();
      await runtime.addWidget(widget);
      onWidgetsChange();

      // Deterministic auto-suggest: profile what the query actually
      // returned and pick a visual from the shape of the data. No LLM call
      // -- the columns are right there.
      const rows = runtime.rowsFor(widget.id);
      if (rows && rows.length) {
        const semantics = runtime.semanticsFor(widget, rows);
        const rec = window.SiloChart.recommend(rows, semantics);
        runtime.updateWidget(widget.id, { visual_type: rec.visual_type, visual_config: rec.visual_config });
        if (rec.visual_type === 'kpi') runtime.updateWidget(widget.id, { layout: { ...widget.layout, w: 3, h: 2 } });
        await runtime.rerenderWidget(widget.id);
        seedReportSemantics(widget, rows);
        setStatus(`Added "${report.title}" as a ${rec.visual_type}. Click the type badge to change it.`, 'info', 5000);
      } else {
        setStatus(`Added "${report.title}".`, 'info', 4000);
      }
      openInspector(widget.id);
    }

    // ── Column semantics ─────────────────────────────────────────────────
    /**
     * First time a widget is built on a report, write the grounded column
     * semantics back onto the REPORT so every future widget on it starts
     * from the same answer -- and so a human correcting one column fixes
     * them all.
     *
     * Only grounded answers are seeded (see seedableMetadata): writing a
     * pure name guess into columns_metadata would launder a guess into an
     * authoritative record, and the next reader could no longer tell the
     * difference between "we know" and "we guessed".
     *
     * Skipped for system reports -- those are service-role-owned by design
     * (20260828130000) and the write would just be denied. Failure is
     * ignored either way: this is an optimisation, not a requirement, and
     * the four-layer fallback means nothing breaks without it.
     */
    async function seedReportSemantics(widget, rows) {
      if (!widget.report_id || widget.report_source === 'system') return;
      if (widget.report_columns_metadata) return;
      const resolved = window.SiloFieldSemantics.resolveAll(
        window.SiloChart.profileColumns(rows),
        { reportMetadata: null, catalogIndex: undefined, overrides: (widget.visual_config || {}).field_semantics },
      );
      const seed = window.SiloFieldSemantics.seedableMetadata(resolved);
      if (!Object.keys(seed).length) return;
      const { error } = await sb.from('silo_chat_saved_reports')
        .update({ columns_metadata: seed }).eq('id', widget.report_id);
      if (!error) runtime.updateWidget(widget.id, { report_columns_metadata: seed });
    }

    /**
     * A human correcting a column's meaning. This writes to the REPORT, not
     * the widget, and says so in the UI -- the whole point of moving
     * semantics off the widget is that `net_sales` means the same thing
     * everywhere that report is used.
     */
    async function setFieldSemantic(widget, field, semantic) {
      const next = { ...(widget.report_columns_metadata || {}) };
      next[field] = { semantic, source: 'human' };
      const { error } = await sb.from('silo_chat_saved_reports')
        .update({ columns_metadata: next }).eq('id', widget.report_id);
      if (error) {
        // A system report (service-role-owned) or someone else's report.
        // Fall back to a widget-local override so the correction still
        // takes effect here rather than silently doing nothing.
        const cfg = { ...(widget.visual_config || {}) };
        cfg.field_semantics = { ...(cfg.field_semantics || {}), [field]: semantic };
        runtime.updateWidget(widget.id, { visual_config: cfg });
        markDirty();
        setStatus(`Applied to this widget only — this report's column types are not yours to edit.`, 'info', 5000);
      } else {
        runtime.updateWidget(widget.id, { report_columns_metadata: next });
        setStatus(`"${field}" is now ${semantic} everywhere this report is used.`, 'pos', 4000);
      }
      await runtime.rerenderWidget(widget.id);
      renderInspector();
    }

    // ── Inspector ────────────────────────────────────────────────────────
    function openInspector(id) {
      inspectingId = id;
      el('inspector').classList.add('open');
      renderInspector();
    }
    function closeInspector() {
      inspectingId = null;
      el('inspector').classList.remove('open');
    }

    function renderInspector() {
      const w = runtime.getWidgets().find((x) => x.id === inspectingId);
      if (!w) { closeInspector(); return; }
      const cfg = w.visual_config || {};
      const rows = runtime.rowsFor(w.id);
      const prof = rows ? window.SiloChart.profileColumns(rows) : [];
      const dims = window.SiloChart.dimensionsOf(prof);
      const meas = window.SiloChart.measuresOf(prof);
      const isChart = ['bar', 'line', 'donut'].includes(w.visual_type);

      const visualOpts = VISUALS.map((v) => `
        <label class="v3-visual-opt${w.visual_type === v.id ? ' is-active' : ''}">
          <input type="radio" name="visualType" value="${v.id}" ${w.visual_type === v.id ? 'checked' : ''} />
          <span class="v3-visual-label">${v.label}</span>
          <span class="v3-visual-hint">${v.hint}</span>
        </label>`).join('');

      const options = (list, selected) => list.map((c) =>
        `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

      const shaped = rows ? window.SiloChart.shape(rows, cfg) : null;
      const activeX = shaped ? shaped.xField : cfg.x_field;
      const activeY = shaped ? shaped.yField : cfg.y_field;

      const SEMANTIC_LABEL = {
        currency: 'Currency ($)', count: 'Whole count', number: 'Number',
        percent: 'Percentage (%)', date: 'Date', category: 'Category', boolean: 'True/false',
      };
      const semantics = rows ? runtime.semanticsFor(w, rows) : {};
      // cfg.measures is the multi-measure form; cfg.y_field is what every
      // widget built before it used. Treat the single field as a one-item
      // list so both shapes drive the same UI.
      const activeMeasures = (Array.isArray(cfg.measures) && cfg.measures.length
        ? cfg.measures
        : [activeY]).filter(Boolean);
      const measureSemantic = activeMeasures[0] ? semantics[activeMeasures[0]] : null;
      const aggNow = window.SiloChart.AGGREGATES.includes(cfg.aggregate)
        ? cfg.aggregate
        : window.SiloChart.defaultAggregate(measureSemantic);

      const fieldsBlock = !rows
        ? `<div class="v3-insp-note">No data loaded for this widget, so there are no fields to configure yet.</div>`
        : `
        ${isChart ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspX">Dimension</label>
          <select class="bcn-field" id="inspX">${options(dims.length ? dims : prof, activeX)}</select>
        </div>` : ''}
        ${isChart ? `
        <div class="bcn-field-group">
          <span class="bcn-label">Measures</span>
          <div class="v3-measures">
            ${(meas.length ? meas : prof).map((c) => `
              <label class="rb-col${activeMeasures.includes(c.name) ? ' is-on' : ''}">
                <input type="checkbox" data-measure="${esc(c.name)}" ${activeMeasures.includes(c.name) ? 'checked' : ''} />
                ${esc(c.name)}
              </label>`).join('')}
          </div>
          <span class="v3-insp-hint">${activeMeasures.length > 1
            ? 'Plotted together. A measure that means something different, or sits on a wildly different scale, gets its own axis on the right automatically — and is drawn as a line over bars.'
            : 'Pick more than one to compare them on the same chart.'}</span>
        </div>` : ''}
        ${(w.visual_type === 'kpi' || w.visual_type === 'table') ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspY">${w.visual_type === 'table' ? 'Sort by (measure)' : 'Measure'}</label>
          <select class="bcn-field" id="inspY">
            ${w.visual_type === 'table' ? '<option value="">—</option>' : ''}
            ${options(meas.length ? meas : prof, activeY)}
          </select>
        </div>` : ''}
        ${(isChart || w.visual_type === 'kpi') ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspAgg">Aggregation</label>
          <select class="bcn-field" id="inspAgg">
            ${window.SiloChart.AGGREGATES.map((a) =>
              `<option value="${a}"${aggNow === a ? ' selected' : ''}>${a === 'none' ? "none (plot every row)" : a}</option>`).join('')}
          </select>
          <span class="v3-insp-hint">${isChart
            ? 'Rows sharing a dimension value are rolled up before sorting and limiting. Leave on sum unless the query already aggregated.'
            : `${rows.length} row${rows.length === 1 ? '' : 's'} in this dataset.`}</span>
        </div>` : ''}
        ${activeMeasures[0] ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspSemantic">"${esc(activeMeasures[0])}" means</label>
          <select class="bcn-field" id="inspSemantic">
            ${window.SiloFieldSemantics.SEMANTICS.map((sem) =>
              `<option value="${sem}"${measureSemantic === sem ? ' selected' : ''}>${SEMANTIC_LABEL[sem] || sem}</option>`).join('')}
          </select>
          <span class="v3-insp-hint">Decides how the value is printed and which aggregation makes sense.
            Saved on the <strong>report</strong>, so it applies everywhere that report is used — not just here.</span>
        </div>` : ''}
        ${w.visual_type !== 'kpi' ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspSort">Sort</label>
          <select class="bcn-field" id="inspSort">
            ${SORTS.map((s) => `<option value="${s.id}"${(cfg.sort || 'desc') === s.id ? ' selected' : ''}>${s.label}</option>`).join('')}
          </select>
        </div>
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspLimit">Limit</label>
          <input class="bcn-field bcn-field--mono" id="inspLimit" type="number" min="0" step="1" value="${Number(cfg.limit) || 0}" />
          <span class="v3-insp-hint">0 shows everything the query returned. Sorting and limiting happen on the returned rows, not in SQL — the source query is still capped at 500 rows.</span>
        </div>` : ''}`;

      el('inspectorBody').innerHTML = `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspTitle">Widget title</label>
          <input class="bcn-field" id="inspTitle" type="text" value="${esc(w.title || '')}" />
        </div>

        <div class="v3-insp-source">
          <span class="bcn-label">Source report</span>
          <div class="v3-insp-source-name">${esc(w.report_title || '(report unavailable)')}</div>
          ${w.report_query_count > 1 ? `
            <label class="bcn-label" for="inspQueryIndex" style="margin-top:8px">Query</label>
            <select class="bcn-field" id="inspQueryIndex">
              ${Array.from({ length: w.report_query_count }, (_, i) =>
                `<option value="${i}"${i === w.query_index ? ' selected' : ''}>Query ${i + 1}</option>`).join('')}
            </select>` : ''}
        </div>

        <div class="bcn-field-group">
          <span class="bcn-label">Visualization</span>
          <div class="v3-visual-opts">${visualOpts}</div>
        </div>

        ${fieldsBlock}

        <div class="v3-insp-actions">
          <button type="button" class="bcn-btn bcn-btn--danger" id="inspRemove">Remove widget</button>
        </div>`;
    }

    function resizeTile(id, w, h) {
      const grid = runtime.grid;
      const el = grid && grid.el.querySelector(`.grid-stack-item[gs-id="${CSS.escape(id)}"]`);
      if (grid && el) grid.update(el, { w, h });
    }

    function patchConfig(patch) {
      const w = runtime.getWidgets().find((x) => x.id === inspectingId);
      if (!w) return;
      runtime.updateWidget(w.id, { visual_config: { ...(w.visual_config || {}), ...patch } });
      markDirty();
      runtime.rerenderWidget(w.id);
    }

    // ── Persistence ──────────────────────────────────────────────────────
    async function save() {
      const widgets = runtime.getWidgets();
      const geometry = runtime.layout();

      const name = (el('dashName').value || '').trim();
      if (!name) { setStatus('Give the dashboard a name before saving.', 'neg', 4000); el('dashName').focus(); return false; }

      // The slicer values in the header become the dashboard's saved
      // position. Only an EDITOR's save writes them: a viewer moving a
      // slicer changes their own session and nobody else's, which is why
      // this is read here rather than persisted on every change.
      // Narrowed to declared keys so a parameter removed from a report does
      // not leave a value behind that nothing reads.
      const declared = new Set(runtime.parameterDeclarations().map((d) => d.key));
      const live = runtime.getParamValues();
      const filterState = {};
      for (const [k, v] of Object.entries(live)) {
        if (declared.has(k) && v !== '' && v != null) filterState[k] = String(v);
      }

      const { error: dashErr } = await sb.from('dashboards').update({
        name,
        description: (el('dashDescription').value || '').trim() || null,
        visibility: el('dashVisibility').value,
        filter_state: filterState,
      }).eq('id', dashboard.id);
      if (dashErr) { setStatus('Could not save the dashboard: ' + dashErr.message, 'neg', 6000); return false; }
      dashboard.name = name;
      dashboard.visibility = el('dashVisibility').value;
      dashboard.filter_state = filterState;

      if (deletedIds.size) {
        const { error } = await sb.from('dashboard_widgets').delete().in('id', Array.from(deletedIds));
        if (error) { setStatus('Could not remove deleted widgets: ' + error.message, 'neg', 6000); return false; }
        deletedIds.clear();
      }

      if (widgets.length) {
        // Only the table's own columns go back -- report_title/query_sql and
        // friends are view-supplied and would be rejected as unknown columns.
        const payload = widgets.map((w, i) => ({
          id: w.id,
          dashboard_id: dashboard.id,
          report_id: w.report_id,
          query_index: w.query_index,
          title: w.title || null,
          visual_type: w.visual_type,
          visual_config: w.visual_config || {},
          layout: geometry.get(w.id) || w.layout || {},
          sort_order: i,
        }));
        // Stamp the company explicitly rather than leaning on the BEFORE
        // INSERT trigger. The trigger is still the backstop, but this write
        // is an UPSERT: on the conflict-update path the row does not take
        // the insert path's stamp, and dashboard_widgets_insert's WITH CHECK
        // tests company_entity_id. Passing it removes the ambiguity entirely,
        // and withCompanyRows() is the documented helper for exactly this.
        const stamped = window.__SILO_CONFIG__?.withCompanyRows?.(payload) || payload;
        const { error } = await sb.from('dashboard_widgets').upsert(stamped, { onConflict: 'id' });
        if (error) { setStatus('Could not save widgets: ' + error.message, 'neg', 6000); return false; }
        for (const w of widgets) { delete w._new; w.layout = geometry.get(w.id) || w.layout; }
      }

      // ── Publishing a board has to publish what it shows ───────────────
      // A COMPANY dashboard whose reports are PRIVATE renders blank tiles for
      // everyone else -- dashboard_widgets_v is security_invoker, so a report
      // the viewer cannot see yields a null query_sql. That is not a
      // theoretical failure: a board was shared and the recipient got nine
      // empty tiles, because sharing the arrangement is not sharing the data.
      //
      // So making a board company-visible promotes its private reports too.
      // NOT silently: the count is reported, because this widens who can read
      // those reports. And only the ones this user is allowed to update --
      // the RLS policy is creator-or-exec, so someone else's private report
      // simply is not returned, and we say that instead of pretending.
      if (el('dashVisibility').value === 'company') {
        const privateIds = Array.from(new Set(widgets
          .filter((w) => w.report_id && w.report_visibility === 'private')
          .map((w) => w.report_id)));
        if (privateIds.length) {
          const { data: promoted, error: promoteErr } = await sb
            .from('silo_chat_saved_reports')
            .update({ visibility: 'company' })
            .in('id', privateIds)
            .eq('visibility', 'private')
            .select('id, title');
          if (promoteErr) {
            setStatus('Dashboard saved, but its private reports could not be shared: '
              + promoteErr.message, 'neg', 8000);
            markDirty(false);
            return true;
          }
          const done = (promoted || []).length;
          const blocked = privateIds.length - done;
          // Keep the local copies in step so a second Save does not retry.
          for (const w of widgets) {
            if (privateIds.includes(w.report_id) && (promoted || []).some((r) => r.id === w.report_id)) {
              w.report_visibility = 'company';
            }
          }
          markDirty(false);
          setStatus(
            `Dashboard saved. ${done} report${done === 1 ? '' : 's'} made company-visible so the tiles are not blank for others.`
            + (blocked
              ? ` ${blocked} belong${blocked === 1 ? 's' : ''} to someone else and stayed private — those tiles will be blank for everyone but the owner.`
              : ''),
            blocked ? 'neg' : 'pos', blocked ? 10000 : 6000);
          return true;
        }
      }

      markDirty(false);
      setStatus('Dashboard saved.', 'pos', 3000);
      return true;
    }

    // ── Wiring ───────────────────────────────────────────────────────────
    function bind() {
      el('btnAddWidget').addEventListener('click', openAddWidget);

      el('addBackdrop').addEventListener('click', (e) => {
        if (e.target.id === 'addBackdrop' || e.target.closest('#btnCloseAdd')) { closeAddWidget(); return; }
        if (e.target.closest('[data-act="back"]')) { renderReportList(); return; }
        const card = e.target.closest('[data-report]');
        if (card) {
          const report = reportsCache.find((r) => r.id === card.dataset.report);
          if (!report) return;
          if ((report.queries_run || []).length === 1) addWidgetFromReport(report, 0);
          else renderQueryPicker(report);
          return;
        }
        const run = e.target.closest('[data-run]');
        if (run && pickedReport) { previewQuery(Number(run.dataset.run)); return; }
        const refine = e.target.closest('[data-refine]');
        if (refine && pickedReport) {
          const sql = (pickedReport.queries_run || [])[Number(refine.dataset.refine)] || '';
          window.location.href = '/v3/report-builder.html?sql=' + encodeURIComponent(sql)
            + '&from=' + encodeURIComponent(pickedReport.title);
          return;
        }
        const q = e.target.closest('[data-query-index]');
        if (q && pickedReport) addWidgetFromReport(pickedReport, Number(q.dataset.queryIndex));
      });
      el('addBackdrop').addEventListener('input', (e) => {
        if (e.target.id !== 'reportSearch') return;
        reportFilter = e.target.value;
        renderReportList();
      });

      // Tile buttons are delegated off the grid: tiles are created and
      // destroyed by the renderer, so nothing can be bound to them directly.
      el('grid').addEventListener('click', (e) => {
        const tile = e.target.closest('.dw');
        if (!tile) return;
        const id = tile.dataset.widgetId;
        if (e.target.closest('[data-act="configure"]')) openInspector(id);
        else if (e.target.closest('[data-act="remove"]')) removeWidget(id);
      });

      el('inspector').addEventListener('click', (e) => {
        if (e.target.closest('#btnCloseInspector')) { closeInspector(); return; }
        if (e.target.closest('#inspRemove')) { removeWidget(inspectingId); return; }
      });

      el('inspector').addEventListener('change', (e) => {
        const w = runtime.getWidgets().find((x) => x.id === inspectingId);
        if (!w) return;
        const t = e.target;
        if (t.name === 'visualType') {
          // Carry the field choices across the switch and only fill in what
          // the new visual needs -- the whole point of config-not-code is
          // that Table -> Bar keeps the same dataset and the same columns.
          const rows = runtime.rowsFor(w.id);
          const rec = rows ? window.SiloChart.recommend(rows, runtime.semanticsFor(w, rows)) : { visual_config: {} };
          const merged = { ...rec.visual_config, ...(w.visual_config || {}) };
          runtime.updateWidget(w.id, { visual_type: t.value, visual_config: merged });
          // A KPI is one number; leaving it in a full chart's footprint
          // wastes the canvas and reads as a broken chart. Only shrink a
          // tile that is still chart-sized, so a deliberately large KPI
          // stays large.
          if (t.value === 'kpi') {
            const geo = runtime.layout().get(w.id) || w.layout || {};
            if ((geo.w || 6) > 4 || (geo.h || 4) > 3) resizeTile(w.id, 3, 2);
          }
          markDirty();
          runtime.rerenderWidget(w.id).then(renderInspector);
          return;
        }
        if (t.dataset.measure !== undefined) {
          const cur = Array.isArray(w.visual_config?.measures) && w.visual_config.measures.length
            ? w.visual_config.measures.slice()
            : [w.visual_config?.y_field].filter(Boolean);
          const name = t.dataset.measure;
          let next = cur.includes(name) ? cur.filter((x) => x !== name) : cur.concat(name);
          // Never leave a chart with nothing to draw.
          if (!next.length) next = [name];
          // y_field stays in step with the first measure so KPI, donut and
          // the table path keep working if the visual is switched later.
          patchConfig({ measures: next, y_field: next[0] });
          renderInspector();
          return;
        }
        if (t.id === 'inspX') patchConfig({ x_field: t.value });
        // Changing the measure can change what aggregation makes sense
        // (sum for dollars, avg for a rate), so re-render the inspector too.
        else if (t.id === 'inspY') { patchConfig({ y_field: t.value || undefined }); renderInspector(); }
        else if (t.id === 'inspAgg') patchConfig({ aggregate: t.value });
        else if (t.id === 'inspSort') patchConfig({ sort: t.value });
        else if (t.id === 'inspLimit') patchConfig({ limit: Math.max(0, Number(t.value) || 0) });
        else if (t.id === 'inspSemantic') {
          const cfgNow = w.visual_config || {};
          const field = (Array.isArray(cfgNow.measures) && cfgNow.measures[0]) || cfgNow.y_field
            || (window.SiloChart.shape(runtime.rowsFor(w.id), cfgNow, runtime.semanticsFor(w, runtime.rowsFor(w.id))) || {}).yField;
          if (field) setFieldSemantic(w, field, t.value);
        }
        else if (t.id === 'inspQueryIndex') changeQueryIndex(w, Number(t.value));
      });

      el('inspector').addEventListener('input', (e) => {
        if (e.target.id !== 'inspTitle') return;
        const w = runtime.updateWidget(inspectingId, { title: e.target.value });
        markDirty();
        const tile = el('grid').querySelector(`.dw[data-widget-id="${CSS.escape(inspectingId)}"] .dw-title`);
        if (tile && w) tile.textContent = w.title || w.report_title || 'Untitled';
      });

      for (const id of ['dashName', 'dashDescription']) {
        el(id).addEventListener('input', () => markDirty());
      }
      el('dashVisibility').addEventListener('change', () => markDirty());
    }

    async function changeQueryIndex(w, index) {
      const { data } = await sb.from('silo_chat_saved_reports_v')
        .select('queries_run').eq('id', w.report_id).maybeSingle();
      const sql = (data?.queries_run || [])[index] || null;
      // A different dataset means the old dimension/measure names may not
      // exist any more. Clearing them lets shape() fall back to the new
      // data's own first dimension and measure instead of rendering empty.
      runtime.updateWidget(w.id, { query_index: index, query_sql: sql, visual_config: {} });
      markDirty();
      await runtime.rerenderWidget(w.id);
      renderInspector();
    }

    function removeWidget(id) {
      const w = runtime.getWidgets().find((x) => x.id === id);
      if (!w) return;
      if (!confirm(`Remove "${w.title || w.report_title || 'this widget'}" from the dashboard?`)) return;
      if (!w._new) deletedIds.add(id);
      runtime.removeWidget(id);
      if (inspectingId === id) closeInspector();
      markDirty();
      onWidgetsChange();
    }

    /**
     * Arrived from Ask SILO's "Save & open dashboard". The report already
     * exists; this adds it, recommends a visual from what the query actually
     * returns, and SAVES immediately -- the user came from another page and
     * has no reason to expect a Save button is still waiting on them.
     *
     * Deliberately defaults to query 0 on a multi-query report rather than
     * interrupting the hand-off with a picker: the inspector can switch it,
     * and the status message says so.
     */
    async function addReportById(reportId) {
      const { data: report, error } = await sb.from('silo_chat_saved_reports_v')
        .select('id, title, description, question, queries_run, visibility, source, company_entity_id')
        .eq('id', reportId).maybeSingle();
      if (error || !report) {
        setStatus('That report could not be found — it may have been deleted, or it is private to someone else.', 'neg', 6000);
        return false;
      }
      if (!(report.queries_run || []).length) {
        setStatus(`"${report.title}" has no stored SQL, so there is nothing for a widget to run.`, 'neg', 6000);
        return false;
      }
      // Not 0: for a multi-query answer the closing query is the answer and
      // an opening information_schema lookup is not. See defaultQueryIndex.
      await addWidgetFromReport(report, window.SiloReportBuilder.defaultQueryIndex(report.queries_run));
      const saved = await save();
      if (saved && (report.queries_run || []).length > 1) {
        // Name WHICH query is showing. "the first is showing" was true when
        // this always took index 0; it no longer does, and a status line that
        // quietly lies about which dataset is on screen is worse than none.
        const shown = window.SiloReportBuilder.defaultQueryIndex(report.queries_run) + 1;
        setStatus(`Added "${report.title}" and saved. It ran ${report.queries_run.length} queries — `
          + `query ${shown} is showing; switch with the Query dropdown in the panel.`, 'info', 9000);
      }
      return saved;
    }

    bind();
    return {
      save, isDirty, openAddWidget, closeInspector, addReportById,
      /** GridStack moved or resized something -- geometry is read at save
          time from grid.save(), so this only has to flip the dirty flag. */
      markLayoutDirty: () => markDirty(),
      /** A slicer moved while editing. Same deal: values are read from the
          runtime at save time, so this only flips the flag. */
      markFiltersDirty: () => markDirty(),
    };
  }

  global.SiloDashboardBuilder = { create };
})(window);
