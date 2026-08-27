// Shared Shopify sync logic for Node (shopify-sync.mjs) and edge function (sync-core.ts).
// Keep windowing / row shapes in sync across both.

import crypto from 'node:crypto';
import { scopesMissingForJob } from './shopify-scopes.mjs';

export const SOURCE = 'shopify_api';
export const DEFAULT_API_VERSION = '2025-01';
export const DEFAULT_CHUNK_DAYS = 30;
/** Smaller windows for Integrations UI / edge functions (CPU limit ~30s). */
export const DEFAULT_UI_CHUNK_DAYS = 7;

/** Shopify variant.price (string dollars) → unit retail for inventory value. */
export function variantUnitPrice(variant) {
  const n = Number(variant?.price);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

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

/** No timeout on the underlying fetch() left a stalled Shopify connection
 * hanging ~28min before Node killed it with `TypeError: terminated`,
 * aborting the whole shop's sync with a partial day already written.
 * Bound each attempt and retry transient failures (timeouts, network
 * errors) the same way we already retry 429s. */
const FETCH_TIMEOUT_MS = 60_000;

export async function fetchWithRetry(url, opts = {}, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status !== 429) return res;
      const retryAfter = Number(res.headers.get('retry-after')) || 2;
      await sleep(retryAfter * 1000);
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(2000);
    }
  }
  throw lastErr || new Error(`fetchWithRetry: exhausted retries for ${url}`);
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

function getShopifyItemType(li) {
  return (li?.properties || []).find((p) => p?.name === '_shopify_item_type')?.value || null;
}

// Last-resort classification for line items with no catalog product_type and
// no _shopify_item_type property -- covers synthetic promo SKUs (bundles,
// combos, archive/mystery packs) and the Redo checkout package-protection
// add-on, none of which exist as real Shopify catalog products. Without this
// they land in "Uncategorized" on product-type reports even though they're
// easily identifiable by SKU/title.
function inferFallbackProductType(sku, name) {
  const s = String(sku || '').trim().toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  if (s === 'x-redo') return 'Package Protection';
  if (/bundle|combo|mystery\s*(box|pack)|archive\s*(top|shorts|mystery)\s*pack/.test(`${s} ${n}`)) {
    return 'Bundles & Multi-Packs';
  }
  if (/\bfor \$\d/.test(n)) return 'Bundles & Multi-Packs';
  return null;
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

/** Transient DB failures (statement/lock timeouts under concurrent load)
 * used to kill multi-hour history imports on a single failed chunk --
 * a 3.5h 730-day online rebuild died at 95% on exactly this. Retry each
 * chunk with backoff, splitting it in half on the final attempts so a
 * temporarily-contended table gets smaller, faster statements. */
const TRANSIENT_DB_ERROR = /statement timeout|lock timeout|canceling statement|deadlock detected|connection/i;

export async function upsertInChunks(supabase, table, rows, onConflict, chunkSize = 500) {
  if (!rows.length) return 0;

  for (const group of chunk(rows, chunkSize)) {
    let lastMessage = null;
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const pieces = attempt < 2 ? [group] : chunk(group, Math.ceil(group.length / 2));
      lastMessage = null;
      for (const piece of pieces) {
        const { error } = await supabase.from(table).upsert(piece, { onConflict });
        if (error) { lastMessage = error.message; break; }
      }
      if (!lastMessage) { done = true; break; }
      if (!TRANSIENT_DB_ERROR.test(lastMessage)) break;
      await sleep(2000 * (attempt + 1));
    }
    if (!done) throw new Error(`${table} upsert failed: ${lastMessage}`);
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

  // Fall back to the connection's default_location_code (set per-store in shopify_connections)
  if (connection?.default_location_code) {
    const tag = slugify(connection.default_location_code);
    return { location_tag: tag, location_name: connection.default_location_code };
  }

  // No mapping found — skip this row rather than writing a garbage unknown tag
  return null;
}

/** Remove shopify_api sales for one shop only (safe for multi-store companies). */
export async function purgeShopifySalesForShop(supabase, companyEntityId, shopDomain) {
  // High-volume shops (main store: ~400k rows) exceed the API statement
  // timeout on a single DELETE — walk the date range in 60-day slices.
  const { data: oldest, error: boundsError } = await supabase
    .from('sales_by_day')
    .select('day_date')
    .eq('company_entity_id', companyEntityId)
    .eq('shop_domain', shopDomain)
    .eq('source', SOURCE)
    .order('day_date', { ascending: true })
    .limit(1);
  if (boundsError) throw new Error(`sales_by_day purge failed: ${boundsError.message}`);
  if (!oldest?.length) return;

  let cursor = oldest[0].day_date;
  const end = isoDateOnly(addDays(new Date(), 2));
  while (cursor <= end) {
    const sliceEnd = isoDateOnly(addDays(new Date(`${cursor}T00:00:00Z`), 60));
    const { error } = await supabase
      .from('sales_by_day')
      .delete()
      .eq('company_entity_id', companyEntityId)
      .eq('shop_domain', shopDomain)
      .eq('source', SOURCE)
      .gte('day_date', cursor)
      .lt('day_date', sliceEnd);
    if (error) throw new Error(`sales_by_day purge failed: ${error.message}`);
    cursor = sliceEnd;
  }
}

/** @deprecated Prefer purgeShopifySalesForShop — company-wide purge breaks multi-store imports. */
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
    shopDomain || '',
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

/**
 * Negative row for a refund, dated by the refund's processed date (Shopify
 * sales-report / Better Reports parity). Hashed per order + date + sku:
 * refunds are immutable in Shopify, so these rows are additive-only — they
 * are marked total_orders = 0 and exempted from day-rebuild deletes.
 */
export function buildRefundRow({
  companyEntityId,
  locationTag,
  locationName,
  shopDomain,
  refundDate,
  sku,
  productName,
  productType,
  vendorOriginal,
  orderId,
  qtyDelta,
  refundAmount,
  taxDelta,
  shippingDelta,
  netDelta,
  totalDelta,
  syncedAt,
  batchId,
}) {
  const rowHash = hashRow([
    companyEntityId,
    locationTag,
    refundDate,
    sku || '',
    productName || '',
    shopDomain || '',
    String(orderId ?? ''),
    'refund',
    SOURCE,
  ]);

  return {
    company_entity_id: companyEntityId,
    location_tag: locationTag,
    location_name: locationName,
    source: SOURCE,
    day_date: refundDate,
    product_name: productName || null,
    sku: sku || null,
    product_type: productType || null,
    vendor_original: vendorOriginal || null,
    total_quantity_sold: qtyDelta || 0,
    total_orders: 0,
    total_gross_sales: 0,
    total_discounts: 0,
    total_refunds: refundAmount || 0,
    total_net_sales: netDelta || 0,
    taxes: taxDelta || 0,
    shipping: shippingDelta || 0,
    total_sales: totalDelta || 0,
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

/** Used only by loadSkuMeta below, which labels historical sales with a
 * product name/type regardless of whether the product is still sellable
 * today — active-only would mismatch a variant to no product once its
 * parent is archived/unpublished on this store, silently falling back to
 * the SKU as the "name" for every sale of it from then on. runCatalogSync
 * and runInventorySnapshot intentionally keep status=active: they reflect
 * the current sellable catalog, not historical labeling. */
const PRODUCT_STATUSES_FOR_LABELING = ['active', 'archived', 'draft'];

export async function loadSkuMeta(headers, base) {
  const [variants, ...productsByStatus] = await Promise.all([
    getAll(headers, `${base}/variants.json?limit=250`),
    ...PRODUCT_STATUSES_FOR_LABELING.map((status) => getAll(headers, `${base}/products.json?limit=250&status=${status}`)),
  ]);
  const productById = new Map();
  for (const products of productsByStatus) {
    for (const p of products) productById.set(String(p.id), p);
  }
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

export function serializeSkuMetaCache(skuMeta) {
  if (!skuMeta || !(skuMeta instanceof Map)) return null;
  return Object.fromEntries(skuMeta);
}

export function deserializeSkuMetaCache(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return new Map(Object.entries(raw));
}

/** Recompute window counts from cursor (accurate after retries / CPU-limit interrupts). */
export function computeBackfillProgress(state) {
  if (!state?.range_start || !state?.range_end) return state;
  const chunkDays = state.chunk_days || DEFAULT_CHUNK_DAYS;
  const windows = planHistoryWindows(state.range_start, state.range_end, chunkDays);
  const windowsTotal = windows.length;
  let windowsDone = 0;
  const cursor = state.cursor;
  if (cursor) {
    for (const win of windows) {
      if (win.window_end <= cursor) windowsDone += 1;
      else break;
    }
  }
  return {
    ...state,
    windows_total: windowsTotal,
    windows_done: windowsDone,
  };
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
  const refundRows = [];
  let newestOrderStamp = null;
  let newestUpdatedStamp = null;
  const skipped = { cancelled_orders: 0, gift_card_lines: 0, no_location_lines: 0 };

  for (const order of orders) {
    newestUpdatedStamp = maxIso(newestUpdatedStamp, order.updated_at || order.created_at);

    // Shopify sales reports INCLUDE cancelled orders: the sale stays on the
    // books and any cancellation refund shows up as a Return dated when it
    // was processed. Skipping them hid $24.3k gross / $23.0k discounts of
    // cancelled TikTok-Shop "Seller discount" orders on 2026-06-07 alone —
    // the bulk of the BI-vs-Shopify report variance. Only test orders are
    // excluded. cancelled_orders is still counted for observability.
    if (order.test) continue;
    if (order.cancelled_at) skipped.cancelled_orders += 1;

    newestOrderStamp = maxIso(newestOrderStamp, order.created_at);

    const orderDate = (order.created_at || '').slice(0, 10);

    // Gift card sales are liabilities, not sales, in Shopify reporting.
    skipped.gift_card_lines += (order.line_items || []).filter((li) => li?.gift_card).length;
    const lineItems = (order.line_items || []).filter((li) => !li?.gift_card && (li?.sku || li?.title || Number(li?.price) > 0 || getShopifyItemType(li)));
    const lineCount = lineItems.length || 1;

    // total_shipping_price_set is the PRE-discount shipping charge. Shopify
    // sales reports show shipping net of shipping discounts (e.g. a 100%-off
    // "Baseballism Fast Pass" code books as $0, not $9.99), and that discount
    // lives only on shipping_lines[].discounted_price(_set) — no refund object
    // is created. Refunded shipping stays separate: it's booked as negative
    // [Shipping] rows on the refund's processed date below.
    const shippingLines = Array.isArray(order.shipping_lines) ? order.shipping_lines : [];
    const orderShippingGross = shippingLines.length
      ? shippingLines.reduce((sum, sl) => {
        const set = sl?.discounted_price_set || sl?.price_set;
        return sum + (set ? moneyAmount(set) : Number(sl?.discounted_price ?? sl?.price ?? 0));
      }, 0)
      : firstOrderMoney(order, 'total_shipping_price_set', 'current_total_shipping_price_set');
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

    // Tax charged on shipping lives on shipping_lines[].tax_lines, never on a
    // line_item — Shopify's Taxes column includes it, so allocate it per line
    // alongside the shipping charge itself.
    const orderShippingTax = (order.shipping_lines || []).reduce(
      (sum, sl) => sum + (sl?.tax_lines || []).reduce((s, t) => s + Number(t?.price || 0), 0),
      0,
    );

    const shippingShare = allocatePerLine(orderShippingGross, lineCount);
    const shippingTaxShare = allocatePerLine(orderShippingTax, lineCount);
    const dutiesShare = allocatePerLine(orderDuties, lineCount);
    const feesShare = allocatePerLine(orderAdditionalFees, lineCount);

    for (const li of lineItems) {
      const qty = Number(li.quantity || 0);
      const price = Number(li.price || 0);
      const discount = sumDiscountForLine(li);
      // Refunds are NOT netted into the sale day — they're booked as negative
      // rows on the refund's processed date below (Shopify report parity).
      const refundAmount = 0;
      const tax = sumTaxForLine(li) + shippingTaxShare;

      const resolvedLoc = resolveSalesRowLocation({
        order,
        lineItem: li,
        locationMap,
        connection,
      });
      if (!resolvedLoc) {
        skipped.no_location_lines += 1;
        continue;
      }
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
      const shopifyItemType = getShopifyItemType(li);
      const effectiveSku = li.sku || li.title || shopifyItemType || 'None';
      const metaSku = (li.sku && skuMeta.get(li.sku)) || {};
      // li.title is the real per-order-line product name. skuMeta is keyed by
      // SKU alone and silently picks one arbitrary product's title/type when
      // two Shopify listings share a SKU (a renamed/relisted product, or a
      // duplicate never-launched variant) -- see the 2026-08-21 "Doubles and
      // Bubbles Cap - Toddler" misattribution, where a never-launched product
      // sharing a SKU with the real Youth cap collected its sales. Preferring
      // li.title, and folding it into the merge key below, keeps same-SKU
      // products as separate sales_by_day rows instead of one merged row
      // stamped with whichever title happened to win the catalog lookup.
      const productName = li.title || metaSku.product_title || null;

      const key = [orderDate, locationTag, effectiveSku, productName].join('||');
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
            sku: effectiveSku,
            productName,
            productType:
              metaSku.product_type ||
              shopifyItemType ||
              inferFallbackProductType(effectiveSku, metaSku.product_title || li.title),
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

    // Returns: negative rows dated by the refund's processed date, matching
    // Shopify sales reports / Better Reports (which book money-out on the day
    // it happened, not as a restatement of the original order day).
    const lineItemById = new Map((order.line_items || []).map((li) => [String(li.id), li]));

    for (const refund of order.refunds || []) {
      const refundDate = (refund.processed_at || refund.created_at || '').slice(0, 10);
      if (!refundDate) continue;

      for (const rli of refund.refund_line_items || []) {
        const li = lineItemById.get(String(rli.line_item_id));
        if (li?.gift_card) continue;

        const resolvedLoc = resolveSalesRowLocation({ order, lineItem: li, locationMap, connection });
        if (!resolvedLoc) {
          skipped.no_location_lines += 1;
          continue;
        }

        const subtotal = Number(rli.subtotal || 0);
        const taxRefund = Number(rli.total_tax || 0);
        const shopifyItemType = getShopifyItemType(li);
        const effectiveSku = li?.sku || li?.title || shopifyItemType || 'None';
        const metaSku = (li?.sku && skuMeta.get(li.sku)) || {};

        refundRows.push(buildRefundRow({
          companyEntityId: connection.company_entity_id,
          locationTag: resolvedLoc.location_tag,
          locationName: resolvedLoc.location_name,
          shopDomain: domain,
          refundDate,
          sku: effectiveSku,
          productName: li?.title || metaSku.product_title || null,
          productType:
            metaSku.product_type ||
            shopifyItemType ||
            inferFallbackProductType(effectiveSku, metaSku.product_title || li?.title),
          vendorOriginal: metaSku.vendor_original || null,
          orderId: order.id,
          qtyDelta: -Number(rli.quantity || 0),
          refundAmount: subtotal,
          taxDelta: -taxRefund,
          shippingDelta: 0,
          netDelta: -subtotal,
          totalDelta: -(subtotal + taxRefund),
          syncedAt,
          batchId,
        }));
      }

      // Order-level pieces: refunded shipping and refund discrepancies.
      let shippingRefund = 0;
      let shippingTax = 0;
      let discrepancy = 0;
      let discrepancyTax = 0;
      for (const rsl of refund.refund_shipping_lines || []) {
        shippingRefund += moneyAmount(rsl.subtotal_amount_set) || Number(rsl.subtotal || 0);
      }
      for (const adj of refund.order_adjustments || []) {
        const kind = String(adj?.kind || '').toLowerCase();
        if (kind.includes('shipping')) {
          shippingRefund += Math.abs(Number(adj.amount || 0));
          shippingTax += Math.abs(Number(adj.tax_amount || 0));
        } else {
          // adjustment amounts are negative when money is returned
          discrepancy += Number(adj.amount || 0);
          discrepancyTax += Number(adj.tax_amount || 0);
        }
      }

      if (shippingRefund || shippingTax || discrepancy || discrepancyTax) {
        const resolvedLoc = resolveSalesRowLocation({ order, lineItem: null, locationMap, connection });
        if (!resolvedLoc) {
          skipped.no_location_lines += 1;
        } else {
          if (shippingRefund || shippingTax) {
            refundRows.push(buildRefundRow({
              companyEntityId: connection.company_entity_id,
              locationTag: resolvedLoc.location_tag,
              locationName: resolvedLoc.location_name,
              shopDomain: domain,
              refundDate,
              sku: '[Shipping]',
              productName: '[Shipping]',
              productType: null,
              vendorOriginal: null,
              orderId: order.id,
              qtyDelta: 0,
              refundAmount: 0,
              taxDelta: -shippingTax,
              shippingDelta: -shippingRefund,
              netDelta: 0,
              totalDelta: -(shippingRefund + shippingTax),
              syncedAt,
              batchId,
            }));
          }
          if (discrepancy || discrepancyTax) {
            refundRows.push(buildRefundRow({
              companyEntityId: connection.company_entity_id,
              locationTag: resolvedLoc.location_tag,
              locationName: resolvedLoc.location_name,
              shopDomain: domain,
              refundDate,
              sku: '[Refund discrepancy]',
              productName: '[Refund discrepancy]',
              productType: null,
              vendorOriginal: null,
              orderId: order.id,
              qtyDelta: 0,
              refundAmount: -discrepancy,
              taxDelta: discrepancyTax,
              shippingDelta: 0,
              netDelta: discrepancy,
              totalDelta: discrepancy + discrepancyTax,
              syncedAt,
              batchId,
            }));
          }
        }
      }
    }
  }

  return {
    salesRows: collapseSalesRows([...dayMap.values(), ...refundRows]),
    newestOrderStamp,
    newestUpdatedStamp,
    skipped,
  };
}

/**
 * Order-level and line-item-level facts, derived from the same order
 * objects ordersToSalesRows() flattens into sales_by_day -- see
 * 20260817210000_shopify_order_level_analytics.sql for why this exists
 * alongside (not instead of) the flattened aggregate. No extra Shopify API
 * calls: `orders` here is the exact array already fetched for sales rows.
 */
export function ordersToOrderRows({ orders, connection, skuMeta, syncedAt, batchId }) {
  const domain = connection.shop_domain;
  const orderRows = [];
  const lineRows = [];

  for (const order of orders) {
    if (order.test) continue;

    const customer = order.customer || {};
    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
    const lineItems = order.line_items || [];

    orderRows.push({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      shop_domain: domain,
      order_id: String(order.id),
      order_number: order.name || (order.order_number != null ? String(order.order_number) : null),
      source_name: order.source_name || null,
      financial_status: order.financial_status || null,
      fulfillment_status: order.fulfillment_status || null,
      cancelled_at: order.cancelled_at || null,
      cancel_reason: order.cancel_reason || null,
      customer_id: customer.id != null ? String(customer.id) : null,
      customer_email: order.email || customer.email || null,
      customer_name: customerName,
      currency: order.currency || null,
      subtotal_price: Number(order.subtotal_price || 0),
      total_discounts: Number(order.total_discounts || 0),
      total_tax: Number(order.total_tax || 0),
      total_shipping: firstOrderMoney(order, 'total_shipping_price_set', 'current_total_shipping_price_set'),
      total_price: Number(order.total_price || 0),
      tags: order.tags || null,
      location_id: order.location_id != null ? String(order.location_id) : null,
      line_item_count: lineItems.length,
      shopify_created_at: order.created_at || null,
      shopify_processed_at: order.processed_at || null,
      shopify_updated_at: order.updated_at || null,
      synced_at: syncedAt,
      sync_batch_id: batchId || null,
    });

    for (const li of lineItems) {
      const metaSku = (li?.sku && skuMeta.get(li.sku)) || {};
      lineRows.push({
        company_entity_id: connection.company_entity_id,
        connection_id: connection.id,
        shop_domain: domain,
        order_id: String(order.id),
        line_item_id: String(li.id),
        sku: li.sku || null,
        product_id: li.product_id != null ? String(li.product_id) : null,
        variant_id: li.variant_id != null ? String(li.variant_id) : null,
        title: li.title || null,
        variant_title: li.variant_title || null,
        quantity: Number(li.quantity || 0),
        price: Number(li.price || 0),
        discount_allocated: sumDiscountForLine(li),
        tax_allocated: sumTaxForLine(li),
        fulfillable_quantity: Number(li.fulfillable_quantity || 0),
        fulfillment_status: li.fulfillment_status || null,
        gift_card: !!li.gift_card,
        vendor: metaSku.vendor_original || li.vendor || null,
        product_type: metaSku.product_type || getShopifyItemType(li) || null,
        synced_at: syncedAt,
        sync_batch_id: batchId || null,
      });
    }
  }

  return { orderRows, lineRows };
}

/**
 * Writes ordersToOrderRows() output. Orders are plain upserts (current state
 * simply replaces the prior row). Line items additionally need a delete pass
 * first, scoped to the touched order ids: unlike orders, a line item can
 * disappear entirely from an edited order, and upsert alone can't remove a
 * row that's no longer in the incoming set.
 */
export async function upsertOrderFacts(supabase, connection, { orders, skuMeta, syncedAt, batchId }) {
  const { orderRows, lineRows } = ordersToOrderRows({ orders, connection, skuMeta, syncedAt, batchId });
  if (!orderRows.length) return { orders_upserted: 0, order_lines_upserted: 0 };

  const orderIds = [...new Set(orderRows.map((r) => r.order_id))];
  for (const group of chunk(orderIds, 500)) {
    const { error } = await supabase
      .from('shopify_order_lines')
      .delete()
      .eq('company_entity_id', connection.company_entity_id)
      .eq('shop_domain', connection.shop_domain)
      .in('order_id', group);
    if (error) throw new Error(`shopify_order_lines rebuild delete failed: ${error.message}`);
  }

  const ordersUpserted = await upsertInChunks(supabase, 'shopify_orders', orderRows, 'shop_domain,order_id');
  const linesUpserted = await upsertInChunks(supabase, 'shopify_order_lines', lineRows, 'shop_domain,order_id,line_item_id');

  return { orders_upserted: ordersUpserted, order_lines_upserted: linesUpserted };
}

/** Sorted unique YYYY-MM-DD dates → contiguous [{start, end}] runs. */
export function contiguousDateRuns(dates) {
  const runs = [];
  for (const d of dates) {
    const last = runs[runs.length - 1];
    if (last && isoDateOnly(addDays(new Date(`${last.end}T00:00:00Z`), 1)) === d) {
      last.end = d;
    } else {
      runs.push({ start: d, end: d });
    }
  }
  return runs;
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

  // Windows are fetched on UTC bounds but rows are bucketed by the order's
  // shop-local date, so a boundary date straddles two windows. Over-fetch one
  // day on each side, then keep only the dates this window fully covers —
  // otherwise the next window's partial aggregate overwrites (via row_hash
  // upsert) the complete aggregate written by this one.
  const fetchStart = isoDateOnly(addDays(new Date(`${win.window_start}T00:00:00Z`), -1));
  const orders = await fetchOrdersInWindow(headers, base, fetchStart, win.window_end);
  const { salesRows, newestOrderStamp } = ordersToSalesRows({
    orders,
    connection,
    locationMap: locationContext.dbLocationMap,
    skuMeta,
    syncedAt,
    batchId,
  });

  // Refund rows (total_orders = 0) are keyed per order + refund date and may
  // land outside the window's date range — keep them regardless; the upsert
  // is idempotent per refund.
  const isFinalWindow = win.window_end >= state.range_end;
  const keepRows = salesRows.filter((r) =>
    r.total_orders === 0
    || (r.day_date >= win.window_start
      && (isFinalWindow ? r.day_date <= win.window_end : r.day_date < win.window_end)));

  const upserted = await upsertInChunks(supabase, 'sales_by_day', keepRows, 'row_hash');
  const orderFacts = await upsertOrderFacts(supabase, connection, { orders, skuMeta, syncedAt, batchId });

  const nextState = computeBackfillProgress({
    ...state,
    cursor: win.window_end,
    windows_done: (state.windows_done || 0) + 1,
    orders_total: (state.orders_total || 0) + orders.length,
    sales_rows_total: (state.sales_rows_total || 0) + upserted,
    last_window: win,
    last_newest_order_stamp: newestOrderStamp,
    updated_at: syncedAt,
  });

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
      orders_upserted: orderFacts.orders_upserted,
      order_lines_upserted: orderFacts.order_lines_upserted,
    },
    caches: { locationContext, skuMeta },
  };
}

/**
 * Shopify Payments payouts → shopify_payouts. Feeds the Accounting Export
 * (deposit register for bank rec + monthly processing-fee journal entry).
 * Payout ids are globally unique, so duplicate connections to the same shop
 * converge on the same rows via the payout_id upsert.
 */
export async function runPayoutsSync(supabase, connection, { batchId } = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'payouts_sync');
  if (missing.length) {
    return { skipped: true, missing };
  }

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };
  const syncedAt = new Date().toISOString();

  // First run pulls the full books year; after that, re-fetch a trailing
  // window so status transitions (scheduled → in_transit → paid) and late
  // adjustments update the stored rows.
  const { data: newest, error: newestError } = await supabase
    .from('shopify_payouts')
    .select('payout_date')
    .eq('company_entity_id', connection.company_entity_id)
    .eq('shop_domain', connection.shop_domain)
    .order('payout_date', { ascending: false })
    .limit(1);
  if (newestError) throw new Error(`shopify_payouts read failed: ${newestError.message}`);

  const since = newest?.length
    ? isoDateOnly(addDays(new Date(`${newest[0].payout_date}T00:00:00Z`), -14))
    : '2026-01-01';

  let payouts;
  try {
    payouts = await getAll(
      headers,
      `${base}/shopify_payments/payouts.json?limit=250&date_min=${since}`,
    );
  } catch (err) {
    // Stores without Shopify Payments enabled 404 on this endpoint.
    if (/404|Not Found/i.test(String(err?.message || err))) {
      return { skipped: true, reason: 'no_shopify_payments' };
    }
    throw err;
  }

  const money = (v) => Number(v || 0);
  const rows = payouts.map((p) => ({
    company_entity_id: connection.company_entity_id,
    connection_id: connection.id,
    shop_domain: connection.shop_domain,
    payout_id: String(p.id),
    payout_date: p.date,
    status: p.status || null,
    currency: p.currency || null,
    amount_net: money(p.amount),
    charges_gross: money(p.summary?.charges_gross_amount),
    charges_fee: money(p.summary?.charges_fee_amount),
    refunds_gross: money(p.summary?.refunds_gross_amount),
    refunds_fee: money(p.summary?.refunds_fee_amount),
    adjustments_gross: money(p.summary?.adjustments_gross_amount),
    adjustments_fee: money(p.summary?.adjustments_fee_amount),
    reserved_funds_gross: money(p.summary?.reserved_funds_gross_amount),
    reserved_funds_fee: money(p.summary?.reserved_funds_fee_amount),
    retried_payouts_gross: money(p.summary?.retried_payouts_gross_amount),
    retried_payouts_fee: money(p.summary?.retried_payouts_fee_amount),
    synced_at: syncedAt,
    sync_batch_id: batchId || null,
  }));

  const upserted = await upsertInChunks(supabase, 'shopify_payouts', rows, 'payout_id');
  return { payouts_upserted: upserted, since };
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

  const [dbLocationMap, locations, variants, ...productsByStatus] = await Promise.all([
    loadLocationMap(supabase, connection.company_entity_id),
    getAll(headers, `${base}/locations.json?limit=250`),
    getAll(headers, `${base}/variants.json?limit=250`),
    ...PRODUCT_STATUSES_FOR_LABELING.map((status) => getAll(headers, `${base}/products.json?limit=250&status=${status}`)),
  ]);
  const productById = new Map();
  for (const products of productsByStatus) {
    for (const p of products) productById.set(String(p.id), p);
  }

  // Keyed by inventory_item_id -- Shopify's real 1:1-with-variant identifier
  // -- not by SKU. Two DIFFERENT products/variants can carry the identical
  // SKU string (a renamed/relisted product, or a duplicate never-launched
  // listing left pointed at the same SKU as the real one -- see the
  // 2026-08-21 "Doubles and Bubbles Cap - Toddler" misattribution, where a
  // never-launched product shared the real Youth cap's SKU and picked up
  // its sales and on-hand qty). Resolving metadata per inventory_item_id
  // keeps each variant's own correct title/type instead of both variants
  // racing to overwrite one SKU-keyed lookup.
  const invItemById = new Map();

  for (const v of variants) {
    if (!v?.sku) continue;
    const p = productById.get(String(v.product_id)) || {};
    const imageUrl =
      p.image?.src || (Array.isArray(p.images) && p.images[0]?.src) || null;
    const unitPrice = variantUnitPrice(v);

    invItemById.set(String(v.inventory_item_id), {
      sku: v.sku,
      product_id: v.product_id != null ? String(v.product_id) : null,
      unit_price: unitPrice,
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

  // Collapse by (locId, sku, product_id) — the same product can legitimately
  // have more than one inventory item tracking the same SKU at a location
  // (those should sum), but two DIFFERENT products sharing a SKU must not:
  // including product_id keeps them as separate rows instead of one merged,
  // mislabeled row.
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
      const invItem = invItemById.get(String(lvl.inventory_item_id));
      if (!invItem?.sku) continue;

      const { sku, product_id: productId, unit_price: unitPrice } = invItem;
      const qty = Number(lvl.available ?? 0);
      const lineRetail = Math.round(qty * unitPrice * 100) / 100;

      const rowHash = hashRow([connection.company_entity_id, locId, sku, productId || '', snapshotAt]);
      const existing = invByKey.get(rowHash);
      if (existing) {
        existing.total_available_quantity += qty;
        existing.total_available_inventory_value += lineRetail;
        continue;
      }

      invByKey.set(rowHash, {
        company_entity_id: connection.company_entity_id,
        location_tag: locationTag,
        location_name: locationName,
        source: SOURCE,
        location: loc.name || null,
        product_title: invItem.product_title || sku,
        variant_title: invItem.variant_title || null,
        variant_sku: sku,
        shop_domain: domain,
        variant_barcode: invItem.variant_barcode || null,
        product_type: invItem.product_type || null,
        product_image: null,
        product_image_url: invItem.product_image_url || null,
        total_available_quantity: qty,
        total_available_inventory_value: lineRetail,
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

/**
 * Keeps products_master current with Shopify's active catalog. Only
 * touches catalog-identity columns (title, type, vendor, image, barcode) --
 * never the human-curated merchandising fields (cost, reorder points,
 * lifecycle_status, notes, etc.), which are absent from the upsert payload
 * and therefore untouched by Postgres's ON CONFLICT DO UPDATE. New SKUs
 * land with those fields blank for someone to fill in; existing SKUs never
 * get overwritten or deleted, even if since discontinued in Shopify.
 */
export async function runCatalogSync(supabase, connection, { batchId } = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'catalog_sync');
  if (missing.length) {
    return { skipped: true, missing };
  }

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const domain = connection.shop_domain;
  const base = `https://${domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };

  const [variants, ...productsByStatus] = await Promise.all([
    getAll(headers, `${base}/variants.json?limit=250`),
    ...PRODUCT_STATUSES_FOR_LABELING.map((status) => getAll(headers, `${base}/products.json?limit=250&status=${status}`)),
  ]);
  const productById = new Map();
  for (const products of productsByStatus) {
    for (const p of products) productById.set(String(p.id), p);
  }

  const now = new Date().toISOString();
  const rowBySku = new Map();

  for (const v of variants) {
    if (!v?.sku || rowBySku.has(v.sku)) continue;
    const p = productById.get(String(v.product_id)) || {};
    const imageUrl = p.image?.src || (Array.isArray(p.images) && p.images[0]?.src) || null;
    const productType =
      p.product_type ||
      p.product_category?.product_taxonomy_node?.full_name ||
      null;

    rowBySku.set(v.sku, {
      sku: v.sku,
      company_entity_id: connection.company_entity_id,
      product_title: (p.title || '').trim() || v.sku,
      variant_title: v.title && v.title !== 'Default Title' ? v.title : null,
      product_type: productType,
      // Category mirrors Shopify's own product_type -- Shopify drives it,
      // it isn't a separately custom-tagged field (subcategory/department/
      // tags/notes are the genuinely custom dimensions, edited in the
      // Catalog tab and left untouched by this sync).
      category: productType,
      vendor_original: p.vendor || null,
      image_url: imageUrl,
      barcode: v.barcode || null,
      shop_domain: domain,
      updated_at: now,
    });
  }

  const rows = [...rowBySku.values()];
  const upserted = await upsertInChunks(supabase, 'products_master', rows, 'company_entity_id,sku');

  return {
    job_type: 'catalog_sync',
    batch_id: batchId,
    skus_seen: rows.length,
    products_master_rows_upserted: upserted,
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

  // Fetch by updated_at (not created_at) so refunds, fulfillments, edits and
  // cancellations on older orders are picked up, not just newly created orders.
  const touched = await getAll(
    headers,
    `${base}/orders.json?status=any&updated_at_min=${encodeURIComponent(sinceISO)}&limit=250`,
  );

  let newestOrderStamp = null;
  let newestUpdatedStamp = null;
  for (const order of touched) {
    newestOrderStamp = maxIso(newestOrderStamp, order.created_at);
    newestUpdatedStamp = maxIso(newestUpdatedStamp, order.updated_at || order.created_at);
  }

  const affectedDates = [...new Set(
    touched.map((o) => (o.created_at || '').slice(0, 10)).filter(Boolean),
  )].sort();

  let rowsUpserted = 0;
  let daysRebuilt = 0;
  let ordersUpserted = 0;
  let orderLinesUpserted = 0;
  const skippedTotals = { cancelled_orders: 0, gift_card_lines: 0, no_location_lines: 0 };

  // Rebuild every affected order-date in full: day aggregates can't be patched
  // incrementally (a refund or edit changes an existing row), so re-fetch all
  // orders for those dates and replace this shop's rows for them.
  for (const run of contiguousDateRuns(affectedDates)) {
    // Over-fetch one UTC day on each side so shop-local dates are complete.
    const fetchStart = isoDateOnly(addDays(new Date(`${run.start}T00:00:00Z`), -1));
    const fetchEnd = isoDateOnly(addDays(new Date(`${run.end}T00:00:00Z`), 1));
    const orders = await fetchOrdersInWindow(headers, base, fetchStart, fetchEnd);

    const { salesRows, skipped } = ordersToSalesRows({
      orders,
      connection,
      locationMap: locationContext.dbLocationMap,
      skuMeta,
      syncedAt,
      batchId,
    });
    for (const key of Object.keys(skippedTotals)) skippedTotals[key] += skipped[key] || 0;

    const keepRows = salesRows.filter((r) =>
      r.total_orders === 0 || (r.day_date >= run.start && r.day_date <= run.end));

    // Delete-then-insert so removed or edited line items don't leave stale
    // aggregate rows behind. Scoped to this shop + source + dates, and only
    // sales rows (total_orders > 0): refund rows on these dates may come from
    // orders created long ago that this fetch doesn't cover — they're
    // additive-only (refunds are immutable) and refreshed by hash upsert.
    const { error: delError } = await supabase
      .from('sales_by_day')
      .delete()
      .eq('company_entity_id', connection.company_entity_id)
      .eq('shop_domain', connection.shop_domain)
      .eq('source', SOURCE)
      .gt('total_orders', 0)
      .gte('day_date', run.start)
      .lte('day_date', run.end);
    if (delError) throw new Error(`sales_by_day rebuild delete failed: ${delError.message}`);

    rowsUpserted += await upsertInChunks(supabase, 'sales_by_day', keepRows, 'row_hash');
    daysRebuilt += Math.round(
      (new Date(`${run.end}T00:00:00Z`) - new Date(`${run.start}T00:00:00Z`)) / 86400000,
    ) + 1;

    const orderFacts = await upsertOrderFacts(supabase, connection, { orders, skuMeta, syncedAt, batchId });
    ordersUpserted += orderFacts.orders_upserted;
    orderLinesUpserted += orderFacts.order_lines_upserted;
  }

  return {
    job_type: 'incremental_sales',
    window_since: sinceISO.slice(0, 10),
    orders_fetched: touched.length,
    days_rebuilt: daysRebuilt,
    sales_rows_upserted: rowsUpserted,
    orders_upserted: ordersUpserted,
    order_lines_upserted: orderLinesUpserted,
    rows_skipped: skippedTotals,
    newest_order_stamp: newestOrderStamp,
    last_order_sync_at: newestUpdatedStamp || syncedAt,
    last_sales_sync_at: syncedAt,
  };
}

/**
 * Draft orders (/draft_orders.json) are a separate Shopify resource from
 * Orders — they never appear in /orders.json until completed/paid, which is
 * exactly why wholesale/rep-built and invoiced net-terms carts were invisible
 * to sales_by_day (see 20260723150000_shopify_draft_orders.sql). This is a
 * pipeline-visibility feed, not a sales feed: once a draft completes,
 * Shopify auto-creates the real Order and runIncrementalSales already picks
 * it up on its own — folding drafts into sales_by_day here would double it.
 *
 * The REST endpoint's `status` filter defaults to open-only when omitted,
 * and (unlike /orders.json) does not document an "any" value — so each
 * status is fetched explicitly rather than gambled on a single call.
 */
const DRAFT_ORDER_STATUSES = ['open', 'invoice_sent', 'completed'];

export async function runDraftOrdersSync(supabase, connection, {
  batchId,
  daysBack = 2,
} = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'draft_orders_sync');
  if (missing.length) {
    return { skipped: true, missing };
  }

  const now = new Date();
  const syncedAt = now.toISOString();
  const meta = readMeta(connection);
  const sinceISO = computeSinceISO(now, meta.last_draft_order_sync_at, daysBack);

  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const base = `https://${connection.shop_domain}/admin/api/${apiVersion}`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };

  const byStatus = await Promise.all(DRAFT_ORDER_STATUSES.map((status) => getAll(
    headers,
    `${base}/draft_orders.json?status=${status}&updated_at_min=${encodeURIComponent(sinceISO)}&limit=250`,
  )));
  const byId = new Map();
  for (const draft of byStatus.flat()) byId.set(String(draft.id), draft);
  const draftOrders = [...byId.values()];

  let newestUpdatedStamp = null;
  const rows = draftOrders.map((d) => {
    newestUpdatedStamp = maxIso(newestUpdatedStamp, d.updated_at);
    const customer = d.customer || {};
    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;

    return {
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      shop_domain: connection.shop_domain,
      draft_order_id: String(d.id),
      name: d.name || null,
      status: d.status || null,
      customer_id: customer.id != null ? String(customer.id) : null,
      customer_email: d.email || customer.email || null,
      customer_name: customerName,
      total_price: Number(d.total_price || 0),
      subtotal_price: Number(d.subtotal_price || 0),
      total_tax: Number(d.total_tax || 0),
      currency: d.currency || null,
      tags: d.tags || null,
      note: d.note || null,
      order_id: d.order_id != null ? String(d.order_id) : null,
      shopify_created_at: d.created_at || null,
      shopify_updated_at: d.updated_at || null,
      invoice_sent_at: d.invoice_sent_at || null,
      completed_at: d.completed_at || null,
      synced_at: syncedAt,
      sync_batch_id: batchId || null,
    };
  });

  const upserted = await upsertInChunks(supabase, 'shopify_draft_orders', rows, 'shop_domain,draft_order_id');

  return {
    job_type: 'draft_orders_sync',
    window_since: sinceISO.slice(0, 10),
    draft_orders_fetched: draftOrders.length,
    draft_orders_upserted: upserted,
    last_draft_order_sync_at: newestUpdatedStamp || syncedAt,
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
    await purgeShopifySalesForShop(
      supabase,
      connection.company_entity_id,
      connection.shop_domain,
    );
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

/* ------------------------------------------------------------------------
   ShopifyQL: storefront funnel + customer mix
   ------------------------------------------------------------------------
   The first GraphQL call in this file -- everything above it is REST. It is
   here because the storefront funnel (sessions -> added to cart -> reached
   checkout -> completed) is not on the Admin REST API at all; it lives in
   Shopify Analytics, which ShopifyQL fronts.

   Volume is trivial: TIMESERIES day aggregates server-side and returns one
   row per day, roughly 365 per shop per year.
------------------------------------------------------------------------- */

// ShopifyQL truncates a result set at 1000 rows with no error and no flag.
// Verified against the live Admin API on 2026-08-27: a day-grain query over
// 1100 days returned exactly rowCount 1000, ending 2026-05-17 -- three months
// short of today. Rows come back oldest-first, so the ones silently dropped
// are the MOST RECENT. Requesting more than 1000 days at day grain therefore
// loses current data, which is the worst possible way for this to fail.
const SHOPIFYQL_ROW_LIMIT = 1000;
// 730 gives a complete year-over-year comparison with headroom under the
// ceiling. History reaches back to at least 2023-05 if more is ever wanted,
// but it has to be fetched in chunks, not one wide window.
const SHOPIFYQL_MAX_DAYS = 730;

/** Run one ShopifyQL statement. Returns rows as objects keyed by column name. */
export async function shopifyql(connection, query) {
  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const url = `https://${connection.shop_domain}/admin/api/${apiVersion}/graphql.json`;
  // Shape read off the live schema via introspection on 2026-08-27, after
  // two wrong guesses. The truth for this API version:
  //
  //   shopifyqlQuery -> ShopifyqlQueryResponse
  //     parseErrors : NON_NULL list of String   (scalar -- no sub-selection)
  //     tableData   : ShopifyqlTableData
  //       columns : ShopifyqlTableDataColumn { name displayName dataType subType }
  //       rows    : JSON                       (scalar -- no sub-selection)
  //
  // Note `rows`, not `rowData`, and it is a JSON scalar that arrives already
  // parsed as an array of arrays. There is no TableResponse type to fragment
  // on, which is what the first attempt assumed.
  const body = {
    query: `query Ql($q: String!) {
      shopifyqlQuery(query: $q) {
        __typename
        parseErrors
        tableData { columns { name } rows }
      }
    }`,
    variables: { q: query },
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': connection.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  // A ShopifyQL parse error comes back 200 with parseErrors populated, so
  // it has to be checked explicitly or it looks like an empty result.
  const gqlErrors = json?.errors;
  if (gqlErrors?.length) {
    throw new Error(`ShopifyQL transport error: ${gqlErrors.map((e) => e.message).join('; ')}`);
  }
  const payload = json?.data?.shopifyqlQuery;
  if (payload?.parseErrors?.length) {
    // Scalar strings, but tolerate objects in case a future version changes it.
    const msgs = payload.parseErrors.map((e) =>
      typeof e === 'string' ? e : `${e?.code ?? ''} ${e?.message ?? ''}`.trim());
    throw new Error(`ShopifyQL rejected the query: ${msgs.join('; ')}`);
  }
  const table = payload?.tableData;
  if (!table) {
    const empty = [];
    Object.defineProperty(empty, 'raw', {
      value: { columns: [], row_count: 0, table_data_was_null: true, typename: payload?.__typename ?? null },
      enumerable: false,
    });
    return empty;
  }

  const cols = (table.columns || []).map((c) => c.name);
  // `rows` is a JSON scalar. It arrives already parsed, but the shape is not
  // guaranteed to be an array of arrays -- a JSON scalar can just as easily
  // hand back an array of objects keyed by column name. Handle both.
  const rawRows = Array.isArray(table.rows) ? table.rows : [];
  const out = rawRows.map((row) => {
    if (Array.isArray(row)) {
      const o = {};
      cols.forEach((c, i) => { o[c] = row[i]; });
      return o;
    }
    if (row && typeof row === 'object') return row;   // already keyed
    return null;
  }).filter(Boolean);

  // The live API returns objects keyed by column name. An array-of-arrays
  // parser silently produced all-undefined rows that were then dropped,
  // reporting a clean sync of nothing -- record the shape so a change is
  // visible in sync_jobs instead of needing another investigation.
  const shape = rawRows.length === 0 ? 'empty'
    : Array.isArray(rawRows[0]) ? 'array_of_arrays' : 'array_of_objects';

  // Landing exactly on the ceiling means the result was almost certainly cut.
  // Fail loudly: a truncated window silently missing its newest days would
  // read as a normal sync and quietly corrupt every week-over-week number
  // built on top of it.
  if (rawRows.length >= SHOPIFYQL_ROW_LIMIT) {
    throw new Error(
      `ShopifyQL returned exactly ${rawRows.length} rows, the row ceiling -- the result is truncated ` +
      'and silently missing its most recent days. Narrow the window or page it. Query: ' + query,
    );
  }

  // Carry the raw payload so a caller that parses nothing can say what it
  // actually received instead of reporting an empty success.
  Object.defineProperty(out, 'raw', {
    value: { columns: cols, row_count: rawRows.length, row_shape: shape, sample: rawRows.slice(0, 1) },
    enumerable: false,
  });
  return out;
}

/**
 * Ask the store's own GraphQL endpoint what shopifyqlQuery actually returns.
 * Only runs when a query has already failed -- it turns "wrong shape, try
 * again" into a single run that names the real fields.
 */
export async function describeShopifyqlSchema(connection) {
  const apiVersion = connection.api_version || DEFAULT_API_VERSION;
  const url = `https://${connection.shop_domain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': connection.access_token,
    'Content-Type': 'application/json',
  };
  const ask = async (query) => {
    const res = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
    return res.json();
  };

  const rootJson = await ask(`{ __schema { queryType { fields { name
      type { kind name ofType { kind name } } } } } }`);
  const fields = rootJson?.data?.__schema?.queryType?.fields || [];
  const field = fields.find((f) => f.name === 'shopifyqlQuery');
  if (!field) return { available: false, note: 'shopifyqlQuery is not on the query root for this API version' };

  const typeName = field.type?.name || field.type?.ofType?.name;
  if (!typeName) return { available: true, note: 'shopifyqlQuery present but its return type could not be unwrapped' };

  // Unwrap NON_NULL / LIST wrappers to the underlying named type. The first
  // version of this only reported the top level, which named
  // ShopifyqlTableData without saying what is inside it -- and the field I
  // needed (the rows) was one level further down.
  const unwrap = (ty) => {
    let t = ty;
    for (let i = 0; i < 6 && t; i += 1) {
      if (t.name) return t.name;
      t = t.ofType;
    }
    return ty?.kind || '?';
  };

  const describeType = async (name) => {
    const j = await ask(`{ __type(name: "${name}") { kind name
        fields { name type { kind name
          ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
        possibleTypes { name } } }`);
    const t = j?.data?.__type;
    if (!t) return null;
    return {
      kind: t.kind,
      fields: (t.fields || []).map((f) => ({ name: f.name, type: unwrap(f.type) })),
      possible_types: (t.possibleTypes || []).map((p) => p.name),
    };
  };

  const top = await describeType(typeName);
  if (!top) return { available: true, return_type: typeName, note: 'type not introspectable' };

  // Follow every object-typed field one level down, so a single failed run
  // reports the whole shape instead of the outermost layer.
  const nested = {};
  const BUILTIN = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
  for (const f of top.fields) {
    if (BUILTIN.has(f.type) || nested[f.type] || f.type === typeName) continue;
    const child = await describeType(f.type);
    if (child) {
      nested[f.type] = child.fields.map((cf) => `${cf.name}: ${cf.type}`);
      for (const cf of child.fields) {
        if (BUILTIN.has(cf.type) || nested[cf.type] || cf.type === typeName) continue;
        const grand = await describeType(cf.type);
        if (grand) nested[cf.type] = grand.fields.map((gf) => `${gf.name}: ${gf.type}`);
      }
    }
  }

  return {
    available: true,
    return_type: typeName,
    kind: top.kind,
    fields: top.fields.map((f) => `${f.name}: ${f.type}`),
    nested,
    possible_types: top.possible_types,
  };
}

const qlNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// ShopifyQL returns the TIMESERIES bucket under whichever alias it picks;
// take the first value that parses as a date rather than guessing the name.
const qlDay = (row) => {
  for (const v of Object.values(row)) {
    const s = String(v ?? '');
    // ISO date, ISO timestamp, or a slash format -- whatever TIMESERIES emits.
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
};

/**
 * Pull the storefront funnel and customer mix and upsert them.
 *
 * COUNTS ONLY. Shopify will hand back conversion_rate and
 * returning_customer_rate directly, and they are deliberately not stored --
 * a stored rate gets averaged when someone rolls days into a week, which
 * does not give the week's rate. shopify_funnel_daily_v derives every ratio
 * from summed components instead.
 */
export async function runSessionsSync(supabase, connection, { batchId, sinceDays = 90 } = {}) {
  const granted = grantedScopes(connection);
  const missing = scopesMissingForJob(granted, 'sessions_sync');
  if (missing.length) return { skipped: true, missing };

  const days = Math.min(Math.max(Number(sinceDays) || 90, 1), SHOPIFYQL_MAX_DAYS);
  const until = new Date();
  const since = new Date(until.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  // Both the relative (`SINCE -7d UNTIL today`) and literal-date range forms
  // were verified against the live Admin API on 2026-08-27 and return
  // identical data. Literal dates are used because they pin the window to the
  // dates actually written to shopify_sessions_daily.
  const range = `SINCE ${iso(since)} UNTIL ${iso(until)}`;

  let sessionRows, customerRows;
  try {
    [sessionRows, customerRows] = await fetchQlPair(connection, range);
  } catch (err) {
    // One guess at the schema already cost a run. Report the real shape so the
    // next attempt is informed rather than another guess.
    let schema = null;
    try { schema = await describeShopifyqlSchema(connection); }
    catch (e2) { schema = { introspection_failed: e2.message || String(e2) }; }
    const detail = new Error(`${err.message || err} :: shopifyqlQuery schema = ${JSON.stringify(schema)}`);
    detail.schema = schema;
    throw detail;
  }

  const rawSess = sessionRows.raw || { row_count: 0 };
  const rawCust = customerRows.raw || { row_count: 0 };

  const droppedEverything =
    (rawSess.row_count > 0 && sessionRows.length === 0) ||
    (rawCust.row_count > 0 && customerRows.length === 0);
  if (droppedEverything) {
    throw new Error(
      'ShopifyQL returned rows but none parsed -- row shape is not what the mapper expects. ' +
      `sessions raw=${JSON.stringify(rawSess).slice(0, 400)} customers raw=${JSON.stringify(rawCust).slice(0, 400)}`,
    );
  }

  const now = new Date().toISOString();
  const res = await finishSessionsSync(supabase, connection, { batchId, iso, since, sessionRows, customerRows, now });

  // Shopify genuinely returned nothing. Legitimate for a quiet shop, wrong
  // for a busy one -- either way it must not read as a normal sync.
  if (rawSess.row_count === 0 && rawCust.row_count === 0) {
    res.warning = 'ShopifyQL returned no rows for this window (both range forms tried)';
    res.raw_sessions = rawSess;
  }
  return res;
}

async function fetchQlPair(connection, range) {
  return Promise.all([
    shopifyql(connection,
      `FROM sessions SHOW sessions, sessions_with_cart_additions, ` +
      `sessions_that_reached_checkout, sessions_that_completed_checkout ` +
      `TIMESERIES day ${range}`),
    shopifyql(connection,
      `FROM sales SHOW customers, new_customers, returning_customers ` +
      `TIMESERIES day ${range}`),
  ]);
}

async function finishSessionsSync(supabase, connection, { batchId, iso, since, sessionRows, customerRows, now }) {
  const base = {
    company_entity_id: connection.company_entity_id,
    shop_domain: connection.shop_domain,
    sync_batch_id: batchId || null,
    synced_at: now,
  };

  let undated = 0;
  const sessions = sessionRows
    .map((r) => {
      const day = qlDay(r);
      if (!day) { undated += 1; return null; }
      return {
        ...base,
        day_date: day,
        sessions: qlNum(r.sessions),
        sessions_with_cart_additions: qlNum(r.sessions_with_cart_additions),
        sessions_that_reached_checkout: qlNum(r.sessions_that_reached_checkout),
        sessions_that_completed_checkout: qlNum(r.sessions_that_completed_checkout),
      };
    })
    .filter(Boolean);

  const customers = customerRows
    .map((r) => {
      const day = qlDay(r);
      if (!day) return null;
      return {
        ...base,
        day_date: day,
        customers: qlNum(r.customers),
        new_customers: qlNum(r.new_customers),
        returning_customers: qlNum(r.returning_customers),
      };
    })
    .filter(Boolean);

  const sessionsUpserted = sessions.length
    ? await upsertInChunks(supabase, 'shopify_sessions_daily', sessions,
        'company_entity_id,shop_domain,day_date')
    : 0;
  const customersUpserted = customers.length
    ? await upsertInChunks(supabase, 'shopify_customer_metrics_daily', customers,
        'company_entity_id,shop_domain,day_date')
    : 0;

  // How far back Shopify actually served is worth recording: analytics
  // retention varies, and it decides when year-over-year becomes possible.
  const first = sessions.length ? sessions.map((r) => r.day_date).sort()[0] : null;

  return {
    job_type: 'sessions_sync',
    batch_id: batchId,
    rows_without_a_recognisable_day: undated || undefined,
    requested_since: iso(since),
    earliest_day_returned: first,
    sessions_rows_upserted: sessionsUpserted,
    customer_rows_upserted: customersUpserted,
  };
}
