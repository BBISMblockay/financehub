# Fixes log

Short list of **resolved** issues. Active problems stay in [bugs.md](bugs.md).

| When | Area | What was fixed |
|------|------|----------------|
| 2026-06 | Multi-tenant | **Phase 1 complete**: company context layer, RLS active-company isolation, view security_invoker — see multi-tenant section in roadmap.md |
| 2026-06 | Multi-tenant | `profiles.active_company_id` column + `active_company_id()` / `set_active_company()` RPC functions — DB-level per-session company isolation |
| 2026-06 | Multi-tenant | `security_invoker = true` on all 30+ views in public schema so RLS applies through views, not just on base tables |
| 2026-06 | Multi-tenant | `company_entity_id` column backfilled on 40+ operational tables (excluding `inventory_on_hand` and `sales_by_day` — deferred) |
| 2026-06 | Multi-tenant | Company picker page (`/v2/company-picker.html`) for users with multiple company memberships |
| 2026-06 | Multi-tenant | `_co` + `company_entity_id` JS query filters added to profile.html work queue, tasks.html, projections.html, launch-calendar.html, po-builder.html, purchase_request.html, request_manager.html, po-costing.html, product-manager.html, product-samples.html, factories.html |
| 2026-06 | Multi-tenant | Insert hardening: `stamp_company_entity_id` trigger on all company-scoped tables (excl. inventory/sales bulk) + `withCompany()` / `withCompanyRows()` in `pages/config.js` |
| 2026-06 | Shopify | Phase 2a: `access_scopes.json` on connection test; `scopes_granted` / `scopes_missing` on `shopify_connections`; UI scope warnings |
| 2026-06 | Shopify | Hotfix: `access_scopes.json` must use `/admin/oauth/` (unversioned); versioned path returned 404 and false missing-scope warnings |
| 2026-06 | Shopify | Revert PR #166 scope regression: restore client-side retest persist, clear stale `meta.scopes_fetch_error`, keep `/admin/oauth/access_scopes.json` |
| 2026-06 | Shopify | Phase 2b: `shopify-sync.mjs` orchestrator, `shopify-sync.yml` workflow, `source=shopify_api` writes with `company_entity_id` |
| 2026-06 | Shopify | UI-initiated windowed sales backfill (90/365/730d) + inventory sync via `shopify-sync-run` edge function; `sync_enabled` toggle on Integrations |
| 2026-06 | Sales verification | `sales_by_day` + `sales_verification_store_comp_summary` scoped by `company_entity_id`; refresh RPC per company; Sheets sync stamps Baseballism id on insert |
| 2026-06 | Auth | Login resolves company via `entity_memberships`, auto-sets single company or routes to picker for multi-company users |
|------|------|----------------|
| 2026-06 | Supabase schema | Verified all tables, RLS, and policies healthy across PO builder, costing, profiles, and launch workbench |
| 2026-06 | Supabase schema | Created missing `po_builder_can_write()` function (was in migration but hadn't applied) |
| 2026-06 | RLS | Confirmed all 13 tables have RLS enabled; PO builder had pre-existing dashboard policies — all access working |
| 2026-06 | Roles | All 7 profiles are `admin` — full write access to PO builder and costing confirmed |
| 2026-06 | Launch comments | `author_name`, `author_email`, `user_id` columns confirmed present on `launch_comments` |
| 2026-05 | Planning Scenarios v2 | Restored v1 revenue/mix/ASP logic; filter scope parity — see [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md) |
| 2026-05 | Planning Scenarios v2 | Rebuilt page from v1 layout + projection seed + Beacon theme |
| 2026-05 | PO module | SQL migrations for builder, costing, profile RLS — [supabase/README.md](../../supabase/README.md) |
