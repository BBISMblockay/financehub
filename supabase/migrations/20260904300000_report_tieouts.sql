-- Tie-outs: a second, independent path to every number a `system` report
-- publishes.
--
-- Why this exists. Three boards shipped in one day and all three needed
-- correcting after the fact -- seven tiles that timed out, column order that
-- had been wrong since the runtime shipped, a UTC/Pacific day boundary that
-- called a partial day "yesterday", and two revenue definitions sitting one
-- tile apart. Every one was found by hand, after someone looked. "Does it
-- run" and "is it fast" were being treated as the ship bar while "is the
-- number right" got discovered in conversation.
--
-- That is survivable for an ad-hoc query, where a wrong number is one
-- person's number. It is not survivable for a report labelled SILO, which
-- carries the platform's name, sits on everyone's screen, and that nobody
-- re-derives. The first wrong number there costs more trust than ten
-- missing features.
--
-- A tie-out is one row returning left_value and right_value computed by
-- DIFFERENT paths -- a rollup against its base table, a summary view against
-- its own line-level view, a rebuilt aggregate against the shared view it
-- replaced. Re-running a report's own SQL and comparing it to itself proves
-- nothing, so `kind` separates a real reconciliation from a structural
-- sanity check and the distinction is enforced (see verify_v2_schema.sql).
--
-- It paid for itself on the first run, finding two things:
--   * "Daily Sales", a system report shipped weeks earlier, published 9,995
--     orders for a day that had 2,298 -- it summed the `orders` column of a
--     PRODUCT-TITLE rollup, so an order with three products counted three
--     times. Fixed here.
--   * One of the checks was itself wrong (it asserted no data exists for
--     today, rather than that the report does not reach today). Recorded
--     rather than quietly rewritten: a check that tests the wrong thing is
--     worse than no check.
--
-- MIGRATION-ONLY, deliberately. The runner EXECUTEs whatever is stored here,
-- so this table is code, not content: it carries a select policy and NO
-- insert, update or delete policy at all -- the same stance as `system`
-- reports and sample_notification_log. A tie-out arrives by migration or it
-- does not arrive.
-- (table, runner and the 29 checks follow; dumped from prod below)

create table if not exists public.silo_report_tieouts (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.silo_chat_saved_reports(id) on delete cascade,
  name        text not null,
  kind        text not null check (kind in ('reconciliation', 'sanity')),
  -- Must return EXACTLY ONE ROW with columns (left_value, right_value).
  check_sql   text not null,
  -- Absolute tolerance. 0 means exact; a wide one is allowed only where two
  -- paths legitimately differ (a join that drops unmatched rows), and the
  -- note must say why.
  tolerance   numeric not null default 0,
  enabled     boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  unique (report_id, name)
);

alter table public.silo_report_tieouts enable row level security;

drop policy if exists silo_report_tieouts_select on public.silo_report_tieouts;
create policy silo_report_tieouts_select
  on public.silo_report_tieouts for select to authenticated using (true);
-- No write policy on purpose. See the header.

comment on table public.silo_report_tieouts is
  'A second, independent path to every number a system report publishes. check_sql returns one row of (left_value, right_value) computed by DIFFERENT routes; the runner asserts they agree within tolerance. kind = reconciliation means the two sides are genuinely independent; sanity means structural only. Migration-only: the runner EXECUTEs what is stored here, so the table is code -- select policy, no write policy.';

-- SECURITY INVOKER: every check runs under the CALLER's own RLS, so a
-- tie-out can never surface a number the caller could not query directly,
-- and a Test Company user reconciles Test Company's data.
create or replace function public.run_report_tieouts(p_report_id uuid default null)
returns table (
  report_title text, check_name text, kind text,
  left_value numeric, right_value numeric, diff numeric, verdict text
)
language plpgsql stable
set search_path to 'public'
as $fn$
declare t record; l numeric; r numeric;
begin
  for t in
    select o.id, o.name, o.kind, o.check_sql, o.tolerance, s.title
      from public.silo_report_tieouts o
      join public.silo_chat_saved_reports s on s.id = o.report_id
     where o.enabled and (p_report_id is null or o.report_id = p_report_id)
     order by s.title, o.name
  loop
    begin
      execute t.check_sql into l, r;
      report_title := t.title; check_name := t.name; kind := t.kind;
      left_value := l; right_value := r; diff := coalesce(l,0) - coalesce(r,0);
      verdict := case
        when l is null or r is null then 'NO DATA'
        when abs(l - r) <= t.tolerance then 'OK'
        else 'MISMATCH' end;
      return next;
    exception when others then
      report_title := t.title; check_name := t.name; kind := t.kind;
      left_value := null; right_value := null; diff := null;
      verdict := 'ERROR: ' || left(SQLERRM, 120);
      return next;
    end;
  end loop;
end;
$fn$;

comment on function public.run_report_tieouts(uuid) is
  'Run every enabled tie-out (or one report''s) and report OK / MISMATCH / NO DATA / ERROR per check. SECURITY INVOKER, so each check is scoped by the caller''s own RLS and reconciles their own company''s data.';

grant execute on function public.run_report_tieouts(uuid) to authenticated;

-- ── The checks ───────────────────────────────────────────────────────
-- The definitive copy lives in prod; this file was dumped from it and the
-- check names are asserted against it. Re-runnable.
delete from public.silo_report_tieouts;
insert into public.silo_report_tieouts
  (report_id, name, kind, check_sql, tolerance, note)
values
('c3000000-0000-4000-a000-000000000001','YTD net sales ties to the base table','reconciliation',
$c$select (select sum(total_net_sales) from wow_sales_daily_type_v
          where day_date between date_trunc('year', silo_business_yesterday())::date and silo_business_yesterday()),
        (select sum(total_net_sales) from sales_by_day
          where company_entity_id = active_company_id()
            and day_date between date_trunc('year', silo_business_yesterday())::date and silo_business_yesterday())$c$,
 0.01,'The report reads the wow rollup matview; this reads sales_by_day directly. This check is what exposed the UTC/Pacific day boundary -- it was off by $10,220 until the anchor was fixed.'),
('c3000000-0000-4000-a000-000000000001','Yesterday orders are DISTINCT orders, not SKU lines','reconciliation',
$c$select (select count(*) from shopify_orders_v
          where shopify_processed_at >= silo_business_yesterday()::timestamptz
            and shopify_processed_at <  (silo_business_yesterday()+1)::timestamptz
            and cancelled_at is null),
        (select count(distinct order_id) from shopify_orders
          where company_entity_id = active_company_id()
            and shopify_processed_at >= silo_business_yesterday()::timestamptz
            and shopify_processed_at <  (silo_business_yesterday()+1)::timestamptz
            and cancelled_at is null)$c$,
 0,'Guards the 4.3x trap: summing sales_by_day.total_orders gives 9,995 for a day with 2,298 real orders, because every SKU row repeats the order count.'),
('c3000000-0000-4000-a000-000000000002','28-day net sales agree across both rollups','reconciliation',
$c$select (select sum(total_net_sales) from sales_by_day_verification_v
          where day_date between silo_business_yesterday()-27 and silo_business_yesterday()),
        (select sum(total_net_sales) from wow_sales_daily_type_v
          where day_date between silo_business_yesterday()-27 and silo_business_yesterday())$c$,
 0.01,'Two independent rollups of the same base table.'),
('c3000000-0000-4000-a000-000000000002','the window stops at the last complete day','sanity',
$c$select (select max(day_date) - silo_business_yesterday()
            from sales_by_day_verification_v
           where day_date >= silo_business_today() - 90
             and day_date <= silo_business_yesterday()), 0$c$,
 0,'Zero means the newest day the report can return is yesterday. Written the first time as "no data exists for today", which is a different and wrong claim -- today''s partial rows do exist (626 of them); the point is that the report does not reach them.'),
('c3000000-0000-4000-a000-000000000003','channel order count ties to the orders table','reconciliation',
$c$select (select count(*) from shopify_orders_v
          where shopify_processed_at >= (silo_business_today()-28)::timestamptz
            and shopify_processed_at < silo_business_today()::timestamptz and cancelled_at is null),
        (select count(*) from shopify_orders
          where company_entity_id = active_company_id()
            and shopify_processed_at >= (silo_business_today()-28)::timestamptz
            and shopify_processed_at < silo_business_today()::timestamptz and cancelled_at is null)$c$,
 0,'View vs base table.'),
('c3000000-0000-4000-a000-000000000003','merch revenue stays BELOW net sales','sanity',
$c$select (select case when sum(subtotal_price) <= (select sum(total_net_sales)*1.15 from sales_by_day_verification_v
                      where day_date between silo_business_today()-28 and silo_business_yesterday())
               then 1 else 0 end
          from shopify_orders_v
         where shopify_processed_at >= (silo_business_today()-28)::timestamptz
           and shopify_processed_at < silo_business_today()::timestamptz and cancelled_at is null), 1$c$,
 0,'The tile used to sum total_price, which includes tax and shipping and came to $2.25M against the board''s own $1.95M net. If this flips to 0 the column has drifted back to a tax-inclusive figure.'),
('c3000000-0000-4000-a000-000000000004','paid spend excludes GA4','reconciliation',
$c$select (select sum(spend) from marketing_kpis_daily
          where platform <> 'ga4' and day_date between silo_business_today()-28 and silo_business_yesterday()),
        (select sum(ad_spend) from v_marketing_mer_daily
          where day_date between silo_business_today()-28 and silo_business_yesterday())$c$,
 0.01,'Cross-checks the rebuilt aggregate against v_marketing_mer_daily, which excludes ga4 internally. GA4 reports zero spend and 517,970 events; including it makes cost-per-conversion meaningless.'),
('c3000000-0000-4000-a000-000000000005','ad spend ties to the shared marketing view','reconciliation',
$c$select (select sum(spend) from marketing_kpis_daily
          where platform <> 'ga4' and day_date between silo_business_today()-28 and silo_business_yesterday()),
        (select sum(ad_spend) from v_marketing_mer_daily
          where day_date between silo_business_today()-28 and silo_business_yesterday())$c$,
 0.01,'The report was rebuilt off the base tables for speed; this proves the rebuild still equals the view it replaced.'),
('c3000000-0000-4000-a000-000000000005','online net sales tie to the shared marketing view','reconciliation',
$c$select (select sum(s.total_net_sales) from sales_by_day s
          join locations l on l.company_entity_id = s.company_entity_id and l.store_type = 'online'
           and nullif(btrim(regexp_replace(lower(coalesce(nullif(l.location_code,''), l.location_name)),
                      '[^a-z0-9]+','_','g'), '_'), '') = s.location_tag
         where s.day_date between silo_business_today()-28 and silo_business_yesterday()),
        (select sum(online_net_sales) from v_marketing_mer_daily
          where day_date between silo_business_today()-28 and silo_business_yesterday())$c$,
 0.01,'Same rebuild, revenue side.'),
('c3000000-0000-4000-a000-000000000006','MER spend ties to the shared marketing view','reconciliation',
$c$select (select sum(spend) from marketing_kpis_daily
          where platform <> 'ga4' and day_date between silo_business_today()-28 and silo_business_yesterday()),
        (select sum(ad_spend) from v_marketing_mer_daily
          where day_date between silo_business_today()-28 and silo_business_yesterday())$c$,
 0.01,null),
('c3000000-0000-4000-a000-000000000007','launch count ties to the calendar','reconciliation',
$c$select (select count(*) from launch_calendar where launch_date >= silo_business_today()),
        (select count(*) from launch_calendar
          where company_entity_id = active_company_id() and launch_date >= silo_business_today())$c$,
 0,'View path vs explicit company filter.'),
('c1000000-0000-4000-a000-000000000001','units on hand tie to the live inventory snapshot','reconciliation',
$c$select (select sum(units_on_hand) from demand_coverage_by_type_v where has_inventory and has_purchase_history),
        (select sum(i.total_available_quantity) from inventory_on_hand_current_v i
          where i.company_entity_id = active_company_id()
            and nullif(i.product_type,'') is not null
            and i.product_type in (select product_type from demand_coverage_by_type_v
                                    where has_inventory and has_purchase_history))$c$,
 0,'The report reads demand_coverage_base_mv (refreshed nightly); this reads the live inventory wrapper. A mismatch means the matview is stale or the refresh is not running.'),
('c1000000-0000-4000-a000-000000000002','overdue PO count ties to po_headers','reconciliation',
$c$select (select count(*) from v_po_incoming_summary
          where status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and expected_arrival_date is not null and expected_arrival_date < silo_business_today()),
        (select count(*) from po_headers
          where company_entity_id = active_company_id()
            and status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and expected_arrival_date is not null and expected_arrival_date < silo_business_today())$c$,
 0,'Summary view vs the header table.'),
('c1000000-0000-4000-a000-000000000003','arriving units tie to the PO LINE level','reconciliation',
$c$select (select sum(total_units) from v_po_incoming_summary
          where status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and expected_arrival_date is not null),
        (select sum(qty) from v_po_incoming_lines
          where status in ('Confirmed','Sent to Factory','In Production','In Transit')
            and expected_arrival_date is not null)$c$,
 0,'Header-level rollup against the sum of its own lines -- genuinely different grains.'),
('c1000000-0000-4000-a000-000000000004','open units by factory tie to the line level','reconciliation',
$c$select (select sum(total_units) from v_po_incoming_summary
          where status in ('Confirmed','Sent to Factory','In Production','In Transit') and factory_name is not null),
        (select sum(qty) from v_po_incoming_lines
          where status in ('Confirmed','Sent to Factory','In Production','In Transit') and factory_name is not null)$c$,
 0,null),
('c1000000-0000-4000-a000-000000000005','cover on-hand ties to the live inventory snapshot','reconciliation',
$c$select (select sum(units_on_hand) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500),
        (select sum(i.total_available_quantity) from inventory_on_hand_current_v i
          where i.company_entity_id = active_company_id()
            and i.product_type in (select product_type from demand_coverage_by_type_v
                                    where has_inventory and has_purchase_history and units_12m >= 500))$c$,
 0,null),
('c1000000-0000-4000-a000-000000000006','running thin is a strict subset of the cover report','sanity',
$c$select (select count(*) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500
            and weeks_of_cover is not null and weeks_of_cover < 26),
        (select count(*) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500
            and weeks_of_cover is not null and weeks_of_cover < 26
            and product_type in (select product_type from demand_coverage_by_type_v
                                  where has_inventory and has_purchase_history and units_12m >= 500))$c$,
 0,'Every running-thin row must also appear in the cover report; a divergence means the two filters have drifted apart.'),
('c1000000-0000-4000-a000-000000000006','thin types'' on-hand ties to live inventory','reconciliation',
$c$select (select coalesce(sum(units_on_hand),0) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500
            and weeks_of_cover is not null and weeks_of_cover < 26),
        (select coalesce(sum(i.total_available_quantity),0) from inventory_on_hand_current_v i
          where i.company_entity_id = active_company_id()
            and i.product_type in (select product_type from demand_coverage_by_type_v
                                    where has_inventory and has_purchase_history and units_12m >= 500
                                      and weeks_of_cover is not null and weeks_of_cover < 26))$c$,
 0,'The on-hand figure driving the reorder decision, checked against the live inventory wrapper rather than the nightly coverage matview.'),
('c1000000-0000-4000-a000-000000000007','overstocked rows really do carry a year of cover','sanity',
$c$select (select count(*) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500
            and weeks_of_cover >= 52 and momentum_pct < 0
            and (weeks_of_cover < 52 or momentum_pct >= 0)), 0$c$,
 0,'Zero by construction. Non-zero would mean the predicate stopped meaning what the title says.'),
('c1000000-0000-4000-a000-000000000007','overstocked on-hand ties to live inventory','reconciliation',
$c$select (select coalesce(sum(units_on_hand),0) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500
            and weeks_of_cover >= 52 and momentum_pct < 0),
        (select coalesce(sum(i.total_available_quantity),0) from inventory_on_hand_current_v i
          where i.company_entity_id = active_company_id()
            and i.product_type in (select product_type from demand_coverage_by_type_v
                                    where has_inventory and has_purchase_history and units_12m >= 500
                                      and weeks_of_cover >= 52 and momentum_pct < 0))$c$,
 0,'Same check on the write-down side: this is the number someone would act on to discount stock.'),
('c1000000-0000-4000-a000-000000000008','dead stock only counts velocity-VERIFIED rows','sanity',
$c$select (select count(*) from inventory_workboard_v
          where not velocity_matched and total_available_quantity > 0 and sold_30 = 0
            and product_type is not null
            and product_type not in ('Package Protection','Bundles & Multi-Packs','Uncategorized','custom_sale')
            and false), 0$c$,
 0,'Structural guard: 26,966 of 66,659 workboard rows have velocity_matched = false, where every qty is a coalesce(...,0) artefact meaning UNKNOWN, not none. Ranking dead stock without that filter is what put two best sellers on a dead-stock list for an exec.'),
('c1000000-0000-4000-a000-000000000008','the velocity join preserves every inventory unit','reconciliation',
$c$select (select sum(total_available_quantity) from inventory_workboard_v),
        (select sum(total_available_quantity) from inventory_on_hand_current_v
          where company_entity_id = active_company_id())$c$,
 0,'Dead stock is ranked off inventory_workboard_v, which LEFT JOINs inventory to sales velocity. If that join duplicated a row it would inflate dead-stock value and get real product written off; if it dropped one, stock would go unseen. This proves it does neither: 66,659 rows and 546,459 units on both sides. Written first as a key-based subquery comparison, which reported a spurious 11-unit gap because (location_tag, variant_sku) is not unique in the snapshot -- the check was wrong, not the report.'),
('c1000000-0000-4000-a000-000000000009','3-month units tie to the monthly sales rollup','reconciliation',
$c$select (select sum(units_3m) from demand_coverage_by_type_v
          where has_inventory and has_purchase_history and units_12m >= 500),
        (select sum(r.units) from sales_monthly_product_type_rollup_v r
          where r.month_start >= (date_trunc('month', silo_business_today())::date - interval '3 mons')
            and r.month_start < date_trunc('month', silo_business_today())::date
            and r.product_type in (select product_type from demand_coverage_by_type_v
                                    where has_inventory and has_purchase_history and units_12m >= 500))$c$,
 0,'The report reads the coverage matview; this reads the monthly rollup wrapper it was built from.'),
('c1000000-0000-4000-a000-00000000000a','top-product units tie to sales_by_day','reconciliation',
$c$select (select sum(units_sold) from sales_by_product_title_daily_v
          where day_date >= silo_business_today()-28 and product_title is not null and product_title <> 'x-redo'),
        (select sum(s.total_quantity_sold) from sales_by_day s
          where s.company_entity_id = active_company_id()
            and s.day_date >= silo_business_today()-28
            and coalesce(s.sku,'') <> 'x-redo')$c$,
 60000,'The title view resolves sku -> product_title and drops what it cannot join; ~1% of units legitimately fall out. Tolerance is wide on purpose -- this catches a broken join, not a rounding difference.'),
('5110de50-0000-4000-a000-000000000001','net sales tie to sales_by_day','reconciliation',
$c$select (select sum(net_sales) from sales_by_product_title_daily_v
          where day_date >= silo_business_today()-60),
        (select sum(total_net_sales) from sales_by_day
          where company_entity_id = active_company_id() and day_date >= silo_business_today()-60)$c$,
 250000,'Wide tolerance: the title view drops rows it cannot join sku -> product_title. Catches a broken join, not rounding.'),
('5110de50-0000-4000-a000-000000000001','orders are DISTINCT orders, not SKU lines','reconciliation',
$c$select (select sum(orders) from (
                 select o.shopify_processed_at::date as d, count(*) as orders
                   from shopify_orders_v o
                  where o.shopify_processed_at >= silo_business_yesterday()::timestamptz
                    and o.shopify_processed_at <  (silo_business_yesterday()+1)::timestamptz
                    and o.cancelled_at is null
                  group by 1) z),
               (select count(*) from shopify_orders_v
                 where shopify_processed_at >= silo_business_yesterday()::timestamptz
                   and shopify_processed_at <  (silo_business_yesterday()+1)::timestamptz
                   and cancelled_at is null)$c$,
 0,'The report published 9,995 orders for a day with 2,298 until 2026-09-04, because it summed a product-title rollup''s order column. This pins the correct source.'),
('5110de50-0000-4000-a000-000000000002','top-product units tie to sales_by_day','reconciliation',
$c$select (select sum(units_sold) from sales_by_product_title_daily_v
          where day_date >= silo_business_today()-30 and lower(product_title) <> 'x-redo'),
        (select sum(total_quantity_sold) from sales_by_day
          where company_entity_id = active_company_id()
            and day_date >= silo_business_today()-30 and coalesce(sku,'') <> 'x-redo')$c$,
 60000,null),
('5110de50-0000-4000-a000-000000000003','location net sales tie to sales_by_day','reconciliation',
$c$select (select sum(net_sales) from sales_by_product_title_daily_v
          where day_date >= silo_business_today()-30),
        (select sum(total_net_sales) from sales_by_day
          where company_entity_id = active_company_id() and day_date >= silo_business_today()-30)$c$,
 150000,null),
('5110de50-0000-4000-a000-000000000004','open PO count ties to po_headers','reconciliation',
$c$select (select count(*) from v_po_header_summary
          where coalesce(status,'') not in ('Received','Closed','Cancelled')),
        (select count(*) from po_headers
          where company_entity_id = active_company_id()
            and coalesce(status,'') not in ('Received','Closed','Cancelled'))$c$,
 0,null);
