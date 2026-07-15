-- refresh_inventory_current_mv() originally shipped with
-- `set statement_timeout = '120s'` (20260625200000), but a later duplicate
-- migration (20260630200000_add_refresh_inventory_current_mv_rpc.sql)
-- re-created the function without the timeout, search_path pin, or the
-- REVOKEs, silently regressing it back to the caller's default timeout.
-- Same bug class as refresh_sales_verification_store_comp_summary() and
-- refresh_sales_velocity_mv() (fixed earlier): the nightly Shopify sync
-- calls this as service_role after every run and log-and-continues on
-- failure, so a timeout here fails silently instead of crashing the job.
-- Confirmed live in the 2026-07-15 sync log: "canceling statement due to
-- statement timeout".

create or replace function public.refresh_inventory_current_mv()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
begin
  refresh materialized view concurrently public.inventory_on_hand_current_mv;
end;
$$;

revoke execute on function public.refresh_inventory_current_mv() from public;
revoke execute on function public.refresh_inventory_current_mv() from authenticated;
