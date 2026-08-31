-- Saving card coding as a real UPDATE, not an upsert.
--
-- The page was saving with PostgREST's upsert, which sends
-- INSERT .. ON CONFLICT DO UPDATE. That makes every save propose a COMPLETE
-- row, so Postgres checks the proposed tuple against RLS and against every NOT
-- NULL constraint -- even though the row already exists and only a handful of
-- coding fields are changing.
--
-- That produced two failures in a row, from one cause:
--   "new row violates row-level security policy"  (company_entity_id was absent)
--   "null value in column amount violates not-null constraint"
--
-- Adding the missing column each time is chasing symptoms: card_transactions
-- has three NOT NULL columns with no default (company_entity_id, batch_id,
-- amount) and any future one would break saving again, at the point where a
-- bookkeeper has just coded 400 rows.
--
-- These rows always exist -- they were inserted at import -- so the correct
-- verb is UPDATE. One statement, one round trip, and only the named columns
-- are touched.
--
-- SECURITY INVOKER (the default, stated here because it is the point): RLS
-- still applies as the caller, so card_transactions_write governs this exactly
-- as it governs a direct write -- same company, same journal-entry gate, and
-- still refusing to touch a batch that has already posted.
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
      exclude_reason    text
    )
   where t.id = r.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.apply_card_coding(jsonb) from public;
grant execute on function public.apply_card_coding(jsonb) to authenticated;
