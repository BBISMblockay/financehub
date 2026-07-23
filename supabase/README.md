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

15. **`migrations/20260713180000_approve_access_request_entity_membership.sql`** — fix employee onboarding  
    `approve_access_request()` was creating the `profiles` row for a newly approved employee but never an `entity_memberships` row, so `resolveCompany()` found no company at login, `active_company_id` was never set, and every company-scoped RLS policy returned zero rows regardless of department/role. Now upserts `entity_memberships` from the request's `company_entity_id` (falling back to Baseballism), mapping `profiles.role` → `entity_memberships.role` (`owner`→`owner_admin`, `admin`→`admin`, `user`→`member`).

16. **`migrations/20260713190000_harden_active_company_function_grants.sql`** — revoke anon execute  
    Revokes `anon`/`PUBLIC` execute on `active_company_id()`, `set_active_company()`, `po_*_can_write()`, and the Shopify company-meta helpers; grants stay on `authenticated`. Follow-up to #20260625140000.

17. **`migrations/20260713200000_performance_reviews_phase1.sql`** — performance reviews (Phase 1)  
    Adds `executive` to `app_role` (also passes `is_admin()` now), `is_exec_or_owner()` / `reviews_can_manage()` helpers, and 8 tables: `employees` (roster, auto-links `profiles` by email), `review_templates` + `review_template_questions` (exec-only writes), `reviews`, `review_answers`, `review_private_notes` (author-only, not even exec), `employee_goals`, `review_access_tokens` (RLS deny-all — edge-function/service-role only). Manager-scoped RLS: managers see only rows where they're `employees.manager_user_id`; exec/owner see all; linked employees see their own non-draft reviews.

18. **`migrations/20260714170000_reviews_employee_template_read.sql`** — my-review page read access  
    Lets a SILO-authenticated employee read the template title and question labels for templates used by one of their own non-draft reviews (previously manager-only), so `/v2/my-review.html` can render. Template contents never leak ahead of a sent review.

## App workflow after SQL succeeds

1. **PO builder** (`/v2/po-builder.html`) — create header + lines (needs at least one factory)
2. **PO costing** (`/v2/po-costing.html`) — FOB → mark shipped → freight → landed unit
3. **Profile** (`/v2/profile.html`) — name and default landing page
4. **Launch calendar** (`/v2/launch-calendar.html`) — marketing launch planning and comments

## Legacy payment request import

After migration **#9** is applied, use **GitHub Actions** (no local Node required):

**Unpaid AP backlog (CSV-controlled cutover):**

1. Curate the set in the AP Manager (`/accountspayable.html`): Filters → uncheck **Include paid items** (plus any other narrowing) → **Export**. The importer auto-detects the AP Workbench export format — no header editing needed. (The raw Jotform-sheet format still works too.)
2. Upload the CSV to `data/imports/` via GitHub (see `data/imports/README.md`)
3. GitHub → **Actions** → **Legacy Payment Requests Import** → **Run workflow**: `dry_run` = **true**, `file_path` = your upload, `unpaid_only` = **true** (safety net even if the export already excluded paid)
4. Check the job log: `Unpaid-only: kept N of M rows`, per-row `would insert` lines, `failed: 0`
5. Re-run with `dry_run` = **false** to import, then retire the old AP sheet flow

Imported rows land as `new` (or `needs_info` for Hold items) in Request Manager, stamped with the Baseballism `company_entity_id` and backdated `created_at` from the sheet's submission date. Re-running is safe — rows dedupe on the Jotform submission id (`legacy_external_id`).

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

**All operational tables are company-isolated** as of 20260709000000. `inventory_on_hand` was the last data holdout (20260708030000: Sheets-sync rows stamped, legacy NULLs backfilled, company-blind admin policy replaced); `launch_task_templates` was the last schema holdout (20260709000000: empty table with `true` policies, scoped before first use). A full audit of every remaining table/view without `company_entity_id` confirmed the rest are correct by design: the `entity_*` family, `activity_events`, and `files` scope by membership, `profiles` is per-user, `job_sync_state` is service_role-only (RLS on, zero policies = deny clients), and all 31 flagged views are either security_invoker over scoped tables or DEFINER MV readers filtering `active_company_id()`.

## Action Items & Insights digest

`/v2/insights.html` reads a nightly-generated digest from `silo_insights_digest`, populated by `scripts/generate-insights.mjs` as the last step of the Shopify sync workflow. Two parts:

1. **Findings** — `compute_silo_insights(company_entity_id)` is a deterministic SQL rules engine (sales pace vs prior year, inventory stockout risk / dead stock, purchasing draft/overdue POs, launch readiness / overdue tasks, AR aging, AP overdue/large payment requests). Thresholds are hardcoded in the migration with comments explaining each one.
2. **Narrative** — the findings JSON is sent to the Anthropic API with a system prompt that forbids inventing any fact beyond what's given. Requires the `ANTHROPIC_API_KEY` GitHub Actions secret; without it the step still stores findings, just with `narrative = null`, and the UI falls back to "AI summary not available — see the findings below." The workflow step is `continue-on-error: true` so a narrative-generation hiccup never fails the sync.

AR/AP findings are hidden client-side for non-finance departments (same session-cached department used for nav filtering) — see `v2/dept-guard.js` / the department plan in `docs/ops/`.

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
    20260707010000_store_comp_summary_discounts.sql
    20260707020000_sales_verification_summary_tax_shipping.sql
    20260707030000_comp_summary_complete_day_anchor.sql
    20260708000000_product_samples_tracker_link.sql
    20260708010000_tasks_evergreen_personal.sql
    20260708020000_product_tags_company_scope.sql
    20260708030000_inventory_on_hand_company_scope.sql
    20260708040000_sales_rollup_mv_company_scope.sql
    20260708050000_sales_velocity_mv_company_scope.sql
    20260708060000_mv_reader_views_definer.sql
    20260709000000_launch_task_templates_company_scope.sql
    20260709010000_shopify_payouts_accounting.sql
    20260709020000_sync_jobs_allow_payouts_sync.sql
    20260709030000_slack_po_status_accuracy.sql
    20260709040000_slack_skip_draft_po_posts.sql
    20260709050000_silo_insights_engine.sql
    20260710000000_accounting_tax_income_wash.sql
    20260713180000_approve_access_request_entity_membership.sql
    20260713190000_harden_active_company_function_grants.sql
    20260713200000_performance_reviews_phase1.sql
    20260714170000_reviews_employee_template_read.sql
    20260714180000_admin_update_profile_entity_membership.sql
    20260714190000_new_org_signup_flow.sql
    20260714200000_org_invites.sql
    20260714210000_per_company_roles.sql
    20260714220000_stamp_created_by.sql
    20260715120000_fix_refresh_inventory_current_mv_timeout.sql
    20260715130000_slack_task_notify_launch_only.sql
    20260716000000_supermetrics_kpis.sql
    20260717190000_inventory_current_mv_company_index.sql
    20260720170000_payment_request_activity_file_uploaded.sql
    20260720180000_payment_request_paid_notification.sql
    20260720190000_products_master_sku_unique.sql
    20260720193000_products_master_drop_global_sku_unique.sql
    20260721000000_fix_launch_tasks_private_select_leak.sql
    20260721000000_mailroom_rebuild.sql
    20260723150000_shopify_draft_orders.sql
    20260723160000_mlb_shopify_default_location.sql
    20260723170000_wholesale_gross_reconciliation.sql
    20260723180000_link_launch_product_readiness_tracker.sql
    20260723190000_products_master_legacy_tag_backfill.sql
    20260723200000_product_tracker_expected_units.sql
    20260723210000_launch_readiness_factory_link.sql
    20260723220000_products_master_category_from_shopify.sql
    20260723230000_product_tracker_po_backfill.sql
    20260723240000_products_master_surface_legacy_attributes_as_tags.sql
    20260723250000_products_master_subcategory_department_from_tag_book.sql
    20260723260000_pair_historical_launch_products_with_tracker.sql
  seeds/
    launch_calendar_jun_jul_2026.sql
```
