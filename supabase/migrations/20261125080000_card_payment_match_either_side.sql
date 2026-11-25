-- A match can be confirmed from either side (2026-11-25).
--
-- 20261125060000 offered a match only where the paydown is: on the card, the
-- line of credit, the payable. But the person reconciling is as often looking
-- at the bank account, where the same pair is just as visible and nothing said
-- so. The pairing rule does not change -- amount to the cent, a date window,
-- the paying side an account of type Bank -- only which row you can be
-- standing on when you confirm it.
--
-- The reverse lookup is NOT the forward one with its arguments swapped. From
-- the bank side the row that must change is the OTHER one, so a candidate is
-- only a candidate while its own import can still be edited: offering a
-- paydown in an approved or posted import would be offering something the
-- confirm would then refuse. From the card side the opposite holds and is
-- deliberate -- the paying row is read, never written, so its import may be
-- anything at all.

-- Both directions walk a company's transactions inside a date window, and the
-- reverse one is asked for a whole bank screen at once, so the window needs an
-- index of its own: company and date alone, since the amount test is an
-- equality on a rounded value that no index on amount would serve anyway.
create index if not exists card_transactions_company_date_idx
  on public.card_transactions (company_entity_id, txn_date);

create or replace function public.card_payment_settlement_candidates(p_transaction_id uuid, p_days integer default 7)
returns table (transaction_id uuid, txn_date date, amount numeric, description text,
  source_name text, batch_status text, qbo_account_name text, accounting_treatment text, day_gap integer)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cps$
  with payer as (
    select t.id, t.company_entity_id, t.amount, t.txn_date, b.source_id
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    join public.card_sources s on s.id = b.source_id and s.credit_qbo_account_type = 'Bank'
    where t.id = p_transaction_id and coalesce(t.amount, 0) > 0 and t.txn_date is not null
      and t.status <> 'excluded'
      and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)
  )
  select t.id, t.txn_date, t.amount, t.description, s.display_name, b.status,
         t.qbo_account_name, t.accounting_treatment, abs(t.txn_date - p.txn_date)::integer
  from payer p
  join public.card_transactions t on t.company_entity_id = p.company_entity_id and t.id <> p.id
  -- Only an import still open: this is the row the confirm has to change.
  join public.card_import_batches b on b.id = t.batch_id and b.status in ('draft', 'categorized')
  join public.card_sources s on s.id = b.source_id and s.id <> p.source_id
    and coalesce(s.credit_qbo_account_type, '') <> 'Bank'
  where round(t.amount, 2) = round(-p.amount, 2)
    and t.txn_date between p.txn_date - greatest(coalesce(p_days, 7), 0)
                       and p.txn_date + greatest(coalesce(p_days, 7), 0)
    and not exists (select 1 from public.card_payment_matches m where m.card_transaction_id = t.id)
  order by abs(t.txn_date - p.txn_date), t.txn_date desc
  limit 25;
$cps$;

-- One answer for a whole screen, whichever side the screen is. `side` says
-- which row was asked about ('paydown' = the row that leaves the entry,
-- 'payment' = the row that posts), and the other_* columns describe its
-- counterpart.
--
-- A NEW NAME rather than a wider card_payment_match_proposals: its columns
-- change, which a create-or-replace cannot do, and a drop would make
-- 20261125060000 fail the next time anything re-ran it in order (apply_all
-- does exactly that). The old one is dropped here and nothing calls it; if a
-- re-run of that migration brings it back, it is harmless.
drop function if exists public.card_payment_match_proposals(uuid[], integer);
create or replace function public.card_payment_match_offers(p_transaction_ids uuid[], p_days integer default 7)
returns table (transaction_id uuid, side text, candidate_count integer, other_transaction_id uuid,
  other_txn_date date, other_amount numeric, other_source_name text, other_batch_status text,
  other_description text)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpp$
  with scope as (
    select t.id, case when coalesce(s.credit_qbo_account_type, '') = 'Bank' then 'payment' else 'paydown' end as side
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    join public.card_sources s on s.id = b.source_id
    where t.id = any(coalesce(p_transaction_ids, '{}'::uuid[]))
      and ((coalesce(s.credit_qbo_account_type, '') <> 'Bank' and coalesce(t.amount, 0) < 0
            and not exists (select 1 from public.card_payment_matches m where m.card_transaction_id = t.id))
        or (coalesce(s.credit_qbo_account_type, '') = 'Bank' and coalesce(t.amount, 0) > 0
            and t.status <> 'excluded'
            and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)))
    limit 400
  ), found as (
    select sc.id, sc.side, c.*, count(*) over (partition by sc.id) as n,
           row_number() over (partition by sc.id order by c.day_gap, c.txn_date desc) as rn
    from scope sc
    cross join lateral (
      select * from public.card_payment_match_candidates(sc.id, p_days) where sc.side = 'paydown'
      union all
      select * from public.card_payment_settlement_candidates(sc.id, p_days) where sc.side = 'payment'
    ) c
  )
  select f.id, f.side, f.n::integer, case when f.n = 1 then f.transaction_id end,
         case when f.n = 1 then f.txn_date end, case when f.n = 1 then f.amount end,
         case when f.n = 1 then f.source_name end, case when f.n = 1 then f.batch_status end,
         case when f.n = 1 then f.description end
  from found f where f.rn = 1;
$cpp$;

revoke all on function public.card_payment_settlement_candidates(uuid, integer) from public, anon;
revoke all on function public.card_payment_match_offers(uuid[], integer) from public, anon;
grant execute on function public.card_payment_settlement_candidates(uuid, integer) to authenticated;
grant execute on function public.card_payment_match_offers(uuid[], integer) to authenticated;
