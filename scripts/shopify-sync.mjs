// scripts/shopify-sync.mjs
//
// Phase 2b — DB-driven Shopify sync orchestrator.
// Reads shopify_connections (sync_enabled + scopes OK), writes sales_by_day /
// inventory_on_hand with company_entity_id, logs progress to sync_jobs.
//
// Baseballism stays on nightly Sheets sync unless a connection has sync_enabled=true.
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional env:
//   SHOPIFY_SYNC_MODE=incremental|history|full   (default incremental)
//   SHOPIFY_DAYS_BACK=2                          (incremental order window)
//   SHOPIFY_HISTORY_DAYS=                        (override connection.history_days_default)
//   SHOPIFY_ONLY_COMPANY_ID=uuid
//   SHOPIFY_ONLY_CONNECTION_ID=uuid
//   SHOPIFY_SKIP_SALES=true
//   SHOPIFY_SKIP_INVENTORY=true
//   SHOPIFY_SKIP_SUMMARY_REFRESH=true
//   SHOPIFY_SYNC_BATCH_ID=custom-batch-id
//
// Run:
//   node scripts/shopify-sync.mjs

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  connectionReadyForSync,
  scopesMissingForJob,
} from './lib/shopify-scopes.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const SYNC_MODE = (process.env.SHOPIFY_SYNC_MODE || 'incremental').toLowerCase();
const DAYS_BACK = Number(process.env.SHOPIFY_DAYS_BACK || 2);
const ONLY_COMPANY_ID = process.env.SHOPIFY_ONLY_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.SHOPIFY_ONLY_CONNECTION_ID || '';
const SKIP_SALES = process.env.SHOPIFY_SKIP_SALES === 'true';
const SKIP_INVENTORY = process.env.SHOPIFY_SKIP_INVENTORY === 'true';
const SKIP_SUMMARY_REFRESH = process.env.SHOPIFY_SKIP_SUMMARY_REFRESH === 'true';

const BATCH_ID =
  process.env.SHOPIFY_SYNC_BATCH_ID ||
  `shopify-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const SOURCE = 'shopify_api';
const DEFAULT_API_VERSION = '2025-01';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashRow(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex');
}

function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a) > new Date(b) ? a : b;
}

function slugify(value) {
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

function normalizeLocationTag(connection, locationName) {
  const prefix = connection.location_tag_prefix
    ? `${slugify(connection.location_tag_prefix)}_`
    : '';
  const shopSlug = String(connection.shop_domain || '')
    .replace(/\.myshopify\.com$/i, '')
    .replace(/[^a-z0-9]+/gi, '_');
  return `${shopSlug}_${prefix}${slugify(locationName)}`.replace(/__+/g, '_');
}

function grantedScopes(connection) {
  const raw = connection.scopes_granted;
  return Array.isArray(raw) ? raw : [];
}

function readMeta(connection) {
  return connection.meta && typeof connection.meta === 'object' ? connection.meta : {};
}

async function fetchWithRetry(url, opts = {}, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get('retry-after')) || 2;
    await sleep(retryAfter * 1000);
  }
  return fetch(url, opts);
}

async function getAll(headers, url) {
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

function computeSinceISO(now, lastSyncAt, daysBack) {
  if (lastSyncAt) {
    const d = new Date(lastSyncAt);
    d.setDate(d.getDate() - 2);
    return d.toISOString();
  }
  const d = new Date(now);
  d.setDate(d.getDate() - Number(daysBack || 2));
  return d.toISOString();
}

function computeHistorySinceISO(now, days) {
  const d = new Date(now);
  d.setDate(d.getDate() - Number(days || 90));
  return d.toISOString();
}

async function upsertInChunks(table, rows, onConflict, chunkSize = 500) {
  if (!rows.length) return 0;

  for (const group of chunk(rows, chunkSize)) {
    const { error } = await supabase.from(table).upsert(group, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }

  return rows.length;
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

async function loadLocationMap(companyEntityId) {
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

function resolveLocation(connection, shopifyLoc, dbMap) {
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

async function startJob(connection, jobType) {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      job_type: jobType,
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

  const { error } = await supabase.from('sync_jobs').update(update).eq('id', jobId);
  if (error) console.warn(`sync_jobs update failed for ${jobId}: ${error.message}`);
}

async function updateConnectionMeta(connection, patch) {
  const meta = { ...readMeta(connection), ...patch };
  const { error } = await supabase
    .from('shopify_connections')
    .update({ meta })
    .eq('id', connection.id);

  if (error) throw new Error(`shopify_connections meta update failed: ${error.message}`);
  connection.meta = meta;
}

function buildSalesRow({
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
    sync_batch_id: BATCH_ID,
    synced_at: syncedAt,
    row_hash: rowHash,
  };
}

function collapseSalesRows(rows) {
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

async function syncSales(connection, { history = false } = {}) {
  const granted = grantedScopes(connection);
  const jobType = history ? 'history_import' : 'incremental_sales';
  const missing = scopesMissingForJob(granted, jobType);
  if (missing.length) {
    console.log(`[skip] ${connection.shop_domain} ${jobType}: missing scopes ${missing.join(', ')}`);
    return { skipped: true, jobType, missing };
  }

  const jobId = await startJob(connection, jobType);
  const now = new Date();
  const syncedAt = now.toISOString();
  const meta = readMeta(connection);
  const historyDays = Number(
    process.env.SHOPIFY_HISTORY_DAYS || connection.history_days_default || 90,
  );
  const sinceISO = history
    ? computeHistorySinceISO(now, historyDays)
    : computeSinceISO(now, meta.last_order_sync_at, DAYS_BACK);

  try {
    const apiVersion = connection.api_version || DEFAULT_API_VERSION;
    const domain = connection.shop_domain;
    const base = `https://${domain}/admin/api/${apiVersion}`;
    const headers = {
      'X-Shopify-Access-Token': connection.access_token,
      'Content-Type': 'application/json',
    };

    const dbLocationMap = await loadLocationMap(connection.company_entity_id);
    const locations = await getAll(headers, `${base}/locations.json?limit=250`);
    const locationById = new Map();
    const locationInfoById = new Map();

    for (const loc of locations) {
      const info = resolveLocation(connection, loc, dbLocationMap);
      locationById.set(String(loc.id), info.location_tag);
      locationInfoById.set(String(loc.id), info);
    }

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

    const orders = await getAll(
      headers,
      `${base}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceISO)}&limit=250`,
    );

    let newestOrderStamp = meta.last_order_sync_at || null;
    const dayMap = new Map();

    for (const order of orders) {
      newestOrderStamp = maxIso(newestOrderStamp, order.created_at);

      const orderDate = (order.created_at || '').slice(0, 10);
      const orderLocId = order.location_id ? String(order.location_id) : null;
      const fallbackInfo = orderLocId
        ? locationInfoById.get(orderLocId)
        : null;
      const fallbackTag =
        fallbackInfo?.location_tag ||
        normalizeLocationTag(connection, 'unknown');

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

    const salesRows = collapseSalesRows([...dayMap.values()]);
    const upserted = await upsertInChunks('sales_by_day', salesRows, 'row_hash');

    await updateConnectionMeta(connection, {
      last_order_sync_at: newestOrderStamp || syncedAt,
      last_sales_sync_at: syncedAt,
      last_sales_job_type: jobType,
    });

    const result = {
      job_type: jobType,
      window_since: sinceISO.slice(0, 10),
      orders_fetched: orders.length,
      sales_rows_upserted: upserted,
      newest_order_stamp: newestOrderStamp,
    };

    await finishJob(jobId, 'success', result);
    console.log(`[ok] ${domain} ${jobType}: ${upserted} sales rows`);
    return result;
  } catch (err) {
    await finishJob(jobId, 'error', { error: err.message || String(err) });
    throw err;
  }
}

async function syncInventory(connection) {
  const granted = grantedScopes(connection);
  const jobType = 'inventory_snapshot';
  const missing = scopesMissingForJob(granted, jobType);
  if (missing.length) {
    console.log(`[skip] ${connection.shop_domain} ${jobType}: missing scopes ${missing.join(', ')}`);
    return { skipped: true, jobType, missing };
  }

  const jobId = await startJob(connection, jobType);
  const snapshotAt = new Date().toISOString();

  try {
    const apiVersion = connection.api_version || DEFAULT_API_VERSION;
    const domain = connection.shop_domain;
    const base = `https://${domain}/admin/api/${apiVersion}`;
    const headers = {
      'X-Shopify-Access-Token': connection.access_token,
      'Content-Type': 'application/json',
    };

    const dbLocationMap = await loadLocationMap(connection.company_entity_id);
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
          sync_batch_id: BATCH_ID,
          row_hash: hashRow([
            connection.company_entity_id,
            locationTag,
            sku,
            snapshotAt,
          ]),
        });
      }
    }

    const upserted = await upsertInChunks('inventory_on_hand', invRows, 'row_hash');
    await updateConnectionMeta(connection, {
      last_inventory_sync_at: snapshotAt,
    });

    const result = {
      job_type: jobType,
      locations: locations.length,
      inventory_rows_upserted: upserted,
      snapshot_at: snapshotAt,
    };

    await finishJob(jobId, 'success', result);
    console.log(`[ok] ${domain} ${jobType}: ${upserted} inventory rows`);
    return result;
  } catch (err) {
    await finishJob(jobId, 'error', { error: err.message || String(err) });
    throw err;
  }
}

async function refreshSalesSummary() {
  if (SKIP_SUMMARY_REFRESH) {
    console.log('[skip] sales verification summary refresh');
    return;
  }

  const { error } = await supabase.rpc('refresh_sales_verification_store_comp_summary');
  if (error) throw new Error(`summary refresh failed: ${error.message}`);
  console.log('[ok] refreshed sales_verification_store_comp_summary');
}

async function syncConnection(connection) {
  const results = { shop_domain: connection.shop_domain, jobs: [] };

  const runSalesHistory =
    !SKIP_SALES && (SYNC_MODE === 'history' || SYNC_MODE === 'full');
  const runSalesIncremental =
    !SKIP_SALES && SYNC_MODE === 'incremental';
  const runInventory =
    !SKIP_INVENTORY &&
    (SYNC_MODE === 'incremental' || SYNC_MODE === 'full');

  if (runSalesHistory) {
    results.jobs.push(await syncSales(connection, { history: true }));
  }
  if (runSalesIncremental) {
    results.jobs.push(await syncSales(connection, { history: false }));
  }
  if (runInventory) {
    results.jobs.push(await syncInventory(connection));
  }

  return results;
}

async function main() {
  console.log(`[shopify-sync] mode=${SYNC_MODE} batch=${BATCH_ID}`);

  const connections = await loadConnections();
  if (!connections.length) {
    console.log('[shopify-sync] no active connections with sync_enabled=true and scopes OK');
    return;
  }

  console.log(`[shopify-sync] ${connections.length} connection(s) to process`);

  const allResults = [];
  let hadError = false;

  for (const connection of connections) {
    console.log(`[shopify-sync] → ${connection.shop_domain} (${connection.company_entity_id})`);
    try {
      allResults.push(await syncConnection(connection));
    } catch (err) {
      hadError = true;
      console.error(`[error] ${connection.shop_domain}: ${err.message || err}`);
      allResults.push({
        shop_domain: connection.shop_domain,
        error: err.message || String(err),
      });
    }
  }

  try {
    await refreshSalesSummary();
  } catch (err) {
    hadError = true;
    console.error(`[error] summary refresh: ${err.message || err}`);
  }

  console.log('[shopify-sync] done', JSON.stringify(allResults, null, 2));
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[shopify-sync] fatal', err);
  process.exit(1);
});
