-- Sales by discount code, per day, from ShopifyQL.
--
-- Replaces the manual "Sales by Affiliate Code" table: Baseballism's
-- affiliate codes ARE Shopify discount codes (team50, BBISMFAM20,
-- baseballogist, preston30...), and ShopifyQL exposes GROUP BY discount_code
-- directly. This never needed typing in.
--
-- Orders with no code come back under an empty discount_code. That row is
-- kept, not dropped, because it is the denominator for "what share of sales
-- ran through a code" -- discarding it would make every percentage a share of
-- coded sales only, which reads far higher than reality. It is stored under
-- the explicit sentinel '(no code)' with is_no_code set, rather than as an
-- empty string nobody would notice.
create table if not exists public.shopify_discount_codes_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  shop_domain text not null,
  day_date date not null,
  discount_code text not null,
  is_no_code boolean not null default false,
  gross_sales numeric,
  orders bigint,
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  unique (company_entity_id, shop_domain, day_date, discount_code)
);

create index if not exists shopify_discount_codes_daily_day_idx
  on public.shopify_discount_codes_daily (company_entity_id, day_date desc);

alter table public.shopify_discount_codes_daily enable row level security;

drop policy if exists shopify_discount_codes_daily_select on public.shopify_discount_codes_daily;
create policy shopify_discount_codes_daily_select on public.shopify_discount_codes_daily
  for select using (company_entity_id = public.active_company_id());

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array[
    'test_connection','history_import','incremental_sales','inventory_snapshot',
    'catalog_sync','payouts_sync','draft_orders_sync','google_ads_kpis',
    'meta_ads_kpis','tiktok_ads_kpis','ga4_kpis','orders_backfill',
    'sessions_sync','landing_pages_sync','discount_codes_sync'
  ]));

-- Top codes for the WoW report's Affiliate section. Percentages are of ALL
-- gross sales, coded and uncoded, so the share is honest.
create or replace function public.wow_discount_codes(p_report_date date, p_limit int default 20)
returns jsonb language sql stable as $$
with w as (
  select p_report_date as e, p_report_date - 6 as s,
         p_report_date - 7 as pe, p_report_date - 13 as ps
),
agg as (
  select d.discount_code as code, bool_or(d.is_no_code) as no_code,
         coalesce(sum(d.gross_sales) filter (where d.day_date between (select s from w) and (select e from w)),0) as sales,
         coalesce(sum(d.orders)      filter (where d.day_date between (select s from w) and (select e from w)),0) as orders,
         coalesce(sum(d.gross_sales) filter (where d.day_date between (select ps from w) and (select pe from w)),0) as prev_sales
  from public.shopify_discount_codes_daily d cross join w
  where d.company_entity_id = public.active_company_id()
    and d.day_date between (select ps from w) and (select e from w)
  group by 1
),
tot as (select coalesce(sum(sales),0) all_sales from agg)
select jsonb_build_object(
  'report_date', p_report_date,
  'total_sales', (select round(all_sales::numeric,0) from tot),
  'coded_sales', (select round(coalesce(sum(sales),0)::numeric,0) from agg where not no_code),
  'days_covered', (select count(distinct d.day_date) from public.shopify_discount_codes_daily d cross join w
                   where d.company_entity_id = public.active_company_id()
                     and d.day_date between (select s from w) and (select e from w)),
  'codes', (select coalesce(jsonb_agg(x order by sv desc),'[]'::jsonb) from (
      select jsonb_build_object(
               'code', a.code, 'sales', round(a.sales::numeric,0), 'orders', a.orders,
               'aov', case when a.orders > 0 then round((a.sales/a.orders)::numeric,2) end,
               'pct_of_total', case when (select all_sales from tot) > 0
                    then round(100.0 * a.sales / (select all_sales from tot), 1) end,
               'prev_sales', round(a.prev_sales::numeric,0),
               'sales_wow', case when a.prev_sales > 0
                    then round(100.0 * (a.sales - a.prev_sales) / a.prev_sales, 1) end
             ) x, a.sales sv
      from agg a where not a.no_code and a.sales > 0
      order by a.sales desc limit greatest(coalesce(p_limit, 20), 1)) c)
);
$$;

grant execute on function public.wow_discount_codes(date, int) to authenticated;
