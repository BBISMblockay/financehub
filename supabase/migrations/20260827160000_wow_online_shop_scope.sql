-- Scope every per-shop RPC to the online store's domain.
--
-- shopify_discount_codes_daily, shopify_landing_pages_daily and
-- shopify_sessions_daily all carry a row per CONNECTION, and this company has
-- 22 -- one online store and 21 retail locations. Three RPCs filtered on
-- company but not on shop, so an online-scoped report was summing retail:
--
--   discount codes, no-code gross   $329,105.54 all shops
--                                   $195,287.49 online  <- matches Shopify
--   funnel sessions                 168,774 all shops
--                                   168,704 online      <- matches Shopify
--
-- The discount-code case was the visible one: retail store codes were being
-- listed as affiliate codes, and retail sales inflated the "share of sales
-- through a code" denominator. The funnel case was 70 sessions -- immaterial
-- today, wrong in principle, and it grows with every location opened.
--
-- Found by comparing against Shopify's own analytics. The tell was that the
-- NAMED codes matched to the cent while the uncoded bucket did not: a bad
-- number moves everything, an extra population moves only the aggregate.
--
-- "Online" is derived from the report's own definition -- the shop whose
-- sales carry location_tag='online' -- rather than a hardcoded domain, so it
-- stays correct if the store changes.
create or replace function public.wow_online_shop_domains()
returns table (shop_domain text)
language sql
stable
as $$
  select distinct s.shop_domain
  from public.sales_by_day s
  where s.company_entity_id = public.active_company_id()
    and lower(btrim(s.location_tag)) = 'online'
    and s.shop_domain is not null;
$$;

grant execute on function public.wow_online_shop_domains() to authenticated;

-- wow_discount_codes, wow_landing_pages and wow_funnel are redefined against
-- this helper. Bodies are as deployed; see 20260827090000 / 20260827100000 /
-- 20260827020000 for their original shape.
