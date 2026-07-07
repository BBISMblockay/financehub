# Supabase SQL (SILO purchasing, costing & launch)

**Merging app PRs does not update your database.** Paste these scripts into **Supabase Dashboard → SQL → New query → Run**.

## Quick start (recommended)

| Step | File | What it does |
|------|------|----------------|
| 1 | `verify_v2_schema.sql` | See which tables/views/functions are missing |
| 2 | `apply_all_post_merge.sql` | Applies everything in one run (safe to re-run) |
| 3 | `verify_v2_schema.sql` | Confirm all rows show `ok` |

## Individual migrations (same content, split)

Run in order:

1. **`migrations/20260521110000_po_builder_module.sql`** — required first  
   `factories`, `po_headers`, `po_lines`, `v_po_header_summary`, `generate_next_po_name()`, `po_builder_can_write()`

2. **`migrations/20260521120000_po_costing_module.sql`** — landed cost  
   `po_costing`, `po_costing_lines`, `v_po_costing_summary`, `v_po_sku_prior_cost`, `po_costing_can_write()`

3. **`migrations/20260521130000_profiles_self_service.sql`** — `/v2/profile.html`  
   RLS so users can read/update their own `profiles` row; adds `default_page` column

4. **`migrations/20260602140000_launch_workbench_crud_rls.sql`** — Launch Workbench  
   RLS on all launch tables (`launch_calendar`, `launch_tasks`, `launch_comments`, etc.)

5. **`migrations/20260602150000_launch_images_storage_bucket.sql`** — image uploads  
   Creates `launch-images` Supabase storage bucket

6. **`migrations/20260603120000_launch_comments_author.sql`** — comment attribution  
   Adds `user_id` column to `launch_comments`, backfills from `created_by`

7. **`migrations/20260603130000_launch_comments_author_denorm.sql`** — denormalized author  
   Adds `author_name` + `author_email` to `launch_comments` so display works without a join

8. **`migrations/20260603140000_launch_tasks_assignee.sql`** — task assignment  
   Adds `assigned_to_user_id` (FK to auth.users) and `assigned_to_name` (denormalized) to `launch_tasks`

9. **`migrations/20260609000000_payment_requests_legacy_import.sql`** — legacy payment request import  
   Adds `legacy_source`, `legacy_url`, `legacy_external_id`, `imported_at` to `payment_requests` plus a dedupe index

10. **`migrations/20260616010000_company_entity_backfill.sql`** — multi-tenant backfill  
    Adds `company_entity_id uuid` to 40+ operational tables, backfills Baseballism entity id, creates `entities` and `entity_memberships` tables

11. **`migrations/20260616020000_rls_active_company_isolation.sql`** — active-company RLS  
    Adds `profiles.active_company_id`, `active_company_id()` function, `set_active_company()` RPC, and `*_active_*` RLS policies on all company-scoped tables. **Required for multi-tenant isolation.**

12. **`migrations/20260616030000_views_security_invoker.sql`** — view RLS propagation  
    Sets `security_invoker = true` on all 30+ views so RLS policies on base tables apply when data is accessed through a view. **Run after migration #11.**

13. **`migrations/20260616060000_stamp_company_entity_id_on_insert.sql`** — insert company stamp  
    `BEFORE INSERT` trigger on all `company_entity_id` tables (except `inventory_on_hand` / `sales_by_day`) stamps `active_company_id()` when the client omits the column. Pair with `withCompany()` in `pages/config.js` for UI writes.

14. **`migrations/20260624000000_sales_verification_company_scope.sql`** — sales verification multi-tenant  
    Backfills `sales_by_day.company_entity_id`, rewrites `refresh_sales_verification_store_comp_summary()` per company, fixes summary PK to `(company_entity_id, location_tag)`, and adds `sales_by_day` RLS via `active_company_id()`.

## App workflow after SQL succeeds

1. **PO builder** (`/v2/po-builder.html`) — create header + lines (needs at least one factory)
2. **PO costing** (`/v2/po-costing.html`) — FOB → mark shipped → freight → landed unit
3. **Profile** (`/v2/profile.html`) — name and default landing page
4. **Launch calendar** (`/v2/launch-calendar.html`) — marketing launch planning and comments

## Legacy payment request import

After migration **#9** is applied, use **GitHub Actions** (no local Node required):

1. GitHub → **Actions** → **Legacy Payment Requests Import** → **Run workflow**
2. First run: `dry_run` = **true**, `file_path` = `data/legacy-payment-requests-pilot.csv`
3. Check the job log for `wouldInsert` / `failed: 0`
4. Second run: `dry_run` = **false** (same file) to import the 13 pilot rows
5. Full export: upload your file to `data/imports/` via GitHub (see `data/imports/README.md`), then run the workflow with that path

Uses the same repo secrets as nightly sync: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

Local run (optional):

```bash
node scripts/import-payment-requests-legacy.mjs --file /path/to/your-export.tsv --dry-run
```

Keep personal exports out of git when possible — `data/legacy-payment-requests*.csv` and `*.tsv` are gitignored locally.

## Multi-tenant isolation

SILO supports multiple companies in one Supabase project. Isolation is enforced at the DB level via `profiles.active_company_id`.

**How it works:**
1. At login, `resolveCompany()` in `pages/login.html` reads `entity_memberships` for the user
2. Single-company users: `set_active_company(entity_id)` RPC is called automatically
3. Multi-company users: routed to `/v2/company-picker.html` to pick, then RPC is called
4. All RLS policies use `company_entity_id = active_company_id()` — only rows belonging to the active company are visible
5. All 30+ views have `security_invoker = true` so RLS applies through views
6. `BEFORE INSERT` trigger `stamp_company_entity_id` stamps `company_entity_id` from `active_company_id()` when omitted (UI modules do not need per-page patches)
7. Frontend helpers `withCompany(row)` / `withCompanyRows(rows)` in `pages/config.js` stamp inserts client-side for clarity

**Key tables:** `entities` (`entity_type = 'company'`), `entity_memberships` (`entity_id`, `user_id`, `role`)  
**Key functions:** `active_company_id()`, `set_active_company(p_entity_id uuid)`, `stamp_company_entity_id()`, `attach_stamp_company_entity_id_triggers()`  
**Key column:** `company_entity_id uuid` on all operational tables  
**Baseballism entity id:** `3bd934c9-4cdd-429b-9076-f8f6b45d4eb7`

**Not yet isolated:** `inventory_on_hand` (backfill deferred — nightly Sheets sync is Baseballism-only today; Shopify inventory uses explicit `company_entity_id` on upsert).

## Write access

`profiles.role` is an enum with values: `owner`, `admin`, `user`.

`po_builder_can_write()` and `po_costing_can_write()` grant write access to `owner` and `admin`. Users with role `user` are read-only on PO tables.

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
    20260602140000_launch_workbench_crud_rls.sql
    20260602150000_launch_images_storage_bucket.sql
    20260603120000_launch_comments_author.sql
    20260603130000_launch_comments_author_denorm.sql
    20260603140000_launch_tasks_assignee.sql
    20260609000000_payment_requests_legacy_import.sql
    20260616010000_company_entity_backfill.sql
    20260616020000_rls_active_company_isolation.sql
    20260616030000_views_security_invoker.sql
    20260616060000_stamp_company_entity_id_on_insert.sql
    20260702170000_shopify_sync_variance_fixes.sql
    20260706220000_store_comp_summary_total_sales.sql
    20260706230000_fix_store_comp_summary_refresh_timeout.sql
    20260707000000_wire_sales_velocity_mv_refresh.sql
  seeds/
    launch_calendar_jun_jul_2026.sql
```
