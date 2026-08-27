-- The last day online sales are COMPLETE for.
--
-- The report defaulted to today, but the Shopify sync runs at 08:30 UTC and
-- only covers up to its own run time -- so "today" and usually "yesterday"
-- are partial. Measured 2026-08-27: 8/26 held $403 of gross against ~$38k on
-- a normal day, so a report dated today understated the week by about two
-- days, roughly 25%.
--
-- That is precisely the discrepancy that cost an evening earlier ("I show
-- 259 in total sales, the report shows 193k"), and it would have happened
-- live in a demo. A partial day is not visibly wrong -- it just quietly
-- lowers every total, and a partial week reads as a bad week.
--
-- Rule: the sync stamps synced_at when it runs, and covers everything before
-- that run. So the last COMPLETE day is the day before the most recent sync.
create or replace function public.wow_data_through()
returns jsonb
language sql
stable
as $$
with s as (
  select max(synced_at)::date as last_sync,
         max(day_date) as last_day_present
  from public.sales_by_day
  where company_entity_id = public.active_company_id()
    and location_tag = 'online'
)
select jsonb_build_object(
  'last_sync_date', (select last_sync from s),
  'last_day_present', (select last_day_present from s),
  -- Never returns a date the sync could not have finished.
  'complete_through', (select least(last_sync - 1, last_day_present) from s)
) from s;
$$;

grant execute on function public.wow_data_through() to authenticated;
