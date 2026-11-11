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

-- ── Which open claim actually stands in the way of a handover ──────────────
-- Returns the reason a claim blocks reporting-only, or NULL when it does not.
-- One definition, read by the handover RPC and by the list the card shows, so
-- the count and the explanation can never disagree.
--
-- A claim blocks when SILO may still be sending it, or when its outcome is
-- uncertain for a period SILO owns. It does NOT block when the period belongs
-- to the setup history: the approval trigger refuses any new send for those
-- months, so no send can be open and nothing is in doubt about SILO's own
-- ledger. Such a claim is still listed, still says who owned the period, and
-- is never released, rewritten or treated as resolved -- it simply is not a
-- reason to refuse a company-wide answer, and counting it would block normal
-- accounting over activity that was never SILO's to post.
--
-- A period that cannot be placed ('unknown': no period on the row, or no
-- settings row) is NOT read as setup history. Not knowing who owned a period
-- is not evidence that SILO did not.
create or replace function public.silo_claim_blocks_handover(p_claim public.quickbooks_journal_postings)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner record;
begin
  if p_claim.status not in ('submitting', 'unknown') then return null; end if;
  select * into v_owner from public.silo_claim_period_owner(p_claim);
  if v_owner.owner = 'outside' then return null; end if;
  return case when p_claim.status = 'submitting' then 'sending' else 'unknown' end;
end $$;
revoke all on function public.silo_claim_blocks_handover(public.quickbooks_journal_postings) from public, anon, authenticated;


create or replace function public.silo_open_posting_claims()
returns table(claim_id uuid, source text, source_ref text, status text,
              period_start date, period_end date, attempt_count integer,
              last_attempt_at timestamptz, created_at timestamptz,
              blocks_handover boolean, period_owner text, owned_from date,
              account text, reason text, resolve_where text)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.source, p.source_ref, p.status,
         p.period_start, p.period_end, p.attempt_count,
         p.last_attempt_at, p.created_at,
         b.blocks is not null,
         o.owner, o.owned_from, o.account,
         case
           when b.blocks = 'sending'
             then 'SILO is sending this entry, or a send stopped before QuickBooks answered. This is an unresolved post, not setup history.'
           when b.blocks = 'unknown'
             then format('SILO owns %s from %s, and this post''s outcome is unknown. SILO has locked the send so it cannot post twice.',
                         o.account, to_char(o.owned_from, 'FMMonth FMDD, YYYY'))
           else format('%s owned this period: it ends before SILO started posting %s (%s), so it is setup history rather than an unresolved post. It is not counted and does not hold up the handover.',
                       'QuickBooks', o.account, to_char(o.owned_from, 'FMMonth FMDD, YYYY'))
         end,
         case when p.source = 'card_import'
           then 'Open the import in Transactions, check QuickBooks, then post it or confirm it was not posted.'
           else 'Open the entry in Books & setup, check QuickBooks, then post it or confirm it was not posted.'
         end
  from public.quickbooks_journal_postings p
  cross join lateral public.silo_claim_period_owner(p.*) o
  -- Asked once per row: the predicate reads the owner, which reads the account.
  cross join lateral (select public.silo_claim_blocks_handover(p.*) as blocks) b
  where p.company_entity_id = public.active_company_id()
    and p.status in ('submitting', 'unknown')
    and coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false)
  order by b.blocks is null, p.created_at;
$$;
revoke all on function public.silo_open_posting_claims() from public, anon, authenticated;
grant execute on function public.silo_open_posting_claims() to authenticated;

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
drop trigger if exists plaid_new_posting_claim on public.quickbooks_journal_postings;
create trigger plaid_new_posting_claim before insert or update of status on public.quickbooks_journal_postings
  for each row execute function public.plaid_guard_new_posting_claim();
drop trigger if exists qbo_card_claim_matches_approval on public.quickbooks_journal_postings;
create trigger qbo_card_claim_matches_approval before insert or update of status on public.quickbooks_journal_postings
  for each row execute function public.card_import_claim_matches_approval();
drop trigger if exists qbo_card_posting_start_claim on public.quickbooks_journal_postings;
create trigger qbo_card_posting_start_claim before insert or update of status on public.quickbooks_journal_postings
  for each row execute function public.card_posting_start_claim_guard();

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
    raise exception 'Your active company changed or was not supplied. Reload Books & setup and answer again.'
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
    raise exception 'The bookkeeping setting changed since you reviewed it. Reload Books & setup and review the current setting before saving.'
      using errcode = 'P0BM4';
  end if;

  if v_takeover is not null then
    select * into v_window from public.silo_takeover_window(v_company);
    if not isfinite(v_takeover) or v_takeover > v_window.latest or v_takeover < v_window.earliest then
      raise exception 'The takeover date must be between % and %. Clear it to use the existing default.',
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
    select count(*), string_agg(format('%s %s %s%s', o.account, p.source_ref,
             case when p.status = 'submitting' then 'is still sending' else 'has an unknown outcome' end,
             case when p.period_end is not null then format(' for %s, a period SILO owns', to_char(p.period_end, 'FMMon YYYY')) else '' end), '; '
             order by p.created_at)
      into v_open, v_detail
      from public.quickbooks_journal_postings p
      cross join lateral public.silo_claim_period_owner(p.*) o
     where p.company_entity_id = v_company
       and p.status in ('submitting', 'unknown')
       and public.silo_claim_blocks_handover(p.*) is not null;
    if v_open > 0 then
      raise exception 'There are % QuickBooks posting attempt(s) still sending or with an unknown outcome: %. Open each one, check QuickBooks, then post it or confirm it was not posted. Do not resend them blindly.', v_open, v_detail
        using errcode = 'P0BM3';
    end if;
    select count(*) into v_open from public.card_import_batches b
     where b.company_entity_id = v_company and b.status = 'approved';
    if v_open > 0 then
      raise exception 'There are % approved import(s) that SILO has not sent. Reopen or post them in Transactions before handing the books back.', v_open
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
    raise exception 'Your active company changed while this was open. Reload Books & setup and answer again.' using errcode = 'P0BM1';
  end if;
  perform public.bookkeeping_mode_lock(v_company);
  select bookkeeping_version into v_version from public.accounting_settings where company_entity_id = v_company;
  return public.set_bookkeeping_mode_checked(p_mode, p_takeover, v_company, v_version);
end $$;
revoke all on function public.set_bookkeeping_mode(text, date, uuid) from public, anon;
grant execute on function public.set_bookkeeping_mode(text, date, uuid) to authenticated;

select public.refresh_chat_schema_catalog();
