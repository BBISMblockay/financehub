// Isolated-process 10,000-order representation/publication probe. Embedded
// PGlite only: no transport, separate-reader concurrency or capacity claim.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { ordersToOrderRows, ordersToSalesRows, compactIncrementalRows, ATOMIC_SALES_MAX_BYTES } from '../lib/shopify-sync-core.mjs';

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const db = new PGlite();
const connection = { id: '82000000-0000-4000-8000-000000000001',
  company_entity_id: '81000000-0000-4000-8000-000000000001', shop_domain: 'synthetic-barrier-1.myshopify.com' };
const now = '2026-10-10T12:00:00Z';
const orders = Array.from({ length: 10000 }, (_, i) => ({
  id: 100000 + i, name: '#BUSY-' + i, created_at: '2026-10-07T18:00:00Z',
  processed_at: '2026-10-07T18:00:00Z', updated_at: now, source_name: 'web',
  financial_status: 'paid', currency: 'USD', tags: 'REUSED-TAG', location_id: 1,
  total_price: '10', subtotal_price: '10', payment_terms: null,
  line_items: [{ id: 200000 + i, product_id: 0, variant_id: 0, sku: 'BUSY-' + i,
    title: 'Busy product ' + i, quantity: 1, price: '10', tax_lines: [], discount_allocations: [] }],
}));
const q = async (s, p = []) => (await db.query(s, p)).rows;
const makeArgs = () => {
  const input = { orders, connection, skuMeta: new Map(), syncedAt: now, batchId: 'busy-window' };
  const { orderRows, lineRows } = ordersToOrderRows(input);
  const { salesRows } = ordersToSalesRows({ ...input, locationMap: new Map() });
  const scope = { p_connection_id: connection.id, p_company_entity_id: connection.company_entity_id,
    p_shop_domain: connection.shop_domain, p_start: '2026-10-07', p_end: '2026-10-07' };
  const compact = { ...scope, ...compactIncrementalRows(orderRows, lineRows, salesRows) };
  // Compare every persisted property, preserving missing keys versus explicit null.
  for (const [name, rows] of [['orders', orderRows], ['lines', lineRows], ['sales', salesRows]]) {
    const expanded = compact['p_' + name].map(row => ({ ...row, ...compact.p_metadata[name] }));
    assert.deepEqual(expanded, rows);
  }
  return { compact, original: { ...scope, p_orders: orderRows, p_lines: lineRows, p_sales: salesRows } };
};
async function publish(a) {
  await db.exec('set role service_role');
  try { return (await q('select public.shopify_publish_incremental_window($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
    [a.p_connection_id,a.p_company_entity_id,a.p_shop_domain,a.p_start,a.p_end,
      JSON.stringify(a.p_orders),JSON.stringify(a.p_lines),JSON.stringify(a.p_sales),JSON.stringify(a.p_metadata)]))[0].result;
  } finally { await db.exec('reset role'); }
}
async function totals() {
  return (await q(`select
    (select count(*)::int from shopify_orders) orders,
    (select count(*)::int from shopify_order_lines) lines,
    (select count(*)::int from sales_by_day) sales,
    (select sum(subtotal_price)::text from shopify_orders) subtotal,
    (select sum(quantity)::int from shopify_order_lines) quantity,
    (select sum(total_net_sales)::text from sales_by_day) net`))[0];
}
try {
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec(read('shopify-atomic-fixture.sql'));
  await db.exec(read('../../supabase/migrations/20261013080000_shopify_atomic_incremental_publish.sql'));
  await q('insert into entities values($1)', [connection.company_entity_id]);
  await q("insert into shopify_connections(id,company_entity_id,shop_domain,access_token) values($1,$2,$3,'synthetic-only')",
    [connection.id,connection.company_entity_id,connection.shop_domain]);
  await db.exec('grant usage on schema public to service_role;grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role;');
  const baselineRss=process.memoryUsage().rss, baselinePeak=process.resourceUsage().maxRSS*1024;
  const prepareAt=performance.now(), {compact,original}=makeArgs(), prepareMs=performance.now()-prepareAt;
  const originalBytes=Buffer.byteLength(JSON.stringify(original));
  const encodeAt=performance.now(), encoded=JSON.stringify(compact), encodeMs=performance.now()-encodeAt;
  const decodeAt=performance.now(), decoded=JSON.parse(encoded), decodeMs=performance.now()-decodeAt;
  assert.deepEqual(decoded,compact);
  const bytes=Buffer.byteLength(encoded);
  const normalizedBytes=(await q('select octet_length($1::jsonb::text) n',[encoded]))[0].n;
  assert.ok(bytes<=ATOMIC_SALES_MAX_BYTES);assert.ok(normalizedBytes<=ATOMIC_SALES_MAX_BYTES);
  const publishAt=performance.now();
  assert.deepEqual(await publish(decoded),{orders_upserted:10000,order_lines_upserted:10000,sales_rows_upserted:10000});
  const publishMs=performance.now()-publishAt;
  const expected={orders:10000,lines:10000,sales:10000,subtotal:'100000',quantity:10000,net:'100000'};
  assert.deepEqual(await totals(),expected);
  orders[0].line_items[0].quantity=2;orders[0].total_price=orders[0].subtotal_price='20';
  const changed=makeArgs().compact;
  await db.exec(`create function fail_busy_publish() returns trigger language plpgsql as $$ begin raise exception 'BUSY_ROLLBACK'; end $$;
    create trigger fail_busy_publish after insert on shopify_order_lines for each statement execute function fail_busy_publish();`);
  const rollbackAt=performance.now();await assert.rejects(()=>publish(changed),/BUSY_ROLLBACK/);
  const rollbackMs=performance.now()-rollbackAt;
  assert.deepEqual(await totals(),expected);
  await db.exec('drop trigger fail_busy_publish on shopify_order_lines;drop function fail_busy_publish();');
  await publish(changed);await publish(changed);
  assert.deepEqual(await totals(),{...expected,subtotal:'100010',quantity:10001,net:'100010'});
  console.log(JSON.stringify({status:'LOCAL_COMPACT_PUBLISH_ROLLBACK_REPLAY_PASSED',orders:10000,lines:10000,salesRows:10000,
    originalBytes,bytes,normalizedBytes,prepareMs,encodeMs,decodeMs,publishMs,rollbackMs,
    baselineRss,baselinePeak,rssAfter:process.memoryUsage().rss,isolatedProcessPeakRss:process.resourceUsage().maxRSS*1024,
    limits:'16MiB implementation proposal, not verified platform constraint; serial PGlite, no hosted acceptance'}));
} catch(error) { console.error(error);process.exitCode=1; } finally { await db.close(); }
