// 20260930150000_shopify_order_payment_terms.sql against real PostgreSQL
// (PGlite), read from disk. Proves:
//   - it applies, twice
//   - shopify_orders_v keeps every existing column in its existing position
//     (create or replace view refuses otherwise, and readers depend on it)
//   - payment_overdue is true / false only when terms were returned, and NULL
//     (unknown) when they were not -- never false for "not returned"
//   - payment_days_overdue counts in the company's business days
//   - the status CHECK refuses anything but present / none / NULL
//   - the Ask SILO catalog note is appended once, not replaced or repeated
//
// Stand-in schema: production's shopify_orders columns as of 2026-09-30
// (information_schema), the channel map, and fixed business-day helpers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const MIGRATION = new URL('../../supabase/migrations/20260930150000_shopify_order_payment_terms.sql', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const OLD_VIEW_COLUMNS = ['id', 'company_entity_id', 'connection_id', 'shop_domain', 'order_id', 'order_number',
  'source_name', 'financial_status', 'fulfillment_status', 'cancelled_at', 'cancel_reason', 'customer_id',
  'customer_email', 'customer_name', 'currency', 'subtotal_price', 'total_discounts', 'total_tax', 'total_shipping',
  'total_price', 'tags', 'location_id', 'line_item_count', 'shopify_created_at', 'shopify_processed_at',
  'shopify_updated_at', 'synced_at', 'sync_batch_id', 'created_at', 'resolved_channel_name'];

await db.exec(`
  create table public.shopify_orders (
    id bigserial primary key, company_entity_id uuid, connection_id uuid, shop_domain text, order_id text,
    order_number text, source_name text, financial_status text, fulfillment_status text,
    cancelled_at timestamptz, cancel_reason text, customer_id text, customer_email text, customer_name text,
    currency text, subtotal_price numeric, total_discounts numeric, total_tax numeric, total_shipping numeric,
    total_price numeric, tags text, location_id text, line_item_count integer,
    shopify_created_at timestamptz, shopify_processed_at timestamptz, shopify_updated_at timestamptz,
    synced_at timestamptz, sync_batch_id text, created_at timestamptz default now(),
    unique (shop_domain, order_id));
  create table public.shopify_channel_map (company_entity_id uuid, source_name text, display_name text);
  -- The pre-migration view, as production has it.
  create view public.shopify_orders_v with (security_invoker = true) as
    select o.id, o.company_entity_id, o.connection_id, o.shop_domain, o.order_id, o.order_number, o.source_name,
      o.financial_status, o.fulfillment_status, o.cancelled_at, o.cancel_reason, o.customer_id, o.customer_email,
      o.customer_name, o.currency, o.subtotal_price, o.total_discounts, o.total_tax, o.total_shipping, o.total_price,
      o.tags, o.location_id, o.line_item_count, o.shopify_created_at, o.shopify_processed_at, o.shopify_updated_at,
      o.synced_at, o.sync_batch_id, o.created_at, coalesce(m.display_name, o.source_name) as resolved_channel_name
    from public.shopify_orders o
    left join public.shopify_channel_map m on m.company_entity_id = o.company_entity_id and m.source_name = o.source_name;
  -- Fixed business day and zone, so day counts are exact.
  create function public.silo_business_today() returns date language sql stable as $$ select date '2026-09-30' $$;
  create function public.silo_business_timezone() returns text language sql stable as $$ select 'America/New_York' $$;
  create table public.silo_chat_schema_catalog (relname text primary key, description text);
  insert into public.silo_chat_schema_catalog values ('shopify_orders', 'One row per Shopify order.'), ('shopify_orders_v', null);
  create function public.refresh_chat_schema_catalog() returns void language plpgsql as $$ begin end $$;
`);

const sql = await readFile(MIGRATION, 'utf8');

await test('the migration applies, and applies again', async () => { await db.exec(sql); await db.exec(sql); });

await test('shopify_orders_v keeps every existing column in its place; the new ones come after', async () => {
  const cols = (await q(`select column_name from information_schema.columns
    where table_schema='public' and table_name='shopify_orders_v' order by ordinal_position`)).map((r) => r.column_name);
  assert.deepEqual(cols.slice(0, OLD_VIEW_COLUMNS.length), OLD_VIEW_COLUMNS);
  assert.deepEqual(cols.slice(OLD_VIEW_COLUMNS.length), ['payment_terms_status', 'payment_terms_name', 'payment_terms_type',
    'payment_due_in_days', 'payment_due_at', 'payment_terms_completed_at', 'total_outstanding',
    'payment_overdue', 'payment_days_overdue']);
});

await test('the view stays security_invoker', async () => {
  const [r] = await q(`select reloptions from pg_class where oid = 'public.shopify_orders_v'::regclass`);
  assert.ok((r.reloptions || []).includes('security_invoker=true'), JSON.stringify(r.reloptions));
});

const ins = (id, o) => q(`insert into public.shopify_orders (shop_domain, order_id, financial_status, cancelled_at,
    payment_terms_status, payment_terms_name, payment_due_at, payment_terms_completed_at, total_outstanding)
  values ('s', $1, $2, $3, $4, $5, $6, $7, $8)`,
  [id, o.fin ?? 'pending', o.cancelled ?? null, o.status ?? null, o.name ?? null, o.due ?? null, o.done ?? null, o.owed ?? null]);

await ins('overdue', { status: 'present', name: 'Net 30', due: '2026-09-20T12:00:00Z', owed: 2062.12 });
await ins('not-due-yet', { status: 'present', name: 'Net 30', due: '2099-01-01T00:00:00Z', owed: 500 });
await ins('paid-late', { status: 'present', fin: 'paid', due: '2026-09-01T00:00:00Z', owed: 0 });
await ins('paid-balance-unknown', { status: 'present', fin: 'paid', due: '2026-09-01T00:00:00Z', owed: null });
await ins('completed', { status: 'present', due: '2026-09-01T00:00:00Z', done: '2026-09-02T00:00:00Z' });
await ins('cancelled', { status: 'present', due: '2026-09-01T00:00:00Z', cancelled: '2026-09-03T00:00:00Z', owed: 10 });
await ins('nothing-owed', { status: 'present', due: '2026-09-01T00:00:00Z', owed: 0 });
await ins('owed-unknown', { status: 'present', due: '2026-09-01T00:00:00Z', owed: null });
await ins('no-terms', { status: 'none', owed: 0 });
await ins('not-returned', { status: null });
await ins('late-evening', { status: 'present', due: '2026-09-29T03:30:00Z', owed: 5 });

const view = async () => Object.fromEntries((await q(
  `select order_id, payment_overdue, payment_days_overdue from public.shopify_orders_v`))
  .map((r) => [r.order_id, [r.payment_overdue, r.payment_days_overdue]]));

await test('overdue: past due, unpaid, still owed -- with its business-day count', async () => {
  const v = await view();
  assert.deepEqual(v.overdue, [true, 10], 'due 20 Sep, business today 30 Sep');
  // 00:00 UTC on 1 Sep is 31 Aug in New York, so 30 business days.
  assert.deepEqual(v['owed-unknown'], [true, 30], 'an unknown balance does not hide a past-due unpaid order');
});

await test('not overdue: not yet due, paid, completed, cancelled, nothing owed', async () => {
  const v = await view();
  for (const id of ['not-due-yet', 'paid-late', 'paid-balance-unknown', 'completed', 'cancelled', 'nothing-owed']) {
    assert.deepEqual(v[id], [false, null], id);
  }
});

await test('no terms is false-free: NULL for both "none" and "not returned", never false', async () => {
  const v = await view();
  assert.deepEqual(v['no-terms'], [null, null]);
  assert.deepEqual(v['not-returned'], [null, null]);
});

await test('days overdue use the company business zone, not UTC', async () => {
  // 03:30 UTC on 29 Sep is 23:30 on 28 Sep in New York -> 2 business days, not 1.
  assert.deepEqual((await view())['late-evening'], [true, 2]);
});

await test('the status CHECK refuses anything but present / none / NULL', async () => {
  await assert.rejects(() => ins('bad', { status: 'unknown' }), /shopify_orders_payment_terms_status_check/);
});

await test('the Ask SILO note is appended once to both relations, and nothing is replaced', async () => {
  await db.exec(sql);
  const rows = await q(`select relname, description from public.silo_chat_schema_catalog order by relname`);
  const orders = rows.find((r) => r.relname === 'shopify_orders').description;
  assert.ok(orders.startsWith('One row per Shopify order.'), 'the existing description is kept');
  for (const r of rows) {
    assert.equal(r.description.split('Payment terms (20260930150000)').length - 1, 1, `${r.relname}: exactly once`);
    assert.match(r.description, /NULL means NOT RETURNED/);
  }
});

await test('verify_v2_schema.sql row shopify_order_payment_terms runs and reads ok', async () => {
  const verify = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  const start = verify.indexOf('-- 25b. Shopify order payment terms');
  const end = verify.indexOf('end as shopify_order_payment_terms;');
  assert.ok(start > 0 && end > start, 'the verify row is present');
  const [row] = await q(verify.slice(start, end + 'end as shopify_order_payment_terms'.length));
  assert.equal(row.shopify_order_payment_terms, 'ok');
});

console.log(`\nshopify-order-terms-database: ${passed} passed`);
