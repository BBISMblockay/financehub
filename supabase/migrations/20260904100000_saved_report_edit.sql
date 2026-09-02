-- v3 reports: make a saved report EDITABLE.
--
-- Until now the workbench was create-only. That is the cause of library rot,
-- not a missing convenience: a typo'd title, a column that should be labelled
-- `Net Sales`, a hardcoded date that should be a parameter -- none of them
-- could be corrected, so the only way to fix a report was to save a second
-- one and leave the first in the shared list. Twenty-two shared reports with
-- three near-duplicates among them is what that produces at one user. At
-- twenty-nine it is unmanageable, and the duplicates belong to other people.
--
-- No policy changes. `silo_chat_saved_reports_update` already says exactly
-- the right thing -- creator or exec/owner, same company, and a WITH CHECK
-- that pins `source` to ask_silo/manual so an edit can never promote a report
-- to a global `system` definition, and `company_entity_id IS NOT NULL` so a
-- global one can never be edited at all. The page rides that policy; it does
-- not widen it.

-- ── 1. Reopening a guided report GUIDED ──────────────────────────────
-- Saving stored only the generated SQL, so a report built with dimensions,
-- measures and filters could only ever be reopened as a wall of SQL -- which
-- means the guided builder is a one-way door and the second edit of any
-- report is a SQL edit. The config that produced the SQL is the report's own
-- fact, so it belongs on the report.
--
-- Nullable, and every reader must cope with null: an Ask SILO save and a
-- hand-written SQL report have no guided config and never will. Null means
-- "open this on the SQL tab", not "something is missing".
--
-- Deliberately NOT the source of truth for what runs. `queries_run` stays
-- that. If the two ever disagree -- someone edits the SQL by hand after
-- building it guided -- the SQL is what executes and the builder config is
-- stale scaffolding, so the page drops it rather than silently regenerating
-- SQL nobody asked for.
alter table public.silo_chat_saved_reports
  add column if not exists builder_config jsonb;

comment on column public.silo_chat_saved_reports.builder_config is
  'How a guided report was built: {relname, cfg} from /v3/report-builder.html, so it reopens guided rather than as raw SQL. Null for Ask SILO saves and hand-written SQL -- null means "edit this as SQL", not "incomplete". queries_run remains the only thing that RUNS; this is scaffolding, and is dropped when the SQL is edited by hand.';

-- ── 2. What an edit will break ───────────────────────────────────────
-- Editing a shared report changes every tile built on it. That IS the point
-- -- one correction fixes every widget -- and it is also the danger: drop a
-- column from the select list and nine tiles across four dashboards go blank,
-- with nothing to connect the blank tile to the edit that caused it.
--
-- So the editor states the blast radius before saving. It cannot do that from
-- the browser: dashboard_widgets RLS scopes reads to dashboards the CALLER
-- can see, so a widget on a colleague's private dashboard is invisible -- and
-- an undercount is worse than no count, because it reads as safety.
-- SECURITY DEFINER, with the tenant check written out by hand.
--
-- It returns counts and COLUMN NAMES only -- never dashboard or widget
-- titles. The caller is editing this report, so they already know its
-- columns; the names of other people's dashboards are not theirs to see, and
-- "3 tiles on dashboards you cannot see" carries the whole warning anyway.
create or replace function public.saved_report_usage(p_report_id uuid)
returns table (
  widget_count          int,
  dashboard_count       int,
  max_query_index       int,
  referenced_columns    text[],
  supplied_parameters   text[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
begin
  -- The tenant guard. Without it a SECURITY DEFINER function that takes a
  -- uuid is an oracle: call it across every id and learn which reports exist
  -- in other companies and how widely they are used. A report the caller
  -- cannot see returns nothing at all, not a zero row -- zero would confirm
  -- the id is real.
  select r.company_entity_id into v_company
    from public.silo_chat_saved_reports r
   where r.id = p_report_id
     and r.company_entity_id is not null
     and r.company_entity_id = active_company_id();
  if v_company is null then
    return;
  end if;

  return query
  with w as (
    select dw.id, dw.dashboard_id, dw.query_index, coalesce(dw.visual_config, '{}'::jsonb) as vc
      from public.dashboard_widgets dw
     where dw.report_id = p_report_id
       and dw.company_entity_id = v_company
  ),
  -- Every place a widget names a column of this report. A column dropped
  -- from the select list that appears here is the concrete breakage: the
  -- tile keeps rendering and quietly shows nothing.
  cols as (
    select distinct c as col from w,
      lateral (
        select w.vc ->> 'x_field'
        union all select w.vc ->> 'y_field'
        union all select w.vc ->> 'row_field'
        union all select w.vc ->> 'compare_field'
        union all select jsonb_array_elements_text(
                     case when jsonb_typeof(w.vc -> 'measures') = 'array'
                          then w.vc -> 'measures' else '[]'::jsonb end)
        union all select jsonb_array_elements_text(
                     case when jsonb_typeof(w.vc -> 'columns') = 'array'
                          then w.vc -> 'columns' else '[]'::jsonb end)
      ) as t(c)
     where c is not null and c <> ''
  ),
  -- Parameter keys the boards carrying this report supply, from their saved
  -- slicer values. Reported RAW, and deliberately not filtered to this
  -- report's own declarations: a board's filter_state also holds keys
  -- belonging to other reports on it, and the editor is the only side that
  -- knows which keys are being removed. It intersects. Filtering here would
  -- either drop the useful case or invent warnings about other reports.
  params as (
    select distinct k as param
      from public.dashboards d,
           lateral jsonb_object_keys(coalesce(d.filter_state, '{}'::jsonb)) k
     where d.company_entity_id = v_company
       and exists (select 1 from w where w.dashboard_id = d.id)
  )
  select
    (select count(*)::int from w),
    (select count(distinct w.dashboard_id)::int from w),
    (select coalesce(max(w.query_index), 0)::int from w),
    (select coalesce(array_agg(col order by col), '{}') from cols),
    (select coalesce(array_agg(param order by param), '{}') from params);
end;
$$;

comment on function public.saved_report_usage(uuid) is
  'Blast radius of editing a saved report: how many widgets and dashboards use it, the highest query_index any widget points at, the columns those widgets name, and the parameter keys their dashboards supply (raw -- the editor intersects them with the declarations it is about to remove). SECURITY DEFINER because dashboard_widgets RLS hides widgets on dashboards the caller cannot see, and an undercount reads as safety. Guarded to the caller''s active company; a report they cannot see returns no rows at all. Returns counts and column names only -- never dashboard or widget titles.';

revoke all on function public.saved_report_usage(uuid) from public;
grant execute on function public.saved_report_usage(uuid) to authenticated;
