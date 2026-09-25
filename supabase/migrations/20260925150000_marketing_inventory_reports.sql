-- Marketing and inventory SILO reports: platform attribution, creative
-- performance, inventory drilldowns, broader overstock.
--
-- Report definitions only: no table, view, policy or grant changes. Every
-- query reads a security_invoker view or an RLS-enabled table (never a
-- matview directly), so each global definition scopes itself to the
-- caller's active company, exactly like the reports it extends. Existing
-- report ids are updated in place, so every widget that points at them keeps
-- working; the one report added is new (c3..0a).
--
-- columns_metadata._queries is read by v3/js/report-preview.js: when a
-- report declares it, opening the report draws one titled tile per query
-- instead of only the last one. It is not a column (no SQL column here is
-- named _queries) and every column-keyed reader ignores it.
--
-- ── 1. Attribution vs Sales: by platform, then the combined comparison ────
-- q0 was one combined row. It is now one row per ad platform with the same
-- platform key and the same spend/claim sums as Ads by Platform, so the two
-- reports tie row for row. Nothing here allocates online sales to a
-- platform: a claim is compared with online sales only as a share of it,
-- and no column is called ROAS except the platform's own claimed ROAS.
-- q1 keeps the combined comparison, with the old "real online ROAS" renamed
-- to what it is -- online net sales per ad dollar (blended MER).
update public.silo_chat_saved_reports set
  description = 'What each ad platform credits itself with, next to its spend, and the combined comparison with canonical online net sales. Platform claims overlap (one order can be claimed by Meta and Google at once) and are not incremental sales, so they are never added together as sales or allocated to online revenue. "Claim as % of online sales" compares one platform''s claim with all online sales; it is not that platform''s share of them. Spend and claims tie to Ads by Platform. Cross-source figures stay blank when a day is missing from either source. Defaults to 28 completed company-calendar days.',
  queries_run = array[
$q$with plat as materialized (
  select platform, sum(spend) spend, sum(conversion_value) credited, sum(conversions) conversions,
         count(distinct day_date) days_reported
    from marketing_kpis_daily
   where platform <> 'ga4' and day_date between {{date_from}} and {{date_to}}
   group by platform
), spend_days as materialized (
  select distinct day_date from marketing_kpis_daily
   where platform <> 'ga4' and day_date between {{date_from}} and {{date_to}}
), online as materialized (
  select s.day_date, sum(s.total_net_sales) online_net_sales
    from sales_by_day_verification_v s
   where s.day_date between {{date_from}} and {{date_to}}
     and s.location_tag = any (public.silo_channel_location_tags('online'))
   group by s.day_date
), cover as (
  select bool_and(sd.day_date is not null and o.day_date is not null) complete,
         sum(o.online_net_sales) online_net_sales
    from spend_days sd full join online o using (day_date)
), tot as (select sum(credited) all_claims from plat)
select p.platform,
       round(p.spend, 2) as spend,
       round(p.credited, 2) as platform_credited_revenue,
       round(p.credited / nullif(p.spend, 0), 2) as claimed_roas,
       round(p.conversions, 1) as claimed_conversions,
       round(p.credited / nullif(t.all_claims, 0), 4) as share_of_platform_claims,
       case when c.complete then round(p.credited / nullif(c.online_net_sales, 0), 4) end as claim_as_pct_of_online_sales,
       p.days_reported
  from plat p cross join tot t cross join cover c
 order by p.spend desc, p.platform$q$,
$q$with spend as materialized (
  select day_date, sum(spend) ad_spend, sum(conversion_value) claimed
    from marketing_kpis_daily
   where platform <> 'ga4' and day_date between {{date_from}} and {{date_to}}
   group by day_date
), online as materialized (
  select s.day_date, sum(s.total_net_sales) online_net_sales
    from sales_by_day_verification_v s
   where s.day_date between {{date_from}} and {{date_to}}
     and s.location_tag = any (public.silo_channel_location_tags('online'))
   group by s.day_date
)
select round(sum(sp.ad_spend), 2) as ad_spend,
       round(sum(sp.claimed), 2) as platforms_claim,
       round(sum(o.online_net_sales), 2) as online_net_sales,
       round(sum(sp.claimed) / nullif(sum(sp.ad_spend), 0), 2) as claimed_roas,
       case when bool_and(sp.day_date is not null and o.day_date is not null)
            then round(sum(o.online_net_sales) / nullif(sum(sp.ad_spend), 0), 2) end as online_sales_per_ad_dollar,
       case when bool_and(sp.day_date is not null and o.day_date is not null)
            then round(sum(sp.claimed) / nullif(sum(o.online_net_sales), 0), 2) end as claim_ratio,
       count(*) filter (where sp.day_date is null or o.day_date is null) as days_missing_a_source
  from spend sp full join online o using (day_date)$q$],
  parameters = '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"}]'::jsonb,
  columns_metadata = '{
    "_queries":[{"index":0,"title":"By platform","chart":true},{"index":1,"title":"All platforms vs online net sales","chart":false}],
    "platform":{"label":"Platform","semantic":"category","chart_dimension":true},
    "spend":{"label":"Spend","semantic":"currency"},
    "platform_credited_revenue":{"label":"Revenue Credited by Platform","semantic":"currency","chart_primary":true},
    "claimed_roas":{"label":"Claimed ROAS","semantic":"number"},
    "claimed_conversions":{"label":"Claimed Conversions","semantic":"count"},
    "share_of_platform_claims":{"label":"Share of All Platform Claims","semantic":"fraction"},
    "claim_as_pct_of_online_sales":{"label":"Claim as % of Online Net Sales","semantic":"fraction","blank_reason":"Blank when a day in the window is missing from ad spend or online sales, so the two cannot be compared."},
    "days_reported":{"label":"Days Reported","semantic":"count"},
    "ad_spend":{"label":"Ad Spend","semantic":"currency"},
    "platforms_claim":{"label":"Platforms Claim (overlapping)","semantic":"currency"},
    "online_net_sales":{"label":"Online Net Sales","semantic":"currency"},
    "online_sales_per_ad_dollar":{"label":"Online Sales per Ad Dollar (MER)","semantic":"number","blank_reason":"Blank when a day in the window is missing from ad spend or online sales."},
    "claim_ratio":{"label":"Claims ÷ Online Net Sales","semantic":"number","blank_reason":"Blank when a day in the window is missing from ad spend or online sales."},
    "days_missing_a_source":{"label":"Days Missing a Source","semantic":"count"}
  }'::jsonb
where id = 'c3000000-0000-4000-a000-000000000005';

-- ── 2. Creative Performance (new) ─────────────────────────────────────────
-- Platform -> campaign -> ad. Meta is stored at AD grain
-- (meta_ad_performance_daily); Google Ads is stored at CAMPAIGN grain only
-- (marketing_kpis_daily has no ad table), so a Google row says so in
-- `grain` rather than posing as a creative. TikTok has no connection today;
-- it would appear only once the sync writes it.
--
-- Media is what Meta returned and nothing more: thumbnail_url is a 64x64
-- signed fbcdn URL whose `oe` parameter is its expiry (hex epoch). An
-- expired URL renders as a broken image, so the query hands the table NULL
-- and names the reason in media_status; the table draws a placeholder.
-- preview_shareable_link opens Meta's own full-size preview of the ad.
insert into public.silo_chat_saved_reports
  (id, company_entity_id, source, visibility, title, description, queries_run, parameters, columns_metadata)
values
('c3000000-0000-4000-a000-00000000000a', null, 'system', 'company',
 'Creative Performance',
 'Paid spend and what each platform credits itself with, by platform, campaign and ad. Meta is reported per ad with its thumbnail and a link to Meta''s full preview; Google Ads is synced at campaign level only, so its rows are campaigns, not creatives. Revenue is credited by the platform, overlaps other platforms and is not incremental sales. Thumbnails are small (64px) and Meta''s image links expire a few days after each sync, so older ads show a placeholder with the reason. Meta''s ad-level credited revenue can differ from its campaign-level figure by a few dollars; spend agrees.',
 array[
$q$with meta as materialized (
  select sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited,
         count(distinct campaign_id) filter (where spend > 0) campaigns, count(distinct ad_id) filter (where spend > 0) ads
    from meta_ad_performance_daily
   where day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'meta_ads')
), google as materialized (
  select sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited,
         count(distinct campaign_id) filter (where spend > 0) campaigns
    from marketing_kpis_daily
   where platform = 'google_ads' and day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'google_ads')
)
select 'meta_ads' as platform, 'Ad' as grain, m.campaigns, m.ads,
       round(m.spend, 2) as spend, m.impressions, m.clicks,
       round(m.clicks::numeric / nullif(m.impressions, 0), 4) as ctr,
       round(m.conversions, 1) as conversions, round(m.credited, 2) as platform_credited_revenue,
       round(m.credited / nullif(m.spend, 0), 2) as claimed_roas
  from meta m where m.spend is not null
union all
select 'google_ads', 'Campaign (no ad-level data)', g.campaigns, null,
       round(g.spend, 2), g.impressions, g.clicks,
       round(g.clicks::numeric / nullif(g.impressions, 0), 4),
       round(g.conversions, 1), round(g.credited, 2), round(g.credited / nullif(g.spend, 0), 2)
  from google g where g.spend is not null
 order by spend desc$q$,
$q$with meta as materialized (
  select campaign_id, max(campaign_name) campaign_name,
         sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited,
         count(distinct ad_id) filter (where spend > 0) ads
    from meta_ad_performance_daily
   where day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'meta_ads')
   group by campaign_id
), google as materialized (
  select campaign_id, max(campaign_name) campaign_name,
         sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited
    from marketing_kpis_daily
   where platform = 'google_ads' and day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'google_ads')
   group by campaign_id
)
select 'meta_ads' as platform, coalesce(campaign_name, campaign_id) as campaign, ads,
       round(spend, 2) as spend, impressions, clicks,
       round(clicks::numeric / nullif(impressions, 0), 4) as ctr,
       round(conversions, 1) as conversions, round(credited, 2) as platform_credited_revenue,
       round(credited / nullif(spend, 0), 2) as claimed_roas, campaign_id
  from meta
union all
select 'google_ads', coalesce(campaign_name, campaign_id), null,
       round(spend, 2), impressions, clicks,
       round(clicks::numeric / nullif(impressions, 0), 4),
       round(conversions, 1), round(credited, 2), round(credited / nullif(spend, 0), 2), campaign_id
  from google
 order by spend desc nulls last, campaign_id$q$,
$q$with meta as materialized (
  select campaign_id, max(campaign_name) campaign_name, ad_id, max(ad_name) ad_name,
         sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited,
         count(distinct day_date) filter (where spend > 0) days_with_spend,
         min(day_date) filter (where spend > 0) first_spend_day,
         max(day_date) filter (where spend > 0) last_spend_day
    from meta_ad_performance_daily
   where day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'meta_ads')
   group by campaign_id, ad_id
), google as materialized (
  select campaign_id, max(campaign_name) campaign_name,
         sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited,
         count(distinct day_date) filter (where spend > 0) days_with_spend,
         min(day_date) filter (where spend > 0) first_spend_day,
         max(day_date) filter (where spend > 0) last_spend_day
    from marketing_kpis_daily
   where platform = 'google_ads' and day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'google_ads')
   group by campaign_id
), media as (
  select c.ad_id, c.object_type, c.preview_shareable_link, c.thumbnail_url,
         case when c.thumbnail_url is null then null
              when substring(c.thumbnail_url from '[?&]oe=([0-9A-Fa-f]{1,15})(&|$)') is null then true
              else to_timestamp(('x' || lpad(substring(c.thumbnail_url from '[?&]oe=([0-9A-Fa-f]{1,15})(&|$)'), 16, '0'))::bit(64)::bigint) > now()
         end as thumbnail_live
    from meta_ad_creatives c
)
select case when md.thumbnail_live then md.thumbnail_url end as thumbnail,
       'meta_ads' as platform, coalesce(m.campaign_name, m.campaign_id) as campaign,
       coalesce(nullif(m.ad_name, ''), m.ad_id) as ad, 'Ad' as grain,
       case when md.ad_id is null then 'Creative not synced'
            when md.thumbnail_url is null then 'No thumbnail from Meta'
            when md.thumbnail_live then 'Thumbnail (64px)'
            else 'Thumbnail link expired; re-sync needed' end as media_status,
       initcap(replace(lower(md.object_type), '_', ' ')) as format,
       md.preview_shareable_link as ad_preview,
       round(m.spend, 2) as spend, m.impressions, m.clicks,
       round(m.clicks::numeric / nullif(m.impressions, 0), 4) as ctr,
       round(m.conversions, 1) as conversions, round(m.credited, 2) as platform_credited_revenue,
       round(m.credited / nullif(m.spend, 0), 2) as claimed_roas,
       m.days_with_spend, m.first_spend_day, m.last_spend_day, m.ad_id, m.campaign_id
  from meta m left join media md on md.ad_id = m.ad_id
union all
select null, 'google_ads', coalesce(g.campaign_name, g.campaign_id),
       coalesce(g.campaign_name, g.campaign_id) || ' (Google campaign)', 'Campaign (no ad-level data)',
       'Not available: Google Ads is synced at campaign level', null, null,
       round(g.spend, 2), g.impressions, g.clicks,
       round(g.clicks::numeric / nullif(g.impressions, 0), 4),
       round(g.conversions, 1), round(g.credited, 2), round(g.credited / nullif(g.spend, 0), 2),
       g.days_with_spend, g.first_spend_day, g.last_spend_day, null, g.campaign_id
  from google g
 order by spend desc nulls last, ad_id, campaign_id$q$,
$q$with daily as (
  select day_date, 'meta_ads' as platform, sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks,
         sum(conversions) conversions, sum(conversion_value) credited
    from meta_ad_performance_daily
   where day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'meta_ads')
   group by day_date
  union all
  select day_date, 'google_ads', sum(spend), sum(impressions), sum(clicks), sum(conversions), sum(conversion_value)
    from marketing_kpis_daily
   where platform = 'google_ads' and day_date between {{date_from}} and {{date_to}} and {{platform}} in ('all', 'google_ads')
   group by day_date
)
select day_date, platform, round(spend, 2) as spend, impressions, clicks,
       round(conversions, 1) as conversions, round(credited, 2) as platform_credited_revenue,
       round(credited / nullif(spend, 0), 2) as claimed_roas
  from daily
 order by day_date, platform$q$],
 '[{"key":"date_from","type":"date","label":"From","default":"today-28d","date_basis":"company"},{"key":"date_to","type":"date","label":"Through","default":"today-1d","date_basis":"company"},{"key":"platform","type":"enum","label":"Platform","default":"all","options":["all","meta_ads","google_ads"]}]'::jsonb,
 '{
   "_queries":[{"index":0,"title":"By platform","chart":false},{"index":1,"title":"By campaign","chart":true},{"index":2,"title":"By ad / creative","chart":true},{"index":3,"title":"Daily trend","chart":true}],
   "thumbnail":{"label":"Creative","semantic":"image","link_column":"ad_preview"},
   "platform":{"label":"Platform","semantic":"category"},
   "grain":{"label":"Reported At","semantic":"category"},
   "campaign":{"label":"Campaign","semantic":"category","chart_dimension":true},
   "campaigns":{"label":"Campaigns","semantic":"count"},
   "ads":{"label":"Ads","semantic":"count"},
   "ad":{"label":"Ad","semantic":"category","chart_dimension":true},
   "media_status":{"label":"Media","semantic":"category"},
   "format":{"label":"Format","semantic":"category"},
   "ad_preview":{"label":"Meta Preview","semantic":"link"},
   "spend":{"label":"Spend","semantic":"currency","chart_primary":true},
   "impressions":{"label":"Impressions","semantic":"count"},
   "clicks":{"label":"Clicks","semantic":"count"},
   "ctr":{"label":"CTR","semantic":"fraction"},
   "conversions":{"label":"Claimed Conversions","semantic":"count"},
   "platform_credited_revenue":{"label":"Revenue Credited by Platform","semantic":"currency"},
   "claimed_roas":{"label":"Claimed ROAS","semantic":"number"},
   "days_with_spend":{"label":"Days With Spend","semantic":"count"},
   "first_spend_day":{"label":"First Spend","semantic":"date"},
   "last_spend_day":{"label":"Last Spend","semantic":"date"},
   "day_date":{"label":"Day","semantic":"date"},
   "ad_id":{"label":"Ad ID","semantic":"category"},
   "campaign_id":{"label":"Campaign ID","semantic":"category"}
 }'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, queries_run = excluded.queries_run,
  parameters = excluded.parameters, columns_metadata = excluded.columns_metadata,
  source = 'system', company_entity_id = null, visibility = 'company';

-- ── 3. Inventory Summary: the total, by product type, and by SKU ──────────
-- q0 keeps its four columns and their meaning (the KPI tiles on five boards
-- read them) and adds a MEASURED cover: cover over the types that have 12
-- months of sales, with the stock it leaves out stated beside it rather
-- than dropped. Portfolio cover stays blank while any stocked type is
-- unmeasured -- a number that silently excluded stock would look complete.
--
-- q1 says WHY a type has no measured demand. Investigated 2026-09-25 on
-- Baseballism (15 stocked types, 1,425 units):
--   * First sales this month: demand_coverage_base_mv counts COMPLETE months
--     only, so a type that started selling this month reads as unsold
--     (Toddler Pack: 392 sold in September).
--   * Sold under another product type: the SKUs sell, but their sales rows
--     carry a different product_type than the inventory rows (Gift Wrap's
--     SKUs sold 1,885 under "Giveaway" and "Gift Tag/Gift Wrap Pack").
--   * Net returns: more returned than sold (Jersey, -1).
--   * No sales in 12 months: genuinely unsold (the other 12 types).
--   * On order; no sales under this type name: incoming whose PO type label
--     matches no selling Shopify type. Real ones today are naming drift, not
--     new products -- "Pins" (4,200 on order) vs "Pin", "Drawstring Bag"
--     (11,000) vs "Draw String Bag", "Youth Boxers" (3,000) -- so the status
--     says what is known rather than "never sold".
-- The SKU check reads SKU velocity whatever product type the sale carried.
--
-- q2 is the product/SKU drilldown at (SKU, product type) grain -- the grain
-- that sums back to q1 exactly, since 160 SKUs are stocked under more than
-- one type label. Demand is the SKU's trailing 365 days
-- (sales_velocity_by_sku_location_v), a different window from q1's 12
-- complete months, and labelled so. Stock with no product type (7,811 units
-- on 2026-09-25) is outside q0/q1 and shown here as "(no product type)".
-- Image: Shopify's product image from inventory, else products_master's.
update public.silo_chat_saved_reports set
  description = 'On-hand and confirmed incoming stock: the total, each product type, and each product/SKU. Cover uses trailing demand; combined cover includes incoming units. Total cover is blank while any stocked type has no measured demand, so a measured-only cover is shown beside it with the stock it excludes. Each type says why its demand is missing (first sales this month, sold under another product type, net returns, or no sales in 12 months). Type demand is 12 complete months; SKU demand is the trailing 365 days. Stock with no product type appears only in the SKU list.',
  queries_run = array[
$q$select sum(units_on_hand) units_on_hand, sum(units_on_order) units_on_order,
case when count(*) filter (where (units_on_hand>0 or units_on_order>0) and (units_12m is null or units_12m<=0))=0
then round(sum(units_on_hand+units_on_order)/nullif(sum(units_12m)/52.0,0),1) end weeks_of_cover,
case when count(*) filter (where units_on_hand>0 and (units_12m is null or units_12m<=0))=0
then round(sum(units_on_hand)/nullif(sum(units_12m)/52.0,0),1) end weeks_on_hand,
round(sum(units_on_hand+units_on_order) filter (where units_12m>0)
      / nullif(sum(units_12m) filter (where units_12m>0)/52.0,0),1) weeks_of_cover_measured,
coalesce(sum(greatest(units_on_hand,0)+units_on_order) filter (where coalesce(units_12m,0)<=0 and (units_on_hand>0 or units_on_order>0)),0) units_without_measured_demand,
count(*) filter (where coalesce(units_12m,0)<=0 and (units_on_hand>0 or units_on_order>0)) types_without_measured_demand
from demand_coverage_by_type_v where has_inventory or units_on_order>0$q$,
$q$with dc as materialized (
  select * from demand_coverage_by_type_v
   where (has_inventory or units_on_order > 0) and (units_on_hand <> 0 or units_on_order <> 0)
), this_month as materialized (
  select product_type, sum(units) units
    from sales_monthly_product_type_rollup_v
   where month_start = date_trunc('month', (select public.silo_business_today()))::date
   group by product_type
), sku_types as materialized (
  select distinct variant_sku as sku, product_type
    from inventory_on_hand_current_v
   where coalesce(variant_sku, '') <> '' and coalesce(product_type, '') <> ''
), sku_demand as materialized (
  select st.product_type, sum(v.qty_365d) units, max(v.last_sold_date) last_sold_date
    from sales_velocity_by_sku_location_v v join sku_types st on st.sku = v.variant_sku
   group by st.product_type
)
select dc.product_type,
       case when dc.units_12m > 0 then 'Measured'
            when dc.units_12m is not null then 'Net returns (12 months)'
            when coalesce(tm.units, 0) > 0 then 'First sales this month'
            when coalesce(sd.units, 0) > 0 then 'Sold under another product type'
            when dc.units_on_hand > 0 then 'No sales in 12 months'
            when dc.units_on_order > 0 then 'On order; no sales under this type name'
            else 'Negative on hand' end as demand_status,
       dc.units_on_hand, dc.units_on_order, dc.units_12m, dc.units_per_week_12m,
       case when dc.units_12m > 0 then round(dc.units_on_hand / (dc.units_12m / 52.0), 1) end as weeks_on_hand,
       dc.weeks_of_cover, dc.momentum_pct,
       tm.units as units_this_month,
       sd.units as sku_units_365d,
       sd.last_sold_date
  from dc
  left join this_month tm on tm.product_type = dc.product_type
  left join sku_demand sd on sd.product_type = dc.product_type
 order by (dc.units_12m > 0) nulls first, dc.units_on_hand desc, dc.product_type$q$,
$q$with onhand as materialized (
  select variant_sku as sku, coalesce(nullif(product_type, ''), '(no product type)') as product_type,
         max(product_title) product_title, max(variant_title) variant_title,
         max(nullif(product_image_url, '')) image_url, sum(total_available_quantity) units_on_hand
    from inventory_on_hand_current_v
   where coalesce(variant_sku, '') <> ''
   group by 1, 2
), incoming as materialized (
  select sku, coalesce(nullif(product_type, ''), '(no product type)') as product_type,
         max(product_title) product_title, max(variant_title) variant_title,
         sum(qty) units_on_order, min(expected_arrival_date) next_arrival
    from v_po_incoming_lines
   where status in ('Confirmed', 'Sent to Factory', 'In Production', 'In Transit') and coalesce(sku, '') <> ''
   group by 1, 2
), lines as (
  select coalesce(o.sku, i.sku) sku, coalesce(o.product_type, i.product_type) product_type,
         coalesce(o.product_title, i.product_title) product_title, coalesce(o.variant_title, i.variant_title) variant_title,
         o.image_url, coalesce(o.units_on_hand, 0) units_on_hand, coalesce(i.units_on_order, 0) units_on_order, i.next_arrival
    from onhand o full join incoming i on i.sku = o.sku and i.product_type = o.product_type
   where coalesce(o.units_on_hand, 0) <> 0 or coalesce(i.units_on_order, 0) <> 0
), demand as materialized (
  select variant_sku as sku, sum(qty_365d) units_365d, sum(qty_90d) units_90d, max(last_sold_date) last_sold_date
    from sales_velocity_by_sku_location_v
   where variant_sku in (select sku from lines)
   group by variant_sku
)
select coalesce(l.image_url, nullif(pm.image_url, '')) as image,
       l.product_title, l.variant_title, l.sku, l.product_type,
       case when d.units_365d > 0 then 'Measured'
            when d.last_sold_date >= (select public.silo_business_today()) - 365 then 'Net returns (365 days)'
            when d.last_sold_date is not null then 'No sales in 365 days'
            when l.units_on_hand <= 0 then 'On order, never sold'
            else 'No sales recorded' end as demand_status,
       l.units_on_hand, l.units_on_order, l.next_arrival,
       d.units_365d, d.units_90d,
       case when d.units_365d > 0 and l.units_on_hand > 0 then round(l.units_on_hand / (d.units_365d / 52.0), 1) end as weeks_on_hand,
       case when d.units_365d > 0 then round((greatest(l.units_on_hand, 0) + l.units_on_order) / (d.units_365d / 52.0), 1) end as weeks_of_cover,
       d.last_sold_date
  from lines l
  left join demand d on d.sku = l.sku
  left join products_master pm on pm.sku = l.sku and pm.company_entity_id = (select public.active_company_id())
 order by l.units_on_hand desc, l.sku, l.product_type$q$],
  columns_metadata = '{
    "_queries":[{"index":0,"title":"Total","chart":false},{"index":1,"title":"By product type","chart":true},{"index":2,"title":"By product / SKU","chart":false}],
    "units_on_hand":{"label":"On Hand","semantic":"count","chart_primary":true},
    "units_on_order":{"label":"On Order","semantic":"count"},
    "weeks_of_cover":{"label":"Cover incl. incoming (weeks)","semantic":"number","blank_reason":"Blank while any product type with stock or orders has no measured demand in the last 12 months, so total cover cannot be computed. Measured-only cover is shown beside it with the stock it excludes."},
    "weeks_on_hand":{"label":"On-hand cover (weeks)","semantic":"number","blank_reason":"Blank while any product type with stock has no measured demand in the last 12 months, so total cover cannot be computed. Measured-only cover is shown beside it with the stock it excludes."},
    "weeks_of_cover_measured":{"label":"Cover, measured types only (weeks)","semantic":"number"},
    "units_without_measured_demand":{"label":"Units excluded (no measured demand)","semantic":"count"},
    "types_without_measured_demand":{"label":"Types excluded","semantic":"count"},
    "product_type":{"label":"Product Type","semantic":"category","chart_dimension":true},
    "demand_status":{"label":"Demand","semantic":"category"},
    "units_12m":{"label":"Units Sold (12 complete months)","semantic":"count"},
    "units_per_week_12m":{"label":"Units per Week (12m)","semantic":"number"},
    "momentum_pct":{"label":"Momentum % (3m vs 12m)","semantic":"number"},
    "units_this_month":{"label":"Units Sold This Month","semantic":"count"},
    "sku_units_365d":{"label":"Its SKUs Sold, Any Type (365d)","semantic":"count"},
    "last_sold_date":{"label":"Last Sold","semantic":"date"},
    "image":{"label":"Image","semantic":"image"},
    "product_title":{"label":"Product","semantic":"category"},
    "variant_title":{"label":"Variant","semantic":"category"},
    "sku":{"label":"SKU","semantic":"category"},
    "next_arrival":{"label":"Next Arrival","semantic":"date"},
    "units_365d":{"label":"Units Sold (365d)","semantic":"count"},
    "units_90d":{"label":"Units Sold (90d)","semantic":"count"}
  }'::jsonb
where id = 'c1000000-0000-4000-a000-000000000001';

-- ── 4. Overstock: every high-cover type, trend as a column and a filter ───
-- It listed only types that were BOTH >= 52 weeks AND declining, which on
-- 2026-09-25 was one type (Boxers) out of sixteen with a year or more on
-- hand. Now: every type at or above `min_weeks` of on-hand cover, with the
-- trend shown, and `trend = declining` to narrow back. Incoming stays in
-- its own columns (on order, cover incl. incoming) so on-hand exposure is
-- never inflated by units not yet received. Types with stock and NO
-- measured demand have no cover to rank; Inventory Summary lists them.
update public.silo_chat_saved_reports set
  description = 'Product types with at least the chosen weeks of on-hand stock (default 52) at their 12-month sales rate. Trend compares the last 3 months with the last 12; choose Declining to see only types that are slowing or have had no sales for 3 months. Incoming stock is shown separately and is not counted in on-hand cover. Types with stock but no measured sales are listed in Inventory Summary.',
  queries_run = array[
$q$with coverage as (
  select *, case when units_12m > 0 then units_on_hand / (units_12m / 52.0) end as onhand_cover
    from demand_coverage_by_type_v
)
select product_type,
       case when coalesce(units_3m, 0) <= 0 then 'No sales in last 3 months'
            when momentum_pct < 0 then 'Declining'
            else 'Not declining' end as demand_trend,
       units_on_hand, round(onhand_cover, 1) as weeks_on_hand,
       units_per_week_12m, units_per_week_3m, momentum_pct,
       units_on_order, weeks_of_cover
  from coverage
 where units_on_hand > 0 and onhand_cover >= {{min_weeks}}
   and ({{trend}} = 'all' or coalesce(units_3m, 0) <= 0 or momentum_pct < 0)
 order by onhand_cover desc, product_type$q$],
  parameters = '[{"key":"min_weeks","type":"number","label":"Minimum weeks on hand","default":"52"},{"key":"trend","type":"enum","label":"Trend","default":"all","options":["all","declining"]}]'::jsonb,
  columns_metadata = '{
    "product_type":{"label":"Product Type","semantic":"category","chart_dimension":true},
    "demand_trend":{"label":"Trend","semantic":"category"},
    "units_on_hand":{"label":"On Hand","semantic":"count","chart_primary":true},
    "weeks_on_hand":{"label":"On-hand cover (weeks)","semantic":"number"},
    "units_per_week_12m":{"label":"Units per Week (12m)","semantic":"number"},
    "units_per_week_3m":{"label":"Units per Week (3m)","semantic":"number"},
    "momentum_pct":{"label":"Momentum % (3m vs 12m)","semantic":"number"},
    "units_on_order":{"label":"On Order (separate)","semantic":"count"},
    "weeks_of_cover":{"label":"Cover incl. incoming (weeks)","semantic":"number"}
  }'::jsonb
where id = 'c1000000-0000-4000-a000-000000000007';

-- ── 5. Tie-outs ───────────────────────────────────────────────────────────
-- Every check runs a report query with its own defaults and compares it
-- with a DIFFERENT route to the same number. The md5 guard makes any later
-- edit to a report read NO DATA until its checks are refreshed (the
-- 20260920075344 convention), which is why this migration replaces the
-- three edited reports' checks rather than leaving them to fail.
delete from public.silo_report_tieouts
 where report_id in ('c3000000-0000-4000-a000-000000000005', 'c3000000-0000-4000-a000-00000000000a',
                     'c1000000-0000-4000-a000-000000000001', 'c1000000-0000-4000-a000-000000000007');

do $checks$
declare
  from_sql constant text := '((select public.silo_business_today()) - 28)';
  to_sql constant text := '((select public.silo_business_today()) - 1)';
  co constant text := '(select public.active_company_id())';
  online_sql constant text := 'public.silo_channel_location_tags(''online'')';
  note constant text := 'Uses deployed default SQL. NO DATA can mean no source rows or a changed definition requiring a refreshed check; never a certification of completeness.';
  r record;
  q text[];
  guard text;
  n int;
begin
  for r in select * from public.silo_chat_saved_reports
            where id in ('c3000000-0000-4000-a000-000000000005', 'c3000000-0000-4000-a000-00000000000a',
                         'c1000000-0000-4000-a000-000000000001', 'c1000000-0000-4000-a000-000000000007') loop
    q := array[]::text[];
    for n in 1 .. coalesce(array_length(r.queries_run, 1), 0) loop
      q := q || replace(replace(replace(replace(replace(r.queries_run[n],
             '{{date_from}}', from_sql), '{{date_to}}', to_sql),
             '{{platform}}', '''all'''), '{{min_weeks}}', '52'), '{{trend}}', '''all''');
    end loop;
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);

    if r.id = 'c3000000-0000-4000-a000-000000000005' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Platform spend agrees with the marketing base table', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(spend) end as left_value, '
         || '(select round(sum(spend), 2) from public.marketing_kpis_daily where company_entity_id = %s and platform <> ''ga4'' '
         || 'and day_date between %s and %s) as right_value from report', q[1], guard, co, from_sql, to_sql),
       0.05, note || ' Each platform row is rounded to the cent.'),
      (r.id, 'Platform claims add up to the combined claim', 'sanity',
       format('with b as materialized (%s), s as materialized (%s) select case when %s then (select sum(platform_credited_revenue) from b) end as left_value, '
         || '(select platforms_claim from s) as right_value', q[1], q[2], guard),
       0.05, note),
      (r.id, 'Online net sales agree with the sales base table', 'reconciliation',
       format('with s as materialized (%s) select case when %s then (select online_net_sales from s) end as left_value, '
         || '(select round(sum(total_net_sales), 2) from public.sales_by_day where company_entity_id = %s '
         || 'and day_date between %s and %s and location_tag = any (%s)) as right_value', q[2], guard, co, from_sql, to_sql, online_sql),
       0.01, note);

    elsif r.id = 'c3000000-0000-4000-a000-00000000000a' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Ad-level spend agrees with campaign-level paid spend', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(spend) end as left_value, '
         || '(select round(sum(spend), 2) from public.marketing_kpis_daily where company_entity_id = %s and platform in (''meta_ads'', ''google_ads'') '
         || 'and day_date between %s and %s) as right_value from report', q[3], guard, co, from_sql, to_sql),
       1.00, note || ' Meta ad rows are summed from the ad-level table and compared with the campaign-level table, a second route; $1 allows per-row rounding.'),
      (r.id, 'Meta credited revenue agrees with the ad-level base table', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(platform_credited_revenue) filter (where platform = ''meta_ads'') end as left_value, '
         || '(select round(sum(conversion_value), 2) from public.meta_ad_performance_daily where company_entity_id = %s '
         || 'and day_date between %s and %s) as right_value from report', q[3], guard, co, from_sql, to_sql),
       1.00, note || ' Ad-level credited revenue can differ from Meta''s campaign-level figure; this compares like with like.'),
      (r.id, 'Campaign, ad, platform and daily views add to the same spend', 'sanity',
       format('with p as materialized (%s), c as materialized (%s), a as materialized (%s), d as materialized (%s) '
         || 'select case when %s and abs((select sum(spend) from c) - (select sum(spend) from a)) < 1 '
         || 'and abs((select sum(spend) from d) - (select sum(spend) from a)) < 1 then (select sum(spend) from p) end as left_value, '
         || '(select sum(spend) from a) as right_value', q[1], q[2], q[3], q[4], guard),
       1.00, note);

    elsif r.id = 'c1000000-0000-4000-a000-000000000001' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'On-hand units agree with live inventory', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(units_on_hand) end as left_value, '
         || '(select sum(total_available_quantity) from public.inventory_on_hand_current_v where company_entity_id = %s '
         || 'and nullif(product_type, '''') is not null) as right_value from report', q[1], guard, co),
       0, note),
      (r.id, 'Product-type rows add up to the total', 'sanity',
       format('with t as materialized (%s), b as materialized (%s) select case when %s '
         || 'and (select sum(units_on_order) from b) = (select units_on_order from t) then (select sum(units_on_hand) from b) end as left_value, '
         || '(select units_on_hand from t) as right_value', q[1], q[2], guard),
       0, note || ' On order must also agree, or the check reads NO DATA.'),
      (r.id, 'SKU on-hand agrees with live inventory', 'reconciliation',
       format('with s as materialized (%s) select case when %s then (select sum(units_on_hand) from s where product_type <> ''(no product type)'') end as left_value, '
         || '(select sum(total_available_quantity) from public.inventory_on_hand_current_v where company_entity_id = %s '
         || 'and nullif(product_type, '''') is not null and nullif(variant_sku, '''') is not null) as right_value', q[3], guard, co),
       0, note || ' Rows without a SKU cannot appear in a SKU list.'),
      (r.id, 'SKU on-order agrees with open PO lines', 'reconciliation',
       format('with s as materialized (%s) select case when %s then (select sum(units_on_order) from s) end as left_value, '
         || '(select sum(pl.qty) from public.po_lines pl join public.po_headers h on h.id = pl.po_header_id '
         || 'where pl.company_entity_id = %s and h.status in (''Confirmed'', ''Sent to Factory'', ''In Production'', ''In Transit'') '
         || 'and nullif(pl.sku_snapshot, '''') is not null) as right_value', q[3], guard, co),
       0, note);

    elsif r.id = 'c1000000-0000-4000-a000-000000000007' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'On-hand units agree with live inventory', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(units_on_hand) end as left_value, '
         || '(select sum(total_available_quantity) from public.inventory_on_hand_current_v where company_entity_id = %s '
         || 'and product_type in (select product_type from report)) as right_value from report', q[1], guard, co),
       0, note);
    end if;
  end loop;
end $checks$;
