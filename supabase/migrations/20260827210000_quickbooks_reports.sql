-- QuickBooks report runs: the read side of the accounting integration.
--
-- Purpose beyond "look at a report". Balance sheet supporting schedules
-- (prepaids first, then leases) only become a RECONCILIATION if each schedule
-- item ties to the actual QuickBooks transactions sitting in that account.
-- That requires transaction-level detail out of QBO, which is what this
-- fetches. A schedule built without it is a spreadsheet in a nicer wrapper.
--
-- Every run is stored rather than just proxied through, for three reasons:
--   1. QBO reports are slow and rate-limited; re-rendering a period should not
--      re-fetch it.
--   2. A stored run is a point-in-time snapshot, which is what a reconciliation
--      needs -- "this is what the ledger said when we tied it out".
--   3. The raw payload stays inspectable when a number looks wrong, instead of
--      being lost inside a rendered table.
--
-- raw_response holds QBO's untouched nested Rows/Columns structure. Flattening
-- happens at render time: the shape differs per report and QBO changes it, so
-- parsing on the way in would bake today's assumptions into stored history.

create table if not exists public.quickbooks_report_runs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.quickbooks_connections(id) on delete set null,

  -- QBO report name exactly as the API takes it: BalanceSheet, ProfitAndLoss,
  -- GeneralLedger, TransactionList, TrialBalance, ProfitAndLossDetail.
  report_name text not null,

  -- Everything that defined the request (dates, account filter, accounting
  -- method). Kept whole so a run can be reproduced or compared later.
  params jsonb not null default '{}'::jsonb,

  start_date date,
  end_date date,

  raw_response jsonb,
  row_count integer,

  status text not null default 'ok' check (status in ('ok', 'error')),
  error_message text,

  fetched_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_quickbooks_report_runs_lookup
  on public.quickbooks_report_runs (company_entity_id, report_name, fetched_at desc);

alter table public.quickbooks_report_runs enable row level security;

-- Report payloads are financial statements: same company scope as everything
-- else, but no credentials, so any active member may read them. Writes come
-- from the edge function's service-role client only -- deliberately no client
-- insert policy, matching sample_notification_log and product_concept_revisions.
drop policy if exists quickbooks_report_runs_active_select on public.quickbooks_report_runs;
create policy quickbooks_report_runs_active_select
  on public.quickbooks_report_runs for select
  to authenticated
  using (company_entity_id = public.active_company_id());

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['balance sheet','profit and loss','general ledger','trial balance',
                   'quickbooks report','prepaid','transaction detail','reconciliation'],
  description = $d$Stored QuickBooks Online report runs -- balance sheet, P&L, general ledger, transaction list -- fetched by the quickbooks-report edge function. raw_response holds QBO's untouched nested Rows/Columns payload; flattening happens at render time because the shape differs per report. Each row is a point-in-time snapshot of what the ledger said, which is what a reconciliation needs. Use the most recent run per report_name unless a question is explicitly about how a figure changed between runs.$d$
where relname = 'quickbooks_report_runs';

-- Journal entries SILO has pushed to QuickBooks.
--
-- Created now, before anything posts, because the schedules being built on top
-- of reporting need it: a prepaid amortization schedule has to know which
-- months have already been recognised, or it will re-post them. Same for the
-- monthly Shopify entry.
--
-- `payload` stores exactly what was sent, and `readback` what QuickBooks
-- returned when the entry was fetched again afterwards. A 200 response only
-- proves Intuit accepted something -- reading the entry back and diffing it
-- against what was sent is what proves the right accounts and locations were
-- hit. readback_matches records the verdict of that comparison.
create table if not exists public.quickbooks_journal_postings (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.quickbooks_connections(id) on delete set null,

  -- What produced this entry. Kept open rather than constrained: the same
  -- posting path serves the derived Shopify entry, prepaid and lease
  -- amortisation, credit-card coding, and hand-written adjustments.
  source text not null,
  -- Identifies the specific thing within that source -- a period like
  -- '2026-07', a prepaid schedule item id, a card statement id.
  source_ref text not null,

  period_start date,
  period_end date,
  memo text,

  payload jsonb not null,

  qbo_journal_entry_id text,
  qbo_doc_number text,

  status text not null default 'draft'
    check (status in ('draft', 'posted', 'failed', 'voided')),

  readback jsonb,
  readback_matches boolean,

  error_message text,
  intuit_tid text,

  created_at timestamptz not null default now(),
  posted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  posted_by uuid references auth.users(id) on delete set null
);

-- The double-post gate. One POSTED entry per source+ref, enforced by the
-- database rather than by a disabled button: a UI guard does not survive two
-- tabs, a double click, or a retry after a timeout that actually succeeded.
-- Partial, so failed and voided attempts can be retried freely.
create unique index if not exists uq_quickbooks_postings_source_ref_posted
  on public.quickbooks_journal_postings (company_entity_id, source, source_ref)
  where status = 'posted';

create index if not exists idx_quickbooks_postings_company_status
  on public.quickbooks_journal_postings (company_entity_id, status, created_at desc);

alter table public.quickbooks_journal_postings enable row level security;

drop policy if exists quickbooks_postings_active_select on public.quickbooks_journal_postings;
create policy quickbooks_postings_active_select
  on public.quickbooks_journal_postings for select
  to authenticated
  using (company_entity_id = public.active_company_id());

-- No client write policy. Entries are written only by the posting edge
-- function's service-role client, so the log cannot be edited to hide or
-- fabricate a posting.

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['journal entry','posted to quickbooks','posting log','je',
                   'amortization posted','double post','audit trail'],
  description = $d$Every journal entry SILO has pushed to QuickBooks Online, with the exact payload sent, the QBO document number returned, and the read-back of the entry as QuickBooks stored it. A unique index allows only one row with status = 'posted' per (source, source_ref), which is the database-level guard against double-posting a period. source names what produced the entry (the derived Shopify monthly entry, prepaid or lease amortisation, credit-card coding, or a manual adjustment) and source_ref identifies which one. Written only by the posting edge function; no client can edit it.$d$
where relname = 'quickbooks_journal_postings';
