-- Week over Week at YTD: stop reading half a million rows per request.
--
-- Narrowing the sbd CTEs (20260901130000) cut the per-call cost roughly in
-- half and was still not enough, because the page does not make ONE call. It
-- fires seven RPCs in parallel, and the Postgres log for a single YTD page
-- load shows seven cancellations inside forty seconds -- three of them within
-- 21 milliseconds of each other. Measured serially and warm, wow_report was
-- 5.0s against an 8s statement_timeout; measured the way the page actually
-- loads, seven concurrent readers of the same 2.1GB table contend for CPU and
-- buffers and all of them inflate past the ceiling together.
--
-- No amount of column-list tuning fixes that. The work itself has to shrink.
--
-- sales_by_day is one row per SKU per location per day -- 1,139,541 rows. Every
-- figure in the report except Top Products is consumed at a much coarser
-- grain, and the cardinality collapse is dramatic:
--
--     base rows                                  1,139,541
--     distinct (company, location, day, type)      136,994     8.3x
--     distinct (company, location, day)             12,315      92x
--
-- So this rolls up ONCE, nightly, to (company, location, day, product_type) --
-- the coarsest grain that still serves the report's totals AND its category
-- split -- and the two heavy functions read that instead. A YTD window goes
-- from ~460,000 rows to a few thousand.
--
-- Top Products is deliberately NOT served from here. It needs product_name,
-- and that grain only collapses 1.6x (692,951 rows) -- not worth a second
-- matview -- but it only ever reads the CURRENT window [s,e], never the prior
-- or last-year ones, so it stays on the base table over a much smaller range.
--
-- WHY A ROLLUP IS EXACT HERE. Every measure carried is a SUM, and summing a
-- partition of a set then summing the partial sums is the same number. Nothing
-- averaged, no distinct counts, no percentiles -- those would NOT survive
-- pre-aggregation and none are taken from this. The migration verifies it
-- rather than asserting it: it compares base against rollup and raises if any
-- measure differs by a cent.
--
-- location_tag is stored ALREADY NORMALISED (lower(btrim(...))), which is what
-- the report has always filtered on. That keeps the defensive normalisation --
-- a sync delivering 'Online' still lands in the same bucket -- while making
-- the column directly indexable, which the expression never was.

create materialized view if not exists public.wow_sales_daily_type_mv as
select
  s.company_entity_id,
  lower(btrim(s.location_tag))          as location_tag,
  s.day_date,
  s.product_type,
  sum(s.total_sales)                    as total_sales,
  sum(s.total_net_sales)                as total_net_sales,
  sum(s.total_refunds)                  as total_refunds,
  sum(s.total_gross_sales)              as total_gross_sales,
  sum(s.total_quantity_sold)            as total_quantity_sold
from public.sales_by_day s
group by 1, 2, 3, 4;

-- NULLS NOT DISTINCT: product_type is nullable, and a plain unique index would
-- treat every null-type day as distinct from itself and refuse to support a
-- CONCURRENT refresh. The rollup must keep nulls as nulls -- the report's
-- category split filters `product_type is not null`, and coalescing to '' here
-- would silently invent an "unclassified" category.
create unique index if not exists wow_sales_daily_type_mv_key
  on public.wow_sales_daily_type_mv (company_entity_id, location_tag, day_date, product_type)
  nulls not distinct;

create index if not exists wow_sales_daily_type_mv_scan_idx
  on public.wow_sales_daily_type_mv (company_entity_id, location_tag, day_date);

-- Same layering as inventory_on_hand_current_v / sales_velocity_by_sku_location_v,
-- and for the same reason: a matview carries no RLS and `authenticated` holds
-- no grant on one, so the tenant filter has to live in a definer-owned view
-- (security_invoker = false) that reads it. Pointing a caller at the matview
-- directly would both fail at runtime and, if it were granted, leak across
-- companies. The filter below is character-for-character the SELECT policy on
-- sales_by_day, so the view shows exactly the rows the base table would.
drop view if exists public.wow_sales_daily_type_v;
create view public.wow_sales_daily_type_v
  with (security_invoker = false) as
select company_entity_id, location_tag, day_date, product_type,
       total_sales, total_net_sales, total_refunds, total_gross_sales,
       total_quantity_sold
from public.wow_sales_daily_type_mv
where company_entity_id = public.active_company_id();

revoke all on public.wow_sales_daily_type_mv from public, anon, authenticated;
grant select on public.wow_sales_daily_type_v to authenticated;

comment on materialized view public.wow_sales_daily_type_mv is
  'Week over Week sales rollup: sales_by_day summed to (company, normalised location, day, product_type) -- 137k rows against 1.14M. Exists because the report fires seven RPCs in parallel and a YTD window over the base table blew the 8s statement_timeout on all of them at once. Every measure is a SUM, so re-summing these partials is exact. Refreshed by refresh_wow_sales_daily_mv() at the end of the Shopify sync. Read through wow_sales_daily_type_v, never directly -- the matview has no RLS.';


create or replace function public.refresh_wow_sales_daily_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
begin
  -- Concurrent where possible; the plain refresh is the fallback for the very
  -- first populate, when the matview has never been filled and CONCURRENTLY
  -- is not allowed. Same shape as refresh_sales_velocity_mv().
  begin
    refresh materialized view concurrently public.wow_sales_daily_type_mv;
  exception when others then
    refresh materialized view public.wow_sales_daily_type_mv;
  end;
end;
$$;

revoke execute on function public.refresh_wow_sales_daily_mv() from public, anon, authenticated;
grant execute on function public.refresh_wow_sales_daily_mv() to service_role;


-- Point the two heavy functions at the rollup.
--
-- Rewrites the DEPLOYED definitions again rather than retyping them, for the
-- same reason as 20260901120000: several migrations have edited these in place
-- and the repo text is not what runs. Each replacement is asserted to match
-- exactly once, so a body that has drifted raises instead of being guessed at.
do $mig$
declare
  def    text;
  newdef text;
  n      int;
begin
  ---------------------------------------------------------------- kpi_compare
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
   where nsp.nspname = 'public' and p.proname = 'wow_kpi_compare'
     and pg_get_function_identity_arguments(p.oid) like '%p_grain%';
  if not found then
    raise exception 'wow rollup: wow_kpi_compare(date, text) not found';
  end if;

  if position('wow_sales_daily_type_v' in def) > 0 then
    raise notice 'wow rollup: wow_kpi_compare already on the rollup -- skipping';
  else
    n := (select count(*) from regexp_matches(def, 'from public\.sales_by_day s cross join w', 'g'));
    if n <> 1 then
      raise exception 'wow rollup: wow_kpi_compare has % base-table reads, expected 1', n;
    end if;
    newdef := replace(def,
      'select s.day_date, s.total_sales, s.total_net_sales from public.sales_by_day s cross join w'
      || E'\n  where s.day_date between w.lys and w.e'
      || E'\n    and lower(btrim(s.location_tag)) = ''online''',
      'select d.day_date, d.total_sales, d.total_net_sales from public.wow_sales_daily_type_v d cross join w'
      || E'\n  where d.day_date between w.lys and w.e'
      || E'\n    and d.location_tag = ''online''');
    if newdef = def then
      raise exception 'wow rollup: wow_kpi_compare sbd CTE did not match -- refusing to guess';
    end if;
    execute newdef;
    raise notice 'wow rollup: wow_kpi_compare now reads wow_sales_daily_type_v';
  end if;

  ---------------------------------------------------------------- wow_report
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
   where nsp.nspname = 'public' and p.proname = 'wow_report'
     and pg_get_function_identity_arguments(p.oid) like '%p_grain%';
  if not found then
    raise exception 'wow rollup: wow_report(date, text) not found';
  end if;

  if position('wow_sales_daily_type_v' in def) > 0 then
    raise notice 'wow rollup: wow_report already on the rollup -- skipping';
  else
    -- sbd feeds totals + the category split, which the rollup serves exactly.
    -- sbd_prod is added alongside it for Top Products, which needs
    -- product_name and therefore stays on the base table -- but only across
    -- [s, e], never the prior or last-year window.
    newdef := replace(def,
      'select s.day_date, s.product_type, s.product_name, s.total_sales, s.total_net_sales,'
      || ' s.total_refunds, s.total_gross_sales, s.total_quantity_sold from public.sales_by_day s cross join w'
      || E'\n  where s.day_date between w.ps and w.e'
      || E'\n    and lower(btrim(s.location_tag)) = ''online''',
      'select d.day_date, d.product_type, d.total_sales, d.total_net_sales,'
      || ' d.total_refunds, d.total_gross_sales from public.wow_sales_daily_type_v d cross join w'
      || E'\n  where d.day_date between w.ps and w.e'
      || E'\n    and d.location_tag = ''online'''
      || E'\n),\nsbd_prod as (\n'
      || '  select s.product_name, s.product_type, s.day_date, s.total_quantity_sold, s.total_net_sales'
      || E'\n  from public.sales_by_day s cross join w'
      || E'\n  where s.day_date between w.s and w.e'
      || E'\n    and lower(btrim(s.location_tag)) = ''online''');
    if newdef = def then
      raise exception 'wow rollup: wow_report sbd CTE did not match -- refusing to guess';
    end if;

    n := (select count(*) from regexp_matches(newdef, 'from sbd s cross join w', 'g'));
    if n <> 1 then
      raise exception 'wow rollup: wow_report has % aliased sbd reads (top products), expected 1', n;
    end if;
    newdef := replace(newdef, 'from sbd s cross join w', 'from sbd_prod s cross join w');

    execute newdef;
    raise notice 'wow rollup: wow_report now reads wow_sales_daily_type_v (+ sbd_prod for top products)';
  end if;
end
$mig$;


-- Prove the rollup equals the base table before anything depends on it.
-- A pre-aggregate that is subtly wrong is far worse than a slow query: it is
-- wrong quietly, in a headline number, forever.
do $chk$
declare
  d record;
begin
  select
    coalesce(sum(b.total_sales),0)       as b_sales,
    coalesce(sum(b.total_net_sales),0)   as b_net,
    coalesce(sum(b.total_refunds),0)     as b_ref,
    coalesce(sum(b.total_gross_sales),0) as b_gross,
    coalesce(sum(b.total_quantity_sold),0) as b_qty,
    (select coalesce(sum(m.total_sales),0)         from public.wow_sales_daily_type_mv m) as m_sales,
    (select coalesce(sum(m.total_net_sales),0)     from public.wow_sales_daily_type_mv m) as m_net,
    (select coalesce(sum(m.total_refunds),0)       from public.wow_sales_daily_type_mv m) as m_ref,
    (select coalesce(sum(m.total_gross_sales),0)   from public.wow_sales_daily_type_mv m) as m_gross,
    (select coalesce(sum(m.total_quantity_sold),0) from public.wow_sales_daily_type_mv m) as m_qty
  into d
  from public.sales_by_day b;

  if round(d.b_sales::numeric,2) <> round(d.m_sales::numeric,2)
     or round(d.b_net::numeric,2)   <> round(d.m_net::numeric,2)
     or round(d.b_ref::numeric,2)   <> round(d.m_ref::numeric,2)
     or round(d.b_gross::numeric,2) <> round(d.m_gross::numeric,2)
     or d.b_qty <> d.m_qty then
    raise exception 'wow rollup does not match sales_by_day: sales %/%, net %/%, refunds %/%, gross %/%, qty %/%',
      d.b_sales, d.m_sales, d.b_net, d.m_net, d.b_ref, d.m_ref, d.b_gross, d.m_gross, d.b_qty, d.m_qty;
  end if;

  raise notice 'wow rollup verified against sales_by_day: every measure matches';
end
$chk$;
