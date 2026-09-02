-- Ad-level creative performance for Week over Week, grouped by objective.
--
-- The report's "Top creatives" card was a flat top-10 by spend across purchase
-- campaigns only. Sammie asked for something different: EVERY ad that spent in
-- the period, ordered by spend, grouped under its campaign objective --
-- Purchases, Thruplays, Subscribers, Followers -- with ad name, ad set, copy,
-- spend, ROAS, CPA and the change against the prior period, ten at a time.
--
-- A SEPARATE FUNCTION, not more surgery on wow_paid_media. That one is
-- campaign-level and ~130 lines that five migrations have now patched in
-- place; this is a different grain from a different table
-- (meta_ad_performance_daily, not marketing_kpis_daily) and bolting it on
-- would mean editing that text a sixth time for no shared logic. The two agree
-- on grouping because both call meta_campaign_group().
--
-- "LIVE ADS THAT SPENT" IS SPEND > 0, NOT effective_status. Status is the ad's
-- state right now -- ACTIVE, PAUSED, ARCHIVED, ADSET_PAUSED, CAMPAIGN_PAUSED,
-- DISAPPROVED, WITH_ISSUES. Filtering on it would drop every ad that ran
-- during the window and has since been paused, which is most of what a
-- retrospective week wants to show, and would quietly shrink last week's
-- numbers as ads are turned off. Spending in the window IS having been live in
-- the window.
--
-- CPA is spend / conversions -- for the purchase group that is purchase CPA,
-- which is what was asked for. It is null, never 0, when there are no
-- conversions: an ad that spent and converted nobody has no cost per
-- acquisition, and printing 0 would rank it as the cheapest.
--
-- COPY IS WHAT META GIVES US, AND WE SAY WHICH. The ask was Meta's
-- best-performing copy. That is not in this database: the sync requests
-- creative{id,thumbnail_url,body,title,object_type} and Dynamic Creative ads
-- keep their variants in asset_feed_spec, with the winner only available
-- through a per-asset insights breakdown -- neither is fetched (the sync says
-- so itself: "creative ads may carry copy in asset feeds rather than
-- body/title; we store whatever the creative exposes"). Measured on the week
-- to 2026-08-31: 57 ads spent, 57 matched a creative, 57 had a thumbnail, and
-- only 20 had body copy. So copy_source comes back beside copy -- 'body',
-- 'title' or null -- and the page prints "not synced" rather than an empty
-- cell, because a blank reads as "this ad had no copy" when the truth is "we
-- did not fetch it". Getting the other 37 means adding asset_feed_spec to the
-- creative fetch; that is a sync change, not a reporting one.
--
-- ad_id is unique in meta_ad_creatives (4,008 rows, 4,008 distinct ads,
-- verified), so the join cannot fan out and no aggregate is needed to tame it.

create or replace function public.wow_creatives(
  p_report_date date,
  p_grain       text default 'week',
  p_limit       int  default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
with w as (select * from public.wow_window(p_report_date, p_grain)),
perf as (
  select p.ad_id,
         max(p.ad_name)       as ad_name,
         max(p.adset_name)    as adset_name,
         max(p.campaign_name) as campaign_name,
         public.meta_campaign_group(max(p.campaign_name)) as grp,
         coalesce(sum(p.spend)            filter (where p.day_date between (select s from w)  and (select e from w)),0)  as spend,
         coalesce(sum(p.conversion_value) filter (where p.day_date between (select s from w)  and (select e from w)),0)  as rev,
         coalesce(sum(p.conversions)      filter (where p.day_date between (select s from w)  and (select e from w)),0)  as conv,
         coalesce(sum(p.clicks)           filter (where p.day_date between (select s from w)  and (select e from w)),0)  as clicks,
         coalesce(sum(p.impressions)      filter (where p.day_date between (select s from w)  and (select e from w)),0)  as impr,
         coalesce(sum(p.spend)            filter (where p.day_date between (select ps from w) and (select pe from w)),0) as prev_spend,
         coalesce(sum(p.conversion_value) filter (where p.day_date between (select ps from w) and (select pe from w)),0) as prev_rev
  from public.meta_ad_performance_daily p cross join w
  where p.day_date between w.ps and w.e
  group by p.ad_id
),
ads as (
  select f.*,
         c.body, c.title, c.thumbnail_url, c.effective_status,
         case when nullif(btrim(coalesce(c.body,'')),'')  is not null then 'body'
              when nullif(btrim(coalesce(c.title,'')),'') is not null then 'title' end as copy_source,
         coalesce(nullif(btrim(coalesce(c.body,'')),''), nullif(btrim(coalesce(c.title,'')),'')) as copy
  from perf f
  left join public.meta_ad_creatives c on c.ad_id = f.ad_id
  -- The window's ads are the ones that SPENT in the window. An ad with only
  -- prior-period spend is carried through perf so its prev_spend can be
  -- compared, but it is not an ad of this period and is dropped here.
  where f.spend > 0
),
grp_roll as (
  select grp,
         sum(spend) spend, sum(rev) rev, sum(conv) conv, sum(clicks) clicks,
         sum(prev_spend) prev_spend, sum(prev_rev) prev_rev, count(*) ads_total
  from ads group by grp
)
select jsonb_build_object(
  'window', (select jsonb_build_object('start', w.s, 'end', w.e,
                    'prev_start', w.ps, 'prev_end', w.pe) from w),
  'limit_per_group', greatest(p_limit, 1),
  'groups', (select coalesce(jsonb_agg(x order by ord, sp desc), '[]'::jsonb) from (
    select jsonb_build_object(
        'group', g.grp,
        -- Same vocabulary as wow_paid_media's campaign view, so a reader
        -- moving between the two cards sees one set of objective names.
        'label', case g.grp when 'purchase'    then 'Purchase campaigns'
                            when 'thruplay'    then 'Thruplays / upper funnel'
                            when 'subscribers' then 'Subscribers'
                            when 'followers'   then 'Followers'
                            when 'traffic'     then 'Traffic / landing page views'
                            else 'Other / unclassified' end,
        'judged_on', case g.grp when 'purchase' then 'roas' else 'spend' end,
        'ads_total', g.ads_total,
        'spend', round(g.spend::numeric,0),
        'revenue', round(g.rev::numeric,0),
        'conversions', round(g.conv::numeric,0),
        'roas', case when g.spend > 0 then round((g.rev/g.spend)::numeric,2) end,
        'cpa',  case when g.conv  > 0 then round((g.spend/g.conv)::numeric,2) end,
        'prev_spend', round(g.prev_spend::numeric,0),
        'spend_wow', case when g.prev_spend > 0
                          then round(100.0*(g.spend - g.prev_spend)/g.prev_spend,1) end,
        'ads', (select coalesce(jsonb_agg(jsonb_build_object(
                   'ad_id', a.ad_id, 'ad', a.ad_name, 'adset', a.adset_name,
                   'campaign', a.campaign_name,
                   'copy', left(a.copy, 400), 'copy_source', a.copy_source,
                   'thumb', a.thumbnail_url, 'status', a.effective_status,
                   'spend', round(a.spend::numeric,0),
                   'revenue', round(a.rev::numeric,0),
                   'conversions', round(a.conv::numeric,0),
                   'clicks', a.clicks, 'impressions', a.impr,
                   'roas', case when a.spend > 0 then round((a.rev/a.spend)::numeric,2) end,
                   -- Null, not zero: an ad that converted nobody has no cost
                   -- per acquisition, and 0 would sort it as the cheapest.
                   'cpa',  case when a.conv  > 0 then round((a.spend/a.conv)::numeric,2) end,
                   'prev_spend', round(a.prev_spend::numeric,0),
                   -- Null when the ad did not run last period. "New this
                   -- period" and "flat" are different answers.
                   'spend_wow', case when a.prev_spend > 0
                                     then round(100.0*(a.spend - a.prev_spend)/a.prev_spend,1) end,
                   'is_new', a.prev_spend = 0)
                 order by a.spend desc), '[]'::jsonb)
               from (select * from ads a2 where a2.grp = g.grp
                     order by a2.spend desc limit greatest(p_limit,1)) a)
      ) x,
      case g.grp when 'purchase' then 1 when 'thruplay' then 2
                 when 'subscribers' then 3 when 'followers' then 4
                 when 'traffic' then 5 else 6 end ord,
      g.spend sp
    from grp_roll g) t)
);
$fn$;

revoke all on function public.wow_creatives(date, text, int) from public, anon;
grant execute on function public.wow_creatives(date, text, int) to authenticated;

comment on function public.wow_creatives(date, text, int) is
  'Week over Week ad-level creatives: every Meta ad that SPENT in the window (spend > 0, not effective_status -- status is current state and would drop ads that ran then paused), grouped by campaign objective via meta_campaign_group, ordered by spend, with ad name, ad set, copy, spend, ROAS, CPA and the change against the prior period. CPA is spend/conversions and is null rather than 0 when nothing converted. copy_source says whether the copy came from the creative body or the title, and is null when neither is synced -- Meta''s best-performing Dynamic Creative copy lives in asset_feed_spec, which the sync does not fetch. SECURITY INVOKER: RLS scopes it to the caller''s active company.';
