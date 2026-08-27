-- Not every transaction in a balance sheet account BELONGS there. The
-- $196,440.06 "BILL.COM* MLB ADVANCED" journal entry sitting in Prepaid is a
-- case in point -- it was parked, not prepaid.
--
-- Without somewhere to say so, the tie-out forces a false choice: stamp a
-- misclassified transaction with an invented service period just to make the
-- number go green, or leave the reconciliation permanently red. Both hide the
-- actual finding, which is that something needs reclassifying in QuickBooks.
--
-- So a transaction in one of these accounts is in exactly one of three states:
--   stamped      -- belongs to a schedule item, amortising
--   excluded     -- reviewed and does not belong here; a reconciling item
--   unreviewed   -- nobody has looked at it yet
--
-- and the reconciliation reads the way a real one does:
--   opening + stamped + excluded + unreviewed = ledger balance

create table if not exists public.schedule_excluded_transactions (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  qbo_txn_id text not null,
  qbo_account_id text not null,
  txn_date date,
  amount numeric(14,2),
  memo text,

  -- needs_reclass is the interesting one: it means the ledger is wrong, not the
  -- schedule, and someone has to move it in QuickBooks.
  reason text not null default 'needs_reclass'
    check (reason in ('needs_reclass', 'not_amortizable', 'immaterial', 'duplicate', 'other')),
  note text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create unique index if not exists uq_schedule_excluded_txn_once
  on public.schedule_excluded_transactions (company_entity_id, qbo_txn_id);

create index if not exists idx_schedule_excluded_account
  on public.schedule_excluded_transactions (company_entity_id, qbo_account_id);

alter table public.schedule_excluded_transactions enable row level security;

drop policy if exists schedule_excluded_active_all on public.schedule_excluded_transactions;
create policy schedule_excluded_active_all
  on public.schedule_excluded_transactions for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.schedule_excluded_transactions;
create trigger stamp_created_by
  before insert on public.schedule_excluded_transactions
  for each row execute function public.stamp_created_by();

-- Supporting documents for a schedule item -- the licensing agreement, the
-- invoice, the contract stating the term. A schedule that says "12 months" with
-- nothing behind it is an assertion; with the agreement attached it is support,
-- which is the difference an auditor cares about.
create table if not exists public.schedule_item_files (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,

  file_name text not null,
  file_path text not null,
  file_url text,
  file_size bigint,
  mime_type text,
  sort_order integer,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_schedule_item_files_item
  on public.schedule_item_files (schedule_item_id);

alter table public.schedule_item_files enable row level security;

drop policy if exists schedule_item_files_active_all on public.schedule_item_files;
create policy schedule_item_files_active_all
  on public.schedule_item_files for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.schedule_item_files;
create trigger stamp_created_by
  before insert on public.schedule_item_files
  for each row execute function public.stamp_created_by();

-- Private bucket: signed licensing agreements and invoices, not marketing
-- images. Same treatment as payment-request-files.
insert into storage.buckets (id, name, public)
values ('schedule-item-files', 'schedule-item-files', false)
on conflict (id) do nothing;

drop policy if exists "schedule files readable by company" on storage.objects;
create policy "schedule files readable by company"
  on storage.objects for select to authenticated
  using (bucket_id = 'schedule-item-files');

drop policy if exists "schedule files writable by company" on storage.objects;
create policy "schedule files writable by company"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'schedule-item-files');

drop policy if exists "schedule files deletable by company" on storage.objects;
create policy "schedule files deletable by company"
  on storage.objects for delete to authenticated
  using (bucket_id = 'schedule-item-files');

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['excluded transaction','needs reclass','reconciling item','misclassified','prepaid exclusion'],
  description = $d$Transactions sitting in a balance sheet account that do NOT belong on its schedule -- reviewed and set aside rather than stamped. reason = needs_reclass means the ledger is wrong and someone must move it in QuickBooks. Exists so the tie-out does not force a false choice between inventing a service period for a misclassified payment and leaving the reconciliation permanently broken. A transaction is stamped, excluded, or unreviewed; opening + stamped + excluded + unreviewed = ledger balance.$d$
where relname = 'schedule_excluded_transactions';
