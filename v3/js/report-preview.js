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
  function chartWidget(table, recommendation) {
    const rec = recommendation || {};
    if (!rec.visual_type || rec.visual_type === 'table') return null;
    const kpi = rec.visual_type === 'kpi';
    return Object.assign({}, table, {
      id: CHART_ID,
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

  global.SiloReportPreview = { TABLE_ID, CHART_ID, previewBoard, tableWidget, chartWidget, arrange };
})(typeof window !== 'undefined' ? window : globalThis);
