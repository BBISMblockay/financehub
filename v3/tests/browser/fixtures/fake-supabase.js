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
    // Per-company location choices for a slicer with options_source
    // (silo_report_locations_v). Read AFTER the bar is built, which is
    // the whole point of the regression that uses it.
    silo_report_locations: [
      { company_entity_id: 'C1', location_tag: 'st_louis', label: 'St. Louis' },
      { company_entity_id: 'C1', location_tag: 'mission_viejo', label: 'Mission Viejo' },
      { company_entity_id: 'C1', location_tag: 'wholesale', label: 'Wholesale' },
    ],
    // Personal saved filter views (20260908130000). Empty by default: the
    // page has to work with none, and a suite seeds its own.
    dashboard_filter_views: [],
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
      // A TEXT parameter, which is the shape the live filter bug was found
      // on: a store name typed into a box rather than picked from a list.
      { id: 'P3', title: 'Sales by product, one store', question: null,
        description: 'Product sales for one store', source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by: 'U1', created_by_name: 'Blake', created_at: '2026-09-04T00:00:00Z',
        parameters: [
          { key: 'store', type: 'text', label: 'Store', default: 'Portland' },
        ],
        queries_run: ['select product_title, net_sales from s where store = {{store}}'] },
      // Two dimensions and a measure: a heatmap and a matrix can both draw
      // it, a bar cannot honestly.
      { id: 'P4', title: 'Units by size and location', question: null,
        description: 'Size x location', source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by: 'U1', created_by_name: 'Blake', created_at: '2026-09-04T00:00:00Z',
        queries_run: ['select size, location, units from grid'] },
      // A bridge: signed steps in a meaningful order, ending on a total.
      { id: 'P5', title: 'Cash bridge', question: null,
        description: 'How opening became closing', source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by: 'U1', created_by_name: 'Blake', created_at: '2026-09-04T00:00:00Z',
        queries_run: ['select step, delta from bridge'] },
      // No parameters at all: the tile that a dashboard filter cannot
      // reach, and which therefore has to say so on its own face.
      { id: 'P6', title: 'Company-wide totals', question: null,
        description: 'Unfiltered on purpose', source: 'manual', company_entity_id: 'C1',
        visibility: 'company', created_by: 'U1', created_by_name: 'Blake', created_at: '2026-09-04T00:00:00Z',
        queries_run: ['select day_date, net_sales from t1'] },
      { id: 'S1', title: 'Daily Sales', question: null,
        description: 'Net sales by day — central SILO definition', source: 'system', company_entity_id: null,
        visibility: 'company', created_by_name: null, created_at: '2026-08-20T00:00:00Z',
        queries_run: ['select day_date, net_sales from t1'] },
    ],
    profiles: [
      { id: 'U1', name: 'Blake', email: 'blake@baseballism.com', role: 'owner', department: 'finance', is_active: true },
      // A second member, so the schedule panel's people list and the
      // "who gets it" summary have somebody to name who is not the viewer.
      { id: 'U9', name: 'Jon Loomis', email: 'jon@example.com', role: 'user', department: 'marketing', is_active: true },
    ],
    // Roles are PER COMPANY: the schedule gates read entity_memberships, and
    // the legacy global profiles.role only when there is no membership. Both
    // paths exist here because isWorkspaceAdmin() reads them in that order.
    entity_memberships: [
      { user_id: 'U1', entity_id: 'C1', role: 'admin' },
      { user_id: 'U9', entity_id: 'C1', role: 'member' },
    ],
    // One supported business timezone, exactly as production ships it
    // (20260918120000). The schedule panel reads this to decide whether a zone
    // is a choice or a fact, so a suite that wants the select can add a row.
    supported_business_timezones: [
      { tz_name: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)', is_supported: true,
        note: 'The only timezone honoured by every day-boundary site.' },
    ],
    // Scheduled report email (20261013180000). Empty by default: a workspace
    // with nothing scheduled is the common case and the page has to read right
    // in it; suites seed their own.
    report_email_schedules: [],
    report_email_subscriptions: [],
    report_email_runs: [],
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
    queryCalls: [],
    upserts: [],
  };

  // Real saved reports have these columns even when their value is null.
  // Keep old authored fixtures authored by the signed-in user; a deliberately
  // different creator (R11) and global definitions retain their own identity.
  for (const report of db.silo_chat_saved_reports) {
    if (!Object.prototype.hasOwnProperty.call(report, 'created_by')) {
      report.created_by = report.source === 'system' ? null : 'U1';
    }
    if (!Object.prototype.hasOwnProperty.call(report, 'archived_at')) report.archived_at = null;
  }

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
    "select product_title, net_sales from s where store = 'Portland'": [
      { product_title: 'Bubbles and Doubles Tee', net_sales: 4000 },
      { product_title: 'Pin of the Month', net_sales: 900 },
    ],
    "select product_title, net_sales from s where store = 'Austin'": [
      { product_title: 'Bubbles and Doubles Tee', net_sales: 1500 },
    ],
    'select size, location, units from grid': [
      { size: 'S', location: 'Web', units: 300 },
      { size: 'M', location: 'Web', units: 520 },
      { size: 'S', location: 'Retail', units: 140 },
      { size: 'L', location: 'Retail', units: 90 },
    ],
    'select step, delta from bridge': [
      { step: 'Opening', delta: 100000 },
      { step: 'Collections', delta: 42000 },
      { step: 'Payroll', delta: -31000 },
      { step: 'Closing', delta: 111000 },
    ],
  };

  if (PERSIST) {
    try {
      const saved = sessionStorage.getItem('__FAKE_DB_STATE__');
      if (saved) Object.assign(db, JSON.parse(saved));
    } catch { /* ignore */ }
  }
  // A table named here fails its reads. It survives a reload on its own, so
  // a test can set it and then navigate, which is the only way to drive a
  // read the page performs for itself at load.
  try {
    db.__selectErrors = JSON.parse(sessionStorage.getItem('__FAKE_SELECT_ERRORS__') || 'null') || {};
  } catch { db.__selectErrors = {}; }
  function persist() {
    if (!PERSIST) return;
    try {
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
        dashboards: db.dashboards, dashboard_widgets: db.dashboard_widgets,
        silo_chat_saved_reports: db.silo_chat_saved_reports,
        dashboard_filter_views: db.dashboard_filter_views,
        // The schedule tables, so a suite can schedule a report on one page
        // and then find, edit, pause and run that schedule from another --
        // which is the whole reports-front-door flow.
        report_email_schedules: db.report_email_schedules,
        report_email_subscriptions: db.report_email_subscriptions,
        report_email_runs: db.report_email_runs,
        // profiles too: the edit path branches on the viewer's ROLE (an
        // owner may edit a colleague's report, an admin may not), so a suite
        // has to be able to change role and reload.
        profiles: db.profiles,
      }));
    } catch { /* ignore */ }
  }

  const base = (t) => t.replace(/_v$/, '');

  function viewRows(table) {
    if (table === 'report_email_schedules_v') {
      return db.report_email_schedules.map((row) => {
        const rep2 = db.silo_chat_saved_reports.find((r) => r.id === row.report_id);
        const dash = db.dashboards.find((d) => d.id === row.dashboard_id);
        const owner = db.profiles.find((pr) => pr.id === row.created_by) || {};
        const runs = db.report_email_runs
          .filter((r) => r.schedule_id === row.id)
          .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
        return {
          ...row,
          target_title: rep2 ? rep2.title : (dash ? dash.name : null),
          created_by_name: owner.name || null,
          created_by_email: owner.email || null,
          subscriber_count: db.report_email_subscriptions.filter((x) => x.schedule_id === row.id).length,
          last_run_status: runs[0] ? runs[0].status : null,
        };
      });
    }
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
    let rows = null, filters = [], op = 'select', payload = null, single = null, orderBy = [];
    let range = null, limit = null;
    const run = () => {
      db.queryCalls.push({ table, op, filters: JSON.parse(JSON.stringify(filters)), range, limit });
      if (op === 'select') {
        // A table named in __selectErrors fails the way PostgREST fails --
        // data null, error set -- so a page's catch path can be driven for
        // real instead of by calling its handler directly.
        const forced = (db.__selectErrors || {})[table];
        if (forced) return { data: null, error: { message: forced } };
        let out = viewRows(table);
        for (const f of filters) {
          if (f.k === 'eq') out = out.filter((r) => String(r[f.c]) === String(f.v));
          if (f.k === 'in') out = out.filter((r) => f.v.includes(r[f.c]));
          if (f.k === 'is') out = out.filter((r) => f.v === null ? r[f.c] == null : r[f.c] === f.v);
          if (f.k === 'not' && f.operator === 'is') out = out.filter((r) => f.v === null ? r[f.c] != null : r[f.c] !== f.v);
        }
        if (orderBy.length) out = out.slice().sort((a, b) => {
          for (const order of orderBy) {
            if (a[order.c] === b[order.c]) continue;
            return (a[order.c] > b[order.c] ? 1 : -1) * (order.asc ? 1 : -1);
          }
          return 0;
        });
        if (range) out = out.slice(range.from, range.to + 1);
        if (limit != null) out = out.slice(0, limit);
        if (single) return { data: out[0] ?? null, error: null };
        return { data: out, error: null };
      }
      if (op === 'insert') {
        // Saved reports get an R id so a new one is not mistaken for a
        // dashboard; dashboards keep D<n>, which suites assert on by URL.
        // Widgets get W<n>. The client may insert an ARRAY (Save a copy
        // writes every widget in one call), as the real client allows.
        const nextId = () => (base(table) === 'silo_chat_saved_reports'
          ? 'R' + (db.silo_chat_saved_reports.length + 100)
          : base(table) === 'dashboard_widgets'
            ? 'W' + (db.dashboard_widgets.length + 1)
            : base(table) === 'report_email_schedules'
              ? 'SCH' + (db.report_email_schedules.length + 1)
              : base(table) === 'report_email_runs'
                ? 'RUN' + (db.report_email_runs.length + 1)
                : 'D' + (db.dashboards.length + 1));
        const made = (Array.isArray(payload) ? payload : [payload]).map((p) => {
          const row = { created_by: 'U1', created_by_name: 'Blake',
            company_entity_id: 'C1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            description: null, visibility: 'company',
            ...(base(table) === 'silo_chat_saved_reports' ? { archived_at: null } : {}), ...p };
          // After the payload, not before: a client that carries an `id` key
          // holding undefined (an insert path that reuses its update payload)
          // used to overwrite the generated id with nothing, where Postgres
          // would have filled in the default. The row then had no id at all,
          // and every button rendered from it pointed at ''.
          if (row.id == null) row.id = nextId();
          db[base(table)].push(row);
          return row;
        });
        persist();
        return { data: single ? made[0] : made, error: null };
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
        // The real client accepts one row or many; the dashboard sends an
        // array of widgets and the filter-view save sends a single object.
        const list = Array.isArray(payload) ? payload : [payload];
        db.upserts.push(JSON.parse(JSON.stringify(list)));
        if (!db[base(table)]) db[base(table)] = [];
        for (const p of list) {
          // Server-side defaults the client never sends: an id from the
          // sequence, and the stamps the BEFORE INSERT triggers apply.
          const row = { created_by: 'U1', company_entity_id: 'C1', ...p };
          if (!row.id) row.id = `${base(table)}-${db[base(table)].length + 1}`;
          // The conflict target is (dashboard_id, created_by, name) for a
          // filter view and (id) everywhere else -- modelled because saving
          // over a view of the same name must REPLACE it, not add a second.
          const i = db[base(table)].findIndex((r) => (p.id && r.id === p.id)
            || (!p.id && r.dashboard_id === row.dashboard_id && r.created_by === row.created_by
                && String(r.name).toLowerCase() === String(row.name).toLowerCase()));
          if (i >= 0) db[base(table)][i] = { ...db[base(table)][i], ...row, id: db[base(table)][i].id };
          else db[base(table)].push(row);
        }
        persist();
        return { data: list, error: null };
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
      is(c, v) { filters.push({ k: 'is', c, v }); return api; },
      not(c, operator, v) { filters.push({ k: 'not', c, operator, v }); return api; },
      range(from, to) { range = { from, to }; return api; },
      limit(n) { limit = n; return api; },
      order(c, o) { orderBy.push({ c, asc: !o || o.ascending !== false }); return api; },
      single() { single = true; return api; },
      maybeSingle() { single = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }

  /* ── Fake mail transport ────────────────────────────────────────────────
     The delivery edge function is the only thing in this product that sends
     real email, and it is reached by a plain fetch() rather than through the
     Supabase client -- so stubbing the client is not enough to make a test
     safe. This intercepts that one URL, records what would have been sent in
     __FAKE_MAIL__, and writes the report_email_runs row the real function
     writes, so Send test and Send now can be driven end to end with nothing
     leaving the browser.

     A suite can make a send fail by setting __FAKE_MAIL_FAIL__ to the error
     the real function would have returned; the run row is then recorded as
     failed with that message, which is what the plain-language failure and
     the pause-on-permanent-fault behaviour are read from. */
  const mail = window.__FAKE_MAIL__ = { sent: [], calls: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (!/\/functions\/v1\/report-email-deliver/.test(url)) return realFetch(input, init);
    let body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch { body = {}; }
    mail.calls.push(body);
    const schedule = db.report_email_schedules.find((r) => r.id === body.schedule_id);
    const fail = window.__FAKE_MAIL_FAIL__ || null;
    const run = {
      id: 'RUN' + (db.report_email_runs.length + 1),
      schedule_id: body.schedule_id,
      company_entity_id: 'C1',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      status: fail ? 'failed' : 'succeeded',
      trigger_kind: body.trigger || 'manual',
      triggered_by: 'U1',
      total_rows: fail ? null : 14,
      attachment_count: fail ? null : 1,
      delivery_mode: fail ? null : 'attachment',
      error_message: fail || null,
      recipient_count: fail ? null : 1,
    };
    db.report_email_runs.push(run);
    if (schedule) {
      if (fail) {
        schedule.last_error = fail;
        // The real handler pauses only on a fault the schedule owns, and never
        // on a test send. Mirrored, because "did a failure pause it" is the
        // behaviour the Schedules view reports.
        const transient = /timeout|resend|network|not set|not configured/i.test(fail);
        if (body.trigger !== 'test' && !transient) schedule.is_paused = true;
      } else {
        schedule.last_run_at = run.finished_at;
        schedule.last_error = null;
      }
    }
    persist();
    if (!fail) mail.sent.push({ schedule_id: body.schedule_id, trigger: run.trigger_kind });
    const payload = fail
      ? { error: fail, run_id: run.id }
      : { ok: true, run_id: run.id, rows: run.total_rows, recipients: 1, delivery_mode: 'attachment' };
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status: fail ? 500 : 200, headers: { 'content-type': 'application/json' },
    }));
  };

  window.supabase = {
    createClient() {
      return {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'U1', email: 'blake@baseballism.com' } } } }) },
        from: (t) => builder(t),
        rpc: async (name, args) => {
          // The sidebar's own call (silo-chrome.js), not the page's: kept out
          // of rpcCalls, which the suites read as the page's queries.
          if (name === 'nav_badge_counts') {
            (window.__FAKE_DB__.chromeRpcCalls = window.__FAKE_DB__.chromeRpcCalls || []).push({ name, args });
            return { data: [], error: null };
          }
          window.__FAKE_DB__.rpcCalls.push({ name, args });
          // Per-page, opt-in fault/latency injection. Recording first lets a
          // test prove duplicate clicks did not issue duplicate writes. An
          // undefined result runs the ordinary implementation below.
          const handler = window.__FAKE_RPC_HANDLERS__?.[name];
          if (handler) {
            const response = await handler(args, db);
            if (response !== undefined) return response;
          }
          // The company's business timezone, read by the schedule panel so no
          // page has to carry a zone literal.
          if (name === 'silo_business_timezone') {
            return { data: 'America/Los_Angeles', error: null };
          }
          if (name === 'pause_all_report_email_schedules') {
            const hit = db.report_email_schedules.filter((r) => r.is_active && !r.is_paused);
            hit.forEach((r) => { r.is_paused = true; });
            persist();
            return { data: hit.length, error: null };
          }
          if (name === 'duplicate_report_email_schedule') {
            const row = db.report_email_schedules.find((r) => r.id === args.p_schedule_id);
            if (!row) return { data: null, error: { message: 'schedule not found' } };
            const copy = { ...row, id: 'SCH' + (db.report_email_schedules.length + 1),
              name: (row.name || 'Copy') + ' (copy)', is_active: true, is_paused: false };
            db.report_email_schedules.push(copy);
            persist();
            return { data: copy.id, error: null };
          }
          if (name === 'saved_report_archive_usage' || name === 'set_saved_report_archived') {
            const report = db.silo_chat_saved_reports.find((r) => r.id === args.p_report_id
              && r.company_entity_id === 'C1' && r.source !== 'system' && r.created_by === 'U1');
            if (!report) return { data: null, error: { message: 'Only the report creator can archive or restore it.' } };
            if (name === 'set_saved_report_archived') {
              report.archived_at = args.p_archived ? (report.archived_at || new Date().toISOString()) : null;
              persist();
              return { data: [{ id: report.id, archived_at: report.archived_at }], error: null };
            }
            const companyBoards = db.dashboards.filter((d) => d.company_entity_id === 'C1');
            const companyIds = new Set(companyBoards.map((d) => d.id));
            const widgets = db.dashboard_widgets.filter((w) => w.report_id === report.id && companyIds.has(w.dashboard_id));
            const used = new Set(widgets.map((w) => w.dashboard_id));
            const visible = companyBoards.filter((d) => used.has(d.id)
              && (d.created_by === 'U1' || d.visibility === 'company'));
            return { data: { dashboard_count: used.size, widget_count: widgets.length,
              dashboards: visible.map((d) => ({ id: d.id, name: d.name })),
              hidden_dashboard_count: used.size - visible.length }, error: null };
          }
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

          // The row-count wrapper the report builder sends when a preview
          // comes back full (20260907140000). Answered from the SAME fixture
          // as the query it wraps, so a test cannot pass with a count that
          // disagrees with the rows the preview actually showed.
          const countWrap = /^select count\(\*\) as n from \(([\s\S]+)\) z$/.exec(String(args.query || '').trim());
          if (countWrap) {
            const inner = QUERY_ROWS[countWrap[1].trim()];
            if (inner) return { data: [{ n: inner.length }], error: null };
            // Unknown inner query: the real RPC would count it. Mirror the
            // unknown-SQL branch below, which returns two plausible rows.
            return { data: [{ n: 2 }], error: null };
          }

          // A suite can seed rows for SQL it does not want to spell out in
          // full: sessionStorage '__FAKE_QUERY_PREFIXES__' is a list of
          // { prefix, rows }, matched on the start of the resolved SQL (the
          // text before the first parameter literal never changes).
          let seeded = null;
          try {
            const list = JSON.parse(sessionStorage.getItem('__FAKE_QUERY_PREFIXES__') || '[]');
            // An entry may also require a fragment to appear anywhere in the
            // query (`match`), so a suite can serve DIFFERENT rows for an
            // edited version of the same report -- which is how "all three
            // paths ran the edited report" is provable rather than assumed.
            const hit = list.find((e) => String(args.query || '').startsWith(e.prefix)
              && (!e.match || String(args.query || '').includes(e.match)));
            if (hit) seeded = hit.rows;
          } catch { /* ignore */ }
          const rows = seeded || QUERY_ROWS[args.query];
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
