-- Top landing pages for the WoW report, replacing a manual table.
--
-- Conversion rate is recomputed per page from that page's own totals over the
-- window -- never averaged across days, same rule as everywhere else here.
--
-- Only the online store has landing pages; POS shops have none, so this is
-- scoped by the same company filter and simply returns nothing for them.
create or replace function public.wow_landing_pages(p_report_date date, p_limit int default 15)
returns jsonb
language sql
stable
as $$
with w as (
  select p_report_date as e, p_report_date - 6 as s,
         p_report_date - 7 as pe, p_report_date - 13 as ps
),
agg as (
  select l.landing_page_path as path,
         coalesce(sum(l.sessions) filter (where l.day_date between (select s from w) and (select e from w)),0) as sessions,
         coalesce(sum(l.sessions_that_completed_checkout) filter (where l.day_date between (select s from w) and (select e from w)),0) as orders,
         coalesce(sum(l.sessions_with_cart_additions) filter (where l.day_date between (select s from w) and (select e from w)),0) as carts,
         coalesce(sum(l.sessions) filter (where l.day_date between (select ps from w) and (select pe from w)),0) as prev_sessions
  from public.shopify_landing_pages_daily l cross join w
  where l.company_entity_id = public.active_company_id()
    and l.day_date between (select ps from w) and (select e from w)
  group by 1
)
select jsonb_build_object(
  'report_date', p_report_date,
  -- Recorded so the page can say the list is a top slice, not the whole tail.
  'truncated_days', (select count(*) from public.shopify_landing_pages_daily l cross join w
                     where l.company_entity_id = public.active_company_id()
                       and l.day_date between (select s from w) and (select e from w)
                       and l.is_truncated),
  'days_covered', (select count(distinct l.day_date) from public.shopify_landing_pages_daily l cross join w
                   where l.company_entity_id = public.active_company_id()
                     and l.day_date between (select s from w) and (select e from w)),
  'pages', (select coalesce(jsonb_agg(x order by sv desc),'[]'::jsonb) from (
      select jsonb_build_object(
               'path', a.path,
               'sessions', a.sessions,
               'carts', a.carts,
               'orders', a.orders,
               'conversion_rate', case when a.sessions > 0
                    then round(100.0 * a.orders / a.sessions, 2) end,
               'cart_rate', case when a.sessions > 0
                    then round(100.0 * a.carts / a.sessions, 2) end,
               'prev_sessions', a.prev_sessions,
               'sessions_wow', case when a.prev_sessions > 0
                    then round(100.0 * (a.sessions - a.prev_sessions) / a.prev_sessions, 1) end
             ) x, a.sessions sv
      from agg a where a.sessions > 0
      order by a.sessions desc limit greatest(coalesce(p_limit, 15), 1)) lp)
);
$$;

grant execute on function public.wow_landing_pages(date, int) to authenticated;
