-- 20260910130000_seo_approvers_stamp_and_granted_by.sql
-- ---------------------------------------------------------------------------
-- Two backstops for seo_approvers, found while wiring its grant button into
-- /v2/backend.html (2026-09-10) and checked against the LIVE schema rather
-- than the migration that created it:
--
--   1. No stamp_company_entity_id trigger. `company_entity_id` is NOT NULL
--      with no default, so a bare insert from a client failed outright and
--      the "DB trigger is the backstop" promise in CLAUDE.md was not true for
--      this table. It was not true for ANY table created on 2026-09-09
--      either -- 12 tables in all (the six seo_* tables, page_inspections,
--      shopify_collections / _products / _sync_runs, shopify_product_skus,
--      shopify_shop_domains), none of whose migrations called
--      attach_stamp_company_entity_id_triggers(). The sync tables are only
--      ever written by service-role scripts that pass the company explicitly,
--      so nothing was mis-stamped; but a backstop that exists on 60 tables
--      and silently not on the 12 newest is the kind of gap that bites the
--      first time someone copies a browser insert from an older page.
--      verify_v2_schema.sql check 6 DOES flag this (stamped tables must be
--      within 2 of tables carrying the column), so either it was not run
--      after those migrations or its MISSING row was not acted on.
--
--   2. `granted_by` had no default. silo_chat_managers, the pattern this
--      table copies, defaults it to auth.uid() so a grant records who made it
--      even when the caller forgets to pass it.
--
-- Both idempotent. The attach function re-creates the trigger on every table
-- carrying the column (except the two large sync tables it excludes by name),
-- and the trigger only fills company_entity_id when it is NULL -- an
-- explicitly passed value is never overwritten, so service-role syncs writing
-- another company's rows are unaffected.
-- ---------------------------------------------------------------------------

select public.attach_stamp_company_entity_id_triggers();

alter table public.seo_approvers
  alter column granted_by set default auth.uid();

comment on column public.seo_approvers.granted_by is
  'Who made the grant. Defaults to auth.uid() (20260910130000) so a browser '
  'insert that omits it still records the granter; /v2/backend.html passes it '
  'explicitly as well.';
