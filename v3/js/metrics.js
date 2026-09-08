/* ==========================================================================
   SILO v3 — metric definitions and comparison arithmetic
   --------------------------------------------------------------------------
   Two questions that were previously answered in four places each:

     "How do I combine this column?"     -- summing a rate is not a number.
     "How much did it change?"           -- a rate changes in POINTS.

   field-semantics.js already answers "what does this column mean" (currency
   / count / percent / date / category). This file is the layer above it:
   given a semantic, HOW is the column aggregated, what is it called, and
   what does a change in it mean. Nothing here touches ECharts or the DOM.

   ── Ratios are aggregated from their parts, never from themselves ────────
   The single most common wrong number on a dashboard is a rolled-up rate.
   Conversion of 2% over 100 sessions and 10% over 10,000 sessions is not
   6%; it is 9.9%. Averaging the two is wrong and summing them is not even
   a quantity. So a ratio is only ever aggregated when its NUMERATOR and
   DENOMINATOR are both present in the same result -- sum both, then divide
   -- and where they are not, the aggregate is refused and says why. An
   honest blank beats a plausible number.

   `RATIOS` maps the ratio columns SILO actually produces onto the pair
   they come from. It is a lookup, not a heuristic: a column named
   `conversion_rate` in a report that returns neither sessions nor orders
   cannot be pooled, and inventing a denominator would be worse than
   refusing.

   ── Total sales is not net sales ─────────────────────────────────────────
   They differ by discounts, returns and (depending on the report) shipping
   and tax, and the two live side by side in SILO's own sales rollups. A
   dashboard that labels either one "Sales" makes the difference invisible
   at exactly the moment someone is comparing two tiles. Both are labelled
   in full, always, and the label comes from here so it reads the same on
   every surface.
   ========================================================================== */
(function (global) {
  'use strict';

  /* Canonical labels for the columns SILO's reports keep returning. Only
     names whose short form is genuinely ambiguous or wrong are listed --
     the generic title-caser in chart-adapter.js handles the rest, and a
     dictionary that tries to name every column goes stale. */
  const LABELS = {
    net_sales: 'Net Sales',
    total_sales: 'Total Sales',
    gross_sales: 'Gross Sales',
    online_net_sales: 'Online Net Sales',
    units: 'Units',
    units_sold: 'Units Sold',
    qty: 'Qty',
    orders: 'Orders',
    order_count: 'Orders',
    aov: 'AOV',
    roas: 'ROAS',
    mer: 'MER',
    ad_spend: 'Ad Spend',
    sessions: 'Sessions',
    conversion_rate: 'Conversion Rate',
    sell_through_pct: 'Sell-through',
    margin_pct: 'Margin',
  };

  /* A ratio and the two columns it is the ratio OF. Pooled correctly when
     both are in the same result; refused when they are not. */
  const RATIOS = {
    conversion_rate: { numerator: 'orders', denominator: 'sessions', scale: 100 },
    aov: { numerator: 'net_sales', denominator: 'orders', scale: 1 },
    roas: { numerator: 'online_net_sales', denominator: 'ad_spend', scale: 1 },
    mer: { numerator: 'net_sales', denominator: 'ad_spend', scale: 1 },
    sell_through_pct: { numerator: 'units_sold', denominator: 'units_received', scale: 100 },
    margin_pct: { numerator: 'gross_margin', denominator: 'net_sales', scale: 100 },
  };

  /* Which aggregate is DEFENSIBLE for a semantic. A rate is deliberately
     absent from the summable set: see the file header. */
  const SUMMABLE = new Set(['currency', 'count', 'number']);

  const label = (name) => LABELS[String(name || '').toLowerCase()] || null;

  const isRate = (semantic) => semantic === 'percent';

  /** The ratio definition for a column, if SILO knows one. */
  function ratioFor(name) {
    return RATIOS[String(name || '').toLowerCase()] || null;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function sumOf(rows, field) {
    let total = 0;
    let seen = 0;
    for (const r of rows || []) {
      const n = num(r[field]);
      if (n === null) continue;
      total += n; seen += 1;
    }
    return seen ? total : null;
  }

  /**
   * Roll a column up across rows, honestly.
   *
   * Returns { value, method, note } or { value: null, refused, note }.
   * `method` names what was actually done, so a caller can print it --
   * "pooled from orders / sessions" is a materially different claim from
   * "sum", and a tile that says which one it did is auditable.
   */
  function aggregate(rows, field, semantic, options) {
    const opts = options || {};
    const requested = opts.aggregate;
    const list = rows || [];
    if (!list.length) return { value: null, note: 'no rows' };

    const nums = list.map((r) => num(r[field])).filter((n) => n !== null);
    if (!nums.length) return { value: null, note: 'no numeric values' };

    // An explicit non-sum choice is the author's, and is honoured as asked.
    if (requested && requested !== 'sum' && requested !== 'auto') {
      if (requested === 'first') return { value: nums[0], method: 'first' };
      if (requested === 'last') return { value: nums[nums.length - 1], method: 'last' };
      if (requested === 'avg') return { value: nums.reduce((a, b) => a + b, 0) / nums.length, method: 'avg' };
      if (requested === 'min') return { value: Math.min(...nums), method: 'min' };
      if (requested === 'max') return { value: Math.max(...nums), method: 'max' };
      if (requested === 'count') return { value: nums.length, method: 'count' };
    }

    if (isRate(semantic)) {
      // One row is not an aggregation -- it is the value.
      if (list.length === 1) return { value: nums[0], method: 'single row' };
      const def = ratioFor(field);
      const cols = list[0] ? Object.keys(list[0]) : [];
      if (def && cols.includes(def.numerator) && cols.includes(def.denominator)) {
        const n = sumOf(list, def.numerator);
        const d = sumOf(list, def.denominator);
        if (n !== null && d) {
          return {
            value: (n / d) * (def.scale || 1),
            method: `pooled from ${def.numerator} ÷ ${def.denominator}`,
          };
        }
        if (d === 0) return { value: null, refused: true, note: `${def.denominator} totals zero` };
      }
      // No parts in the result: refuse rather than average. An average of
      // rates is a number, just not the one anybody wanted.
      return {
        value: null,
        refused: true,
        note: `a rate cannot be summed, and averaging ${list.length} of them is not the pooled rate`
          + (def ? ` — add ${def.numerator} and ${def.denominator} to this report to pool it correctly` : ''),
      };
    }

    if (SUMMABLE.has(semantic) || semantic === undefined) {
      return { value: nums.reduce((a, b) => a + b, 0), method: 'sum' };
    }
    return { value: null, refused: true, note: `${semantic} values do not add up` };
  }

  /**
   * Change between two values, in the unit the metric is actually measured
   * in.
   *
   * A rate changes in PERCENTAGE POINTS: 4% to 5% is +1pp, and calling it
   * +25% is a different (and usually more flattering) statement about a
   * different quantity. Both are returned so a caller can print the right
   * one and, where it helps, the other in parentheses.
   */
  function change(current, prior, semantic) {
    const c = num(current);
    const p = num(prior);
    if (c === null || p === null) return { ok: false, reason: 'one side is missing' };
    const absolute = c - p;
    const out = { ok: true, absolute, current: c, prior: p, semantic };
    if (isRate(semantic)) {
      out.points = absolute;
      out.unit = 'pp';
      out.direction = absolute === 0 ? 'flat' : absolute > 0 ? 'up' : 'down';
      // The relative change of a rate is still computable and is still a
      // real thing; it is just not what "change" means for a rate.
      out.percent = p === 0 ? null : (absolute / Math.abs(p)) * 100;
      return out;
    }
    out.unit = '%';
    out.percent = p === 0 ? null : (absolute / Math.abs(p)) * 100;
    out.direction = absolute === 0 ? 'flat' : absolute > 0 ? 'up' : 'down';
    if (p === 0) out.note = 'no prior value to divide by';
    return out;
  }

  // ── Period arithmetic ──────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };

  /** Whole days in an INCLUSIVE range. 1st to 7th is 7 days, not 6. */
  function inclusiveDays(from, to) {
    const a = parse(from); const b = parse(to);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000) + 1;
  }

  /**
   * The window immediately before an inclusive range, of the same length.
   *
   * Stated explicitly rather than "last month": for 1–7 Sep this is
   * 25–31 Aug, and a caller is expected to print those dates. A comparison
   * whose window the reader cannot see is a comparison they cannot check.
   */
  function priorPeriod(from, to) {
    const days = inclusiveDays(from, to);
    if (!days) return null;
    const a = parse(from);
    const end = new Date(a.getFullYear(), a.getMonth(), a.getDate() - 1);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
    return { from: iso(start), to: iso(end), days, basis: 'previous period' };
  }

  /**
   * The same calendar window one year earlier.
   *
   * Calendar-shifted, not 365-day-shifted, because "last year" means the
   * same dates -- and 29 Feb is snapped back to 28 Feb rather than silently
   * becoming 1 March.
   */
  function priorYear(from, to) {
    const a = parse(from); const b = parse(to);
    if (!a || !b) return null;
    const shift = (d) => {
      const y = d.getFullYear() - 1;
      const day = Math.min(d.getDate(), new Date(y, d.getMonth() + 1, 0).getDate());
      return iso(new Date(y, d.getMonth(), day));
    };
    return { from: shift(a), to: shift(b), days: inclusiveDays(from, to), basis: 'same dates last year' };
  }

  /**
   * Is this comparison even answerable?
   *
   * Refuses rather than manufacturing one: two rows is not a trend, and a
   * period whose length nobody knows cannot have a "previous period".
   */
  function canCompare(kind, context) {
    const ctx = context || {};
    if (kind === 'previous_row') {
      return ctx.rowCount >= 2
        ? { ok: true }
        : { ok: false, reason: 'needs at least two rows to have a previous one' };
    }
    if (kind === 'previous_period' || kind === 'previous_year') {
      if (!ctx.from || !ctx.to) {
        return { ok: false, reason: 'needs a date range on the dashboard to know what the previous period is' };
      }
      return { ok: true };
    }
    if (kind === 'column') {
      return ctx.hasColumn ? { ok: true } : { ok: false, reason: 'the comparison column is not in this result' };
    }
    return { ok: false, reason: 'unknown comparison' };
  }

  global.SiloMetrics = {
    LABELS, RATIOS, SUMMABLE,
    label, isRate, ratioFor, aggregate, change,
    inclusiveDays, priorPeriod, priorYear, canCompare,
    _num: num, _iso: iso, _parse: parse,
  };
})(window);
