-- sales_sku_location_rollup_mv is a confirmed-orphaned materialized view
-- (no reader view, no repo references outside migrations/docs/legacy —
-- superseded by sales_velocity_by_sku_location_mv). 20260708050000 already
-- revoked SELECT from anon/authenticated/public, but a 2026-08-20 grant
-- audit (decoding pg_class.relacl, since information_schema does not report
-- matview grants) found it still carries residual non-SELECT privileges
-- (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) granted to
-- anon and authenticated — almost certainly Supabase's default-privileges
-- grant from when the object was created, never fully revoked. Postgres
-- itself blocks DML on materialized views regardless of grants, but TRUNCATE
-- is not blocked, so this closes that residual exposure and brings the
-- object's ACL in line with the other three matviews (which already have
-- zero anon/authenticated grants of any kind). No data or query behavior
-- changes — this view has no live readers.

revoke all on public.sales_sku_location_rollup_mv from anon, authenticated, public;
