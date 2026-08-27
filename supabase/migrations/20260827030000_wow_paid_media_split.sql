-- Paid media split for /v2/wow-report.html: Meta by campaign objective,
-- Google on its own.
--
-- Why: a single blended table with one ROAS column misreads awareness buys as
-- failures. A Thruplay campaign has no attributed revenue BY DESIGN, so it
-- shows 0.00x next to a purchase campaign's 1.98x and looks broken. Meta's
-- objectives are judged on different denominators -- purchase on ROAS,
-- thruplay on cost per thruplay, subscriber on cost per lead -- so they need
-- to be separate tables, not separate rows.

-- Campaign -> objective group, by name. Meta's API objective is not stored on
-- marketing_kpis_daily, so name is what we have. Order matters: 'Brand
-- Promotion - Upper Funnel' must land on thruplay before any broader rule
-- claims it. Anything unmatched lands in 'other' and is RENDERED, never
-- dropped -- a silently vanishing campaign is worse than an unclassified one.
-- Verified 2026-08-27 against all 8 Meta campaigns active in the last 60 days:
-- every one classifies, none falls through to 'other'. Re-run that check after
-- editing these patterns:
--   select public.meta_campaign_group(campaign_name), campaign_name
--   from marketing_kpis_daily where platform='meta_ads'
--     and day_date > current_date - 60 group by 1,2;
create or replace function public.meta_campaign_group(p_name text)
returns text language sql immutable as $$
  select case
    when coalesce(p_name,'') ~* '(thru.?play|video.?view|upper.?funnel|awareness|brand.?promotion)' then 'thruplay'
    when coalesce(p_name,'') ~* '(subscriber|follower|sign.?up|opt.?in|\msms\M|email|activation|\mlead)' then 'subscribers'
    when coalesce(p_name,'') ~* '(traffic|landing.?page|link.?click|\mlpv\M|page.?view)'              then 'traffic'
    when coalesce(p_name,'') ~* '(purchase|conversion|\msale|catalog|dpa|retarget|prospect|advantage)' then 'purchase'
    else 'other'
  end;
$$;

create or replace function public.wow_paid_media(p_report_date date)
returns jsonb
language sql
stable
as $$
with w as (
  select p_report_date as e, p_report_date - 6 as s,
         p_report_date - 7 as pe, p_report_date - 13 as ps
),
mk as (
  select k.platform,
         k.campaign_name,
         case when k.platform = 'meta_ads'
              then public.meta_campaign_group(k.campaign_name)
              else 'google' end as grp,
         coalesce(sum(k.spend)            filter (where k.day_date between (select s from w) and (select e from w)),0) as spend,
         coalesce(sum(k.conversion_value) filter (where k.day_date between (select s from w) and (select e from w)),0) as rev,
         coalesce(sum(k.conversions)      filter (where k.day_date between (select s from w) and (select e from w)),0) as conv,
         coalesce(sum(k.clicks)           filter (where k.day_date between (select s from w) and (select e from w)),0) as clicks,
         coalesce(sum(k.impressions)      filter (where k.day_date between (select s from w) and (select e from w)),0) as impr,
         coalesce(sum(k.spend)            filter (where k.day_date between (select ps from w) and (select pe from w)),0) as prev_spend,
         coalesce(sum(k.conversion_value) filter (where k.day_date between (select ps from w) and (select pe from w)),0) as prev_rev
  from public.marketing_kpis_daily k cross join w
  where k.platform in ('meta_ads','google_ads')
    and k.company_entity_id = public.active_company_id()
    and k.day_date between (select ps from w) and (select e from w)
  group by 1,2,3
),
camp as (
  select platform, grp, campaign_name, spend, rev, conv, clicks, impr, prev_spend, prev_rev,
         -- Ratios per campaign are derived from that campaign's own totals.
         case when spend > 0 then round((rev/spend)::numeric,2) end          as roas,
         case when conv > 0 then round((spend/conv)::numeric,2) end          as cost_per_conv,
         case when clicks > 0 then round((spend/clicks)::numeric,2) end      as cost_per_click
  from mk
  where spend > 0 or prev_spend > 0
),
grp_roll as (
  select platform, grp,
         sum(spend) spend, sum(rev) rev, sum(conv) conv, sum(clicks) clicks, sum(impr) impr,
         sum(prev_spend) prev_spend, sum(prev_rev) prev_rev,
         -- Group ratios recomputed from group totals, never averaged from the
         -- per-campaign ratios above.
         case when sum(spend) > 0  then round((sum(rev)/sum(spend))::numeric,2) end   as roas,
         case when sum(conv) > 0   then round((sum(spend)/sum(conv))::numeric,2) end  as cost_per_conv,
         case when sum(clicks) > 0 then round((sum(spend)/sum(clicks))::numeric,2) end as cost_per_click,
         case when sum(prev_spend) > 0 then round((sum(prev_rev)/sum(prev_spend))::numeric,2) end as prev_roas
  from camp group by 1,2
)
select jsonb_build_object(
  'report_date', p_report_date,
  'window', (select jsonb_build_object('start', w.s, 'end', w.e, 'prev_start', w.ps, 'prev_end', w.pe) from w),

  'meta', (select coalesce(jsonb_agg(x order by ord, sp desc),'[]'::jsonb) from (
      select jsonb_build_object(
               'group', g.grp,
               'label', case g.grp when 'purchase' then 'Purchase campaigns'
                                   when 'thruplay' then 'Thruplays / upper funnel'
                                   when 'subscribers' then 'Subscribers'
                                   when 'traffic' then 'Traffic / landing page views'
                                   else 'Other / unclassified' end,
               -- Which denominator this objective is judged on. The page uses
               -- this to pick columns rather than hardcoding a ROAS column
               -- onto campaigns that cannot have one.
               'judged_on', case g.grp when 'purchase' then 'roas'
                                       when 'thruplay' then 'cost_per_thruplay'
                                       when 'subscribers' then 'cost_per_lead'
                                       when 'traffic' then 'cost_per_click'
                                       else 'spend' end,
               'spend', round(g.spend::numeric,0), 'revenue', round(g.rev::numeric,0),
               'roas', g.roas, 'conversions', round(g.conv::numeric,0),
               'cost_per_conv', g.cost_per_conv, 'clicks', g.clicks, 'impressions', g.impr,
               'cost_per_click', g.cost_per_click,
               'prev_spend', round(g.prev_spend::numeric,0), 'prev_roas', g.prev_roas,
               'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
                     'campaign', c.campaign_name, 'spend', round(c.spend::numeric,0),
                     'revenue', round(c.rev::numeric,0), 'roas', c.roas,
                     'conversions', round(c.conv::numeric,0), 'cost_per_conv', c.cost_per_conv,
                     'clicks', c.clicks, 'cost_per_click', c.cost_per_click,
                     'impressions', c.impr,
                     'prev_spend', round(c.prev_spend::numeric,0)) order by c.spend desc),'[]'::jsonb)
                  from camp c where c.platform='meta_ads' and c.grp=g.grp)
             ) x,
             case g.grp when 'purchase' then 1 when 'thruplay' then 2
                        when 'subscribers' then 3 when 'traffic' then 4 else 5 end ord,
             g.spend sp
      from grp_roll g where g.platform='meta_ads') mg),

  'google', (select jsonb_build_object(
      'spend', round(coalesce(sum(g.spend),0)::numeric,0),
      'revenue', round(coalesce(sum(g.rev),0)::numeric,0),
      'roas', case when sum(g.spend) > 0 then round((sum(g.rev)/sum(g.spend))::numeric,2) end,
      'conversions', round(coalesce(sum(g.conv),0)::numeric,0),
      'cost_per_conv', case when sum(g.conv) > 0 then round((sum(g.spend)/sum(g.conv))::numeric,2) end,
      'clicks', coalesce(sum(g.clicks),0),
      'prev_spend', round(coalesce(sum(g.prev_spend),0)::numeric,0),
      'prev_roas', case when sum(g.prev_spend) > 0 then round((sum(g.prev_rev)/sum(g.prev_spend))::numeric,2) end,
      'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
            'campaign', c.campaign_name, 'spend', round(c.spend::numeric,0),
            'revenue', round(c.rev::numeric,0), 'roas', c.roas,
            'conversions', round(c.conv::numeric,0), 'cost_per_conv', c.cost_per_conv,
            'clicks', c.clicks, 'cost_per_click', c.cost_per_click,
            'prev_spend', round(c.prev_spend::numeric,0)) order by c.spend desc),'[]'::jsonb)
         from camp c where c.platform='google_ads')
    ) from grp_roll g where g.platform='google_ads'),

  -- Top creatives, scoped to purchase campaigns: a creative is ranked here on
  -- ROAS, which only means anything where revenue is attributed.
  'creatives', (select coalesce(jsonb_agg(x order by sp desc),'[]'::jsonb) from (
      select jsonb_build_object('ad', p.ad_name, 'campaign', max(p.campaign_name),
               'spend', round(sum(p.spend)::numeric,0),
               'revenue', round(sum(p.conversion_value)::numeric,0),
               'roas', case when sum(p.spend) > 0
                            then round((sum(p.conversion_value)/sum(p.spend))::numeric,2) end,
               'conversions', round(sum(p.conversions)::numeric,0),
               'clicks', sum(p.clicks),
               'thumb', max(c.thumbnail_url)) x, sum(p.spend) sp
      from public.meta_ad_performance_daily p
      left join public.meta_ad_creatives c
        on c.ad_id = p.ad_id and c.company_entity_id = p.company_entity_id
      cross join w
      where p.day_date between (select s from w) and (select e from w)
        and p.company_entity_id = public.active_company_id()
        and public.meta_campaign_group(p.campaign_name) = 'purchase'
      group by p.ad_name having sum(p.spend) > 0
      order by sp desc limit 10) cr),

  -- Stated, not silently omitted: these two are what Sammie currently pulls
  -- from Ads Manager by hand. They are not in marketing_kpis_daily, so the
  -- page must say so rather than render an empty column that reads as zero.
  'not_synced', jsonb_build_array('thruplays', 'leads')
);
$$;

grant execute on function public.meta_campaign_group(text) to authenticated;
grant execute on function public.wow_paid_media(date) to authenticated;
