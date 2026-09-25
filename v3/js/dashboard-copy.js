/* ============================================================================
   SILO v3 — Save a copy of a dashboard
   --------------------------------------------------------------------------
   A SILO dashboard (source = 'system', no company) is read-only to every
   client, execs included. Customising one means copying it into an ordinary
   board the caller owns, in their active company.

   The copy carries CONFIGURATION only -- report ids, visual settings, layout
   and the board's filter position. Every report on a SILO board is a global
   system report, so the copied tiles still run under the viewer's own RLS.

   Nothing here passes company_entity_id or created_by: the BEFORE INSERT
   triggers stamp both, exactly as for a board made from scratch. The copy
   starts PRIVATE ("Only me"): making it the whole company's board is a
   deliberate second step in Settings, not a side effect of clicking Copy.
   ========================================================================== */
(function (global) {
  'use strict';

  // The table's own widget columns. dashboard_widgets_v also carries the
  // joined report fields (report_title, query_sql, ...), which are not columns
  // of dashboard_widgets and would make the insert fail.
  const WIDGET_COLUMNS = ['report_id', 'query_index', 'title', 'visual_type', 'visual_config', 'layout', 'sort_order'];

  function copyName(name) {
    const base = String(name || '').trim() || 'Dashboard';
    return `${base} (copy)`;
  }

  /** The rows to insert, before any id exists. Pure, so node can check it. */
  function buildCopy(dashboard, widgets) {
    const board = {
      name: copyName(dashboard && dashboard.name),
      description: (dashboard && dashboard.description) || null,
      visibility: 'private',
      filter_state: (dashboard && dashboard.filter_state && typeof dashboard.filter_state === 'object')
        ? JSON.parse(JSON.stringify(dashboard.filter_state)) : {},
    };
    const rows = (widgets || []).map((w, i) => {
      const row = {};
      for (const k of WIDGET_COLUMNS) {
        const v = w[k];
        row[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : (v === undefined ? null : v);
      }
      if (row.query_index == null) row.query_index = 0;
      if (row.sort_order == null) row.sort_order = i;
      if (row.visual_config == null) row.visual_config = {};
      if (row.layout == null) row.layout = {};
      return row;
    });
    return { board, widgets: rows };
  }

  /**
   * Insert the copy. All or nothing from the reader's point of view: if the
   * widgets cannot be written, the half-made board is deleted again rather
   * than left behind as an empty "Overview (copy)" nobody asked for.
   * Resolves to the new dashboard id.
   */
  async function saveCopy(sb, dashboard, widgets) {
    const { board, widgets: rows } = buildCopy(dashboard, widgets);
    const { data: made, error } = await sb.from('dashboards').insert(board).select('id').single();
    if (error) throw new Error(error.message);
    if (rows.length) {
      const { error: wErr } = await sb.from('dashboard_widgets')
        .insert(rows.map((r) => Object.assign({ dashboard_id: made.id }, r)));
      if (wErr) {
        await sb.from('dashboards').delete().eq('id', made.id);
        throw new Error(wErr.message);
      }
    }
    return made.id;
  }

  global.SiloDashboardCopy = { WIDGET_COLUMNS, copyName, buildCopy, saveCopy };
})(typeof window !== 'undefined' ? window : globalThis);
