-- Fix inventory_on_hand SELECT policy — was "true" (no company filter)
DROP POLICY IF EXISTS "Allow authenticated read inventory_on_hand" ON public.inventory_on_hand;

CREATE POLICY "inventory_on_hand_select_company"
  ON public.inventory_on_hand
  FOR SELECT
  TO authenticated
  USING (company_entity_id = active_company_id());

-- Recreate view with security_invoker so RLS propagates through it
CREATE OR REPLACE VIEW public.inventory_on_hand_current_v
  WITH (security_invoker = true)
AS
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
