-- Business-timezone sweep, part 4 of 5: reporting surfaces that anchored on a
-- Pacific day -- the store comp summary's "last completed day" and the Org
-- Calendar's live-session slots. Needs silo_company_timezone() from
-- 20260924130000; see that file's header.

-- ── 1. Org Calendar: live-session slots on the company's clock ─────────────
-- Rewritten from the LIVE definition rather than retyped: calendar_events_v
-- has ten branches and only the live-session one names a timezone, and the
-- repo's 20260810120000 text is not the definition production runs. Replacing
-- the literal in pg_get_viewdef() keeps every other branch exactly as deployed,
-- and is a no-op on a re-run (the literal is gone).
do $$
declare
  v_def text := pg_get_viewdef('public.calendar_events_v'::regclass, true);
  v_new text;
begin
  v_new := replace(v_def, '''America/Los_Angeles''::text', 'public.silo_company_timezone(ls.company_entity_id)');
  if v_new <> v_def then
    execute 'create or replace view public.calendar_events_v with (security_invoker = true) as ' || v_new;
  end if;
end $$;

-- ── 2. Store comp summary: each company's own completed day ───────────────

create or replace function public.refresh_sales_verification_store_comp_summary()
returns void
language plpgsql
set statement_timeout to '120s'
as $function$
begin
  truncate table public.sales_verification_store_comp_summary;

  insert into public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    cur_day_total,
    cur_day_discounts,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    py_day_total,
    py_day_discounts,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    cur_mtd_total,
    cur_mtd_discounts,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    py_mtd_total,
    py_mtd_discounts,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    cur_ytd_total,
    cur_ytd_discounts,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    py_ytd_total,
    py_ytd_discounts,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    day_total_var,
    day_total_var_pct,
    mtd_total_var,
    mtd_total_var_pct,
    ytd_total_var,
    ytd_total_var_pct,
    day_discounts_var,
    day_discounts_var_pct,
    mtd_discounts_var,
    mtd_discounts_var_pct,
    ytd_discounts_var,
    ytd_discounts_var_pct,
    refreshed_at
  )
  -- Each company's own "today", computed ONCE per company (a handful of rows,
  -- MATERIALIZED so the lookup is not repeated per joined row).
  with company_today as materialized (
    select e.id as company_entity_id,
           (now() at time zone public.silo_company_timezone(e.id))::date as today
    from public.entities e
    where e.entity_type = 'company'
  ),
  -- Collapsed to one row per company-day BEFORE the join. Joining the raw view
  -- to company_today directly lets the planner drive an index scan per company
  -- (a parameterised nested loop), which measured 20.0s on production on
  -- 2026-09-24 against 4.8s for the old Pacific-literal scan -- inside a
  -- function with a 120s budget that also rebuilds the whole summary. This
  -- shape keeps the one sequential scan: measured 4.7s on the same data.
  company_days as (
    select v.company_entity_id, v.day_date
    from public.sales_by_day_verification_v v
    where v.company_entity_id is not null
    group by v.company_entity_id, v.day_date
  ),
  max_day as (
    select
      d.company_entity_id,
      max(d.day_date)::date as as_of_date
    from company_days d
    join company_today t on t.company_entity_id = d.company_entity_id
    -- Only days that have fully ended in the COMPANY'S business timezone can
    -- anchor the comps -- the in-progress day is partial by definition and
    -- would skew Day, MTD and YTD against full PY days.
    where d.day_date < t.today
    group by d.company_entity_id
  ),
  periods as (
    select
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date as py_as_of_date,
      date_trunc('month', as_of_date)::date as cur_mtd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        extract(month from as_of_date)::int,
        1
      )::date as py_mtd_start,
      date_trunc('year', as_of_date)::date as cur_ytd_start,
      make_date(
        extract(year from (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date as py_ytd_start
    from max_day
  ),
  base as (
    select
      s.company_entity_id,
      s.location_tag,
      s.day_date::date as day_date,
      coalesce(s.total_quantity_sold, 0)::numeric as qty,
      coalesce(s.total_net_sales, 0)::numeric as net_sales,
      coalesce(s.total_refunds, 0)::numeric as refunds,
      coalesce(s.total_sales, 0)::numeric as total_sales,
      coalesce(s.total_discounts, 0)::numeric as discounts,
      case
        when coalesce(trim(s.sku), '') = '' then 1
        else 0
      end as blank_sku_row,
      case
        when lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          or lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        then 1
        else 0
      end as refund_discrepancy_row
    from public.sales_by_day_verification_v s
    where s.company_entity_id is not null
  ),
  location_dates as (
    select
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) as min_day_date,
      max(b.day_date) as max_day_date,
      count(*) as row_count,
      sum(b.blank_sku_row) as blank_sku_rows,
      sum(b.refund_discrepancy_row) as refund_discrepancy_rows
    from base b
    group by b.company_entity_id, b.location_tag
  ),
  day_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_day_qty,
      sum(b.net_sales) as cur_day_net,
      sum(b.refunds) as cur_day_refunds,
      sum(b.total_sales) as cur_day_total,
      sum(b.discounts) as cur_day_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  day_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_day_qty,
      sum(b.net_sales) as py_day_net,
      sum(b.refunds) as py_day_refunds,
      sum(b.total_sales) as py_day_total,
      sum(b.discounts) as py_day_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date = p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_mtd_qty,
      sum(b.net_sales) as cur_mtd_net,
      sum(b.refunds) as cur_mtd_refunds,
      sum(b.total_sales) as cur_mtd_total,
      sum(b.discounts) as cur_mtd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_mtd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  mtd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_mtd_qty,
      sum(b.net_sales) as py_mtd_net,
      sum(b.refunds) as py_mtd_refunds,
      sum(b.total_sales) as py_mtd_total,
      sum(b.discounts) as py_mtd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_mtd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_cur as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as cur_ytd_qty,
      sum(b.net_sales) as cur_ytd_net,
      sum(b.refunds) as cur_ytd_refunds,
      sum(b.total_sales) as cur_ytd_total,
      sum(b.discounts) as cur_ytd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.cur_ytd_start and p.as_of_date
    group by b.company_entity_id, b.location_tag
  ),
  ytd_py as (
    select
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) as py_ytd_qty,
      sum(b.net_sales) as py_ytd_net,
      sum(b.refunds) as py_ytd_refunds,
      sum(b.total_sales) as py_ytd_total,
      sum(b.discounts) as py_ytd_discounts
    from base b
    join periods p
      on p.company_entity_id = b.company_entity_id
    where b.day_date between p.py_ytd_start and p.py_as_of_date
    group by b.company_entity_id, b.location_tag
  )
  select
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dc.cur_day_total, 0),
    coalesce(dc.cur_day_discounts, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),
    coalesce(dp.py_day_total, 0),
    coalesce(dp.py_day_discounts, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mc.cur_mtd_total, 0),
    coalesce(mc.cur_mtd_discounts, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),
    coalesce(mp.py_mtd_total, 0),
    coalesce(mp.py_mtd_discounts, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yc.cur_ytd_total, 0),
    coalesce(yc.cur_ytd_discounts, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),
    coalesce(yp.py_ytd_total, 0),
    coalesce(yp.py_ytd_discounts, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    case
      when coalesce(dp.py_day_net, 0) = 0 then null
      else (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    end,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    case
      when coalesce(mp.py_mtd_net, 0) = 0 then null
      else (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    end,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    case
      when coalesce(yp.py_ytd_net, 0) = 0 then null
      else (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    end,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    case
      when coalesce(dp.py_day_qty, 0) = 0 then null
      else (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    end,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    case
      when coalesce(mp.py_mtd_qty, 0) = 0 then null
      else (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    end,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    case
      when coalesce(yp.py_ytd_qty, 0) = 0 then null
      else (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    end,

    coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0),
    case
      when coalesce(dp.py_day_total, 0) = 0 then null
      else (coalesce(dc.cur_day_total, 0) - coalesce(dp.py_day_total, 0)) / nullif(dp.py_day_total, 0)
    end,

    coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0),
    case
      when coalesce(mp.py_mtd_total, 0) = 0 then null
      else (coalesce(mc.cur_mtd_total, 0) - coalesce(mp.py_mtd_total, 0)) / nullif(mp.py_mtd_total, 0)
    end,

    coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0),
    case
      when coalesce(yp.py_ytd_total, 0) = 0 then null
      else (coalesce(yc.cur_ytd_total, 0) - coalesce(yp.py_ytd_total, 0)) / nullif(yp.py_ytd_total, 0)
    end,

    coalesce(dc.cur_day_discounts, 0) - coalesce(dp.py_day_discounts, 0),
    case
      when coalesce(dp.py_day_discounts, 0) = 0 then null
      else (coalesce(dc.cur_day_discounts, 0) - coalesce(dp.py_day_discounts, 0)) / nullif(dp.py_day_discounts, 0)
    end,

    coalesce(mc.cur_mtd_discounts, 0) - coalesce(mp.py_mtd_discounts, 0),
    case
      when coalesce(mp.py_mtd_discounts, 0) = 0 then null
      else (coalesce(mc.cur_mtd_discounts, 0) - coalesce(mp.py_mtd_discounts, 0)) / nullif(mp.py_mtd_discounts, 0)
    end,

    coalesce(yc.cur_ytd_discounts, 0) - coalesce(yp.py_ytd_discounts, 0),
    case
      when coalesce(yp.py_ytd_discounts, 0) = 0 then null
      else (coalesce(yc.cur_ytd_discounts, 0) - coalesce(yp.py_ytd_discounts, 0)) / nullif(yp.py_ytd_discounts, 0)
    end,

    now()
  from location_dates ld
  join periods p
    on p.company_entity_id = ld.company_entity_id
  left join day_cur dc
    on ld.company_entity_id = dc.company_entity_id
   and ld.location_tag = dc.location_tag
  left join day_py dp
    on ld.company_entity_id = dp.company_entity_id
   and ld.location_tag = dp.location_tag
  left join mtd_cur mc
    on ld.company_entity_id = mc.company_entity_id
   and ld.location_tag = mc.location_tag
  left join mtd_py mp
    on ld.company_entity_id = mp.company_entity_id
   and ld.location_tag = mp.location_tag
  left join ytd_cur yc
    on ld.company_entity_id = yc.company_entity_id
   and ld.location_tag = yc.location_tag
  left join ytd_py yp
    on ld.company_entity_id = yp.company_entity_id
   and ld.location_tag = yp.location_tag
  order by ld.company_entity_id, ld.location_tag;
end;
$function$;
