-- Replace backfill RPC with a longer statement timeout and smaller default batch.
-- sales_by_day has no index on company_entity_id so large batches time out.
-- SET LOCAL statement_timeout overrides PostgREST's connection-level timeout
-- for the duration of this function's transaction.

CREATE OR REPLACE FUNCTION public.backfill_company_entity_batch(
  p_table     text,
  p_entity_id uuid,
  p_batch_size int DEFAULT 5000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count int;
BEGIN
  -- Override the PostgREST statement timeout for this transaction
  SET LOCAL statement_timeout = '120s';

  IF p_table = 'sales_by_day' THEN
    WITH batch AS (
      SELECT id FROM public.sales_by_day
      WHERE company_entity_id IS NULL
      LIMIT p_batch_size
    )
    UPDATE public.sales_by_day
    SET company_entity_id = p_entity_id
    FROM batch
    WHERE sales_by_day.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;

  ELSIF p_table = 'inventory_on_hand' THEN
    WITH batch AS (
      SELECT id FROM public.inventory_on_hand
      WHERE company_entity_id IS NULL
      LIMIT p_batch_size
    )
    UPDATE public.inventory_on_hand
    SET company_entity_id = p_entity_id
    FROM batch
    WHERE inventory_on_hand.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;

  ELSE
    RAISE EXCEPTION 'Unknown table: %', p_table;
  END IF;

  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_company_entity_batch(text, uuid, int)
  TO service_role;
