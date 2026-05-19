// scripts/audit-inventory-product-titles.mjs
//
// Compare product titles across:
//   1) Live Silo inventory CSV exports (Google Sheets)
//   2) public.inventory_on_hand (raw sync table)
//   3) public.inventory_workboard_v (what the inventory UI reads)
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-inventory-product-titles.mjs
//
// Optional:
//   AUDIT_SKUS=71/2-MoneyBall-Cap,FM-M-HomeoftheBrave2.0-Mens

import { createClient } from "@supabase/supabase-js";
import { getInventorySources, INVENTORY_SOURCES, validateSources } from "../config/silo-sources.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_SKUS = [
  "71/2-MoneyBall-Cap",
  "FM-M-HomeoftheBrave2.0-Mens",
  "JR-FM-73/8-Jackie42-Cap",
  "MLB-L-GeorgiaFieldASG(Navy)-Mens",
];

const AUDIT_SKUS = (process.env.AUDIT_SKUS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SKUS = AUDIT_SKUS.length ? AUDIT_SKUS : DEFAULT_SKUS;

function norm(value) {
  return String(value ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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

function pickLoose(row, candidates) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) {
    const cleanKey = String(key || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    normalized[cleanKey] = value;
  }
  for (const candidate of candidates) {
    const cleanCandidate = String(candidate || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const value = normalized[cleanCandidate];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

async function loadCsvTitlesBySku() {
  validateSources();
  const sources = getInventorySources(INVENTORY_SOURCES);
  const bySku = new Map();

  for (const source of sources) {
    const csvText = await fetchText(source.inventory_csv_url);
    const parsed = rowsToObjects(csvText);

    for (const raw of parsed.rows) {
      const sku = pickLoose(raw, ["Variant SKU", "SKU"]);
      if (!sku || !SKUS.includes(sku)) continue;

      const title = pickLoose(raw, ["Product title", "Product name"]);

      bySku.set(`${source.location_tag}::${sku}`, {
        location_tag: source.location_tag,
        sku,
        csv_product_title: title || null,
        csv_variant_title: pickLoose(raw, ["Variant title"]) || null,
      });
    }
  }

  return bySku;
}

async function main() {
  console.log("=== Inventory product title audit ===");
  console.log(`SKUs: ${SKUS.join(", ")}`);

  const csvByKey = await loadCsvTitlesBySku();
  console.log(`\n[csv] matched ${csvByKey.size} location+sku rows from live Sheets exports`);

  for (const [key, row] of csvByKey) {
    console.log(
      `  ${key} -> title="${row.csv_product_title || "(empty)"}" variant="${row.csv_variant_title || ""}"`
    );
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log(
      "\n[supabase] skipped (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to compare DB + workboard view)"
    );
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: onHand, error: onHandErr } = await supabase
    .from("inventory_on_hand")
    .select(
      "location_tag, variant_sku, product_title, variant_title, source, snapshot_at, sync_batch_id"
    )
    .in("variant_sku", SKUS)
    .order("snapshot_at", { ascending: false })
    .limit(500);

  if (onHandErr) throw new Error(`inventory_on_hand: ${onHandErr.message}`);

  const latestOnHand = new Map();
  for (const row of onHand || []) {
    const key = `${row.location_tag}::${row.variant_sku}`;
    if (!latestOnHand.has(key)) latestOnHand.set(key, row);
  }

  console.log(`\n[inventory_on_hand] ${latestOnHand.size} latest rows (by location+sku)`);
  for (const sku of SKUS) {
    const rows = [...latestOnHand.values()].filter((r) => r.variant_sku === sku);
    if (!rows.length) {
      console.log(`  ${sku}: (no rows)`);
      continue;
    }
    for (const r of rows) {
      console.log(
        `  ${r.location_tag} | title="${r.product_title || "(null)"}" | source=${r.source} | snapshot=${r.snapshot_at}`
      );
    }
  }

  const { data: workboard, error: wbErr } = await supabase
    .from("inventory_workboard_v")
    .select("location_tag, variant_sku, product_title, variant_title, product_type")
    .in("variant_sku", SKUS)
    .limit(500);

  if (wbErr) throw new Error(`inventory_workboard_v: ${wbErr.message}`);

  console.log(`\n[inventory_workboard_v] ${(workboard || []).length} rows`);
  for (const sku of SKUS) {
    const rows = (workboard || []).filter((r) => r.variant_sku === sku);
    if (!rows.length) {
      console.log(`  ${sku}: (no rows)`);
      continue;
    }
    for (const r of rows) {
      console.log(
        `  ${r.location_tag} | title="${r.product_title || "(null)"}" | type=${r.product_type || ""}`
      );
    }
  }

  console.log("\n=== Diagnosis hints ===");
  console.log(
    "- CSV has title but inventory_on_hand is null → nightly sync not writing titles (check GitHub Actions / sync logs)."
  );
  console.log(
    "- inventory_on_hand has title but workboard_v is null → fix inventory_workboard_v view (likely joins products_master only)."
  );
  console.log(
    "- Old shopify snapshots with null/sku titles → run: node scripts/backfill-inventory-titles-from-sheets.mjs"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
