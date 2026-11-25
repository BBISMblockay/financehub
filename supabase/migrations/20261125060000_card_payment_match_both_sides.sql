-- A matched paydown settles BOTH sides, and the matches are offered rather
-- than hunted (2026-11-25).
--
-- 20261125020000 recorded the pair and excluded the card side. Two things were
-- left to the person, and both are work SILO already knows how to do:
--
--   1. The PAYING row stayed uncategorized. It is the side that posts, and the
--      account it must hit is not a judgement call -- it is the liability
--      account of the source being paid, which the card source already names.
--      So confirming a match now codes it: treatment from the account's type,
--      account from the source. If that row's import is already approved or
--      posted it is left exactly as it is; it is in the books already.
--   2. Finding a match meant opening each row and pressing a button.
--      card_payment_match_proposals answers for a whole screen at once, so the
--      page can offer "this looks like the payment" and the person confirms.
--
-- Generic: nothing here names a company, a bank or a card. The two sides are
-- told apart by the QuickBooks ACCOUNT TYPE behind each source -- a source
-- whose credit account is a Bank account pays; a source whose credit account
-- is a liability is paid -- so a line of credit, a payable card or a second
-- checking account all work without a special case.

alter table public.card_payment_matches
  add column if not exists payer_coded_at timestamptz,
  add column if not exists payer_prior jsonb;

comment on column public.card_payment_matches.payer_prior is
  'How the paying row was coded before the match coded it, so undoing the match can put it back exactly. Null when the match did not code it.';

-- The treatment the paying row must carry, decided by the TYPE of the account
-- it will hit. These are approval''s own rules (plaid_guard_batch): a card
-- payment may only land on Credit Card or Accounts Payable, and a transfer
-- only on an Other Current Asset or Other Current Liability. Anything else
-- returns null, and the match then leaves the paying row for a person -- a
-- guess here would be refused at approval, which is a worse place to find out.
create or replace function public.card_payment_posting_treatment(p_account_type text)
returns text language sql immutable set search_path = 'public', 'pg_temp' as $cpt$
  select case
    when p_account_type in ('Credit Card', 'Accounts Payable') then 'card_payment'
    when p_account_type in ('Other Current Asset', 'Other Current Liability', 'Bank') then 'transfer'
    else null end;
$cpt$;

-- Candidates: the rows that could be the payment for this one. Amount to the
-- cent and a date window, nothing cleverer. The payer must be a source whose
-- credit account is a BANK account -- that is what "the bank feed owns card
-- payments" means once it is said in terms of accounts rather than of cards.
create or replace function public.card_payment_match_candidates(p_transaction_id uuid, p_days integer default 7)
returns table (transaction_id uuid, txn_date date, amount numeric, description text,
  source_name text, batch_status text, qbo_account_name text, accounting_treatment text, day_gap integer)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpc$
  with card as (
    select t.id, t.company_entity_id, t.amount, t.txn_date, b.source_id
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    where t.id = p_transaction_id and coalesce(t.amount, 0) < 0 and t.txn_date is not null
  )
  select t.id, t.txn_date, t.amount, t.description, s.display_name, b.status,
         t.qbo_account_name, t.accounting_treatment, abs(t.txn_date - c.txn_date)::integer
  from card c
  join public.card_transactions t on t.company_entity_id = c.company_entity_id and t.id <> c.id
  join public.card_import_batches b on b.id = t.batch_id and b.status <> 'voided'
  join public.card_sources s on s.id = b.source_id and s.id <> c.source_id
    and s.credit_qbo_account_type = 'Bank'
  where round(t.amount, 2) = round(-c.amount, 2)
    and t.txn_date between c.txn_date - greatest(coalesce(p_days, 7), 0)
                       and c.txn_date + greatest(coalesce(p_days, 7), 0)
    and t.status <> 'excluded'
    and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)
  order by abs(t.txn_date - c.txn_date), t.txn_date desc
  limit 25;
$cpc$;

-- The record cannot say something the transactions do not. Written as a
-- trigger rather than left to the RPC so a direct client insert is held to the
-- same rules: both rows in one company, amounts that offset to the cent, the
-- paying side an account of type Bank, the two sides different accounts, and
-- the settled side actually excluded.
create or replace function public.card_payment_match_integrity()
returns trigger language plpgsql security invoker set search_path = 'public', 'pg_temp' as $cpm$
declare v_card public.card_transactions%rowtype; v_bank public.card_transactions%rowtype;
  v_card_src public.card_sources%rowtype; v_bank_src public.card_sources%rowtype;
begin
  select * into v_card from public.card_transactions where id = new.card_transaction_id;
  if not found then raise exception 'The card transaction no longer exists'; end if;
  select * into v_bank from public.card_transactions where id = new.bank_transaction_id;
  if not found then raise exception 'The bank transaction no longer exists'; end if;
  if v_card.company_entity_id <> v_bank.company_entity_id
     or v_card.company_entity_id <> new.company_entity_id then
    raise exception 'Both transactions must belong to the same company';
  end if;
  select s.* into v_card_src from public.card_sources s
    join public.card_import_batches b on b.source_id = s.id where b.id = v_card.batch_id;
  select s.* into v_bank_src from public.card_sources s
    join public.card_import_batches b on b.source_id = s.id where b.id = v_bank.batch_id;
  if v_card_src.id is null or v_bank_src.id is null then raise exception 'An account for these transactions is missing'; end if;
  if v_card_src.id = v_bank_src.id then raise exception 'A payment must come from a different account'; end if;
  if coalesce(v_bank_src.credit_qbo_account_type, '') <> 'Bank' then
    raise exception 'The paying side must be an account of type Bank';
  end if;
  if coalesce(v_card.amount, 0) >= 0 then
    raise exception 'Only money arriving on the account being paid is a paydown';
  end if;
  if round(v_bank.amount, 2) <> round(-v_card.amount, 2) then
    raise exception 'The two amounts do not offset';
  end if;
  if v_card.status <> 'excluded' then
    raise exception 'The settled side must be excluded from its entry before it is matched';
  end if;
  return new;
end $cpm$;

drop trigger if exists card_payment_match_integrity on public.card_payment_matches;
create trigger card_payment_match_integrity before insert or update on public.card_payment_matches
  for each row execute function public.card_payment_match_integrity();

-- What a whole screen of transactions should be offered, in one call, so the
-- person confirms a match instead of looking for one. A row with exactly one
-- candidate carries it; a row with several carries the count and no pick,
-- because choosing between two payments of the same amount is the one part of
-- this that is a judgement.
create or replace function public.card_payment_match_proposals(p_transaction_ids uuid[], p_days integer default 7)
returns table (transaction_id uuid, candidate_count integer, bank_transaction_id uuid,
  bank_txn_date date, bank_amount numeric, bank_source_name text, bank_batch_status text,
  bank_description text)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpp$
  with scope as (
    select t.id, t.amount
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    join public.card_sources s on s.id = b.source_id
    where t.id = any(coalesce(p_transaction_ids, '{}'::uuid[]))
      and coalesce(t.amount, 0) < 0
      and coalesce(s.credit_qbo_account_type, '') <> 'Bank'
      and not exists (select 1 from public.card_payment_matches m where m.card_transaction_id = t.id)
    limit 400
  ), found as (
    select sc.id, c.*, count(*) over (partition by sc.id) as n,
           row_number() over (partition by sc.id order by c.day_gap, c.txn_date desc) as rn
    from scope sc
    cross join lateral public.card_payment_match_candidates(sc.id, p_days) c
  )
  select f.id, f.n::integer, case when f.n = 1 then f.transaction_id end,
         case when f.n = 1 then f.txn_date end, case when f.n = 1 then f.amount end,
         case when f.n = 1 then f.source_name end, case when f.n = 1 then f.batch_status end,
         case when f.n = 1 then f.description end
  from found f where f.rn = 1;
$cpp$;

-- Linking is one transaction: the settled row is excluded, the paying row is
-- coded where it can be, and the pairing is recorded, or none of it happens.
-- The UPDATEs run under the caller's own RLS, so a row in an approved or
-- posted import is refused exactly as it is in Transactions -- and an
-- RLS-refused UPDATE changes zero rows rather than raising, which is why the
-- row count is read back by name. For the settled row that is an error; for
-- the paying row it is the ordinary case of a payment already in the books,
-- and the match simply records the pairing without touching it.
create or replace function public.link_card_payment_match(p_card_transaction_id uuid, p_bank_transaction_id uuid)
returns jsonb language plpgsql security invoker set search_path = 'public', 'pg_temp' as $lcm$
declare v_card public.card_transactions%rowtype; v_bank public.card_transactions%rowtype;
  v_card_src public.card_sources%rowtype; v_bank_src public.card_sources%rowtype;
  v_reason text; v_rows integer; v_treatment text; v_prior jsonb; v_coded boolean := false;
begin
  select * into v_card from public.card_transactions where id = p_card_transaction_id;
  if not found then raise exception 'That transaction is not available'; end if;
  select * into v_bank from public.card_transactions where id = p_bank_transaction_id;
  if not found then raise exception 'That bank transaction is not available'; end if;
  if v_bank.status = 'excluded' then
    raise exception 'That payment has since been excluded from its own entry — search again and pick the payment that posts';
  end if;
  if exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = v_bank.id
             and m.card_transaction_id <> v_card.id) then
    raise exception 'That payment is already matched to another transaction';
  end if;
  select s.* into v_card_src from public.card_sources s
    join public.card_import_batches b on b.source_id = s.id where b.id = v_card.batch_id;
  select s.* into v_bank_src from public.card_sources s
    join public.card_import_batches b on b.source_id = s.id where b.id = v_bank.batch_id;
  v_reason := 'Paid by ' || coalesce(nullif(v_bank_src.display_name, ''), 'the bank account')
    || ' on ' || to_char(v_bank.txn_date, 'YYYY-MM-DD') || ' — matched to the bank feed, which posts this payment';

  update public.card_transactions t
     set status = 'excluded', exclude_reason = v_reason, updated_at = now(), updated_by = auth.uid()
   where t.id = v_card.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'This transaction cannot be changed — its import is approved or posted, or you do not have finance access';
  end if;

  -- The paying row posts this payment, and the account it must hit is the
  -- liability account of the source being paid. A split row is left alone:
  -- its lines are somebody's deliberate work, and nothing here can know what
  -- the rest of them are for.
  v_treatment := public.card_payment_posting_treatment(v_card_src.credit_qbo_account_type);
  if v_treatment is not null and v_card_src.credit_qbo_account_id is not null
     and not exists (select 1 from public.card_transaction_splits sp where sp.transaction_id = v_bank.id) then
    v_prior := jsonb_build_object('status', v_bank.status, 'qbo_account_id', v_bank.qbo_account_id,
      'qbo_account_name', v_bank.qbo_account_name, 'accounting_treatment', v_bank.accounting_treatment,
      'coding_source', v_bank.coding_source);
    update public.card_transactions t
       set status = 'coded', qbo_account_id = v_card_src.credit_qbo_account_id,
           qbo_account_name = v_card_src.credit_qbo_account_name,
           accounting_treatment = v_treatment, coding_source = 'manual', coding_conflict = null,
           updated_at = now(), updated_by = auth.uid()
     where t.id = v_bank.id;
    get diagnostics v_rows = row_count;
    v_coded := v_rows > 0;
  end if;

  insert into public.card_payment_matches (company_entity_id, card_transaction_id, bank_transaction_id, note,
      payer_coded_at, payer_prior)
  values (v_card.company_entity_id, v_card.id, v_bank.id, v_reason,
      case when v_coded then now() end, case when v_coded then v_prior end)
  on conflict (card_transaction_id) do update
    set bank_transaction_id = excluded.bank_transaction_id, note = excluded.note,
        matched_at = now(), matched_by = auth.uid(),
        payer_coded_at = excluded.payer_coded_at, payer_prior = excluded.payer_prior;

  return jsonb_build_object('status', 'excluded', 'exclude_reason', v_reason,
    'bank_transaction_id', v_bank.id, 'bank_source_name', v_bank_src.display_name,
    'bank_txn_date', v_bank.txn_date, 'bank_coded', v_coded,
    'bank_qbo_account_name', case when v_coded then v_card_src.credit_qbo_account_name end,
    'bank_accounting_treatment', case when v_coded then v_treatment end);
end $lcm$;

-- Undoing it puts both rows back where they were. The paying row is restored
-- only while it still carries exactly what the match wrote: once somebody has
-- changed it themselves, their coding is the newer decision and stands.
create or replace function public.unlink_card_payment_match(p_card_transaction_id uuid)
returns jsonb language plpgsql security invoker set search_path = 'public', 'pg_temp' as $ucm$
declare v_card public.card_transactions%rowtype; v_bank public.card_transactions%rowtype;
  v_card_src public.card_sources%rowtype; v_match public.card_payment_matches%rowtype;
  v_status text; v_reason text; v_rows integer; v_treatment text; v_restored boolean := false;
begin
  select * into v_card from public.card_transactions where id = p_card_transaction_id;
  if not found then raise exception 'That transaction is not available'; end if;
  select * into v_match from public.card_payment_matches where card_transaction_id = v_card.id;

  if v_card.origin = 'plaid' and (v_card.provider_status is distinct from 'posted' or v_card.currency is distinct from 'USD') then
    v_status := 'excluded'; v_reason := 'Pending or non-USD bank transaction';
  elsif v_card.qbo_account_id is not null
     or exists (select 1 from public.card_transaction_splits sp where sp.transaction_id = v_card.id) then
    v_status := 'coded'; v_reason := null;
  else
    v_status := 'uncoded'; v_reason := null;
  end if;

  update public.card_transactions t
     set status = v_status, exclude_reason = v_reason, updated_at = now(), updated_by = auth.uid()
   where t.id = v_card.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'This transaction cannot be changed — its import is approved or posted, or you do not have finance access';
  end if;

  if v_match.payer_coded_at is not null and v_match.payer_prior is not null then
    select * into v_bank from public.card_transactions where id = v_match.bank_transaction_id;
    select s.* into v_card_src from public.card_sources s
      join public.card_import_batches b on b.source_id = s.id where b.id = v_card.batch_id;
    v_treatment := public.card_payment_posting_treatment(v_card_src.credit_qbo_account_type);
    if v_bank.id is not null and v_bank.status = 'coded'
       and v_bank.qbo_account_id is not distinct from v_card_src.credit_qbo_account_id
       and v_bank.accounting_treatment is not distinct from v_treatment then
      update public.card_transactions t
         set status = v_match.payer_prior->>'status',
             qbo_account_id = v_match.payer_prior->>'qbo_account_id',
             qbo_account_name = v_match.payer_prior->>'qbo_account_name',
             accounting_treatment = coalesce(v_match.payer_prior->>'accounting_treatment', 'unknown'),
             coding_source = v_match.payer_prior->>'coding_source',
             updated_at = now(), updated_by = auth.uid()
       where t.id = v_bank.id;
      get diagnostics v_rows = row_count;
      v_restored := v_rows > 0;
    end if;
  end if;

  delete from public.card_payment_matches m where m.card_transaction_id = v_card.id;
  return jsonb_build_object('status', v_status, 'exclude_reason', v_reason,
    'bank_transaction_id', v_match.bank_transaction_id, 'bank_restored', v_restored);
end $ucm$;

-- Supabase's default privileges re-grant EXECUTE to anon on every new public
-- function, and PostgreSQL grants it to PUBLIC besides. Both are taken back.
revoke all on function public.card_payment_posting_treatment(text) from public, anon;
revoke all on function public.card_payment_match_candidates(uuid, integer) from public, anon;
revoke all on function public.card_payment_match_proposals(uuid[], integer) from public, anon;
revoke all on function public.link_card_payment_match(uuid, uuid) from public, anon;
revoke all on function public.unlink_card_payment_match(uuid) from public, anon;
revoke all on function public.card_payment_match_integrity() from public, anon, authenticated;
grant execute on function public.card_payment_posting_treatment(text) to authenticated;
grant execute on function public.card_payment_match_candidates(uuid, integer) to authenticated;
grant execute on function public.card_payment_match_proposals(uuid[], integer) to authenticated;
grant execute on function public.link_card_payment_match(uuid, uuid) to authenticated;
grant execute on function public.unlink_card_payment_match(uuid) to authenticated;

select public.attach_stamp_company_entity_id_triggers();
