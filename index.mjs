import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const {
  PORT = 3000,
  SHOPIFY_API_VER = "2025-01",

  // single-store fallback
  SHOPIFY_STORE,
  SHOPIFY_TOKEN,

  // multi-store json array fallback
  // example:
  // [
  //   {"domain":"store-a.myshopify.com","token":"shpat_xxx","location_tag_prefix":"AZ"},
  //   {"domain":"store-b.myshopify.com","token":"shpat_yyy","location_tag_prefix":"TX"}
  // ]
  SHOPIFY_CONNECTIONS = "[]",

  // new silo supabase
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,

  // sync behavior
  SHOPIFY_PULL_MODE = "created", // created | updated
  SHOPIFY_DAYS_BACK = "2",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1(input) {
  return crypto.createHash("sha1").update(String(input)).digest("hex");
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

function computeSinceISO(now, lastSyncAt, explicitSince, daysBack) {
  if (explicitSince) return explicitSince;
  if (lastSyncAt) {
    const d = new Date(lastSyncAt);
    d.setDate(d.getDate() - 2); // overlap buffer
    return d.toISOString();
  }
  const d = new Date(now);
  d.setDate(d.getDate() - Number(daysBack || 2));
  return d.toISOString();
}

function sumDiscountForLine(li) {
  return (li?.discount_allocations || []).reduce((sum, d) => {
    return sum + Number(d?.amount || 0);
  }, 0);
}

function sumTaxForLine(li) {
  return (li?.tax_lines || []).reduce((sum, t) => {
    return sum + Number(t?.price || 0);
  }, 0);
}

async function fetchWithRetry(url, opts = {}, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("retry-after")) || 2;
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

    const link = res.headers.get("link");
    const next = link?.split(",").find((l) => l.includes('rel="next"'));
    nextUrl = next?.match(/<([^>]+)>/)?.[1] || null;
  }

  return out;
}

function parseConnections() {
  let parsed = [];
  try {
    parsed = JSON.parse(SHOPIFY_CONNECTIONS || "[]");
  } catch {
    parsed = [];
  }

  if (parsed.length) return parsed;

  if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
    return [{ domain: SHOPIFY_STORE, token: SHOPIFY_TOKEN }];
  }

  return [];
}

async function readSyncState(shop) {
  const { data, error } = await supa
    .from("sync_state")
    .select("*")
    .eq("shop", shop)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function writeSyncState(shop, payload) {
  const { error } = await supa.from("sync_state").upsert(
    [{ shop, ...payload }],
    { onConflict: "shop" }
  );
  if (error) throw error;
}

function normalizeLocationTag(domain, locationName, prefix = "") {
  const base = `${prefix ? `${prefix}-` : ""}${locationName || "unknown"}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${domain.replace(".myshopify.com", "")}:${base}`;
}

function salesByDayRow({
  domain,
  locationTag,
  orderDate,
  sku,
  productTitle,
  variantTitle,
  productType,
  qty,
  grossSales,
  discountAmount,
  taxAmount,
  netSales,
}) {
  // adjust this object if your exact sales_by_day columns differ
  return {
    sales_date: orderDate,
    shop_domain: domain,
    location_tag: locationTag,
    sku,
    product_title: productTitle || null,
    variant_title: variantTitle || null,
    product_type: productType || null,
    qty_sold: qty,
    gross_sales: grossSales,
    discount_amount: discountAmount,
    tax_amount: taxAmount,
    net_sales: netSales,
    source: "shopify",
    updated_at: new Date().toISOString(),
  };
}

async function upsertProductsMaster(rows) {
  if (!rows.length) return 0;

  for (const part of chunk(rows, 500)) {
    const { error } = await supa.from("products_master").upsert(part, {
      onConflict: "sku",
    });
    if (error) throw error;
  }

  return rows.length;
}

async function insertInventorySnapshot(rows) {
  if (!rows.length) return 0;

  for (const part of chunk(rows, 500)) {
    const { error } = await supa.from("inventory_on_hand").insert(part);
    if (error) throw error;
  }

  return rows.length;
}

async function upsertSalesByDay(rows) {
  if (!rows.length) return 0;

  // update onConflict if your unique key differs
  for (const part of chunk(rows, 500)) {
    const { error } = await supa.from("sales_by_day").upsert(part, {
      onConflict: "sales_date,shop_domain,location_tag,sku",
    });
    if (error) throw error;
  }

  return rows.length;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/sync/shopify", async (req, res) => {
  try {
    const now = new Date();
    const explicitSince = req.body?.since || null;
    const daysBack = req.body?.days_back || SHOPIFY_DAYS_BACK;
    const mode = (req.body?.mode || SHOPIFY_PULL_MODE || "created").toLowerCase();
    const timeField = mode === "updated" ? "updated_at_min" : "created_at_min";
    const usingUpdated = mode === "updated";

    const connections = parseConnections();
    if (!connections.length) {
      return res.status(400).json({ ok: false, error: "No Shopify connections configured." });
    }

    const results = [];

    for (const conn of connections) {
      const domain = conn.domain;
      const token = conn.token;
      const locationPrefix = conn.location_tag_prefix || "";

      if (!domain || !token) continue;

      const base = `https://${domain}/admin/api/${SHOPIFY_API_VER}`;
      const headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      };

      const state = await readSyncState(domain);
      const sinceISO = computeSinceISO(now, state?.last_order_sync_at, explicitSince, daysBack);

      // locations
      const locResp = await fetchWithRetry(`${base}/locations.json`, { headers });
      if (!locResp.ok) throw new Error(await locResp.text());
      const { locations = [] } = await locResp.json();

      const locationTagById = new Map();
      for (const loc of locations) {
        locationTagById.set(
          String(loc.id),
          normalizeLocationTag(domain, loc.name, locationPrefix)
        );
      }

      // products + variants
      const allProducts = await getAll(headers, `${base}/products.json?limit=250&status=active`);
      const variants = await getAll(headers, `${base}/variants.json?limit=250`);

      const productById = new Map(allProducts.map((p) => [String(p.id), p]));
      const skuMeta = new Map();
      const skuByInvItem = new Map();
      const productRows = [];

      for (const v of variants) {
        if (!v?.sku) continue;

        const p = productById.get(String(v.product_id)) || {};
        const productTitle = (p.title || "").trim();
        const productType =
          p.product_type ||
          p.product_category?.product_taxonomy_node?.full_name ||
          null;

        const imageUrl =
          p.image?.src ||
          (Array.isArray(p.images) && p.images[0]?.src) ||
          null;

        const row = {
          sku: v.sku,
          upc: v.barcode || null,
          product_title: productTitle || v.sku,
          variant_title: v.title && v.title !== "Default Title" ? v.title : null,
          product_type: productType,
          vendor_original: p.vendor || null,
          image_url: imageUrl,
          shop_domain: domain,
          is_active: p.status ? p.status === "active" : true,
          updated_at: new Date().toISOString(),
        };

        productRows.push(row);

        skuByInvItem.set(String(v.inventory_item_id), v.sku);
        skuMeta.set(v.sku, {
          product_title: row.product_title,
          variant_title: row.variant_title,
          product_type: row.product_type,
          variant_barcode: row.upc,
          product_image_url: row.image_url,
        });
      }

      const dedupProducts = Array.from(
        productRows.reduce((m, r) => m.set(r.sku, r), new Map()).values()
      );

      const productsUpserted = await upsertProductsMaster(dedupProducts);

      // orders -> daily sku/location sales
      const orders = await getAll(
        headers,
        `${base}/orders.json?status=any&${timeField}=${encodeURIComponent(sinceISO)}&limit=250`
      );

      let newestOrderStamp = state?.last_order_sync_at || null;
      const dayMap = new Map();

      for (const o of orders) {
        newestOrderStamp = maxIso(newestOrderStamp, usingUpdated ? o.updated_at : o.created_at);

        const orderDate = (o.created_at || o.updated_at || "").slice(0, 10);
        const orderLocId = o.location_id ? String(o.location_id) : null;
        const fallbackLocationTag = orderLocId
          ? locationTagById.get(orderLocId) || `${domain.replace(".myshopify.com", "")}:unknown`
          : `${domain.replace(".myshopify.com", "")}:unknown`;

        for (const li of o.line_items || []) {
          if (!li?.sku) continue;

          const qty = Number(li.quantity || 0);
          const price = Number(li.price || 0);
          const discount = sumDiscountForLine(li);
          const tax = sumTaxForLine(li);

          const liLocId = li.location_id ? String(li.location_id) : orderLocId;
          const locationTag = liLocId
            ? locationTagById.get(liLocId) || fallbackLocationTag
            : fallbackLocationTag;

          const grossSales = price * qty;
          const netSales = grossSales - discount + tax;
          const meta = skuMeta.get(li.sku) || {};

          const key = [orderDate, domain, locationTag, li.sku].join("||");
          const cur = dayMap.get(key);

          if (!cur) {
            dayMap.set(
              key,
              salesByDayRow({
                domain,
                locationTag,
                orderDate,
                sku: li.sku,
                productTitle: meta.product_title || li.title || null,
                variantTitle: meta.variant_title || null,
                productType: meta.product_type || null,
                qty,
                grossSales,
                discountAmount: discount,
                taxAmount: tax,
                netSales,
              })
            );
          } else {
            cur.qty_sold += qty;
            cur.gross_sales += grossSales;
            cur.discount_amount += discount;
            cur.tax_amount += tax;
            cur.net_sales += netSales;
          }
        }
      }

      const salesRows = Array.from(dayMap.values());
      const salesUpserted = await upsertSalesByDay(salesRows);

      // inventory snapshot
      const snapshotAt = new Date().toISOString();
      const invRows = [];

      for (const loc of locations) {
        const locId = String(loc.id);
        const locationTag =
          locationTagById.get(locId) ||
          `${domain.replace(".myshopify.com", "")}:unknown`;

        const levels = await getAll(
          headers,
          `${base}/inventory_levels.json?location_ids=${encodeURIComponent(locId)}&limit=250`
        );

        for (const lvl of levels) {
          const sku = skuByInvItem.get(String(lvl.inventory_item_id));
          if (!sku) continue;

          const meta = skuMeta.get(sku) || {};
          const rowHash = sha1(`${domain}|${locationTag}|${sku}|${snapshotAt.slice(0, 13)}`);

          invRows.push({
            location_tag: locationTag,
            source: "shopify",
            location: loc.name || null,
            product_title: meta.product_title || sku,
            variant_title: meta.variant_title || null,
            variant_sku: sku,
            shop_domain: domain,
            variant_barcode: meta.variant_barcode || null,
            product_type: meta.product_type || null,
            product_image: null,
            product_image_url: meta.product_image_url || null,
            total_available_quantity: Number(lvl.available ?? 0),
            snapshot_at: snapshotAt,
            row_hash: rowHash,
          });
        }
      }

      const inventoryInserted = await insertInventorySnapshot(invRows);

      await writeSyncState(domain, {
        last_order_sync_at: newestOrderStamp || new Date().toISOString(),
        last_inventory_sync_date: snapshotAt.slice(0, 10),
        updated_at: new Date().toISOString(),
      });

      results.push({
        shop: domain,
        mode,
        window_since: sinceISO.slice(0, 10),
        locations: locations.length,
        orders_fetched: orders.length,
        products_upserted: productsUpserted,
        sales_rows_upserted: salesUpserted,
        inventory_rows_inserted: inventoryInserted,
        newest_order_stamp: newestOrderStamp,
      });
    }

    return res.json({ ok: true, results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`shopify sync server running on :${PORT}`);
});
