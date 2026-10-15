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
-- The judgement itself lives in one place, card_posting_start_refusal, so the
-- approval trigger below, the posting-claim trigger and the On Deck preview ask
-- the same question and cannot drift apart. It returns the sentence to show, or
-- null when the batch is SILO's to approve and post. Not callable by clients:
-- only the definer functions and triggers that need it reach it.
create or replace function public.card_posting_start_refusal(
  p_batch uuid, p_source uuid, p_period_end date, p_entry_date date, p_period_start date)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_start date; v_name text; v_end date; v_early date; v_count integer;
begin
  select s.posting_start_on, s.display_name into v_start, v_name
    from public.card_sources s where s.id = p_source;
  if v_start is null then return null; end if;

  -- Two tests, because a period and a transaction are judged on different
  -- dates and a cut-over need not fall on a period boundary.
  --
  -- First the period itself. period_end is its own last day; an import with no
  -- period is judged by its entry date, and one with neither is left to the
  -- second test rather than guessed at.
  v_end := coalesce(p_period_end, p_entry_date, p_period_start);
  if v_end is not null and v_end < v_start then
    return format('This period ends before SILO started posting %s (%s). It was handled outside SILO; nothing is to be sent for it.',
      coalesce(v_name, 'this account'), to_char(v_start, 'FMMonth FMDD, YYYY'));
  end if;

  -- Then its contents. A cut-over mid-period (say September 15 on a September
  -- 1-30 import) passes the test above, and approval would freeze a snapshot
  -- holding BOTH the September 10 and the September 20 lines -- so posting it
  -- would send the pre-cut-over one, which is exactly the activity the date
  -- says was handled elsewhere. Meanwhile silo_ledger_start keeps that same
  -- line out of SILO's ledger, so approval and the ledger would disagree about
  -- the same row. These are the lines approval actually freezes
  -- (card_coding_effective_lines over the batch, non-zero), so the test asks
  -- the same question the snapshot answers.
  select min(e.txn_date), count(distinct e.transaction_id) into v_early, v_count
    from public.card_coding_effective_lines e
   where e.batch_id = p_batch and round(e.amount, 2) <> 0 and e.txn_date < v_start;
  if v_early is null then return null; end if;
  return format('This import holds %s transaction(s) dated before SILO started posting %s (%s), the earliest on %s. Approving it would freeze an entry containing activity that was handled outside SILO. Move those rows to their own import, or exclude them, before approving this period.',
    v_count, coalesce(v_name, 'this account'), to_char(v_start, 'FMMonth FMDD, YYYY'), to_char(v_early, 'FMMonth FMDD, YYYY'));
end $$;
revoke all on function public.card_posting_start_refusal(uuid, uuid, date, date, date) from public, anon, authenticated;

create or replace function public.card_posting_start_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text;
begin
  -- Only a move INTO 'approved' is judged. 'approved'/'posted' -> 'approved' is
  -- not one: a re-save is a no-op, and posted -> approved is void_card_posting /
  -- "Mark unposted", the way OUT of a post made before the date was set. Refusing
  -- that would leave a wrongly posted month reading "In QuickBooks" for good.
  -- (That voided month is then approved and pre-cut-over; the posting-claim
  -- trigger below is what keeps it from being sent again.)
  -- An INSERT already carrying status 'approved' is judged too (finance clients
  -- may insert any status but 'posted'), so there is no OLD row to compare.
  if new.status <> 'approved' then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('approved', 'posted') then return new; end if;
  v_msg := public.card_posting_start_refusal(new.id, new.source_id, new.period_end, new.entry_date, new.period_start);
  if v_msg is null then return new; end if;
  raise exception '%', v_msg;
end $$;
revoke all on function public.card_posting_start_guard() from public, anon, authenticated;

drop trigger if exists card_batch_posting_start on public.card_import_batches;
create trigger card_batch_posting_start before insert or update of status on public.card_import_batches
  for each row execute function public.card_posting_start_guard();

-- ── A pre-cut-over month can never be SENT, whatever state it is in ─────────
-- The approval guard only stops a month BECOMING approved. A month that was
-- already approved when the date was set, or that SILO posted, voided and put
-- back to approved, stays approved -- and quickbooks-post-journal checks only
-- status, posting_enabled and the connection. Taking the posting claim is the
-- one step every send must pass, so refuse it here. The function already treats
-- a failed claim insert as "nothing was sent" (it never calls Intuit before the
-- claim exists), so this needs no deploy. Fires after
-- qbo_card_claim_matches_approval (alphabetical), which owns the stale-approval
-- and missing-batch cases.
create or replace function public.card_posting_start_claim_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_batch public.card_import_batches%rowtype; v_reason text;
begin
  if new.source <> 'card_import' or new.status <> 'submitting' then return new; end if;
  select * into v_batch from public.card_import_batches where id = new.source_ref::uuid;
  if not found then return new; end if;
  v_reason := public.card_posting_start_refusal(v_batch.id, v_batch.source_id, v_batch.period_end, v_batch.entry_date, v_batch.period_start);
  if v_reason is null then return new; end if;
  raise exception '%', v_reason using errcode = 'P0PS1';
end $$;
revoke all on function public.card_posting_start_claim_guard() from public, anon, authenticated;
drop trigger if exists qbo_card_posting_start_claim on public.quickbooks_journal_postings;
create trigger qbo_card_posting_start_claim before insert on public.quickbooks_journal_postings
  for each row execute function public.card_posting_start_claim_guard();

-- ── Bringing the ledger in line with the cut-over, in pages ───────────────
-- The date moves in BOTH directions, so this reconciles in both. Setting a
-- cut-over reverses what the ledger recorded for earlier months; clearing it,
-- or moving it earlier, records what it should now hold again. The first
-- version of this function only did the reversal half, which made the UI report
-- a finished save after clearing a date while those months stayed absent from
-- SILO's ledger -- silo_ledger_on_source deliberately ignores this field, so
-- nothing else would have resynced them.
--
-- A transaction needs work exactly when the ledger's state disagrees with what
-- silo_ledger_desired_lines now wants:
--   * desired null, a live original exists      -> reverse it;
--   * desired non-null, no live original exists -> record it.
-- Both are written by silo_ledger_sync_card_transaction, the same append-only
-- writer a recode goes through, which respects the period lock and never
-- deletes. A recode of an unchanged date is not this function's business, so a
-- live original whose fingerprint merely differs is left to its own trigger.
--
-- An approved or posted batch is frozen and is never touched here: its entry
-- was recorded from the approval snapshot, and for a posted one QuickBooks
-- holds it.
drop function if exists public.silo_ledger_resync_candidates(uuid, uuid, integer);
create or replace function public.silo_ledger_resync_candidates(
  p_source_id uuid, p_company uuid, p_limit integer, p_before date default null)
returns setof uuid language sql stable security invoker set search_path = public, pg_temp as $$
  select t.id from public.card_transactions t
  join public.card_import_batches b on b.id = t.batch_id
  where b.source_id = p_source_id and t.company_entity_id = p_company
    and b.status not in ('approved', 'posted')
    -- Only a row dated before the LATER of the old and new cut-over can change
    -- state: from that day on both dates agree. The caller passes it, so a
    -- backloaded account does not judge every row it has ever coded.
    and (p_before is null or t.txn_date < p_before)
    -- A coded row that fails validation (open feed exception, inactive account)
    -- is HELD by the writer: it returns without recording or reversing. Such a
    -- row would be a candidate on every pass and never change, so the remainder
    -- could not reach 0. Judge candidacy by the rule the writer uses.
    and public.silo_ledger_blocker(t.id) is null
    -- Cheap pre-filter: an uncoded row with no entry cannot be out of line, so
    -- skip it before the per-row desired_lines call.
    and (t.status = 'coded' or exists (select 1 from public.ledger_entries x
          where x.company_entity_id = p_company and x.source = 'card_transaction'
            and x.source_id = t.id and x.kind = 'original'))
    and (public.silo_ledger_desired_lines(t.id) is null) <> (not exists (
          select 1 from public.ledger_entries e
          where e.company_entity_id = p_company and e.source = 'card_transaction'
            and e.source_id = t.id and e.kind = 'original'
            and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = e.id)))
  order by t.txn_date, t.id
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke all on function public.silo_ledger_resync_candidates(uuid, uuid, integer, date) from public, anon, authenticated;

-- Returns how many of the source's transactions are still out of line AFTER
-- reconciling up to p_limit of them. The caller loops until it returns 0.
-- The remainder reads at most 5000 (RESYNC_SCAN): that caps how large the number
-- can read, never whether it reaches 0, so the caller's loop still terminates.
-- p_before narrows the rows judged to those dated before the later of the old and
-- new cut-over (the only rows that can change state); null judges every row. The
-- work per call is still every candidate row in that window (silo_ledger_desired_lines
-- per row, twice per call), so measure it on real data before relying on the
-- browser's 8s statement timeout.
drop function if exists public.silo_ledger_resync_posting_start(uuid, integer);
create or replace function public.silo_ledger_resync_posting_start(p_source_id uuid, p_limit integer default 100, p_before date default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_company uuid; v_id uuid;
begin
  if not (coalesce(public.can_manage_journal_entries(), false) or coalesce(public.is_exec_or_owner(), false)) then
    raise exception 'Finance access required';
  end if;
  select company_entity_id into v_company from public.card_sources
   where id = p_source_id and company_entity_id = public.active_company_id();
  if v_company is null then raise exception 'Account not found'; end if;

  for v_id in select public.silo_ledger_resync_candidates(p_source_id, v_company, p_limit, p_before) loop
    perform public.silo_ledger_sync_card_transaction(v_id);
  end loop;

  return (select count(*)::int from public.silo_ledger_resync_candidates(p_source_id, v_company, 5000, p_before));
end $$;

revoke all on function public.silo_ledger_resync_posting_start(uuid, integer, date) from public, anon;
grant execute on function public.silo_ledger_resync_posting_start(uuid, integer, date) to authenticated;

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

-- ── On Deck stops offering to send a month SILO is not to post ──────────────
-- card_import_batch_preview, byte-for-byte as 20261004120000 defined it plus
-- v_cutover: an approved pre-cut-over month reports blocker, ready=false and
-- can_post=false. Grants are kept by CREATE OR REPLACE.
create or replace function public.card_import_batch_preview(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_batch public.card_import_batches%rowtype;
  v_source public.card_sources%rowtype;
  v_snapshot jsonb;
  v_hash text;
  v_blocker text;
  v_connection uuid;
  v_lines jsonb;
  v_dest jsonb;
  v_posting jsonb;
  v_dates jsonb;
  v_cutover text;
begin
  if auth.uid() is null or v_company is null
     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then
    raise exception 'Finance access required' using errcode = '42501';
  end if;
  select * into v_batch from public.card_import_batches
  where id = p_batch_id and company_entity_id = v_company;
  if not found then raise exception 'Batch not found' using errcode = '42501'; end if;
  select * into v_source from public.card_sources where id = v_batch.source_id and company_entity_id = v_company;

  if v_batch.status in ('approved', 'posted') then
    -- Already frozen: the preview IS the stored approval, never a rebuild.
    v_snapshot := v_batch.approval_snapshot;
    v_hash := v_batch.approval_hash;
    if v_snapshot is null or v_hash is null then
      v_blocker := 'This approval predates the posting controls. Reopen it in Transactions and approve it again.';
    end if;
  elsif v_batch.status in ('draft', 'categorized') then
    -- Run the real approval and roll it back. PL/pgSQL variables survive the
    -- rollback of the block; every row change, audit event and lock taken by
    -- approve_card_import_batch does not.
    begin
      perform public.approve_card_import_batch(p_batch_id);
      select approval_snapshot, approval_hash into v_snapshot, v_hash
      from public.card_import_batches where id = p_batch_id;
      raise exception using errcode = 'P0D01', message = 'on_deck_preview_rollback';
    exception
      when sqlstate 'P0D01' then null;
      when others then v_blocker := sqlerrm; v_snapshot := null; v_hash := null;
    end;
  else
    v_blocker := format('This import is %s and cannot be approved.', v_batch.status);
  end if;

  -- An approved month that SILO is not to post (the cut-over came after it was
  -- approved, or it was posted, voided and put back) must not offer a send: the
  -- posting claim would refuse it, so say so here instead of on a failed click.
  if v_batch.status = 'approved' then
    v_cutover := public.card_posting_start_refusal(v_batch.id, v_batch.source_id, v_batch.period_end, v_batch.entry_date, v_batch.period_start);
  end if;

  v_connection := nullif(v_snapshot->>'qbo_connection_id', '')::uuid;
  if v_connection is null then v_connection := coalesce(v_batch.qbo_connection_id, v_source.qbo_connection_id); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'posting_type', l.line->'JournalEntryLineDetail'->>'PostingType',
           'amount', (l.line->>'Amount')::numeric,
           'account_id', l.line->'JournalEntryLineDetail'->'AccountRef'->>'value',
           'account_name', coalesce(a.fully_qualified_name, a.name),
           'account_type', a.account_type,
           'location_name', loc.name,
           'entity_type', l.line->'JournalEntryLineDetail'->'Entity'->>'Type',
           'entity_name', coalesce(cu.display_name, ve.display_name),
           'description', l.line->>'Description') order by l.n), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(coalesce(v_snapshot->'payload'->'Line', '[]'::jsonb)) with ordinality as l(line, n)
  left join public.quickbooks_accounts a on a.company_entity_id = v_company and a.connection_id = v_connection
    and a.qbo_account_id = l.line->'JournalEntryLineDetail'->'AccountRef'->>'value'
  left join public.quickbooks_locations loc on loc.company_entity_id = v_company and loc.connection_id = v_connection
    and loc.qbo_location_id = l.line->'JournalEntryLineDetail'->'DepartmentRef'->>'value'
  left join public.quickbooks_customers cu on cu.company_entity_id = v_company and cu.connection_id = v_connection
    and l.line->'JournalEntryLineDetail'->'Entity'->>'Type' = 'Customer'
    and cu.qbo_customer_id = l.line->'JournalEntryLineDetail'->'Entity'->'EntityRef'->>'value'
  left join public.quickbooks_vendors ve on ve.company_entity_id = v_company and ve.connection_id = v_connection
    and l.line->'JournalEntryLineDetail'->'Entity'->>'Type' = 'Vendor'
    and ve.qbo_vendor_id = l.line->'JournalEntryLineDetail'->'Entity'->'EntityRef'->>'value';

  select jsonb_build_object('connection_id', c.id, 'company_name', c.company_name, 'environment', c.environment, 'is_active', c.is_active)
    into v_dest
  from public.quickbooks_connections c where c.id = v_connection and c.company_entity_id = v_company;

  select jsonb_build_object('status', p.status, 'qbo_journal_entry_id', p.qbo_journal_entry_id,
           'qbo_doc_number', p.qbo_doc_number, 'error_message', left(p.error_message, 500),
           'posted_at', p.posted_at, 'payload_hash', p.payload_hash)
    into v_posting
  from public.quickbooks_journal_postings p
  where p.company_entity_id = v_company and p.source = 'card_import' and p.source_ref = p_batch_id::text
  order by p.created_at desc limit 1;

  select jsonb_build_object('first_txn', min(t.txn_date), 'last_txn', max(t.txn_date),
           'txn_count', count(*), 'uncoded', count(*) filter (where t.status = 'uncoded'),
           'excluded', count(*) filter (where t.status = 'excluded'),
           'coded', count(*) filter (where t.status = 'coded'),
           'source_updated_at', max(t.updated_at),
           'currency', case when count(distinct t.currency) = 1 then min(t.currency) end)
    into v_dates
  from public.card_transactions t where t.batch_id = p_batch_id and t.company_entity_id = v_company;

  return jsonb_build_object(
    'batch_id', v_batch.id, 'status', v_batch.status, 'label', v_batch.label,
    'source_name', v_source.display_name, 'posting_enabled', coalesce(v_source.posting_enabled, false),
    'entry_date', v_snapshot->'payload'->>'TxnDate',
    'period_start', v_batch.period_start, 'period_end', v_batch.period_end,
    'ready', v_blocker is null and v_cutover is null and v_hash is not null,
    'blocker', coalesce(v_blocker, v_cutover),
    'hash', v_hash,
    'approval_version', v_batch.approval_version,
    'approved_at', v_batch.approved_at,
    'memo', v_snapshot->'payload'->>'PrivateNote',
    'lines', v_lines,
    'debits', (select coalesce(sum((x->>'amount')::numeric), 0) from jsonb_array_elements(v_lines) x where x->>'posting_type' = 'Debit'),
    'credits', (select coalesce(sum((x->>'amount')::numeric), 0) from jsonb_array_elements(v_lines) x where x->>'posting_type' = 'Credit'),
    'destination', v_dest,
    'posting', v_posting,
    'facts', v_dates,
    'can_post', coalesce(public.can_manage_journal_entries(), false) and coalesce(v_source.posting_enabled, false) and v_cutover is null);
end;
$$;

-- Ask SILO's schema map: the batch view gained a column.
do $$ begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
