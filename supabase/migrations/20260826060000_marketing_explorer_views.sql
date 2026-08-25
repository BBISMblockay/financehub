-- Marketing Explorer: a defined measure layer over the ad-platform data.
--
-- Why views rather than aggregating everywhere in page JS: ratio metrics
-- (ROAS, CPA, CTR, CPM, MER) are the only marketing numbers anyone acts on,
-- and they are the ones a naive rollup gets WRONG. Summing or averaging a
-- ratio across campaigns/days produces a plausible-looking number that is
-- not the ratio. Every ratio here is computed as sum(numerator) /
-- nullif(sum(denominator),0) at the grain being reported, never rolled up
-- from a lower grain. Anything reading these views -- the Explorer page,
-- Ask SILO, the product-concept loop -- inherits that correctness instead
-- of re-deriving it (and re-breaking it) per caller.
--
-- All three are security_invoker so RLS on marketing_kpis_daily /
-- meta_ad_performance_daily keeps enforcing company_entity_id =
-- active_company_id(), exactly as it does for the base tables.
--
-- Units: spend and conversion_value are DOLLARS. The sync divides Google's
-- cost_micros by 1e6 and passes Meta's decimal spend through
-- (scripts/lib/ad-platforms-sync-core.mjs). Do not re-scale.

-- ── 1. Day-grain fact view ────────────────────────────────────────────
-- One row per platform x account x campaign x day. The base for any
-- date-filtered marketing question.
create or replace view public.marketing_facts_daily_v as
select
  k.company_entity_id,
  k.platform,
  case k.platform
    when 'google_ads' then 'Google Ads'
    when 'meta_ads'   then 'Meta Ads'
    when 'tiktok_ads' then 'TikTok Ads'
    when 'ga4'        then 'GA4'
    else k.platform
  end                                            as platform_label,
  (k.platform <> 'ga4')                          as is_paid,
  k.account_id,
  k.account_name,
  k.day_date,
  k.campaign_id,
  coalesce(nullif(trim(k.campaign_name), ''), '(no campaign)') as campaign_name,
  k.impressions,
  k.clicks,
  k.spend,
  k.conversions,
  k.conversion_value,
  k.sessions,
  k.view_content,
  k.add_to_cart,
  k.initiate_checkout,
  k.source
from public.marketing_kpis_daily k;

alter view public.marketing_facts_daily_v set (security_invoker = true);

comment on view public.marketing_facts_daily_v is
  'Day-grain marketing facts per platform x account x campaign. Spend and conversion_value are DOLLARS. is_paid excludes GA4 -- GA4 carries no spend and its "conversions" column counts GA4 key events (page/scroll/etc.), NOT orders, so never sum GA4 conversions as purchases or include GA4 in a CPA. Funnel columns (view_content/add_to_cart/initiate_checkout) are populated for Meta only; sessions for GA4 only.';

-- ── 2. Per-campaign rollup with correct ratios ────────────────────────
create or replace view public.marketing_campaign_summary_v as
select
  f.company_entity_id,
  f.platform,
  f.platform_label,
  f.is_paid,
  f.account_name,
  f.campaign_id,
  f.campaign_name,
  min(f.day_date)                                    as first_day,
  max(f.day_date)                                    as last_day,
  count(distinct f.day_date)                         as active_days,
  sum(f.impressions)                                 as impressions,
  sum(f.clicks)                                      as clicks,
  sum(f.spend)                                       as spend,
  sum(f.conversions)                                 as conversions,
  sum(f.conversion_value)                            as conversion_value,
  -- Ratios: computed from the summed components at THIS grain.
  round(sum(f.conversion_value) / nullif(sum(f.spend), 0), 4)          as roas,
  round(sum(f.spend) / nullif(sum(f.conversions), 0), 4)               as cpa,
  round(sum(f.spend) / nullif(sum(f.clicks), 0), 4)                    as cpc,
  round(sum(f.clicks)::numeric / nullif(sum(f.impressions), 0), 6)     as ctr,
  round(1000 * sum(f.spend) / nullif(sum(f.impressions), 0), 4)        as cpm,
  -- An awareness campaign legitimately returns ~no attributed revenue, so
  -- a near-zero ROAS there is a campaign OBJECTIVE signal, not a failure.
  -- Flagged rather than hidden so a reader does not average it into a
  -- portfolio ROAS and conclude the account is underperforming.
  (sum(f.spend) > 0 and coalesce(sum(f.conversion_value), 0) < sum(f.spend) * 0.1)
                                                     as looks_upper_funnel
from public.marketing_facts_daily_v f
group by 1,2,3,4,5,6,7;

alter view public.marketing_campaign_summary_v set (security_invoker = true);

comment on view public.marketing_campaign_summary_v is
  'One row per platform x campaign over all time, with ROAS/CPA/CPC/CTR/CPM computed from summed components (never averaged from day rows). Filter marketing_facts_daily_v instead when you need a date-bounded rollup. looks_upper_funnel marks campaigns whose attributed revenue is under 10% of spend -- typically awareness/traffic objectives where ROAS is not the goal.';

-- ── 3. Blended daily totals (the MER line) ────────────────────────────
create or replace view public.marketing_daily_totals_v as
with paid as (
  select company_entity_id, day_date,
         sum(spend)             as ad_spend,
         sum(impressions)       as impressions,
         sum(clicks)            as clicks,
         sum(conversions)       as platform_conversions,
         sum(conversion_value)  as platform_conversion_value
  from public.marketing_facts_daily_v
  where is_paid
  group by 1,2
),
ga as (
  select company_entity_id, day_date,
         sum(sessions)          as sessions,
         sum(conversion_value)  as ga4_revenue
  from public.marketing_facts_daily_v
  where platform = 'ga4'
  group by 1,2
)
select
  coalesce(p.company_entity_id, g.company_entity_id) as company_entity_id,
  coalesce(p.day_date, g.day_date)                   as day_date,
  coalesce(p.ad_spend, 0)                            as ad_spend,
  coalesce(p.impressions, 0)                         as impressions,
  coalesce(p.clicks, 0)                              as clicks,
  coalesce(p.platform_conversions, 0)                as platform_conversions,
  coalesce(p.platform_conversion_value, 0)           as platform_conversion_value,
  g.sessions,
  g.ga4_revenue,
  round(coalesce(p.platform_conversion_value, 0) / nullif(p.ad_spend, 0), 4) as blended_roas,
  round(coalesce(p.ad_spend, 0) / nullif(p.platform_conversions, 0), 4)      as blended_cpa
from paid p
full outer join ga g
  on g.company_entity_id = p.company_entity_id
 and g.day_date = p.day_date;

alter view public.marketing_daily_totals_v set (security_invoker = true);

comment on view public.marketing_daily_totals_v is
  'One row per day: paid spend/impressions/clicks/platform-attributed conversions and value, plus GA4 sessions and site revenue. blended_roas is PLATFORM-attributed (each network claiming its own conversions, so it double-counts across networks). For true MER against Shopify ledger revenue use v_marketing_mer_daily, which divides online net sales by ad spend.';

-- ── 4. Meta ad-level detail with creative ─────────────────────────────
-- Meta is the only platform with sub-campaign depth in the warehouse;
-- Google and TikTok stop at campaign until the sync pulls ad-group rows.
create or replace view public.meta_ad_performance_v as
select
  p.company_entity_id,
  p.day_date,
  p.account_id,
  p.campaign_id,
  p.campaign_name,
  p.adset_id,
  p.adset_name,
  p.ad_id,
  p.ad_name,
  p.impressions,
  p.clicks,
  p.spend,
  p.conversions,
  p.conversion_value,
  p.view_content,
  p.add_to_cart,
  p.initiate_checkout,
  c.thumbnail_url,
  c.title        as creative_title,
  c.body         as creative_body,
  c.object_type  as creative_type,
  c.effective_status
from public.meta_ad_performance_daily p
left join public.meta_ad_creatives c
  on c.ad_id = p.ad_id
 and c.company_entity_id = p.company_entity_id;

alter view public.meta_ad_performance_v set (security_invoker = true);

comment on view public.meta_ad_performance_v is
  'Meta ad-level daily performance joined to creative metadata (thumbnail/title/body). Coverage starts only when ad-level sync was switched on -- far shorter than the campaign-level history in marketing_kpis_daily. Check min(day_date) before drawing period comparisons.';

-- ── 5. Teach Ask SILO what these are ──────────────────────────────────
-- refresh_chat_schema_catalog() auto-discovers columns but leaves
-- description/keywords empty for a new object, so the model has no reason
-- to pick these over the raw tables. Curated meaning belongs in the
-- catalog, never hand-typed into the edge function's prompt.
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  description = case relname
    when 'marketing_facts_daily_v' then 'Day-grain paid marketing facts per platform x account x campaign (Google Ads, Meta Ads, GA4). Spend and conversion_value are DOLLARS. Use is_paid to exclude GA4: GA4 has no spend and its conversions column counts key events, not orders. Start here for any date-bounded marketing question.'
    when 'marketing_campaign_summary_v' then 'One row per platform x campaign, all time, with ROAS/CPA/CPC/CTR/CPM already computed correctly from summed components. Use for "which campaigns performed best". looks_upper_funnel flags awareness campaigns where near-zero ROAS is the objective, not a failure.'
    when 'marketing_daily_totals_v' then 'One row per day: total paid ad spend, impressions, clicks, platform-attributed conversions and value, plus GA4 sessions and site revenue. Use for spend trend over time. For true MER against Shopify ledger revenue use v_marketing_mer_daily instead.'
    when 'meta_ad_performance_v' then 'Meta ad-level daily performance joined to creative metadata (thumbnail, headline, body). The only sub-campaign depth in the warehouse -- Google and TikTok stop at campaign. Coverage is much shorter than campaign history; check min(day_date) first.'
    else description end,
  keywords = case relname
    when 'marketing_facts_daily_v' then array['marketing','ad spend','advertising','campaign','roas','paid media','google ads','meta','facebook','instagram','daily']
    when 'marketing_campaign_summary_v' then array['campaign performance','roas','cpa','ctr','cpm','best campaigns','worst campaigns','ad efficiency','upper funnel','awareness']
    when 'marketing_daily_totals_v' then array['ad spend trend','daily spend','mer','marketing efficiency','sessions','blended roas']
    when 'meta_ad_performance_v' then array['creative','ad level','adset','meta ads','facebook ads','best ads','thumbnail','ad copy']
    else keywords end
where relname in ('marketing_facts_daily_v','marketing_campaign_summary_v',
                  'marketing_daily_totals_v','meta_ad_performance_v');
