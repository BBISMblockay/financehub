// scripts/backfill-company-entity-large-tables.mjs
//
// One-time backfill of company_entity_id on sales_by_day and inventory_on_hand.
// Calls the backfill_company_entity_batch() RPC which does the CTE+UPDATE
// entirely in Postgres — avoids sending large ID lists over the wire.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional:
//   BACKFILL_TABLES=sales_by_day,inventory_on_hand  (default: both)
//   BATCH_SIZE=2000                                  (override per-table default)
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

/** inventory_on_hand rows are wide + heavily indexed; keep batches small. */
const DEFAULT_BATCH_SIZE = {
  sales_by_day: 10000,
  inventory_on_hand: 2000,
};

function batchSizeFor(table) {
  if (process.env.BATCH_SIZE) return parseInt(process.env.BATCH_SIZE, 10);
  return DEFAULT_BATCH_SIZE[table] ?? 5000;
}

const TABLES = (process.env.BACKFILL_TABLES || "sales_by_day,inventory_on_hand")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function backfillTable(table) {
  const batchSize = batchSizeFor(table);
  console.log(`\n── ${table} (batch size: ${batchSize}) ──`);
  let total = 0;
  let batch = 0;

  while (true) {
    batch++;

    const { data: updated, error } = await db.rpc("backfill_company_entity_batch", {
      p_table: table,
      p_entity_id: BASEBALLISM_ENTITY_ID,
      p_batch_size: batchSize,
    });

    if (error) {
      console.error(`  [batch ${batch}] rpc error:`, error.message || JSON.stringify(error));
      throw error;
    }

    const count = updated ?? 0;
    total += count;
    console.log(`  batch ${batch}: ${count} rows updated (total: ${total})`);

    if (count === 0) {
      console.log(`  done. Total rows updated: ${total}`);
      break;
    }

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

  const status = nulls === 0 ? "✓" : "⚠";
  console.log(
    `  ${status} ${table}: ${total ?? "?"} total, ${nulls ?? "?"} remaining nulls`
  );
}

console.log(`Backfill starting. Tables: ${TABLES.join(", ")}`);
if (process.env.BATCH_SIZE) {
  console.log(`Batch size override: ${process.env.BATCH_SIZE} (all tables)`);
} else {
  console.log(
    `Batch sizes: ${TABLES.map((t) => `${t}=${batchSizeFor(t)}`).join(", ")}`
  );
}
console.log(`Entity id: ${BASEBALLISM_ENTITY_ID}`);

for (const table of TABLES) {
  await backfillTable(table);
}

console.log("\n── Verification ──");
for (const table of TABLES) {
  await verify(table);
}

console.log("\nBackfill complete.");
