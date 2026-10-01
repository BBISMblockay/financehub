-- set_card_transaction_splits: reset its scratch table with a WHERE clause.
--
-- Saving any split failed with "DELETE requires a WHERE clause" (reported
-- 2026-10-01 on a $25,187.68 loan payment). Supabase loads pg_safeupdate for
-- API sessions, and it refuses an unqualified DELETE even against a temporary
-- table, so `delete from tmp_split;` aborted the call before anything was
-- written. Clearing a split never reached that line, which is why it worked.
-- The function is otherwise identical to 20260915100000; `where true` keeps the
-- reset explicit for safeupdate without changing what it deletes.
-- create or replace retains grants; they are re-asserted below anyway.

create or replace function public.set_card_transaction_splits(
 p_transaction_id uuid, p_splits jsonb, p_learn_rule boolean default false, p_rule_match text default 'merchant')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
 co uuid := public.active_company_id(); txn public.card_transactions%rowtype; batch public.card_import_batches%rowtype;
 src public.card_sources%rowtype; conn uuid; n integer; total numeric; v_rule uuid; v_pattern text;
begin
 if auth.uid() is null or co is null or not(public.can_manage_journal_entries() or public.is_exec_or_owner()) then
  raise exception 'Finance access required'; end if;
 select * into txn from public.card_transactions where id = p_transaction_id and company_entity_id = co;
 if not found then raise exception 'Transaction not found'; end if;
 select * into batch from public.card_import_batches where id = txn.batch_id and company_entity_id = co;
 if not found then raise exception 'Transaction not found'; end if;
 if batch.status not in ('draft','categorized') then
  raise exception 'This batch is %; reopen it before changing how a transaction is split', batch.status; end if;
 select * into src from public.card_sources where id = batch.source_id and company_entity_id = co;
 conn := src.qbo_connection_id;

 -- Clearing a split returns the row to uncoded rather than guessing which of
 -- its accounts was meant to be the single one.
 if p_splits is null or jsonb_array_length(p_splits) = 0 then
  delete from public.card_transaction_splits where transaction_id = txn.id and company_entity_id = co;
  update public.card_transactions set status = 'uncoded', coding_source = null where id = txn.id;
  return jsonb_build_object('transaction_id', txn.id, 'lines', 0, 'status', 'uncoded');
 end if;
 n := jsonb_array_length(p_splits);
 if n < 2 then raise exception 'A split needs at least two lines; code it to one account instead'; end if;
 if n > 50 then raise exception 'A transaction may be split across at most 50 accounts'; end if;

 create temporary table if not exists tmp_split(line_no integer, amount numeric(14,2), qbo_account_id text,
  qbo_location_id text, entity_qbo_id text, entity_type text, memo text) on commit drop;
 delete from tmp_split where true;
 insert into tmp_split(line_no, amount, qbo_account_id, qbo_location_id, entity_qbo_id, entity_type, memo)
 select ordinality, (x->>'amount')::numeric, nullif(x->>'qbo_account_id',''), nullif(x->>'qbo_location_id',''),
        nullif(x->>'entity_qbo_id',''), nullif(x->>'entity_type',''), nullif(x->>'memo','')
   from jsonb_array_elements(p_splits) with ordinality as e(x, ordinality);
 if exists(select 1 from tmp_split where amount is null) then
  raise exception 'Every split line needs an amount; enter the amount for each account from the statement'; end if;
 if exists(select 1 from tmp_split where amount = 0) then
  raise exception 'A split line cannot be zero; remove the account instead'; end if;
 if exists(select 1 from tmp_split where qbo_account_id is null) then
  raise exception 'Every split line needs an account'; end if;
 select round(sum(amount), 2) into total from tmp_split;
 if total <> round(txn.amount, 2) then
  raise exception 'Split lines total % but the transaction is %; the difference is %. A split must account for the whole amount',
   total, round(txn.amount, 2), round(txn.amount, 2) - total; end if;
 -- Same QBO reference checks an ordinary coded line passes, before anything
 -- is written: an unknown account here would surface at approval instead.
 if exists(select 1 from tmp_split s where not exists(
   select 1 from public.quickbooks_accounts a where a.connection_id = conn and a.company_entity_id = co
     and a.qbo_account_id = s.qbo_account_id and a.is_active)) then
  raise exception 'A split line names an account that is not active on this QuickBooks connection'; end if;
 if exists(select 1 from tmp_split s where s.qbo_location_id is not null and not exists(
   select 1 from public.quickbooks_locations l where l.connection_id = conn and l.company_entity_id = co
     and l.qbo_location_id = s.qbo_location_id and l.is_active)) then
  raise exception 'A split line names a location that is not active on this QuickBooks connection'; end if;
 if exists(select 1 from tmp_split s join public.quickbooks_accounts a
    on a.connection_id = conn and a.company_entity_id = co and a.qbo_account_id = s.qbo_account_id
   where a.account_type in ('Accounts Receivable','Accounts Payable') and s.entity_qbo_id is null) then
  raise exception 'A split line on a receivable or payable account needs a customer or vendor'; end if;
 if exists(select 1 from tmp_split s where s.entity_qbo_id is not null and not(
   (s.entity_type = 'Customer' and exists(select 1 from public.quickbooks_customers e where e.connection_id = conn
      and e.company_entity_id = co and e.qbo_customer_id = s.entity_qbo_id and e.is_active))
   or (s.entity_type = 'Vendor' and exists(select 1 from public.quickbooks_vendors e where e.connection_id = conn
      and e.company_entity_id = co and e.qbo_vendor_id = s.entity_qbo_id and e.is_active)))) then
  raise exception 'A split line names a customer or vendor that is not active on this QuickBooks connection'; end if;

 delete from public.card_transaction_splits where transaction_id = txn.id and company_entity_id = co;
 -- The parent's single account goes first: the deferred tie check refuses a
 -- row that carries both, and a reader must never see one account standing
 -- for a payment that is split across several.
 update public.card_transactions
    set qbo_account_id = null, qbo_account_name = null, status = 'coded', coding_source = 'split',
        confidence = null, ai_reasoning = null
  where id = txn.id;
 insert into public.card_transaction_splits(company_entity_id, transaction_id, line_no, amount, qbo_account_id,
   qbo_account_name, qbo_location_id, qbo_location_name, entity_qbo_id, entity_type, memo, created_by)
 select co, txn.id, s.line_no, s.amount, s.qbo_account_id,
        (select a.name from public.quickbooks_accounts a where a.connection_id = conn and a.company_entity_id = co
           and a.qbo_account_id = s.qbo_account_id),
        s.qbo_location_id,
        (select l.name from public.quickbooks_locations l where l.connection_id = conn and l.company_entity_id = co
           and l.qbo_location_id = s.qbo_location_id),
        s.entity_qbo_id, s.entity_type, s.memo, auth.uid()
   from tmp_split s;

 if p_learn_rule then
  if p_rule_match not in ('merchant','card_name') then raise exception 'A split rule matches on merchant or card name'; end if;
  -- v_pattern, not pattern: the bare name also resolves to
  -- card_split_rules.pattern inside the insert below, which is ambiguous.
  v_pattern := case when p_rule_match = 'merchant'
    then public.normalize_merchant(coalesce(txn.clean_merchant, txn.description))
    else nullif(txn.card_name, '') end;
  if v_pattern is null or v_pattern = '' then
   raise exception 'This transaction has no % to learn a rule from', replace(p_rule_match, '_', ' '); end if;
  insert into public.card_split_rules(company_entity_id, source_id, match_field, pattern, created_by)
   values(co, batch.source_id, p_rule_match, v_pattern, auth.uid())
   on conflict (company_entity_id, source_id, match_field, pattern)
   do update set last_used_at = now(), hit_count = public.card_split_rules.hit_count + 1
   returning id into v_rule;
  -- v_rule, never a variable named rule_id: a WHERE comparing the column with
  -- itself is always true and would delete every rule line in the company.
  delete from public.card_split_rule_lines l where l.rule_id = v_rule;
  insert into public.card_split_rule_lines(rule_id, line_no, qbo_account_id, qbo_account_name, qbo_location_id,
    qbo_location_name, entity_qbo_id, entity_type, memo_template)
  select v_rule, s.line_no, s.qbo_account_id, s.qbo_account_name, s.qbo_location_id, s.qbo_location_name,
         s.entity_qbo_id, s.entity_type, s.memo
    from public.card_transaction_splits s where s.transaction_id = txn.id order by s.line_no;
 end if;
 return jsonb_build_object('transaction_id', txn.id, 'lines', n, 'total', total, 'status', 'coded',
   'rule_id', v_rule, 'learned_amounts', false);
end $$;
revoke all on function public.set_card_transaction_splits(uuid, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function public.set_card_transaction_splits(uuid, jsonb, boolean, text) to authenticated;
