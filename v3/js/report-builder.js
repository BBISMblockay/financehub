/* ==========================================================================
   SILO v3 — report builder
   --------------------------------------------------------------------------
   The third authoring surface. Ask SILO writes source='ask_silo', migrations
   write source='system', and this writes source='manual' -- all into the same
   silo_chat_saved_reports table, all rendered by the same dashboard runtime,
   all executed by the same chat_run_readonly_query. Nothing downstream knows
   or cares which door a report came through.

   Two tabs over one preview:
     Build — pick a table or view, choose columns, summarise, filter, sort.
     SQL   — type it yourself, with the schema browser still there.

   Both compose a single SELECT and run it through chat_run_readonly_query,
   which is SECURITY INVOKER. So the hard boundary is unchanged: a person can
   only ever build a report over data their own RLS already lets them read,
   and a saved report shows each viewer their own company's rows.

   ── The one thing that is NOT enforced by RLS ─────────────────────────────
   Postgres does not apply row-level security to MATERIALIZED VIEWS. Every
   other object here is protected whatever SQL we generate; a matview is not.
   So the guided tab force-adds `company_entity_id = active_company_id()` to
   any matview source, and hides matviews that have no such column. The SQL
   tab cannot force anything, so it warns instead -- see checkRawSqlScope().
   ========================================================================== */
(function (global) {
  'use strict';

  const esc = (s) => window.SiloChart.esc(s);

  // ── SQL construction ────────────────────────────────────────────────
  // Identifiers are always double-quoted and always validated against the
  // catalog's real column list for the chosen relation first, so a name can
  // never carry anything but a name. Literals are single-quoted with quotes
  // doubled. This is a read-only surface behind an invoker-rights RPC, so
  // the blast radius of a mistake here is "reads what they could already
  // read" -- but a query that silently returns the wrong rows is its own
  // kind of harm, so it is worth being exact.
  const qIdent = (name) => '"' + String(name).replace(/"/g, '""') + '"';
  const qLit = (v) => "'" + String(v).replace(/'/g, "''") + "'";

  const NUMERIC_PG = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|smallserial|serial|bigserial)/i;
  const DATEISH_PG = /^(date|timestamp)/i;

  const AGGREGATES = ['sum', 'avg', 'min', 'max', 'count'];
  const OPERATORS = [
    { id: 'eq', label: 'is', sql: (c, v) => `${c} = ${v}` },
    { id: 'ne', label: 'is not', sql: (c, v) => `${c} <> ${v}` },
    { id: 'gt', label: 'greater than', sql: (c, v) => `${c} > ${v}` },
    { id: 'lt', label: 'less than', sql: (c, v) => `${c} < ${v}` },
    { id: 'contains', label: 'contains', sql: (c, v) => `${c} ilike ${v}`, wrap: (s) => `%${s}%` },
    { id: 'notnull', label: 'is not empty', sql: (c) => `${c} is not null`, noValue: true },
    { id: 'isnull', label: 'is empty', sql: (c) => `${c} is null`, noValue: true },
  ];

  const DATE_RANGES = [
    { id: '', label: 'All time', days: 0 },
    { id: '7', label: 'Last 7 days', days: 7 },
    { id: '30', label: 'Last 30 days', days: 30 },
    { id: '60', label: 'Last 60 days', days: 60 },
    { id: '90', label: 'Last 90 days', days: 90 },
    { id: '365', label: 'Last 365 days', days: 365 },
  ];

  /**
   * Turn the guided config into one SELECT.
   *
   * `source.relkind === 'matview'` gets a company predicate appended that the
   * user cannot remove. See the header: it is the only object kind where the
   * database will not do this for us.
   */
  function buildSql(source, cfg) {
    const known = new Map((source.columns || []).map((c) => [c.name, c.type]));
    const ok = (n) => known.has(n);
    const col = (n) => qIdent(n);

    const where = [];

    if (cfg.dateColumn && ok(cfg.dateColumn) && cfg.dateRange) {
      const days = Number(cfg.dateRange);
      if (days > 0) where.push(`${col(cfg.dateColumn)} >= current_date - ${days}`);
    }

    for (const f of cfg.filters || []) {
      if (!f.column || !ok(f.column) || !f.op) continue;
      const op = OPERATORS.find((o) => o.id === f.op);
      if (!op) continue;
      if (op.noValue) { where.push(op.sql(col(f.column))); continue; }
      if (f.value === '' || f.value === undefined || f.value === null) continue;
      const pgType = known.get(f.column) || '';
      const raw = op.wrap ? op.wrap(f.value) : f.value;
      // A numeric column compared to a quoted literal still works in
      // Postgres, but an unquoted non-number is a syntax error the user
      // cannot read. Quote unless it is genuinely a number.
      const useNumber = NUMERIC_PG.test(pgType) && !op.wrap && String(raw).trim() !== ''
        && Number.isFinite(Number(raw));
      where.push(op.sql(col(f.column), useNumber ? String(Number(raw)) : qLit(raw)));
    }

    if (source.relkind === 'matview' && ok('company_entity_id')) {
      // Not user-removable, and stated in the UI. Postgres will not do this.
      where.push(`${col('company_entity_id')} = active_company_id()`);
    }

    let selectList;
    let groupBy = '';
    if (cfg.summarise) {
      const dims = (cfg.dimensions || []).filter(ok);
      const measures = (cfg.measures || []).filter((m) => ok(m.column) && AGGREGATES.includes(m.agg));
      if (!measures.length) return null;
      const dimSql = dims.map(col);
      const measureSql = measures.map((m) =>
        `${m.agg}(${col(m.column)}) as ${qIdent(m.alias || `${m.agg}_${m.column}`)}`);
      selectList = dimSql.concat(measureSql).join(',\n       ');
      if (dims.length) groupBy = `\n group by ${dims.map((_, i) => i + 1).join(', ')}`;
    } else {
      const cols = (cfg.columns || []).filter(ok);
      selectList = cols.length ? cols.map(col).join(',\n       ') : '*';
    }

    let sql = `select ${selectList}\n  from ${qIdent(source.relname)}`;
    if (where.length) sql += `\n where ${where.join('\n   and ')}`;
    sql += groupBy;

    if (cfg.sortColumn) {
      // Sorting by an aggregate alias is legal in Postgres' ORDER BY, and is
      // what someone means by "top sellers", so aliases are allowed here
      // alongside real columns.
      const aliases = (cfg.measures || []).map((m) => m.alias || `${m.agg}_${m.column}`);
      if (ok(cfg.sortColumn) || aliases.includes(cfg.sortColumn)) {
        sql += `\n order by ${qIdent(cfg.sortColumn)} ${cfg.sortDir === 'asc' ? 'asc' : 'desc'} nulls last`;
      }
    }
    const limit = Number(cfg.limit) || 0;
    if (limit > 0) sql += `\n limit ${Math.min(limit, 500)}`;
    return sql;
  }

  /**
   * The SQL tab cannot force a company predicate onto a matview the way the
   * guided tab can, so it says so. A warning rather than a block: someone
   * writing raw SQL may have a legitimate reason, and may have written the
   * filter themselves -- which this checks for before complaining.
   */
  function checkRawSqlScope(sql, catalog) {
    const lower = String(sql || '').toLowerCase();
    if (/company_entity_id/.test(lower)) return null;
    const hit = (catalog || []).filter((r) => r.relkind === 'matview')
      .map((r) => r.relname)
      .filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`).test(lower));
    if (!hit.length) return null;
    return `This reads ${hit.join(', ')}, which ${hit.length === 1 ? 'is a materialized view' : 'are materialized views'}. `
      + `Postgres does not apply row-level security to those, so this will return EVERY company's rows. `
      + `Add "where company_entity_id = active_company_id()" unless you mean that.`;
  }

  /** Semantics straight from the catalog's pg types — grounded, not guessed. */
  function metadataFromCatalog(source, sql, rows) {
    const known = new Map((source && source.columns || []).map((c) => [c.name, c.type]));
    const out = {};
    for (const name of Object.keys((rows && rows[0]) || {})) {
      const pg = known.get(name);
      const semantic = pg
        ? window.SiloFieldSemantics.resolve(name, DATEISH_PG.test(pg) ? 'date' : NUMERIC_PG.test(pg) ? 'number' : 'string',
            { catalogIndex: new Map([[name, window.SiloFieldSemantics.pgKind(pg)]]) }).semantic
        : null;
      if (semantic) out[name] = { semantic, source: 'catalog' };
    }
    return Object.keys(out).length ? out : null;
  }

  global.SiloReportBuilder = {
    buildSql, checkRawSqlScope, metadataFromCatalog,
    AGGREGATES, OPERATORS, DATE_RANGES, qIdent, qLit,
    NUMERIC_PG, DATEISH_PG,
  };
})(window);
