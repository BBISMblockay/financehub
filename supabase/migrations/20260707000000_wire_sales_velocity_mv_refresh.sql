-- sales_velocity_by_sku_location_mv backs the Top Sellers report but had no
-- refresh call site anywhere in the codebase (confirmed by grep across all
-- sync scripts and workflows) — it was last refreshed at MV-creation time
-- and had drifted ~5-6 days stale. Fix:
--   1. Same statement_timeout guard already applied to
--      refresh_sales_verification_store_comp_summary (measured runtime ~7s
--      today; will grow as sales_by_day grows, same class of silent-failure
--      risk under PostgREST's role-level timeout).
--   2. Wired the RPC call into both nightly sync scripts
--      (scripts/shopify-sync.mjs, scripts/sync-silo-inventory-sales.mjs) —
--      see those files for the call sites, no DB-side change needed for that.

create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
set statement_timeout = '120s'
as $function$
begin
  refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
end;
$function$;
