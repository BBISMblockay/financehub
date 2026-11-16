/* Shared read-only model for the Inventory Overview (/v2/inventory-overview.html).
 *
 * WHAT THIS IS. The Overview is the first tab of the Inventory suite. It reads
 * the same view the Inventory Manager reads -- `inventory_workboard_v` -- plus
 * open purchase-order lines, and says what the company HOLDS: value, units,
 * SKUs, where it sits and what is arriving. It writes nothing.
 *
 * WHY IT AGGREGATES IN SQL. /v2/inventory.html fetches the whole view in seven
 * 10,000-row pages (~68k rows, tens of MB) because it is a workbench and needs
 * every row. An overview needs five small aggregates, so it runs them through
 * `chat_run_readonly_query` -- the shared report engine every other SILO report
 * surface uses: SECURITY INVOKER, so RLS is still the tenant boundary, SELECT
 * only, 1000 rows per page. Each aggregate here returns well under 1,000 rows
 * (the widest is locations x buckets).
 *
 * WHY NO DAYS-OF-COVER. The first draft of this page was built on cover days
 * and velocity. Blake, 2026-11-16: "let's not put re order, more inventory
 * focused and less forecast demand focused". Every band on this page is a UNIT
 * COUNT, which is a fact about the stock, not a projection. The one place
 * velocity still appears is the "no sale in 90 days" figure, and there it is
 * read through `velocity_matched` so an unmatched row is never called stale --
 * see v2/inventory-signals.js for why that flag exists.
 *
 * NOTHING HERE IS COMPANY-SPECIFIC. Product types, locations and the currency
 * all come from the data; a card with no rows is hidden by the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SiloInventoryOverview = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------- buckets */

  /* Stock depth, in units on hand. Deliberately coarse: these are the five
   * states somebody acts on, and every one of them is a count of units rather
   * than a forecast. `neg` is kept apart from `out` because negative on hand is
   * a data problem (a sale recorded against stock that was never received),
   * not an empty shelf, and its value is negative -- folding it into the total
   * would quietly reduce the inventory value by that error. */
  const BUCKETS = Object.freeze([
    { key: 'deep', label: 'Deep stock, 100+ units', short: 'deep stock' },
    { key: 'ok', label: 'Healthy, 25–99', short: 'healthy' },
    { key: 'low', label: 'Low, 1–24', short: 'low' },
    { key: 'out', label: 'Out of stock', short: 'out' },
    { key: 'neg', label: 'Negative on hand', short: 'negative' },
  ]);
  const BUCKET_KEYS = Object.freeze(BUCKETS.map((b) => b.key));

  /** Which bucket a quantity on hand falls in. */
  function bucketOf(qty) {
    const n = Number(qty);
    if (!Number.isFinite(n)) return 'out';
    if (n < 0) return 'neg';
    if (n === 0) return 'out';
    if (n <= 24) return 'low';
    if (n <= 99) return 'ok';
    return 'deep';
  }

  /* The same CASE, in SQL, so the page and the database never disagree about
   * which bucket a row is in. Written once and reused by three queries. */
  const BUCKET_SQL = `case
      when total_available_quantity < 0 then 'neg'
      when total_available_quantity = 0 then 'out'
      when total_available_quantity <= 24 then 'low'
      when total_available_quantity <= 99 then 'ok'
      else 'deep' end`;

  // Open PO statuses, the same list po-report.html and purchasing-overview.js
  // use, so "arriving" means the same thing on both pages.
  const OPEN_PO_STATUSES = Object.freeze([
    'Approved', 'Sent to Factory', 'Confirmed', 'In Production',
    'Shipped', 'In Transit', 'Partially Received',
  ]);

  const STALE_DAYS = 90;

  /* --------------------------------------------------------------- numbers */

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /* ------------------------------------------------------------ SQL safety */

  /**
   * A single-quoted SQL literal.
   *
   * The only values that ever reach this are a product type or a location tag
   * the page itself read back out of the database a moment ago, but "it came
   * from us" is not a safety property -- the row came from a Shopify product
   * title somebody else types. So: doubled quotes (standard_conforming_strings
   * is on, so that is the whole escape), no control characters, and a length
   * cap. Anything else throws rather than being silently repaired, because a
   * repaired filter is a query that quietly answers a different question.
   */
  function lit(value) {
    if (typeof value !== 'string') throw new Error('A SQL literal must be a string');
    if (value.length > 200) throw new Error('Filter value too long');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(value)) throw new Error('Filter value has a control character');
    return `'${value.replace(/'/g, "''")}'`;
  }

  /** The WHERE clause shared by the inventory_workboard_v reads. */
  function whereClause(filters, extra) {
    const parts = (extra || []).slice();
    const type = filters && filters.productType;
    const loc = filters && filters.locationTag;
    if (type) parts.push(`coalesce(nullif(product_type, ''), '—') = ${lit(type)}`);
    if (loc) parts.push(`location_tag = ${lit(loc)}`);
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }

  /* ---------------------------------------------------------------- queries */

  /* Five aggregates. None returns more than a few hundred rows, so none of them
   * pages, and each is a GROUP BY the matview's own index can drive. */
  function queries(filters) {
    const f = filters || {};
    const stale = `sum(case when total_available_quantity > 0 and velocity_matched`
      + ` and (last_sold_date is null or last_sold_date < (public.silo_business_today() - ${STALE_DAYS}))`
      + ` then total_available_inventory_value else 0 end) as stale_value`;

    const byLocation = `select coalesce(nullif(location_name, ''), nullif(location, ''), location_tag, '—') as loc,
        coalesce(location_tag, '') as loc_key,
        ${BUCKET_SQL} as bucket,
        max(snapshot_at) as as_of,
        count(*) as row_count,
        sum(total_available_quantity) as units,
        sum(total_available_inventory_value) as value,
        ${stale}
      from public.inventory_workboard_v${whereClause(f)}
      group by 1, 2, 3`;

    const byType = `select coalesce(nullif(product_type, ''), '—') as ptype,
        ${BUCKET_SQL} as bucket,
        count(*) as row_count,
        sum(total_available_quantity) as units,
        sum(total_available_inventory_value) as value,
        ${stale}
      from public.inventory_workboard_v${whereClause(f)}
      group by 1, 2`;

    // SKU counts have to be measured on the SKU, not on the row: the view is
    // one row per SKU per location, so a SKU out of stock in one store and
    // deep in another is ONE sku and it is not out.
    const bySku = `with v as (
        select variant_sku,
          sum(total_available_quantity) as q,
          count(*) filter (where total_available_quantity > 0) as locs
        from public.inventory_workboard_v${whereClause(f, ["coalesce(variant_sku, '') <> ''"])}
        group by 1)
      select case when q < 0 then 'neg' when q = 0 then 'out' when q <= 24 then 'low'
                  when q <= 99 then 'ok' else 'deep' end as bucket,
        count(*) as skus,
        count(*) filter (where locs > 1) as multi_location
      from v group by 1`;

    // Only products that carry an image: these are tiles, and a tile with no
    // picture is a worse row than the table this replaced. It also keeps
    // non-product lines (shipping, fees) out of the biggest-holdings card.
    const holdings = `select product_title,
        max(product_image_url) as img,
        sum(total_available_quantity) as units,
        sum(total_available_inventory_value) as value
      from public.inventory_workboard_v${whereClause(f, ["coalesce(product_image_url, '') <> ''"])}
      group by 1
      having sum(total_available_quantity) > 0
      order by 4 desc
      limit 6`;

    // Lines, not PO headers, so a product-type filter still means something.
    // There is no location on a PO line, so the page hides this card when a
    // location is selected rather than showing a company-wide number under a
    // single store's heading.
    const inboundWhere = [`status in (${OPEN_PO_STATUSES.map(lit).join(', ')})`];
    if (f.productType) inboundWhere.push(`coalesce(nullif(product_type, ''), '—') = ${lit(f.productType)}`);
    const inbound = `select to_char(expected_arrival_date, 'YYYY-MM') as month,
        count(distinct po_header_id) as pos,
        sum(qty) as units,
        sum(estimated_cost) as est_cost
      from public.v_po_incoming_lines
      where ${inboundWhere.join(' and ')}
      group by 1`;

    return { byLocation, byType, bySku, holdings, inbound };
  }

  /* ----------------------------------------------------------------- shapes */

  function emptyBuckets() {
    const out = {};
    for (const key of BUCKET_KEYS) out[key] = { units: 0, value: 0, rowCount: 0, skus: 0 };
    return out;
  }

  /**
   * Group rows that carry a bucket into one total plus a per-bucket breakdown.
   *
   * `value` here is the RETAIL value of the units on hand -- the view has no
   * cost column, so there is no cost basis to report and the page says retail.
   * The headline total counts positive stock only: a negative row is an error,
   * and netting it off would under-report the stock that is really there.
   */
  function rollup(rows, keyOf, labelOf) {
    const groups = new Map();
    const totals = {
      value: 0, units: 0, rowCount: 0, staleValue: 0, negValue: 0, negUnits: 0,
      buckets: emptyBuckets(),
    };
    for (const row of rows || []) {
      const key = keyOf(row);
      if (key === null || key === undefined) continue;
      const bucket = BUCKET_KEYS.includes(row.bucket) ? row.bucket : 'out';
      if (!groups.has(key)) {
        groups.set(key, { key, label: labelOf(row), value: 0, units: 0, rowCount: 0, staleValue: 0, buckets: emptyBuckets() });
      }
      const g = groups.get(key);
      const value = num(row.value);
      const units = num(row.units);
      const rowCount = num(row.row_count);
      g.buckets[bucket].value += value;
      g.buckets[bucket].units += units;
      g.buckets[bucket].rowCount += rowCount;
      g.staleValue += num(row.stale_value);
      g.rowCount += rowCount;
      totals.buckets[bucket].value += value;
      totals.buckets[bucket].units += units;
      totals.buckets[bucket].rowCount += rowCount;
      totals.staleValue += num(row.stale_value);
      totals.rowCount += rowCount;
      if (bucket === 'neg') {
        totals.negValue += value;
        totals.negUnits += units;
      } else {
        g.value += value;
        g.units += units;
        totals.value += value;
        totals.units += units;
      }
    }
    const list = [...groups.values()].sort((a, b) => b.value - a.value);
    return { totals, list };
  }

  /** Locations, biggest holding first, with the count that has any stock. */
  function shapeLocations(rows) {
    const { totals, list } = rollup(rows, (r) => r.loc_key ?? r.loc, (r) => r.loc || '—');
    return {
      totals,
      list,
      withStock: list.filter((l) => l.units > 0).length,
    };
  }

  /** Product types, biggest holding first. */
  function shapeTypes(rows) {
    const { totals, list } = rollup(rows, (r) => r.ptype, (r) => r.ptype || '—');
    return { totals, list };
  }

  /**
   * Top `n` groups by value plus one "Other N" row, for the donut and the bars.
   * The remainder is a real row, not a rounding gap: the parts always add to
   * the total the page prints in the middle of the donut.
   */
  function topWithOther(list, n, otherLabel) {
    const head = (list || []).slice(0, n);
    const tail = (list || []).slice(n);
    if (!tail.length) return head;
    const rest = tail.reduce((acc, g) => acc + g.value, 0);
    const restUnits = tail.reduce((acc, g) => acc + g.units, 0);
    return head.concat([{
      key: '__other__',
      label: typeof otherLabel === 'function' ? otherLabel(tail.length) : `Other ${tail.length}`,
      value: rest,
      units: restUnits,
      other: true,
    }]);
  }

  /** SKU counts per bucket, plus the two totals the KPI band needs. */
  function shapeSkus(rows) {
    const buckets = {};
    for (const key of BUCKET_KEYS) buckets[key] = 0;
    let total = 0;
    let multiLocation = 0;
    for (const row of rows || []) {
      const bucket = BUCKET_KEYS.includes(row.bucket) ? row.bucket : 'out';
      const skus = num(row.skus);
      buckets[bucket] += skus;
      total += skus;
      multiLocation += num(row.multi_location);
    }
    return {
      buckets,
      total,
      multiLocation,
      inStock: buckets.deep + buckets.ok + buckets.low,
      out: buckets.out,
      negative: buckets.neg,
    };
  }

  /** Biggest holdings, already ordered by the query; defensive re-sort. */
  function shapeHoldings(rows) {
    return (rows || [])
      .map((r) => ({
        title: String(r.product_title || '').trim() || '—',
        img: String(r.img || ''),
        units: num(r.units),
        value: num(r.value),
      }))
      .filter((r) => r.img && r.units > 0)
      .sort((a, b) => b.value - a.value);
  }

  /**
   * Arrivals by month.
   *
   * Anything whose expected arrival is before this month is LATE, and late is
   * one bar rather than a run of empty past months -- a PO three months
   * overdue and one three weeks overdue are the same fact to look at. A line
   * with no expected date at all is its own bar, because "we do not know when
   * this lands" is not the same as "it lands later".
   */
  function shapeInbound(rows, todayMonth, monthsAhead) {
    const ahead = Number.isFinite(monthsAhead) ? monthsAhead : 4;
    const bars = [{ key: 'late', label: 'Late', units: 0, pos: 0, estCost: 0, late: true }];
    const months = [];
    let cursor = todayMonth;
    for (let i = 0; i <= ahead; i++) {
      months.push(cursor);
      bars.push({ key: cursor, label: monthLabel(cursor), units: 0, pos: 0, estCost: 0, current: i === 0 });
      cursor = nextMonth(cursor);
    }
    const later = { key: 'later', label: 'Later', units: 0, pos: 0, estCost: 0 };
    const undated = { key: 'none', label: 'No date', units: 0, pos: 0, estCost: 0, undated: true };
    const byKey = new Map(bars.map((b) => [b.key, b]));
    const totals = { units: 0, pos: 0, estCost: 0, lateUnits: 0 };

    for (const row of rows || []) {
      const month = typeof row.month === 'string' && /^\d{4}-\d{2}$/.test(row.month) ? row.month : null;
      const units = num(row.units);
      const pos = num(row.pos);
      const estCost = num(row.est_cost);
      let target;
      if (!month) target = undated;
      else if (month < todayMonth) target = byKey.get('late');
      else if (byKey.has(month)) target = byKey.get(month);
      else target = later;
      target.units += units;
      target.pos += pos;
      target.estCost += estCost;
      totals.units += units;
      totals.pos += pos;
      totals.estCost += estCost;
      if (target.late) totals.lateUnits += units;
    }
    const all = bars.concat([later, undated]).filter((b) => b.units > 0 || b.current);
    return { bars: all, totals };
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthLabel(key) {
    return MONTHS[Number(key.slice(5, 7)) - 1] || key;
  }
  function nextMonth(key) {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  /** The five KPI figures, from the shapes above. */
  function kpis(locations, skus, inbound) {
    const t = (locations && locations.totals) || { value: 0, units: 0, negValue: 0, buckets: emptyBuckets() };
    return {
      value: t.value,
      units: t.units,
      locations: (locations && locations.withStock) || 0,
      skusInStock: (skus && skus.inStock) || 0,
      skusTotal: (skus && skus.total) || 0,
      skusOut: (skus && skus.out) || 0,
      skusNegative: (skus && skus.negative) || 0,
      negativeValue: t.negValue,
      inboundUnits: (inbound && inbound.totals.units) || 0,
      inboundCost: (inbound && inbound.totals.estCost) || 0,
      inboundLate: (inbound && inbound.totals.lateUnits) || 0,
    };
  }

  /** Deep links into the Inventory Manager, so a tile lands on the same rows. */
  function managerHref(opts) {
    const params = new URLSearchParams();
    if (opts && opts.lens) params.set('lens', opts.lens);
    if (opts && opts.productType) params.set('type', opts.productType);
    if (opts && opts.locationTag) params.set('loc', opts.locationTag);
    const qs = params.toString();
    return qs ? `/v2/inventory.html?${qs}` : '/v2/inventory.html';
  }

  /* A bucket's drill-in. `deep` and `ok` have no lens of their own on the
   * Inventory Manager, so they land on the unfiltered page rather than on a
   * lens that would show different rows than the segment claimed. */
  const BUCKET_LENS = Object.freeze({
    low: 'onhand10', out: 'oos', neg: 'negative', deep: null, ok: null,
  });

  /* ------------------------------------------------------------- the read */

  const result = async (promise) => {
    const r = await promise;
    if (r && r.error) throw r.error;
    return r;
  };

  /* Each aggregate is its own call to the shared report engine. They run in
   * parallel; a failed one is reported by name and leaves its card out rather
   * than taking the page down, because four cards and a named gap is more
   * useful than an error screen. */
  async function runQuery(db, sql) {
    const r = await result(db.rpc('chat_run_readonly_query', { query: sql, p_offset: 0 }));
    if (!Array.isArray(r.data)) throw new Error('Unexpected response');
    // Every query here is an aggregate well inside the engine's 1000-row page.
    // A full page means it was truncated, and a truncated total is a wrong
    // total, so say so rather than print it.
    if (r.data.length >= 1000) throw new Error('Too many rows to total');
    return r.data;
  }

  function currentMonth(today) {
    if (typeof today === 'string' && /^\d{4}-\d{2}/.test(today)) return today.slice(0, 7);
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  async function load({ db, config = window.__SILO_CONFIG__, filters = {} }) {
    // Resolve on every refresh. Never trust a company id from sessionStorage.
    const company = await config?.ensureActiveCompany?.(db);
    if (!company || !company.id) throw new Error('Select a company first');
    if (company._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');

    let today = null;
    try { today = (await result(db.rpc('silo_business_today'))).data; } catch (_) { today = null; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) today = null;

    const sql = queries(filters);
    const errors = [];
    const raw = {};
    await Promise.all(Object.entries(sql).map(async ([key, text]) => {
      try { raw[key] = await runQuery(db, text); } catch (error) {
        raw[key] = undefined;
        errors.push({ source: key, message: error.message || String(error) });
      }
    }));

    let currency = null;
    try {
      const r = await result(db.from('company_settings').select('default_currency')
        .eq('company_entity_id', company.id).maybeSingle());
      const code = r.data && r.data.default_currency;
      if (/^[A-Z]{3}$/.test(code || '')) currency = code;
    } catch (_) { currency = null; }

    // Another tab can switch the active company while these run. Never render
    // a mixed snapshot as if it belonged to this company.
    const current = await config.ensureActiveCompany(db);
    if (current && current._staleReconcile) throw new Error('Company could not be reconciled. Refresh to retry.');
    if (!current || current.id !== company.id) throw new Error('Company changed while loading. Refresh to retry.');

    if (raw.byLocation === undefined) {
      const why = errors.find((e) => e.source === 'byLocation');
      throw new Error((why && why.message) || 'Could not read inventory');
    }

    const locations = shapeLocations(raw.byLocation);
    const types = raw.byType ? shapeTypes(raw.byType) : null;
    const skus = raw.bySku ? shapeSkus(raw.bySku) : null;
    const holdings = raw.holdings ? shapeHoldings(raw.holdings) : null;
    // Inbound carries no location, so a location filter would put a
    // company-wide number under one store's heading. Leave the card out.
    const inbound = (raw.inbound && !filters.locationTag)
      ? shapeInbound(raw.inbound, currentMonth(today)) : null;

    let asOf = null;
    for (const row of raw.byLocation) {
      if (row.as_of && (!asOf || row.as_of > asOf)) asOf = row.as_of;
    }

    return {
      company, today, currency, asOf, filters, errors,
      locations, types, skus, holdings, inbound,
      kpis: kpis(locations, skus, inbound),
    };
  }

  async function boot({ active, crumbs, onModel, onError, filters = {},
    config = window.__SILO_CONFIG__, db: providedDb } = {}) {
    let reported = false;
    try {
      if (!providedDb && (!config || !config.SUPABASE_URL || !config.SUPABASE_ANON_KEY)) {
        throw new Error('Missing Supabase config');
      }
      const db = providedDb || window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
      const session = await result(db.auth.getSession());
      if (!session.data || !session.data.session) {
        window.location.href = '/pages/login.html?next='
          + encodeURIComponent(window.location.pathname + window.location.search);
        return null;
      }
      let generation = 0;
      let selected = Object.assign({}, filters);
      const controller = {
        db,
        company: null,
        get filters() { return Object.assign({}, selected); },
        async refresh(next) {
          const token = ++generation;
          if (next !== undefined) selected = Object.assign({}, next);
          try {
            const model = await load({ db, config, filters: selected });
            if (token !== generation) return null;
            controller.company = model.company;
            if (onModel) onModel(model);
            return model;
          } catch (error) {
            if (token === generation) { reported = true; if (onError) onError(error); }
            throw error;
          }
        },
      };
      if (window.SiloChrome && window.SiloChrome.mount) {
        window.SiloChrome.mount({
          appEl: '#silo-app', active, user: { email: session.data.session.user.email },
          crumbs, supabaseClient: db,
        });
      }
      await controller.refresh();
      return controller;
    } catch (error) {
      if (!reported && onError) onError(error);
      throw error;
    }
  }

  return {
    BUCKETS,
    BUCKET_KEYS,
    BUCKET_LENS,
    OPEN_PO_STATUSES,
    STALE_DAYS,
    bucketOf,
    lit,
    whereClause,
    queries,
    shapeLocations,
    shapeTypes,
    shapeSkus,
    shapeHoldings,
    shapeInbound,
    topWithOther,
    kpis,
    managerHref,
    monthLabel,
    nextMonth,
    currentMonth,
    load,
    boot,
  };
}));
