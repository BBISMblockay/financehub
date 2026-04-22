// scripts/sync-silo-inventory-sales.mjs
//
// Nightly Silo sync:
// - Inventory tabs (Google Sheets CSV export) -> public.inventory_on_hand
// - Sales daily CSVs (one link per location)   -> public.sales_by_day
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional:
//   SILO_SYNC_BATCH_ID   (otherwise generated automatically)
//
// Run:
//   node scripts/sync-silo-inventory-sales.mjs

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { INVENTORY_SOURCES, validateSources } from "../config/silo-sources.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

validateSources();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BATCH_ID =
  process.env.SILO_SYNC_BATCH_ID ||
  `silo-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const SNAPSHOT_AT = new Date().toISOString();

const INV_HEADERS = {
  location: "Location",
  shopDomain: "Shop MyShopify Domain",
  sku: "Variant SKU",
  barcode: "Variant Barcode",
  product: "Product title",
  productType: "Product type",
  variant: "Variant title",
  availQty: "Total available quantity",
  invValue: "Total available inventory value",
  sold30: "SUM Variant Quantity sold over the last 30 days",
  avgDay: "SUM Variant Average quantity sold per day",
  daysOos: "SUM Variant Estimated days before out of stock",
  image: "Product Image url",
};

const SALES_HEADERS = {
  dayDate: "DAY Date",
  productName: "Product name",
  sku: "SKU",
  productType: "Product type",
  vendorOriginal: "Vendor (original)",
  totalQuantitySold: "Total quantity sold",
  totalOrders: "Total orders",
  totalGrossSales: "Total gross sales",
  totalDiscounts: "Total discounts",
  totalRefunds: "Total refunds",
  totalNetSales: "Total net sales",
  taxes: "SUM Taxes",
  shipping: "SUM Shipping",
  totalSales: "SUM Total sales",
};

function norm(value) {
  return String(value ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function intNum(value) {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed);
}

function parseDateOnly(value) {
  const raw = norm(value);
  if (!raw) return null;

  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, mm, dd, yyyy] = mdy;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const [, yyyy, mm, dd] = ymd;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  const jsDate = raw.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})/i);
  if (jsDate) {
    const [, yyyy, mmZeroBased, dd] = jsDate;
    const mm = String(Number(mmZeroBased) + 1).padStart(2, "0");
    return `${yyyy}-${mm}-${String(dd).padStart(2, "0")}`;
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial > 20000) {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const dt = new Date(excelEpoch.getTime() + serial * 86400000);
      return dt.toISOString().slice(0, 10);
    }
  }

  return null;
}

function hashRow(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"))
    .digest("hex");
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

function parseCSV(text) {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (inQuotes) {
      if (c === '"' && n === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i += 1;
      continue;
    }

    field += c;
    i += 1;
  }

  row.push(field);
  rows.push(row);

  return rows;
}

function rowsToObjects(csvText) {
  const grid = parseCSV(csvText).filter((r) => r.some((c) => norm(c) !== ""));
  if (!grid.length) return { headers: [], rows: [] };

  const headers = grid[0].map((h) => norm(h));
  const rows = grid.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });

  return { headers, rows };
}

function chunk(array, size = 500) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

async function upsertInChunks(table, rows, onConflict, ignoreDuplicates = false, chunkSize = 500) {
  for (const group of chunk(rows, chunkSize)) {
    const { error } = await supabase
      .from(table)
      .upsert(group, { onConflict, ignoreDuplicates });

    if (error) {
      throw new Error(`${table} upsert failed: ${error.message}`);
    }
  }
}

function collapseInventoryRows(mappedRows) {
  const byKey = new Map();

  for (const row of mappedRows) {
    const sku = norm(row.variant_sku);
    if (!sku) continue;

    const key = `${row.location_tag}::${sku}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        ...row,
        _locations: new Set(row.location ? [row.location] : []),
      });
      continue;
    }

    existing.total_available_quantity =
      (existing.total_available_quantity ?? 0) + (row.total_available_quantity ?? 0);

    existing.total_available_inventory_value =
      Number(existing.total_available_inventory_value ?? 0) +
      Number(row.total_available_inventory_value ?? 0);

    existing.qty_sold_30d = Math.max(
      existing.qty_sold_30d ?? 0,
      row.qty_sold_30d ?? 0
    );

    existing.avg_qty_sold_per_day = Math.max(
      Number(existing.avg_qty_sold_per_day ?? 0),
      Number(row.avg_qty_sold_per_day ?? 0)
    );

    existing.est_days_before_oos = Math.max(
      Number(existing.est_days_before_oos ?? 0),
      Number(row.est_days_before_oos ?? 0)
    );

    if (!existing.product_title && row.product_title) existing.product_title = row.product_title;
    if (!existing.variant_title && row.variant_title) existing.variant_title = row.variant_title;
    if (!existing.product_type && row.product_type) existing.product_type = row.product_type;
    if (!existing.variant_barcode && row.variant_barcode) existing.variant_barcode = row.variant_barcode;
    if (!existing.product_image_url && row.product_image_url) existing.product_image_url = row.product_image_url;
    if (!existing.shop_domain && row.shop_domain) existing.shop_domain = row.shop_domain;

    if (row.location) existing._locations.add(row.location);
  }

  return [...byKey.values()].map((row) => {
    const locs = [...row._locations];
    row.location =
      locs.length <= 3
        ? locs.join(", ")
        : `${locs.slice(0, 3).join(", ")} (+${locs.length - 3})`;

    delete row._locations;

    row.row_hash = hashRow([
      row.location_tag,
      row.variant_sku,
      row.snapshot_at,
    ]);

    return row;
  });
}

function collapseSalesRows(mappedRows) {
  const byKey = new Map();

  for (const row of mappedRows) {
    const key = row.row_hash;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { ...row });
      continue;
    }

    existing.total_quantity_sold =
      (existing.total_quantity_sold ?? 0) + (row.total_quantity_sold ?? 0);

    existing.total_orders =
      (existing.total_orders ?? 0) + (row.total_orders ?? 0);

    existing.total_gross_sales =
      Number(existing.total_gross_sales ?? 0) + Number(row.total_gross_sales ?? 0);

    existing.total_discounts =
      Number(existing.total_discounts ?? 0) + Number(row.total_discounts ?? 0);

    existing.total_refunds =
      Number(existing.total_refunds ?? 0) + Number(row.total_refunds ?? 0);

    existing.total_net_sales =
      Number(existing.total_net_sales ?? 0) + Number(row.total_net_sales ?? 0);

    existing.taxes =
      Number(existing.taxes ?? 0) + Number(row.taxes ?? 0);

    existing.shipping =
      Number(existing.shipping ?? 0) + Number(row.shipping ?? 0);

    existing.total_sales =
      Number(existing.total_sales ?? 0) + Number(row.total_sales ?? 0);

    if (!existing.product_name && row.product_name) existing.product_name = row.product_name;
    if (!existing.sku && row.sku) existing.sku = row.sku;
    if (!existing.product_type && row.product_type) existing.product_type = row.product_type;
    if (!existing.vendor_original && row.vendor_original) existing.vendor_original = row.vendor_original;
    if (!existing.shop_domain && row.shop_domain) existing.shop_domain = row.shop_domain;
  }

  return [...byKey.values()];
}

function mapInventoryRow(source, raw) {
  const variantSku = norm(raw[INV_HEADERS.sku]);
  if (!variantSku) return null;

  return {
    location_tag: source.location_tag,
    location_name: source.location_name,
    source: "better_reports",
    location: norm(raw[INV_HEADERS.location]) || null,
    product_title: norm(raw[INV_HEADERS.product]) || null,
    variant_title: norm(raw[INV_HEADERS.variant]) || null,
    variant_sku: variantSku,
    shop_domain: norm(raw[INV_HEADERS.shopDomain]) || source.shop_domain || null,
    variant_barcode: norm(raw[INV_HEADERS.barcode]) || null,
    est_oos_date: null,
    variant_created_at: null,
    product_type: norm(raw[INV_HEADERS.productType]) || null,
    product_image: norm(raw[INV_HEADERS.image]) || null,
    product_image_url: norm(raw[INV_HEADERS.image]) || null,
    total_available_quantity: intNum(raw[INV_HEADERS.availQty]),
    total_available_inventory_value: num(raw[INV_HEADERS.invValue]),
    qty_sold_30d: intNum(raw[INV_HEADERS.sold30]),
    avg_qty_sold_per_day: num(raw[INV_HEADERS.avgDay]),
    est_days_before_oos: num(raw[INV_HEADERS.daysOos]),
    snapshot_at: SNAPSHOT_AT,
    sync_batch_id: BATCH_ID,
    row_hash: null,
  };
}

function mapSalesRow(source, raw) {
  const dayDate = parseDateOnly(raw[SALES_HEADERS.dayDate]);
  if (!dayDate) return null;

  const sku = norm(raw[SALES_HEADERS.sku]) || null;
  const productName = norm(raw[SALES_HEADERS.productName]) || null;

  if (!sku && !productName) return null;

  return {
    location_tag: source.location_tag,
    location_name: source.location_name,
    source: "better_reports",
    day_date: dayDate,
    product_name: productName,
    sku,
    product_type: norm(raw[SALES_HEADERS.productType]) || null,
    vendor_original: norm(raw[SALES_HEADERS.vendorOriginal]) || null,
    total_quantity_sold: intNum(raw[SALES_HEADERS.totalQuantitySold]),
    total_orders: intNum(raw[SALES_HEADERS.totalOrders]),
    total_gross_sales: num(raw[SALES_HEADERS.totalGrossSales]),
    total_discounts: num(raw[SALES_HEADERS.totalDiscounts]),
    total_refunds: num(raw[SALES_HEADERS.totalRefunds]),
    total_net_sales: num(raw[SALES_HEADERS.totalNetSales]),
    taxes: num(raw[SALES_HEADERS.taxes]),
    shipping: num(raw[SALES_HEADERS.shipping]),
    total_sales: num(raw[SALES_HEADERS.totalSales]),
    shop_domain: source.shop_domain || null,
    sync_batch_id: BATCH_ID,
    synced_at: SNAPSHOT_AT,
    row_hash: hashRow([
      source.location_tag,
      dayDate,
      sku || "",
      productName || "",
    ]),
  };
}

async function syncInventory() {
  const allRows = [];
  const stats = [];

  for (const source of INVENTORY_SOURCES) {
    const csvText = await fetchText(source.inventory_csv_url);
    const parsed = rowsToObjects(csvText);
    const mapped = parsed.rows.map((r) => mapInventoryRow(source, r)).filter(Boolean);
    const collapsed = collapseInventoryRows(mapped);

    allRows.push(...collapsed);
    stats.push({
      location_tag: source.location_tag,
      raw_rows: parsed.rows.length,
      mapped_rows: mapped.length,
      collapsed_rows: collapsed.length,
    });
  }

  if (!allRows.length) {
    return { inserted: 0, stats };
  }

  await upsertInChunks("inventory_on_hand", allRows, "row_hash", false, 500);

  return {
    inserted: allRows.length,
    stats,
  };
}

async function syncSalesByDay() {
  let totalUpserted = 0;
  const stats = [];

  for (const source of INVENTORY_SOURCES) {
    console.log(`--- SALES SOURCE START: ${source.location_tag} ---`);
    console.log(`sales_daily_csv_url: ${source.sales_daily_csv_url}`);

    const csvText = await fetchText(source.sales_daily_csv_url);
    console.log(`[sales csv length] ${source.location_tag}: ${csvText.length}`);

    const parsed = rowsToObjects(csvText);

    console.log(`[sales headers] ${source.location_tag}:`, parsed.headers);
    console.log(`[sales first raw row] ${source.location_tag}:`, parsed.rows[0]);

    const sampleDayValue = parsed.rows?.[0]?.[SALES_HEADERS.dayDate];
    const sampleSkuValue = parsed.rows?.[0]?.[SALES_HEADERS.sku];
    const sampleProductValue = parsed.rows?.[0]?.[SALES_HEADERS.productName];

    console.log(`[sales sample mapped keys] ${source.location_tag}:`, {
      expectedDayHeader: SALES_HEADERS.dayDate,
      expectedSkuHeader: SALES_HEADERS.sku,
      expectedProductHeader: SALES_HEADERS.productName,
      sampleDayValue,
      sampleSkuValue,
      sampleProductValue,
      parsedRowKeys: parsed.rows?.[0] ? Object.keys(parsed.rows[0]) : [],
    });

    const mapped = parsed.rows
      .map((r, idx) => {
        const row = mapSalesRow(source, r);

        if (idx < 3) {
          console.log(`[sales map result] ${source.location_tag} row ${idx}:`, {
            inputDay: r[SALES_HEADERS.dayDate],
            parsedDay: parseDateOnly(r[SALES_HEADERS.dayDate]),
            inputSku: r[SALES_HEADERS.sku],
            inputProduct: r[SALES_HEADERS.productName],
            mapped: row,
          });
        }

        return row;
      })
      .filter(Boolean);

    const collapsed = collapseSalesRows(mapped);

    stats.push({
      location_tag: source.location_tag,
      raw_rows: parsed.rows.length,
      mapped_rows: mapped.length,
      collapsed_rows: collapsed.length,
    });

    console.log(
      `[sales stats] ${source.location_tag}: raw=${parsed.rows.length}, mapped=${mapped.length}, collapsed=${collapsed.length}`
    );

    if (collapsed.length) {
      await upsertInChunks("sales_by_day", collapsed, "row_hash", false, 100);
      totalUpserted += collapsed.length;
      console.log(`[sales upserted] ${source.location_tag}: ${collapsed.length}`);
    } else {
      console.log(`[sales upserted] ${source.location_tag}: 0`);
    }

    console.log(`--- SALES SOURCE END: ${source.location_tag} ---`);
  }

  return {
    upserted: totalUpserted,
    stats,
  };
}

async function main() {
  console.log(`Starting Silo sync batch: ${BATCH_ID}`);
  console.log(`Snapshot at: ${SNAPSHOT_AT}`);

  const inventory = await syncInventory();
  const sales = await syncSalesByDay();

  const result = {
    batch_id: BATCH_ID,
    snapshot_at: SNAPSHOT_AT,
    inventory,
    sales,
  };

  console.log("Silo sync complete:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Silo sync failed:");
  console.error(err);
  process.exit(1);
});