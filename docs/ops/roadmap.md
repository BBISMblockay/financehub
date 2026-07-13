# Roadmap

Three buckets only. Check items off in PRs when done.

---

## Now (stability)

- [x] Sync architecture: one GitHub Action reads Google Sheets → injects sales + inventory (named "Shopify sync" in the Action)
- [ ] Post-merge SQL checklist on every DB PR (`verify_v2_schema.sql`)
- [x] Align `profiles.role` with `po_builder_can_write` / `po_costing_can_write` — all 7 users are `admin`, enum is `owner/admin/user`

---

## Multi-tenant (Phase 1 — complete as of 2026-06-16)

Architecture: one Supabase project, multiple companies isolated at the DB level.

- [x] `entities` table (`entity_type = 'company'`) + `entity_memberships` (user ↔ company + role)
- [x] Baseballism seeded as entity `id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'`, `entity_key = 'baseballism'`
- [x] `company_entity_id uuid` column added + backfilled on 40+ operational tables
- [x] `profiles.active_company_id` — per-session company pointer written at login
- [x] `active_company_id()` STABLE SECURITY DEFINER function — used by all RLS policies
- [x] `set_active_company(p_entity_id)` RPC — validates membership then sets `profiles.active_company_id`
- [x] RLS `*_active_*` policies on all company-scoped tables using `company_entity_id = active_company_id()`
- [x] `security_invoker = true` on all 30+ views so RLS propagates through views
- [x] Login flow: auto-picks company if one membership, routes to `/v2/company-picker.html` if multiple
- [x] `window.__SILO_CONFIG__.getActiveCompany()` / `setActiveCompany()` helpers
- [x] JS `company_entity_id` filters on all page SELECT queries
- [x] Test Company validated: all pages show zero Baseballism data when toggled to test-co

### Multi-tenant deferred (Phase 2)
- [ ] `inventory_on_hand` backfill (2.6M rows) — needs batched approach, out of scope until inventory reporting is repiped per-company
- [ ] `sales_by_day` backfill (1M rows) — same; sales sync is Baseballism-specific (Google Sheets / Better Reports). New companies need their own sync pipeline.
- [ ] Materialized views (`sales_monthly_product_type_rollup_mv`, `sales_sku_location_rollup_mv`) — cannot use `security_invoker`; blocked until sales backfill is done
- [ ] Per-company nav menu — hide Baseballism-specific sections (AR, payroll, legacy finance) when on a non-Baseballism entity → see `docs/ops/nav-profiles.md` (PR in progress)
- [x] Insert-side `company_entity_id` wiring — DB `BEFORE INSERT` trigger + `withCompany()` helpers in `pages/config.js` (no per-page patches required)
- [ ] Company switcher in the sidebar (without requiring full logout/login)
- [ ] Invite-based onboarding for new companies — today, `pages/login.html`'s "Create account" only creates a bare `auth.users` + `profiles` row; nothing creates an `access_requests` row, and nothing lets a signup declare which company it belongs to. Fine for Baseballism-only rollout (manual `profiles`/`entity_memberships` edits in Supabase Studio), but not safe once a second real company exists — an open signup form can't be trusted to self-select the right tenant. Needed before onboarding another client: an `invites` table + admin UI (Backend Hub) to generate a token scoped to company/department/role, and an accept-invite page that sets a password without ever letting the invitee choose the company.

---

## Next (v2 product)

- [ ] Finish Beacon shell migration ([SILO-BRAND.md](../../v2/SILO-BRAND.md) — fewer iframe legacy pages)
- [ ] One canonical URL per tool (`/v2/...` preferred)
- [ ] Same error/status pattern on all v2 pages

---

## Later (platform)

- [ ] Smoke tests (auth + one read per critical page)
- [ ] Sync job summary in DB or admin health page
- [ ] Retire unused `legacy/` pages after v2 parity

---

## v2 migration snapshot

| Done | In progress |
|------|-------------|
| projections, launch-calendar, profile, po-builder, planning-scenarios | inventory, finance, employeehub (custom layout) |
| | cashflow and others (iframe tool-shell) |

## Security — Deferred

### launch_task_templates RLS (P2)
Currently has overly broad INSERT/UPDATE policy. Acceptable for now (admin-only users) but must be tightened before launch module is opened to non-admin users. Scope writes to `company_entity_id = active_company_id()` and role-gate mutations.
