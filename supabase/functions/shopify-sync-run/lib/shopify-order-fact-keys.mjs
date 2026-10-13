/* Which unique key to upsert Shopify order facts on.
 *
 * 20261013220000 makes shopify_orders, _order_lines, _draft_orders and
 * shopify_payouts unique PER COMPANY (the old keys had no company_entity_id,
 * so a second company's sync of the same store MOVED the first company's
 * rows). PostgREST's onConflict must name a unique key that exists, so the
 * code has to work on both sides of that migration: it upserts on the
 * per-company key and, only when Postgres answers that no such constraint
 * exists, falls back to the old key -- remembered for the rest of the run, so
 * the miss costs one failed statement per table.
 *
 * So this code may merge and deploy BEFORE the migration applies. Not the
 * other way round: code without this module still upserts on the old key
 * only, and fails once the migration drops it. A run that settled on the old
 * key and then sees the migration land switches to the new key by itself.
 * While the old key is in force, a second company's sync is still dangerous and
 * lib/shopify-tenant-guard.mjs refuses it; once the migration applies, the
 * guard stands aside (shopify_order_facts_keyed_by_company()).
 *
 * `upsert` is the caller's upsertInChunks(supabase, table, rows, onConflict),
 * passed in so this module has no imports: it is copied verbatim into
 * supabase/functions/shopify-sync-run/lib/ and ad-platform-sync-run/lib/,
 * whose cores each have their own upsertInChunks. Pinned identical by
 * scripts/tests/shopify-order-fact-keys.test.mjs.
 */

export const ORDER_FACT_KEYS = {
  shopify_orders: {
    perCompany: 'shop_domain,order_id,company_entity_id',
    legacy: 'shop_domain,order_id',
  },
  shopify_order_lines: {
    perCompany: 'shop_domain,order_id,line_item_id,company_entity_id',
    legacy: 'shop_domain,order_id,line_item_id',
  },
  shopify_draft_orders: {
    perCompany: 'shop_domain,draft_order_id,company_entity_id',
    legacy: 'shop_domain,draft_order_id',
  },
  shopify_payouts: {
    perCompany: 'payout_id,company_entity_id',
    legacy: 'payout_id',
  },
};

// Postgres 42P10: "there is no unique or exclusion constraint matching the ON
// CONFLICT specification". Anything else is a real failure and is rethrown.
const NO_MATCHING_KEY = /no unique or exclusion constraint matching the ON CONFLICT/i;

// table -> 'perCompany' | 'legacy', once a statement has settled it.
const settled = new Map();

export function resetOrderFactKeyCache() {
  settled.clear();
}

export async function upsertOrderFact(upsert, supabase, table, rows) {
  const keys = ORDER_FACT_KEYS[table];
  if (!keys) throw new Error(`upsertOrderFact: ${table} is not an order-fact table`);
  if (!rows.length) return 0;
  // Settled on the old key, but the migration may have applied since (a long
  // nightly, a warm edge isolate): if the OLD key is the one now missing, the
  // per-company key is in force -- switch to it for good. Never the reverse.
  if (settled.get(table) === 'legacy') {
    try {
      return await upsert(supabase, table, rows, keys.legacy);
    } catch (err) {
      if (!NO_MATCHING_KEY.test(String(err && err.message))) throw err;
      const n = await upsert(supabase, table, rows, keys.perCompany);
      settled.set(table, 'perCompany');
      return n;
    }
  }
  try {
    const n = await upsert(supabase, table, rows, keys.perCompany);
    settled.set(table, 'perCompany');
    return n;
  } catch (err) {
    // A per-company key that worked and then "vanished" is a broken schema,
    // not a pre-migration database: never fall back to the cross-tenant key.
    if (settled.get(table) === 'perCompany' || !NO_MATCHING_KEY.test(String(err && err.message))) throw err;
    settled.set(table, 'legacy');
    return upsert(supabase, table, rows, keys.legacy);
  }
}
