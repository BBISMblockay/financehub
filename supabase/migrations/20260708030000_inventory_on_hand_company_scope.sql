-- Finish company isolation for inventory_on_hand.
--
-- The column existed and Shopify-sourced snapshots stamped it, but:
-- 1. The Sheets nightly sync never stamped inventory rows (fixed in
--    scripts/sync-silo-inventory-sales.mjs alongside this migration), leaving
--    ~816k legacy rows with NULL company — invisible to the company-scoped
--    select policy and orphaned from any tenant.
-- 2. The old inventory_on_hand_admin_all policy (ALL for any admin-role user)
--    had NO company predicate. Policies are OR'd, so any company's admin
--    could read and write every row, silently bypassing
--    inventory_on_hand_select_company.

-- Backfill legacy Sheets rows to Baseballism.
update public.inventory_on_hand
set company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where company_entity_id is null;

create index if not exists inventory_on_hand_company_entity_id_idx
  on public.inventory_on_hand (company_entity_id);

-- Replace the company-blind admin policy with the standard company-bound
-- write policy (same shape as sales_by_day). Select policy already correct.
drop policy if exists inventory_on_hand_admin_all on public.inventory_on_hand;

create policy inventory_on_hand_active_write on public.inventory_on_hand
  for all to authenticated
  using (company_entity_id = active_company_id() and is_admin_user())
  with check (company_entity_id = active_company_id() and is_admin_user());
