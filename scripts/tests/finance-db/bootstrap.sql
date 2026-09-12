-- Synthetic, LOCAL-ONLY foundation for the real finance dependency migrations.
-- This is not a Supabase project clone. Only auth/profile/company helpers and
-- unrelated schema-catalog plumbing are fixtures; every finance table, policy,
-- grant, constraint, approval/hash/void function comes from repository SQL.
create schema auth;
create schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
-- Mirror Supabase's broad default grants so missing explicit revokes fail tests.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table auth.users (id uuid primary key);
create table public.entities (id uuid primary key, title text);
create type public.app_role as enum ('owner', 'admin', 'executive', 'user');
create table public.profiles (
  id uuid primary key references auth.users(id), name text,
  role public.app_role not null default 'user', department text,
  is_active boolean not null default true,
  active_company_id uuid references public.entities(id)
);
create table public.entity_memberships (
  entity_id uuid references public.entities(id),
  user_id uuid references auth.users(id), role text,
  primary key (entity_id, user_id)
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function public.active_company_id() returns uuid language sql stable security definer as $$
  select active_company_id from public.profiles where id = auth.uid();
$$;
create function public.is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_active
    and role::text in ('owner', 'executive'));
$$;
create function public.is_admin_user() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_active
    and role::text in ('owner', 'executive', 'admin'));
$$;
create function public.stamp_created_by() returns trigger language plpgsql as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end;
$$;

-- Unrelated migrations update catalog descriptions and legacy COA mappings.
create table public.accounting_coa_map (id uuid primary key, account_name text);
create table public.silo_chat_schema_catalog (
  relname text primary key, is_hidden boolean, keywords text[], description text
);
create function public.refresh_chat_schema_catalog() returns void language sql as $$ select; $$;
