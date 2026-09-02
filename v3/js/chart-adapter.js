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
      return { name, type, distinct, nonNull: vals.length };
    });
  }

  const dimensionsOf = (prof) => prof.filter((c) => c.type !== 'number' && c.type !== 'json');
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
  function shape(rows, config, semantics) {
    const cfg = config || {};
    if (!Array.isArray(rows) || !rows.length) return null;
    const prof = profileColumns(rows);
    const has = (f) => f && prof.some((c) => c.name === f);

    const xField = has(cfg.x_field) ? cfg.x_field : (dimensionsOf(prof)[0] || {}).name;
    const yField = has(cfg.y_field) ? cfg.y_field : (measuresOf(prof)[0] || {}).name;
    if (!xField || !yField) return null;

    const semantic = semanticOf(yField, semantics, prof);
    const agg = AGGREGATES.includes(cfg.aggregate) ? cfg.aggregate : defaultAggregate(semantic);

    let points;
    let aggregatedFrom = 0;
    if (agg === 'none') {
      points = rows.map((r) => ({ label: r[xField], value: toNumber(r[yField]), row: r }));
    } else {
      // Map keyed on the STRING label, but the first row's original label is
      // kept for display -- two rows whose dimension is null and '' must not
      // silently merge into one bar under a key of ''.
      const groups = new Map();
      for (const r of rows) {
        const key = r[xField] === null || r[xField] === undefined ? '\u0000null' : String(r[xField]);
        if (!groups.has(key)) groups.set(key, { label: r[xField], nums: [], rows: [] });
        const g = groups.get(key);
        const n = toNumber(r[yField]);
        if (n !== null) g.nums.push(n);
        g.rows.push(r);
      }
      aggregatedFrom = rows.length;
      points = Array.from(groups.values()).map((g) => ({
        label: g.label, value: aggregateValues(g.nums, agg), row: g.rows[0], rowCount: g.rows.length,
      }));
    }

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
    if (truncated) points = points.slice(0, limit);

    return {
      xField, yField, points, truncated, totalRows,
      aggregate: agg,
      // Non-zero only when grouping actually collapsed rows -- the foot uses
      // this to say "10 of 46 products (from 1,204 rows)" instead of
      // implying the chart shows every row it was given.
      aggregatedFrom: aggregatedFrom > totalRows ? aggregatedFrom : 0,
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
    const values = shaped.points.map((p) => p.value);
    const horizontal = kind === 'bar' && labels.some((l) => l.length > 14);

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
    const valAxis = {
      type: 'value',
      axisLabel: { color: t.ink2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace', formatter: (v) => compact(v, shaped.format) },
      splitLine: { lineStyle: { color: t.grid, type: 'dashed' } },
      axisLine: { show: false },
    };

    const series = {
      type: kind === 'line' ? 'line' : 'bar',
      data: horizontal ? values.slice().reverse() : values,
      barMaxWidth: 34,
      itemStyle: { borderRadius: kind === 'bar' ? (horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]) : 0 },
      smooth: kind === 'line' ? 0.2 : false,
      showSymbol: kind === 'line' && shaped.points.length <= 40,
      symbolSize: 5,
      lineStyle: kind === 'line' ? { width: 2 } : undefined,
      areaStyle: kind === 'line' ? { opacity: t.dark ? 0.14 : 0.08 } : undefined,
    };

    return {
      ...baseOption(t),
      tooltip: {
        ...baseOption(t).tooltip,
        trigger: 'axis',
        axisPointer: { type: kind === 'line' ? 'line' : 'shadow' },
        formatter: (params) => {
          const p = Array.isArray(params) ? params[0] : params;
          return `<div style="font-size:11px;opacity:.7">${p.name}</div>
                  <div style="font-weight:700">${formatValue(p.value, shaped.format)}</div>`;
        },
      },
      grid: { left: 8, right: 14, top: 14, bottom: 4, containLabel: true },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      series: [series],
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
        })),
      }],
    };
  }

  function optionFor(visualType, shaped) {
    const t = theme();
    if (visualType === 'donut') return donutOption(shaped, t);
    return axisChartOption(visualType === 'line' ? 'line' : 'bar', shaped, t);
  }

  // ── HTML visuals (table / KPI) ───────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

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

    const head = prof.map((c) => `<th class="${c.type === 'number' ? 'dw-num' : ''}">${esc(c.name)}</th>`).join('');
    const body = shown.map((r) => `<tr>${prof.map((c) => {
      const raw = r[c.name];
      let cell;
      if (c.type === 'number') cell = formatValue(raw, semanticOf(c.name, semantics, prof));
      else if (raw !== null && typeof raw === 'object') {
        // jsonb. Show the JSON rather than "[object Object]" -- the value is
        // the point, and a truncated object at least says what is in there.
        try { cell = JSON.stringify(raw); } catch { cell = '[unserialisable]'; }
      } else cell = (raw === null || raw === undefined ? '' : String(raw));
      const full = cell;
      if (cell.length > 160) cell = cell.slice(0, 157) + '…';
      return `<td class="${c.type === 'number' ? 'dw-num' : ''}"${c.type === 'json' ? ` title="${esc(full)}"` : ''}>${esc(cell)}</td>`;
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
    const value = agg === 'first' ? nums[0]
      : agg === 'avg' ? nums.reduce((a, b) => a + b, 0) / nums.length
      : agg === 'max' ? Math.max(...nums)
      : agg === 'min' ? Math.min(...nums)
      : agg === 'count' ? nums.length
      : nums.reduce((a, b) => a + b, 0);

    const semantic = semanticOf(field, semantics, prof);
    const aggLabel = nums.length === 1 ? field : `${agg} of ${field} · ${nums.length} rows`;
    return `<div class="dw-kpi">
      <div class="dw-kpi-value">${esc(formatValue(value, agg === 'count' ? 'count' : semantic))}</div>
      <div class="dw-kpi-label">${esc(aggLabel)}</div>
    </div>`;
  }

  global.SiloChart = {
    VISUAL_TYPES: ['table', 'kpi', 'bar', 'line', 'donut'],
    profileColumns, dimensionsOf, measuresOf,
    recommend, shape, optionFor,
    tableHtml, kpiHtml,
    AGGREGATES, defaultAggregate, semanticOf,
    formatValue, inferFormat, theme, isDark, esc,
  };
})(window);
