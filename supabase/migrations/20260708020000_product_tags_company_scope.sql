-- Company-scope product_tags like the rest of the operational tables.
--
-- The table came from a legacy Google Sheet import and was skipped by the
-- 20260616 multi-tenant backfill; its policies were plain
-- authenticated-read / admin-write, so any future second company's users
-- would have seen Baseballism's catalog tags through the Products page's
-- Catalog tab. Tags are now managed in SILO alone, so the table gets the
-- standard treatment: company column, Baseballism backfill, insert stamp
-- trigger, and active-company RLS.

alter table public.product_tags
  add column if not exists company_entity_id uuid;

update public.product_tags
set company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
where company_entity_id is null;

create index if not exists product_tags_company_entity_id_idx
  on public.product_tags (company_entity_id);

-- Stamp inserts with the active company when the client omits the column
-- (same trigger every other company-scoped table uses).
drop trigger if exists stamp_company_entity_id on public.product_tags;
create trigger stamp_company_entity_id
  before insert on public.product_tags
  for each row
  execute function public.stamp_company_entity_id();

-- Replace the legacy open policies with active-company isolation.
-- Write semantics preserved: admin-only, now additionally company-bound.
drop policy if exists "Allow authenticated read product_tags" on public.product_tags;
drop policy if exists product_tags_select_authenticated on public.product_tags;
drop policy if exists product_tags_insert_admin_only on public.product_tags;
drop policy if exists product_tags_update_admin_only on public.product_tags;
drop policy if exists product_tags_delete_admin_only on public.product_tags;

create policy product_tags_active_select on public.product_tags
  for select to authenticated
  using (company_entity_id = active_company_id());

create policy product_tags_active_write on public.product_tags
  for all to authenticated
  using (company_entity_id = active_company_id() and is_admin_user())
  with check (company_entity_id = active_company_id() and is_admin_user());
