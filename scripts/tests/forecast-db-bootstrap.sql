-- Synthetic, LOCAL-ONLY foundation for the forecast candidate migration.
-- Same stance as seo-db-bootstrap.sql: only auth/profile/company helpers and
-- the upstream sales relations are fixtures here. Every
-- forecast_candidate_* / forecast_model_baselines table, policy, grant,
-- trigger and function under test comes from the repository's own migration.
create schema auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public, auth to anon, authenticated, service_role;
-- Mirror Supabase's broad default grants so a missing explicit revoke fails
-- the suite instead of passing by accident.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table auth.users (id uuid primary key);
create table public.entities (id uuid primary key, title text);
create type public.app_role as enum ('owner', 'admin', 'executive', 'user');
create table public.profiles (
  id uuid primary key references auth.users(id), name text, email text,
  role public.app_role not null default 'user', department text,
  is_active boolean not null default true,
  active_company_id uuid references public.entities(id)
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function public.active_company_id() returns uuid language sql stable security definer as $$
  select active_company_id from public.profiles where id = auth.uid();
$$;
-- Used by void_forecast_candidate_run. Same body as production's.
create function public.is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_active
    and role::text in ('owner', 'executive'));
$$;
create function public.stamp_company_entity_id() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.company_entity_id is null then
    new.company_entity_id := public.active_company_id();
  end if;
  return new;
end;
$$;

-- The upstream sales relations, at the grain the forecast functions read.
-- sales_by_day carries RLS (it does in production); the monthly rollup is a
-- real MATERIALIZED VIEW, which is the property that matters here -- a matview
-- has no RLS and is granted to nobody, which is precisely why every forecast
-- function is SECURITY DEFINER with a hand-written tenant check.
create table public.sales_by_day (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  day_date date not null,
  location_tag text not null default 'online',
  sku text,
  product_type text,
  total_quantity_sold numeric not null default 0
);
alter table public.sales_by_day enable row level security;
create policy sales_by_day_select on public.sales_by_day
  for select to authenticated using (company_entity_id = public.active_company_id());
create index sales_by_day_company_day_idx on public.sales_by_day (company_entity_id, day_date);

create materialized view public.sales_monthly_product_type_rollup_mv as
select company_entity_id,
       date_trunc('month', day_date)::date as month_start,
       coalesce(nullif(product_type, ''), 'Uncategorized') as product_type,
       sum(coalesce(total_quantity_sold, 0))::numeric as units
from public.sales_by_day
where company_entity_id is not null
group by 1, 2, 3;
create unique index sales_monthly_rollup_mv_uq
  on public.sales_monthly_product_type_rollup_mv (company_entity_id, month_start, product_type);
-- Mirror production's grants on the matview EXACTLY, verified against the live
-- database on 2026-09-17: anon and authenticated cannot select it (a matview
-- carries no RLS, so a grant there would hand every company's rows to every
-- user), service_role can. Getting this wrong in either direction makes the
-- suite lie -- too strict and a legitimate service-role read fails here but
-- works in production; too loose and the whole tenant boundary goes untested.
revoke all on public.sales_monthly_product_type_rollup_mv from anon, authenticated;
grant select on public.sales_monthly_product_type_rollup_mv to service_role;

create view public.sales_monthly_product_type_rollup_v
with (security_invoker = true) as
select month_start, product_type, units
from public.sales_monthly_product_type_rollup_mv
where company_entity_id = public.active_company_id();
grant select on public.sales_monthly_product_type_rollup_v to authenticated;

-- ── Stand-ins for 20260917180000_product_type_profile.sql ────────────────────
-- Only the shapes the classification reads. Deliberately added so the DB suite
-- can load BOTH migrations: the evaluator's positional call to a reordered
-- forecast_candidate_cycles was undetectable while the suite stopped at the
-- first migration, and that bug silently returned INSUFFICIENT_DATA for
-- forecasts that existed.
create function public.silo_business_today() returns date language sql stable as $$
  select (timezone('America/Los_Angeles', now()))::date;
$$;

create function public.is_admin_user() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role::text in ('owner','admin'));
$$;

-- A row per (type, location). PRESENCE is what says "inventory-tracked";
-- total_available_quantity may be zero (sold out) or negative (oversold).
create table public.inventory_on_hand_current_mv (
  company_entity_id uuid,
  product_type text,
  location_tag text,
  total_available_quantity numeric
);

create table public.po_lines (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid,
  product_type_snapshot text,
  qty integer
);

create table public.sales_by_product_title_daily_mv (
  company_entity_id uuid,
  product_type text,
  product_title text,
  day_date date,
  units_sold numeric
);
