-- Period-over-period units by product type, for the Top Sellers report.
--
-- The page reads inventory_workboard_v, which carries TRAILING windows only
-- (qty_7d / sold_30 / qty_90d / qty_365d) with no prior-period equivalent,
-- so a "% change" column cannot be derived from what the page already has.
-- Pulling raw rows client-side is not an option either: a 365-day window
-- needs three years of sales_by_day to compare against.
--
-- So the aggregation happens here, same reasoning as
-- sales_verification_filtered_summary -- ~36 rows back instead of a
-- multi-hundred-thousand row client scan.
--
-- Two comparisons, because they routinely disagree and only showing one is
-- how a report misleads. Measured live while writing this, 7-day window:
-- Youth was -33% against the prior week and +126% against the same week
-- last year. The first says the back-to-school surge is over; the second
-- says the category is far bigger than it was. Both true, and a reader
-- given only the first would conclude the wrong thing.
--
-- LAST YEAR IS 364 DAYS BACK, NOT 365 -- exactly 52 weeks, so the window
-- lands on the same weekdays. For retail a window that shifts a Saturday
-- in or out moves the number more than real demand does, and 365 does
-- exactly that.
--
-- Windows are COMPLETE days ending yesterday. Today is excluded because it
-- is partial and would drag every current-period figure down against two
-- full comparison windows.
--
-- SECURITY INVOKER on purpose: RLS on sales_by_day scopes every read to the
-- caller's active company, exactly as it does for the rest of the page.

create or replace function public.top_sellers_type_variance(
  p_days           int,
  p_location_tags  text[] default null
)
returns table (
  product_type   text,
  units_current  bigint,
  units_prev     bigint,
  units_ly       bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with p as (
    select
      greatest(coalesce(p_days, 30), 1)                          as days,
      current_date - greatest(coalesce(p_days, 30), 1)           as cur_start,
      current_date - 1                                           as cur_end
  )
  select
    s.product_type,
    coalesce(sum(s.total_quantity_sold)
      filter (where s.day_date between p.cur_start and p.cur_end), 0)::bigint,
    coalesce(sum(s.total_quantity_sold)
      filter (where s.day_date between p.cur_start - p.days and p.cur_end - p.days), 0)::bigint,
    coalesce(sum(s.total_quantity_sold)
      filter (where s.day_date between p.cur_start - 364 and p.cur_end - 364), 0)::bigint
  from public.sales_by_day s
  cross join p
  where s.day_date >= p.cur_start - 364 - p.days
    and s.day_date <= p.cur_end
    and s.product_type is not null
    and (p_location_tags is null or s.location_tag = any (p_location_tags))
  group by s.product_type
  having coalesce(sum(s.total_quantity_sold)
           filter (where s.day_date between p.cur_start and p.cur_end), 0) > 0;
$$;

revoke all on function public.top_sellers_type_variance(int, text[]) from public, anon;
grant execute on function public.top_sellers_type_variance(int, text[]) to authenticated;

comment on function public.top_sellers_type_variance(int, text[]) is
  'Units by product type for three windows: the trailing p_days complete days ending yesterday, the p_days before that, and the same window 364 days back (52 weeks, so weekdays align -- not 365). Optional p_location_tags filters to a store group. SECURITY INVOKER, so RLS scopes it to the caller''s active company. Returns only types that sold something in the current window.';
