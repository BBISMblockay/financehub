-- Bookkeeping mode: one company-wide answer to "who keeps your books?"
--
-- Before this, a company's position was spread across four per-account fields
-- (books start, imports from, posts from, posting on/off) and had to be
-- inferred by whoever set it up. Nothing stated the company's intent, so a
-- company that does its bookkeeping in QuickBooks and uses SILO for reporting
-- had no way to say so: every account had to be switched off one at a time,
-- and a single account left on is a hybrid nobody chose.
--
-- Two modes, and no third:
--   'silo' -- SILO codes and posts into QuickBooks from the takeover date.
--   'qbo'  -- QuickBooks keeps the books. SILO sends nothing, ever, from any
--             surface, and records nothing in its own ledger.
--
-- The takeover date is the company default. An account's own posting_start_on
-- still wins where it is set, which is what keeps an account that came onboard
-- later (Baseballism Operating, September 1) from being dragged back to the
-- company date. Nothing here deletes anything or sends anything to QuickBooks.

alter table public.accounting_settings
  add column if not exists bookkeeping_mode text not null default 'silo',
  add column if not exists silo_takeover_on date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_settings_bookkeeping_mode_check') then
    alter table public.accounting_settings
      add constraint accounting_settings_bookkeeping_mode_check
      check (bookkeeping_mode in ('silo', 'qbo'));
  end if;
end $$;

comment on column public.accounting_settings.bookkeeping_mode is
  'silo = SILO codes and posts into QuickBooks; qbo = QuickBooks keeps the books and SILO posts nothing. There is no hybrid.';
comment on column public.accounting_settings.silo_takeover_on is
  'Company default for the first day SILO may post. An account''s own card_sources.posting_start_on overrides it.';

-- ── One place that answers "from when, for this account?" ──────────────────
-- Every caller below asks this, so the precedence lives once. Reporting-only
-- is modelled as a start date of infinity: no transaction is ever on or after
-- it, so the ledger records nothing and every date test refuses, through the
-- paths that already exist rather than a second set of them.
create or replace function public.silo_posting_start_for_source(p_source public.card_sources)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  select case when st.bookkeeping_mode = 'qbo' then 'infinity'::date
              else greatest(st.accounting_start_date,
                            coalesce(p_source.authoritative_from, st.accounting_start_date),
                            coalesce(p_source.posting_start_on, st.silo_takeover_on, st.accounting_start_date))
         end
  from public.accounting_settings st
  where st.company_entity_id = p_source.company_entity_id;
$$;
revoke all on function public.silo_posting_start_for_source(public.card_sources) from public, anon, authenticated;

-- silo_ledger_start keeps its name, its signature and its opening-balances
-- condition (a company that has not accepted opening balances has no ledger to
-- gate, and must keep returning null rather than infinity); only the date it
-- computes now comes from the function above.
create or replace function public.silo_ledger_start(p_source public.card_sources)
returns date language sql stable security definer set search_path = public, pg_temp as $$
  select public.silo_posting_start_for_source(p_source)
  from public.accounting_settings st
  join public.accounting_opening_balances ob on ob.company_entity_id = st.company_entity_id and ob.status = 'accepted'
  where st.company_entity_id = p_source.company_entity_id;
$$;

-- ── The refusal sentence learns the mode ───────────────────────────────────
-- Unchanged from 20261015020000 but for the mode branch and the start date now
-- coming from silo_posting_start_for_source, so the approval trigger, the
-- posting-claim trigger and the On Deck preview still ask one question.
create or replace function public.card_posting_start_refusal(
  p_batch uuid, p_source uuid, p_period_end date, p_entry_date date, p_period_start date)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_src public.card_sources%rowtype; v_start date; v_name text; v_end date; v_early date; v_count integer;
begin
  select * into v_src from public.card_sources s where s.id = p_source;
  if not found then return null; end if;
  v_name := coalesce(v_src.display_name, 'this account');
  v_start := public.silo_posting_start_for_source(v_src);
  if v_start is null then return null; end if;

  -- Reporting-only: there is no date to compare against and no month that is
  -- SILO's, so say why rather than reporting a date of infinity.
  if v_start = 'infinity'::date then
    return 'QuickBooks keeps the books for this company, so SILO does not send anything to it. Change that in Books & setup if SILO should keep the books.';
  end if;

  -- Two tests, because a period and a transaction are judged on different
  -- dates and a cut-over need not fall on a period boundary.
  --
  -- First the period itself. period_end is its own last day; an import with no
  -- period is judged by its entry date, and one with neither is left to the
  -- second test rather than guessed at.
  v_end := coalesce(p_period_end, p_entry_date, p_period_start);
  if v_end is not null and v_end < v_start then
    return format('This period ends before SILO started posting %s (%s). It was handled outside SILO; nothing is to be sent for it.',
      v_name, to_char(v_start, 'FMMonth FMDD, YYYY'));
  end if;

  -- Then its contents. A cut-over mid-period (say September 15 on a September
  -- 1-30 import) passes the test above, and approval would freeze a snapshot
  -- holding BOTH the September 10 and the September 20 lines -- so posting it
  -- would send the pre-cut-over one, which is exactly the activity the date
  -- says was handled elsewhere.
  select min(e.txn_date), count(distinct e.transaction_id) into v_early, v_count
    from public.card_coding_effective_lines e
   where e.batch_id = p_batch and round(e.amount, 2) <> 0 and e.txn_date < v_start;
  if v_early is null then return null; end if;
  return format('This import holds %s transaction(s) dated before SILO started posting %s (%s), the earliest on %s. Approving it would freeze an entry containing activity that was handled outside SILO. Move those rows to their own import, or exclude them, before approving this period.',
    v_count, v_name, to_char(v_start, 'FMMonth FMDD, YYYY'), to_char(v_early, 'FMMonth FMDD, YYYY'));
end $$;
revoke all on function public.card_posting_start_refusal(uuid, uuid, date, date, date) from public, anon, authenticated;

-- ── Reporting-only refuses EVERY send, not just bank coding ────────────────
-- qbo_card_posting_start_claim judges bank-feed claims against a per-account
-- date. Reporting-only is a statement about the whole company, and SILO posts
-- from five surfaces (bank coding, revenue journals, schedules, fixed assets
-- and hand-written adjustments), so it is judged here, on the claim every one
-- of them must take. quickbooks-post-journal never calls Intuit before the
-- claim row exists and already treats a failed claim as "nothing was sent", so
-- this needs no deploy.
create or replace function public.silo_bookkeeping_mode_claim_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mode text;
begin
  if new.status <> 'submitting' then return new; end if;
  select bookkeeping_mode into v_mode from public.accounting_settings
   where company_entity_id = new.company_entity_id;
  if coalesce(v_mode, 'silo') <> 'qbo' then return new; end if;
  raise exception 'QuickBooks keeps the books for this company, so SILO does not send entries to it. Nothing was sent.'
    using errcode = 'P0PS2';
end $$;
revoke all on function public.silo_bookkeeping_mode_claim_guard() from public, anon, authenticated;
drop trigger if exists bookkeeping_mode_claim on public.quickbooks_journal_postings;
-- Triggers fire in name order, and this name sorts before every other claim
-- guard (plaid_guard_new_posting_claim, qbo_card_claim_matches_approval,
-- qbo_card_posting_start_claim) on purpose: when SILO is to send nothing at
-- all, that is the answer the reader needs, not a diagnosis of the entry.
create trigger bookkeeping_mode_claim before insert on public.quickbooks_journal_postings
  for each row execute function public.silo_bookkeeping_mode_claim_guard();

-- ── One lock, so an approval in flight cannot slip past the handover ──────
-- Both sides take this, company-scoped, and hold it to commit. Without it the
-- interleaving is: A approves a batch while the mode is still 'silo' but has
-- not committed; B counts approved batches, sees none, commits 'qbo'; A
-- commits. The company is then in reporting-only holding a frozen, unsent
-- ledger entry -- exactly what the count exists to prevent, and the resync
-- never touches an approved batch. Whichever gets the lock first wins and the
-- other re-reads committed state. Each side takes only this one lock, so there
-- is no ordering to get wrong.
create or replace function public.bookkeeping_mode_lock(p_company uuid)
returns void language sql volatile security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtext('silo.bookkeeping_mode:' || p_company::text));
$$;
revoke all on function public.bookkeeping_mode_lock(uuid) from public, anon, authenticated;

-- The approval trigger of 20261015020000, unchanged but for that lock: it is
-- taken before the refusal is read, so an approval that is going to commit is
-- already holding it when a handover tries to count.
create or replace function public.card_posting_start_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text;
begin
  if new.status <> 'approved' then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('approved', 'posted') then return new; end if;
  perform public.bookkeeping_mode_lock(new.company_entity_id);
  v_msg := public.card_posting_start_refusal(new.id, new.source_id, new.period_end, new.entry_date, new.period_start);
  if v_msg is null then return new; end if;
  raise exception '%', v_msg;
end $$;
revoke all on function public.card_posting_start_guard() from public, anon, authenticated;

-- ── Saving the answer ──────────────────────────────────────────────────────
-- accounting_settings has a read policy and no write policy, so the write is a
-- definer RPC behind the finance gates. It writes ONLY the two fields: the
-- ledger is brought in line afterwards by the caller looping
-- silo_ledger_resync_posting_start per account, exactly as saving a per-account
-- date does, because reconciling thousands of transactions inside this
-- statement would exceed the browser's 8s timeout and roll the save back.
-- p_company is the company the reader was looking at when the confirmation
-- opened. The dialog is appended to document.body, outside the element the
-- company-switch shield makes inert, so a switch in another tab can land
-- between opening the confirmation and confirming it -- and active_company_id()
-- alone would then write the answer to the wrong company's books.
drop function if exists public.set_bookkeeping_mode(text, date);
create or replace function public.set_bookkeeping_mode(p_mode text, p_takeover date default null, p_company uuid default null)
returns public.accounting_settings language plpgsql security definer set search_path = public, pg_temp as $$
declare v_company uuid := public.active_company_id(); v_row public.accounting_settings%rowtype; v_open integer;
begin
  if auth.uid() is null or v_company is null
     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then
    raise exception 'Finance access required' using errcode = '42501';
  end if;
  if p_company is not null and p_company <> v_company then
    raise exception 'Your active company changed while this was open. Reload Books & setup and answer again.'
      using errcode = 'P0BM1';
  end if;
  if p_mode not in ('silo', 'qbo') then
    raise exception 'Unknown bookkeeping mode %', p_mode using errcode = '22023';
  end if;

  -- Held to commit, so an approval already in flight is counted below rather
  -- than committing after this does.
  if p_mode = 'qbo' then perform public.bookkeeping_mode_lock(v_company); end if;

  -- An approved batch is frozen: its ledger entry was recorded from the
  -- approval snapshot and the resync deliberately never touches it, so handing
  -- the books back while one is outstanding would leave SILO's ledger holding
  -- an entry it can no longer send -- and the save would report a reversal that
  -- did not happen. A posted month is different: QuickBooks holds it, and its
  -- entry is the record of that, so it stays. Reopening is the way out, and it
  -- is the reader's decision, not this function's.
  if p_mode = 'qbo' then
    select count(*) into v_open from public.card_import_batches b
     where b.company_entity_id = v_company and b.status = 'approved';
    if v_open > 0 then
      raise exception 'There %s still % approved import(s) that SILO has not sent. Reopen or post %s in Transactions first, so nothing is left approved with nowhere to go.',
        case when v_open = 1 then 'is' else 'are' end, v_open, case when v_open = 1 then 'it' else 'them' end
        using errcode = 'P0BM2';
    end if;
  end if;

  update public.accounting_settings
     set bookkeeping_mode = p_mode,
         -- The takeover date belongs to 'silo'. Keeping a stale one on 'qbo'
         -- would reappear as a date nobody chose on switching back.
         silo_takeover_on = case when p_mode = 'silo' then p_takeover else null end
   where company_entity_id = v_company
   returning * into v_row;
  if not found then raise exception 'Accounting is not set up for this company yet' using errcode = 'P0002'; end if;
  return v_row;
end $$;
revoke all on function public.set_bookkeeping_mode(text, date, uuid) from public, anon;
grant execute on function public.set_bookkeeping_mode(text, date, uuid) to authenticated;

-- ── On Deck stops asking for work SILO is not to do ───────────────────────
-- Byte-for-byte as 20261015020000 defined it but for the one predicate marked
-- below. A reporting-only company's unapproved periods cannot be approved (the
-- guard refuses them), so listing them would be asking for a click that fails.
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
      -- 20261015190000: in reporting-only, SILO sends nothing, so an unapproved
      -- period is not work waiting to be done -- approving it is refused. An
      -- item nobody can act on does not belong in the queue. Approved and
      -- posted history still shows, as below.
      and (b.status in ('approved', 'posted')
           or coalesce((select st.bookkeeping_mode from public.accounting_settings st
                        where st.company_entity_id = b.company_entity_id), 'silo') <> 'qbo')
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

select public.refresh_chat_schema_catalog();
