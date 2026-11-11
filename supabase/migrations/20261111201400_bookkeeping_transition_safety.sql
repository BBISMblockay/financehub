-- First accounting lifecycle slice: serialize reporting-only handover with ALL
-- posting claims and protect updated editors from stale mode/date writes.
-- No journal send, ledger rewrite, new tenant activation or worker is added.
-- Apply only with approval. See docs/ops/accounting-transition-safety.md.

alter table public.accounting_settings
  add column if not exists bookkeeping_version bigint not null default 0;
comment on column public.accounting_settings.bookkeeping_version is
  'Revision of bookkeeping_mode/silo_takeover_on through the mode RPCs; not ledger convergence or a full accounting configuration version.';

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

create or replace function public.set_bookkeeping_mode_checked(
  p_mode text, p_takeover date, p_company uuid, p_expected_version bigint)
returns public.accounting_settings language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company uuid := public.active_company_id();
  v_row public.accounting_settings%rowtype;
  v_takeover date;
  v_open integer;
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
  if p_expected_version is null or p_expected_version <> v_row.bookkeeping_version then
    raise exception 'The bookkeeping setting changed since you reviewed it. Reload Books & setup and review the current setting before saving.'
      using errcode = 'P0BM4';
  end if;
  v_takeover := case when p_mode = 'silo' then p_takeover else null end;
  if v_takeover is not null and (not isfinite(v_takeover)
      or v_takeover > public.silo_business_today()
      or v_takeover < v_row.accounting_start_date) then
    raise exception 'The takeover date must be on or after the books start and no later than today. Clear it to use the existing default.'
      using errcode = '22023';
  end if;

  -- Re-saving is the existing catch-up/retry flow, not a new configuration.
  -- Validate its reviewed version too, so a stale tab cannot claim success.
  if v_row.bookkeeping_mode = p_mode and v_row.silo_takeover_on is not distinct from v_takeover then
    return v_row;
  end if;
  if p_mode = 'qbo' then
    -- A committed claim can own a network send or an uncertain outcome from
    -- ANY source. Never release it or pretend switching mode cancels it.
    select count(*) into v_open from public.quickbooks_journal_postings p
     where p.company_entity_id = v_company and p.status in ('submitting', 'unknown');
    if v_open > 0 then
      raise exception 'There are % QuickBooks posting attempt(s) still sending or with an unknown outcome. Resolve those attempts before handing the books back; do not resend them blindly.', v_open
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
