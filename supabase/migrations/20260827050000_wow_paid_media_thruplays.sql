-- Surfaces thruplays / leads through wow_paid_media, so the Thruplays and
-- Subscribers tables show the denominator each objective is actually judged
-- on instead of only spend and clicks.
--
-- Definition below is pg_get_functiondef output from prod on 2026-08-27, so
-- this file and the running function cannot drift.
--
-- Note 'not_synced' is now COMPUTED from the window rather than a fixed list:
-- once a sync has landed thruplays, the page stops telling the reader to open
-- Ads Manager for a number that is already on screen.

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
         case when k.platform='meta_ads' then public.meta_campaign_group(k.campaign_name) else 'google' end as grp,
         coalesce(sum(k.spend)            filter (where k.day_date between (select s from w) and (select e from w)),0) as spend,
         coalesce(sum(k.conversion_value) filter (where k.day_date between (select s from w) and (select e from w)),0) as rev,
         coalesce(sum(k.conversions)      filter (where k.day_date between (select s from w) and (select e from w)),0) as conv,
         coalesce(sum(k.clicks)           filter (where k.day_date between (select s from w) and (select e from w)),0) as clicks,
         coalesce(sum(k.impressions)      filter (where k.day_date between (select s from w) and (select e from w)),0) as impr,
         -- No coalesce: null must survive as null so "not reported" stays
         -- distinguishable from "reported zero".
         sum(k.thruplays) filter (where k.day_date between (select s from w) and (select e from w)) as thruplays,
         sum(k.leads)     filter (where k.day_date between (select s from w) and (select e from w)) as leads,
         coalesce(sum(k.spend)            filter (where k.day_date between (select ps from w) and (select pe from w)),0) as prev_spend,
         coalesce(sum(k.conversion_value) filter (where k.day_date between (select ps from w) and (select pe from w)),0) as prev_rev
  from public.marketing_kpis_daily k cross join w
  where k.platform in ('meta_ads','google_ads')
    and k.company_entity_id = public.active_company_id()
    and k.day_date between (select ps from w) and (select e from w)
  group by 1,2,3
),
camp as (
  select platform, grp, campaign_name, spend, rev, conv, clicks, impr, thruplays, leads, prev_spend, prev_rev,
         -- Ratios per campaign are derived from that campaign's own totals.
         case when spend > 0 then round((rev/spend)::numeric,2) end          as roas,
         case when conv > 0 then round((spend/conv)::numeric,2) end          as cost_per_conv,
         case when clicks > 0 then round((spend/clicks)::numeric,2) end      as cost_per_click,
         case when thruplays > 0 then round((spend/thruplays)::numeric,4) end as cost_per_thruplay,
         case when leads > 0 then round((spend/leads)::numeric,2) end         as cost_per_lead
  from mk
  where spend > 0 or prev_spend > 0
),
grp_roll as (
  select platform, grp,
         sum(spend) spend, sum(rev) rev, sum(conv) conv, sum(clicks) clicks, sum(impr) impr,
         sum(thruplays) thruplays, sum(leads) leads,
         sum(prev_spend) prev_spend, sum(prev_rev) prev_rev,
         -- Group ratios recomputed from group totals, never averaged from the
         -- per-campaign ratios above.
         case when sum(spend) > 0  then round((sum(rev)/sum(spend))::numeric,2) end   as roas,
         case when sum(conv) > 0   then round((sum(spend)/sum(conv))::numeric,2) end  as cost_per_conv,
         case when sum(clicks) > 0 then round((sum(spend)/sum(clicks))::numeric,2) end as cost_per_click,
         case when sum(thruplays) > 0 then round((sum(spend)/sum(thruplays))::numeric,4) end as cost_per_thruplay,
         case when sum(leads) > 0 then round((sum(spend)/sum(leads))::numeric,2) end   as cost_per_lead,
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
               'thruplays', g.thruplays, 'cost_per_thruplay', g.cost_per_thruplay,
               'leads', g.leads, 'cost_per_lead', g.cost_per_lead,
               'prev_spend', round(g.prev_spend::numeric,0), 'prev_roas', g.prev_roas,
               'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
                     'campaign', c.campaign_name, 'spend', round(c.spend::numeric,0),
                     'revenue', round(c.rev::numeric,0), 'roas', c.roas,
                     'conversions', round(c.conv::numeric,0), 'cost_per_conv', c.cost_per_conv,
                     'clicks', c.clicks, 'cost_per_click', c.cost_per_click,
                     'impressions', c.impr,
                     'thruplays', c.thruplays, 'cost_per_thruplay', c.cost_per_thruplay,
                     'leads', c.leads, 'cost_per_lead', c.cost_per_lead,
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
  'not_synced', (select coalesce(jsonb_agg(m), '[]'::jsonb) from (
      select 'thruplays' as m where not exists (
        select 1 from camp where grp='thruplay' and thruplays is not null)
      union all
      select 'leads' where not exists (
        select 1 from camp where grp='subscribers' and leads is not null)) ns)
);
$$;

grant execute on function public.meta_campaign_group(text) to authenticated;
grant execute on function public.wow_paid_media(date) to authenticated;

