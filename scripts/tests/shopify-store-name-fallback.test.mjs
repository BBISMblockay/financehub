// Sales at an unmapped Shopify location, on a connection with no typed
// default, are labelled with the store's own name instead of being skipped.
// Precedence: mapped location > typed default_location_code > store name.
import { resolveSalesRowLocation, storeNameLocation, runShopDomainsSync } from '../lib/shopify-sync-core.mjs';
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

for (const [label, lib] of [['node', { resolveSalesRowLocation, storeNameLocation }], ['edge', edge]]) {
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

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
