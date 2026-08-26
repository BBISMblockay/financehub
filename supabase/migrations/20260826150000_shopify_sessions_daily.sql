-- Shopify storefront funnel and customer mix, pulled from ShopifyQL.
--
-- Why this exists: the Week over Week report needs sessions -> added to cart
-- -> reached checkout -> completed checkout, and a trustworthy
-- returning-customer rate. Neither was available:
--
--   * The funnel was assumed to need GA4 event-level data. It does not --
--     Shopify tracks its own storefront funnel and exposes it through
--     ShopifyQL's `sessions` dataset. The report currently tells the reader
--     to go and fetch those three numbers from GA4 by hand.
--   * The returning-customer rate was being reconstructed from
--     shopify_orders ("did this customer order before?"). That table is a
--     patchwork of partial backfills -- August, September and October 2025
--     and January and March 2026 are missing entirely -- so customers whose
--     earlier orders fall in a hole are counted as new. The rate it produced
--     (33.9%) is understated by an unknown amount. Shopify computes this
--     itself and is the better source.
--
-- Volume is trivial. ShopifyQL aggregates server-side and TIMESERIES day
-- returns ONE ROW PER DAY per shop -- roughly 365 rows per shop per year,
-- about 3,300 a year across nine shops. For scale, sales_by_day is 1.1M
-- rows and inventory_on_hand is 3.5M.
--
-- COMPONENTS ARE STORED, RATIOS ARE NOT. Shopify will hand back a
-- conversion_rate and a returning_customer_rate directly, but storing a
-- ratio means anyone rolling a week up from days averages it and gets a
-- number that is not the rate. The counts are stored and every ratio is
-- derived as sum(numerator)/sum(denominator) at the grain being reported,
-- the same discipline as marketing_campaign_summary_v and
-- top_sellers_type_variance.
--
-- Sessions are online-store only by nature -- POS has no sessions -- which
-- matches the Week over Week report's online scope without extra filtering.

create table if not exists public.shopify_sessions_daily (
  id                                 uuid primary key default gen_random_uuid(),
  company_entity_id                  uuid not null,
  shop_domain                        text not null,
  day_date                           date not null,
  sessions                           bigint,
  sessions_with_cart_additions       bigint,
  sessions_that_reached_checkout     bigint,
  sessions_that_completed_checkout   bigint,
  source                             text not null default 'shopifyql',
  sync_batch_id                      text,
  synced_at                          timestamptz not null default now(),
  unique (company_entity_id, shop_domain, day_date)
);

create index if not exists shopify_sessions_daily_co_day_idx
  on public.shopify_sessions_daily (company_entity_id, day_date desc);

create table if not exists public.shopify_customer_metrics_daily (
  id                   uuid primary key default gen_random_uuid(),
  company_entity_id    uuid not null,
  shop_domain          text not null,
  day_date             date not null,
  customers            bigint,
  new_customers        bigint,
  returning_customers  bigint,
  source               text not null default 'shopifyql',
  sync_batch_id        text,
  synced_at            timestamptz not null default now(),
  unique (company_entity_id, shop_domain, day_date)
);

create index if not exists shopify_customer_metrics_daily_co_day_idx
  on public.shopify_customer_metrics_daily (company_entity_id, day_date desc);

alter table public.shopify_sessions_daily         enable row level security;
alter table public.shopify_customer_metrics_daily enable row level security;

-- Read for the company; writes are service-role only (the nightly sync),
-- same as sales_by_day and inventory_on_hand.
drop policy if exists shopify_sessions_daily_active_select on public.shopify_sessions_daily;
create policy shopify_sessions_daily_active_select
  on public.shopify_sessions_daily for select
  using (company_entity_id = active_company_id());

drop policy if exists shopify_customer_metrics_daily_active_select on public.shopify_customer_metrics_daily;
create policy shopify_customer_metrics_daily_active_select
  on public.shopify_customer_metrics_daily for select
  using (company_entity_id = active_company_id());

-- Ratios derived here, never stored. Roll a week up by summing the counts
-- and dividing once.
create or replace view public.shopify_funnel_daily_v as
select
  s.company_entity_id,
  s.day_date,
  sum(s.sessions)                          as sessions,
  sum(s.sessions_with_cart_additions)      as added_to_cart,
  sum(s.sessions_that_reached_checkout)    as reached_checkout,
  sum(s.sessions_that_completed_checkout)  as completed_checkout,
  round(sum(s.sessions_with_cart_additions)::numeric
        / nullif(sum(s.sessions), 0), 6)   as cart_rate,
  round(sum(s.sessions_that_reached_checkout)::numeric
        / nullif(sum(s.sessions), 0), 6)   as checkout_rate,
  round(sum(s.sessions_that_completed_checkout)::numeric
        / nullif(sum(s.sessions), 0), 6)   as conversion_rate,
  sum(c.customers)                         as customers,
  sum(c.new_customers)                     as new_customers,
  sum(c.returning_customers)               as returning_customers,
  round(sum(c.returning_customers)::numeric
        / nullif(sum(c.customers), 0), 6)  as returning_customer_rate
from public.shopify_sessions_daily s
left join public.shopify_customer_metrics_daily c
  on c.company_entity_id = s.company_entity_id
 and c.shop_domain = s.shop_domain
 and c.day_date = s.day_date
group by s.company_entity_id, s.day_date;

alter view public.shopify_funnel_daily_v set (security_invoker = true);

comment on view public.shopify_funnel_daily_v is
  'Storefront funnel by day from Shopify: sessions, added to cart, reached checkout, completed checkout, plus customer mix. Every rate is derived from summed counts rather than stored, so rolling a week up sums the components and divides once instead of averaging daily percentages. Sessions are online-store only -- POS has no sessions.';

comment on table public.shopify_sessions_daily is
  'One row per shop per day from ShopifyQL''s sessions dataset. Counts only; rates are derived in shopify_funnel_daily_v. This is what the Week over Week conversion funnel reads -- it does NOT need GA4 event data, which was an earlier wrong assumption.';

comment on table public.shopify_customer_metrics_daily is
  'One row per shop per day from ShopifyQL''s sales dataset: customers, new and returning. Replaces reconstructing the returning-customer rate from shopify_orders, which is a patchwork of partial backfills (Aug-Oct 2025 and Jan/Mar 2026 missing) and therefore undercounts returning customers.';

-- New job type for the nightly runner.
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array[
    'test_connection'::text, 'history_import'::text, 'incremental_sales'::text,
    'inventory_snapshot'::text, 'catalog_sync'::text, 'payouts_sync'::text,
    'draft_orders_sync'::text, 'google_ads_kpis'::text, 'meta_ads_kpis'::text,
    'tiktok_ads_kpis'::text, 'ga4_kpis'::text, 'orders_backfill'::text,
    'sessions_sync'::text
  ]));
