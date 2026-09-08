/* Real rows from inventory_workboard_v, captured 2026-09-07 against
 * Baseballism (company 3bd934c9-4cdd-429b-9076-f8f6b45d4eb7) while
 * reproducing the three reported bugs.
 *
 * These are NOT invented. Each one is the exact shape the view returns, so a
 * suite that passes here is asserting against what production actually
 * serves -- including the `days_oos: null` that started all of this.
 *
 * `viewRow` mirrors the raw view row; `mapped` is what v2/inventory.html's
 * mapInventoryViewRow() produces from it. Suites use `mapped` because that is
 * the shape every signal and filter function sees. */
'use strict';

/** Turn a raw view row into the client row shape, the way the page does. */
function mapped(v) {
  const n = (x) => (x === null || x === undefined || x === '' ? 0 : Number(x));
  const avg30 = n(v.avg_day_30);
  const avg7 = n(v.avg_day_7);
  const daysOosRaw = v.days_oos === null || v.days_oos === undefined ? null : Number(v.days_oos);
  return {
    _id: v.variant_sku + '::' + v.location_tag,
    level: 'location',
    source_id: v.location_tag,
    location: v.location_tag,
    sku: v.variant_sku,
    barcode: '',
    variant: v.variant_title,
    product: v.product_title,
    product_type: v.product_type || 'Uncategorized',
    tag: '', sub_tag: '', indicator_group: '', collection: '',
    avail_qty: n(v.total_available_quantity),
    inv_value: n(v.total_available_inventory_value),
    qty_7d: n(v.qty_7d),
    sold_30: n(v.sold_30),
    qty_90d: n(v.qty_90d),
    qty_120d: n(v.qty_120d),
    qty_365d: n(v.qty_365d),
    avg_day_7: avg7,
    avg_day: avg30,
    avg_day_90: n(v.avg_day_90),
    avg_day_365: n(v.avg_day_365),
    days_cover: daysOosRaw !== null
      ? daysOosRaw
      : (avg30 > 0 ? n(v.total_available_quantity) / avg30
        : (avg7 > 0 ? n(v.total_available_quantity) / avg7 : null)),
    velocity_basis: v.velocity_basis,
    velocity_matched: v.velocity_matched !== false,
    velocity_source: v.velocity_source,
    demand_known_count: v.velocity_matched === false ? 0 : 1,
    demand_rows_count: 1,
    last_sold_date: v.last_sold_date || '',
    last_sold_ms: v.last_sold_date ? Date.parse(v.last_sold_date) : null,
    children: []
  };
}

/* BUG 2. 1,002 units, no recorded sale, days_oos NULL, velocity_matched
 * FALSE. The page's num() turned that null into 0 and the "cover <= 7 days"
 * lens then matched it. */
const PIN = {
  product_title: 'Sonic The Hedgehog x Baseballism Collectible Pin',
  variant_title: 'Sonic Pin',
  variant_sku: 'SC-OESonic(Sept26)-Pin',
  location_tag: 'online',
  product_type: 'Pin',
  total_available_quantity: 1002,
  total_available_inventory_value: 12024,
  qty_7d: 0, sold_30: 0, qty_90d: 0, qty_120d: 0, qty_365d: 0,
  avg_day_7: 0, avg_day_30: 0, avg_day_90: 0, avg_day_365: 0,
  days_oos: null,
  velocity_basis: 'none',
  velocity_matched: false,
  velocity_source: 'none',
  last_sold_date: null
};

/* BUG 3. Two zero-stock sizes of the Sonic Team Sonic Youth T-Shirt, both
 * selling hundreds a month. days_oos is a REAL 0 here (0 units / 15 per day),
 * not a null -- the old cell rendered `d ? ... : "—"` so a genuine zero
 * printed the same blank as an unknown, and the allocation table's only
 * verdict for them was "OK" because no transfer rule fired. */
const TEE_YM = {
  product_title: 'Sonic The Hedgehog Team Sonic Youth T-Shirt',
  variant_title: 'YM',
  variant_sku: 'SC-YM-SonicSquad-Y',
  location_tag: 'online',
  product_type: 'T-Shirt',
  total_available_quantity: 0,
  total_available_inventory_value: 0,
  qty_7d: 105, sold_30: 450, qty_90d: 900, qty_120d: 900, qty_365d: 900,
  avg_day_7: 15, avg_day_30: 15, avg_day_90: 10, avg_day_365: 2.47,
  days_oos: 0,
  velocity_basis: '30d',
  velocity_matched: true,
  velocity_source: 'title',
  last_sold_date: '2026-09-02'
};

const TEE_YS = Object.assign({}, TEE_YM, {
  variant_title: 'YS',
  variant_sku: 'SC-YS-SonicSquad-Y',
  sold_30: 367,
  avg_day_30: 12.2333,
  avg_day_7: 12,
  last_sold_date: '2026-09-01'
});

/* A healthy size of the same tee: 69 units, 277/30d, 7.5 days of cover. */
const TEE_YL = Object.assign({}, TEE_YM, {
  variant_title: 'YL',
  variant_sku: 'SC-YL-SonicSquad-Y',
  total_available_quantity: 69,
  total_available_inventory_value: 1863,
  sold_30: 277,
  avg_day_30: 9.2333,
  avg_day_7: 9,
  days_oos: 7.5,
  last_sold_date: '2026-09-07'
});

/* Overstocked: 49 on hand against 0.5/day is 98 days of cover. */
const SWEATS_M = {
  product_title: 'Sonic The Hedgehog Relaxed Fit Comfort Sweatpants',
  variant_title: 'M',
  variant_sku: 'SC-M-SweatsBlue(Sonic)-Mens',
  location_tag: 'online',
  product_type: 'Sweatpants',
  total_available_quantity: 49,
  total_available_inventory_value: 3430,
  qty_7d: 3, sold_30: 15, qty_90d: 60, qty_120d: 80, qty_365d: 200,
  avg_day_7: 0.43, avg_day_30: 0.5, avg_day_90: 0.67, avg_day_365: 0.55,
  days_oos: 98,
  velocity_basis: '30d',
  velocity_matched: true,
  velocity_source: 'title',
  last_sold_date: '2026-09-04'
};

/* Negative inventory, and it is real: -1 units with 327 sold in 30 days. */
const STOLEN_YS = {
  product_title: 'Sonic The Hedgehog Stolen Bases Youth T-Shirt',
  variant_title: 'YS',
  variant_sku: 'SC-YS-StolenBases(Sonic)-Y',
  location_tag: 'online',
  product_type: 'T-Shirt',
  total_available_quantity: -1,
  total_available_inventory_value: -27,
  qty_7d: 76, sold_30: 327, qty_90d: 654, qty_120d: 654, qty_365d: 654,
  avg_day_7: 10.9, avg_day_30: 10.9, avg_day_90: 7.3, avg_day_365: 1.8,
  days_oos: -0.1,
  velocity_basis: '30d',
  velocity_matched: true,
  velocity_source: 'title',
  last_sold_date: '2026-09-02'
};

/* Demand history matched, and it genuinely shows nothing sold in 365 days.
 * This is the case that must NOT be confused with the pin above: here zero
 * really is zero, there it is "we have no idea". */
const DEAD_STOCK = {
  product_title: 'Retired Logo Tee',
  variant_title: 'L',
  variant_sku: 'RET-L-Logo',
  location_tag: 'warehouse',
  product_type: 'T-Shirt',
  total_available_quantity: 240,
  total_available_inventory_value: 6000,
  qty_7d: 0, sold_30: 0, qty_90d: 0, qty_120d: 0, qty_365d: 0,
  avg_day_7: 0, avg_day_30: 0, avg_day_90: 0, avg_day_365: 0,
  days_oos: null,
  velocity_basis: 'none',
  velocity_matched: true,
  velocity_source: 'title',
  last_sold_date: null
};

/* Sold within the year but nothing recently: stale, not dead, not unknown. */
const STALE_STOCK = Object.assign({}, DEAD_STOCK, {
  product_title: 'Last Season Cap',
  variant_sku: 'LS-OS-Cap',
  qty_90d: 4, qty_120d: 9, qty_365d: 140,
  avg_day_90: 0.04, avg_day_365: 0.38,
  last_sold_date: '2026-05-01'
});

module.exports = {
  mapped,
  raw: { PIN, TEE_YM, TEE_YS, TEE_YL, SWEATS_M, STOLEN_YS, DEAD_STOCK, STALE_STOCK },
  rows: {
    PIN: mapped(PIN),
    TEE_YM: mapped(TEE_YM),
    TEE_YS: mapped(TEE_YS),
    TEE_YL: mapped(TEE_YL),
    SWEATS_M: mapped(SWEATS_M),
    STOLEN_YS: mapped(STOLEN_YS),
    DEAD_STOCK: mapped(DEAD_STOCK),
    STALE_STOCK: mapped(STALE_STOCK)
  },
  /** All eight, as an array — the "product list" a filter runs over. */
  all() {
    return [PIN, TEE_YM, TEE_YS, TEE_YL, SWEATS_M, STOLEN_YS, DEAD_STOCK, STALE_STOCK].map(mapped);
  }
};
