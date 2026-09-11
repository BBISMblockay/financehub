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

  /* Everything a widget needs to render BEFORE the dashboard has been saved
     and reloaded through dashboard_widgets_v.

     This list exists because it kept getting short. The picker used to
     select nine columns and `parameters` was not among them, so a widget
     built on a parameterised report was handed report_parameters=undefined
     -- and substitute() correctly refuses a {{token}} nothing declares.
     The tile therefore read "this report's SQL uses {{report_date}}, which
     is not a declared parameter" on a report that declares it perfectly
     well, and healed itself on the next reload because the VIEW supplies
     the column. columns_metadata and answer had the same shape of bug,
     quieter: a freshly added tile formatted its numbers by profiling and
     reformatted them after a reload, and the Answer visual was missing
     from the inspector until then.

     One list, used by every read, so the next column added to the view is
     added here once rather than in three places. */
  const REPORT_FIELDS = [
    'id', 'title', 'description', 'question', 'answer', 'queries_run',
    'visibility', 'source', 'company_entity_id', 'created_by_name', 'created_at',
    'row_estimate', 'parameters', 'columns_metadata',
  ].join(', ');

  /**
   * The denormalised half of a widget row: the columns dashboard_widgets_v
   * joins in from the report. Built in ONE place so a locally created
   * widget is indistinguishable from a reloaded one -- which is the whole
   * property "add a report and it works immediately" depends on.
   */
  function reportFieldsFor(report, queryIndex) {
    const queries = (report && report.queries_run) || [];
    return {
      report_title: report.title,
      report_question: report.question,
      report_description: report.description,
      report_source: report.source,
      report_visibility: report.visibility,
      report_columns_metadata: report.columns_metadata || null,
      report_parameters: report.parameters || null,
      report_answer: report.answer || null,
      report_query_count: queries.length,
      query_sql: queries[queryIndex] || null,
    };
  }

  // A system/manual report has a description; an Ask SILO save has the
  // question that produced it. Same slot, different provenance.
  const reportSubtitle = (r) => r.description || r.question || '';

  // A system definition is global (company_entity_id null) and reusable
  // across tenants, so "Company"/"Only you" would be a lie for it.
  /**
   * Flag a report whose result does not fit one page, at the moment someone
   * is choosing it for a tile.
   *
   * The runner returns 1000 rows per page. A TABLE tile can page through the
   * rest, so this is a heads-up there; on a chart or KPI it is the whole
   * story, because those are computed from the first page and do not page.
   * Either way the person picking is the last one who can cheaply choose a
   * different report.
   *
   * A null estimate means never measured, NOT small -- every report saved
   * before 20260907140000 is null -- so an unmeasured report shows nothing
   * rather than a reassuring badge it has not earned.
   */
  function sizePill(r) {
    const n = Number(r.row_estimate);
    if (!Number.isFinite(n) || n <= 1000) return '';
    return `<span class="bcn-pill bcn-pill--neg" title="This report returns ${n.toLocaleString()} rows. A tile shows 1,000 at a time -- a table can page through the rest, a chart is drawn from the first page alone.">${n.toLocaleString()} rows</span>`;
  }

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
    { id: 'combo', label: 'Combo', hint: 'Bars plus a reference line' },
    { id: 'donut', label: 'Donut', hint: 'Parts of a whole' },
    { id: 'matrix', label: 'Matrix', hint: 'One thing down, another across' },
    { id: 'heatmap', label: 'Heatmap', hint: 'The same grid, read as a pattern' },
    { id: 'waterfall', label: 'Waterfall', hint: 'How one number becomes another' },
  ];

  /* The conditional-formatting vocabulary. Small on purpose: a table where
     six colours mean six things has no highlights at all. */
  const RULE_OPS = {
    gt: 'greater than', lt: 'less than', gte: 'at least', lte: 'at most',
    between: 'between', negative: 'is negative', positive: 'is positive',
    empty: 'is empty', contains: 'contains',
  };

  // Offered only when the widget's report actually has answer text -- an
  // Ask SILO save always does; a manual/system report built from a table or
  // view never does, so this option would silently render nothing there.
  const ANSWER_VISUAL = { id: 'answer', label: 'Answer', hint: 'The written synthesis, as text' };

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
    /* Dashboards this user can OPEN, for the drill-through target list.
       Read through dashboards_v, so RLS decides what is offered -- a board
       the user cannot see is simply not in the list, and following a link
       to one still goes through the destination's own policy. Hiding an
       unavailable destination is a UX courtesy, never the authorization. */
    let dashboardsForDrill = [];
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
        .select(REPORT_FIELDS)
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
            ${sizePill(r)}
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
      // Offered whenever the report has answer text, but pitched hardest for
      // a many-query analysis: that is exactly the case where no single
      // query below reproduces what was asked, because the actual answer is
      // the synthesis across all of them, not any one dataset.
      const answerCta = report.answer ? `
        <div class="v3-answer-cta">
          <div class="v3-answer-cta-text">
            <strong>${queries.length > 3 ? 'Show the written answer instead' : 'Or show the written answer'}</strong>
            <p>Renders the synthesis Ask SILO wrote, as text — no query, no rows, nothing to pick.</p>
          </div>
          <button type="button" class="bcn-btn bcn-btn--primary" data-act="use-answer">Add as Answer widget</button>
        </div>` : '';

      el('addBody').innerHTML = `
        <button type="button" class="v3-back" data-act="back">← All reports</button>
        <div class="v3-picker-head">
          <div class="v3-report-title">${esc(report.title)}</div>
          <div class="v3-report-question">${esc(reportSubtitle(report))}</div>
        </div>
        <div class="v3-picker-note">${queries.length > 3 ? `
          <strong>This answer was an analysis, not a dataset.</strong> It took ${queries.length} queries, and the
          written answer is a synthesis across all of them — so no single query reproduces it, and a table widget
          can only ever draw one. <strong>Preview</strong> below to find the query carrying one number you want to
          track on its own, <strong>Refine in report builder</strong> to turn it into a clean report, or use the
          written answer as-is.` : `
          This report ran ${queries.length} queries. A widget draws one dataset — <strong>Preview</strong> them to
          see what each returns, then pick. If none is right on its own, <strong>Refine in report builder</strong>
          opens it as editable SQL you can save as its own report.`}
        </div>
        ${answerCta}
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

    /** A heading tile. No report, no query -- it just groups what follows. */
    function addSection() {
      const widget = {
        id: uid(),
        dashboard_id: dashboard.id,
        report_id: null,
        query_index: 0,
        title: 'New section',
        visual_type: 'section',
        visual_config: {},
        // Full width and short: a heading spans the row it introduces.
        layout: { w: 12, h: 1 },
        sort_order: runtime.getWidgets().length,
        report_title: null, report_question: null, report_visibility: null,
        report_source: null, report_columns_metadata: null, report_parameters: null,
        query_sql: null, report_query_count: 0,
        _new: true,
      };
      runtime.addWidget(widget);
      markDirty();
      onWidgetsChange();
      openInspector(widget.id);
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
        // on reload, they are not columns on the table. Built through the
        // shared helper so a just-added widget carries EVERY field a
        // reloaded one does -- parameters above all, without which a
        // parameterised report renders "not a declared parameter" until
        // the page is saved and reloaded.
        ...reportFieldsFor(report, queryIndex),
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

    /**
     * The other door onto a saved report: no query, no rows, just the
     * written synthesis rendered as text. Exists because a genuinely
     * open-ended Ask SILO question -- "tell me about the business and
     * suggest action items" -- can take 20+ queries and never reduce to one
     * dataset; the answer text is the actual deliverable, and until this
     * widget existed the only way onto a dashboard was picking one of those
     * queries and hoping it stood on its own.
     */
    async function addAnswerWidgetFromReport(report) {
      closeAddWidget();
      // An answer widget ignores query_sql entirely while it IS an answer
      // widget (see loadWidget's answer branch) -- but the Visualization
      // picker still offers Table/Bar/etc, and switching to one of those
      // needs a real dataset underneath, not null. Populate it the same way
      // addWidgetFromReport does, using the same "last non-probe query"
      // heuristic the picker already uses to suggest one -- so switching
      // away from Answer lands on a sensible query rather than a blank tile.
      const queries = report.queries_run || [];
      const queryIndex = queries.length ? window.SiloReportBuilder.defaultQueryIndex(queries) : 0;
      const widget = {
        id: uid(),
        dashboard_id: dashboard.id,
        report_id: report.id,
        query_index: queryIndex,
        title: report.title,
        visual_type: 'answer',
        visual_config: {},
        layout: { w: 6, h: 5 },
        sort_order: runtime.getWidgets().length,
        ...reportFieldsFor(report, queryIndex),
        _new: true,
      };
      markDirty();
      await runtime.addWidget(widget);
      onWidgetsChange();
      setStatus(`Added "${report.title}" as the written answer.`, 'info', 4000);
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
    /* Four tabs, in the order the questions are actually asked:
     *
     *   Data          which report, which query, which columns
     *   Visual        which chart, and how it is drawn
     *   Format        what the numbers look like and what stands out
     *   Interactions  what a click does, and which filters reach this tile
     *
     * The panel used to be one scroll of nineteen controls where the sort
     * order sat below the column checkboxes and above the semantic picker,
     * and finding anything meant reading all of it. Splitting it is only
     * worth doing if the split is predictable, hence four fixed tabs rather
     * than per-visual sections that appear and vanish.
     *
     * THE TILE IS THE PREVIEW. Every control here writes config and
     * re-renders the widget immediately, so the live preview is the real
     * tile at its real size on the real data -- not a thumbnail that can
     * disagree with it. The tile is ringed and scrolled into view when the
     * panel opens so it is always the thing next to the controls.
     */
    const TABS = [
      { id: 'data', label: 'Data' },
      { id: 'visual', label: 'Visual' },
      { id: 'format', label: 'Format' },
      { id: 'interactions', label: 'Interactions' },
    ];
    let activeTab = 'data';

    function openInspector(id) {
      inspectingId = id;
      activeTab = 'data';
      el('inspector').classList.add('open');
      renderInspector();
      highlightInspected();
    }
    function closeInspector() {
      inspectingId = null;
      el('inspector').classList.remove('open');
      highlightInspected();
    }

    /** Ring the tile being edited and bring it on screen: it IS the preview. */
    function highlightInspected() {
      for (const tile of el('grid').querySelectorAll('.dw')) {
        tile.classList.toggle('is-inspecting', tile.dataset.widgetId === inspectingId);
      }
      if (!inspectingId) return;
      const tile = el('grid').querySelector(`.dw[data-widget-id="${CSS.escape(inspectingId)}"]`);
      if (tile && tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function renderTabs(available) {
      el('inspectorTabs').innerHTML = TABS.filter((t) => available.includes(t.id)).map((t) => `
        <button type="button" role="tab" class="v3-insp-tab${t.id === activeTab ? ' is-active' : ''}"
                data-tab="${t.id}" aria-selected="${t.id === activeTab}">${t.label}</button>`).join('');
    }

    function renderInspector() {
      const w = runtime.getWidgets().find((x) => x.id === inspectingId);
      if (!w) { closeInspector(); return; }
      const cfg = w.visual_config || {};
      const rows = runtime.rowsFor(w.id);
      const prof = rows ? window.SiloChart.profileColumns(rows) : [];
      const dims = window.SiloChart.dimensionsOf(prof);
      const meas = window.SiloChart.measuresOf(prof);
      const isChart = ['bar', 'line', 'donut', 'combo'].includes(w.visual_type);
      const isSection = w.visual_type === 'section';
      const isAnswer = w.visual_type === 'answer';
      // A matrix and a heatmap both need a SECOND dimension -- one down,
      // one across -- which no other visual has.
      const isGrid2d = w.visual_type === 'matrix' || w.visual_type === 'heatmap';
      const isWaterfall = w.visual_type === 'waterfall';
      const semantics = rows ? runtime.semanticsFor(w, rows) : {};

      el('inspectorHeading').textContent = isSection ? 'Section' : (w.title || w.report_title || 'Widget');

      // A section has no data and no format; showing four tabs where two
      // are empty is worse than showing the two that mean something.
      const available = isSection ? ['data']
        : isAnswer ? ['data', 'interactions']
        : ['data', 'visual', 'format', 'interactions'];
      if (!available.includes(activeTab)) activeTab = available[0];
      renderTabs(available);

      const options = (list, selected) => list.map((c) =>
        `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(window.SiloChart.columnLabel(c.name, semantics))}</option>`).join('');

      const shaped = rows ? window.SiloChart.shape(rows, cfg, semantics) : null;
      const activeX = shaped ? shaped.xField : cfg.x_field;
      const activeY = shaped ? shaped.yField : cfg.y_field;
      const activeMeasures = (Array.isArray(cfg.measures) && cfg.measures.length
        ? cfg.measures
        : [activeY]).filter(Boolean);
      const measureSemantic = activeMeasures[0] ? semantics[activeMeasures[0]] : null;
      const aggNow = window.SiloChart.AGGREGATES.includes(cfg.aggregate)
        ? cfg.aggregate
        : window.SiloChart.defaultAggregate(measureSemantic);

      const SEMANTIC_LABEL = {
        currency: 'Currency ($)', count: 'Whole count', number: 'Number',
        percent: 'Percentage (%)', date: 'Date', category: 'Category', boolean: 'True/false',
        link: 'Link', image: 'Image',
      };

      // ── Data ───────────────────────────────────────────────────────────
      const sourceBlock = `
        <div class="v3-insp-source">
          <span class="bcn-label">Source report</span>
          <div class="v3-insp-source-name">${esc(w.report_title || (isSection ? 'None — a section is a heading' : '(report unavailable)'))}</div>
          ${w.report_id ? `
            <!-- The tile is where you NOTICE a report is wrong -- a column
                 labelled with its raw alias, a figure formatted as the wrong
                 type, a hardcoded date. Editing it from here is what stops
                 the fix being "save a second report". Opens the workbench;
                 whether it saves over the original or forks is decided
                 there, by RLS. -->
            <a class="v3-insp-source-edit" href="/v3/report-builder.html?id=${esc(w.report_id)}">
              Edit this report →</a>` : ''}
          ${(!isAnswer && w.report_query_count > 1) ? `
            <label class="bcn-label" for="inspQueryIndex" style="margin-top:8px">Query ${w.query_index + 1} of ${w.report_query_count}</label>
            <select class="bcn-field" id="inspQueryIndex">
              ${Array.from({ length: w.report_query_count }, (_, i) =>
                `<option value="${i}"${i === w.query_index ? ' selected' : ''}>Query ${i + 1}</option>`).join('')}
            </select>
            <span class="v3-insp-hint">This report ran ${w.report_query_count} queries and a widget draws one.
              Switching re-reads the report — the other widgets built on its other queries are untouched.</span>` : ''}
        </div>`;

      const dataBlock = isSection
        ? `<div class="bcn-field-group">
             <label class="bcn-label" for="inspNote">Standfirst (optional)</label>
             <input class="bcn-field" id="inspNote" type="text" value="${esc(cfg.note || '')}"
                    placeholder="One line under the heading" />
           </div>`
        : isAnswer
        ? `<div class="v3-insp-note">This widget renders the report's saved answer text — no query, no columns,
             nothing to configure here. The wording isn't editable once saved; ask Ask SILO the question again
             and save a fresh report if it needs correcting.</div>`
        : !rows
        ? `<div class="v3-insp-note">No data loaded for this widget yet, so there are no fields to configure.
             If the tile shows an error, fix that first — the columns come from what the query actually returned.</div>`
        : `
        ${isChart || isWaterfall ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspX">Dimension</label>
          <select class="bcn-field" id="inspX">${options(dims.length ? dims : prof, activeX)}</select>
        </div>` : ''}
        ${isGrid2d ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspRow">Rows (down)</label>
          <select class="bcn-field" id="inspRow">${options(dims.length ? dims : prof, cfg.row_field || (dims[0] || {}).name)}</select>
        </div>
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspX">Columns (across)</label>
          <select class="bcn-field" id="inspX">${options(dims.length ? dims : prof, cfg.x_field)}</select>
        </div>
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspY">Cell value</label>
          <select class="bcn-field" id="inspY">${options(meas.length ? meas : prof, cfg.y_field)}</select>
        </div>
        <p class="v3-insp-hint">Rows and columns keep the order the query returned them in, so a
          statement stays in statement order. An empty cell means no row for that pair — not zero.</p>` : ''}
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
        ${w.visual_type === 'combo' && activeMeasures.length > 1 ? `
        <div class="bcn-field-group">
          <span class="bcn-label">Draw as a line</span>
          <div class="v3-measures">
            ${activeMeasures.map((m) => `
              <label class="rb-col${(cfg.line_measures || []).includes(m) ? ' is-on' : ''}">
                <input type="checkbox" data-line-measure="${esc(m)}" ${(cfg.line_measures || []).includes(m) ? 'checked' : ''} />
                ${esc(m)}
              </label>`).join('')}
          </div>
          <span class="v3-insp-hint">Name the measure that is the reference line — a target, a budget, a rate.
            Without this, a measure only becomes a line when its scale forces it onto the right-hand axis.</span>
        </div>` : ''}
        ${(w.visual_type === 'kpi' || w.visual_type === 'table') ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspY">${w.visual_type === 'table' ? 'Sort by (measure)' : 'Measure'}</label>
          <select class="bcn-field" id="inspY">
            ${w.visual_type === 'table' ? '<option value="">—</option>' : ''}
            ${w.visual_type === 'kpi' && !cfg.y_field && meas.length > 1
              ? '<option value="" selected>Choose a measure…</option>' : ''}
            ${options(meas.length ? meas : prof, activeY)}
          </select>
          ${w.visual_type === 'kpi' && !cfg.y_field && meas.length > 1 ? `
          <span class="v3-insp-hint v3-insp-hint--warn">This card has ${meas.length} numeric columns and no measure chosen,
            so it is not showing a number. Pick the one the title claims — the title is not used to guess it.</span>` : ''}
        </div>` : ''}
        ${(isChart || isGrid2d || w.visual_type === 'kpi' || isWaterfall) ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspAgg">Aggregation</label>
          <select class="bcn-field" id="inspAgg">
            ${window.SiloChart.AGGREGATES.map((a) =>
              `<option value="${a}"${aggNow === a ? ' selected' : ''}>${a === 'none' ? 'none (plot every row)' : a}</option>`).join('')}
          </select>
          <span class="v3-insp-hint">${isChart || isGrid2d
            ? 'Rows sharing a dimension value are rolled up before sorting and limiting. Leave on sum unless the query already aggregated.'
            : `${rows.length} row${rows.length === 1 ? '' : 's'} in this dataset. A rate is pooled from its numerator and denominator where the report returns them, never averaged.`}</span>
        </div>` : ''}
        ${(w.visual_type !== 'kpi' && !isWaterfall) ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspSort">Sort</label>
          <select class="bcn-field" id="inspSort">
            ${SORTS.map((sOpt) => `<option value="${sOpt.id}"${(cfg.sort || 'desc') === sOpt.id ? ' selected' : ''}>${sOpt.label}</option>`).join('')}
          </select>
        </div>` : ''}
        ${isWaterfall ? `
        <p class="v3-insp-hint">A bridge keeps the query's own row order — the sequence is the explanation,
          so there is no sort here. A step whose label reads like a total (Total, Net, Gross Profit…) is drawn
          from zero rather than stacked.</p>` : ''}
        ${w.visual_type !== 'kpi' ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspLimit">Limit</label>
          <input class="bcn-field bcn-field--mono" id="inspLimit" type="number" min="0" step="1" value="${Number(cfg.limit) || 0}" />
          <span class="v3-insp-hint">0 shows everything the query returned. Sorting and limiting happen on the returned rows, not in SQL — the source query is still capped at 1,000 rows per page (a table widget offers "Load more" past that; other visuals do not).</span>
        </div>` : ''}`;

      // ── Visual ─────────────────────────────────────────────────────────
      // Only offer a visual that can actually draw THIS result. Listing
      // Heatmap for a one-dimension query produces a tile that says "needs
      // two dimensions", which is a worse answer than not offering it --
      // by then the person has already committed the tile.
      const visualChoices = VISUALS.concat(w.report_answer ? [ANSWER_VISUAL] : [])
        .map((v) => {
          const check = rows ? window.SiloChart.validateVisual(v.id, rows, cfg, semantics) : { ok: true };
          return Object.assign({}, v, { ok: v.id === 'answer' ? true : check.ok, why: check.reason });
        });
      const visualOpts = visualChoices.map((v) => `
        <label class="v3-visual-opt${w.visual_type === v.id ? ' is-active' : ''}${v.ok ? '' : ' is-disabled'}"
               ${v.ok ? '' : `title="Not available for this result: ${esc(v.why || '')}"`}>
          <input type="radio" name="visualType" value="${v.id}" ${w.visual_type === v.id ? 'checked' : ''} ${v.ok ? '' : 'disabled'} />
          <span class="v3-visual-label">${v.label}</span>
          <span class="v3-visual-hint">${v.ok ? v.hint : esc(v.why || 'not available here')}</span>
        </label>`).join('');

      const visualBlock = `
        ${w.visual_type === 'table' ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspTableLayout">Reading layout</label>
          <select class="bcn-field" id="inspTableLayout">
            <option value="">Table — compare rows and columns</option>
            <option value="summary"${cfg.table_layout === 'summary' ? ' selected' : ''}>Summary — read each result as a card</option>
          </select>
          <span class="v3-insp-hint">Summary uses the same live rows and selected columns. Long explanations wrap in full; no AI wording is generated.</span>
        </div>
        ${cfg.table_layout === 'summary' ? `<div class="bcn-field-group">
          <label class="bcn-label" for="inspSummaryHeading">Card heading</label>
          <select class="bcn-field" id="inspSummaryHeading"><option value="">First visible column</option>${options(prof, cfg.summary_heading)}</select>
          <span class="v3-insp-hint">Choose columns in Format. Use Report view to read the full cards without a fixed tile height.</span>
        </div>` : ''}` : ''}
        <div class="bcn-field-group">
          <span class="bcn-label">Visualization</span>
          <div class="v3-visual-opts">${visualOpts}</div>
        </div>
        ${(isChart || isWaterfall) && w.visual_type !== 'donut' ? `
        <label class="rb-col${cfg.show_values ? ' is-on' : ''}">
          <input type="checkbox" id="inspShowValues" ${cfg.show_values ? 'checked' : ''} />
          Show the value on each point
        </label>` : ''}
        ${w.visual_type === 'bar' ? `
        <label class="rb-col${cfg.stacked ? ' is-on' : ''}">
          <input type="checkbox" id="inspStacked" ${cfg.stacked ? 'checked' : ''} />
          Stack the bars
        </label>
        <span class="v3-insp-hint">Stacking is refused across measures that mean different things —
          dollars stacked on a ratio is a bar whose height is not a quantity.</span>` : ''}
        ${w.visual_type === 'kpi' ? `
        <label class="rb-col${cfg.sparkline ? ' is-on' : ''}">
          <input type="checkbox" id="inspSpark" ${cfg.sparkline ? 'checked' : ''} />
          Show a sparkline of the rows behind the number
        </label>
        <span class="v3-insp-hint">Drawn in the order the query returned the rows, so it only means
          something when that order is time.</span>` : ''}
        ${(isChart || isWaterfall || isGrid2d) ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspAxisLabel">Value axis label</label>
          <input class="bcn-field" id="inspAxisLabel" type="text" value="${esc(cfg.axis_label || '')}"
                 placeholder="Blank uses the measure's own name" />
        </div>` : ''}
        ${isChart && activeMeasures.length > 1 ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspLegend">Legend</label>
          <select class="bcn-field" id="inspLegend">
            <option value=""${!cfg.legend ? ' selected' : ''}>Show (default for multiple measures)</option>
            <option value="off"${cfg.legend === 'off' ? ' selected' : ''}>Hide</option>
          </select>
        </div>` : ''}`;

      // ── Format ─────────────────────────────────────────────────────────
      const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
      const formatBlock = `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspTitle">Widget title</label>
          <input class="bcn-field" id="inspTitle" type="text" value="${esc(w.title || '')}" />
        </div>
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
        ${w.visual_type === 'kpi' ? `
        <label class="rb-col${cfg.abbreviate ? ' is-on' : ''}">
          <input type="checkbox" id="inspAbbrev" ${cfg.abbreviate ? 'checked' : ''} />
          Abbreviate the number ($36.4M instead of $36,393,571)
        </label>
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspCompare">Compare against</label>
          <select class="bcn-field" id="inspCompare">
            <option value=""${!cfg.compare && !cfg.compare_field ? ' selected' : ''}>Nothing — just the number</option>
            <option value="__prev"${cfg.compare === 'previous_row' ? ' selected' : ''}>The previous row (last vs the one before)</option>
            ${(meas.length ? meas : prof).map((c) => `<option value="${esc(c.name)}"${cfg.compare_field === c.name ? ' selected' : ''}>${esc(window.SiloChart.columnLabel(c.name, semantics))}</option>`).join('')}
          </select>
          <span class="v3-insp-hint">A rate's change is shown in percentage POINTS, with the relative change
            in brackets — 4% to 5% is +1pp, not +25%. A comparison with nothing to compare to says so instead
            of printing a number.</span>
        </div>
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspCompareLabel">Comparison label</label>
          <input class="bcn-field" id="inspCompareLabel" value="${esc(cfg.compare_label || '')}" placeholder="Uses the comparison column's label" />
          <span class="v3-insp-hint">For example, Previous month. Match the period the report actually returns; this does not change its calculation.</span>
        </div>` : ''}
        ${(w.visual_type === 'table' || isGrid2d) ? `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspTotals">Totals</label>
          <select class="bcn-field" id="inspTotals">
            <option value="">None</option>
            ${w.visual_type === 'table'
              ? `<option value="row"${cfg.totals === 'row' ? ' selected' : ''}>A total row at the bottom</option>`
              : `<option value="row"${cfg.totals === 'row' ? ' selected' : ''}>A total row</option>
                 <option value="column"${cfg.totals === 'column' ? ' selected' : ''}>A total column</option>
                 <option value="both"${cfg.totals === 'both' ? ' selected' : ''}>Both</option>`}
          </select>
          <span class="v3-insp-hint">Only currency, counts and plain numbers are totalled. A rate is pooled from
            its numerator and denominator where the report returns them, and otherwise left blank —
            summing or averaging rates gives a number that does not exist.</span>
        </div>` : ''}
        ${w.visual_type === 'table' && rows ? `
        <div class="bcn-field-group">
          <span class="bcn-label">Columns</span>
          <div class="v3-measures">
            ${prof.map((c) => {
              const chosen = Array.isArray(cfg.columns) && cfg.columns.length
                ? cfg.columns.includes(c.name) : true;
              return `<label class="rb-col${chosen ? ' is-on' : ''}">
                <input type="checkbox" data-col-show="${esc(c.name)}" ${chosen ? 'checked' : ''} />
                ${esc(window.SiloChart.columnLabel(c.name, semantics))}</label>`;
            }).join('')}
          </div>
          <span class="v3-insp-hint">Unticking hides a column here only — the report still returns it, and
            other widgets built on it are unaffected. Use the arrows to reorder.</span>
          ${Array.isArray(cfg.columns) && cfg.columns.length > 1 ? `
          <div class="v3-col-order">
            ${cfg.columns.map((name, i) => `
              <span class="v3-col-chip">
                <button type="button" class="v3-col-move" data-col-move="${esc(name)}" data-dir="-1"
                        ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(name)} left">◀</button>
                ${esc(window.SiloChart.columnLabel(name, semantics))}
                <button type="button" class="v3-col-move" data-col-move="${esc(name)}" data-dir="1"
                        ${i === cfg.columns.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(name)} right">▶</button>
              </span>`).join('')}
          </div>` : ''}
        </div>` : ''}
        ${w.visual_type === 'table' && rows ? `
        <div class="bcn-field-group">
          <span class="bcn-label">Conditional formatting</span>
          ${rules.length ? `<div class="v3-rules">${rules.map((r, i) => `
            <div class="v3-rule" data-rule="${i}">
              <span class="v3-rule-text">${esc(window.SiloChart.columnLabel(r.col, semantics))} ${esc(RULE_OPS[r.op] || r.op)}${
                r.op === 'between' ? ` ${esc(r.value)}–${esc(r.value2)}`
                : (r.value !== undefined && r.value !== '' ? ` ${esc(r.value)}` : '')} → ${esc(r.tone)}</span>
              <button type="button" class="dw-icon-btn" data-rule-remove="${i}" aria-label="Remove rule">✕</button>
            </div>`).join('')}</div>` : '<span class="v3-insp-hint">No rules — every cell is drawn the same.</span>'}
          <div class="v3-rule-add">
            <select class="bcn-field" id="ruleCol">${options(prof, prof[0] && prof[0].name)}</select>
            <select class="bcn-field" id="ruleOp">
              ${Object.entries(RULE_OPS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select>
            <input class="bcn-field bcn-field--mono" id="ruleValue" type="text" placeholder="value" />
            <select class="bcn-field" id="ruleTone">
              <option value="pos">green</option><option value="warn">amber</option><option value="neg">red</option>
            </select>
            <button type="button" class="bcn-btn bcn-btn--ghost" id="btnAddRule">Add</button>
          </div>
        </div>` : ''}`;

      // ── Interactions ───────────────────────────────────────────────────
      const paramKeys = runtime.widgetParamKeys(w.id);
      const boardKeys = runtime.parameterDeclarations().filter((d) => !d.conflict);
      const filterable = boardKeys.filter((d) => paramKeys.includes(d.key));
      const otherBoards = dashboardsForDrill;
      const interactionsBlock = `
        <div class="bcn-field-group">
          <span class="bcn-label">Dashboard filters</span>
          ${!boardKeys.length
            ? '<span class="v3-insp-hint">No report on this dashboard declares a parameter, so there are no dashboard filters to take part in.</span>'
            : filterable.length
              ? `<span class="v3-insp-hint">This widget reads ${filterable.map((d) => `<strong>${esc(d.label)}</strong>`).join(', ')}
                   and re-runs when ${filterable.length === 1 ? 'it changes' : 'any of them change'}.
                   ${boardKeys.length > filterable.length
                     ? `It ignores ${boardKeys.filter((d) => !paramKeys.includes(d.key)).map((d) => esc(d.label)).join(', ')} —
                        its report does not declare ${boardKeys.length - filterable.length === 1 ? 'that parameter' : 'those parameters'}.` : ''}</span>`
              : `<span class="v3-insp-hint v3-insp-hint--warn">This widget takes part in none of the dashboard's filters
                   (${boardKeys.map((d) => esc(d.label)).join(', ')}), so it does not change when they move — the tile
                   is marked "not filtered" for exactly that reason. Add a <code>{{token}}</code> to its report to
                   make it participate.</span>`}
        </div>
        ${isAnswer || isSection ? '' : `
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspCrossFilter">Clicking a value filters the dashboard by</label>
          <select class="bcn-field" id="inspCrossFilter">
            <option value=""${!cfg.cross_filter ? ' selected' : ''}>Nothing — clicks do not filter</option>
            ${boardKeys.map((d) => `<option value="${esc(d.key)}"${cfg.cross_filter === d.key ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
          </select>
          <span class="v3-insp-hint">${boardKeys.length
            ? 'Only parameters some report on this board declares are offered — filtering on anything else would change nothing. Clicking the selected value again clears it.'
            : 'Nothing is offered because no report here declares a parameter. Cross-filtering re-runs the other tiles\\u2019 queries; it never hides rows in one tile while another keeps its total.'}</span>
        </div>
        <div class="bcn-field-group">
          <label class="bcn-label" for="inspDrillTo">Clicking a value opens</label>
          <select class="bcn-field" id="inspDrillTo">
            <option value=""${!cfg.drill_to ? ' selected' : ''}>Nothing — stay here</option>
            ${otherBoards.map((d) => `<option value="${esc(d.id)}"${cfg.drill_to === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select>
          ${cfg.drill_to ? `
          <label class="bcn-label" for="inspDrillKey" style="margin-top:8px">…carrying the clicked value as</label>
          <select class="bcn-field" id="inspDrillKey">
            <option value=""${!cfg.drill_key ? ' selected' : ''}>Just the current filters</option>
            ${boardKeys.map((d) => `<option value="${esc(d.key)}"${cfg.drill_key === d.key ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
          </select>` : ''}
          <span class="v3-insp-hint">The destination gets every filter currently applied here, so the numbers
            there reconcile with the one that was clicked. Only dashboards you can open are listed — a
            destination you cannot see is not offered, and following a link to one still goes through its own
            RLS.</span>
        </div>`}`;

      const bodies = {
        data: sourceBlock + dataBlock,
        visual: visualBlock,
        format: formatBlock,
        interactions: interactionsBlock,
      };

      el('inspectorBody').innerHTML = `
        ${bodies[activeTab] || ''}
        <div class="v3-insp-actions">
          <button type="button" class="bcn-btn bcn-btn--ghost" id="inspDuplicate">Duplicate</button>
          <button type="button" class="bcn-btn bcn-btn--danger" id="inspRemove">Remove widget</button>
        </div>`;
    }

    /**
     * Copy a widget, config and all, and drop it beside the original.
     *
     * The common case this exists for is "the same table, one column
     * different" and "this KPI, but for the other measure" -- both of which
     * were previously a re-add from the picker plus retyping every setting.
     * A new id is minted so the buffered upsert treats it as a new row; the
     * copy is NOT saved until Save, exactly like every other edit.
     */
    function duplicateWidget(id) {
      const w = runtime.getWidgets().find((x) => x.id === id);
      if (!w) return;
      const geo = runtime.layout().get(id) || w.layout || {};
      const copy = Object.assign({}, w, {
        id: uid(),
        // Deep-copied: the two widgets must not share a config object, or
        // editing one would silently change the other.
        visual_config: JSON.parse(JSON.stringify(w.visual_config || {})),
        title: w.title ? `${w.title} (copy)` : w.title,
        // Directly below, full width of the original: GridStack finds it a
        // real slot from there, and "below" is where a person looks for
        // something they just duplicated.
        layout: { x: geo.x || 0, y: (geo.y || 0) + (geo.h || 4), w: geo.w || 6, h: geo.h || 4 },
        sort_order: runtime.getWidgets().length,
        _new: true,
      });
      delete copy.created_at;
      delete copy.updated_at;
      markDirty();
      runtime.addWidget(copy).then(() => {
        onWidgetsChange();
        openInspector(copy.id);
        setStatus(`Duplicated "${w.title || w.report_title || 'widget'}". It is not saved until you Save.`, 'info', 5000);
      });
    }

    /** Dashboards offered as drill-through destinations. RLS-scoped. */
    async function loadDrillTargets() {
      const { data } = await sb.from('dashboards_v').select('id, name').order('name');
      dashboardsForDrill = (data || []).filter((d) => d.id !== dashboard.id);
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
        const useAnswer = e.target.closest('[data-act="use-answer"]');
        if (useAnswer && pickedReport) addAnswerWidgetFromReport(pickedReport);
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
        else if (e.target.closest('[data-act="duplicate"]')) duplicateWidget(id);
        else if (e.target.closest('[data-act="remove"]')) removeWidget(id);
      });

      el('inspectorTabs').addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;
        activeTab = tab.dataset.tab;
        renderInspector();
      });

      el('inspector').addEventListener('click', (e) => {
        if (e.target.closest('#btnCloseInspector')) { closeInspector(); return; }
        if (e.target.closest('#inspRemove')) { removeWidget(inspectingId); return; }
        if (e.target.closest('#inspDuplicate')) { duplicateWidget(inspectingId); return; }
        const del = e.target.closest('[data-rule-remove]');
        if (del) {
          const w = runtime.getWidgets().find((x) => x.id === inspectingId);
          const rules = (w && Array.isArray(w.visual_config?.rules) ? w.visual_config.rules : []).slice();
          rules.splice(Number(del.dataset.ruleRemove), 1);
          patchConfig({ rules: rules.length ? rules : undefined });
          renderInspector();
          return;
        }
        if (e.target.closest('#btnAddRule')) {
          const col = el('ruleCol').value;
          const op = el('ruleOp').value;
          const raw = (el('ruleValue').value || '').trim();
          // An operator that needs a threshold and has none would match
          // every row or none of them; either way the rule is not what the
          // person meant, so it is refused rather than added.
          const needsValue = !['negative', 'positive', 'empty'].includes(op);
          if (needsValue && raw === '') {
            setStatus('That rule needs a value to compare against.', 'neg', 4000);
            return;
          }
          const w = runtime.getWidgets().find((x) => x.id === inspectingId);
          const rules = (w && Array.isArray(w.visual_config?.rules) ? w.visual_config.rules : []).slice();
          const parts = raw.split(/\s*[-–,]\s*/);
          rules.push(op === 'between'
            ? { col, op, value: parts[0], value2: parts[1], tone: el('ruleTone').value }
            : { col, op, value: raw, tone: el('ruleTone').value });
          patchConfig({ rules });
          renderInspector();
          return;
        }
        const move = e.target.closest('[data-col-move]');
        if (move) {
          const w = runtime.getWidgets().find((x) => x.id === inspectingId);
          const cols = (w && Array.isArray(w.visual_config?.columns) ? w.visual_config.columns : []).slice();
          const from = cols.indexOf(move.dataset.colMove);
          const to = from + Number(move.dataset.dir);
          if (from < 0 || to < 0 || to >= cols.length) return;
          cols.splice(to, 0, cols.splice(from, 1)[0]);
          patchConfig({ columns: cols });
          renderInspector();
        }
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
          // A KPI must never inherit its measure from a RECOMMENDATION.
          // The recommendation ranks columns (money, then counts, then
          // plain numbers) which is a fine default for a bar chart's y
          // axis and a wrong one for a single number under a title the
          // person wrote themselves. If the widget itself never carried a
          // measure, the KPI starts unset and says so on the tile.
          if (t.value === 'kpi' && !(w.visual_config || {}).y_field) delete merged.y_field;
          // A matrix and a heatmap need TWO dimensions, and the config
          // carried over from a one-dimension visual names only one. Fill
          // the second in from the data rather than leaving the tile
          // saying "needs two dimensions" over a result that has them.
          if ((t.value === 'matrix' || t.value === 'heatmap') && rows) {
            const dims = window.SiloChart.dimensionsOf(window.SiloChart.profileColumns(rows));
            if (!merged.row_field) merged.row_field = (dims[0] || {}).name;
            if (!merged.x_field || merged.x_field === merged.row_field) {
              merged.x_field = (dims.find((d) => d.name !== merged.row_field) || {}).name;
            }
          }
          runtime.updateWidget(w.id, { visual_type: t.value, visual_config: merged });
          // A KPI is one number; leaving it in a full chart's footprint
          // wastes the canvas and reads as a broken chart. Only shrink a
          // tile that is still chart-sized, so a deliberately large KPI
          // stays large.
          // Constraints follow the visual, so they have to be applied
          // BEFORE the resize below -- a tile still carrying the table's
          // 3-row minimum cannot be shrunk to a KPI's 2.
          runtime.applyConstraints(runtime.getWidgets().find((x) => x.id === w.id));
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
        if (t.dataset.colShow !== undefined) {
          // `cfg` and `prof` are locals of renderInspector(), not of this
          // handler -- reading them here threw a ReferenceError and the
          // column checkbox silently did nothing. Read them from the widget
          // and its live rows instead, which is what the inspector renders
          // from anyway.
          const cfgNow = w.visual_config || {};
          const rowsNow = runtime.rowsFor(w.id) || [];
          const profNow = window.SiloChart.profileColumns(rowsNow);
          // Start from what is currently shown so unticking one column does
          // not silently reorder or drop the rest.
          const current = (Array.isArray(cfgNow.columns) && cfgNow.columns.length)
            ? cfgNow.columns.slice()
            : profNow.map((c) => c.name);
          const name = t.dataset.colShow;
          const next = t.checked
            ? (current.includes(name) ? current
               : profNow.map((c) => c.name).filter((n) => current.includes(n) || n === name))
            : current.filter((n) => n !== name);
          patchConfig({ columns: next.length ? next : undefined });
          renderInspector();
          return;
        }
        if (t.dataset.lineMeasure !== undefined) {
          const cur = Array.isArray(w.visual_config?.line_measures) ? w.visual_config.line_measures.slice() : [];
          const name = t.dataset.lineMeasure;
          const next = cur.includes(name) ? cur.filter((x) => x !== name) : cur.concat(name);
          patchConfig({ line_measures: next.length ? next : undefined });
          renderInspector();
          return;
        }
        if (t.id === 'inspNote') patchConfig({ note: t.value || undefined });
        else if (t.id === 'inspTableLayout') { patchConfig({ table_layout: t.value || undefined }); renderInspector(); }
        else if (t.id === 'inspSummaryHeading') patchConfig({ summary_heading: t.value || undefined });
        else if (t.id === 'inspCompareLabel') patchConfig({ compare_label: t.value || undefined });
        else if (t.id === 'inspSpark') patchConfig({ sparkline: t.checked || undefined });
        else if (t.id === 'inspAxisLabel') patchConfig({ axis_label: t.value || undefined });
        else if (t.id === 'inspLegend') patchConfig({ legend: t.value || undefined });
        else if (t.id === 'inspCrossFilter') patchConfig({ cross_filter: t.value || undefined });
        else if (t.id === 'inspDrillTo') { patchConfig({ drill_to: t.value || undefined }); renderInspector(); }
        else if (t.id === 'inspDrillKey') patchConfig({ drill_key: t.value || undefined });
        else if (t.id === 'inspTotals') patchConfig({ totals: t.value || undefined });
        else if (t.id === 'inspShowValues') patchConfig({ show_values: t.checked || undefined });
        else if (t.id === 'inspStacked') patchConfig({ stacked: t.checked || undefined });
        else if (t.id === 'inspAbbrev') patchConfig({ abbreviate: t.checked || undefined });
        else if (t.id === 'inspCompare') {
          patchConfig(t.value === '__prev'
            ? { compare: 'previous_row', compare_field: undefined }
            : { compare: undefined, compare_field: t.value || undefined });
        }
        else if (t.id === 'inspRow') patchConfig({ row_field: t.value });
        else if (t.id === 'inspX') patchConfig({ x_field: t.value });
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
        const tile = el('grid').querySelector(`.dw[data-widget-id="${CSS.escape(inspectingId)}"]`);
        // A section's heading IS its title, so it lives in a different
        // element from an ordinary tile's.
        const target = tile && (tile.querySelector('.dw-title') || tile.querySelector('.dw-section-title'));
        if (target && w) target.textContent = w.title || w.report_title || 'Untitled';
        el('inspectorHeading').textContent = w.visual_type === 'section' ? 'Section' : (w.title || w.report_title || 'Widget');
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
        .select(REPORT_FIELDS)
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
    // Fire and forget: the drill-through list is only read when someone
    // opens the Interactions tab, and a dashboard that fails to load its
    // sibling list should still be editable.
    loadDrillTargets().catch(() => {});
    return {
      save, isDirty, openAddWidget, closeInspector, addReportById, addSection,
      duplicateWidget,
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
