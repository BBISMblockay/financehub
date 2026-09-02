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
   honest about the fact that the query runner caps every result at 500
   rows.
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
      points = Array.from(groups.values()).map((g) => ({
        label: g.label, row: g.rows[0], rowCount: g.rows.length,
        // Each measure is aggregated with the aggregate that suits ITS OWN
        // semantic, not the widget's -- summing a ratio next to summing
        // dollars is how a ROAS column becomes 99 instead of 3.3.
        values: Object.fromEntries(fields.map((f) => {
          const sem = semanticOf(f, semantics, prof);
          const perField = AGGREGATES.includes(cfg.aggregate) && fields.length === 1
            ? cfg.aggregate : defaultAggregate(sem);
          return [f, aggregateValues(g.nums[f], perField)];
        })),
      }));
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

  function axisChartOption(kind, shaped, t) {
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
      const asLine = kind === 'line' || (multi && sr.axis === 1);
      const data = horizontal ? sr.data.slice().reverse() : sr.data;
      return {
        name: sr.field,
        type: asLine ? 'line' : 'bar',
        yAxisIndex: horizontal ? undefined : sr.axis,
        xAxisIndex: horizontal ? sr.axis : undefined,
        data,
        barMaxWidth: 34,
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
      legend: multi ? {
        type: 'scroll', top: 0, left: 'center',
        textStyle: { color: t.ink2, fontSize: 10.5, fontFamily: '"IBM Plex Mono", monospace' },
        itemWidth: 12, itemHeight: 8,
      } : undefined,
      grid: { left: 8, right: shaped.hasSecondAxis ? 12 : 14, top: multi ? 30 : 14, bottom: 4, containLabel: true },
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

  function optionFor(visualType, shaped) {
    const t = theme();
    if (visualType === 'donut') return donutOption(shaped, t);
    return axisChartOption(visualType === 'line' ? 'line' : 'bar', shaped, t);
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

  const ACRONYMS = { roas: 'ROAS', aov: 'AOV', sku: 'SKU', po: 'PO', qbo: 'QBO',
                     mtd: 'MTD', ytd: 'YTD', cy: 'CY', ly: 'LY', id: 'ID',
                     cogs: 'COGS', cac: 'CAC', cpm: 'CPM', ctr: 'CTR', pct: '%' };
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
    const colField = cfg.x_field
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

    const note = truncated
      ? `<div class="dw-foot-note">Showing ${shownRows.length} of ${rowKeys.length} rows</div>` : '';
    return `<div class="bcn-matrix-scroll dw-matrix-wrap">
        <table class="bcn-table dw-matrix"><thead>${head}</thead><tbody>${body}</tbody></table>
      </div>${note}`;
  }

  function tableHtml(rows, config, semantics) {
    if (!Array.isArray(rows) || !rows.length) return '<div class="dw-empty">0 rows</div>';
    const prof = profileColumns(rows);
    const cfg = config || {};

    let shown = rows.slice();
    const sortField = cfg.y_field && prof.some((c) => c.name === cfg.y_field) ? cfg.y_field : null;
    if (sortField && (cfg.sort === 'desc' || cfg.sort === 'asc')) {
      const dir = cfg.sort === 'desc' ? -1 : 1;
      shown.sort((a, b) => dir * (((toNumber(a[sortField]) ?? 0)) - ((toNumber(b[sortField]) ?? 0))));
    }
    const limit = Number(cfg.limit) || 0;
    const truncated = limit > 0 && shown.length > limit;
    if (truncated) shown = shown.slice(0, limit);

    const head = prof.map((c) =>
      `<th class="${c.type === 'number' ? 'dw-num' : ''}" title="${esc(c.name)}">${esc(columnLabel(c.name, semantics))}</th>`).join('');
    const body = shown.map((r) => `<tr>${prof.map((c) => {
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
            return `<td class="dw-cell-img"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">`
              + `<img class="dw-thumb" src="${esc(url)}" alt="" loading="lazy" /></a></td>`;
          }
          return `<td class="dw-cell-link"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
            + ` title="${esc(url)}">${esc(linkLabel(url))}</a></td>`;
        }
      }

      let cell;
      let numClass = c.type === 'number' ? 'dw-num' : '';
      if (c.type === 'number') { cell = formatValue(raw, sem); numClass += signClass(raw, sem); }
      else if (raw !== null && typeof raw === 'object') {
        // jsonb. Show the JSON rather than "[object Object]" -- the value is
        // the point, and a truncated object at least says what is in there.
        try { cell = JSON.stringify(raw); } catch { cell = '[unserialisable]'; }
      } else cell = (raw === null || raw === undefined ? '' : String(raw));
      const full = cell;
      if (cell.length > 160) cell = cell.slice(0, 157) + '…';
      return `<td class="${numClass}"${c.type === 'json' ? ` title="${esc(full)}"` : ''}>${esc(cell)}</td>`;
    }).join('')}</tr>`).join('');

    const note = truncated ? `<div class="dw-foot-note">Showing ${shown.length} of ${rows.length} rows</div>` : '';
    return `<div class="dw-table-wrap"><table class="dw-table">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${note}`;
  }

  function kpiHtml(rows, config, semantics) {
    const cfg = config || {};
    const prof = profileColumns(rows || []);
    const meas = measuresOf(prof);
    const field = cfg.y_field && prof.some((c) => c.name === cfg.y_field) ? cfg.y_field : (meas[0] || {}).name;
    if (!field) return '<div class="dw-empty">No numeric column to show as a KPI.</div>';

    const nums = (rows || []).map((r) => toNumber(r[field])).filter((n) => n !== null);
    if (!nums.length) return '<div class="dw-empty">No value</div>';

    // A KPI over many rows has to say WHICH number it is showing. Sum is
    // the default because that is what a "total sales" style report means,
    // but a rate or an average is not summable, so the aggregate is part
    // of the config and printed under the value either way.
    const agg = cfg.aggregate || (nums.length === 1 ? 'first' : 'sum');
    let value = agg === 'first' ? nums[0]
      : agg === 'avg' ? nums.reduce((a, b) => a + b, 0) / nums.length
      : agg === 'max' ? Math.max(...nums)
      : agg === 'min' ? Math.min(...nums)
      : agg === 'count' ? nums.length
      : nums.reduce((a, b) => a + b, 0);

    const semantic = semanticOf(field, semantics, prof);
    const valueSemantic = agg === 'count' ? 'count' : semantic;

    // A bare number is most of a KPI's job left undone: $36,393,571 says
    // nothing without something to compare it to. `compare_field` names a
    // second measure to read as the prior value; with no config, a
    // multi-row result compares the LAST row to the one before it, which is
    // what a daily or monthly series means by "vs last period".
    let prior = null;
    let priorLabel = '';
    if (cfg.compare_field && prof.some((c) => c.name === cfg.compare_field)) {
      const p2 = (rows || []).map((r) => toNumber(r[cfg.compare_field])).filter((n) => n !== null);
      if (p2.length) {
        prior = agg === 'first' ? p2[0] : p2.reduce((a, b) => a + b, 0);
        priorLabel = columnLabel(cfg.compare_field, semantics);
      }
    } else if (cfg.compare === 'previous_row' && nums.length > 1) {
      prior = nums[nums.length - 2];
      value = nums[nums.length - 1];
      priorLabel = 'previous';
    }

    let delta = '';
    if (prior !== null && prior !== 0) {
      const pct = ((value - prior) / Math.abs(prior)) * 100;
      // Direction is stated with a word as well as a colour and an arrow --
      // colour alone is not readable for everyone, and an arrow alone does
      // not survive being pasted into Slack.
      const dir = pct >= 0 ? 'up' : 'down';
      delta = `<div class="dw-kpi-delta dw-kpi-delta--${dir}">
          <span aria-hidden="true">${pct >= 0 ? '▲' : '▼'}</span>
          ${esc(Math.abs(pct).toLocaleString(undefined, { maximumFractionDigits: 1 }))}%
          <span class="dw-kpi-delta-note">${dir} vs ${esc(priorLabel)} (${esc(formatValue(prior, valueSemantic))})</span>
        </div>`;
    }

    // Abbreviation is a WIDGET choice, not a report one: the same measure
    // wants $36.4M in a 3-column tile and $36,393,571 in a wide one.
    const shown = cfg.abbreviate ? compact(value, valueSemantic) : formatValue(value, valueSemantic);
    const aggLabel = nums.length === 1 ? columnLabel(field, semantics)
      : `${agg} of ${columnLabel(field, semantics)} · ${nums.length} rows`;
    return `<div class="dw-kpi">
      <div class="dw-kpi-value"${cfg.abbreviate ? ` title="${esc(formatValue(value, valueSemantic))}"` : ''}>${esc(shown)}</div>
      ${delta}
      <div class="dw-kpi-label">${esc(aggLabel)}</div>
    </div>`;
  }

  global.SiloChart = {
    VISUAL_TYPES: ['table', 'kpi', 'bar', 'line', 'donut'],
    profileColumns, dimensionsOf, measuresOf,
    recommend, shape, optionFor,
    tableHtml, matrixHtml, kpiHtml, columnLabel,
    AGGREGATES, defaultAggregate, semanticOf,
    formatValue, inferFormat, theme, isDark, esc,
  };
})(window);
