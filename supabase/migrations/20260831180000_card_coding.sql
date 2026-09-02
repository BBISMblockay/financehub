-- Credit-card / card-feed coding and journal entry staging.
--
-- The shape this replaces: a spreadsheet tab per card per month, hand-coded,
-- exported into a SaaS uploader's JE template. The two things that template
-- could never do are the two things here: remember how a vendor was coded last
-- month, and check the entry before it lands in the books.
--
-- AI is the FALLBACK in this design, not the engine. Card spend is dominated by
-- repeat vendors, so a learned rule handles most rows deterministically, for
-- free, with an auditable reason. The model is asked only about merchants
-- nothing has seen before.

-- ---------------------------------------------------------------------------
-- Who may code and post
-- ---------------------------------------------------------------------------

-- Same population as the comp-request gate: owner_admin membership (or profile
-- owner), or the finance/exec departments. Deliberately NOT is_admin_user(),
-- which passes for any membership 'admin' -- 28 of 29 Baseballism profiles are
-- membership 'admin', so that gate would let nearly the whole company post
-- journal entries to the general ledger.
create or replace function public.can_manage_journal_entries()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
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

-- ---------------------------------------------------------------------------
-- Merchant normalisation
-- ---------------------------------------------------------------------------

-- Card descriptors carry noise that changes every month while the merchant does
-- not: 'AMZN Mktp US*2A4XY9', 'SQ *BLUE BOTTLE 0421', 'TST* CANTEEN - PDX'.
-- Matching on the raw string means a rule learned in November misses in
-- December. Normalising strips the parts that vary and keeps the name.
--
-- Stripping only trailing DIGITS is not enough, and fails on the vendor most
-- likely to dominate the file: 'AMZN Mktp US*2A4XY9' keeps its order code
-- because the code has letters in it, so every Amazon charge normalises to a
-- different string and no rule ever matches twice. Verified against 16 real
-- descriptor shapes -- including ones that must NOT be stripped, like
-- 'ADOBE *ACROPRO SUBS' (a product name, not a reference) and '7-ELEVEN'.
--
-- IMMUTABLE so it can back an index.
create or replace function public.normalize_merchant(p_text text)
returns text
language sql
immutable
as $$
  with s0 as (select lower(coalesce(p_text, '')) t),
  -- 1. leading processor prefix: SQ *, TST*, PAYPAL *, PY *
  s1 as (select regexp_replace(t, '^(sq|tst|sp|py|paypal|pp|ppl|dd|ec)\s*\*+\s*', '', 'i') t from s0),
  -- 2. a reference code introduced by '*': AMZN Mktp US*2A4XY9, AMAZON.COM*RT4G8.
  --    Only when the tail actually carries a digit -- ADOBE *ACROPRO SUBS is a
  --    product name, not a code, and has to survive.
  s2 as (select regexp_replace(t, '\s*\*+\s*[a-z0-9-]*[0-9][a-z0-9-]*\s*$', '', 'g') t from s1),
  -- 3. trailing store / reference digits: SHELL OIL 57443210, #0421
  s3 as (select regexp_replace(t, '\s*[#*]?\s*[0-9]{2,}\s*$', '', 'g') t from s2),
  -- 4. trailing mixed alphanumeric code of 4+ chars: ... e0800abcd
  s4 as (select regexp_replace(t, '\s+[a-z0-9]*[0-9][a-z0-9]{3,}\s*$', '', 'g') t from s3)
  select nullif(trim(regexp_replace(regexp_replace(t, '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g')), '')
  from s4;
$$;

-- ---------------------------------------------------------------------------
-- Card sources: one row per feed (Amex, Brex, Divvy, Parker, PayPal, ...)
-- ---------------------------------------------------------------------------

create table if not exists public.card_sources (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  source_key text not null,
  display_name text not null,

  -- The balancing leg. Chosen by a person from the pulled QuickBooks chart,
  -- never derived from the card's name: Baseballism's chart carries 'Parker'
  -- (Accounts Payable) AND 'Parker Card' (Credit Card), and three plausible
  -- Amex accounts across two types. Guessing picks the wrong one silently.
  credit_qbo_account_id text,
  credit_qbo_account_name text,
  credit_qbo_account_type text,

  -- QuickBooks REJECTS a JournalEntry line hitting an Accounts Payable or
  -- Accounts Receivable account unless that line carries an Entity (vendor or
  -- customer). Several of these cards settle to AP accounts, so the vendor is
  -- part of the source's configuration rather than a surprise at post time.
  credit_vendor_qbo_id text,
  credit_vendor_name text,

  default_qbo_location_id text,
  default_qbo_location_name text,

  -- CSV header -> canonical field. Every issuer exports a different shape, so
  -- this is mapped once per card and reused, rather than hardcoding one
  -- issuer's column names and breaking on the next.
  column_map jsonb not null default '{}'::jsonb,

  -- Posting stays off until a person turns this card on, after reading an entry
  -- it produced. A new card cannot reach the general ledger by accident.
  posting_enabled boolean not null default false,

  is_active boolean not null default true,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  unique (company_entity_id, source_key)
);

-- ---------------------------------------------------------------------------
-- Import batches: one upload = one journal entry
-- ---------------------------------------------------------------------------

create table if not exists public.card_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  source_id uuid not null references public.card_sources(id) on delete cascade,

  label text,
  period_start date,
  period_end date,
  -- The JE date. Their existing entries land on the period end (12/31/2025).
  entry_date date,

  file_name text,
  row_count integer not null default 0,
  total_amount numeric(14,2) not null default 0,

  status text not null default 'draft'
    check (status in ('draft', 'categorized', 'approved', 'posted', 'voided')),

  -- The staged/posted entry. quickbooks_journal_postings already carries the
  -- partial unique index that makes a double post impossible.
  posting_id uuid references public.quickbooks_journal_postings(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_card_batches_company_status
  on public.card_import_batches (company_entity_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

create table if not exists public.card_transactions (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  batch_id uuid not null references public.card_import_batches(id) on delete cascade,

  row_no integer,
  txn_date date,
  description text,
  merchant text,
  -- Positive = a charge (debits an expense). Negative = a refund or credit.
  amount numeric(14,2) not null,
  currency text default 'USD',
  cardholder text,
  last4 text,

  -- The CSV row exactly as read, so a mis-mapped column is recoverable without
  -- asking anyone to re-export a statement.
  raw jsonb,

  qbo_account_id text,
  qbo_account_name text,
  qbo_location_id text,
  qbo_location_name text,
  vendor_name text,
  memo text,

  -- How this row got its account. 'rule' and 'manual' are auditable claims;
  -- 'ai' is a suggestion that a person is expected to read.
  coding_source text check (coding_source in ('rule', 'ai', 'manual', 'default')),
  confidence numeric(4,3),
  ai_reasoning text,
  rule_id uuid,

  status text not null default 'uncoded'
    check (status in ('uncoded', 'coded', 'excluded')),
  -- A card payment, an intercompany transfer, a personal charge being
  -- reimbursed: real rows that do not belong in this entry.
  exclude_reason text,

  -- SHA-256 of source + date + amount + description: the identity of the
  -- underlying charge. On import the page checks incoming hashes against rows
  -- ALREADY STORED for that card and asks whether to skip the overlap -- it
  -- does not decide alone, because two identical charges in one statement are
  -- usually two real charges, while the same charge in two downloads is not.
  dedupe_hash text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_card_txn_batch
  on public.card_transactions (batch_id, row_no);
create index if not exists idx_card_txn_company_status
  on public.card_transactions (company_entity_id, status);
create index if not exists idx_card_txn_dedupe
  on public.card_transactions (company_entity_id, dedupe_hash)
  where dedupe_hash is not null;
create index if not exists idx_card_txn_merchant_norm
  on public.card_transactions (company_entity_id, public.normalize_merchant(description));

-- ---------------------------------------------------------------------------
-- Coding rules: the asset that accrues
-- ---------------------------------------------------------------------------

-- Every confirmation a person makes writes one of these back, so the second
-- month of a card is mostly answered before the model is asked anything.
create table if not exists public.card_coding_rules (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  -- Null = applies to every card. A vendor usually codes the same way whichever
  -- card paid it.
  source_id uuid references public.card_sources(id) on delete cascade,

  match_type text not null default 'normalized'
    check (match_type in ('exact', 'normalized', 'contains')),
  pattern text not null,

  qbo_account_id text,
  qbo_account_name text,
  qbo_location_id text,
  qbo_location_name text,
  vendor_name text,
  memo_template text,

  -- Higher wins. A card-specific rule outranks an all-cards rule by default.
  priority integer not null default 100,

  hit_count integer not null default 0,
  last_used_at timestamptz,

  is_active boolean not null default true,
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  unique (company_entity_id, source_id, match_type, pattern)
);

create index if not exists idx_card_rules_lookup
  on public.card_coding_rules (company_entity_id, is_active, priority desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

drop view if exists public.card_transactions_v;
create view public.card_transactions_v
with (security_invoker = true) as
select
  t.*,
  b.status        as batch_status,
  b.label         as batch_label,
  b.entry_date    as batch_entry_date,
  s.display_name  as source_name,
  s.source_key    as source_key,
  public.normalize_merchant(t.description) as merchant_norm
from public.card_transactions t
join public.card_import_batches b on b.id = t.batch_id
join public.card_sources s on s.id = b.source_id;

drop view if exists public.card_import_batches_v;
create view public.card_import_batches_v
with (security_invoker = true) as
select
  b.*,
  s.display_name            as source_name,
  s.source_key              as source_key,
  s.credit_qbo_account_name as credit_account_name,
  s.credit_qbo_account_type as credit_account_type,
  s.posting_enabled         as source_posting_enabled,
  cp.name                   as created_by_name,
  ap.name                   as approved_by_name,
  p.status                  as posting_status,
  p.qbo_journal_entry_id    as qbo_journal_entry_id,
  p.qbo_doc_number          as qbo_doc_number,
  (select count(*) from public.card_transactions t where t.batch_id = b.id)                            as txn_count,
  (select count(*) from public.card_transactions t where t.batch_id = b.id and t.status = 'uncoded')   as uncoded_count,
  (select count(*) from public.card_transactions t where t.batch_id = b.id and t.status = 'excluded')  as excluded_count,
  (select coalesce(sum(t.amount), 0) from public.card_transactions t
     where t.batch_id = b.id and t.status = 'coded')                                                   as coded_amount
from public.card_import_batches b
join public.card_sources s on s.id = b.source_id
left join public.profiles cp on cp.id = b.created_by
left join public.profiles ap on ap.id = b.approved_by
left join public.quickbooks_journal_postings p on p.id = b.posting_id;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.card_sources enable row level security;
alter table public.card_import_batches enable row level security;
alter table public.card_transactions enable row level security;
alter table public.card_coding_rules enable row level security;

-- Read: any active member of the company. Card coding is not secret from the
-- team, and the review UI is more useful when a budget owner can look.
-- Write: the journal-entry gate.
do $$
declare
  t text;
begin
  foreach t in array array[
    'card_sources', 'card_import_batches', 'card_transactions', 'card_coding_rules'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$
      create policy %I on public.%I for select to authenticated
      using (company_entity_id = public.active_company_id())
    $p$, t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$
      create policy %I on public.%I for all to authenticated
      using (
        company_entity_id = public.active_company_id()
        and (public.can_manage_journal_entries() or public.is_exec_or_owner())
      )
      with check (
        company_entity_id = public.active_company_id()
        and (public.can_manage_journal_entries() or public.is_exec_or_owner())
      )
    $p$, t || '_write', t);
  end loop;
end $$;

-- A posted batch is a record of what hit the ledger. Editing its lines after
-- the fact would leave SILO describing an entry QuickBooks does not have.
drop policy if exists card_transactions_write on public.card_transactions;
create policy card_transactions_write
  on public.card_transactions for all to authenticated
  using (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
    and exists (
      select 1 from public.card_import_batches b
      where b.id = card_transactions.batch_id and b.status <> 'posted'
    )
  )
  with check (
    company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner())
  );

-- ---------------------------------------------------------------------------
-- Stamping
-- ---------------------------------------------------------------------------

drop trigger if exists trg_card_sources_created_by on public.card_sources;
create trigger trg_card_sources_created_by before insert on public.card_sources
  for each row execute function public.stamp_created_by();

drop trigger if exists trg_card_batches_created_by on public.card_import_batches;
create trigger trg_card_batches_created_by before insert on public.card_import_batches
  for each row execute function public.stamp_created_by();

drop trigger if exists trg_card_rules_created_by on public.card_coding_rules;
create trigger trg_card_rules_created_by before insert on public.card_coding_rules
  for each row execute function public.stamp_created_by();

grant select on public.card_transactions_v to authenticated;
grant select on public.card_import_batches_v to authenticated;
