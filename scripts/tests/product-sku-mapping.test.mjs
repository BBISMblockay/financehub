/* buildProductSkuRows: the properties products_master cannot hold.
 *
 * Each assertion here corresponds to something the per-SKU table discards.
 * The measured reason this matters (2026-09-09): 4,147 of 15,398 sold SKUs
 * (26.9%) appear in more than one shop, and 43% of the rows currently
 * carrying a shopify_product_id are SKUs another shop also sells -- so that
 * single column is decided by nightly sync order for a large minority of the
 * catalogue.
 *
 * No network, no database, no install. Run:
 *   node scripts/tests/product-sku-mapping.test.mjs
 */
import { buildProductSkuRows } from '../lib/shopify-sync-core.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

const CTX = { companyEntityId: 'company-1', shopDomain: 'test.myshopify.com', now: '2026-09-09T00:00:00Z' };

const productMap = (...products) => new Map(products.map((p) => [String(p.id), p]));

const PRODUCTS = productMap(
  { id: 100, handle: 'doubles-tee', title: 'Doubles Tee', status: 'active', published_at: '2026-01-01T00:00:00Z' },
  { id: 200, handle: 'doubles-tee-wholesale', title: '  Doubles Tee (WS)  ', status: 'archived', published_at: null },
);

console.log('\n-- the collapse products_master performs, undone --');

// runCatalogSync does `if (!v?.sku || rowBySku.has(v.sku)) continue`, so the
// SECOND product carrying this SKU never reaches products_master at all.
await test('one SKU on two products in the same shop yields TWO rows', () => {
  const rows = buildProductSkuRows([
    { id: 1, product_id: 100, sku: 'BB-TEE-M', title: 'M' },
    { id: 2, product_id: 200, sku: 'BB-TEE-M', title: 'M' },
  ], PRODUCTS, CTX);
  eq(rows.length, 2, 'row count');
  eq(new Set(rows.map((r) => r.shopify_product_id)).size, 2, 'distinct product ids kept');
  eq(new Set(rows.map((r) => r.shopify_variant_id)).size, 2, 'distinct variant ids');
});

await test('identity is the variant, so sku is free to repeat', () => {
  const rows = buildProductSkuRows([
    { id: 1, product_id: 100, sku: 'DUP', title: 'M' },
    { id: 2, product_id: 100, sku: 'DUP', title: 'L' },
  ], PRODUCTS, CTX);
  eq(rows.length, 2, 'both variants kept');
  eq(rows[0].variant_title, 'M', 'variant title carries the size');
  eq(rows[1].variant_title, 'L', 'variant title carries the size');
});

console.log('\n-- what must NOT be dropped --');

await test('a variant with no SKU is still mapped, with sku null', () => {
  const rows = buildProductSkuRows([{ id: 3, product_id: 100, sku: '', title: 'Default Title' }], PRODUCTS, CTX);
  eq(rows.length, 1, 'kept');
  eq(rows[0].sku, null, 'empty string must become null, never stay ""');
  eq(rows[0].variant_title, null, "Shopify's 'Default Title' is not a real variant name");
});

// The catalog sync fetches products for a fixed set of statuses. A variant
// whose product was not among them still knows its own product_id, and that
// id is the join key -- dropping the row would make the collection look
// smaller than it is.
await test('a variant whose product was not fetched keeps its product id', () => {
  const rows = buildProductSkuRows([{ id: 4, product_id: 999, sku: 'ORPHAN', title: 'M' }], PRODUCTS, CTX);
  eq(rows.length, 1, 'kept');
  eq(rows[0].shopify_product_id, '999', 'product id preserved');
  eq(rows[0].product_handle, null, 'handle genuinely unknown');
  eq(rows[0].product_title, null, 'title genuinely unknown, not a fabricated fallback');
});

await test('rows without an identity are the only ones dropped', () => {
  const rows = buildProductSkuRows([
    { id: null, product_id: 100, sku: 'A' },
    { product_id: 100, sku: 'B' },
    { id: 5, product_id: null, sku: 'C' },
    { id: 6, product_id: 100, sku: 'D' },
  ], PRODUCTS, CTX);
  eq(rows.length, 1, 'only the fully-identified variant survives');
  eq(rows[0].sku, 'D', 'the right one');
});

console.log('\n-- per-shop facts stay per-shop --');

await test('status and published_at come from THIS shop, not the company', () => {
  const rows = buildProductSkuRows([
    { id: 1, product_id: 100, sku: 'X', title: 'M' },
    { id: 2, product_id: 200, sku: 'X', title: 'M' },
  ], PRODUCTS, CTX);
  eq(rows[0].shopify_status, 'active', 'main store active');
  eq(rows[1].shopify_status, 'archived', 'wholesale archived — same SKU, different answer');
  eq(rows[0].online_published_at, '2026-01-01T00:00:00Z', 'published in the main store');
  eq(rows[1].online_published_at, null, 'not published in wholesale');
});

await test('every row carries the company and shop it was read from', () => {
  const rows = buildProductSkuRows([{ id: 1, product_id: 100, sku: 'X' }], PRODUCTS, CTX);
  eq(rows[0].company_entity_id, 'company-1', 'company stamped');
  eq(rows[0].shop_domain, 'test.myshopify.com', 'shop stamped');
  eq(rows[0].last_seen_at, CTX.now, 'last_seen_at stamped');
  ok(!('first_seen_at' in rows[0]),
    'first_seen_at must NOT be in the payload — an upsert would restamp it nightly and it would stop meaning "first seen"');
});

await test('ids are stringified, matching the membership tables dialect', () => {
  const rows = buildProductSkuRows([{ id: 7, product_id: 100, sku: 'X' }], PRODUCTS, CTX);
  eq(rows[0].shopify_product_id, '100', 'product id is text');
  eq(rows[0].shopify_variant_id, '7', 'variant id is text');
});

await test('titles are trimmed but never invented', () => {
  const rows = buildProductSkuRows([{ id: 1, product_id: 200, sku: 'X' }], PRODUCTS, CTX);
  eq(rows[0].product_title, 'Doubles Tee (WS)', 'trimmed');
});

await test('an empty or missing variant list is not an error', () => {
  eq(buildProductSkuRows([], PRODUCTS, CTX).length, 0, 'empty');
  eq(buildProductSkuRows(undefined, PRODUCTS, CTX).length, 0, 'undefined');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
