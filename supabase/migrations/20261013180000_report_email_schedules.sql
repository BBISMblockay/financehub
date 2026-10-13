-- Scheduled CSV email delivery for saved reports and dashboard bundles.
-- Admins configure schedules; a nightly GitHub Action invokes the
-- report-email-deliver edge function. Full exports page past the 1,000-row
-- interactive cap via chat_run_readonly_query's optional p_limit (max 10k).

-- ── Extend chat_run_readonly_query with optional page size ───────────────
drop function if exists public.chat_run_readonly_query(text, integer);

create function public.chat_run_readonly_query(
  query text,
  p_offset integer default 0,
  p_limit integer default 1000
)
returns json
language plpgsql
volatile
set search_path to 'public'
as $function$
declare
  result      json;
  trimmed     text;
  safe_offset integer;
  safe_limit  integer;
begin
  trimmed := btrim(
    regexp_replace(query, '^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+', ''),
    E' \t\r\n'
  );

  if right(trimmed, 1) = ';' then
    trimmed := btrim(left(trimmed, length(trimmed) - 1), E' \t\r\n');
  end if;

  if trimmed !~* '^(select|with)\s' then
    raise exception
      'Only a single SELECT or WITH (read-only) statement is allowed (parsed statement began: %)',
      left(coalesce(nullif(trimmed, ''), '<empty>'), 40);
  end if;

  if trimmed ~ ';' then
    raise exception 'Statement must not contain a semicolon (single statement only)';
  end if;

  safe_offset := greatest(coalesce(p_offset, 0), 0);
  safe_limit := least(greatest(coalesce(p_limit, 1000), 1), 10000);

  set local statement_timeout = '120s';
  execute 'set transaction read only';

  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) user_query limit %s offset %s) t',
    trimmed, safe_limit, safe_offset
  ) into result;

  return result;
end;
$function$;

revoke all on function public.chat_run_readonly_query(text, integer, integer) from public, anon;
grant execute on function public.chat_run_readonly_query(text, integer, integer) to authenticated;

comment on function public.chat_run_readonly_query(text, integer, integer) is
  'Shared read-only reporting engine: single SELECT/WITH, 1000-row default page (p_limit up to 10000 for exports), p_offset, read-only txn. SECURITY INVOKER.';

-- ── Schedules ────────────────────────────────────────────────────────────
create table if not exists public.report_email_schedules (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  name text,
  target_kind text not null check (target_kind in ('report', 'dashboard')),
  report_id uuid references public.silo_chat_saved_reports(id) on delete set null,
  dashboard_id uuid references public.dashboards(id) on delete set null,
  -- null = default query; empty array with report = all declared parts; else indices
  query_indices integer[],
  parameter_state jsonb not null default '{}'::jsonb,
  filter_view_id uuid references public.dashboard_filter_views(id) on delete set null,
  cadence_preset text not null check (cadence_preset in (
    'weekdays_0700', 'daily_0600', 'monday_0700', 'month_first_0700'
  )),
  timezone text not null default 'America/Los_Angeles',
  subject_template text,
  is_active boolean not null default true,
  is_paused boolean not null default false,
  allow_member_subscribe boolean not null default false,
  recipients jsonb not null default '[{"kind":"workspace_admins"}]'::jsonb,
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_email_schedules_target_check check (
    (target_kind = 'report' and report_id is not null and dashboard_id is null)
    or (target_kind = 'dashboard' and dashboard_id is not null and report_id is null)
  )
);

create index if not exists report_email_schedules_company_idx
  on public.report_email_schedules (company_entity_id, is_active, next_run_at);

create index if not exists report_email_schedules_due_idx
  on public.report_email_schedules (next_run_at)
  where is_active and not is_paused and next_run_at is not null;

alter table public.report_email_schedules enable row level security;

drop policy if exists report_email_schedules_select on public.report_email_schedules;
create policy report_email_schedules_select on public.report_email_schedules
  for select using (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  );

drop policy if exists report_email_schedules_insert on public.report_email_schedules;
create policy report_email_schedules_insert on public.report_email_schedules
  for insert with check (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
    and created_by = auth.uid()
  );

drop policy if exists report_email_schedules_update on public.report_email_schedules;
create policy report_email_schedules_update on public.report_email_schedules
  for update using (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  )
  with check (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  );

drop policy if exists report_email_schedules_delete on public.report_email_schedules;
create policy report_email_schedules_delete on public.report_email_schedules
  for delete using (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  );

-- Member self-subscribe (optional per schedule)
create table if not exists public.report_email_subscriptions (
  schedule_id uuid not null references public.report_email_schedules(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (schedule_id, profile_id)
);

alter table public.report_email_subscriptions enable row level security;

drop policy if exists report_email_subscriptions_select on public.report_email_subscriptions;
create policy report_email_subscriptions_select on public.report_email_subscriptions
  for select using (
    exists (
      select 1 from public.report_email_schedules s
      where s.id = schedule_id
        and s.company_entity_id = active_company_id()
        and (is_entity_admin(s.company_entity_id) or profile_id = auth.uid())
    )
  );

drop policy if exists report_email_subscriptions_insert on public.report_email_subscriptions;
create policy report_email_subscriptions_insert on public.report_email_subscriptions
  for insert with check (
    profile_id = auth.uid()
    and exists (
      select 1 from public.report_email_schedules s
      where s.id = schedule_id
        and s.company_entity_id = active_company_id()
        and s.allow_member_subscribe
        and s.is_active
        and not s.is_paused
    )
  );

drop policy if exists report_email_subscriptions_delete on public.report_email_subscriptions;
create policy report_email_subscriptions_delete on public.report_email_subscriptions
  for delete using (
    profile_id = auth.uid()
    or exists (
      select 1 from public.report_email_schedules s
      where s.id = schedule_id
        and s.company_entity_id = active_company_id()
        and is_entity_admin(s.company_entity_id)
    )
  );

-- Delivery log
create table if not exists public.report_email_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.report_email_schedules(id) on delete cascade,
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed')),
  trigger_kind text not null default 'schedule'
    check (trigger_kind in ('schedule', 'manual', 'test')),
  triggered_by uuid references public.profiles(id),
  total_rows bigint,
  attachment_count integer,
  delivery_mode text check (delivery_mode in ('attachment', 'storage_link', 'mixed')),
  storage_paths text[],
  error_message text,
  recipient_count integer
);

create index if not exists report_email_runs_schedule_idx
  on public.report_email_runs (schedule_id, started_at desc);

alter table public.report_email_runs enable row level security;

drop policy if exists report_email_runs_select on public.report_email_runs;
create policy report_email_runs_select on public.report_email_runs
  for select using (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  );

drop policy if exists report_email_runs_insert on public.report_email_runs;
create policy report_email_runs_insert on public.report_email_runs
  for insert with check (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  );

drop policy if exists report_email_runs_update on public.report_email_runs;
create policy report_email_runs_update on public.report_email_runs
  for update using (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  )
  with check (
    company_entity_id = active_company_id()
    and is_entity_admin(company_entity_id)
  );

-- Invoker view for the library tab
create or replace view public.report_email_schedules_v
with (security_invoker = true)
as
select
  s.*,
  coalesce(r.title, d.name) as target_title,
  p.name as created_by_name,
  p.email as created_by_email,
  (select count(*)::integer from public.report_email_subscriptions sub where sub.schedule_id = s.id) as subscriber_count,
  (
    select r2.status
    from public.report_email_runs r2
    where r2.schedule_id = s.id
    order by r2.started_at desc
    limit 1
  ) as last_run_status
from public.report_email_schedules s
left join public.silo_chat_saved_reports r on r.id = s.report_id
left join public.dashboards d on d.id = s.dashboard_id
left join public.profiles p on p.id = s.created_by;

grant select on public.report_email_schedules_v to authenticated;

-- Resolve recipient emails for a schedule (admin or delivery worker)
create or replace function public.resolve_report_email_recipients(p_schedule_id uuid)
returns table(email text, profile_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_sched record;
  v_rec jsonb;
  v_kind text;
  v_dept text;
  v_pid uuid;
  v_emails text[] := '{}';
begin
  select * into v_sched
  from public.report_email_schedules s
  where s.id = p_schedule_id;

  if v_sched.id is null then
    return;
  end if;

  if auth.uid() is not null
     and not public.is_entity_admin(v_sched.company_entity_id)
     and auth.role()::text <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_rec in select jsonb_array_elements(v_sched.recipients)
  loop
    v_kind := v_rec->>'kind';
    if v_kind = 'workspace_admins' then
      return query
      select distinct pr.email, pr.id
      from public.entity_memberships em
      join public.profiles pr on pr.id = em.user_id
      where em.entity_id = v_sched.company_entity_id
        and em.role in ('owner_admin', 'admin')
        and coalesce(pr.is_active, true)
        and pr.email is not null;
    elsif v_kind = 'department' then
      v_dept := nullif(trim(v_rec->>'value'), '');
      if v_dept is not null then
        return query
        select distinct pr.email, pr.id
        from public.entity_memberships em
        join public.profiles pr on pr.id = em.user_id
        where em.entity_id = v_sched.company_entity_id
          and coalesce(pr.is_active, true)
          and pr.department::text = v_dept
          and pr.email is not null;
      end if;
    elsif v_kind = 'profile' then
      v_pid := nullif(v_rec->>'id', '')::uuid;
      if v_pid is not null then
        return query
        select pr.email, pr.id
        from public.profiles pr
        join public.entity_memberships em
          on em.user_id = pr.id and em.entity_id = v_sched.company_entity_id
        where pr.id = v_pid
          and coalesce(pr.is_active, true)
          and pr.email is not null;
      end if;
    end if;
  end loop;

  if v_sched.allow_member_subscribe then
    return query
    select pr.email, pr.id
    from public.report_email_subscriptions sub
    join public.profiles pr on pr.id = sub.profile_id
    where sub.schedule_id = p_schedule_id
      and coalesce(pr.is_active, true)
      and pr.email is not null;
  end if;
end;
$$;

revoke all on function public.resolve_report_email_recipients(uuid) from public, anon;
grant execute on function public.resolve_report_email_recipients(uuid) to authenticated, service_role;

-- Pause every active schedule in the active company (admin)
create or replace function public.pause_all_report_email_schedules()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co uuid := public.active_company_id();
  v_n integer;
begin
  if auth.uid() is null or not public.is_entity_admin(v_co) then
    raise exception 'not authorized';
  end if;
  update public.report_email_schedules
     set is_paused = true, updated_at = now()
   where company_entity_id = v_co
     and is_active
     and not is_paused;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.pause_all_report_email_schedules() from public, anon;
grant execute on function public.pause_all_report_email_schedules() to authenticated;

-- Duplicate a schedule (admin, same company)
create or replace function public.duplicate_report_email_schedule(p_schedule_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.report_email_schedules%rowtype;
  v_new uuid;
begin
  select * into v_old from public.report_email_schedules where id = p_schedule_id;
  if v_old.id is null then
    raise exception 'schedule not found';
  end if;
  if not public.is_entity_admin(v_old.company_entity_id)
     or v_old.company_entity_id is distinct from public.active_company_id() then
    raise exception 'not authorized';
  end if;

  insert into public.report_email_schedules (
    company_entity_id, created_by, name, target_kind, report_id, dashboard_id,
    query_indices, parameter_state, filter_view_id, cadence_preset, timezone,
    subject_template, is_active, is_paused, allow_member_subscribe, recipients, next_run_at
  ) values (
    v_old.company_entity_id, auth.uid(),
    coalesce(v_old.name, 'Copy') || ' (copy)',
    v_old.target_kind, v_old.report_id, v_old.dashboard_id,
    v_old.query_indices, v_old.parameter_state, v_old.filter_view_id,
    v_old.cadence_preset, v_old.timezone, v_old.subject_template,
    true, false, v_old.allow_member_subscribe, v_old.recipients, v_old.next_run_at
  ) returning id into v_new;

  return v_new;
end;
$$;

revoke all on function public.duplicate_report_email_schedule(uuid) from public, anon;
grant execute on function public.duplicate_report_email_schedule(uuid) to authenticated;

select public.attach_stamp_company_entity_id_triggers();

insert into storage.buckets (id, name, public)
values ('report-email-exports', 'report-email-exports', false)
on conflict (id) do nothing;

-- Service-role uploads from report-email-deliver; signed URLs are emailed.
drop policy if exists "report_email_exports_service" on storage.objects;
create policy "report_email_exports_service" on storage.objects
  for all to service_role
  using (bucket_id = 'report-email-exports')
  with check (bucket_id = 'report-email-exports');
