// scripts/backfill-company-entity-large-tables.mjs
//
// One-time backfill of company_entity_id on sales_by_day and inventory_on_hand.
// Uses the service role key (bypasses RLS) to stamp all null rows with the
// Baseballism entity id. Runs in batches to avoid timeouts.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional:
//   BACKFILL_TABLES=sales_by_day,inventory_on_hand  (default: both)
//   BATCH_SIZE=50000                                 (default: 50000)
//
// Run:
//   node scripts/backfill-company-entity-large-tables.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const BASEBALLISM_ENTITY_ID = "3bd934c9-4cdd-429b-9076-f8f6b45d4eb7";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50000", 10);
const TABLES = (process.env.BACKFILL_TABLES || "sales_by_day,inventory_on_hand")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function backfillTable(table) {
  console.log(`\n── ${table} ──`);
  let total = 0;
  let batch = 0;

  while (true) {
    batch++;

    // Fetch a batch of IDs that still need stamping
    const { data: rows, error: fetchErr } = await db
      .from(table)
      .select("id")
      .is("company_entity_id", null)
      .limit(BATCH_SIZE);

    if (fetchErr) {
      console.error(`  [batch ${batch}] fetch error:`, fetchErr.message);
      throw fetchErr;
    }

    if (!rows || rows.length === 0) {
      console.log(`  done. Total rows updated: ${total}`);
      break;
    }

    const ids = rows.map((r) => r.id);

    const { error: updateErr } = await db
      .from(table)
      .update({ company_entity_id: BASEBALLISM_ENTITY_ID })
      .in("id", ids);

    if (updateErr) {
      console.error(`  [batch ${batch}] update error:`, updateErr.message);
      throw updateErr;
    }

    total += ids.length;
    console.log(`  batch ${batch}: ${ids.length} rows → total ${total}`);

    // Short pause between batches to keep Supabase happy
    await new Promise((r) => setTimeout(r, 500));
  }

  return total;
}

async function verify(table) {
  const { count: total } = await db
    .from(table)
    .select("*", { count: "exact", head: true });

  const { count: nulls } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .is("company_entity_id", null);

  console.log(
    `  ${table}: ${total ?? "?"} total rows, ${nulls ?? "?"} remaining nulls`
  );
  if (nulls > 0) {
    console.warn(`  ⚠ ${nulls} rows still unset in ${table}`);
  }
}

console.log(`Backfill starting. Tables: ${TABLES.join(", ")}`);
console.log(`Batch size: ${BATCH_SIZE}`);
console.log(`Entity id: ${BASEBALLISM_ENTITY_ID}\n`);

for (const table of TABLES) {
  await backfillTable(table);
}

console.log("\n── Verification ──");
for (const table of TABLES) {
  await verify(table);
}

console.log("\nBackfill complete.");
