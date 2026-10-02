// Real Node/edge builders AND production sales entrypoints with in-memory IO.
// No credentials, network, or production writes. Each listed mutation must fail.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = new URL('../../', import.meta.url);
const mutation = process.env.SHOPIFY_DEFAULT_MUTATION;
async function load(path) {
  const url = new URL(path, ROOT);
  let src = await readFile(url, 'utf8');
  const edits = {
    'drop-default': ["if (connection?.default_location_code) {", "if (false) {"],
    'override-mapping': ['  const candidateIds = [];', "  if (connection?.sales_default_location) return connection.sales_default_location;\n  const candidateIds = [];"],
    'unmapped-online': ['if (fallback?.automatic && candidateIds.length && !webWithoutSalesLocation) return null;', ''],
    'cross-company': [".eq('company_entity_id', companyEntityId)", ''],
    'web-dropped': ["const webWithoutSalesLocation = order?.source_name === 'web' && !directSalesId;", 'const webWithoutSalesLocation = false;'],
    'cross-store': [".eq('connection_id', connectionId)", ''],
    'skip-prepare': ['await prepareSalesDefault(supabase, connection);', ''],
    'delete-unresolved': ['if (skipped?.no_location_lines) {', 'if (false) {'],
    'name-is-identity': ['fallback?.location_tag || slugify(connection.default_location_code)', 'slugify(fallback?.location_name || connection.default_location_code)'],
  };
  if (mutation) {
    assert.ok(edits[mutation], 'known mutation');
    assert.ok(src.includes(edits[mutation][0]), 'mutation applies');
    src = src.replaceAll(...edits[mutation]);
  }
  src = src.replace("'./shopify-scopes.mjs'", JSON.stringify(new URL('./shopify-scopes.mjs', url).href));
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}
const modules = [
  ['node', await load('scripts/lib/shopify-sync-core.mjs')],
  ['edge', await load('supabase/functions/shopify-sync-run/lib/shopify-sync-core.mjs')],
];
let count = 0;
async function test(name, fn) {
  await fn(); count++; console.log(`ok ${count} - ${name}`);
}
const CO = '998f69e6-d6cc-408c-9b16-06ec63b7d3b4';
const CONN = '11ff0bda-62fc-4bf7-bed5-080d1001e09f';
const CODE = `shopify_online_${CONN.replaceAll('-', '')}`;
const fallback = { location_tag: CODE, location_name: 'Bat Nutz Online', default_location_code: CODE, automatic: true };
const connection = () => ({ id: CONN, company_entity_id: CO, shop_domain: 'i09sb0-6m.myshopify.com', scopes_granted: ['read_orders'] });
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const order = () => ({ id: 100, created_at: `${day}T12:00:00-07:00`, updated_at: `${day}T12:01:00-07:00`,
  location_id: null, source_name: 'web', line_items: [{ id: 200, sku: 'NUTS', title: 'Nuts', quantity: 2, price: '10.00' }],
  refunds: [{ id: 300, processed_at: `${day}T13:00:00-07:00`, refund_line_items: [{ line_item_id: 200, quantity: 1, subtotal: '10.00', total_tax: '0.00' }] }] });
const rowOpts = (conn, o = order(), map = new Map()) => ({ orders: [o], connection: conn, locationMap: map, skuMeta: new Map(), syncedAt: '2026-10-02T00:00:00Z' });

// Query fixture actually applies every filter, so removing scope cannot pass.
function database({ rpcError = null, mapped = [], locations = [] } = {}) {
  const ops = [];
  const rows = new Map();
  return { ops, rows,
    async rpc(name, params) {
      ops.push({ type: 'rpc', name, params });
      assert.equal(name, 'ensure_shopify_sales_default'); assert.equal(params.p_connection_id, CONN);
      return { data: rpcError ? null : { ...fallback }, error: rpcError };
    },
    from(table) {
      const q = { table, type: 'select', filters: [] };
      const api = {
        select() { return api; },
        eq(k, v) { q.filters.push(r => r[k] === v); return api; },
        not(k, op, v) { q.filters.push(r => r[k] != null); return api; },
        in(k, vals) { q.filters.push(r => vals.includes(r[k])); return api; },
        gt() { return api; }, gte() { return api; }, lte() { return api; },
        delete() { q.type = 'delete'; return api; },
        upsert(data, options) { q.type = 'upsert'; q.data = structuredClone(data); q.options = options; return api; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            ops.push(q);
            if (q.type === 'upsert' && table === 'sales_by_day') {
              for (const r of q.data) rows.set(r.row_hash, r);
            }
            const data = table === 'shopify_location_mappings' ? mapped : table === 'locations' ? locations : [];
            return { data: data.filter(r => q.filters.every(f => f(r))), error: null };
          }).then(resolve, reject);
        },
      }; return api;
    },
  };
}
async function mockFetch(o, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const key = path.split('/').at(-1).replace('.json', '');
    assert.ok(['orders', 'locations', 'products', 'variants'].includes(key), `unexpected request ${path}`);
    return new Response(JSON.stringify({ [key]: key === 'orders' ? [o] : [] }), { status: 200 });
  };
  try { return await fn(); } finally { globalThis.fetch = prev; }
}

for (const [runtime, m] of modules) {
  await test(`${runtime}: unmapped/no-id sales and refunds are retained with readable company label`, async () => {
    const conn = connection(); await m.prepareSalesDefault(database(), conn);
    const result = await m.ordersToSalesRows(rowOpts(conn));
    assert.equal(result.skipped.no_location_lines, 0); assert.equal(result.salesRows.length, 2);
    assert.equal(result.salesRows.reduce((sum, r) => sum + r.total_net_sales, 0), 10);
    for (const r of result.salesRows) { assert.equal(r.location_tag, CODE); assert.equal(r.location_name, 'Bat Nutz Online'); assert.equal(r.company_entity_id, CO); }
    assert.equal((await m.ordersToOrderRows(rowOpts(conn))).orderRows[0].location_id, null, 'never fabricate Shopify source ids');
  });
  await test(`${runtime}: real mappings win, explicit wholesale defaults retain legacy behavior`, async () => {
    const conn = connection(); await m.prepareSalesDefault(database(), conn);
    const real = { location_tag: 'retail', location_name: 'Retail shop' };
    const o = { ...order(), location_id: '12' };
    assert.deepEqual(m.resolveSalesRowLocation({ order: o, locationMap: new Map([['12', real]]), connection: conn }), real);
    const explicit = { ...conn, default_location_code: 'wholesale', sales_default_location: { location_tag: 'wholesale', location_name: 'Wholesale', automatic: false } };
    assert.equal(m.resolveSalesRowLocation({ order: o, locationMap: new Map(), connection: explicit }).location_tag, 'wholesale');
    assert.equal(m.resolveSalesRowLocation({ order: {}, locationMap: new Map(), connection: { default_location_code: 'Special Outlet' } }).location_tag, 'special_outlet');
  });
  await test(`${runtime}: unmapped actual order/fulfillment/line ids are never inferred online`, async () => {
    const conn = connection(); await m.prepareSalesDefault(database(), conn);
    for (const o of [{ location_id: '12' }, { fulfillments: [{ location_id: '12' }] }, { line_items: [{ location_id: '12' }] }]) {
      assert.equal(m.resolveSalesRowLocation({ order: o, locationMap: new Map(), connection: conn }), null);
    }
    assert.equal(m.resolveLocation(conn, { id: '12', name: 'Warehouse' }, new Map()), null, 'no invented inventory mapping');
  });
  await test(`${runtime}: a fulfilled web order without a sales location retains online sales`, async () => {
    const conn = connection(); await m.prepareSalesDefault(database(), conn);
    const o = { ...order(), fulfillments: [{ location_id: 'warehouse-1' }] };
    const result = await m.ordersToSalesRows(rowOpts(conn, o));
    assert.equal(result.skipped.no_location_lines, 0); assert.equal(result.salesRows.length, 2);
    assert.ok(result.salesRows.every(r => r.location_tag === CODE));
    const mapped = { location_tag: 'customer_mapping', location_name: 'Customer mapping' };
    assert.deepEqual(m.resolveSalesRowLocation({ order: o, connection: conn, locationMap: new Map([['warehouse-1', mapped]]) }), mapped);
    assert.equal(m.resolveSalesRowLocation({ order: { ...o, source_name: 'pos' }, connection: conn, locationMap: new Map() }), null);
  });
  await test(`${runtime}: rename preserves every sale/refund row hash and source location`, async () => {
    const conn = connection(); await m.prepareSalesDefault(database(), conn);
    const before = await m.ordersToSalesRows(rowOpts(conn));
    conn.sales_default_location.location_name = 'Bat Nutz Web';
    const after = await m.ordersToSalesRows(rowOpts(conn));
    assert.deepEqual(before.salesRows.map(r => r.row_hash), after.salesRows.map(r => r.row_hash));
    assert.ok(after.salesRows.every(r => r.location_name === 'Bat Nutz Web'));
  });
  await test(`${runtime}: mapping reads do not borrow another connection or another company's labels`, async () => {
    const db = database({ mapped: [
      { company_entity_id: CO, connection_id: CONN, shopify_location_id: '12', silo_location_code: 'ours', location_id: 1 },
      { company_entity_id: CO, connection_id: 'other-store', shopify_location_id: '12', silo_location_code: 'wrong-store', location_id: 2 },
      { company_entity_id: 'other-company', connection_id: CONN, shopify_location_id: '12', silo_location_code: 'wrong-company', location_id: 2 },
    ], locations: [{ id: 1, company_entity_id: 'other-company', location_name: 'Secret other-company label' }] });
    const map = await m.loadLocationMap(db, CO, CONN);
    assert.equal(map.get('12').location_tag, 'ours'); assert.equal(map.get('12').location_name, 'ours');
    assert.deepEqual(map.get('12'), map.get('gid://shopify/Location/12'));
  });
  await test(`${runtime}: real incremental entrypoint hydrates fallback, writes sales and replay keeps hashes`, async () => {
    const conn = connection(); const db = database();
    await mockFetch(order(), async () => {
      const result = await m.runIncrementalSales(db, conn);
      assert.equal(result.rows_skipped.no_location_lines, 0); assert.equal(result.sales_rows_upserted, 2);
      assert.equal(db.rows.size, 2); const hashes = [...db.rows.keys()];
      await m.runIncrementalSales(db, conn);
      assert.deepEqual([...db.rows.keys()], hashes); assert.equal(db.rows.size, 2);
      assert.ok(db.ops[0].type === 'rpc');
    });
  });
  await test(`${runtime}: default setup failure occurs before any sales delete/upsert`, async () => {
    const db = database({ rpcError: { message: 'function missing' } });
    await mockFetch(order(), () => assert.rejects(() => m.runIncrementalSales(db, connection()), /sales default setup/));
    assert.equal(db.ops.filter(o => ['delete', 'upsert'].includes(o.type)).length, 0);
  });
  await test(`${runtime}: history orchestrator checks setup before its initial purge`, async () => {
    const db = database({ rpcError: { message: 'function missing' } });
    await assert.rejects(() => m.runWindowedHistory(db, connection(), { historyDays: 2 }), /sales default setup/);
    assert.deepEqual(db.ops.map(o => o.type), ['rpc']);
  });
  await test(`${runtime}: incomplete actual-location resolution fails before destructive rebuild`, async () => {
    const db = database(); const o = { ...order(), location_id: 'unmapped-real-id' };
    await mockFetch(o, () => assert.rejects(() => m.runIncrementalSales(db, connection()), /Cannot rebuild sales/));
    assert.equal(db.ops.filter(o => ['delete', 'upsert'].includes(o.type)).length, 0);
  });
  await test(`${runtime}: history cache path still provisions fallback and cannot advance unresolved window`, async () => {
    const tomorrow = new Date(`${day}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const conn = { ...connection(), meta: { history_backfill: { status: 'running', range_start: day, range_end: tomorrow.toISOString().slice(0, 10), cursor: day, chunk_days: 1, windows_done: 0 } } };
    const opts = { skuMetaCache: new Map(), locationContextCache: { dbLocationMap: new Map() } };
    const db = database();
    await mockFetch(order(), () => m.runHistoryChunk(db, conn, opts));
    assert.equal(db.rows.size, 2); assert.equal(db.ops[0].type, 'rpc');
    const badDb = database();
    await mockFetch({ ...order(), location_id: 'unmapped' }, () => assert.rejects(() => m.runHistoryChunk(badDb, connectionWithHistory(), opts), /Cannot rebuild sales/));
    assert.equal(badDb.ops.filter(o => ['delete', 'upsert'].includes(o.type)).length, 0);
    function connectionWithHistory() { return { ...connection(), meta: { history_backfill: { ...conn.meta.history_backfill } } }; }
  });
}
await test('edge UI history-start handler fails setup before its destructive reset', async () => {
  const source = await readFile(new URL('supabase/functions/shopify-sync-run/index.ts', ROOT), 'utf8');
  const start = source.indexOf('async function handleStartHistoryBackfill(');
  const end = source.indexOf('async function handleHistoryChunk(', start);
  assert.ok(start > 0 && end > start);
  let handlerSource = stripTypeScriptTypes(source.slice(start, end));
  if (mutation === 'skip-prepare') handlerSource = handlerSource.replace('await prepareSalesDefault(admin, connection);', '');
  let purged = false;
  const handler = new Function('readMeta', 'prepareSalesDefault', 'purgeShopifySalesForShop', handlerSource + '; return handleStartHistoryBackfill;')(
    () => ({}), async () => { throw new Error('setup failed'); }, async () => { purged = true; throw new Error('purged first'); },
  );
  await assert.rejects(() => handler({}, connection(), 'admin', 2, 1), /setup failed/);
  assert.equal(purged, false);
});
console.log(`${count} Shopify online-default checks passed (${mutation || 'production source'})`);
