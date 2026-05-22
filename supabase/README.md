# Supabase migrations (SILO)

## PO costing module

Apply **`migrations/20260521120000_po_costing_module.sql`** in the Supabase SQL Editor (Dashboard → SQL → New query → paste → Run).

Creates:

| Object | Purpose |
|--------|---------|
| `po_costing` | One row per PO: FOB/factory invoice, ship dates, freight pools, totals |
| `po_costing_lines` | Per `po_lines` row: FOB override, allocations, landed unit |
| `v_po_costing_summary` | Reporting join for PO list / status |
| `v_po_sku_prior_cost` | Latest cost per SKU from prior POs |
| RLS | Authenticated read; write for finance/purchasing roles via `po_costing_can_write()` |

### Workflow in the app

1. **PO builder** — create `po_headers` + `po_lines`
2. **PO costing → FOB** — prior SKU and/or factory invoice; save (phase `fob`)
3. **Mark shipped** — sets `shipped_at`, phase `freight`
4. **Freight** — enter freight invoice total, duty %, misc; split to lines; save landed costs

The UI falls back to `internal_notes` `[SILO_COSTING]` JSON if tables are missing (pre-migration).

### Role access

Adjust `po_costing_can_write()` in the migration if your `profiles.role` values differ.
