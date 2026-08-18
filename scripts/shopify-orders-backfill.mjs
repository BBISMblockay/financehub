// scripts/shopify-orders-backfill.mjs — one-shot historical backfill of
// shopify_orders / shopify_order_lines (manual GHA: shopify-orders-backfill.yml).
//
// The nightly incremental sync (scripts/shopify-sync.mjs) only writes order
// facts for orders touched in its ~2-day watermark window, so history before
// each store's first post-20260817210000 sync is missing from these tables.
// sales_by_day is NOT the answer to that gap — its history is already
// correct, and re-running the full history import just to get order facts
// would spend hours rewriting sales aggregates that don't need it.
//
// This walks the same history windows the sales import uses
// (planHistoryWindows / fetchOrdersInWindow) but writes ONLY order facts
// via upsertOrderFacts — no sales_by_day reads or writes, no location
// mapping, no watermark/meta updates. Everything is keyed on Shopify's own
// ids ((shop_domain, order_id) / (…, line_item_id)), so re-running any
// range is idempotent and overlapping the nightly sync is safe.

import { createClient } from '@supabase/supabase-js';
import { connectionReadyForSync } from './lib/shopify-scopes.mjs';
import {
  DEFAULT_API_VERSION,
  DEFAULT_CHUNK_DAYS,
  computeHistoryRange,
  fetchOrdersInWindow,
  loadSkuMeta,
  planHistoryWindows,
  upsertOrderFacts,
} from './lib/shopify-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// Explicit YYYY-MM-DD range wins; otherwise BACKFILL_DAYS back from today,
// falling back per connection to its history_days_default (same default the
// sales history import uses), then 365.
const BACKFILL_START = process.env.BACKFILL_START || '';
const BACKFILL_END = process.env.BACKFILL_END || '';
const BACKFILL_DAYS = process.env.BACKFILL_DAYS ? Number(process.env.BACKFILL_DAYS) : null;
const CHUNK_DAYS = Number(process.env.BACKFILL_CHUNK_DAYS || DEFAULT_CHUNK_DAYS);
const ONLY_COMPANY_ID = process.env.SHOPIFY_ONLY_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.SHOPIFY_ONLY_CONNECTION_ID || '';

const BATCH_ID =
  process.env.SHOPIFY_SYNC_BATCH_ID ||
  `orders-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`;

if ((BACKFILL_START && !/^\d{4}-\d{2}-\d{2}$/.test(BACKFILL_START))
  || (BACKFILL_END && !/^\d{4}-\d{2}-\d{2}$/.test(BACKFILL_END))) {
  throw new Error('BACKFILL_START / BACKFILL_END must be YYYY-MM-DD');
}
if (!!BACKFILL_START !== !!BACKFILL_END) {
  throw new Error('Set both BACKFILL_START and BACKFILL_END, or neither');
}
if (BACKFILL_START && BACKFILL_START >= BACKFILL_END) {
  throw new Error('BACKFILL_START must be before BACKFILL_END');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function startJob(connection) {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      job_type: 'orders_backfill',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`sync_jobs insert failed: ${error.message}`);
  return data.id;
}

async function finishJob(jobId, status, payload) {
  const update = {
    status,
    finished_at: new Date().toISOString(),
  };
  if (status === 'success') update.result = payload;
  else update.error = String(payload?.error || payload).slice(0, 2000);
  await supabase.from('sync_jobs').update(update).eq('id', jobId);
}

async function loadConnections() {
  let q = supabase
    .from('shopify_connections')
    .select('*')
    .eq('is_active', true)
    .eq('sync_enabled', true)
    .not('access_token', 'is', null);

  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);

  const { data, error } = await q.order('shop_domain');
  if (error) throw new Error(`shopify_connections load failed: ${error.message}`);
  return (data || []).filter(connectionReadyForSync);
}

async function backfillConnection(connection) {
  let rangeStart;
  let rangeEnd;
  if (BACKFILL_START) {
    rangeStart = BACKFILL_START;
    rangeEnd = BACKFILL_END;
  } else {
    const days = BACKFILL_DAYS || connection.history_days_default || 365;
    ({ range_start: rangeStart, range_end: rangeEnd } = computeHistoryRange(new Date(), days));
  }

  const windows = planHistoryWindows(rangeStart, rangeEnd, CHUNK_DAYS);
  console.log(`[orders-backfill] ${connection.shop_domain}: ${rangeStart} → ${rangeEnd} (${windows.length} windows)`);

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };
  const syncedAt = new Date().toISOString();
  const skuMeta = await loadSkuMeta(headers, base);

  const jobId = await startJob(connection);
  let ordersTotal = 0;
  let linesTotal = 0;
  let ordersFetched = 0;
  try {
    for (const [i, win] of windows.entries()) {
      const orders = await fetchOrdersInWindow(headers, base, win.window_start, win.window_end);
      const facts = await upsertOrderFacts(supabase, connection, { orders, skuMeta, syncedAt, batchId: BATCH_ID });
      ordersFetched += orders.length;
      ordersTotal += facts.orders_upserted;
      linesTotal += facts.order_lines_upserted;
      console.log(`[orders-backfill] ${connection.shop_domain} window ${i + 1}/${windows.length} (${win.window_start}→${win.window_end}): ${facts.orders_upserted} orders, ${facts.order_lines_upserted} lines`);
    }
    const result = {
      job_type: 'orders_backfill',
      range_start: rangeStart,
      range_end: rangeEnd,
      windows: windows.length,
      orders_fetched: ordersFetched,
      orders_upserted: ordersTotal,
      order_lines_upserted: linesTotal,
    };
    await finishJob(jobId, 'success', result);
    return result;
  } catch (err) {
    await finishJob(jobId, 'error', { error: err.message || String(err) });
    throw err;
  }
}

async function main() {
  console.log(`[orders-backfill] batch=${BATCH_ID} chunk_days=${CHUNK_DAYS}`);

  const connections = await loadConnections();
  if (!connections.length) {
    console.log('[orders-backfill] no active connections with sync_enabled=true and scopes OK');
    return;
  }

  let hadError = false;
  const allResults = [];

  for (const connection of connections) {
    try {
      allResults.push({ shop_domain: connection.shop_domain, ...(await backfillConnection(connection)) });
    } catch (err) {
      hadError = true;
      console.error(`[error] ${connection.shop_domain}: ${err.message || err}`);
      allResults.push({ shop_domain: connection.shop_domain, error: String(err) });
    }
  }

  console.log('[orders-backfill] done', JSON.stringify(allResults, null, 2));
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[orders-backfill] fatal', err);
  process.exit(1);
});
