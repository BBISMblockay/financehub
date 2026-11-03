-- Windsor: store ANY connector, not only the ones SILO has a hand-made
-- mapping for. Builds on 20261103060000 (windsor_sync).
--
-- scripts/windsor-sync.mjs reads Windsor's public field list for each
-- connector (https://connectors.windsor.ai/<connector>/fields) and asks for
-- every numeric field it lists, in batches. Where the rows go is decided by
-- the connector's SHAPE, not by a list of names:
--
--   ad-like (it has spend, impressions, clicks and a campaign) ->
--     public.marketing_kpis_daily, platform = '<connector>_ads' (bing ->
--     'microsoft_ads'), source 'windsor'. Marketing Explorer
--     (marketing_facts_daily_v) and MER (v_marketing_mer_daily) read every
--     platform, so they pick these up. So that a new ad platform needs no
--     migration, the platform CHECK becomes a name-shape check.
--   anything else -> public.windsor_metrics_daily (new): common typed
--     columns plus every other numeric field in `metrics`.
--
-- Meta, Google Ads and GA4 through Windsor never go to marketing_kpis_daily:
-- SILO syncs those directly, and two copies under different identities would
-- be counted twice. They land in windsor_metrics_daily.
--
-- Written only by the sync (service role). Applying this turns nothing on.

-- ── marketing_kpis_daily.platform: any well-formed platform name ────────────
alter table public.marketing_kpis_daily
  drop constraint if exists marketing_kpis_daily_platform_check;
alter table public.marketing_kpis_daily
  add constraint marketing_kpis_daily_platform_check
  check (platform ~ '^[a-z][a-z0-9_]{1,63}$');

-- ── Fields Windsor refused, by name, so a gap is visible ────────────────────
alter table public.windsor_linked_accounts
  add column if not exists refused_fields text[] not null default '{}';

-- ── Every other connector ───────────────────────────────────────────────────
create table if not exists public.windsor_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  ds_id text not null,
  account_id text not null,
  account_name text,
  day_date date not null,
  -- 'account' = the account's daily totals; 'campaign' = one campaign's.
  object_type text not null,
  object_id text not null default '',
  object_name text,
  -- Common measures, filled when the connector has a field that means this.
  -- NULL = the connector has no such field or did not report it, never zero.
  impressions numeric,
  clicks numeric,
  spend numeric,
  conversions numeric,
  revenue numeric,
  sends numeric,
  delivered numeric,
  opens numeric,
  sessions numeric,
  users numeric,
  orders numeric,
  -- Every numeric field Windsor returned for the row, by field id.
  metrics jsonb not null default '{}'::jsonb,
  source text not null default 'windsor',
  row_hash text not null,
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  constraint windsor_metrics_daily_row_hash_key unique (row_hash),
  constraint windsor_metrics_daily_object_type_check check (object_type in ('account', 'campaign'))
);

create index if not exists idx_windsor_metrics_daily_company_day
  on public.windsor_metrics_daily (company_entity_id, ds_id, day_date);

alter table public.windsor_metrics_daily enable row level security;

revoke all on public.windsor_metrics_daily from anon, authenticated;
grant select on public.windsor_metrics_daily to authenticated;
grant all on public.windsor_metrics_daily to service_role;

drop policy if exists windsor_metrics_daily_active_select on public.windsor_metrics_daily;
create policy windsor_metrics_daily_active_select on public.windsor_metrics_daily
  for select to authenticated
  using (company_entity_id = (select public.active_company_id()));

select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('windsor_metrics_daily', 'r', '[]'::jsonb,
   'Daily numbers from any data source connected through Windsor.ai that has no '
   'table of its own (email, reviews, analytics, Shopify-through-Windsor, and '
   'Meta / Google Ads / GA4 when connected through Windsor instead of directly). '
   'One row per data source (ds_id) x account x object x day. object_type '
   '''account'' is the account''s daily total; ''campaign'' rows are parts of it, '
   'so never add the two together. The typed columns (impressions, clicks, spend, '
   'conversions, revenue, sends, delivered, opens, sessions, users, orders) are '
   'filled only when the source has a field meaning that; NULL means not '
   'reported, never zero. metrics holds every numeric field the source returned, '
   'by Windsor field id. revenue and conversions are what the source CLAIMS: '
   'they overlap net sales and each other, so never add them to either. Ad '
   'platforms other than Meta/Google are in marketing_kpis_daily (source '
   '''windsor''), not here.',
   array['windsor','email','reviews','analytics','metrics','connector'])
on conflict (relname) do nothing;

-- ── A company's own field choices ───────────────────────────────────────────
-- For a connector mapped automatically, which Windsor field fills which SILO
-- measure. The sync picks one itself (the first field of a known name); an
-- admin overrides it here from /v2/windsor-test.html, e.g. "for Pinterest,
-- conversions = total_conversions". field_id NULL = leave that measure blank.
-- Per company: one company's choice never changes another's numbers.
create table if not exists public.windsor_field_mappings (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  ds_id text not null,
  measure text not null,
  field_id text,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint windsor_field_mappings_one unique (company_entity_id, ds_id, measure),
  constraint windsor_field_mappings_ds_check check (ds_id ~ '^[a-z0-9_]{1,64}$'),
  constraint windsor_field_mappings_field_check check (field_id is null or field_id ~* '^[a-z0-9_.]{1,64}$'),
  constraint windsor_field_mappings_measure_check check (measure in (
    'impressions', 'clicks', 'spend', 'conversions', 'revenue',
    'sends', 'delivered', 'opens', 'sessions', 'users', 'orders'))
);

alter table public.windsor_field_mappings enable row level security;

revoke all on public.windsor_field_mappings from anon, authenticated;
grant select, insert, update, delete on public.windsor_field_mappings to authenticated;
grant all on public.windsor_field_mappings to service_role;

-- The same people who may see this company's Windsor accounts
-- (windsor_linked_accounts_admin_select).
drop policy if exists windsor_field_mappings_admin_all on public.windsor_field_mappings;
create policy windsor_field_mappings_admin_all on public.windsor_field_mappings
  for all to authenticated
  using (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()))
  with check (company_entity_id = (select public.active_company_id()) and (select public.is_admin_user()));

-- A changed mapping changes what every stored day means, so that connector's
-- history is pulled again for that company on the next runs. Only the
-- bookkeeping column is touched, only for the mapping row's own company
-- (which the policy above has already confined to the caller's).
create or replace function public.windsor_field_mappings_rewind()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  co uuid;
  ds text;
begin
  if tg_op = 'DELETE' then co := old.company_entity_id; ds := old.ds_id;
  else co := new.company_entity_id; ds := new.ds_id;
  end if;
  update public.windsor_linked_accounts
     set history_from = null
   where company_entity_id = co
     and ds_id = ds;
  return null;
end $$;

revoke all on function public.windsor_field_mappings_rewind() from public, anon, authenticated;

drop trigger if exists windsor_field_mappings_rewind on public.windsor_field_mappings;
create trigger windsor_field_mappings_rewind
  after insert or update or delete on public.windsor_field_mappings
  for each row execute function public.windsor_field_mappings_rewind();

select public.attach_stamp_company_entity_id_triggers();
