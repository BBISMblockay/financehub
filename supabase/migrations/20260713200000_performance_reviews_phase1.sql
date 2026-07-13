-- Performance Reviews — Phase 1: roles, schema, RLS.
--
-- Visibility model (enforced here, not in the UI):
--   owner/executive  -> every employee, every review in their company
--   admin (manager)  -> only employees where employees.manager_user_id = them
--   authenticated employee -> only their own non-draft reviews (via employees.profile_id)
--   associates (no SILO login) -> nothing here; they go through the token
--     portal edge function (service role) in Phase 4
--   private notes    -> author only, not even exec/owner
--
-- NOTE: 'executive' is added to app_role in this migration but must not be
-- referenced as an enum literal ('executive'::app_role) in this same
-- transaction — all role checks below compare role::text instead.

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------
alter type public.app_role add value if not exists 'executive';

-- Executive outranks admin: let it pass the existing admin gate too
-- (backend hub, admin_* RPCs). Text comparison avoids same-transaction
-- enum-literal use.
create or replace function public.is_admin()
returns boolean
language sql stable
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(p.role::text) in ('owner', 'admin', 'executive')
  );
$$;

create or replace function public.is_exec_or_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(p.role::text) in ('owner', 'executive')
  );
$$;

create or replace function public.reviews_can_manage()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and lower(p.role::text) in ('owner', 'executive', 'admin')
  );
$$;

revoke execute on function public.is_exec_or_owner() from public, anon;
revoke execute on function public.reviews_can_manage() from public, anon;
grant execute on function public.is_exec_or_owner() to authenticated, service_role;
grant execute on function public.reviews_can_manage() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  name text not null,
  email text not null,
  location text,
  job_title text,
  manager_user_id uuid not null references public.profiles(id),
  profile_id uuid references public.profiles(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists employees_company_email_uniq
  on public.employees (company_entity_id, lower(email));
create index if not exists employees_manager_idx on public.employees (manager_user_id);
create index if not exists employees_profile_idx on public.employees (profile_id);

create table if not exists public.review_templates (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_template_questions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.review_templates(id) on delete cascade,
  company_entity_id uuid,
  position integer not null default 0,
  kind text not null check (kind in ('free_text', 'scale_1_10', 'single_choice', 'multi_choice', 'goals')),
  label text not null,
  help_text text,
  options jsonb not null default '[]'::jsonb,
  required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_template_questions_template_idx
  on public.review_template_questions (template_id, position);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  template_id uuid not null references public.review_templates(id),
  employee_id uuid not null references public.employees(id) on delete cascade,
  manager_user_id uuid not null references public.profiles(id),
  period_label text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'finished')),
  sent_at timestamptz,
  employee_response text,
  employee_signed_name text,
  employee_signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reviews_employee_idx on public.reviews (employee_id);
create index if not exists reviews_manager_idx on public.reviews (manager_user_id);

create table if not exists public.review_answers (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  question_id uuid not null references public.review_template_questions(id),
  company_entity_id uuid,
  value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, question_id)
);

create index if not exists review_answers_review_idx on public.review_answers (review_id);

create table if not exists public.review_private_notes (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  company_entity_id uuid,
  author_user_id uuid not null default auth.uid() references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_private_notes_review_idx on public.review_private_notes (review_id);

create table if not exists public.employee_goals (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  employee_id uuid not null references public.employees(id) on delete cascade,
  review_id uuid references public.reviews(id) on delete set null,
  title text not null,
  description text,
  target_date date,
  status text not null default 'open' check (status in ('open', 'achieved', 'dropped', 'carried')),
  created_by uuid default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_goals_employee_idx on public.employee_goals (employee_id);

create table if not exists public.review_access_tokens (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  company_entity_id uuid,
  token_hash text not null unique,
  expires_at timestamptz not null,
  completed_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists review_access_tokens_review_idx on public.review_access_tokens (review_id);

-- ---------------------------------------------------------------------------
-- 3. Triggers — auto-link SILO profile by email, touch updated_at, stamp company
-- ---------------------------------------------------------------------------

-- profiles is RLS'd to self-select, so the email match runs SECURITY DEFINER.
create or replace function public.employees_autolink_profile()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.profile_id is null and new.email is not null then
    select p.id into new.profile_id
    from public.profiles p
    where lower(p.email) = lower(new.email)
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists employees_autolink_profile on public.employees;
create trigger employees_autolink_profile
  before insert or update of email on public.employees
  for each row execute function public.employees_autolink_profile();

create or replace function public.tg_reviews_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['employees','review_templates','review_template_questions','reviews','review_answers','review_private_notes','employee_goals']
  loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.tg_reviews_touch_updated_at()', t);
  end loop;
end;
$$;

-- Attach the existing company_entity_id stamp trigger to the new tables.
select public.attach_stamp_company_entity_id_triggers();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

alter table public.employees enable row level security;
alter table public.review_templates enable row level security;
alter table public.review_template_questions enable row level security;
alter table public.reviews enable row level security;
alter table public.review_answers enable row level security;
alter table public.review_private_notes enable row level security;
alter table public.employee_goals enable row level security;
alter table public.review_access_tokens enable row level security;
-- review_access_tokens: RLS on, NO policies — service-role (edge functions) only.

revoke all on public.employees, public.review_templates, public.review_template_questions,
  public.reviews, public.review_answers, public.review_private_notes,
  public.employee_goals, public.review_access_tokens from anon;

-- employees: manager sees own roster; exec/owner sees all; a linked profile sees itself
drop policy if exists employees_active_select on public.employees;
create policy employees_active_select on public.employees for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner() or profile_id = auth.uid())
  );

drop policy if exists employees_active_insert on public.employees;
create policy employees_active_insert on public.employees for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists employees_active_update on public.employees;
create policy employees_active_update on public.employees for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  )
  with check (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists employees_active_delete on public.employees;
create policy employees_active_delete on public.employees for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

-- templates: managers read, exec/owner write
drop policy if exists review_templates_active_select on public.review_templates;
create policy review_templates_active_select on public.review_templates for select to authenticated
  using (company_entity_id = public.active_company_id() and public.reviews_can_manage());

drop policy if exists review_templates_exec_write on public.review_templates;
create policy review_templates_exec_write on public.review_templates for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_exec_or_owner())
  with check (company_entity_id = public.active_company_id() and public.is_exec_or_owner());

drop policy if exists review_template_questions_active_select on public.review_template_questions;
create policy review_template_questions_active_select on public.review_template_questions for select to authenticated
  using (company_entity_id = public.active_company_id() and public.reviews_can_manage());

drop policy if exists review_template_questions_exec_write on public.review_template_questions;
create policy review_template_questions_exec_write on public.review_template_questions for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_exec_or_owner())
  with check (company_entity_id = public.active_company_id() and public.is_exec_or_owner());

-- reviews: manager-scoped; linked employee sees own non-draft reviews
drop policy if exists reviews_active_select on public.reviews;
create policy reviews_active_select on public.reviews for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (
      manager_user_id = auth.uid()
      or public.is_exec_or_owner()
      or (
        status <> 'draft'
        and exists (
          select 1 from public.employees e
          where e.id = reviews.employee_id and e.profile_id = auth.uid()
        )
      )
    )
  );

drop policy if exists reviews_active_insert on public.reviews;
create policy reviews_active_insert on public.reviews for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists reviews_active_update on public.reviews;
create policy reviews_active_update on public.reviews for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  )
  with check (
    company_entity_id = public.active_company_id()
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

drop policy if exists reviews_active_delete on public.reviews;
create policy reviews_active_delete on public.reviews for delete to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and status = 'draft'
    and (manager_user_id = auth.uid() or public.is_exec_or_owner())
  );

-- answers: visibility inherits the parent review's RLS via the subquery
drop policy if exists review_answers_select on public.review_answers;
create policy review_answers_select on public.review_answers for select to authenticated
  using (exists (select 1 from public.reviews r where r.id = review_answers.review_id));

drop policy if exists review_answers_write on public.review_answers;
create policy review_answers_write on public.review_answers for all to authenticated
  using (
    public.reviews_can_manage()
    and exists (
      select 1 from public.reviews r
      where r.id = review_answers.review_id
        and (r.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  )
  with check (
    public.reviews_can_manage()
    and exists (
      select 1 from public.reviews r
      where r.id = review_answers.review_id
        and (r.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  );

-- private notes: strictly author-only (not exec, not owner)
drop policy if exists review_private_notes_author on public.review_private_notes;
create policy review_private_notes_author on public.review_private_notes for all to authenticated
  using (author_user_id = auth.uid())
  with check (
    author_user_id = auth.uid()
    and public.reviews_can_manage()
    and exists (select 1 from public.reviews r where r.id = review_private_notes.review_id)
  );

-- goals: visibility inherits employees RLS (manager / exec / linked self)
drop policy if exists employee_goals_select on public.employee_goals;
create policy employee_goals_select on public.employee_goals for select to authenticated
  using (
    company_entity_id = public.active_company_id()
    and exists (select 1 from public.employees e where e.id = employee_goals.employee_id)
  );

drop policy if exists employee_goals_write on public.employee_goals;
create policy employee_goals_write on public.employee_goals for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and exists (
      select 1 from public.employees e
      where e.id = employee_goals.employee_id
        and (e.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and public.reviews_can_manage()
    and exists (
      select 1 from public.employees e
      where e.id = employee_goals.employee_id
        and (e.manager_user_id = auth.uid() or public.is_exec_or_owner())
    )
  );
