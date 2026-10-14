-- Report location filter: the choices a location slicer offers.
--
-- A SILO (source = 'system') report is global and read-only to every client,
-- so its location choices cannot be a list written into the report. Each
-- company has its own locations: Baseballism has 14 live sales tags, and the
-- three Shopify-only clients have one each, named after their store.
--
-- So the report declares the parameter and this view supplies the choices,
-- per company, at render time. It is security_invoker, so RLS on the two
-- source tables is the tenant boundary and no explicit company filter is
-- needed or wanted here.
--
-- WHY TWO SOURCES, preferring `locations`:
--   `locations` is the catalog a person maintains, with real names
--   ("St. Louis", not "st_louis"). It is also the fast one: Baseballism's 28
--   rows read instantly, where a DISTINCT over its 1.19M `sales_by_day` rows
--   measured 1.23s on production -- too much to spend on every dashboard
--   load for a dropdown.
--   But it is NOT complete. Measured on production 2026-10-14: three client
--   companies (Süti, State Forty Eight, HH Outfitter) have sales under a
--   location tag with no `locations` row at all, so a picker fed only from
--   the catalog would be empty for them. Their fallback scan is
--   company-scoped and measured 62ms.
--   Hence: use the catalog when the company has one, fall back to the tags
--   actually present in its sales when it does not. For Baseballism the
--   catalog covers all 19 observed tags (0 unmatched), so the fallback
--   changes nothing there.
--
-- `location_tag` in the sales tables is the SLUG of `locations.location_code`
-- (lower case, non-alphanumerics collapsed to underscore), which is exactly
-- what silo_location_slug() computes -- the catalog stores "St. Louis" and
-- "Mission Viejo" while the sales rows carry st_louis and mission_viejo. The
-- view emits the slug as the VALUE (what a query filters on) and the human
-- name as the LABEL (what the dropdown shows). Never the other way round.

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
  select s.company_entity_id, s.location_tag
    from public.sales_by_day s
   where s.location_tag is not null
     -- Only for a company with no catalog at all. A company that maintains
     -- `locations` gets its own names and its own idea of what is current,
     -- including a location it has closed and deliberately kept.
     and not exists (select 1 from catalog c where c.company_entity_id = s.company_entity_id)
   group by 1, 2
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
  'filters on; label is for display. security_invoker: RLS on locations / sales_by_day is the '
  'tenant boundary. Prefers the locations catalog and falls back to observed sales tags only for '
  'a company with no catalog rows.';

-- Ask SILO's schema map must learn the new view.
select public.refresh_chat_schema_catalog();
