# Supabase migrations (SILO)

Run these in the Supabase SQL Editor in order (Dashboard → SQL → New query → paste → Run).

## 1. PO builder (required first)

Apply **`migrations/20260521110000_po_builder_module.sql`** if you see `relation "public.po_headers" does not exist`.

Creates `factories` (if missing), `po_headers`, `po_lines`, `v_po_header_summary`, `generate_next_po_name()`, and RLS.

## 2. PO costing module

Apply **`migrations/20260521120000_po_costing_module.sql`** after the PO builder script succeeds.

Creates:

| Object | Purpose |
|--------|---------|
| `po_costing` | One row per PO: FOB/factory invoice, ship dates, freight pools, totals |
| `po_costing_lines` | Per `po_lines` row: FOB override, allocations, landed unit |
| `v_po_costing_summary` | Reporting join for PO list / status |
| `v_po_sku_prior_cost` | Latest cost per SKU from prior POs |
| RLS | Authenticated read; write for finance/purchasing roles via `po_costing_can_write()` |

### Workflow in the app

1. **PO builder** — create `po_headers` + `po_lines` (migration `20260521110000`)
2. **PO costing → FOB** — prior SKU and/or factory invoice; save (phase `fob`)
3. **Mark shipped** — sets `shipped_at`, phase `freight`
4. **Freight** — enter freight invoice total, duty %, misc; split to lines; save landed costs

The UI falls back to `internal_notes` `[SILO_COSTING]` JSON if tables are missing (pre-migration).

### Role access

Adjust `po_costing_can_write()` in the migration if your `profiles.role` values differ.

---

## 3. Profiles self-service

Apply **`migrations/20260521130000_profiles_self_service.sql`** so `/v2/profile.html` can read and update the signed-in user’s own `profiles` row (name, `default_page`).

Without this policy, the profile page may show only your auth email or an RLS error.
