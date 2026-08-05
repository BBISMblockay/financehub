-- ============================================================
-- 20260805080000_sales_comp_as_of_perf_fix.sql
--
-- sales_comp_as_of() was timing out in production (6.3s / 1.29M buffer
-- hits measured via EXPLAIN ANALYZE for a single date). Two compounding
-- causes:
--
-- 1. The `base` CTE was referenced by six separate downstream CTEs
--    (day_cur/day_py/mtd_cur/mtd_py/ytd_cur/ytd_py), and a plain (non-
--    materialized) CTE gets inlined and re-evaluated per reference in
--    modern Postgres -- so the expensive shopify_api-over-better_reports
--    anti-join in sales_by_day_verification_v ran six times, not once.
-- 2. `base` had no lower date bound (removed in the prior migration to
--    keep a since-defunct pop-up location, bld_houston, showing as a
--    zero row for historical dates) -- so each of those six scans covered
--    the entire multi-million-row sales history, not just the window
--    the comparison actually needs.
--
-- Fix: materialize `base` (computed once) and bound it to as_of_date -
-- ~2 years (covers day/mtd/ytd for the current year and the full prior
-- year needed for YTD comps, with a buffer), then collapse the six
-- GROUP BY passes into one using FILTER. Trade-off: a location with zero
-- activity in that ~2 year window (i.e. genuinely defunct, like
-- bld_houston, whose last sale was mid-2024) won't appear for a custom
-- date picked from before that window -- an acceptable cost for turning
-- a 6+ second query into a sub-second one.
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
      make_date(extract(year from (p_as_of_date - interval '1 year'))::int, 1, 1)::date as py_ytd_start,
      (p_as_of_date - interval '2 years' - interval '15 days')::date as scan_floor
  ),
  base as materialized (
    select
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      coalesce(s.total_discounts, 0)::numeric as discounts
    from public.sales_by_day_verification_v s, p
    where s.company_entity_id = active_company_id()
      and s.day_date between p.scan_floor and p.as_of_date
  ),
  agg as (
    select
      b.location_tag,
      sum(b.qty)        filter (where b.day_date = p.as_of_date)                              as day_cur_q,
      sum(b.net_sales)  filter (where b.day_date = p.as_of_date)                              as day_cur_n,
      sum(b.total_sales) filter (where b.day_date = p.as_of_date)                             as day_cur_t,
      sum(b.discounts)  filter (where b.day_date = p.as_of_date)                              as day_cur_d,
      sum(b.qty)        filter (where b.day_date = p.py_as_of_date)                           as day_py_q,
      sum(b.net_sales)  filter (where b.day_date = p.py_as_of_date)                           as day_py_n,
      sum(b.total_sales) filter (where b.day_date = p.py_as_of_date)                          as day_py_t,
      sum(b.discounts)  filter (where b.day_date = p.py_as_of_date)                           as day_py_d,
      sum(b.qty)        filter (where b.day_date between p.cur_mtd_start and p.as_of_date)    as mtd_cur_q,
      sum(b.net_sales)  filter (where b.day_date between p.cur_mtd_start and p.as_of_date)    as mtd_cur_n,
      sum(b.total_sales) filter (where b.day_date between p.cur_mtd_start and p.as_of_date)   as mtd_cur_t,
      sum(b.discounts)  filter (where b.day_date between p.cur_mtd_start and p.as_of_date)    as mtd_cur_d,
      sum(b.qty)        filter (where b.day_date between p.py_mtd_start and p.py_as_of_date)  as mtd_py_q,
      sum(b.net_sales)  filter (where b.day_date between p.py_mtd_start and p.py_as_of_date)  as mtd_py_n,
      sum(b.total_sales) filter (where b.day_date between p.py_mtd_start and p.py_as_of_date) as mtd_py_t,
      sum(b.discounts)  filter (where b.day_date between p.py_mtd_start and p.py_as_of_date)  as mtd_py_d,
      sum(b.qty)        filter (where b.day_date between p.cur_ytd_start and p.as_of_date)    as ytd_cur_q,
      sum(b.net_sales)  filter (where b.day_date between p.cur_ytd_start and p.as_of_date)    as ytd_cur_n,
      sum(b.total_sales) filter (where b.day_date between p.cur_ytd_start and p.as_of_date)   as ytd_cur_t,
      sum(b.discounts)  filter (where b.day_date between p.cur_ytd_start and p.as_of_date)    as ytd_cur_d,
      sum(b.qty)        filter (where b.day_date between p.py_ytd_start and p.py_as_of_date)  as ytd_py_q,
      sum(b.net_sales)  filter (where b.day_date between p.py_ytd_start and p.py_as_of_date)  as ytd_py_n,
      sum(b.total_sales) filter (where b.day_date between p.py_ytd_start and p.py_as_of_date) as ytd_py_t,
      sum(b.discounts)  filter (where b.day_date between p.py_ytd_start and p.py_as_of_date)  as ytd_py_d
    from base b, p
    group by b.location_tag
  )
  select
    a.location_tag,
    p.as_of_date, p.py_as_of_date,
    coalesce(a.day_cur_q,0), coalesce(a.day_cur_n,0), coalesce(a.day_cur_t,0), coalesce(a.day_cur_d,0),
    coalesce(a.day_py_q,0),  coalesce(a.day_py_n,0),  coalesce(a.day_py_t,0),  coalesce(a.day_py_d,0),
    coalesce(a.mtd_cur_q,0), coalesce(a.mtd_cur_n,0), coalesce(a.mtd_cur_t,0), coalesce(a.mtd_cur_d,0),
    coalesce(a.mtd_py_q,0),  coalesce(a.mtd_py_n,0),  coalesce(a.mtd_py_t,0),  coalesce(a.mtd_py_d,0),
    coalesce(a.ytd_cur_q,0), coalesce(a.ytd_cur_n,0), coalesce(a.ytd_cur_t,0), coalesce(a.ytd_cur_d,0),
    coalesce(a.ytd_py_q,0),  coalesce(a.ytd_py_n,0),  coalesce(a.ytd_py_t,0),  coalesce(a.ytd_py_d,0),
    case when coalesce(a.day_py_t,0)=0 then null else (coalesce(a.day_cur_t,0)-a.day_py_t)/nullif(a.day_py_t,0) end,
    case when coalesce(a.mtd_py_t,0)=0 then null else (coalesce(a.mtd_cur_t,0)-a.mtd_py_t)/nullif(a.mtd_py_t,0) end,
    case when coalesce(a.ytd_py_t,0)=0 then null else (coalesce(a.ytd_cur_t,0)-a.ytd_py_t)/nullif(a.ytd_py_t,0) end,
    case when coalesce(a.day_py_n,0)=0 then null else (coalesce(a.day_cur_n,0)-a.day_py_n)/nullif(a.day_py_n,0) end,
    case when coalesce(a.mtd_py_n,0)=0 then null else (coalesce(a.mtd_cur_n,0)-a.mtd_py_n)/nullif(a.mtd_py_n,0) end,
    case when coalesce(a.ytd_py_n,0)=0 then null else (coalesce(a.ytd_cur_n,0)-a.ytd_py_n)/nullif(a.ytd_py_n,0) end,
    case when coalesce(a.day_py_q,0)=0 then null else (coalesce(a.day_cur_q,0)-a.day_py_q)/nullif(a.day_py_q,0) end,
    case when coalesce(a.mtd_py_q,0)=0 then null else (coalesce(a.mtd_cur_q,0)-a.mtd_py_q)/nullif(a.mtd_py_q,0) end,
    case when coalesce(a.ytd_py_q,0)=0 then null else (coalesce(a.ytd_cur_q,0)-a.ytd_py_q)/nullif(a.ytd_py_q,0) end,
    case when coalesce(a.day_py_d,0)=0 then null else (coalesce(a.day_cur_d,0)-a.day_py_d)/nullif(a.day_py_d,0) end,
    case when coalesce(a.mtd_py_d,0)=0 then null else (coalesce(a.mtd_cur_d,0)-a.mtd_py_d)/nullif(a.mtd_py_d,0) end,
    case when coalesce(a.ytd_py_d,0)=0 then null else (coalesce(a.ytd_cur_d,0)-a.ytd_py_d)/nullif(a.ytd_py_d,0) end,
    now()
  from agg a
  cross join p
  order by a.location_tag;
$function$;
