-- v3 dashboards, pass 2: semantic column typing.
--
-- ── Why columns_metadata ──────────────────────────────────────────────
-- The v3 renderer decides how to print a number by looking at its column
-- NAME, and a name is a guess. The first build shipped with `total_units`
-- formatting as currency because "total" is a money word -- a wrong number
-- on a dashboard, not a cosmetic slip. Decoupling the dataset from the
-- visual is what makes that class of bug possible at all: once one saved
-- report can be drawn five ways, nothing in the drawing code knows what
-- the values MEAN.
--
-- So the meaning has to travel with the report, not be re-guessed per
-- widget. columns_metadata is that carrier:
--
--   {"net_sales":  {"semantic": "currency"},
--    "units":      {"semantic": "count"},
--    "day_date":   {"semantic": "date"},
--    "conversion_rate": {"semantic": "percent"}}
--
-- Nullable, and every reader falls back to inference when a column is
-- absent from it, so nothing breaks on the ~50 reports saved before this
-- existed. It is on silo_chat_saved_reports rather than on
-- dashboard_widgets deliberately: the semantics of `net_sales` belong to
-- the report, and correcting them once should fix every widget and every
-- future widget built on it. Per-widget DISPLAY overrides stay in
-- dashboard_widgets.visual_config.value_format -- a different thing
-- ("show this one as a plain number here"), not a different meaning.
--
-- Populated three ways, in ascending order of authority: v3 seeds it from
-- profiling + silo_chat_schema_catalog the first time a widget is built on
-- a report; a human corrects a field in the widget inspector; Ask SILO can
-- write it at save time once the edge function is taught to (not yet -- the
-- column exists so that work is additive rather than a migration away).
alter table public.silo_chat_saved_reports
  add column if not exists columns_metadata jsonb;

comment on column public.silo_chat_saved_reports.columns_metadata is
  'Semantic type per result column, e.g. {"net_sales":{"semantic":"currency"},"units":{"semantic":"count"}}. Null/absent means "infer" -- readers must fall back, never assume. Belongs to the report, so a correction fixes every widget built on it.';

-- Anyone who can update the report can update its semantics: the existing
-- silo_chat_saved_reports_update policy (creator or exec/owner, company
-- rows only) already covers it, so no new policy. A SYSTEM definition's
-- metadata stays service-role-only for the same reason its SQL does --
-- that boundary is set in 20260828130000 and this migration does not
-- widen it.

-- ── Views ─────────────────────────────────────────────────────────────
-- Rebuilt to carry columns_metadata alongside the source/description added
-- in 20260828130000. Kept in one place rather than patched twice: a view is
-- replaced wholesale, so the full column list has to be restated anyway.
-- `drop view` + `create view`, not `create or replace view`: Postgres can
-- only APPEND columns to an existing view, so replacing one whose column
-- list changed shape fails with "cannot change name of view column". These
-- three v3 migrations each reshape the same views, and
-- apply_all_post_merge.sql runs all of them in sequence -- so a plain
-- replace breaks a fresh rebuild at the second migration, and breaks a
-- re-run of apply_all at the first. Nothing depends on these views, so the
-- drop is safe and no cascade is needed.
drop view if exists public.silo_chat_saved_reports_v;
create view public.silo_chat_saved_reports_v
with (security_invoker = true) as
select
  r.id,
  r.company_entity_id,
  r.created_by,
  p.name as created_by_name,
  r.source,
  r.title,
  r.description,
  r.question,
  r.answer,
  r.queries_run,
  r.visibility,
  r.columns_metadata,
  r.created_at,
  r.updated_at
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;

-- The renderer gets a widget, its SQL, and the semantics of its columns in
-- one round trip. Same security_invoker caveat as query_sql: a report that
-- is private to someone else yields nulls here, and the tile says so.
drop view if exists public.dashboard_widgets_v;
create view public.dashboard_widgets_v
with (security_invoker = true) as
select
  w.id,
  w.dashboard_id,
  w.company_entity_id,
  w.created_by,
  w.report_id,
  w.query_index,
  w.title,
  w.visual_type,
  w.visual_config,
  w.layout,
  w.sort_order,
  w.created_at,
  w.updated_at,
  r.title       as report_title,
  r.question    as report_question,
  r.description as report_description,
  r.source      as report_source,
  r.visibility  as report_visibility,
  r.columns_metadata as report_columns_metadata,
  r.queries_run[w.query_index + 1] as query_sql,
  coalesce(array_length(r.queries_run, 1), 0) as report_query_count
from public.dashboard_widgets w
left join public.silo_chat_saved_reports r on r.id = w.report_id;

revoke all on public.dashboard_widgets_v from anon;
grant select on public.dashboard_widgets_v to authenticated;
