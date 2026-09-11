/* ==========================================================================
   SILO v3 — dashboard renderer
   --------------------------------------------------------------------------
   Reads saved configuration and draws it. This file is the "runtime" half of
   the v3 idea: a dashboard is rows in `dashboards` / `dashboard_widgets`,
   never stored HTML, so changing a tile from a table to a bar chart is a
   config change that re-renders here rather than a new page someone has to
   write.

   It is used unchanged in both view and edit mode -- the builder layers
   interaction on top of this, it does not fork the drawing path. That is
   deliberate: the milestone is "save a dashboard, reload it identically",
   and two render paths is the usual way that stops being true.

   Data comes from chat_run_readonly_query which, despite the name, is a
   generic read-only SQL runner (SECURITY INVOKER, single SELECT/WITH,
   1000-row cap per page, 30s timeout) -- the same engine Ask SILO's
   "Refresh data" button uses. Zero LLM involvement, and a viewer can never
   see through a dashboard anything their own RLS would not already show
   them.

   Pagination (table widgets only): a query that fills a page is re-run with
   p_offset advanced by the page size, and the new rows are appended to what
   is already drawn -- never a fresh render, since that would lose scroll
   position and any in-progress reading. A chart draws once and does not
   offer "load more": a bar/line/donut/KPI/matrix is a computed shape over
   whatever page it got, and re-shaping it live while someone is looking at
   it would move the thing they were reading. The cap-hit note on those
   visuals still says to aggregate in the report itself.

   This file has no idea where a widget's report was authored. It reads
   `query_sql` and draws the result, so an Ask SILO save, a central SILO
   report definition and a hand-defined report all render identically.
   Keep it that way: source-specific behaviour belongs in the builder's
   picker, not here.

   Parameters (dashboard slicers) enter at exactly one point: resolveSql()
   turns a widget's stored SQL into the SQL that runs, substituting each
   {{token}} with a type-validated literal (see v3/js/report-params.js).
   Every fetch goes through it, and the data cache is keyed on the RESOLVED
   sql -- so two tiles on the same report and the same slicer values still
   cost one query, and moving a slicer misses the cache without anyone
   having to invalidate it by hand.
   ========================================================================== */
(function (global) {
  'use strict';

  const esc = (s) => window.SiloChart.esc(s);
  // Must match chat_run_readonly_query's per-page cap (20260904320000).
  const PAGE_CAP = 1000;

  // ── Reusable inner markup ────────────────────────────────────────────
  /* Full screen is offered on anything that draws -- a section is a
     heading and there is nothing to enlarge. It is present in VIEW mode
     too: reading one tile bigger is reading, not editing, the same stance
     slicers and pagination already take. */
  const canFullscreen = (w) => w.visual_type !== 'section';

  function headActionsHtml(widget, editable) {
    // In edit mode the visual type is the primary control, not a status
    // pill: it is a button that opens the inspector, with a caret so it
    // reads as "this changes". A plain pill next to a gear icon taught
    // people the type was informational and the gear was for "settings".
    const fs = canFullscreen(widget)
      ? `<button type="button" class="dw-icon-btn" data-act="fullscreen"
                 title="View full screen" aria-label="View ${esc(widget.title || widget.report_title || 'widget')} full screen">⤢</button>`
      : '';
    return editable
      ? `
        <button type="button" class="dw-type-badge dw-type-badge--btn" data-act="configure"
                title="Change visualization" aria-label="Change visualization, currently ${esc(widget.visual_type)}">
          ${esc(widget.visual_type)}<span class="dw-caret" aria-hidden="true">▾</span>
        </button>
        ${fs}
        <button type="button" class="dw-icon-btn" data-act="duplicate" title="Duplicate widget" aria-label="Duplicate widget">⧉</button>
        <button type="button" class="dw-icon-btn" data-act="remove" title="Remove widget" aria-label="Remove widget">✕</button>`
      : `
        <span class="dw-type-badge">${esc(widget.visual_type)}</span>
        ${fs}
        <button type="button" class="dw-icon-btn" data-act="reload" title="Refresh this widget" aria-label="Refresh this widget">↻</button>`;
  }

  function tileShell(widget, editable) {
    if (widget.visual_type === 'section') {
      // The collapse control is view-mode only. Collapsing detaches tiles
      // from the grid, and doing that while someone is dragging is how a
      // layout gets saved in a shape nobody arranged -- entering edit mode
      // expands everything first for exactly that reason.
      const collapse = editable ? '' : `
            <button type="button" class="dw-icon-btn dw-collapse" data-act="collapse"
                    aria-expanded="true" title="Collapse this section"
                    aria-label="Collapse ${esc(widget.title || 'section')}">▾</button>`;
      return `
      <div class="dw dw--section" data-widget-id="${esc(widget.id)}">
        <header class="dw-head dw-head--section">
          <div class="dw-head-text"><span class="dw-section-title">${esc(widget.title || '')}</span></div>
          <div class="dw-head-actions">${collapse}${editable
            ? `<button type="button" class="dw-type-badge dw-type-badge--btn" data-act="configure"
                       title="Edit this section">section<span class="dw-caret" aria-hidden="true">▾</span></button>
               <button type="button" class="dw-icon-btn" data-act="duplicate" aria-label="Duplicate section">⧉</button>
               <button type="button" class="dw-icon-btn" data-act="remove" aria-label="Remove section">✕</button>`
            : ''}</div>
        </header>
        <div class="dw-body dw-body--section" data-role="body"></div>
        <footer class="dw-foot" data-role="foot" hidden></footer>
      </div>`;
    }
    const title = widget.title || widget.report_title || 'Untitled';
    const sub = widget.report_title && widget.title && widget.title !== widget.report_title
      ? widget.report_title : '';
    return `
      <div class="dw" data-widget-id="${esc(widget.id)}">
        <header class="dw-head">
          <div class="dw-head-text">
            <span class="dw-title">${esc(title)}</span>
            ${sub ? `<span class="dw-sub">${esc(sub)}</span>` : ''}
          </div>
          <div class="dw-head-actions">${headActionsHtml(widget, editable)}</div>
        </header>
        <div class="dw-body" data-role="body"><div class="dw-loading">Loading…</div></div>
        <footer class="dw-foot" data-role="foot"></footer>
      </div>`;
  }

  function createRuntime(options) {
    const sb = options.sb;
    const gridEl = options.gridEl;
    // Mutable, not fixed at construction: toggling Edit must not tear down
    // and rebuild the runtime, or every tile would refetch its query just
    // to gain a drag handle.
    let editable = !!options.editable;
    const onLayoutChange = options.onLayoutChange || function () {};
    /** Called when a reader clicks a point or a dimension cell. The page
        turns it into a filter or a drill-through; the renderer has no
        opinion about which. */
    const onPointClick = options.onPointClick || function () {};

    let grid = null;
    let widgets = [];
    /** RESOLVED sql -> { rows } | { error } — one fetch per distinct SQL per
        refresh, so two tiles reading the same report cost one query.
        Keyed on the resolved SQL, not the stored SQL, so two tiles on the
        same parameterised report still share a fetch while a slicer change
        naturally misses the cache instead of needing manual invalidation. */
    let dataCache = new Map();
    /** widget id -> { sql, rows, hasMore, loading }. Tracks pagination state
        for TABLE widgets only -- see the file header for why charts don't
        page. `rows` here is the full accumulated set across every page
        loaded so far; dataCache above holds one entry per individual page
        fetch, which is what actually dedupes two tiles sharing a report. */
    const pageState = new Map();
    /** widget id -> { search, sortCol, sortDir }. The READER's view of a
        table, never written back to visual_config: searching or re-sorting
        a table is reading, and an edit-mode reader should not be handed a
        dirty dashboard for having looked. */
    const tableView = new Map();
    /** Current slicer values, keyed by parameter key. Dashboard-level: one
        value per key, applied to every widget declaring it. */
    let paramValues = Object.assign({}, options.paramValues || {});
    let density = options.density === 'compact' ? 'compact' : 'comfortable';
    /** Section widget ids currently collapsed (view mode only). */
    const collapsed = new Set();
    /** Geometry as it was before the first collapse, so expanding restores
        exactly rather than leaving GridStack's compaction in place. */
    let preCollapseLayout = null;
    /** widget id -> echarts instance */
    const charts = new Map();
    let resizeObserver = null;
    // The grounded layer of field semantics, fetched once per tab. Started
    // here rather than awaited at call time so it overlaps the widget
    // queries instead of serialising behind them.
    const catalogIndexPromise = window.SiloFieldSemantics.loadCatalogIndex(sb);
    let catalogIndex = new Map();
    catalogIndexPromise.then((idx) => { catalogIndex = idx; });

    /* Two spacing modes, one grid. Compact is not a different layout --
       the same 12 columns and the same {x,y,w,h} -- only a shorter row and
       a tighter gutter, so a board saved in one density reloads identically
       in the other. That is why density is a per-reader localStorage
       preference and never touches `layout`. */
    const DENSITY = {
      comfortable: { cellHeight: 78, margin: 8 },
      compact: { cellHeight: 58, margin: 5 },
    };

    function initGrid() {
      const d = DENSITY[density] || DENSITY.comfortable;
      grid = GridStack.init({
        column: 12,
        cellHeight: d.cellHeight,
        margin: d.margin,
        float: false,
        animate: true,
        disableDrag: !editable,
        disableResize: !editable,
        handle: '.dw-head',
        // Below 700px a 6-of-12 tile is half a phone screen: axis labels
        // overlap the plot and a KPI clips mid-number. Collapse to a single
        // column so every tile gets full width and stacks.
        //
        // layout: 'list' governs a LIVE resize across the breakpoint, where
        // nodes already exist: it re-stacks them in (y, x) order instead of
        // scaling their 12-column positions down. It does NOT cover a page
        // LOADED narrow -- the collapse runs before any widget exists, so
        // columnChanged() returns early with no nodes -- which is what
        // stackForNarrowScreen() handles after the tiles are added.
        columnOpts: { breakpoints: [{ w: 700, c: 1 }], layout: 'list' },
      }, gridEl);

      grid.on('change', () => { if (editable) onLayoutChange(); });
      // Charts do not reflow on their own. A ResizeObserver on each body
      // catches every cause -- grid resize, sidebar drawer, window, the
      // browser zoom -- where listening to gridstack's resizestop alone
      // would miss most of them.
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target.closest('.dw')?.dataset.widgetId;
          const chart = id && charts.get(id);
          if (chart) chart.resize();
        }
      });
    }

    function disposeChart(id) {
      const c = charts.get(id);
      if (c) { c.dispose(); charts.delete(id); }
    }

    function tileEl(id) {
      return gridEl.querySelector(`.grid-stack-item[gs-id="${CSS.escape(id)}"]`);
    }

    // ── Parameters ─────────────────────────────────────────────────────
    /**
     * The SQL this widget should actually run: its stored SQL with every
     * {{token}} replaced by a type-validated literal.
     *
     * Returns { sql } or { error }. A report with no tokens comes straight
     * back, so an unparameterised dashboard costs nothing and behaves
     * exactly as it did before parameters existed.
     */
    function resolveSql(widget) {
      return window.SiloReportParams.substitute(
        widget.query_sql, widget.report_parameters, paramValues);
    }

    /** Which parameters this dashboard's widgets actually read. */
    function parameterDeclarations() {
      return window.SiloReportParams.mergeDeclarations(widgets);
    }

    function getParamValues() {
      return Object.assign({}, paramValues);
    }

    /**
     * Give every declared parameter a value in the map, taking the report's
     * own default where the dashboard has none.
     *
     * Without this the control and the query disagree the moment a
     * parameterised report is ADDED to a board: substitute() falls back to
     * the declaration's default, so the tile runs with (say) `today-27d`
     * while the header control renders blank -- a filter bar showing
     * nothing over results that are filtered. Seeding is deliberately
     * silent (no reload): it does not CHANGE what any tile ran, it records
     * what it ran with.
     *
     * @returns {boolean} true if anything was seeded.
     */
    function ensureParamDefaults() {
      const seeded = window.SiloReportParams.defaultsFor(parameterDeclarations(), paramValues);
      let changed = false;
      for (const [k, v] of Object.entries(seeded)) {
        if (paramValues[k] === undefined || paramValues[k] === '') { paramValues[k] = v; changed = true; }
      }
      return changed;
    }

    /**
     * Which widgets read a given parameter key, split into the ones a
     * change will actually move and the ones it will not.
     *
     * The filter bar needs both halves: "this control drives 6 of 9 tiles"
     * is the honest statement, and the three that ignore it have to be
     * marked on the tile rather than left looking stale. A section or an
     * answer widget is neither -- it has no query at all -- so it is
     * excluded from both counts rather than being reported as unsupported.
     */
    function participationFor(key) {
      const supported = [];
      const unsupported = [];
      for (const w of widgets) {
        if (w.visual_type === 'section' || w.visual_type === 'answer') continue;
        if (!w.query_sql) continue;
        const tokens = window.SiloReportParams.tokensIn(w.query_sql);
        (tokens.includes(key) ? supported : unsupported).push(w.id);
      }
      return { supported, unsupported };
    }

    /** Every parameter key a widget's own SQL reads. */
    function widgetParamKeys(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w || !w.query_sql) return [];
      return window.SiloReportParams.tokensIn(w.query_sql);
    }

    /**
     * Apply new slicer values and reload only what they change.
     *
     * Widgets that declare none of the changed keys are left alone: a date
     * slicer on a nine-tile board should not re-run the two tiles that do
     * not take a date.
     */
    function setParamValues(next) {
      const changed = new Set();
      const merged = Object.assign({}, paramValues);
      for (const [k, v] of Object.entries(next || {})) {
        if (String(merged[k] == null ? '' : merged[k]) !== String(v == null ? '' : v)) changed.add(k);
        merged[k] = v;
      }
      paramValues = merged;
      if (!changed.size) return Promise.resolve();
      const affected = widgets.filter((w) => {
        if (!w.query_sql) return false;
        return window.SiloReportParams.tokensIn(w.query_sql).some((k) => changed.has(k));
      });
      return Promise.all(affected.map(loadWidget));
    }

    // ── Data ───────────────────────────────────────────────────────────
    /** offset 0 is the common case and keys the cache exactly as before
        pagination existed, so an unparameterised, single-page dashboard
        costs nothing extra and shares its cache entry the same way it
        always has. Later pages get their own key -- they are a different
        query result, not a variant of the first page. */
    async function fetchQuery(sql, offset) {
      const key = offset ? `${sql} offset=${offset}` : sql;
      if (dataCache.has(key)) return dataCache.get(key);
      let entry;
      try {
        const { data, error } = await sb.rpc('chat_run_readonly_query', { query: sql, p_offset: offset || 0 });
        entry = error ? { error: error.message } : { rows: Array.isArray(data) ? data : [] };
      } catch (err) {
        entry = { error: err.message || String(err) };
      }
      dataCache.set(key, entry);
      return entry;
    }

    /**
     * What this widget's columns MEAN. Four layers, most authoritative
     * first: the widget's own override, the source report's saved
     * columns_metadata, the database's column types, then profiling +
     * name heuristics. The renderer resolves it once per draw and hands
     * the adapter a flat map -- the adapter never asks where a semantic
     * came from.
     */
    function semanticsFor(widget, rows) {
      const cfg = widget.visual_config || {};
      return window.SiloFieldSemantics.semanticMap(window.SiloChart.profileColumns(rows), {
        overrides: cfg.field_semantics,
        reportMetadata: widget.report_columns_metadata,
        catalogIndex,
      });
    }

    // ── Rendering one tile ─────────────────────────────────────────────
    function renderBody(widget, state) {
      const el = tileEl(widget.id);
      if (!el) return;
      const body = el.querySelector('[data-role="body"]');
      const foot = el.querySelector('[data-role="foot"]');
      disposeChart(widget.id);
      foot.textContent = '';

      // A skeleton rather than the word "Loading": a tile that keeps its
      // shape while it fetches does not make the whole board jump when six
      // of them land at slightly different times.
      if (state.loading) {
        body.innerHTML = `<div class="dw-skeleton" role="status" aria-live="polite">
            <span class="dw-skeleton-bar"></span><span class="dw-skeleton-bar"></span>
            <span class="dw-skeleton-bar"></span><span class="dw-sr-only">Loading…</span>
          </div>`;
        return;
      }

      if (state.notice) {
        body.innerHTML = `<div class="dw-empty dw-empty--warn">${esc(state.notice)}</div>`;
        return;
      }
      if (state.error) {
        // Naming the likely cause matters: a saved report's SQL can stop
        // working because the schema moved under it, and "column does not
        // exist" on its own reads like a bug in the dashboard.
        //
        // Retry is offered because a real share of these are a 30s timeout
        // or a dropped connection, and re-running is exactly what a person
        // does next. It bypasses the cache, so it is a genuine retry rather
        // than a redraw of the failure.
        const timedOut = /timeout|canceling statement/i.test(String(state.error));
        body.innerHTML = `<div class="dw-empty dw-empty--error">
            <strong>${timedOut ? 'This query ran out of time.' : 'Query failed.'}</strong> ${esc(state.error)}
            <span class="dw-empty-hint">${timedOut
              ? 'The runner stops a statement at 30 seconds. Narrowing the date range, or aggregating in the report itself, is usually the fix.'
              : "The saved report's SQL may no longer match the schema."}</span>
            <button type="button" class="bcn-btn bcn-btn--ghost dw-retry" data-act="retry">Retry</button>
          </div>`;
        return;
      }

      const rows = state.rows || [];
      const cfg = widget.visual_config || {};

      if (widget.visual_type === 'section') {
        // The widget's own title is the content; the shell already renders
        // it, so the body only carries an optional standfirst.
        body.innerHTML = cfg.note ? `<p class="dw-section-note">${esc(cfg.note)}</p>` : '';
        return;
      }
      if (widget.visual_type === 'answer') {
        // No query, no rows -- the widget's content is the report's saved
        // answer TEXT, not anything queries_run returned. loadWidget() never
        // fetches for this type; it either got here with report_answer set
        // or with a notice already rendered, so this is the only path left.
        body.innerHTML = '<p class="dw-saved-answer-note">Saved answer — wording does not update with filters or Refresh.</p>'
          + window.SiloChart.answerHtml(widget.report_answer);
        return;
      }
      if (!rows.length) {
        // "0 rows" alone reads as broken. Naming the filters that are
        // narrowing it is the difference between a bug report and a person
        // widening a date range.
        const keys = widget.query_sql ? window.SiloReportParams.tokensIn(widget.query_sql) : [];
        const applied = keys.filter((k) => paramValues[k] !== undefined && paramValues[k] !== '')
          .map((k) => `${k} = ${paramValues[k]}`);
        body.innerHTML = `<div class="dw-empty">
            <strong>No rows matched.</strong>
            <span class="dw-empty-hint">${applied.length
              ? `The query ran fine with ${esc(applied.join(', '))}. Widening a filter is the usual fix.`
              : 'The query ran fine and returned nothing — this report has no data for its own window.'}</span>
          </div>`;
        return;
      }

      const semantics = semanticsFor(widget, rows);

      if (widget.visual_type === 'table') {
        // The reader's own view of the table -- search text and the column
        // they clicked to sort by. Kept OUT of visual_config on purpose:
        // searching a table is reading, not editing, so it must not mark
        // the dashboard dirty or become everyone's saved position.
        const page = pageState.get(widget.id);
        const view = tableView.get(widget.id) || {};
        body.innerHTML = window.SiloChart.tableHtml(rows, cfg, semantics, {
          search: view.search || '',
          sortCol: view.sortCol || null,
          sortDir: view.sortDir || 'desc',
          totalRows: widget.report_row_estimate || null,
          hasMore: !!(page && page.hasMore),
        });
        // Pagination lives here, not in the cap-message block below: a table
        // is the one visual where "more" is just more rows in the same
        // shape, so it is the one visual that can offer to fetch them.
        if (page && page.hasMore) {
          foot.innerHTML = `<div class="dw-loadmore">
              <button type="button" class="bcn-btn bcn-btn--ghost" data-act="loadmore"
                      ${page.loading ? 'disabled' : ''}>${page.loading ? 'Loading…' : `Load next ${PAGE_CAP} rows`}</button>
              <span>${rows.length.toLocaleString()} loaded${
                widget.report_row_estimate ? ` of ${Number(widget.report_row_estimate).toLocaleString()}` : ' so far'}</span>
            </div>`;
        } else if (page && page.rows.length > PAGE_CAP) {
          // Pagination ran to completion. Say so once rather than the
          // footer just going quiet after two "loaded so far" updates,
          // which reads as broken -- did it stop, or is that everything?
          foot.textContent = `${rows.length.toLocaleString()} rows loaded — that's everything.`;
        }
      } else if (widget.visual_type === 'matrix') {
        body.innerHTML = window.SiloChart.matrixHtml(rows, cfg, semantics);
      } else if (widget.visual_type === 'kpi') {
        body.innerHTML = window.SiloChart.kpiHtml(rows, cfg, semantics);
      } else if (widget.visual_type === 'heatmap') {
        const grid2d = window.SiloChart.grid2dOf(rows, cfg, semantics);
        if (!grid2d) {
          body.innerHTML = `<div class="dw-empty">A heatmap needs two dimensions and a measure. ${editable ? 'Open the type badge to pick them.' : ''}</div>`;
          return;
        }
        body.innerHTML = '<div class="dw-chart" data-role="chart"></div>';
        const host = body.querySelector('[data-role="chart"]');
        const chart = echarts.init(host, null, { renderer: 'canvas' });
        chart.setOption(window.SiloChart.heatmapOption(grid2d, window.SiloChart.theme(), grid2d.semantic), true);
        charts.set(widget.id, chart);
        const missing = grid2d.rows.length * grid2d.cols.length - grid2d.data.length;
        foot.textContent = `${grid2d.rows.length} × ${grid2d.cols.length}`
          + (missing > 0 ? ` · ${missing} pair${missing === 1 ? '' : 's'} had no row — drawn as gaps, not zeros` : '');
      } else {
        // A result carrying jsonb columns cannot be charted at all -- there
        // is no axis in a nested object. Ask SILO produces this shape often
        // (json_agg / row_to_json reads well in prose), so say what is wrong
        // and where to fix it rather than drawing an empty chart.
        const prof = window.SiloChart.profileColumns(rows);
        const jsonCols = prof.filter((c) => c.type === 'json').map((c) => c.name);
        if (jsonCols.length) {
          body.innerHTML = `<div class="dw-empty dw-empty--warn">
              <strong>This report returns nested JSON, not rows.</strong>
              ${esc(jsonCols.join(', '))} ${jsonCols.length === 1 ? 'is an object' : 'are objects'}, so there is
              nothing for an axis to plot. Switch to Table to read it, or rebuild it as flat columns
              ${editable ? '<a href="/v3/report-builder.html">in the report builder</a>' : 'in the report builder'}.
            </div>`;
          return;
        }
        // Refuse before drawing, and say what is missing. A waterfall over
        // percentages or a combo with one measure produces a chart that
        // renders and lies; "needs two numeric columns" is a better tile.
        const valid = window.SiloChart.validateVisual(widget.visual_type, rows, cfg, semantics);
        if (!valid.ok) {
          body.innerHTML = `<div class="dw-empty dw-empty--warn">
              <strong>A ${esc(widget.visual_type)} ${esc(valid.reason)}.</strong>
              ${editable ? '<span class="dw-empty-hint">Pick a different visual from the type badge, or change the report.</span>' : ''}
            </div>`;
          return;
        }
        // A bridge is its SEQUENCE: sorting a waterfall by size destroys
        // the one thing it is for, so the query's own order is forced here
        // rather than left to a config that defaults to 'desc'.
        const drawCfg = widget.visual_type === 'waterfall'
          ? Object.assign({}, cfg, { sort: 'none' }) : cfg;
        const shaped = window.SiloChart.shape(rows, drawCfg, semantics);
        if (!shaped) {
          body.innerHTML = `<div class="dw-empty">This visual needs a dimension and a measure. ${editable ? 'Open the type badge to pick them.' : ''}</div>`;
          return;
        }
        body.innerHTML = '<div class="dw-chart" data-role="chart"></div>';
        const host = body.querySelector('[data-role="chart"]');
        const chart = echarts.init(host, null, { renderer: 'canvas' });
        chart.setOption(window.SiloChart.optionFor(widget.visual_type, shaped, drawCfg), true);
        // Click-to-filter and drill-through both start here: a click on a
        // point hands the page the dimension VALUE it was drawn from. The
        // page decides what that means -- neither is a chart concern.
        chart.on('click', (p) => {
          onPointClick(widget, { field: shaped.xField, value: shaped.points[p.dataIndex] ? shaped.points[p.dataIndex].label : p.name });
        });
        charts.set(widget.id, chart);
        // Say what the chart is actually showing. Grouping is invisible
        // otherwise: "top 10 of 46" reads very differently once you know
        // those 46 were rolled up from 1,204 rows.
        const parts = [];
        if (shaped.truncated) parts.push(`Top ${shaped.points.length} of ${shaped.totalRows}`);
        if (shaped.aggregatedFrom) {
          parts.push(`${shaped.aggregate} of ${shaped.yField} over ${shaped.aggregatedFrom.toLocaleString()} rows`);
        }
        // A ratio that had to be averaged rather than pooled says so. A
        // mis-weighted number that does not admit it is mis-weighted is the
        // thing the metric layer exists to prevent.
        if (shaped.ratioNote) parts.push(shaped.ratioNote);
        foot.textContent = parts.join(' · ');
      }

      // PAGE_CAP is the query runner's hard cap per page. A chart cannot
      // page (see the file header), so it still just says so; a table gets
      // the Load more control above instead of this note.
      if (widget.visual_type !== 'table' && rows.length >= PAGE_CAP) {
        foot.textContent = (foot.textContent ? foot.textContent + ' · ' : '')
          + `Source query hit the ${PAGE_CAP}-row cap — aggregate in the report itself for a complete picture.`;
      }
      if (resizeObserver) resizeObserver.observe(body);
    }

    async function loadWidget(widget) {
      // A section is a heading, not a query. It short-circuits before every
      // report check below -- otherwise the "no saved report attached"
      // notice would fire on a tile that correctly has none.
      if (widget.visual_type === 'section') { renderBody(widget, { rows: [] }); return; }
      // An answer widget needs report_answer, never query_sql -- it has to
      // short-circuit before the query_sql check below, which would
      // otherwise fire "no stored SQL to run" on a widget that was never
      // supposed to run one.
      if (widget.visual_type === 'answer') {
        if (!widget.report_id) {
          renderBody(widget, { notice: 'No saved report attached to this widget.' });
          return;
        }
        if (!widget.report_answer) {
          // Same ambiguity as the query_sql check below: dashboard_widgets_v
          // is security_invoker, so a private report belonging to someone
          // else yields null here too -- and a manual/system report never
          // had answer text to begin with. Both read identically from here.
          renderBody(widget, {
            notice: widget.report_title
              ? `"${widget.report_title}" has no saved answer text — it may be private to someone else, or it was built as a manual/system report rather than asked in chat.`
              : 'The source report was deleted, or it is private to someone else.',
          });
          return;
        }
        renderBody(widget, { rows: [] });
        return;
      }
      if (!widget.report_id) {
        renderBody(widget, { notice: 'No saved report attached to this widget.' });
        return;
      }
      if (!widget.query_sql) {
        // dashboard_widgets_v is security_invoker, so a private report
        // belonging to someone else comes back with a null query_sql
        // rather than leaking its SQL. Both causes look identical from
        // here, so the message names both instead of guessing.
        renderBody(widget, {
          notice: widget.report_query_count === 0 && widget.report_title
            ? `"${widget.report_title}" has no stored SQL to run.`
            : 'The source report was deleted, or it is private to someone else.',
        });
        return;
      }
      // Substitution failures are AUTHORING errors -- an undeclared token, a
      // value that is not a date -- so they are reported on the tile rather
      // than sent to Postgres to come back as a syntax error nobody can act
      // on. Nothing runs until the SQL is fully resolved.
      const resolved = resolveSql(widget);
      if (resolved.error) {
        renderBody(widget, { notice: resolved.error });
        return;
      }
      renderBody(widget, { loading: true });
      const [entry] = await Promise.all([fetchQuery(resolved.sql, 0), catalogIndexPromise]);
      // Every fresh load starts pagination over at page 1 -- a stale
      // "load more" from a previous slicer value or refresh would otherwise
      // point at an offset that no longer matches this query.
      if (entry.error) {
        pageState.delete(widget.id);
      } else {
        // A search typed against last week's rows must not survive into a
        // different query's results -- it would silently hide rows the new
        // filter legitimately returned.
        tableView.delete(widget.id);
        pageState.set(widget.id, {
          sql: resolved.sql, rows: entry.rows || [], hasMore: (entry.rows || []).length >= PAGE_CAP, loading: false,
        });
      }
      renderBody(widget, entry);
    }

    /**
     * Fetch the next page for a TABLE widget already showing a full page,
     * and append it. Table-only: see the file header for why charts do not
     * get this. Appends rather than re-rendering from scratch so a reader
     * mid-scroll does not lose their place.
     */
    async function loadMoreWidget(id) {
      const widget = widgets.find((w) => w.id === id);
      const page = pageState.get(id);
      if (!widget || !page || !page.hasMore || page.loading) return;
      page.loading = true;
      renderBody(widget, { rows: page.rows });
      const entry = await fetchQuery(page.sql, page.rows.length);
      page.loading = false;
      if (entry.error) {
        // Keep what is already shown; the button just goes back to its
        // normal state so the reader can retry rather than losing the page.
        renderBody(widget, { rows: page.rows });
        return;
      }
      const newRows = entry.rows || [];
      page.rows = page.rows.concat(newRows);
      page.hasMore = newRows.length >= PAGE_CAP;
      renderBody(widget, { rows: page.rows });
    }

    // ── Public surface ─────────────────────────────────────────────────
    /**
     * Minimum tile height, in grid rows.
     *
     * A section is a one-row heading; every other visual needs room to draw.
     * This was a flat gs-min-h of 2 for everything, which silently broke
     * every section on a board: GridStack cannot honour a height below the
     * minimum, so an h=1 section was resized to 2 and the resulting
     * collisions reflowed it -- on the Logistics board two of the three
     * headings ended up stacked at the very bottom, under the last tile.
     */
    const minHeightFor = (w) => (w && w.visual_type === 'section' ? 1 : (SIZE[w.visual_type] || SIZE._default).minH);

    /**
     * Per-visual size constraints, and the size a fresh tile is given.
     *
     * These are not aesthetics. A donut in a 2x2 box is a ring of unreadable
     * labels; a matrix in one that narrow paints its row labels over the
     * first data column (the trap dashboard.css already documents); a KPI
     * dragged to 6x5 reads as a chart that failed to draw. The minimums are
     * the smallest box in which each visual is still honest, and GridStack
     * enforces them on drag as well as on load.
     */
    const SIZE = {
      _default: { minW: 2, minH: 2, w: 6, h: 4 },
      kpi: { minW: 2, minH: 2, w: 3, h: 2 },
      section: { minW: 3, minH: 1, w: 12, h: 1 },
      donut: { minW: 3, minH: 3, w: 4, h: 4 },
      table: { minW: 3, minH: 3, w: 6, h: 4 },
      matrix: { minW: 4, minH: 3, w: 8, h: 5 },
      heatmap: { minW: 4, minH: 3, w: 8, h: 5 },
      waterfall: { minW: 4, minH: 3, w: 8, h: 4 },
      combo: { minW: 4, minH: 3, w: 8, h: 4 },
      answer: { minW: 3, minH: 3, w: 6, h: 5 },
    };
    const sizeFor = (type) => SIZE[type] || SIZE._default;
    const minWidthFor = (w) => sizeFor(w && w.visual_type).minW;

    function setWidgets(next) {
      if (!grid) initGrid();
      for (const id of Array.from(charts.keys())) disposeChart(id);
      if (resizeObserver) resizeObserver.disconnect();
      grid.removeAll();
      widgets = (next || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      /* DOM order is READING order -- top to bottom, then left to right --
         not sort_order. On the desktop it makes no difference: every item
         carries an explicit gs-x/gs-y. It decides two other things:
         GridStack's single-column collapse (layout:'list' above follows the
         DOM), and tab order, which should walk a board the way a person
         reads it. sort_order only tracks the order tiles were ADDED and
         drifts from the arrangement the moment anything is dragged. */
      const inReadingOrder = widgets.slice().sort((a, b) => {
        const la = a.layout || {}; const lb = b.layout || {};
        return (la.y ?? 0) - (lb.y ?? 0) || (la.x ?? 0) - (lb.x ?? 0)
          || (a.sort_order || 0) - (b.sort_order || 0);
      });

      for (const w of inReadingOrder) {
        const lay = w.layout || {};
        const el = document.createElement('div');
        el.className = 'grid-stack-item';
        el.setAttribute('gs-id', w.id);
        el.setAttribute('gs-x', String(lay.x ?? 0));
        el.setAttribute('gs-y', String(lay.y ?? 0));
        el.setAttribute('gs-w', String(lay.w ?? 6));
        el.setAttribute('gs-h', String(lay.h ?? 4));
        el.setAttribute('gs-min-w', String(minWidthFor(w)));
        el.setAttribute('gs-min-h', String(minHeightFor(w)));
        el.innerHTML = `<div class="grid-stack-item-content">${tileShell(w, editable)}</div>`;
        gridEl.appendChild(el);
        grid.makeWidget(el);
      }
      collapsed.clear();
      preCollapseLayout = null;
      stackForNarrowScreen(inReadingOrder);
      return Promise.all(widgets.map(loadWidget));
    }

    /**
     * Put a collapsed (single-column) grid into reading order.
     *
     * GridStack's own breakpoint collapse cannot help here: it runs at init,
     * BEFORE any widget exists, so `columnChanged` returns early with no
     * nodes and `columnOpts.layout` never applies. Each tile is then simply
     * ADDED at its 12-column y, and every collision pushes the tile already
     * there downward -- which inverts the board. Measured on a real one:
     * a section, two KPIs and a chart on the same row came out section,
     * chart, KPI-2, KPI-1, so the phone read the row backwards.
     *
     * Placing them explicitly is safe because `layout()` refuses to
     * serialise a collapsed grid: this can move tiles on a phone and can
     * never write that arrangement back over the 12-column one.
     */
    function stackForNarrowScreen(ordered) {
      if (!grid || grid.getColumn() === 12) return;
      grid.batchUpdate();
      let y = 0;
      for (const w of ordered) {
        const item = gridItem(w.id);
        if (!item) continue;
        const h = Math.max((w.layout || {}).h ?? 4, minHeightFor(w));
        grid.update(item, { x: 0, y, w: 1, h });
        y += h;
      }
      grid.commit();
    }

    function addWidget(w) {
      widgets.push(w);
      const lay = w.layout || {};
      const el = document.createElement('div');
      el.className = 'grid-stack-item';
      el.setAttribute('gs-id', w.id);
      el.setAttribute('gs-w', String(lay.w ?? 6));
      el.setAttribute('gs-h', String(lay.h ?? 4));
      el.setAttribute('gs-min-w', '2');
      el.setAttribute('gs-min-h', String(minHeightFor(w)));
      if (lay.x !== undefined) el.setAttribute('gs-x', String(lay.x));
      if (lay.y !== undefined) el.setAttribute('gs-y', String(lay.y));
      el.innerHTML = `<div class="grid-stack-item-content">${tileShell(w, editable)}</div>`;
      gridEl.appendChild(el);
      grid.makeWidget(el);
      return loadWidget(w);
    }

    function removeWidget(id) {
      disposeChart(id);
      pageState.delete(id);
      const el = tileEl(id);
      if (el) grid.removeWidget(el, true);
      widgets = widgets.filter((w) => w.id !== id);
    }

    /**
     * Push a widget's per-visual size constraints onto its grid item.
     *
     * Has to run on every visual-type change, not only at creation: the
     * minimums are a property of the VISUAL, and a tile added as a table
     * (min 3 rows) then switched to a KPI stayed unable to shrink below 3 --
     * GridStack silently grew every 2-row KPI back, which is the same
     * class of bug as save() omitting h.
     */
    function applyConstraints(w) {
      const item = gridItem(w.id);
      if (!item || !grid) return;
      const minW = minWidthFor(w);
      const minH = minHeightFor(w);
      item.setAttribute('gs-min-w', String(minW));
      item.setAttribute('gs-min-h', String(minH));
      // Current geometry is passed back explicitly. grid.update() treats an
      // omitted w/h as "unset it", not "leave it alone", so updating only
      // the minimums wiped every tile's size -- layout() then read null and
      // fell through to the 6x4 default on the next save.
      const n = item.gridstackNode || {};
      grid.update(item, {
        minW, minH,
        x: n.x, y: n.y,
        w: Math.max(n.w == null ? minW : n.w, minW),
        h: Math.max(n.h == null ? minH : n.h, minH),
      });
    }

    /** Re-draw one widget from cache after its visual_config changed. */
    function rerenderWidget(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w) return Promise.resolve();
      applyConstraints(w);
      const el = tileEl(id);
      if (el) {
        el.querySelector('.dw-title').textContent = w.title || w.report_title || 'Untitled';
        const badge = el.querySelector('.dw-type-badge');
        if (badge) badge.innerHTML = editable
          ? `${esc(w.visual_type)}<span class="dw-caret" aria-hidden="true">▾</span>`
          : esc(w.visual_type);
      }
      return loadWidget(w);
    }

    /** Re-run one widget's query against live data, bypassing the cache. */
    function refreshWidget(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w) return Promise.resolve();
      if (w.query_sql) {
        // Evict the key this widget will actually look up, which is the
        // RESOLVED sql -- deleting the stored sql would leave the resolved
        // entry cached and make "refresh" a no-op on any parameterised tile.
        const r = resolveSql(w);
        if (r.sql) dataCache.delete(r.sql);
      }
      return loadWidget(w);
    }

    /** Re-run every distinct query against live data. */
    function refresh() {
      dataCache = new Map();
      return Promise.all(widgets.map(loadWidget));
    }

    /**
     * Current grid geometry, keyed by widget id.
     *
     * Read from each item's live gridstackNode rather than grid.save():
     * save() OMITS a property that matches the item's min/default, so a
     * tile at h=2 with gs-min-h=2 comes back as {x,y,w} with no h at all.
     * That silently broke reload-identically -- the missing h fell through
     * to the renderer's `lay.h ?? 4` default, so every KPI shrunk to 3x2
     * came back 3x4 on the next load. The gs-* attributes are the
     * fallback, and they were correct throughout.
     */
    function layout() {
      const out = new Map();
      if (!grid) return out;
      // Never serialise a COLLAPSED grid. Below the breakpoint every tile is
      // 1 column wide; saving that would overwrite the real 12-column
      // layout with the phone's, for everyone. Hand back what the widgets
      // already carry instead, so a save from a narrow screen is a no-op
      // for geometry rather than a silent reflow.
      if (grid.getColumn() !== 12) {
        for (const w of widgets) if (w.layout) out.set(String(w.id), w.layout);
        return out;
      }
      const num = (node, key, attr, dflt) => {
        if (node && node[key] != null) return node[key];
        const v = Number(attr);
        return Number.isFinite(v) ? v : dflt;
      };
      for (const el of gridEl.querySelectorAll('.grid-stack-item')) {
        const id = el.getAttribute('gs-id');
        if (!id) continue;
        const n = el.gridstackNode;
        out.set(String(id), {
          x: num(n, 'x', el.getAttribute('gs-x'), 0),
          y: num(n, 'y', el.getAttribute('gs-y'), 0),
          w: num(n, 'w', el.getAttribute('gs-w'), 6),
          h: num(n, 'h', el.getAttribute('gs-h'), 4),
        });
      }
      return out;
    }

    function getWidgets() { return widgets; }

    // ── Table interaction ──────────────────────────────────────────────
    /**
     * Search / sort a table WITHOUT touching its config.
     *
     * Re-rendering from the rows already in memory, so neither costs a
     * query. `rowsFor` is the loaded set including every page the reader
     * pulled with Load more, which is what makes "search" mean "search what
     * I have" rather than "search the first page".
     */
    function setTableView(id, patch) {
      const w = widgets.find((x) => x.id === id);
      if (!w || w.visual_type !== 'table') return;
      const cur = tableView.get(id) || { search: '', sortCol: null, sortDir: 'desc' };
      tableView.set(id, Object.assign({}, cur, patch));
      const page = pageState.get(id);
      const rows = page ? page.rows : (rowsFor(id) || []);
      // Keep the caret where the reader left it: re-rendering the tile
      // replaces the input, and a search box that loses focus per keystroke
      // is unusable.
      const el = tileEl(id);
      const active = el && el.querySelector('[data-role="table-search"]');
      const hadFocus = active && document.activeElement === active;
      const caret = hadFocus ? active.selectionStart : null;
      renderBody(w, { rows });
      if (hadFocus) {
        const next = tileEl(id) && tileEl(id).querySelector('[data-role="table-search"]');
        if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch (e) { /* number input */ } }
      }
    }

    function getTableView(id) {
      return Object.assign({ search: '', sortCol: null, sortDir: 'desc' }, tableView.get(id) || {});
    }

    /**
     * CSV of exactly what a table tile is showing.
     *
     * Deliberately NOT "the whole report": the tile has 1,000 rows because
     * that is what the runner returns per page, and an export that silently
     * covered a different set than the screen would be the worst of both.
     * The file's first line names the scope, and the caller is told whether
     * more rows exist so it can say so out loud too.
     */
    function tableCsvFor(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w) return null;
      const page = pageState.get(id);
      const rows = page ? page.rows : (rowsFor(id) || []);
      if (!rows.length) return null;
      const view = getTableView(id);
      const csv = window.SiloChart.tableCsv(rows, w.visual_config || {}, semanticsFor(w, rows), {
        search: view.search,
        sortCol: view.sortCol,
        sortDir: view.sortDir,
        totalRows: w.report_row_estimate || null,
        hasMore: !!(page && page.hasMore),
      });
      return {
        csv,
        filename: `${(w.title || w.report_title || 'widget').replace(/[^\w.-]+/g, '-').toLowerCase()}.csv`,
        loaded: rows.length,
        hasMore: !!(page && page.hasMore),
        estimate: w.report_row_estimate || null,
      };
    }

    /** Resize every live chart. Needed after a density change, a
        full-screen open/close, or anything else that moves a tile's box
        without GridStack noticing. */
    function resizeCharts() {
      for (const c of charts.values()) { try { c.resize(); } catch (e) { /* disposed */ } }
    }

    function setDensity(mode) {
      const next = mode === 'compact' ? 'compact' : 'comfortable';
      if (next === density) return;
      density = next;
      const d = DENSITY[density];
      if (grid) { grid.cellHeight(d.cellHeight); grid.margin(d.margin); }
      // The grid reflows on the next frame; charts have to be told after.
      requestAnimationFrame(resizeCharts);
    }

    /**
     * The tiles a section heading introduces: everything after it, in
     * sort order, up to the next heading.
     *
     * Membership is positional rather than stored, which is the only
     * definition that survives someone dragging a tile from under one
     * heading to under another -- a stored section_id would go stale the
     * moment the grid moved and would then collapse the wrong tiles.
     */
    function sectionMembers(id) {
      const order = widgets.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const at = order.findIndex((w) => w.id === id);
      if (at < 0) return [];
      const out = [];
      for (let i = at + 1; i < order.length; i += 1) {
        if (order[i].visual_type === 'section') break;
        out.push(order[i]);
      }
      return out;
    }

    function gridItem(id) {
      return gridEl.querySelector(`.grid-stack-item[gs-id="${CSS.escape(id)}"]`);
    }

    /**
     * Collapse or expand a section's tiles.
     *
     * A collapsed tile is DETACHED from the grid (not merely hidden), so the
     * board actually gets shorter rather than leaving a hole where the
     * section used to be. Expanding restores the exact geometry captured
     * before the first collapse -- GridStack compacts on removal, and
     * re-adding alone would leave that compaction in place, which is a
     * layout nobody arranged.
     *
     * View mode only. setEditable(true) expands everything first, so no
     * collapsed state can ever reach `layout()` and be saved.
     */
    function toggleSection(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w || w.visual_type !== 'section' || !grid) return false;
      const members = sectionMembers(id);
      const isCollapsed = collapsed.has(id);
      if (!isCollapsed && !preCollapseLayout) preCollapseLayout = layout();
      for (const m of members) {
        const item = gridItem(m.id);
        if (!item) continue;
        if (isCollapsed) {
          item.hidden = false;
          grid.makeWidget(item);
        } else {
          grid.removeWidget(item, false);
          item.hidden = true;
        }
      }
      if (isCollapsed) collapsed.delete(id); else collapsed.add(id);
      if (!collapsed.size && preCollapseLayout) {
        for (const [wid, geo] of preCollapseLayout) {
          const item = gridItem(wid);
          if (item && item.gridstackNode) grid.update(item, geo);
        }
        preCollapseLayout = null;
      }
      const tile = tileEl(id);
      const btn = tile && tile.querySelector('[data-act="collapse"]');
      if (btn) {
        const nowCollapsed = collapsed.has(id);
        btn.setAttribute('aria-expanded', String(!nowCollapsed));
        btn.textContent = nowCollapsed ? '▸' : '▾';
        btn.title = nowCollapsed ? 'Expand this section' : 'Collapse this section';
      }
      if (tile) tile.classList.toggle('is-collapsed', collapsed.has(id));
      requestAnimationFrame(resizeCharts);
      return collapsed.has(id);
    }

    function expandAllSections() {
      for (const id of Array.from(collapsed)) toggleSection(id);
    }

    // Reader-only flow layout. GridStack's nodes remain the saved canvas;
    // CSS lays out their existing bodies so filters, paging and chart
    // instances keep one lifecycle. No queries and no geometry writes.
    function setReportLayout(enabled) {
      if (enabled) {
        expandAllSections();
        const positions = layout();
        widgets.slice().sort((a, b) => {
          const p = positions.get(a.id) || a.layout || {};
          const q = positions.get(b.id) || b.layout || {};
          return (p.y || 0) - (q.y || 0) || (p.x || 0) - (q.x || 0);
        }).forEach((w) => {
          const item = tileEl(w.id);
          if (!item) return;
          item.dataset.reportKind = w.visual_type;
          gridEl.appendChild(item);
        });
      }
      gridEl.classList.toggle('is-report-layout', !!enabled);
      requestAnimationFrame(resizeCharts);
    }

    /**
     * Swap between view and edit chrome in place. Only the head actions and
     * GridStack's drag/resize flags change -- the bodies (and their live
     * chart instances and cached rows) are left exactly as they are.
     */
    function setEditable(next) {
      if (!!next === editable) return;
      // Never enter edit mode with tiles detached from the grid: layout()
      // would read geometry GridStack compacted rather than geometry a
      // person arranged, and Save would write it.
      if (next) expandAllSections();
      editable = !!next;
      if (grid) { grid.enableMove(editable); grid.enableResize(editable); }
      gridEl.classList.toggle('is-editing', editable);
      for (const w of widgets) {
        const tile = tileEl(w.id);
        if (!tile) continue;
        const actions = tile.querySelector('.dw-head-actions');
        if (actions) actions.innerHTML = headActionsHtml(w, editable);
      }
    }

    /**
     * The rows currently cached for a widget's query, or null if it has not
     * loaded (or failed). The builder's inspector needs these to offer real
     * column names in its dimension/measure pickers -- it profiles the data
     * that actually came back rather than guessing from the SQL text.
     */
    function rowsFor(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w || !w.query_sql) return null;
      const r = resolveSql(w);
      if (!r.sql) return null;
      const entry = dataCache.get(r.sql);
      return entry && entry.rows ? entry.rows : null;
    }

    function updateWidget(id, patch) {
      const w = widgets.find((x) => x.id === id);
      if (w) Object.assign(w, patch);
      return w;
    }

    // Charts read theme colours at draw time, so a theme flip has to
    // redraw them. Cheap: the data is already cached.
    function retheme() {
      for (const w of widgets) {
        if (charts.has(w.id)) loadWidget(w);
      }
    }

    return {
      setWidgets, addWidget, removeWidget, rerenderWidget, refresh, refreshWidget, loadMoreWidget,
      layout, getWidgets, updateWidget, retheme, rowsFor, setEditable, semanticsFor,
      parameterDeclarations, getParamValues, setParamValues, resolveSql,
      ensureParamDefaults, participationFor, widgetParamKeys,
      setDensity, resizeCharts, toggleSection, sectionMembers, expandAllSections, sizeFor, setReportLayout,
      setTableView, getTableView, tableCsvFor, applyConstraints,
      get grid() { return grid; },
    };
  }

  global.SiloDashboardRenderer = { createRuntime };
})(window);
