-- Fix inventory_on_hand_current_v to scope latest snapshot per company
-- Previously used global max(snapshot_at), causing cross-company data bleed
CREATE OR REPLACE VIEW public.inventory_on_hand_current_v AS
WITH latest AS (
  SELECT company_entity_id, max(snapshot_at) AS snapshot_at
  FROM inventory_on_hand
  GROUP BY company_entity_id
)
SELECT ioh.*
FROM inventory_on_hand ioh
JOIN latest l
  ON ioh.company_entity_id = l.company_entity_id
 AND ioh.snapshot_at = l.snapshot_at;

-- Index to make the per-company latest CTE fast
CREATE INDEX IF NOT EXISTS inventory_on_hand_company_snapshot_idx
  ON public.inventory_on_hand (company_entity_id, snapshot_at DESC);
