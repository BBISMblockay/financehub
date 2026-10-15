-- When SILO starts posting an account
--
-- Different accounts came under SILO at different times. Baseballism's card
-- accounts began in August 2026 (accounting_settings.accounting_start_date =
-- 2026-08-01); the Plaid bank feed only began in September, and its July and
-- August periods were coded inside QuickBooks directly off a three-month Plaid
-- backload. Those two months are therefore NOT work waiting to be done -- they
-- are already in QuickBooks by hand -- but SILO had no way to say so:
--
--   * On Deck listed both at stage 'approve', indistinguishable from a month
--     nobody had got to.
--   * Approve would have accepted them, leaving each one click from a post
--     that would duplicate the manual entries in QuickBooks.
--   * SILO's own ledger recorded August's 620 coded rows (435 entries), because
--     a coded transaction is recorded from accounting_start_date whether or not
--     it was ever sent -- so the Books & setup roll-forward counted that
--     activity as SILO's unsent record AND, through the QuickBooks closing
--     balance, as other activity in QuickBooks.
--
-- `card_sources.posting_start_on` is the first day SILO may post an account,
-- and the first day its transactions enter SILO's ledger. NULL keeps today's
-- behaviour exactly, so nothing changes for any account until a date is set.
-- It does not touch accounting_start_date: moving that resyncs the whole
-- company's ledger, and the two dates mean different things.
--
-- Written by whoever can already approve (card_sources_write: finance or
-- exec/owner), so this is a guard against accident, not a lock against them.

alter table public.card_sources
  add column if not exists posting_start_on date;

comment on column public.card_sources.posting_start_on is
  'First day SILO may post this account, and the first day its transactions enter SILO ledger. NULL = no cut-over: every period is SILO''s. Set when an account comes under SILO later than the company books (a provider backload of months already entered in QuickBooks by hand).';

-- ── The ledger honours it too ───────────────────────────────────────────────
-- silo_ledger_desired_lines records nothing for a transaction dated before this
-- start, so setting the date stops new records at once. Entries ALREADY written
-- for earlier months are reversed, never deleted (ledger_entries is
-- append-only): silo_ledger_resync_posting_start below does that in pages,
-- because a browser statement has 8s and one source can carry thousands of
-- transactions.
create or replace function public.silo_ledger_start(p_source public.card_sources)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(st.accounting_start_date,
                  coalesce(p_source.authoritative_from, st.accounting_start_date),
                  coalesce(p_source.posting_start_on, st.accounting_start_date))
  from public.accounting_settings st
  join public.accounting_opening_balances ob on ob.company_entity_id = st.company_entity_id and ob.status = 'accepted'
  where st.company_entity_id = p_source.company_entity_id;
$$;

-- posting_start_on is deliberately NOT in silo_ledger_on_source's change list:
-- that trigger resyncs every transaction of the source inside the UPDATE, which
-- on an account with a backload would exceed the 8s statement timeout and roll
-- the date back. The paged resync is called after the date is saved instead.

-- ── Approval refuses a pre-cut-over period ─────────────────────────────────
-- A trigger, not a clause inside approve_card_import_batch: it then covers
-- every path that approves a batch (including service-role writes) and cannot
-- drift from that 200-line function. Posting is unreachable without approval --
-- quickbooks-post-journal refuses any batch that is not already 'approved' --
-- so this one guard closes both.
create or replace function public.card_posting_start_guard()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_start date; v_name text; v_end date;
begin
  if new.status <> 'approved' or old.status is not distinct from 'approved' then return new; end if;
  select s.posting_start_on, s.display_name into v_start, v_name
    from public.card_sources s where s.id = new.source_id;
  if v_start is null then return new; end if;
  -- period_end is the period's own last day; an import with no period is judged
  -- by its entry date, and one with neither is left alone rather than guessed at.
  v_end := coalesce(new.period_end, new.entry_date, new.period_start);
  if v_end is null or v_end >= v_start then return new; end if;
  raise exception 'This period ends before SILO started posting % (%). It was handled outside SILO; nothing is to be sent for it.',
    coalesce(v_name, 'this account'), to_char(v_start, 'FMMonth FMDD, YYYY');
end $$;

drop trigger if exists card_batch_posting_start on public.card_import_batches;
create trigger card_batch_posting_start before update of status on public.card_import_batches
  for each row execute function public.card_posting_start_guard();

-- ── Reversing what the ledger already recorded, in pages ───────────────────
-- Returns how many of the source's transactions still hold a live ledger entry
-- they should no longer have, AFTER reversing up to p_limit of them. The caller
-- loops until it returns 0. Nothing is deleted: each one is reversed by
-- silo_ledger_sync_card_transaction, which also respects the period lock.
create or replace function public.silo_ledger_resync_posting_start(p_source_id uuid, p_limit integer default 100)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_company uuid; v_id uuid; v_done integer := 0;
begin
  if not (coalesce(public.can_manage_journal_entries(), false) or coalesce(public.is_exec_or_owner(), false)) then
    raise exception 'Finance access required';
  end if;
  select company_entity_id into v_company from public.card_sources
   where id = p_source_id and company_entity_id = public.active_company_id();
  if v_company is null then raise exception 'Account not found'; end if;

  for v_id in
    select t.id from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    where b.source_id = p_source_id and t.company_entity_id = v_company
      and b.status not in ('approved', 'posted')
      and public.silo_ledger_desired_lines(t.id) is null
      and exists (
        select 1 from public.ledger_entries e
        where e.company_entity_id = v_company and e.source = 'card_transaction'
          and e.source_id = t.id and e.kind = 'original'
          and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = e.id))
    order by t.txn_date, t.id
    limit greatest(coalesce(p_limit, 100), 1)
  loop
    perform public.silo_ledger_sync_card_transaction(v_id);
    v_done := v_done + 1;
  end loop;

  return (
    select count(*)::int from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    where b.source_id = p_source_id and t.company_entity_id = v_company
      and b.status not in ('approved', 'posted')
      and public.silo_ledger_desired_lines(t.id) is null
      and exists (
        select 1 from public.ledger_entries e
        where e.company_entity_id = v_company and e.source = 'card_transaction'
          and e.source_id = t.id and e.kind = 'original'
          and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = e.id)));
end $$;

revoke all on function public.silo_ledger_resync_posting_start(uuid, integer) from public, anon;
grant execute on function public.silo_ledger_resync_posting_start(uuid, integer) to authenticated;

-- ── The date travels with the batch ────────────────────────────────────────
-- Appended at the end so CREATE OR REPLACE keeps every existing column in
-- place. The browser reads it per batch exactly as it reads the posting switch.
create or replace view public.card_import_batches_v with (security_invoker=true) as
select b.*,s.display_name as source_name,s.source_key,s.credit_qbo_account_name as credit_account_name,
  s.credit_qbo_account_type as credit_account_type,s.posting_enabled as source_posting_enabled,
  cp.name as created_by_name,ap.name as approved_by_name,p.status as posting_status,
  p.qbo_journal_entry_id,p.qbo_doc_number,
  (select count(*) from public.card_transactions t where t.batch_id=b.id) as txn_count,
  (select count(*) from public.card_transactions t where t.batch_id=b.id and t.status='uncoded') as uncoded_count,
  (select count(*) from public.card_transactions t where t.batch_id=b.id and t.status='excluded') as excluded_count,
  (select coalesce(sum(t.amount),0) from public.card_transactions t where t.batch_id=b.id and t.status='coded') as coded_amount,
  s.posting_start_on as source_posting_start_on
from public.card_import_batches b join public.card_sources s on s.id=b.source_id
left join public.profiles cp on cp.id=b.created_by left join public.profiles ap on ap.id=b.approved_by
left join public.quickbooks_journal_postings p on p.id=b.posting_id;
grant select on public.card_import_batches_v to authenticated;


-- ── On Deck leaves those periods out ───────────────────────────────────────
-- Unchanged from 20261004120000 but for the one filter in `base`, marked below.
create or replace function public.on_deck_coding_items()
returns table(
  batch_id uuid, label text, source_name text, status text,
  entry_date date, period_start date, period_end date,
  txn_count integer, uncoded_count integer, excluded_count integer, coded_amount numeric,
  open_suggestions integer, suggested_amount numeric, low_confidence integer,
  needs_judgment integer, failed integer,
  first_txn date, last_txn date, posting_enabled boolean,
  posting_status text, qbo_journal_entry_id text, qbo_doc_number text,
  approval_hash text, approved_at timestamptz, updated_at timestamptz,
  account_mix jsonb, currency text, stage text, stage_reason text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with gate as (
    select public.active_company_id() as co,
           coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) as ok
  ), base as (
    -- The ACTIVE claim is read from the claims table itself: the batch's
    -- posting_id (and so card_import_batches_v.posting_status) is set only
    -- after a successful send, so an unknown outcome would otherwise read as
    -- an ordinary approved entry and be forgotten (cycle-2 review).
    select b.*,
           (select p.status from public.quickbooks_journal_postings p
            where p.company_entity_id = b.company_entity_id and p.source = 'card_import'
              and p.source_ref = b.id::text and p.status in ('submitting', 'unknown')
            order by p.created_at desc limit 1) as active_claim_status
    from public.card_import_batches_v b, gate
    where gate.ok and b.company_entity_id = gate.co and coalesce(b.txn_count, 0) > 0
      -- A period that ends before SILO started posting the account is not work:
      -- it was handled outside SILO (card_sources.posting_start_on). Approved
      -- and posted history is left alone, so receipts still read as receipts.
      and (b.source_posting_start_on is null
           or b.status in ('approved', 'posted')
           or coalesce(b.period_end, b.entry_date, b.period_start) is null
           or coalesce(b.period_end, b.entry_date, b.period_start) >= b.source_posting_start_on)
  ), batches as (
    -- Work that still needs a person is selected on its own, so receipts can
    -- never crowd it out of the queue or out of Home's count (cycle-1 review).
    (select * from base
     where status in ('draft', 'categorized') or (status = 'approved' and active_claim_status is not null)
     order by updated_at desc
     limit 500)
    union all
    -- Receipts (approved in SILO, or also sent to QuickBooks): a bounded,
    -- recent history only.
    (select * from base
     where updated_at > now() - interval '14 days'
       and (status = 'posted' or (status = 'approved' and active_claim_status is null))
     order by updated_at desc
     limit 12)
  ), sugg as (
    -- Only live, current suggestions on rows still waiting for a category --
    -- the same rule the Transactions page applies (SiloCodingSuggestions.applies).
    select t.batch_id,
           count(*) filter (where s.outcome = 'suggested')::int as open_suggestions,
           coalesce(sum(t.amount) filter (where s.outcome = 'suggested'), 0) as suggested_amount,
           count(*) filter (where s.outcome = 'suggested' and s.confidence < 0.6)::int as low_confidence,
           count(*) filter (where s.outcome = 'needs_judgment')::int as needs_judgment,
           count(*) filter (where s.outcome = 'failed')::int as failed
    from public.card_coding_suggestions_v s
    join public.card_transactions t on t.id = s.transaction_id
    join batches b on b.id = t.batch_id
    where s.review_status = 'open' and s.stale_reason is null
      and t.status = 'uncoded' and t.qbo_account_id is null
      and not exists (select 1 from public.card_transaction_splits x where x.transaction_id = t.id)
    group by t.batch_id
  ), mix as (
    select m.batch_id, jsonb_agg(jsonb_build_object('account', m.account, 'count', m.n, 'amount', m.amount)
                                 order by m.n desc, m.account) as account_mix
    from (
      select t.batch_id, s.qbo_account_name as account, count(*)::int as n, sum(t.amount) as amount
      from public.card_coding_suggestions_v s
      join public.card_transactions t on t.id = s.transaction_id
      join batches b on b.id = t.batch_id
      where s.review_status = 'open' and s.stale_reason is null and s.outcome = 'suggested'
        and t.status = 'uncoded' and t.qbo_account_id is null
        and not exists (select 1 from public.card_transaction_splits x where x.transaction_id = t.id)
      group by t.batch_id, s.qbo_account_name
    ) m
    group by m.batch_id
  ), dates as (
    select t.batch_id, min(t.txn_date) as first_txn, max(t.txn_date) as last_txn,
           -- One currency or none: a mixed batch is shown without a symbol, never as USD.
           case when count(distinct t.currency) = 1 then min(t.currency) end as currency
    from public.card_transactions t join batches b on b.id = t.batch_id
    group by t.batch_id
  )
  select b.id, b.label, b.source_name, b.status,
         b.entry_date, b.period_start, b.period_end,
         b.txn_count::int, b.uncoded_count::int, b.excluded_count::int, coalesce(b.coded_amount, 0),
         coalesce(s.open_suggestions, 0), coalesce(s.suggested_amount, 0), coalesce(s.low_confidence, 0),
         coalesce(s.needs_judgment, 0), coalesce(s.failed, 0),
         d.first_txn, d.last_txn, coalesce(b.source_posting_enabled, false),
         coalesce(b.active_claim_status, b.posting_status), b.qbo_journal_entry_id, b.qbo_doc_number,
         b.approval_hash, b.approved_at, b.updated_at,
         coalesce(m.account_mix, '[]'::jsonb), d.currency,
         case
           when b.status = 'posted' then 'posted'
           when b.status = 'approved' and b.active_claim_status is not null then 'needs_input'
           when b.status = 'approved' then 'approved'
           when coalesce(s.open_suggestions, 0) > 0 then 'code'
           when b.uncoded_count = 0 and not coalesce(b.source_posting_enabled, false) then 'needs_input'
           when b.uncoded_count = 0 then 'approve'
           else 'needs_input'
         end,
         case
           when b.status = 'approved' and b.active_claim_status is not null then 'posting_unresolved'
           when b.status in ('draft', 'categorized') and not coalesce(b.source_posting_enabled, false)
                and coalesce(s.open_suggestions, 0) = 0 and b.uncoded_count = 0 then 'posting_disabled'
           when b.status in ('draft', 'categorized') and coalesce(s.open_suggestions, 0) = 0 and b.uncoded_count > 0 then 'uncoded_without_suggestion'
         end
  from batches b
  left join sugg s on s.batch_id = b.id
  left join mix m on m.batch_id = b.id
  left join dates d on d.batch_id = b.id
  order by b.updated_at desc;
$$;

-- Ask SILO's schema map: the batch view gained a column.
do $$ begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
