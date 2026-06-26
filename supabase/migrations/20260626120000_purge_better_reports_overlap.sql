-- Removes better_reports rows for any location_tag + day_date that already has
-- a shopify_api row. Called after the nightly Google Sheets sync so Shopify
-- OAuth data is never shadowed by the legacy Better Reports feed.
create or replace function public.purge_better_reports_overlap(
  p_company_entity_id uuid default '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
)
returns table(deleted_rows bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  delete from public.sales_by_day br
  using public.sales_by_day api
  where br.source           = 'better_reports'
    and api.source          = 'shopify_api'
    and br.location_tag     = api.location_tag
    and br.day_date         = api.day_date
    and br.company_entity_id = p_company_entity_id
    and api.company_entity_id = p_company_entity_id;

  get diagnostics v_deleted = row_count;
  return query select v_deleted;
end;
$$;

grant execute on function public.purge_better_reports_overlap(uuid) to service_role;
