/* One Shopify store, two companies: whose orders are they?
 *
 * shopify_orders (shop_domain, order_id), shopify_order_lines (shop_domain,
 * order_id, line_item_id), shopify_draft_orders (shop_domain, draft_order_id)
 * and shopify_payouts (payout_id) are unique WITHOUT company_entity_id, and
 * every sync upserts on those keys with the service role. So a second
 * company's connection to a store another company already syncs does not
 * get its own copy of the orders: its upsert REWRITES the existing rows'
 * company_entity_id, moving them out of one tenant and into another, and the
 * nightly moves them again every night after.
 *
 * Live on 2026-10-13: baseballismmlb is synced by Baseballism and also
 * connected (off, never imported) under BlockayOps; baseballismchicago and
 * baseballismdsg are synced by Baseballism and also connected (off) under
 * Test Company. PR #971's "Start first import" offered the BlockayOps row.
 *
 * The rule: a connection may write order facts for a store only if no OTHER
 * company already holds that store's order facts. Keyed on the rows, not on
 * which connection is older or enabled, because the rows are what would
 * move -- and the company that has them keeps them. sales_by_day and
 * inventory_on_hand hash company_entity_id into their key, so they are
 * duplicated per company, never moved, and need no guard.
 *
 * Fails CLOSED: a check that cannot be made blocks the sync, because the
 * cost of guessing wrong is another tenant's data.
 *
 * ONE row per table is read, by shop_domain alone (index-backed). That is
 * exact because a store's order facts belong to a single company: verified
 * on production 2026-10-13 (no shop_domain in any of the three tables has
 * rows under two companies), and this guard is what keeps it so -- the
 * first company to write a store's facts is the only one that ever can.
 * The tempting `.neq('company_entity_id', ...)` form has to step past every
 * row of the caller's own: 8.1 s on Baseballism's largest store (616k rows).
 *
 * Verbatim copy in supabase/functions/shopify-sync-run/lib/ (pinned by
 * scripts/tests/shopify-tenant-guard.test.mjs). Edit this one and re-copy.
 */

export const ORDER_FACT_TABLES = ['shopify_orders', 'shopify_draft_orders', 'shopify_payouts'];

export async function orderFactsHeldElsewhere(supabase, connection) {
  const domain = connection && connection.shop_domain;
  const companyId = connection && connection.company_entity_id;
  if (!domain || !companyId) {
    return { blocked: true, reason: 'the connection has no shop_domain or company, so ownership cannot be checked' };
  }
  for (const table of ORDER_FACT_TABLES) {
    const { data, error } = await supabase.from(table)
      .select('company_entity_id')
      .eq('shop_domain', domain)
      .limit(1);
    if (error) {
      return { blocked: true, reason: `could not check ${table} for ${domain}: ${error.message}` };
    }
    const holder = data && data[0] && data[0].company_entity_id;
    const other = holder && holder !== companyId ? holder : null;
    if (other) {
      return {
        blocked: true,
        heldBy: other,
        table,
        reason: `${domain}'s ${table} rows belong to company ${other}; syncing it from company ${companyId} would move them`,
      };
    }
  }
  return { blocked: false };
}
