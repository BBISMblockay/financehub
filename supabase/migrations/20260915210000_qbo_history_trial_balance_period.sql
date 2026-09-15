-- Refuse a trial balance that does not cover the ledger's own period.
--
-- WHAT WENT WRONG. archive_qbo_ledger checked that the trial balance ENDS on
-- the same date as the general ledger, and nothing about where it STARTS. QBO's
-- trial balance is period-scoped: a balance-sheet account reports its as-at
-- balance, so the start date does not move it, but an income or expense account
-- reports ACTIVITY for the range. A trial balance over a different period is
-- therefore a perfectly valid report that answers a different question, and
-- comparing the ledger against it produces a mismatch on every P&L account.
--
-- /v2/qbo-history.js had been requesting the trial balance from the FISCAL YEAR
-- START rather than the ledger's start. Every window anyone had tried began on
-- January 1, so the two coincided and the reconciliation was clean. The first
-- window to cross a fiscal-year boundary, 2025-08-01 .. 2026-07-31 on
-- 2026-09-15, compared twelve months of ledger against seven months of trial
-- balance:
--
--   account type        accounts mismatched   absolute difference
--   Income                               35        16,518,388.26
--   Cost of Goods Sold                    5         8,565,950.91
--   Expense                              17         7,063,382.26
--   Other Expense                         6           899,499.69
--   Equity                                1           239,045.48
--   Bank / AR / AP / Credit Card          0                  0.00
--
-- Not one balance-sheet account moved, which is the signature of a period
-- mismatch rather than lost history: the 36,686 archived lines were complete
-- and correct, and only the verdict on them was wrong. The page is fixed in the
-- same change, but a UI that asks the wrong question must not be able to turn
-- itself into 145 exceptions and a $54.4m headline, so the refusal belongs
-- here, where the comparison is actually made.
--
-- WHAT THIS CHECKS. Both reports must declare the ledger's own start date, in
-- their stored column and in the provider's own header. StartPeriod was never
-- read before for either report; EndPeriod already was. Measured across all 22
-- distinct stored report windows on 2026-09-15: every GeneralLedger and
-- TrialBalance run carries Header.StartPeriod, and every one equals its stored
-- start_date, so nothing that exists today is refused by this.
--
-- Additive: no table changes, no grant changes. Re-creates archive_qbo_ledger
-- from 20260915200000 with that one edit and nothing else.

create or replace function public.archive_qbo_ledger(p_gl_run_id uuid,p_tb_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 co uuid:=public.active_company_id(); settings public.accounting_settings%rowtype;
 gl public.quickbooks_report_runs%rowtype; tb public.quickbooks_report_runs%rowtype;
 job public.qbo_history_jobs%rowtype; imp uuid; src jsonb; digest text; column_keys text[]; expected_keys text[]:=array['tx_date','txn_type','doc_num','name','memo','split_acc','subt_nat_amount','rbal_nat_amount'];
 section jsonb; item jsonb; cells jsonb; totals jsonb; tb_balances jsonb:='{}'; account public.accounting_accounts%rowtype;
 qid text; seen text[]:='{}'; debit numeric; credit numeric; debit_sum numeric:=0; credit_sum numeric:=0; n integer; doc jsonb; node record; child_total numeric; summary_amount numeric; where_ text; unattr text; direction integer; v_seq integer:=0;
 -- per-call budget
 budget_rows integer:=coalesce(nullif(current_setting('silo.qbo_archive_batch_rows',true),'')::integer,5000);
 budget_ms integer:=coalesce(nullif(current_setting('silo.qbo_archive_batch_ms',true),'')::integer,3000);
 -- The ceiling the two unbounded phases need (see header). Settable for tests
 -- the way the budget is; raising it only risks a timeout on the caller's own
 -- import, never a partial archive -- the completeness guarantee is the
 -- atomic final copy, not this number.
 max_rows integer:=coalesce(nullif(current_setting('silo.qbo_archive_max_rows',true),'')::integer,100000);
 max_bytes bigint:=coalesce(nullif(current_setting('silo.qbo_archive_max_bytes',true),'')::bigint,8*1024*1024);
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
 -- The trial balance must cover the ledger's PERIOD, not merely end on its last
 -- day: an income or expense account reports activity for the range, so a
 -- shorter or longer trial balance disagrees with the ledger on every P&L
 -- account while every balance-sheet account still ties. That reads as lost
 -- history and is not.
 if tb.start_date is distinct from gl.start_date then
  raise exception 'The trial balance covers % to % but the ledger covers % to %. Read a trial balance over the same period and retry; nothing was written',
   tb.start_date,tb.end_date,gl.start_date,gl.end_date; end if;
 foreach doc in array array[gl.raw_response,tb.raw_response] loop
  -- StartPeriod is the provider's own statement of the period it answered for,
  -- and is checked beside EndPeriod: the stored columns say what was ASKED, the
  -- header says what QBO ANSWERED, and a report that quietly covers a different
  -- range than the one requested is the same defect seen from the other side.
  if doc#>>'{Header,Currency}' is distinct from settings.base_currency or doc#>>'{Header,ReportBasis}' is distinct from settings.accounting_basis
    or doc#>>'{Header,EndPeriod}' is distinct from gl.end_date::text
    or doc#>>'{Header,StartPeriod}' is distinct from gl.start_date::text then raise exception 'Report currency, basis or period does not match'; end if;
 end loop;
 -- The ledger's own StartPeriod used to be checked here and now runs in the
 -- loop above, which covers BOTH reports; leaving a second copy would mean the
 -- next period rule added to one is missing from the other.
 if gl.raw_response#>>'{Header,ReportName}' is distinct from 'GeneralLedger'
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
  -- These same two stored report runs already archived: answered from their
  -- ids, before the snapshot is built. The hash lookup below still runs for a
  -- DIFFERENT pair of runs whose content is identical (a re-fetch of the same
  -- period), which the ids cannot see -- but re-clicking Archive on the runs
  -- already on the books must not rebuild and re-hash a multi-megabyte
  -- document to discover that, and it must not be refused by the size guard
  -- for a period that is in fact completely archived.
  select id into imp from public.qbo_history_imports
   where company_entity_id=co and qbo_connection_id=gl.connection_id and gl_run_id=gl.id and tb_run_id=tb.id;
  if found then return jsonb_build_object('id',imp,'already_imported',true,'status','complete'); end if;
  -- Refuse an oversized report BEFORE the snapshot is assembled or hashed.
  -- Those two are the unbounded setup work the ceiling exists to prevent, so a
  -- guard standing after them guards nothing: jsonb_build_object copies both
  -- raw responses and finance_approval_snapshot_hash runs sha256 over the
  -- whole document, and on an oversized report both would run to completion
  -- and only then be told the report is too large. The byte check is
  -- effectively free (the stored jsonb's own size) and screens an absurd
  -- document out before the counting pass, which is one recursive scan (~0.3s
  -- at 37k rows, ~1.4s at the ceiling). Running before the supersession
  -- update below also means a refusal no longer abandons somebody else's
  -- in-flight job on its way out.
  if pg_column_size(gl.raw_response) > max_bytes then
   raise exception 'This general ledger is % MB, larger than the % MB this archive processes in one window. Choose a shorter period and archive it in parts; nothing was written',
    round(pg_column_size(gl.raw_response) / 1048576.0, 1), round(max_bytes / 1048576.0); end if;
  with recursive walk(j) as (
   select value from jsonb_array_elements(gl.raw_response#>'{Rows,Row}')
   union all select c.value from walk cross join lateral jsonb_array_elements(walk.j#>'{Rows,Row}') c where walk.j->>'type'='Section'
  ) select count(*) into n from walk where j->>'type'='Data';
  if n > max_rows then
   raise exception 'This general ledger has % ledger rows, more than the % this archive processes in one window (its final save is one atomic copy and cannot be split). Choose a shorter period and archive it in parts; nothing was written, and no row would have been dropped',
    n, max_rows; end if;
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
   -- QBO emits its own housekeeping bucket as a leaf section with NO account
   -- id -- on Baseballism's ledger it is called 'Not Specified' and holds 24
   -- rows, every one either a zero Journal Entry or a blank-amount Payment
   -- reading 'Created by QB Online to link credits to ...'. Refusing the whole
   -- import over it left the full-year window permanently unarchivable, since
   -- these are rows QuickBooks creates and nobody can assign an account to.
   --
   -- So it is ARCHIVED, not skipped: every row is preserved and readable under
   -- an id that cannot be mistaken for a QBO account, and the section appears
   -- in the reconciliation under its own issue name. What is NOT tolerated is
   -- a section with no account carrying actual money -- that is a real problem
   -- for a person to fix in QuickBooks, and it still refuses the whole import
   -- rather than filing the amount under a placeholder.
   if qid is null or qid='' then
    unattr:=coalesce(nullif(section#>>'{Header,ColData,0,value}',''),'(unnamed)');
    where_:=format('unattributed ledger section %s',unattr);
    -- The entire case for filing this section under a placeholder is that it
    -- is provably immaterial, so that is ESTABLISHED here rather than assumed:
    -- every amount cell, every running balance cell and the period total must
    -- be present, and every one of them must be blank or zero. Anything else
    -- -- money, a carried balance, a total that disagrees with the rows -- is
    -- a real bookkeeping fact that no placeholder may absorb, and it refuses
    -- the whole import naming what it found. Checking only the amount cells
    -- would admit a section whose closing balance is real money and then skip
    -- the trial-balance comparison on it, which is the one outcome this
    -- placeholder must never produce.
    --
    -- Measured against all seven stored windows of Baseballism's ledger
    -- (2026-09-15): amount and running balance cells are only ever '' or '.00'
    -- and the period total is '.00' in every window, so none of this refuses
    -- the real report.
    if exists(select 1 from jsonb_array_elements(section#>'{Rows,Row}') c
       where jsonb_typeof(c.value#>'{ColData,6,value}') is distinct from 'string'
          or jsonb_typeof(c.value#>'{ColData,7,value}') is distinct from 'string') then
     raise exception 'A row in the % is missing its amount or running balance cell; no archive was written',where_; end if;
    select count(*) into n from jsonb_array_elements(section#>'{Rows,Row}') c
     where c.value->>'type'='Data'
       and coalesce(public.qbo_report_number(c.value#>>'{ColData,6,value}',where_),0)<>0;
    if n>0 then
     raise exception 'The ledger section "%" has no QuickBooks account and carries % rows with an amount. Assign those transactions to an account in QuickBooks, then retry; nothing was written and no row would have been dropped',
      unattr,n; end if;
    select count(*) into n from jsonb_array_elements(section#>'{Rows,Row}') c
     where c.value->>'type'='Data'
       and coalesce(public.qbo_report_number(c.value#>>'{ColData,7,value}',where_),0)<>0;
    if n>0 then
     raise exception 'The ledger section "%" has no QuickBooks account and carries a running balance on % rows. Assign those transactions to an account in QuickBooks, then retry; nothing was written and no row would have been dropped',
      unattr,n; end if;
    if jsonb_typeof(section#>'{Summary,ColData,6,value}') is distinct from 'string' then
     raise exception 'Period total cell is missing for the %; no archive was written',where_; end if;
    if coalesce(public.qbo_report_number(section#>>'{Summary,ColData,6,value}',where_),0)<>0 then
     raise exception 'The ledger section "%" has no QuickBooks account and reports a non-zero period total. Assign those transactions to an account in QuickBooks, then retry; nothing was written and no row would have been dropped',
      unattr; end if;
    -- Column 7 is 'rbal_nat_amount', the section's ENDING BALANCE, and it is a
    -- separate claim from the period total in column 6: a section can report no
    -- movement and still report a balance carried out. On a real account an
    -- inconsistency there surfaces as a trial_balance_mismatch, because the
    -- closing balance is compared to the trial balance. The placeholder has no
    -- trial-balance counterpart and skips that comparison, so nothing downstream
    -- would ever look at it -- zero rows, zero movement and a $250 ending
    -- balance would archive and report 'matched'. All 14 stored sections carry
    -- this cell as '', so requiring it changes nothing about the real report.
    if jsonb_typeof(section#>'{Summary,ColData,7,value}') is distinct from 'string' then
     raise exception 'Period ending balance cell is missing for the %; no archive was written',where_; end if;
    if coalesce(public.qbo_report_number(section#>>'{Summary,ColData,7,value}',where_),0)<>0 then
     raise exception 'The ledger section "%" has no QuickBooks account and reports a non-zero ending balance. Assign those transactions to an account in QuickBooks, then retry; nothing was written and no row would have been dropped',
      unattr; end if;
    if exists(select 1 from public.qbo_history_staging_sections where job_id=job.id and qbo_account_id='silo:unattributed') then
     raise exception 'This ledger has more than one account-less section; SILO archives one. Raise it with your administrator rather than retrying'; end if;
    qid:='silo:unattributed';
    -- Sign is inert here and the name says so: every row is zero, so the
    -- direction cannot change any figure it is multiplied into.
    v_seq:=v_seq+1;
    insert into public.qbo_history_staging_sections(job_id,seq,qbo_account_id,account_name,account_type,direction,section,rows_total)
     values(job.id,v_seq,qid,coalesce(nullif(section#>>'{Header,ColData,0,value}',''),'Unattributed'),'Unattributed',1,section,coalesce(jsonb_array_length(section#>'{Rows,Row}'),0));
    continue;
   end if;
   if exists(select 1 from public.qbo_history_staging_sections where job_id=job.id and qbo_account_id=qid) then raise exception 'Unsupported or duplicate ledger account section; raw report remains available'; end if;
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
    if row_balance is null then
     -- A section is only staged as 'silo:unattributed' once every amount AND
     -- every running balance in it is blank or zero, so a blank balance here
     -- is a zero QBO did not bother to print, not a figure that went missing.
     -- On a real account it is unusable and still refuses. This is not a
     -- hypothetical: four of the seven stored windows carry exactly one such
     -- row, and they failed on this line rather than on the account-less
     -- section the rest of this migration is about.
     if qid='silo:unattributed' then row_balance:=0;
     else raise exception 'Missing running balance at row % of account %; no archive was written',section_row,qid; end if;
    end if;
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
    if qid='silo:unattributed' then
     -- Named, never silent, and deliberately NOT counted as a reconciliation
     -- exception: the section is provably zero, so the books still tie, and a
     -- permanent exception on every archive is a signal people stop reading.
     problems:=array_append(problems,'unattributed_ledger_section');difference:=null;
    elsif expected is null then problems:=array_append(problems,'missing_trial_balance_account');difference:=null;
     else difference:=balance*st.direction-expected;if difference<>0 then problems:=array_append(problems,'trial_balance_mismatch'); end if; end if;
    -- ONLY the intentional notice is exempt. A real reconciliation problem on
    -- the unattributed section -- a running balance gap, a period total that
    -- disagrees with its rows, a row carrying no transaction reference -- is
    -- counted like any other, so exception_count=0 keeps meaning what the
    -- history page prints for it: the balances matched.
    if exists(select 1 from unnest(problems) p where p<>'unattributed_ledger_section') then exceptions:=exceptions+1; end if;
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
