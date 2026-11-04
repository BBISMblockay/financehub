-- Take the default write grant off the two custom-conversion tables.
--
-- 20261104000500 granted select and relied on RLS for the rest, which is what
-- marketing_kpis_daily and meta_ad_performance_daily do. Measured on
-- production right after it was applied, that leaves `authenticated` holding
-- Postgres's default insert/update/delete on both new tables.
--
-- Nothing was exposed: RLS is on and each table has exactly ONE policy, for
-- select, scoped to active_company_id(), so a client write is refused for want
-- of a policy. But a grant that only RLS stands between is a weaker posture
-- than the one the newer tables use (integration_feed_health, 20261103220000,
-- revokes them outright), and the "Meta custom conversions" check in
-- verify_v2_schema.sql asks for the stricter one -- so production reports a
-- CRITICAL row until this runs.
--
-- Tightening only, and idempotent: revoking a privilege nobody uses changes no
-- row and no behaviour. Only the service-role sync writes these tables, and it
-- bypasses both grants and RLS.

revoke insert, update, delete on public.meta_custom_conversion_daily from authenticated, anon;
revoke insert, update, delete on public.meta_custom_conversions from authenticated, anon;

-- select stays exactly as 20261104000500 left it: authenticated reads through
-- RLS, anon reads nothing.
grant select on public.meta_custom_conversion_daily to authenticated;
grant select on public.meta_custom_conversions to authenticated;
