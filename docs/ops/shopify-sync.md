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

**Inventory retail value:** `total_available_inventory_value` = `variant.price × available` (Shopify variant list price; matches BR “retail value” column intent).

**Company stamping:** every row gets `company_entity_id` from the connection (bulk tables have no insert trigger).

### Sales row math (Shopify POS parity)

Per order line, `sales_by_day` rows are built as:

| Field | Source |
|-------|--------|
| Gross sales | `price × quantity` |
| Discounts | line `discount_allocations` |
| Refunds | `order.refunds[].refund_line_items` matched by `line_item_id` |
| Net sales | gross − discounts − refunds |
| Shipping | `total_shipping_price_set` (minus shipping refunds), allocated per line |
| Duties / additional fees | order-level amounts, allocated per line |
| Taxes | line `tax_lines` minus refunded tax |
| **Total sales** | net + shipping + duties + fees + taxes |

Exclusions (Shopify sales-report parity): **cancelled orders**, **test orders**, and
**gift card line items** (gift card sales are liabilities, not sales) are skipped and
reported in the job result as `rows_skipped`.

**Row identity:** `row_hash` = sha256 of
`company | location_tag | day | sku | product_name | shop_domain | source` — shop_domain
is included so two shops mapped to the same SILO location can't overwrite each other's rows.

**Refunds (Shopify report / BR parity):** refunds are NOT netted into the original
order's day. Each refund emits negative rows dated by its `processed_at` date —
per-SKU return rows (negative qty, `total_refunds` = merchandise subtotal, negative
taxes), plus `[Shipping]` and `[Refund discrepancy]` rows for order-level pieces.
Refund rows are hashed per order + refund date + sku, carry `total_orders = 0`, and
are **additive-only** (Shopify refunds are immutable): day rebuilds delete and
regenerate only sales rows (`total_orders > 0`) and leave refund rows in place.

**Incremental sync** fetches orders by `updated_at_min` (not `created_at_min`) so refunds,
fulfillments, edits, and cancellations on older orders are picked up. Every affected
order-date's sales rows are rebuilt in full (delete + reinsert scoped to that shop +
source + dates), so day aggregates never drift; new refunds upsert as dated rows.

**History imports** over-fetch one UTC day per window and keep only fully-covered
shop-local dates, so chunk-boundary days aren't overwritten with partial aggregates.

After changing this logic, **re-run a sales history import** from Integrations so existing rows are upserted with corrected amounts.

---

## One-time setup (per company)

### 1. Connect Shopify (UI)

1. Log in → pick company (e.g. test-co)
2. Open **Settings → Integrations** (`/v2/integrations.html`)
3. Add shop domain + custom app access token → **Test & Save**
4. Confirm **all sync scopes granted** (green + no scope warning)

### 2. Enable sync

Either toggle **API sync enabled** on the Integrations page, or run SQL:

```sql
update public.shopify_connections
set sync_enabled = true
where id = '<connection-uuid>'
  and company_entity_id = '<company-entity-uuid>';
```

Optional: set `history_days_default` (default 90) before first history import.

### 3. Map Shopify locations (recommended)

**From Integrations UI:** open **Map locations** on your connection. For each Shopify location, link an existing SILO location or create a new one (name, code, store type, domain). SILO stores the Shopify location id on `locations.shopify_location_id`.

After mapping, **re-run a sales history import** so existing `sales_by_day` rows pick up the correct `location_tag` (mapped locations use `location_code`; unmapped fall back to `{shop}_{name}`).

**Manual SQL** (optional):

```sql
update public.locations
set shopify_location_id = '123456789'  -- Shopify location id (numeric or gid://shopify/Location/…)
where company_entity_id = '<company-entity-uuid>'
  and location_code = 'ONL';
```

Unmapped Shopify locations fall back to `{shop}_{location_name}` tags.

**Sales location linking:** when Shopify omits `location_id` on orders (common for online stores), sales rows use your SILO mapping when the company has exactly one linked location. Product/SKU/amount metadata is unchanged. A fresh **history import** purges prior `shopify_api` sales rows for **that shop only** (`shop_domain`) so location tags refresh without wiping other stores.

**Multi-store companies:** Baseballism has one `company_entity_id` but many Shopify connections. History imports only purge/replace rows for the connection being imported — never the whole company.

---

## Run sync

### From Integrations UI (recommended for customers)

1. Settings → **Integrations** (admin, correct company selected)
2. Enable **API sync enabled** for nightly incremental job (optional)
3. **Sales history:** click **90d**, **365d**, or **730d** — imports run in **7-day windows** (edge CPU limit); keep the tab open until the progress bar completes. If you see **546**, click **Resume** — progress is saved.
4. **Inventory:** click **Sync now**
5. If a long import is interrupted, click **Resume** (or **Cancel** to abort)

Backfill progress is stored on the connection (`meta.history_backfill`) and in `sync_jobs`.

**Deploy:** `supabase functions deploy shopify-sync-run` after merge.

### Manual (GitHub Actions — ops / scheduled only)

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

| Mode | Sales | Inventory | Trigger |
|------|-------|-----------|---------|
| UI **90d / 365d / 730d** | Windowed history import | — | Integrations → edge function |
| UI **Sync now** | — | Snapshot | Integrations → edge function |
| `incremental` (GHA) | Orders since last sync | Snapshot | Nightly 11:00 UTC |
| `history` / `full` (GHA) | Windowed history | full only | Ops manual dispatch |

Window size: **30 days** per chunk (tunable via `chunk_days` in edge request). 730d ≈ 25 windows; UI loops automatically.

---

## Safety

- **Baseballism:** leave `sync_enabled = false` on all connections until Phase 5 cutover
- **Scopes:** connections with non-empty `scopes_missing` are skipped
- **Schedule:** workflow runs 11:00 UTC (after Sheets sync at 10:30 UTC)
- **No dual-write:** only connections with `sync_enabled=true` are processed

---

## Next (Phase 3+)

- Show `sync_jobs` history inline on Integrations
- `entities.meta.integrations.shopify` company-level flag
- Baseballism online-only cutover from Sheets
