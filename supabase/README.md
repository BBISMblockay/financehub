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

19. **`migrations/20260804000000_reviews_can_manage_self_service.sql`** — roster/reviews open to any manager, not just admins  
    `reviews_can_manage()` required owner/executive/admin role on top of every write policy's own `manager_user_id = auth.uid() OR is_exec_or_owner()` scoping, so a non-admin manager (a retail store manager, say) couldn't roster or review their own direct reports at all. Redefined to true-for-any-active-user; per-row scoping is unchanged (Blake stays company-wide super-admin via `is_exec_or_owner()`, template building stays exec-only).

20. **`migrations/20260804010000_employee_managers_multi_manager.sql`** — an employee can now have more than one manager  
    `employees.manager_user_id` was a single required column, so the same person could never be rostered under two managers at once (e.g. dual reporting to both Loomis and Brett) — the company-wide unique email index blocked adding them a second time. New `employee_managers` many-to-many join table (backfilled from the existing single column) is now the source of truth for who manages whom; RLS on `employees`/`employee_goals` moves from the column to an `is_employee_manager()` check, and `reviews_active_insert` is tightened to actually verify the inserting manager is linked to the employee (previously trusted the client with no relationship check at all). `employees.manager_user_id` is kept but is informational-only now (original creator, not authorization). `v2/reviews.html` gained a Managers list (add/remove co-managers) in the edit-employee dialog and an exec-only "assign to manager" picker when starting a review for a shared employee.  
    `is_employee_manager()` is `SECURITY DEFINER` specifically to avoid RLS self-reference: a raw `EXISTS` subquery against `employee_managers` embedded inside `employee_managers`' own policy (or `employees`'/`employee_goals`'/`reviews`' policies, which need the same check) re-triggers `employee_managers`' RLS on every access — genuine infinite recursion, caught live (`infinite recursion detected in policy for relation "employee_managers"`) and fixed same-day before this migration reached `main`. The function bypasses RLS on its internal query the same way `active_company_id()`/`is_exec_or_owner()` already do.

21. **`migrations/20260804020000_employee_managers_creator_link_visibility.sql`** — self-service employee creation was fully broken for non-exec users  
    Two compounding bugs, both live in prod since the previous migration and caught while building the "add a co-manager at creation" UX: (1) `v2/reviews.html`'s employee insert chained `.select()`, which requires `INSERT ... RETURNING` to pass `employees_active_select` on the just-inserted row — but a brand-new employee has no `employee_managers` link yet, so a non-exec creator was denied visibility of their own row and the whole insert threw `violates row-level security policy`. Fixed by generating the employee id client-side (`crypto.randomUUID()`, same pattern as mail intake) and dropping `.select()` entirely — same fix applied to CSV import. (2) Even without `.select()`, the very next statement — self-linking as manager — also failed: `employee_managers_active_insert`'s "creator self-link" branch did a raw `EXISTS` against `employees`, itself gated by `employees_active_select`, which can't see an unlinked brand-new employee either — the exact same class of bug `is_employee_manager()` fixed, one level deeper. New `is_employee_creator()` (same `SECURITY DEFINER` bypass pattern) replaces that raw subquery. Verified end-to-end under real RLS impersonation: a non-exec user creating an employee, self-linking, adding a second manager, and both managers seeing the employee back, all pass cleanly now.

22. **`migrations/20260804170000_payment_requests_insert_requires_active_company.sql`** — no more ghost payment requests from not-yet-activated accounts  
    `payment_requests_insert_own` had no company check while the files-table insert policy does, so a user in the signup→activation window (no membership yet → `active_company_id()` NULL) could insert the parent request — stamped NULL company, invisible to everyone — then fail on the attachments with a cryptic RLS error, minting another ghost per retry. Caught live with the first real member-tier user (6 ghosts cleaned up). Insert now requires `company_entity_id = active_company_id()` (no-op for activated users — the stamp trigger fills it), and `v2/purchase_request.html` shows a plain "account not activated yet" message with submit disabled instead of letting the user reach the RLS error.

23. **`migrations/20260804200000_admin_update_profile_executive_role.sql`** — the backend can now actually grant the `executive` role  
    `admin_update_profile()`'s role mapping only knew owner/admin; every other value the Edit dialog offers (executive, member, viewer, and the never-real superadmin) was silently coerced to profile `user` and the membership sync then set the person's `entity_memberships` row to `member` — so "promote to executive" both failed AND stripped their admin membership (profile-name visibility, PO writes, etc.). Full vocabulary now mapped explicitly — `executive` → profile `executive` + membership `admin`; `member`/`viewer` → profile `user` + the matching membership tier — with unknown values raising instead of coercing. `superadmin` removed from the backend dropdown.

24. **`migrations/20260805030000_ar_sync_status_v_restore_definer_read.sql`** — AR sync freshness banner was silently returning nothing for every real user  
    `ar_sync_status_v` reads `job_sync_state`, which is intentionally locked down (RLS enabled, zero policies — service-role/bypassrls only). The view is meant to be the one safe read surface into it, which only works with `security_invoker = false` (view runs as its owner `postgres`, which has `BYPASSRLS`) — but the view had `security_invoker = true` set (no tracked migration ever created it; this predates migration history), so it ran as the *calling* role instead and hit the deny-all RLS, returning zero rows with no error for every non-bypassrls caller. Confirmed live via `set local role authenticated`. Broke the freshness banner on `pages/baseballismwholesale.html` and the new Ops status panel on `v2/backend.html` identically. Fix: `security_invoker` back to `false` — `job_sync_state` itself is untouched and stays exactly as locked down as documented.

25. **`migrations/20260805040000_default_page_bootstrap_profile.sql`** — one-time data backfill, paired with the `pages/login.html` fix below  
    Bootstraps every existing profile's `default_page` to `/v2/profile.html`. Until the `login.html` fix, this column was write-only (saved by `/v2/profile.html`, never read at login), so any existing value — a few users had already set one — had no real effect. This gives everyone a neutral, working landing page immediately; each person can still change it themselves from Profile → Default page.

`pages/login.html` — `getRouteFromProfile()` now actually reads and honors `profiles.default_page` (validated through the same same-origin-path guard as the `?next=` deep-link param) before falling back to the role/department routing, which previously sent every department to `/v2/finance.html` regardless.

26. **`migrations/20260805050000_profile_avatars.sql`** — real profile photos, replacing the bold-initials block everywhere it appears  
    Adds `profiles.avatar_url` and a public `avatars` storage bucket (path `avatars/{auth.uid()}/avatar.{ext}`, RLS-scoped so each user can only write their own folder; public read since other people need to see the photo too — Request Manager, Tasks, the sidebar). `payment_requests_v` gained `assigned_to_avatar_url` (new column appended at the end, `security_invoker` explicitly re-set to `true` after the `CREATE OR REPLACE VIEW` — same lesson as #24). Shared render/upload logic lives in `v2/avatar.js` (`.bcn-avatar` component in `beacon.css`) so any page can drop in a real photo with initials-fallback in one call: `SiloAvatar.html({name, email, avatarUrl}, size)`. Wired into `/v2/profile.html` (upload UI), the sidebar (`silo-chrome.js`, resolved the same session-cache-then-resolve way as nav department), `/v2/request_manager.html`, and `/v2/tasks.html`. A follow-up fix (`v2/avatar.js`) converts iPhone HEIC photos to JPEG client-side before upload, since HEIC uploads fine but doesn't render outside Safari.

27. **`migrations/20260805060000_mail_items_v_avatars.sql`** — extends the avatar rollout to Mailroom, Launch comments, and Reviews' Managers column  
    `mail_items_v` gained `assigned_to_avatar_url`/`submitted_by_avatar_url`/`processed_by_avatar_url` (same appended-column + explicit `security_invoker=true` pattern as `payment_requests_v`). Launch comments (`v2/launch-calendar.html`) and the Reviews roster's Managers column (`v2/reviews.html`) needed no view change — both already maintain a client-side `profiles` lookup map (`profileById` / `employee_managers` embed), so just added `avatar_url` to those selects and swapped their own bespoke initials-block markup for `SiloAvatar.html(...)`. Reviews' employee rows (not managers) were deliberately left alone — associates in `employees` don't always have a linked `profiles` row (`profile_id` can be null; no SILO login), so there's often no avatar to show there anyway.

28. **`migrations/20260805070000_sales_comp_as_of_rpc.sql`** — pick-a-date comparisons on Sales Performance Overview  
    `sales_verification_store_comp_summary` is a single snapshot row per store, truncated and rebuilt nightly by `refresh_sales_verification_store_comp_summary()` — there's no history to browse, only ever "as of yesterday." New function `sales_comp_as_of(p_as_of_date date)` mirrors that refresh function's exact Day/MTD/YTD-vs-prior-year math (same literal `interval '1 year'` alignment, same `sales_by_day_verification_v` source so the shopify_api-over-better_reports dedup stays consistent) but computed live for whatever date the caller passes, scoped to one company instead of looping every company. Deliberately not `security definer` — `sales_by_day` already has proper `company_entity_id = active_company_id()` RLS, so a plain function inherits it; the explicit filter in the function body is for index use, not because RLS needs the help. Verified against the live snapshot for `2026-08-04` (exact dollar match, 27/27 locations) before wiring into `v2/bi-sales-overview.html`.

29. **`migrations/20260805080000_sales_comp_as_of_perf_fix.sql`** — the above timed out in production  
    `EXPLAIN ANALYZE` showed 6.3s / 1.29M buffer hits for one date. Two causes: `base` was referenced by six downstream CTEs, and a plain (non-materialized) CTE gets inlined and re-evaluated per reference in modern Postgres — so the expensive shopify_api-over-better_reports anti-join ran six times, not once — and `base` had no date lower bound (removed in the prior migration specifically so a defunct pop-up location, `bld_houston`, still showed as a zero row for historical dates), so each of those six scans covered the full multi-year sales history. Fix: `with base as materialized (...)` so it's computed exactly once, bounded to `as_of_date - ~2 years` (covers day/mtd/ytd for the current and full prior year with a buffer), and the six separate `GROUP BY` CTEs collapsed into one pass using `FILTER`. Down to 2.1s / 198K buffer hits — same exact dollar-match verified again after the rewrite. Trade-off accepted: a location with zero activity in that ~2 year window won't appear for a custom date picked from before it — `sales_by_day` is SKU-grain, not pre-aggregated by day, so a live per-request query over any wider window is inherently expensive; a proper fix would add a nightly-refreshed daily (not SKU-grain) rollup the way `sales_verification_store_comp_summary` already does for "as of yesterday" — noted as a follow-up if 2s ever proves not fast enough in practice.

30. **`migrations/20260810120000_org_calendar.sql`** — Organization Calendar V1 (`/v2/calendar.html`)  
    Hybrid date layer: a `calendar_events` table for manual company events (meetings, holidays, deadlines, milestones — visibility `company`/`finance`/`private`, standard stamp triggers) plus `calendar_events_v`, a `security_invoker` UNION ALL view projecting system dates into one event contract: launches + campaign sends (`launch_calendar`/`launch_channel_items`), open task due dates (`launch_tasks`), active-PO ship/arrival (`po_headers`), open AP due dates (`payment_requests`), paydays (`payroll_import_batches`), claimed live slots (`live_sessions`, UTC → Pacific), open mail deadlines (`mail_items`). Because the view is invoker-rights, each branch inherits its source table's RLS — restricted sources (POs, AP, payroll) stay restricted with no calendar-specific ACL. Clients must range-bound on `start_on`. Full audit + architecture rationale: `docs/ops/org-calendar.md`.

## App workflow after SQL succeeds

1. **PO builder** (`/v2/po-builder.html`) — create header + lines (needs at least one factory)
2. **PO costing** (`/v2/po-costing.html`) — FOB → mark shipped → freight → landed unit
3. **Profile** (`/v2/profile.html`) — name and default landing page
4. **Launch calendar** (`/v2/launch-calendar.html`) — marketing launch planning and comments

## Legacy payment request import

After migration **#9** is applied, use **GitHub Actions** (no local Node required):

**Unpaid AP backlog (CSV-controlled cutover):**

1. Curate the set and export a CSV. **The AP Manager page (`/accountspayable.html`) that produced these exports was retired 2026-08-16** — this step is historical. The importer still auto-detects the AP Workbench export format, so an already-exported CSV works as-is; the raw Jotform-sheet format works too.
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

## Action Items & Insights — retired 2026-09-01

`/v2/insights.html`, `compute_silo_insights()`, `silo_insights_digest`, and `scripts/generate-insights.mjs` are gone (`20260901030000_retire_silo_insights.sql`). The rules engine hadn't been touched since it shipped 2026-07-09 and didn't know about anything built since — card coding, journal adjustments, comp requests, mail routing, product concepts, returns. Its six original domains (sales pace, inventory stockout/dead stock, purchasing draft/overdue POs, launch readiness/overdue tasks, AR aging, AP overdue/large payment requests) still ran correctly against live data when checked, so this wasn't a bug fix — it was a call that the module wasn't worth keeping current.

The half that had been silently broken since the feature existed: the nightly AI narrative needs the `ANTHROPIC_API_KEY` GitHub Actions secret, which was never set. Every digest ever generated logged `ANTHROPIC_API_KEY not set` and stored `narrative = null` — the "Briefing" card always showed the fallback placeholder, never the real thing, confirmed from the last real run's job log before retiring it.

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
    20260803160000_ar_company_entity_backfill.sql
    20260805090000_backfill_uncategorized_product_types.sql
    20260805100000_payment_request_melio_forward.sql
    20260807000000_ad_platform_direct_api.sql
    20260807120000_tiktok_live_schedule.sql
    20260807150000_live_schedule_payroll_payout.sql
    20260810120000_org_calendar.sql
    20260810230000_marketing_mer_view.sql
    20260811000000_meta_ad_creative_performance.sql
    20260811120000_meta_funnel_events.sql
    20260812000000_meta_organic_insights.sql
    20260812000000_product_sample_tracker_links.sql
    20260812120000_redo_returns_integration.sql
    20260812130000_redo_return_items.sql
    20260813180000_silo_chat_readonly_query.sql
    20260813210000_silo_chat_notes.sql
    20260813220000_silo_chat_notes_category.sql
    20260813230000_silo_chat_managers.sql
    20260814000000_lock_connection_secrets_to_admin.sql
    20260814130000_payment_request_activity_amount_and_removed.sql
    20260814150000_launch_calendar_release_brief.sql
    20260814170000_launch_calendar_audience_tags.sql
    20260814190000_silo_chat_audit_log.sql
    20260817180000_launch_calendar_approved_copy_creatives.sql
    20260817190000_sample_notifications.sql
    20260817200000_product_samples_request_source.sql
    20260817210000_shopify_order_level_analytics.sql
    20260818050000_silo_chat_saved_reports.sql
    20260818060000_orders_backfill_job_type.sql
    20260818130000_product_samples_assignee_notifications.sql
    20260818150000_sample_notification_log.sql
    20260818170000_sample_requested_vs_received_on_insert.sql
    20260818180000_sample_insert_no_double_fire.sql
    20260818190000_sample_pps_full_run_received.sql
    20260818200000_sample_received_transition_within_family.sql
    20260818210000_incoming_shipment_lines.sql
    20260818220000_factories_country.sql
    20260820130000_sales_by_day_trgm_search_indexes.sql
    20260820140000_inventory_on_hand_trgm_search_indexes.sql
    20260821090000_silo_chat_saved_reports_visibility.sql
    20260821110000_product_concepts.sql
    20260821130000_product_concept_images.sql
    20260821140000_product_concept_po_link.sql
    20260821160000_product_concept_launch_plan_fields.sql
    20260821170000_product_concept_collections.sql
    20260821170000_sku_collision_velocity_fix.sql
    20260821180000_product_search_rollup_rpc.sql
    20260821210000_silo_chat_schema_catalog.sql
    20260822010000_shopify_order_lines_trgm_indexes.sql
    20260824000000_comp_adjustment_requests.sql
    20260825120000_product_concept_structured_workflow.sql
    20260826060000_marketing_explorer_views.sql
    20260826070000_launch_measurability.sql
    20260826080000_launch_product_actuals.sql
    20260826100000_chat_query_timeout_30s.sql
    20260826070000_quickbooks_integration.sql
    20260826090000_quickbooks_locations.sql
    20260826110000_per_location_accounts.sql
    20260827210000_quickbooks_reports.sql
    20260827220000_schedule_items.sql
    20260827230000_schedule_exclusions_and_files.sql
    20260827240000_schedule_payment_request_link.sql
    20260826120000_top_sellers_type_variance.sql
    20260826230000_sales_by_product_title_daily.sql
    20260826130000_wow_report_rpc.sql
    20260826140000_wow_report_entries.sql
    20260826150000_shopify_sessions_daily.sql
    20260827180000_paid_media_reality_check.sql
    20260901120000_wow_grain_windows.sql
    20260901130000_wow_narrow_sbd_cte.sql
    20260901140000_wow_sales_daily_rollup.sql
    20260827200000_review_scale_1_4_and_goal_dates.sql
    20260831180000_card_coding.sql
    20260831190000_card_name_and_holder.sql
    20260831200000_qbo_entities_and_line_entity.sql
    20260831210000_apply_card_coding_rpc.sql
    20260831220000_void_card_posting.sql
    20260831230000_rule_hits_and_conflicts.sql
    20260901000000_journal_adjustments.sql
    20260901010000_void_journal_adjustment.sql
    20260901020000_posted_status_not_client_writable.sql
    20260901030000_retire_silo_insights.sql
  seeds/
    launch_calendar_jun_jul_2026.sql
```
