-- v3 dashboards: personal saved filter views.
--
-- A dashboard already stores ONE filter position (`dashboards.filter_state`,
-- 20260903100000) -- the board's saved starting point, written only by an
-- editor's Save. That is the right thing for "what everyone sees when they
-- open this", and it is the wrong thing for the way a board is actually
-- read: the same nine tiles, looked at as last week / this month / one
-- store, by six people who each keep going back to their own cut.
--
-- Before this the only way to keep a cut was to duplicate the dashboard,
-- which duplicates its widgets, which duplicates nothing useful -- the
-- reports and the arrangement are identical and only the filter values
-- differ. A view is those values and nothing else: a name and a
-- filter_state, pointing at the dashboard that already exists.
--
-- PERSONAL, deliberately. `dashboard_filter_views_select` is creator-only,
-- not company-wide: a saved cut is a working habit, not a publication, and
-- a shared list of everyone's cuts would be noise on every board within a
-- month. The board's own `filter_state` remains the shared position, and
-- promoting a personal view to it is what an editor's Save already does.
-- Widening this to company visibility later is an additive policy change,
-- not a rewrite; narrowing it afterwards would not be.
--
-- Rollout: additive. No existing row, page or saved configuration changes
-- behaviour if this migration is not applied -- /v3/dashboard.html degrades
-- to the previous "no saved views" bar (it feature-detects the table and
-- hides the control on a 42P01), so the page and the migration can ship in
-- either order.
create table if not exists public.dashboard_filter_views (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  dashboard_id uuid not null references public.dashboards(id) on delete cascade,
  created_by uuid references public.profiles(id),
  name text not null,
  -- Same shape as dashboards.filter_state: { parameter_key: value }, where a
  -- date is stored as the TOKEN ('today-27d'), never as the date it resolves
  -- to today -- storing the resolved date would freeze a "last 28 days" view
  -- on the day it was saved, which is the one thing a saved view must not do.
  filter_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One name per person per dashboard: saving over "My stores" should REPLACE
-- it, and a list with three entries called "My stores" is a list nobody
-- trusts. The upsert in the page targets this constraint.
create unique index if not exists dashboard_filter_views_owner_name_idx
  on public.dashboard_filter_views (dashboard_id, created_by, lower(name));

create index if not exists dashboard_filter_views_dashboard_idx
  on public.dashboard_filter_views (dashboard_id, created_by);

alter table public.dashboard_filter_views enable row level security;

-- Creator-only on all four verbs. Note the company predicate is kept on
-- every one of them even though created_by already implies it: active
-- company can change under a user who belongs to two, and a view saved
-- against one company's dashboard must not follow them into the other.
drop policy if exists dashboard_filter_views_select on public.dashboard_filter_views;
create policy dashboard_filter_views_select on public.dashboard_filter_views
  for select using (
    company_entity_id = active_company_id() and created_by = auth.uid()
  );

drop policy if exists dashboard_filter_views_insert on public.dashboard_filter_views;
create policy dashboard_filter_views_insert on public.dashboard_filter_views
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
    -- A view for a dashboard the caller cannot see is not a thing that
    -- should exist. dashboards' own RLS answers "can see"; this EXISTS
    -- inherits it rather than restating who may read a board.
    and exists (select 1 from public.dashboards d where d.id = dashboard_id)
  );

drop policy if exists dashboard_filter_views_update on public.dashboard_filter_views;
create policy dashboard_filter_views_update on public.dashboard_filter_views
  for update using (
    company_entity_id = active_company_id() and created_by = auth.uid()
  ) with check (
    company_entity_id = active_company_id() and created_by = auth.uid()
  );

drop policy if exists dashboard_filter_views_delete on public.dashboard_filter_views;
create policy dashboard_filter_views_delete on public.dashboard_filter_views
  for delete using (
    company_entity_id = active_company_id() and created_by = auth.uid()
  );

-- The standard stamps, same as dashboards/dashboard_widgets.
drop trigger if exists stamp_created_by on public.dashboard_filter_views;
create trigger stamp_created_by before insert on public.dashboard_filter_views
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.dashboard_filter_views;
create trigger set_updated_at before update on public.dashboard_filter_views
  for each row execute function public.set_updated_at();

-- Re-attaches the stamp_company_entity_id BEFORE INSERT trigger across every
-- table carrying the column, this one included, so the page can omit it.
select public.attach_stamp_company_entity_id_triggers();

revoke all on public.dashboard_filter_views from anon;
grant select, insert, update, delete on public.dashboard_filter_views to authenticated;

comment on table public.dashboard_filter_views is
  'Personal saved filter positions for a v3 dashboard: a name plus a filter_state, pointing at a dashboard that already exists. Exists so keeping "my cut" of a board does not mean duplicating the board and its widgets. Creator-only by RLS on purpose -- the shared position is dashboards.filter_state, which only an editor''s Save writes.';
