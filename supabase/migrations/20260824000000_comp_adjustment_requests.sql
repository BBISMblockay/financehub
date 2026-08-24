-- Compensation Adjustment Requests — Team module, phase 2.
--
-- Extends Performance Reviews (employees / employee_managers) with a
-- workflow for managers to request a raise / bonus / promotion / equity
-- change for one of their reports. Submissions route to the finance team
-- for review and a decision, same approval boundary already used for
-- payment_requests (current_user_can_manage_payment_requests()) — this
-- migration adds a dedicated current_user_can_manage_comp_requests()
-- rather than reusing that function, so the two approval paths can
-- diverge later (e.g. HR-specific approvers) without coupling them.
--
-- Lifecycle: draft -> submitted -> in_review -> (needs_info -> submitted)*
--                                            -> approved | denied
-- A manager can freely edit/resubmit their own row while it is still
-- 'draft' (mirrors reviews_active_update's own-row-while-draft shape).
-- Once submitted, only finance (or exec/owner) can move it — same
-- "requester creates, AP/finance owns the rest" boundary as
-- payment_requests_internal_update.

-- ---------------------------------------------------------------------------
-- 1. Approval-gate function
-- ---------------------------------------------------------------------------

create or replace function public.current_user_can_manage_comp_requests()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        case when em.role is not null
             then em.role in ('owner_admin','admin')
             else p.role::text = 'admin'
        end
        or p.department in ('finance','admin','exec')
      )
  );
$function$;

revoke execute on function public.current_user_can_manage_comp_requests() from public, anon;
grant execute on function public.current_user_can_manage_comp_requests() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.comp_adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  employee_id uuid not null references public.employees(id) on delete cascade,
  adjustment_type text not null check (adjustment_type in ('raise', 'bonus', 'promotion', 'equity', 'other')),
  current_compensation numeric(12,2),
  proposed_compensation numeric(12,2),
  current_title text,
  proposed_title text,
  effective_date date,
  justification text not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'in_review', 'needs_info', 'approved', 'denied')),
  finance_notes text,
  reviewed_by uuid references public.profiles(id),
  decided_at timestamptz,
  submitted_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists comp_adjustment_requests_employee_idx on public.comp_adjustment_requests (employee_id);
create index if not exists comp_adjustment_requests_created_by_idx on public.comp_adjustment_requests (created_by);
create index if not exists comp_adjustment_requests_status_idx on public.comp_adjustment_requests (company_entity_id, status);

create table if not exists public.comp_adjustment_request_activity (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.comp_adjustment_requests(id) on delete cascade,
  company_entity_id uuid,
  activity_type text not null,
  message text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists comp_adjustment_request_activity_request_idx
  on public.comp_adjustment_request_activity (request_id);

-- ---------------------------------------------------------------------------
-- 3. Triggers — touch updated_at, stamp created_by / company_entity_id
-- ---------------------------------------------------------------------------

create or replace function public.tg_comp_adjustment_requests_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_updated_at on public.comp_adjustment_requests;
create trigger touch_updated_at before update on public.comp_adjustment_requests
  for each row execute function public.tg_comp_adjustment_requests_touch_updated_at();

drop trigger if exists stamp_created_by on public.comp_adjustment_requests;
create trigger stamp_created_by before insert on public.comp_adjustment_requests
  for each row execute function public.stamp_created_by();

drop trigger if exists stamp_created_by on public.comp_adjustment_request_activity;
create trigger stamp_created_by before insert on public.comp_adjustment_request_activity
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

alter table public.comp_adjustment_requests enable row level security;
alter table public.comp_adjustment_request_activity enable row level security;

revoke all on public.comp_adjustment_requests, public.comp_adjustment_request_activity from anon;

-- select: the submitting manager, any of the employee's other managers,
-- finance, or exec/owner.
drop policy if exists comp_adjustment_requests_active_select on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_select on public.comp_adjustment_requests for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      created_by = auth.uid()
      or public.is_employee_manager(employee_id)
      or public.current_user_can_manage_comp_requests()
      or public.is_exec_or_owner()
    )
  );

-- insert: only a manager of the target employee (or exec/owner) can open a
-- request, and only as themselves.
drop policy if exists comp_adjustment_requests_active_insert on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_insert on public.comp_adjustment_requests for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and created_by = auth.uid()
    and (public.is_employee_manager(employee_id) or public.is_exec_or_owner())
  );

-- update: the submitting manager may keep editing/resubmitting their OWN
-- request only while it is still 'draft' (matches the row's state before
-- this update — WITH CHECK then allows it to land on 'draft' or
-- 'submitted'). Finance/exec/owner may move any row at any stage — that's
-- the actual review workflow (submitted -> in_review -> needs_info ->
-- approved/denied).
drop policy if exists comp_adjustment_requests_active_update on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_update on public.comp_adjustment_requests for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      public.current_user_can_manage_comp_requests()
      or public.is_exec_or_owner()
      or (created_by = auth.uid() and public.is_employee_manager(employee_id) and status = 'draft')
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and (
      public.current_user_can_manage_comp_requests()
      or public.is_exec_or_owner()
      or (created_by = auth.uid() and public.is_employee_manager(employee_id) and status in ('draft', 'submitted'))
    )
  );

-- delete: creator can delete their own draft (before it ever reached
-- finance); exec/owner can delete at any stage.
drop policy if exists comp_adjustment_requests_active_delete on public.comp_adjustment_requests;
create policy comp_adjustment_requests_active_delete on public.comp_adjustment_requests for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      public.is_exec_or_owner()
      or (created_by = auth.uid() and status = 'draft')
    )
  );

-- activity: visibility/write inherits the parent request's own RLS (same
-- pattern as review_answers keying off reviews).
drop policy if exists comp_adjustment_request_activity_select on public.comp_adjustment_request_activity;
create policy comp_adjustment_request_activity_select on public.comp_adjustment_request_activity for select to authenticated
  using (exists (select 1 from public.comp_adjustment_requests r where r.id = comp_adjustment_request_activity.request_id));

drop policy if exists comp_adjustment_request_activity_insert on public.comp_adjustment_request_activity;
create policy comp_adjustment_request_activity_insert on public.comp_adjustment_request_activity for insert to authenticated
  with check (exists (select 1 from public.comp_adjustment_requests r where r.id = comp_adjustment_request_activity.request_id));

-- ---------------------------------------------------------------------------
-- 5. Reporting view — joins employee/requester/reviewer names, same shape
--    as payment_requests_v.
-- ---------------------------------------------------------------------------

create or replace view public.comp_adjustment_requests_v
with (security_invoker = true) as
select
  r.*,
  e.name as employee_name,
  e.email as employee_email,
  e.job_title as employee_job_title,
  rp.name as requested_by_name,
  rp.email as requested_by_email,
  vp.name as reviewed_by_name,
  vp.email as reviewed_by_email
from public.comp_adjustment_requests r
join public.employees e on e.id = r.employee_id
left join public.profiles rp on rp.id = r.created_by
left join public.profiles vp on vp.id = r.reviewed_by;

revoke all on public.comp_adjustment_requests_v from anon;
grant select on public.comp_adjustment_requests_v to authenticated;
