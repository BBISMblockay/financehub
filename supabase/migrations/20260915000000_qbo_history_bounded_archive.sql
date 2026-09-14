-- QBO history: a bounded, resumable archive that fits under PostgREST's
-- statement timeout, with the same evidence, invariants and reconciliation.
--
-- WHAT FAILED. Both production imports (2025-08-01..2026-07-31, 36,778 rows,
-- and the reduced 2026-01-01..2026-07-31 window) fetched their reports and
-- then timed out inside archive_qbo_ledger. Measured on PostgreSQL 16 with
-- synthetic reports in the production shape (scripts/tests/qbo-history-benchmark.mjs):
--
--     rows    1,000   2,000   4,000    8,000   16,000      36,778
--     before   1.4s    5.1s   19.7s    77.9s    431s   ~27 min (extrapolated)
--     after    0.2s    --      --      --       --      5.7s in 8 calls, longest call 2.9s
--
-- Time quadruples per doubling: the RPC appended every staged line to one
-- growing jsonb value (`staged := staged || jsonb_build_array(...)`), and
-- each append copies the whole array, so 36,778 rows cost the sum of 36,778
-- ever-larger copies -- extrapolated ~27 minutes for the full-year report.
-- The 8s ceiling is crossed near 2,500 rows, which is why the reduced window
-- failed too. While it ran it held the company row `FOR UPDATE`, and a second
-- session wanting that row waited the whole time (79s at 8,000 rows).
--
-- WHY THE 55s OVERRIDE DID NOT HELP. Production's hand-applied
-- `ALTER FUNCTION archive_qbo_ledger SET statement_timeout = '55s'` is
-- ineffective for the statement that calls it, measured (same harness, real
-- server): under PostgREST's transaction shape -- BEGIN; SET LOCAL ROLE; the
-- role's statement_timeout applied as SET LOCAL; SELECT rpc() -- a function
-- carrying `SET statement_timeout = '10s'` is cancelled at the role's limit
-- exactly like one without it, while current_setting() inside it reports
-- 10s. The timer is armed when the top-level statement starts; the
-- function's SET is applied when the function is entered, after that. So the
-- effective ceiling is the role's 8s, for every call, and this migration does
-- not carry a timeout clause: `create or replace` below replaces the
-- function's configuration, which removes the hand-applied override rather
-- than leaving a setting in production that the repository does not record
-- and that does nothing.
--
-- WHAT THIS DOES INSTEAD. The archive becomes a job the browser drives with
-- repeated calls of the SAME RPC, each bounded by rows and wall-clock:
--
--   call 1  validates everything the old RPC validated up front (auth,
--           company lock, settings, report identity, headers, currency,
--           basis, dates, filters, columns, trial balance totals, the
--           grouped-section tie-outs), records the job with the frozen
--           source snapshot and its hash, and stages each leaf account
--           section; then processes rows until the budget is spent.
--   call n  resumes: continues the next unfinished section from the row it
--           stopped at (per-row state -- running balance, movement, flags --
--           is persisted per section), inserting normalised lines into a
--           staging table, and returns {status:'in_progress', rows_done,
--           rows_total, ...} until every section is checked.
--   last    cross-checks the trial balance against the ledger accounts,
--           inserts the immutable import header and copies every staged
--           line into qbo_history_lines in one set-based statement, drops
--           the staging rows, and returns {id, status:'complete', ...} --
--           the same result shape as before.
--
-- TWO PHASES ARE NOT ROW-BOUNDED, AND THAT IS WHY THERE IS A CEILING.
-- The per-call budget governs row processing only. Two phases cannot be
-- split without giving up a guarantee this archive exists to provide:
--
--   * Setup (first call) freezes the source snapshot and hashes it, then
--     walks and stages the ledger's sections. A sha256 over one document
--     cannot be resumed part-way.
--   * Finalization (last call) inserts the import header and copies every
--     staged line. That must be ONE statement pair in ONE transaction:
--     the evidence tables are immutable (no UPDATE, by trigger), so there
--     is no "incomplete" flag to set and clear, and a partially copied
--     import would be readable by the card categorizer as if it were whole.
--
-- Both grow with the report. Measured on PostgreSQL 16, longest single call
-- (setup+rows on the first, rows+finalization on the last):
--
--     data rows   36,778   80,000   100,000   120,000   150,000
--     longest       2.5s     3.3s      3.6s      5.2s      6.9s
--
-- So the bound is real up to a point and then it is not, and the honest
-- thing is a guard rather than a claim. A job refuses before any work when
-- the report exceeds QBO_ARCHIVE_MAX_ROWS (100,000 data rows, longest call
-- measured 3.6s, a 2.2x margin under the authenticated 8s ceiling) or
-- QBO_ARCHIVE_MAX_BYTES (48 MB of stored JSON, a cheap first check so an
-- absurd document is refused without the counting pass). The refusal names
-- the count and says to narrow the window, which is what
-- docs/ops/qbo-history.md already tells an operator to do with a report too
-- large to process. Nothing is truncated and no row is skipped: the archive
-- either covers the window completely or refuses it and says why.
-- Baseballism's full year is 36,778 rows, comfortably inside.
--
-- Nothing reaches qbo_history_imports / qbo_history_lines until the last
-- call, so an incomplete archive is never evidence: the card categorizer
-- reads only those two tables. A validation failure at any point marks the
-- job failed with the message (the same messages as before), deletes its
-- staging rows, and returns {status:'failed', error}; the evidence tables
-- are untouched, and a retry with the same reports starts a fresh job.
-- Retrying an unfinished job with the same reports resumes it (same source
-- hash); a completed source returns {already_imported:true} as before; two
-- jobs for one source cannot run at once (partial unique index), and only
-- one job per company/connection is live at a time -- starting a new one
-- abandons an older unfinished one and removes its staging.
--
-- What did not change: tenant/connection isolation (every read is scoped to
-- the caller's active company and the settings' connection), the immutable
-- evidence tables and their triggers, the number parser and blank-amount
-- rule, zero_amount rows kept out of coding precedent, the reconciliation
-- checks and their issue names, and the atomic appearance of an archive.
--
-- One more cost removed on the way: the finance audit trigger copied the
-- whole import row -- the multi-megabyte source_snapshot included -- into
-- finance_audit_events.new_values. The import now audits through
-- qbo_history_audit_event(), which records the row without the snapshot
-- body (its sha256 source_hash stays in the event), so the snapshot is
-- written once, not twice.

-- ── Job and staging tables ───────────────────────────────────────────────
create table if not exists public.qbo_history_jobs (
 id uuid primary key default gen_random_uuid(),
 company_entity_id uuid not null references public.entities(id),
 qbo_connection_id uuid not null,
 gl_run_id uuid not null,
 tb_run_id uuid not null,
 period_start date not null,
 period_end date not null,
 source_hash text not null,
 status text not null default 'running' check(status in ('running','complete','failed','abandoned')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 calls integer not null default 0,
 sections_total integer not null default 0,
 sections_done integer not null default 0,
 rows_total integer not null default 0,
 rows_done integer not null default 0,
 line_count integer not null default 0,
 transaction_count integer not null default 0,
 exception_count integer not null default 0,
 blank_amount_rows integer not null default 0,
 zero_amount_rows integer not null default 0,
 tb_balances jsonb not null default '{}'::jsonb,
 tb_accounts text[] not null default '{}',
 source_snapshot jsonb,
 import_id uuid,
 error text,
 unique(id,company_entity_id)
);
create unique index if not exists qbo_history_jobs_one_running on public.qbo_history_jobs(company_entity_id,qbo_connection_id,source_hash) where status='running';
create index if not exists qbo_history_jobs_company on public.qbo_history_jobs(company_entity_id,status,created_at desc);

create table if not exists public.qbo_history_staging_sections (
 job_id uuid not null references public.qbo_history_jobs(id) on delete cascade,
 seq integer not null,
 qbo_account_id text not null,
 account_name text not null,
 account_type text not null,
 direction integer not null,
 section jsonb not null,
 rows_total integer not null,
 rows_done integer not null default 0,
 state jsonb not null default '{}'::jsonb,
 result jsonb,
 primary key(job_id,seq)
);
create table if not exists public.qbo_history_staging_lines (
 job_id uuid not null references public.qbo_history_jobs(id) on delete cascade,
 row_no integer not null,
 company_entity_id uuid not null,
 row_kind text not null,
 qbo_account_id text not null,
 account_name text not null,
 account_type text not null,
 transaction_date date,
 qbo_transaction_id text,
 transaction_type text,
 document_number text,
 counterparty text,
 memo text,
 split_account_id text,
 split_account_name text,
 natural_amount numeric not null,
 natural_balance numeric not null,
 raw_row jsonb not null,
 primary key(job_id,row_no)
);
-- Jobs: finance readers of the company see progress; nobody writes from a
-- client. Staging: no client access at all, in either direction.
do $$ declare t text; begin
 foreach t in array array['qbo_history_jobs','qbo_history_staging_sections','qbo_history_staging_lines'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
 grant select on public.qbo_history_jobs to authenticated;
 drop policy if exists history_jobs_finance_read on public.qbo_history_jobs;
 create policy history_jobs_finance_read on public.qbo_history_jobs for select to authenticated
  using (company_entity_id=public.active_company_id() and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
end $$;

-- ── Audit without the snapshot body ──────────────────────────────────────
create or replace function public.qbo_history_audit_event()
returns trigger language plpgsql security definer set search_path='public','pg_temp' as $$
begin
 insert into public.finance_audit_events(company_entity_id,object_type,object_id,event_type,actor_user_id,old_values,new_values)
  values(new.company_entity_id,tg_table_name,new.id,lower(tg_op),auth.uid(),null,to_jsonb(new)-'source_snapshot');
 return new;
end $$;
revoke all on function public.qbo_history_audit_event() from public,anon,authenticated;
drop trigger if exists finance_audit_event on public.qbo_history_imports;
create trigger finance_audit_event after insert on public.qbo_history_imports for each row execute function public.qbo_history_audit_event();

-- ── The bounded archive ──────────────────────────────────────────────────
create or replace function public.archive_qbo_ledger(p_gl_run_id uuid,p_tb_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 co uuid:=public.active_company_id(); settings public.accounting_settings%rowtype;
 gl public.quickbooks_report_runs%rowtype; tb public.quickbooks_report_runs%rowtype;
 job public.qbo_history_jobs%rowtype; imp uuid; src jsonb; digest text; column_keys text[]; expected_keys text[]:=array['tx_date','txn_type','doc_num','name','memo','split_acc','subt_nat_amount','rbal_nat_amount'];
 section jsonb; item jsonb; cells jsonb; totals jsonb; tb_balances jsonb:='{}'; account public.accounting_accounts%rowtype;
 qid text; seen text[]:='{}'; debit numeric; credit numeric; debit_sum numeric:=0; credit_sum numeric:=0; n integer; doc jsonb; node record; child_total numeric; summary_amount numeric; where_ text; direction integer; v_seq integer:=0;
 -- per-call budget
 budget_rows integer:=coalesce(nullif(current_setting('silo.qbo_archive_batch_rows',true),'')::integer,5000);
 budget_ms integer:=coalesce(nullif(current_setting('silo.qbo_archive_batch_ms',true),'')::integer,3000);
 -- The ceiling the two unbounded phases need (see header). Settable for tests
 -- the way the budget is; raising it only risks a timeout on the caller's own
 -- import, never a partial archive -- the completeness guarantee is the
 -- atomic final copy, not this number.
 max_rows integer:=coalesce(nullif(current_setting('silo.qbo_archive_max_rows',true),'')::integer,100000);
 started timestamptz:=clock_timestamp(); rows_this_call integer:=0; stopped boolean:=false;
 -- per-section state
 st public.qbo_history_staging_sections%rowtype; state jsonb; balance numeric; movement numeric; has_beginning boolean; txn_started boolean; problems text[]; section_row integer; blank_rows integer; zero_rows integer;
 amount numeric; row_balance numeric; d date; row_kind text; row_no integer; txn_count integer; exceptions integer; blank_total integer; zero_total integer; expected numeric; difference numeric; k text; checks jsonb; err text;
begin
 if auth.uid() is null or co is null or not(public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
 perform 1 from public.entities where id=co for update;
 select * into settings from public.accounting_settings where company_entity_id=co;
 if not found then raise exception 'Seed accounting settings before importing history'; end if;
 select * into gl from public.quickbooks_report_runs where id=p_gl_run_id and company_entity_id=co and report_name='GeneralLedger' and status='ok' for share;
 if not found then raise exception 'Select a successful GeneralLedger report for this company'; end if;
 select * into tb from public.quickbooks_report_runs where id=p_tb_run_id and company_entity_id=co and report_name='TrialBalance' and status='ok' for share;
 if not found then raise exception 'Select a successful TrialBalance report for this company'; end if;
 if gl.connection_id is distinct from settings.qbo_connection_id or tb.connection_id is distinct from gl.connection_id then raise exception 'Report connections must match company accounting settings'; end if;
 if gl.start_date is null or gl.end_date is null or gl.start_date>gl.end_date or gl.end_date-gl.start_date>365
   or gl.end_date>=settings.accounting_start_date or tb.end_date is distinct from gl.end_date then
  raise exception 'Choose at most 366 historical days before the Silo start date and a trial balance at the same end date'; end if;
 foreach doc in array array[gl.raw_response,tb.raw_response] loop
  if doc#>>'{Header,Currency}' is distinct from settings.base_currency or doc#>>'{Header,ReportBasis}' is distinct from settings.accounting_basis
    or doc#>>'{Header,EndPeriod}' is distinct from gl.end_date::text then raise exception 'Report currency, basis or end date does not match'; end if;
 end loop;
 if gl.raw_response#>>'{Header,StartPeriod}' is distinct from gl.start_date::text or gl.raw_response#>>'{Header,ReportName}' is distinct from 'GeneralLedger'
   or tb.raw_response#>>'{Header,ReportName}' is distinct from 'TrialBalance' then raise exception 'Unexpected report header'; end if;
 if exists(select 1 from (select * from jsonb_each(gl.params) union all select * from jsonb_each(tb.params)) p where p.key not in ('start_date','end_date','accounting_method') and p.value not in ('null'::jsonb,'""'::jsonb)) then
  raise exception 'Filtered or custom-column reports cannot establish historical coverage'; end if;
 -- A running job for exactly these two stored reports resumes without
 -- rebuilding or re-hashing the snapshot (the job holds both); the source
 -- snapshot is only assembled once, when the job is created.
 select * into job from public.qbo_history_jobs where company_entity_id=co and qbo_connection_id=gl.connection_id and gl_run_id=gl.id and tb_run_id=tb.id and status='running';
 if found then
  digest:=job.source_hash;
 else
  -- Immutable copies have no FK to cached reports or connection credentials.
  src:=jsonb_build_object('general_ledger',gl.raw_response,'trial_balance',tb.raw_response,'gl_params',gl.params,'tb_params',tb.params,
   'account_context',(select jsonb_agg(to_jsonb(a) order by a.qbo_account_id) from public.accounting_accounts a where a.company_entity_id=co and a.qbo_connection_id=gl.connection_id),
   'gl_fetched_at',gl.fetched_at,'tb_fetched_at',tb.fetched_at,'realm_id',(select realm_id from public.quickbooks_connections where id=gl.connection_id and company_entity_id=co));
  digest:=public.finance_approval_snapshot_hash(src);
  select id into imp from public.qbo_history_imports where company_entity_id=co and qbo_connection_id=gl.connection_id and source_hash=digest;
  if found then return jsonb_build_object('id',imp,'already_imported',true,'status','complete'); end if;
  select * into job from public.qbo_history_jobs where company_entity_id=co and qbo_connection_id=gl.connection_id and source_hash=digest and status='running';
 end if;
 if job.id is null then
  -- One live job per company and connection: a newer source supersedes an
  -- unfinished one, whose staging goes with it.
  update public.qbo_history_jobs set status='abandoned',updated_at=now(),source_snapshot=null,error='Superseded by a newer archive of the same connection'
   where company_entity_id=co and qbo_connection_id=gl.connection_id and status='running';
  delete from public.qbo_history_staging_lines l using public.qbo_history_jobs j where l.job_id=j.id and j.company_entity_id=co and j.status='abandoned';
  delete from public.qbo_history_staging_sections s using public.qbo_history_jobs j where s.job_id=j.id and j.company_entity_id=co and j.status='abandoned';
  -- Refuse an oversized report BEFORE any work: the setup and finalization
  -- phases are not row-bounded (see header). The byte check is effectively
  -- free (the stored jsonb's own size) and screens an absurd document out
  -- before the counting pass, which is one recursive scan (~0.3s at 37k
  -- rows, ~1.4s at the ceiling).
  if pg_column_size(gl.raw_response) > 48 * 1024 * 1024 then
   raise exception 'This general ledger is % MB, larger than the % MB this archive processes in one window. Choose a shorter period and archive it in parts; nothing was written',
    round(pg_column_size(gl.raw_response) / 1048576.0), 48; end if;
  with recursive walk(j) as (
   select value from jsonb_array_elements(gl.raw_response#>'{Rows,Row}')
   union all select c.value from walk cross join lateral jsonb_array_elements(walk.j#>'{Rows,Row}') c where walk.j->>'type'='Section'
  ) select count(*) into n from walk where j->>'type'='Data';
  if n > max_rows then
   raise exception 'This general ledger has % ledger rows, more than the % this archive processes in one window (its final save is one atomic copy and cannot be split). Choose a shorter period and archive it in parts; nothing was written, and no row would have been dropped',
    n, max_rows; end if;
  -- A known provider shape, verified against Test Company's stored GL. Do not
  -- infer accounting signs from translated display labels or arbitrary columns.
  select array_agg((select m->>'Value' from jsonb_array_elements(c.value->'MetaData') m where m->>'Name'='ColKey') order by c.ordinality)
   into column_keys from jsonb_array_elements(gl.raw_response#>'{Columns,Column}') with ordinality c;
  if column_keys is distinct from expected_keys then raise exception 'Unsupported ledger columns; fetch the default unfiltered GeneralLedger report'; end if;
  cells:=tb.raw_response#>'{Columns,Column}';
  if jsonb_array_length(cells) is distinct from 3 or cells#>>'{0,ColType}' is distinct from 'Account'
    or lower(cells#>>'{1,ColTitle}') is distinct from 'debit' or lower(cells#>>'{2,ColTitle}') is distinct from 'credit' then raise exception 'Unsupported trial balance columns'; end if;
  for item in with recursive rows(j) as (select value from jsonb_array_elements(tb.raw_response#>'{Rows,Row}')
    union all select c.value from rows cross join lateral jsonb_array_elements(rows.j#>'{Rows,Row}') c)
    select j from rows where j ? 'ColData' or j->>'type'='Data'
  loop
   cells:=item->'ColData';qid:=cells#>>'{0,id}';
   if qid is null or qid='' or qid=any(seen) or jsonb_array_length(cells) is distinct from 3 then raise exception 'Unidentified or duplicate trial balance account'; end if;
   if jsonb_typeof(cells#>'{1,value}') is distinct from 'string' or jsonb_typeof(cells#>'{2,value}') is distinct from 'string' then
    raise exception 'Trial balance amount cell is missing for account %; no archive was written',qid; end if;
   debit:=coalesce(public.qbo_report_number(cells#>>'{1,value}',format('trial balance debit for account %s',qid)),0);
   credit:=coalesce(public.qbo_report_number(cells#>>'{2,value}',format('trial balance credit for account %s',qid)),0);
   if debit<0 or credit<0 then raise exception 'Negative trial balance amount for account %; a negative debit or credit is ambiguous and was not archived',qid; end if;
   if debit>0 and credit>0 then raise exception 'Trial balance account contains both debit and credit'; end if;
   debit_sum:=debit_sum+debit;credit_sum:=credit_sum+credit;seen:=array_append(seen,qid);
   tb_balances:=tb_balances||jsonb_build_object(qid,debit-credit);
  end loop;
  select count(*),jsonb_agg(e.value#>'{Summary,ColData}')->0 into n,totals from jsonb_array_elements(tb.raw_response#>'{Rows,Row}') e
   where e.value ? 'Summary' and coalesce(e.value->>'group','GrandTotal')='GrandTotal';
  if cardinality(seen)=0 or n<>1 or debit_sum<>credit_sum or totals#>>'{0,value}' is distinct from 'TOTAL'
   or jsonb_typeof(totals#>'{1,value}') is distinct from 'string' or jsonb_typeof(totals#>'{2,value}') is distinct from 'string' then raise exception 'Trial balance lacks a valid balanced grand total'; end if;
  debit:=public.qbo_report_number(totals#>>'{1,value}','trial balance grand total debit');
  credit:=public.qbo_report_number(totals#>>'{2,value}','trial balance grand total credit');
  if debit is null or credit is null or debit<0 or credit<0 then raise exception 'Trial balance lacks a valid balanced grand total'; end if;
  if debit<>debit_sum or credit<>credit_sum then raise exception 'Trial balance rows do not tie to provider totals'; end if;
  insert into public.qbo_history_jobs(company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,source_hash,created_by,tb_balances,tb_accounts,source_snapshot)
   values(co,gl.connection_id,gl.id,tb.id,gl.start_date,gl.end_date,digest,auth.uid(),tb_balances,seen,src) returning * into job;
  -- Each account section is retained separately. Same QBO transaction may
  -- legitimately have multiple lines; identity is the source row, not txn ID.
  -- Group sections are checked here and never staged; leaf sections are
  -- staged whole, in provider order, so a later call reads only its slice.
  for node in
   with recursive sections(j,qid,path) as (
    select value,value#>>'{Header,ColData,0,id}',array[ordinality] from jsonb_array_elements(gl.raw_response#>'{Rows,Row}') with ordinality
    union all select c.value,case when c.value ? 'Header' then c.value#>>'{Header,ColData,0,id}' else sections.qid end,sections.path||c.ordinality
    from sections cross join lateral jsonb_array_elements(sections.j#>'{Rows,Row}') with ordinality c where c.value->>'type'='Section'
   ) select * from sections order by path
  loop
   section:=node.j;qid:=node.qid;
   if section->>'type' is distinct from 'Section' or jsonb_array_length(section#>'{Summary,ColData}') is distinct from 8 then raise exception 'Unsupported ledger section'; end if;
   if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where c.value->>'type' not in ('Section','Data') or c.value->>'type' is null) then raise exception 'Unsupported ledger row type'; end if;
   -- QBO wraps a parent's own rows in a headerless child, alongside named
   -- subaccounts. A headerless child inherits its parent's ID; a named group
   -- without an ID never inherits one. No name-to-ID guessing.
   if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where c.value->>'type'='Section') then
    if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where c.value->>'type'='Data') then raise exception 'Mixed grouped and direct ledger rows are not supported'; end if;
    where_:=format('grouped ledger total for %s',coalesce(nullif(qid,''),'an unidentified group'));
    if jsonb_typeof(section#>'{Summary,ColData,6,value}') is distinct from 'string'
      or exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c where jsonb_typeof(c.value#>'{Summary,ColData,6,value}') is distinct from 'string') then
     raise exception 'Ledger total cell is missing in %; no archive was written',where_; end if;
    summary_amount:=coalesce(public.qbo_report_number(section#>>'{Summary,ColData,6,value}',where_),0);
    select coalesce(sum(coalesce(public.qbo_report_number(c.value#>>'{Summary,ColData,6,value}',where_),0)),0) into child_total from jsonb_array_elements(section#>'{Rows,Row}') c;
    if summary_amount<>child_total then raise exception 'Grouped ledger totals do not tie to child sections'; end if;
    continue;
   end if;
   if qid is null or qid='' or exists(select 1 from public.qbo_history_staging_sections where job_id=job.id and qbo_account_id=qid) then raise exception 'Unsupported or duplicate ledger account section; raw report remains available'; end if;
   select * into account from public.accounting_accounts where company_entity_id=co and qbo_connection_id=gl.connection_id and qbo_account_id=qid;
   if not found then raise exception 'Ledger account % is not in the Silo chart; reconcile the chart before importing',qid; end if;
   direction:=case when account.account_type in ('Bank','Accounts Receivable','Other Current Asset','Fixed Asset','Other Asset','Expense','Other Expense','Cost of Goods Sold') then 1
    when account.account_type in ('Accounts Payable','Credit Card','Other Current Liability','Long Term Liability','Equity','Income','Other Income') then -1 else null end;
   if direction is null then raise exception 'Unsupported account type %',account.account_type; end if;
   -- The period total cell is checked now so a missing cell fails before any
   -- row work; its value is compared once the section's rows are done.
   if jsonb_typeof(section#>'{Summary,ColData,6,value}') is distinct from 'string' then raise exception 'Period total cell is missing for account %; no archive was written',qid; end if;
   v_seq:=v_seq+1;
   insert into public.qbo_history_staging_sections(job_id,seq,qbo_account_id,account_name,account_type,direction,section,rows_total)
    values(job.id,v_seq,qid,account.name,account.account_type,direction,section,coalesce(jsonb_array_length(section#>'{Rows,Row}'),0));
  end loop;
  if v_seq=0 then raise exception 'Ledger contains no account sections; no historical coverage was established'; end if;
  update public.qbo_history_jobs set sections_total=v_seq,rows_total=(select coalesce(sum(rows_total),0) from public.qbo_history_staging_sections where job_id=job.id) where id=job.id returning * into job;
 end if;

 -- ── Bounded work: resume from the first unfinished section ────────────
 row_no:=job.line_count;txn_count:=job.transaction_count;exceptions:=job.exception_count;blank_total:=job.blank_amount_rows;zero_total:=job.zero_amount_rows;
 begin
  for st in select * from public.qbo_history_staging_sections where job_id=job.id and result is null order by seq loop
   exit when stopped;
   qid:=st.qbo_account_id;state:=st.state;
   balance:=coalesce((state->>'balance')::numeric,0);movement:=coalesce((state->>'movement')::numeric,0);
   has_beginning:=coalesce((state->>'has_beginning')::boolean,false);txn_started:=coalesce((state->>'txn_started')::boolean,false);
   problems:=coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(state->'problems','[]'::jsonb)) x),'{}');
   section_row:=st.rows_done;blank_rows:=coalesce((state->>'blank_rows')::integer,0);zero_rows:=coalesce((state->>'zero_rows')::integer,0);
   if st.rows_total=0 then problems:=array_append(problems,'no_ledger_rows'); end if;
   for item in select value from jsonb_array_elements(st.section#>'{Rows,Row}') with ordinality o where o.ordinality>st.rows_done order by o.ordinality loop
    cells:=item->'ColData';section_row:=section_row+1;
    if item ? 'Rows' or jsonb_array_length(cells) is distinct from 8 then raise exception 'Unsupported nested or incomplete ledger row; no archive was written'; end if;
    -- A cell without a "value" key is a shape the archive has never seen; it
    -- is not a blank and is never read as zero.
    if jsonb_typeof(cells#>'{6,value}') is distinct from 'string' or jsonb_typeof(cells#>'{7,value}') is distinct from 'string' then
     raise exception 'Ledger amount or running balance cell is missing at row % of account %; no archive was written',section_row,qid; end if;
    row_balance:=public.qbo_report_number(cells#>>'{7,value}',format('running balance at row %s of account %s',section_row,qid));
    if row_balance is null then raise exception 'Missing running balance at row % of account %; no archive was written',section_row,qid; end if;
    if cells#>>'{0,value}'='Beginning Balance' then
     if has_beginning or txn_started then raise exception 'Unexpected beginning balance position'; end if;
     has_beginning:=true;balance:=row_balance;amount:=0;row_kind:='opening';d:=null;
    else
     if cells#>>'{0,value}' is null or cells#>>'{0,value}' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Missing ledger transaction date'; end if;
     d:=(cells#>>'{0,value}')::date;
     if d<gl.start_date or d>gl.end_date then raise exception 'Ledger row outside declared period'; end if;
     amount:=public.qbo_report_number(cells#>>'{6,value}',format('ledger amount at row %s of account %s',section_row,qid));
     if amount is null then
      -- QBO leaves the amount blank on a zero-value line (a $0 payment
      -- application, a zero journal line). The running balance decides: an
      -- unchanged balance corroborates zero; a moving balance beside a blank
      -- amount is ambiguous and nothing is inferred from it.
      if row_balance<>balance then raise exception 'Blank ledger amount with a changed running balance at row % of account % is ambiguous; no archive was written',section_row,qid; end if;
      amount:=0;blank_rows:=blank_rows+1;blank_total:=blank_total+1;
     end if;
     -- A zero line is retained but is not coding precedent (see header).
     if amount=0 then row_kind:='zero_amount';zero_rows:=zero_rows+1;zero_total:=zero_total+1; else row_kind:='transaction'; end if;
     txn_started:=true;txn_count:=txn_count+1;
     if balance+amount<>row_balance and not('running_balance_gap'=any(problems)) then problems:=array_append(problems,'running_balance_gap'); end if;
     movement:=movement+amount;balance:=row_balance;
     if nullif(cells#>>'{1,id}','') is null and not('missing_transaction_reference'=any(problems)) then problems:=array_append(problems,'missing_transaction_reference'); end if;
    end if;
    row_no:=row_no+1;rows_this_call:=rows_this_call+1;
    insert into public.qbo_history_staging_lines(job_id,row_no,company_entity_id,row_kind,qbo_account_id,account_name,account_type,transaction_date,qbo_transaction_id,transaction_type,document_number,counterparty,memo,split_account_id,split_account_name,natural_amount,natural_balance,raw_row)
     values(job.id,row_no,co,row_kind,qid,st.account_name,st.account_type,d,nullif(cells#>>'{1,id}',''),cells#>>'{1,value}',cells#>>'{2,value}',cells#>>'{3,value}',cells#>>'{4,value}',cells#>>'{5,id}',cells#>>'{5,value}',amount,row_balance,item);
    if section_row<st.rows_total and (rows_this_call>=budget_rows or clock_timestamp()-started>make_interval(secs=>budget_ms/1000.0)) then stopped:=true; exit; end if;
   end loop;
   if section_row<st.rows_total then
    -- Budget spent inside this section: persist where it stopped.
    update public.qbo_history_staging_sections set rows_done=section_row,
     state=jsonb_build_object('balance',balance,'movement',movement,'has_beginning',has_beginning,'txn_started',txn_started,'problems',to_jsonb(problems),'blank_rows',blank_rows,'zero_rows',zero_rows)
     where job_id=job.id and seq=st.seq;
    stopped:=true;
   else
    -- A PRESENT blank period total is zero (an account with only a beginning
    -- balance); a missing cell was refused when the section was staged.
    summary_amount:=coalesce(public.qbo_report_number(st.section#>>'{Summary,ColData,6,value}',format('period total for account %s',qid)),0);
    if summary_amount<>movement then problems:=array_append(problems,'movement_total_mismatch'); end if;
    expected:=(job.tb_balances->>qid)::numeric;
    if expected is null then problems:=array_append(problems,'missing_trial_balance_account');difference:=null;
     else difference:=balance*st.direction-expected;if difference<>0 then problems:=array_append(problems,'trial_balance_mismatch'); end if; end if;
    if cardinality(problems)>0 then exceptions:=exceptions+1; end if;
    update public.qbo_history_staging_sections set rows_done=section_row,state='{}'::jsonb,
     result=jsonb_build_object('qbo_account_id',qid,'account_name',st.account_name,'ledger_debit_net',balance*st.direction,'trial_balance_debit_net',expected,'difference',difference,'issues',to_jsonb(problems),'blank_amount_rows',blank_rows,'zero_amount_rows',zero_rows)
     where job_id=job.id and seq=st.seq;
    if rows_this_call>=budget_rows or clock_timestamp()-started>make_interval(secs=>budget_ms/1000.0) then stopped:=true; end if;
   end if;
  end loop;
 exception when others then
  err:=sqlerrm;
 end;
 if err is not null then
  -- The failing call's row work rolled back with the block above; the job
  -- records why, its staging goes, and the evidence tables were never touched.
  update public.qbo_history_jobs set status='failed',error=err,updated_at=now(),calls=calls+1,source_snapshot=null where id=job.id;
  delete from public.qbo_history_staging_lines where job_id=job.id;
  delete from public.qbo_history_staging_sections where job_id=job.id;
  return jsonb_build_object('status','failed','job_id',job.id,'error',err);
 end if;

 update public.qbo_history_jobs set calls=calls+1,updated_at=now(),line_count=row_no,transaction_count=txn_count,exception_count=exceptions,blank_amount_rows=blank_total,zero_amount_rows=zero_total,
  rows_done=(select coalesce(sum(rows_done),0) from public.qbo_history_staging_sections where job_id=job.id),
  sections_done=(select count(*) from public.qbo_history_staging_sections where job_id=job.id and result is not null)
  where id=job.id returning * into job;
 if job.sections_done<job.sections_total then
  return jsonb_build_object('status','in_progress','job_id',job.id,'rows_done',job.rows_done,'rows_total',job.rows_total,'sections_done',job.sections_done,'sections_total',job.sections_total,'calls',job.calls);
 end if;

 -- ── Every section checked: finish atomically ───────────────────────────
 -- In its own exception block, for the same reason the row loop has one: a
 -- constraint, trigger or storage error here rolls the call back, and
 -- without this the job would stay 'running' with every resume repeating
 -- the same terminal failure and nothing recording why. On failure the job
 -- is marked failed with the message and its staging is dropped, exactly as
 -- a mid-row failure is; the evidence tables were never written.
 begin
 select coalesce(jsonb_agg(result order by seq),'[]'::jsonb) into checks from public.qbo_history_staging_sections where job_id=job.id;
 -- A TB account not in GL is an explicit coverage exception even at zero;
 -- a zero closing balance does not prove the account has no historical rows.
 foreach k in array job.tb_accounts loop
  if not exists(select 1 from public.qbo_history_staging_sections where job_id=job.id and qbo_account_id=k) then
   exceptions:=exceptions+1;
   checks:=checks||jsonb_build_array(jsonb_build_object('qbo_account_id',k,'account_name',coalesce((select name from public.accounting_accounts where company_entity_id=co and qbo_connection_id=gl.connection_id and qbo_account_id=k),k),'trial_balance_debit_net',job.tb_balances->k,'issues',jsonb_build_array('missing_ledger_account')));
  end if;
 end loop;
 if row_no=0 then raise exception 'Ledger contains no account sections; no historical coverage was established'; end if;
 insert into public.qbo_history_imports(company_entity_id,qbo_connection_id,gl_run_id,tb_run_id,period_start,period_end,currency,accounting_basis,source_hash,source_snapshot,reconciliation,reconciliation_status,exception_count,transaction_count,created_by)
 values(co,gl.connection_id,gl.id,tb.id,gl.start_date,gl.end_date,settings.base_currency,settings.accounting_basis,digest,job.source_snapshot,checks,case when exceptions=0 then 'matched' else 'exceptions' end,exceptions,txn_count,auth.uid()) returning id into imp;
 insert into public.qbo_history_lines(company_entity_id,import_id,row_no,row_kind,qbo_account_id,account_name,account_type,transaction_date,qbo_transaction_id,transaction_type,document_number,counterparty,memo,split_account_id,split_account_name,natural_amount,natural_balance,raw_row)
 select co,imp,l.row_no,l.row_kind,l.qbo_account_id,l.account_name,l.account_type,l.transaction_date,l.qbo_transaction_id,l.transaction_type,l.document_number,l.counterparty,l.memo,l.split_account_id,l.split_account_name,l.natural_amount,l.natural_balance,l.raw_row
 from public.qbo_history_staging_lines l where l.job_id=job.id order by l.row_no;
 if (select count(*) from public.qbo_history_lines where import_id=imp)<>row_no then raise exception 'Archived line count does not match the staged rows; no archive was written'; end if;
 delete from public.qbo_history_staging_lines where job_id=job.id;
 delete from public.qbo_history_staging_sections where job_id=job.id;
 update public.qbo_history_jobs set status='complete',import_id=imp,exception_count=exceptions,source_snapshot=null,updated_at=now() where id=job.id;
 exception when others then
  err:=sqlerrm;
 end;
 if err is not null then
  update public.qbo_history_jobs set status='failed',error=err,updated_at=now(),source_snapshot=null where id=job.id;
  delete from public.qbo_history_staging_lines where job_id=job.id;
  delete from public.qbo_history_staging_sections where job_id=job.id;
  return jsonb_build_object('status','failed','job_id',job.id,'error',err);
 end if;
 return jsonb_build_object('id',imp,'status','complete','job_id',job.id,'transaction_count',txn_count,'exception_count',exceptions,'blank_amount_rows',blank_total,'zero_amount_rows',zero_total,'calls',job.calls,'rows_total',job.rows_total);
end $$;
revoke all on function public.archive_qbo_ledger(uuid,uuid) from public,anon,authenticated;
grant execute on function public.archive_qbo_ledger(uuid,uuid) to authenticated;
-- The new tables carry company_entity_id; verify's check 6 expects the stamp
-- trigger on every such table. The helper is absent from the local test
-- fixtures, which bootstrap only what the finance migrations need.
do $$ begin
 if to_regprocedure('public.attach_stamp_company_entity_id_triggers()') is not null then perform public.attach_stamp_company_entity_id_triggers(); end if;
end $$;
