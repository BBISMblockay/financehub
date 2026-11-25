-- Saved rules categorize on their own, and an entry made by hand in QuickBooks
-- can be marked so SILO never sends it.
--
-- Two findings from the 2026-11-25 accounting audit, both additive:
--
--   1. SAVED RULES ONLY RAN IN THE BROWSER. v2/transactions.html applies a
--      company's rules when someone opens the page and saves. Background
--      preparation deliberately skips a row a rule answers ('rule_applies',
--      20260923140000), so those rows waited for a person to open the page:
--      207 of 362 uncategorized November bank rows (production, 2026-11-24).
--      apply_saved_card_coding_rules() is the page's applyRules() in SQL, for
--      the scheduler: it writes through apply_card_coding, the same statement
--      the page's Save uses, so the provider-revision check, the rule/source/
--      direction guard, the audit row and the ledger trigger all still run.
--      Owner decision 2026-11-25: "Yes, categorize automatically".
--
--      What it will not touch, by construction:
--        * a row a person has ever saved (updated_by is not null) -- clearing
--          a rule's answer by hand is a decision, and it stays made
--        * an account that is not switched on (card_sources.auto_prepare_coding)
--        * an approved, posted or voided month; an excluded, split, pending or
--          already categorized row (card_coding_preparation_blocker)
--        * a merchant/card conflict -- a person decides, as on the page
--        * an account missing from the source's current QuickBooks chart
--        * a bank-feed row whose transaction type cannot be read from the
--          category (the page would leave it "Needs transaction type")
--      Approval and sending are not reachable from here.
--
--   2. AN ENTRY MADE BY HAND IN QUICKBOOKS HAD NOWHERE TO GO. The sync page
--      could only offer it unticked, for ever. quickbooks_entered_by_hand is a
--      person's statement that an entry is already in QuickBooks; while it
--      stands, a claim to send that entry is refused in the database, so no
--      page, old or new, can post it twice.

-- ── 1. The page's transaction-type reading, in SQL ─────────────────────────
-- MIRRORS inferTreatment() in v2/transaction-dates.js, called the way
-- applyRules() calls it: with the row's own type set aside ('unknown'). NULL
-- means "not a bank-feed row: leave the type alone", which is what the page
-- does for a CSV line.
create or replace function public.card_coding_infer_treatment(
  p_origin text, p_account_type text, p_source_type text, p_amount numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_origin is null or p_origin not in ('plaid', 'manual') then null
    when p_account_type in ('Other Current Asset', 'Other Current Liability') then 'transfer'
    when p_account_type in ('Credit Card', 'Accounts Payable') then
      case when p_source_type = 'bank' then 'card_payment' else 'unknown' end
    when p_account_type in ('Expense', 'Other Expense', 'Cost of Goods Sold', 'Fixed Asset', 'Other Asset') then
      case when p_amount > 0 then 'purchase' when p_amount < 0 then 'refund' else 'unknown' end
    when p_account_type in ('Income', 'Other Income', 'Accounts Receivable') and p_amount < 0 then 'deposit'
    when p_account_type is null or p_account_type = '' then 'unknown'
    else case when p_amount > 0 then 'purchase' when p_amount < 0 then 'deposit' else 'unknown' end
  end
$$;
revoke all on function public.card_coding_infer_treatment(text, text, text, numeric) from public, anon;
grant execute on function public.card_coding_infer_treatment(text, text, text, numeric) to authenticated, service_role;

-- ── 2. Saved rules, applied without a page ─────────────────────────────────
-- Returns {applied, skipped: {reason: n}, more}. One row at a time, each in
-- its own subtransaction: a row that cannot be saved is counted and left
-- exactly as it was, and never takes the rows before it down with it.
-- p_limit caps the rows APPLIED, not the rows looked at: a row that is skipped
-- stays a candidate on the next run, so a cap on rows looked at would let a
-- few hundred permanent skips hide every row sorted after them.
create or replace function public.apply_saved_card_coding_rules(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_id uuid; v_batch uuid; v_seen integer := 0; v_applied integer := 0; v_count integer;
  v_skipped jsonb := '{}'::jsonb; v_reason text; v_more boolean := false;
  t public.card_transactions%rowtype; b public.card_import_batches%rowtype; s public.card_sources%rowtype;
  r public.card_coding_rules%rowtype; v_match jsonb; v_type text; v_treatment text;
  v_location text; v_location_name text;
begin
  for v_id, v_batch in
    select x.id, x.batch_id from public.card_transactions x
      join public.card_import_batches xb on xb.id = x.batch_id and xb.company_entity_id = x.company_entity_id
      join public.card_sources xs on xs.id = xb.source_id and xs.company_entity_id = x.company_entity_id
     where xb.status in ('draft', 'categorized') and xs.is_active and xs.auto_prepare_coding
       and x.status = 'uncoded' and x.qbo_account_id is null and x.updated_by is null
       and public.card_coding_needs_preparation(x, xb, xs) = 'rule_applies'
     -- Months in id order, the order apply_card_coding and the bank sync lock
     -- them in, so this cannot deadlock against either.
     order by x.batch_id, x.id
  loop
    if v_applied >= v_limit or v_seen >= 20000 then v_more := true; exit; end if;
    v_seen := v_seen + 1;
    v_reason := null;
    begin
      select * into b from public.card_import_batches where id = v_batch for update;
      select * into t from public.card_transactions where id = v_id for update;
      select * into s from public.card_sources where id = b.source_id;
      -- Everything is read again under the locks: the candidate list above
      -- was a snapshot, and a person or the bank feed may have been there since.
      if t.id is null or b.id is null or s.id is null or t.updated_by is not null
         or not s.is_active or not s.auto_prepare_coding
         or public.card_coding_needs_preparation(t, b, s) is distinct from 'rule_applies' then
        raise exception using message = 'changed';
      end if;
      v_match := public.card_coding_rule_match(t, s);
      if v_match is null or (v_match->>'conflict')::boolean or v_match->>'rule_id' is null then
        raise exception using message = 'changed';
      end if;
      select * into r from public.card_coding_rules
        where id = (v_match->>'rule_id')::uuid and company_entity_id = t.company_entity_id;
      if r.id is null or r.qbo_account_id is null then raise exception using message = 'changed'; end if;
      -- The account must be in the chart this source posts to, today.
      if s.qbo_connection_id is null or (b.qbo_connection_id is not null and b.qbo_connection_id <> s.qbo_connection_id) then
        raise exception using message = 'no_connection';
      end if;
      select a.account_type into v_type from public.quickbooks_accounts a
        where a.company_entity_id = t.company_entity_id and a.connection_id = s.qbo_connection_id
          and a.qbo_account_id = r.qbo_account_id and a.is_active;
      if v_type is null then raise exception using message = 'account_unavailable'; end if;
      -- A rule saved with a type keeps it; otherwise the category says it.
      v_treatment := case when t.origin in ('plaid', 'manual') then
          case when r.accounting_treatment is not null and r.accounting_treatment <> 'unknown' then r.accounting_treatment
               else public.card_coding_infer_treatment(t.origin, v_type, s.source_type, t.amount) end
        else null end;
      if v_treatment = 'unknown' then raise exception using message = 'needs_type'; end if;
      v_location := coalesce(nullif(r.qbo_location_id, ''), nullif(s.default_qbo_location_id, ''));
      v_location_name := null;
      if v_location is not null then
        select l.name into v_location_name from public.quickbooks_locations l
          where l.company_entity_id = t.company_entity_id and l.connection_id = s.qbo_connection_id
            and l.qbo_location_id = v_location;
      end if;
      v_count := public.apply_card_coding(jsonb_build_array(jsonb_build_object(
        'id', t.id, 'accounting_treatment', v_treatment,
        'expected_provider_updated_at', t.provider_updated_at,
        'qbo_account_id', r.qbo_account_id, 'qbo_account_name', r.qbo_account_name,
        'qbo_location_id', v_location, 'qbo_location_name', v_location_name,
        'entity_qbo_id', nullif(r.entity_qbo_id, ''), 'entity_name', r.entity_name, 'entity_type', r.entity_type,
        'vendor_name', coalesce(r.vendor_name, t.vendor_name), 'memo', t.memo,
        'coding_source', 'rule', 'confidence', 1, 'ai_reasoning', null,
        'rule_id', r.id, 'status', 'coded', 'exclude_reason', t.exclude_reason, 'coding_conflict', null)));
      if v_count <> 1 then raise exception using message = 'not_saved'; end if;
      v_applied := v_applied + 1;
    exception when others then
      v_reason := case when sqlerrm in ('changed', 'no_connection', 'account_unavailable', 'needs_type', 'not_saved')
        then sqlerrm else 'refused' end;
      v_skipped := jsonb_set(v_skipped, array[v_reason], to_jsonb(coalesce((v_skipped->>v_reason)::integer, 0) + 1));
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped, 'more', v_more);
end $$;
-- Supabase re-grants EXECUTE on every new public function: take it back from
-- the browser roles. Only the scheduler's service role may run this.
revoke all on function public.apply_saved_card_coding_rules(integer) from public, anon, authenticated;
grant execute on function public.apply_saved_card_coding_rules(integer) to service_role;

-- ── 3. "Already in QuickBooks" ─────────────────────────────────────────────
-- One row per entry a person says they entered in QuickBooks by hand. The key
-- is the one a sending claim carries (quickbooks_journal_postings.source and
-- source_ref), so the guard below is an exact match, not an inference.
create table if not exists public.quickbooks_entered_by_hand (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  source text not null,
  source_ref text not null,
  approval_hash text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (company_entity_id, source, source_ref)
);
alter table public.quickbooks_entered_by_hand enable row level security;
drop policy if exists quickbooks_entered_by_hand_read on public.quickbooks_entered_by_hand;
create policy quickbooks_entered_by_hand_read on public.quickbooks_entered_by_hand
  for select to authenticated
  using (company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
-- No insert, update or delete policy: the two functions below are the only way in.
revoke all on public.quickbooks_entered_by_hand from anon, authenticated;
grant select on public.quickbooks_entered_by_hand to authenticated;
grant all on public.quickbooks_entered_by_hand to service_role;
drop trigger if exists finance_audit_event on public.quickbooks_entered_by_hand;
create trigger finance_audit_event after insert or update or delete on public.quickbooks_entered_by_hand
  for each row execute function public.finance_append_audit_event();

-- The mark and a sending claim for the same entry take this lock, so one of
-- them always sees the other. Nothing else is locked by either side through
-- this function, which is what keeps it clear of the claim guards' lock order.
create or replace function public.quickbooks_entry_lock(p_company uuid, p_source text, p_ref text)
returns void language sql security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('quickbooks_entry:' || p_company::text || ':' || p_source || ':' || p_ref, 0))
$$;
revoke all on function public.quickbooks_entry_lock(uuid, text, text) from public, anon, authenticated;

-- p_kind 'batch' (a card or bank month) or 'adjustment' (a journal entry).
-- p_marked true marks it, false takes the mark off again.
create or replace function public.set_entry_entered_in_quickbooks(p_kind text, p_id uuid, p_marked boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_source text; v_ref text; v_status text; v_hash text;
begin
  if auth.uid() is null or v_company is null then raise exception 'Sign in and choose a company first'; end if;
  if not public.can_manage_journal_entries() then raise exception 'Finance access required'; end if;
  if p_id is null or p_marked is null or p_kind is null or p_kind not in ('batch', 'adjustment') then
    raise exception 'Name one entry to mark';
  end if;
  if p_kind = 'batch' then
    select 'card_import', i.id::text, i.status, i.approval_hash into v_source, v_ref, v_status, v_hash
      from public.card_import_batches i where i.id = p_id and i.company_entity_id = v_company;
  else
    select coalesce(a.accounting_source, 'journal_adjustment'), coalesce(a.accounting_source_ref, a.id::text), a.status, a.approval_hash
      into v_source, v_ref, v_status, v_hash
      from public.journal_adjustments a where a.id = p_id and a.company_entity_id = v_company;
  end if;
  if v_source is null then raise exception 'That entry was not found in this company'; end if;
  perform public.quickbooks_entry_lock(v_company, v_source, v_ref);
  if not p_marked then
    delete from public.quickbooks_entered_by_hand
      where company_entity_id = v_company and source = v_source and source_ref = v_ref;
    return jsonb_build_object('marked', false);
  end if;
  -- Read again under the lock: a send that began before it is visible now.
  if p_kind = 'batch' then
    select i.status into v_status from public.card_import_batches i where i.id = p_id;
  else
    select a.status into v_status from public.journal_adjustments a where a.id = p_id;
  end if;
  if v_status is distinct from 'draft' and v_status is distinct from 'categorized' and v_status is distinct from 'approved' then
    raise exception 'SILO already sent this entry, or it was voided, so it cannot be marked as entered by hand';
  end if;
  if exists (select 1 from public.quickbooks_journal_postings p
      where p.company_entity_id = v_company and p.source = v_source and p.source_ref = v_ref
        and p.status in ('submitting', 'unknown', 'posted')) then
    raise exception 'SILO has a send on record for this entry. Resolve that first';
  end if;
  insert into public.quickbooks_entered_by_hand(company_entity_id, source, source_ref, approval_hash, created_by)
    values (v_company, v_source, v_ref, v_hash, auth.uid())
    on conflict (company_entity_id, source, source_ref) do nothing;
  return jsonb_build_object('marked', true);
end $$;
revoke all on function public.set_entry_entered_in_quickbooks(text, uuid, boolean) from public, anon;
grant execute on function public.set_entry_entered_in_quickbooks(text, uuid, boolean) to authenticated;

-- A claim to send an entry that is marked is refused, whichever page asked.
-- Only a row ENTERING 'submitting' is judged, like the other claim guards, so
-- a receipt or a recovery update is never slowed or refused.
create or replace function public.quickbooks_entered_by_hand_claim_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status <> 'submitting' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'submitting' then return new; end if;
  perform public.quickbooks_entry_lock(new.company_entity_id, new.source, new.source_ref);
  if exists (select 1 from public.quickbooks_entered_by_hand h
      where h.company_entity_id = new.company_entity_id and h.source = new.source and h.source_ref = new.source_ref) then
    raise exception 'This entry is marked as already entered in QuickBooks by hand, so SILO did not send it. Nothing was sent.'
      using errcode = 'P0PS3';
  end if;
  return new;
end $$;
revoke all on function public.quickbooks_entered_by_hand_claim_guard() from public, anon, authenticated;
-- Alphabetical trigger order is the claim guards' lock order (Plaid account,
-- batch, company). This one sorts after the batch guards and before
-- zz_bookkeeping_mode_claim, and takes only its own lock.
drop trigger if exists qbo_entered_by_hand_claim on public.quickbooks_journal_postings;
create trigger qbo_entered_by_hand_claim before insert or update of status on public.quickbooks_journal_postings
  for each row execute function public.quickbooks_entered_by_hand_claim_guard();

select public.attach_stamp_company_entity_id_triggers();
