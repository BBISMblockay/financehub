-- Candidate collection pages for SEO review, with their URL already built.
--
-- WHY THIS EXISTS AT ALL, given the preference for prompt guidance over new
-- database objects: one join in here is safety-critical and cannot be left to
-- be re-derived correctly on every question.
--
-- THE WRONG-STORE HAZARD. Baseballism owns TWO 'primary' storefront hosts:
--     baseballism.myshopify.com          -> www.baseballism.com   (DTC)
--     baseballismwholesale.myshopify.com -> baseballismb2b.com    (B2B)
-- Both are allowlisted for the SAME company, so page-inspect will fetch
-- either one happily -- correctly, since both really are this company's
-- storefronts. But shopify_landing_pages_daily rows carry their own
-- shop_domain, and 182,502 of the 182,700 rows belong to the DTC store. Pair a
-- DTC path with the B2B host and you get HTTP 200 from a real page that has
-- nothing to do with the traffic being discussed -- a confident,
-- well-formatted, entirely wrong answer. The SSRF allowlist cannot catch this,
-- because nothing about it is a security violation.
--
-- So the host is joined on (company_entity_id, shop_domain) -- the SAME shop
-- the sessions were measured on -- and never merely on company.
--
-- THE PATH-SHAPE HAZARD. Of 1,311 distinct landing paths in the last 90 days,
-- only 85 are collection ROOTS (/collections/handle); 290 are collection
-- SUBPATHS (/collections/handle/product-slug), which are PRODUCT pages reached
-- in a collection context. Treating a subpath as a collection page would
-- attribute a product page's sessions to the collection and then rewrite the
-- wrong page's copy. Only roots are returned here, matched with an anchored
-- regex.
--
-- COVERAGE TRAVELS WITH THE ROW. Every candidate carries how many days of data
-- actually backed it, the real date range, and how many of those days hit the
-- top-N cap -- so a recommendation cannot be made from a number whose
-- coverage the reader never saw. On this store every single day is capped, so
-- days_truncated = days_with_data is the normal case, not an anomaly.

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
  sessions                 bigint,
  sessions_that_completed_checkout bigint,
  completed_checkout_rate  numeric,
  days_with_data           integer,
  earliest_day             date,
  latest_day               date,
  days_truncated           integer,
  coverage_note            text
)
language sql
stable
security invoker
set search_path = public
as $$
with win as (
  select greatest(least(coalesce(p_days, 90), 730), 1) as days
),
agg as (
  select
    lp.company_entity_id,
    lp.shop_domain,
    lp.landing_page_path,
    -- Anchored: a collection ROOT only. /collections/x/y is a product page.
    substring(lp.landing_page_path from '^/collections/([^/?#]+)$') as handle,
    sum(lp.sessions)                            as sessions,
    sum(lp.sessions_that_completed_checkout)    as completed,
    count(distinct lp.day_date)::int            as days_with_data,
    min(lp.day_date)                            as earliest_day,
    max(lp.day_date)                            as latest_day,
    count(distinct lp.day_date) filter (where lp.is_truncated)::int as days_truncated
  from public.shopify_landing_pages_daily lp, win
  where lp.day_date >= current_date - win.days
    and (p_shop_domain is null or lp.shop_domain = p_shop_domain)
    and lp.landing_page_path ~ '^/collections/[^/?#]+$'
  group by 1,2,3,4
)
select
  a.shop_domain,
  d.host,
  d.kind,
  a.landing_page_path,
  a.handle,
  -- NULL when no host for THIS shop is known. A null URL is the correct
  -- answer: there is nothing safe to substitute, and borrowing a sibling
  -- store's host is exactly the wrong-store bug this function prevents.
  case when d.host is null then null
       else 'https://' || d.host || a.landing_page_path end,
  c.title,
  c.products_count,
  c.published_to_online_store,
  (c.shopify_collection_id is not null),
  a.sessions,
  a.completed,
  case when a.sessions > 0
       then round((a.completed::numeric / a.sessions::numeric) * 100, 2)
       else null end,
  a.days_with_data,
  a.earliest_day,
  a.latest_day,
  a.days_truncated,
  format(
    '%s of %s day(s) in range hit the top-N landing-page cap; figures cover %s to %s. '
    || 'Landing-page rows are per-page and TRUNCATED -- absence is never zero traffic, '
    || 'and these must never be summed as a store total (use shopify_sessions_daily).',
    a.days_truncated, a.days_with_data, a.earliest_day, a.latest_day)
from agg a
-- SAME SHOP, not merely same company. This is the load-bearing line.
left join lateral (
  select sd.host, sd.kind
  from public.shopify_shop_domains sd
  where sd.company_entity_id = a.company_entity_id
    and sd.shop_domain       = a.shop_domain
  -- Prefer the custom storefront domain; the shop's own myshopify domain is
  -- the same store either way, so falling back to it cannot misattribute.
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
  'Collection landing pages that have measured traffic in the last p_days, with '
  'a ready-to-inspect URL built from the SAME SHOP''s verified storefront host. '
  'SECURITY INVOKER -- scoped to the caller''s company by the underlying tables'' '
  'RLS. Collection ROOTS only (/collections/handle); a subpath is a product '
  'page and is excluded. inspect_url is NULL when no host is known for that '
  'shop, which is the correct answer rather than borrowing a sibling store''s '
  'domain. Every row carries its own coverage and truncation facts: these are '
  'per-page TRUNCATED figures, never a store total, and an absent page is not '
  'a page with zero traffic.';

revoke all on function public.seo_collection_candidates(integer, text) from public, anon;
grant execute on function public.seo_collection_candidates(integer, text) to authenticated;

insert into public.silo_chat_schema_catalog (relname, relkind, description, keywords, columns)
values
  ('seo_collection_candidates', 'f',
   'FUNCTION, call as: select * from seo_collection_candidates(90). The intended '
   'starting point for on-page SEO work on COLLECTION pages. Returns collection '
   'landing pages with measured sessions in the window, each with inspect_url '
   'already built from the SAME shop''s verified storefront host -- pass that '
   'url straight to inspect_storefront_page, do NOT assemble a URL yourself and '
   'do NOT pair a path from one shop with another shop''s domain. Second '
   'argument optionally pins one shop_domain. Read coverage_note, '
   'days_truncated and days_with_data before making any claim: these are '
   'per-page truncated figures. NEVER sum them as store traffic (that is '
   'shopify_sessions_daily) and never read an absent page as zero traffic. '
   'Contains no search-engine data of any kind -- no queries, impressions, '
   'clicks, CTR or rankings.',
   array['seo','collection','landing page','candidate','inspect','on-page','opportunity'],
   '[]'::jsonb)
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords,
      updated_at  = now();

select public.refresh_chat_schema_catalog();
