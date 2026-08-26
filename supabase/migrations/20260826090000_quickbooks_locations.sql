-- QuickBooks locations: the dimension journal entries get tagged with, so one
-- revenue account serves every store instead of one account per store.
--
-- Baseballism runs 28 active locations. Per-location ACCOUNTS would mean 56
-- accounts for revenue and refunds alone, which is why accounting_coa_map's
-- revenue_template/refunds_template keys carry a {location} placeholder today.
-- Tagging a line with a location replaces that entirely: one account id, plus
-- a location reference per line.
--
-- NAMING: QuickBooks calls this "Location" in its UI and `Department` in its
-- API (the UI label is even renameable -- Location / Division / Store /
-- Territory). Everything here is named `location`, matching what a human sees
-- in QuickBooks; only the API calls in quickbooks-accounts-sync say
-- Department. Do not confuse this with QBO `Class`, a separate dimension SILO
-- does not use.

create table if not exists public.quickbooks_locations (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.quickbooks_connections(id) on delete cascade,
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  -- QBO Department.Id
  qbo_location_id text not null,
  name text not null,
  -- "Parent:Child" path for a sub-location, same shape as an account's
  -- FullyQualifiedName.
  fully_qualified_name text,
  is_active boolean not null default true,

  synced_at timestamptz not null default now()
);

create unique index if not exists uq_quickbooks_locations_connection_location
  on public.quickbooks_locations (connection_id, qbo_location_id);

create index if not exists idx_quickbooks_locations_company
  on public.quickbooks_locations (company_entity_id, is_active);

alter table public.quickbooks_locations enable row level security;

-- No credentials here, and the mapping UI on Accounting Export is not
-- admin-only -- same stance as quickbooks_accounts.
drop policy if exists quickbooks_locations_active_select on public.quickbooks_locations;
create policy quickbooks_locations_active_select
  on public.quickbooks_locations for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- Location tracking is a QBO preference (and a Plus/Advanced feature). When it
-- is off, Department returns nothing -- indistinguishable from "enabled but
-- none created" unless we record the preference itself. Without this the
-- mapping UI would show an empty dropdown and no reason why.
alter table public.quickbooks_connections
  add column if not exists location_tracking_enabled boolean;

comment on column public.quickbooks_connections.location_tracking_enabled is
  'QBO Preferences.AccountingInfoPrefs.TrackDepartments, read by quickbooks-accounts-sync. Null = not yet checked; false = location tracking is off in QuickBooks, so no locations can exist.';

-- Maps a SILO sales location to a QBO location.
--
-- Keyed on sales_by_day's `location_tag`, NOT locations.location_code.
-- Measured 2026-08-26 over 12 months of sales: 19 distinct location_tags, only
-- 10 matching a locations.location_code exactly, and 3 (field_of_dreams,
-- st_louis, mission_viejo) not matching even case-insensitively, because
-- location_code is inconsistently formatted (snake_case for some rows, Title
-- Case with spaces and periods for others). Routing the mapping through
-- `locations` would therefore drop real revenue locations silently. location_tag
-- is what accounting_sales_buckets() actually emits and what the journal is
-- built from, so it is the honest key. Fixing locations.location_code is a
-- separate cleanup and does not block this.
create table if not exists public.accounting_location_map (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  location_tag text not null,
  qbo_location_id text,
  -- Denormalized so a mapping whose QBO location was archived still renders as
  -- a name to flag rather than a bare id.
  qbo_location_name text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create unique index if not exists uq_accounting_location_map_company_tag
  on public.accounting_location_map (company_entity_id, location_tag);

alter table public.accounting_location_map enable row level security;

drop policy if exists accounting_location_map_active_select on public.accounting_location_map;
create policy accounting_location_map_active_select
  on public.accounting_location_map for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- Same write gate as accounting_coa_map: any active member of the company can
-- maintain the mapping, since this is the finance team's own working data and
-- the page is already scoped to them.
drop policy if exists accounting_location_map_active_write on public.accounting_location_map;
create policy accounting_location_map_active_write
  on public.accounting_location_map for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.accounting_location_map;
create trigger stamp_created_by
  before insert on public.accounting_location_map
  for each row execute function public.stamp_created_by();

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['quickbooks location','qbo location','department','store mapping','location mapping','journal location'],
  description = $d$QuickBooks Online locations (QBO's "Location" dimension, called Department in its API), mirrored by the quickbooks-accounts-sync edge function. A journal line is tagged with a location instead of using a separate per-store revenue account -- Baseballism has 28 active locations, so per-location accounts would not scale. Join accounting_location_map.qbo_location_id to see which SILO sales location posts to which QBO location. Read-only mirror; SILO does not create locations in QuickBooks.$d$
where relname = 'quickbooks_locations';

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['location mapping','store mapping','location tag','qbo location','accounting export locations'],
  description = $d$Maps a SILO sales location (sales_by_day.location_tag, the same key accounting_sales_buckets() emits) to a QuickBooks location id, for tagging posted journal lines. Deliberately keyed on location_tag rather than locations.location_code: location_code is inconsistently formatted and only 10 of 19 tags match it exactly, so routing through the locations table would silently drop real revenue locations.$d$
where relname = 'accounting_location_map';
