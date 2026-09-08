/* ==========================================================================
   SILO v3 — chart adapter
   --------------------------------------------------------------------------
   The one place that knows how to turn (rows, visual_config) into a drawn
   visual. Nothing else in v3 talks to ECharts.

   Rows arrive as plain objects straight from the read-only query runner, so the
   adapter starts by PROFILING them: it has no schema to consult and must
   decide from the values themselves which columns are dimensions and which
   are measures. Everything downstream -- the recommendation, the inspector's
   field pickers, the axis formatting -- is built on that profile.

   What a column MEANS lives in field-semantics.js, not here. This file asks
   "how do I print a currency value"; that one answers "is this column
   currency at all", grounded in the report's saved metadata and the
   database's own column types rather than in a regex over the name.

   Deliberately not here: anything that rewrites SQL. A widget's dataset is
   whatever its saved report's query returned. Sort/limit/top-N and
   aggregation are applied to those returned rows, client side, which is
   honest about the fact that the query runner caps every result at 1000
   rows per page (dashboard-renderer.js pages a table widget past that;
   see its header for why charts don't).

   One visual has no rows at all: answerHtml() renders a saved report's
   ANSWER text (prose, not a dataset) as sanitized markdown. It is here
   alongside tableHtml/matrixHtml/kpiHtml because this file is already "how
   is a widget body rendered", not because markdown parsing is ECharts.
   ========================================================================== */
(function (global) {
  'use strict';

  // ── Palette ──────────────────────────────────────────────────────────
  // Explicit hex, not the beacon oklch() tokens read off :root. ECharts
  // does not just paint these strings -- zrender parses them to derive
  // hover/emphasis shades, and its parser predates oklch(), so an oklch
  // token comes back null and the hover state renders transparent. Hex
  // keeps every derived state working. Hues are matched to beacon's
  // accent/pos/warn/neg by eye so a chart sits next to a KPI band without
  // clashing.
  const PALETTE_LIGHT = ['#2f6fe4', '#17a67c', '#e8873a', '#8a5cd6', '#d94f6a', '#0e9cb5', '#b08a2e', '#6b7a8f'];
  const PALETTE_DARK  = ['#6fa4ff', '#3fd2a4', '#ffab5e', '#b48cf5', '#ff829a', '#45c8dd', '#dfb857', '#9aa9bd'];

  const INK_LIGHT = { ink: '#26303d', ink2: '#5b6673', grid: '#e2e6eb', surface: '#ffffff' };
  const INK_DARK  = { ink: '#eef1f5', ink2: '#9aa6b4', grid: '#333c47', surface: '#2b3038' };

  function isDark() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function theme() {
    const dark = isDark();
    return { dark, palette: dark ? PALETTE_DARK : PALETTE_LIGHT, ...(dark ? INK_DARK : INK_LIGHT) };
  }

  // ── Column profiling ─────────────────────────────────────────────────
  // Postgres hands jsonb numerics back as JS numbers, but a numeric column
  // that overflows a double, or a money column selected as text, arrives as
  // a string. So the check is "does every non-null value parse as a finite
  // number", not typeof.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

  // Dimension names that describe a whole being split up, rather than a
  // list being ranked. Used only by recommend(); the user can pick donut
  // for anything.
  const COMPOSITION_RE = /(channel|location|store|type|category|status|source|platform|segment|region|department|gender|state|country)/i;

  function looksNumeric(v) {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'string' || v.trim() === '') return false;
    return Number.isFinite(Number(v));
  }
  function looksDate(v) {
    return typeof v === 'string' && DATE_RE.test(v);
  }

  /**
   * @returns {{name:string, type:'number'|'date'|'string'|'boolean'|'json', distinct:number, nonNull:number}[]}
   */
  /**
   * The one gate between a database value and an href/src attribute.
   *
   * ONLY http(s), and no whitespace. That rejects javascript:, data:,
   * vbscript: and file: -- every scheme that turns a rendered link into
   * script execution -- and also protocol-relative "//evil.com", which
   * silently inherits the page's scheme. Anything that fails this is
   * rendered as ordinary escaped text instead, never as a link.
   */
  function isHttpUrl(v) {
    return typeof v === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(v.trim());
  }
  const safeUrl = (v) => (isHttpUrl(v) ? String(v).trim() : null);

  const IMAGE_NAME_RE = /(image|img|thumb|thumbnail|photo|picture|avatar|creative)/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;
  /** An image is a URL that either looks like one or is named like one. */
  function looksImageColumn(name, vals) {
    if (IMAGE_NAME_RE.test(name)) return true;
    return vals.length > 0 && vals.every((v) => IMAGE_EXT_RE.test(String(v)));
  }

  function profileColumns(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const names = Object.keys(rows[0] || {});
    const sample = rows.slice(0, 200);
    return names.map((name) => {
      const vals = sample.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== '');
      const distinct = new Set(sample.map((r) => String(r[name]))).size;
      let type = 'string';
      if (!vals.length) type = 'string';
      // A jsonb column arrives as a real object or array. It is neither a
      // dimension nor a measure -- there is nothing to plot -- and calling
      // it a string is how it ended up rendered as "[object Object]".
      else if (vals.some((v) => v !== null && typeof v === 'object')) type = 'json';
      else if (vals.every((v) => typeof v === 'boolean')) type = 'boolean';
      else if (vals.every(looksDate)) type = 'date';
      else if (vals.every(looksNumeric)) type = 'number';
      // Decided by the VALUES, not the name: every non-null value is an
      // http(s) URL. A column *named* `link` might hold anything, but a
      // column full of URLs is a link whatever it is called.
      else if (vals.every(isHttpUrl)) type = looksImageColumn(name, vals) ? 'image' : 'url';
      return { name, type, distinct, nonNull: vals.length };
    });
  }

  /* Composite map key. A single non-printing byte, so two dimension values
     can never collide by containing the separator themselves -- 'A|B' x 'C'
     and 'A' x 'B|C' are different cells. */
  const SEP = String.fromCharCode(0);

  const NOT_A_FIELD = new Set(['json', 'url', 'image']);
  const dimensionsOf = (prof) => prof.filter((c) => c.type !== 'number' && !NOT_A_FIELD.has(c.type));
  const measuresOf = (prof) => prof.filter((c) => c.type === 'number');

  /**
   * Suggest a visual for a freshly added widget. Intentionally conservative:
   * table is the answer whenever the shape is ambiguous, because a table is
   * never WRONG -- it just isn't the most expressive choice. A chart that
   * picks the wrong dimension is worse than a table.
   */
  function recommend(rows, semantics) {
    const prof = profileColumns(rows);
    const dims = dimensionsOf(prof);
    // A column that profiles as a number is not necessarily something worth
    // plotting -- an id, a year, a rank all profile as numbers. Semantics
    // let the recommendation prefer a column that actually MEANS a
    // quantity, and fall back to raw profiling when nothing is known.
    const allMeas = measuresOf(prof);
    const ranked = allMeas.slice().sort((a, b) =>
      measureRank(semanticOf(b.name, semantics, prof)) - measureRank(semanticOf(a.name, semantics, prof)));
    const meas = ranked.length ? ranked : allMeas;

    if (!rows || !rows.length || !prof.length) return { visual_type: 'table', visual_config: {} };
    // Nested JSON is not plottable. Ask SILO returns this shape often --
    // json_agg/row_to_json reads well in prose and charts not at all.
    if (prof.some((c) => c.type === 'json')) return { visual_type: 'table', visual_config: {} };

    // One row, one number: that is a KPI, whatever it is called.
    if (rows.length === 1 && meas.length >= 1) {
      return { visual_type: 'kpi', visual_config: { y_field: meas[0].name, aggregate: 'first' } };
    }
    if (!meas.length || !dims.length) return { visual_type: 'table', visual_config: {} };

    const measure = meas[0].name;
    const dateDim = dims.find((d) => d.type === 'date');
    // A date axis is a time series; drawing it as a bar chart sorted by
    // value would scramble the one ordering that carries meaning.
    if (dateDim) {
      return { visual_type: 'line', visual_config: { x_field: dateDim.name, y_field: measure, sort: 'x_asc', limit: 0, aggregate: defaultAggregate(semanticOf(measure, semantics, prof)) } };
    }
    const dim = dims[0];
    // Donut only when the dimension really is a composition. "Few rows" is
    // not enough of a test on its own: a top-4-products query has few rows
    // and is a ranking, and drawing a ranking as a donut invites reading
    // the top seller as a share of all sales when the query only returned
    // four of thousands of products. So the name has to say composition
    // too -- and bar stays the fallback, since bar is never actively
    // misleading, only sometimes less expressive.
    if (COMPOSITION_RE.test(dim.name) && dim.distinct <= 6 && rows.length <= 8) {
      return { visual_type: 'donut', visual_config: { x_field: dim.name, y_field: measure, sort: 'desc', limit: 8, aggregate: defaultAggregate(semanticOf(measure, semantics, prof)) } };
    }
    return { visual_type: 'bar', visual_config: { x_field: dim.name, y_field: measure, sort: 'desc', limit: 10, aggregate: defaultAggregate(semanticOf(measure, semantics, prof)) } };
  }

  // ── Value formatting ─────────────────────────────────────────────────
  // Driven by SEMANTIC, not by name. The name-based guessing that used to
  // live here is now the last of four layers in field-semantics.js.
  function semanticOf(name, semantics, profile) {
    const s = semantics && semantics[name];
    if (s) return typeof s === 'string' ? s : s.semantic;
    const col = (profile || []).find((c) => c.name === name);
    return global.SiloFieldSemantics.resolve(name, col ? col.type : 'number', {}).semantic;
  }

  // Which numeric column is most likely the thing someone wants plotted.
  // Money first, then counts, then plain numbers; a rate last, because a
  // rate is usually a supporting column rather than the subject.
  const MEASURE_RANK = { currency: 4, count: 3, number: 2, percent: 1 };
  const measureRank = (semantic) => MEASURE_RANK[semantic] || 0;

  // Kept for callers that only have a name (and for the inspector's "auto"
  // label). Ungrounded on purpose -- it is the fallback, not the answer.
  function inferFormat(fieldName) {
    if (!fieldName) return 'number';
    return global.SiloFieldSemantics.resolve(fieldName, 'number', {}).semantic;
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function formatValue(v, semantic) {
    const n = toNumber(v);
    if (n === null) return v === null || v === undefined ? '' : String(v);
    if (semantic === 'currency') {
      return n.toLocaleString(undefined, {
        style: 'currency', currency: 'USD',
        maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
      });
    }
    if (semantic === 'percent') {
      // Values arrive either as 0-1 fractions or as already-scaled 0-100
      // percentages depending on the query. Guessing wrong by 100x is the
      // kind of error nobody catches on a dashboard, so only treat a value
      // as a fraction when it cannot be anything else.
      const scaled = Math.abs(n) <= 1 ? n * 100 : n;
      return `${scaled.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    }
    // A count is a whole thing. Printing 19,362.5 units is not a rounding
    // preference, it is a category error -- so counts never get decimals
    // even when an average produces one.
    if (semantic === 'count') return Math.round(n).toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });
  }

  // Compact axis labels -- a y-axis reading "1,250,000" three times over
  // eats the plot area a small tile does not have.
  function compact(v, semantic) {
    const n = toNumber(v);
    if (n === null) return '';
    const abs = Math.abs(n);
    const unit = abs >= 1e9 ? ['e9', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['k', 1e3] : ['', 1];
    const short = `${(n / unit[1]).toLocaleString(undefined, { maximumFractionDigits: unit[1] === 1 ? 0 : 1 })}${unit[0] === 'e9' ? 'B' : unit[0]}`;
    return semantic === 'currency' ? `$${short}` : semantic === 'percent' ? formatValue(n, 'percent') : short;
  }

  // ── Shaping ──────────────────────────────────────────────────────────
  const AGGREGATES = ['sum', 'avg', 'min', 'max', 'count', 'none'];

  /**
   * Sum is right for currency and counts and wrong for rates: averaging
   * three days of 40%/50%/60% gives 50%, summing gives 150%. Percent
   * therefore defaults to avg. 'none' stays available for a query that has
   * already aggregated and must not be touched.
   */
  function defaultAggregate(semantic) {
    return semantic === 'percent' ? 'avg' : 'sum';
  }

  function aggregateValues(nums, agg) {
    if (!nums.length) return null;
    switch (agg) {
      case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
      case 'min': return Math.min(...nums);
      case 'max': return Math.max(...nums);
      case 'count': return nums.length;
      default: return nums.reduce((a, b) => a + b, 0);
    }
  }

  /**
   * Apply the widget's dimension/measure/aggregate/sort/limit to the raw
   * rows. Returns null when the config does not name usable fields --
   * callers render a "pick a dimension and a measure" prompt rather than an
   * empty chart, so a half-configured widget says so.
   *
   * Grouping happens BEFORE sort and limit, which is the only order that
   * gives the right answer: taking the top 10 rows and then summing them
   * per product answers a different question than summing per product and
   * then taking the top 10.
   */
  /**
   * How far apart two measures have to sit before they need separate axes.
   * ROAS averages 3.3 while online sales average $38,000 -- on one axis the
   * ROAS line is flat on the floor and tells you nothing. 25x is well past
   * anything that still reads on a shared scale, and comfortably below the
   * gap between a ratio and a currency.
   */
  const SECOND_AXIS_RATIO = 25;

  function medianAbs(nums) {
    const v = nums.filter((n) => n !== null && Number.isFinite(n)).map(Math.abs).sort((a, b) => a - b);
    if (!v.length) return 0;
    return v[Math.floor(v.length / 2)];
  }

  /**
   * Apply the widget's dimension/measures/aggregate/sort/limit to the raw
   * rows. Returns null when the config does not name usable fields --
   * callers render a "pick a dimension and a measure" prompt rather than an
   * empty chart, so a half-configured widget says so.
   *
   * Grouping happens BEFORE sort and limit, which is the only order that
   * gives the right answer: taking the top 10 rows and then summing them
   * per product answers a different question than summing per product and
   * then taking the top 10.
   *
   * MEASURES, plural. cfg.measures is an array of column names; cfg.y_field
   * is the single-measure form every widget built before this used, and is
   * still honoured -- a stored widget must keep drawing exactly what it drew
   * yesterday. points[].value stays the FIRST measure so KPI, donut and the
   * table path are unaffected.
   */
  function shape(rows, config, semantics) {
    const cfg = config || {};
    if (!Array.isArray(rows) || !rows.length) return null;
    const prof = profileColumns(rows);
    const has = (f) => f && prof.some((c) => c.name === f);

    const xField = has(cfg.x_field) ? cfg.x_field : (dimensionsOf(prof)[0] || {}).name;
    const declared = Array.isArray(cfg.measures) && cfg.measures.length ? cfg.measures : [cfg.y_field];
    const fields = declared.filter(has);
    if (!fields.length) {
      const fallback = (measuresOf(prof)[0] || {}).name;
      if (fallback) fields.push(fallback);
    }
    if (!xField || !fields.length) return null;

    const yField = fields[0];
    const semantic = semanticOf(yField, semantics, prof);
    const agg = AGGREGATES.includes(cfg.aggregate) ? cfg.aggregate : defaultAggregate(semantic);

    let points;
    let aggregatedFrom = 0;
    let ratioNote = null;
    if (agg === 'none') {
      points = rows.map((r) => ({
        label: r[xField], row: r,
        values: Object.fromEntries(fields.map((f) => [f, toNumber(r[f])])),
      }));
    } else {
      // Map keyed on the STRING label, but the first row's original label is
      // kept for display -- two rows whose dimension is null and '' must not
      // silently merge into one bar under a key of ''.
      const groups = new Map();
      for (const r of rows) {
        const key = r[xField] === null || r[xField] === undefined ? '\u0000null' : String(r[xField]);
        if (!groups.has(key)) {
          groups.set(key, { label: r[xField], rows: [], nums: Object.fromEntries(fields.map((f) => [f, []])) });
        }
        const g = groups.get(key);
        for (const f of fields) {
          const n = toNumber(r[f]);
          if (n !== null) g.nums[f].push(n);
        }
        g.rows.push(r);
      }
      aggregatedFrom = rows.length;
      /* Measures that had to be averaged because the report does not return
         the parts they are a ratio OF. Surfaced in the tile's footer -- see
         below for why a chart discloses where a KPI refuses. */
      const unpooled = new Set();
      points = Array.from(groups.values()).map((g) => ({
        label: g.label, row: g.rows[0], rowCount: g.rows.length,
        // Each measure is aggregated with the aggregate that suits ITS OWN
        // semantic, not the widget's -- summing a ratio next to summing
        // dollars is how a ROAS column becomes 99 instead of 3.3.
        values: Object.fromEntries(fields.map((f) => {
          const sem = semanticOf(f, semantics, prof);
          const perField = AGGREGATES.includes(cfg.aggregate) && fields.length === 1
            ? cfg.aggregate : defaultAggregate(sem);

          /* A RATIO is pooled from its numerator and denominator here for
             the same reason a KPI pools it, and through the same function:
             a bar chart of ROAS by platform summing 2 and 8 into 10 while
             the KPI beside it pools them into 5 puts two numbers on one
             board that cannot both be right.
             `perField` is passed through so min/max/first/last still pick a
             row as asked; only sum and avg -- the two that manufacture a
             new ratio -- are overridden. */
          const M = global.SiloMetrics;
          if (M && M.isRatio(f, sem) && g.rows.length > 1) {
            const rolled = M.aggregate(g.rows, f, sem, { aggregate: perField });
            if (rolled.value !== null && rolled.value !== undefined) return [f, rolled.value];
            /* No parts in the result, so it cannot be pooled. A KPI REFUSES
               here, because one headline number has nowhere to put a
               caveat. A chart is a shape over forty bars and blanking it
               destroys far more than the mis-weighting costs -- so it falls
               back to the unweighted mean, NEVER a sum (a $110 AOV is not a
               quantity at all), and the footer says so. */
            unpooled.add(f);
            return [f, aggregateValues(g.nums[f], 'avg')];
          }
          return [f, aggregateValues(g.nums[f], perField)];
        })),
      }));
      if (unpooled.size) {
        ratioNote = `${Array.from(unpooled).join(', ')} averaged across rows — `
          + 'this report does not return the columns it is a ratio of, so it cannot be pooled';
      }
    }
    // Back-compat: every caller written before multi-measure reads .value.
    for (const p of points) p.value = p.values[yField];

    const sort = cfg.sort || 'desc';
    if (sort === 'desc') points.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    else if (sort === 'asc') points.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));
    else if (sort === 'x_asc') points.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    else if (sort === 'x_desc') points.sort((a, b) => String(b.label).localeCompare(String(a.label)));
    // sort === 'none' keeps the query's own ORDER BY, which is often the
    // point of the query.

    const totalRows = points.length;
    const limit = Number(cfg.limit) || 0;
    const truncated = limit > 0 && points.length > limit;
    // Keep what gets cut. A ranking can honestly show its top 10 and stop,
    // but a DONUT that drops slices stops being a part-of-whole chart: the
    // percentages it prints are computed over what it was handed, so
    // "Top 10 of 12" silently inflates every one of them. donutOption adds
    // this back as an "Other" slice.
    let dropped = [];
    if (truncated) { dropped = points.slice(limit); points = points.slice(0, limit); }
    const remainder = dropped.length
      ? Object.fromEntries(fields.map((f) => [f, dropped.reduce((a, p) => a + (p.values[f] ?? 0), 0)]))
      : null;

    // Axis assignment. The first measure owns the left axis; a later one
    // moves right when it means something different (a ratio beside money)
    // or when its typical magnitude is so far off that it would flatten.
    const primarySemantic = semanticOf(yField, semantics, prof);
    const primaryMag = medianAbs(points.map((p) => p.values[yField]));
    const series = fields.map((f, i) => {
      const sem = semanticOf(f, semantics, prof);
      const data = points.map((p) => p.values[f]);
      let axis = 0;
      if (i > 0) {
        const mag = medianAbs(data);
        const differentMeaning = sem !== primarySemantic;
        const differentScale = primaryMag > 0 && mag > 0
          && (primaryMag / mag > SECOND_AXIS_RATIO || mag / primaryMag > SECOND_AXIS_RATIO);
        if (differentMeaning || differentScale) axis = 1;
      }
      return { field: f, semantic: sem, data, axis };
    });

    return {
      xField, yField, fields, points, series, truncated, totalRows,
      droppedCount: dropped.length, remainder,
      aggregate: agg,
      // Set only when a ratio measure had to be averaged rather than pooled.
      // The tile prints it; a mis-weighted number that does not say it is
      // mis-weighted is the thing this whole layer exists to prevent.
      ratioNote,
      // Non-zero only when grouping actually collapsed rows -- the foot uses
      // this to say "10 of 46 products (from 1,204 rows)" instead of
      // implying the chart shows every row it was given.
      aggregatedFrom: aggregatedFrom > totalRows ? aggregatedFrom : 0,
      hasSecondAxis: series.some((sr) => sr.axis === 1),
      semantic,
      // Legacy alias: the option builders and older call sites read .format.
      format: semantic,
    };
  }

  // ── ECharts options ──────────────────────────────────────────────────
  function baseOption(t) {
    return {
      color: t.palette,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif', color: t.ink2 },
      animationDuration: 260,
      tooltip: {
        trigger: 'item',
        backgroundColor: t.surface,
        borderColor: t.grid,
        textStyle: { color: t.ink, fontSize: 12 },
        extraCssText: 'box-shadow:0 4px 14px rgba(15,23,42,.12);border-radius:4px;',
      },
    };
  }

  function axisChartOption(kind, shaped, t, config) {
    const cfg = config || {};
    // Stacking only makes sense when every series measures the same
    // KIND of thing. Dollars stacked on a ratio draws a number that
    // does not exist.
    const sameSemantic = new Set(shaped.series.map((sr) => sr.semantic)).size <= 1;
    const labels = shaped.points.map((p) => (p.label === null || p.label === undefined ? '—' : String(p.label)));
    const multi = shaped.series.length > 1;
    // Horizontal bars are for long category names, and only make sense with
    // a single series -- a grouped horizontal bar with two axes is a mess.
    const horizontal = kind === 'bar' && !multi && labels.some((l) => l.length > 14);

    const catAxis = {
      type: 'category',
      data: horizontal ? labels.slice().reverse() : labels,
      axisLabel: {
        color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace',
        hideOverlap: true,
        // Long product titles are the norm in this data set; truncate
        // rather than rotate, the tooltip carries the full name.
        formatter: (v) => (String(v).length > 22 ? String(v).slice(0, 21) + '…' : v),
      },
      axisLine: { lineStyle: { color: t.grid } },
      axisTick: { show: false },
    };

    // One value axis per side. The right-hand one exists only when a measure
    // genuinely needs it -- see SECOND_AXIS_RATIO.
    const axisFor = (side) => {
      const own = shaped.series.filter((sr) => sr.axis === side);
      const sem = own.length ? own[0].semantic : shaped.semantic;
      return {
        type: 'value',
        position: side === 1 ? 'right' : 'left',
        alignTicks: true,
        // An author-supplied axis label only goes on the LEFT axis: the
        // right-hand one exists precisely because it measures something
        // else, and repeating one name over both would mislabel it.
        name: (side === 0 && cfg.axis_label) ? cfg.axis_label : undefined,
        nameLocation: 'middle',
        nameGap: 38,
        nameTextStyle: { color: t.ink2, fontSize: 10.5 },
        axisLabel: {
          color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace',
          formatter: (v) => compact(v, sem),
        },
        splitLine: { show: side === 0, lineStyle: { color: t.grid, type: 'dashed' } },
        axisLine: { show: false },
      };
    };
    const valueAxes = shaped.hasSecondAxis ? [axisFor(0), axisFor(1)] : [axisFor(0)];

    const series = shaped.series.map((sr, i) => {
      // A secondary-axis measure is drawn as a line even in a bar chart:
      // that is the conventional combo, and a ratio rendered as a bar next
      // to dollar bars invites reading them as comparable heights.
      //
      // `line_measures` is the explicit version of the same idea, for the
      // combo visual: an author naming which measure is the line, rather
      // than the axis heuristic inferring it. Needed when the two measures
      // sit on a SIMILAR scale (sales and target, spend and budget), where
      // nothing about the numbers says one of them is the reference line.
      const named = Array.isArray(cfg.line_measures) && cfg.line_measures.includes(sr.field);
      const asLine = kind === 'line' || named || (multi && sr.axis === 1);
      const data = horizontal ? sr.data.slice().reverse() : sr.data;
      return {
        name: sr.field,
        type: asLine ? 'line' : 'bar',
        yAxisIndex: horizontal ? undefined : sr.axis,
        xAxisIndex: horizontal ? sr.axis : undefined,
        data,
        barMaxWidth: 34,
        // Stacking is a BAR idea: stacked lines read as an area chart
        // nobody asked for, and a stacked rate is meaningless. So it only
        // applies to bars, and only when every series shares a semantic --
        // stacking dollars on top of a ratio would draw a number that does
        // not exist.
        stack: (!asLine && cfg.stacked && sameSemantic) ? 'total' : undefined,
        // Value labels are off by default: on a 40-point series they
        // collide into a grey smear. Shown only when asked, and only where
        // there is room.
        label: (cfg.show_values && shaped.points.length <= 24) ? {
          show: true,
          position: horizontal ? 'right' : 'top',
          fontSize: 10,
          fontFamily: '"IBM Plex Mono", monospace',
          color: t.ink2,
          formatter: (p) => compact(p.value, sr.semantic || shaped.semantic),
        } : { show: false },
        itemStyle: { borderRadius: !asLine ? (horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]) : 0 },
        smooth: asLine ? 0.2 : false,
        showSymbol: asLine && shaped.points.length <= 40,
        symbolSize: 5,
        lineStyle: asLine ? { width: 2 } : undefined,
        // Only fill under a single line. Stacked translucent fills across
        // several series read as one muddy shape.
        areaStyle: (asLine && !multi) ? { opacity: t.dark ? 0.14 : 0.08 } : undefined,
        z: asLine ? 3 : 2,
      };
    });

    const semanticByField = Object.fromEntries(shaped.series.map((sr) => [sr.field, sr.semantic]));

    return {
      ...baseOption(t),
      tooltip: {
        ...baseOption(t).tooltip,
        trigger: 'axis',
        axisPointer: { type: series.some((sr) => sr.type === 'bar') ? 'shadow' : 'line' },
        formatter: (params) => {
          const arr = Array.isArray(params) ? params : [params];
          if (!arr.length) return '';
          const head = `<div style="font-size:11px;opacity:.7">${arr[0].name}</div>`;
          // Every series at that x, each formatted by its OWN semantic --
          // dollars as dollars and a ratio as a ratio, in one tooltip.
          return head + arr.map((p) => `<div style="display:flex;gap:8px;justify-content:space-between">
              <span>${p.marker || ''}${multi ? esc(p.seriesName) : ''}</span>
              <span style="font-weight:700">${formatValue(p.value, semanticByField[p.seriesName] || shaped.semantic)}</span>
            </div>`).join('');
        },
      },
      legend: (multi && cfg.legend !== 'off') ? {
        type: 'scroll', top: 0, left: 'center',
        textStyle: { color: t.ink2, fontSize: 10.5, fontFamily: '"IBM Plex Mono", monospace' },
        itemWidth: 12, itemHeight: 8,
      } : undefined,
      grid: {
        left: 8, right: shaped.hasSecondAxis ? 12 : 14,
        top: (multi && cfg.legend !== 'off') ? 30 : 14,
        bottom: cfg.axis_label && !horizontal ? 4 : 4,
        containLabel: true,
      },
      xAxis: horizontal ? valueAxes : catAxis,
      yAxis: horizontal ? catAxis : valueAxes,
      series,
    };
  }

  function donutOption(shaped, t) {
    return {
      ...baseOption(t),
      tooltip: {
        ...baseOption(t).tooltip,
        formatter: (p) => `<div style="font-size:11px;opacity:.7">${p.name}</div>
          <div style="font-weight:700">${formatValue(p.value, shaped.format)} · ${p.percent}%</div>`,
      },
      legend: {
        type: 'scroll', orient: 'vertical', right: 4, top: 'middle',
        textStyle: { color: t.ink2, fontSize: 10.5 }, itemWidth: 9, itemHeight: 9,
      },
      series: [{
        type: 'pie',
        radius: ['52%', '76%'],
        center: ['36%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: t.surface, borderWidth: 2 },
        data: shaped.points.map((p) => ({
          name: p.label === null || p.label === undefined ? '—' : String(p.label),
          value: p.value,
        })).concat(shaped.remainder ? [{
          // Without this the donut's own percentages are wrong -- ECharts
          // computes them over the slices it was given, not the real total.
          name: `Other (${shaped.droppedCount})`,
          value: shaped.remainder[shaped.yField],
          itemStyle: { color: t.dark ? '#6b7a8f' : '#9aa9bd' },
        }] : []),
      }],
    };
  }

  /**
   * A heatmap: two dimensions, one measure, colour instead of position.
   *
   * The same (row, column, cell) shape the matrix reads -- day-of-week x
   * hour, size x location, category x month -- drawn where the PATTERN is
   * the point and the individual number is not. It keeps the matrix's two
   * rules for the same reasons: row and column order come from the query
   * (except dates, which go chronological), and an absent cell is absent,
   * not zero. ECharts draws a missing pair as a gap because the data point
   * simply is not emitted.
   *
   * The colour ramp is single-hue for a measure that is all one sign, and
   * diverging around zero when the values cross it -- a spend variance that
   * goes both ways is unreadable on a sequential ramp.
   */
  function heatmapOption(grid2d, t, semantic) {
    const values = grid2d.data.map((d) => d[2]).filter((v) => v !== null && v !== undefined);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    const diverging = min < 0 && max > 0;
    const bound = Math.max(Math.abs(min), Math.abs(max));
    return {
      ...baseOption(t),
      tooltip: {
        ...baseOption(t).tooltip,
        formatter: (p) => `<div style="font-size:11px;opacity:.7">${esc(grid2d.rows[p.value[1]])} · ${esc(grid2d.cols[p.value[0]])}</div>
          <div style="font-weight:700">${formatValue(p.value[2], semantic)}</div>`,
      },
      grid: { left: 8, right: 8, top: 8, bottom: 40, containLabel: true },
      xAxis: {
        type: 'category', data: grid2d.cols, splitArea: { show: true },
        axisLabel: { color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace', hideOverlap: true },
        axisLine: { lineStyle: { color: t.grid } }, axisTick: { show: false },
      },
      yAxis: {
        type: 'category', data: grid2d.rows, splitArea: { show: true },
        // Inverted so the FIRST row the query returned is at the top, which
        // is how the matrix reads the identical shape. ECharts puts index 0
        // at the bottom of a category axis, so without this the two visuals
        // disagree about the same data and a P&L comes out upside down.
        inverse: true,
        axisLabel: { color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace' },
        axisLine: { lineStyle: { color: t.grid } }, axisTick: { show: false },
      },
      visualMap: {
        min: diverging ? -bound : min,
        max: diverging ? bound : max,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: 90,
        textStyle: { color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace' },
        formatter: (v) => compact(v, semantic),
        inRange: {
          color: diverging
            ? (t.dark ? ['#ff829a', '#2b3038', '#3fd2a4'] : ['#d94f6a', '#f2f4f7', '#17a67c'])
            : (t.dark ? ['#1f3a52', '#6fa4ff'] : ['#eaf1fd', '#2f6fe4']),
        },
      },
      series: [{
        type: 'heatmap',
        data: grid2d.data,
        label: { show: false },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
        progressive: 0,
      }],
    };
  }

  /**
   * A waterfall: a bridge from one number to another through signed steps.
   *
   * Drawn as an invisible base bar plus a visible delta bar, which is the
   * standard way to do this in ECharts without a dedicated series type.
   *
   * ROW ORDER IS THE QUERY'S, always. A bridge sorted by size is not a
   * bridge -- the sequence IS the explanation -- so the widget forces
   * sort off, and a total step is recognised by name rather than by
   * position.
   */
  function waterfallOption(shaped, t, config) {
    const cfg = config || {};
    const semantic = shaped.semantic;
    const labels = shaped.points.map((p) => (p.label === null || p.label === undefined ? '—' : String(p.label)));
    const values = shaped.points.map((p) => toNumber(p.value) || 0);
    // A step whose label says total/net/closing is an ABSOLUTE position in
    // the bridge, not another delta -- drawing it as a delta double-counts
    // the whole chart. Named rather than positional so a "Gross Profit"
    // subtotal mid-statement works too.
    const totalRe = /(total|net|closing|balance|ending|subtotal|gross profit)/i;
    const isTotal = labels.map((l, i) => (cfg.total_steps === 'none' ? false
      : (totalRe.test(l) || (cfg.total_steps === 'last' && i === labels.length - 1))));

    const base = [];
    const up = [];
    const down = [];
    let running = 0;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (isTotal[i]) {
        base.push(0);
        up.push(v >= 0 ? v : null);
        down.push(v < 0 ? -v : null);
        running = v;
        continue;
      }
      if (v >= 0) { base.push(running); up.push(v); down.push(null); }
      else { base.push(running + v); up.push(null); down.push(-v); }
      running += v;
    }

    const bar = (name, data, color) => ({
      name, type: 'bar', stack: 'wf', data,
      itemStyle: { color, borderRadius: [2, 2, 0, 0] },
      barMaxWidth: 42,
      label: cfg.show_values && labels.length <= 24 ? {
        show: true, position: 'top', fontSize: 10,
        fontFamily: '"IBM Plex Mono", monospace', color: t.ink2,
        formatter: (p) => (p.value === null ? '' : compact(p.value, semantic)),
      } : { show: false },
    });

    return {
      ...baseOption(t),
      tooltip: {
        ...baseOption(t).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const arr = Array.isArray(params) ? params : [params];
          const i = arr.length ? arr[0].dataIndex : 0;
          const runningTo = values.slice(0, i + 1).reduce((a, b, j) => (isTotal[j] ? b : a + b), 0);
          return `<div style="font-size:11px;opacity:.7">${esc(labels[i])}</div>
            <div style="font-weight:700">${formatValue(values[i], semantic)}</div>
            ${isTotal[i] ? '<div style="font-size:10px;opacity:.7">total step</div>'
              : `<div style="font-size:10px;opacity:.7">running ${formatValue(runningTo, semantic)}</div>`}`;
        },
      },
      legend: { show: false },
      grid: { left: 8, right: 14, top: 14, bottom: 4, containLabel: true },
      xAxis: {
        type: 'category', data: labels,
        axisLabel: {
          color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace', hideOverlap: true,
          formatter: (v) => (String(v).length > 18 ? String(v).slice(0, 17) + '…' : v),
        },
        axisLine: { lineStyle: { color: t.grid } }, axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace', formatter: (v) => compact(v, semantic) },
        splitLine: { lineStyle: { color: t.grid, type: 'dashed' } },
        axisLine: { show: false },
      },
      series: [
        // The base is a transparent spacer, not data. It carries no tooltip
        // and no legend entry so nobody can read it as a value.
        { name: 'base', type: 'bar', stack: 'wf', data: base, itemStyle: { color: 'transparent' },
          emphasis: { disabled: true }, silent: true, tooltip: { show: false } },
        bar('increase', up, t.palette[1]),
        bar('decrease', down, t.dark ? '#ff829a' : '#d94f6a'),
      ],
    };
  }

  /**
   * Shape a result into (rows x columns x value) for a heatmap. Shares the
   * matrix's rules deliberately -- these two visuals answer the same
   * question and disagreeing about cell order would be worse than either
   * ordering.
   */
  function grid2dOf(rows, config, semantics) {
    const prof = profileColumns(rows);
    const cfg = config || {};
    const dims = dimensionsOf(prof);
    const rowField = cfg.row_field || (dims[0] && dims[0].name);
    // A config carried over from a bar chart has an x_field and NO
    // row_field, and its x_field is very often the same column the row then
    // falls back to. That collision is an accident of the switch, so the
    // x_field is treated as unset. Naming the SAME column for both
    // deliberately is a different thing and is still refused below -- there
    // is no grid to draw, and quietly substituting a column the person did
    // not choose would be worse than saying so.
    const bothNamed = !!(cfg.row_field && cfg.x_field);
    const colField = (cfg.x_field && (bothNamed || cfg.x_field !== rowField) ? cfg.x_field : null)
      || (dims.find((d) => d.name !== rowField) || {}).name;
    const valField = cfg.y_field || (measuresOf(prof)[0] || {}).name;
    if (!rowField || !colField || !valField || rowField === colField) return null;

    const agg = AGGREGATES.includes(cfg.aggregate) ? cfg.aggregate : 'sum';
    const colType = (prof.find((c) => c.name === colField) || {}).type;
    const rowKeys = [];
    const colKeys = [];
    const cells = new Map();
    const cellKey = (rk, ck) => rk + SEP + ck;
    for (const r of rows) {
      const rk = r[rowField] === null || r[rowField] === undefined ? '—' : String(r[rowField]);
      const ck = r[colField] === null || r[colField] === undefined ? '—' : String(r[colField]);
      if (!rowKeys.includes(rk)) rowKeys.push(rk);
      if (!colKeys.includes(ck)) colKeys.push(ck);
      const n = toNumber(r[valField]);
      if (n === null) continue;
      const k = cellKey(rk, ck);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(n);
    }
    if (colType === 'date') colKeys.sort();

    const data = [];
    for (let ri = 0; ri < rowKeys.length; ri += 1) {
      for (let ci = 0; ci < colKeys.length; ci += 1) {
        const vals = cells.get(cellKey(rowKeys[ri], colKeys[ci]));
        // Absent stays absent: no data point at all, so the cell reads as a
        // gap rather than as the ramp's zero colour.
        if (!vals) continue;
        data.push([ci, ri, aggregateValues(vals, agg)]);
      }
    }
    const colLabels = (colType === 'date' && dateColumnLabels(colKeys)) || colKeys;
    return {
      rows: rowKeys, cols: colLabels, rawCols: colKeys, data,
      rowField, colField, valField,
      semantic: semanticOf(valField, semantics, prof),
    };
  }

  /**
   * Can this visual actually draw this result?
   *
   * Called before a visual is OFFERED, not only before it is drawn. A
   * picker that lists Heatmap for a result with one dimension produces a
   * tile that says "needs two dimensions", which is a worse answer than
   * not offering it -- the person has already committed the tile by then.
   *
   * Returns { ok: true } or { ok: false, reason }.
   */
  function validateVisual(visualType, rows, config, semantics) {
    if (visualType === 'section') return { ok: true };
    if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'no rows to draw' };
    const prof = profileColumns(rows);
    const dims = dimensionsOf(prof);
    const meas = measuresOf(prof);
    const cfg = config || {};

    if (prof.some((c) => c.type === 'json') && visualType !== 'table') {
      return { ok: false, reason: 'this result has nested JSON columns, which only a table can show' };
    }
    if (visualType === 'table') return { ok: true };
    if (visualType === 'kpi') {
      return meas.length ? { ok: true } : { ok: false, reason: 'needs at least one numeric column' };
    }
    if (visualType === 'matrix' || visualType === 'heatmap') {
      if (dims.length < 2) return { ok: false, reason: 'needs two dimensions — one down, one across' };
      if (!meas.length) return { ok: false, reason: 'needs a numeric column for the cells' };
      return { ok: true };
    }
    if (visualType === 'waterfall') {
      if (!dims.length) return { ok: false, reason: 'needs a dimension for the steps' };
      if (!meas.length) return { ok: false, reason: 'needs a numeric column for each step' };
      const sem = semanticOf((cfg.y_field || meas[0].name), semantics, prof);
      if (sem === 'percent') {
        return { ok: false, reason: 'a bridge adds its steps up, and rates do not add up' };
      }
      return { ok: true };
    }
    if (visualType === 'combo') {
      if (!dims.length) return { ok: false, reason: 'needs a dimension for the axis' };
      if (meas.length < 2) return { ok: false, reason: 'needs two numeric columns — one for the bars, one for the line' };
      return { ok: true };
    }
    // bar / line / donut
    if (!dims.length) return { ok: false, reason: 'needs a dimension to plot against' };
    if (!meas.length) return { ok: false, reason: 'needs a numeric column to measure' };
    if (visualType === 'donut') {
      const sem = semanticOf((cfg.y_field || meas[0].name), semantics, prof);
      if (sem === 'percent') {
        return { ok: false, reason: 'slices of a whole have to add up, and rates do not' };
      }
    }
    return { ok: true };
  }

  function optionFor(visualType, shaped, config) {
    const t = theme();
    if (visualType === 'donut') return donutOption(shaped, t);
    if (visualType === 'waterfall') return waterfallOption(shaped, t, config);
    // combo is a bar chart whose named measures are drawn as lines on the
    // right-hand axis. axisChartOption already does exactly that for a
    // measure that needs a second axis; combo makes it an explicit choice
    // rather than an inference, which is what an author wants when the two
    // measures happen to sit on a similar scale.
    return axisChartOption(visualType === 'line' ? 'line' : 'bar', shaped, t,
      visualType === 'combo' ? Object.assign({}, config || {}, { combo: true }) : config);
  }

  // ── HTML visuals (table / KPI) ───────────────────────────────────────
  /**
   * A readable label for a link cell. A raw 120-character Ads Manager URL
   * makes a table unreadable, and the full URL is still on the title
   * attribute and in the href.
   */
  function linkLabel(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      const host = u.hostname.replace(/^www\./, '');
      return last ? `${host}/${decodeURIComponent(last)}` : host;
    } catch (e) {
      return url.length > 60 ? url.slice(0, 57) + '…' : url;
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // ── Presentation, applied everywhere ─────────────────────────────────
  // These are module-wide defaults, not per-report fixes. Every table and
  // matrix on every dashboard renders through here, so improving a default
  // improves every tile that already exists -- including reports nobody has
  // opened since. An override belongs on the REPORT when the answer is the
  // same wherever the column appears (a label), and on the WIDGET when two
  // tiles could legitimately differ (abbreviation, density).

  /**
   * Is a total of this column meaningful?
   *
   * Currency and counts add up. A PERCENT or a ratio does not -- summing
   * three days of 40%/50%/60% gives 150%, and averaging them gives 50%,
   * which is only right when the days are equally weighted. Neither is
   * reliably the answer, so a rate column gets a BLANK total rather than a
   * confident wrong one. Same stance as an empty matrix cell.
   */
  const TOTALLABLE = new Set(['currency', 'count', 'number']);

  /** Columns to show, in order. `visual_config.columns` wins when present. */
  function visibleColumns(prof, cfg) {
    const chosen = Array.isArray(cfg && cfg.columns) ? cfg.columns : null;
    if (!chosen || !chosen.length) return prof;
    // Only names that actually came back, in the ORDER the config lists
    // them -- that is what makes this reorder as well as hide. A column the
    // query stopped returning simply drops out rather than rendering blank.
    const byName = new Map(prof.map((c) => [c.name, c]));
    return chosen.map((n) => byName.get(n)).filter(Boolean);
  }

  const ACRONYMS = { roas: 'ROAS', aov: 'AOV', sku: 'SKU', po: 'PO', qbo: 'QBO',
                     mtd: 'MTD', ytd: 'YTD', cy: 'CY', ly: 'LY', id: 'ID',
                     cogs: 'COGS', cac: 'CAC', cpm: 'CPM', ctr: 'CTR', pct: '%',
                     // A baseball brand: MLB is a licensor, a product line
                     // and a filter, and it reads as a typo in title case.
                     mlb: 'MLB', dtc: 'DTC', pos: 'POS', ar: 'AR', ap: 'AP',
                     ga4: 'GA4', tiktok: 'TikTok', mer: 'MER' };
  // Noise words a SQL alias carries that a reader does not need.
  const DROP_SUFFIX = /_(snapshot|tag)$/;

  /**
   * A column header a person would write.
   *
   *   qty_arriving_by_cutoff  ->  Qty Arriving By Cutoff
   *   product_type_snapshot   ->  Product Type
   *   platform_roas           ->  Platform ROAS
   *
   * A report can override any of it via columns_metadata[col].label -- that
   * belongs to the report rather than the widget, because `net_sales` should
   * read the same wherever it appears, and one correction then fixes every
   * widget built on it.
   */
  function columnLabel(name, semantics) {
    const meta = semantics && semantics[name];
    if (meta && typeof meta === 'object' && meta.label) return meta.label;
    return String(name)
      .replace(DROP_SUFFIX, '')
      .split('_')
      .filter(Boolean)
      .map((w) => ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  }

  const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * Matrix column headers for a date dimension.
   *
   * A P&L across the top reading `2025-01-01 2025-02-01 …` is a SQL result;
   * `Jan 2025 Feb 2025 …` is a statement. Only relabels when EVERY value is
   * the first of a month -- that is what proves the grain is monthly. Any
   * other set of dates keeps its ISO form, which stays unambiguous.
   */
  function dateColumnLabels(keys) {
    const parsed = keys.map((k) => /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k)));
    if (!parsed.every(Boolean)) return null;
    if (!parsed.every((m) => m[3] === '01')) return null;
    return keys.map((k, i) => `${MONTH[Number(parsed[i][2]) - 1]} ${parsed[i][1]}`);
  }

  /** A negative currency or number is the thing a reader scans for. */
  function signClass(value, semantic) {
    if (value === null || value === undefined) return '';
    const n = toNumber(value);
    if (n === null || n >= 0) return '';
    return (semantic === 'currency' || semantic === 'number' || semantic === 'percent')
      ? ' dw-neg' : '';
  }

  /**
   * A matrix: one dimension down, another across, a measure in the cells.
   *
   * The shape a table cannot express. A P&L is LINES down and MONTHS across;
   * rendered long it is 160 correct rows that read as nothing. Same for
   * sales by category by month, units by size by location.
   *
   * ROW AND COLUMN ORDER COME FROM THE QUERY, in order of first appearance,
   * rather than being sorted. That is the whole reason a P&L comes out
   * right: Income, COGS, Gross Profit, Expenses, Net Income is a meaningful
   * sequence that alphabetical order destroys, and the report already put
   * them in that sequence with its ORDER BY. Sorting here would be this
   * file second-guessing the query. Dates are the one exception -- a month
   * column reads left-to-right chronologically whatever order it arrived in.
   *
   * Cells aggregate because a (row, column) pair can hold several source
   * rows. `aggregate: 'none'` takes the single value and is right when the
   * query already produced one row per cell.
   */
  function matrixHtml(rows, config, semantics) {
    if (!Array.isArray(rows) || !rows.length) return '<div class="dw-empty">0 rows</div>';
    const prof = profileColumns(rows);
    const cfg = config || {};
    const dims = dimensionsOf(prof);
    const rowField = cfg.row_field || (dims[0] && dims[0].name);
    // Same collision as the heatmap, and the same distinction: an x_field
    // inherited from a one-dimension visual is an accident, two fields
    // named the same on purpose is a refusal.
    const bothNamed = !!(cfg.row_field && cfg.x_field);
    const colField = (cfg.x_field && (bothNamed || cfg.x_field !== rowField) ? cfg.x_field : null)
      || (dims.find((d) => d.name !== rowField) || {}).name;
    const valField = cfg.y_field || (measuresOf(prof)[0] || {}).name;

    if (!rowField || !colField || !valField || rowField === colField) {
      return '<div class="dw-empty">A matrix needs a row field, a column field and a measure.</div>';
    }

    const agg = AGGREGATES.includes(cfg.aggregate) ? cfg.aggregate : 'sum';
    const sem = semanticOf(valField, semantics, prof);
    const colType = (prof.find((c) => c.name === colField) || {}).type;

    // First-appearance order, then chronological for a date column.
    const rowKeys = [];
    const colKeys = [];
    const cells = new Map();                       // "row\u0000col" -> [values]
    for (const r of rows) {
      const rk = r[rowField] === null || r[rowField] === undefined ? '—' : String(r[rowField]);
      const ck = r[colField] === null || r[colField] === undefined ? '—' : String(r[colField]);
      if (!rowKeys.includes(rk)) rowKeys.push(rk);
      if (!colKeys.includes(ck)) colKeys.push(ck);
      const k = rk + '\u0000' + ck;
      const n = toNumber(r[valField]);
      if (n === null) continue;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(n);
    }
    if (colType === 'date') colKeys.sort();

    const cap = Number(cfg.limit) || 0;
    const truncated = cap > 0 && rowKeys.length > cap;
    const shownRows = truncated ? rowKeys.slice(0, cap) : rowKeys;

    // The label sits in a block child rather than directly in the cell: a
    // table cell does not reliably honour width/min-width, and a sticky one
    // with nowrap and no width overflows on top of the first data column.
    const colLabels = (colType === 'date' && dateColumnLabels(colKeys)) || colKeys;
    const head = `<tr><th class="dw-matrix-corner"><span class="dw-matrix-label">${esc(columnLabel(rowField, semantics))}</span></th>`
      + colLabels.map((c) => `<th class="dw-num">${esc(c)}</th>`).join('') + '</tr>';

    const body = shownRows.map((rk) => {
      const tds = colKeys.map((ck) => {
        const vals = cells.get(rk + '\u0000' + ck);
        const v = vals ? aggregateValues(vals, agg) : null;
        // An absent cell is EMPTY, not zero. "No row for August" and
        // "August was zero" are different facts and a matrix that prints
        // 0 for both is the same class of lie as a coalesced velocity.
        return `<td class="dw-num${signClass(v, sem)}">${v === null ? '' : esc(formatValue(v, sem))}</td>`;
      }).join('');
      return `<tr><th class="dw-matrix-row"><span class="dw-matrix-label" title="${esc(rk)}">${esc(rk)}</span></th>${tds}</tr>`;
    }).join('');

    // Totals only where a total means something: currency, counts and plain
    // numbers add up, a rate does not. A matrix of percentages gets no
    // totals at all rather than a row of nonsense.
    const canTotal = TOTALLABLE.has(sem);
    const wantRow = canTotal && (cfg.totals === 'row' || cfg.totals === 'both');
    const wantCol = canTotal && (cfg.totals === 'column' || cfg.totals === 'both');

    const sumOf = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) : null);
    const cellVal = (rk, ck) => {
      const vals = cells.get(rk + '\u0000' + ck);
      return vals ? aggregateValues(vals, agg) : null;
    };

    const headWithTotal = wantCol
      ? head.replace('</tr>', '<th class="dw-num dw-total-label">Total</th></tr>')
      : head;

    const bodyWithTotal = !wantCol ? body : shownRows.map((rk) => {
      const tds = colKeys.map((ck) => {
        const v = cellVal(rk, ck);
        return `<td class="dw-num${signClass(v, sem)}">${v === null ? '' : esc(formatValue(v, sem))}</td>`;
      }).join('');
      const rowTotal = sumOf(colKeys.map((ck) => cellVal(rk, ck)).filter((v) => v !== null));
      return `<tr><th class="dw-matrix-row"><span class="dw-matrix-label" title="${esc(rk)}">${esc(rk)}</span></th>`
        + tds
        + `<td class="dw-num dw-total-cell${signClass(rowTotal, sem)}">${rowTotal === null ? '' : esc(formatValue(rowTotal, sem))}</td></tr>`;
    }).join('');

    let matrixFoot = '';
    if (wantRow) {
      const tds = colKeys.map((ck) => {
        const v = sumOf(shownRows.map((rk) => cellVal(rk, ck)).filter((x) => x !== null));
        return `<td class="dw-num${signClass(v, sem)}">${v === null ? '' : esc(formatValue(v, sem))}</td>`;
      }).join('');
      const grand = wantCol
        ? sumOf(shownRows.flatMap((rk) => colKeys.map((ck) => cellVal(rk, ck))).filter((x) => x !== null))
        : null;
      matrixFoot = `<tfoot><tr class="dw-total-row">
          <th class="dw-matrix-row dw-total-label"><span class="dw-matrix-label">Total</span></th>${tds}
          ${wantCol ? `<td class="dw-num dw-total-cell${signClass(grand, sem)}">${grand === null ? '' : esc(formatValue(grand, sem))}</td>` : ''}
        </tr></tfoot>`;
    }

    const totalsNote = (cfg.totals && !canTotal)
      ? '<div class="dw-foot-note">Totals are off for this measure — summing a rate is not meaningful.</div>' : '';
    const note = (truncated
      ? `<div class="dw-foot-note">Showing ${shownRows.length} of ${rowKeys.length} rows${wantRow ? ' — the total covers the rows shown' : ''}</div>`
      : '') + totalsNote;

    return `<div class="bcn-matrix-scroll dw-matrix-wrap">
        <table class="bcn-table dw-matrix"><thead>${headWithTotal}</thead><tbody>${bodyWithTotal}</tbody>${matrixFoot}</table>
      </div>${note}`;
  }

  /**
   * Rows a table should actually draw, after the widget's own sort/limit
   * and the reader's live search.
   *
   * Split out of tableHtml because CSV export has to produce exactly what
   * is on screen. Two code paths deciding "which rows" is how an export
   * quietly disagrees with the table above it.
   */
  function tableRows(rows, config, ui) {
    const cfg = config || {};
    const state = ui || {};
    let shown = rows.slice();

    const term = String(state.search || '').trim().toLowerCase();
    if (term) {
      shown = shown.filter((r) => Object.values(r).some((v) => {
        if (v === null || v === undefined) return false;
        const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return t.toLowerCase().includes(term);
      }));
    }

    // The reader's column sort wins over the widget's configured one: they
    // just clicked it, and it is a view of the loaded rows either way.
    const prof = profileColumns(rows);
    const sortField = state.sortCol && prof.some((c) => c.name === state.sortCol)
      ? state.sortCol
      : (cfg.y_field && prof.some((c) => c.name === cfg.y_field) ? cfg.y_field : null);
    const dirName = state.sortCol ? (state.sortDir || 'desc') : cfg.sort;
    if (sortField && (dirName === 'desc' || dirName === 'asc')) {
      const dir = dirName === 'desc' ? -1 : 1;
      const col = prof.find((c) => c.name === sortField);
      shown.sort((a, b) => {
        if (col && col.type === 'number') {
          return dir * (((toNumber(a[sortField]) ?? 0)) - ((toNumber(b[sortField]) ?? 0)));
        }
        return dir * String(a[sortField] ?? '').localeCompare(String(b[sortField] ?? ''));
      });
    }

    const limit = Number(cfg.limit) || 0;
    const matched = shown.length;
    const truncated = limit > 0 && shown.length > limit;
    if (truncated) shown = shown.slice(0, limit);
    return { shown, matched, truncated, sortField, sortDir: dirName };
  }

  /**
   * Conditional formatting rules, evaluated per cell.
   *
   * `visual_config.rules` is [{ col, op, value, value2, tone }] where tone is
   * pos / neg / warn. Deliberately a small vocabulary: the point of
   * highlighting a cell is that a reader's eye goes to it, and a table where
   * six colours mean six things has no highlights at all.
   *
   * A rule naming a column the query no longer returns is skipped, never
   * an error -- same stance as `columns`: a report edited underneath a
   * widget should degrade, not break.
   */
  function ruleTone(rules, colName, raw) {
    if (!Array.isArray(rules) || !rules.length) return '';
    const n = toNumber(raw);
    for (const r of rules) {
      if (!r || r.col !== colName) continue;
      const a = toNumber(r.value);
      const b = toNumber(r.value2);
      let hit = false;
      if (r.op === 'gt') hit = n !== null && a !== null && n > a;
      else if (r.op === 'lt') hit = n !== null && a !== null && n < a;
      else if (r.op === 'gte') hit = n !== null && a !== null && n >= a;
      else if (r.op === 'lte') hit = n !== null && a !== null && n <= a;
      else if (r.op === 'between') hit = n !== null && a !== null && b !== null && n >= Math.min(a, b) && n <= Math.max(a, b);
      else if (r.op === 'negative') hit = n !== null && n < 0;
      else if (r.op === 'positive') hit = n !== null && n > 0;
      else if (r.op === 'empty') hit = raw === null || raw === undefined || raw === '';
      else if (r.op === 'contains') hit = String(raw == null ? '' : raw).toLowerCase().includes(String(r.value || '').toLowerCase());
      if (hit) return ` dw-rule dw-rule--${r.tone === 'neg' ? 'neg' : r.tone === 'warn' ? 'warn' : 'pos'}`;
    }
    return '';
  }

  /** The visible cell text for a value -- shared by the table and the CSV
      export so an exported number reads the same as the printed one. */
  function cellText(raw, col, semantic) {
    if (col.type === 'number') return formatValue(raw, semantic);
    if (raw !== null && typeof raw === 'object') {
      try { return JSON.stringify(raw); } catch (e) { return '[unserialisable]'; }
    }
    return raw === null || raw === undefined ? '' : String(raw);
  }

  /**
   * CSV of exactly what the table is showing: the same columns in the same
   * order, the same search and sort, the same limit.
   *
   * `note` is a comment line naming the scope, because the single most
   * dangerous thing about a dashboard export is that it looks complete.
   * A table sitting on 1,000 of 7,231 rows exports 1,000 and says so, in
   * the file -- not only in the UI the recipient never saw.
   */
  function tableCsv(rows, config, semantics, ui) {
    const cfg = config || {};
    const prof = profileColumns(rows);
    const cols = visibleColumns(prof, cfg);
    const { shown, matched, truncated } = tableRows(rows, cfg, ui);
    const q = (v) => {
      const t = String(v === null || v === undefined ? '' : v);
      return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const lines = [];
    const state = ui || {};
    const scope = [];
    if (state.search) scope.push(`filtered by "${state.search}"`);
    if (truncated) scope.push(`limited to ${shown.length} of ${matched} matching rows`);
    if (state.hasMore) scope.push('the source query has more rows than are loaded — use Load more first for the rest');
    else if (state.totalRows && state.totalRows > rows.length) {
      scope.push(`${rows.length} of ${state.totalRows} rows loaded`);
    }
    if (scope.length) lines.push(`# ${scope.join('; ')}`);
    lines.push(cols.map((c) => q(columnLabel(c.name, semantics))).join(','));
    for (const r of shown) {
      lines.push(cols.map((c) => {
        // Raw values, not formatted ones: a spreadsheet needs 36393571,
        // not "$36,393,571". The comment line above carries the context a
        // formatted string was trying to.
        const raw = r[c.name];
        if (raw !== null && typeof raw === 'object') { try { return q(JSON.stringify(raw)); } catch (e) { return ''; } }
        return q(raw);
      }).join(','));
    }
    return lines.join('\n');
  }

  /**
   * A table.
   *
   * `ui` is the reader's live state -- search text, which column they
   * clicked to sort, how many rows are loaded against how many exist. It is
   * deliberately NOT part of visual_config: searching a table is reading,
   * not editing, and it must not mark a dashboard dirty or be written back
   * as everyone's saved position.
   */
  function tableHtml(rows, config, semantics, ui) {
    if (!Array.isArray(rows) || !rows.length) return '<div class="dw-empty">0 rows</div>';
    const prof = profileColumns(rows);
    const cfg = config || {};
    const state = ui || {};
    const { shown, matched, truncated, sortField, sortDir } = tableRows(rows, cfg, state);

    const cols = visibleColumns(prof, cfg);
    const head = cols.map((c) => {
      const active = c.name === sortField;
      const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
      const next = active && sortDir === 'desc' ? 'asc' : 'desc';
      return `<th class="${c.type === 'number' ? 'dw-num' : ''}${active ? ' is-sorted' : ''}"
                  aria-sort="${ariaSort}" title="${esc(c.name)}">
          <button type="button" class="dw-th-btn" data-sort-col="${esc(c.name)}" data-sort-dir="${next}">
            <span class="dw-th-label">${esc(columnLabel(c.name, semantics))}</span><span
              class="dw-th-arrow" aria-hidden="true">${active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
          </button>
        </th>`;
    }).join('');

    const body = shown.map((r) => `<tr>${cols.map((c) => {
      const raw = r[c.name];
      const sem = semanticOf(c.name, semantics, prof);

      // Links and images are the only cells that put a database value into
      // an HTML ATTRIBUTE rather than a text node, so both go through
      // safeUrl() first. A value that is not an http(s) URL falls through
      // and renders as ordinary escaped text -- never as a broken link.
      if (sem === 'image' || sem === 'link') {
        const url = safeUrl(raw);
        if (url) {
          if (sem === 'image') {
            return `<td class="dw-cell-img" data-col="${esc(c.name)}"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">`
              + `<img class="dw-thumb" src="${esc(url)}" alt="" loading="lazy" /></a></td>`;
          }
          return `<td class="dw-cell-link" data-col="${esc(c.name)}"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
            + ` title="${esc(url)}">${esc(linkLabel(url))}</a></td>`;
        }
      }

      let numClass = c.type === 'number' ? 'dw-num' : '';
      let cell = cellText(raw, c, sem);
      if (c.type === 'number') numClass += signClass(raw, sem);
      numClass += ruleTone(cfg.rules, c.name, raw);
      const full = cell;
      if (cell.length > 160) cell = cell.slice(0, 157) + '…';
      // data-col / data-value are what click-to-filter and drill-through
      // read. They carry the RAW value, not the formatted one: a filter on
      // "$36,393,571" matches nothing.
      return `<td class="${numClass}" data-col="${esc(c.name)}"`
        + (c.type !== 'number' && raw !== null && typeof raw !== 'object' ? ` data-value="${esc(raw)}"` : '')
        + (c.type === 'json' ? ` title="${esc(full)}"` : '') + `>${esc(cell)}</td>`;
    }).join('')}</tr>`).join('');

    // A totals row sums the ROWS ON SCREEN, and says so when that is not
    // all of them -- a footer reading "Total" under a truncated list, over
    // a number covering everything, is the kind of quiet mismatch nobody
    // catches. Rates are refused outright: SiloMetrics.aggregate pools one
    // from its numerator and denominator where the result carries them and
    // otherwise leaves the cell blank rather than averaging.
    let foot = '';
    const refusals = [];
    if (cfg.totals) {
      const cells = cols.map((c, i) => {
        if (i === 0) return '<th class="dw-total-label">Total</th>';
        const sem = semanticOf(c.name, semantics, prof);
        if (c.type !== 'number') return '<td></td>';
        const res = global.SiloMetrics
          ? global.SiloMetrics.aggregate(shown, c.name, sem, { aggregate: 'sum' })
          : { value: TOTALLABLE.has(sem) ? shown.map((r) => toNumber(r[c.name])).filter((n) => n !== null).reduce((a, b) => a + b, 0) : null };
        if (res.value === null || res.value === undefined) {
          if (res.refused) refusals.push(`${columnLabel(c.name, semantics)}: ${res.note}`);
          return '<td></td>';
        }
        const title = res.method && res.method !== 'sum' ? ` title="${esc(res.method)}"` : '';
        return `<td class="dw-num${signClass(res.value, sem)}"${title}>${esc(formatValue(res.value, sem))}</td>`;
      }).join('');
      foot = `<tfoot><tr class="dw-total-row">${cells}</tr></tfoot>`;
    }

    // The tools row is the difference between a table you read and a table
    // you use. Search and CSV are reader actions, so they are present in
    // view mode too.
    const tools = `<div class="dw-table-tools">
        <input type="search" class="bcn-field dw-table-search" data-role="table-search"
               placeholder="Search rows" aria-label="Search this table"
               value="${esc(state.search || '')}" />
        <span class="dw-table-count bcn-mono">${shown.length.toLocaleString()}${
          matched !== shown.length ? ` of ${matched.toLocaleString()}` : ''} rows</span>
        <button type="button" class="bcn-btn bcn-btn--ghost dw-csv" data-act="export-csv"
                title="Download exactly these rows and columns as CSV">CSV</button>
      </div>`;

    const notes = [];
    if (truncated) {
      notes.push(`Showing ${shown.length.toLocaleString()} of ${matched.toLocaleString()} rows`
        + (cfg.totals ? ' — the total covers the rows shown' : ''));
    }
    if (state.search) notes.push(`Search matched ${matched.toLocaleString()} of ${rows.length.toLocaleString()} loaded rows`);
    if (refusals.length) notes.push('No total for ' + refusals.join('; '));
    const note = notes.length ? `<div class="dw-foot-note">${esc(notes.join(' · '))}</div>` : '';

    // tabindex + role make the horizontal scroller reachable by keyboard:
    // a wide table whose rightmost columns can only be reached by dragging
    // is unusable without a mouse.
    return tools + `<div class="dw-table-wrap" tabindex="0" role="region"
        aria-label="Table, scroll horizontally for more columns"><table class="dw-table">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>${note}`;
  }

  /**
   * Which measure a KPI is showing -- or null, meaning "nobody has said".
   *
   * A KPI is one number under one title, so getting the column wrong is not
   * a formatting slip: it is a card headed "Total sales" printing MLB sales,
   * which is what happened live. The old behaviour fell back to the first
   * numeric column whenever `y_field` was unset, and every path that creates
   * a KPI without choosing one (switching visual type, an imported config)
   * landed there silently.
   *
   * So the fallback is now allowed in exactly one case: the result has ONE
   * numeric column, where "first numeric" and "the only measure" are the
   * same statement and there is nothing to get wrong. With a choice to make,
   * the widget says so instead of guessing -- and never infers the measure
   * from the card's title, which is the one place a wrong guess is invisible.
   */
  function kpiField(prof, cfg) {
    const meas = measuresOf(prof);
    if (cfg && cfg.y_field && prof.some((c) => c.name === cfg.y_field)) {
      return { field: cfg.y_field, chosen: true };
    }
    if (meas.length === 1) return { field: meas[0].name, chosen: false };
    return { field: null, chosen: false, candidates: meas.map((c) => c.name) };
  }

  /**
   * A sparkline drawn as inline SVG rather than as an ECharts instance.
   *
   * A KPI tile is often 3x2 grid cells; standing up a whole chart runtime,
   * a canvas and a ResizeObserver inside it for forty points costs more
   * than the tile does. SVG also scales with the tile without a resize
   * pass, which is what makes the KPI survive the density switch and the
   * full-screen move for free.
   *
   * No axes and no labels on purpose: a sparkline is shape, not
   * measurement. The number above it is the measurement.
   */
  function sparklineSvg(values, t, semantic) {
    const nums = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    if (nums.length < 2) return '';
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const W = 100;
    const H = 26;
    const step = W / (nums.length - 1);
    const pts = nums.map((v, i) => `${(i * step).toFixed(2)},${(H - ((v - min) / span) * (H - 3) - 1.5).toFixed(2)}`);
    const last = nums[nums.length - 1];
    const first = nums[0];
    // The stroke follows the metric's direction, not a fixed accent: a
    // sparkline that is red when the number fell is readable at a glance
    // in a way a blue one is not. Colour is never the only signal -- the
    // delta line underneath states the direction in words.
    const colour = last === first ? t.ink2 : (last > first ? t.palette[1] : (t.dark ? '#ff829a' : '#d94f6a'));
    const lastPt = pts[pts.length - 1].split(',');
    return `<svg class="dw-kpi-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
        role="img" aria-label="Trend across ${nums.length} points, ${formatValue(first, semantic)} to ${formatValue(last, semantic)}">
        <polyline points="${pts.join(' ')}" fill="none" stroke="${colour}" stroke-width="1.6"
                  stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="1.8" fill="${colour}" />
      </svg>`;
  }

  function kpiHtml(rows, config, semantics) {
    const cfg = config || {};
    const prof = profileColumns(rows || []);
    const meas = measuresOf(prof);
    const pick = kpiField(prof, cfg);
    const field = pick.field;
    if (!field) {
      if (!meas.length) return '<div class="dw-empty">No numeric column to show as a KPI.</div>';
      // Named candidates, not a bare instruction: the point is that the
      // reader can see this card has not been told what it measures.
      return `<div class="dw-empty dw-empty--warn dw-kpi-unset">
          <strong>This KPI has no measure selected.</strong>
          <span class="dw-empty-hint">Pick one of ${esc(meas.map((c) => columnLabel(c.name, semantics)).join(', '))}
          in the widget's <em>Data</em> settings. A card's title is not evidence of which number it shows.</span>
        </div>`;
    }

    const list = rows || [];
    const nums = list.map((r) => toNumber(r[field])).filter((n) => n !== null);
    if (!nums.length) return '<div class="dw-empty">No value</div>';

    const semantic = semanticOf(field, semantics, prof);

    // A KPI over many rows has to say WHICH number it is showing, and how
    // it got there. Rolling up goes through SiloMetrics so a rate is pooled
    // from its numerator and denominator where the result carries them --
    // and refused, not averaged, where it does not. Averaging 2% over 100
    // sessions with 10% over 10,000 gives 6%; the real rate is 9.9%.
    const requested = cfg.aggregate || (nums.length === 1 ? 'first' : 'sum');
    const rolled = global.SiloMetrics
      ? global.SiloMetrics.aggregate(list, field, semantic, { aggregate: requested })
      : { value: nums.reduce((a, b) => a + b, 0), method: 'sum' };
    if (rolled.value === null || rolled.value === undefined) {
      return `<div class="dw-empty dw-empty--warn">
          <strong>This number cannot be rolled up.</strong>
          <span class="dw-empty-hint">${esc(rolled.note || 'no value')}</span>
        </div>`;
    }
    const agg = requested;
    let value = rolled.value;
    const valueSemantic = agg === 'count' ? 'count' : semantic;

    // A bare number is most of a KPI's job left undone: $36,393,571 says
    // nothing without something to compare it to. `compare_field` names a
    // second measure to read as the prior value; `compare: 'previous_row'`
    // compares the LAST row to the one before it, which is what a daily or
    // monthly series means by "vs last period".
    let prior = null;
    let priorLabel = '';
    let compareRefusal = '';
    const M = global.SiloMetrics;
    if (cfg.compare_field && prof.some((c) => c.name === cfg.compare_field)) {
      const priorSem = semanticOf(cfg.compare_field, semantics, prof);
      const p2 = M
        ? M.aggregate(list, cfg.compare_field, priorSem, { aggregate: agg })
        : { value: list.map((r) => toNumber(r[cfg.compare_field])).filter((n) => n !== null).reduce((a, b) => a + b, 0) };
      if (p2.value !== null && p2.value !== undefined) {
        prior = p2.value;
        priorLabel = columnLabel(cfg.compare_field, semantics);
      } else if (p2.refused) {
        compareRefusal = p2.note;
      }
    } else if (cfg.compare === 'previous_row') {
      // Refused rather than manufactured: one row has no previous row, and
      // a comparison invented from insufficient data is worse than none.
      const check = M ? M.canCompare('previous_row', { rowCount: nums.length }) : { ok: nums.length >= 2 };
      if (check.ok) {
        prior = nums[nums.length - 2];
        value = nums[nums.length - 1];
        priorLabel = 'the previous row';
      } else {
        compareRefusal = check.reason || 'not enough rows to compare';
      }
    } else if (cfg.compare_field) {
      compareRefusal = `"${cfg.compare_field}" is not in this result any more`;
    }

    let delta = '';
    if (prior !== null) {
      const ch = M ? M.change(value, prior, valueSemantic) : null;
      if (ch && ch.ok && (ch.percent !== null || ch.unit === 'pp')) {
        const dir = ch.direction;
        // A rate moves in PERCENTAGE POINTS. Calling 4% -> 5% a 25% rise is
        // a true statement about a different quantity, and the one people
        // quote when they want the bigger number, so points lead and the
        // relative change follows in brackets.
        const magnitude = ch.unit === 'pp'
          ? `${Math.abs(ch.points).toLocaleString(undefined, { maximumFractionDigits: 2 })}pp`
          : `${Math.abs(ch.percent).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
        const extra = ch.unit === 'pp' && ch.percent !== null
          ? ` (${Math.abs(ch.percent).toLocaleString(undefined, { maximumFractionDigits: 1 })}% relative)` : '';
        delta = `<div class="dw-kpi-delta dw-kpi-delta--${dir}">
            <span aria-hidden="true">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬'}</span>
            ${esc(magnitude)}
            <span class="dw-kpi-delta-note">${esc(dir === 'flat' ? 'unchanged vs' : `${dir} vs`)} ${esc(priorLabel)} (${esc(formatValue(prior, valueSemantic))})${esc(extra)}</span>
          </div>`;
      } else if (ch && ch.ok) {
        delta = `<div class="dw-kpi-delta dw-kpi-delta--flat">
            <span class="dw-kpi-delta-note">${esc(formatValue(ch.absolute, valueSemantic))} vs ${esc(priorLabel)} — no percentage, the prior value is zero</span>
          </div>`;
      }
    } else if (compareRefusal) {
      // Say why there is no comparison rather than silently dropping it:
      // a card configured to compare and showing none reads as a bug.
      delta = `<div class="dw-kpi-delta dw-kpi-delta--none">
          <span class="dw-kpi-delta-note">No comparison — ${esc(compareRefusal)}</span>
        </div>`;
    }

    // The sparkline is the shape behind the number, and only means anything
    // when the rows are in a meaningful order -- which is the query's, so it
    // is drawn from the rows as they arrived rather than from anything
    // sorted here.
    const spark = cfg.sparkline && nums.length > 1
      ? sparklineSvg(nums, theme(), valueSemantic) : '';

    // Abbreviation is a WIDGET choice, not a report one: the same measure
    // wants $36.4M in a 3-column tile and $36,393,571 in a wide one.
    const shown = cfg.abbreviate ? compact(value, valueSemantic) : formatValue(value, valueSemantic);
    const method = rolled.method && rolled.method.startsWith('pooled') ? rolled.method : null;
    const aggLabel = nums.length === 1
      ? columnLabel(field, semantics)
      : `${method || agg} of ${columnLabel(field, semantics)} · ${nums.length} rows`;
    return `<div class="dw-kpi">
      <div class="dw-kpi-value"${cfg.abbreviate ? ` title="${esc(formatValue(value, valueSemantic))}"` : ''}>${esc(shown)}</div>
      ${spark}
      ${delta}
      <div class="dw-kpi-label" title="${esc(field)}">${esc(aggLabel)}</div>
    </div>`;
  }

  // ── Answer widget ────────────────────────────────────────────────────
  // The one visual with no query and no rows: it renders a saved report's
  // ANSWER text (an Ask SILO synthesis) as markdown, for the case a chart or
  // table can never cover -- a genuinely open-ended question that took many
  // queries and never reduced to one dataset. Same rendering Ask SILO's own
  // chat bubbles and saved-report detail view already use (marked +
  // DOMPurify), so an answer reads identically wherever it is shown.
  let delTokenizerPatched = false;
  function answerHtml(text) {
    if (!text) return '<div class="dw-empty">No answer text saved.</div>';
    if (!(global.marked && global.DOMPurify)) {
      // Libraries failed to load (offline CDN, ad blocker). Still readable,
      // just as plain text -- never silently blank.
      return `<div class="dw-answer">${esc(text)}</div>`;
    }
    // Answers write "~$24K" for approximations, and marked's GFM `del` rule
    // pairs single tildes across a sentence into strikethrough. Answers
    // never intentionally use strikethrough, so disable it once -- same fix
    // silo-chat.html applies to the identical text. Returning undefined from
    // the tokenizer means "no match here," so the tildes fall through as
    // literal text instead.
    if (!delTokenizerPatched && global.marked.use) {
      global.marked.use({ tokenizer: { del: () => undefined } });
      delTokenizerPatched = true;
    }
    return `<div class="dw-answer">${global.DOMPurify.sanitize(global.marked.parse(text))}</div>`;
  }

  global.SiloChart = {
    VISUAL_TYPES: ['table', 'kpi', 'bar', 'line', 'donut', 'matrix', 'combo', 'heatmap', 'waterfall'],
    profileColumns, dimensionsOf, measuresOf,
    recommend, shape, optionFor, validateVisual,
    grid2dOf, heatmapOption, waterfallOption,
    tableHtml, tableRows, tableCsv, matrixHtml, kpiHtml, kpiField, answerHtml, columnLabel,
    AGGREGATES, defaultAggregate, semanticOf, visibleColumns, ruleTone,
    formatValue, compact, inferFormat, theme, isDark, esc,
  };
})(window);
