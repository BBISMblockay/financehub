-- Rule usage tracking, and refusing to auto-code a row whose card disagrees
-- with its merchant.
--
-- The second is the point. Precedence said a merchant rule outranks a card-name
-- rule, because knowing the vendor is more specific than knowing which card
-- paid. That is right for an ordinary expense and DANGEROUS for an
-- intercompany one: a Comcast charge on Jackie's card is not a Baseballism
-- utility bill, it is money Jackie's owes. The merchant rule would have coded
-- it to Utilities Expense silently and correctly-looking, and the only signal
-- that anything was wrong -- the card it was paid on -- is the signal
-- precedence throws away.
--
-- So where a merchant rule and a card-name rule disagree, NEITHER applies. The
-- row stays in the queue carrying what the disagreement was, because that
-- disagreement is exactly the thing a person needs to see.

alter table public.card_transactions
  add column if not exists coding_conflict text;

comment on column public.card_transactions.coding_conflict is
  'Why this row was left uncoded despite matching a rule: a merchant rule and a card-name rule disagreed. Cleared when a person codes it.';

-- Counting a rule as USED when a row it coded is SAVED, not when it is
-- previewed: a suggestion the person reverted before saving did not do any
-- work, and counting it would inflate exactly the number used to judge whether
-- a rule is pulling its weight.
create or replace function public.apply_card_coding(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'apply_card_coding expects a json array of rows';
  end if;

  update public.card_transactions t
     set qbo_account_id    = r.qbo_account_id,
         qbo_account_name  = r.qbo_account_name,
         qbo_location_id   = r.qbo_location_id,
         qbo_location_name = r.qbo_location_name,
         entity_qbo_id     = r.entity_qbo_id,
         entity_name       = r.entity_name,
         entity_type       = r.entity_type,
         vendor_name       = r.vendor_name,
         memo              = r.memo,
         coding_source     = r.coding_source,
         confidence        = r.confidence,
         ai_reasoning      = r.ai_reasoning,
         rule_id           = r.rule_id,
         status            = coalesce(r.status, t.status),
         exclude_reason    = r.exclude_reason,
         coding_conflict   = r.coding_conflict,
         updated_at        = now(),
         updated_by        = auth.uid()
    from jsonb_to_recordset(p_rows) as r(
      id                uuid,
      qbo_account_id    text,
      qbo_account_name  text,
      qbo_location_id   text,
      qbo_location_name text,
      entity_qbo_id     text,
      entity_name       text,
      entity_type       text,
      vendor_name       text,
      memo              text,
      coding_source     text,
      confidence        numeric,
      ai_reasoning      text,
      rule_id           uuid,
      status            text,
      exclude_reason    text,
      coding_conflict   text
    )
   where t.id = r.id;

  get diagnostics v_count = row_count;

  -- Bump the rules that actually did the coding in this save.
  update public.card_coding_rules cr
     set hit_count = cr.hit_count + hits.n,
         last_used_at = now()
    from (
      select (value ->> 'rule_id')::uuid rid, count(*) n
        from jsonb_array_elements(p_rows)
       where value ->> 'rule_id' is not null
         and value ->> 'coding_source' = 'rule'
       group by 1
    ) hits
   where cr.id = hits.rid;

  return v_count;
end;
$$;
