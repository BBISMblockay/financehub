-- ============================================================
-- Shopify ingestion — Phase 1 (schema + flags only)
--
-- Adds per-company Shopify connection config, location mappings,
-- and sync job tracking. Does NOT write to sales_by_day,
-- inventory_on_hand, or change existing Sheets sync.
--
-- Tokens: credential_ref names a vault / GitHub secret — never
-- store Admin API tokens in plain columns.
-- ============================================================

-- ── 1. shopify_connections (multi-shop per company) ─────────
CREATE TABLE IF NOT EXISTS public.shopify_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_entity_id     uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  shop_domain           text NOT NULL,
  display_name          text,
  location_tag_prefix   text,
  credential_ref        text,
  api_version           text NOT NULL DEFAULT '2025-01',
  sync_enabled          boolean NOT NULL DEFAULT false,
  history_days_default  integer NOT NULL DEFAULT 90
    CHECK (history_days_default BETWEEN 1 AND 365),
  meta                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT shopify_connections_shop_domain_nonempty
    CHECK (btrim(shop_domain) <> ''),
  CONSTRAINT shopify_connections_company_shop_uidx
    UNIQUE (company_entity_id, shop_domain)
);

CREATE INDEX IF NOT EXISTS shopify_connections_company_idx
  ON public.shopify_connections (company_entity_id);

CREATE INDEX IF NOT EXISTS shopify_connections_sync_enabled_idx
  ON public.shopify_connections (company_entity_id)
  WHERE sync_enabled;

-- ── 2. shopify_location_mappings ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.shopify_location_mappings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         uuid NOT NULL REFERENCES public.shopify_connections(id) ON DELETE CASCADE,
  company_entity_id     uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  shopify_location_id   text NOT NULL,
  shopify_location_name text,
  silo_location_code    text,
  location_id           bigint REFERENCES public.locations(id) ON DELETE SET NULL,
  is_sales_only         boolean NOT NULL DEFAULT false,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_location_mappings_conn_loc_uidx
    UNIQUE (connection_id, shopify_location_id)
);

CREATE INDEX IF NOT EXISTS shopify_location_mappings_connection_idx
  ON public.shopify_location_mappings (connection_id);

CREATE INDEX IF NOT EXISTS shopify_location_mappings_company_idx
  ON public.shopify_location_mappings (company_entity_id);

-- ── 3. sync_jobs (history import + incremental runs) ───────
CREATE TABLE IF NOT EXISTS public.sync_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  connection_id     uuid REFERENCES public.shopify_connections(id) ON DELETE SET NULL,
  job_type          text NOT NULL
    CHECK (job_type IN (
      'test_connection',
      'history_import',
      'incremental_sales',
      'inventory_snapshot',
      'catalog_sync'
    )),
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message     text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS sync_jobs_company_status_idx
  ON public.sync_jobs (company_entity_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS sync_jobs_connection_idx
  ON public.sync_jobs (connection_id, created_at DESC);

-- ── 4. updated_at triggers ───────────────────────────────────
DROP TRIGGER IF EXISTS shopify_connections_updated_at ON public.shopify_connections;
CREATE TRIGGER shopify_connections_updated_at
  BEFORE UPDATE ON public.shopify_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS shopify_location_mappings_updated_at ON public.shopify_location_mappings;
CREATE TRIGGER shopify_location_mappings_updated_at
  BEFORE UPDATE ON public.shopify_location_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 5. Helpers ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.active_company_shopify_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT (e.meta #>> '{integrations,shopify,enabled}')::boolean
      FROM public.entities e
      WHERE e.id = public.active_company_id()
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.active_company_shopify_sync_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT e.meta #>> '{integrations,shopify,sync_mode}'
      FROM public.entities e
      WHERE e.id = public.active_company_id()
    ),
    'none'
  );
$$;

-- ── 6. Seed integration flags (does not enable API sync) ─────
UPDATE public.entities
SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
  'integrations', jsonb_build_object(
    'shopify', jsonb_build_object('enabled', false, 'sync_mode', 'sheets')
  )
)
WHERE entity_key = 'baseballism'
  AND (meta #>> '{integrations,shopify,sync_mode}') IS NULL;

UPDATE public.entities
SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
  'integrations', jsonb_build_object(
    'shopify', jsonb_build_object('enabled', false, 'sync_mode', 'api')
  )
)
WHERE entity_key = 'test-co'
  AND (meta #>> '{integrations,shopify,sync_mode}') IS NULL;

-- ── 7. RLS ───────────────────────────────────────────────────
ALTER TABLE public.shopify_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_location_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shopify_connections_active_select" ON public.shopify_connections;
CREATE POLICY "shopify_connections_active_select" ON public.shopify_connections
  FOR SELECT USING (company_entity_id = active_company_id());

DROP POLICY IF EXISTS "shopify_connections_active_write" ON public.shopify_connections;
CREATE POLICY "shopify_connections_active_write" ON public.shopify_connections
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

DROP POLICY IF EXISTS "shopify_location_mappings_active_select" ON public.shopify_location_mappings;
CREATE POLICY "shopify_location_mappings_active_select" ON public.shopify_location_mappings
  FOR SELECT USING (company_entity_id = active_company_id());

DROP POLICY IF EXISTS "shopify_location_mappings_active_write" ON public.shopify_location_mappings;
CREATE POLICY "shopify_location_mappings_active_write" ON public.shopify_location_mappings
  FOR ALL USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK       (company_entity_id = active_company_id() AND is_admin_user());

DROP POLICY IF EXISTS "sync_jobs_active_select" ON public.sync_jobs;
CREATE POLICY "sync_jobs_active_select" ON public.sync_jobs
  FOR SELECT USING (company_entity_id = active_company_id());

DROP POLICY IF EXISTS "sync_jobs_active_insert" ON public.sync_jobs;
CREATE POLICY "sync_jobs_active_insert" ON public.sync_jobs
  FOR INSERT WITH CHECK (company_entity_id = active_company_id() AND is_admin_user());

DROP POLICY IF EXISTS "sync_jobs_active_update" ON public.sync_jobs;
CREATE POLICY "sync_jobs_active_update" ON public.sync_jobs
  FOR UPDATE USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK          (company_entity_id = active_company_id() AND is_admin_user());
