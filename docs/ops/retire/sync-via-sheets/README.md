# Sync via Google Sheets (interim)

These tools **feel native** in SILO but data still flows **Sheets → GitHub Action → Supabase**. Target: **Shopify API / webhooks → Supabase** ([rebuild P0](../rebuild/README.md)).

| Tool | Route | Sync |
|------|-------|------|
| Inventory manager | `/v2/inventory.html` | `nightly-silo-sync.yml` → `sync-silo-inventory-sales.mjs` |
| BBISM wholesale AR | `/v2/baseballismwholesale.html` | `ar-sync.yml` |
| Wholesale orders | `/pages/wholesale.html` | Sheet CSV (no Supabase yet) |

## WPV receivables

WPV uses similar sheet/Wave patterns but is a **separate product** — not SILO nav. See [external/README.md](../external/README.md).

## Direction

Replace Better Reports → Sheets middle layer with direct Shopify ingestion. Sheets become optional export only.
