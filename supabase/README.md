# Supabase SQL (SILO purchasing & costing)

**Merging app PRs does not update your database.** Paste these scripts into **Supabase Dashboard → SQL → New query → Run**.

## Quick start (recommended)

| Step | File | What it does |
|------|------|----------------|
| 1 | `verify_v2_schema.sql` | See which tables/views are missing |
| 2 | `apply_all_post_merge.sql` | Applies everything in one run (safe to re-run) |
| 3 | `verify_v2_schema.sql` | Confirm all rows show `ok` |

## Individual migrations (same content, split)

Run in this order if you prefer separate scripts:

1. **`migrations/20260521110000_po_builder_module.sql`** — **required first**  
   `factories`, `po_headers`, `po_lines`, `v_po_header_summary`, `generate_next_po_name()`  
   Without this, costing fails with `relation "public.po_headers" does not exist`.

2. **`migrations/20260521120000_po_costing_module.sql`** — landed cost  
   `po_costing`, `po_costing_lines`, `v_po_costing_summary`, `v_po_sku_prior_cost`

3. **`migrations/20260521130000_profiles_self_service.sql`** — `/v2/profile.html`  
   RLS so users can read/update their own `profiles` row; adds `default_page` column

## App workflow after SQL succeeds

1. **PO builder** (`/v2/po-builder.html`) — create header + lines (needs at least one factory)
2. **PO costing** (`/v2/po-costing.html`) — FOB → mark shipped → freight → landed unit
3. **Profile** (`/v2/profile.html`) — name and default landing page

Until migrations run, costing may fall back to `[SILO_COSTING]` JSON inside `po_headers.internal_notes`.

## Write access

`po_builder_can_write()` and `po_costing_can_write()` allow roles such as `finance`, `purchasing`, `buyer`, `admin`, `operations`. Adjust the role list in the SQL if your `profiles.role` values differ.

## Repo paths

```
supabase/
  apply_all_post_merge.sql      ← one-shot apply
  verify_v2_schema.sql          ← health check
  README.md
  migrations/
    20260521110000_po_builder_module.sql
    20260521120000_po_costing_module.sql
    20260521130000_profiles_self_service.sql
```
