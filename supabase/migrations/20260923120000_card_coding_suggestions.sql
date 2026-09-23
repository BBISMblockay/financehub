-- Prepared coding suggestions, stored server-side and kept apart from the
-- accepted coding on card_transactions.
--
-- Until now a Claude suggestion lived in a browser Map: reload the page, open it
-- in another tab, or hand it to a colleague, and the prepared work was gone and
-- had to be paid for again. This migration makes a suggestion a durable record
-- with its own lifecycle, and keeps three things separate on purpose:
--
--   * PREPARING a suggestion writes only card_coding_suggestions. It never
--     touches card_transactions, so a background run can never overwrite a
--     human edit, a split, or an exclusion.
--   * ACCEPTING one is a person's act. accept_card_coding_suggestions re-checks
--     the transaction, its batch, the facts the suggestion was made from, and
--     the account, then writes through apply_card_coding -- the same coding path
--     the Save button uses -- as that person.
--   * APPROVING and POSTING are unchanged and live nowhere near this file.
--
-- A suggestion is STALE when the facts it was prepared from have changed. The
-- facts are summarised by card_coding_input_hash() -- one definition, used by
-- the writer, the accept path and the read view. A bank correction bumps
-- provider_updated_at (plaid_project_transaction does that only when the
-- accounting facts move), so a changed amount, date or description retires
-- every suggestion made against the old facts, dismissed ones included.
--
-- AI suggestions are not evidence. Nothing that reads coding history reads this
-- table; an accepted suggestion becomes a card_transactions row with
-- coding_source = 'ai', which history counts only once its batch is approved or
-- posted -- the rule that already applied before this table existed.

-- ── What a suggestion was prepared from ───────────────────────────────────
-- Every input the categoriser reads from the transaction itself. Timestamps go
-- in as epoch numbers: a timestamptz rendered to JSON uses the session time
-- zone, and a hash that depends on who is asking is not a revision.
create or replace function public.card_coding_input_hash(t public.card_transactions)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select md5(jsonb_build_array(
    t.id, t.company_entity_id, t.txn_date, t.amount, t.currency, t.description, t.merchant,
    t.clean_merchant, t.card_name, t.cardholder, t.origin, t.provider_status,
    extract(epoch from t.provider_updated_at), t.accounting_treatment
  )::text)
$$;

-- ── Which transactions may be prepared at all ─────────────────────────────
-- NULL when the row may be prepared, otherwise the reason it may not. The same
-- conditions card-categorize has always applied before asking the model,
-- written once here so the writer and the accept path cannot disagree.
create or replace function public.card_coding_preparation_blocker(
  t public.card_transactions, b public.card_import_batches, s public.card_sources)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when b.id is null or b.id <> t.batch_id or b.company_entity_id <> t.company_entity_id then 'batch_missing'
    when b.status not in ('draft','categorized') then 'batch_locked'
    when s.id is null or s.id <> b.source_id or not s.is_active or s.source_type not in ('bank','card') then 'source_inactive'
    when t.status = 'excluded' then 'excluded'
    -- Before already_coded: a split row is stored as coded with no single
    -- account, and "split" is the reason a person can act on.
    when exists (select 1 from public.card_transaction_splits x where x.transaction_id = t.id) then 'split'
    when t.status <> 'uncoded' or t.qbo_account_id is not null then 'already_coded'
    when t.origin is distinct from b.origin then 'origin_mismatch'
    when t.origin = 'plaid' and t.provider_status is distinct from 'posted' then 'not_settled'
    when t.amount is null or t.amount = 0 or t.currency is distinct from 'USD' then 'unsupported_amount'
    when s.source_type = 'card' and (t.amount < 0 or (t.origin = 'plaid' and t.accounting_treatment is distinct from 'purchase'))
      then 'not_a_purchase'
    when coalesce(public.normalize_merchant(coalesce(t.clean_merchant, t.description)), '') = '' then 'no_merchant'
    else null end
$$;

-- Whether an account may carry a transaction of this treatment and direction.
-- Mirrors the categoriser's allowedTypes and the page's suggestionAccount().
create or replace function public.card_coding_account_fits(p_treatment text, p_account_type text, p_amount numeric)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_treatment
    when 'purchase' then p_amount > 0 and p_account_type in ('Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset')
    when 'refund' then p_amount < 0 and p_account_type in ('Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset')
    when 'deposit' then p_amount < 0 and p_account_type in ('Income','Other Income')
    when 'transfer' then p_account_type in ('Other Current Asset','Other Current Liability')
    when 'payroll_settlement' then p_account_type in ('Other Current Asset','Other Current Liability')
    when 'shopify_settlement' then p_account_type in ('Other Current Asset','Other Current Liability')
    when 'card_payment' then p_account_type in ('Credit Card','Accounts Payable')
    else false end
$$;

-- ── One row per preparation run: what was asked, what came back, how long ──
create table if not exists public.card_coding_preparation_runs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  source_id uuid references public.card_sources(id) on delete set null,
  batch_id uuid references public.card_import_batches(id) on delete set null,
  qbo_connection_id uuid not null,
  trigger text not null check (trigger in ('manual','retry','background','nightly')),
  requested_by uuid references auth.users(id) on delete set null,
  status text not null default 'running' check (status in ('running','completed','partial','failed')),
  model text,
  prompt_version text,
  transactions_requested integer not null default 0,
  groups_requested integer not null default 0,
  model_calls integer not null default 0,
  model_calls_failed integer not null default 0,
  suggestions_recorded integer not null default 0,
  needs_judgment_recorded integer not null default 0,
  failures_recorded integer not null default 0,
  skipped integer not null default 0,
  -- Milliseconds per phase (auth, load, context, history, model, persist, total)
  -- and the model's own token counts. Measurements, never estimates.
  timings jsonb not null default '{}'::jsonb,
  usage jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists card_coding_runs_source_idx
  on public.card_coding_preparation_runs (company_entity_id, source_id, started_at desc);

-- ── The suggestions themselves ────────────────────────────────────────────
create table if not exists public.card_coding_suggestions (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  transaction_id uuid not null,
  run_id uuid references public.card_coding_preparation_runs(id) on delete set null,
  qbo_connection_id uuid not null,
  input_hash text not null,
  -- suggested: an account from the active chart. needs_judgment: the model (or
  -- validation) declined to name one. failed: preparation did not complete.
  outcome text not null check (outcome in ('suggested','needs_judgment','failed')),
  review_status text not null default 'open'
    check (review_status in ('open','accepted','dismissed','superseded')),
  attempt integer not null default 1 check (attempt >= 1),
  qbo_account_id text,
  qbo_account_name text,
  qbo_location_id text,
  qbo_location_name text,
  vendor_name text,
  accounting_treatment text check (accounting_treatment is null or accounting_treatment in
    ('purchase','refund','deposit','transfer','card_payment','payroll_settlement','shopify_settlement','unknown')),
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  reasoning text,
  evidence text,
  history_status text,
  error_code text,
  model text,
  prompt_version text,
  prepared_via text not null check (prepared_via in ('manual','retry','background','nightly')),
  prepared_by uuid references auth.users(id) on delete set null,
  prepared_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  foreign key (transaction_id, company_entity_id)
    references public.card_transactions(id, company_entity_id) on delete cascade,
  constraint card_coding_suggestion_account_matches_outcome check (
    (outcome = 'suggested' and qbo_account_id is not null) or (outcome <> 'suggested' and qbo_account_id is null)),
  -- A superseded row keeps whatever decision it carried (a dismissal that the
  -- facts later overtook is still a dismissal someone made).
  constraint card_coding_suggestion_decision_recorded check (
    (review_status <> 'open' or decided_at is null)
    and (review_status not in ('accepted','dismissed') or decided_at is not null))
);
-- One LIVE suggestion per transaction. Accepted and superseded rows stay as
-- history -- what was suggested, and what a person did with it.
create unique index if not exists card_coding_suggestions_live
  on public.card_coding_suggestions (transaction_id) where review_status in ('open','dismissed');
create index if not exists card_coding_suggestions_company_idx
  on public.card_coding_suggestions (company_entity_id, review_status, prepared_at desc);

alter table public.card_coding_preparation_runs enable row level security;
alter table public.card_coding_suggestions enable row level security;

-- Read: the same population that may read split lines and code transactions.
drop policy if exists card_coding_runs_read on public.card_coding_preparation_runs;
create policy card_coding_runs_read on public.card_coding_preparation_runs for select to authenticated
  using (company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner()));
drop policy if exists card_coding_suggestions_read on public.card_coding_suggestions;
create policy card_coding_suggestions_read on public.card_coding_suggestions for select to authenticated
  using (company_entity_id = public.active_company_id()
    and (public.can_manage_journal_entries() or public.is_exec_or_owner()));

-- Write: nobody client-side. Supabase grants authenticated full DML on every
-- new table, and a client-authored suggestion is one Claude never made.
revoke all on public.card_coding_preparation_runs from anon, authenticated;
revoke all on public.card_coding_suggestions from anon, authenticated;
grant select on public.card_coding_preparation_runs to authenticated;
grant select on public.card_coding_suggestions to authenticated;
grant all on public.card_coding_preparation_runs to service_role;
grant all on public.card_coding_suggestions to service_role;

-- ── Read view: is the suggestion still about these facts? ──────────────────
drop view if exists public.card_coding_suggestions_v;
create view public.card_coding_suggestions_v with (security_invoker = true) as
select g.*,
  t.batch_id,
  t.status as transaction_status,
  case
    when public.card_coding_input_hash(t) <> g.input_hash then 'facts_changed'
    when s.qbo_connection_id is distinct from g.qbo_connection_id then 'connection_changed'
    when g.outcome = 'suggested' and not exists (select 1 from public.quickbooks_accounts a
      where a.company_entity_id = g.company_entity_id and a.connection_id = g.qbo_connection_id
        and a.qbo_account_id = g.qbo_account_id and a.is_active) then 'account_unavailable'
    else null end as stale_reason
from public.card_coding_suggestions g
join public.card_transactions t on t.id = g.transaction_id and t.company_entity_id = g.company_entity_id
join public.card_import_batches b on b.id = t.batch_id
join public.card_sources s on s.id = b.source_id;
grant select on public.card_coding_suggestions_v to authenticated;

-- ── The fingerprints a preparer reads BEFORE it reads the facts ───────────
-- Read first, facts second: if anything moves in between, the fingerprint the
-- preparer carries no longer matches and the answer is refused. updated_at
-- cannot serve here -- nothing maintains it on a direct row update.
create or replace function public.card_coding_input_hashes(p_company uuid, p_ids uuid[])
returns table (transaction_id uuid, input_hash text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, public.card_coding_input_hash(t) from public.card_transactions t
  where t.company_entity_id = p_company and t.id = any(p_ids)
$$;

-- ── Writer: record what a preparation run produced ────────────────────────
-- Service role only. Each row carries the fingerprint the preparer READ before
-- it read the facts; a row that has changed since was not what the model saw,
-- so it is refused rather than stamped with a revision describing other facts.
create or replace function public.record_card_coding_suggestions(
  p_run_id uuid, p_rows jsonb, p_retry boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.card_coding_preparation_runs%rowtype;
  v_row jsonb; v_txn uuid;
  v_t public.card_transactions%rowtype; v_b public.card_import_batches%rowtype; v_s public.card_sources%rowtype;
  v_live public.card_coding_suggestions%rowtype;
  v_hash text; v_outcome text; v_account_id text; v_account_name text; v_account_type text;
  v_location_id text; v_location_name text; v_treatment text; v_error text; v_blocker text;
  v_recorded integer := 0; v_skipped jsonb := '[]'::jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'record_card_coding_suggestions expects a json array'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Too many suggestions in one call'; end if;
  select * into v_run from public.card_coding_preparation_runs where id = p_run_id;
  if not found then raise exception 'Preparation run not found'; end if;

  -- Ascending transaction order, the same order accept takes these locks in,
  -- so a recorder and a bulk accept can never wait on each other in a cycle.
  for v_row in select value from jsonb_array_elements(p_rows) order by value->>'transaction_id' loop
    v_txn := nullif(v_row->>'transaction_id','')::uuid;
    -- Two workers, a worker and a button click, or a worker and an accept,
    -- serialise per transaction.
    perform pg_advisory_xact_lock(hashtextextended('card_coding_suggestion:' || coalesce(v_txn::text,''), 0));
    select * into v_t from public.card_transactions where id = v_txn and company_entity_id = v_run.company_entity_id;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', 'not_found'); continue;
    end if;
    if public.card_coding_input_hash(v_t) is distinct from nullif(v_row->>'expected_input_hash','') then
      v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', 'changed_since_read'); continue;
    end if;
    select * into v_b from public.card_import_batches where id = v_t.batch_id;
    select * into v_s from public.card_sources where id = v_b.source_id;
    v_blocker := public.card_coding_preparation_blocker(v_t, v_b, v_s);
    if v_blocker is not null then
      v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', v_blocker); continue;
    end if;
    if v_s.qbo_connection_id is distinct from v_run.qbo_connection_id
      or (v_b.qbo_connection_id is not null and v_b.qbo_connection_id <> v_run.qbo_connection_id) then
      v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', 'connection_changed'); continue;
    end if;
    v_hash := public.card_coding_input_hash(v_t);
    v_outcome := v_row->>'outcome';
    if v_outcome is null or v_outcome not in ('suggested','needs_judgment','failed') then raise exception 'Unknown suggestion outcome %', v_outcome; end if;

    select * into v_live from public.card_coding_suggestions
      where transaction_id = v_txn and review_status in ('open','dismissed') for update;
    if v_live.id is not null and v_live.input_hash = v_hash and v_live.qbo_connection_id = v_run.qbo_connection_id then
      -- A dismissal stands until the facts change or someone asks again.
      if v_live.review_status = 'dismissed' and not p_retry then
        v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', 'dismissed'); continue;
      end if;
      -- Never trade a prepared answer for a failure.
      if v_outcome = 'failed' and v_live.outcome <> 'failed' then
        v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', 'kept_prepared'); continue;
      end if;
      -- Duplicate delivery of the same work: the first answer stands.
      if v_live.review_status = 'open' and v_live.outcome <> 'failed' and not p_retry then
        v_skipped := v_skipped || jsonb_build_object('transaction_id', v_txn, 'reason', 'already_prepared'); continue;
      end if;
    end if;

    v_account_id := null; v_account_name := null; v_location_id := null; v_location_name := null; v_error := nullif(v_row->>'error_code','');
    v_treatment := nullif(v_row->>'accounting_treatment','');
    if v_treatment is not null and v_treatment not in ('purchase','refund','deposit','transfer','card_payment','payroll_settlement','shopify_settlement','unknown') then
      v_treatment := 'unknown';
    end if;
    if v_outcome = 'suggested' then
      -- The account is re-read from the chart: the name stored is the chart's,
      -- never the model's, and an account that is not active in this realm, or
      -- that cannot carry this transaction, is not a suggestion.
      select a.qbo_account_id, coalesce(a.fully_qualified_name, a.name), a.account_type
        into v_account_id, v_account_name, v_account_type
        from public.quickbooks_accounts a
        where a.company_entity_id = v_run.company_entity_id and a.connection_id = v_run.qbo_connection_id
          and a.qbo_account_id = v_row->>'qbo_account_id' and a.is_active;
      if v_account_id is null or not public.card_coding_account_fits(
          coalesce(v_treatment, case when v_t.amount > 0 then 'purchase' else 'refund' end), v_account_type, v_t.amount) then
        v_outcome := 'needs_judgment'; v_account_id := null; v_account_name := null; v_error := 'account_rejected';
      else
        select l.qbo_location_id, coalesce(l.fully_qualified_name, l.name) into v_location_id, v_location_name
          from public.quickbooks_locations l
          where l.company_entity_id = v_run.company_entity_id and l.connection_id = v_run.qbo_connection_id and l.is_active
            and (coalesce(l.fully_qualified_name, l.name) = v_row->>'location_name' or l.qbo_location_id = v_row->>'qbo_location_id')
          order by l.qbo_location_id limit 1;
      end if;
    end if;

    if v_live.id is not null then
      update public.card_coding_suggestions set review_status = 'superseded' where id = v_live.id;
    end if;
    insert into public.card_coding_suggestions(company_entity_id, transaction_id, run_id, qbo_connection_id, input_hash,
      outcome, attempt, qbo_account_id, qbo_account_name, qbo_location_id, qbo_location_name, vendor_name,
      accounting_treatment, confidence, reasoning, evidence, history_status, error_code, model, prompt_version,
      prepared_via, prepared_by)
    values (v_run.company_entity_id, v_txn, v_run.id, v_run.qbo_connection_id, v_hash,
      v_outcome,
      case when v_live.id is not null and v_live.input_hash = v_hash then v_live.attempt + 1 else 1 end,
      v_account_id, v_account_name, v_location_id, v_location_name, left(nullif(v_row->>'vendor_name',''), 200),
      v_treatment,
      case when v_outcome = 'failed' then null else least(1, greatest(0, coalesce((v_row->>'confidence')::numeric, 0))) end,
      left(nullif(v_row->>'reasoning',''), 600), left(nullif(v_row->>'evidence',''), 800), left(nullif(v_row->>'history_status',''), 40),
      left(v_error, 200), coalesce(nullif(v_row->>'model',''), v_run.model), coalesce(nullif(v_row->>'prompt_version',''), v_run.prompt_version),
      v_run.trigger, v_run.requested_by);
    v_recorded := v_recorded + 1;
  end loop;
  return jsonb_build_object('recorded', v_recorded, 'skipped', v_skipped);
end $$;

-- ── Accept: a person applies a suggestion, re-checked at the moment they do ─
-- SECURITY DEFINER because suggestions have no client write grant. Every check
-- card_transactions' RLS would have made is made here explicitly -- company,
-- permission, a mutable batch -- and then the coding goes through
-- apply_card_coding, so a suggestion is saved exactly as a hand-coded row is,
-- by the person accepting it. Each id succeeds or is refused on its own.
create or replace function public.accept_card_coding_suggestions(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_id uuid; v_g public.card_coding_suggestions%rowtype;
  v_t public.card_transactions%rowtype; v_b public.card_import_batches%rowtype; v_s public.card_sources%rowtype;
  v_blocker text; v_type text; v_name text; v_treatment text; v_count integer;
  v_accepted jsonb := '[]'::jsonb; v_refused jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or v_company is null then raise exception 'Sign in and choose a company first'; end if;
  if not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then raise exception 'Accept between 1 and 500 suggestions at a time'; end if;
  -- Parents first, in the same stable order apply_card_coding and the bank
  -- sync take them, so this cannot deadlock against either.
  perform 1 from public.card_import_batches b where b.id in (
    select t.batch_id from public.card_coding_suggestions g
    join public.card_transactions t on t.id = g.transaction_id
    where g.id = any(p_ids) and g.company_entity_id = v_company) order by b.id for update;

  for v_id in select x from unnest(p_ids) x
      left join public.card_coding_suggestions g0 on g0.id = x and g0.company_entity_id = v_company
      group by x, g0.transaction_id order by g0.transaction_id nulls last, x loop
    begin
      select * into v_g from public.card_coding_suggestions where id = v_id and company_entity_id = v_company;
      if not found then raise exception using message = 'not_found'; end if;
      perform pg_advisory_xact_lock(hashtextextended('card_coding_suggestion:' || v_g.transaction_id::text, 0));
      select * into v_g from public.card_coding_suggestions where id = v_id for update;
      if v_g.review_status <> 'open' then raise exception using message = 'not_open'; end if;
      if v_g.outcome <> 'suggested' then raise exception using message = 'no_account_suggested'; end if;
      select * into v_t from public.card_transactions where id = v_g.transaction_id and company_entity_id = v_company for update;
      if not found then raise exception using message = 'not_found'; end if;
      select * into v_b from public.card_import_batches where id = v_t.batch_id;
      select * into v_s from public.card_sources where id = v_b.source_id;
      v_blocker := public.card_coding_preparation_blocker(v_t, v_b, v_s);
      if v_blocker is not null then raise exception using message = v_blocker; end if;
      if public.card_coding_input_hash(v_t) <> v_g.input_hash then raise exception using message = 'facts_changed'; end if;
      if v_s.qbo_connection_id is distinct from v_g.qbo_connection_id
        or (v_b.qbo_connection_id is not null and v_b.qbo_connection_id <> v_g.qbo_connection_id) then
        raise exception using message = 'connection_changed';
      end if;
      v_treatment := coalesce(v_g.accounting_treatment, case when v_t.amount > 0 then 'purchase' else 'refund' end);
      select a.account_type, coalesce(a.fully_qualified_name, a.name) into v_type, v_name
        from public.quickbooks_accounts a
        where a.company_entity_id = v_company and a.connection_id = v_g.qbo_connection_id
          and a.qbo_account_id = v_g.qbo_account_id and a.is_active;
      if v_type is null or not public.card_coding_account_fits(v_treatment, v_type, v_t.amount) then
        raise exception using message = 'account_unavailable';
      end if;
      if v_g.qbo_location_id is not null and not exists (select 1 from public.quickbooks_locations l
        where l.company_entity_id = v_company and l.connection_id = v_g.qbo_connection_id
          and l.qbo_location_id = v_g.qbo_location_id and l.is_active) then
        raise exception using message = 'location_unavailable';
      end if;
      v_count := public.apply_card_coding(jsonb_build_array(jsonb_build_object(
        'id', v_t.id, 'accounting_treatment', v_treatment,
        'expected_provider_updated_at', v_t.provider_updated_at,
        'qbo_account_id', v_g.qbo_account_id, 'qbo_account_name', v_name,
        'qbo_location_id', v_g.qbo_location_id, 'qbo_location_name', v_g.qbo_location_name,
        'entity_qbo_id', null, 'entity_name', null, 'entity_type', null,
        'vendor_name', coalesce(v_g.vendor_name, v_t.vendor_name), 'memo', v_t.memo,
        'coding_source', 'ai', 'confidence', v_g.confidence,
        -- The evidence line travels with the accepted row: it is the part a
        -- reviewer can check against the ledger.
        'ai_reasoning', left(trim(coalesce(v_g.reasoning, '') || case when v_g.evidence is not null
          then ' History: ' || v_g.evidence else '' end), 1400),
        'rule_id', null, 'status', 'coded', 'exclude_reason', null, 'coding_conflict', null)));
      if v_count <> 1 then raise exception using message = 'not_saved'; end if;
      update public.card_coding_suggestions set review_status = 'accepted', decided_at = now(), decided_by = auth.uid()
        where id = v_g.id;
      v_accepted := v_accepted || jsonb_build_object('id', v_g.id, 'transaction_id', v_t.id);
    exception when others then
      v_refused := v_refused || jsonb_build_object('id', v_id, 'reason', left(sqlerrm, 200));
    end;
  end loop;
  return jsonb_build_object('accepted', v_accepted, 'refused', v_refused);
end $$;

-- ── Dismiss: stays dismissed until the facts change or someone asks again ──
create or replace function public.dismiss_card_coding_suggestions(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid := public.active_company_id(); v_count integer;
begin
  if auth.uid() is null or v_company is null then raise exception 'Sign in and choose a company first'; end if;
  if not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then raise exception 'Finance access required'; end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then raise exception 'Dismiss between 1 and 500 suggestions at a time'; end if;
  update public.card_coding_suggestions set review_status = 'dismissed', decided_at = now(), decided_by = auth.uid()
    where id = any(p_ids) and company_entity_id = v_company and review_status = 'open';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.card_coding_input_hashes(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.card_coding_input_hashes(uuid, uuid[]) to service_role;
revoke all on function public.record_card_coding_suggestions(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.record_card_coding_suggestions(uuid, jsonb, boolean) to service_role;
revoke all on function public.accept_card_coding_suggestions(uuid[]) from public, anon;
grant execute on function public.accept_card_coding_suggestions(uuid[]) to authenticated, service_role;
revoke all on function public.dismiss_card_coding_suggestions(uuid[]) from public, anon;
grant execute on function public.dismiss_card_coding_suggestions(uuid[]) to authenticated, service_role;
revoke all on function public.card_coding_input_hash(public.card_transactions) from public, anon;
grant execute on function public.card_coding_input_hash(public.card_transactions) to authenticated, service_role;
revoke all on function public.card_coding_preparation_blocker(public.card_transactions, public.card_import_batches, public.card_sources) from public, anon;
grant execute on function public.card_coding_preparation_blocker(public.card_transactions, public.card_import_batches, public.card_sources) to authenticated, service_role;

-- The company stamp is a backstop for an insert that forgets the company; both
-- tables are written only by the functions above, which always set it.
do $$ begin
  if to_regprocedure('public.attach_stamp_company_entity_id_triggers()') is not null then
    perform public.attach_stamp_company_entity_id_triggers();
  end if;
end $$;

-- New public tables and a view: keep Ask SILO's schema map current.
select public.refresh_chat_schema_catalog();
