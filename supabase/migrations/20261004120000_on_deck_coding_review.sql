-- On Deck: transaction-coding review, approval and posting against the exact
-- version a person reviewed.
--
-- Nothing here is a second definition of a journal entry. Card coding already
-- has the whole chain: prepared suggestions (card_coding_suggestions),
-- accepting them (accept_card_coding_suggestions, which re-checks each row's
-- fingerprint), freezing the entry (approve_card_import_batch, which builds a
-- hashed QuickBooks-ready snapshot) and posting it (quickbooks-post-journal).
-- What was missing is the binding between what a person SAW and what the
-- server DID:
--
--   * approve_card_import_batch(p_batch_id) snapshots whatever the database
--     holds at the moment of the click. If a bank sync or a colleague changed a
--     row after the preview was drawn, the approval froze an entry nobody
--     looked at.
--
-- So:
--   card_import_batch_preview(batch)  -- the entry approve WOULD freeze, and its
--       hash, computed by RUNNING approve_card_import_batch inside a block that
--       is then rolled back. One definition of the entry, by construction: a
--       preview that rebuilt the lines itself would drift from approval the
--       first time either changed. A refusal from approve is returned as the
--       specific blocker ("Needs input"), never as a fabricated entry.
--   approve_reviewed_card_import_batch(batch, hash)  -- approves only when the
--       entry it freezes hashes to what the person reviewed; otherwise the
--       whole call rolls back and asks for a fresh preview.
--   on_deck_coding_items()  -- the finance review queue: real import batches
--       and the stage each is in. card_import_batches is readable by every
--       company member, so this gates on the finance population explicitly.
--   on_deck_ready_count()  -- the compact count on Home.
--
-- SILO is the ledger of record for this flow: approval freezes the entry in
-- SILO's journal register and is the finish line. Sending it to QuickBooks is
-- an optional extra step, bound to the reviewed approval in
-- quickbooks-post-journal (optional expected_approval_hash), not here.
--
-- No table, no policy, no grant on an existing object changes. The one-argument
-- approve_card_import_batch is untouched; Transactions keeps calling it.

-- ── Who may review coding on On Deck ────────────────────────────────────────
-- The same population accept/approve already admit, plus whether this caller
-- may POST (quickbooks-post-journal admits can_manage_journal_entries() only,
-- so an exec who is not finance can approve but not post, exactly as today).
create or replace function public.on_deck_coding_access()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'review', auth.uid() is not null and public.active_company_id() is not null
              and coalesce(public.can_manage_journal_entries() or public.is_exec_or_owner(), false),
    'post',   auth.uid() is not null and public.active_company_id() is not null
              and coalesce(public.can_manage_journal_entries(), false));
$$;

-- ── The finance review queue ────────────────────────────────────────────────
-- One row per import batch that still needs a person: draft/categorized
-- batches with transactions, approved batches not yet posted, and the last
-- fortnight's posted batches (receipts). Stage is derived, never stored:
--   code         open, current suggestions are waiting to be accepted
--   approve      every row is coded or excluded; the entry can be previewed
--   approved     approved in SILO: frozen in the journal register. DONE as far
--                as SILO is concerned; sending it to QuickBooks is optional
--   needs_input  something a person must supply first (stage_reason says what)
--   posted       approved and also sent to QuickBooks (receipt)
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

-- ── The entry approval would freeze, without freezing it ─────────────────────
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
    'ready', v_blocker is null and v_hash is not null,
    'blocker', v_blocker,
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
    'can_post', coalesce(public.can_manage_journal_entries(), false) and coalesce(v_source.posting_enabled, false));
end;
$$;

-- ── Approve exactly what was reviewed ───────────────────────────────────────
-- INVOKER: approve_card_import_batch is itself DEFINER and does every
-- permission, company and validation check. This only refuses when the entry
-- it froze is not the entry the person saw; raising rolls the approval back.
create or replace function public.approve_reviewed_card_import_batch(p_batch_id uuid, p_expected_hash text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if p_expected_hash is null or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Review the journal entry preview before approving' using errcode = '22023';
  end if;
  v_result := public.approve_card_import_batch(p_batch_id);
  if v_result->>'approval_hash' is distinct from p_expected_hash then
    raise exception 'This journal entry changed after you reviewed it. Review the updated preview before approving'
      using errcode = '40001';
  end if;
  return v_result;
end;
$$;

-- ── A QuickBooks claim must match the approval at the moment it is taken ────
-- quickbooks-post-journal reads the batch, does token and recovery work, and
-- only then inserts its 'submitting' claim. Without this guard another finance
-- user could reopen and reapprove in that gap, and the request would claim and
-- send the snapshot it read first -- an entry nobody now approves (cycle-1
-- review). plaid_guard_new_posting_claim already closes this for bank-feed
-- sources only; this closes it for every card import. The row lock serialises
-- with reopen_card_import_batch, which refuses once an active claim exists.
-- Named to fire AFTER plaid_new_posting_claim (alphabetical), so a bank-feed
-- source keeps that trigger's lock order (plaid_accounts, then the batch).
create or replace function public.card_import_claim_matches_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_batch public.card_import_batches%rowtype;
begin
  if new.source <> 'card_import' or new.status <> 'submitting' then return new; end if;
  select * into v_batch from public.card_import_batches where id = new.source_ref::uuid for update;
  if not found then raise exception 'Card batch not found for posting claim'; end if;
  if v_batch.status <> 'approved'
     or new.company_entity_id is distinct from v_batch.company_entity_id
     or new.connection_id is distinct from v_batch.qbo_connection_id
     or new.payload_hash is null or new.payload_hash is distinct from v_batch.approval_hash then
    raise exception 'The approved entry changed before it could be sent. Review the current version.'
      using errcode = 'P0OD1';
  end if;
  return new;
end;
$$;
revoke all on function public.card_import_claim_matches_approval() from public, anon, authenticated;
drop trigger if exists qbo_card_claim_matches_approval on public.quickbooks_journal_postings;
create trigger qbo_card_claim_matches_approval before insert on public.quickbooks_journal_postings
  for each row execute function public.card_import_claim_matches_approval();

-- ── The compact count on Home ───────────────────────────────────────────────
-- Counts only work waiting for a decision. An entry approved in SILO is done:
-- sending it to QuickBooks is optional and never counted as pending.
-- Counts only real work: coding batches in a reviewable stage (finance only,
-- via on_deck_coding_items' own gate) and On Deck proposals ready for a
-- decision (on_deck_proposals RLS already limits these to owner/admin members).
create or replace function public.on_deck_ready_count()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'coding', (select count(*) from public.on_deck_coding_items() i where i.stage in ('code', 'approve')),
    'needs_input', (select count(*) from public.on_deck_coding_items() i where i.stage = 'needs_input'),
    'proposals', (select count(*) from public.on_deck_proposals p
                  where p.company_entity_id = public.active_company_id() and p.status = 'ready'));
$$;

-- New public functions inherit EXECUTE for PUBLIC/anon through Supabase's
-- default privileges: revoke all, then grant authenticated explicitly.
do $$
declare f text;
begin
  foreach f in array array[
    'public.on_deck_coding_access()', 'public.on_deck_coding_items()',
    'public.card_import_batch_preview(uuid)', 'public.approve_reviewed_card_import_batch(uuid, text)',
    'public.on_deck_ready_count()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
