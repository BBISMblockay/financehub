-- ─────────────────────────────────────────────────────────────────────────────
-- seo_collection_candidates() inside the browser's statement_timeout.
-- Same signature, columns, semantics and grants as 20260909420000; one CTE
-- is MATERIALIZED (see the comment on it). `create or replace` keeps the
-- grants (authenticated EXECUTE; public/anon revoked).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.seo_collection_candidates(
  p_days integer default 90,
  p_shop_domain text default null
) returns table (
  shop_domain              text,
  storefront_host          text,
  host_kind                text,
  landing_page_path        text,
  collection_handle        text,
  inspect_url              text,
  collection_title         text,
  products_count           integer,
  published_to_online_store boolean,
  in_registry              boolean,
  candidate_status         text,
  sessions                 bigint,
  sessions_that_completed_checkout bigint,
  completed_checkout_rate  numeric,
  page_days_present        integer,
  -- Named for what they ARE: the first and last day this page appeared in the
  -- truncated top-N. NOT a launch date, NOT a retirement date, and NOT the
  -- bounds of the page's traffic.
  page_first_day_in_top_n  date,
  page_last_day_in_top_n   date,
  page_days_truncated      integer,
  source_days_available    integer,
  source_earliest_day      date,
  source_latest_day        date,
  source_days_truncated    integer,
  coverage_note            text
)
language sql
stable
security invoker
set search_path = public
as $$
-- MATERIALIZED, and that word is the fix (measured 2026-09-26 as a signed-in
-- user on Baseballism): the same body run inline takes 100 ms, but as a
-- function with p_days a PARAMETER the planner cannot fold `today - days`
-- into an index condition, scans the 186,802-row table with a FILTER, and a
-- filter evaluates silo_business_today() -- a STABLE function that reads
-- company_settings -- per row, twice: 25.6 s, over the browser role's 8 s
-- statement_timeout. Materialising the one-row window makes it a value the
-- scan joins to, so the function answers like the inline query does. This
-- broke /v2/seo-keywords.html's "Suggest keywords" (which calls it for
-- collection names) and every Ask SILO call of it since 2026-09-09.
with win as materialized (
  select greatest(least(coalesce(p_days, 90), 730), 1) as days,
         public.silo_business_today()                  as today
),
scoped as (
  select lp.*
  from public.shopify_landing_pages_daily lp, win
  where lp.day_date >= win.today - win.days
    and lp.day_date <  win.today
    and (p_shop_domain is null or lp.shop_domain = p_shop_domain)
),
source_cov as (
  select
    company_entity_id,
    shop_domain,
    count(distinct day_date)::int as source_days_available,
    min(day_date)                 as source_earliest_day,
    max(day_date)                 as source_latest_day,
    count(distinct day_date) filter (where is_truncated)::int as source_days_truncated
  from scoped
  group by 1, 2
),
agg as (
  select
    s.company_entity_id,
    s.shop_domain,
    s.landing_page_path,
    substring(s.landing_page_path from '^/collections/([^/?#]+)$') as handle,
    sum(s.sessions)                          as sessions,
    sum(s.sessions_that_completed_checkout)  as completed,
    count(distinct s.day_date)::int          as page_days_present,
    min(s.day_date)                          as page_first_day_in_top_n,
    max(s.day_date)                          as page_last_day_in_top_n,
    count(distinct s.day_date) filter (where s.is_truncated)::int as page_days_truncated
  from scoped s
  where s.landing_page_path ~ '^/collections/[^/?#]+$'
  group by 1,2,3,4
)
select
  a.shop_domain,
  d.host,
  d.kind,
  a.landing_page_path,
  a.handle,
  case when d.host is null then null
       else 'https://' || d.host || a.landing_page_path end,
  c.title,
  c.products_count,
  c.published_to_online_store,
  (c.shopify_collection_id is not null),
  case
    when c.shopify_collection_id is null              then 'not_in_registry'
    when c.published_to_online_store is null          then 'publication_unknown'
    when c.published_to_online_store = false          then 'not_published'
    when coalesce(c.products_count, 0) = 0            then 'empty_collection'
    else 'reviewable'
  end,
  a.sessions,
  a.completed,
  case when a.sessions > 0
       then round((a.completed::numeric / a.sessions::numeric) * 100, 2)
       else null end,
  a.page_days_present,
  a.page_first_day_in_top_n,
  a.page_last_day_in_top_n,
  a.page_days_truncated,
  sc.source_days_available,
  sc.source_earliest_day,
  sc.source_latest_day,
  sc.source_days_truncated,
  format(
    'This page appeared on %s of the %s day(s) of landing-page data this shop has '
    || 'between %s and %s (Pacific, completed days only); %s of those days hit the '
    || 'top-N cap. Days the page is ABSENT are days it did not rank in the top N -- '
    || 'they are NOT days with zero traffic, and NOT gaps in the dataset. '
    || 'page_first_day_in_top_n (%s) IS NOT A LAUNCH DATE and is not when traffic '
    || 'started -- it is only the first day this page ranked high enough to be '
    || 'recorded; the page may have existed and had traffic long before it. Never '
    || 'say "since launch", "in just N days" or "new" from these dates: check '
    || 'sales_by_day or the collection record if a start date actually matters. '
    || 'These are per-page truncated figures: never sum them as store traffic '
    || '(use shopify_sessions_daily).',
    a.page_days_present, sc.source_days_available,
    sc.source_earliest_day, sc.source_latest_day, sc.source_days_truncated,
    a.page_first_day_in_top_n)
from agg a
join source_cov sc
  on  sc.company_entity_id = a.company_entity_id
  and sc.shop_domain       = a.shop_domain
left join lateral (
  select sd.host, sd.kind
  from public.shopify_shop_domains sd
  where sd.company_entity_id = a.company_entity_id
    and sd.shop_domain       = a.shop_domain
  order by case sd.kind when 'primary' then 0 else 1 end, sd.host
  limit 1
) d on true
left join public.shopify_collections c
  on  c.company_entity_id = a.company_entity_id
  and c.shop_domain       = a.shop_domain
  and c.handle            = a.handle
  and c.missing_since is null
order by a.sessions desc
$$;
