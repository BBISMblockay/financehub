-- Carry each ad's destination through to the Week over Week creative card,
-- and reconcile this function with what production is actually running.
--
-- TWO THINGS ARE HAPPENING HERE AND THE SECOND ONE IS THE DANGEROUS ONE.
--
-- 1. The creative card gains 'link' / 'link_source' / 'link_path' per ad, so
--    a reader can see where an ad sent the click, not only what it looked
--    like. That is the ask.
--
-- 2. The deployed wow_creatives is AHEAD OF THIS REPO and no migration file
--    contains the difference. 20260901170000 is the only create-or-replace
--    for it here, and the version running in production additionally
--    computes thruplays, leads, cost_per_thruplay and cost_per_lead at both
--    the group and the ad grain -- which /v2/wow-report.html reads by name
--    (g.cost_per_lead, g.cost_per_thruplay, a.thruplays). The deployed body
--    also has every explanatory comment stripped, so it was applied by hand
--    from an edited copy rather than from this directory.
--
--    Writing this migration from the repo's file plus the new link columns
--    would therefore have DELETED a shipped feature: the Thruplays and
--    Subscribers groups would have gone back to "spend only" headlines and
--    the per-ad thruplay columns would have become null, with nothing in the
--    diff to show it. The body below is reconstructed from
--    pg_get_functiondef() against production on 2026-09-15, with this repo's
--    original comments restored, plus the link fields.
--
--    Same family as notify_slack_sample_created() and notify_sample_events()
--    in docs/ops/bugs.md: functions live in the database, and the migration
--    directory is not proof of what is running. Recorded there too.
--
-- 'link_source' travels with 'link' for the same reason link_url_source
-- exists on the table: the last-resort source (effective_object_url) may be
-- the Facebook post rather than the advertiser's site on a page-post ad, and
-- 63% of this account's creatives are that type. The page shows the HOST so
-- the reader can see which they are looking at.
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
         -- NOT coalesced to 0, unlike the five above: an ad that did not
         -- report the metric has not scored zero on it.
         sum(p.thruplays)                 filter (where p.day_date between (select s from w)  and (select e from w))     as thruplays,
         sum(p.leads)                     filter (where p.day_date between (select s from w)  and (select e from w))     as leads,
         coalesce(sum(p.spend)            filter (where p.day_date between (select ps from w) and (select pe from w)),0) as prev_spend,
         coalesce(sum(p.conversion_value) filter (where p.day_date between (select ps from w) and (select pe from w)),0) as prev_rev
  from public.meta_ad_performance_daily p cross join w
  where p.day_date between w.ps and w.e
  group by p.ad_id
),
ads as (
  select f.*,
         c.body, c.title, c.thumbnail_url, c.effective_status,
         c.link_url, c.link_url_source, c.link_path,
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
         sum(thruplays) thruplays, sum(leads) leads,
         sum(spend) spend, sum(rev) rev, sum(conv) conv, sum(clicks) clicks,
         sum(prev_spend) prev_spend, sum(prev_rev) prev_rev, count(*) ads_total,
         -- How many of this group's ads resolved a destination at all.
         -- Reported so the card can say "8 of 20 ads have a destination"
         -- rather than leaving twelve blank cells that read as twelve ads
         -- going nowhere.
         count(*) filter (where link_url is not null) ads_with_link
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
        'ads_with_link', g.ads_with_link,
        'spend', round(g.spend::numeric,0),
        'revenue', round(g.rev::numeric,0),
        'conversions', round(g.conv::numeric,0),
        'roas', case when g.spend > 0 then round((g.rev/g.spend)::numeric,2) end,
        'cpa',  case when g.conv  > 0 then round((g.spend/g.conv)::numeric,2) end,
        'thruplays', g.thruplays, 'leads', g.leads,
        'cost_per_thruplay', case when coalesce(g.thruplays,0) > 0
             then round((g.spend/g.thruplays)::numeric,4) end,
        'cost_per_lead', case when coalesce(g.leads,0) > 0
             then round((g.spend/g.leads)::numeric,2) end,
        'prev_spend', round(g.prev_spend::numeric,0),
        'spend_wow', case when g.prev_spend > 0
                          then round(100.0*(g.spend - g.prev_spend)/g.prev_spend,1) end,
        'ads', (select coalesce(jsonb_agg(jsonb_build_object(
                   'ad_id', a.ad_id, 'ad', a.ad_name, 'adset', a.adset_name,
                   'campaign', a.campaign_name,
                   'copy', left(a.copy, 400), 'copy_source', a.copy_source,
                   'thumb', a.thumbnail_url, 'status', a.effective_status,
                   -- Destination. link_source travels with it, always: the
                   -- page decides what it may call a landing page from the
                   -- source, not from the URL alone.
                   'link', a.link_url, 'link_source', a.link_url_source,
                   'link_path', a.link_path,
                   'spend', round(a.spend::numeric,0),
                   'revenue', round(a.rev::numeric,0),
                   'conversions', round(a.conv::numeric,0),
                   'clicks', a.clicks, 'impressions', a.impr,
                   'roas', case when a.spend > 0 then round((a.rev/a.spend)::numeric,2) end,
                   -- Null, not zero: an ad that converted nobody has no cost
                   -- per acquisition, and 0 would sort it as the cheapest.
                   'cpa',  case when a.conv  > 0 then round((a.spend/a.conv)::numeric,2) end,
                   'thruplays', a.thruplays, 'leads', a.leads,
                   'cost_per_thruplay', case when coalesce(a.thruplays,0) > 0
                        then round((a.spend/a.thruplays)::numeric,4) end,
                   'cost_per_lead', case when coalesce(a.leads,0) > 0
                        then round((a.spend/a.leads)::numeric,2) end,
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
  'Week over Week ad-level creatives: every Meta ad that SPENT in the window (spend > 0, not effective_status -- status is current state and would drop ads that ran then paused), grouped by campaign objective via meta_campaign_group, ordered by spend, with ad name, ad set, copy, destination, spend, ROAS, CPA, thruplays/leads and the change against the prior period. CPA is spend/conversions and is null rather than 0 when nothing converted; thruplays/leads are null when the ad did not report them. copy_source says whether the copy came from the creative body or the title. link/link_source/link_path are the ad''s destination -- read link_source before calling it a landing page, since effective_object_url may be the Facebook post on a page-post ad; ads_with_link per group says how many resolved one, so blanks read as unresolved rather than as ads going nowhere. SECURITY INVOKER: RLS scopes it to the caller''s active company.';
