// scripts/backfill-inventory-titles-from-sheets.mjs
//
// Repair product_title on inventory_on_hand from live Silo CSV exports.
// Use when CSVs have titles but Supabase rows (or inventory_workboard_v) do not.
//
// Required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Run:
//   node scripts/backfill-inventory-titles-from-sheets.mjs
//
// Optional:
//   SILO_ONLY_SOURCE=atlanta
//   BACKFILL_DRY_RUN=true

import { createClient } from "@supabase/supabase-js";
import {
  INVENTORY_SOURCES,
  getInventorySources,
  validateSources,
} from "../config/silo-sources.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ONLY_SOURCE = process.env.SILO_ONLY_SOURCE || "";
const DRY_RUN = process.env.BACKFILL_DRY_RUN === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

validateSources();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function norm(value) {
  return String(value ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
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
  if (!grid.length) return [];

  const headers = grid[0].map((h) => norm(h));
  return grid.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

function filterSources(sources) {
  if (!ONLY_SOURCE) return sources;
  return sources.filter((s) => s.location_tag === ONLY_SOURCE);
}

async function main() {
  const sources = filterSources(getInventorySources(INVENTORY_SOURCES));
  console.log(`Backfill product_title from Sheets (${sources.length} sources, dry_run=${DRY_RUN})`);

  let scanned = 0;
  let candidates = 0;
  let updated = 0;
  let errors = 0;

  for (const source of sources) {
    console.log(`--- ${source.location_tag} ---`);
    const csvText = await fetchText(source.inventory_csv_url);
    const rows = rowsToObjects(csvText);
    const titleBySku = new Map();

    for (const raw of rows) {
      const sku = pickLoose(raw, ["Variant SKU", "SKU"]);
      const title = pickLoose(raw, ["Product title", "Product name"]);
      if (!sku || !title) continue;
      titleBySku.set(sku, title);
    }

    console.log(`  CSV rows with title: ${titleBySku.size}`);

    for (const [sku, title] of titleBySku) {
      scanned += 1;

      const { data: existing, error: readErr } = await supabase
        .from("inventory_on_hand")
        .select("id, product_title, variant_sku, snapshot_at")
        .eq("location_tag", source.location_tag)
        .eq("variant_sku", sku)
        .order("snapshot_at", { ascending: false })
        .limit(20);

      if (readErr) {
        errors += 1;
        console.warn(`  read failed ${sku}: ${readErr.message}`);
        continue;
      }

      const needsFix = (existing || []).filter(
        (r) => !r.product_title || r.product_title === r.variant_sku
      );

      if (!needsFix.length) continue;

      candidates += needsFix.length;

      if (DRY_RUN) {
        console.log(`  would update ${sku}: "${title}" (${needsFix.length} rows)`);
        continue;
      }

      const ids = needsFix.map((r) => r.id);
      const { error: updErr } = await supabase
        .from("inventory_on_hand")
        .update({ product_title: title })
        .in("id", ids);

      if (updErr) {
        errors += 1;
        console.warn(`  update failed ${sku}: ${updErr.message}`);
        continue;
      }

      updated += ids.length;
    }
  }

  console.log("\nBackfill complete:");
  console.log(
    JSON.stringify({ scanned_skus: scanned, candidate_rows: candidates, updated_rows: updated, errors }, null, 2)
  );

  if (!DRY_RUN && updated > 0) {
    console.log(
      "\nIf inventory_workboard_v still shows null titles, the view definition needs to expose inventory_on_hand.product_title (not only products_master)."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
