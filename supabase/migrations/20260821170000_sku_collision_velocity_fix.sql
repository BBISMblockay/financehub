-- Fixes the "Doubles and Bubbles Cap - Toddler" misattribution (Kalin,
-- 2026-08-21): a never-launched Shopify listing shared its SKU with the real
-- "Bubbles and Doubles Cap - Youth" product. sales_velocity_by_sku_location_mv
-- grouped sales_by_day by (company, location, sku) ALONE, with no product
-- identity in the key, so two different products sharing one SKU had their
-- sales summed into a single velocity row -- and inventory_workboard_v's
-- location+sku join then attached that blended number to BOTH products'
-- inventory rows.
--
-- The companion sync-code fix (scripts/lib/shopify-sync-core.mjs and its
-- supabase/functions/shopify-sync-run mirror) already stopped collapsing
-- sales_by_day rows and inventory_on_hand rows across different products
-- that happen to share a SKU. This migration widens the velocity MV and the
-- workboard join to match: (location, sku, product_name) instead of
-- (location, sku) alone, so the two products' numbers stay separated all
-- the way through to the report.
--
-- Known tradeoff: sales_by_day.product_name is the AS-SOLD line-item title,
-- frozen at order time, while inventory_on_hand.product_title reflects
-- Shopify's CURRENT product title. A product renamed within the trailing
-- velocity window (7/30/90/365d) will show reduced velocity for the days
-- still under its old title until the rename ages out of that window. This
-- is a narrow, self-healing edge case -- and a much smaller blast radius
-- than the SKU-collision misattribution it replaces, which silently blended
-- unrelated products' numbers together with no self-healing at all.

drop view if exists public.inventory_workboard_v;
drop view if exists public.sales_velocity_by_sku_location_v;
drop materialized view if exists public.sales_velocity_by_sku_location_mv;

create materialized view public.sales_velocity_by_sku_location_mv as
  select
    company_entity_id,
    lower(trim(location_tag))          as location_tag,
    trim(sku)                          as variant_sku,
    coalesce(trim(product_name), '')   as product_name,
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
  group by company_entity_id, lower(trim(location_tag)), trim(sku), coalesce(trim(product_name), '')
with no data;

create unique index sales_velocity_mv_co_loc_sku_name
  on public.sales_velocity_by_sku_location_mv (company_entity_id, location_tag, variant_sku, product_name);

revoke all on public.sales_velocity_by_sku_location_mv from anon, authenticated, public;
grant select on public.sales_velocity_by_sku_location_mv to service_role;

-- Company-filtered reader. DEFINER (security_invoker = false), matching the
-- 20260708060000 fix -- an invoker view here needs SELECT on the locked-down
-- MV directly, which is exactly what that migration closed off.
create view public.sales_velocity_by_sku_location_v
  with (security_invoker = false)
as
  select location_tag, variant_sku, product_name, qty_7d, qty_30d, qty_90d, qty_120d,
         qty_365d, avg_day_7, avg_day_30, avg_day_90, avg_day_120,
         avg_day_365, last_sold_date
  from public.sales_velocity_by_sku_location_mv
  where company_entity_id = active_company_id();

grant select on public.sales_velocity_by_sku_location_v to authenticated;

-- Recreate inventory_workboard_v (dropped above) — join now also requires
-- product_name to match, so two products sharing a SKU each get their own
-- velocity numbers instead of one blended row attached to both.
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
    and trim(i.variant_sku)         = v.variant_sku
    and trim(i.product_title)       = v.product_name;

grant select on public.inventory_workboard_v to authenticated;

-- refresh_sales_velocity_mv() is unchanged (still refreshes this MV by name)
-- but is recreated here anyway since CONCURRENTLY refresh depends on the new
-- unique index existing under its new definition.
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
