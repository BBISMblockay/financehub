-- ============================================================
-- Shopify Phase 2a: store granted API scopes on connection test
-- ============================================================

ALTER TABLE public.shopify_connections
  ADD COLUMN IF NOT EXISTS scopes_granted   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scopes_missing   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scopes_checked_at timestamptz;

COMMENT ON COLUMN public.shopify_connections.scopes_granted IS
  'Shopify Admin API scope handles from access_scopes.json at last test';
COMMENT ON COLUMN public.shopify_connections.scopes_missing IS
  'Subset of REQUIRED_FOR_SYNC scopes not granted — blocks Phase 2 sync until empty';

NOTIFY pgrst, 'reload schema';
