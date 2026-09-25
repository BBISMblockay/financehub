/* ============================================================================
   SILO v3 — Open a report as a temporary, unsaved board
   --------------------------------------------------------------------------
   /v3/dashboard.html?report=<id> draws ONE saved report the way an expanded
   dashboard tile reads -- with the viewer's own data, the report's own
   filters, a chart where the data has a shape and the full table under it --
   without saving anything anywhere. Opening a SILO report used to land in the
   report builder's SQL view, which is an authoring tool, not a way to read.

   Nothing here writes. The board is built in memory from the report row and
   handed to the same renderer every saved dashboard uses, so a preview can
   never disagree with the tile the report becomes once someone adds it.
   Pure: no DOM, no Supabase, so node can check every decision.
   ========================================================================== */
(function (global) {
  'use strict';

  const TABLE_ID = 'preview-table';
  const CHART_ID = 'preview-chart';

  /** The in-memory board. No id: it is not a dashboard and must never be
      written as one (saved views, Save and Edit all key on an id). */
  function previewBoard(report) {
    return {
      id: null,
      name: (report && report.title) || 'Report',
      description: (report && report.description) || null,
      visibility: 'company',
      filter_state: {},
      source: 'preview',
    };
  }

  /**
   * The table tile that always shows. Full width and tall, because it is
   * the whole reason for opening the report; `reportFields` is the
   * denormalised half a widget carries (dashboard-builder's reportFieldsFor),
   * passed in so this file and the builder cannot disagree about its shape.
   */
  function tableWidget(report, queryIndex, reportFields) {
    return Object.assign({
      id: TABLE_ID,
      dashboard_id: null,
      report_id: report.id,
      query_index: queryIndex,
      title: report.title,
      visual_type: 'table',
      visual_config: {},
      layout: { x: 0, y: 0, w: 12, h: 8 },
      sort_order: 0,
    }, reportFields);
  }

  /**
   * The chart to put above the table, or null when there is none worth
   * drawing. Takes chart-adapter's own recommendation, so a preview picks
   * exactly what "Add insight" would pick for the same rows. A table
   * recommendation means the shape is ambiguous -- drawing a second table
   * would only repeat the first. A KPI stays small, as it does on a board.
   */
  function chartWidget(table, recommendation, id) {
    const rec = recommendation || {};
    if (!rec.visual_type || rec.visual_type === 'table') return null;
    const kpi = rec.visual_type === 'kpi';
    return Object.assign({}, table, {
      id: id || CHART_ID,
      visual_type: rec.visual_type,
      visual_config: JSON.parse(JSON.stringify(rec.visual_config || {})),
      layout: { x: 0, y: 0, w: kpi ? 4 : 12, h: kpi ? 2 : 5 },
      sort_order: 0,
    });
  }

  /** Chart first, table below it; the table alone when there is no chart. */
  function arrange(table, chart) {
    if (!chart) return [table];
    const below = Object.assign({}, table, {
      layout: Object.assign({}, table.layout, { y: chart.layout.h }),
      sort_order: 1,
    });
    return [chart, below];
  }

  /**
   * A report may name the column its chart should plot:
   * columns_metadata[col].chart_primary = true. The automatic recommendation
   * ranks money above plain numbers, which is right in general and wrong for
   * a ratio report -- Marketing Efficiency's chart plotted Ad Spend when the
   * report is about MER. Only applied when that column came back in the rows.
   *
   * chart_dimension = true names the column the chart is broken out BY. The
   * recommendation takes the first text column, which for Email & SMS
   * Performance is `kind` -- 132 messages drawn as two bars, campaign and
   * automation. With the message named, a bar chart becomes a top-10 ranking
   * of messages, sorted, whatever the recommendation's own sort and limit.
   */
  function preferPrimary(rec, columnsMetadata, rows) {
    if (!rec || !rec.visual_config || !rows || !rows.length) return rec;
    const meta = columnsMetadata || {};
    const flagged = (flag) => Object.keys(meta).find((k) => meta[k] && meta[k][flag] === true && k in rows[0]);
    const y = flagged('chart_primary');
    const x = flagged('chart_dimension');
    if (!y && !x) return rec;
    const cfg = Object.assign({}, rec.visual_config);
    if (y) cfg.y_field = y;
    let type = rec.visual_type;
    if (x) {
      cfg.x_field = x;
      // A named breakout of many values is a ranking: a donut or line over
      // it would be wrong, and a KPI would ignore it.
      type = 'bar';
      cfg.sort = 'desc';
      cfg.limit = 10;
    }
    return Object.assign({}, rec, { visual_type: type, visual_config: cfg });
  }

  /**
   * A report whose queries are PARTS of one answer -- a total, then by
   * type, then by SKU -- says so in columns_metadata._queries:
   *   [{ index, title, chart }]
   * Opening it then draws every declared query, titled, in that order.
   * Without the declaration a report's queries_run is treated as the
   * transcript it usually is (an Ask SILO answer), and only the last
   * non-probe query is drawn. Malformed entries are dropped rather than
   * guessed at: an index that names no query, a repeat, a non-integer.
   */
  function declaredQueries(report) {
    const meta = report && report.columns_metadata;
    const list = meta && Array.isArray(meta._queries) ? meta._queries : null;
    const count = report && Array.isArray(report.queries_run) ? report.queries_run.length : 0;
    if (!list) return null;
    const out = [];
    const seen = new Set();
    for (const e of list) {
      const i = Number(e && e.index);
      if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) continue;
      seen.add(i);
      out.push({
        index: i,
        title: String((e && e.title) || '').trim() || `Query ${i + 1}`,
        chart: !(e && e.chart === false),
      });
    }
    return out.length ? out : null;
  }

  function queryTableId(index) { return `preview-q${index}-table`; }
  function queryChartId(index) { return `preview-q${index}-chart`; }

  /** One declared query's table, titled "Report · Part". */
  function queryTable(report, entry, reportFields) {
    return Object.assign(tableWidget(report, entry.index, reportFields), {
      id: queryTableId(entry.index),
      title: entry.title,
    });
  }

  /** A table only as tall as its rows need: a one-row total is a strip,
      a long list gets the room to scroll. */
  function tableHeight(rowCount) {
    if (rowCount <= 2) return 3;
    if (rowCount <= 10) return 6;
    return 9;
  }

  /**
   * Stack parts top to bottom in declared order: each part's chart (when
   * it has one) directly above its own table. Returns new objects; the
   * inputs are not moved.
   */
  function stack(parts) {
    const out = [];
    let y = 0;
    for (const part of parts || []) {
      if (part.chart) {
        out.push(Object.assign({}, part.chart, {
          layout: Object.assign({}, part.chart.layout, { x: 0, y }),
          sort_order: out.length,
        }));
        y += part.chart.layout.h;
      }
      const h = tableHeight(part.rowCount || 0);
      out.push(Object.assign({}, part.table, {
        layout: Object.assign({}, part.table.layout, { x: 0, y, w: 12, h }),
        sort_order: out.length,
      }));
      y += h;
    }
    return out;
  }

  global.SiloReportPreview = {
    TABLE_ID, CHART_ID, previewBoard, tableWidget, chartWidget, arrange, preferPrimary,
    declaredQueries, queryTable, queryTableId, queryChartId, tableHeight, stack,
  };
})(typeof window !== 'undefined' ? window : globalThis);
