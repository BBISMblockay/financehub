-- QuickBooks customers and vendors, and a per-LINE entity on card coding.
--
-- Why this is not optional. Baseballism's chart carries ~26 intercompany
-- receivables -- 'Sugar Hill Receivable', 'La Palma Receivable', 'Two Wrongs
-- Receivable', 'COLAB Receivable', 'Jackie's Receivable', 'Due From LFRE/RFRE'
-- and so on -- and card spend on behalf of those entities is coded TO them
-- rather than to an expense. Two things followed from that:
--
-- 1. Every one of those accounts is account_type 'Accounts Receivable', and
--    QuickBooks REJECTS a JournalEntry line on an AR or AP account unless that
--    line carries an Entity. Until now SILO could only put an entity on the
--    card's own balancing leg, so any attempt to code a row to an
--    intercompany receivable would have been refused by Intuit with an opaque
--    error after the person had already coded the whole file.
--
-- 2. Nothing in SILO knew what customers or vendors exist, so there was no id
--    to put there. Hence these two tables.

create table if not exists public.quickbooks_customers (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.quickbooks_connections(id) on delete set null,
  qbo_customer_id text not null,
  display_name text,
  company_name text,
  email text,
  is_active boolean not null default true,
  raw jsonb,
  synced_at timestamptz not null default now(),
  unique (company_entity_id, qbo_customer_id)
);

create table if not exists public.quickbooks_vendors (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.quickbooks_connections(id) on delete set null,
  qbo_vendor_id text not null,
  display_name text,
  company_name text,
  email text,
  is_active boolean not null default true,
  raw jsonb,
  synced_at timestamptz not null default now(),
  unique (company_entity_id, qbo_vendor_id)
);

create index if not exists idx_qbo_customers_company
  on public.quickbooks_customers (company_entity_id, is_active);
create index if not exists idx_qbo_vendors_company
  on public.quickbooks_vendors (company_entity_id, is_active);

alter table public.quickbooks_customers enable row level security;
alter table public.quickbooks_vendors enable row level security;

-- Read: any active member -- these are names, not credentials, and the coding
-- UI needs them. Write: service-role sync only, so no client policy exists.
drop policy if exists qbo_customers_select on public.quickbooks_customers;
create policy qbo_customers_select on public.quickbooks_customers
  for select to authenticated using (company_entity_id = public.active_company_id());

drop policy if exists qbo_vendors_select on public.quickbooks_vendors;
create policy qbo_vendors_select on public.quickbooks_vendors
  for select to authenticated using (company_entity_id = public.active_company_id());

-- The entity on ONE coded line, not on the whole entry. A single Divvy import
-- can carry rows for four different related entities.
alter table public.card_transactions
  add column if not exists entity_qbo_id text,
  add column if not exists entity_name text,
  add column if not exists entity_type text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.card_transactions'::regclass
                    and conname = 'card_transactions_entity_type_check') then
    alter table public.card_transactions
      add constraint card_transactions_entity_type_check
      check (entity_type is null or entity_type in ('Customer', 'Vendor'));
  end if;
end $$;

-- A learned rule carries the entity too. 'the COLAB card codes to COLAB
-- Receivable for customer COLAB' has to survive as one fact, or the entity has
-- to be re-picked by hand every month on rows the rule already coded.
alter table public.card_coding_rules
  add column if not exists entity_qbo_id text,
  add column if not exists entity_name text,
  add column if not exists entity_type text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.card_coding_rules'::regclass
                    and conname = 'card_coding_rules_entity_type_check') then
    alter table public.card_coding_rules
      add constraint card_coding_rules_entity_type_check
      check (entity_type is null or entity_type in ('Customer', 'Vendor'));
  end if;
end $$;

-- Which accounts REQUIRE an entity on their line. Kept as a function rather
-- than a hardcoded list in three places (page, post function, verify), since
-- getting it wrong means Intuit refuses the entry at post time.
create or replace function public.qbo_account_needs_entity(p_account_type text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_account_type, '') in ('Accounts Receivable', 'Accounts Payable');
$$;

grant select on public.quickbooks_customers to authenticated;
grant select on public.quickbooks_vendors to authenticated;
