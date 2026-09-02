-- demand_coverage_by_type_v errored for every authenticated user.
--
--   ERROR: 42501: permission denied for materialized view
--          sales_monthly_product_type_rollup_mv
--
-- The view is `security_invoker = true` and read two MATERIALIZED VIEWS
-- directly. Postgres does not apply RLS to a matview, so neither is granted
-- to `authenticated` -- and under security_invoker the caller needs the
-- privilege itself. So the view did not return fewer rows, it raised. Any
-- page or Ask SILO answer touching it failed outright.
--
-- The obvious fix is the wrong one. `grant select on
-- sales_monthly_product_type_rollup_mv to authenticated` would make the
-- error go away and hand every authenticated user EVERY COMPANY'S monthly
-- sales, because there is no RLS on a matview to stop them querying it
-- directly. That is the trap this codebase already documents.
--
-- The house pattern is a wrapper view: `security_invoker = false` (so it
-- runs as the owner, which may read the matview) with the tenant filter
-- written into the wrapper. Both wrappers ALREADY EXIST and are already
-- granted -- `sales_monthly_product_type_rollup_v` and
-- `inventory_on_hand_current_v`. This view simply never used them.
--
-- Note what is deliberately NOT changed: the view stays
-- `security_invoker = true`. Flipping the whole thing to definer would have
-- fixed the error in one line and quietly widened PO visibility --
-- `po_headers_active_select` is `company AND (is_admin_user() OR created_by
-- = auth.uid())`, narrower than company alone, and a definer view would
-- bypass it. The units-on-order column would then have been visible to
-- people the PO table refuses. Keeping the view as invoker means the PO
-- branch still runs under the caller's own RLS; only the matview reads are
-- delegated, which is exactly as much bypass as the problem needs.
create or replace view public.demand_coverage_by_type_v as
with co as (
  select active_company_id() as id
),
bounds as (
  select date_trunc('month', current_date::timestamptz)::date as this_month_start
),
sold as (
  -- Wrapper, not the matview. It is security_invoker = false and carries the
  -- company filter itself, so there is no company predicate to repeat here
  -- (the wrapper does not even expose company_entity_id).
  select r.product_type,
         sum(r.units) filter (where r.month_start >= ((select this_month_start from bounds) - interval '1 year')) as units_12m,
         sum(r.units) filter (where r.month_start >= ((select this_month_start from bounds) - interval '3 mons')) as units_3m
    from sales_monthly_product_type_rollup_v r
   where nullif(r.product_type, '') is not null
     and r.month_start < (select this_month_start from bounds)
   group by r.product_type
),
onhand as (
  -- Same wrapper treatment. The company predicate is kept because this
  -- wrapper does expose the column, and a redundant tenant filter is cheap
  -- insurance against the wrapper ever being re-pointed.
  select i.product_type,
         sum(i.total_available_quantity) as on_hand
    from inventory_on_hand_current_v i, co
   where i.company_entity_id = co.id
     and nullif(i.product_type, '') is not null
   group by i.product_type
),
onorder as (
  -- Real tables with real RLS, read as the CALLER. Unchanged.
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
  select product_type from sold
  union select product_type from onhand
  union select product_type from onorder
)
select t.product_type,
       s.product_type is not null  as has_sales_history,
       oh.product_type is not null as has_inventory,
       oo.product_type is not null as has_purchase_history,
       coalesce(oh.on_hand, 0)::numeric          as units_on_hand,
       coalesce(oo.on_order, 0)::numeric         as units_on_order,
       coalesce(oo.on_order_draft, 0)::numeric   as units_on_order_draft,
       (coalesce(oh.on_hand, 0) + coalesce(oo.on_order, 0))::numeric as units_available_committed,
       s.units_12m,
       s.units_3m,
       round(s.units_12m / 52.0, 1) as units_per_week_12m,
       round(s.units_3m / 13.0, 1)  as units_per_week_3m,
       case when s.units_12m > 0
            then round((coalesce(oh.on_hand, 0) + coalesce(oo.on_order, 0))::numeric / (s.units_12m / 52.0), 1)
       end as weeks_of_cover,
       case when s.units_12m > 0 and s.units_3m is not null
            then round((s.units_3m / 13.0 / (s.units_12m / 52.0) - 1) * 100, 1)
       end as momentum_pct
  from types t
  left join sold    s  on s.product_type  = t.product_type
  left join onhand  oh on oh.product_type = t.product_type
  left join onorder oo on oo.product_type = t.product_type;

alter view public.demand_coverage_by_type_v set (security_invoker = true);
grant select on public.demand_coverage_by_type_v to authenticated;

comment on view public.demand_coverage_by_type_v is
  'Per product type: does sales history / inventory / purchase history exist at all, plus weeks of cover and 3m-vs-12m momentum. The cheap "do we have the data to answer this" pre-check. Reads the sales and inventory MATVIEW WRAPPERS (security_invoker = false, tenant filter inside) rather than the matviews themselves -- a matview has no RLS and is not granted to authenticated, so reading one directly from a security_invoker view raises 42501 rather than returning fewer rows. The PO branch reads po_lines/po_headers as the caller on purpose: po_headers RLS is narrower than company, and a definer view would widen it.';
