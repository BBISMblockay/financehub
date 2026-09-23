-- Background coding preparation: which rows still need a suggestion, who is
-- preparing them right now, and what the scheduler should do next.
--
-- 20260923120000 made a suggestion a durable record. This makes preparation
-- run without a browser: after every bank feed sync, and nightly as a catch-up
-- for CSV imports and anything missed. Three rules shape it:
--
--   * Work is DERIVED, not enqueued. card_coding_needs_preparation() says of
--     any transaction whether it should be prepared now, from facts already
--     stored -- so a missed sync, an interrupted run or a failed call is picked
--     up by the next pass without a queue that could itself be lost or stale.
--   * A CLAIM with a lease stops two workers, or a worker and a button click,
--     paying for the same rows. A crashed claimant's lease expires; nothing
--     needs cleaning up by hand.
--   * Preparation still writes only card_coding_suggestions. Accepting, batch
--     approval and posting are people's acts and nothing here reaches them.

-- ── Is a suggestion still about these facts? One definition ───────────────
-- 20260923120000 made this the one test the read view, the writer's duplicate
-- gate and (here) the scheduler all ask. It now also treats a retired LOCATION
-- as stale: accept refuses an inactive location, so a suggestion naming one
-- would sit on screen as ready, fail when used, and -- counted as prepared --
-- never be replaced.
create or replace function public.card_coding_suggestion_stale_reason(
  g public.card_coding_suggestions, t public.card_transactions, s public.card_sources)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when public.card_coding_input_hash(t) <> g.input_hash then 'facts_changed'
    when s.qbo_connection_id is distinct from g.qbo_connection_id then 'connection_changed'
    when g.outcome = 'suggested' and not exists (select 1 from public.quickbooks_accounts a
      where a.company_entity_id = g.company_entity_id and a.connection_id = g.qbo_connection_id
        and a.qbo_account_id = g.qbo_account_id and a.is_active) then 'account_unavailable'
    when g.qbo_location_id is not null and not exists (select 1 from public.quickbooks_locations l
      where l.company_entity_id = g.company_entity_id and l.connection_id = g.qbo_connection_id
        and l.qbo_location_id = g.qbo_location_id and l.is_active) then 'location_unavailable'
    else null end
$$;

-- ── Which accounts are prepared in the background at all ────────────────
-- Explicit, per account, and off by default: background preparation spends
-- model calls on a company's behalf, so no tenant's account is prepared until
-- someone switches it on. The bookkeeper's Prepare button does not read this.
alter table public.card_sources add column if not exists auto_prepare_coding boolean not null default false;

-- ── Claims: who is preparing a transaction right now ──────────────────────
create table if not exists public.card_coding_preparation_claims (
  transaction_id uuid primary key,
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  claim_token uuid not null,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (transaction_id, company_entity_id)
    references public.card_transactions(id, company_entity_id) on delete cascade
);
create index if not exists card_coding_claims_token_idx on public.card_coding_preparation_claims (claim_token);
alter table public.card_coding_preparation_claims enable row level security;
-- No policy and no client grant: claims are the preparer's bookkeeping.
revoke all on public.card_coding_preparation_claims from anon, authenticated;
grant all on public.card_coding_preparation_claims to service_role;

-- Automatic retries back off 15m, 30m, 1h, 2h and stop after the fifth: a row
-- that keeps failing needs a person to look, and the page offers Retry.
create or replace function public.card_coding_retry_after(p_attempt integer, p_prepared_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_prepared_at + least(interval '15 minutes' * power(2, greatest(p_attempt, 1) - 1), interval '24 hours')
$$;

-- ── Should this transaction be prepared automatically, now? ────────────────
-- NULL means yes. Otherwise the reason not, which is what makes a skipped row
-- distinguishable from a forgotten one.
create or replace function public.card_coding_needs_preparation(
  t public.card_transactions, b public.card_import_batches, s public.card_sources)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare v_blocker text; v_live public.card_coding_suggestions%rowtype;
begin
  v_blocker := public.card_coding_preparation_blocker(t, b, s);
  if v_blocker is not null then return v_blocker; end if;
  if s.qbo_connection_id is null or (b.qbo_connection_id is not null and b.qbo_connection_id <> s.qbo_connection_id)
    or not exists (select 1 from public.quickbooks_connections c
      where c.id = s.qbo_connection_id and c.company_entity_id = t.company_entity_id and c.is_active) then
    return 'no_connection';
  end if;
  if exists (select 1 from public.card_coding_preparation_claims c where c.transaction_id = t.id and c.expires_at > now()) then
    return 'in_progress';
  end if;
  select * into v_live from public.card_coding_suggestions g
    where g.transaction_id = t.id and g.review_status in ('open','dismissed');
  if v_live.id is null or public.card_coding_suggestion_stale_reason(v_live, t, s) is not null then return null; end if;
  if v_live.review_status = 'dismissed' then return 'dismissed'; end if;
  if v_live.outcome <> 'failed' then return 'prepared'; end if;
  if v_live.attempt >= 5 then return 'retry_limit'; end if;
  if now() < public.card_coding_retry_after(v_live.attempt, v_live.prepared_at) then return 'backoff'; end if;
  return null;
end $$;

-- ── Claim and release ─────────────────────────────────────────────────────
-- Returns the ids THIS caller now holds. A row another live claim holds is
-- simply absent from the result; an expired claim is taken over.
create or replace function public.claim_card_coding_preparation(
  p_company uuid, p_ids uuid[], p_token uuid, p_lease_seconds integer default 240)
returns setof uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.card_coding_preparation_claims as c (transaction_id, company_entity_id, claim_token, claimed_at, expires_at)
  select t.id, t.company_entity_id, p_token, now(), now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)))
  from public.card_transactions t
  where t.company_entity_id = p_company and t.id = any(p_ids)
  on conflict (transaction_id) do update
    set claim_token = excluded.claim_token, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
    where c.expires_at <= now() or c.claim_token = excluded.claim_token
  returning transaction_id
$$;

create or replace function public.release_card_coding_preparation(p_token uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  delete from public.card_coding_preparation_claims where claim_token = p_token;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ── Housekeeping: runs the gateway cut off, leases nobody released ────────
-- A run the edge gateway killed at 150s never writes its finish. Its finished
-- slices are saved already; this only stops the run log claiming it is still
-- going, and says what happened.
create or replace function public.close_interrupted_card_coding_runs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update public.card_coding_preparation_runs set status = 'failed', finished_at = now(),
    error = coalesce(error || ' | ', '') || 'interrupted before it finished (gateway limit or crash); finished model calls were saved'
    where status = 'running' and started_at < now() - interval '10 minutes';
  get diagnostics v_count = row_count;
  delete from public.card_coding_preparation_claims where expires_at <= now();
  return v_count;
end $$;

-- ── What the scheduler should prepare next ────────────────────────────────
-- One import per call, which bounds a scheduled invocation's runtime. The
-- caller names at most a cursor (the last import it finished) or the import it
-- is still working through; the company is read from the import, never taken
-- from the caller.
create or replace function public.next_card_coding_work(p_after uuid, p_batch uuid, p_limit integer default 160)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_batch public.card_import_batches%rowtype; v_ids uuid[]; v_total integer;
begin
  perform public.close_interrupted_card_coding_runs();
  select b.* into v_batch
    from public.card_import_batches b join public.card_sources s on s.id = b.source_id
    where b.status in ('draft','categorized') and s.is_active and s.auto_prepare_coding
      and (case when p_batch is not null then b.id = p_batch else (p_after is null or b.id > p_after) end)
      and exists (select 1 from public.card_transactions t
        where t.batch_id = b.id and t.status = 'uncoded' and t.qbo_account_id is null
          and public.card_coding_needs_preparation(t, b, s) is null)
    order by b.id limit 1;
  if v_batch.id is null then return null; end if;
  select array_agg(id order by txn_date desc nulls last, id), count(*) into v_ids, v_total from (
    select t.id, t.txn_date from public.card_transactions t join public.card_sources s on s.id = v_batch.source_id
    where t.batch_id = v_batch.id and t.status = 'uncoded' and t.qbo_account_id is null
      and public.card_coding_needs_preparation(t, v_batch, s) is null) x;
  return jsonb_build_object('batch_id', v_batch.id, 'company_entity_id', v_batch.company_entity_id,
    'transaction_ids', to_jsonb(v_ids[1:greatest(1, least(coalesce(p_limit, 160), 500))]),
    'remaining', greatest(0, v_total - greatest(1, least(coalesce(p_limit, 160), 500))));
end $$;

revoke all on function public.claim_card_coding_preparation(uuid, uuid[], uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_card_coding_preparation(uuid, uuid[], uuid, integer) to service_role;
revoke all on function public.release_card_coding_preparation(uuid) from public, anon, authenticated;
grant execute on function public.release_card_coding_preparation(uuid) to service_role;
revoke all on function public.close_interrupted_card_coding_runs() from public, anon, authenticated;
grant execute on function public.close_interrupted_card_coding_runs() to service_role;
revoke all on function public.next_card_coding_work(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.next_card_coding_work(uuid, uuid, integer) to service_role;
revoke all on function public.card_coding_needs_preparation(public.card_transactions, public.card_import_batches, public.card_sources) from public, anon;
grant execute on function public.card_coding_needs_preparation(public.card_transactions, public.card_import_batches, public.card_sources) to authenticated, service_role;
revoke all on function public.card_coding_suggestion_stale_reason(public.card_coding_suggestions, public.card_transactions, public.card_sources) from public, anon;
grant execute on function public.card_coding_suggestion_stale_reason(public.card_coding_suggestions, public.card_transactions, public.card_sources) to authenticated, service_role;

do $$ begin
  if to_regprocedure('public.attach_stamp_company_entity_id_triggers()') is not null then
    perform public.attach_stamp_company_entity_id_triggers();
  end if;
end $$;
select public.refresh_chat_schema_catalog();
