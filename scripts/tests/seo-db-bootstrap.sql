-- Synthetic, LOCAL-ONLY foundation for the real SEO workflow migrations.
-- Same stance as finance-db/bootstrap.sql: only auth/profile/company helpers
-- and the unrelated tables the SEO migrations reference are fixtures here.
-- Every seo_* / page_inspections / search_console_* table, policy, grant,
-- trigger and RPC comes from the repository's own migration files.
create schema auth;
create schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
-- Mirror Supabase's broad default grants so a missing explicit revoke fails.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table auth.users (id uuid primary key);
create table public.entities (id uuid primary key, title text);
-- The column silo_company_timezone() (20260924130000) reads. No row means the
-- Pacific fallback, which is every synthetic company unless a test sets one.
create table public.company_settings (
  company_entity_id uuid primary key references public.entities(id),
  business_timezone text not null
);
create type public.app_role as enum ('owner', 'admin', 'executive', 'user');
create table public.profiles (
  id uuid primary key references auth.users(id), name text, email text,
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
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
-- Same body as 20260904280000; that migration also rewrites saved reports,
-- which have no place in this fixture.
create function public.silo_business_today() returns date language sql stable
  as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
grant execute on function public.silo_business_today() to authenticated;

-- Ask SILO's catalog, with the columns the SEO migrations upsert into.
create table public.silo_chat_schema_catalog (
  relname text primary key, relkind text not null,
  columns jsonb not null default '[]'::jsonb, description text, keywords text[],
  is_hidden boolean not null default false, auto_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);
-- The insert/update half of the real refresh (20260821210000): column lists
-- from pg_catalog, so the verifier's "catalog entry has no columns" check is
-- exercised here rather than trivially skipped, and its prune, which is what
-- decides whether a FUNCTION catalog row can exist at all.
create function public.refresh_chat_schema_catalog() returns integer language plpgsql security definer as $$
begin
  insert into public.silo_chat_schema_catalog (relname, relkind, columns, auto_refreshed_at)
  select c.relname,
    case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'matview' end,
    coalesce((select jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
              from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::jsonb),
    now()
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  on conflict (relname) do update
    set relkind = excluded.relkind, columns = excluded.columns,
        auto_refreshed_at = excluded.auto_refreshed_at, updated_at = now();
  -- The real function's prune: a row for anything that is not a public
  -- relation (a FUNCTION entry, for one) does not survive a refresh.
  delete from public.silo_chat_schema_catalog s
  where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = s.relname and c.relkind in ('r', 'p', 'v', 'm'));
  return 0;
end $$;

-- Unrelated tables the SEO migrations reference by name. Column sets are the
-- ones those migrations and the RPCs under test actually touch.
create table public.ad_platform_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  platform text not null, search_console_site_url text
);
create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  constraint sync_jobs_job_type_check check (job_type = any (array['shopify_sales'::text, 'ad_platform_daily'::text]))
);
create table public.shopify_landing_pages_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null, shop_domain text not null, day_date date not null,
  landing_page_path text not null, sessions bigint, sessions_with_cart_additions bigint,
  sessions_that_reached_checkout bigint, sessions_that_completed_checkout bigint,
  is_truncated boolean not null default false, synced_at timestamptz not null default now(),
  sync_batch_id text, unique (company_entity_id, shop_domain, day_date, landing_page_path)
);
alter table public.shopify_landing_pages_daily enable row level security;
create policy shopify_landing_pages_daily_select on public.shopify_landing_pages_daily
  for select to authenticated using (company_entity_id = public.active_company_id());
create table public.shopify_sessions_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null, shop_domain text not null, day_date date not null,
  sessions bigint, sessions_with_cart_additions bigint, sessions_that_reached_checkout bigint,
  sessions_that_completed_checkout bigint, source text not null default 'shopifyql',
  sync_batch_id text, synced_at timestamptz not null default now(),
  unique (company_entity_id, shop_domain, day_date)
);
alter table public.shopify_sessions_daily enable row level security;
create policy shopify_sessions_daily_select on public.shopify_sessions_daily
  for select to authenticated using (company_entity_id = public.active_company_id());
create table public.shopify_collections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  shop_domain text not null, shopify_collection_id text not null, legacy_resource_id text,
  handle text not null, title text, description text, seo_title_override text,
  seo_description_override text, is_smart_collection boolean, sort_order text,
  template_suffix text, products_count integer, published_to_online_store boolean,
  missing_since timestamptz, unique (company_entity_id, shop_domain, shopify_collection_id)
);
alter table public.shopify_collections enable row level security;
create policy shopify_collections_select on public.shopify_collections
  for select to authenticated using (company_entity_id = public.active_company_id());
