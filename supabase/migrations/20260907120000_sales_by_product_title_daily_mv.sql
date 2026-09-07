-- Materialize the product-title sales rollup.
--
-- Roadmap's top "Now (stability)" item, but the reason recorded there is no
-- longer the reason. It says a 30-day product rollup measures ~3s. Measured
-- again before building this (2026-09-07, as blake@baseballism.com through
-- the real view with RLS applied), a 30-day rollup is 229ms -- the
-- is_admin_user() SECURITY DEFINER fix that landed the day after that note
-- (20260904220000) took 50x off every policy evaluation underneath it,
-- including the `for all` write policies that are also evaluated on select.
--
-- The cost that survives is on the UNBOUNDED reads, and it is worse than the
-- note claimed:
--
--     select max(day_date) from sales_by_product_title_daily_v   6,890 ms
--     30-day product rollup                                        229 ms
--
-- That max() is not hypothetical. The `Top products by units` saved report
-- runs it as a correlated subquery on EVERY execution, to clamp its window to
-- the last day with data:
--
--     and day_date <= (select least({{date_to}}, max(day_date))
--                        from sales_by_product_title_daily_v)
--
-- With no date filter to push down, Postgres has to build the whole rollup to
-- answer it: 1.16M sales rows joined to products_master, hash-aggregated to
-- 700k groups, spilling 127MB to disk -- for one date. So that tile pays ~7s
-- before it reads a single row it will display, and `Logistics · Top products
-- by units sold` (open-ended upper bound) is on the same footing.
--
-- Materializing turns both into an index read. The rollup is stored once and
-- carries a (company_entity_id, day_date) index, so max(day_date) is an index
-- scan and a windowed read seeks instead of scanning.
--
-- WHY THIS IS EXACT. The matview's select list is character-for-character the
-- view body it replaces, at the same grain, so it is not a pre-aggregation of
-- the view -- it IS the view, stored. The verification block at the bottom
-- proves it row for row (EXCEPT ALL in both directions) rather than asserting
-- it, and separately proves the totals against raw sales_by_day.
--
-- WHY THIS DOES NOT WIDEN RLS. A matview carries no RLS at all, so the tenant
-- filter moves into a definer-owned wrapper (security_invoker = false) that
-- reads it -- the same layering as inventory_on_hand_current_v,
-- sales_velocity_by_sku_location_v and wow_sales_daily_type_v. The filter is
-- `company_entity_id = active_company_id()`, which is character-for-character
-- the SELECT policy on BOTH base tables:
--
--     sales_by_day_active_select      (company_entity_id = active_company_id())
--     products_master_active_select   (company_entity_id = active_company_id())
--
-- so the wrapper shows exactly the rows the invoker view showed, no more. The
-- products_master join is keyed on company_entity_id as well, so a title can
-- never be resolved from another company's catalog. The matview itself is
-- revoked from public/anon/authenticated: nobody can read it around the
-- wrapper, and a security_invoker view over one would RAISE 42501 rather than
-- return fewer rows (the demand_coverage_by_type_v failure, 20260904140000).
--
-- WHAT THIS COSTS. Freshness now depends on a refresh. sales_by_day only
-- changes during a sync, and refresh_sales_by_product_title_mv() runs at the
-- end of scripts/shopify-sync.mjs alongside the other four, so the nightly
-- path adds no staleness at all. The on-demand "sync now" button in
-- Integrations (shopify-sync-run) does not refresh any matview today --
-- velocity, the monthly rollup and the wow rollup are all in the same
-- position -- so it leaves this one a run behind too, until the nightly. A
-- backfill workflow that writes sales_by_day should call the refresh RPC.

-- The initial populate builds 700k groups from 1.16M rows; the verification
-- block below then recomputes the same rollup a second time to compare.
set statement_timeout = '600s';

create materialized view if not exists public.sales_by_product_title_daily_mv as
select
  s.company_entity_id,
  coalesce(pm.product_title, s.product_name)             as product_title,
  case when pm.sku is not null then 'products_master'
       else 'sales_fallback' end                         as title_source,
  coalesce(pm.product_type, s.product_type)              as product_type,
  s.location_tag,
  s.day_date,
  count(distinct s.sku)                                  as variant_skus,
  sum(s.total_quantity_sold)                             as units_sold,
  sum(s.total_orders)                                    as orders,
  sum(s.total_gross_sales)                               as gross_sales,
  sum(s.total_discounts)                                 as discounts,
  sum(s.total_refunds)                                   as refunds,
  sum(s.total_net_sales)                                 as net_sales
from public.sales_by_day s
left join public.products_master pm
  on pm.sku = s.sku
 and pm.company_entity_id = s.company_entity_id
group by 1, 2, 3, 4, 5, 6;

-- NULLS NOT DISTINCT, same reason as wow_sales_daily_type_mv_key: three of the
-- six grain columns are nullable (product_title and product_type both come
-- through coalesce of two nullable columns, location_tag is nullable), and a
-- plain unique index treats every null as distinct from itself -- which both
-- fails to be unique over this grain and disqualifies CONCURRENTLY. The nulls
-- must stay nulls: coalescing them to '' here would invent an "unclassified"
-- product that no caller asked for.
create unique index if not exists sales_by_product_title_daily_mv_key
  on public.sales_by_product_title_daily_mv
     (company_entity_id, product_title, title_source, product_type, location_tag, day_date)
  nulls not distinct;

-- The index the whole exercise is for: every read is company + a date window,
-- and max(day_date) becomes a backwards index scan instead of a 700k-group
-- aggregate.
create index if not exists sales_by_product_title_daily_mv_day_idx
  on public.sales_by_product_title_daily_mv (company_entity_id, day_date);

comment on materialized view public.sales_by_product_title_daily_mv is
  'Stored form of sales_by_product_title_daily_v -- identical select list and grain, not a further aggregation. Exists because the unbounded reads (max(day_date) inside the Top products report, open-ended date_from on the Logistics tile) had to build the entire 700k-group rollup to answer, measured 6,890ms. Refreshed by refresh_sales_by_product_title_mv() at the end of the Shopify sync. READ THROUGH sales_by_product_title_daily_v, NEVER DIRECTLY: this carries no RLS and no grant, so a direct read raises 42501 and a granted one would leak across companies.';


-- The wrapper keeps the view's name, column names and column ORDER, so every
-- existing caller -- six saved reports, four tie-out checks, the report
-- builder's start-here list, Ask SILO's schema catalog -- is untouched.
-- Column order matters beyond tidiness: chat_run_readonly_query returns json
-- specifically to preserve the select list, and every table tile in /v3/
-- renders in that order.
drop view if exists public.sales_by_product_title_daily_v;
create view public.sales_by_product_title_daily_v
  with (security_invoker = false) as
select
  company_entity_id,
  product_title,
  title_source,
  product_type,
  location_tag,
  day_date,
  variant_skus,
  units_sold,
  orders,
  gross_sales,
  discounts,
  refunds,
  net_sales
from public.sales_by_product_title_daily_mv
where company_entity_id = public.active_company_id();

comment on view public.sales_by_product_title_daily_v is
  'Sales rolled up from SKU variants to product title, per location per day. The grain buying decisions are made at, and the one place the sales_by_day -> products_master title join is defined. title_source = ''sales_fallback'' means the SKU had no products_master row and the title came from sales_by_day.product_name (about 1% of rows) -- those are still counted, never dropped. Reads sales_by_product_title_daily_mv, so it is as of the last Shopify sync rather than live; security_invoker = false with an explicit company_entity_id = active_company_id() filter, which is the same predicate the RLS policies on both base tables carry. Note ''x-redo'' (Package Protection) is the Redo checkout line item, not merchandise -- filter it when ranking real products.';

revoke all on public.sales_by_product_title_daily_mv from public, anon, authenticated;

-- anon is revoked EXPLICITLY, not left to RLS. Supabase's default privileges
-- on the public schema grant SELECT to anon on every newly created view, and
-- `create view` re-applies them -- the same mechanism that quietly reopened
-- anon's EXECUTE on chat_run_readonly_query across four drop+creates
-- (20260904330000). Verified this is a tidy-up and not a live leak: anon
-- holds no EXECUTE on active_company_id() (20260713183258), so an anon read
-- of this wrapper already raised 42501 inside the filter rather than
-- returning rows. A clean permission refusal on the view is the better
-- answer, and it stops the guarantee resting on a second object's grants.
-- The four sibling wrappers (wow_sales_daily_type_v, inventory_on_hand_current_v,
-- sales_velocity_by_sku_location_v, sales_monthly_product_type_rollup_v) carry
-- the same inert anon grant and are safe for the same reason; left alone here
-- rather than widening this migration into views it does not own.
revoke all on public.sales_by_product_title_daily_v from anon;
grant select on public.sales_by_product_title_daily_v to authenticated;


create or replace function public.refresh_sales_by_product_title_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '600s'
as $$
begin
  -- Concurrent where possible; the plain refresh is the fallback for the very
  -- first populate, when the matview has never been filled and CONCURRENTLY is
  -- not allowed. Same shape as refresh_wow_sales_daily_mv().
  begin
    refresh materialized view concurrently public.sales_by_product_title_daily_mv;
  exception when others then
    refresh materialized view public.sales_by_product_title_daily_mv;
  end;
end;
$$;

revoke execute on function public.refresh_sales_by_product_title_mv() from public, anon, authenticated;
grant execute on function public.refresh_sales_by_product_title_mv() to service_role;


-- Keep matviews out of Ask SILO's schema index.
--
-- refresh_chat_schema_catalog() picks up relkind 'm' along with tables and
-- views, and its upsert preserves is_hidden/description/reportable -- so
-- claiming the row now, hidden, means the next catalog refresh cannot offer a
-- matview to the model. Offering one is not harmless: the model cannot select
-- it (no grant), so the query raises 42501 and the answer fails outright
-- rather than degrading. No matview is in the catalog today only because it
-- has not been refreshed since the first one was created.
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, is_hidden, reportable)
select c.relname, 'matview', '[]'::jsonb,
       'Materialized view. Not readable directly (no RLS, no grant) -- read its _v wrapper instead.',
       true, false
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'm'
on conflict (relname) do update
  set is_hidden = true,
      reportable = false;


-- Prove the stored rollup equals the view it replaces, before anything reads
-- it. A pre-computed number that is subtly wrong is worse than a slow one: it
-- is wrong quietly, in a headline, forever.
do $chk$
declare
  n_extra_mv   bigint;
  n_extra_live bigint;
  d            record;
begin
  -- 1. Row for row, in both directions, against a fresh recomputation of the
  --    old view body. Catches a wrong grain, a dropped null bucket, a changed
  --    coalesce -- none of which a total would reveal.
  create temp table _live_rollup on commit drop as
  select
    s.company_entity_id,
    coalesce(pm.product_title, s.product_name)             as product_title,
    case when pm.sku is not null then 'products_master'
         else 'sales_fallback' end                         as title_source,
    coalesce(pm.product_type, s.product_type)              as product_type,
    s.location_tag,
    s.day_date,
    count(distinct s.sku)                                  as variant_skus,
    sum(s.total_quantity_sold)                             as units_sold,
    sum(s.total_orders)                                    as orders,
    sum(s.total_gross_sales)                               as gross_sales,
    sum(s.total_discounts)                                 as discounts,
    sum(s.total_refunds)                                   as refunds,
    sum(s.total_net_sales)                                 as net_sales
  from public.sales_by_day s
  left join public.products_master pm
    on pm.sku = s.sku
   and pm.company_entity_id = s.company_entity_id
  group by 1, 2, 3, 4, 5, 6;

  select count(*) into n_extra_mv from (
    select * from public.sales_by_product_title_daily_mv
    except all
    select * from _live_rollup
  ) x;

  select count(*) into n_extra_live from (
    select * from _live_rollup
    except all
    select * from public.sales_by_product_title_daily_mv
  ) x;

  if n_extra_mv <> 0 or n_extra_live <> 0 then
    raise exception 'product-title rollup does not match the live view: % rows only in the matview, % rows only in the live recomputation',
      n_extra_mv, n_extra_live;
  end if;

  -- 2. Totals against RAW sales_by_day. The grouping partitions the table, so
  --    every summed measure must survive it to the cent. variant_skus is a
  --    count(distinct) and does NOT re-sum -- it is covered by check 1 above,
  --    which is row-exact, and is deliberately not asserted here.
  select
    coalesce(sum(b.total_quantity_sold),0) as b_qty,
    coalesce(sum(b.total_orders),0)        as b_ord,
    coalesce(sum(b.total_gross_sales),0)   as b_gross,
    coalesce(sum(b.total_discounts),0)     as b_disc,
    coalesce(sum(b.total_refunds),0)       as b_ref,
    coalesce(sum(b.total_net_sales),0)     as b_net,
    (select coalesce(sum(m.units_sold),0)  from public.sales_by_product_title_daily_mv m) as m_qty,
    (select coalesce(sum(m.orders),0)      from public.sales_by_product_title_daily_mv m) as m_ord,
    (select coalesce(sum(m.gross_sales),0) from public.sales_by_product_title_daily_mv m) as m_gross,
    (select coalesce(sum(m.discounts),0)   from public.sales_by_product_title_daily_mv m) as m_disc,
    (select coalesce(sum(m.refunds),0)     from public.sales_by_product_title_daily_mv m) as m_ref,
    (select coalesce(sum(m.net_sales),0)   from public.sales_by_product_title_daily_mv m) as m_net
  into d
  from public.sales_by_day b;

  if d.b_qty <> d.m_qty
     or d.b_ord <> d.m_ord
     or round(d.b_gross::numeric, 2) <> round(d.m_gross::numeric, 2)
     or round(d.b_disc::numeric, 2)  <> round(d.m_disc::numeric, 2)
     or round(d.b_ref::numeric, 2)   <> round(d.m_ref::numeric, 2)
     or round(d.b_net::numeric, 2)   <> round(d.m_net::numeric, 2) then
    raise exception 'product-title rollup totals differ from sales_by_day: qty %/%, orders %/%, gross %/%, discounts %/%, refunds %/%, net %/%',
      d.b_qty, d.m_qty, d.b_ord, d.m_ord, d.b_gross, d.m_gross,
      d.b_disc, d.m_disc, d.b_ref, d.m_ref, d.b_net, d.m_net;
  end if;

  raise notice 'product-title rollup verified: row-exact against the live view, totals exact against sales_by_day';
end
$chk$;
