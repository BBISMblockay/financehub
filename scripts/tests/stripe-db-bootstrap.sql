-- Synthetic, LOCAL-ONLY foundation for 20260919120000_stripe_billing_and_connect.
-- Not a Supabase clone: only the auth/company plumbing that predates the
-- migration is a fixture here. Every table, policy, grant, constraint and
-- function under test comes from the repository migration itself.
--
-- The helper bodies below are production's, copied from the migrations that
-- define them (is_admin_user: 20260904220000, can_manage_journal_entries:
-- 20260831180000, is_exec_or_owner / active_company_id / stamp triggers:
-- 20260616060000 and 20260918120000). is_admin_user in particular must be the
-- real one, because the whole argument for can_manage_client_invoices() being
-- a separate, narrower gate is that a membership 'admin' passes is_admin_user()
-- -- a fixture that got that wrong would make the two gates look identical and
-- the test would prove nothing.
create schema auth;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;

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
-- Mirror Supabase's broad default grants, so a missing explicit revoke in the
-- migration FAILS here rather than passing on a stricter-than-production fixture.
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

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create function public.active_company_id() returns uuid language sql stable security definer as $$
  select active_company_id from public.profiles where id = auth.uid();
$$;

create function public.is_admin_user() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin')
            else p.role::text in ('owner','admin')
          end
  );
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

create function public.is_owner_admin_of_active_company() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = auth.uid()
      and em.entity_id = public.active_company_id()
      and em.role = 'owner_admin'
  );
$$;

-- 20260616060000, verbatim in behaviour: the company stamp the migration's
-- closing attach_stamp_company_entity_id_triggers() call depends on.
create function public.stamp_company_entity_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.company_entity_id is null then
    new.company_entity_id := public.active_company_id();
  end if;
  return new;
end;
$$;

create function public.attach_stamp_company_entity_id_triggers() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'company_entity_id'
       and t.table_type = 'BASE TABLE'
  loop
    execute format(
      'drop trigger if exists stamp_company_entity_id on public.%I;
       create trigger stamp_company_entity_id before insert on public.%I
         for each row execute function public.stamp_company_entity_id()',
      r.table_name, r.table_name);
  end loop;
end;
$$;

-- Mirrors 20260821210000's real shape, NOT a convenient subset. `relkind` is
-- NOT NULL there with no default, and this stub omitted it -- so a catalog
-- insert that forgets it passed here and FAILED on the real database (found
-- applying to production, 2026-09-19). A fixture more permissive than
-- production is a fixture that certifies migrations it has not tested.
create table public.silo_chat_schema_catalog (
  relname text primary key,
  relkind text not null,
  columns jsonb not null default '[]'::jsonb,
  description text,
  keywords text[],
  is_hidden boolean not null default false,
  auto_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);
create function public.refresh_chat_schema_catalog() returns void language plpgsql as $$
begin
  insert into public.silo_chat_schema_catalog (relname, relkind, auto_refreshed_at)
  select c.relname, c.relkind::text, now()
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v','m')
  on conflict (relname) do update
    -- The real function writes relkind back from pg_catalog, which is what
    -- silently corrected a hand-supplied value in production.
    set relkind = excluded.relkind,
        auto_refreshed_at = excluded.auto_refreshed_at;
end;
$$;
