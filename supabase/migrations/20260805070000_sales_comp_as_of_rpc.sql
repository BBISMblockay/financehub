-- ============================================================
-- 20260805070000_sales_comp_as_of_rpc.sql
--
-- Sales Performance Overview's "Comps as of" was locked to whatever the
-- nightly refresh_sales_verification_store_comp_summary() job last wrote --
-- a single snapshot row per store, overwritten every night, with no history
-- to pick a past date from. This adds a live, parameterized equivalent:
-- same Day/MTD/YTD-vs-prior-year math (mirrored exactly from that refresh
-- function -- same prior-year alignment via literal `interval '1 year'`,
-- same sales_by_day_verification_v source so the shopify_api-over-
-- better_reports dedup stays consistent), computed on demand for whatever
-- date the caller picks.
--
-- Deliberately NOT security definer: sales_by_day already has proper RLS
-- (`company_entity_id = active_company_id()`), so a plain function
-- querying it inherits that automatically. The explicit
-- `company_entity_id = active_company_id()` filter below is for query
-- performance/index use, not because RLS needs the help.
-- ============================================================

create or replace function public.sales_comp_as_of(p_as_of_date date)
returns table (
  location_tag text,
  as_of_date date,
  py_as_of_date date,
  cur_day_qty numeric, cur_day_net numeric, cur_day_total numeric, cur_day_discounts numeric,
  py_day_qty numeric, py_day_net numeric, py_day_total numeric, py_day_discounts numeric,
  cur_mtd_qty numeric, cur_mtd_net numeric, cur_mtd_total numeric, cur_mtd_discounts numeric,
  py_mtd_qty numeric, py_mtd_net numeric, py_mtd_total numeric, py_mtd_discounts numeric,
  cur_ytd_qty numeric, cur_ytd_net numeric, cur_ytd_total numeric, cur_ytd_discounts numeric,
  py_ytd_qty numeric, py_ytd_net numeric, py_ytd_total numeric, py_ytd_discounts numeric,
  day_total_var_pct numeric, mtd_total_var_pct numeric, ytd_total_var_pct numeric,
  day_net_var_pct numeric, mtd_net_var_pct numeric, ytd_net_var_pct numeric,
  day_qty_var_pct numeric, mtd_qty_var_pct numeric, ytd_qty_var_pct numeric,
  day_discounts_var_pct numeric, mtd_discounts_var_pct numeric, ytd_discounts_var_pct numeric,
  refreshed_at timestamptz
)
language sql
stable
set search_path to 'public'
as $function$
  with p as (
    select
      p_as_of_date as as_of_date,
      (p_as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', p_as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (p_as_of_date - interval '1 year'))::int,
        extract(month from p_as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', p_as_of_date)::date as cur_ytd_start,
      make_date(extract(year from (p_as_of_date - interval '1 year'))::int, 1, 1)::date as py_ytd_start
  ),
  base as (
    select
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      coalesce(s.total_discounts, 0)::numeric as discounts
    from public.sales_by_day_verification_v s
    where s.company_entity_id = active_company_id()
      and s.day_date <= (select as_of_date from p)
  ),
  locs as (
    select distinct location_tag from base
  ),
  day_cur as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date = p.as_of_date group by location_tag
  ),
  day_py as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date = p.py_as_of_date group by location_tag
  ),
  mtd_cur as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.cur_mtd_start and p.as_of_date group by location_tag
  ),
  mtd_py as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.py_mtd_start and p.py_as_of_date group by location_tag
  ),
  ytd_cur as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.cur_ytd_start and p.as_of_date group by location_tag
  ),
  ytd_py as (
    select location_tag, sum(qty) q, sum(net_sales) n, sum(total_sales) t, sum(discounts) d
    from base, p where day_date between p.py_ytd_start and p.py_as_of_date group by location_tag
  )
  select
    l.location_tag,
    p.as_of_date, p.py_as_of_date,
    coalesce(dc.q,0), coalesce(dc.n,0), coalesce(dc.t,0), coalesce(dc.d,0),
    coalesce(dp.q,0), coalesce(dp.n,0), coalesce(dp.t,0), coalesce(dp.d,0),
    coalesce(mc.q,0), coalesce(mc.n,0), coalesce(mc.t,0), coalesce(mc.d,0),
    coalesce(mp.q,0), coalesce(mp.n,0), coalesce(mp.t,0), coalesce(mp.d,0),
    coalesce(yc.q,0), coalesce(yc.n,0), coalesce(yc.t,0), coalesce(yc.d,0),
    coalesce(yp.q,0), coalesce(yp.n,0), coalesce(yp.t,0), coalesce(yp.d,0),
    case when coalesce(dp.t,0)=0 then null else (coalesce(dc.t,0)-coalesce(dp.t,0))/nullif(dp.t,0) end,
    case when coalesce(mp.t,0)=0 then null else (coalesce(mc.t,0)-coalesce(mp.t,0))/nullif(mp.t,0) end,
    case when coalesce(yp.t,0)=0 then null else (coalesce(yc.t,0)-coalesce(yp.t,0))/nullif(yp.t,0) end,
    case when coalesce(dp.n,0)=0 then null else (coalesce(dc.n,0)-coalesce(dp.n,0))/nullif(dp.n,0) end,
    case when coalesce(mp.n,0)=0 then null else (coalesce(mc.n,0)-coalesce(mp.n,0))/nullif(mp.n,0) end,
    case when coalesce(yp.n,0)=0 then null else (coalesce(yc.n,0)-coalesce(yp.n,0))/nullif(yp.n,0) end,
    case when coalesce(dp.q,0)=0 then null else (coalesce(dc.q,0)-coalesce(dp.q,0))/nullif(dp.q,0) end,
    case when coalesce(mp.q,0)=0 then null else (coalesce(mc.q,0)-coalesce(mp.q,0))/nullif(mp.q,0) end,
    case when coalesce(yp.q,0)=0 then null else (coalesce(yc.q,0)-coalesce(yp.q,0))/nullif(yp.q,0) end,
    case when coalesce(dp.d,0)=0 then null else (coalesce(dc.d,0)-coalesce(dp.d,0))/nullif(dp.d,0) end,
    case when coalesce(mp.d,0)=0 then null else (coalesce(mc.d,0)-coalesce(mp.d,0))/nullif(mp.d,0) end,
    case when coalesce(yp.d,0)=0 then null else (coalesce(yc.d,0)-coalesce(yp.d,0))/nullif(yp.d,0) end,
    now()
  from locs l
  cross join p
  left join day_cur dc on dc.location_tag = l.location_tag
  left join day_py dp on dp.location_tag = l.location_tag
  left join mtd_cur mc on mc.location_tag = l.location_tag
  left join mtd_py mp on mp.location_tag = l.location_tag
  left join ytd_cur yc on yc.location_tag = l.location_tag
  left join ytd_py yp on yp.location_tag = l.location_tag
  order by l.location_tag;
$function$;

grant execute on function public.sales_comp_as_of(date) to authenticated;
