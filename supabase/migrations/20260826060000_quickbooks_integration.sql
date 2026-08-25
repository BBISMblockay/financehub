-- QuickBooks Online integration, phase 1-2: connect a QBO company, pull its
-- chart of accounts, and let Accounting Export map to real QBO account IDs
-- instead of hand-typed account-name strings.
--
-- Why account IDs and not names: QBO's JournalEntry API addresses accounts by
-- AccountRef.value (the QBO account id). A typed name is unverifiable until
-- post time, where it either 400s or -- worse -- fuzzy-matches the wrong
-- account. accounting_coa_map keeps account_name (the CSV export still emits
-- names, and stays useful with no QBO connection) and gains qbo_account_id as
-- the authority whenever a connection exists.
--
-- Token shape is NOT the shopify_connections shape. QBO access tokens live 1
-- hour and the refresh token ROTATES on every refresh with a ~100-day window.
-- Failing to persist the rotated refresh token silently bricks the connection
-- until someone reconnects by hand, so refresh_token/token_expires_at/
-- refresh_token_expires_at are all written on every refresh, not just at
-- connect time.

create table if not exists public.quickbooks_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  -- QBO's own company id, returned by the OAuth callback as realmId. One
  -- realm == one QBO company file; there is no multi-company realm.
  realm_id text not null,
  company_name text,

  -- 'sandbox' hits quickbooks.api.intuit.com's sandbox host and Intuit's
  -- test company; 'production' touches a real general ledger. Kept per-row so
  -- a sandbox connection can be proven before a production one is added.
  environment text not null default 'sandbox'
    check (environment in ('sandbox', 'production')),

  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,

  is_active boolean not null default true,

  accounts_synced_at timestamptz,
  last_tested_at timestamptz,
  last_test_status text,
  last_test_success boolean,
  last_test_error text,

  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

-- Reconnecting the same QBO company must update the existing row (and its
-- rotated tokens), never mint a second one -- unlike ad_platform_connections,
-- where a company may legitimately run several accounts per platform.
create unique index if not exists uq_quickbooks_connections_company_realm
  on public.quickbooks_connections (company_entity_id, realm_id);

-- Single-use 10-minute CSRF nonces for the OAuth handshake. RLS on with no
-- policies at all: service-role only, matching shopify_oauth_states and
-- ad_platform_oauth_states.
create table if not exists public.quickbooks_oauth_states (
  nonce             text primary key,
  company_entity_id uuid not null references public.entities(id),
  user_id           uuid not null references auth.users(id),
  environment       text not null default 'sandbox'
    check (environment in ('sandbox', 'production')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '10 minutes')
);

alter table public.quickbooks_oauth_states enable row level security;

-- Mirror of the QBO chart of accounts, refreshed by quickbooks-accounts-sync.
-- Read by the Accounting Export mapping UI so the dropdown offers real
-- accounts; no client ever writes here.
create table if not exists public.quickbooks_accounts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.quickbooks_connections(id) on delete cascade,
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  qbo_account_id text not null,
  name text not null,
  -- QBO's own display path for a sub-account, e.g. "COGS:Freight". This is
  -- what a human recognizes when two sub-accounts share a leaf name.
  fully_qualified_name text,
  account_type text,
  account_sub_type text,
  classification text,
  currency text,
  is_active boolean not null default true,

  synced_at timestamptz not null default now()
);

create unique index if not exists uq_quickbooks_accounts_connection_account
  on public.quickbooks_accounts (connection_id, qbo_account_id);

create index if not exists idx_quickbooks_accounts_company
  on public.quickbooks_accounts (company_entity_id, is_active);

alter table public.quickbooks_connections enable row level security;
alter table public.quickbooks_accounts enable row level security;

-- Row carries live OAuth tokens, so SELECT is admin-gated to match the write
-- policy -- same treatment as ad_platform_connections and
-- redo_connections.webhook_secret. Edge functions use the service-role key
-- and are unaffected.
drop policy if exists quickbooks_connections_admin_select on public.quickbooks_connections;
create policy quickbooks_connections_admin_select
  on public.quickbooks_connections for select
  to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user());

drop policy if exists quickbooks_connections_admin_write on public.quickbooks_connections;
create policy quickbooks_connections_admin_write
  on public.quickbooks_connections for all
  to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

-- Accounts carry no credentials and the mapping UI on Accounting Export is
-- not admin-only, so any active member of the company may read them.
drop policy if exists quickbooks_accounts_active_select on public.quickbooks_accounts;
create policy quickbooks_accounts_active_select
  on public.quickbooks_accounts for select
  to authenticated
  using (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.quickbooks_connections;
create trigger stamp_created_by
  before insert on public.quickbooks_connections
  for each row execute function public.stamp_created_by();

-- Additive on accounting_coa_map: account_name stays the CSV export's source
-- and the fallback with no QBO connection; qbo_account_id is what a future
-- journal post will address. qbo_account_name is a denormalized copy kept so
-- the UI can render a mapping whose account was archived in QBO (and flag it)
-- rather than showing a bare id.
alter table public.accounting_coa_map
  add column if not exists qbo_account_id text,
  add column if not exists qbo_account_name text;

comment on column public.accounting_coa_map.qbo_account_id is
  'QBO Account.Id this map key posts to. Null until a QuickBooks connection exists; account_name remains the CSV export authority either way.';

-- accounting_coa_map held the pre-rename account names while the Accounting
-- Export page rewrote them in memory on every load (a LEGACY_RENAMES lookup),
-- so the stored rows and the page never agreed. That masking is removed in
-- this change, which would otherwise regress the CSV export to the old names
-- -- so promote the stored values to the ones the page was already emitting.
-- Safe to do unconditionally: nothing has been filed from these exports, and
-- the update is scoped to rows still holding the exact superseded string.
update public.accounting_coa_map set account_name = 'Retail Revenue - Shopify ({location})'
  where account_name = 'In Store Retail Revenue - Shopify ({location})';
update public.accounting_coa_map set account_name = 'Shipping Revenue - Shopify'
  where account_name = 'Freight Revenue';
update public.accounting_coa_map set account_name = 'Sales Refunds - Shopify ({location})'
  where account_name = 'Sales Refunds - ({location})';
-- Discounts are contra-revenue, not cost of goods.
update public.accounting_coa_map set account_name = 'Sales Discounts - Shopify'
  where account_name = 'COGS - Sales Discounts';
-- Sales tax is a pass-through liability, not cost of goods.
update public.accounting_coa_map set account_name = 'Sales Tax Clearing'
  where account_name = 'COGS - Sales Tax Liability';
-- Shopify deposits clear through their own account so they never commingle
-- with real wholesale AR.
update public.accounting_coa_map set account_name = 'Shopify Clearing'
  where account_name = 'Accounts Receivable';
update public.accounting_coa_map set account_name = 'Shopify Processing Fees'
  where account_name = 'COGS - Processing Fees';
