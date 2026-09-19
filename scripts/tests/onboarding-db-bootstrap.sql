-- Synthetic, LOCAL-ONLY foundation for the company-onboarding migration.
-- Not a Supabase clone: only the auth/company/catalog plumbing that predates
-- 20260918120000 is a fixture here. Every table, policy, grant, constraint and
-- function under test comes from the repository migration itself.
--
-- The shapes below are copied from PRODUCTION (information_schema /
-- pg_constraint, 2026-09-18), not from memory -- in particular
-- entity_memberships' role CHECK, which is what proves create_entity_with_owner
-- could never have worked, and accounting_settings.qbo_connection_id being NOT
-- NULL, which is why the declared currency does not live there.
create schema auth;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
-- Roles are CLUSTER-wide, not per-database. PGlite starts empty every run, but
-- a real server keeps them between runs, so creating them is guarded rather
-- than assumed. Nothing under test turns on which run created them.
do $silo_roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $silo_roles$;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
-- Mirror Supabase's broad default grants so a missing explicit revoke fails.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

create table auth.users (id uuid primary key, email text);

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  entity_type text not null,
  entity_key text not null,
  source text,
  title text,
  meta jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type public.app_role as enum ('owner', 'admin', 'executive', 'user');

create table public.profiles (
  id uuid primary key references auth.users(id),
  email text,
  name text,
  role public.app_role not null default 'user',
  department text,
  is_active boolean not null default true,
  active_company_id uuid references public.entities(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table public.entity_memberships (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text,
  constraint entity_memberships_entity_user_uniq unique (entity_id, user_id),
  constraint entity_memberships_role_check
    check (role = any (array['owner_admin','admin','member','viewer']))
);
-- 20260917220000 removed client writes to this table entirely.
revoke insert, update, delete on public.entity_memberships from authenticated, anon;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create function public.active_company_id() returns uuid language sql stable security definer as $$
  select active_company_id from public.profiles where id = auth.uid();
$$;

-- entities RLS as production holds it. This is load-bearing for onboarding:
-- config.js's ensureActiveCompany() reads `entities` to resolve the active
-- company, and SiloChrome cannot render a sidebar without it. is_entity_member
-- has NO role filter (checked against production 2026-09-18), which is why an
-- 'owner_admin' passes -- unlike is_entity_admin/is_owner_admin beside it,
-- which still test role in ('owner','admin') and so match nothing an
-- owner_admin holds.
create function public.is_entity_member(p_entity_id uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.entity_memberships
                  where entity_id = p_entity_id and user_id = auth.uid());
$$;
alter table public.entities enable row level security;
create policy entities_select_member on public.entities
  for select to authenticated using (public.is_entity_member(id));
grant select on public.entities to authenticated;

create function public.set_active_company(p_entity_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.entity_memberships
                  where entity_id = p_entity_id and user_id = auth.uid()) then
    raise exception 'Not a member of this company';
  end if;
  update public.profiles set active_company_id = p_entity_id where id = auth.uid();
end;
$$;

-- Production's definition verbatim (pg_get_functiondef, 2026-09-18).
create function public.is_admin() returns boolean language sql stable
set search_path to 'public' as $$
  select exists (
    select 1 from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','admin','executive')
          end);
$$;

create function public.is_exec_or_owner() returns boolean language sql stable security definer
set search_path to 'public' as $$
  select exists (
    select 1 from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role = 'owner_admin' or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','executive')
          end);
$$;

-- Production's body verbatim (supabase/migrations/20260831180000_card_coding.sql).
-- It is in the fixture because finding 1 of the cycle-1 review turns on its
-- LAST clause: `or p.department in ('finance','exec')` admits on the GLOBAL
-- profile department alone, with no reference to the active company's
-- membership. That is what made writing department='exec' during company
-- founding an escalation inside every OTHER company the user belongs to.
create function public.can_manage_journal_entries() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        case when em.role is not null
             then em.role = 'owner_admin'
             else p.role::text = 'owner'
        end
        or p.department in ('finance','exec')
      )
  );
$$;

-- The dead function this migration drops, reproduced exactly as production
-- holds it (role 'owner', which the CHECK above forbids) so the test can prove
-- both that it was broken and that it is gone.
create function public.create_entity_with_owner(
  p_module text, p_entity_type text, p_entity_key text,
  p_source text default null, p_title text default null, p_meta jsonb default '{}'::jsonb)
returns public.entities language plpgsql security definer set search_path to 'public' as $$
declare v_entity public.entities;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
  values (p_module, p_entity_type, p_entity_key, p_source, p_title, coalesce(p_meta,'{}'::jsonb), auth.uid())
  returning * into v_entity;
  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_entity.id, auth.uid(), 'owner') on conflict do nothing;
  return v_entity;
end;
$$;

-- handle_new_user as 20260714190000 left it: the org_name founding branch this
-- migration removes. The trigger is real so the test can sign a user up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_org_name text; v_key text; v_entity_id uuid;
begin
  v_org_name := nullif(trim(coalesce(new.raw_user_meta_data->>'org_name', '')), '');
  if v_org_name is null then
    insert into public.profiles (id, email, name)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null))
    on conflict (id) do update set email = excluded.email;
    return new;
  end if;
  v_key := trim(both '-' from regexp_replace(lower(v_org_name), '[^a-z0-9]+', '-', 'g'));
  if v_key = '' then v_key := 'org'; end if;
  insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
  values ('finance_hub', 'company', v_key, 'self_signup', v_org_name,
          jsonb_build_object('self_signup', true), new.id)
  returning id into v_entity_id;
  insert into public.profiles (id, email, name, role, department, is_active, active_company_id)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null),
          'owner'::app_role, 'exec', true, v_entity_id)
  on conflict (id) do update set email = excluded.email, role = excluded.role,
    department = excluded.department, is_active = true,
    active_company_id = excluded.active_company_id;
  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_entity_id, new.id, 'owner_admin')
  on conflict (entity_id, user_id) do update set role = excluded.role;
  return new;
end;
$$;

alter table auth.users add column raw_user_meta_data jsonb default '{}'::jsonb;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Mirror production's anon grants EXACTLY (measured 2026-09-18 via
-- has_function_privilege). The fixture's `alter default privileges` above
-- reproduces Supabase's habit of granting EXECUTE to anon on every new
-- function, which is the hazard under test -- but production has since revoked
-- three of these, and a fixture LOOSER than production reports violations the
-- database does not have. Production keeps anon on can_manage_journal_entries,
-- handle_new_user and is_entity_member (all three are on the reviewed allowlist
-- in verify_v2_schema.sql) and revokes it on the three below.
revoke execute on function public.active_company_id() from public, anon;
revoke execute on function public.is_exec_or_owner() from public, anon;
revoke execute on function public.set_active_company(uuid) from public, anon;

-- Pacific-anchored helpers as 20260904280000 left them, so the test can show
-- the company-aware versions replacing them without changing Pacific's answer.
create function public.silo_business_today() returns date language sql stable
as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
create function public.silo_business_yesterday() returns date language sql stable
as $$ select (now() at time zone 'America/Los_Angeles')::date - 1 $$;

-- accounting_settings: production's NOT NULL shape, which is the whole reason
-- the declared currency cannot live in base_currency.
create table public.accounting_settings (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null unique references public.entities(id),
  qbo_connection_id uuid not null,
  base_currency text not null,
  fiscal_year_start_month integer not null default 1,
  accounting_start_date date not null default current_date,
  accounting_basis text not null default 'accrual',
  books_authority text not null default 'qbo',
  created_at timestamptz not null default now()
);

create table public.silo_chat_audit_log (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid,
  question text not null,
  answer text,
  queries_run text[] not null default '{}',
  tool_rounds integer,
  status text not null default 'ok',
  error_message text,
  created_at timestamptz not null default now()
);
alter table public.silo_chat_audit_log enable row level security;
create policy chat_audit_select on public.silo_chat_audit_log
  for select to authenticated using (company_entity_id = public.active_company_id());
grant select on public.silo_chat_audit_log to authenticated;

create table public.silo_chat_schema_catalog (
  relname text primary key, is_hidden boolean, keywords text[], description text
);
create function public.refresh_chat_schema_catalog() returns void language plpgsql as $$
begin
  insert into public.silo_chat_schema_catalog (relname)
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v','m')
  on conflict (relname) do nothing;
end;
$$;
