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

  // ── Calculated measures ──────────────────────────────────────────────
  // A measure over two aggregates rather than one: ROAS is sum(sales) /
  // sum(spend), and there is no column anywhere that holds it. Without this
  // an analyst who wants a rate has to leave for the SQL tab, which is the
  // moment the guided builder stops being self-serve.
  //
  // Every one divides through nullif(x, 0). A zero denominator is ordinary
  // in real data -- a platform with clicks and no spend, a day with no
  // orders -- and it must produce an empty cell, not a failed query that
  // takes the whole tile down.
  //
  // `semantic` matters more here than anywhere else: a calculated column
  // exists in no catalog, so the grounded layer that stops `total_units`
  // being printed as currency has nothing to say about it. Name heuristics
  // are all that is left, and they get `net_sales_pct_of_total` wrong --
  // "sales" reads as money and it would print as $12.40 instead of 12.4%.
  // So the calculation declares what it produces.
  const CALCS = [
    { id: 'ratio', label: 'divided by', symbol: '÷', semantic: 'number',
      sql: (a, b) => `round((${a} / nullif(${b}, 0))::numeric, 4)`,
      alias: (m) => `${m.column}_per_${m.column2}` },
    { id: 'pct', label: 'as % of', symbol: '%', semantic: 'percent',
      sql: (a, b) => `round((${a} / nullif(${b}, 0) * 100)::numeric, 2)`,
      alias: (m) => `${m.column}_pct_of_${m.column2}` },
    // No declared semantic: currency minus currency is currency, units minus
    // units is a count. It inherits from its left operand rather than
    // claiming a type it cannot know.
    { id: 'diff', label: 'minus', symbol: '−', semantic: null,
      sql: (a, b) => `(${a} - ${b})`,
      alias: (m) => `${m.column}_less_${m.column2}` },
  ];

  const calcFor = (m) => (m && m.calc) ? CALCS.find((c) => c.id === m.calc) || null : null;

  /** The column name a measure produces. Aliases are user-editable; this is
      the fallback, and it is also what ORDER BY and the chart pickers use. */
  function measureAlias(m) {
    if (!m) return '';
    if (m.alias) return m.alias;
    const calc = calcFor(m);
    return calc ? calc.alias(m) : `${m.agg}_${m.column}`;
  }

  const OPERATORS = [
    { id: 'eq', label: 'is', sql: (c, v) => `${c} = ${v}` },
    { id: 'ne', label: 'is not', sql: (c, v) => `${c} <> ${v}` },
    { id: 'gt', label: 'greater than', sql: (c, v) => `${c} > ${v}` },
    { id: 'lt', label: 'less than', sql: (c, v) => `${c} < ${v}` },
    // gte/lte exist so a date RANGE can be expressed as two filters --
    // `day_date >= {{date_from}}` and `day_date <= {{date_to}}` -- which is
    // how a parameterised window is built in the guided tab. Useful on
    // their own too; `>` on a date is almost never what someone means.
    { id: 'gte', label: 'on or after', sql: (c, v) => `${c} >= ${v}` },
    { id: 'lte', label: 'on or before', sql: (c, v) => `${c} <= ${v}` },
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

    // Parameters the report declares, by key. A filter value that is
    // exactly {{key}} for a DECLARED key is emitted as the token rather
    // than as a literal, so the value is supplied at run time by the
    // dashboard's slicer. An undeclared token is deliberately NOT special-
    // cased here: it falls through and is quoted as an ordinary string, so
    // a typo produces a filter that matches nothing rather than SQL that
    // the runner refuses -- and the Parameters panel flags it either way.
    const declared = new Set(
      window.SiloReportParams.normalizeDeclarations(cfg.parameters).map((d) => d.key));
    const tokenFor = (v) => {
      const m = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/i.exec(String(v == null ? '' : v).trim());
      return m && declared.has(m[1].toLowerCase()) ? `{{${m[1].toLowerCase()}}}` : null;
    };

    for (const f of cfg.filters || []) {
      if (!f.column || !ok(f.column) || !f.op) continue;
      const op = OPERATORS.find((o) => o.id === f.op);
      if (!op) continue;
      if (op.noValue) { where.push(op.sql(col(f.column))); continue; }
      if (f.value === '' || f.value === undefined || f.value === null) continue;
      const token = tokenFor(f.value);
      if (token && !op.wrap) { where.push(op.sql(col(f.column), token)); continue; }
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
      // A calculated measure needs BOTH operands to be real columns with
      // real aggregates. Half a calculation is dropped rather than emitted
      // as its left half, which would look like a working measure showing
      // the wrong number -- the worst of the three outcomes.
      const measures = (cfg.measures || []).filter((m) => {
        if (!ok(m.column) || !AGGREGATES.includes(m.agg)) return false;
        const calc = calcFor(m);
        if (!calc) return true;
        return ok(m.column2) && AGGREGATES.includes(m.agg2);
      });
      if (!measures.length) return null;
      const dimSql = dims.map(col);
      const measureSql = measures.map((m) => {
        const calc = calcFor(m);
        const left = `${m.agg}(${col(m.column)})`;
        const expr = calc ? calc.sql(left, `${m.agg2}(${col(m.column2)})`) : left;
        return `${expr} as ${qIdent(measureAlias(m))}`;
      });
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
      const aliases = (cfg.measures || []).map(measureAlias);
      if (ok(cfg.sortColumn) || aliases.includes(cfg.sortColumn)) {
        sql += `\n order by ${qIdent(cfg.sortColumn)} ${cfg.sortDir === 'asc' ? 'asc' : 'desc'} nulls last`;
      }
    }
    const limit = Number(cfg.limit) || 0;
    if (limit > 0) sql += `\n limit ${Math.min(limit, 1000)}`;
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

  /**
   * Does this report's SQL agree with its parameter declarations?
   *
   * Returns { errors, warnings }. The split matters: a token with no
   * declaration CANNOT run (the runner refuses it, by design -- the
   * declaration is the allowlist), so it is an error and blocks saving. A
   * declaration the SQL never uses runs fine and is merely dead weight in
   * the dashboard header, so it is a warning.
   */
  function validateParameters(sql, parameters) {
    const decls = window.SiloReportParams.normalizeDeclarations(parameters);
    const declaredKeys = new Set(decls.map((d) => d.key));
    const used = window.SiloReportParams.tokensIn(sql);
    const errors = [];
    const warnings = [];

    // Something in `parameters` that normalize dropped: a bad key, an
    // unknown type, an enum with no options. Named specifically, because
    // "your parameter disappeared" is otherwise a silent failure.
    const rawKeys = (Array.isArray(parameters) ? parameters : [])
      .map((p) => String((p && p.key) || '').trim().toLowerCase()).filter(Boolean);
    for (const k of rawKeys) {
      if (!declaredKeys.has(k)) {
        errors.push(`Parameter "${k}" is incomplete — it needs a valid key, a type, and (for a choice) at least one option.`);
      }
    }

    for (const k of used) {
      if (!declaredKeys.has(k)) {
        errors.push(`The SQL uses {{${k}}}, which is not declared as a parameter. Add it below, or remove the token.`);
      }
    }
    for (const d of decls) {
      if (!used.includes(d.key)) {
        warnings.push(`"${d.label}" is declared but never used — {{${d.key}}} does not appear in the SQL.`);
      }
      if (d.default) {
        const res = window.SiloReportParams.toLiteral(d, d.default);
        if (res.error) errors.push(`Default for "${d.label}" is not valid: ${res.error}`);
      }
    }
    return { errors, warnings };
  }

  /** One column's semantic, from its pg type in the catalog. Null if the
      catalog does not know the column -- which is always true of a
      calculated measure, hence metadataForMeasures below. */
  function semanticForColumn(source, name) {
    const known = new Map((source && source.columns || []).map((c) => [c.name, c.type]));
    const pg = known.get(name);
    if (!pg) return null;
    return window.SiloFieldSemantics.resolve(
      name,
      DATEISH_PG.test(pg) ? 'date' : NUMERIC_PG.test(pg) ? 'number' : 'string',
      { catalogIndex: new Map([[name, window.SiloFieldSemantics.pgKind(pg)]]) }).semantic;
  }

  /** Semantics straight from the catalog's pg types — grounded, not guessed. */
  function metadataFromCatalog(source, sql, rows) {
    const out = {};
    for (const name of Object.keys((rows && rows[0]) || {})) {
      const semantic = semanticForColumn(source, name);
      if (semantic) out[name] = { semantic, source: 'catalog' };
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Semantics for CALCULATED measures, which no catalog can supply.
   *
   * This is the layer that stops a rate being printed as money. A ratio is a
   * number, a percentage is a percent, and a difference means whatever its
   * left operand meant. Overlay this on metadataFromCatalog -- the
   * calculation is more authoritative about its own output than any
   * inference over the returned rows.
   */
  function metadataForMeasures(source, measures) {
    const out = {};
    for (const m of measures || []) {
      const calc = calcFor(m);
      if (!calc) continue;
      const semantic = calc.semantic || semanticForColumn(source, m.column);
      if (semantic) out[measureAlias(m)] = { semantic, source: 'calculation' };
    }
    return out;
  }

  // ── Schema probes ────────────────────────────────────────────────────
  /**
   * Is this query the model looking up column names rather than answering?
   *
   * An agentic answer's queries_run is a TRANSCRIPT, not a dataset list. The
   * first entry is very often `select column_name from information_schema
   * ...` -- Ask SILO orienting itself before it can write the real query.
   * A widget defaulting to index 0 then renders a list of column names, and
   * it looks like a working tile because it has rows and headers.
   *
   * That is not hypothetical: "Open payment requests by vendor" shipped onto
   * a dashboard twice showing exactly that, and the real query was sitting
   * at index 1.
   */
  function isSchemaProbe(sql) {
    const s = String(sql || '').toLowerCase();
    return /\b(information_schema\.|pg_catalog\.|pg_class\b|pg_attribute\b|pg_matviews\b|pg_policies\b|pg_proc\b|pg_indexes\b)/.test(s);
  }

  /**
   * Which query of a saved answer a widget should default to.
   *
   * The LAST non-probe query, not the first. In a tool loop the closing
   * query is the one that produced the answer; the earlier ones are the
   * model working up to it. Falls back to the last query, then to 0, so
   * this always returns a usable index.
   */
  function defaultQueryIndex(queriesRun) {
    const queries = Array.isArray(queriesRun) ? queriesRun : [];
    if (!queries.length) return 0;
    for (let i = queries.length - 1; i >= 0; i -= 1) {
      if (queries[i] && !isSchemaProbe(queries[i])) return i;
    }
    return queries.length - 1;
  }

  // ── Plumbing columns ─────────────────────────────────────────────────
  // Every synced table carries the same scaffolding: a surrogate key, the
  // tenant id, sync bookkeeping, audit stamps. The build pane was showing
  // `id, company_entity_id, connection_id, row_hash` before it showed
  // `spend`, which is the wrong first impression of a reporting tool.
  //
  // Hidden by default, never removed -- a "Show all columns" toggle brings
  // them back, because occasionally you do want to group by a foreign key
  // or check synced_at.
  const PLUMBING_NAMES = new Set([
    'id', 'company_entity_id', 'row_hash', 'sync_batch_id', 'synced_at',
    'created_at', 'updated_at', 'created_by', 'changed_by', 'updated_by',
    'deleted_at', 'ds_id', 'connection_id', 'shop_domain',
  ]);

  /**
   * A uuid ending in _id is a join key, and the guided builder cannot join,
   * so it is noise here. A TEXT id is usually meaningful (account_id on an
   * ad platform, media_id on an Instagram post) and stays.
   */
  function isPlumbing(col) {
    if (!col || !col.name) return false;
    if (PLUMBING_NAMES.has(col.name)) return true;
    return /_id$/.test(col.name) && /^uuid/i.test(col.type || '');
  }

  const businessColumns = (cols) => (cols || []).filter((c) => !isPlumbing(c));

  global.SiloReportBuilder = {
    isPlumbing, businessColumns, PLUMBING_NAMES, isSchemaProbe, defaultQueryIndex,
    buildSql, checkRawSqlScope, metadataFromCatalog, validateParameters,
    metadataForMeasures, semanticForColumn, measureAlias, calcFor, CALCS,
    AGGREGATES, OPERATORS, DATE_RANGES, qIdent, qLit,
    NUMERIC_PG, DATEISH_PG,
  };
})(window);
