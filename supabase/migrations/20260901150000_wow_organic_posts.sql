-- Organic posts in the Week over Week report, from the data SILO already has.
--
-- The report carried a MANUAL table -- "Meta & Instagram organic — last 12
-- posts", twelve blank rows, hinted "Type these in. Fills in automatically
-- once Meta access is granted." That access was granted: the ad-platforms sync
-- has been filling instagram_media_insights since 2026-05-21 and Marketing
-- Overview has rendered it on its Organic tab the whole time. Somebody has
-- been retyping, into the weekly report, numbers that were already in the
-- database.
--
-- Ranked by VIEWS, and the ranking metric is named on the card rather than
-- left implied. Views, reach and engagement do not agree about which post won
-- -- the same trap already documented on launch_product_sales_v, where the top
-- product by units was not the top by sell-through and got reported wrong once.
--
-- ENGAGEMENT is likes + comments + shares + saved. engagement_rate divides it
-- by REACH (people), never by views (plays, which one person can run up), and
-- is null rather than 0 when reach is 0, because "nobody saw it" and "everyone
-- who saw it ignored it" are different findings.
--
-- COVERAGE IS RETURNED, NOT ASSUMED. instagram_media_insights begins
-- 2026-05-21, so a YTD window asks for January and gets May onward. That is
-- not a small discrepancy on a year -- it is most of the year missing -- and
-- an organic total that quietly starts in May while every sales figure beside
-- it starts on Jan 1 is exactly the kind of number that gets read aloud in a
-- meeting. history_starts comes back on every call and the page marks the
-- window partial whenever it begins before that date.
--
-- thumbnail_url is null for IMAGE and CAROUSEL_ALBUM -- Meta only returns one
-- for video (verified: 0 of 138 videos null, 35 of 35 images and 32 of 32
-- carousels null). That is the API's shape, not a sync bug, so the page draws
-- a placeholder rather than a broken image and nobody goes looking for a fault
-- that is not there.

create or replace function public.wow_organic_posts(
  p_report_date date,
  p_grain       text default 'week',
  p_limit       int  default 12
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
with w as (select * from public.wow_window(p_report_date, p_grain)),
src as (
  select i.media_id, i.media_type, i.caption, i.permalink, i.thumbnail_url,
         i.posted_at, i.posted_at::date as posted_on,
         coalesce(i.views,0)    as views,
         coalesce(i.reach,0)    as reach,
         coalesce(i.likes,0)    as likes,
         coalesce(i.comments,0) as comments,
         coalesce(i.shares,0)   as shares,
         coalesce(i.saved,0)    as saved,
         coalesce(i.likes,0) + coalesce(i.comments,0)
           + coalesce(i.shares,0) + coalesce(i.saved,0) as engagement
  from public.instagram_media_insights i cross join w
  -- Widest span any bucket below needs, read once.
  where i.posted_at::date between least(w.lys, w.ps) and w.e
),
cur  as (select * from src cross join w where posted_on between w.s   and w.e),
prev as (select * from src cross join w where posted_on between w.ps  and w.pe),
ly   as (select * from src cross join w where posted_on between w.lys and w.lye),
agg as (
  select
    (select count(*) from cur) c_posts, (select count(*) from prev) p_posts, (select count(*) from ly) l_posts,
    (select coalesce(sum(views),0)      from cur) c_views,
    (select coalesce(sum(views),0)      from prev) p_views,
    (select coalesce(sum(views),0)      from ly)   l_views,
    (select coalesce(sum(reach),0)      from cur) c_reach,
    (select coalesce(sum(reach),0)      from prev) p_reach,
    (select coalesce(sum(reach),0)      from ly)   l_reach,
    (select coalesce(sum(engagement),0) from cur) c_eng,
    (select coalesce(sum(engagement),0) from prev) p_eng,
    (select coalesce(sum(engagement),0) from ly)   l_eng
)
-- A percent change against an empty base is null, never 0 -- "nothing posted
-- last period" and "flat" must not render alike. Same rule as wow_kpi_compare.
select jsonb_build_object(
  'window', (select jsonb_build_object('start', w.s, 'end', w.e, 'prev_start', w.ps,
                    'prev_end', w.pe, 'ly_start', w.lys, 'ly_end', w.lye) from w),
  'history_starts', (select min(posted_at)::date from public.instagram_media_insights),
  'ranked_by', 'views',
  'totals', (select jsonb_build_object(
      'posts', jsonb_build_object('cur', c_posts, 'prev', p_posts, 'ly', l_posts,
        'wow', case when p_posts > 0 then round(100.0*(c_posts - p_posts)::numeric/p_posts,1) end,
        'yoy', case when l_posts > 0 then round(100.0*(c_posts - l_posts)::numeric/l_posts,1) end),
      'views', jsonb_build_object('cur', c_views, 'prev', p_views, 'ly', l_views,
        'wow', case when p_views > 0 then round(100.0*(c_views - p_views)::numeric/p_views,1) end,
        'yoy', case when l_views > 0 then round(100.0*(c_views - l_views)::numeric/l_views,1) end),
      'reach', jsonb_build_object('cur', c_reach, 'prev', p_reach, 'ly', l_reach,
        'wow', case when p_reach > 0 then round(100.0*(c_reach - p_reach)::numeric/p_reach,1) end,
        'yoy', case when l_reach > 0 then round(100.0*(c_reach - l_reach)::numeric/l_reach,1) end),
      'engagement', jsonb_build_object('cur', c_eng, 'prev', p_eng, 'ly', l_eng,
        'wow', case when p_eng > 0 then round(100.0*(c_eng - p_eng)::numeric/p_eng,1) end,
        'yoy', case when l_eng > 0 then round(100.0*(c_eng - l_eng)::numeric/l_eng,1) end)
    ) from agg),
  'by_type', (select coalesce(jsonb_agg(x order by v desc), '[]'::jsonb) from (
      select jsonb_build_object('media_type', media_type, 'posts', count(*),
               'views', sum(views), 'reach', sum(reach), 'engagement', sum(engagement)) x,
             sum(views) v
      from cur group by media_type) t),
  'posts', (select coalesce(jsonb_agg(x order by v desc), '[]'::jsonb) from (
      select jsonb_build_object(
               'media_id', media_id, 'media_type', media_type,
               'caption', left(coalesce(caption,''), 180),
               'permalink', permalink, 'thumb', thumbnail_url,
               'posted_on', posted_on,
               'views', views, 'reach', reach, 'likes', likes, 'comments', comments,
               'shares', shares, 'saved', saved, 'engagement', engagement,
               'engagement_rate', case when reach > 0
                                       then round(100.0*engagement::numeric/reach, 2) end) x,
             views v
      from cur order by views desc limit greatest(p_limit, 1)) t)
);
$fn$;

revoke all on function public.wow_organic_posts(date, text, int) from public, anon;
grant execute on function public.wow_organic_posts(date, text, int) to authenticated;

comment on function public.wow_organic_posts(date, text, int) is
  'Week over Week organic social: Instagram posts in the window with views/reach/engagement, ranked by views, plus period totals against the prior period and last year. Engagement is likes+comments+shares+saved and engagement_rate divides it by REACH, not views, and is null when reach is 0. Returns history_starts because instagram_media_insights begins 2026-05-21 -- a YTD window asks for January and gets May onward, and the page marks it partial rather than printing a confident short total. SECURITY INVOKER: RLS scopes it to the caller''s active company.';
