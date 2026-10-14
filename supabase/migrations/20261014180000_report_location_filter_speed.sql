-- Report location filter: make the choices readable inside the browser's
-- 8 second statement timeout.
--
-- THE BUG. 20261014080000 built `silo_report_locations_v` as the catalog
-- union a fallback that scans `sales_by_day` for the tags a company has
-- actually sold under, excluding companies that keep a `locations` catalog
-- with `not exists`. That exclusion is logically right and operationally
-- wrong: the planner has to READ a row before it can tell which company it
-- belongs to, so the anti-join scans the whole table even for a company
-- whose catalog makes the branch produce nothing. Measured on production
-- 2026-10-14 as Blake (an authenticated member of Baseballism):
--
--   1,189,919 rows scanned, 16,271 ms   -- `authenticated` is capped at 8s
--
-- so every dashboard carrying a location slicer got
-- `canceling statement due to statement timeout`, dashboard.html swallowed
-- it by design (a dropdown must not take the page down) and the control sat
-- at "All locations / Nothing to choose from yet". The 62ms in the original
-- migration's header was measured for one small client, not for the scan
-- this plan actually performs.
--
-- THE FIX, same rows, different shape. Drive the fallback from `entities`
-- (17 rows) instead of from `sales_by_day` (1.19M), and reach the sales
-- table through a LATERAL keyed on the company. Now the catalog test is
-- answered per COMPANY, before any sales row is touched, so a company with
-- a catalog never scans at all -- under RLS the planner even folds the
-- branch to a one-time filter. Measured the same way:
--
--   0 rows scanned, 15 ms
--
-- and as service role, across every company, 2,677 ms -> 86 ms. The row set
-- is unchanged: 33 rows both ways, `except all` empty in both directions.
--
-- Every company that has sales also exists in `entities` (verified: 5 of 5),
-- and `entities` carries a select policy for members, so a client of a
-- catalog-less workspace still sees its own observed tags. This remains
-- security_invoker with no company filter of its own: RLS on `entities`,
-- `locations` and `sales_by_day` is still the tenant boundary.

create or replace view public.silo_report_locations_v with (security_invoker = true) as
with catalog as (
  select l.company_entity_id,
         public.silo_location_slug(l.location_code) as location_tag,
         min(coalesce(nullif(btrim(l.location_name), ''), l.location_code)) as label
    from public.locations l
   where l.is_active
     and public.silo_location_slug(l.location_code) is not null
   group by 1, 2
),
observed as (
  -- One row per company FIRST, so the catalog test costs nothing, then the
  -- sales scan only for a company that has no catalog at all.
  select e.id as company_entity_id, t.location_tag
    from public.entities e
    cross join lateral (
      select distinct s.location_tag
        from public.sales_by_day s
       where s.company_entity_id = e.id
         and s.location_tag is not null
    ) t
   -- A company that maintains `locations` gets its own names and its own
   -- idea of what is current, including a location it has closed and
   -- deliberately kept.
   where not exists (select 1 from catalog c where c.company_entity_id = e.id)
)
select company_entity_id, location_tag, label from catalog
union all
select company_entity_id, location_tag,
       -- No catalog row, so the slug is all there is. Make it readable
       -- rather than showing shopify_state_forty_eight in a dropdown.
       initcap(replace(location_tag, '_', ' ')) as label
  from observed;

revoke all on public.silo_report_locations_v from anon;
grant select on public.silo_report_locations_v to authenticated, service_role;

comment on view public.silo_report_locations_v is
  'Per-company location choices for a report location slicer. location_tag is the value a query '
  'filters on; label is for display. security_invoker: RLS on entities / locations / sales_by_day is '
  'the tenant boundary. Prefers the locations catalog and falls back to observed sales tags only for '
  'a company with no catalog rows. The fallback is driven from entities through a LATERAL so a '
  'company with a catalog never scans sales_by_day: scanning it cost 16s under RLS and the browser '
  'is capped at 8s.';

select public.refresh_chat_schema_catalog();
