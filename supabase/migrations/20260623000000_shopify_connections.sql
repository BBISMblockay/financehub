-- ============================================================
-- Shopify Integration: connections, sync jobs, location mapping
-- ============================================================

-- shopify_connections: one row per company Shopify store
create table if not exists public.shopify_connections (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  shop_domain         text not null,   -- e.g. mystore.myshopify.com
  access_token        text not null,   -- Shopify Admin API token (private/custom app)
  api_version         text not null default '2024-07',
  is_active           boolean not null default true,
  last_tested_at      timestamptz,
  last_test_status    text check (last_test_status in ('ok', 'error')),
  last_test_error     text,
  shop_name           text,            -- populated on successful test
  shop_currency       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),
  updated_by          uuid references auth.users(id),
  unique (company_entity_id, shop_domain)
);

alter table public.shopify_connections enable row level security;

drop policy if exists "shopify_connections_select" on public.shopify_connections;
drop policy if exists "shopify_connections_write"  on public.shopify_connections;

create policy "shopify_connections_select" on public.shopify_connections
  for select using (company_entity_id = active_company_id());

create policy "shopify_connections_write" on public.shopify_connections
  for all using    (company_entity_id = active_company_id() and is_admin_user())
  with check       (company_entity_id = active_company_id() and is_admin_user());

-- updated_at trigger
create or replace function public.set_shopify_connections_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_shopify_connections_updated_at on public.shopify_connections;
create trigger trg_shopify_connections_updated_at
  before update on public.shopify_connections
  for each row execute function public.set_shopify_connections_updated_at();

-- -------------------------------------------------------
-- sync_jobs: tracks async Shopify sync operations
-- -------------------------------------------------------
create table if not exists public.sync_jobs (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  connection_id       uuid references public.shopify_connections(id) on delete set null,
  job_type            text not null,   -- test_connection | sync_inventory | sync_orders | ...
  status              text not null default 'pending'
                        check (status in ('pending', 'running', 'success', 'error')),
  started_at          timestamptz,
  finished_at         timestamptz,
  result              jsonb,
  error               text,
  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id)
);

alter table public.sync_jobs enable row level security;

drop policy if exists "sync_jobs_select" on public.sync_jobs;
drop policy if exists "sync_jobs_write"  on public.sync_jobs;

create policy "sync_jobs_select" on public.sync_jobs
  for select using (company_entity_id = active_company_id());

create policy "sync_jobs_write" on public.sync_jobs
  for all using    (company_entity_id = active_company_id() and is_admin_user())
  with check       (company_entity_id = active_company_id() and is_admin_user());

-- -------------------------------------------------------
-- locations: add Shopify location mapping column
-- -------------------------------------------------------
alter table public.locations
  add column if not exists shopify_location_id text;

comment on column public.locations.shopify_location_id is
  'Shopify location GID (gid://shopify/Location/…) for inventory sync mapping';
