# Supabase SQL (SILO purchasing, costing & launch)

**Merging app PRs does not update your database.** Paste these scripts into **Supabase Dashboard → SQL → New query → Run**.

## Quick start (recommended)

| Step | File | What it does |
|------|------|----------------|
| 1 | `verify_v2_schema.sql` | See which tables/views/functions are missing |
| 2 | `apply_all_post_merge.sql` | Applies everything in one run (safe to re-run) |
| 3 | `verify_v2_schema.sql` | Confirm all rows show `ok` |

## Individual migrations (same content, split)

**Plaid bank feeds:** `migrations/20260912052930_plaid_bank_feed.sql` follows the Finance V1 posting controls. It adds encrypted service-only Plaid credentials, account mapping, account-scoped atomic sync, provider lifecycle exceptions, CSV authority enforcement and finance audit events. It does not connect an institution or post a journal. Deploy `plaid-finance` and the updated `card-categorize` separately; see [the rollout and recovery runbook](../docs/ops/plaid-bank-feed-v1.md). Scheduled ingestion remains off until explicitly enabled.

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
    20260901150000_wow_organic_posts.sql
    20260901160000_meta_followers_group.sql
    20260901170000_wow_creatives.sql
    20260901180000_products_shopify_status.sql
    20260902000000_meta_creative_body_source.sql
    20260902010000_ad_level_thruplays_leads.sql
    20260902020000_meta_ad_performance_v_thruplays.sql
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
    20260902030000_fixed_assets.sql
    20260902100000_fix_top_products_redo_filter.sql
    20260902110000_report_builder_reportable.sql
    20260902120000_report_builder_start_here.sql
    20260828120000_v3_dashboards.sql
    20260828130000_saved_report_source.sql
    20260828140000_saved_report_column_semantics.sql
    20260828150000_seed_system_reports.sql
    20260903100000_report_parameters.sql
    20260903200000_matrix_visual.sql
    20260903210000_section_widget.sql
    20260904100000_saved_report_edit.sql
    20260904120000_storage_company_scoping.sql
    20260904140000_demand_coverage_grants.sql
    20260904160000_logistics_reports.sql
    20260904180000_logistics_dashboard.sql
    20260904200000_readonly_query_column_order.sql
    20260904210000_demand_coverage_base_mv.sql
    20260904220000_is_admin_user_definer.sql
    20260904230000_demand_coverage_uses_base.sql
    20260904240000_ownership_reports.sql
    20260904260000_ownership_dashboard.sql
    20260904280000_business_timezone_and_channel_revenue.sql
    20260904300000_report_tieouts.sql
    20260904310000_cash_flow_forecast.sql
    20260904320000_readonly_query_pagination.sql
    20260904330000_readonly_query_revoke_anon.sql
    20260904340000_answer_widget.sql
    20260907120000_sales_by_product_title_daily_mv.sql
    20260907140000_report_row_estimate.sql
    20260908120000_drop_retired_better_reports_inventory.sql
    20260908130000_dashboard_filter_views.sql
    20260908140000_v3_visual_types.sql
    20260908150000_chat_catalog_evidence_caveats.sql
    20260909120000_shopify_collections_registry.sql
    20260909140000_landing_pages_day_level_truncation.sql
    20260909160000_collections_registry_now_populated.sql
    20260909180000_search_console_connection.sql
    20260909200000_shopify_product_skus.sql
    20260909220000_page_inspection.sql
    20260909240000_seo_project_workflow.sql
    20260909260000_seo_workflow_integrity.sql
    20260909300000_seo_baseline_business_timezone.sql
    20260909320000_collection_skus_show_empty_collections.sql
    20260909340000_sync_jobs_skipped_status.sql
    20260909360000_landing_pages_resume_and_sweep.sql
    20260909380000_seo_collection_candidates.sql
    20260909400000_seo_candidates_coverage_and_pacific.sql
    20260909420000_seo_candidates_top_n_day_names.sql
    20260910120000_tasks_on_initiatives.sql
    20260910130000_seo_approvers_stamp_and_granted_by.sql
    20260910140000_initiative_delete_cascades_tasks.sql
    20260910150000_restore_lost_catalog_caveats.sql
    20260910160000_notify_sample_events_as_deployed.sql
  seeds/
    launch_calendar_jun_jul_2026.sql
```

- `20260910120000_tasks_on_initiatives.sql` — a task can be attached to an
  **initiative** (`launch_channel_items`), not only a launch. Adds
  `launch_tasks.channel_item_id` (`ON DELETE CASCADE` since
  `20260910140000` — see below; it shipped as SET NULL), a BEFORE trigger deriving `launch_id` from the
  initiative so the two columns can never disagree about which launch a task is on,
  an AFTER trigger on `launch_channel_items` so moving an initiative moves its
  tasks, and `tasks_v` (**`security_invoker`** — `launch_tasks` hides private tasks
  from all but their assignee and creator). Nothing is required: a task created in
  Task Manager with no parent stays evergreen and never reaches the new triggers.

- `20260910130000_seo_approvers_stamp_and_granted_by.sql` — `seo_approvers`
  (and the other 11 tables created 2026-09-09) had no `stamp_company_entity_id`
  trigger, so the "DB trigger is the backstop" promise was false for exactly the
  newest tables; re-runs `attach_stamp_company_entity_id_triggers()`, which is
  idempotent and never overwrites an explicitly passed company. Also defaults
  `seo_approvers.granted_by` to `auth.uid()`, matching `silo_chat_managers`.
  Surfaced by wiring the SEO approver grant into `/v2/backend.html`

- `20260910140000_initiative_delete_cascades_tasks.sql` — deleting an initiative
  deletes its tasks. Deleting a **launch** has always done this
  (`launch_tasks_launch_id_fkey` has been CASCADE since the table existed), so an
  initiative behaving differently meant two rules for the same gesture. A task tied
  to **neither** survives both deletes — that needs no rule, since an unattached task
  references nothing to cascade from. Applied when zero tasks carried a
  `channel_item_id`, so it rewrote a rule rather than deleting anything.

- `20260910150000_restore_lost_catalog_caveats.sql` — two Ask SILO catalog
  caveats were lost to later migrations that wrote `set description = '...'`
  instead of appending: `CLAIMED, NOT ACTUAL` on `marketing_kpis_daily`
  (dropped by `20260908150000`) and `ABSENCE IS NOT NONEXISTENCE` on
  `shopify_landing_pages_daily` (the SEO project's step 1, dropped the next day
  by `20260909140000` and `20260909360000`). Re-appended, guarded. Found by the
  first scheduled run of `deployment-drift-check.yml`, whose verify checks had
  been reporting MISSING since the rewrites. Edit these rows by appending

- `20260910160000_notify_sample_events_as_deployed.sql` — the trigger function
  production actually runs, verbatim: SAMPLE_REQUESTED / SAMPLE_RECEIVED on
  insert, SAMPLE_SIZE_REQUEST for catalog photo pulls only. The wider version in
  `20260818130000` → `20260818200000` (ASSIGNED, WAREHOUSE_READY, received on
  update) never ran in production; by decision it stays that way until the Slack
  rebuild defines notifications deliberately. Verify checks 28 and 33 assert this
  shape now. A no-op when applied

- `20260910180000_search_console_daily.sql` — Search Console performance data,
  three grains in three tables (`search_console_site_daily` / `_page_daily` /
  `_query_daily`), built to what `scripts/search-console-probe.mjs` measured on
  2026-09-10 rather than recalled: final data ends 2 days back, 498 days of
  history, 25k-row pages, the page cut complete on clicks, the query cut
  recovering only 56.9% of clicks (Google anonymises the rest). The site row
  stores the per-day attributed sums from the same fetch and derives
  `unattributed_query_clicks` / `_share` as generated columns (NULL = never
  measured, never 0). Service-role writes only. Extends `sync_jobs.job_type`
  with `search_console_daily` by reading the LIVE constraint definition and
  appending, so a value that exists only in production survives. Seeds the
  Ask SILO catalog entries as guarded appends and refreshes columns. Verify
  check `search_console_daily_tables`. Tested twice over against a scratch
  Postgres (idempotent; a prod-only job_type value survived the rewrite)

- `20260910190000_search_console_page_absence_caveat.sql` — forward-corrective.
  The migration above shipped the `search_console_page_daily` catalog row saying
  a page with no row on a day "genuinely had no search clicks", from the probe's
  aggregate 102.8% page recovery. That is a per-row guarantee Google explicitly
  does not make (the Search Analytics API does not promise every row, even with
  pagination), and it teaches Ask SILO the negative-claim-from-a-partial-list
  error the SEO project exists to prevent. Replaces the sentence on the page
  and site rows with an ABSENCE IS NOT ZERO caveat; idempotent. Verify's
  `search_console_daily_tables` goes CRITICAL if the wrong sentence returns.
  Found in review of PR #666 after 20260910180000 was already applied

- `20260910200000_search_console_query_cap_caveat.sql` — records the repeated
  5,000-row daily averages as an observed pattern, not a confirmed cap.
  Missing rows have unknown causes; use weighted window coverage for the same
  company/property, withholding the share for unmeasured or truncated days.
- `20260910210000_search_console_overview_rpcs.sql` — three read-only RPCs
  behind `/v2/seo-overview.html`: `search_console_overview(p_days, p_end)`
  (freshness, window, current + prior totals with POOLED ctr and
  impression-weighted position, the unattributed share over measured days,
  observed 5,000-row/truncated day counts, a daily series), `search_console_top_pages` and
  `search_console_top_queries` (top rows with the same row's prior-window
  figures; `prior_*` NULL = not returned, never 0; a prior of 0 clicks gives a
  NULL percent change). The window ends on the NEWEST INGESTED day, not
  today−2, so a missed nightly reads as lag, not as a collapse. SECURITY
  INVOKER, `authenticated` only, `anon` revoked. Behaviour test
  `scripts/sql/verify_search_console_overview.sql` (16 assertions, fixture
  rows, rolled back); verify's `search_console_daily_tables` checks existence
  and grants

- `20260914120000_seo_measurement_capture.sql` — the measurement half of the
  SEO workflow. `seo_capture_measurements(task, window_kind, start, end)` is
  the ONLY writer of a captured measurement: the `seo_measurements` insert
  policy refuses `search_console_page` / `shopify_landing_pages` rows from any
  client, the function is SECURITY DEFINER with `company_entity_id =
  active_company_id()` on every read, and a partial unique index on (task,
  window, period, source, metric) backs "frozen on repeat" (a
  `unique_violation` returns `already_captured`). Pooled CTR,
  impression-weighted position, absent page = NULL never 0, the latest
  `page_inspections` row as evidence. `seo_follow_up_window(task, days)`
  names the window equivalent to the latest baseline. Triggers: a publication
  may cite only an `approved` task and never a future date; a baseline ends
  before the FIRST publication and a follow-up starts after the LAST; a
  publication is refused while an existing follow-up would then start on or
  before it. Executed by `scripts/tests/seo-workflow-database.test.mjs`
  (PGlite, real migrations, authenticated roles, six mutations)
- `20260914130000_search_console_newest_run_wins.sql` — the nightly and the
  manual backfill overlap with no concurrency gate. The sync core's retirement
  sweep is ordered by `synced_at`, but a plain upsert from an OLDER run
  resuming after a newer one completed would still rewrite shared identities
  and the site totals with the older payload. One BEFORE INSERT OR UPDATE
  trigger on all three `search_console_*_daily` tables: an update whose
  `synced_at` is older than the stored row is dropped (equal passes, a retry
  within one run), and a page/query insert for a day whose site row already
  carries a newer `synced_at` is dropped. Deliberately not a GitHub
  concurrency group — see CLAUDE.md's shopify-sync note on why a group can
  silently cancel a scheduled nightly. Verify: `search_console_newest_run_wins`
- `20260912000000_finance_v1_posting_controls.sql` — Finance V1 posting
  prerequisites without a second approval surface: approval moves to
  authorization-checked RPCs that validate QBO references and freeze a hashed,
  QBO-ready snapshot; RLS makes approved card/adjustment content immutable;
  each approval binds one active QBO connection; generated Shopify, prepaid,
  and depreciation entries carry stable source identity; and posting claims
  now distinguish `submitting`, `unknown`, `posted`, and `failed`.
  Unknown Intuit outcomes recover by deterministic DocNumber before a retry,
  while local persistence failures remain recoverable from the same path.
  Approval verification hashes the stored JSONB inside Postgres via a
  service-role-only RPC, binding the exact hash/version the posting function
  loaded; JavaScript serialization never determines approval validity.
  `void_journal_adjustment` supports both typed source identities and legacy
  adjustment IDs, preserving the exact posting link and the operator's reason.
  Confirmed postings remain locked when recovery cannot find the QBO entry.
  Recovery and reopen actions use explicit finance dialogs in the account workspace.
  This migration retains snapshots and posting/reopen/void metadata. A separate
  append-only finance event ledger is still a Finance V1 prerequisite.

- `20260912203725_bank_feed_workspace_history.sql` — records the history requested
  at new Plaid Item initialization. Existing Items remain NULL (not recorded),
  never backfilled from today's configuration. No policy, approval, cursor, or
  posting changes. Apply separately after review; deploy plaid-finance and
  card-categorize with the workspace frontend. See the Plaid runbook.

### Accounting foundation (20260912231606)

`20260912231606_accounting_foundation.sql` adds QBO-seeded Silo account identities, accounting settings, reviewed immutable local opening history and the existing-source journal register. Apply after the Plaid history migration. Deploy `quickbooks-report` for explicit connection selection. See `docs/ops/accounting-foundation.md` for scope and rollout gates. This is not an independent Silo ledger cutover.


### QBO historical ledger (20260913022606)

`20260913022606_qbo_historical_ledger.sql` adds immutable `qbo_history_imports`
and `qbo_history_lines`, finance/company read policies, and the authenticated
`archive_qbo_ledger(uuid,uuid)` RPC. Depends on accounting foundation and finance
controls. The RPC validates stored, unfiltered GL/TB reports, preserves independent
copies, and records per-account reconciliation exceptions. It creates no journals.
Apply only this new migration after review; no Edge Function change is required.
See [QBO history operations](../docs/ops/qbo-history.md) for limits and test gates.

### QBO history number formats (20260914220000)

`20260914220000_qbo_history_number_formats.sql` adds `qbo_report_number(text,text)`
(one parser for every numeric report cell: QBO writes fractions as `.44` / `-.67`,
which the first archive migration rejected as `Invalid ledger movement`) and
re-creates `archive_qbo_ledger(uuid,uuid)` to use it, to settle a blank amount from
the running balance only when the balance did not move, to treat a missing `value`
key as a shape failure, and to name the cell, row ordinal and QBO account id in
format errors. Zero lines (blank or `.00`) get `row_kind = 'zero_amount'` (the
`row_kind` CHECK is widened, and a second CHECK refuses a zero-amount `transaction`
row) so the categorizer's `row_kind = 'transaction'` evidence read never treats
them as precedent. The second CHECK is the compatibility proof: over an archive
that already held such a row the `ALTER` fails and the migration stops before the
RPC is re-created (production held no archives when written). Additive; the 20260913 migration is untouched. Apply after it. No
Edge Function change. `verify_v2_schema.sql` reports STALE until applied.

### QBO history bounded archive (20260915000000)

`20260915000000_qbo_history_bounded_archive.sql` replaces the single-call archive,
which appended every ledger line to one growing `jsonb` value and was therefore
quadratic: measured on a real PostgreSQL 16, 1k rows 1.4 s, 2k 5.1 s, 4k 19.7 s,
8k 77.9 s, 16k 431 s, against PostgREST's 8 s ceiling -- both production imports
(36,778 rows and a half-year window) fetched their reports and died in the RPC. A
function-level `statement_timeout` cannot raise that ceiling (the timer is armed
before the function's SET applies; measured), so the hand-applied 55 s override is
dropped by this migration's `create or replace` rather than kept. The archive is now
a job: `qbo_history_jobs` (finance-readable progress, no client writes, partial
unique index on one running job per source) plus `qbo_history_staging_sections` and
`qbo_history_staging_lines` (closed to every client). Each call of
`archive_qbo_ledger(uuid,uuid)` does at most 5,000 rows / ~3 s, persists where it
stopped inside a section, and returns `in_progress` with counts; the last call
inserts the import and copies the staged lines set-based, so nothing partial ever
reaches the evidence tables. A malformed row marks the job failed with the same
cell-level message and drops its staging. The import's audit trigger now runs
`qbo_history_audit_event()`, which omits the snapshot body. After: 36,778 rows in
8 calls / 5.7 s, longest call 2.9 s. Two phases stay unbounded by construction
(hashing the frozen source; the final copy, which must be atomic because the
evidence tables are immutable), so a job refuses a report over 100,000 ledger
rows or 8 MB of stored JSON before any work rather than risking a timeout
mid-import -- the byte ceiling is measured, since hashing is worse than linear
in document size (7.7 MB 1.21 s, 15.5 MB 7.10 s, 31 MB 21.1 s against an 8 s
timeout) -- the refusal runs before the snapshot is built or hashed, and
finalization carries its own exception block so a final-copy error terminates
the job instead of stranding it as `running`. Tests: `scripts/tests/qbo-history-database.test.mjs` (40,000-row
synthetic archive, six mutations), `qbo-history-ui.test.mjs`; timing harness
`scripts/tests/qbo-history-benchmark.mjs`. Verify: `QBO history bounded archive`.

### Plaid removal classification (20260915220000)

`20260915220000_plaid_removed_from_status.sql` adds
`card_transactions.removed_from_status` and makes `plaid_project_transaction`
stamp it whenever the feed removes a row.

Plaid maps every `transactions/sync` removal to `provider_status='removed'`,
whether the institution retired a **pending** id (it posted, or the
authorisation was dropped) or retracted a **posted** transaction that was real,
codeable and possibly already coded. One status, two entirely different events.

A pending row is `status='excluded'` and fails `isAvailable()`, so it was never
codeable and never reached the books: retiring its id costs a reader nothing and
is the feed's own bookkeeping. A posted row being retracted is money that was in
the books and is now gone. The transactions page hides the first and keeps the
second reachable, which it cannot do unless the row says which it was.

It has to be recorded at removal time. Observed on the live feed 2026-09-15: 26
pending rows retired in one sync cycle, their posted twins delivered in a LATER
cycle, **none carrying `pending_transaction_id`** — this connection never
populates it, so the pairing cannot be recovered from the row afterwards.

Constrained to `pending` / `posted` / null, cleared when a row comes back, and
backfilled from the surviving pre-removal payload (`raw->>'pending'`) for rows
removed before the migration. `verify_v2_schema.sql` fails STALE if any removed
Plaid row is left unclassified, since an unclassified row reads as a retraction.

### QBO history trial balance period (20260915210000)

`20260915210000_qbo_history_trial_balance_period.sql` makes `archive_qbo_ledger`
refuse a trial balance that does not cover the ledger's own period. It checked
only that the two reports ENDED on the same date.

QBO's trial balance is period-scoped: a balance-sheet account reports its as-at
balance, so the start date does not move it, but an income or expense account
reports ACTIVITY for the range. `/v2/qbo-history.js` had been requesting the
trial balance from the FISCAL YEAR START rather than the ledger's start; every
window tried began on January 1 so the two coincided, and the first window to
cross a fiscal-year boundary (2025-08-01 → 2026-07-31, 2026-09-15) compared
twelve months of ledger against seven months of trial balance -- 63 P&L accounts
out by $33.3m with every balance-sheet account tying exactly. All 36,686 lines
were archived correctly; only the verdict was wrong.

Both the stored columns (`tb.start_date` vs `gl.start_date`) and each report's
own `Header.StartPeriod` are checked. **Correction (2026-09-15, same day):** the
header half cannot fire for a trial balance -- QBO ignores `start_date` on that
report and echoes the requested value back, so two runs asking for different
starts return byte-identical rows. The diagnosis this migration was written on
was wrong: the trial balance is fiscal-year-to-date whatever is asked, so only a
ledger window beginning on the fiscal year start can reconcile at all. The
practical fix is the fiscal-year buttons on `/v2/accounting-books.html`; this
migration's remaining value is the stored-column check. Logged P3 in
`docs/ops/bugs.md`. The page is fixed in the same change, but a
UI asking the wrong question must not be able to turn itself into a headline
number, so the refusal lives where the comparison is made. Verified across all
22 distinct stored report windows: every run carries `Header.StartPeriod` equal
to its `start_date`, so nothing existing is refused. Additive; re-creates
`archive_qbo_ledger` from `20260915200000` with that one edit. Apply after it.
Verify: the two new rows inside `QBO history bounded archive`.

### QBO history unattributed section (20260915200000)

`20260915200000_qbo_history_unattributed_section.sql` stops `archive_qbo_ledger`
refusing the whole import over QuickBooks' own account-less section. Measured on
the stored Baseballism reports: exactly one leaf section per window has no
account id (209 sections / 36,778 rows in the full year; 193 / 23,002 in the half
year) and there are zero duplicate ids, so the `duplicate` half of the old
message was never involved. That section is `Not Specified`, 24 rows, every one a
Journal Entry for `.00` or a Payment with a blank amount reading `Created by QB
Online to link credits to ...`. Nobody can assign those an account, so the
refusal left the full-year window permanently unarchivable.

The section is now **archived, not skipped**: every row kept under
`silo:unattributed` (cannot collide with a numeric QBO id), `account_type`
`Unattributed`, and named in the reconciliation under its own
`unattributed_ledger_section` issue with a null difference.

**Admission checks four cells, not one.** The placeholder has no trial-balance
counterpart, so the comparison is skipped for it and whatever admission lets
through is never checked again -- admission is the only test this section faces.
It therefore requires each row's amount cell, each row's running balance cell,
the section's period total (`Summary.ColData[6]`) and the section's ending
balance (`Summary.ColData[7]`, `rbal_nat_amount`) all to be present and all
blank or zero; any of them non-zero refuses the whole import, naming what it
found. Each is a separate claim: a `Beginning Balance` row has a blank amount
and a real running balance, so an amounts-only test admits a $250 closing
balance and reports `matched`; and a section can report zero movement in column
6 while reporting a balance carried out in column 7, so the period total does
not vouch for the balance.

**A blank running balance reads as zero on the placeholder only**, since
admission has already established the section is all zero; on a real account it
stays a hard refusal. Four of the seven stored windows carry exactly one row
with both cells blank and previously failed on `Missing running balance`, so
without this the fix would have covered only the window that was reported.

**The exemption from `exception_count` is the notice, not the section.** Only
`unattributed_ledger_section` is exempt; a running balance gap, a disagreeing
period total or a missing transaction reference on that section counts like it
would anywhere else, so `matched` keeps meaning matched.

Additive; re-creates `archive_qbo_ledger` from `20260915000000` with those edits
only. Apply after it. Verify: the six new rows inside `QBO history bounded
archive`.

### Card transaction splits (20260915100000)

`20260915100000_card_transaction_splits.sql` lets one card or bank transaction be
coded across several accounts. A coded row carried exactly one `qbo_account_id`
and the approval snapshot built exactly one journal line per row, so a $25,187.68
loan payment that is part principal and part interest had three bad options: all
to the liability (overstating principal paid), all to interest (never reducing
the loan), or excluding the row and hand-writing a journal adjustment every
month with nothing linking the two. The same shape covers a card payment with a
fee, payroll drafts and a charge spanning two cost centres.

`card_transaction_splits` holds the lines: a signed `numeric(14,2)` that may not
be zero, its own account, location, entity and memo, and a composite FK to
`(card_transactions.id, company_entity_id)` so a split can never point across
tenants. **The lines must total the parent to the cent**, which is the whole
safety property -- the settlement leg of the journal entry is computed from the
batch total, so a split that summed to anything else would unbalance the entry or
move money the statement never moved. It is enforced three times: in
`set_card_transaction_splits`, by the deferred constraint trigger
`card_splits_must_tie` that a service-role write cannot dodge, and again by
`approve_card_import_batch` before it freezes the snapshot. A split row's own
`qbo_account_id` is null and `card_transaction_splits_still_tie` keeps it that
way, so a query reading only that column returns "no account" rather than one
account standing for several.

`card_split_rules` / `card_split_rule_lines` learn the SHAPE of a recurring
split -- the ordered accounts, matched on merchant or card name -- and
**deliberately have no amount column at all**: an amortizing payment divides
differently every month, so a remembered amount would be wrong by construction
and would look authoritative while being wrong. `suggest_card_transaction_splits`
returns those lines with `amount` null, and refuses to suggest anything when a
merchant rule and a card-name rule disagree, the same stance `card_coding_rules`
takes on a conflicting single-account coding. `verify_v2_schema.sql` fails
CRITICAL if any amount-shaped column appears on either rule table.

`card_coding_effective_lines` (security_invoker) is the one definition of a
posted line -- the split lines of a split row, or the single line of an unsplit
row -- and `approve_card_import_batch` is re-created from `20260912000000` to
validate and aggregate through it. Duplicating the account/location/entity
checks for splits would have been the obvious change and the wrong one: the next
check added to one copy would be missing from the other, and the gap would be
invisible until a split line posted to an account nobody validated.

**Two bank-feed interactions the first version got wrong** and this migration
now owns. `plaid_guard_batch` is re-created from `20260912052930` because its
direction and clearing-account checks ran through one INNER JOIN on
`card_transactions.qbo_account_id` -- null on a split row, so every split row
fell out of the join and skipped all four: a `card_payment` could be split into
expense accounts and approved where the same row unsplit is refused. Direction
is now checked on the transaction (no account join) and account type through
`card_coding_effective_lines`, per posted line. And
`card_splits_follow_provider_change` drops a split when the bank corrects a
DRAFT row's amount, because the feed discards that row's coding and a split is
coding: left behind, the tie check would raise inside `plaid_apply_sync` and
roll back its cursor, so every later sync of that account would re-read the
same correction and fail identically -- one split would stop the feed for good.

Writes are RPC-only (`revoke all`, `grant select`), finance-gated by
`can_manage_journal_entries()`, and refused once the batch leaves `draft` /
`categorized`. UI: the split editor in `v2/card-splits.js`, opened from the
category cell and the review panel on `/v2/transactions.html`. Tests:
`scripts/tests/card-splits-database.test.mjs` (28 cases, two mutations) and
`scripts/tests/card-splits-ui.test.mjs`. Verify: `Card transaction splits`.
Apply after `20260912000000`. No Edge Function change.

### Profiles active-company scope (20260913054723)

`20260913054723_profiles_active_company_scope.sql` scopes profile visibility to
the caller's ACTIVE company. `profiles` carried three OR'd SELECT policies, none
of which constrained the ROW being read to a company, and `is_owner_admin()` has
no `entity_id` filter — so an owner of one tenant read every profile in the
database while active in another. Reported as Baseballism people appearing in
Test Company's assignee dropdown on `/v2/tasks.html`; twelve people-pickers read
`profiles` directly and all relied on RLS for scoping.

`profiles` has no `company_entity_id` of its own, so the scope comes from
`entity_memberships` via `shares_active_company(uuid)` — SECURITY DEFINER with
`row_security = off`, because a policy on `profiles` reading
`entity_memberships` directly would re-enter that table's RLS. The UPDATE side
becomes self-only: the only client writes are the two self-edits in
`/v2/profile.html`, and `admin_update_profile()` is SECURITY DEFINER.

Measured against production first: Baseballism 34 → 33 visible (losing only a
Test-Company-only account referenced by no Baseballism row), Test Company
34 → 2, zero profiles orphaned. Regressions in
`scripts/tests/profiles-tenant-scope.test.mjs`; `verify_v2_schema.sql` asserts
exactly one SELECT policy.

## 20260915140000 / 20260915150000 — where a Meta ad sends the customer

`meta_ad_creatives` gains `link_url`, `link_url_source`, `link_url_tags` and a
generated `link_path`; `meta_ad_performance_v` and `wow_creatives` expose them.

Two things are worth knowing before touching either file.

**The source is not decoration.** 2,565 of 4,079 stored creatives are
`object_type = SHARE` — a page-post ad, which carries no `object_story_spec`
of its own. Their only available source is `creative.effective_object_url`,
and Meta may resolve that to the POST rather than to the advertiser's site. So
a URL from that source is the best answer available for the ad and is NOT
automatically a landing page. `link_url` and `link_url_source` are therefore
constrained null-or-non-null together, and every reader shows the host.

**`wow_creatives` was drifted.** Production was running a version carrying
`thruplays` / `leads` / `cost_per_thruplay` / `cost_per_lead` that no migration
in this repo contained, with its comments stripped — applied by hand. The
`20260915150000` body is reconstructed from `pg_get_functiondef()` against
production, with this repo's comments restored, because building it from
`20260901170000` would have deleted a shipped feature `/v2/wow-report.html`
reads by name. `verify_v2_schema.sql` now fails CRITICAL if `cost_per_thruplay`
leaves the deployed function again. Read the live definition before re-creating
any RPC.

Regressions in `scripts/tests/meta-creative-links-database.test.mjs` (executes
both migrations twice, so a non-re-appliable one fails here rather than during
an `apply_all_post_merge.sql` re-run) and, for the sync and page,
`meta-creative-links.test.mjs` / `wow-report-destination.test.mjs`.

`20260915230000_product_tracker_po_link.sql` adds `product_tracker.po_header_id`.
`/v2/products.html`'s Pipeline drawer has always offered a "PO / Incoming"
product search and has always labelled its Expected Units field "(from the
originating PO)", but there was no column to hold which PO — so the pick could
not be saved, and Expected Units was typed by hand. Additive, nullable, and
`on delete set null`: a deleted purchase order must not delete the pipeline item
that came from it, nor block the delete. `product_samples.po_header_id` is the
existing counterpart on the samples side.

The page **feature-detects the column** (one `select po_header_id limit 1` probe
at boot) and omits it from the write until it exists, because merging a PR does
not apply a migration — sending an unknown column fails the whole update, which
would turn "the PO link is not stored yet" into "nothing on this page saves".
Only a `42703` is read as absent; any other error is logged and the column is
still treated as present, so one bad request cannot quietly stop the link being
saved on a database that has it.

## 20260916030000 — the Ask SILO destination caveat, corrected by measurement

`20260915140000` taught the catalog that `effective_object_url` is the source
page-post ads "rely on". The first clean sync disproved both halves: the
account **refuses** that field as unknown, and the SHARE ads said to rely on it
are the 82 resolving through `asset_feed_spec`.

It is a **targeted `replace()` of that one sentence**, because rewriting this
column whole is how two caveats were silently dropped and had to be restored in
`20260910150000`. It is idempotent, and it no-ops silently if production's text
has drifted — so `verify_v2_schema.sql` asserts the OUTCOME (`Ask SILO ad
destination caveat`) rather than trusting the update, and doubles as a guard
against a later migration reintroducing the claim.

Confirmed against production before commit: the expected sentence matches
exactly, and the verify check flags today (pre-apply) as it should.

## 20260916120000 / 20260916121000 — Ask SILO reliability (2026-09-16 audit)

**`chat_run_readonly_query` now runs in a read-only transaction.** The
existing guard — single `SELECT`/`WITH`, no semicolon — is a check on the
*shape of the statement text*, and a SELECT is not a read. A SELECT can call a
VOLATILE function, which runs with the caller's own privileges, and
`set_active_company(uuid)` is granted to `authenticated`:

```sql
select public.set_active_company('<an entity the caller belongs to>');
```

is a single semicolon-free SELECT that passes every existing check and
**UPDATEs `profiles.active_company_id`** — the column every RLS policy in SILO
reads to decide which company's rows the caller sees. It is not a cross-tenant
read (the function validates membership first), but it silently repoints the
caller's session at another of their companies mid-answer, which is precisely
what a shared read-only reporting engine must not be able to do.

`20260916120000` issues **`SET TRANSACTION READ ONLY` through `EXECUTE`** before
it runs the caller's statement. Enforcement moves to the executor, so it holds
however the write is reached — directly, through a function, or through a
function called by a function — and a write attempt raises `25006` like any
other query error. Nothing changes for a genuine read; every caller today (Ask
SILO's tool loop and Refresh button, every `/v3/` widget, the report builder
preview) runs SELECTs only.

**It is a TRANSACTION property, not a function one, so the rest of the
transaction stays read-only after the call returns.** Under PostgREST that is
the end of the request, and every caller today is an HTTP RPC from the browser
or the silo-chat edge function — nothing in this repo calls it from SQL inside
a larger transaction. If something ever does, its later write fails loudly with
`25006` rather than quietly, which is the right direction for that mistake to
fall, but it is a real constraint on where this function may be called from.

**Two mechanisms that look like this fix are not, and both were measured**
(`scripts/tests/chat-readonly-query-database.test.mjs` pins all three):

- A function-level `set transaction_read_only to 'on'` clause, or a `set local`
  in the body. Postgres marks the parameter `GUC_DISALLOW_IN_FUNC` and rejects
  both: `parameter "transaction_read_only" cannot be set locally in functions`.
- Declaring the function **`STABLE`**, since PostgREST runs a STABLE function in
  a read-only transaction. This is the one to know about, because it reads as
  the safer declaration and is not: SPI's non-volatile guard is **per function**,
  so a nested VOLATILE function still wrote the row in test, and a non-volatile
  function may not run `set local statement_timeout` at all — which would
  silently drop the 30s query budget as well. The function must stay `VOLATILE`;
  `verify_v2_schema.sql` fails CRITICAL if it does not.

**Scope, so nobody reads more into it than it earns:** this stops WRITES. It
does not allowlist which functions may be called, and it does not stop a
function that writes outside transactional visibility (dblink, an untrusted PL
opening its own connection). No such function is reachable from
`authenticated` today. An allowlist would be the stronger boundary and is
deliberately not attempted, since it would have to enumerate every function
every legitimate report already calls.

**`silo_chat_audit_log.request_id`** gives one chat request an identity.
`/v2/silo-chat.html` recovers a finished answer out of this table when the
fetch dies but the edge function completed — it matched on `question` text
plus recency, and question text repeats inside a conversation ("yes", "keep
going", "now by month"). Worse, the select policy is `created_by = auth.uid()
OR is_exec_or_owner()`, so for an exec the match was not scoped to their own
rows at all. The column is nullable (pre-migration rows and cached browser tabs
have none; recovery simply does not fire for them, which is the right failure)
and deliberately **not unique** — a unique violation would fail the audit
INSERT, and the edge function now reports insert failures rather than swallowing
them, so a duplicate id must not become a user-visible error on a good answer.
`silo_chat_audit_log_v` carries an explicit column list, so `request_id` is
appended at the END (a `create or replace view` can only add columns after the
existing ones) and `verify_v2_schema.sql` checks the view, not only the table.

### 20260916140000_silo_chat_evidence_diagnostics.sql

Two traced Ask SILO answers (`silo_chat_audit_log`
`c0b642ca-3bc4-4703-be94-995cb7f0a7b9`, `7c90b2cd-84a2-4ce8-888f-a2186ba0927c`)
published correct figures under labels their SQL never supported — a week of ad
spend pooled across every platform was called one platform's spend and then
divided by that platform's own attributed value. Establishing that from the
audit log meant re-running every statement by hand against live data, which
answers what the database says *today*; marketing attribution moves, so today
is not the evidence.

`silo_chat_audit_log.diagnostics jsonb` closes that: per query, the statement,
the evidence scope derived from it, the row count, the duration and the error
text; plus which relations were in the up-front schema slice and which the
model fetched mid-request. **No result rows, ever** — a returned row is the
business data RLS exists to scope, and a second copy is a second policy to get
right; counts and shapes are what diagnose a mislabelled figure. No new table,
grant or reader: it is a column on a row that already lands through the
caller's own JWT under this table's existing select policy. Size is capped in
the edge function *before* the insert (detail shed in order, what was shed
recorded), and the function retries the insert without the column when it is
absent — so the function and this migration apply in either order. Retention is
deliberately unchanged: the table has no update or delete policy at all, and
adding a sweep here would be the first thing in it that could destroy a record.

The same file drops the Meta ad-level card's coverage sentence. It said about
seven weeks from 2026-07-08 and *do not use it for launch comps*; measured
2026-09-16 the table held 415 days back to 2025-07-28, so a true sentence had
become an instruction to avoid the history it forbade using. It is **not**
replaced with a fresher range — a hardcoded range is the defect, and the next
one ages the same way. The card now says to measure, `describe_relations` reads
min/max of the day-grain column at request time, and `verify_v2_schema.sql`
goes CRITICAL if any hardcoded range returns. `marketing_daily_totals_v`'s card
gains the fact that it carries no platform or campaign column at all.

The migration ends with `refresh_chat_schema_catalog()` — `silo_chat_audit_log`
and its view are both in the catalog and both gained a column, which
`verify_v2_schema.sql` otherwise flags as STALE. The refresh preserves the
curated descriptions set above it.
## 20260916150000 — a job_type for the Meta creative backfill

One line of schema: `meta_creative_backfill` added to the `sync_jobs.job_type`
CHECK. The interesting part is why it is its own type rather than reusing
`meta_ads_kpis`.

The nightly (`runMetaAdLevelSync`) asks Meta about creatives only for ad ids
that have **insights rows in its trailing window** (`days_back ?? 30`). That is
correct for a nightly and it is why destination coverage looked thin. Measured
2026-09-16 on Baseballism: **126 of 4,079 stored creatives had ever been asked
about**, 82 resolved a destination, and **$5,304,686 of SHARE spend sat on ads
that had never been requested at all** — not refused, never asked.

`scripts/meta-creative-backfill.mjs` (manual workflow) fills that in. It writes
no performance rows whatsoever, so folding its runs into `meta_ads_kpis` would
make "did the nightly run" unanswerable from `sync_jobs` — the same reason
`search_console_daily` was split out.

The backfill **only ever adds**: a resolved link, recovered page-post copy, or
a full row for an ad that had none. It never writes a null over a destination
the nightly already found, and never blanks copy the page-post pass recovered.
That safety rests on `ON CONFLICT DO UPDATE` touching only the columns named in
its SET list, which `meta-creative-links-database.test.mjs` proves against a
real Postgres rather than trusting to documentation.

Idempotent: `drop constraint if exists` then re-add. Verified against
production before commit that no stored `job_type` falls outside the new list,
so the `ADD CONSTRAINT` cannot fail on existing rows.

## Demand Planner candidate ledger (`20260917140000`)

Prospective forecasts for a candidate demand model, written at a cutoff and
scored only once actuals mature. Source specification: saved report
`f98754f7-47a6-4eeb-8a8b-eece9a069432` ("SILO - Demand Model Workbench"),
frozen candidate `Candidate_YoY_Shift_v1` — Youth, 30-day horizon.

It changes **nothing** in the production purchasing path. The workbench report,
its locked per-category models, `v_po_*`, `po_headers`/`po_lines` and the
existing 90/180-day logic are untouched; this is a parallel record kept so a
candidate can earn promotion instead of being adopted because a backtest
flattered it.

**Why a table rather than another saved report.** A saved report re-runs its SQL
every time it is opened, so a "forecast" held in one is a restatement: change
the rule, or let another month land, and the number a planner acted on is gone
with no trace it existed. Prospective evaluation needs the opposite — a number
written before the outcome and provably untouched after. Hence an append-only
ledger (`forecast_candidate_ledger`), a calculation that cannot read past its own
cutoff, and a scorer that refuses to grade a partial month.

Three things worth knowing before changing any of it:

- **The grain is a calendar month.** "30-day horizon" is the label kept in
  `horizon_days`; the measured window is the calendar month beginning at the
  cutoff, and `t-N` means N calendar months back. That is not a convenience — it
  is the only reading that reproduces the frozen run's three inputs exactly
  (115,699 / 59,124 / 4,297 → 7,735). A literal 30-day window does not: Jun–Aug
  2026 is 92 days.
- **Absent is not zero.** The monthly rollup emits a row only where the sync
  recorded something, so a missing month is "no data". A missing month makes a
  cutoff ineligible and writes nothing; a *recorded* 0 is data and stays 0. The
  Youth series has both, plus twelve genuinely negative months (returns
  exceeding sales), which are refused as a ratio denominator or forecast base.
- **Authorization is by GRANT, not by an in-function role check.** The engine
  functions take an explicit company id and are granted to `service_role` alone;
  the planner-facing ones are gated on `active_company_id()` and granted to
  `authenticated`. An earlier version asked
  `pg_has_role(current_user, 'service_role', 'member')` inside a SECURITY DEFINER
  function, where `current_user` is the function's **owner** — so it answered yes
  for every signed-in user. `session_user` is no better: in Supabase that is
  `authenticator`, which holds every role. `verify_v2_schema.sql` fails CRITICAL
  if that check returns.

- **A forecast cannot be written after its own outcome.** The runner still
  attempts a catch-up range — a dropped monthly run is what catch-up is for —
  but the database refuses any cutoff whose horizon has already fully synced
  (`expired`), backed by a CHECK a service-role job cannot dodge and by the
  scorer refusing to grade such a row. Without it a missed run was a licence to
  backfill retrospective evidence into a prospective ledger.
- **Voiding requires exec/owner**, not merely the same company: a void can turn
  a HOLD into a promotion recommendation by removing the cycle that broke the
  streak.
- **A forecast must be issued within a bounded lag** (`max_issuance_lag_days`,
  default 5, stored per row). One frozen on day 16 would still be scored against
  the whole month, including the half that had already elapsed. A late freeze is
  written and labelled `ISSUED LATE — NOT SCORED`, never scored. Recording the
  lag without gating on it protected nothing.

Runner: `scripts/forecast-candidate-run.mjs` via
`.github/workflows/forecast-candidate-run.yml` (monthly, the 3rd — not the 1st,
because a cutoff may only be frozen once the source has synced through the day
before it). Re-running is a no-op on any frozen cutoff: the writer returns the
existing row **without recomputing**.

Retrospective score: `scripts/forecast-candidate-backtest.mjs` /
`scripts/sql/forecast_candidate_backtest.sql`. It writes nothing, and its number
is not prospective performance — see `docs/ops/demand-candidate-yoy-shift.md`.

Tests: `scripts/tests/forecast-candidate.test.mjs` (unit) and
`scripts/tests/forecast-candidate-database.test.mjs` (real PostgreSQL via
PGlite, with ten mutations).

## Tenant boundary hardening (2026-09-17)

`20260917210000_tenant_boundary_hardening.sql`. RLS was already complete on the
base tables; the holes were beside it. A SECURITY DEFINER function runs as its
owner and bypasses RLS, so its EXECUTE grant is the entire tenant boundary —
and Supabase's default privileges grant EXECUTE to `public` on every new
function unless revoked, so the insecure state is the default. Four functions
were reachable from a browser session, two of them cross-tenant destructive and
both confirmed callable as `anon` against a company the caller had no
relationship to. Also removes the last `coalesce(active_company_id(),
'<Baseballism>')` fallbacks from the two RPCs that grant membership.

Guard trap worth remembering: `current_user` is the OWNER inside a definer
function, so the obvious guard is inert. Use `current_setting('role', true)`.

Audit: `docs/ops/multi-tenant-audit-2026-09.md`.
Onboarding: `docs/ops/new-client-onboarding.md`.
Tests: `scripts/tests/tenant-boundary.test.mjs` (real PostgreSQL via PGlite,
five mutations) and `scripts/tests/nav-profile.test.mjs`.

## Membership self-enrollment (2026-09-18)

`20260917220000_membership_self_enrollment.sql`. `memberships_insert_self` let
any authenticated user insert `(entity_id = <any company>, user_id = self, role
= 'owner_admin')` — the WITH CHECK constrained only *who the row was about*.

Read this one together with `20260917210000`: it is not a smaller sibling of the
profiles hole, it **defeats** it. Nothing is forged. The attacker creates a real
membership row, then calls `set_active_company()` — SECURITY DEFINER, which
validates membership before writing — and it validates against the row just
created. Narrowing the profiles column privileges does not touch that path.

Nothing legitimate used the policy: every membership INSERT runs through a
SECURITY DEFINER function or the service-role client. SELECT is untouched — the
company picker and login resolve memberships from it.

Audit: `docs/ops/multi-tenant-audit-2026-09.md` (P0-5).
Tests: `scripts/tests/tenant-boundary.test.mjs`, which pins the vulnerability
*before* applying the migration so the fix assertion cannot pass vacuously.

## Forecast method competition (`20260918000000`)

*(Originally numbered `20260917200000`; renamed to avoid colliding with the
same prefix in PR #722.)*

`20260917140000` proves ONE method prospectively. This runs several against each
other and — the part that matters — records **which one was chosen, before the
cutoff it governs**.

`forecast_method_selections` is that record: one row per
(company, category, horizon, first cutoff it governs), carrying the evidence
window the choice was made from and every method's score over it, not just the
winner's. It is append-only, and

```sql
constraint fms_evidence_precedes_cutoff check (evidence_to < effective_from_cutoff)
```

is the whole point of the table. A competition where all four forecasts are
frozen but the pick is not is unfalsifiable: any winner can be named afterwards
and the ledger cannot contradict it. That is the exact failure mode a week of
retrospective testing kept producing.

The methods — `forecast_seasonal_naive_v1`, `forecast_run_rate_v1`,
`forecast_blend_v1`, plus the existing `Candidate_YoY_Shift_v1` — share one
signature and one return shape, so `forecast_for_method` dispatches on a name
and a method added later is one branch. Their parameters (3-month recent window,
12-month seasonal lookback, an even blend) are **conventional defaults fixed in
advance, not values searched against this tenant's history**. Searching them is
what produced a week of results that did not survive their own holdout.

Four things worth knowing before changing any of it:

- **The ledger's guarantee was generalised, not weakened.** Its provenance
  columns (`recent_demand`, `raw_ratio`, …) are specific to
  `Candidate_YoY_Shift_v1` and were `NOT NULL`, so no other method could be
  stored. They are nullable now — and the old no-look-ahead CHECK keyed on them
  would have passed **trivially on NULL**. So every method must record
  `inputs_through_date`, `NOT NULL`, bound by
  `forecast_ledger_inputs_precede_cutoff` to be strictly before its own cutoff.
  Method-agnostic, and inherited by anything added later without anyone
  remembering to.
- **The selection is written BEFORE the forecasts, and only the runner enforces
  that.** Nothing in the database can tell the two orderings apart — the
  evidence CHECK passes either way. `runMethodCompetition` in
  `scripts/lib/forecast-candidate-core.mjs` does it in that order and a unit
  test pins the call sequence. That is one of the very few guarantees here that
  is not a constraint.
- **The scorer and selector are service-role only.** They take an explicit
  company id and read that company's sales, and inside a SECURITY DEFINER
  function there is no way to tell a service-role caller from a user — so an
  `authenticated` grant would be a tenant leak dressed as a research tool. Users
  read the *result* through `forecast_method_selections`, whose RLS scopes it.
  `verify_v2_schema.sql` fails CRITICAL on either grant.
- **The monthly rollup is grained by LOCATION, and counting its rows as months
  is the mistake to make.** `sales_monthly_product_type_rollup_mv` is grouped by
  `(company, month, location_tag, channel, product_type)` — measured on
  production 2026-09-18, Youth carries 12 to 14 location rows in *every* month.
  So anything asking "are all six months of this window present" must collapse
  to one row per month first, or `count(distinct month_start)`. The shipped
  `forecast_yoy_shift_v1` does this with its `visible` CTE, which is why it was
  never affected; `score_forecast_methods` and the buy report did not, and would
  have scored and selected **nothing at all** in production while every test
  passed. The test fixture was one row per month and hid it. It now carries the
  real grain, and `forecast-method-competition.test.mjs` has a three-location
  regression category.
- **`record_forecast_candidate_run` is re-copied here from `20260917180000`.**
  `inputs_through_date` is `NOT NULL` and that function did not know about it, so
  without the copy the existing monthly job would have started failing on its
  next run, in production, silently until somebody read the Actions log. Copied
  from the *second* migration, not the first: the second dropped and recreated it
  to remove a tenant-specific default, and a create-or-replace cannot remove a
  default but can add one back. Both were caught by the test suite, not by
  reading.

The buy report (`scripts/sql/category_buy_forecast.sql`, saved report
`1143dcd9-f2f1-4165-a299-ec21952aa465`) reads the ledger for its `fwd_*` columns.
**Every one of them belongs to the method of the figure beside it**, joined on
that method — never pooled across a category. Two earlier versions of that block
were wrong in the same direction and are worth not repeating:

1. Pooling every frozen forecast the *selection* had named, discarding which
   method made each one. That measures how the selection procedure has
   performed — a real question, but not this one.
2. Comparing the displayed method to the *current* selection before allowing a
   proven status. That does not close it: six accurate `seasonal_naive_v1`
   cycles, then a switch to the run rate, and the displayed method and the
   current selection agree while the evidence belongs to neither.

A forward record can only belong to the method it measured. `governing_method`
is surfaced separately, because it says what the next cutoff will freeze, not
what the numbers on the row mean. Until cycles mature the `fwd_` columns are
**NULL, never 0**, and the record line names the method so "no record" is never
read as "no record of anything".

**The report's own arithmetic must equal the method it names.** Two errors found
on 2026-09-18, both by tracing the report's formulas against the shipped
functions rather than reading either alone:

- The live blend's seasonal term read `cum(nl-11+h) - cum(nl-11)` — one month
  late at both ends. With August complete and a six-month window that sums
  October–March where `forecast_blend_v1` sums September–February, so the figure
  displayed was a different calculation from the method whose forward record sat
  beside it. Correct endpoints: `cum(nl-12+h) - cum(nl-12)`. Note the BACKTEST's
  seasonal term was always right — the two disagreed with each other, which is
  the tell.
- The backtest's recent-velocity term read `cum(n) - cum(n-4)`, four months over
  three, **including month `n` — the first month of its own outcome**. Every
  error column the report publishes was computed by a forecast that had seen
  part of what it was scored against. On a flat 100-a-month history it inflated
  a 600-unit forecast to 700 and published 16.7% WAPE where the specified method
  scores 0%. Correct: `cum(n-1) - cum(n-4)`.

Both halves are now floored at zero and rounded the way the governed functions
round, and `forecast-method-competition.test.mjs` holds the report to an
EQUALITY against `forecast_blend_v1` / `forecast_run_rate_v1` on a seasonal
fixture, plus a flat-history zero-error check and a spike that a forecast issued
before it must under-call. Anything added to this report's formulas belongs in
that equality test.

`select_forecast_method` reads any already-frozen selection for its exact key
**before** scoring anything, and returns it. A selection is append-only, so
nothing computed afterwards can change it — and reaching for the scorer first
was a defect in its own right: a late deletion or source gap leaves today's
scores empty, and the empty-score path returned NULL and logged "NO SELECTION"
while the durable selection sat in the table. Reading first also makes a re-run
free.

Tests: `scripts/tests/forecast-method-competition.test.mjs` (real PostgreSQL via
PGlite, thirteen mutations, including the whole buy report run as a signed-in
user and held to an equality against the governed formulas).

## Guided company onboarding (`20260918120000`)

Founding a new tenant, invite-gated. Read the migration header first — it
records why each piece is shaped the way it is. The four decisions worth
knowing before touching this:

**The gate is `handle_new_user`, not the login form.** Company creation used to
run off an `org_name` key in the signup metadata. `signUp` is a public Supabase
Auth endpoint and the anon key ships in `pages/config.js` by design, so that key
was caller-controlled input — anyone could found a tenant. The branch is gone;
`pages/login.html` lost its organization field in the same change, but that is
cosmetic and the migration is the fix.

**`platform_admins`, not `owner_admin`.** Founding spends this project's
Supabase and Anthropic quota, so it is a platform act rather than a company one.
28 of 29 Baseballism profiles are membership `admin`; gating on `is_admin()`
would have handed company creation to nearly everyone, the same blast radius
that made `current_user_can_manage_comp_requests()` diverge from the AP gate. No
RPC adds a platform admin — it takes a migration or a service-role write.

**The redeem is idempotent, not merely atomic.** One `SECURITY DEFINER`
function makes it atomic for free. What atomicity does not cover is a committed
row with a lost response, and a user who presses the button again. The invite
stores `created_company_id`, and a repeat redeem by the same user returns that
company with `repeated = true`. The token is the idempotency key. A repeat
naming a different company still returns the original.

**A refused timezone beats a stored one nothing honours.**
`silo_business_today()` / `_yesterday()` now read
`company_settings.business_timezone` — the change 20260904280000 said was
needed. Ten further public functions and seven files under `scripts/` and `v2/`
still hardcode `America/Los_Angeles` (measured 2026-09-18), so
`supported_business_timezones` holds one row and onboarding refuses anything
else, naming what does not honour it. Finishing the sweep is an INSERT there
plus a test.

Also: `company_settings.default_currency` (declared) is reconciled against
`accounting_settings.base_currency` (measured from QuickBooks' trial balance) by
a trigger on **each** table that raises on divergence — one side alone is not an
invariant, since a trigger on `accounting_settings` never fires when only
`company_settings` is edited — the row cannot merge into
`accounting_settings`, whose `qbo_connection_id` is NOT NULL. And
`create_entity_with_owner` is dropped: it inserted membership role `'owner'`,
which the CHECK has forbidden since the multi-tenant work, so every call failed
`23514` and rolled back its own entity insert. Measured failing on production
before removal; its `verify_v2_schema.sql` anon-allowlist entry went with it.

Tests: `scripts/tests/company-onboarding-database.test.mjs` (real PostgreSQL via
PGlite, 47 assertions, thirteen mutations), which also executes the four new
`verify_v2_schema.sql` checks and then breaks each guard to confirm they can go
red.

Plus `scripts/tests/onboarding-concurrency.test.mjs`, which is a separate file
for a structural reason rather than a tidiness one: **PGlite is a single
connection.** It can prove a guard refuses a bad state, and it can never prove
that two sessions racing cannot assemble that state between them — which is the
shape of all three concurrency guarantees here (the invite row lock, the
profiles `FOR UPDATE`, the per-company currency lock). That suite drives two
real `psql` sessions and a control session reading `pg_stat_activity`, so the
block is observed in the server's own wait state rather than inferred from
timing. Measured 2026-09-18, each lock removed in turn: without the currency
lock a company commits with its books in USD under a CAD declaration; without
the profiles lock an administrator's deactivation is undone by the redeem it
raced; without the invite lock one invite founds **two** companies. CI runs it
against a `postgres:16` service and requires all three mutations to go red.

Do not add a concurrency assertion to the PGlite file. It would exercise the
sequential case and be credited as coverage of the concurrent one.


### Cycle-1 review corrections (PR #724)

Five findings, all valid, all fixed in one batch. Three are worth carrying
forward as rules rather than as changelog:

- **Founding must not write the global profile fields for a user who already
  belongs to another org.** `profiles.role`/`department` are the legacy GLOBAL
  fields, and `can_manage_journal_entries()` admits
  `p.department in ('finance','exec')` on its own — no membership check. So
  `department = 'exec'` written while founding company B is journal-entry
  authority inside company A. `accept_org_invite` already had the guard
  (`v_has_other_org`); this now matches it. Per-company authority comes from
  the membership row.
- **`create or replace` RETAINS existing grants.** Production grants `anon`
  EXECUTE on `silo_business_today()`/`_yesterday()`. Marking them SECURITY
  DEFINER would therefore have created two anon-reachable definer functions —
  and this migration's own new "Definer functions reachable by anon" check
  would have gone CRITICAL the moment it was applied. They stay INVOKER (only
  `silo_business_timezone()` needs definer rights) and lose the anon grant.
- **A fixture looser than production reports violations the database does not
  have.** `onboarding-db-bootstrap.sql` now mirrors production's real anon
  grants: kept on `can_manage_journal_entries` / `handle_new_user` /
  `is_entity_member` (all allowlisted), revoked on `active_company_id` /
  `is_exec_or_owner` / `set_active_company`. Same correction `20260918000000`'s
  fixture needed.

The two browser-side findings — `supabase-js` resolving `{ data: null, error }`
rather than throwing, and the emailed auth callbacks dropping `next` — are
covered by `v2/tests/unit/onboarding-callbacks.test.js`.


### Cycle-2 review corrections (PR #724)

Two findings, both valid, both fixed.

- **`profiles.is_active` is global too, and the cycle-1 fix stopped one column
  short.** Preserving `role`/`department` for a multi-org founder while still
  writing `is_active = true` left the same escalation in its most direct form:
  deactivation does not remove memberships, so an account disabled by company A
  could redeem a legitimate company-B founding invite and have A's
  deactivation undone — every authorization helper gates on that one column.
  A disabled account is now refused outright, and `is_active` is preserved for
  a multi-org founder as well. Refusing beats founding-without-reactivating: an
  account somebody disabled should not be acquiring tenants either, and a
  silent half-success is the harder state to reason about later.
- **Two guards are not an invariant unless they serialise.** Starting from
  declared USD with no books, one transaction can move the declaration to CAD
  and read "no books", while another inserts USD books and reads the
  still-committed USD declaration; both BEFORE triggers pass and both commit.
  Both now take `pg_advisory_xact_lock` on one shared per-company key before
  reading. The interleaving is NOT demonstrated by the suite — PGlite is
  single-connection — so the suite asserts both functions still take the lock,
  on the same key, and the migration header says plainly that the race is
  argued rather than measured.


### Third-cycle corrections (PR #724, self-directed)

The cycle-2 fixes were themselves unreviewed — the automated budget was spent
producing them — so they got an explicit adversarial pass. Five more findings,
three of which no earlier cycle had raised:

- **A guard on UPDATE only is not a guard.** `check_declared_currency_matches_books`
  fired `before update of default_currency`, so an INSERT contradicting existing
  books was accepted — and that is the state EVERY pre-migration company is in:
  `accounting_settings` already carries a currency, `company_settings` has no row,
  and this migration backfills none. The first declaration written for such a
  company is an INSERT, the one path the invariant was not watching. Now
  `before insert or update`, keyed off `TG_OP`.
- **A two-layer guard can hide its inner layer from the tests.** With the
  disabled-account refusal in place, no disabled account reaches the profile
  upsert, so the assertion about what that upsert preserves could not fail —
  coverage in name only. The inner layer is now exercised under
  `ONBOARDING_MUTATION=refusal-only-removed`, and the test runs BEFORE the
  refusal test so a mutation stripping the outer layer reaches it. Each layer
  now has a mutation that fails its own assertion.
- **Time-of-check/time-of-use on `is_active`.** The read took no lock while the
  upsert's fallback arm wrote a literal `true`, so a concurrent
  `admin_update_profile(..., is_active => false)` was undone. That is the
  unclaimed-profile branch — precisely what any admin may edit. The read is now
  `for update`.
- The refusal moved above the idempotent-retry branch, which bypassed it (no
  escalation — every helper gates on `is_active` — but the RPC should give a
  disabled account one answer).
- Advisory keys use `hashtextextended(..., 0)` like `20260912052930`'s Plaid
  locks, not `hashtext` (int4) crowding the same shared space at a quarter of
  its width.

Also removed: the expired-invite `status = 'expired'` UPDATE, which the `raise`
on the next line rolled back. It read like bookkeeping and never persisted;
expiry is derived from `expires_at` everywhere it is shown.

## Stripe: subscription billing and Connect invoicing (`20260919120000`)

`migrations/20260919120000_stripe_billing_and_connect.sql` adds two Stripe
surfaces that share a vendor and nothing else.

| | Who is the merchant | Who pays | Tables |
|---|---|---|---|
| **Billing** | SILO | the tenant company | `billing_plans`, `billing_subscriptions`, `billing_invoices` |
| **Connect** | the tenant | the tenant's own customer | `stripe_connect_accounts`, `stripe_invoice_customers`, `stripe_invoices`, `stripe_invoice_lines` |

Money on the Connect side never touches SILO's balance, and SILO stores no key
for a tenant: Connect **Standard** means the client owns the account, keeps
their own Stripe dashboard and carries their own dispute liability, and every
call is the platform secret key plus a `Stripe-Account` header.

### The five properties worth knowing before changing any of it

1. **Every table is a read-only mirror.** There is no INSERT/UPDATE/DELETE
   policy on any of them and no write grant to `authenticated`. Rows arrive
   only through the SECURITY DEFINER `stripe_sync_*` functions, called by an
   edge function from an object Stripe returned. A client-writable row would be
   an invoice SILO claims to have sent and Stripe has never heard of — the same
   stance Card Coding takes toward QuickBooks.
2. **The two surfaces cannot be crossed.** `stripe_resolve_event_company()` is
   the single definition of who owns a webhook: connect events resolve by
   account id, platform events by customer id, and a *platform* event carrying
   an account id **raises** rather than being attributed (that is what crossed
   endpoint secrets look like, and attributing it would file a tenant's own
   sales as SILO revenue). A composite FK to
   `(company_entity_id, stripe_account_id)` makes an invoice that names one
   company and another's Stripe account unrepresentable.
3. **An older fetch never overwrites a newer one.** Stripe does not order
   webhooks. Each sync stamps `stripe_synced_at` with the time of the *fetch*
   and returns early on anything older; the `stripe_drop_stale_sync` BEFORE
   UPDATE trigger repeats the test for a writer going round the functions (the
   service role bypasses RLS, so a policy could not be that backstop).
4. **A retried create does not invoice a customer twice.**
   `stripe_invoice_requests` records a caller-minted `request_id` *before*
   Stripe is called; a repeat returns the first attempt's object. Stripe's own
   `Idempotency-Key` is sent too, but it only covers a retry that reuses the
   key — not the reload that mints a fresh uuid, which is the retry that
   actually happens. Same mechanism as `platform_invites.created_company_id`.
5. **`can_manage_client_invoices()` is deliberately narrower than
   `is_admin_user()`** — owner_admin, profile owner, or department
   finance/exec. 28 of 29 Baseballism profiles are membership `admin`; reusing
   the common gate would let nearly the whole company bill real customers.
   Committing the company to a SILO plan is narrower still: the billing edge
   function requires `is_owner_admin_of_active_company()`.

### Vocabularies

Stripe-owned status columns (`stripe_invoices.status`,
`billing_subscriptions.status`) carry **no CHECK constraint**. Stripe can add a
value at any time and a CHECK would then refuse the sync, freezing the mirror
on the previous state while Stripe moved on. SILO-owned vocabularies
(`billing_plans.billing_interval`, `stripe_webhook_events.status`,
`stripe_invoice_requests.action`) keep theirs.

Amounts are **integer minor units** with the currency beside them, as Stripe
sends them — `numeric(14,2)` would add a rounding step at every boundary and is
simply wrong for zero-decimal currencies (JPY `500` is ¥500, not ¥5.00). Both
pages format via `Intl`, which knows each currency's exponent.

### Deploying

The migration alone does nothing: four edge functions (`stripe-webhook`,
`stripe-billing`, `stripe-connect`, `stripe-invoice`) and four secrets are
required, and two Stripe webhook endpoints have to be registered. See
[docs/ops/stripe.md](../docs/ops/stripe.md).

Regressions: `scripts/tests/stripe-billing-database.test.mjs` (42 assertions,
eight mutations) and `scripts/tests/stripe-edge-logic.test.mjs`, both in
`sync-tests.yml`.

## Customer accounts — `20260919140000_customer_account_onboarding.sql`

SILO's first **native customer master**. The four customer-shaped things that
existed before it are all mirrors or the wrong party: `ar_customers` is derived
from a Google Sheet by name and has no address or tax fields, `quickbooks_customers`
and `stripe_invoice_customers` are read-only mirrors with no client write policy,
and `factories` is the supplier directory. The accounting foundation has a chart
of accounts and no parties at all.

So `customer_accounts` carries an `account_type` (`wholesale` today) rather than
being a wholesale table with a boolean, and it **links out** to all three mirrors
without ever writing into them.

Three separations are the design, and each has a mutation covering it:

- **Tax data is not directory data.** `customer_account_tax_profiles` (EIN,
  resale id, certificate path) is gated by `can_manage_client_invoices()`, while
  the directory is readable by any active member. The `customer-account-files`
  storage policy keys its `EXISTS` on the tax profile, so the certificate
  inherits the narrow gate rather than the directory's.
- **Requested terms are not approved terms.** `requested_payment_terms` is
  applicant-supplied; `approved_payment_terms` / `credit_limit` / `price_tier`
  are written only by `approve_customer_account()`.
- **"Same as" is a pointer, not a copy.** CHECK constraints bound the chain to
  `billing → shipping → business`, so no cycle is representable and
  `customer_account_addresses_resolved_v` is two joins rather than a recursive CTE.

Onboarding is public and token-gated (`customer_account_invites`, RLS deny-all,
RPC-only, like `org_invites`). The 14-day onboarding token is **consumed** at
submission, which issues a 2-hour `card_setup` continuation in the same
transaction — the link that lives in an inbox is not the link that can open a
payment-method capture.

### Deploying

The migration alone does nothing. Deploy `customer-onboarding`, **redeploy
`stripe-webhook`** (it gained `connect_setup` routing for setup-mode Checkout),
add `checkout.session.completed` and `checkout.session.expired` to the **connect**
webhook endpoint in Stripe, then uncomment the Customers row in `v2/nav-config.js`.
See [docs/ops/customer-onboarding.md](../docs/ops/customer-onboarding.md).

Regressions: `scripts/tests/customer-onboarding-database.test.mjs` (60
assertions, 13 mutations) and `scripts/tests/customer-onboarding.test.mjs` (31
scenarios, 10 mutations), both in `sync-tests.yml`.

## Workspace Settings administration — `20260920120000_workspace_settings_admin.sql`

Four SECURITY DEFINER functions behind the Workspace Settings area
(`/v2/settings-company.html`, `/v2/settings-team.html`) and Silo Admin
(`/v2/platform-admin.html`). No new tables, no new role vocabulary: the roles
are `entity_memberships`' own `owner_admin` / `admin` / `member` / `viewer`.

- **`set_workspace_member_role(user, role)`** — the reason this migration
  exists. Changing a role previously meant `admin_update_profile()`, which
  writes the **global** `profiles.role` as well as the membership. That column
  is not per-company and gates read it alone —
  `can_manage_journal_entries()` admits on `p.role` / `p.department` with no
  reference to the active company — so an admin of company B could change what
  somebody may do inside company A. This writes the membership always and the
  global profile **only when the target belongs to no other organization**, the
  same rule `accept_org_invite` and `redeem_platform_invite` already follow.
  Only an owner grants or removes `owner_admin`, and a workspace can never be
  left without one (nothing in the product could put one back). **That last
  check is check-then-act across two DIFFERENT rows** — the target membership
  is locked, the owner count is not — so this and `remove_workspace_member`
  take **one shared per-company `pg_advisory_xact_lock`** before counting, the
  same mechanism and reasoning as the per-company currency lock in
  `20260918120000`. One key across both, not one per function: self-demotion is
  allowed on purpose, so two owners can each step back with no overlapping row
  lock at all, and a per-function key would still leave "one owner demoted
  while another is removed" open. Measured rather than argued — without it, two
  real connections leave the workspace with **zero** owners.
- **`remove_workspace_member(user)`** — removing somebody from *one* workspace
  had no implementation. The nearest thing, `admin_update_profile(p_is_active
  => false)`, sets a global flag and locks the person out of every company they
  belong to. This deletes one membership, revokes their pending invite here (a
  live link in an inbox is a way straight back in), repoints their
  `active_company_id`, and deactivates only a profile left with no membership
  anywhere — which would otherwise be an "unclaimed" profile any admin of any
  company may adopt. Refuses self-removal and the last owner.
- **`set_workspace_company_name(title)`** — `entities` carries one policy,
  `entities_select_member`, and no UPDATE policy at all, so a company could not
  be renamed from the product. An UPDATE policy would be the wrong fix: RLS
  cannot scope to columns, so it would also hand the browser `entity_key` and
  `meta` (which holds `nav_profile`). A definer function writing one column is
  column-scoped by construction.
- **`platform_list_companies()`** — every tenant, for Silo Admin.
  `is_platform_admin()` only, deliberately not `is_admin_user()` (which passes
  for any membership `admin`) and not "any owner_admin". Returns operational
  facts — member and owner counts, declared settings, plan status, last
  successful sync — and no tenant business data.

Verify: the `Workspace membership administration` check in
`verify_v2_schema.sql`, which also fails if a client write grant is ever
restored on `entity_memberships` — these functions are the only write path.

Regressions: `scripts/tests/workspace-settings-database.test.mjs` (16
assertions, 7 mutations), `scripts/tests/workspace-settings.test.mjs` (7
navigation suites), and `scripts/tests/workspace-settings-concurrency.test.mjs`
(two real PostgreSQL connections; skips loudly without a server, and CI sets
`SILO_PG_REQUIRED=1` so an absent one fails rather than passing quietly). All
three in `sync-tests.yml`.

## entities: remove client UPDATE — `20260920130000_entities_update_lockdown.sql`

Found by the verify check that shipped with `20260920120000`, the first time it
ran against production. Not caused by it — the check is simply the first thing
that ever looked.

`entities` carried two permissive UPDATE policies, `entities_update_member` and
`entities_update_access`, both resolving to `is_entity_member(id)` — which has
no role filter. RLS cannot scope to columns, so **any member of a company, a
`viewer` included, could rewrite its own row entirely from the browser**:
`title`, `entity_key`, `meta`, `entity_type`.

**Bounded to the caller's own tenant.** `is_entity_member` is false for every
other company's row, and isolation everywhere else keys on
`company_entity_id`, not on anything writable here. So this is privilege
escalation *inside* a company — a viewer performing an owner's act — not a
cross-tenant read or write. It is not the `entity_memberships` hole
`20260917220000` closed, which handed out `owner_admin` of an arbitrary
company.

What it reached: `entity_key` and `meta.nav_profile` are what
`resolveNavProfile()` reads to decide **whose menu** a company is served, so a
member could serve themselves the grandfathered sidebar (no data follows —
RLS still scopes every query); `title` had just been made owner-only through
`set_workspace_company_name()`, which was the right path and not the only one;
and `entity_type` away from `'company'` breaks the caller's own company
resolution.

Nothing legitimate used the policies. Every write runs through a SECURITY
DEFINER function (`handle_new_user`, `redeem_platform_invite`,
`set_workspace_company_name`) or the service role, and neither is affected by
a policy or a grant on `authenticated`. The only client references are reads.
The grant is revoked as well as the policies dropped, so a future permissive
policy added in good faith cannot reopen it alone.

`entities_insert_active_user` is deliberately left alone — a row with no
membership can never become anyone's active company, so it is litter rather
than escalation, and narrowing INSERT is its own decision.

Regressions: `scripts/tests/entities-update-lockdown.test.mjs` (7 assertions,
2 mutations). It **builds the production policies first and asserts the hole
exists**, so closing it proves something; and because either layer alone
refuses the write, the two are pinned structurally against `pg_policy` and
`has_table_privilege` rather than through behaviour.

## Entity admin gate scoped to the entity — `20260920160000_entity_admin_gate_company_scope.sql`

Found by impersonating the newly invited BlockayOps admin against production
(2026-09-20), as the last step of the Workspace Settings acceptance walkthrough.
Operational isolation held — 0 Baseballism payment requests, POs or launches,
and `profiles` correctly returned only the two BlockayOps members — but
`entities` returned **all three tenants**.

```sql
is_owner_admin(): exists (select 1 from entity_memberships m
                          where m.user_id = auth.uid()
                            and m.role in ('owner','admin'));
```

No `entity_id` predicate. It asks "do I hold an owner/admin membership
**anywhere**" and then answers true for **every** company. `20260913054723`
diagnosed this exact root cause and fixed it for `profiles`; the function
stayed in place for everything else, and this is the rest of it.

**Two reachable consequences.** It gated `entities_select_access` through
`can_access_entity()`, so any admin could list every tenant with its
`entity_key` — disclosure of who else uses SILO, and 28 of 29 Baseballism
profiles are membership `admin`. And it was the **entire qual** of
`entities_delete_admin_only`, with DELETE still granted to `authenticated`
(`20260920130000` revoked UPDATE only).

**On the delete, precisely.** Deleting Baseballism would in fact fail: ~70
child FKs are `NO ACTION` and populated (`profiles`, `po_headers`,
`sales_by_day`), so the statement aborts atomically. That is accidental
protection, not design. A tenant founded last week has no rows in those tables
and ~70 *other* FKs are `CASCADE` — `company_settings`, `entity_memberships`,
`shopify_connections`, `billing_subscriptions`, `stripe_connect_accounts`,
every `customer_account*`. Not verified by deleting anything: entity triggers
reach `notify-slack` through `pg_net`, which is not transactional, so even a
rolled-back probe would fire.

**The same stale vocabulary fails the other way too.** Per-company roles are
`owner_admin | admin | member | viewer` since `20260714232106`, and `'owner'`
matches no production row (measured: 33 `admin`, 3 `owner_admin`, 2 `member`).
So `is_entity_admin` — correctly scoped, and the sibling policy on all four
affected tables — excluded **every owner_admin from their own company**. Both
gates are corrected to `('owner_admin','admin')`.

**What changed.** `can_access_entity()` loses the wide branch (its remaining
branches are all row-specific). The four policies built on the wide gate are
retired; each table already carried a correctly scoped `is_entity_admin(...)`
sibling, so they were pure widening duplicates — and policies are OR'd, so
fixing the function alone would not have closed it. The author/uploader clauses
on `entity_comments` and `files` are *not* duplicates and are preserved on
their own. `is_owner_admin()` is then dropped rather than corrected: a
zero-argument "am I an admin" helper cannot be scoped to a row, so the next
caller would reintroduce the hole. Scoped callers have `is_entity_admin(uuid)`;
"owner of the company I am active in" has `is_owner_admin_of_active_company()`.

**INSERT and DELETE are revoked** on `entities`. `20260920130000` revoked
UPDATE for the reason that a company is not a row a browser edits; DELETE is
the same argument with a worse outcome, and INSERT is the same argument
pointing the other way — `entities_insert_active_user` admitted any active
user, which would let a browser found a tenant outside the platform-invite flow
`20260918120000` exists to enforce. Safe because every legitimate writer is
SECURITY DEFINER and so is unaffected by a table grant (`redeem_platform_invite`,
`handle_new_user`, `set_workspace_company_name`), and no client code writes this
table at all.

Verified by `scripts/tests/entity-admin-gate-scope.test.mjs` — 12 assertions,
six mutations. The fixture builds the wide gate and all four policies before
applying the migration, and its delete assertions use a *young* tenant, because
asserting against Baseballism would pass whether or not the fix is present.
`verify_v2_schema.sql` gains **Entity admin gate is company-scoped**, confirmed
CRITICAL against production before the migration was applied.

### Canned report accuracy — 20260920075344

Updates 16 existing global report definitions in place; IDs, output aliases,
query index and private copies remain stable. Removes hidden PO-history stock
filters, separates on-hand from incoming cover, requires complete zero-sales
evidence, includes paid attribution on zero-spend days, and preserves missing
marketing measures as NULL. Sales totals use the canonical de-duplicated view;
orders use company-local date boundaries. Relative defaults are resolved by
the company-calendar parameter support in v3.

Deploy the frontend **before** applying the migration, then run the schema
verifier and `run_report_tieouts()` as the relevant tenant. Strict checks can
flag existing source/rollup staleness; they do not repair ingestion. No new
secrets, functions, policies or source-data writes. See
`docs/ops/canned-report-accuracy.md` and the isolated database test.

## Channel scope resolves from locations — `20260920190000` + `20260920180000`

Five deployed RPCs scoped themselves to the online store with a hardcoded
`location_tag = 'online'`, at seven sites (`wow_report` ×3, `wow_data_through`,
`wow_kpi_compare`, `wow_online_shop_domains`, `wow_paid_media_reality`).

**Why it is a multi-tenant bug and not a style problem.** Measured 2026-09-20
across the three live tenants: Baseballism has 27 locations (1 online, 26
retail, 1 wholesale); Test Company has 2, both retail, and **no online store at
all**; BlockayOps has no `locations` rows. So for tenants two and three the
literal matches *nothing*, every Marketing figure comes back empty, and the
page draws that as zero — indistinguishable from a bad week.

**Why there is no new table.** A first draft added a `location_channel_map`,
on the belief that nothing maintained `locations.store_type`. That is true of
the Shopify sync (it only *reads* `locations`, for id mapping) but **not of the
app**: `/v2/integrations.html`'s location mapper has always written
`store_type` from a constrained select — `online`, `retail`, `outlet`,
`pop_up`, `warehouse`, `wholesale`. A new table would have been a *second*
admin control for one fact, which is the drift being removed. `store_type`
stays the source of truth; what was missing was a named way to read it as a
channel.

Three functions do that: `silo_location_slug(text)` (the sync's `slugify()`,
previously inlined by hand in `v_marketing_mer_daily`, the ownership reports
and one tie-out), `silo_location_channel(text)` (store_type vocabulary →
channel; **NULL means unclassified**, never silently `other`) and
`silo_channel_location_tags(text)` → `text[]`.

The array return is deliberate: a set-returning function in a `WHERE` clause
carries the planner's default 1000-row estimate, the trap `wow_window()` needed
`ROWS 1` for. A STABLE scalar is evaluated once and `= any(...)` still uses the
`(company_entity_id, location_tag, day_date)` btree indexes. It is not filtered
on `is_active` — a closed store's history is still retail revenue.

**An empty channel is "not configured", never "sold nothing".**
`wow_channel_status(text)` reports `configured` plus the sold-from locations
that carry no store type at all; `/v2/wow-report.html` and the Integrations
location panel both render that instead of a zero.

**Both migrations refuse rather than guess.** `20260920190000` asserts, per
company, that the derived online set equals the set the literal matched
(verified: Baseballism `{online}` = `{online}`, the other two `{}` = `{}`), so
it cannot restate a published number. `20260920180000` rewrites the *deployed*
bodies by string replacement — the method from `20260901120000` /
`20260901140000`, because several of these have been edited in place and the
repo text is not what runs — asserting each function's site count (3,1,1,1,1)
and that every literal is a `location_tag` predicate before touching anything.

`verify_v2_schema.sql` gains a check that fails CRITICAL if the literal returns
anywhere in `public`, if any of the five stops resolving, if a `store_type` the
Integrations select offers maps to no channel, or if a resolver is
anon-reachable. Verified the check fires: the regex matches exactly those 5
functions before the fix.
## Per-tenant notification sender — `20260920190000_notification_reply_contacts.sql`

Agreed with Blake 2026-09-20. The target:

```
From:     Baseballism - SILO <notifications@get-silo.com>
Reply-To: the tenant's own contact for that kind of notification
```

**Why this could not be configuration.** All ten mail edge functions held one
global constant, `SILO_MAIL_FROM`, defaulting to
`SILO <noreply@silo-baseballism.com>` — and **nine of the ten set no `Reply-To`
at all** (only `payment-request-forward-melio` did). One env string cannot carry
one company's name on one email and another's on the next, so the sender
identity is resolved at send time from the company rather than configured.

**`resolve_notification_sender(company, purpose, actor_email)`** is the one
definition of both halves. The display name is the tenant's; the address stays
SILO's, because the From domain must be one SILO authenticates for SPF/DKIM.
`Reply-To` carries no such constraint — which is exactly why the split works.

**The fallback chain is the point**: purpose → `general_ops` → the person who
triggered the notification → an owner-admin → nothing. **Never a SILO address.**
Omitting `Reply-To` looks harmless and silently routes every reply about an
invoice to `notifications@get-silo.com`; `support@get-silo.com` is for platform
support only. `reply_to_source` records which rung answered, so the Notifications
tab can say *why* a blank row still reaches someone.

**A database function, not a `_shared/` TypeScript module.** `_shared` sits
outside each function directory and `deployment-drift-check.yml` diffs each
*deployed* function against the repo, so a cross-directory import risks showing
all ten as permanently drifted. It also puts the logic where the data already
is, and makes it testable without deploying anything.

**The resolver re-checks the caller.** It is SECURITY DEFINER, it takes a
company id, and it is granted to every authenticated user — which is an RLS
bypass unless it checks memberships itself. Without that, a member of company A
could pass company B's uuid and read B's configured reply address, and B's
owner-admin email out of the fallback. Found by the independent review on
PR #745 and reproduced against two synthetic tenants; it is the same shape as
the unscoped `is_owner_admin()` gate closed the same day in `20260920160000`.
`auth.uid()` is NULL for the service role, which is how all ten mail functions
call it, so the sending path is unaffected and only browser sessions are held to
their own memberships.

**`company_notification_contacts`** holds one address per purpose per company —
one, not a list, so a tenant-controlled group address keeps staff changes out of
SILO. Read: any active member. Write: `is_admin_user()`, matching Integrations
rather than the owner-only rename.

The From display name is **sanitised**: a company title carrying a quote, comma,
angle bracket or CRLF would otherwise split the header.

Verified by `scripts/tests/notification-sender.test.mjs` — 10 assertions, 4
mutations, all caught, including `fallback-to-silo`. `verify_v2_schema.sql`
gains **Notification sender resolves per tenant**, which fails if the resolver's
fallback can ever name a SILO domain.

## Open wholesale applications — `20260921120000_open_customer_applications.sql`

The second door into `customer_accounts`. Until now the only way in was an
emailed, email-bound, single-use invite that created the row up front; the
public page filled in a row that already existed. This adds one shareable URL
per company — `/v2/customer-onboarding.html?apply=<entity_key>` — where the
SUBMISSION creates the account.

Three things carry the safety:

- **`company_settings.open_customer_applications`, default FALSE.** A public
  endpoint that creates rows is not something every tenant should get because
  a migration ran. Invite links are unaffected by the switch.
- **A closed company and an unknown one answer identically** (no row), so the
  endpoint cannot be used to enumerate which tenants exist.
- **One live application per email per company**, exactly as the invite path
  enforces — raised as `open_duplicate` so the page can explain it rather than
  surfacing a constraint violation.

It also factors the two halves both doors share into
`apply_customer_account_payload()` (what a submitted application writes) and
`issue_customer_card_setup_token()` (the 2-hour card continuation).
`submit_customer_account` keeps its signature and behaviour and now calls
both. A second copy of those inserts would have drifted the moment either
door gained a column, and the drift would have been invisible — the same
reasoning as `card_coding_effective_lines`.

`customer_accounts.source` (`invite` | `open_link`) records which door an
application came through. `created_by` cannot stand in for it: it is null for
an open submission *and* for anything a service role wrote.

Note the migration **drops and recreates `customer_accounts_v`**. It selects
`ca.*`, which expands to a fixed column list at creation time, so a view made
before `source` existed never carries it — and `create or replace` cannot fix
that, since the new column lands mid-list and a replace may only append.

## Open-form toggle — `20260921140000_open_applications_toggle.sql`

`set_open_customer_applications(boolean)` — owner-admin only, so a tenant can
publish or retract its own application form without anybody running SQL.
Owner-admin rather than `can_manage_client_invoices()`: switching it on
publishes an unauthenticated endpoint that creates rows in the company's name,
which is a different decision from issuing one customer an invite.

**It creates the `company_settings` row when there is none**, which is the
whole reason the RPC exists rather than a bare UPDATE. Baseballism has no such
row — only companies created through `/v2/company-onboarding.html` get one —
so `update company_settings set open_customer_applications = true where …`
matched zero rows and reported success, and
`peek_open_customer_application` INNER JOINs that table, so the form could
never have opened for the tenant most likely to want it.

The created row needs two columns this feature has no opinion about:

- `business_timezone` — constrained to `supported_business_timezones`, which
  holds exactly one value, so there is nothing to ask.
- `default_currency` — a DECLARED fact, guarded on both sides against
  contradicting `accounting_settings.base_currency`, which is MEASURED from a
  connected QuickBooks realm. So the RPC reads the currency **from the books
  when they exist** and falls back to USD only when they do not — the one case
  where nothing can contradict it yet. The test fixture seeds CAD books
  precisely so a hardcoded USD fails.

The toggle lives in the header card on `/v2/customers.html`, rendered only for
an owner-admin (UX; the RPC re-checks) and showing the shareable link once on.
