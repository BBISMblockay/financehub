-- Forward-corrective for 20260909400000. A first-appearance date is not a
-- launch date, and the column name has to say so.
--
-- WHAT HAPPENED. On the first live run of the SEO workflow (2026-09-09,
-- silo-chat v63) Ask SILO returned, from correct data:
--
--   "38,286 sessions since launch on 2026-08-13"      (uncrustables-collection)
--   "41,264 sessions in just 8 days"                  (sonic-the-hedgehog)
--
-- Both are false, and measurably so. page_first_day was the first day the page
-- entered the TRUNCATED top-N -- not the day the collection launched, and not
-- the start of its traffic. Checked against sales_by_day:
--
--   uncrustables : first recorded sale 2026-07-28, 352 units over 10 selling
--                  days BEFORE the page ever entered the top N
--   sonic        : first recorded sale 2026-08-07,  85 units over  6 selling
--                  days before
--
-- So Uncrustables had been selling for over two weeks before the date the
-- answer called its launch, and "41k in just 8 days" reads as an explosive
-- launch spike to anyone planning against it.
--
-- The interesting part: the answer stated the truncation caveat correctly in
-- its own header and then made a claim that contradicted it. The general rule
-- ("an absent DAY is not zero traffic") did not generalise to the specific
-- inference ("the first day present is when it started"). A caveat that has to
-- be re-derived at each claim will eventually not be.
--
-- THE FIX IS THE NAME. page_first_day_in_top_n cannot be read as a launch date
-- without ignoring the words in it, where page_first_day invites exactly that
-- reading. The coverage_note now says it outright as well, so the warning
-- travels in the row rather than only in a prompt that must be remembered.
-- Renaming is cheap today -- the function is one day old and only Ask SILO
-- reads it -- and would not be later.
--
-- Return type changes, so DROP + CREATE, which resets privileges. Supabase's
-- default privileges re-grant EXECUTE to anon on any newly created public
-- function, so the revokes below are re-applied and are NOT redundant.

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
with win as (
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

comment on function public.seo_collection_candidates(integer, text) is
  'Collection landing pages with measured traffic over the last p_days '
  'COMPLETED Pacific days, each with an inspect_url built from the SAME SHOP''s '
  'verified storefront host. SECURITY INVOKER. Collection ROOTS only. '
  'page_first_day_in_top_n / page_last_day_in_top_n are TRUNCATION ARTEFACTS: '
  'the first and last day the page ranked in the top N. They are NOT launch or '
  'retirement dates and NOT the bounds of the page''s traffic -- a page may '
  'have existed and sold long before it first appears. Read page_days_present '
  'against source_days_available. candidate_status is the verdict: only '
  '"reviewable" is a copy job.';

revoke all on function public.seo_collection_candidates(integer, text) from public, anon;
grant execute on function public.seo_collection_candidates(integer, text) to authenticated;

update public.silo_chat_schema_catalog
set description =
  'FUNCTION, call as: select * from seo_collection_candidates(90). The intended '
  'starting point for on-page SEO work on COLLECTION pages. Window is the last '
  'p_days COMPLETED PACIFIC days. Each row carries inspect_url, already built '
  'from the SAME shop''s verified storefront host -- pass it straight to '
  'inspect_storefront_page; never assemble a URL yourself. READ candidate_status '
  'FIRST: only "reviewable" should receive rewritten copy; not_in_registry / '
  'not_published / empty_collection / publication_unknown are investigation or '
  'redirect findings. READ page_days_present AGAINST source_days_available: the '
  'first is how many days this page surfaced in the truncated top-N, the second '
  'is how many days of data the shop has. **page_first_day_in_top_n and '
  'page_last_day_in_top_n ARE NOT LAUNCH OR END DATES** -- they are only when '
  'the page ranked high enough to be recorded, so NEVER write "since launch", '
  '"in just N days", "new collection" or any age/spike claim from them; the '
  'page may have existed and had traffic long before. Check sales_by_day if a '
  'real start date matters. A page absent on some days FELL OUT OF THE TOP N -- '
  'never report that as zero traffic. Never sum these rows as store traffic '
  '(that is shopify_sessions_daily). Contains no search-engine data of any kind.',
    updated_at = now()
where relname = 'seo_collection_candidates';

select public.refresh_chat_schema_catalog();
