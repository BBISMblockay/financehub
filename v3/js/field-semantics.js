/* ==========================================================================
   SILO v3 — field semantics
   --------------------------------------------------------------------------
   What a column MEANS, as distinct from what it looks like.

   Decoupling the dataset from the visual is what makes this file necessary.
   Once one saved report can be drawn five ways, nothing in the drawing code
   knows whether 19362 is dollars, units, or a percentage -- and the first
   build guessed from the column name and got `total_units` wrong (currency,
   because "total" is a money word). A name is a guess. This resolves the
   question from four sources instead, most authoritative first:

     1. The widget's own override        visual_config.field_semantics
     2. The saved report's metadata      silo_chat_saved_reports.columns_metadata
     3. The database's own column types  silo_chat_schema_catalog
     4. Value profiling + name heuristics (the old behaviour, now last)

   Layer 3 is the one that does the real work today, because it is grounded
   rather than guessed: Postgres already knows `units` is `integer` and
   `net_sales` is `numeric`. An integer column is a count and can never be
   currency, whatever its name says -- which is exactly the `total_units`
   case, fixed at the root instead of by adding another word to a regex.

   Layer 2 is where it gets reliable over time: v3 seeds it from 1+3+4 the
   first time a widget is built on a report, a human corrects it in the
   inspector, and Ask SILO can write it at save time later. Corrections land
   on the REPORT, so fixing `net_sales` once fixes every widget using it.
   ========================================================================== */
(function (global) {
  'use strict';

  // The vocabulary. Deliberately small: these are the distinctions that
  // change how a value is printed or how it may be aggregated, not a type
  // system.
  const SEMANTICS = ['currency', 'count', 'number', 'percent', 'date', 'category', 'boolean'];
  const MEASURES = new Set(['currency', 'count', 'number', 'percent']);

  const PERCENT_RE = /(pct|percent|rate|share|ratio)/i;
  const COUNT_RE = /(units?|qty|quantity|orders?|count|sessions?|clicks?|impressions?|items?|visits?|users?|skus?|days?)\b/i;
  const CURRENCY_RE = /(sales|revenue|amount|cost|price|spend|total|value|payout|margin|gross|net|aov|profit)/i;

  // ── Layer 3: the database's own types ────────────────────────────────
  /**
   * Build a column-name -> pg-type index from silo_chat_schema_catalog rows
   * ([{relname, columns:[{name,type}]}]).
   *
   * A name that resolves to more than one DIFFERENT type kind across the
   * schema is dropped rather than guessed at: `total` being numeric in one
   * view and integer in another is exactly the ambiguity this layer exists
   * to avoid inventing an answer for. Ambiguous names fall through to
   * profiling, which at least sees the real values.
   */
  function buildCatalogIndex(catalogRows) {
    const kinds = new Map();
    for (const row of catalogRows || []) {
      for (const col of row.columns || []) {
        if (!col || !col.name) continue;
        const kind = pgKind(col.type);
        if (!kind) continue;
        const seen = kinds.get(col.name);
        if (seen === undefined) kinds.set(col.name, kind);
        else if (seen !== kind) kinds.set(col.name, null); // ambiguous
      }
    }
    const index = new Map();
    for (const [name, kind] of kinds) if (kind) index.set(name, kind);
    return index;
  }

  /** Collapse format_type() output into the distinctions that matter. */
  function pgKind(type) {
    const t = String(type || '').toLowerCase();
    if (/^(smallint|integer|bigint|smallserial|serial|bigserial)\b/.test(t)) return 'int';
    if (/^(numeric|decimal|real|double precision|money)\b/.test(t)) return 'decimal';
    if (/^(date|timestamp)/.test(t)) return 'time';
    if (/^bool/.test(t)) return 'bool';
    if (/^(text|character|uuid|name)/.test(t)) return 'text';
    return null;
  }

  // ── Resolution ───────────────────────────────────────────────────────
  /**
   * @param {string} name        result column name
   * @param {'number'|'date'|'string'|'boolean'} profiled  from value profiling
   * @param {object} sources     { overrides, reportMetadata, catalogIndex }
   * @returns {{semantic:string, source:'override'|'report'|'catalog'|'inferred'}}
   */
  function resolve(name, profiled, sources) {
    const s = sources || {};

    const override = s.overrides && s.overrides[name];
    if (override && SEMANTICS.includes(override)) return { semantic: override, source: 'override' };

    const meta = s.reportMetadata && s.reportMetadata[name];
    const fromReport = meta && (typeof meta === 'string' ? meta : meta.semantic);
    if (fromReport && SEMANTICS.includes(fromReport)) return { semantic: fromReport, source: 'report' };

    // Profiling beats the catalog on the two things profiling cannot get
    // wrong: a value that is not a number is not a measure, whatever a
    // same-named column elsewhere in the schema happens to be. A result
    // column can be an expression (`sum(qty) as units`) whose name collides
    // with a real column of a different kind.
    if (profiled === 'date') return { semantic: 'date', source: 'inferred' };
    if (profiled === 'boolean') return { semantic: 'boolean', source: 'inferred' };
    if (profiled !== 'number') return { semantic: 'category', source: 'inferred' };

    const kind = s.catalogIndex && s.catalogIndex.get(name);
    if (kind === 'int') {
      // An integer column is a count. This is the whole point of the layer:
      // `total_units` is integer, so it is a count no matter how much its
      // name looks like money. A percentage stored as an integer is the one
      // real exception, so the name still gets to say "percent".
      return { semantic: PERCENT_RE.test(name) ? 'percent' : 'count', source: 'catalog' };
    }
    if (kind === 'decimal') {
      if (PERCENT_RE.test(name)) return { semantic: 'percent', source: 'catalog' };
      if (CURRENCY_RE.test(name)) return { semantic: 'currency', source: 'catalog' };
      return { semantic: 'number', source: 'catalog' };
    }

    // Layer 4: nothing grounded to go on. Order matters -- count words are
    // checked before currency words because half of them co-occur
    // ("total_units", "net_units_sold", "order_count").
    if (PERCENT_RE.test(name)) return { semantic: 'percent', source: 'inferred' };
    if (COUNT_RE.test(name)) return { semantic: 'count', source: 'inferred' };
    if (CURRENCY_RE.test(name)) return { semantic: 'currency', source: 'inferred' };
    return { semantic: 'number', source: 'inferred' };
  }

  /** Resolve every profiled column at once. */
  function resolveAll(profile, sources) {
    const out = {};
    for (const col of profile || []) out[col.name] = resolve(col.name, col.type, sources);
    return out;
  }

  /**
   * The subset worth writing back to the report as columns_metadata. Only
   * grounded or human answers are worth persisting -- seeding the report
   * with a pure name guess would launder a guess into an authoritative
   * record, and the next reader could no longer tell the difference.
   */
  function seedableMetadata(resolved) {
    const out = {};
    for (const [name, r] of Object.entries(resolved || {})) {
      if (r.source === 'inferred' && r.semantic === 'number') continue;
      if (r.source === 'inferred' && (r.semantic === 'currency' || r.semantic === 'count')) continue;
      out[name] = { semantic: r.semantic, source: r.source };
    }
    return out;
  }

  const isMeasure = (semantic) => MEASURES.has(semantic);

  global.SiloFieldSemantics = {
    SEMANTICS, resolve, resolveAll, buildCatalogIndex, seedableMetadata, isMeasure, pgKind,
  };
})(window);
