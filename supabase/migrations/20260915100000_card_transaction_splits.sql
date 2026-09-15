-- Split one transaction across several accounts: the loan payment problem.
--
-- A coded row carried exactly one qbo_account_id, and the approval snapshot
-- built exactly one journal line per row. A $25,187.68 loan payment that is
-- part principal and part interest therefore had three bad options: all to
-- the liability (overstating principal paid, hiding the interest expense),
-- all to interest expense (never reducing the loan), or excluding the row and
-- hand-writing a journal adjustment, which is correct on the books but manual
-- every month and leaves nothing connecting the excluded row to the entry
-- that replaced it. The same shape covers a card payment with a fee, payroll
-- drafts, and a vendor charge spanning two cost centres.
--
-- WHAT A SPLIT IS. One row may carry two or more split lines, each with its
-- own account, location, entity and memo, and its own signed amount. The
-- amounts must sum to the parent's amount to the cent. That is the whole
-- safety property: the settlement side of the journal entry is computed from
-- the batch total, so a split that summed to anything else would silently
-- unbalance the entry or move money the statement never moved. It is enforced
-- three ways -- in the RPC, by a deferred constraint trigger that a
-- service-role write cannot dodge, and by the posting snapshot recomputing it
-- before it freezes.
--
-- AMOUNTS ARE ALWAYS TYPED; ONLY THE SHAPE IS LEARNED. An amortizing payment
-- divides differently every month, so a rule that remembered amounts would be
-- wrong by construction and wrong in a way that looks authoritative. A split
-- rule therefore stores the ORDERED ACCOUNTS ONLY (with optional location,
-- entity and memo). Applying one pre-fills the lines and leaves every amount
-- blank for a person to enter against the statement. There is deliberately no
-- default amount, no remembered proportion and no "same as last month".
--
-- ONE DEFINITION OF A JOURNAL LINE. card_coding_effective_lines yields one row
-- per line a batch will post -- the split lines of a split row, or the single
-- line of an unsplit row -- and the approval snapshot now validates and
-- aggregates through it. Duplicating the account, location and entity checks
-- for splits would have been the obvious change and the wrong one: the next
-- check added to one copy would be missing from the other, and the gap would
-- be invisible until a split line posted to an account nobody validated.

-- ── Splits ───────────────────────────────────────────────────────────────
-- The parent needs a composite key before anything can reference it, and a
-- marker a reader cannot miss: a split row's own qbo_account_id is null, so a
-- query that reads the single account and ignores splits returns nothing
-- rather than a half-truth.
do $$ begin
 if not exists(select 1 from pg_constraint where conname='card_transactions_id_company_key') then
  alter table public.card_transactions add constraint card_transactions_id_company_key unique(id, company_entity_id);
 end if;
end $$;
create table if not exists public.card_transaction_splits (
 id uuid primary key default gen_random_uuid(),
 company_entity_id uuid not null references public.entities(id) on delete cascade,
 transaction_id uuid not null,
 line_no integer not null check(line_no >= 1),
 -- Signed like the parent: positive debits the account, negative credits it.
 -- Zero is not a line; it is an account someone meant to remove.
 amount numeric(14,2) not null check(amount <> 0),
 qbo_account_id text not null,
 qbo_account_name text,
 qbo_location_id text,
 qbo_location_name text,
 entity_qbo_id text,
 entity_type text check(entity_type in ('Customer','Vendor')),
 memo text,
 created_at timestamptz not null default now(),
 created_by uuid references auth.users(id),
 unique(transaction_id, line_no),
 unique(id, company_entity_id),
 check((entity_qbo_id is null) = (entity_type is null)),
 foreign key(transaction_id, company_entity_id)
   references public.card_transactions(id, company_entity_id) on delete cascade
);
create index if not exists card_transaction_splits_txn on public.card_transaction_splits(transaction_id, line_no);
create index if not exists card_transaction_splits_company on public.card_transaction_splits(company_entity_id);

alter table public.card_transactions drop constraint if exists card_transactions_coding_source_check;
alter table public.card_transactions add constraint card_transactions_coding_source_check
 check(coding_source is null or coding_source in ('rule','ai','manual','default','split'));

-- ── The stored invariant ─────────────────────────────────────────────────
-- Deferred, because replacing a split set is several statements in one
-- transaction and the sum is only meaningful once they have all run.
create or replace function public.card_splits_must_tie()
returns trigger language plpgsql as $$
declare v_txn uuid; v_parent numeric; v_sum numeric; v_count integer; v_account text;
begin
 v_txn := coalesce(new.transaction_id, old.transaction_id);
 select amount, qbo_account_id into v_parent, v_account from public.card_transactions where id = v_txn;
 if not found then return null; end if;  -- the parent went with a deleted batch
 select count(*), coalesce(sum(amount), 0) into v_count, v_sum
  from public.card_transaction_splits where transaction_id = v_txn;
 if v_count = 0 then return null; end if;
 if v_count = 1 then
  raise exception 'A split needs at least two lines; one line is an ordinary coded transaction'
   using errcode = 'check_violation'; end if;
 if round(v_sum, 2) <> round(v_parent, 2) then
  raise exception 'Split lines total % but the transaction is %; a split must account for the whole amount',
   round(v_sum, 2), round(v_parent, 2) using errcode = 'check_violation'; end if;
 if v_account is not null then
  raise exception 'A split transaction cannot also carry a single account; its own qbo_account_id must be null'
   using errcode = 'check_violation'; end if;
 return null;
end $$;
drop trigger if exists card_splits_must_tie on public.card_transaction_splits;
create constraint trigger card_splits_must_tie
 after insert or update or delete on public.card_transaction_splits
 deferrable initially deferred for each row execute function public.card_splits_must_tie();

-- The same rule from the parent's side: a row that has splits may not be
-- given a single account, and its amount may not drift away from them.
create or replace function public.card_transaction_splits_still_tie()
returns trigger language plpgsql as $$
declare v_sum numeric; v_count integer;
begin
 select count(*), coalesce(sum(amount), 0) into v_count, v_sum
  from public.card_transaction_splits where transaction_id = new.id;
 if v_count = 0 then return new; end if;
 if new.qbo_account_id is not null then
  raise exception 'This transaction is split across % accounts; clear its splits before coding it to one account', v_count
   using errcode = 'check_violation'; end if;
 if round(v_sum, 2) <> round(new.amount, 2) then
  raise exception 'This transaction is split into lines totalling %; changing its amount to % would leave the split short',
   round(v_sum, 2), round(new.amount, 2) using errcode = 'check_violation'; end if;
 return new;
end $$;
drop trigger if exists card_transaction_splits_still_tie on public.card_transactions;
create trigger card_transaction_splits_still_tie
 after update of amount, qbo_account_id on public.card_transactions
 for each row execute function public.card_transaction_splits_still_tie();

-- ── When the bank corrects a split row ───────────────────────────────────
-- The bank feed rewrites a DRAFT row in place when the provider changes its
-- accounting facts, resetting every coding column to null because the human's
-- coding was of different facts (plaid_project_transaction). A split is that
-- same coding, so it has to go the same way -- and if it does not, the tie
-- check above raises INSIDE plaid_apply_sync, which rolls the whole sync back
-- including its cursor, so every later sync of that account re-reads the same
-- correction and fails identically. One split would stop the account's feed
-- permanently. Measured shape: a draft $100 row split $60/$40, corrected by
-- the bank to $105.
--
-- Deleting is right rather than merely convenient: the lines are a person's
-- allocation of an amount the statement no longer says, so keeping them would
-- leave an uncoded row carrying lines that add up to nothing real. The row is
-- left uncoded and says so, exactly as an unsplit row does after the same
-- correction. This fires only on the provider's own reset -- the amount moved
-- AND the single account is null AND the row is back to uncoded -- so an
-- ordinary edit still hits the tie check instead.
create or replace function public.card_splits_follow_provider_change()
returns trigger language plpgsql as $$
begin
 if new.status = 'uncoded' and new.qbo_account_id is null
   and round(new.amount, 2) is distinct from round(old.amount, 2)
   and exists(select 1 from public.card_transaction_splits s where s.transaction_id = old.id) then
  delete from public.card_transaction_splits where transaction_id = old.id;
 end if;
 return new;
end $$;
drop trigger if exists card_splits_follow_provider_change on public.card_transactions;
-- BEFORE the tie check, which is an AFTER trigger: the lines are gone by the
-- time it looks, so it finds no splits and returns rather than raising.
create trigger card_splits_follow_provider_change
 before update of amount on public.card_transactions
 for each row execute function public.card_splits_follow_provider_change();

-- ── Learned shape, never learned amounts ─────────────────────────────────
create table if not exists public.card_split_rules (
 id uuid primary key default gen_random_uuid(),
 company_entity_id uuid not null references public.entities(id) on delete cascade,
 -- Null = every card, as with card_coding_rules.
 source_id uuid references public.card_sources(id) on delete cascade,
 -- Which fact identifies the payment. A loan draft is usually recognised by
 -- its merchant; a cost-centre card by its card name.
 match_field text not null check(match_field in ('merchant','card_name')),
 pattern text not null,
 priority integer not null default 100,
 hit_count integer not null default 0,
 last_used_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid references auth.users(id),
 unique(company_entity_id, source_id, match_field, pattern)
);
create table if not exists public.card_split_rule_lines (
 rule_id uuid not null references public.card_split_rules(id) on delete cascade,
 line_no integer not null check(line_no >= 1),
 qbo_account_id text not null,
 qbo_account_name text,
 qbo_location_id text,
 qbo_location_name text,
 entity_qbo_id text,
 entity_type text check(entity_type in ('Customer','Vendor')),
 memo_template text,
 primary key(rule_id, line_no),
 check((entity_qbo_id is null) = (entity_type is null))
);
comment on table public.card_split_rules is
 'The SHAPE of a recurring split -- which accounts, in what order -- learned from a '
 'confirmed split and matched on merchant or card name. Deliberately carries no '
 'amounts: an amortizing payment divides differently every month, so a remembered '
 'amount would be wrong by construction and would look authoritative while being wrong. '
 'Applying a rule pre-fills the accounts and leaves every amount blank.';

-- ── One definition of a posted line ──────────────────────────────────────
create or replace view public.card_coding_effective_lines
with (security_invoker = true) as
 select t.id as transaction_id, t.batch_id, t.company_entity_id, t.row_no, t.txn_date, t.description,
        s.line_no, s.amount, s.qbo_account_id, s.qbo_location_id, s.entity_qbo_id, s.entity_type, s.memo, true as is_split
   from public.card_transactions t
   join public.card_transaction_splits s on s.transaction_id = t.id and s.company_entity_id = t.company_entity_id
  where t.status = 'coded'
 union all
 select t.id, t.batch_id, t.company_entity_id, t.row_no, t.txn_date, t.description,
        1, t.amount, t.qbo_account_id, t.qbo_location_id, t.entity_qbo_id, t.entity_type, t.memo, false
   from public.card_transactions t
  where t.status = 'coded'
    and not exists(select 1 from public.card_transaction_splits s where s.transaction_id = t.id);
comment on view public.card_coding_effective_lines is
 'One row per journal line a coded batch will post: a split row contributes its split '
 'lines, an unsplit row contributes itself. The approval snapshot validates and '
 'aggregates through this view so a split line cannot skip a check that an ordinary '
 'coded line passes.';

-- ── Access ───────────────────────────────────────────────────────────────
-- Splits and rules are read by finance users of the company; splits are
-- written only by set_card_transaction_splits, which is where the invariants
-- and the QBO reference checks live.
do $$ declare t text; begin
 foreach t in array array['card_transaction_splits','card_split_rules','card_split_rule_lines'] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from public, anon, authenticated', t);
  execute format('grant select on public.%I to authenticated', t);
 end loop;
end $$;
grant select on public.card_coding_effective_lines to authenticated;
drop policy if exists card_transaction_splits_read on public.card_transaction_splits;
create policy card_transaction_splits_read on public.card_transaction_splits for select to authenticated
 using (company_entity_id = public.active_company_id()
   and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
drop policy if exists card_split_rules_read on public.card_split_rules;
create policy card_split_rules_read on public.card_split_rules for select to authenticated
 using (company_entity_id = public.active_company_id()
   and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
drop policy if exists card_split_rule_lines_read on public.card_split_rule_lines;
create policy card_split_rule_lines_read on public.card_split_rule_lines for select to authenticated
 using (exists(select 1 from public.card_split_rules r where r.id = card_split_rule_lines.rule_id
   and r.company_entity_id = public.active_company_id()
   and (public.can_manage_journal_entries() or public.is_exec_or_owner())));

-- ── Write path ───────────────────────────────────────────────────────────
-- Replaces a transaction's entire split set in one call. DEFINER because the
-- table takes no client writes; every read is filtered to the caller's active
-- company by hand, and the batch must still be open, which is the same
-- boundary card_transactions_write_draft enforces for ordinary coding.
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
 delete from tmp_split;
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

-- The shape a learned rule offers for a transaction, amounts blank. Returns
-- nothing when a merchant rule and a card-name rule disagree, the same stance
-- card_coding_rules takes on a conflicting single-account coding: knowing the
-- vendor and knowing the card are different claims, and where they differ
-- neither is evidence.
create or replace function public.suggest_card_transaction_splits(p_transaction_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare co uuid := public.active_company_id(); txn public.card_transactions%rowtype; batch public.card_import_batches%rowtype;
 merchant_rule uuid; card_rule uuid; chosen uuid; shape_m text; shape_c text;
begin
 if auth.uid() is null or co is null or not(public.can_manage_journal_entries() or public.is_exec_or_owner()) then
  raise exception 'Finance access required'; end if;
 select * into txn from public.card_transactions where id = p_transaction_id and company_entity_id = co;
 if not found then raise exception 'Transaction not found'; end if;
 select * into batch from public.card_import_batches where id = txn.batch_id and company_entity_id = co;
 select id into merchant_rule from public.card_split_rules
  where company_entity_id = co and match_field = 'merchant'
    and pattern = public.normalize_merchant(coalesce(txn.clean_merchant, txn.description))
    and (source_id is null or source_id = batch.source_id)
  order by (source_id is not null) desc, priority desc, created_at desc limit 1;
 select id into card_rule from public.card_split_rules
  where company_entity_id = co and match_field = 'card_name' and pattern = txn.card_name
    and (source_id is null or source_id = batch.source_id)
  order by (source_id is not null) desc, priority desc, created_at desc limit 1;
 if merchant_rule is not null and card_rule is not null then
  select string_agg(qbo_account_id, '|' order by line_no) into shape_m from public.card_split_rule_lines where rule_id = merchant_rule;
  select string_agg(qbo_account_id, '|' order by line_no) into shape_c from public.card_split_rule_lines where rule_id = card_rule;
  if shape_m is distinct from shape_c then
   return jsonb_build_object('conflict', true, 'reason',
     'A merchant rule and a card rule split this differently; neither is applied'); end if;
 end if;
 chosen := coalesce(merchant_rule, card_rule);
 if chosen is null then return jsonb_build_object('lines', '[]'::jsonb); end if;
 return jsonb_build_object('rule_id', chosen, 'conflict', false, 'lines', coalesce((
   select jsonb_agg(jsonb_build_object('line_no', line_no, 'qbo_account_id', qbo_account_id,
     'qbo_account_name', qbo_account_name, 'qbo_location_id', qbo_location_id, 'qbo_location_name', qbo_location_name,
     'entity_qbo_id', entity_qbo_id, 'entity_type', entity_type, 'memo', memo_template,
     -- Never a remembered amount. The person enters each one from the statement.
     'amount', null) order by line_no)
   from public.card_split_rule_lines where rule_id = chosen), '[]'::jsonb));
end $$;
revoke all on function public.suggest_card_transaction_splits(uuid) from public, anon, authenticated;
grant execute on function public.suggest_card_transaction_splits(uuid) to authenticated;

-- ── The bank feed's own direction and treatment guard ────────────────────
-- Re-created from 20260912052930. That guard INNER JOINs quickbooks_accounts
-- through card_transactions.qbo_account_id, which a split row deliberately
-- leaves null -- so every split row fell out of the join and skipped all four
-- of its checks. A posted bank row classified as card_payment could be split
-- entirely into expense accounts and approved, where the same row unsplit is
-- refused; the entry balances and misclassifies the payment. The direction
-- checks went with it, because they sat in the same join although they only
-- read the parent's own amount.
--
-- Split in two accordingly. Direction is a fact about the TRANSACTION, so it
-- is checked on the transaction with no account join at all and now covers
-- split rows for the first time. Account type is a fact about each LINE, so it
-- is checked through card_coding_effective_lines -- the same one definition of
-- a posted line the approval snapshot uses, so a split line cannot pass a
-- check an ordinary line fails. Everything else in this function is
-- 20260912052930 unchanged.
create or replace function public.plaid_guard_batch()
returns trigger language plpgsql security invoker set search_path='public','pg_temp' as $$
declare v_source public.card_sources%rowtype; begin
  if tg_op='UPDATE' and (new.source_id,new.company_entity_id) is distinct from (old.source_id,old.company_entity_id)
    and exists(select 1 from public.card_transactions where batch_id=old.id) then
    raise exception 'A populated import batch cannot change its source or company';
  end if;
  if current_user in ('anon','authenticated') then
    if tg_op='DELETE' and old.origin='plaid' then raise exception 'Feed batches cannot be deleted'; end if;
    if tg_op='INSERT' and new.origin='plaid' then raise exception 'Feed batches are server-owned'; end if;
    if tg_op='UPDATE' and (old.origin='plaid' or new.origin='plaid') and
      (new.origin,new.source_id,new.period_start,new.period_end,new.feed_sequence,new.company_entity_id)
      is distinct from (old.origin,old.source_id,old.period_start,old.period_end,old.feed_sequence,old.company_entity_id) then
      raise exception 'Feed batch identity is server-owned';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.status='approved' and (tg_op='INSERT' or old.status<>'approved') then
    -- Existing Mark unposted preserves its reviewed snapshot while retiring
    -- the old posting claim. It must remain possible to reopen next, even
    -- when a provider exception is the reason the QBO entry was removed.
    if tg_op='UPDATE' and old.status='posted' and new.approval_snapshot is not distinct from old.approval_snapshot
      and new.approval_hash is not distinct from old.approval_hash and new.approval_version=old.approval_version then return new; end if;
    select * into v_source from public.card_sources where id=new.source_id;
    if exists(select 1 from public.plaid_sync_exceptions e join public.plaid_accounts a on a.id=e.account_id
      where a.source_id=new.source_id and e.status='open') then raise exception 'Resolve the bank feed change before approval'; end if;
    if exists(select 1 from public.card_transactions t where t.batch_id=new.id and t.origin='plaid' and t.status='coded'
      and (t.provider_status<>'posted' or t.currency is distinct from 'USD' or t.accounting_treatment='unknown')) then
      raise exception 'Included feed transactions require posted USD data and an accounting treatment';
    end if;
    -- Direction: the transaction's own amount against its treatment. No
    -- account join, so a split row is checked like any other.
    if exists(select 1 from public.card_transactions t
      where t.batch_id=new.id and t.origin='plaid' and t.status='coded'
        and ((t.accounting_treatment='purchase' and t.amount<=0)
        or (t.accounting_treatment in ('refund','deposit') and t.amount>=0))) then
      raise exception 'Review feed direction and clearing-account treatment; the bank feed owns card payments';
    end if;
    -- Account type: per POSTED LINE, so each line of a split is judged on the
    -- account it actually hits.
    if exists(select 1 from public.card_coding_effective_lines e
      join public.card_transactions t on t.id=e.transaction_id
      join public.quickbooks_accounts a
      on a.connection_id=new.qbo_connection_id and a.qbo_account_id=e.qbo_account_id and a.company_entity_id=new.company_entity_id
      where e.batch_id=new.id and t.origin='plaid' and
        ((t.accounting_treatment in ('transfer','payroll_settlement','shopify_settlement') and a.account_type not in ('Other Current Asset','Other Current Liability'))
        or (t.accounting_treatment='card_payment' and (v_source.source_type='card' or a.account_type not in ('Credit Card','Accounts Payable'))))) then
      raise exception 'Review feed direction and clearing-account treatment; the bank feed owns card payments';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists plaid_batch_integrity on public.card_import_batches;
create trigger plaid_batch_integrity before insert or update or delete on public.card_import_batches for each row execute function public.plaid_guard_batch();

-- ── Posting: one journal line per effective line ─────────────────────────
-- Re-created from 20260912000000 with the per-row validations and the line
-- aggregate reading card_coding_effective_lines, plus a re-check that every
-- split still totals its transaction before the snapshot is frozen.
-- Everything else -- auth, the batch lock, connection and balancing-account
-- resolution, the balancing line, the hash and the approval write -- is the
-- committed function unchanged.
create or replace function public.approve_card_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid := public.active_company_id();
  v_batch public.card_import_batches%rowtype;
  v_source public.card_sources%rowtype;
  v_connection uuid;
  v_connection_count integer;
  v_balancing_type text;
  v_lines jsonb;
  v_net numeric(14,2);
  v_snapshot jsonb;
  v_hash text;
begin
  if v_user is null or v_company is null
     or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;

  select * into v_batch from public.card_import_batches
  where id = p_batch_id and company_entity_id = v_company for update;
  if not found then raise exception 'Batch not found'; end if;
  if v_batch.status = 'approved' and v_batch.approval_snapshot is not null
     and v_batch.approval_hash is not null then
    return jsonb_build_object('id', p_batch_id, 'approval_hash', v_batch.approval_hash,
      'approval_version', v_batch.approval_version, 'already_approved', true);
  end if;
  if v_batch.status not in ('draft', 'categorized') then
    raise exception 'Batch cannot be approved from status %', v_batch.status;
  end if;
  if v_batch.entry_date is null then raise exception 'Batch has no entry date'; end if;

  select * into v_source from public.card_sources
  where id = v_batch.source_id and company_entity_id = v_company;
  if not found or not v_source.is_active then raise exception 'Card source is not active'; end if;
  if not v_source.posting_enabled then raise exception 'Posting is disabled for this card source'; end if;

  v_connection := coalesce(v_source.qbo_connection_id, v_batch.qbo_connection_id);
  if v_connection is null then
    select count(*), (array_agg(id order by id))[1] into v_connection_count, v_connection
    from public.quickbooks_connections
    where company_entity_id = v_company and is_active;
    if v_connection_count <> 1 then
      raise exception 'Select one active QuickBooks connection before approval';
    end if;
  end if;
  if not exists (
    select 1 from public.quickbooks_connections
    where id = v_connection and company_entity_id = v_company and is_active
  ) then raise exception 'QuickBooks connection is not active for this company'; end if;

  if v_source.credit_qbo_account_id is null then raise exception 'Balancing account is required'; end if;
  select account_type into v_balancing_type
  from public.quickbooks_accounts
    where connection_id = v_connection and company_entity_id = v_company
      and qbo_account_id = v_source.credit_qbo_account_id and is_active;
  if not found then raise exception 'Balancing account is not active on the selected QuickBooks connection'; end if;

  if exists (select 1 from public.card_transactions where batch_id = p_batch_id and status = 'uncoded') then
    raise exception 'Every transaction must be coded or excluded before approval';
  end if;
  if not exists (select 1 from public.card_transactions where batch_id = p_batch_id and status = 'coded') then
    raise exception 'No coded transactions to approve';
  end if;
  -- Validated through card_coding_effective_lines so a split line passes the
  -- same account, location and entity checks an ordinary coded line does.
  -- Reading card_transactions here instead would skip every split line, which
  -- is exactly the gap a second copy of these checks would leave.
  if exists (
    select 1 from public.card_coding_effective_lines e
    left join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = e.qbo_account_id and a.is_active
    where e.batch_id = p_batch_id and (e.qbo_account_id is null or a.id is null)
  ) then raise exception 'A coded line has an invalid QuickBooks account'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    where e.batch_id = p_batch_id and e.qbo_location_id is not null
      and not exists (
        select 1 from public.quickbooks_locations l
        where l.connection_id = v_connection and l.company_entity_id = v_company
          and l.qbo_location_id = e.qbo_location_id and l.is_active
      )
  ) then raise exception 'A coded line has an invalid QuickBooks location'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    join public.quickbooks_accounts a
      on a.connection_id = v_connection and a.company_entity_id = v_company
     and a.qbo_account_id = e.qbo_account_id
    where e.batch_id = p_batch_id
      and a.account_type in ('Accounts Receivable', 'Accounts Payable')
      and e.entity_qbo_id is null
  ) then raise exception 'Receivable and payable lines require an entity'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    where e.batch_id = p_batch_id and ((e.entity_qbo_id is null) <> (e.entity_type is null))
  ) then raise exception 'Entity id and type must be supplied together'; end if;
  if exists (
    select 1 from public.card_coding_effective_lines e
    where e.batch_id = p_batch_id and e.entity_qbo_id is not null
      and not (
        (e.entity_type = 'Customer' and exists (
          select 1 from public.quickbooks_customers c where c.connection_id = v_connection
            and c.company_entity_id = v_company and c.qbo_customer_id = e.entity_qbo_id and c.is_active
        )) or
        (e.entity_type = 'Vendor' and exists (
          select 1 from public.quickbooks_vendors ve where ve.connection_id = v_connection
            and ve.company_entity_id = v_company and ve.qbo_vendor_id = e.entity_qbo_id and ve.is_active
        ))
      )
  ) then raise exception 'A coded line has an invalid QuickBooks entity'; end if;
  -- A split whose lines no longer total its transaction cannot be posted: the
  -- settlement side is computed from the batch total, so the entry would be
  -- unbalanced or would move money the statement never moved. The deferred
  -- constraint makes this unreachable; it is re-checked because approval is
  -- the last point before the numbers are frozen and sent to Intuit.
  if exists (
    select 1 from public.card_transactions t
    join (select transaction_id, sum(amount) total from public.card_transaction_splits group by transaction_id) s
      on s.transaction_id = t.id
    where t.batch_id = p_batch_id and t.status = 'coded' and round(s.total, 2) <> round(t.amount, 2)
  ) then raise exception 'A split transaction does not total its own amount; no entry was approved'; end if;

  select coalesce(round(sum(round(e.amount, 2)), 2), 0),
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'DetailType', 'JournalEntryLineDetail',
           'Amount', abs(round(e.amount, 2)),
           'Description', left(concat_ws(' · ', e.txn_date::text, e.description,
             case when e.is_split then coalesce(nullif(e.memo, ''), 'split ' || e.line_no::text) end), 4000),
           'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
             'PostingType', case when e.amount >= 0 then 'Debit' else 'Credit' end,
             'AccountRef', jsonb_build_object('value', e.qbo_account_id),
             'Entity', case when e.entity_qbo_id is not null then jsonb_build_object(
               'Type', e.entity_type, 'EntityRef', jsonb_build_object('value', e.entity_qbo_id)) end,
             'DepartmentRef', case when coalesce(e.qbo_location_id, v_source.default_qbo_location_id) is not null
               then jsonb_build_object('value', coalesce(e.qbo_location_id, v_source.default_qbo_location_id)) end
           ))
         )) order by e.row_no nulls last, e.transaction_id, e.line_no)
    into v_net, v_lines
  from public.card_coding_effective_lines e
  where e.batch_id = p_batch_id and round(e.amount, 2) <> 0;
  if v_lines is null then raise exception 'Every coded transaction rounds to zero'; end if;

  if v_source.default_qbo_location_id is not null and not exists (
    select 1 from public.quickbooks_locations
    where connection_id = v_connection and company_entity_id = v_company
      and qbo_location_id = v_source.default_qbo_location_id and is_active
  ) then raise exception 'Default location is not active on the selected QuickBooks connection'; end if;

  if v_net <> 0 then
    if v_balancing_type = 'Accounts Payable' then
      if v_source.credit_vendor_qbo_id is null or not exists (
        select 1 from public.quickbooks_vendors where connection_id = v_connection
          and company_entity_id = v_company and qbo_vendor_id = v_source.credit_vendor_qbo_id and is_active
      ) then raise exception 'The balancing payable account requires a valid vendor'; end if;
    elsif v_balancing_type = 'Accounts Receivable' then
      if v_source.credit_vendor_qbo_id is null or not exists (
        select 1 from public.quickbooks_customers where connection_id = v_connection
          and company_entity_id = v_company and qbo_customer_id = v_source.credit_vendor_qbo_id and is_active
      ) then raise exception 'The balancing receivable account requires a valid customer'; end if;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'DetailType', 'JournalEntryLineDetail', 'Amount', abs(v_net),
      'Description', left(trim(v_source.display_name || ' ' || coalesce(v_batch.label, '')), 4000),
      'JournalEntryLineDetail', jsonb_strip_nulls(jsonb_build_object(
        'PostingType', case when v_net >= 0 then 'Credit' else 'Debit' end,
        'AccountRef', jsonb_build_object('value', v_source.credit_qbo_account_id),
        'Entity', case when v_source.credit_vendor_qbo_id is not null then jsonb_build_object(
          'Type', case when v_balancing_type = 'Accounts Receivable' then 'Customer' else 'Vendor' end,
          'EntityRef', jsonb_build_object('value', v_source.credit_vendor_qbo_id)) end,
        'DepartmentRef', case when v_source.default_qbo_location_id is not null
          then jsonb_build_object('value', v_source.default_qbo_location_id) end
      ))
    )));
  end if;

  v_snapshot := jsonb_build_object(
    'schema_version', 1, 'kind', 'card_batch', 'qbo_connection_id', v_connection,
    'source', 'card_import', 'source_ref', p_batch_id,
    'period_start', v_batch.period_start, 'period_end', v_batch.period_end,
    'payload', jsonb_build_object(
      'TxnDate', v_batch.entry_date,
      'PrivateNote', left(trim('SILO card coding · ' || v_source.display_name || ' · ' || coalesce(v_batch.label, '')), 4000),
      'Line', v_lines));
  v_hash := public.finance_approval_snapshot_hash(v_snapshot);

  update public.card_sources set qbo_connection_id = v_connection, updated_at = now()
  where id = v_source.id and qbo_connection_id is null;
  update public.card_import_batches set
    status = 'approved', approved_at = now(), approved_by = v_user,
    approval_version = approval_version + 1,
    approval_snapshot = v_snapshot, approval_hash = v_hash,
    qbo_connection_id = v_connection, updated_at = now(),
    approval_reopened_at = null, approval_reopened_by = null, approval_reopen_reason = null
  where id = p_batch_id;
  return jsonb_build_object('id', p_batch_id, 'approval_hash', v_hash,
    'approval_version', v_batch.approval_version + 1);
end;
$$;
