/* The Inventory Overview's model: v2/inventory-overview.js.
 *
 * Everything the page prints is derived here, so this is where the claims are
 * tested: which bucket a quantity is in, how a negative row is kept out of the
 * inventory value, what the SQL is allowed to interpolate, and what "late"
 * means on the arrivals chart.
 *
 * Mutation-tested: set INVENTORY_OVERVIEW_MUTATION to a key below and the
 * suite must go RED. The workflow runs every one of them.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
let source = await readFile(new URL('v2/inventory-overview.js', root), 'utf8');

/* Each mutation breaks exactly one claim this suite makes. */
const MUTATIONS = {
  // A negative row folded back into the inventory value.
  neg_into_value: ["      if (bucket === 'neg') {", '      if (false) {'],
  // The boundary between low and healthy moved.
  low_boundary: ["if (n <= 24) return 'low';", "if (n <= 23) return 'low';"],
  // A quote in a filter value passed through unescaped.
  lit_escape: ['value.replace(/\'/g, "\'\'")', 'value'],
  // Last month treated as still to come.
  late_month: ['else if (month < todayMonth)', 'else if (false)'],
  // The remainder slice dropped, so the donut no longer adds up.
  other_slice: ['if (!tail.length) return head;', 'return head;'],
  // SKUs counted per row instead of per SKU.
  sku_total: ['total += skus;', 'total += 0;'],
};
const mutation = process.env.INVENTORY_OVERVIEW_MUTATION;
if (mutation) {
  const pair = MUTATIONS[mutation];
  if (!pair) throw new Error(`Unknown mutation ${mutation}`);
  if (!source.includes(pair[0])) throw new Error(`Mutation ${mutation} no longer applies`);
  source = source.replace(pair[0], pair[1]);
}

const context = { module: { exports: {} }, URLSearchParams };
context.globalThis = context;
vm.runInNewContext(source, context);
const M = context.module.exports;

/* ------------------------------------------------------------- buckets */

test('a quantity lands in the bucket its label promises', () => {
  assert.equal(M.bucketOf(-3), 'neg');
  assert.equal(M.bucketOf(0), 'out');
  assert.equal(M.bucketOf(1), 'low');
  assert.equal(M.bucketOf(24), 'low');
  assert.equal(M.bucketOf(25), 'ok');
  assert.equal(M.bucketOf(99), 'ok');
  assert.equal(M.bucketOf(100), 'deep');
  // Not a number is not silently healthy.
  assert.equal(M.bucketOf(null), 'out');
  assert.equal(M.bucketOf('x'), 'out');
});

test('the SQL CASE and bucketOf agree on every boundary', () => {
  const sql = M.queries({}).byLocation;
  assert.match(sql, /<= 24 then 'low'/);
  assert.match(sql, /<= 99 then 'ok'/);
  assert.equal(M.bucketOf(24), 'low');
  assert.equal(M.bucketOf(25), 'ok');
  assert.equal(M.bucketOf(99), 'ok');
  assert.equal(M.bucketOf(100), 'deep');
});

/* --------------------------------------------------------------- totals */

const LOCATION_ROWS = [
  { loc: 'Online', loc_key: 'online', bucket: 'deep', row_count: 2, units: 500, value: 10000, stale_value: 1000 },
  { loc: 'Online', loc_key: 'online', bucket: 'low', row_count: 5, units: 20, value: 800, stale_value: 100 },
  { loc: 'Online', loc_key: 'online', bucket: 'out', row_count: 40, units: 0, value: 0, stale_value: 0 },
  { loc: 'Online', loc_key: 'online', bucket: 'neg', row_count: 3, units: -30, value: -900, stale_value: 0 },
  { loc: 'Store', loc_key: 'store', bucket: 'ok', row_count: 4, units: 200, value: 4000, stale_value: 0 },
];

test('negative stock is reported on its own and never nets off the value', () => {
  const shaped = M.shapeLocations(LOCATION_ROWS);
  assert.equal(shaped.totals.value, 14800, 'value is the positive stock only');
  assert.equal(shaped.totals.units, 720);
  assert.equal(shaped.totals.negValue, -900);
  assert.equal(shaped.totals.negUnits, -30);
  // And the negative row is still counted in its bucket, so the key can say
  // how big the problem is.
  assert.equal(shaped.totals.buckets.neg.rowCount, 3);
  assert.equal(shaped.totals.buckets.neg.value, -900);
});

test('locations are ranked by value and only those holding stock are counted', () => {
  const shaped = M.shapeLocations(LOCATION_ROWS);
  assert.deepEqual([...shaped.list.map((l) => l.key)], ['online', 'store']);
  assert.equal(shaped.list[0].value, 10800);
  assert.equal(shaped.withStock, 2);
  assert.equal(M.shapeLocations([LOCATION_ROWS[2], LOCATION_ROWS[3]]).withStock, 0,
    'a location with only out-of-stock and negative rows holds nothing');
});

test('an unknown bucket is treated as out of stock, not as healthy', () => {
  const shaped = M.shapeLocations([
    { loc: 'X', loc_key: 'x', bucket: 'wat', row_count: 1, units: 9, value: 99, stale_value: 0 },
  ]);
  assert.equal(shaped.totals.buckets.out.rowCount, 1);
  assert.equal(shaped.totals.buckets.deep.rowCount, 0);
});

test('the stale figure is summed from the database, never recomputed here', () => {
  assert.equal(M.shapeLocations(LOCATION_ROWS).totals.staleValue, 1100);
  // It is a FILTERED sum in SQL, gated on velocity_matched: an unmatched row
  // means "we do not know whether it sold", which must never read as stale.
  assert.match(M.queries({}).byLocation, /and velocity_matched/);
});

/* ----------------------------------------------------------------- SKUs */

test('SKU counts are measured per SKU, and in-stock excludes out and negative', () => {
  const skus = M.shapeSkus([
    { bucket: 'deep', skus: 10, multi_location: 4 },
    { bucket: 'ok', skus: 20, multi_location: 6 },
    { bucket: 'low', skus: 30, multi_location: 2 },
    { bucket: 'out', skus: 100, multi_location: 0 },
    { bucket: 'neg', skus: 5, multi_location: 1 },
  ]);
  assert.equal(skus.total, 165);
  assert.equal(skus.inStock, 60);
  assert.equal(skus.out, 100);
  assert.equal(skus.negative, 5);
  assert.equal(skus.multiLocation, 13);
});

test('the SKU query groups by SKU before it buckets', () => {
  const sql = M.queries({}).bySku;
  assert.match(sql, /group by 1\)/, 'the inner query rolls locations up to the SKU');
  assert.match(sql, /sum\(total_available_quantity\) as q/);
  assert.match(sql, /coalesce\(variant_sku, ''\) <> ''/, 'rows without a SKU are not counted as one');
});

/* ------------------------------------------------------------ SQL safety */

test('a filter value is escaped, and anything unusual throws instead', () => {
  assert.equal(M.lit("Women's"), "'Women''s'");
  assert.throws(() => M.lit("x'; drop table t --".padEnd(300, 'x')), /too long/);
  assert.throws(() => M.lit('a\nb'), /control character/);
  assert.throws(() => M.lit(5), /must be a string/);
  // The dangerous case, end to end: a quote in a product type cannot close
  // the literal and start new SQL.
  const sql = M.queries({ productType: "Kids' Tees' or true--" }).byType;
  assert.ok(sql.includes("'Kids'' Tees'' or true--'"), 'the quote is doubled, not closed');
});

test('a filter reaches every query that can honour it, and only those', () => {
  const sql = M.queries({ productType: 'Cap', locationTag: 'online' });
  assert.match(sql.byLocation, /product_type[^\n]*= 'Cap'/);
  assert.match(sql.byLocation, /location_tag = 'online'/);
  assert.match(sql.byType, /location_tag = 'online'/);
  assert.match(sql.holdings, /location_tag = 'online'/);
  // A PO line has a product type but no location, so the location filter must
  // not appear there -- it would silently drop every row.
  assert.match(sql.inbound, /product_type[^\n]*= 'Cap'/);
  assert.ok(!sql.inbound.includes('location_tag'), 'inbound carries no location');
});

test('no query asks for more than the report engine will return', () => {
  const sql = M.queries({});
  assert.match(sql.holdings, /limit 6/);
  for (const text of Object.values(sql)) {
    assert.ok(!text.includes(';'), 'the engine refuses a semicolon');
    assert.match(text.trim(), /^(select|with)\s/i);
  }
});

/* ------------------------------------------------------------- holdings */

test('a holding without a usable image or stock is not offered as a tile', () => {
  const tiles = M.shapeHoldings([
    { product_title: 'A', img: 'https://x/a.jpg', units: 10, value: 100 },
    { product_title: 'B', img: '', units: 99, value: 9999 },
    { product_title: 'C', img: 'https://x/c.jpg', units: 0, value: 0 },
    { product_title: 'D', img: 'https://x/d.jpg', units: 5, value: 500 },
  ]);
  assert.deepEqual([...tiles.map((t) => t.title)], ['D', 'A']);
});

/* ------------------------------------------------------------- arrivals */

test('anything overdue is one Late bar, and an undated line is its own', () => {
  const shaped = M.shapeInbound([
    { month: '2026-07', pos: 2, units: 100, est_cost: 10 },
    { month: '2026-09', pos: 1, units: 50, est_cost: 5 },
    { month: '2026-11', pos: 3, units: 200, est_cost: 20 },
    { month: '2026-12', pos: 1, units: 80, est_cost: 8 },
    { month: null, pos: 1, units: 7, est_cost: 1 },
  ], '2026-11');
  const byKey = Object.fromEntries(shaped.bars.map((b) => [b.key, b]));
  assert.equal(byKey.late.units, 150, 'July and September are both just Late');
  assert.equal(byKey['2026-11'].units, 200);
  assert.equal(byKey['2026-11'].current, true);
  assert.equal(byKey['2026-12'].units, 80);
  assert.equal(byKey.none.units, 7, 'no expected date is not the same as later');
  assert.equal(shaped.totals.units, 437);
  assert.equal(shaped.totals.lateUnits, 150);
});

test('an arrival past the drawn months falls into Later, not off the chart', () => {
  const shaped = M.shapeInbound([{ month: '2030-01', pos: 1, units: 42, est_cost: 4 }], '2026-11');
  const later = shaped.bars.find((b) => b.key === 'later');
  assert.equal(later.units, 42);
  assert.equal(shaped.totals.units, 42);
});

test('an empty month is not drawn, but this month always is', () => {
  const shaped = M.shapeInbound([], '2026-11');
  assert.deepEqual([...shaped.bars.map((b) => b.key)], ['2026-11']);
  assert.equal(shaped.totals.units, 0);
});

/* --------------------------------------------------------------- slices */

test('the top slices plus Other always add back to the whole', () => {
  const list = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, value: 100 - i, units: 1 }));
  const sliced = M.topWithOther(list, 7);
  assert.equal(sliced.length, 8);
  assert.equal(sliced[7].label, 'Other 4');
  assert.equal(sliced.reduce((a, s) => a + s.value, 0), list.reduce((a, s) => a + s.value, 0));
  // Nothing to roll up means no Other row at all.
  assert.equal(M.topWithOther(list.slice(0, 3), 7).length, 3);
});

/* ----------------------------------------------------------- deep links */

test('a tile links into the Inventory Manager carrying what it showed', () => {
  assert.equal(M.managerHref({ lens: 'oos' }), '/v2/inventory.html?lens=oos');
  assert.equal(M.managerHref({ locationTag: 'field_of_dreams' }),
    '/v2/inventory.html?loc=field_of_dreams');
  assert.equal(M.managerHref({}), '/v2/inventory.html');
  assert.equal(M.managerHref({ productType: 'T-Shirts & Tops' }),
    '/v2/inventory.html?type=T-Shirts+%26+Tops');
  // The two healthy bands have no lens of their own on that page, so they
  // must land unfiltered rather than on a lens showing other rows.
  assert.equal(M.BUCKET_LENS.deep, null);
  assert.equal(M.BUCKET_LENS.ok, null);
  assert.equal(M.BUCKET_LENS.out, 'oos');
  assert.equal(M.BUCKET_LENS.neg, 'negative');
});

/* --------------------------------------------------------------- months */

test('months roll over a year end', () => {
  assert.equal(M.nextMonth('2026-11'), '2026-12');
  assert.equal(M.nextMonth('2026-12'), '2027-01');
  assert.equal(M.monthLabel('2026-01'), 'Jan');
  assert.equal(M.currentMonth('2026-11-16'), '2026-11');
});

/* ----------------------------------------------------------------- KPIs */

test('the KPI band reads from the shapes, with nothing invented', () => {
  const locations = M.shapeLocations(LOCATION_ROWS);
  const skus = M.shapeSkus([
    { bucket: 'deep', skus: 3, multi_location: 1 },
    { bucket: 'out', skus: 9, multi_location: 0 },
  ]);
  const inbound = M.shapeInbound([{ month: '2026-10', pos: 1, units: 60, est_cost: 600 }], '2026-11');
  const k = M.kpis(locations, skus, inbound);
  assert.equal(k.value, 14800);
  assert.equal(k.skusInStock, 3);
  assert.equal(k.skusTotal, 12);
  assert.equal(k.inboundUnits, 60);
  assert.equal(k.inboundLate, 60);
  // A card that could not be read leaves its figures absent rather than zero
  // dressed up as an answer.
  const none = M.kpis(locations, null, null);
  assert.equal(none.skusTotal, 0);
  assert.equal(none.inboundUnits, 0);
});

/* ------------------------------------------------------------ the page */

const page = await readFile(new URL('v2/inventory-overview.html', root), 'utf8');
const nav = await readFile(new URL('v2/nav-config.js', root), 'utf8');

// Pattern 1 (root CLAUDE.md): the asset order is not cosmetic. nav-config.js
// must load BEFORE silo-chrome.js or no sidebar renders at all.
test('the page follows the Pattern 1 asset order', () => {
  const at = (needle) => {
    const i = page.indexOf(needle);
    assert.ok(i !== -1, `missing from the page: ${needle}`);
    return i;
  };
  const order = [
    'href="beacon.css"',
    'href="silo-brand.css"',
    'href="beacon-mirrors-unified.css"',
    'href="v2-mobile.css"',
    'src="v2-shell.js"',
    'src="nav-config.js"',
    'src="silo-chrome.js"',
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'assets are out of Pattern 1 order');
});

test('the page states errors in the status strip, never in an alert', () => {
  assert.match(page, /<div class="bcn-status" id="status" hidden><\/div>/);
  assert.ok(!/\balert\(/.test(page));
  // It reads. Nothing on this page writes, and nothing calls an edge function.
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(|functions\.invoke/.test(page));
});

test('the Overview is the Inventory suite row, with the workbench as its tab', () => {
  const win = {};
  new Function('window', nav)(win);
  const suite = win.SiloNav.SUITES.find((s) => s.key === 'inventory');
  assert.equal(suite.row, 'inventory/overview');
  assert.deepEqual([...suite.pages.map((p) => p[2])], [
    '/v2/inventory-overview.html', '/v2/inventory.html',
    '/v2/products.html', '/v3/product-workflow.html',
  ]);
  const item = (id) => win.SiloNav.NAV_ITEMS.find((i) => i.id === id);
  assert.equal(item('inventory/overview').href, '/v2/inventory-overview.html');
  assert.equal(item('inventory/overview').tabOf, undefined, 'the row is not a tab of anything');
  assert.equal(item('inventory/workboard').tabOf, 'inventory/overview');
  assert.equal(item('inventory/workboard').label, 'Inventory Manager');
  // Both profiles keep the suite: this moved no gate.
  for (const profile of ['grandfathered', 'standard']) {
    assert.ok(item('inventory/overview').profiles.includes(profile), profile);
  }
});
