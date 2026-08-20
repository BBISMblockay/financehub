-- Enforce company_entity_id NOT NULL on sales_by_day and inventory_on_hand.
--
-- Both tables were backfilled and RLS-scoped by company_entity_id back in
-- 20260624000000/20260708030000, and the live Shopify sync
-- (scripts/lib/shopify-sync-core.mjs) has stamped company_entity_id on every
-- write since. A 2026-08-20 production audit confirmed zero NULL
-- company_entity_id rows on both tables. This migration just closes the
-- remaining schema-level gap (the column was never made NOT NULL, unlike
-- newer multi-tenant tables) — it does not change any data.
--
-- Guarded with an explicit check rather than assuming: if any environment
-- (e.g. a branch/staging DB) still has stray NULL rows, this raises a clear
-- error instead of failing (or silently succeeding in a way that leaves
-- those rows RLS-invisible without explanation).

do $$
declare
  v_sales_null_count bigint;
  v_inventory_null_count bigint;
begin
  select count(*) into v_sales_null_count
    from public.sales_by_day where company_entity_id is null;
  if v_sales_null_count > 0 then
    raise exception 'sales_by_day has % row(s) with NULL company_entity_id — backfill before enforcing NOT NULL', v_sales_null_count;
  end if;

  select count(*) into v_inventory_null_count
    from public.inventory_on_hand where company_entity_id is null;
  if v_inventory_null_count > 0 then
    raise exception 'inventory_on_hand has % row(s) with NULL company_entity_id — backfill before enforcing NOT NULL', v_inventory_null_count;
  end if;
end $$;

-- ALTER COLUMN ... SET NOT NULL is a no-op if already set, so this is safe to re-run.
alter table public.sales_by_day alter column company_entity_id set not null;
alter table public.inventory_on_hand alter column company_entity_id set not null;
