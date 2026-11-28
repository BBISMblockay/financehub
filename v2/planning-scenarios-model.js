/* Scenario planning — the model, with no DOM and no network.
 *
 * Ported line for line from the arithmetic inside /v2/planning-scenarios.html
 * (revenue × mix ÷ price, the historical-lift mode with its per-channel
 * assumptions, the channel share allocation and the inventory gap) so the
 * compact page can show the same numbers as the page people use today. The
 * only thing added is `planSource`: where each month's revenue plan comes from
 * when nobody has typed one — history, as before, or the revenue projections.
 *
 * Everything here is a pure function of rows in and assumptions in, so
 * scripts/tests/planning-scenarios-model.test.mjs can hold the numbers still.
 * The old page keeps its own copy until it is retired; this file is the one
 * the compact page reads.
 */
(function (root, factory) {
  root.SiloScenarioModel = factory();
})(globalThis, function () {
  'use strict';

  const CHANNELS = [
    { key: 'online', label: 'Online' },
    { key: 'retail', label: 'Retail' },
    { key: 'wholesale', label: 'Wholesale / Faire' },
  ];
  const SCENARIOS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  const norm = (v) => String(v ?? '').replace(/ /g, ' ').trim();
  function num(v) {
    const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(x) ? x : 0;
  }
  function pick(row, names, fallback = '') {
    for (const n of names) if (row && row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
    return fallback;
  }
  const monthKey = (v) => { if (!v) return ''; const s = String(v); return s.length >= 7 ? s.slice(0, 7) : s; };
  function addMonths(month, offset) {
    if (!month || month.length < 7) return '';
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, (m - 1) + offset, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const sameMonthPriorYear = (month) => addMonths(month, -12);
  function buildMonthRange(from, to) {
    if (!from || !to) return [];
    const out = [];
    let cursor = from, guard = 0;
    while (cursor <= to && guard < 48) { out.push(cursor); cursor = addMonths(cursor, 1); guard++; }
    return out;
  }
  const normalizeTitleKey = (v) => String(v ?? '').trim().toLowerCase()
    .replace(/['"]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').replace(/-+/g, '-');

  /* Channel is read from the row's own channel/location words, exactly as the
     live page reads it: a location nobody classified counts as retail. */
  function channelOf(row) {
    const c = norm(row.channel).toLowerCase();
    const loc = norm(row.location || row.location_tag).toLowerCase();
    if (c.includes('online') || loc === 'online') return 'online';
    if (c.includes('wholesale') || c.includes('faire') || c.includes('dsg') || c.includes('event')
      || loc.includes('wholesale') || loc.includes('faire') || loc.includes('dsg')
      || loc.includes('popup') || loc.includes('pop_up')) return 'wholesale';
    return 'retail';
  }
  /* A LOCATION's channel, so a revenue projection -- which is stored per
     location, with no channel of its own -- can be attributed to one. Its own
     store_type is read first, then the same words the sales rows are read by. */
  function channelOfLocation(row) {
    const t = norm(row && row.store_type).toLowerCase();
    if (t.includes('online') || t.includes('ecom') || t.includes('web')) return 'online';
    if (t.includes('wholesale') || t.includes('faire') || t.includes('event')) return 'wholesale';
    if (t.includes('retail') || t.includes('store')) return 'retail';
    return channelOfInventory({
      location_tag: norm(row && (row.location_code || row.location_name)),
    });
  }
  function locationChannels(locations) {
    const out = new Map();
    for (const l of locations || []) {
      if (l && l.id != null) out.set(String(l.id), channelOfLocation(l));
    }
    return out;
  }

  function channelOfInventory(row) {
    const loc = norm(pick(row, ['location_tag', 'location', 'location_label', 'location_name'], 'unknown')).toLowerCase();
    if (loc === 'online') return 'online';
    if (loc.includes('wholesale') || loc.includes('faire') || loc.includes('dsg')
      || loc.includes('popup') || loc.includes('pop_up')) return 'wholesale';
    return 'retail';
  }

  const mapSalesRow = (r) => ({
    month_key: monthKey(pick(r, ['month_key', 'month_start'], '')),
    product_type: norm(pick(r, ['product_type', 'Product Type'], 'Uncategorized')) || 'Uncategorized',
    channel: channelOf(r),
    location: norm(pick(r, ['location', 'location_tag'], '')),
    units: num(pick(r, ['units', 'total_quantity_sold'], 0)),
    revenue: num(pick(r, ['net', 'total_sales', 'gross'], 0)),
  });
  const mapInventoryRow = (r) => {
    const sku = norm(pick(r, ['variant_sku', 'sku', 'SKU'], ''));
    const product = norm(pick(r, ['product_title', 'product_name', 'title'], '')) || sku || 'Untitled product';
    return {
      channel: channelOfInventory(r),
      product_type: norm(pick(r, ['product_type', 'product_category', 'category'], 'Uncategorized')) || 'Uncategorized',
      product, product_key: normalizeTitleKey(product), sku,
      tag: norm(pick(r, ['tag'], '')), collection: norm(pick(r, ['collection'], '')),
      indicator_group: norm(pick(r, ['indicator_group'], '')),
      avail_qty: num(pick(r, ['total_available_quantity', 'available_quantity', 'avail_qty', 'quantity_available', 'quantity_on_hand', 'on_hand'], 0)),
      inv_value: num(pick(r, ['total_available_inventory_value', 'available_inventory_value', 'inventory_value', 'retail_value', 'inv_value'], 0)),
      sold_30: num(pick(r, ['sold_30', 'qty_30d', 'sold_30d'], 0)),
      qty_365d: num(pick(r, ['qty_365d', 'sold_365d'], 0)),
    };
  };
  const mapOpenPORow = (r) => {
    const product = norm(pick(r, ['product_title', 'title_snapshot', 'product_name'], '')) || 'Untitled product';
    return {
      po_name: norm(pick(r, ['po_name'], '')), factory_name: norm(pick(r, ['factory_name'], '')),
      month_key: monthKey(pick(r, ['month_key', 'planning_date', 'current_eta', 'expected_arrival_date', 'req_ship_date'], '')),
      channel: channelOfInventory(r),
      product_type: norm(pick(r, ['product_type', 'product_type_snapshot'], 'Uncategorized')) || 'Uncategorized',
      product, product_key: normalizeTitleKey(product), sku: norm(pick(r, ['sku'], '')),
      incoming_units: num(pick(r, ['incoming_units', 'qty'], 0)),
    };
  };
  const mapProjRow = (r) => ({
    month_key: monthKey(r.projection_date),
    location_id: r.location_id,
    projected_sales: num(r.projected_sales),
    scenario: norm(r.scenario) || 'active',
  });

  /* --- filtering, as run() does it ------------------------------------- */
  function filterRows({ sales = [], inventory = [], openPo = [] }, f) {
    const search = norm(f.productSearch).toLowerCase();
    return {
      sales: sales.filter((r) => (f.productType === '__ALL__' || r.product_type === f.productType)
        && (f.channel === '__ALL__' || r.channel === f.channel)
        && (!f.from || r.month_key >= f.from) && (!f.to || r.month_key <= f.to)),
      inventory: inventory.filter((r) => {
        if (f.productType !== '__ALL__' && r.product_type !== f.productType) return false;
        if (f.channel !== '__ALL__' && r.channel !== f.channel) return false;
        if (search && !`${r.product} ${r.sku} ${r.product_type} ${r.tag} ${r.collection} ${r.indicator_group}`.toLowerCase().includes(search)) return false;
        return true;
      }),
      openPo: openPo.filter((r) => {
        if (f.productType !== '__ALL__' && r.product_type !== f.productType) return false;
        if (f.channel !== '__ALL__' && r.channel && r.channel !== f.channel) return false;
        if (f.to && r.month_key && r.month_key > f.to) return false;
        if (search && !`${r.product} ${r.sku} ${r.product_type} ${r.po_name} ${r.factory_name}`.toLowerCase().includes(search)) return false;
        return true;
      }),
    };
  }

  function selectMonths(sales, f) {
    if (f.from && f.to) return buildMonthRange(f.from, f.to);
    let months = [...new Set(sales.map((r) => r.month_key).filter(Boolean))].sort();
    if (f.from) months = months.filter((m) => m >= f.from);
    if (f.to) months = months.filter((m) => m <= f.to);
    return months;
  }

  /* A month with no history of its own is read from the same month a year
     earlier -- the live page's baselineMonthFor. A future month is the normal
     case for a plan, so this is not a fallback, it is the baseline. */
  function baselineMonthFor(sales, month) {
    if (sales.some((r) => r.month_key === month)) return month;
    const prior = sameMonthPriorYear(month);
    if (sales.some((r) => r.month_key === prior)) return prior;
    return month;
  }

  function emptyChannelTotals(extra) {
    const out = {};
    for (const ch of CHANNELS) out[ch.key] = { key: ch.key, label: ch.label, units: 0, revenue: 0, ...extra };
    return out;
  }
  function salesTotalsByChannel(rows) {
    const out = emptyChannelTotals();
    for (const r of rows) {
      const k = out[r.channel] ? r.channel : 'retail';
      out[k].units += r.units; out[k].revenue += r.revenue;
    }
    return out;
  }
  function inventoryTotalsByChannel(rows) {
    const out = {};
    for (const ch of CHANNELS) out[ch.key] = { key: ch.key, label: ch.label, on_hand: 0, retail_value: 0 };
    for (const r of rows) {
      const k = out[r.channel] ? r.channel : 'retail';
      out[k].on_hand += r.avail_qty; out[k].retail_value += r.inv_value;
    }
    return out;
  }
  const openPOUnitsTotal = (rows) => rows.reduce((s, r) => s + r.incoming_units, 0);
  /* Incoming units carry no channel of their own, so they are split the way
     revenue was -- and, with no history at all, on the live page's fixed
     60/35/5, which is a guess and is labelled as one in the UI. */
  function openPOUnitsByChannelFromShare(openPo, histByCh) {
    const totalIncoming = openPOUnitsTotal(openPo);
    const baseline = Object.values(histByCh || {}).reduce((s, r) => s + num(r.revenue), 0);
    const out = {};
    for (const ch of CHANNELS) {
      const hist = histByCh?.[ch.key] || { revenue: 0 };
      const fallback = ch.key === 'online' ? 0.6 : ch.key === 'retail' ? 0.35 : 0.05;
      const share = baseline > 0 ? hist.revenue / baseline : fallback;
      out[ch.key] = { key: ch.key, label: ch.label, incoming_units: totalIncoming * share };
    }
    return out;
  }

  /* --- per-month assumptions -------------------------------------------- */
  function monthFacts(ctx, month) {
    const { sales, filters, overrides, projections } = ctx;
    const sourceMonth = baselineMonthFor(sales, month);
    const inMonth = sales.filter((r) => r.month_key === sourceMonth
      && (filters.channel === '__ALL__' || r.channel === filters.channel));
    const typeRows = inMonth.filter((r) => filters.productType === '__ALL__' || r.product_type === filters.productType);
    const allRevenue = inMonth.reduce((s, r) => s + r.revenue, 0);
    const typeRevenue = typeRows.reduce((s, r) => s + r.revenue, 0);
    const typeUnits = typeRows.reduce((s, r) => s + r.units, 0);
    // A projection is stored per location, so a channel filter has to be
    // applied through the locations themselves: with Online selected, summing
    // every location's projection would hand the Online plan the retail
    // revenue too. A location the workspace has not classified is left out of
    // a channel's plan rather than counted in it. With no locations in context
    // there is nothing to attribute by, and every row counts as before.
    const locChannels = ctx.locationChannels instanceof Map
      ? ctx.locationChannels
      : locationChannels(ctx.locations);
    const channelWanted = filters.channel && filters.channel !== '__ALL__' ? filters.channel : null;
    // No location map and a channel selected means the projections CANNOT be
    // attributed. Summing them anyway is the bug this filter exists to stop, so
    // the plan falls back to last year's actuals instead and says so.
    const canAttribute = !channelWanted || locChannels.size > 0;
    const projRevenue = !canAttribute ? 0 : projections
      .filter((r) => r.month_key === month
        && (!filters.projScenario || r.scenario === filters.projScenario)
        && (!filters.locationId || String(r.location_id) === String(filters.locationId))
        && (!channelWanted || locChannels.get(String(r.location_id)) === channelWanted))
      .reduce((s, r) => s + r.projected_sales, 0);

    const revOverride = num(overrides.rev?.[month]);
    const autoRevenue = (filters.planSource === 'projections' && projRevenue > 0) ? projRevenue : allRevenue;
    const planRevenue = revOverride > 0 ? revOverride : autoRevenue;

    const mixOverride = num(overrides.mix?.[month]);
    const autoMix = allRevenue > 0 ? typeRevenue / allRevenue : 0;
    const mix = mixOverride > 0 ? mixOverride / 100 : autoMix;

    const aspOverride = num(overrides.asp?.[month]);
    const autoAsp = typeUnits > 0 ? typeRevenue / typeUnits : 0;
    const asp = aspOverride > 0 ? aspOverride : autoAsp;

    return {
      month, baseline_month: sourceMonth,
      last_year: allRevenue, projection: projRevenue,
      plan_revenue: planRevenue, plan_source: revOverride > 0 ? 'typed'
        : (filters.planSource === 'projections' && projRevenue > 0) ? 'projections' : 'history',
      mix, mix_source: mixOverride > 0 ? 'typed' : 'history', auto_mix: autoMix,
      asp, asp_source: aspOverride > 0 ? 'typed' : 'history', auto_asp: autoAsp,
      auto_revenue: autoRevenue,
    };
  }

  /* --- revenue plan mode: revenue × mix ÷ price -------------------------- */
  function revenuePlanScenario(ctx, lift) {
    const { filtered, months, filters } = ctx;
    const invByCh = inventoryTotalsByChannel(filtered.inventory);
    let revenue = 0, units = 0;
    const monthRows = months.map((month) => {
      const f = monthFacts(ctx, month);
      const productRevenue = f.plan_revenue * f.mix * (1 + lift);
      const reqUnits = f.asp > 0 ? productRevenue / f.asp : 0;
      revenue += productRevenue; units += reqUnits;
      return { ...f, product_revenue: productRevenue, units: reqUnits };
    });
    const histUnits = filtered.sales.reduce((s, r) => s + r.units, 0);
    const histRevenue = filtered.sales.reduce((s, r) => s + r.revenue, 0);
    const onHand = Object.values(invByCh).reduce((s, r) => s + r.on_hand, 0);
    const retailValue = Object.values(invByCh).reduce((s, r) => s + r.retail_value, 0);
    const incoming = openPOUnitsTotal(filtered.openPo);
    const available = onHand + incoming;
    const gap = Math.ceil(units - available);
    const total = {
      key: 'total', label: 'Total',
      hist_units: histUnits, hist_revenue: histRevenue,
      hist_asp: histUnits > 0 ? histRevenue / histUnits : 0, hist_mix: 1, plan_mix: 1,
      plan_asp: units > 0 ? revenue / units : 0, asp_change: 0,
      revenue, units, unit_delta: units - histUnits, revenue_delta: revenue - histRevenue,
      on_hand: onHand, incoming_po_units: incoming, available_units: available, retail_value: retailValue,
      gap, gap_buffer: Math.max(0, Math.ceil(gap + units * filters.safetyPct)),
      mode: 'revenue × mix ÷ asp',
    };
    // Channels are allocated on the same months' historical revenue share.
    const histByCh = emptyChannelTotals();
    for (const month of months) {
      const sourceMonth = baselineMonthFor(ctx.sales, month);
      const rows = ctx.sales.filter((r) => r.month_key === sourceMonth
        && (filters.productType === '__ALL__' || r.product_type === filters.productType)
        && (filters.channel === '__ALL__' || r.channel === filters.channel));
      for (const r of rows) {
        const k = histByCh[r.channel] ? r.channel : 'retail';
        histByCh[k].units += r.units; histByCh[k].revenue += r.revenue;
      }
    }
    const incomingByCh = openPOUnitsByChannelFromShare(filtered.openPo, histByCh);
    const baseRevenue = Object.values(histByCh).reduce((s, r) => s + r.revenue, 0);
    const rows = CHANNELS.map((ch) => {
      const hist = histByCh[ch.key], inv = invByCh[ch.key];
      const share = baseRevenue > 0 ? hist.revenue / baseRevenue
        : (ch.key === 'online' ? 0.6 : ch.key === 'retail' ? 0.35 : 0.05);
      const chRevenue = revenue * share, chUnits = units * share;
      const incomingPo = incomingByCh[ch.key]?.incoming_units || 0;
      const availableUnits = inv.on_hand + incomingPo;
      const chGap = Math.ceil(chUnits - availableUnits);
      return {
        key: ch.key, label: ch.label,
        hist_units: hist.units, hist_revenue: hist.revenue,
        hist_asp: hist.units > 0 ? hist.revenue / hist.units : 0,
        hist_mix: share, plan_mix: share,
        plan_asp: chUnits > 0 ? chRevenue / chUnits : 0, asp_change: 0,
        revenue: chRevenue, units: chUnits,
        unit_delta: chUnits - hist.units, revenue_delta: chRevenue - hist.revenue,
        on_hand: inv.on_hand, incoming_po_units: incomingPo, available_units: availableUnits,
        retail_value: inv.retail_value, gap: chGap,
        gap_buffer: Math.max(0, Math.ceil(chGap + chUnits * filters.safetyPct)),
        mode: 'allocated by historical channel share',
      };
    });
    return { lift, rows, total, monthRows };
  }

  /* --- historical lift mode: last year's units × lift, at a price -------- */
  function historicalScenario(ctx, lift) {
    const { filtered, filters, overrides } = ctx;
    const histByCh = salesTotalsByChannel(filtered.sales);
    const invByCh = inventoryTotalsByChannel(filtered.inventory);
    const incomingByCh = openPOUnitsByChannelFromShare(filtered.openPo, histByCh);
    const histTotal = Object.values(histByCh).reduce((s, r) => s + r.revenue, 0);
    const rows = [];
    for (const ch of CHANNELS) {
      const hist = histByCh[ch.key], inv = invByCh[ch.key];
      const a = Object.assign(
        { enabled: true, mixPct: 0, bucketLift: 0, revenueOverride: 0, aspOverride: 0, aspChange: 0 },
        overrides.channels?.[ch.key] || {},
      );
      const histAsp = hist.units > 0 ? hist.revenue / hist.units : 0;
      const planAsp = a.aspOverride > 0 ? a.aspOverride : histAsp * (1 + a.aspChange);
      const combinedLift = lift + a.bucketLift;
      const histMix = histTotal > 0 ? hist.revenue / histTotal : 0;
      let revenue = 0, units = 0, mode = 'historical × lift';
      if (!a.enabled) { mode = 'disabled'; } else if (a.revenueOverride > 0) {
        revenue = a.revenueOverride; units = planAsp > 0 ? revenue / planAsp : 0; mode = 'bucket revenue override';
      } else if (filters.totalRevenueOverride > 0) {
        const mix = a.mixPct > 0 ? a.mixPct : histMix;
        revenue = filters.totalRevenueOverride * mix;
        units = planAsp > 0 ? revenue / planAsp : 0; mode = 'total revenue × mix';
      } else {
        units = hist.units * (1 + combinedLift); revenue = units * planAsp;
      }
      const incomingPo = incomingByCh[ch.key]?.incoming_units || 0;
      const availableUnits = inv.on_hand + incomingPo;
      const gap = Math.ceil(units - availableUnits);
      rows.push({
        key: ch.key, label: ch.label,
        hist_units: hist.units, hist_revenue: hist.revenue, hist_asp: histAsp, hist_mix: histMix,
        plan_mix: a.mixPct || histMix, plan_asp: planAsp,
        asp_change: histAsp > 0 ? (planAsp / histAsp - 1) : 0,
        revenue, units, unit_delta: units - hist.units, revenue_delta: revenue - hist.revenue,
        on_hand: inv.on_hand, incoming_po_units: incomingPo, available_units: availableUnits,
        retail_value: inv.retail_value, gap,
        gap_buffer: Math.max(0, Math.ceil(gap + units * filters.safetyPct)), mode,
      });
    }
    const total = rows.reduce((a, r) => {
      a.hist_units += r.hist_units; a.hist_revenue += r.hist_revenue;
      a.revenue += r.revenue; a.units += r.units;
      a.unit_delta += r.unit_delta; a.revenue_delta += r.revenue_delta;
      a.on_hand += r.on_hand; a.incoming_po_units += r.incoming_po_units;
      a.available_units += r.available_units; a.retail_value += r.retail_value;
      a.gap += r.gap; a.gap_buffer += r.gap_buffer;
      return a;
    }, {
      key: 'total', label: 'Total', hist_units: 0, hist_revenue: 0, revenue: 0, units: 0,
      unit_delta: 0, revenue_delta: 0, on_hand: 0, incoming_po_units: 0, available_units: 0,
      retail_value: 0, gap: 0, gap_buffer: 0,
    });
    total.hist_asp = total.hist_units > 0 ? total.hist_revenue / total.hist_units : 0;
    total.plan_asp = total.units > 0 ? total.revenue / total.units : 0;
    total.hist_mix = 1; total.plan_mix = 1;
    total.asp_change = total.hist_asp > 0 ? (total.plan_asp / total.hist_asp - 1) : 0;
    total.mode = 'total';
    // Historical mode has no month grain of its own; the months are shown so
    // the sheet still has rows, spread on each month's share of the baseline.
    const months = ctx.months;
    const shareBase = months.reduce((s, m) => s + monthFacts(ctx, m).last_year, 0);
    const monthRows = months.map((month) => {
      const f = monthFacts(ctx, month);
      const share = shareBase > 0 ? f.last_year / shareBase : (months.length ? 1 / months.length : 0);
      return {
        ...f,
        product_revenue: total.revenue * share,
        units: total.units * share,
      };
    });
    return { lift, rows, total, monthRows };
  }

  function prepare(input) {
    const filters = Object.assign({
      planMode: 'revenue_plan', planSource: 'history', productType: '__ALL__', channel: '__ALL__',
      productSearch: '', from: '', to: '', safetyPct: 0, totalRevenueOverride: 0,
      locationId: '', projScenario: 'active',
    }, input.filters || {});
    const sales = input.sales || [];
    const filtered = filterRows({ sales, inventory: input.inventory || [], openPo: input.openPo || [] }, filters);
    return {
      sales, filtered, filters,
      overrides: input.overrides || {},
      projections: input.projections || [],
      locations: input.locations || [],
      // built once: every month's plan needs it, and a channel filter is
      // meaningless for a projection without it.
      locationChannels: locationChannels(input.locations),
      months: selectMonths(sales, filters),
    };
  }

  /** One scenario at one lift (0.25 = +25%). */
  function computeScenario(input, lift) {
    const ctx = prepare(input);
    return ctx.filters.planMode === 'historical'
      ? historicalScenario(ctx, lift)
      : revenuePlanScenario(ctx, lift);
  }

  /** The whole ladder, for the compare row. */
  function computeLadder(input, lifts = SCENARIOS) {
    const ctx = prepare(input);
    const run = ctx.filters.planMode === 'historical' ? historicalScenario : revenuePlanScenario;
    return lifts.map((pctLift) => run(ctx, pctLift / 100));
  }

  /** The monthly facts on their own, for the sheet and for the AI prompt. */
  function monthlyFacts(input) {
    const ctx = prepare(input);
    return ctx.months.map((m) => monthFacts(ctx, m));
  }

  function productFamilies(inventory, openPo = []) {
    const by = new Map();
    for (const r of inventory) {
      const k = r.product_key || normalizeTitleKey(r.product);
      if (!by.has(k)) by.set(k, { product_key: k, product: r.product, product_type: r.product_type, avail_qty: 0, inv_value: 0, sold_30: 0, qty_365d: 0, incoming_units: 0, skus: new Set() });
      const a = by.get(k);
      a.avail_qty += r.avail_qty; a.inv_value += r.inv_value;
      a.sold_30 += r.sold_30; a.qty_365d += r.qty_365d;
      if (r.sku) a.skus.add(r.sku);
    }
    for (const r of openPo) {
      const k = r.product_key || normalizeTitleKey(r.product);
      if (by.has(k)) by.get(k).incoming_units += r.incoming_units;
    }
    return [...by.values()].map((r) => ({ ...r, sku_count: r.skus.size, skus: undefined }));
  }

  return {
    CHANNELS, SCENARIOS,
    num, norm, pick, monthKey, addMonths, sameMonthPriorYear, buildMonthRange, normalizeTitleKey,
    channelOf, channelOfInventory, channelOfLocation, locationChannels, mapSalesRow, mapInventoryRow, mapOpenPORow, mapProjRow,
    filterRows, selectMonths, baselineMonthFor, salesTotalsByChannel, inventoryTotalsByChannel,
    openPOUnitsTotal, openPOUnitsByChannelFromShare,
    computeScenario, computeLadder, monthlyFacts, productFamilies,
  };
});
