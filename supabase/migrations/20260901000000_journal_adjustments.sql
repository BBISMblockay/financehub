-- Ad-hoc journal entries, raised where the problem is noticed.
--
-- The gap this closes: prepaid amortisation, accruals, reclasses and any
-- adjustment spotted while reconciling still went out through the old
-- spreadsheet uploader, because the only thing SILO could post was a coded
-- card batch. Reconciling in a report and then leaving the app to fix what you
-- just found is the whole friction.
--
-- These STAGE before they post, exactly as card batches do, rather than the
-- browser handing a finished entry to Intuit. That is deliberate and costs a
-- click: an adjustment to the general ledger should exist as a record with an
-- author and a stated reason BEFORE it exists in the books, and staging is
-- also what lets quickbooks-post-journal keep its one real guarantee -- the
-- entry it posts is rebuilt from the database, never taken from a page.

create table if not exists public.journal_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  entry_date date not null,
  -- Goes to QuickBooks as the entry's PrivateNote, so "why" travels with the
  -- entry rather than living only in SILO.
  memo text not null,

  -- Where it was raised from: 'qbo-reports:GeneralLedger', 'schedules:<id>'.
  -- Free text on purpose -- a new surface should not need a migration.
  source_context text,

  status text not null default 'draft'
    check (status in ('draft', 'approved', 'posted', 'voided')),

  posting_id uuid references public.quickbooks_journal_postings(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null
);

create table if not exists public.journal_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  adjustment_id uuid not null references public.journal_adjustments(id) on delete cascade,

  line_no integer not null,

  qbo_account_id text not null,
  qbo_account_name text,

  -- QuickBooks takes a positive Amount plus a side, not a signed number.
  -- Storing it the same way means the post is a copy, not a reinterpretation.
  posting_type text not null check (posting_type in ('Debit', 'Credit')),
  amount numeric(14,2) not null check (amount > 0),

  description text,
  qbo_location_id text,
  qbo_location_name text,

  -- QuickBooks rejects a line on an AR or AP account without one.
  entity_qbo_id text,
  entity_name text,
  entity_type text check (entity_type is null or entity_type in ('Customer', 'Vendor')),

  created_at timestamptz not null default now()
);

create index if not exists idx_journal_adj_company_status
  on public.journal_adjustments (company_entity_id, status, created_at desc);
create index if not exists idx_journal_adj_lines_parent
  on public.journal_adjustment_lines (adjustment_id, line_no);

drop view if exists public.journal_adjustments_v;
create view public.journal_adjustments_v
with (security_invoker = true) as
select
  a.*,
  cp.name as created_by_name,
  ap.name as approved_by_name,
  p.status as posting_status,
  p.qbo_journal_entry_id,
  p.qbo_doc_number,
  (select count(*) from public.journal_adjustment_lines l where l.adjustment_id = a.id) as line_count,
  (select coalesce(sum(l.amount), 0) from public.journal_adjustment_lines l
     where l.adjustment_id = a.id and l.posting_type = 'Debit') as debits,
  (select coalesce(sum(l.amount), 0) from public.journal_adjustment_lines l
     where l.adjustment_id = a.id and l.posting_type = 'Credit') as credits
from public.journal_adjustments a
left join public.profiles cp on cp.id = a.created_by
left join public.profiles ap on ap.id = a.approved_by
left join public.quickbooks_journal_postings p on p.id = a.posting_id;

alter table public.journal_adjustments enable row level security;
alter table public.journal_adjustment_lines enable row level security;

-- Read: any active member -- an adjustment to the ledger is not secret from
-- the team. Write: the journal-entry gate, same population that may post.
drop policy if exists journal_adjustments_select on public.journal_adjustments;
create policy journal_adjustments_select on public.journal_adjustments
  for select to authenticated using (company_entity_id = public.active_company_id());

drop policy if exists journal_adjustments_write on public.journal_adjustments;
create policy journal_adjustments_write on public.journal_adjustments
  for all to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_journal_entries() or public.is_exec_or_owner())
         -- A posted entry is a record of what hit the books. Editing it after
         -- the fact would leave SILO describing an entry QuickBooks does not
         -- have, which is the same trap card_transactions closes.
         and status <> 'posted')
  with check (company_entity_id = public.active_company_id()
              and (public.can_manage_journal_entries() or public.is_exec_or_owner()));

drop policy if exists journal_adjustment_lines_select on public.journal_adjustment_lines;
create policy journal_adjustment_lines_select on public.journal_adjustment_lines
  for select to authenticated using (company_entity_id = public.active_company_id());

drop policy if exists journal_adjustment_lines_write on public.journal_adjustment_lines;
create policy journal_adjustment_lines_write on public.journal_adjustment_lines
  for all to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_journal_entries() or public.is_exec_or_owner())
         and exists (select 1 from public.journal_adjustments a
                      where a.id = journal_adjustment_lines.adjustment_id
                        and a.status <> 'posted'))
  with check (company_entity_id = public.active_company_id()
              and (public.can_manage_journal_entries() or public.is_exec_or_owner()));

drop trigger if exists trg_journal_adj_created_by on public.journal_adjustments;
create trigger trg_journal_adj_created_by before insert on public.journal_adjustments
  for each row execute function public.stamp_created_by();

grant select on public.journal_adjustments_v to authenticated;
