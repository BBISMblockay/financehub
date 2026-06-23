# Shopify API sync (Phase 2b)

DB-driven Shopify ingestion for **non-Baseballism** companies (or any entity with `sync_enabled=true` on a connection). Baseballism retail stays on the nightly Google Sheets sync unless you explicitly enable API sync on that connection.

## Architecture

| Piece | Role |
|-------|------|
| `shopify_connections` | Per-company shop + token; `sync_enabled` gate |
| `scripts/shopify-sync.mjs` | Orchestrator — orders → `sales_by_day`, inventory → `inventory_on_hand` |
| `sync_jobs` | Audit log per job (`incremental_sales`, `history_import`, `inventory_snapshot`) |
| `.github/workflows/shopify-sync.yml` | Scheduled + manual runs (separate from Sheets sync) |

**Source tag:** `shopify_api` (distinct from Sheets `better_reports` and legacy server `shopify`).

**Company stamping:** every row gets `company_entity_id` from the connection (bulk tables have no insert trigger).

---

## One-time setup (per company)

### 1. Connect Shopify (UI)

1. Log in → pick company (e.g. test-co)
2. Open **Settings → Integrations** (`/v2/integrations.html`)
3. Add shop domain + custom app access token → **Test & Save**
4. Confirm **all sync scopes granted** (green + no scope warning)

### 2. Enable sync for that connection (SQL)

`sync_enabled` defaults to `false` so Baseballism is never touched accidentally.

```sql
-- Replace with your connection id from shopify_connections
update public.shopify_connections
set sync_enabled = true
where id = '<connection-uuid>'
  and company_entity_id = '<company-entity-uuid>';
```

Optional: set `history_days_default` (default 90) before first history import.

### 3. Map Shopify locations (recommended)

Populate `locations.shopify_location_id` so API rows use your existing `location_tag` naming:

```sql
update public.locations
set shopify_location_id = '123456789'  -- Shopify location id (numeric or gid://shopify/Location/…)
where company_entity_id = '<company-entity-uuid>'
  and location_code = 'ONL';
```

Unmapped Shopify locations fall back to `{shop}_{location_name}` tags.

---

## Run sync

### Manual (GitHub Actions)

1. Repo → **Actions** → **Shopify API Sync** → **Run workflow**
2. Inputs:
   - `sync_mode`: `incremental` (default), `history` (90d backfill), or `full` (history + inventory)
   - `company_entity_id` / `connection_id` — optional scoping
3. Watch job logs; inspect `sync_jobs` in Supabase for per-connection results

### Local

```bash
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...

# Incremental (last ~2 days orders + inventory snapshot)
node scripts/shopify-sync.mjs

# 90-day history import for one company
SHOPIFY_SYNC_MODE=history \
SHOPIFY_ONLY_COMPANY_ID=<uuid> \
node scripts/shopify-sync.mjs

# Full first run: history + inventory
SHOPIFY_SYNC_MODE=full \
SHOPIFY_ONLY_CONNECTION_ID=<uuid> \
node scripts/shopify-sync.mjs
```

### npm script

```bash
npm run sync:shopify
```

---

## Verify

```sql
-- Recent jobs
select id, job_type, status, started_at, finished_at, result, error
from public.sync_jobs
order by started_at desc
limit 20;

-- Rows landed for a company
select count(*) from public.sales_by_day
where company_entity_id = '<uuid>' and source = 'shopify_api';

select count(*) from public.inventory_on_hand
where company_entity_id = '<uuid>' and source = 'shopify_api';
```

In the app: switch to the company → Inventory / Sales Verification should show data scoped to that entity only.

---

## Modes

| Mode | Sales | Inventory |
|------|-------|-----------|
| `incremental` | Orders since last sync (or `SHOPIFY_DAYS_BACK`, default 2) | Snapshot |
| `history` | `history_days_default` (default 90) lookback | — |
| `full` | 90d history import | Snapshot |

---

## Safety

- **Baseballism:** leave `sync_enabled = false` on all connections until Phase 5 cutover
- **Scopes:** connections with non-empty `scopes_missing` are skipped
- **Schedule:** workflow runs 11:00 UTC (after Sheets sync at 10:30 UTC)
- **No dual-write:** only connections with `sync_enabled=true` are processed

---

## Next (Phase 3+)

- Integrations UI: toggle `sync_enabled`, trigger history import, show `sync_jobs` progress
- `entities.meta.integrations.shopify` company-level flag
- Baseballism online-only cutover from Sheets
