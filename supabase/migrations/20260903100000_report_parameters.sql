-- v3 dashboards, pass 3: report parameters (dashboard slicers).
--
-- ── The problem ───────────────────────────────────────────────────────
-- Every saved report so far bakes its window into its SQL: `where day_date
-- >= current_date - 27`. That is why the Week over Week DASHBOARD is frozen
-- at week grain while the Week over Week PAGE has a Day/Week/MTD/YTD
-- switch -- the page passes a grain into wow_window(), and a saved report
-- had no way to be passed anything. Nine tiles built on nine frozen
-- queries is a screenshot, not a report.
--
-- A parameter is the missing half: the report DECLARES what it needs, the
-- dashboard SUPPLIES it, and the runner substitutes before executing.
--
--   report.parameters   [{ key, type, label, default, options? }, ...]
--   dashboard.filter_state  { "grain": "week", "report_date": "2026-09-01" }
--   report SQL          select * from wow_kpi_compare({{report_date}}, {{grain}})
--
-- Matching is BY KEY ACROSS REPORTS, which is the whole point: nine reports
-- that each declare `report_date` get one control in the dashboard header,
-- not nine.
--
-- ── Substitution is typed, never string interpolation ─────────────────
-- chat_run_readonly_query is SECURITY INVOKER, so a caller can only ever
-- read what their own RLS already allows -- pasting arbitrary SQL through a
-- parameter could not read another company's rows. But it could still
-- rewrite the report into a question nobody asked, and "the blast radius is
-- small" is a bad reason to build an injection point. So v3/js/report-
-- params.js turns a value into a SQL LITERAL by type and never by
-- concatenation:
--
--   number  Number() + isFinite, emitted as digits -- unforgeable
--   date    matched against YYYY-MM-DD (or a relative token) and emitted
--           as `date '2026-09-01'`
--   enum    must be === one of the declared options, or it is rejected
--   text    single-quoted with quotes doubled
--
-- and a {{token}} in the SQL that no parameter declares is an ERROR, not a
-- passthrough. The declaration is the allowlist.
--
-- ── Why the shape is not stricter in the database ─────────────────────
-- `parameters` is jsonb with a CHECK only on being an array. The validation
-- that matters is type-directed and happens where the substitution happens;
-- a CONSTRAINT enumerating parameter types would have to be migrated every
-- time a type is added, and would still not stop a bad default. Same stance
-- as visual_config being schemaless: this describes a UI contract, not a
-- data invariant.

-- ── silo_chat_saved_reports.parameters ────────────────────────────────
alter table public.silo_chat_saved_reports
  add column if not exists parameters jsonb;

alter table public.silo_chat_saved_reports
  drop constraint if exists silo_chat_saved_reports_parameters_is_array;
alter table public.silo_chat_saved_reports
  add constraint silo_chat_saved_reports_parameters_is_array
  check (parameters is null or jsonb_typeof(parameters) = 'array');

comment on column public.silo_chat_saved_reports.parameters is
  'Declared parameters for this report''s SQL, as [{key,type,label,default,options?}]. A {{key}} token in queries_run is substituted with a TYPE-VALIDATED literal before the query runs; an undeclared token is an error. Null means the report takes no parameters and runs exactly as stored.';

-- ── dashboards.filter_state ───────────────────────────────────────────
-- A flat key -> value map, not per-widget. A tile quietly on a different
-- date range than the header claims makes "what am I looking at" an
-- unanswerable question, which defeats the point of a slicer -- so the
-- dashboard holds one value per key and every widget declaring that key
-- gets it. Per-widget overrides are deliberately NOT modelled here; adding
-- them later means a new column, not reinterpreting this one.
alter table public.dashboards
  add column if not exists filter_state jsonb not null default '{}'::jsonb;

alter table public.dashboards
  drop constraint if exists dashboards_filter_state_is_object;
alter table public.dashboards
  add constraint dashboards_filter_state_is_object
  check (jsonb_typeof(filter_state) = 'object');

comment on column public.dashboards.filter_state is
  'Saved parameter values for this dashboard''s slicers, keyed by parameter key. The dashboard''s default position; a VIEWER changing a slicer changes it for their session only, and only an editor''s Save writes it back here.';

-- ── views ─────────────────────────────────────────────────────────────
-- `drop view` + `create view`, not `create or replace view`: Postgres can
-- only APPEND columns to an existing view, and these v3 migrations each
-- reshape the same views in sequence inside apply_all_post_merge.sql. A
-- plain replace breaks a fresh rebuild at the second migration. See the
-- same note in 20260828120000 and 20260828140000.
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
  r.parameters,
  r.created_at,
  r.updated_at
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;

-- report_parameters travels with query_sql so the renderer can substitute
-- without a second round trip per widget. Same security_invoker caveat as
-- query_sql: someone else's private report yields nulls, and the tile says
-- so rather than rendering an unparameterised query by accident.
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
  r.parameters       as report_parameters,
  r.queries_run[w.query_index + 1] as query_sql,
  coalesce(array_length(r.queries_run, 1), 0) as report_query_count
from public.dashboard_widgets w
left join public.silo_chat_saved_reports r on r.id = w.report_id;

revoke all on public.dashboard_widgets_v from anon;
grant select on public.dashboard_widgets_v to authenticated;

drop view if exists public.dashboards_v;
create view public.dashboards_v
with (security_invoker = true) as
select
  d.id,
  d.company_entity_id,
  d.created_by,
  p.name as created_by_name,
  d.name,
  d.description,
  d.visibility,
  d.filter_state,
  d.created_at,
  d.updated_at,
  (select count(*) from public.dashboard_widgets w where w.dashboard_id = d.id) as widget_count
from public.dashboards d
left join public.profiles p on p.id = d.created_by;

revoke all on public.dashboards_v from anon;
grant select on public.dashboards_v to authenticated;
