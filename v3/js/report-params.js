/* ==========================================================================
   SILO v3 — report parameters
   --------------------------------------------------------------------------
   A saved report declares what it needs; a dashboard supplies it; this file
   turns the pair into runnable SQL. It is the only place a value from a UI
   control ever becomes part of a query, so the rules live here and nowhere
   else.

     report.parameters      [{ key, type, label, default, options? }]
     dashboard.filter_state { "grain": "week", "report_date": "2026-09-01" }
     report SQL             select * from wow_kpi_compare({{report_date}}, {{grain}})

   ── Substitution is typed, never string interpolation ────────────────────
   chat_run_readonly_query is SECURITY INVOKER, so nothing pushed through a
   parameter can read another company's rows -- RLS still decides that. But
   it could rewrite the report into a question nobody asked, and "the blast
   radius is small" is a bad reason to build an injection point. So a value
   never reaches the SQL as text. It is converted to a LITERAL by type:

     number   Number() + isFinite, emitted as digits. Unforgeable: a string
              that is not a number cannot survive the conversion at all.
     date     matched against YYYY-MM-DD after relative tokens are resolved,
              emitted as `date '2026-09-01'`.
     enum     must be === one of the DECLARED options. Not "sanitised" --
              compared. Anything else is rejected.
     text     single-quoted, quotes doubled (Postgres literal escaping under
              standard_conforming_strings, which is the default and which
              Supabase does not turn off).

   And a {{token}} in the SQL that no parameter declares is an ERROR, never
   a passthrough and never left in place. The declaration is the allowlist:
   if it is not declared, it does not substitute, and the query does not run.

   ── Why values are resolved client-side into literals ────────────────────
   The alternative is passing values to Postgres as bind parameters, which
   is stronger in general. It is not available here: chat_run_readonly_query
   takes ONE text argument and EXECUTEs it, because it exists to run SQL
   nobody wrote in advance. Given that, the honest design is to make the set
   of things a parameter can become small and typed, and to make an
   undeclared token fatal -- rather than to imply a safety the RPC's shape
   cannot provide.
   ========================================================================== */
(function (global) {
  'use strict';

  const TYPES = ['date', 'number', 'enum', 'text'];

  // {{key}} — keys are snake_case identifiers so a token can never be
  // confused with SQL punctuation, and so the same regex validates a
  // declaration and finds a use.
  const KEY_RE = /^[a-z][a-z0-9_]*$/;
  const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const RELATIVE_RE = /^today(?:\s*-\s*(\d{1,5})d)?$/;
  // Anything a terminal or a SQL parser would treat as structure rather
  // than content. Written as escapes: these bytes are invisible in a diff.
  const CONTROL_RE = /[\x00-\x1f\x7f]/;

  // ── Dates ──────────────────────────────────────────────────────────
  // Built from LOCAL date components, never toISOString(): a user in PST
  // asking for "today" at 5pm gets tomorrow's date out of UTC, and a
  // dashboard that silently reports one day ahead is worse than one that
  // errors.
  function localISO(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * Resolve a date expression to YYYY-MM-DD, or null if it is not one.
   * Accepts a literal date, or one of a deliberately small set of relative
   * tokens -- enough for "last 28 days" and "this month", not a date DSL.
   */
  function resolveDateExpr(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return null;
    if (ISO_DATE_RE.test(s)) {
      // Reject 2026-02-31 and friends: the regex only proves the shape.
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const round = dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
      return round ? s : null;
    }
    const now = new Date();
    if (s === 'month_start') return localISO(new Date(now.getFullYear(), now.getMonth(), 1));
    if (s === 'year_start') return localISO(new Date(now.getFullYear(), 0, 1));
    // Day 0 of the NEXT month is the last day of this one, which handles
    // February and leap years without a table of month lengths.
    if (s === 'month_end') return localISO(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    // Planning reports ask "arriving by end of year" far more often than
    // they ask about the start of it, and a literal '2026-12-31' default
    // freezes the report on the year it was written.
    if (s === 'year_end') return localISO(new Date(now.getFullYear(), 11, 31));
    const rel = RELATIVE_RE.exec(s);
    if (rel) {
      const days = rel[1] ? Number(rel[1]) : 0;
      return localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
    }
    return null;
  }

  const DATE_HINT = 'a date (YYYY-MM-DD), or today, today-27d, month_start, month_end, year_start, year_end';

  // ── Declarations ───────────────────────────────────────────────────
  /**
   * Clean a stored `parameters` value into declarations this file will act
   * on. Anything malformed is DROPPED rather than half-honoured -- a
   * declaration that cannot be understood must not become a token that
   * silently substitutes something unintended.
   */
  function normalizeDeclarations(parameters) {
    if (!Array.isArray(parameters)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of parameters) {
      if (!raw || typeof raw !== 'object') continue;
      const key = String(raw.key || '').trim().toLowerCase();
      const type = String(raw.type || '').trim().toLowerCase();
      if (!KEY_RE.test(key) || !TYPES.includes(type) || seen.has(key)) continue;
      const decl = {
        key,
        type,
        label: String(raw.label || '').trim() || key.replace(/_/g, ' '),
        default: raw.default === undefined || raw.default === null ? '' : String(raw.default),
      };
      if (type === 'enum') {
        decl.options = (Array.isArray(raw.options) ? raw.options : [])
          .map((o) => String(o)).filter((o) => o !== '');
        // An enum with nothing to choose from can never resolve, so it is
        // not a usable declaration.
        if (!decl.options.length) continue;
      }
      seen.add(key);
      out.push(decl);
    }
    return out;
  }

  /** Every distinct {{token}} used in a SQL string, in order of appearance. */
  function tokensIn(sql) {
    const out = [];
    const seen = new Set();
    const text = String(sql || '');
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(text))) {
      const key = m[1].toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
    return out;
  }

  // ── Value -> SQL literal ───────────────────────────────────────────
  /**
   * The whole security surface, in one function. Returns { literal } or
   * { error }; it never returns the input, and it never falls through to a
   * default that emits the raw value.
   */
  function toLiteral(decl, value) {
    const label = decl.label || decl.key;
    const raw = value == null ? '' : String(value);

    if (decl.type === 'number') {
      const n = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(n)) {
        return { error: `"${label}" must be a number.` };
      }
      return { literal: String(n) };
    }

    if (decl.type === 'date') {
      const iso = resolveDateExpr(raw);
      if (!iso) return { error: `"${label}" must be ${DATE_HINT}.` };
      return { literal: `date '${iso}'` };
    }

    if (decl.type === 'enum') {
      const opts = decl.options || [];
      // Compared, not sanitised. An option list is an allowlist.
      if (!opts.some((o) => o === raw)) {
        return { error: `"${label}" must be one of: ${opts.join(', ')}.` };
      }
      return { literal: "'" + raw.replace(/'/g, "''") + "'" };
    }

    // text
    if (CONTROL_RE.test(raw)) {
      return { error: `"${label}" contains a control character.` };
    }
    // chat_run_readonly_query rejects a semicolon ANYWHERE in the query as
    // its single-statement guard, so a value carrying one would fail with
    // an error about the statement rather than about the field. Say the
    // true thing here instead of letting the runner say a confusing one.
    if (raw.includes(';')) {
      return { error: `"${label}" cannot contain a semicolon.` };
    }
    return { literal: "'" + raw.replace(/'/g, "''") + "'" };
  }

  /**
   * The value a parameter should take: the supplied one if there is one,
   * otherwise the declared default. Empty string counts as "not supplied"
   * so clearing a control falls back to the report's own default rather
   * than erroring.
   */
  function effectiveValue(decl, supplied) {
    const v = supplied && Object.prototype.hasOwnProperty.call(supplied, decl.key)
      ? supplied[decl.key] : undefined;
    if (v === undefined || v === null || String(v) === '') return decl.default;
    return String(v);
  }

  /**
   * Substitute a report's parameters into its SQL.
   *
   * Returns { sql } or { error }. Three ways to get an error, all of them
   * refusing to run rather than running something approximate:
   *   - the SQL uses a token no parameter declares
   *   - a declared parameter has no value and no default
   *   - a value fails its type's validation
   */
  function substitute(sql, declarations, values) {
    const text = String(sql || '');
    const decls = normalizeDeclarations(declarations);
    const used = tokensIn(text);
    if (!used.length) return { sql: text };

    const byKey = new Map(decls.map((d) => [d.key, d]));
    const undeclared = used.filter((k) => !byKey.has(k));
    if (undeclared.length) {
      return {
        error: `This report's SQL uses ${undeclared.map((k) => `{{${k}}}`).join(', ')}, `
          + `which ${undeclared.length === 1 ? 'is not a declared parameter' : 'are not declared parameters'}. `
          + 'Declare it in the report, or remove the token.',
      };
    }

    const literals = new Map();
    for (const key of used) {
      const decl = byKey.get(key);
      const value = effectiveValue(decl, values);
      if (value === '' || value === undefined) {
        return { error: `"${decl.label}" needs a value.` };
      }
      const res = toLiteral(decl, value);
      if (res.error) return { error: res.error };
      literals.set(key, res.literal);
    }

    TOKEN_RE.lastIndex = 0;
    return { sql: text.replace(TOKEN_RE, (_m, k) => literals.get(k.toLowerCase())) };
  }

  // ── Dashboard-level merge ──────────────────────────────────────────
  /**
   * The union of parameters declared across a dashboard's widgets, keyed by
   * parameter key -- one control per key however many reports want it, which
   * is what makes a slicer a DASHBOARD control rather than a widget setting.
   *
   * Two reports declaring the same key with different types is an authoring
   * mistake we can neither resolve nor ignore, so the merged declaration
   * records the conflict and the header renders it as a warning instead of
   * guessing which report to believe.
   */
  function mergeDeclarations(widgets) {
    const merged = new Map();
    for (const w of widgets || []) {
      if (!w || !w.query_sql) continue;
      const decls = normalizeDeclarations(w.report_parameters);
      const used = new Set(tokensIn(w.query_sql));
      for (const d of decls) {
        // A parameter the report declares but never uses is dead weight in
        // the header. Only declarations the SQL actually reads get a control.
        if (!used.has(d.key)) continue;
        const prev = merged.get(d.key);
        if (!prev) {
          merged.set(d.key, Object.assign({}, d, { usedBy: [w.id] }));
          continue;
        }
        prev.usedBy.push(w.id);
        if (prev.type !== d.type) prev.conflict = `declared as both ${prev.type} and ${d.type}`;
        if (prev.type === 'enum' && d.type === 'enum') {
          // Intersect: only offer a choice EVERY report using this key can
          // accept, so picking one can never break a tile.
          const shared = (prev.options || []).filter((o) => (d.options || []).includes(o));
          prev.options = shared;
          if (!shared.length) prev.conflict = 'reports share no common options';
        }
      }
    }
    return Array.from(merged.values());
  }

  /** Starting values for a set of merged declarations. */
  function defaultsFor(declarations, saved) {
    const out = {};
    for (const d of declarations || []) {
      const v = effectiveValue(d, saved);
      if (v !== '' && v !== undefined) out[d.key] = v;
    }
    return out;
  }

  global.SiloReportParams = {
    TYPES, KEY_RE, DATE_HINT,
    normalizeDeclarations, tokensIn, toLiteral, effectiveValue,
    substitute, mergeDeclarations, defaultsFor, resolveDateExpr, localISO,
  };
})(window);
