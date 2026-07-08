-- Company-scope the sales velocity chain (inventory workboard + planning
-- demand math). Completes the MV isolation sweep: inventory_on_hand_current_mv
-- (already scoped), sales_monthly_product_type_rollup_mv (20260708040000),
-- and now sales_velocity_by_sku_location_mv.
--
-- The velocity MV grouped ALL companies' sales_by_day by (location, sku) with
-- no company column, and inventory_workboard_v joined it on location+sku only
-- — so a test-co inventory row whose location/SKU collides with Baseballism's
-- (e.g. 'online' + shared seed SKUs) picked up Baseballism's sell-through.
--
-- Same pattern as the other MVs: company column in the MV, service_role-only
-- access, and the security-invoker view filters active_company_id() so the
-- workboard join becomes same-company by construction (its output columns are
-- unchanged).

drop view if exists public.inventory_workboard_v;
drop view if exists public.sales_velocity_by_sku_location_v;
drop materialized view if exists public.sales_velocity_by_sku_location_mv;

create materialized view public.sales_velocity_by_sku_location_mv as
  select
    company_entity_id,
    lower(trim(location_tag))   as location_tag,
    trim(sku)                   as variant_sku,
    sum(case when day_date >= current_date - interval '7 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_7d,
    sum(case when day_date >= current_date - interval '30 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_30d,
    sum(case when day_date >= current_date - interval '90 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_90d,
    sum(case when day_date >= current_date - interval '120 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_120d,
    sum(case when day_date >= current_date - interval '365 days'
             then coalesce(total_quantity_sold, 0) else 0 end)  as qty_365d,
    round(sum(case when day_date >= current_date - interval '7 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 7,   4) as avg_day_7,
    round(sum(case when day_date >= current_date - interval '30 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 30,  4) as avg_day_30,
    round(sum(case when day_date >= current_date - interval '90 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 90,  4) as avg_day_90,
    round(sum(case when day_date >= current_date - interval '120 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 120, 4) as avg_day_120,
    round(sum(case when day_date >= current_date - interval '365 days'
                   then coalesce(total_quantity_sold, 0) else 0 end)::numeric / 365, 4) as avg_day_365,
    max(day_date) filter (where coalesce(total_quantity_sold, 0) <> 0) as last_sold_date
  from public.sales_by_day
  where sku is not null and trim(sku) <> ''
    and company_entity_id is not null
  group by company_entity_id, lower(trim(location_tag)), trim(sku)
with no data;

create unique index sales_velocity_mv_co_loc_sku
  on public.sales_velocity_by_sku_location_mv (company_entity_id, location_tag, variant_sku);

revoke select on public.sales_velocity_by_sku_location_mv from anon, authenticated, public;
grant select on public.sales_velocity_by_sku_location_mv to service_role;

-- Company-filtered reader — output columns unchanged (no company col), so the
-- workboard join below and any other consumer keep working as-is.
create view public.sales_velocity_by_sku_location_v
  with (security_invoker = true)
as
  select location_tag, variant_sku, qty_7d, qty_30d, qty_90d, qty_120d,
         qty_365d, avg_day_7, avg_day_30, avg_day_90, avg_day_120,
         avg_day_365, last_sold_date
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = active_company_id();

grant select on public.sales_velocity_by_sku_location_v to authenticated;

-- Recreate inventory_workboard_v (dropped above) — identical definition;
-- both join sides are now company-filtered.
create view public.inventory_workboard_v
  with (security_invoker = true)
as
  select
    i.id,
    i.location_tag,
    i.source,
    i.location,
    i.product_title,
    i.variant_title,
    i.variant_sku,
    i.shop_domain,
    i.variant_barcode,
    i.est_oos_date,
    i.variant_created_at,
    i.product_type,
    i.product_image,
    i.product_image_url,
    i.retail_price,
    i.total_available_quantity,
    i.total_available_inventory_value,
    i.qty_sold_30d,
    i.avg_qty_sold_per_day,
    i.est_days_before_oos,
    i.snapshot_at,
    i.row_hash,
    i.location_name,
    i.sync_batch_id,
    i.company_entity_id,
    coalesce(v.qty_7d,     0) as qty_7d,
    coalesce(v.qty_30d,    0) as sold_30,
    coalesce(v.qty_90d,    0) as qty_90d,
    coalesce(v.qty_120d,   0) as qty_120d,
    coalesce(v.qty_365d,   0) as qty_365d,
    coalesce(v.avg_day_7,  0) as avg_day_7,
    coalesce(v.avg_day_30, 0) as avg_day_30,
    coalesce(v.avg_day_90, 0) as avg_day_90,
    coalesce(v.avg_day_120,0) as avg_day_120,
    coalesce(v.avg_day_365,0) as avg_day_365,
    v.last_sold_date,
    case
      when coalesce(v.avg_day_30, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_30, 1)
      when coalesce(v.avg_day_7, 0) > 0
        then round(coalesce(i.total_available_quantity, 0)::numeric / v.avg_day_7, 1)
      else null
    end as days_oos,
    case
      when coalesce(v.avg_day_30, 0) > 0 then '30d'
      when coalesce(v.avg_day_7,  0) > 0 then '7d'
      else 'none'
    end as velocity_basis
  from public.inventory_on_hand_current_v i
  left join public.sales_velocity_by_sku_location_v v
    on  lower(trim(i.location_tag)) = v.location_tag
    and trim(i.variant_sku)         = v.variant_sku;

grant select on public.inventory_workboard_v to authenticated;

-- Refresh RPC: concurrent when possible, plain fallback for the first
-- populate after a rebuild (WITH NO DATA above).
create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  begin
    refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
  exception when others then
    refresh materialized view public.sales_velocity_by_sku_location_mv;
  end;
end;
$$;

revoke execute on function public.refresh_sales_velocity_mv() from public, anon, authenticated;
grant execute on function public.refresh_sales_velocity_mv() to service_role;

-- sales_sku_location_rollup_mv: orphaned (no dependents, no repo references),
-- no company column — lock it down pending deletion in a later cleanup.
revoke select on public.sales_sku_location_rollup_mv from anon, authenticated, public;
