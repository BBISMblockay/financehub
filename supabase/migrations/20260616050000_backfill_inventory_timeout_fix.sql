-- Speed up inventory_on_hand backfill batches + avoid statement timeout (57014).
-- Partial index targets only rows still needing company_entity_id.
-- RPC sets a longer local statement_timeout per batch.

CREATE INDEX IF NOT EXISTS inventory_on_hand_null_company_entity_idx
  ON public.inventory_on_hand (id)
  WHERE company_entity_id IS NULL;

CREATE OR REPLACE FUNCTION public.backfill_company_entity_batch(
  p_table      text,
  p_entity_id  uuid,
  p_batch_size int DEFAULT 10000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count int;
BEGIN
  -- Supabase default is 2min; inventory batches need more headroom.
  PERFORM set_config('statement_timeout', '600000', true); -- 10 minutes (ms)

  IF p_table = 'sales_by_day' THEN
    WITH batch AS (
      SELECT id
      FROM public.sales_by_day
      WHERE company_entity_id IS NULL
      LIMIT p_batch_size
    )
    UPDATE public.sales_by_day AS t
    SET company_entity_id = p_entity_id
    FROM batch
    WHERE t.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;

  ELSIF p_table = 'inventory_on_hand' THEN
    WITH batch AS (
      SELECT id
      FROM public.inventory_on_hand
      WHERE company_entity_id IS NULL
      LIMIT p_batch_size
    )
    UPDATE public.inventory_on_hand AS t
    SET company_entity_id = p_entity_id
    FROM batch
    WHERE t.id = batch.id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;

  ELSE
    RAISE EXCEPTION 'Unknown table: %', p_table;
  END IF;

  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_company_entity_batch(text, uuid, int)
  TO service_role;
