/* In-memory stand-in for @supabase/supabase-js, enough for the v3 pages. */
(function () {
  // Opt-in: a test that reloads the page needs the stub DB to survive, the
  // way a real database would. Off unless the test asks, so suites that
  // rely on a fresh DB per navigation are unaffected.
  const PERSIST = (() => { try { return !!sessionStorage.getItem('__PERSIST_FAKE_DB__'); } catch { return false; } })();
  const db = window.__FAKE_DB__ = {
    dashboards: [{ id: 'D1', company_entity_id: 'C1', created_by: 'U1', created_by_name: 'Blake',
      name: 'Monday sales review', description: 'What sold last week', visibility: 'company',
      created_at: '2026-08-28T00:00:00Z', updated_at: '2026-08-28T00:00:00Z', widget_count: 0 }],
    dashboard_widgets: [],
    silo_chat_saved_reports: [
      { id: 'R1', title: 'Top products 30d', question: 'What were our top products last 30 days?',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-08-27T00:00:00Z',
        queries_run: ['select product_title, net_sales, units from sales'] },
      { id: 'R2', title: 'Daily sales trend', question: 'Daily sales this month?',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-08-26T00:00:00Z',
        queries_run: ['select day_date, net_sales from t1', 'select day_date, units from t2'] },
      // A central SILO definition: global (company_entity_id null), no chat
      // question, no author. The picker must offer it like any other report.
      { id: 'R3', title: 'Totals by product', question: 'Totals?',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-08-25T00:00:00Z',
        queries_run: ['select product_title, total_units, net_sales, conversion_rate from sales'] },
      // ── Edit-path fixtures ──
      // Guided: carries builder_config, so opening it must restore the BUILD
      // tab rather than dumping SQL on someone who never wrote any.
      { id: 'R10', title: 'Spend by platform', question: null,
        description: 'Guided report', source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by: 'U1', created_by_name: 'Blake',
        created_at: '2026-09-01T00:00:00Z',
        queries_run: ['select "platform", sum("spend") as "sum_spend" from "meta_ad_performance_daily" group by 1'],
        columns_metadata: { sum_spend: { semantic: 'currency' } },
        parameters: [{ key: 'date_from', type: 'date', label: 'From', default: 'today-27d' }],
        builder_config: { relname: 'meta_ad_performance_daily',
          cfg: { columns: ['platform', 'spend'], summarise: true, dimensions: ['platform'],
                 measures: [{ column: 'spend', agg: 'sum' }], dateColumn: 'day_date',
                 dateRange: '30', filters: [], sortColumn: '', sortDir: 'desc', limit: 100 } } },
      // Someone else's. Readable (company-visible) but not writable: the
      // page must say so up front and offer a copy, never a dead Save.
      { id: 'R11', title: "Jon's launch recap", question: 'How did the launch do?',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by: 'U9', created_by_name: 'Jon Loomis',
        created_at: '2026-09-01T00:00:00Z',
        queries_run: ['select day_date, net_sales from t1'] },
      // A central SILO definition: global, and RLS refuses every client
      // write to it, so the editor must be read-only from the start.
      { id: 'R12', title: 'SILO · Net sales by channel', question: null,
        description: 'A central definition', source: 'system', company_entity_id: null,
        visibility: 'company', created_by: null, created_by_name: null,
        created_at: '2026-08-28T00:00:00Z',
        queries_run: ['select day_date, net_sales from t1'] },
      // Saved before queries_run was reliably populated: real rows like this
      // exist, and the picker must hide them rather than offer a dead tile.
      { id: 'R4', title: 'Old report, no SQL', question: 'An old question',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-08-01T00:00:00Z',
        queries_run: [] },
      // Mirrors the real distribution: most saved chat answers ran many
      // queries. This one stands in for "Daily chief of staff" (21).
      { id: 'R5', title: 'Daily chief of staff', question: 'Give me a chief-of-staff style report',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-08-30T00:00:00Z',
        queries_run: Array.from({length: 7}, (_, i) =>
          `select day_date, sum(net_sales) as net_sales from sales_by_day where q = ${i} group by 1`),
        // Real shape: a genuinely open-ended ask that never reduces to one
        // dataset -- the answer widget's whole reason to exist. The tilde
        // in "~$24K" exercises the del-tokenizer fix (marked's GFM strikethrough
        // rule would otherwise pair it with something later in the text).
        answer: '## Past 7 Days\n\n**Net sales +61% week-over-week**, ~$24K driven mostly by one launch.\n\n'
          + '- Two SKUs are already sold out\n- Retail dipped while online spiked\n\nWant the inventory detail?' },
      // The real "Ad spend vs Online Sales" shape: one row, three jsonb
      // columns from json_agg/row_to_json. Reads fine in prose, charts not
      // at all, and used to render as [object Object].
      { id: 'R6', title: 'Ad spend vs Online Sales', question: 'ad spend vs online sales',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-09-01T00:00:00Z',
        queries_run: ['select nested json shape'] },
      // The flat query Ask SILO returned after the training note.
      { id: 'R7', title: 'Ad spend vs online sales, daily', question: 'ad spend vs online sales by day with roas',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-09-02T00:00:00Z',
        columns_metadata: { online_net_sales: { semantic: 'currency' }, ad_spend: { semantic: 'currency' },
                            roas: { semantic: 'number' }, day_date: { semantic: 'date' } },
        queries_run: ['select day_date, online_net_sales, ad_spend, roas from roas_daily'] },
      // Parameterised: the SQL carries tokens and the report declares them.
      { id: 'P1', title: 'WoW KPIs (parameterised)', question: null,
        description: 'Current vs prior at a chosen grain', source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-09-03T00:00:00Z',
        parameters: [
          { key: 'report_date', type: 'date', label: 'As of', default: 'today' },
          { key: 'grain', type: 'enum', label: 'Grain', options: ['day','week','month','ytd'], default: 'week' },
        ],
        queries_run: ['select metric, current_period from k(d => {{report_date}}, g => {{grain}})'] },
      // Shares the `grain` key -- one control must drive both -- and adds a
      // key of its own so the header shows the union.
      { id: 'P2', title: 'Channels (parameterised)', question: null,
        description: null, source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-09-03T00:00:00Z',
        parameters: [
          { key: 'grain', type: 'enum', label: 'Grain', options: ['day','week','month'], default: 'week' },
          { key: 'min_sales', type: 'number', label: 'Min sales', default: '0' },
        ],
        queries_run: ['select channel from c(g => {{grain}}) where sales >= {{min_sales}}'] },
      // The real "Open payment requests by vendor" shape: Ask SILO looked up
      // the columns first, so queries_run[0] is an information_schema probe.
      // Two widgets shipped pointing at it and rendered a list of column names.
      { id: 'R8', title: 'Open payment requests by vendor', question: 'open payment requests by vendor',
        description: null, source: 'ask_silo', company_entity_id: 'C1',
        visibility: 'company', created_by_name: 'Blake', created_at: '2026-09-03T00:00:00Z',
        queries_run: [
          "select column_name, data_type from information_schema.columns where table_name in ('payment_requests')",
          'select vendor, count(*) as open_requests, sum(amount_due) as total_amount_due from payment_requests_v group by 1'] },
      { id: 'S1', title: 'Daily Sales', question: null,
        description: 'Net sales by day — central SILO definition', source: 'system', company_entity_id: null,
        visibility: 'company', created_by_name: null, created_at: '2026-08-20T00:00:00Z',
        queries_run: ['select day_date, net_sales from t1'] },
    ],
    profiles: [{ id: 'U1', name: 'Blake', email: 'blake@baseballism.com', role: 'owner' }],
    // Shaped exactly like refresh_chat_schema_catalog() produces:
    // format_type() output per column. This is what lets semantics say
    // "total_units is a bigint, therefore a count, whatever its name".
    silo_chat_schema_catalog: [
      { relname: 'sales_by_product_title_daily_v', relkind: 'view', is_hidden: false, reportable: true, report_priority: 1,
        description: 'Sales rolled up to product title, per location per day.',
        columns: [ { name: 'product_title', type: 'text' }, { name: 'location_tag', type: 'text' },
                   { name: 'day_date', type: 'date' }, { name: 'units_sold', type: 'bigint' },
                   { name: 'net_sales', type: 'numeric' }, { name: 'company_entity_id', type: 'uuid' } ] },
      { relname: 'sales_velocity_by_sku_location_mv', relkind: 'matview', is_hidden: false, reportable: true, report_priority: 0,
        description: null,
        columns: [ { name: 'sku', type: 'text' }, { name: 'units_30d', type: 'integer' },
                   { name: 'company_entity_id', type: 'uuid' } ] },
      { relname: 'meta_ad_performance_daily', relkind: 'table', is_hidden: false, reportable: true, report_priority: 0,
        description: 'Ad-level Meta performance.',
        columns: [ { name: 'id', type: 'uuid' }, { name: 'company_entity_id', type: 'uuid' },
                   { name: 'connection_id', type: 'uuid' }, { name: 'row_hash', type: 'text' },
                   { name: 'synced_at', type: 'timestamp with time zone' },
                   { name: 'account_id', type: 'text' }, { name: 'day_date', type: 'date' },
                   { name: 'spend', type: 'numeric' }, { name: 'clicks', type: 'bigint' } ] },
      { relname: 'payroll_register_lines', relkind: 'table', is_hidden: false, reportable: false,
        description: 'Payroll detail — visible to Ask SILO, never offered in the workbench.',
        columns: [ { name: 'gross_pay', type: 'numeric' } ] },
      { relname: 'ad_platform_connections', relkind: 'table', is_hidden: true, reportable: false,
        description: 'Holds OAuth tokens — hidden from the picker.',
        columns: [ { name: 'access_token', type: 'text' } ] },
      { relname: 'sales_by_day', relkind: 'table', is_hidden: false, reportable: true, description: null, columns: [
        { name: 'day_date', type: 'date' },
        { name: 'net_sales', type: 'numeric' },
        { name: 'units', type: 'integer' },
        { name: 'total_units', type: 'bigint' },
        { name: 'product_title', type: 'text' },
      ] },
      { relname: 'v_marketing_mer_daily', relkind: 'view', is_hidden: false, reportable: true, description: null, columns: [
        { name: 'conversion_rate', type: 'numeric' },
      ] },
    ],
    rpcCalls: [],
    upserts: [],
  };

  const QUERY_ROWS = {
    // Keyed on the RESOLVED sql. A hit here proves substitution reached the
    // RPC with the literal we expect, not just that the tile drew something.
    ...(() => {
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const T = iso(new Date());
      const out = {};
      for (const g of ['day','week','month','ytd']) {
        out[`select metric, current_period from k(d => date '${T}', g => '${g}')`] =
          [{ metric: `net_sales@${g}`, current_period: g === 'day' ? 1000 : 7000 }];
      }
      out[`select channel from c(g => 'week') where sales >= 0`] = [{ channel: 'web' }, { channel: 'pos' }];
      out[`select channel from c(g => 'day') where sales >= 0`] = [{ channel: 'web' }];
      out[`select channel from c(g => 'week') where sales >= 500`] = [{ channel: 'web' }];
      return out;
    })(),
    'select product_title, net_sales, units from sales': [
      { product_title: 'Bubbles and Doubles Tee', net_sales: '241033.55', units: 19362 },
      { product_title: 'Stuck On The Game Shorts', net_sales: '118240.00', units: 13219 },
      { product_title: 'School of Base Knocks', net_sales: '64110.20', units: 5120 },
      { product_title: 'Pin of the Month', net_sales: '4210.50', units: 842 },
    ],
    'select product_title, total_units, net_sales, conversion_rate from sales': [
      { product_title: 'Tee', total_units: 19362, net_sales: 241033.55, conversion_rate: 0.041 },
      { product_title: 'Tee', total_units: 1200, net_sales: 15000.00, conversion_rate: 0.039 },
      { product_title: 'Shorts', total_units: 13219, net_sales: 118240.00, conversion_rate: 0.052 },
    ],
    'select nested json shape': [{
      ad_totals: { total_spend: 301480.6, total_claimed_value: 883120.2 },
      by_platform: [{ platform: 'meta_ads', spend: 201000.1 }, { platform: 'google_ads', spend: 100480.5 }],
      shopify_online: { online_net_sales: 1153143.26, online_orders: 28114 },
    }],
    'select day_date, online_net_sales, ad_spend, roas from roas_daily':
      Array.from({length: 30}, (_, i) => ({
        day_date: `2026-08-${String(i + 1).padStart(2, '0')}`,
        online_net_sales: 25000 + i * 400, ad_spend: 9000 + i * 90,
        roas: +(2.5 + i * 0.03).toFixed(2) })),
    'select day_date, net_sales from t1': Array.from({ length: 14 }, (_, i) => ({
      day_date: `2026-08-${String(i + 1).padStart(2, '0')}`, net_sales: 8000 + i * 210 })),
    'select day_date, units from t2': Array.from({ length: 14 }, (_, i) => ({
      day_date: `2026-08-${String(i + 1).padStart(2, '0')}`, units: 300 + i * 7 })),
    // Pagination fixture: 2,500 rows, more than two full 1000-row pages and
    // a partial third, so a suite can assert on the whole lifecycle (full
    // page, full page, partial page that ends it) rather than just page 1.
    'select n, val from big_series': Array.from({ length: 2500 }, (_, i) => ({ n: i + 1, val: (i + 1) * 10 })),
  };

  if (PERSIST) {
    try {
      const saved = sessionStorage.getItem('__FAKE_DB_STATE__');
      if (saved) Object.assign(db, JSON.parse(saved));
    } catch { /* ignore */ }
  }
  function persist() {
    if (!PERSIST) return;
    try {
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
        dashboards: db.dashboards, dashboard_widgets: db.dashboard_widgets,
        silo_chat_saved_reports: db.silo_chat_saved_reports,
        // profiles too: the edit path branches on the viewer's ROLE (an
        // owner may edit a colleague's report, an admin may not), so a suite
        // has to be able to change role and reload.
        profiles: db.profiles,
      }));
    } catch { /* ignore */ }
  }

  const base = (t) => t.replace(/_v$/, '');

  function viewRows(table) {
    if (table === 'dashboards_v') {
      return db.dashboards.map((d) => ({ filter_state: {}, ...d,
        widget_count: db.dashboard_widgets.filter((w) => w.dashboard_id === d.id).length }));
    }
    if (table === 'dashboard_widgets_v') {
      return db.dashboard_widgets.map((w) => {
        const r = db.silo_chat_saved_reports.find((x) => x.id === w.report_id);
        return { ...w,
          report_title: r ? r.title : null,
          report_question: r ? r.question : null,
          report_visibility: r ? r.visibility : null,
          report_source: r ? r.source : null,
          report_description: r ? r.description : null,
          report_columns_metadata: r ? (r.columns_metadata || null) : null,
          report_parameters: r ? (r.parameters || null) : null,
          report_answer: r ? (r.answer ?? null) : null,
          query_sql: r ? (r.queries_run[w.query_index] ?? null) : null,
          report_query_count: r ? r.queries_run.length : 0 };
      });
    }
    return db[base(table)] || [];
  }

  function builder(table) {
    let rows = null, filters = [], op = 'select', payload = null, single = null, orderBy = null;
    const run = () => {
      if (op === 'select') {
        let out = viewRows(table);
        for (const f of filters) {
          if (f.k === 'eq') out = out.filter((r) => String(r[f.c]) === String(f.v));
          if (f.k === 'in') out = out.filter((r) => f.v.includes(r[f.c]));
        }
        if (orderBy) out = out.slice().sort((a, b) => (a[orderBy.c] > b[orderBy.c] ? 1 : -1) * (orderBy.asc ? 1 : -1));
        if (single) return { data: out[0] ?? null, error: null };
        return { data: out, error: null };
      }
      if (op === 'insert') {
        // Saved reports get an R id so a new one is not mistaken for a
        // dashboard; dashboards keep D<n>, which suites assert on by URL.
        const newId = base(table) === 'silo_chat_saved_reports'
          ? 'R' + (db.silo_chat_saved_reports.length + 100)
          : 'D' + (db.dashboards.length + 1);
        const row = { id: newId, created_by: 'U1', created_by_name: 'Blake',
          company_entity_id: 'C1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          description: null, visibility: 'company', ...payload };
        db[base(table)].push(row);
        persist();
        return { data: single ? row : [row], error: null };
      }
      if (op === 'update') {
        let out = db[base(table)];
        for (const f of filters) if (f.k === 'eq') out = out.filter((r) => String(r[f.c]) === String(f.v));
        // silo_chat_saved_reports_update, in miniature: creator only (this
        // stub's user is not exec), never a global `system` row. Modelled
        // because "RLS matched nothing" is a SUCCESS with zero rows, not an
        // error, and the page has to handle that shape specifically.
        if (base(table) === 'silo_chat_saved_reports') {
          const me = db.profiles.find((x) => x.id === 'U1') || {};
          const exec = ['owner', 'executive'].includes(me.role);
          out = out.filter((r) => r.company_entity_id && r.source !== 'system'
            && (r.created_by === 'U1' || exec));
        }
        out.forEach((r) => Object.assign(r, payload, { updated_at: new Date().toISOString() }));
        persist();
        return { data: out, error: null };
      }
      if (op === 'upsert') {
        db.upserts.push(JSON.parse(JSON.stringify(payload)));
        persist();
        for (const p of payload) {
          const i = db[base(table)].findIndex((r) => r.id === p.id);
          if (i >= 0) db[base(table)][i] = { ...db[base(table)][i], ...p };
          else db[base(table)].push({ ...p });
        }
        persist();
        return { data: payload, error: null };
      }
      if (op === 'delete') {
        let keep = db[base(table)];
        for (const f of filters) {
          if (f.k === 'in') keep = keep.filter((r) => !f.v.includes(r.id));
          if (f.k === 'eq') keep = keep.filter((r) => String(r[f.c]) !== String(f.v));
        }
        db[base(table)] = keep;
        persist();
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const api = {
      select() { if (op === 'select') op = 'select'; return api; },
      insert(p) { op = 'insert'; payload = p; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      upsert(p) { op = 'upsert'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c, v) { filters.push({ k: 'eq', c, v }); return api; },
      in(c, v) { filters.push({ k: 'in', c, v }); return api; },
      order(c, o) { orderBy = { c, asc: !o || o.ascending !== false }; return api; },
      single() { single = true; return api; },
      maybeSingle() { single = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }

  window.supabase = {
    createClient() {
      return {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'U1', email: 'blake@baseballism.com' } } } }) },
        from: (t) => builder(t),
        rpc: async (name, args) => {
          window.__FAKE_DB__.rpcCalls.push({ name, args });
          if (name === 'saved_report_usage') {
            const ws = db.dashboard_widgets.filter((w) => w.report_id === args.p_report_id);
            const cols = new Set();
            for (const w of ws) {
              const vc = w.visual_config || {};
              for (const k of ['x_field', 'y_field', 'row_field', 'compare_field']) if (vc[k]) cols.add(vc[k]);
              for (const k of ['measures', 'columns']) if (Array.isArray(vc[k])) vc[k].forEach((c) => cols.add(c));
            }
            const boards = new Set(ws.map((w) => w.dashboard_id));
            const supplied = new Set();
            for (const d of db.dashboards) {
              if (!boards.has(d.id)) continue;
              Object.keys(d.filter_state || {}).forEach((k) => supplied.add(k));
            }
            return { data: [{ widget_count: ws.length, dashboard_count: boards.size,
              max_query_index: ws.reduce((m, w) => Math.max(m, w.query_index || 0), 0),
              referenced_columns: [...cols].sort(), supplied_parameters: [...supplied].sort() }], error: null };
          }
          if (name !== 'chat_run_readonly_query') return { data: null, error: null };
          const rows = QUERY_ROWS[args.query];
          if (rows) {
            // Mirrors chat_run_readonly_query's real pagination (20260904320000):
            // a 1000-row page per call, offset by p_offset. Every fixture but
            // the pagination one is under 1000 rows, so this is a no-op there
            // at the default offset 0 -- existing suites see no behaviour change.
            const offset = Math.max(Number(args.p_offset) || 0, 0);
            return { data: rows.slice(offset, offset + 1000), error: null };
          }
          // Unknown SQL: the real RPC would run it. Fail only for the
          // deliberately-broken marker the tests use, otherwise return
          // plausible rows so the preview path is exercised.
          if (/from gone\b|relation_does_not_exist/.test(args.query)) {
            return { data: null, error: { message: 'relation does not exist' } };
          }
          return { data: [
            { product_title: 'Bubbles and Doubles Tee', net_sales: 241033.55, units_sold: 19362, day_date: '2026-08-01' },
            { product_title: 'Stuck On The Game Shorts', net_sales: 118240.00, units_sold: 13219, day_date: '2026-08-02' },
          ], error: null };
        },
      };
    },
  };
})();
