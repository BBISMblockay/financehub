// Sales at an unmapped Shopify location, on a connection with no typed
// default, are labelled with the store's own name instead of being skipped.
// Precedence: mapped location > typed default_location_code > store name.
//
// INVENTORY follows the same precedence (added 2026-10-12). It used to skip an
// unmapped location outright, so a store nobody had mapped produced a snapshot
// of ZERO rows that still reported success. The integrated test at the bottom
// drives the real runInventorySnapshot over a stubbed Shopify, because the
// precedence being right in resolveLocation says nothing about the snapshot
// loop actually writing the rows.
import {
  resolveSalesRowLocation,
  storeNameLocation,
  runShopDomainsSync,
  resolveLocation,
  isLocationMapped,
  runInventorySnapshot,
} from '../lib/shopify-sync-core.mjs';
import * as edge from '../../supabase/functions/shopify-sync-run/lib/shopify-sync-core.mjs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

let failures = 0;
let count = 0;
async function test(name, fn) {
  count++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function deepEq(actual, expected, what) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

const conn = { id: 'c1', shop_domain: 'i09sb0-6m.myshopify.com', shop_name: 'Bat Nutz ' };
const posOrder = { id: 1, location_id: 555, line_items: [] };
const webOrder = { id: 2, source_name: 'web', line_items: [] };
const mapped = new Map([['555', { location_tag: 'store_1', location_name: 'Store 1' }]]);

for (const [label, lib] of [['node', { resolveSalesRowLocation, storeNameLocation, resolveLocation, isLocationMapped }], ['edge', edge]]) {
  await test(`${label}: a mapped location wins`, () => {
    deepEq(lib.resolveSalesRowLocation({ order: posOrder, locationMap: mapped, connection: conn }),
      { location_tag: 'store_1', location_name: 'Store 1' }, 'mapped');
  });

  await test(`${label}: a typed default wins over the store name`, () => {
    deepEq(lib.resolveSalesRowLocation({ order: posOrder, locationMap: new Map(), connection: { ...conn, default_location_code: 'online' } }),
      { location_tag: 'online', location_name: 'online' }, 'typed default');
  });

  await test(`${label}: unmapped and untyped falls back to the store name`, () => {
    const expected = { location_tag: 'shopify_i09sb0_6m', location_name: 'Bat Nutz' };
    deepEq(lib.resolveSalesRowLocation({ order: posOrder, locationMap: new Map(), connection: conn }), expected, 'POS order');
    deepEq(lib.resolveSalesRowLocation({ order: webOrder, locationMap: new Map(), connection: conn }), expected, 'web order');
  });

  await test(`${label}: renaming the store keeps the tag (history does not split)`, () => {
    const a = lib.storeNameLocation(conn);
    const b = lib.storeNameLocation({ ...conn, shop_name: 'Bat Nutz Co' });
    deepEq([a.location_tag, b.location_name], ['shopify_i09sb0_6m', 'Bat Nutz Co'], 'tag stable, name follows');
  });

  await test(`${label}: no store name uses the shop handle; no domain still skips`, () => {
    deepEq(lib.storeNameLocation({ shop_domain: 'Foo.myshopify.com', shop_name: '  ' }),
      { location_tag: 'shopify_foo', location_name: 'foo' }, 'handle');
    deepEq(lib.storeNameLocation({ shop_name: 'X' }), null, 'no domain');
  });

  // Inventory: same three-step precedence as sales, on the SAME resolver the
  // snapshot loop calls.
  await test(`${label}: inventory keeps a mapped location's own tag`, () => {
    deepEq(lib.resolveLocation(conn, { id: 555, name: 'Store 1' }, mapped),
      { location_tag: 'store_1', location_name: 'Store 1' }, 'mapped wins');
  });

  await test(`${label}: inventory prefers a typed default over the store name`, () => {
    deepEq(lib.resolveLocation({ ...conn, default_location_code: 'online' }, { id: 999, name: 'Warehouse' }, new Map()),
      { location_tag: 'online', location_name: 'online' }, 'typed default');
  });

  await test(`${label}: inventory at an unmapped location falls back to the store`, () => {
    deepEq(lib.resolveLocation(conn, { id: 999, name: 'Warehouse' }, new Map()),
      { location_tag: 'shopify_i09sb0_6m', location_name: 'Bat Nutz' }, 'store fallback');
  });

  await test(`${label}: inventory tag matches what the store's unmapped SALES carry`, () => {
    const sale = lib.resolveSalesRowLocation({ order: posOrder, locationMap: new Map(), connection: conn });
    const stock = lib.resolveLocation(conn, { id: 999, name: 'Warehouse' }, new Map());
    deepEq(stock, sale, 'inventory and sales agree');
  });

  await test(`${label}: a connection with no shop domain is still skipped`, () => {
    deepEq(lib.resolveLocation({ shop_name: 'X' }, { id: 999, name: 'Warehouse' }, new Map()), null, 'no domain');
  });

  await test(`${label}: isLocationMapped separates a mapping from a fallback`, () => {
    // loadLocationMap keys every mapping under BOTH the numeric id and the gid
    // form, so a real map answers either spelling.
    const bothForms = new Map([
      ['555', { location_tag: 'store_1', location_name: 'Store 1' }],
      ['gid://shopify/Location/555', { location_tag: 'store_1', location_name: 'Store 1' }],
    ]);
    deepEq(
      [
        lib.isLocationMapped({ id: 555 }, bothForms),
        lib.isLocationMapped({ id: 999 }, bothForms),
        lib.isLocationMapped({ id: 'gid://shopify/Location/555' }, bothForms),
      ],
      [true, false, true],
      'mapped / unmapped / gid form',
    );
  });
}

await test('runShopDomainsSync refreshes a stale store name from shop.json', async () => {
  const supabase = createFakeSupabase();
  const c = { ...conn, shop_name: 'My Store', company_entity_id: 'co', api_version: '2024-10', access_token: 'x' };
  const res = await runShopDomainsSync(supabase, c, {
    fetchJson: async () => ({ shop: { name: ' Bat  Nutz ', myshopify_domain: c.shop_domain } }),
  });
  deepEq([res.shop_name_updated, c.shop_name], [true, 'Bat Nutz'], 'in-memory name updated');
  const upd = supabase.calls.updates.find((u) => u.table === 'shopify_connections');
  deepEq(upd?.patch, { shop_name: 'Bat Nutz' }, 'persisted patch');
});

await test('runShopDomainsSync leaves an unchanged name alone', async () => {
  const supabase = createFakeSupabase();
  const c = { ...conn, company_entity_id: 'co', api_version: '2024-10', access_token: 'x' };
  const res = await runShopDomainsSync(supabase, c, {
    fetchJson: async () => ({ shop: { name: 'Bat Nutz', myshopify_domain: c.shop_domain } }),
  });
  deepEq([res.shop_name_updated, supabase.calls.updates.length], [false, 0], 'no write');
});


// ── The integrated snapshot: a store with NOTHING mapped writes real rows ───
//
// This is the case that was broken in production: 16 Shopify locations, no
// mappings, "success", zero rows. Stubbing global fetch rather than injecting
// one keeps the real getAll/pagination/upsert path in the test.
function stubShopify({ locations, variants, products, levelsByLocation }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = (() => {
      if (u.includes('/locations.json')) return { locations };
      if (u.includes('/variants.json')) return { variants };
      if (u.includes('/products.json')) return { products };
      if (u.includes('/inventory_levels.json')) {
        const id = new URL(u).searchParams.get('location_ids');
        return { inventory_levels: levelsByLocation[id] || [] };
      }
      throw new Error(`stub: unexpected Shopify call ${u}`);
    })();
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  };
  return () => { globalThis.fetch = original; };
}

const invConn = {
  id: 'c-inv',
  company_entity_id: 'co-1',
  shop_domain: 'hhoutfitter.myshopify.com',
  shop_name: 'STLHD GEAR',
  api_version: '2024-10',
  access_token: 'tok',
  // runInventorySnapshot gates on scopes before it fetches anything.
  scopes_granted: ['read_inventory', 'read_locations', 'read_products', 'read_orders'],
};

const invFixture = {
  locations: [{ id: 1, name: 'Main Warehouse' }, { id: 2, name: 'Retail Floor' }],
  variants: [{ id: 10, product_id: 100, sku: 'SKU-1', inventory_item_id: 1000, price: '20.00', title: 'Default Title' }],
  products: [{ id: 100, title: 'Steelhead Tee', product_type: 'Tops' }],
  levelsByLocation: {
    1: [{ inventory_item_id: 1000, available: 7 }],
    2: [{ inventory_item_id: 1000, available: 3 }],
  },
};

await test('runInventorySnapshot writes rows for a store with no mappings at all', async () => {
  const supabase = createFakeSupabase();
  const restore = stubShopify(invFixture);
  try {
    const res = await runInventorySnapshot(supabase, { ...invConn }, { batchId: 'b1' });
    const rows = supabase.calls.upserts.filter((u) => u.table === 'inventory_on_hand').flatMap((u) => u.rows);
    if (res.inventory_rows_upserted !== 2 || rows.length !== 2) {
      throw new Error(`expected 2 inventory rows, got ${res.inventory_rows_upserted} / ${rows.length}`);
    }
    deepEq([...new Set(rows.map((r) => r.location_tag))], ['shopify_hhoutfitter'], 'both rows carry the store tag');
    deepEq(rows.map((r) => r.total_available_quantity).sort(), [3, 7], 'per-location quantities kept');
    deepEq([res.locations, res.locations_unmapped, res.locations_skipped], [2, 2, 0], 'result reports the fallback');
  } finally { restore(); }
});

await test('a typed default_location_code labels the snapshot instead', async () => {
  const supabase = createFakeSupabase();
  const restore = stubShopify(invFixture);
  try {
    await runInventorySnapshot(supabase, { ...invConn, default_location_code: 'online' }, { batchId: 'b2' });
    const rows = supabase.calls.upserts.filter((u) => u.table === 'inventory_on_hand').flatMap((u) => u.rows);
    deepEq([...new Set(rows.map((r) => r.location_tag))], ['online'], 'typed default wins');
  } finally { restore(); }
});

await test('an explicit mapping still splits the store into its own locations', async () => {
  const supabase = createFakeSupabase();
  supabase.from('shopify_location_mappings').insert({
    company_entity_id: 'co-1', connection_id: 'c-inv', shopify_location_id: '1',
    silo_location_code: 'main_wh', location_id: null,
  });
  const restore = stubShopify(invFixture);
  try {
    const res = await runInventorySnapshot(supabase, { ...invConn }, { batchId: 'b3' });
    const rows = supabase.calls.upserts.filter((u) => u.table === 'inventory_on_hand').flatMap((u) => u.rows);
    deepEq([...new Set(rows.map((r) => r.location_tag))].sort(), ['main_wh', 'shopify_hhoutfitter'], 'mapped keeps its tag, the rest fall back');
    deepEq([res.locations_unmapped, res.locations_skipped], [1, 0], 'only the unmapped one counted');
  } finally { restore(); }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
