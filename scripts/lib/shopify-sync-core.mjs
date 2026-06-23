// Shared Shopify sync logic for Node (shopify-sync.mjs) and edge function (sync-core.ts).
// Keep windowing / row shapes in sync across both.

import crypto from 'node:crypto';
import { scopesMissingForJob } from './shopify-scopes.mjs';

export const SOURCE = 'shopify_api';
export const DEFAULT_API_VERSION = '2025-01';
export const DEFAULT_CHUNK_DAYS = 30;

export function hashRow(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex');
}

export function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a) > new Date(b) ? a : b;
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function normalizeShopifyLocationId(id) {
  const raw = String(id || '');
  if (raw.startsWith('gid://')) return raw;
  return raw;
}

function shopifyLocationKeys(id) {
  const raw = String(id || '');
  return [raw, `gid://shopify/Location/${raw}`];
}

export function normalizeLocationTag(connection, locationName) {
  const prefix = connection.location_tag_prefix
    ? `${slugify(connection.location_tag_prefix)}_`
    : '';
  const shopSlug = String(connection.shop_domain || '')
    .replace(/\.myshopify\.com$/i, '')
    .replace(/[^a-z0-9]+/gi, '_');
  return `${shopSlug}_${prefix}${slugify(locationName)}`.replace(/__+/g, '_');
}

export function grantedScopes(connection) {
  const raw = connection.scopes_granted;
  return Array.isArray(raw) ? raw : [];
}

export function readMeta(connection) {
  return connection.meta && typeof connection.meta === 'object' ? connection.meta : {};
}

export function isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchWithRetry(url, opts = {}, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get('retry-after')) || 2;
    await sleep(retryAfter * 1000);
  }
  return fetch(url, opts);
}

export async function getAll(headers, url) {
  let out = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl, { headers });
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    const firstKey = Object.keys(data || {})[0];
    const arr = firstKey ? data[firstKey] : [];
    out = out.concat(Array.isArray(arr) ? arr : []);

    const link = res.headers.get('link');
    const next = link?.split(',').find((l) => l.includes('rel="next"'));
    nextUrl = next?.match(/<([^>]+)>/)?.[1] || null;
  }

  return out;
}

function sumDiscountForLine(li) {
  return (li?.discount_allocations || []).reduce(
    (sum, d) => sum + Number(d?.amount || 0),
    0,
  );
}

function sumTaxForLine(li) {
  return (li?.tax_lines || []).reduce(
    (sum, t) => sum + Number(t?.price || 0),
    0,
  );
}

export function computeSinceISO(now, lastSyncAt, daysBack) {
  if (lastSyncAt) {
    const d = new Date(lastSyncAt);
    d.setDate(d.getDate() - 2);
    return d.toISOString();
  }
  const d = new Date(now);
  d.setDate(d.getDate() - Number(daysBack || 2));
  return d.toISOString();
}

export function computeHistoryRange(now, historyDays) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Number(historyDays || 90));
  return {
    range_start: isoDateOnly(start),
    range_end: isoDateOnly(end),
  };
}

export async function upsertInChunks(supabase, table, rows, onConflict, chunkSize = 500) {
  if (!rows.length) return 0;

  for (const group of chunk(rows, chunkSize)) {
    const { error } = await supabase.from(table).upsert(group, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }

  return rows.length;
}

export async function loadLocationMap(supabase, companyEntityId) {
  const { data, error } = await supabase
    .from('locations')
    .select('location_code, location_name, shopify_location_id')
    .eq('company_entity_id', companyEntityId)
    .not('shopify_location_id', 'is', null);

  if (error) throw new Error(`locations load failed: ${error.message}`);

  const byShopifyId = new Map();
  for (const row of data || []) {
    const tag = slugify(row.location_code || row.location_name);
    const entry = {
      location_tag: tag,
      location_name: row.location_name || row.location_code || tag,
    };
    for (const key of shopifyLocationKeys(row.shopify_location_id)) {
      byShopifyId.set(normalizeShopifyLocationId(key), entry);
    }
  }
  return byShopifyId;
}

export function resolveLocation(connection, shopifyLoc, dbMap) {
  for (const key of shopifyLocationKeys(shopifyLoc.id)) {
    const hit = dbMap.get(normalizeShopifyLocationId(key));
    if (hit) return hit;
  }

  const locationName = shopifyLoc.name || 'Unknown';
  return {
    location_tag: normalizeLocationTag(connection, locationName),
    location_name: locationName,
  };
}

export function buildSalesRow({
  companyEntityId,
  locationTag,
  locationName,
  shopDomain,
  orderDate,
  sku,
  productName,
  productType,
  vendorOriginal,
  qty,
  grossSales,
  discountAmount,
  refundAmount,
  taxAmount,
  shippingAmount,
  totalSales,
  syncedAt,
  batchId,
}) {
  const rowHash = hashRow([
    companyEntityId,
    locationTag,
    orderDate,
    sku || '',
    productName || '',
    SOURCE,
  ]);

  return {
    company_entity_id: companyEntityId,
    location_tag: locationTag,
    location_name: locationName,
    source: SOURCE,
    day_date: orderDate,
    product_name: productName || null,
    sku: sku || null,
    product_type: productType || null,
    vendor_original: vendorOriginal || null,
    total_quantity_sold: qty || 0,
    total_orders: 1,
    total_gross_sales: grossSales || 0,
    total_discounts: discountAmount || 0,
    total_refunds: refundAmount || 0,
    total_net_sales: (grossSales || 0) - (discountAmount || 0) - (refundAmount || 0),
    taxes: taxAmount || 0,
    shipping: shippingAmount || 0,
    total_sales: totalSales || 0,
    shop_domain: shopDomain,
    sync_batch_id: batchId,
    synced_at: syncedAt,
    row_hash: rowHash,
  };
}

export function collapseSalesRows(rows) {
  const byHash = new Map();

  for (const row of rows) {
    const existing = byHash.get(row.row_hash);
    if (!existing) {
      byHash.set(row.row_hash, { ...row });
      continue;
    }

    existing.total_quantity_sold += row.total_quantity_sold || 0;
    existing.total_orders += row.total_orders || 0;
    existing.total_gross_sales += Number(row.total_gross_sales || 0);
    existing.total_discounts += Number(row.total_discounts || 0);
    existing.total_refunds += Number(row.total_refunds || 0);
    existing.total_net_sales += Number(row.total_net_sales || 0);
    existing.taxes += Number(row.taxes || 0);
    existing.shipping += Number(row.shipping || 0);
    existing.total_sales += Number(row.total_sales || 0);
  }

  return [...byHash.values()];
}

async function loadSkuMeta(headers, base) {
  const variants = await getAll(headers, `${base}/variants.json?limit=250`);
  const products = await getAll(headers, `${base}/products.json?limit=250&status=active`);
  const productById = new Map(products.map((p) => [String(p.id), p]));
  const skuMeta = new Map();

  for (const v of variants) {
    if (!v?.sku) continue;
    const p = productById.get(String(v.product_id)) || {};
    skuMeta.set(v.sku, {
      product_title: (p.title || '').trim() || v.sku,
      product_type:
        p.product_type ||
        p.product_category?.product_taxonomy_node?.full_name ||
        null,
      vendor_original: p.vendor || null,
    });
  }

  return skuMeta;
}

async function loadLocationContext(supabase, connection, headers, base) {
  const dbLocationMap = await loadLocationMap(supabase, connection.company_entity_id);
  const locations = await getAll(headers, `${base}/locations.json?limit=250`);
  const locationById = new Map();
  const locationInfoById = new Map();

  for (const loc of locations) {
    const info = resolveLocation(connection, loc, dbLocationMap);
    locationById.set(String(loc.id), info.location_tag);
    locationInfoById.set(String(loc.id), info);
  }

  return { locations, locationById, locationInfoById };
}

export function ordersToSalesRows({
  orders,
  connection,
  locationById,
  locationInfoById,
  skuMeta,
  syncedAt,
  batchId,
}) {
  const domain = connection.shop_domain;
  const dayMap = new Map();
  let newestOrderStamp = null;

  for (const order of orders) {
    newestOrderStamp = maxIso(newestOrderStamp, order.created_at);

    const orderDate = (order.created_at || '').slice(0, 10);
    const orderLocId = order.location_id ? String(order.location_id) : null;
    const fallbackInfo = orderLocId ? locationInfoById.get(orderLocId) : null;
    const fallbackTag =
      fallbackInfo?.location_tag || normalizeLocationTag(connection, 'unknown');

    const orderShipping = Number(
      order?.current_total_shipping_price_set?.shop_money?.amount || 0,
    );
    const lineCount =
      Array.isArray(order.line_items) && order.line_items.length
        ? order.line_items.length
        : 1;

    for (const li of order.line_items || []) {
      if (!li?.sku) continue;

      const qty = Number(li.quantity || 0);
      const price = Number(li.price || 0);
      const discount = sumDiscountForLine(li);
      const tax = sumTaxForLine(li);

      const liLocId = li.location_id ? String(li.location_id) : orderLocId;
      const locInfo = liLocId
        ? locationInfoById.get(liLocId) || fallbackInfo
        : fallbackInfo;
      const locationTag = liLocId
        ? locationById.get(liLocId) || fallbackTag
        : fallbackTag;
      const locationName = locInfo?.location_name || locationTag;

      const grossSales = price * qty;
      const refundAmount = 0;
      const shippingAmount = orderShipping / lineCount;
      const totalSales = grossSales - discount - refundAmount + tax + shippingAmount;
      const metaSku = skuMeta.get(li.sku) || {};

      const key = [orderDate, locationTag, li.sku].join('||');
      const cur = dayMap.get(key);

      if (!cur) {
        dayMap.set(
          key,
          buildSalesRow({
            companyEntityId: connection.company_entity_id,
            locationTag,
            locationName,
            shopDomain: domain,
            orderDate,
            sku: li.sku,
            productName: metaSku.product_title || li.title || null,
            productType: metaSku.product_type || null,
            vendorOriginal: metaSku.vendor_original || null,
            qty,
            grossSales,
            discountAmount: discount,
            refundAmount,
            taxAmount: tax,
            shippingAmount,
            totalSales,
            syncedAt,
            batchId,
          }),
        );
      } else {
        cur.total_quantity_sold += qty;
        cur.total_orders += 1;
        cur.total_gross_sales += grossSales;
        cur.total_discounts += discount;
        cur.total_refunds += refundAmount;
        cur.total_net_sales += grossSales - discount - refundAmount;
        cur.taxes += tax;
        cur.shipping += shippingAmount;
        cur.total_sales += totalSales;
      }
    }
  }

  return {
    salesRows: collapseSalesRows([...dayMap.values()]),
    newestOrderStamp,
  };
}

export function planHistoryWindows(rangeStart, rangeEnd, chunkDays) {
  const windows = [];
  let cursor = rangeStart;
  while (cursor < rangeEnd) {
    const winStart = cursor;
    const winEnd = isoDateOnly(addDays(new Date(`${cursor}T00:00:00Z`), chunkDays));
    const cappedEnd = winEnd > rangeEnd ? rangeEnd : winEnd;
    windows.push({ window_start: winStart, window_end: cappedEnd });
    if (cappedEnd === rangeEnd) break;
    cursor = cappedEnd;
  }
  return windows;
}

export function initHistoryBackfillState({
  historyDays,
  chunkDays = DEFAULT_CHUNK_DAYS,
  now = new Date(),
}) {
  const { range_start, range_end } = computeHistoryRange(now, historyDays);
  const windows = planHistoryWindows(range_start, range_end, chunkDays);
  return {
    status: 'running',
    target_days: historyDays,
    chunk_days: chunkDays,
    range_start,
    range_end,
    cursor: range_start,
    windows_done: 0,
    windows_total: windows.length,
    orders_total: 0,
    sales_rows_total: 0,
    started_at: now.toISOString(),
  };
}

export function nextHistoryWindow(state) {
  if (!state || state.status !== 'running') return null;
  const { cursor, range_end, chunk_days: chunkDays } = state;
  if (!cursor || cursor >= range_end) return null;

  const windowStart = cursor;
  const rawEnd = isoDateOnly(addDays(new Date(`${cursor}T00:00:00Z`), chunkDays || DEFAULT_CHUNK_DAYS));
  const windowEnd = rawEnd > range_end ? range_end : rawEnd;
  return { window_start: windowStart, window_end: windowEnd };
}

export async function fetchOrdersInWindow(headers, base, windowStart, windowEnd) {
  const minIso = new Date(`${windowStart}T00:00:00Z`).toISOString();
  const maxIsoStr = new Date(`${windowEnd}T23:59:59Z`).toISOString();
  return getAll(
    headers,
    `${base}/orders.json?status=any&created_at_min=${encodeURIComponent(minIso)}&created_at_max=${encodeURIComponent(maxIsoStr)}&limit=250`,
  );
}

export async function runHistoryChunk(supabase, connection, {
  batchId,
  skuMetaCache = null,
  locationContextCache = null,
} = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'history_import');
  if (missing.length) {
    return { skipped: true, missing };
  }

  const meta = readMeta(connection);
  const state = meta.history_backfill;
  if (!state || state.status !== 'running') {
    throw new Error('No active history backfill on this connection');
  }

  const win = nextHistoryWindow(state);
  if (!win) {
    return { done: true, state: { ...state, status: 'complete', completed_at: new Date().toISOString() } };
  }

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };
  const syncedAt = new Date().toISOString();

  const locationContext = locationContextCache || await loadLocationContext(supabase, connection, headers, base);
  const skuMeta = skuMetaCache || await loadSkuMeta(headers, base);
  const orders = await fetchOrdersInWindow(headers, base, win.window_start, win.window_end);
  const { salesRows, newestOrderStamp } = ordersToSalesRows({
    orders,
    connection,
    locationById: locationContext.locationById,
    locationInfoById: locationContext.locationInfoById,
    skuMeta,
    syncedAt,
    batchId,
  });

  const upserted = await upsertInChunks(supabase, 'sales_by_day', salesRows, 'row_hash');

  const nextState = {
    ...state,
    cursor: win.window_end,
    windows_done: (state.windows_done || 0) + 1,
    orders_total: (state.orders_total || 0) + orders.length,
    sales_rows_total: (state.sales_rows_total || 0) + upserted,
    last_window: win,
    last_newest_order_stamp: newestOrderStamp,
    updated_at: syncedAt,
  };

  if (nextState.cursor >= nextState.range_end) {
    nextState.status = 'complete';
    nextState.completed_at = syncedAt;
  }

  return {
    done: nextState.status === 'complete',
    state: nextState,
    chunk: {
      window_start: win.window_start,
      window_end: win.window_end,
      orders_fetched: orders.length,
      sales_rows_upserted: upserted,
    },
    caches: { locationContext, skuMeta },
  };
}

export async function runInventorySnapshot(supabase, connection, { batchId } = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'inventory_snapshot');
  if (missing.length) {
    return { skipped: true, missing };
  }

  const snapshotAt = new Date().toISOString();
  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const domain = connection.shop_domain;
  const base = `https://${domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };

  const dbLocationMap = await loadLocationMap(supabase, connection.company_entity_id);
  const locations = await getAll(headers, `${base}/locations.json?limit=250`);
  const variants = await getAll(headers, `${base}/variants.json?limit=250`);
  const products = await getAll(headers, `${base}/products.json?limit=250&status=active`);
  const productById = new Map(products.map((p) => [String(p.id), p]));

  const skuByInvItem = new Map();
  const skuMeta = new Map();

  for (const v of variants) {
    if (!v?.sku) continue;
    const p = productById.get(String(v.product_id)) || {};
    const imageUrl =
      p.image?.src || (Array.isArray(p.images) && p.images[0]?.src) || null;

    skuByInvItem.set(String(v.inventory_item_id), v.sku);
    skuMeta.set(v.sku, {
      product_title: (p.title || '').trim() || v.sku,
      variant_title: v.title && v.title !== 'Default Title' ? v.title : null,
      product_type:
        p.product_type ||
        p.product_category?.product_taxonomy_node?.full_name ||
        null,
      variant_barcode: v.barcode || null,
      product_image_url: imageUrl,
    });
  }

  const invRows = [];

  for (const loc of locations) {
    const locId = String(loc.id);
    const { location_tag: locationTag, location_name: locationName } = resolveLocation(
      connection,
      loc,
      dbLocationMap,
    );

    const levels = await getAll(
      headers,
      `${base}/inventory_levels.json?location_ids=${encodeURIComponent(locId)}&limit=250`,
    );

    for (const lvl of levels) {
      const sku = skuByInvItem.get(String(lvl.inventory_item_id));
      if (!sku) continue;

      const metaSku = skuMeta.get(sku) || {};
      invRows.push({
        company_entity_id: connection.company_entity_id,
        location_tag: locationTag,
        location_name: locationName,
        source: SOURCE,
        location: loc.name || null,
        product_title: metaSku.product_title || sku,
        variant_title: metaSku.variant_title || null,
        variant_sku: sku,
        shop_domain: domain,
        variant_barcode: metaSku.variant_barcode || null,
        product_type: metaSku.product_type || null,
        product_image: null,
        product_image_url: metaSku.product_image_url || null,
        total_available_quantity: Number(lvl.available ?? 0),
        snapshot_at: snapshotAt,
        sync_batch_id: batchId,
        row_hash: hashRow([
          connection.company_entity_id,
          locationTag,
          sku,
          snapshotAt,
        ]),
      });
    }
  }

  const upserted = await upsertInChunks(supabase, 'inventory_on_hand', invRows, 'row_hash');

  return {
    job_type: 'inventory_snapshot',
    locations: locations.length,
    inventory_rows_upserted: upserted,
    snapshot_at: snapshotAt,
  };
}

export async function runIncrementalSales(supabase, connection, {
  batchId,
  daysBack = 2,
} = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'incremental_sales');
  if (missing.length) {
    return { skipped: true, missing };
  }

  const now = new Date();
  const syncedAt = now.toISOString();
  const meta = readMeta(connection);
  const sinceISO = computeSinceISO(now, meta.last_order_sync_at, daysBack);

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };

  const locationContext = await loadLocationContext(supabase, connection, headers, base);
  const skuMeta = await loadSkuMeta(headers, base);
  const orders = await getAll(
    headers,
    `${base}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceISO)}&limit=250`,
  );

  const { salesRows, newestOrderStamp } = ordersToSalesRows({
    orders,
    connection,
    locationById: locationContext.locationById,
    locationInfoById: locationContext.locationInfoById,
    skuMeta,
    syncedAt,
    batchId,
  });

  const upserted = await upsertInChunks(supabase, 'sales_by_day', salesRows, 'row_hash');

  return {
    job_type: 'incremental_sales',
    window_since: sinceISO.slice(0, 10),
    orders_fetched: orders.length,
    sales_rows_upserted: upserted,
    newest_order_stamp: newestOrderStamp,
    last_order_sync_at: newestOrderStamp || syncedAt,
    last_sales_sync_at: syncedAt,
  };
}

export async function runWindowedHistory(supabase, connection, {
  batchId,
  historyDays,
  chunkDays = DEFAULT_CHUNK_DAYS,
}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'history_import');
  if (missing.length) {
    return { skipped: true, missing };
  }

  let meta = readMeta(connection);
  let state = meta.history_backfill;

  if (!state || state.status !== 'running') {
    state = initHistoryBackfillState({ historyDays, chunkDays });
    meta = { ...meta, history_backfill: state };
    await supabase.from('shopify_connections').update({ meta }).eq('id', connection.id);
    connection.meta = meta;
  }

  const chunks = [];
  let caches = null;

  while (state.status === 'running') {
    const result = await runHistoryChunk(supabase, connection, {
      batchId,
      skuMetaCache: caches?.skuMeta,
      locationContextCache: caches?.locationContext,
    });

    if (result.done && !result.chunk) break;

    caches = result.caches;
    state = result.state;
    meta = { ...readMeta(connection), history_backfill: state };
    await supabase.from('shopify_connections').update({ meta }).eq('id', connection.id);
    connection.meta = meta;

    if (result.chunk) chunks.push(result.chunk);
    if (result.done) break;
  }

  return {
    job_type: 'history_import',
    history_days: historyDays,
    chunk_days: chunkDays,
    windows_done: state.windows_done,
    windows_total: state.windows_total,
    orders_total: state.orders_total,
    sales_rows_total: state.sales_rows_total,
    chunks,
    status: state.status,
  };
}
