-- Coding evidence retrieval, and saved rules before any model call.
--
-- Two measured problems (Baseballism production, 2026-09-23, read-only):
--
--   1. HISTORY WAS CAPPED BEFORE IT WAS MATCHED. card-categorize paged the
--      window's ledger lines newest-first and stopped at 5,000, then looked for
--      the merchant among them. The 24-month window held 53,869 expense-side
--      lines (18,001 once the nine overlapping QuickBooks snapshots are
--      deduplicated); 5,000 reached back only to 2026-06-30. Of 52 uncoded
--      merchant keys, 3 have an exact payee match in the ledger (5,255 lines),
--      and inside the capped 5,000 only ONE key had any. The history was there;
--      the read order threw it away.
--      card_coding_history_evidence() matches FIRST -- per merchant, exact
--      payee, exact memo, then whole-word similar -- and caps each merchant
--      separately, exact matches ahead of similar ones, returning how many
--      lines matched so a cap is disclosed rather than read as the whole story.
--
--   2. THE BACKGROUND WORKER WOULD PAY FOR ROWS A SAVED RULE ANSWERS. Saved
--      rules are applied by the page (transactions.html ruleMatches), and the
--      page sends only what they leave. A worker has no page. 761 of this
--      company's 910 rules scope to its bank feed. card_coding_rule_match() is
--      the page's rule decision in SQL, so a row a rule already codes is never
--      sent to the model and never counted as needing preparation. The page
--      still APPLIES the rule when it opens; preparation writes nothing but
--      suggestions.
--
-- Evidence is never later than the transaction: every merchant is asked about
-- with its own "before" date (the EARLIEST row of its group), and nothing dated
-- after it is returned. An optional exclusion list lets an evaluation ask about
-- a row that is itself coded without its own coding counting as evidence.

-- ── The page's saved-rule decision, in SQL ────────────────────────────────
-- MIRRORS ruleMatches() in v2/transactions.html and ruleScopeMatches() in
-- v2/plaid-bank-feed.js, including their load order (priority, then a
-- source-specific rule, then hit_count, then id -- the page's stable sort over
-- rules loaded in that order). Changing one without the other makes the worker
-- and the page disagree about which rows a rule answers.
--   * a bank feed (plaid origin, plaid ingest or bank source) takes only rules
--     scoped to THIS source and THIS direction; a card takes unscoped or this
--     source's rules, direction 'any' or matching
--   * a merchant rule outranks a card-name rule -- unless they name a
--     different account or entity, which is a CONFLICT and codes nothing
--   * a rule with no account codes nothing
-- Returns NULL when no rule is live for the row, else
-- {rule_id, qbo_account_id, conflict}.
create or replace function public.card_coding_rule_match(t public.card_transactions, s public.card_sources)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_dir text := case when t.amount < 0 then 'inflow' else 'outflow' end;
  v_bank boolean := t.origin = 'plaid' or s.ingest_mode = 'plaid' or s.source_type = 'bank';
  v_raw text := lower(coalesce(t.description, ''));
  v_norm text := coalesce(public.normalize_merchant(coalesce(nullif(t.clean_merchant, ''), t.description)), '');
  v_card text := lower(coalesce(t.card_name, ''));
  m public.card_coding_rules%rowtype;
  c public.card_coding_rules%rowtype;
begin
  if s.id is null or (t.origin = 'plaid' and t.provider_status is distinct from 'posted') then return null; end if;
  select r.* into m from public.card_coding_rules r
    where r.company_entity_id = t.company_entity_id and r.is_active is not false
      and case when v_bank then r.source_id = s.id and r.direction = v_dir
               else (r.source_id is null or r.source_id = s.id) and (r.direction is null or r.direction in ('any', v_dir)) end
      and coalesce(r.match_field, 'merchant') = 'merchant'
      and case r.match_type
            when 'exact' then v_raw = lower(r.pattern)
            when 'contains' then position(lower(r.pattern) in v_raw) > 0 or position(lower(r.pattern) in v_norm) > 0
            else v_norm = lower(r.pattern) end
    order by r.priority desc, (r.source_id is not null) desc, r.hit_count desc, r.id
    limit 1;
  if v_card <> '' then
    select r.* into c from public.card_coding_rules r
      where r.company_entity_id = t.company_entity_id and r.is_active is not false
        and case when v_bank then r.source_id = s.id and r.direction = v_dir
                 else (r.source_id is null or r.source_id = s.id) and (r.direction is null or r.direction in ('any', v_dir)) end
        and r.match_field = 'card_name'
        and case r.match_type when 'contains' then position(lower(r.pattern) in v_card) > 0 else v_card = lower(r.pattern) end
      order by r.priority desc, (r.source_id is not null) desc, r.hit_count desc, r.id
      limit 1;
  end if;
  if m.id is not null and c.id is not null and (m.qbo_account_id is distinct from c.qbo_account_id
      or nullif(m.entity_qbo_id, '') is distinct from nullif(c.entity_qbo_id, '')) then
    return jsonb_build_object('rule_id', null, 'qbo_account_id', null, 'conflict', true);
  end if;
  if m.id is not null then return jsonb_build_object('rule_id', m.id, 'qbo_account_id', m.qbo_account_id, 'conflict', false); end if;
  if c.id is not null then return jsonb_build_object('rule_id', c.id, 'qbo_account_id', c.qbo_account_id, 'conflict', false); end if;
  return null;
end $$;

-- Rows of one company a saved rule codes outright (a rule with an account and
-- no conflict). A conflict is NOT here: the rules disagree, so a person
-- decides, and a prepared suggestion is useful evidence for that decision.
create or replace function public.card_coding_rule_answered(p_company uuid, p_ids uuid[])
returns table(transaction_id uuid, rule_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, (x.m->>'rule_id')::uuid
  from public.card_transactions t
  join public.card_import_batches b on b.id = t.batch_id and b.company_entity_id = t.company_entity_id
  join public.card_sources s on s.id = b.source_id and s.company_entity_id = t.company_entity_id
  cross join lateral (select public.card_coding_rule_match(t, s) m) x
  where t.company_entity_id = p_company and t.id = any(p_ids)
    and cardinality(p_ids) <= 5000
    and x.m is not null and not (x.m->>'conflict')::boolean and x.m->>'qbo_account_id' is not null
$$;

-- ── Needs preparation: a row a saved rule codes does not ────────────────────
create or replace function public.card_coding_needs_preparation(
  t public.card_transactions, b public.card_import_batches, s public.card_sources)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare v_blocker text; v_live public.card_coding_suggestions%rowtype; v_rule jsonb;
begin
  v_blocker := public.card_coding_preparation_blocker(t, b, s);
  if v_blocker is not null then return v_blocker; end if;
  v_rule := public.card_coding_rule_match(t, s);
  if v_rule is not null and not (v_rule->>'conflict')::boolean and v_rule->>'qbo_account_id' is not null then
    return 'rule_applies';
  end if;
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

-- ── Merchant-targeted history ─────────────────────────────────────────────
-- p_pairs: [{"key": <normalised merchant>, "before": "YYYY-MM-DD", "direction": "inflow"|"outflow"|null}]
-- One entry per merchant group, each with its OWN window: the 24 months up to
-- and including "before", never after it. Returns
--   {"rows":   [{i, src, match, account_id, account_name, date, amount}],
--    "totals": [{i, src, total}]}
-- where i is the pair's position, src is 'silo' or 'ledger', and total is how
-- many lines matched BEFORE the per-merchant cap -- total > rows returned is a
-- cap, and the caller says so.
--
-- SILO rows: this company, coded to one account, confirmed (manual or rule, or
-- an AI coding only once its batch is approved or posted -- an accepted but
-- unreviewed suggestion is the model agreeing with itself), not voided, from a
-- batch bound to THIS QuickBooks connection (the batch's own binding, else its
-- source's), exact merchant key only. In a bank feed the sign must match: a
-- Shopify payout and a Shopify subscription share a name and not an account.
--
-- Ledger lines: this company's archive imports for THIS connection, the
-- expense/asset/income leg only (a settlement leg says how a bill was paid,
-- not what it was), deduplicated across overlapping snapshots. Matched on the
-- payee (exact, or whole-word similar at four characters or more) or on the
-- memo (exact, or the memo containing the key -- bank-feed lines in QuickBooks
-- often carry the descriptor there and no payee). An outflow never takes an
-- income-account line as precedent.
--
-- Matching happens against the DISTINCT normalised payees and memos, so the
-- cost scales with how many different names the ledger holds, not with how
-- many lines.
create or replace function public.card_coding_history_evidence(
  p_company uuid, p_connection uuid, p_pairs jsonb, p_per_key integer default 100, p_exclude uuid[] default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb; v_per integer := greatest(1, least(coalesce(p_per_key, 100), 500));
begin
  if jsonb_typeof(p_pairs) is distinct from 'array' or jsonb_array_length(p_pairs) > 200 then
    raise exception 'history evidence takes an array of at most 200 merchants';
  end if;
  if exists (select 1 from jsonb_array_elements(p_pairs) e
      where coalesce(e->>'key', '') = '' or (e->>'before') !~ '^\d{4}-\d{2}-\d{2}$'
        or coalesce(e->>'direction', 'any') not in ('any', 'inflow', 'outflow')) then
    raise exception 'each merchant needs a key, a before date (YYYY-MM-DD) and at most a direction';
  end if;
  if not exists (select 1 from public.quickbooks_connections c where c.id = p_connection and c.company_entity_id = p_company) then
    raise exception 'connection does not belong to this company';
  end if;

  with pairs as (
    select (o - 1)::integer i, e->>'key' k, (e->>'before')::date d, nullif(e->>'direction', 'any') dir,
      ((e->>'before')::date - interval '24 months')::date lo
    from jsonb_array_elements(p_pairs) with ordinality as x(e, o)
  ),
  bounds as (select min(lo) lo, max(d) hi from pairs),
  silo_all as materialized (
    select t.id, t.qbo_account_id, t.qbo_account_name, t.txn_date, t.amount,
      public.normalize_merchant(coalesce(t.clean_merchant, t.description)) k
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id and b.company_entity_id = t.company_entity_id
    join public.card_sources s on s.id = b.source_id and s.company_entity_id = t.company_entity_id
    cross join bounds
    where t.company_entity_id = p_company and t.status = 'coded' and t.qbo_account_id is not null
      and t.txn_date between bounds.lo and bounds.hi and not (t.id = any(coalesce(p_exclude, '{}')))
      and coalesce(b.qbo_connection_id, s.qbo_connection_id) = p_connection
      and b.status <> 'voided'
      and (t.coding_source in ('manual', 'rule') or (t.coding_source = 'ai' and b.status in ('approved', 'posted')))
  ),
  silo as (
    select p.i, 'silo'::text src, 'exact'::text mt, 1 rank, a.qbo_account_id acct, a.qbo_account_name nm,
      a.txn_date dt, a.amount amt, a.id::text tie
    from pairs p join silo_all a on a.k = p.k and a.txn_date between p.lo and p.d
    where p.dir is null or (p.dir = 'outflow' and a.amount > 0) or (p.dir = 'inflow' and a.amount < 0)
  ),
  lines as (
    select h.id, h.qbo_account_id, h.account_name, h.account_type, h.transaction_date, h.natural_amount,
      h.counterparty, h.memo, h.qbo_transaction_id
    from public.qbo_history_lines h
    join public.qbo_history_imports im on im.id = h.import_id and im.company_entity_id = h.company_entity_id
    cross join bounds
    where h.company_entity_id = p_company and im.qbo_connection_id = p_connection
      and h.row_kind = 'transaction'
      and h.account_type in ('Expense', 'Other Expense', 'Cost of Goods Sold', 'Fixed Asset', 'Other Asset',
        'Other Current Asset', 'Income', 'Other Income')
      and h.transaction_date between bounds.lo and bounds.hi
  ),
  payees as materialized (select raw, public.normalize_merchant(raw) n from (select distinct counterparty raw from lines where counterparty is not null) x),
  memos as materialized (select raw, public.normalize_merchant(raw) n from (select distinct memo raw from lines where memo is not null) x),
  hits as (
    select p.i, 'payee'::text fld, y.raw, case when y.n = p.k then 1 else 3 end rank
    from pairs p join payees y on y.n = p.k
      or (least(length(y.n), length(p.k)) >= 4
        and (position(' ' || p.k || ' ' in ' ' || y.n || ' ') > 0 or position(' ' || y.n || ' ' in ' ' || p.k || ' ') > 0))
    union all
    select p.i, 'memo'::text, y.raw, case when y.n = p.k then 2 else 3 end
    from pairs p join memos y on y.n = p.k
      or (length(p.k) >= 4 and position(' ' || p.k || ' ' in ' ' || y.n || ' ') > 0)
  ),
  matched as (
    select h.i, h.rank, l.* from hits h join lines l on h.fld = 'payee' and l.counterparty = h.raw
    union all
    select h.i, h.rank, l.* from hits h join lines l on h.fld = 'memo' and l.memo = h.raw
  ),
  ledger as (
    select distinct on (m.i, m.qbo_transaction_id, m.qbo_account_id, m.transaction_date, m.natural_amount, m.counterparty)
      m.i, 'ledger'::text src, case m.rank when 1 then 'exact' when 2 then 'memo' else 'similar' end mt, m.rank,
      m.qbo_account_id acct, m.account_name nm, m.transaction_date dt, m.natural_amount amt, m.id::text tie
    from matched m join pairs p on p.i = m.i
    where m.transaction_date between p.lo and p.d
      and (p.dir is distinct from 'outflow' or m.account_type not in ('Income', 'Other Income'))
    order by m.i, m.qbo_transaction_id, m.qbo_account_id, m.transaction_date, m.natural_amount, m.counterparty, m.rank, m.id
  ),
  ranked as (
    select u.*, row_number() over (partition by u.i, u.src order by u.rank, u.dt desc, u.tie) rn,
      count(*) over (partition by u.i, u.src) total
    from (select * from silo union all select * from ledger) u
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('i', i, 'src', src, 'match', mt, 'account_id', acct,
        'account_name', nm, 'date', dt, 'amount', amt) order by i, src, rn) from ranked where rn <= v_per), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('i', i, 'src', src, 'total', total) order by i, src)
        from (select distinct i, src, total from ranked) x), '[]'::jsonb),
    'per_key', v_per)
  into v_out;
  return v_out;
end $$;

revoke all on function public.card_coding_rule_match(public.card_transactions, public.card_sources) from public, anon;
grant execute on function public.card_coding_rule_match(public.card_transactions, public.card_sources) to authenticated, service_role;
revoke all on function public.card_coding_rule_answered(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.card_coding_rule_answered(uuid, uuid[]) to service_role;
revoke all on function public.card_coding_history_evidence(uuid, uuid, jsonb, integer, uuid[]) from public, anon, authenticated;
grant execute on function public.card_coding_history_evidence(uuid, uuid, jsonb, integer, uuid[]) to service_role;
revoke all on function public.card_coding_needs_preparation(public.card_transactions, public.card_import_batches, public.card_sources) from public, anon;
grant execute on function public.card_coding_needs_preparation(public.card_transactions, public.card_import_batches, public.card_sources) to authenticated, service_role;

select public.refresh_chat_schema_catalog();
