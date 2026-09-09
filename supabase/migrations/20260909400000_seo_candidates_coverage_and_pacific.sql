-- Forward-corrective for 20260909380000, already applied.
--
-- THREE CORRECTIONS, all found in review.
--
-- 1. COVERAGE WAS PER-PAGE AND READ AS PER-DATASET. The old function counted
--    only the days a PARTICULAR PAGE appeared in the top-N, then reported that
--    as days_with_data with an earliest/latest range. Measured on live data:
--    /collections/prime-collection came back as "28 days, 2026-06-22 to
--    2026-07-19", which reads as "SILO only holds five weeks of data" -- when
--    SILO actually searched 90 truncated days and that page merely surfaced on
--    28 of them. A recommendation carrying that sentence misstates its own
--    evidence base, which is the precise failure this whole project exists to
--    stop. Page presence and dataset coverage are now separate, and named so
--    they cannot be confused: page_days_present vs source_days_available.
--
--    The distinction is load-bearing: a page present on 28 of 90 days is a
--    page that FELL OUT of the top N on the other 62 -- which is a finding
--    about that page, not a gap in the data.
--
-- 2. IT USED current_date, WHICH IS UTC. CLAUDE.md is explicit: anything a
--    person reads as a day uses silo_business_today(). From 17:00 Pacific
--    onward current_date is already tomorrow, so "the last 90 days" silently
--    shifted by one for the last seven hours of every working day. Latent
--    rather than visible -- the two agreed on the day this was written -- which
--    is exactly how it would have survived review a second time. The window is
--    now the last N COMPLETED Pacific days: >= today-N and < today.
--
-- 3. AN UNPUBLISHED OR UNREGISTERED COLLECTION IS NOT A COPY JOB. The old
--    function returned published_to_online_store and in_registry and left the
--    reader to notice. A page whose handle no longer matches any live
--    collection is a redirect/investigation finding, and rewriting its meta
--    description is work aimed at a page that may not exist. candidate_status
--    now states the verdict rather than leaving it to be inferred.
--
-- Return type changes, so this is DROP + CREATE rather than CREATE OR REPLACE.
-- That resets privileges -- and Supabase's default privileges on the public
-- schema re-grant EXECUTE to anon on any newly created function, the same hole
-- 20260904330000 and 20260909360000 each had to close. The revokes below are
-- re-applied for that reason and are not redundant.

drop function if exists public.seo_collection_candidates(integer, text);

create function public.seo_collection_candidates(
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
  -- The verdict, so it is not inferred: only 'reviewable' is a copy job.
  candidate_status         text,
  sessions                 bigint,
  sessions_that_completed_checkout bigint,
  completed_checkout_rate  numeric,
  -- How many days THIS PAGE appeared in the truncated top-N.
  page_days_present        integer,
  page_first_day           date,
  page_last_day            date,
  page_days_truncated      integer,
  -- How many days the DATASET covers for this shop in the same window. This
  -- is the denominator; page_days_present is the numerator.
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
with win as (
  -- Pacific, and COMPLETED days only. silo_business_today() is today in
  -- Pacific; the upper bound is exclusive so a partial day never enters a
  -- window someone reads as "the last 90 days".
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
-- Dataset coverage per shop: every day the SHOP has any landing-page row in
-- the window, whether or not a given page appears on it.
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
    min(s.day_date)                          as page_first_day,
    max(s.day_date)                          as page_last_day,
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
    -- A path with no live collection behind it: the handle was renamed or the
    -- collection was deleted. That is a redirect question, not a copy job.
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
  a.page_first_day,
  a.page_last_day,
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
    || 'These are per-page truncated figures: never sum them as store traffic '
    || '(use shopify_sessions_daily).',
    a.page_days_present, sc.source_days_available,
    sc.source_earliest_day, sc.source_latest_day, sc.source_days_truncated)
from agg a
join source_cov sc
  on  sc.company_entity_id = a.company_entity_id
  and sc.shop_domain       = a.shop_domain
-- SAME SHOP, not merely same company. See 20260909380000 for why: two primary
-- hosts under one company means a path from store A paired with store B's
-- domain fetches successfully and reports on the wrong store.
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

comment on function public.seo_collection_candidates(integer, text) is
  'Collection landing pages with measured traffic over the last p_days '
  'COMPLETED Pacific days (silo_business_today(), never current_date), each '
  'with an inspect_url built from the SAME SHOP''s verified storefront host. '
  'SECURITY INVOKER. Collection ROOTS only. Read page_days_present against '
  'source_days_available: the first is how many days this PAGE surfaced in the '
  'truncated top-N, the second is how many days of data the SHOP has -- a page '
  'absent on some days fell out of the top N, which is a fact about the page, '
  'not a gap in the data. candidate_status is the verdict: only "reviewable" '
  'is a copy job; not_in_registry / not_published / empty_collection / '
  'publication_unknown are investigation or redirect findings.';

revoke all on function public.seo_collection_candidates(integer, text) from public, anon;
grant execute on function public.seo_collection_candidates(integer, text) to authenticated;

update public.silo_chat_schema_catalog
set description =
  'FUNCTION, call as: select * from seo_collection_candidates(90). The intended '
  'starting point for on-page SEO work on COLLECTION pages. Window is the last '
  'p_days COMPLETED PACIFIC days. Each row carries inspect_url, already built '
  'from the SAME shop''s verified storefront host -- pass it straight to '
  'inspect_storefront_page; never assemble a URL yourself and never pair a path '
  'from one shop with another shop''s domain. READ candidate_status FIRST: only '
  '"reviewable" should receive rewritten copy. "not_in_registry" means the '
  'handle no longer matches a live collection (a redirect question), '
  '"not_published" means the page is not on the online store, "empty_collection" '
  'means it has no products, "publication_unknown" means publication could not '
  'be resolved -- all four are investigation findings, not copy jobs. READ '
  'page_days_present AGAINST source_days_available: the first is how many days '
  'this page surfaced in the truncated top-N, the second is how many days of '
  'data the shop has. A page absent on some days FELL OUT OF THE TOP N -- never '
  'report that as zero traffic or as missing data. Never sum these rows as store '
  'traffic (that is shopify_sessions_daily). Contains no search-engine data of '
  'any kind -- no queries, impressions, clicks, CTR or rankings.',
    updated_at = now()
where relname = 'seo_collection_candidates';

select public.refresh_chat_schema_catalog();
