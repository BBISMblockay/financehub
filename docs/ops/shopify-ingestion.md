# Shopify ingestion (multi-company)

Additive pipeline for per-company Shopify API sync. **Does not replace** the Baseballism Google Sheets nightly sync until an explicit per-company cutover.

## Phase 1 (this PR) — schema + flags only

**Ships:**
- `shopify_connections` — N shops per company (`sync_enabled` default `false`)
- `shopify_location_mappings` — Shopify location id → SILO `location_code`
- `sync_jobs` — history import / incremental run tracking
- `entities.meta.integrations.shopify` — company feature flag
- Helpers: `active_company_shopify_enabled()`, `active_company_shopify_sync_mode()`

**Does not ship:**
- Sync scripts, GitHub Actions, settings UI
- Writes to `sales_by_day`, `inventory_on_hand`, `products_master`
- Changes to `sync-silo-inventory-sales.mjs` or `config/silo-sources.mjs`

## Company integration flags

| Company | `enabled` | `sync_mode` | Meaning |
|---------|-----------|-------------|---------|
| baseballism | `false` | `sheets` | Keep existing Sheets pipeline (production) |
| test-co / new cos | `false` until configured | `api` | API path when Phase 2+ enables |

Orchestrator (future) only processes companies where `meta.integrations.shopify.enabled = true`.

## Credentials

`shopify_connections.credential_ref` names a secret in GitHub Actions / Supabase Vault — **never** store Admin API tokens in Postgres or `entities.meta`.

Example: `SHOPIFY_TOKEN_test_co_main` → resolved at runtime by sync worker (service role).

## Multi-shop per company

One row in `shopify_connections` per Shopify shop. Use `location_tag_prefix` when two shops share location names (e.g. `outlet:scottsdale` vs `main:scottsdale`).

## Roadmap

| Phase | Scope |
|-------|--------|
| **1** | Schema + flags (this PR) |
| **2** | `shopify-sync.mjs` orchestrator + separate GitHub Action |
| **3** | Company settings UI (connect, map locations, import 90d) |
| **4** | View parity + RLS on analytics tables |
| **5** | Baseballism location-by-location cutover from Sheets |
