-- Clearing a bank row the feed has abandoned, without a database console.
--
-- A Plaid 'pending' row is a promise: the bank says a transaction is coming
-- and will later retire that id, either by posting it or by listing it in
-- removed[]. SILO keeps such a row 'excluded', so it is never in the books.
-- When the institution stops answering, that promise is never kept and the
-- rows sit there for ever. Observed 2026-10-26 on a Columbia Bank item: 21
-- rows frozen pending, two of them carrying amounts the bank plainly got
-- wrong, and Plaid's own institution page showing 0% success on existing
-- connection updates from that same day.
--
-- Until now nothing could remove them. plaid_guard_transaction refuses a
-- browser DELETE of a provider row outright, which is correct -- a person
-- must not be able to erase what the bank said -- so the only way out was a
-- hand-written DELETE by someone with database access. That is not a feature;
-- no other SILO company could do it at all.
--
-- It matters more now that hand-entered days exist (20261103070000). The
-- person types in the days the feed is missing, and their bank statement
-- shows those transactions on the day they actually settled. The abandoned
-- pending rows carry the SAME provider ids. If the institution ever comes
-- back, Plaid posts those ids against the rows it already gave us -- an
-- UPDATE by external id, which never consults the hand-entered claim -- and
-- the books end up holding both copies. Clearing the abandoned rows first is
-- what makes typing the days in safe.
--
-- Deleting is the right verb and it is not destructive here, by construction:
-- the rows are excluded (never in the books), never posted to QuickBooks, and
-- the bank's own copies come back if it ever delivers them -- and then they
-- arrive down the INSERT branch, where a hand-entered row CAN claim them.
--
-- Deliberately NOT done: no date is written into this file, nothing here
-- distinguishes one company from another, and nothing judges which rows look
-- implausible. The only question asked is whether the feed abandoned them.

create or replace function public.plaid_discard_stale_pending(
  p_account_id uuid, p_expected_ids text[])
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  -- The same threshold the scheduled top-up uses to call a feed silent
  -- (SILENT_DAYS_BEFORE_TOP_UP in supabase/functions/plaid-finance/handler.ts)
  -- and the same one the page warns on. A pending row younger than this is
  -- ordinary: the bank is simply still working on it.
  c_silent_days constant integer := 4;
  v_company uuid := public.active_company_id();
  v_account public.plaid_accounts%rowtype;
  v_source public.card_sources%rowtype;
  v_last_heard timestamptz;
  v_ids text[];
  v_row_ids uuid[];
  v_batch_ids uuid[];
  v_blocked text;
  v_removed jsonb;
  v_count integer;
begin
  if auth.uid() is null or v_company is null
    or not (public.can_manage_journal_entries() or public.is_exec_or_owner()) then
    raise exception 'Finance access required';
  end if;
  select * into v_account from public.plaid_accounts
    where id=p_account_id and company_entity_id=v_company for update;
  if not found then raise exception 'Plaid account not found'; end if;
  -- A sync in flight is the one thing that could retire these ids properly.
  if v_account.sync_lease_id is not null and v_account.sync_lease_expires_at>now() then
    raise exception 'Wait for account sync to finish';
  end if;
  select * into v_source from public.card_sources
    where id=v_account.source_id and is_active and ingest_mode='plaid';
  if not found then raise exception 'Map this account to an active bank feed first'; end if;

  -- Has the feed actually abandoned them? This asks when the PROVIDER last
  -- wrote anything for this account, not when SILO last asked: a sync that
  -- returns empty pages still updates last_synced_at, which is exactly how
  -- a stalled feed hid for a week.
  select max(provider_updated_at) into v_last_heard
    from public.card_transactions where plaid_account_id=p_account_id;
  if v_last_heard is null or v_last_heard > now() - make_interval(days => c_silent_days) then
    raise exception 'This feed is still delivering (last heard %). Pending rows clear themselves when the bank posts or withdraws them.',
      coalesce(v_last_heard::text, 'never');
  end if;

  if p_expected_ids is null or array_length(p_expected_ids,1) is null then
    raise exception 'Name the rows to clear';
  end if;
  if array_length(p_expected_ids,1) > 1000 then
    raise exception 'Clear at most 1000 rows at a time';
  end if;

  -- Everything eligible, decided here and not by the caller. There is no
  -- per-row freshness test, because there cannot be a meaningful one: the
  -- gate above already requires the newest provider write on the WHOLE
  -- account to be older than the silence threshold, so every row is older
  -- than it too. One row re-sent yesterday means the feed is answering
  -- again, and then nothing on the account is clearable -- which is the
  -- behaviour we want. Locked, so a sync cannot retire one of these between
  -- this read and the delete.
  select array_agg(t.id order by t.id), array_agg(t.batch_id),
         array_agg(t.external_transaction_id order by t.external_transaction_id),
         jsonb_agg(jsonb_build_object('external_transaction_id',t.external_transaction_id,
           'date',t.txn_date,'amount',t.amount,'description',t.description)
           order by t.txn_date, t.external_transaction_id),
         count(*)
    into v_row_ids, v_batch_ids, v_ids, v_removed, v_count
    from (select t.* from public.card_transactions t
            join public.card_import_batches b on b.id=t.batch_id
            where t.plaid_account_id=p_account_id and t.company_entity_id=v_company
              -- status='excluded' is deliberately redundant today: the row
              -- guard already refuses any pending feed row that is not
              -- excluded, so breaking this predicate fails no test. It stays
              -- because it is the safety property itself -- never clear
              -- anything that is in the books -- stated where the rows are
              -- chosen, rather than inferred from a rule in another function.
              and t.origin='plaid' and t.provider_status='pending' and t.status='excluded'
              and b.status in ('draft','categorized')
            for update of t) t;
  if coalesce(v_count,0)=0 then
    raise exception 'No abandoned pending rows on this account';
  end if;

  -- The person pressed a button on a list they were shown. If a sync has
  -- landed since, or the page is stale, the set they confirmed is not the set
  -- we would delete -- so delete nothing and let them look again.
  if v_ids is distinct from (
    select coalesce(array_agg(x order by x),'{}') from unnest(p_expected_ids) as x)
  then
    raise exception 'These rows have changed since the page loaded. Reload bank feeds and look again.';
  end if;

  -- Refuse rather than cascade. Each of these means somebody did work on the
  -- row, and silently taking that with it is how a cleanup becomes a loss.
  -- A reclass and a daily-ledger entry are deliberately NOT checked here:
  -- both require a row that is coded and in the books, which an excluded row
  -- is not, so the check would be unreachable -- and their foreign keys are
  -- NO ACTION, so the database itself refuses the delete if one ever existed.
  select string_agg(reason,'; ') into v_blocked from (
    select 'a bank change is under review' as reason where exists (
      select 1 from public.plaid_sync_exceptions e where e.transaction_id = any(v_row_ids))
    union all
    select 'a row is split across accounts' where exists (
      select 1 from public.card_transaction_splits s where s.transaction_id = any(v_row_ids))
  ) blockers;
  if v_blocked is not null then
    raise exception 'Cannot clear these rows: %. Resolve that first.', v_blocked;
  end if;

  delete from public.card_transactions where id = any(v_row_ids);

  update public.card_import_batches b set
    row_count=(select count(*) from public.card_transactions where batch_id=b.id),
    total_amount=(select coalesce(sum(amount),0) from public.card_transactions where batch_id=b.id),
    updated_at=now()
    where b.id = any(v_batch_ids) and b.status in ('draft','categorized');

  -- The audit row carries every discarded transaction in full, so what was
  -- cleared is answerable later even though the rows are gone.
  insert into public.finance_audit_events(company_entity_id,object_type,object_id,event_type,old_values,new_values)
    values(v_company,'plaid_accounts',p_account_id,'stale_pending_discarded',
      v_removed, jsonb_build_object('rows',v_count,'last_heard_from_bank',v_last_heard));

  return jsonb_build_object('account_id',p_account_id,'discarded',v_count,
    'last_heard_from_bank',v_last_heard,'rows',coalesce(v_removed,'[]'::jsonb));
end $fn$;

comment on function public.plaid_discard_stale_pending(uuid,text[]) is
  'Removes Plaid pending rows an abandoned feed will never retire: excluded, never in the books, in a batch that is not approved, and untouched by the provider since the feed went silent. The bank''s own copies return if it ever delivers them, and a hand-entered row can claim them then. Refuses while the feed is still delivering.';

revoke all on function public.plaid_discard_stale_pending(uuid,text[]) from public,anon;
grant execute on function public.plaid_discard_stale_pending(uuid,text[]) to authenticated;
