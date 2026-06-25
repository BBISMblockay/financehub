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

function moneyAmount(priceSet) {
  return Number(priceSet?.shop_money?.amount || 0);
}

function firstOrderMoney(order, ...keys) {
  for (const key of keys) {
    const amount = moneyAmount(order?.[key]);
    if (amount) return amount;
  }
  return 0;
}

/** Refund subtotal + tax per line_item_id from order.refunds */
export function buildLineItemRefundMap(order) {
  const map = new Map();
  for (const refund of order?.refunds || []) {
    for (const rli of refund?.refund_line_items || []) {
      const id = String(rli.line_item_id);
      const prev = map.get(id) || { subtotal: 0, tax: 0 };
      prev.subtotal += Number(rli.subtotal || 0);
      prev.tax += Number(rli.total_tax || 0);
      map.set(id, prev);
    }
  }
  return map;
}

function sumRefundShipping(order) {
  let total = 0;
  for (const refund of order?.refunds || []) {
    for (const rsl of refund?.refund_shipping_lines || []) {
      total += moneyAmount(rsl.subtotal_amount_set)
        || Number(rsl.subtotal || 0);
    }
    for (const adj of refund?.order_adjustments || []) {
      const kind = String(adj?.kind || '').toLowerCase();
      if (kind.includes('shipping')) {
        total += Math.abs(Number(adj.amount || 0));
      }
    }
  }
  return total;
}

function allocatePerLine(orderAmount, lineCount) {
  const count = Math.max(Number(lineCount) || 1, 1);
  return Number(orderAmount || 0) / count;
}

function computeTotalSales({
  grossSales,
  discountAmount,
  refundAmount,
  shippingAmount,
  dutiesAmount,
  additionalFeesAmount,
  taxAmount,
}) {
  const net =
    Number(grossSales || 0)
    - Number(discountAmount || 0)
    - Number(refundAmount || 0);
  return (
    net
    + Number(shippingAmount || 0)
    + Number(dutiesAmount || 0)
    + Number(additionalFeesAmount || 0)
    + Number(taxAmount || 0)
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
  const byShopifyId = new Map();

  // Primary source: shopify_location_mappings (set via integrations UI)
  const { data: mappings, error: mappingsError } = await supabase
    .from('shopify_location_mappings')
    .select('shopify_location_id, silo_location_code, location_id')
    .eq('company_entity_id', companyEntityId);

  if (mappingsError) throw new Error(`shopify_location_mappings load failed: ${mappingsError.message}`);

  // Fetch location names for mapped location_ids
  const locationIds = [...new Set((mappings || []).map((m) => m.location_id).filter(Boolean))];
  const nameById = new Map();
  if (locationIds.length) {
    const { data: locs, error: locsError } = await supabase
      .from('locations')
      .select('id, location_name')
      .in('id', locationIds);
    if (locsError) throw new Error(`locations name load failed: ${locsError.message}`);
    for (const l of locs || []) nameById.set(l.id, l.location_name);
  }

  for (const m of mappings || []) {
    const tag = slugify(m.silo_location_code);
    const entry = {
      location_tag: tag,
      location_name: nameById.get(m.location_id) || m.silo_location_code || tag,
    };
    for (const key of shopifyLocationKeys(m.shopify_location_id)) {
      byShopifyId.set(normalizeShopifyLocationId(key), entry);
    }
  }

  // Fallback: locations.shopify_location_id (legacy direct mapping)
  const { data, error } = await supabase
    .from('locations')
    .select('location_code, location_name, shopify_location_id')
    .eq('company_entity_id', companyEntityId)
    .not('shopify_location_id', 'is', null);

  if (error) throw new Error(`locations load failed: ${error.message}`);

  for (const row of data || []) {
    const tag = slugify(row.location_code || row.location_name);
    const entry = {
      location_tag: tag,
      location_name: row.location_name || row.location_code || tag,
    };
    for (const key of shopifyLocationKeys(row.shopify_location_id)) {
      // Don't overwrite a mapping already set via shopify_location_mappings
      if (!byShopifyId.has(normalizeShopifyLocationId(key))) {
        byShopifyId.set(normalizeShopifyLocationId(key), entry);
      }
    }
  }

  return byShopifyId;
}

/** SILO locations explicitly linked via locations.shopify_location_id */
export async function loadSiloMappedLocations(supabase, companyEntityId) {
  const { data, error } = await supabase
    .from('locations')
    .select('location_code, location_name, shopify_location_id')
    .eq('company_entity_id', companyEntityId)
    .not('shopify_location_id', 'is', null);

  if (error) throw new Error(`locations load failed: ${error.message}`);

  return (data || []).map((row) => {
    const tag = slugify(row.location_code || row.location_name);
    return {
      location_tag: tag,
      location_name: row.location_name || row.location_code || tag,
      shopify_location_id: String(row.shopify_location_id),
    };
  });
}

function buildSiloMappedByShopifyId(siloMappedLocations) {
  const map = new Map();
  for (const entry of siloMappedLocations || []) {
    for (const key of shopifyLocationKeys(entry.shopify_location_id)) {
      map.set(normalizeShopifyLocationId(key), entry);
    }
  }
  return map;
}

/** Shopify location ids present on an order payload (no extra API calls). */
export function shopifyLocationIdsOnOrder(order) {
  const ids = [];
  const add = (id) => {
    const raw = id != null && id !== '' ? String(id) : null;
    if (raw && !ids.includes(raw)) ids.push(raw);
  };

  add(order?.location_id);
  for (const f of order?.fulfillments || []) add(f?.location_id);
  for (const li of order?.line_items || []) add(li?.location_id);

  return ids;
}

/**
 * Resolve SILO location_tag/name for sales_by_day aggregation only.
 * Uses Shopify location ids when present, then SILO shopify_location_id mapping.
 * Does not alter product/order metadata fields.
 */
export function resolveSalesRowLocation({
  order,
  lineItem,
  locationMap,
  connection,
}) {
  const candidateIds = [];
  if (lineItem?.location_id) candidateIds.push(String(lineItem.location_id));
  for (const id of shopifyLocationIdsOnOrder(order)) {
    if (!candidateIds.includes(id)) candidateIds.push(id);
  }

  for (const id of candidateIds) {
    for (const key of shopifyLocationKeys(id)) {
      const hit = locationMap.get(normalizeShopifyLocationId(key));
      if (hit) return { location_tag: hit.location_tag, location_name: hit.location_name };
    }
  }

  // No location_id on order — if exactly one mapping exists for this connection, use it
  if (!candidateIds.length && locationMap.size === 1) {
    const hit = [...locationMap.values()][0];
    return { location_tag: hit.location_tag, location_name: hit.location_name };
  }

  // No mapping found — skip this row rather than writing a garbage unknown tag
  return null;
}

export async function purgeShopifySalesForCompany(supabase, companyEntityId) {
  const { error } = await supabase
    .from('sales_by_day')
    .delete()
    .eq('company_entity_id', companyEntityId)
    .eq('source', SOURCE);

  if (error) throw new Error(`sales_by_day purge failed: ${error.message}`);
}

export async function purgeShopifyInventoryForConnection(supabase, companyEntityId, shopDomain) {
  const { error } = await supabase
    .from('inventory_on_hand')
    .delete()
    .eq('company_entity_id', companyEntityId)
    .eq('shop_domain', shopDomain)
    .eq('source', SOURCE);

  if (error) throw new Error(`inventory_on_hand purge failed: ${error.message}`);
}

export function resolveLocation(connection, shopifyLoc, dbMap) {
  for (const key of shopifyLocationKeys(shopifyLoc.id)) {
    const hit = dbMap.get(normalizeShopifyLocationId(key));
    if (hit) return hit;
  }

  // No mapping found — skip this location rather than writing a garbage unknown tag
  return null;
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
  dutiesAmount = 0,
  additionalFeesAmount = 0,
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

  const netSales =
    Number(grossSales || 0)
    - Number(discountAmount || 0)
    - Number(refundAmount || 0);
  const resolvedTotalSales = totalSales ?? computeTotalSales({
    grossSales,
    discountAmount,
    refundAmount,
    shippingAmount,
    dutiesAmount,
    additionalFeesAmount,
    taxAmount,
  });

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
    total_net_sales: netSales,
    taxes: taxAmount || 0,
    shipping: shippingAmount || 0,
    total_sales: resolvedTotalSales,
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

export async function fetchShopifyLocations(connection) {
  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };
  const locations = await getAll(headers, `${base}/locations.json?limit=250`);
  return (locations || []).map((loc) => ({
    id: String(loc.id),
    name: loc.name || '',
    active: loc.active !== false,
    address1: loc.address1 || null,
    city: loc.city || null,
    province: loc.province || null,
    country: loc.country || null,
  }));
}

async function loadLocationContext(supabase, connection, headers, base) {
  const [dbLocationMap, siloMappedLocations] = await Promise.all([
    loadLocationMap(supabase, connection.company_entity_id),
    loadSiloMappedLocations(supabase, connection.company_entity_id),
  ]);
  const siloMappedByShopifyId = buildSiloMappedByShopifyId(siloMappedLocations);
  const locations = await getAll(headers, `${base}/locations.json?limit=250`);
  const locationById = new Map();
  const locationInfoById = new Map();

  for (const loc of locations) {
    const info = resolveLocation(connection, loc, dbLocationMap);
    if (!info) {
      console.warn(`[inventory] No mapping for Shopify location "${loc.name}" (${loc.id}) — skipping`);
      continue;
    }
    locationById.set(String(loc.id), info.location_tag);
    locationInfoById.set(String(loc.id), info);
  }

  return {
    locations,
    locationById,
    locationInfoById,
    siloMappedLocations,
    siloMappedByShopifyId,
    dbLocationMap,
  };
}

export function ordersToSalesRows({
  orders,
  connection,
  locationMap,
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

    const lineItems = (order.line_items || []).filter((li) => li?.sku);
    const lineCount = lineItems.length || 1;
    const refundMap = buildLineItemRefundMap(order);

    const orderShippingGross = firstOrderMoney(
      order,
      'total_shipping_price_set',
      'current_total_shipping_price_set',
    );
    const orderShippingNet = Math.max(0, orderShippingGross - sumRefundShipping(order));
    const orderDuties = firstOrderMoney(
      order,
      'original_total_duties_set',
      'total_duties_set',
      'current_total_duties_set',
    );
    const orderAdditionalFees = firstOrderMoney(
      order,
      'original_total_additional_fees_set',
      'current_total_additional_fees_set',
    );

    const shippingShare = allocatePerLine(orderShippingNet, lineCount);
    const dutiesShare = allocatePerLine(orderDuties, lineCount);
    const feesShare = allocatePerLine(orderAdditionalFees, lineCount);

    for (const li of lineItems) {
      const qty = Number(li.quantity || 0);
      const price = Number(li.price || 0);
      const discount = sumDiscountForLine(li);
      const lineRefund = refundMap.get(String(li.id)) || { subtotal: 0, tax: 0 };
      const refundAmount = lineRefund.subtotal;
      const tax = Math.max(0, sumTaxForLine(li) - lineRefund.tax);

      const resolvedLoc = resolveSalesRowLocation({
        order,
        lineItem: li,
        locationMap,
        connection,
      });
      if (!resolvedLoc) continue;
      const { location_tag: locationTag, location_name: locationName } = resolvedLoc;

      const grossSales = price * qty;
      const totalSales = computeTotalSales({
        grossSales,
        discountAmount: discount,
        refundAmount,
        shippingAmount: shippingShare,
        dutiesAmount: dutiesShare,
        additionalFeesAmount: feesShare,
        taxAmount: tax,
      });
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
            shippingAmount: shippingShare,
            dutiesAmount: dutiesShare,
            additionalFeesAmount: feesShare,
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
        cur.shipping += shippingShare;
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
    locationMap: locationContext.dbLocationMap,
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

  // Collapse by (locId, sku) — same SKU can appear on multiple inventory items
  // at the same location; sum quantities so the upsert batch has no duplicates.
  const invByKey = new Map();

  for (const loc of locations) {
    const locId = String(loc.id);
    const resolvedLoc = resolveLocation(connection, loc, dbLocationMap);
    if (!resolvedLoc) {
      console.warn(`[inventory] No mapping for Shopify location "${loc.name}" (${loc.id}) — skipping`);
      continue;
    }
    const { location_tag: locationTag, location_name: locationName } = resolvedLoc;

    const levels = await getAll(
      headers,
      `${base}/inventory_levels.json?location_ids=${encodeURIComponent(locId)}&limit=250`,
    );

    for (const lvl of levels) {
      const sku = skuByInvItem.get(String(lvl.inventory_item_id));
      if (!sku) continue;

      const rowHash = hashRow([connection.company_entity_id, locId, sku, snapshotAt]);
      const existing = invByKey.get(rowHash);
      if (existing) {
        existing.total_available_quantity += Number(lvl.available ?? 0);
        continue;
      }

      const metaSku = skuMeta.get(sku) || {};
      invByKey.set(rowHash, {
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
        row_hash: rowHash,
      });
    }
  }

  const invRows = [...invByKey.values()];

  await purgeShopifyInventoryForConnection(supabase, connection.company_entity_id, domain);
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
    locationMap: locationContext.dbLocationMap,
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
    await purgeShopifySalesForCompany(supabase, connection.company_entity_id);
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
