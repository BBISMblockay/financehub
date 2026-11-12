-- First accounting lifecycle slice: serialize reporting-only handover with ALL
-- posting claims and protect updated editors from stale mode/date writes.
-- No journal send, ledger rewrite, new tenant activation or worker is added.
-- Apply only with approval. See docs/ops/accounting-transition-safety.md.

alter table public.accounting_settings
  add column if not exists bookkeeping_version bigint not null default 0,
  add column if not exists takeover_earliest_on date,
  add column if not exists takeover_latest_on date;
comment on column public.accounting_settings.bookkeeping_version is
  'Revision of bookkeeping_mode/silo_takeover_on through the mode RPCs; not ledger convergence or a full accounting configuration version.';
comment on column public.accounting_settings.takeover_earliest_on is
  'Configurable earliest silo_takeover_on this company accepts. NULL = the books start date. Data, not code: a company migrating mid-year sets its own floor.';
comment on column public.accounting_settings.takeover_latest_on is
  'Configurable latest silo_takeover_on this company accepts. NULL = the company business day, so a date nobody has reached cannot stop SILO posting the months being worked on now.';

-- ── The takeover window, per company, from data ────────────────────────────
-- Both bounds are read from the company's own settings and fall back to the
-- two facts that are already true of it (the books start, its business day),
-- so no date is fixed in code and a tenant can widen or narrow its own window
-- without a migration. The card reads the same two columns and sets the date
-- input's min/max from them, so the picker and the server agree by
-- construction rather than by a rule written twice.
create or replace function public.silo_takeover_window(p_company uuid)
returns table(earliest date, latest date)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(st.takeover_earliest_on, st.accounting_start_date),
         coalesce(st.takeover_latest_on, public.silo_business_today())
  from public.accounting_settings st
  where st.company_entity_id = p_company;
$$;
revoke all on function public.silo_takeover_window(uuid) from public, anon, authenticated;
grant execute on function public.silo_takeover_window(uuid) to authenticated;

-- The date from which SILO owns a claim's periods, and the account it belongs
-- to. Separate from the blocking question because the reader needs it even
-- when nothing is blocked: during a build the trial balance, the Plaid history
-- and a handover date can all cover the same months without anything being
-- wrong, and what settles it is which source owns that period. Returns NULL
-- for an account it cannot identify, which is not a claim that the period is
-- SILO's.
create or replace function public.silo_claim_period_owner(p_claim public.quickbooks_journal_postings)
returns table(owner text, owned_from date, account text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_src public.card_sources%rowtype; v_st public.accounting_settings%rowtype; v_floor date;
begin
  select * into v_st from public.accounting_settings st
   where st.company_entity_id = p_claim.company_entity_id;
  if p_claim.source = 'card_import' and p_claim.source_ref ~ '^[0-9a-fA-F-]{36}$' then
    select s.* into v_src from public.card_import_batches b
      join public.card_sources s on s.id = b.source_id
     where b.id = p_claim.source_ref::uuid and b.company_entity_id = p_claim.company_entity_id;
  end if;
  v_floor := greatest(v_st.accounting_start_date,
                      coalesce(v_src.authoritative_from, v_st.accounting_start_date),
                      coalesce(v_src.posting_start_on, v_st.silo_takeover_on, v_st.accounting_start_date));
  return query select
    case when p_claim.period_end is null or v_floor is null then 'unknown'
         when p_claim.period_end < v_floor then 'outside' else 'silo' end,
    v_floor,
    coalesce(v_src.display_name, v_src.source_key, p_claim.source);
end $$;
revoke all on function public.silo_claim_period_owner(public.quickbooks_journal_postings) from public, anon, authenticated;

-- ── What actually stands in the way of a handover ──────────────────────────
-- Two different things can, and they are judged on different evidence. Getting
-- that backwards is how a customer ends up either stuck or unprotected.
--
-- 1. A POST ALREADY IN PROGRESS (quickbooks_journal_postings, 'submitting' or
--    'unknown'). Every such row is an attempted send by construction:
--    quickbooks-post-journal inserts the claim with attempt_count = 1 and
--    last_attempt_at stamped, immediately before the Intuit write, and
--    recovery moves it to 'unknown' when the outcome is in doubt. So the entry
--    may be in QuickBooks right now. **No date can settle that.** This is
--    judged on the row's status alone, deliberately ignoring every period and
--    cut-over date: a takeover date moved forward later must NOT quietly stop
--    a live or unresolved send from blocking the handover, and an earlier
--    version of this function read exactly that way.
-- 2. OLD SETUP HISTORY (card_import_batches, 'approved', never sent). This is
--    where the Plaid backfill and the trial-balance era really do overlap the
--    handover dates. An approved import whose activity all predates SILO
--    posting that account can never be sent -- card_posting_start_refusal
--    refuses it, and the resync reverses its ledger entries -- so counting it
--    tells the reader to "post it or reopen it" when neither is possible, and
--    normal accounting is blocked over activity that was never SILO's. Those
--    are judged on the dates, because the same dates are what makes them
--    unsendable, and they are still listed.
--
-- Nothing is ever released, rewritten or treated as resolved by either path.
create or replace function public.silo_claim_blocks_handover(p_claim public.quickbooks_journal_postings)
returns text language sql immutable security definer set search_path = public, pg_temp as $$
  -- Status only. Adding a date test here is the bug described above.
  select case p_claim.status when 'submitting' then 'sending' when 'unknown' then 'unknown' end;
$$;
revoke all on function public.silo_claim_blocks_handover(public.quickbooks_journal_postings) from public, anon, authenticated;

-- An approved import SILO can still send blocks; one whose activity is all
-- before SILO started posting the account is setup history and does not. The
-- floor mirrors the ELSE branch of silo_posting_start_for_source for the same
-- reason silo_claim_period_owner does: the whole function answers infinity in
-- reporting-only, which is the answer being asked for here.
create or replace function public.silo_batch_blocks_handover(p_batch public.card_import_batches)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_src public.card_sources%rowtype; v_st public.accounting_settings%rowtype;
        v_floor date; v_last date;
begin
  if p_batch.status <> 'approved' then return null; end if;
  select * into v_st from public.accounting_settings st
   where st.company_entity_id = p_batch.company_entity_id;
  select * into v_src from public.card_sources s where s.id = p_batch.source_id;
  v_floor := greatest(v_st.accounting_start_date,
                      coalesce(v_src.authoritative_from, v_st.accounting_start_date),
                      coalesce(v_src.posting_start_on, v_st.silo_takeover_on, v_st.accounting_start_date));
  -- The latest day this import would actually send. Its CONTENTS decide it,
  -- as the approval trigger does: a cut-over inside a period leaves lines on
  -- both sides, and those are still SILO's to send.
  select max(e.txn_date) into v_last from public.card_coding_effective_lines e
   where e.batch_id = p_batch.id and round(e.amount, 2) <> 0;
  v_last := coalesce(v_last, p_batch.period_end, p_batch.entry_date, p_batch.period_start);
  if v_floor is null or v_last is null then return 'approved'; end if;
  if v_last < v_floor then return null; end if;
  return 'approved';
end $$;
revoke all on function public.silo_batch_blocks_handover(public.card_import_batches) from public, anon, authenticated;

-- ── The list the reader can act on, with somewhere to go ──────────────────
-- A refusal that names a count, or a uuid, asks the reader to go and resolve
-- something they cannot find. Every row here carries the page that reviews it,
-- so the card can offer the action rather than describe it. Read-only; it
-- releases nothing. Finance-gated to the same two narrow gates as the mode RPC
-- rather than is_admin_user(), which nearly everyone passes.
create or replace function public.silo_handover_blockers()
returns table(kind text, reference text, title text, status text,
              period_start date, period_end date, period_owner text,
              owned_from date, account text, blocks_handover boolean,
              reason text, action_label text, review_path text)
language sql stable security definer set search_path = public, pg_temp as $$
  select 'post', p.source_ref, coalesce(p.memo, o.account), p.status,
         p.period_start, p.period_end, o.owner, o.owned_from, o.account,
         b.blocks is not null,
         case when p.status = 'submitting'
           then 'Posting to QuickBooks'
           else 'Check in QuickBooks'
         end,
         'Review',
         case when p.source = 'card_import' and p.source_ref ~ '^[0-9a-fA-F-]{36}$'
           then '/v2/transactions.html?batch=' || p.source_ref
           else '/v2/accounting-books.html#register'
         end
  from public.quickbooks_journal_postings p
  cross join lateral public.silo_claim_period_owner(p.*) o
  cross join lateral (select public.silo_claim_blocks_handover(p.*) as blocks) b
  where p.company_entity_id = public.active_company_id()
    and p.status in ('submitting', 'unknown')
    and coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false)
  union all
  select 'import', i.id::text, coalesce(i.label, s.display_name, s.source_key), i.status,
         i.period_start, i.period_end,
         case when k.blocks is null then 'outside' else 'silo' end,
         null::date, coalesce(s.display_name, s.source_key),
         k.blocks is not null,
         case when k.blocks is null
           then 'Approved during setup. Not in the way.'
           else 'Approved in SILO, not sent.'
         end,
         'Review',
         '/v2/transactions.html?batch=' || i.id::text
  from public.card_import_batches i
  join public.card_sources s on s.id = i.source_id
  cross join lateral (select public.silo_batch_blocks_handover(i.*) as blocks) k
  where i.company_entity_id = public.active_company_id()
    and i.status = 'approved'
    and coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false)
  order by 10 desc, 5 nulls last;
$$;
revoke all on function public.silo_handover_blockers() from public, anon, authenticated;
grant execute on function public.silo_handover_blockers() to authenticated;
-- An intermediate draft of this migration exposed the claim half alone. It
-- never reached production; drop it so no caller can read a partial list.
drop function if exists public.silo_open_posting_claims();

create or replace function public.silo_bookkeeping_mode_claim_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mode text;
begin
  if new.status <> 'submitting' then return new; end if;
  -- Existing Plaid/account and batch guards run BEFORE this trigger. Card
  -- approval locks its batch before this company lock too. Reversing that
  -- order deadlocks a stale claim against a concurrent reapproval. A claimant
  -- losing to a mode change reads the committed mode before any send.
  perform public.bookkeeping_mode_lock(new.company_entity_id);
  select bookkeeping_mode into v_mode from public.accounting_settings
   where company_entity_id = new.company_entity_id;
  if coalesce(v_mode, 'silo') <> 'qbo' then return new; end if;
  raise exception 'QuickBooks keeps the books for this company, so SILO does not send entries to it. Nothing was sent.'
    using errcode = 'P0PS2';
end $$;
revoke all on function public.silo_bookkeeping_mode_claim_guard() from public, anon, authenticated;
drop trigger if exists bookkeeping_mode_claim on public.quickbooks_journal_postings;
drop trigger if exists zz_bookkeeping_mode_claim on public.quickbooks_journal_postings;
-- New claims and any future re-entry into submitting share the same boundary.
-- Receipt/recovery updates to posted/unknown/failed are deliberately allowed.
-- Alphabetical trigger order is a lock-order invariant: Plaid account, batch,
-- company. Keep this AFTER plaid_new_posting_claim and qbo_card_claim_matches_approval.
create trigger zz_bookkeeping_mode_claim before insert or update of status on public.quickbooks_journal_postings
  for each row execute function public.silo_bookkeeping_mode_claim_guard();

-- ── The other three claim guards cover re-entry too ───────────────────────
-- Every one of these refuses unless the row is ENTERING 'submitting', so a
-- receipt (posted/unknown/failed) is untouched and a finance-approved send is
-- never slowed down: an approval by the finance role is the authority, and
-- these only check that the claim still matches what was approved. Until now
-- they fired on INSERT only, so a path that moved an existing row back into
-- 'submitting' would have passed the mode guard added above while skipping the
-- approval-hash match, the per-account posting start date and the open bank
-- feed exception. The deployed quickbooks-post-journal never does that, so
-- this changes no current behaviour; it closes the gap rather than leaving one
-- arm of the boundary shorter than the others. Function bodies are unchanged,
-- so the lock order they take (plaid_accounts, then the batch) is unchanged.
-- Each pair is widened only where its guard function exists in THIS database.
-- Production does not have card_import_claim_matches_approval(): the On Deck
-- coding review migration's objects were applied there by hand and that one
-- never landed, so naming it unconditionally aborted this whole migration.
-- Widening a trigger SILO does not have is not this migration's job -- and
-- creating the guard it is missing would change what posting accepts, which is
-- a decision of its own. Skipping it leaves that database exactly as it was.
do $$
declare
  v_pair record;
begin
  for v_pair in
    select * from (values
      ('plaid_new_posting_claim', 'public.plaid_guard_new_posting_claim()'),
      ('qbo_card_claim_matches_approval', 'public.card_import_claim_matches_approval()'),
      ('qbo_card_posting_start_claim', 'public.card_posting_start_claim_guard()')
    ) as t(trigger_name, guard)
  loop
    if to_regprocedure(v_pair.guard) is null then
      raise notice 'skipping %: % is not in this database', v_pair.trigger_name, v_pair.guard;
      continue;
    end if;
    execute format('drop trigger if exists %I on public.quickbooks_journal_postings', v_pair.trigger_name);
    execute format('create trigger %I before insert or update of status on public.quickbooks_journal_postings'
                   ' for each row execute function %s', v_pair.trigger_name, v_pair.guard);
  end loop;
end $$;

create or replace function public.set_bookkeeping_mode_checked(
  p_mode text, p_takeover date, p_company uuid, p_expected_version bigint)
returns public.accounting_settings language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company uuid := public.active_company_id();
  v_row public.accounting_settings%rowtype;
  v_takeover date;
  v_open integer;
  v_window record;
  v_detail text;
begin
  if auth.uid() is null or v_company is null
     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then
    raise exception 'Finance access required' using errcode = '42501';
  end if;
  if p_company is null or p_company <> v_company then
    raise exception 'Your active company changed. Reload Books & setup.'
      using errcode = 'P0BM1';
  end if;
  if p_mode is null or p_mode not in ('silo', 'qbo') then
    raise exception 'Unknown bookkeeping mode' using errcode = '22023';
  end if;

  -- Lock order: company advisory lock, then settings row. Claim/approval
  -- checks below take no row locks: finalization must remain able to finish.
  perform public.bookkeeping_mode_lock(v_company);
  select * into v_row from public.accounting_settings
   where company_entity_id = v_company for update;
  if not found then raise exception 'Accounting is not set up for this company yet' using errcode = 'P0002'; end if;

  v_takeover := case when p_mode = 'silo' then p_takeover else null end;

  -- Nothing to change is answered FIRST, and the committed row is what comes
  -- back. Re-saving is how the card resumes a ledger catch-up it could not
  -- finish in one pass, so it must stay connected to the setting rather than
  -- be refused by a version another tab moved on, or by a stored date that
  -- predates a window tightened since: neither can make an identical write
  -- wrong. Every write that DOES change something is checked below.
  if v_row.bookkeeping_mode = p_mode and v_row.silo_takeover_on is not distinct from v_takeover then
    return v_row;
  end if;

  if p_expected_version is null or p_expected_version <> v_row.bookkeeping_version then
    raise exception 'This setting changed since you opened it. Reload Books & setup.'
      using errcode = 'P0BM4';
  end if;

  if v_takeover is not null then
    select * into v_window from public.silo_takeover_window(v_company);
    if not isfinite(v_takeover) or v_takeover > v_window.latest or v_takeover < v_window.earliest then
      raise exception 'Pick a date between % and %, or clear it.',
        to_char(v_window.earliest, 'FMMonth FMDD, YYYY'), to_char(v_window.latest, 'FMMonth FMDD, YYYY')
        using errcode = '22023';
    end if;
  end if;

  if p_mode = 'qbo' then
    -- A committed claim can own a network send or an uncertain outcome from
    -- ANY source. Never release it or pretend switching mode cancels it. What
    -- is counted is what silo_claim_blocks_handover says stands in the way,
    -- so pre-takeover history does not make the switch impossible, and the
    -- refusal names the entries so the reader can go and resolve them.
    select count(*), string_agg(format('%s%s', o.account,
             case when p.period_end is not null then format(' %s', to_char(p.period_end, 'FMMon YYYY')) else '' end), '; '
             order by p.created_at)
      into v_open, v_detail
      from public.quickbooks_journal_postings p
      cross join lateral public.silo_claim_period_owner(p.*) o
     where p.company_entity_id = v_company
       and public.silo_claim_blocks_handover(p.*) is not null;
    if v_open > 0 then
      raise exception 'SILO has % QuickBooks post% still in progress: %.',
        v_open, case when v_open = 1 then '' else 's' end, v_detail
        using errcode = 'P0BM3';
    end if;
    -- Only an import SILO could still send. One approved during setup, before
    -- SILO started posting the account, can never be sent, so "post it or
    -- reopen it" is impossible advice and counting it strands the company in
    -- SILO mode for good.
    select count(*) into v_open from public.card_import_batches b
     where b.company_entity_id = v_company
       and public.silo_batch_blocks_handover(b.*) is not null;
    if v_open > 0 then
      raise exception 'SILO has % approved import% it has not sent.',
        v_open, case when v_open = 1 then '' else 's' end
        using errcode = 'P0BM2';
    end if;
  end if;

  update public.accounting_settings
     set bookkeeping_mode = p_mode, silo_takeover_on = v_takeover,
         bookkeeping_version = bookkeeping_version + 1
   where company_entity_id = v_company
   returning * into v_row;
  return v_row;
end $$;
revoke all on function public.set_bookkeeping_mode_checked(text, date, uuid, bigint) from public, anon, authenticated;
grant execute on function public.set_bookkeeping_mode_checked(text, date, uuid, bigint) to authenticated;

-- Preserve cached pages and external callers using the previous signature.
-- They receive the claim/date/authorization safeguards, but cannot supply a
-- reviewed version. Their existing last-writer semantics remain until refresh.
-- The UPDATED UI always uses checked when bookkeeping_version is available;
-- it must never fall back to this wrapper after an error from checked.
create or replace function public.set_bookkeeping_mode(p_mode text, p_takeover date default null, p_company uuid default null)
returns public.accounting_settings language plpgsql security definer set search_path = public, pg_temp as $$
declare v_company uuid := public.active_company_id(); v_version bigint;
begin
  if auth.uid() is null or v_company is null
     or not coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false) then
    raise exception 'Finance access required' using errcode = '42501';
  end if;
  if p_company is not null and p_company <> v_company then
    raise exception 'Your active company changed. Reload Books & setup.' using errcode = 'P0BM1';
  end if;
  perform public.bookkeeping_mode_lock(v_company);
  select bookkeeping_version into v_version from public.accounting_settings where company_entity_id = v_company;
  return public.set_bookkeeping_mode_checked(p_mode, p_takeover, v_company, v_version);
end $$;
revoke all on function public.set_bookkeeping_mode(text, date, uuid) from public, anon;
grant execute on function public.set_bookkeeping_mode(text, date, uuid) to authenticated;

select public.refresh_chat_schema_catalog();
