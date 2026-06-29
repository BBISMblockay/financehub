-- RPC for refreshing the inventory mat view concurrently.
-- Called by the nightly Shopify sync GitHub Action after each sync run.
-- SECURITY DEFINER so the service role call can refresh without superuser.
-- Revoked from public/authenticated — service role only.

CREATE OR REPLACE FUNCTION public.refresh_inventory_current_mv()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.inventory_on_hand_current_mv;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_inventory_current_mv() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_inventory_current_mv() FROM authenticated;
