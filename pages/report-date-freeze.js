/* ==========================================================================
   Frozen dates in a saved report
   --------------------------------------------------------------------------
   Ask SILO writes the model's SQL to silo_chat_saved_reports verbatim, with
   no `parameters` at all. When that SQL carries a literal date -- and on
   production 2026-10-14, 35 of the 231 saved reports did -- the report is
   pinned to the window it was asked about and will report that window
   forever. The person who saved it believes they saved "sales last month".

   This file is the one place that decides what a frozen date looks like and
   how to turn one into a parameter. It is loaded by Ask SILO (which offers
   the fix at save time) and by the v3 report page (which flags a report
   already saved this way), so the two can never disagree about which
   reports are affected.

   It is deliberately conservative. A rewrite it is not sure of is not
   offered: a wrong rewrite changes what a report MEANS, silently, and that
   is worse than leaving a frozen report frozen and saying so.
   ========================================================================== */
(function (global) {
  'use strict';

  // A date literal as Postgres and the model both write it: '2026-09-01'
  // or date '2026-09-01'. Captured with its quotes so a rewrite can replace
  // the whole literal, and with the optional `date` keyword so the rewrite
  // does not leave a dangling one in front of a {{token}}.
  // The \b belongs to the `date` keyword alone. Written as \b(?:date\s+)?
  // it demanded a word boundary immediately before the quote, and a
  // quote preceded by a space is not one -- so a bare '2026-09-01' was
  // invisible and only `date '...'` was ever found.
  const LITERAL_RE = /(?:\bdate\s+)?'(\d{4}-\d{2}-\d{2})'/gi;

  // The comparison a literal sits in, which is what decides whether the
  // window is inclusive. `between a and b` puts `between` before the first
  // and `and` before the second; a half-open month is `>= a ... < b`.
  //
  // Both SIDES are read, because a bound can be written either way round:
  //   day_date < '2026-10-01'          -- strict, in front
  //   '2026-10-01'::date > day_date    -- the same bound, strict behind
  // and the wrapping a hand-written query puts around a literal has to be
  // stepped over, or the operator hides behind it:
  //   day_date < ('2026-10-01'::date)  -- `(` is not an operator
  // No `date` keyword to step over in front: LITERAL_RE has already taken
  // it as part of the match.
  const OPERATOR_RE = /(<=|>=|<>|!=|<|>|=|\bbetween\b|\band\b)\s*$/i;
  const OPEN_RE = /[\s(]+$/;
  // A cast and any number of closing parens, before whatever comes next.
  const AFTER_RE = /^(?:\s|\)|::\s*[A-Za-z_][\w ]*)*/;
  const STRICT_AFTER_RE = /^(<|>)(?!=)/;

  /** Every literal date in a SQL string, in order, with its position and the
   *  comparison on either side of it. `op` is what precedes it and `nextOp`
   *  the strict operator that follows, if any; both see through parentheses
   *  and casts. */
  function findLiterals(sql) {
    const out = [];
    const text = String(sql || '');
    LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = LITERAL_RE.exec(text))) {
      const before = text.slice(0, m.index).replace(OPEN_RE, '').match(OPERATOR_RE);
      const rest = text.slice(m.index + m[0].length).replace(AFTER_RE, '');
      const after = rest.match(STRICT_AFTER_RE);
      out.push({
        match: m[0], date: m[1], index: m.index,
        op: before ? before[1].toLowerCase() : null,
        nextOp: after ? after[1] : null,
      });
    }
    return out;
  }

  // The comparisons that put a literal ON the window, both ends included.
  // `between` and the `and` that follows it are the two halves of a BETWEEN;
  // null is a literal that is not a bound at all (a select list, a cast, a
  // function argument), which has no inclusivity to get wrong.
  const INCLUSIVE_OPS = ['>=', '<=', '=', 'between', 'and', null];

  /** True when this literal's comparison is demonstrably inclusive. Anything
   *  the detection cannot place is NOT inclusive: the rewrite refuses rather
   *  than assuming the shape it happens to recognise. */
  function isInclusiveBound(lit) {
    return INCLUSIVE_OPS.includes(lit.op) && !lit.nextOp;
  }

  /**
   * What is frozen about a report's queries.
   *
   * `dates` is every distinct date in order of first appearance.
   * `frozen` is true when there is at least one AND the report declares no
   * date parameter -- a report WITH a date parameter may legitimately carry
   * a literal somewhere else (a cohort start, a launch day) and is not
   * something to warn about.
   */
  function inspect(queries, parameters) {
    const list = Array.isArray(queries) ? queries : [];
    const declaresDate = (Array.isArray(parameters) ? parameters : [])
      .some((p) => p && String(p.type).toLowerCase() === 'date');
    const seen = new Set();
    const dates = [];
    for (const sql of list) {
      for (const lit of findLiterals(sql)) {
        if (seen.has(lit.date)) continue;
        seen.add(lit.date);
        dates.push(lit.date);
      }
    }
    const sorted = dates.slice().sort();
    return {
      dates,
      declaresDate,
      frozen: dates.length > 0 && !declaresDate,
      from: sorted[0] || null,
      to: sorted[sorted.length - 1] || null,
    };
  }

  /** One sentence for a person, or '' when nothing is frozen. */
  function describe(info) {
    if (!info || !info.frozen) return '';
    if (info.dates.length === 1) {
      return `This report is fixed to ${info.from}. It will report that date every time it runs.`;
    }
    return `This report is fixed to ${info.from} → ${info.to}. It will report that window every `
      + 'time it runs, however long ago it was.';
  }

  /**
   * Default values for the two parameters a rewrite declares.
   *
   * The window's LENGTH is the thing worth keeping: someone who asked about
   * the last 30 days wants a rolling 30 days, not a rolling 94. The end is
   * `today-1d` because a report built on yesterday's completed day is what
   * every shipped SILO report defaults to, and a partial today is a
   * different question.
   *
   * A window that is exactly one calendar month maps to prior_month rather
   * than to a day count -- "last month" is what the person meant, and 28,
   * 30 and 31 days are not interchangeable with it.
   */
  function defaultsForWindow(from, to) {
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO.test(String(from)) || !ISO.test(String(to))) return null;
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const start = new Date(fy, fm - 1, fd);
    const end = new Date(ty, tm - 1, td);
    if (!(end >= start)) return null;
    // A whole calendar month: the 1st to that month's last day.
    const lastOfMonth = new Date(fy, fm, 0).getDate();
    if (fd === 1 && fy === ty && fm === tm && td === lastOfMonth) {
      return { from: 'prior_month_start', to: 'prior_month_end' };
    }
    const days = Math.round((end - start) / 86400000);
    return { from: `today-${days + 1}d`, to: 'today-1d' };
  }

  /**
   * Rewrite a report's queries so its date window is a parameter.
   *
   * Returns { queries, parameters } or { error }. It refuses -- rather than
   * guessing -- unless the report uses EXACTLY two distinct dates, because
   * that is the only shape whose meaning is unambiguous. One date could be
   * an as-of, a cutoff or a cohort start; three or more could be a
   * comparison between two windows, and parameterising the wrong pair turns
   * a year-on-year report into nonsense that still returns rows.
   */
  function parameterize(queries, keyFrom, keyTo) {
    const list = Array.isArray(queries) ? queries : [];
    const info = inspect(list, []);
    if (info.dates.length !== 2) {
      return {
        error: info.dates.length < 2
          ? 'This report uses one fixed date, so there is no window to make adjustable. Open it in the report builder to declare a parameter.'
          : `This report uses ${info.dates.length} fixed dates, so which two are the window is a guess. Open it in the report builder to declare the parameters.`,
      };
    }
    const from = info.from;
    const to = info.to;
    // A HALF-OPEN window is refused, because its two dates do not mean what
    // they look like. `day_date >= '2026-09-01' and day_date < '2026-10-01'`
    // is September, but its literals are 1 Sep and 1 Oct -- a 31-day span
    // whose end is a day the report deliberately excludes. Rewriting it
    // keeps the `<`, so the report would then report everything up to but
    // not including the chosen end: pick Last month and the last day of the
    // month disappears. Normalising it would mean rewriting the operator as
    // well as the literal, which is a different and much larger promise.
    //
    // So the test is POSITIVE: every literal has to be demonstrably on an
    // inclusive bound. Listing the strict spellings to refuse is the version
    // that leaks, because a bound can be parenthesised, cast or written back
    // to front and each spelling has to be thought of in advance. Refusing
    // whatever cannot be placed costs only a handoff to the report builder.
    const unsafe = findLiterals(list.join('\n')).filter((l) => !isInclusiveBound(l));
    if (unsafe.length) {
      return {
        error: 'This report\u2019s date bounds are not both inclusive, so its two dates are not the '
          + 'window they look like. Open it in the report builder to declare the parameters.',
      };
    }
    const defaults = defaultsForWindow(from, to);
    if (!defaults) return { error: 'Those dates are not a window that can be made relative.' };
    const fromKey = keyFrom || 'date_from';
    const toKey = keyTo || 'date_to';
    const rewritten = list.map((sql) => String(sql || '').replace(LITERAL_RE, (whole, d) => {
      if (d === from) return `{{${fromKey}}}`;
      if (d === to) return `{{${toKey}}}`;
      return whole;
    }));
    return {
      queries: rewritten,
      parameters: [
        // date_basis 'company': the window is resolved by Postgres in the
        // company's calendar at run time, not in whichever timezone the
        // browser that saved the report happened to be in.
        { key: fromKey, type: 'date', label: 'From', default: defaults.from, date_basis: 'company' },
        { key: toKey, type: 'date', label: 'Through', default: defaults.to, date_basis: 'company' },
      ],
      window: { from, to, defaults },
    };
  }

  global.SiloReportDateFreeze = {
    findLiterals, isInclusiveBound, inspect, describe, defaultsForWindow, parameterize,
  };
}(typeof window !== 'undefined' ? window : globalThis));
