-- Match a card paydown to the bank payment that made it (2026-11-25).
--
-- A card feed and a bank feed both show the same paydown: the card shows money
-- arriving, the bank shows money leaving. Only ONE of them may reach the books,
-- and it is the bank side -- that is what approval means by "the bank feed owns
-- card payments" (plaid_guard_batch, 20261103070000). Until now the only way to
-- settle the card side was to exclude it by hand and write a reason, which is
-- both a guess and a dead end: nothing recorded WHICH payment it was.
--
-- This records the pair. The card row is excluded with the bank row named in
-- its reason, and the link is kept so the pairing can be read back and undone.
--
-- The bank side is never written to. That is deliberate and it is the whole
-- point of the design: the paying account is usually days ahead of the card
-- review, so its row may already be coded, approved or posted. Reading it is
-- always allowed; writing it would not be, and would have made the common case
-- -- the bank side already done -- the one case this could not settle.
--
-- Generic: nothing here names a company, an account or a provider. A card
-- source is one whose source_type is 'card'; a paying account is one whose
-- source_type is 'bank'; the pairing rule is amount and date alone.

create table if not exists public.card_payment_matches (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  card_transaction_id uuid not null unique references public.card_transactions(id) on delete cascade,
  bank_transaction_id uuid not null unique references public.card_transactions(id) on delete cascade,
  note text,
  matched_at timestamptz not null default now(),
  matched_by uuid default auth.uid(),
  constraint card_payment_matches_two_sides check (card_transaction_id <> bank_transaction_id)
);

create index if not exists card_payment_matches_company_idx
  on public.card_payment_matches (company_entity_id, bank_transaction_id);

alter table public.card_payment_matches enable row level security;

drop policy if exists card_payment_matches_select on public.card_payment_matches;
create policy card_payment_matches_select on public.card_payment_matches
  for select using (company_entity_id = (select public.active_company_id()));

-- The same authority that codes and approves the transactions themselves.
drop policy if exists card_payment_matches_write on public.card_payment_matches;
create policy card_payment_matches_write on public.card_payment_matches
  for all using (company_entity_id = (select public.active_company_id())
      and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())))
  with check (company_entity_id = (select public.active_company_id())
      and ((select public.can_manage_journal_entries()) or (select public.is_exec_or_owner())));

-- The record cannot say something the transactions do not. Written as a
-- trigger rather than left to the RPC so a direct client insert is held to the
-- same rules: both rows in one company, amounts that offset to the cent, the
-- paying side a bank account, the two sides different accounts, and the card
-- side actually excluded -- a link that does not keep a row out of the books
-- would be a note that looks like a safeguard.
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
  if coalesce(v_bank_src.source_type, '') <> 'bank' then raise exception 'The paying side must be a bank account'; end if;
  if coalesce(v_card.amount, 0) = 0 or round(v_bank.amount, 2) <> round(-v_card.amount, 2) then
    raise exception 'The two amounts do not offset';
  end if;
  if v_card.status <> 'excluded' then
    raise exception 'The card side must be excluded from its entry before it is matched';
  end if;
  return new;
end $cpm$;

drop trigger if exists card_payment_match_integrity on public.card_payment_matches;
create trigger card_payment_match_integrity before insert or update on public.card_payment_matches
  for each row execute function public.card_payment_match_integrity();

-- Candidates: the bank rows that could be this paydown. Amount to the cent and
-- a date window, nothing cleverer -- a description match would be a guess, and
-- the person picking is looking at both rows. Already-linked bank rows are left
-- out so one payment cannot settle two card rows. SECURITY INVOKER: a reader
-- sees only their own company's rows, through the same policies as everywhere.
create or replace function public.card_payment_match_candidates(p_transaction_id uuid, p_days integer default 7)
returns table (transaction_id uuid, txn_date date, amount numeric, description text,
  source_name text, batch_status text, qbo_account_name text, accounting_treatment text, day_gap integer)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpc$
  with card as (
    select t.id, t.company_entity_id, t.amount, t.txn_date, b.source_id
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    where t.id = p_transaction_id and coalesce(t.amount, 0) <> 0 and t.txn_date is not null
  )
  select t.id, t.txn_date, t.amount, t.description, s.display_name, b.status,
         t.qbo_account_name, t.accounting_treatment, abs(t.txn_date - c.txn_date)::integer
  from card c
  join public.card_transactions t on t.company_entity_id = c.company_entity_id and t.id <> c.id
  join public.card_import_batches b on b.id = t.batch_id and b.status <> 'voided'
  join public.card_sources s on s.id = b.source_id and s.source_type = 'bank' and s.id <> c.source_id
  where round(t.amount, 2) = round(-c.amount, 2)
    and t.txn_date between c.txn_date - greatest(coalesce(p_days, 7), 0)
                       and c.txn_date + greatest(coalesce(p_days, 7), 0)
    and t.status <> 'excluded'
    and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)
  order by abs(t.txn_date - c.txn_date), t.txn_date desc
  limit 25;
$cpc$;

-- Linking is one transaction: the card row is excluded and the pairing is
-- recorded, or neither happens. The UPDATE runs under the caller's own RLS, so
-- a card row in an approved or posted import is refused here exactly as it is
-- in Transactions -- and an RLS-refused UPDATE changes zero rows rather than
-- raising, which is why the row count is read back by name.
create or replace function public.link_card_payment_match(p_card_transaction_id uuid, p_bank_transaction_id uuid)
returns jsonb language plpgsql security invoker set search_path = 'public', 'pg_temp' as $lcm$
declare v_card public.card_transactions%rowtype; v_bank public.card_transactions%rowtype;
  v_bank_src public.card_sources%rowtype; v_reason text; v_rows integer;
begin
  select * into v_card from public.card_transactions where id = p_card_transaction_id;
  if not found then raise exception 'That transaction is not available'; end if;
  select * into v_bank from public.card_transactions where id = p_bank_transaction_id;
  if not found then raise exception 'That bank transaction is not available'; end if;
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

  insert into public.card_payment_matches (company_entity_id, card_transaction_id, bank_transaction_id, note)
  values (v_card.company_entity_id, v_card.id, v_bank.id, v_reason)
  on conflict (card_transaction_id) do update
    set bank_transaction_id = excluded.bank_transaction_id, note = excluded.note,
        matched_at = now(), matched_by = auth.uid();

  return jsonb_build_object('status', 'excluded', 'exclude_reason', v_reason,
    'bank_transaction_id', v_bank.id, 'bank_source_name', v_bank_src.display_name, 'bank_txn_date', v_bank.txn_date);
end $lcm$;

-- Undoing it puts the card row back where it was. A provider row that is
-- pending, removed or not in USD must stay excluded (plaid_guard_transaction
-- refuses anything else), so it keeps its place and says why rather than
-- failing the whole undo.
create or replace function public.unlink_card_payment_match(p_card_transaction_id uuid)
returns jsonb language plpgsql security invoker set search_path = 'public', 'pg_temp' as $ucm$
declare v_card public.card_transactions%rowtype; v_status text; v_reason text; v_rows integer;
begin
  select * into v_card from public.card_transactions where id = p_card_transaction_id;
  if not found then raise exception 'That transaction is not available'; end if;
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

  delete from public.card_payment_matches m where m.card_transaction_id = v_card.id;
  return jsonb_build_object('status', v_status, 'exclude_reason', v_reason);
end $ucm$;

-- Supabase's default privileges re-grant EXECUTE to anon on every new public
-- function, and PostgreSQL grants it to PUBLIC besides. Both are taken back;
-- only a signed-in reader may call these, and RLS decides the rest.
revoke all on function public.card_payment_match_candidates(uuid, integer) from public, anon;
revoke all on function public.link_card_payment_match(uuid, uuid) from public, anon;
revoke all on function public.unlink_card_payment_match(uuid) from public, anon;
revoke all on function public.card_payment_match_integrity() from public, anon, authenticated;
grant execute on function public.card_payment_match_candidates(uuid, integer) to authenticated;
grant execute on function public.link_card_payment_match(uuid, uuid) to authenticated;
grant execute on function public.unlink_card_payment_match(uuid) to authenticated;
revoke all on public.card_payment_matches from public, anon;
grant select, insert, update, delete on public.card_payment_matches to authenticated;

select public.attach_stamp_company_entity_id_triggers();
