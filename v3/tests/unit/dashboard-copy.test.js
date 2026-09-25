/* Save a copy of a (SILO) dashboard: what is written, and what happens when
 * half of it fails. */
'use strict';
const { loadV3 } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(['dashboard-copy.js']);
const C = g.SiloDashboardCopy;
const R = createReporter('dashboard copy');
const { test, eq, truthy } = R;

const silo = {
  id: 'silo-1', name: 'Overview', description: 'Sales at a glance.',
  company_entity_id: null, source: 'system', visibility: 'company', created_by: null,
  created_by_name: 'SILO', filter_state: { date_from: 'today-28d', cover_weeks: 26 },
};
// Rows shaped like dashboard_widgets_v: table columns PLUS joined report
// fields that are not columns of dashboard_widgets.
const widgets = [
  { id: 'w1', dashboard_id: 'silo-1', company_entity_id: null, created_by: null, report_id: 'r1', query_index: 0,
    title: 'Sales', visual_type: 'table', visual_config: { limit: 10 }, layout: { x: 0, y: 0, w: 12, h: 3 },
    sort_order: 0, report_title: 'Daily Sales', query_sql: 'select 1' },
  { id: 'w2', report_id: null, query_index: 0, title: 'Stock', visual_type: 'section',
    visual_config: {}, layout: { x: 0, y: 3, w: 12, h: 1 }, sort_order: 1 },
];

test('the copy is a private user board named "(copy)", carrying the filter position', () => {
  const { board } = C.buildCopy(silo, widgets);
  eq(board.name, 'Overview (copy)');
  eq(board.visibility, 'private');
  eq(board.description, 'Sales at a glance.');
  eq(board.filter_state, { date_from: 'today-28d', cover_weeks: 26 });
  // Stamped by triggers, never passed: a client-chosen company or author is
  // exactly what the stamps exist to prevent.
  for (const k of ['company_entity_id', 'created_by', 'source', 'id']) eq(k in board, false, k);
});

test('widgets carry only dashboard_widgets columns -- no ids, scope or joined report fields', () => {
  const { widgets: rows } = C.buildCopy(silo, widgets);
  eq(rows.length, 2);
  eq(Object.keys(rows[0]).sort(), C.WIDGET_COLUMNS.slice().sort());
  eq(rows[0].report_id, 'r1');
  eq(rows[1].report_id, null);
  eq(rows[1].visual_type, 'section');
});

test('the copy does not share objects with the source (editing it cannot mutate the SILO board in memory)', () => {
  const { board, widgets: rows } = C.buildCopy(silo, widgets);
  rows[0].visual_config.limit = 99;
  board.filter_state.date_from = 'today-7d';
  eq(widgets[0].visual_config.limit, 10);
  eq(silo.filter_state.date_from, 'today-28d');
});

function fakeSb({ failWidgets = false } = {}) {
  const calls = [];
  const table = (name) => ({
    insert(payload) {
      calls.push({ op: 'insert', name, payload });
      const res = name === 'dashboard_widgets' && failWidgets
        ? { data: null, error: { message: 'new row violates row-level security policy' } }
        : { data: { id: 'new-1' }, error: null };
      return Object.assign(Promise.resolve(res), { select: () => ({ single: async () => res }) });
    },
    delete() { return { eq: async (col, val) => { calls.push({ op: 'delete', name, col, val }); return { error: null }; } }; },
  });
  return { calls, from: table };
}

(async () => {
  await test('saveCopy writes the board, then its widgets pointed at the NEW board', async () => {
    const sb = fakeSb();
    const id = await C.saveCopy(sb, silo, widgets);
    eq(id, 'new-1');
    eq(sb.calls.map((c) => `${c.op}:${c.name}`), ['insert:dashboards', 'insert:dashboard_widgets']);
    truthy(sb.calls[1].payload.every((w) => w.dashboard_id === 'new-1'));
  });

  await test('a failed widget insert removes the half-made board and reports the error', async () => {
    const sb = fakeSb({ failWidgets: true });
    let err = null;
    try { await C.saveCopy(sb, silo, widgets); } catch (e) { err = e; }
    truthy(err && /row-level security/.test(err.message));
    eq(sb.calls.map((c) => `${c.op}:${c.name}`), ['insert:dashboards', 'insert:dashboard_widgets', 'delete:dashboards']);
    eq(sb.calls[2].val, 'new-1');
  });

  const result = R.summary();
  process.exit(result.fail ? 1 : 0);
})();
