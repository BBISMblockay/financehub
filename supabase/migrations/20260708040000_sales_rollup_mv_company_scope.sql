-- Company-scope the monthly sales rollup (planning-scenarios' baseline data).
--
-- sales_monthly_product_type_rollup_mv aggregated ALL companies' sales_by_day
-- into one blended rollup with no company column, and 20260625140000 granted
-- authenticated direct SELECT on it — materialized views bypass RLS, so
-- test-co users saw Baseballism's numbers in Planning Scenarios (and
-- Baseballism's rollup silently included test-co rows). The identically
-- shaped security-invoker view existed but nothing used it and it computed
-- live over 4.7M rows.
--
-- New shape (same pattern as inventory_on_hand_current_mv):
--   MV: grouped by company_entity_id, service_role-only
--   View: security_invoker, filters company_entity_id = active_company_id()
--   RPC: refresh_sales_monthly_rollup_mv() — called by the nightly Shopify sync

drop view if exists public.sales_monthly_product_type_rollup_v;
drop materialized view if exists public.sales_monthly_product_type_rollup_mv;

create materialized view public.sales_monthly_product_type_rollup_mv as
select
  company_entity_id,
  (date_trunc('month', day_date::timestamptz))::date as month_start,
  to_char(date_trunc('month', day_date::timestamptz), 'YYYY-MM') as month_key,
  location_tag as location,
  case
    when location_tag = 'online' then 'online'
    when location_tag ilike '%wholesale%' then 'wholesale'
    when location_tag ilike '%faire%' then 'wholesale'
    when location_tag ilike '%dsg%' then 'wholesale'
    when location_tag ilike '%popup%' or location_tag ilike '%pop_up%' then 'event'
    else 'retail'
  end as channel,
  coalesce(nullif(product_type, ''), 'Uncategorized') as product_type,
  count(*) as rows,
  count(distinct sku) as unique_skus,
  sum(coalesce(total_quantity_sold, 0))::numeric as units,
  round(sum(coalesce(total_gross_sales, 0)), 2) as gross,
  round(sum(coalesce(total_discounts, 0)), 2) as discounts,
  round(sum(coalesce(total_refunds, 0)), 2) as refunds,
  round(sum(coalesce(total_net_sales, 0)), 2) as net,
  round(sum(coalesce(total_sales, 0)), 2) as total_sales,
  round(sum(coalesce(total_net_sales, 0)) / nullif(sum(coalesce(total_quantity_sold, 0))::numeric, 0), 2) as avg_net_per_unit
from public.sales_by_day
where company_entity_id is not null
group by company_entity_id, 2, 3, location_tag, 5, 6
with no data;

create unique index sales_monthly_rollup_mv_uq
  on public.sales_monthly_product_type_rollup_mv (company_entity_id, month_key, location, product_type);

-- MV bypasses RLS — only the refresh path may touch it directly.
revoke select on public.sales_monthly_product_type_rollup_mv from anon, authenticated;
grant select on public.sales_monthly_product_type_rollup_mv to service_role;

-- Company-filtered reader (what pages use). Same output columns as before.
create view public.sales_monthly_product_type_rollup_v
with (security_invoker = true) as
select month_start, month_key, location, channel, product_type,
       rows, unique_skus, units, gross, discounts, refunds, net,
       total_sales, avg_net_per_unit
from public.sales_monthly_product_type_rollup_mv
where company_entity_id = active_company_id();

grant select on public.sales_monthly_product_type_rollup_v to authenticated;

create or replace function public.refresh_sales_monthly_rollup_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  -- concurrently requires the unique index above and a populated MV;
  -- fall back to a plain refresh the first time (WITH NO DATA above).
  begin
    refresh materialized view concurrently public.sales_monthly_product_type_rollup_mv;
  exception when others then
    refresh materialized view public.sales_monthly_product_type_rollup_mv;
  end;
end;
$$;

revoke execute on function public.refresh_sales_monthly_rollup_mv() from public, anon, authenticated;
grant execute on function public.refresh_sales_monthly_rollup_mv() to service_role;
