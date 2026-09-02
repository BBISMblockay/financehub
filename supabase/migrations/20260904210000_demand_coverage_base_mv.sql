-- Seven tiles on the Logistics board read demand_coverage_by_type_v, and
-- every one re-scanned 66,539 inventory rows and 11,913 sales rows. Serially
-- that measured 787ms each and looked fine. Fired together by a dashboard
-- they contend, and every one hit the 30s statement timeout -- the board
-- rendered seven red tiles.
--
-- Testing a dashboard query serially does not test a dashboard.
--
-- Only the SALES and INVENTORY branches are materialised. The PURCHASE ORDER
-- branch deliberately stays live in the view: po_headers RLS is narrower
-- than company (is_admin_user() OR created_by = auth.uid()) and a matview is
-- built as the owner with RLS bypassed, so baking POs in here would hand
-- units-on-order to users the PO table refuses. It is also cheap.
--
-- ~250 rows across all companies, against ~78k scanned before. Measured
-- after: the wrapper reads in 3ms.
drop materialized view if exists public.demand_coverage_base_mv cascade;

create materialized view public.demand_coverage_base_mv as
with bounds as (
  select date_trunc('month', current_date::timestamptz)::date as this_month_start
),
sold as (
  select r.company_entity_id, r.product_type,
         sum(r.units) filter (where r.month_start >= ((select this_month_start from bounds) - interval '1 year')) as units_12m,
         sum(r.units) filter (where r.month_start >= ((select this_month_start from bounds) - interval '3 mons')) as units_3m
    from public.sales_monthly_product_type_rollup_mv r
   where nullif(r.product_type, '') is not null
     and r.month_start < (select this_month_start from bounds)
   group by 1, 2
),
onhand as (
  select i.company_entity_id, i.product_type,
         sum(i.total_available_quantity) as on_hand
    from public.inventory_on_hand_current_mv i
   where nullif(i.product_type, '') is not null
   group by 1, 2
)
select coalesce(s.company_entity_id, o.company_entity_id) as company_entity_id,
       coalesce(s.product_type, o.product_type)           as product_type,
       s.units_12m, s.units_3m, o.on_hand,
       s.company_entity_id is not null as has_sales_history,
       o.company_entity_id is not null as has_inventory
  from sold s
  full join onhand o
    on o.company_entity_id = s.company_entity_id and o.product_type = s.product_type;

-- Required for REFRESH ... CONCURRENTLY, which keeps the board readable
-- while the nightly sync runs.
create unique index if not exists demand_coverage_base_mv_uq
  on public.demand_coverage_base_mv (company_entity_id, product_type);

-- REQUIRED, and easy to forget: CREATE MATERIALIZED VIEW picks up Supabase's
-- default privileges on the public schema, which grant SELECT to anon and
-- authenticated. A matview has NO RLS, so without this revoke the thing is
-- readable across every tenant -- every company's product-type sales and
-- on-hand quantities, to any logged-in user and to anon. That is exactly
-- what happened when this view was first created; the verify script's
-- `reports_runnable` check caught it on its first run. Every other matview
-- here carries the same revoke.
revoke all on public.demand_coverage_base_mv from anon, authenticated;

-- Access is through this wrapper only: security_invoker = false so it may
-- read the matview, with the tenant filter written inside. Same layering as
-- inventory_on_hand_current_v.
create or replace view public.demand_coverage_base_v as
  select * from public.demand_coverage_base_mv
   where company_entity_id = active_company_id();

alter view public.demand_coverage_base_v set (security_invoker = false);
grant select on public.demand_coverage_base_v to authenticated;

create or replace function public.refresh_demand_coverage_base_mv()
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $$
begin
  begin
    refresh materialized view concurrently public.demand_coverage_base_mv;
  exception when others then
    refresh materialized view public.demand_coverage_base_mv;
  end;
end;
$$;

comment on materialized view public.demand_coverage_base_mv is
  'Sales-and-inventory half of demand coverage, per company per product type (~250 rows). Exists because seven Logistics tiles each re-scanned 66k inventory rows and, fired together by a dashboard, all hit the 30s statement timeout. Purchase orders are deliberately NOT here: po_headers RLS is narrower than company and a matview bypasses RLS, so baking POs in would widen units-on-order. Read through demand_coverage_base_v, never directly -- no RLS on a matview. Refreshed by refresh_demand_coverage_base_mv() at the end of the Shopify sync, after the two matviews it reads.';
