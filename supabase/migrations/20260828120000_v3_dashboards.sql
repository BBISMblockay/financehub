-- v3 dashboard runtime: dashboards + dashboard_widgets.
--
-- The point of this pair of tables is what is NOT in them: HTML. A
-- dashboard is stored as configuration -- which saved report feeds a
-- widget, which visual renders it, which column is the dimension, which
-- is the measure, and where the widget sits on the grid. The renderer
-- (v3/js/dashboard-renderer.js) reads that config and draws it. Switching
-- a widget from a table to a bar chart is a one-field UPDATE, not a new
-- page, not an LLM call, not a deploy.
--
-- There is deliberately NO third table for saved reports. SILO already has
-- one: silo_chat_saved_reports, which since 20260818050000 stores a
-- question, an answer, and the exact SQL (queries_run) that produced it,
-- and which the Ask SILO "Refresh data" button already re-runs client-side
-- through chat_run_readonly_query. That RPC is SECURITY INVOKER, so every
-- re-run stays scoped by the caller's own RLS. A dashboard widget is
-- therefore just "saved report + which of its queries + how to draw it" --
-- inventing a parallel saved_reports table would fork the one artifact
-- Ask SILO already produces and split refresh behaviour across two code
-- paths.
--
-- query_index exists because queries_run is an ARRAY. A saved Ask SILO
-- answer routinely ran several queries to get where it got; a widget draws
-- exactly one dataset. The widget names which one rather than silently
-- taking the first and being wrong on multi-query reports.
--
-- report_id is `on delete set null`, not cascade and not restrict: deleting
-- a saved report should not silently delete someone else's dashboard tile,
-- and it should not block the delete either. The widget keeps its own
-- `title`, so an orphaned tile can still say what it used to show.

-- ── dashboards ────────────────────────────────────────────────────────
create table if not exists public.dashboards (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid references public.profiles(id),
  name text not null,
  description text,
  -- Same two-value split as silo_chat_saved_reports.visibility, and for
  -- the same reason: a personal daily-routine dashboard should not have
  -- to live in the company list to exist.
  visibility text not null default 'company'
    check (visibility in ('company', 'private')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dashboards_company_created_idx
  on public.dashboards (company_entity_id, created_at desc);

alter table public.dashboards enable row level security;

drop policy if exists dashboards_select on public.dashboards;
create policy dashboards_select on public.dashboards
  for select using (
    company_entity_id = active_company_id()
    and (visibility = 'company' or created_by = auth.uid())
  );

drop policy if exists dashboards_insert on public.dashboards;
create policy dashboards_insert on public.dashboards
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
  );

drop policy if exists dashboards_update on public.dashboards;
create policy dashboards_update on public.dashboards
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  )
  with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop policy if exists dashboards_delete on public.dashboards;
create policy dashboards_delete on public.dashboards
  for delete using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop trigger if exists stamp_created_by on public.dashboards;
create trigger stamp_created_by before insert on public.dashboards
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.dashboards;
create trigger set_updated_at before update on public.dashboards
  for each row execute function public.set_updated_at();

-- ── dashboard_widgets ─────────────────────────────────────────────────
create table if not exists public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.dashboards(id) on delete cascade,
  company_entity_id uuid references public.entities(id),
  created_by uuid references public.profiles(id),
  report_id uuid references public.silo_chat_saved_reports(id) on delete set null,
  -- Which entry of the source report's queries_run array feeds this widget.
  query_index integer not null default 0 check (query_index >= 0),
  title text,
  visual_type text not null default 'table'
    check (visual_type in ('table', 'kpi', 'bar', 'line', 'donut')),
  -- { x_field, y_field, sort, limit, value_format, ... } -- read by
  -- v3/js/chart-adapter.js. Deliberately schemaless: adding a visual
  -- option should never need a migration.
  visual_config jsonb not null default '{}'::jsonb,
  -- GridStack geometry: { x, y, w, h }. Kept separate from visual_config
  -- so a drag/resize save never has to round-trip the visual settings.
  layout jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dashboard_widgets_dashboard_idx
  on public.dashboard_widgets (dashboard_id, sort_order);

alter table public.dashboard_widgets enable row level security;

-- Widget visibility and writability are entirely the parent dashboard's,
-- resolved through an EXISTS against dashboards -- the same shape
-- comp_adjustment_request_activity uses against its parent request. No
-- recursion risk: dashboards' own policies never reference this table.
drop policy if exists dashboard_widgets_select on public.dashboard_widgets;
create policy dashboard_widgets_select on public.dashboard_widgets
  for select using (
    exists (select 1 from public.dashboards d where d.id = dashboard_widgets.dashboard_id)
  );

drop policy if exists dashboard_widgets_insert on public.dashboard_widgets;
create policy dashboard_widgets_insert on public.dashboard_widgets
  for insert with check (
    company_entity_id = active_company_id()
    and exists (
      select 1 from public.dashboards d
       where d.id = dashboard_widgets.dashboard_id
         and (d.created_by = auth.uid() or is_exec_or_owner())
    )
  );

drop policy if exists dashboard_widgets_update on public.dashboard_widgets;
create policy dashboard_widgets_update on public.dashboard_widgets
  for update using (
    exists (
      select 1 from public.dashboards d
       where d.id = dashboard_widgets.dashboard_id
         and (d.created_by = auth.uid() or is_exec_or_owner())
    )
  )
  with check (
    exists (
      select 1 from public.dashboards d
       where d.id = dashboard_widgets.dashboard_id
         and (d.created_by = auth.uid() or is_exec_or_owner())
    )
  );

drop policy if exists dashboard_widgets_delete on public.dashboard_widgets;
create policy dashboard_widgets_delete on public.dashboard_widgets
  for delete using (
    exists (
      select 1 from public.dashboards d
       where d.id = dashboard_widgets.dashboard_id
         and (d.created_by = auth.uid() or is_exec_or_owner())
    )
  );

drop trigger if exists stamp_created_by on public.dashboard_widgets;
create trigger stamp_created_by before insert on public.dashboard_widgets
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.dashboard_widgets;
create trigger set_updated_at before update on public.dashboard_widgets
  for each row execute function public.set_updated_at();

-- Attaches (and refreshes) the stamp_company_entity_id BEFORE INSERT
-- trigger on both new tables so the UI can omit company_entity_id.
select public.attach_stamp_company_entity_id_triggers();

revoke all on public.dashboards from anon;
revoke all on public.dashboard_widgets from anon;
grant select, insert, update, delete on public.dashboards to authenticated;
grant select, insert, update, delete on public.dashboard_widgets to authenticated;

-- ── views ─────────────────────────────────────────────────────────────
create or replace view public.dashboards_v
with (security_invoker = true) as
select
  d.id,
  d.company_entity_id,
  d.created_by,
  p.name as created_by_name,
  d.name,
  d.description,
  d.visibility,
  d.created_at,
  d.updated_at,
  (select count(*) from public.dashboard_widgets w where w.dashboard_id = d.id) as widget_count
from public.dashboards d
left join public.profiles p on p.id = d.created_by;

revoke all on public.dashboards_v from anon;
grant select on public.dashboards_v to authenticated;

-- Joins the source report so the renderer fetches a dashboard's widgets
-- AND their SQL in one round trip. security_invoker, so a widget whose
-- source report is someone else's PRIVATE saved report comes back with a
-- null query_sql for everyone but its owner -- the tile then renders a
-- "source report not visible to you" state instead of silently blank.
create or replace view public.dashboard_widgets_v
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
  r.title      as report_title,
  r.question   as report_question,
  r.visibility as report_visibility,
  r.queries_run[w.query_index + 1] as query_sql,
  coalesce(array_length(r.queries_run, 1), 0) as report_query_count
from public.dashboard_widgets w
left join public.silo_chat_saved_reports r on r.id = w.report_id;

revoke all on public.dashboard_widgets_v from anon;
grant select on public.dashboard_widgets_v to authenticated;

comment on table public.dashboards is
  'v3 dashboard runtime: a named canvas of widgets. Stores configuration, never rendered HTML.';
comment on table public.dashboard_widgets is
  'One tile on a dashboard: which saved report (and which of its queries) feeds it, which visual draws it, and where it sits on the grid.';
comment on column public.dashboard_widgets.query_index is
  'Zero-based index into silo_chat_saved_reports.queries_run. A saved answer often ran several queries; a widget draws exactly one.';
