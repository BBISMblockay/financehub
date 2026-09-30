-- Report archive is a library state, never deletion or a read restriction.
-- Keep SQL, sharing, dashboard references and widget configuration intact.
-- Live preflight (2026-09-30) found an unrecorded archived_at column and a
-- view-level archive filter. IF NOT EXISTS preserves any existing timestamps;
-- the unfiltered, security-invoker view below makes them restorable.
begin;

alter table public.silo_chat_saved_reports
  add column if not exists archived_at timestamptz;

comment on column public.silo_chat_saved_reports.archived_at is
  'Library archive state. NULL is active. Archiving hides a report from active lists and new-widget pickers, not from existing dashboards or authorized direct reads. Only the report creator in the active company may archive or restore it.';

-- UPDATE RLS also permits exec/owner content edits. It cannot compare OLD
-- with NEW, so merely adding an owner-only RPC would leave a direct PATCH
-- bypass, including claiming someone else''s report and then archiving it.
-- This INVOKER trigger guards the table boundary. Trusted migrations and
-- service-role maintenance retain their existing access; JWT role claims are
-- deliberately not used to identify those database roles.
create or replace function public.guard_saved_report_archive()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'service_role') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.archived_at is not null then
      raise exception 'Create the report before archiving it' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.created_by is distinct from old.created_by
     or new.company_entity_id is distinct from old.company_entity_id then
    raise exception 'Report creator and company cannot be changed' using errcode = '42501';
  end if;

  -- The source CHECK permits legacy company-scoped system rows. Otherwise
  -- their creator could demote one to manual, then archive on a second call.
  if old.source = 'system' and new.source is distinct from old.source then
    raise exception 'System reports cannot be converted by clients' using errcode = '42501';
  end if;

  if new.archived_at is distinct from old.archived_at then
    if auth.uid() is null
       or old.created_by is distinct from auth.uid()
       or old.company_entity_id is null
       or old.company_entity_id is distinct from public.active_company_id()
       or old.source not in ('ask_silo', 'manual')
       or not exists (
         select 1 from public.profiles p
         join public.entity_memberships em
           on em.user_id = p.id and em.entity_id = p.active_company_id
         where p.id = auth.uid() and p.is_active is true
           and p.active_company_id = old.company_entity_id
       ) then
      raise exception 'Report is unavailable or cannot be archived by you' using errcode = '42501';
    end if;
    -- Clients request a state, never supply the audit timestamp. A repeat
    -- archive cannot move the original archive date.
    if new.archived_at is not null then
      new.archived_at := coalesce(old.archived_at, now());
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_saved_report_archive() from public, anon, authenticated;
drop trigger if exists guard_saved_report_archive on public.silo_chat_saved_reports;
create trigger guard_saved_report_archive
  before insert or update on public.silo_chat_saved_reports
  for each row execute function public.guard_saved_report_archive();

-- One atomic, retry-safe operation. The row lock serializes opposite actions;
-- repeat requests return the existing state without touching updated_at.
-- INVOKER preserves the table's SELECT/UPDATE policies as another boundary.
create or replace function public.set_saved_report_archived(p_report_id uuid, p_archived boolean)
returns table (id uuid, archived_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_report public.silo_chat_saved_reports%rowtype;
begin
  if p_archived is null then
    raise exception 'Archive state is required' using errcode = '22004';
  end if;
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid() and p.is_active is true
      and p.active_company_id = public.active_company_id()
  ) then
    raise exception 'Report is unavailable or cannot be archived by you' using errcode = '42501';
  end if;

  select r.* into v_report
    from public.silo_chat_saved_reports r
   where r.id = p_report_id
     and r.created_by = auth.uid()
     and r.company_entity_id = public.active_company_id()
     and r.source in ('ask_silo', 'manual')
   for update;
  if not found then
    raise exception 'Report is unavailable or cannot be archived by you' using errcode = '42501';
  end if;

  if (v_report.archived_at is not null) is distinct from p_archived then
    update public.silo_chat_saved_reports r
       set archived_at = case when p_archived then now() else null end
     where r.id = v_report.id
     returning r.* into v_report;
  end if;
  return query select v_report.id, v_report.archived_at;
end;
$$;

revoke all on function public.set_saved_report_archived(uuid, boolean) from public, anon;
grant execute on function public.set_saved_report_archived(uuid, boolean) to authenticated;

-- Totals include colleagues' private boards, but their titles/ids do not.
-- Reuse the existing DEFINER counter only AFTER the stricter owner/active
-- membership check. Fetch names through native dashboard RLS (INVOKER), so
-- a later dashboard visibility-policy change also applies here automatically.
create or replace function public.saved_report_archive_usage(p_report_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_widget_count integer;
  v_dashboard_count integer;
  v_dashboards jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid() and p.is_active is true
      and p.active_company_id = v_company
  ) or not exists (
    select 1 from public.silo_chat_saved_reports r
    where r.id = p_report_id and r.created_by = auth.uid()
      and r.company_entity_id = v_company
      and r.source in ('ask_silo', 'manual')
  ) then
    raise exception 'Report is unavailable or cannot be archived by you' using errcode = '42501';
  end if;

  select u.widget_count, u.dashboard_count into v_widget_count, v_dashboard_count
    from public.saved_report_usage(p_report_id) u;
  if not found then
    raise exception 'Report dependencies could not be checked' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name)
                            order by d.name, d.id), '[]'::jsonb)
    into v_dashboards
    from public.dashboards d
   where d.company_entity_id = v_company
     and exists (
       select 1 from public.dashboard_widgets w
        where w.dashboard_id = d.id and w.report_id = p_report_id
          and w.company_entity_id = v_company
     );

  return jsonb_build_object(
    'dashboard_count', v_dashboard_count,
    'widget_count', v_widget_count,
    'dashboards', v_dashboards,
    'hidden_dashboard_count', greatest(0, v_dashboard_count - jsonb_array_length(v_dashboards))
  );
end;
$$;

revoke all on function public.saved_report_archive_usage(uuid) from public, anon;
grant execute on function public.saved_report_archive_usage(uuid) to authenticated;

-- Archive filtering belongs to the library/picker, never to read visibility.
-- Preserve column order and invoker RLS; append archived_at at the end.
create or replace view public.silo_chat_saved_reports_v
with (security_invoker = true) as
select r.id, r.company_entity_id, r.created_by, p.name as created_by_name,
       r.source, r.title, r.description, r.question, r.answer, r.queries_run,
       r.visibility, r.columns_metadata, r.parameters, r.created_at, r.updated_at,
       r.row_estimate, r.row_estimate_at, r.archived_at
  from public.silo_chat_saved_reports r
  left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from public, anon;
grant select on public.silo_chat_saved_reports_v to authenticated;

commit;
