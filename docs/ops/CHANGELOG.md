# Fixes log

Short list of **resolved** issues. Active problems stay in [bugs.md](bugs.md).

| When | Area | What was fixed |
|------|------|----------------|
| 2026-07 | Shopify sync | Shipping tax captured: `taxes` only summed `line_items[].tax_lines`, but tax charged on shipping lives on `shipping_lines[].tax_lines` — Shopify's Taxes column includes it, so SILO ran ~5%/month low (~$30.6k over Jan–Jun online). Now allocated per line alongside the shipping charge; requires a history re-import to restate. Part of the PBI-variance reconciliation — returns valuation (~$94k) and promo-day free-gift lines (~$84k) still under investigation, see bugs.md |
| 2026-07 | Sales verification | Comp summary now anchors to the last **complete** business day (Pacific) instead of `max(day_date)` — the incremental Shopify sync always lands a few hours of the in-progress day, so the Day comp was showing a partial CY day against a full PY day (e.g. $3.4k vs $106k on 7/7) and the partial day leaked into MTD/YTD while PY windows covered full days; KPI labels on the BI overview/dashboard now name the anchored day instead of saying "Today" |
| 2026-07 | Sales verification | `refresh_sales_verification_store_comp_summary()` gained tax-inclusive Total Sales columns (matches the legacy PBI dashboard's Day/MTD/YTD figures, which were never net-of-tax) and an explicit `statement_timeout = 120s` — the full recompute over `sales_by_day_verification_v` (1.1M+ rows) had no override and was silently timing out under the nightly sync's `service_role` PostgREST call (same class of bug as the `purge_better_reports_overlap` fix below), requiring manual refreshes to see current data |
| 2026-07 | Shopify sync | Refund date parity with Shopify POS reports / Better Reports: refunds now book as negative rows on the refund's `processed_at` date (per-SKU + `[Shipping]` + `[Refund discrepancy]` rows, `total_orders = 0`, additive-only) instead of restating the original order day — requires one full history re-import per store |
| 2026-07 | Shopify sync | BR-vs-API variance: incremental sync fetches by `updated_at` and rebuilds affected days (captures refunds/edits/cancellations on older orders); gift cards, cancelled and test orders excluded (Shopify report parity); history chunk boundary dates no longer overwritten with partial aggregates; `row_hash` includes `shop_domain` |
| 2026-07 | Shopify sync | `purge_better_reports_overlap` rewritten as indexed semi-join (old self-join timed out on ~1M rows, leaving BR + shopify_api rows double-counted for recent days); duplicate active connections (chicago, dsg) deactivated; `default_location_code` set for main + wholesale shops so unfulfilled orders aren't dropped |
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
| 2026-06 | Sales verification | Server-side `sales_verification_filtered_summary` RPC replaces client row-chunk scans (fixes timeouts on large histories) |
| 2026-06 | Shopify sync | Sales row math: refunds from `order.refunds`, net/total sales include shipping, duties, additional fees, and taxes (Shopify POS parity) |
| 2026-06 | Shopify / Integrations | Location mapper UI: link Shopify locations to SILO `locations` (create or map existing); `list_shopify_locations` edge action |
| 2026-06 | Integrations | Fix location create duplicate PK: `next_location_id()` RPC (client max(id) was RLS-scoped per company) |
| 2026-06 | Shopify sync | Sales rows link to SILO mapped locations when Shopify omits order location_id; fresh history import purges stale shopify_api sales |
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
