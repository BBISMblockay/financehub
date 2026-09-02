-- Point demand_coverage_by_type_v at the materialised base (20260904210000).
-- The PO branch stays live and stays under the CALLER's RLS -- see that
-- migration's header for why it must not be materialised.
create or replace view public.demand_coverage_by_type_v as
with co as (
  select active_company_id() as id
),
base as (
  select product_type, units_12m, units_3m, on_hand, has_sales_history, has_inventory
    from public.demand_coverage_base_v
),
onorder as (
  select pl.product_type_snapshot as product_type,
         sum(pl.qty) filter (where h.status = any (array['Confirmed','Sent to Factory','In Production','In Transit'])) as on_order,
         sum(pl.qty) filter (where h.status = 'Draft') as on_order_draft
    from po_lines pl
    join po_headers h on h.id = pl.po_header_id, co
   where pl.company_entity_id = co.id
     and nullif(pl.product_type_snapshot, '') is not null
   group by pl.product_type_snapshot
),
types as (
  select product_type from base
  union select product_type from onorder
)
select t.product_type,
       coalesce(b.has_sales_history, false) as has_sales_history,
       coalesce(b.has_inventory, false)     as has_inventory,
       oo.product_type is not null          as has_purchase_history,
       coalesce(b.on_hand, 0)::numeric               as units_on_hand,
       coalesce(oo.on_order, 0)::numeric             as units_on_order,
       coalesce(oo.on_order_draft, 0)::numeric       as units_on_order_draft,
       (coalesce(b.on_hand, 0) + coalesce(oo.on_order, 0))::numeric as units_available_committed,
       b.units_12m,
       b.units_3m,
       round(b.units_12m / 52.0, 1) as units_per_week_12m,
       round(b.units_3m / 13.0, 1)  as units_per_week_3m,
       case when b.units_12m > 0
            then round((coalesce(b.on_hand, 0) + coalesce(oo.on_order, 0))::numeric / (b.units_12m / 52.0), 1)
       end as weeks_of_cover,
       case when b.units_12m > 0 and b.units_3m is not null
            then round((b.units_3m / 13.0 / (b.units_12m / 52.0) - 1) * 100, 1)
       end as momentum_pct
  from types t
  left join base    b  on b.product_type  = t.product_type
  left join onorder oo on oo.product_type = t.product_type;

alter view public.demand_coverage_by_type_v set (security_invoker = true);
grant select on public.demand_coverage_by_type_v to authenticated;

comment on view public.demand_coverage_by_type_v is
  'Per product type: whether sales history / inventory / purchase history exist, plus weeks of cover and 3m-vs-12m momentum. Sales and inventory come from demand_coverage_base_v (a matview wrapper, refreshed nightly); purchase orders are read LIVE under the caller''s own RLS because po_headers is narrower than company and must not be materialised. Stays security_invoker for the same reason.';
