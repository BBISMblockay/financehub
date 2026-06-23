-- ============================================================
-- Align shopify_connections + sync_jobs with PR #160 UI
--
-- Earlier partial apply (Phase 1 + CREATE IF NOT EXISTS) left
-- last_test_success instead of last_test_status, and sync_jobs
-- without result / success status. Safe to re-run.
-- ============================================================

-- shopify_connections (PR #160 columns)
ALTER TABLE public.shopify_connections
  ADD COLUMN IF NOT EXISTS access_token        text,
  ADD COLUMN IF NOT EXISTS last_test_status    text,
  ADD COLUMN IF NOT EXISTS last_test_error     text,
  ADD COLUMN IF NOT EXISTS shop_name           text,
  ADD COLUMN IF NOT EXISTS shop_currency       text,
  ADD COLUMN IF NOT EXISTS is_active           boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_by          uuid REFERENCES auth.users(id);

-- Backfill status from legacy boolean column when present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shopify_connections'
      AND column_name = 'last_test_success'
  ) THEN
    EXECUTE $sql$
      UPDATE public.shopify_connections
      SET last_test_status = CASE
        WHEN last_test_success IS TRUE  THEN 'ok'
        WHEN last_test_success IS FALSE THEN 'error'
        ELSE last_test_status
      END
      WHERE last_test_status IS NULL
        AND last_test_success IS NOT NULL
    $sql$;
  END IF;
END;
$$;

ALTER TABLE public.shopify_connections
  DROP CONSTRAINT IF EXISTS shopify_connections_last_test_status_check;

ALTER TABLE public.shopify_connections
  ADD CONSTRAINT shopify_connections_last_test_status_check
  CHECK (last_test_status IS NULL OR last_test_status IN ('ok', 'error'));

-- sync_jobs (PR #160 columns + status values)
ALTER TABLE public.sync_jobs
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS error  text;

ALTER TABLE public.sync_jobs
  DROP CONSTRAINT IF EXISTS sync_jobs_status_check;

ALTER TABLE public.sync_jobs
  ADD CONSTRAINT sync_jobs_status_check
  CHECK (status IN (
    'pending', 'running', 'success', 'error',
    'completed', 'failed', 'cancelled'
  ));

-- Ensure updated_at trigger sets updated_by (PR #160)
CREATE OR REPLACE FUNCTION public.set_shopify_connections_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.updated_by = auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shopify_connections_updated_at ON public.shopify_connections;
CREATE TRIGGER trg_shopify_connections_updated_at
  BEFORE UPDATE ON public.shopify_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_shopify_connections_updated_at();

-- Ask PostgREST to reload schema cache (Supabase API)
NOTIFY pgrst, 'reload schema';
