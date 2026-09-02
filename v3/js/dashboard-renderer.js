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
   500-row cap, 30s timeout) -- the same engine Ask SILO's "Refresh data"
   button uses. Zero LLM involvement, and a viewer can never see through a
   dashboard anything their own RLS would not already show them.

   This file has no idea where a widget's report was authored. It reads
   `query_sql` and draws the result, so an Ask SILO save, a central SILO
   report definition and a hand-defined report all render identically.
   Keep it that way: source-specific behaviour belongs in the builder's
   picker, not here.
   ========================================================================== */
(function (global) {
  'use strict';

  const esc = (s) => window.SiloChart.esc(s);

  // ── Reusable inner markup ────────────────────────────────────────────
  function headActionsHtml(widget, editable) {
    // In edit mode the visual type is the primary control, not a status
    // pill: it is a button that opens the inspector, with a caret so it
    // reads as "this changes". A plain pill next to a gear icon taught
    // people the type was informational and the gear was for "settings".
    return editable
      ? `
        <button type="button" class="dw-type-badge dw-type-badge--btn" data-act="configure"
                title="Change visualization" aria-label="Change visualization, currently ${esc(widget.visual_type)}">
          ${esc(widget.visual_type)}<span class="dw-caret" aria-hidden="true">▾</span>
        </button>
        <button type="button" class="dw-icon-btn" data-act="remove" title="Remove widget" aria-label="Remove widget">✕</button>`
      : `
        <span class="dw-type-badge">${esc(widget.visual_type)}</span>
        <button type="button" class="dw-icon-btn" data-act="reload" title="Refresh this widget" aria-label="Refresh this widget">↻</button>`;
  }

  function tileShell(widget, editable) {
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

    let grid = null;
    let widgets = [];
    /** query_sql -> { rows } | { error } — one fetch per distinct SQL per
        refresh, so two tiles reading the same report cost one query. */
    let dataCache = new Map();
    /** widget id -> echarts instance */
    const charts = new Map();
    let resizeObserver = null;
    // The grounded layer of field semantics, fetched once per tab. Started
    // here rather than awaited at call time so it overlaps the widget
    // queries instead of serialising behind them.
    const catalogIndexPromise = window.SiloFieldSemantics.loadCatalogIndex(sb);
    let catalogIndex = new Map();
    catalogIndexPromise.then((idx) => { catalogIndex = idx; });

    function initGrid() {
      grid = GridStack.init({
        column: 12,
        cellHeight: 78,
        margin: 8,
        float: false,
        animate: true,
        disableDrag: !editable,
        disableResize: !editable,
        handle: '.dw-head',
        // Below 700px a 6-of-12 tile is half a phone screen: axis labels
        // overlap the plot and a KPI clips mid-number. Collapse to a single
        // column so every tile gets full width and stacks.
        columnOpts: { breakpoints: [{ w: 700, c: 1 }] },
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

    // ── Data ───────────────────────────────────────────────────────────
    async function fetchQuery(sql) {
      if (dataCache.has(sql)) return dataCache.get(sql);
      let entry;
      try {
        const { data, error } = await sb.rpc('chat_run_readonly_query', { query: sql });
        entry = error ? { error: error.message } : { rows: Array.isArray(data) ? data : [] };
      } catch (err) {
        entry = { error: err.message || String(err) };
      }
      dataCache.set(sql, entry);
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

      if (state.loading) { body.innerHTML = '<div class="dw-loading">Loading…</div>'; return; }

      if (state.notice) {
        body.innerHTML = `<div class="dw-empty dw-empty--warn">${esc(state.notice)}</div>`;
        return;
      }
      if (state.error) {
        // Naming the likely cause matters: a saved report's SQL can stop
        // working because the schema moved under it, and "column does not
        // exist" on its own reads like a bug in the dashboard.
        body.innerHTML = `<div class="dw-empty dw-empty--error">
            <strong>Query failed.</strong> ${esc(state.error)}
            <span class="dw-empty-hint">The saved report's SQL may no longer match the schema.</span>
          </div>`;
        return;
      }

      const rows = state.rows || [];
      const cfg = widget.visual_config || {};

      if (!rows.length) { body.innerHTML = '<div class="dw-empty">Query returned 0 rows.</div>'; return; }

      const semantics = semanticsFor(widget, rows);

      if (widget.visual_type === 'table') {
        body.innerHTML = window.SiloChart.tableHtml(rows, cfg, semantics);
      } else if (widget.visual_type === 'kpi') {
        body.innerHTML = window.SiloChart.kpiHtml(rows, cfg, semantics);
      } else {
        const shaped = window.SiloChart.shape(rows, cfg, semantics);
        if (!shaped) {
          body.innerHTML = `<div class="dw-empty">This visual needs a dimension and a measure. ${editable ? 'Open ⚙ to pick them.' : ''}</div>`;
          return;
        }
        body.innerHTML = '<div class="dw-chart" data-role="chart"></div>';
        const host = body.querySelector('[data-role="chart"]');
        const chart = echarts.init(host, null, { renderer: 'canvas' });
        chart.setOption(window.SiloChart.optionFor(widget.visual_type, shaped), true);
        charts.set(widget.id, chart);
        // Say what the chart is actually showing. Grouping is invisible
        // otherwise: "top 10 of 46" reads very differently once you know
        // those 46 were rolled up from 1,204 rows.
        const parts = [];
        if (shaped.truncated) parts.push(`Top ${shaped.points.length} of ${shaped.totalRows}`);
        if (shaped.aggregatedFrom) {
          parts.push(`${shaped.aggregate} of ${shaped.yField} over ${shaped.aggregatedFrom.toLocaleString()} rows`);
        }
        foot.textContent = parts.join(' · ');
      }

      // 500 is the query runner's hard cap. A tile silently drawing
      // the first 500 of a larger result would be a quiet lie, so say it.
      if (rows.length >= 500) {
        foot.textContent = (foot.textContent ? foot.textContent + ' · ' : '')
          + 'Source query hit the 500-row cap — aggregate in the report itself for a complete picture.';
      }
      if (resizeObserver) resizeObserver.observe(body);
    }

    async function loadWidget(widget) {
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
      renderBody(widget, { loading: true });
      const [entry] = await Promise.all([fetchQuery(widget.query_sql), catalogIndexPromise]);
      renderBody(widget, entry);
    }

    // ── Public surface ─────────────────────────────────────────────────
    function setWidgets(next) {
      if (!grid) initGrid();
      for (const id of Array.from(charts.keys())) disposeChart(id);
      if (resizeObserver) resizeObserver.disconnect();
      grid.removeAll();
      widgets = (next || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      for (const w of widgets) {
        const lay = w.layout || {};
        const el = document.createElement('div');
        el.className = 'grid-stack-item';
        el.setAttribute('gs-id', w.id);
        el.setAttribute('gs-x', String(lay.x ?? 0));
        el.setAttribute('gs-y', String(lay.y ?? 0));
        el.setAttribute('gs-w', String(lay.w ?? 6));
        el.setAttribute('gs-h', String(lay.h ?? 4));
        el.setAttribute('gs-min-w', '2');
        el.setAttribute('gs-min-h', '2');
        el.innerHTML = `<div class="grid-stack-item-content">${tileShell(w, editable)}</div>`;
        gridEl.appendChild(el);
        grid.makeWidget(el);
      }
      return Promise.all(widgets.map(loadWidget));
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
      el.setAttribute('gs-min-h', '2');
      if (lay.x !== undefined) el.setAttribute('gs-x', String(lay.x));
      if (lay.y !== undefined) el.setAttribute('gs-y', String(lay.y));
      el.innerHTML = `<div class="grid-stack-item-content">${tileShell(w, editable)}</div>`;
      gridEl.appendChild(el);
      grid.makeWidget(el);
      return loadWidget(w);
    }

    function removeWidget(id) {
      disposeChart(id);
      const el = tileEl(id);
      if (el) grid.removeWidget(el, true);
      widgets = widgets.filter((w) => w.id !== id);
    }

    /** Re-draw one widget from cache after its visual_config changed. */
    function rerenderWidget(id) {
      const w = widgets.find((x) => x.id === id);
      if (!w) return Promise.resolve();
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
      if (w.query_sql) dataCache.delete(w.query_sql);
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

    /**
     * Swap between view and edit chrome in place. Only the head actions and
     * GridStack's drag/resize flags change -- the bodies (and their live
     * chart instances and cached rows) are left exactly as they are.
     */
    function setEditable(next) {
      if (!!next === editable) return;
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
      const entry = dataCache.get(w.query_sql);
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
      setWidgets, addWidget, removeWidget, rerenderWidget, refresh, refreshWidget,
      layout, getWidgets, updateWidget, retheme, rowsFor, setEditable, semanticsFor,
      get grid() { return grid; },
    };
  }

  global.SiloDashboardRenderer = { createRuntime };
})(window);
