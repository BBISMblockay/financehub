-- Materialize sales_velocity_by_sku_location_v to eliminate full sales_by_day
-- aggregate scan on every inventory board page load (was causing intermittent 500s).

-- Drop the plain view and replace with a materialized view + fast-refresh RPC.
drop view if exists sales_velocity_by_sku_location_v cascade;

create materialized view public.sales_velocity_by_sku_location_mv
as
  select
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
  group by lower(trim(location_tag)), trim(sku)
with data;

create unique index sales_velocity_mv_loc_sku
  on public.sales_velocity_by_sku_location_mv (location_tag, variant_sku);

-- Recreate the view name so existing queries/views continue to work unchanged.
create view public.sales_velocity_by_sku_location_v
  with (security_invoker = true)
as
  select * from public.sales_velocity_by_sku_location_mv;

-- Recreate inventory_workboard_v (dropped via cascade above) — identical definition.
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

-- RPC to refresh the velocity MV (called by nightly sync / manual trigger).
create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
as $$
begin
  refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
end;
$$;
