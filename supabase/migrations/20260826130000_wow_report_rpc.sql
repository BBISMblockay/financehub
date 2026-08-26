-- Week over Week report data in one call, scoped to the online store.
--
-- Background: the weekly report existed as a hand-filled HTML form -- every
-- figure typed in from Shopify, GA4 and Ads Manager by hand. Roughly
-- two-thirds of those fields are already in SILO, so this returns them.
--
-- ONLINE SCOPE. Orders are source_name = 'web' (the Shopify online store);
-- sales and inventory are location_tag = 'online', which is what
-- locations.store_type = 'online' covers -- exactly one location code. That
-- matters: blended across retail POS and wholesale, AOV reads $76.34 and the
-- returning rate 27%. Online alone it is $93.43 and 33.9%. Same week, very
-- different business.
--
-- Channel mix stays all-channel on purpose, as context beside the online
-- figures, and it doubles as the template's TikTok attribution table.
--
-- INVENTORY IS DE-DUPLICATED, one row per SKU via distinct on. The current
-- inventory matview carries duplicate sku/location rows -- 4,728 pairs
-- overall, 191 in the online location -- so a naive sum overstates online
-- units by about 5% (303,826 vs 287,684). Summing by product title without
-- this produced 104,980 units of a single drawstring bag.
--
-- Last year is 364 days back, not 365: exactly 52 weeks, so the window lands
-- on the same weekdays. A 7-day window that shifts a Saturday in or out moves
-- the number more than real demand does.
--
-- Deliberately absent: add-to-cart / reach-checkout / complete-checkout.
-- SILO holds those only for Meta AD traffic, not sitewide, so a sitewide
-- funnel would be wrong rather than incomplete. Those stay manual from GA4.
--
-- SECURITY INVOKER: RLS scopes every read to the caller's active company.
-- That is also why inventory comes from inventory_on_hand_current_v rather
-- than the matview it wraps -- see the note on the inv CTE below.

create or replace function public.wow_report(p_report_date date default current_date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with w as (
  select p_report_date       as e,   p_report_date - 6   as s,
         p_report_date - 7   as pe,  p_report_date - 13  as ps,
         p_report_date - 364 as lye, p_report_date - 370 as lys
),
ord as (
  select o.order_id, o.customer_id, o.total_price
  from public.shopify_orders o cross join w
  where o.shopify_created_at::date between w.s and w.e
    and o.cancelled_at is null
    and o.source_name = 'web'
),
ord_all as (
  select coalesce(o.resolved_channel_name, o.source_name, 'Unknown') as channel,
         o.total_price
  from public.shopify_orders_v o cross join w
  where o.shopify_created_at::date between w.s and w.e and o.cancelled_at is null
),
wk_cust as (select distinct customer_id from ord where customer_id is not null),
firsts as (
  select o.customer_id, min(o.shopify_created_at::date) as first_d
  from public.shopify_orders o
  join wk_cust c on c.customer_id = o.customer_id
  where o.cancelled_at is null
  group by 1
),
sbd as (
  select s.* from public.sales_by_day s cross join w
  where s.day_date between w.ps and w.e
    and lower(btrim(s.location_tag)) = 'online'
),
cur_cat as (select product_type, sum(total_net_sales) v from sbd cross join w
            where day_date between w.s and w.e and product_type is not null group by 1),
prev_cat as (select product_type, sum(total_net_sales) v from sbd cross join w
             where day_date between w.ps and w.pe and product_type is not null group by 1),
cat_total as (select sum(v) t from cur_cat),
-- inventory_on_hand_current_v, NOT the matview underneath it. Matviews carry
-- no RLS and authenticated holds no grant on one, so reading it directly
-- fails at runtime with "permission denied for materialized view" -- invisible
-- from a service-role connection, which sees zero rows instead of an error.
-- The view is the definer-owned wrapper, and it also scopes to
-- active_company_id(), which filtering the matview by location_tag alone
-- did not.
inv as (
  select distinct on (variant_sku)
         variant_sku, product_title, total_available_quantity
  from public.inventory_on_hand_current_v
  where lower(btrim(location_tag)) = 'online'
  order by variant_sku, snapshot_at desc, id desc
),
inv_by_title as (
  select lower(btrim(product_title)) k, sum(total_available_quantity) oh
  from inv group by 1
)
select jsonb_build_object(
  'report_date', p_report_date,
  'scope', 'online',
  'window', (select jsonb_build_object('start', w.s, 'end', w.e, 'prev_start', w.ps,
                    'prev_end', w.pe, 'ly_start', w.lys, 'ly_end', w.lye) from w),
  'core', (select jsonb_build_object(
      'gross_sales', round(coalesce(sum(total_price),0)::numeric,0),
      'orders', count(*),
      'aov', round((coalesce(sum(total_price),0)/nullif(count(*),0))::numeric,2)) from ord),
  'customers', (select jsonb_build_object(
      'total', count(*), 'returning', count(*) filter (where first_d < (select s from w)),
      'returning_pct', round(100.0*count(*) filter (where first_d < (select s from w))/nullif(count(*),0),1),
      'history_starts', (select min(shopify_created_at)::date from public.shopify_orders)) from firsts),
  'inventory', (select jsonb_build_object(
      'units_on_hand', coalesce(sum(total_available_quantity),0),
      'skus', count(*)) from inv),
  'channels', (select coalesce(jsonb_agg(x order by sv desc),'[]'::jsonb) from (
      select jsonb_build_object('channel', channel, 'sales', round(sum(total_price)::numeric,0),
               'pct', round(100.0*sum(total_price)/nullif((select sum(total_price) from ord_all),0),1)) x,
             sum(total_price) sv
      from ord_all group by channel) c),
  'ga4', (select jsonb_build_object(
      'sessions_ty', coalesce(sum(sessions) filter (where day_date between (select s from w) and (select e from w)),0),
      'sessions_ly', coalesce(sum(sessions) filter (where day_date between (select lys from w) and (select lye from w)),0),
      'revenue_ty', round(coalesce(sum(conversion_value) filter (where day_date between (select s from w) and (select e from w)),0)::numeric,0),
      'revenue_ly', round(coalesce(sum(conversion_value) filter (where day_date between (select lys from w) and (select lye from w)),0)::numeric,0)
    ) from public.marketing_kpis_daily where platform='ga4'),
  'top_products', (select coalesce(jsonb_agg(x order by u desc),'[]'::jsonb) from (
      select jsonb_build_object('product', p.product_name, 'units', p.u,
               'sales', round(p.sales::numeric,0),
               'on_hand', i.oh,
               'days_of_stock', case when p.u > 0 and i.oh is not null
                                     then round((i.oh/(p.u/7.0))::numeric,0) end) x, p.u
      from (select s.product_name, sum(s.total_quantity_sold) u, sum(s.total_net_sales) sales
            from sbd s cross join w
            where s.day_date between w.s and w.e and s.product_name is not null
              and coalesce(s.product_type,'') <> 'Package Protection'
            group by 1 order by 2 desc limit 10) p
      left join inv_by_title i on i.k = lower(btrim(p.product_name))) t),
  'categories', (select coalesce(jsonb_agg(x order by v desc),'[]'::jsonb) from (
      select jsonb_build_object('category', c.product_type, 'sales', round(c.v::numeric,0),
               'pct', round(100.0*c.v/nullif((select t from cat_total),0),1),
               'wow', round(100.0*(c.v-p.v)/nullif(p.v,0),1)) x, c.v
      from cur_cat c left join prev_cat p using (product_type) order by c.v desc limit 12) g),
  'paid', (select coalesce(jsonb_agg(x order by sp desc),'[]'::jsonb) from (
      select jsonb_build_object('platform', m.platform, 'campaign', m.campaign_name,
               'spend', round(sum(m.spend)::numeric,0),
               'roas', round((sum(m.conversion_value)/nullif(sum(m.spend),0))::numeric,2),
               'clicks', sum(m.clicks),
               'cost_per_conv', round((sum(m.spend)/nullif(sum(m.conversions),0))::numeric,2)) x,
             sum(m.spend) sp
      from public.marketing_kpis_daily m cross join w
      where m.day_date between w.s and w.e and m.platform in ('meta_ads','google_ads')
      group by m.platform, m.campaign_name having sum(m.spend) > 0 order by sp desc limit 12) pm),
  'creatives', (select coalesce(jsonb_agg(x order by sp desc),'[]'::jsonb) from (
      select jsonb_build_object('ad', p.ad_name, 'spend', round(sum(p.spend)::numeric,0),
               'roas', round((sum(p.conversion_value)/nullif(sum(p.spend),0))::numeric,2),
               'clicks', sum(p.clicks), 'thumb', max(c.thumbnail_url)) x, sum(p.spend) sp
      from public.meta_ad_performance_daily p
      left join public.meta_ad_creatives c on c.ad_id=p.ad_id and c.company_entity_id=p.company_entity_id
      cross join w
      where p.day_date between w.s and w.e
      group by p.ad_name having sum(p.spend) > 0 order by sp desc limit 6) cr)
);
$$;

revoke all on function public.wow_report(date) from public, anon;
grant execute on function public.wow_report(date) to authenticated;

comment on function public.wow_report(date) is
  'Week over Week report data for the 7 days ending p_report_date, scoped to ONLINE: orders are source_name = web (the Shopify online store), sales and inventory are location_tag = online, matching locations.store_type. Channel mix is all-channel on purpose, as context beside the online figures. Inventory is de-duplicated one row per SKU -- the current-inventory matview carries duplicate sku/location rows and a naive sum overstates online units by roughly 5%. Last year is 364 days back so weekdays align. SECURITY INVOKER: RLS scopes every read to the caller''s active company.';
