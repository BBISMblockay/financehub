# CLAUDE.md — SILO project guide

This file is the authoritative context for AI agents working on this repo. Read it fully before making any changes.

---

## What this is

SILO is an internal operations platform for Baseballism (a baseball-themed brand). It's a static HTML/JS frontend backed by Supabase (Postgres + Auth + Storage). The app itself has no backend server — the browser talks directly to Supabase via the JS SDK. (`server/index.mjs` is a separate Express service used only for the AR sync / Shopify pull outside the app; nothing in the browser calls it.)

**Team:** blake@baseballism.com is `owner`, most others are `admin`, and there are now `executive` and `member`-tier users too. Do not assume a fixed headcount — query `profiles` / `entity_memberships` if it matters.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML + CSS + JS (no framework) |
| Database | Supabase (Postgres) |
| Auth | Supabase Auth (email/password) |
| Storage | Supabase Storage (5 buckets — see Storage buckets below) |
| Hosting | Static file hosting (GitHub Pages or similar) |
| Data sync | GitHub Actions → Node.js scripts → Supabase |
| Config injection | `pages/config.js` sets `window.__SILO_CONFIG__` |

---

## File structure

```
/
├── index.html                 ← Site root: auth-hash router (invite/recovery links) → /v2/finance.html
├── v2/                        ← All CURRENT pages live here — build new tools here
│   ├── beacon.css             ← Design system tokens + components (DO NOT EDIT casually)
│   ├── silo-brand.css         ← Page layout, card harmonization
│   ├── beacon-mirrors-unified.css  ← Legacy component overrides
│   ├── v2-mobile.css          ← Responsive overrides
│   ├── po-workbench.css / purchasing-page-content.css / profile-page.css  ← page-family CSS
│   ├── nav-config.js          ← window.SiloNav: THE sidebar nav definition (add new links here)
│   ├── silo-chrome.js         ← Sidebar nav renderer (needs SiloNav; mount after auth)
│   ├── tool-shell.js          ← iframe wrapper for legacy tools
│   ├── v2-shell.js            ← Mobile drawer close behavior (Esc / tap-outside). NOT an auth check
│   ├── avatar.js              ← window.SiloAvatar — user avatar markup
│   ├── dept-guard.js          ← Soft redirect off finance pages for non-finance departments
│   ├── lib/supabase-js.min.js ← Local Supabase SDK copy (calendar.html + launch-calendar.html only;
│   │                            every other page loads the SDK from the jsDelivr CDN)
│   ├── hidden/                ← Parked pages, deliberately not in nav (bi-dashboard, bi-returns)
│   ├── licensing/             ← Standalone MLB licensing microsite, not linked from the app
│   └── [page].html            ← One file per tool
├── pages/
│   ├── config.js              ← window.__SILO_CONFIG__: credentials + active-company helpers
│   ├── login.html             ← Auth page (routes to /v2/finance.html after login)
│   ├── set-password.html      ← Password set/reset landing
│   ├── review.html            ← PUBLIC review portal (token = the authorization)
│   ├── embed.js               ← Loaded by iframe tool pages
│   ├── po-costing-lib.js      ← Shared PO costing logic (used by v2/po-builder + v2/po-costing)
│   └── [legacy-tool].html     ← factories, wholesale, baseballismwholesale, sales-verification,
│                                product-manager — some iframed by v2 wrappers, some linked directly
├── *.html (repo root)         ← iframe TARGETS for the v2 tool-shell wrappers
│                                (buyer, checkwriter). UNAUTHENTICATED —
│                                see "Repo drift" note below.
│                                Also holds superseded originals (inventory, projections, mailroom,
│                                executive, employeehub) — see stale-file note
├── legacy/                    ← DO NOT TOUCH — old pages, kept for reference only
├── supabase/
│   ├── verify_v2_schema.sql   ← Run this to health-check the DB after any SQL changes
│   ├── apply_all_post_merge.sql ← One-shot apply for all migrations (safe to re-run)
│   ├── migrations/            ← Individual migration files (timestamped, 128 as of 2026-08)
│   ├── functions/             ← Edge function sources (manual deploy — merging a PR does NOT deploy)
│   └── seeds/                 ← Seed data SQL
├── scripts/                   ← Node.js / Python sync + backfill scripts (lib/ holds the sync cores)
├── config/silo-sources.mjs    ← Google Sheets CSV source URLs for the retired Sheets sync
├── server/                    ← Express service (ar-sync.mjs, index.mjs) — NOT used by the browser app
├── data/                      ← One-off CSV import fixtures
├── .github/workflows/         ← GitHub Actions (see "GitHub Actions / data sync" below)
├── docs/ops/                  ← Ops documentation (bugs, roadmap, changelog, runbooks)
└── silo-pitch.html            ← Product pitch deck (standalone, not part of the app, not linked)
```

---

## Config and auth

`pages/config.js` sets `window.__SILO_CONFIG__` with the real Supabase URL and anon key. This file is loaded before any page scripts.

Every v2 page reads config like this:
```js
const cfg = window.__SILO_CONFIG__ || {};
const SUPABASE_URL = cfg.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || '';
```

The Supabase client is then created with these values. If they're empty the page shows a "Missing Supabase config" error — that's intentional.

**Never hardcode credentials.** The real credentials are in `pages/config.js`. Do not embed them in HTML files.

`window.__SILO_CONFIG__` also exposes the active-company helpers used everywhere:

| Helper | Use it for |
|--------|-----------|
| `await ensureActiveCompany(db)` | **Preferred.** Resolves the active company, self-healing from `profiles.active_company_id` when `sessionStorage` is empty |
| `getActiveCompany()` | Sync read of the cached company. Returns `null` in any tab that didn't go through `login.html` |
| `withCompany(row)` / `withCompanyRows(rows)` | Stamp `company_entity_id` on insert payloads (DB trigger is the backstop) |

`getActiveCompany()` reads `sessionStorage`, which is **per-tab**, while the Supabase auth session lives in `localStorage` and survives new tabs and restarts. A user landing on a v2 page from a bookmark or deep link is fully authenticated but has no cached company — any client-side logic gated on a bare `getActiveCompany()` silently no-ops there, and it's hard to spot because RLS-only queries still work (`active_company_id()` reads the server-side column). Use `ensureActiveCompany()` wherever the result feeds a query or a write.

---

## Three page patterns — use the right one

### Pattern 1: Full Beacon shell (preferred for new tools)
Now the majority of `v2/` — 33 pages. Anything in `v2/` that loads `silo-chrome.js` but **not**
`tool-shell.js` is Pattern 1: `accounting-export`, `bi-daily-trend`, `bi-product-search`,
`bi-product-types`, `bi-sales-overview`, `bi-top-sellers`, `calendar`, `finance`, `insights`,
`integrations`, `inventory`, `launch-calendar`, `live-schedule`, `mail-intake`, `mailroom`,
`marketing-overview`, `my-review`, `planning-scenarios`, `po-builder`, `po-costing`, `po-report`,
`products`, `profile`, `projections`, `purchase_request`, `request_manager`, `returns-overview`,
`review-editor`, `review-templates`, `reviews`, `sales-verification`, `silo-chat`, `tasks`.

Asset load order (must follow exactly):
```html
<link rel="stylesheet" href="beacon.css" />
<link rel="stylesheet" href="silo-brand.css" />
<!-- page-specific <style> block if needed -->
<link rel="stylesheet" href="beacon-mirrors-unified.css" />
<link rel="stylesheet" href="v2-mobile.css" />
<script src="v2-shell.js" defer></script>
<script src="nav-config.js"></script>   <!-- REQUIRED: defines window.SiloNav -->
<script src="avatar.js"></script>       <!-- optional: sidebar/user avatars -->
<script src="silo-chrome.js"></script>
```

**`nav-config.js` must load before `silo-chrome.js`.** Without it `SiloChrome` logs
`SiloChrome: load nav-config.js before silo-chrome.js` and bails — the page renders with no sidebar at all.

Page skeleton:
```html
<body>
  <div class="silo-app" id="silo-app">
    <main class="silo-main">
      <header class="bcn-header">…</header>
      <section class="bcn-kpi-band">…</section>   <!-- optional -->
      <section class="bcn-filter-bar">…</section> <!-- optional -->
      <!-- content -->
    </main>
  </div>
</body>
```

Mount chrome after auth:
```js
window.SiloChrome.mount({
  appEl: '#silo-app',
  active: 'purchasing/po-builder',   // matches nav item key
  user: { email, role },
  crumbs: ['Purchasing', 'PO Builder'],
  supabaseClient: db,
});
```

### Pattern 2: Tool shell (iframe wrapper for legacy pages)
4 pages remain: `baseballismwholesale`, `buyer`, `checkwriter`, `wholesale`.
(`sales-verification.html` was rebuilt as Pattern 1 and is no longer a wrapper. `allocation`,
`aprio`, `cashflow`, `modelapps`, `recon`, `travel` and `wpvaccounts` were retired 2026-08-16 —
stale Google Sheets flows.)

Entire file is ~20 lines:
```html
<link rel="stylesheet" href="tool-shell.css" />
<div class="silo-app" id="silo-app">
  <main class="silo-main" data-tool='{"title":"Cash flow","src":"/cashflow.html","active":"finance/cashflow","crumbs":["Finance","Cash flow"]}'></main>
</div>
<script src="nav-config.js"></script>
<script src="silo-chrome.js"></script>
<script src="tool-shell.js"></script>
```

The `src` is a repo-root or `/pages/` HTML file. Those iframe targets are separate pages with their own
(often absent) auth — the wrapper's auth check does not protect the target's own URL.

### Pattern 3: Stub redirect (placeholder)
Only three left: `v2/employeehub.html` → `/v2/finance.html`, and `v2/product-manager.html` /
`v2/product-samples.html` → `/v2/products.html` (URL-compat shims that forward their query string).
Do not add logic to these.

---

## Design system — Beacon CSS

**Always use Beacon classes. Never invent new design patterns.**

Key classes:
```
Layout:       .silo-app  .silo-main  .silo-sidebar
Header:       .bcn-header  .bcn-header-title  .bcn-header-actions
KPI band:     .bcn-kpi-band  .bcn-kpi  .bcn-kpi-label  .bcn-kpi-value  .bcn-kpi-delta
Filter bar:   .bcn-filter-bar  .bcn-filter
Cards:        .bcn-card  .bcn-card-header  .bcn-card-header--dark  .bcn-card-body  .bcn-card-foot
Tables:       .bcn-table  .bcn-matrix-scroll  .bcn-matrix-wrap
Buttons:      .bcn-btn  .bcn-btn--primary  .bcn-btn--ghost  .bcn-btn--dark  .bcn-btn--danger
Pills:        .bcn-pill  .bcn-pill--pos  .bcn-pill--neg  .bcn-pill--accent  .bcn-pill--dark
Fields:       .bcn-field-group  .bcn-label  .bcn-field  .bcn-field--mono
Tabs:         .bcn-tabs  .bcn-tab  .bcn-tab--active
Status:       .bcn-status  .bcn-status--pos  .bcn-status--neg  .bcn-status--info
Mono text:    .bcn-mono  .bcn-num
```

CSS tokens (defined in `beacon.css`):
- `--bcn-accent` — blue, primary actions
- `--bcn-pos` — green, success/healthy
- `--bcn-neg` — red/orange, error/critical
- `--bcn-warn` — amber, warning
- `--bcn-band` — near-black, sidebar background
- `--bcn-ink` / `--bcn-ink-2` / `--bcn-ink-3` — text hierarchy

**Fonts:** `Plus Jakarta Sans` (UI) and `IBM Plex Mono` (labels, numbers, mono data). Always use IBM Plex Mono for KPI values, table numbers, and status labels.

---

## Database — Supabase

### Multi-tenant architecture

SILO supports multiple companies in one Supabase project. Isolation is enforced at the DB level.

**Key tables:**
- `entities` — company registry (`entity_type = 'company'`, `entity_key`, `title`)
- `entity_memberships` — links users to companies (`entity_id`, `user_id`, `role`)

**Key column:** `company_entity_id uuid` on all operational tables (backfilled for Baseballism; `inventory_on_hand` and `sales_by_day` deferred).

**Baseballism entity id:** `3bd934c9-4cdd-429b-9076-f8f6b45d4eb7`

**Onboarding flow (two paths):**
- **Create account** (login page signup) = founding a NEW organization: `handle_new_user` reads `org_name` from the auth metadata and provisions the `entities` row, an `owner` profile, an `owner_admin` membership, and `active_company_id` in one shot
- **Joining an existing org** is invitation-only: an admin creates an invite in `/v2/backend.html` (`create_org_invite` RPC → link `/pages/login.html?invite=TOKEN`, emailed via the `org-invite-send` edge function with manual-copy fallback); a brand-new invitee gets a "set password & join" screen (`org-invite-redeem` edge function creates the confirmed account and applies the invite — no confirmation email); an invitee with an existing account signs in and the login page redeems via `accept_org_invite`. Both paths activate the profile, apply role/department, and create the `entity_memberships` row. Tokens are sha256-hashed in `org_invites` (RLS deny-all, RPC-only), expire in 14 days, and are email-bound. Access-request approval and backend role grants also create the membership. Backend admin RPCs are scoped to the caller's active company plus unclaimed profiles (no membership anywhere)

**Active-company flow:**
1. Login calls `resolveCompany()` → reads `entity_memberships`
2. Single company → `set_active_company(entity_id)` RPC called automatically
3. Multiple companies → user routed to `/v2/company-picker.html` to pick, then RPC called
4. RPC writes `profiles.active_company_id` for the session
5. All RLS policies use `company_entity_id = active_company_id()` — only active company data visible

**RLS helper functions:**
```sql
active_company_id()                    -- reads profiles.active_company_id for auth.uid()
set_active_company(p_entity_id uuid)   -- validates membership then writes active_company_id
```

**Views:** All 30+ views in the public schema have `security_invoker = true` so RLS propagates through views, not just on base tables.

**JS pattern on every page:**
```js
const _co = await window.__SILO_CONFIG__?.ensureActiveCompany?.(db) || null;
// then on every SELECT of a company-scoped table:
if (_co?.id) query = query.eq('company_entity_id', _co.id);
```
Older pages still call the sync `getActiveCompany()`; prefer `ensureActiveCompany(db)` in new code
(see "Config and auth" for why). On inserts, wrap the payload in `withCompany()` / `withCompanyRows()`.

**Not yet isolated:** `inventory_on_hand`, `sales_by_day` — backfill deferred. These depend on Baseballism-specific Google Sheets / Better Reports sync pipelines. New companies need their own data pipeline before these tables can be partitioned.

### Role system
Roles are **per-company**: permission gates judge by `entity_memberships.role` (`owner_admin` | `admin` | `member` | `viewer`) for the caller's ACTIVE company. `profiles.role` (enum `app_role`: `owner`, `admin`, `executive`, `user`) is the legacy global role — gates fall back to it only when the user has no membership row, and the profile-level `executive` still passes exec gates everywhere.
- membership `owner_admin`/`admin` (or profile fallback `owner`/`admin`) get write access to PO tables
- `executive` (profile-level) outranks `admin`: it passes `is_admin()` and additionally gates review-template building; `owner_admin` also passes `is_exec_or_owner()`
- `member`/`viewer` (or profile `user`) are read-only on PO tables
- Performance Reviews is the one module that ignores this hierarchy on purpose: rostering and running reviews needs no admin/exec role at all — any active user can manage the reports linked to them in `employee_managers` (via `is_employee_manager()`; `employees.manager_user_id` is informational-only and is NOT the authorization source); only `is_exec_or_owner()` (Blake) sees/manages the whole company roster, and only `is_exec_or_owner()` can build templates
- Invites and backend role grants set the membership role for that org; they only touch the global profile role/department when the user belongs to no other org
- blake@baseballism.com is `owner` (membership `owner_admin`); the other 6 users are `admin`

**Important:** `profiles.role` is an ENUM, not TEXT. Always cast with `role::text` when comparing in SQL.

### Write-access functions
```sql
po_builder_can_write()   -- gates write on factories, po_headers, po_lines
po_costing_can_write()   -- gates write on po_costing, po_costing_lines
is_exec_or_owner()       -- gates review-template writes (owner, executive) and whole-company roster visibility
reviews_can_manage()     -- true for any active SILO user; per-row scoping (own reports vs. sees-everyone) lives in each policy's manager_user_id/is_exec_or_owner clause, not here
is_employee_manager(p_employee_id)  -- SECURITY DEFINER (bypasses RLS internally, like active_company_id()) so employees/employee_goals/reviews/employee_managers policies can check "is auth.uid() one of this employee's managers" without a raw EXISTS against employee_managers, which recurses into that table's own RLS
is_employee_creator(p_employee_id)  -- SECURITY DEFINER, same bypass pattern: "is auth.uid() the profiles.id recorded in employees.manager_user_id" without a raw EXISTS against employees, which employees_active_select would deny for a brand-new employee with no employee_managers link yet (self-service creation's bootstrap step)
can_manage_silo_notes()  -- is_exec_or_owner() OR a silo_chat_managers grant for the caller's active company; gates silo_chat_notes writes so Ask SILO access can be handed out without promoting someone to executive company-wide
```

The PO functions check `profiles` for `auth.uid()` and role in (`owner`, `admin`).

### Key tables

| Table | Purpose |
|-------|---------|
| `profiles` | User records (id, name, email, role, department, is_active, default_page) |
| `factories` | Supplier/factory directory (141 records) |
| `po_headers` | Purchase order headers |
| `po_lines` | PO line items |
| `po_costing` | Landed cost calculations per PO |
| `po_costing_lines` | Per-SKU costing breakdown |
| `launch_calendar` | Marketing launches |
| `launch_tasks` | Tasks per launch |
| `launch_comments` | Comments with author_name, author_email, user_id |
| `launch_assets` | Asset URLs per launch |
| `launch_channel_items` | Channel plan per launch |
| `launch_product_readiness` | SKU readiness per launch |
| `launch_system_links` | System links per launch |
| `payment_requests` | Payment/approval requests |
| `payment_request_files` | File attachments for requests |
| `payment_request_activity` | Activity log per request |
| `revenue_projections` | Monthly revenue plan by location + type |
| `revenue_projection_history` | Version history |
| `locations` | Sales channels/locations |
| `products_master` | Product catalog |
| `product_tags` | Product tagging |
| `access_requests` | Pending team access requests |
| `org_invites` | Org invite tokens (sha256-hashed, RLS deny-all, RPC-only) |
| `employees` | Performance-review roster (auto-links `profiles` by email; associates exist ONLY here, no SILO auth). `manager_user_id` is informational-only (original creator) — see `employee_managers` for who actually manages this person |
| `employee_managers` | Many-to-many manager links (an employee can have more than one manager, e.g. dual reporting) — the real authorization source for roster/review RLS |
| `review_templates` | Review question sets (exec-only writes; publish locks questions) |
| `review_template_questions` | Ordered questions: free_text, scale_1_10, single_choice, multi_choice, goals |
| `reviews` | One review per employee per cycle (draft → sent → finished; employee signature fields) |
| `review_answers` | Manager's answers per question (jsonb value) |
| `review_private_notes` | Manager notes — RLS author-only, not even exec/owner |
| `employee_goals` | Goals persist on the employee across review cycles |
| `review_access_tokens` | Hashed 30-day portal tokens — RLS deny-all, edge functions only |
| `ad_platform_connections` | Per-company ad platform credentials + sync config (google_ads / meta_ads / tiktok_ads / ga4); tokens written by OAuth callbacks or Integrations UI, read by the nightly sync. Client-side SELECT is `is_admin_user()`-gated (matches the write policy) since the row carries live OAuth tokens — same treatment as `redo_connections.webhook_secret`/`api_secret`. Edge functions always use the service-role key, unaffected either way |
| `ad_platform_oauth_states` | Single-use 10-min OAuth CSRF nonces (RLS deny-all, service-role only) |
| `marketing_kpis_daily` | Daily campaign-level marketing KPIs per company × platform × account × campaign, upserted on identity row_hash |
| `silo_chat_notes` | Ask SILO's taught knowledge, `category` = `general` (a correction/fact, e.g. "Pin of Month is a one-time monthly drop, not a restock signal") or `brand` (foundational brand identity/voice/tagline — nothing about brand is hardcoded in the edge function, so this is what makes Ask SILO's voice genuinely per-company). The `save_note` tool records it; every future chat request re-reads it into its system prompt. Read: any active company member. Write (insert/delete): `can_manage_silo_notes()` — `is_exec_or_owner()` OR a `silo_chat_managers` grant (below); shared memory needs a narrower write gate than most tables. Managed via the "Notes" button on `/v2/silo-chat.html`; `silo_chat_notes_v` for querying directly |
| `silo_chat_managers` | Per-user Ask SILO write-access grants, decoupled from `profiles.role` on purpose — promoting someone to `executive` also unlocks review-template building and whole-company roster visibility, more than "can teach Ask SILO." Granted/revoked via the "Ask SILO access" button in the profile edit dialog on `/v2/backend.html`, `is_exec_or_owner()`-gated either way. A granted user can see their own row (RLS) to self-check status; only exec/owner see the full list. `silo_chat_managers_v` for querying with names |
| `shopify_connections` | Per-company Shopify store credentials + sync config; drives `scripts/shopify-sync.mjs` and the `shopify-sync-run` edge function |
| `shopify_oauth_states` | Single-use Shopify OAuth CSRF nonces (RLS deny-all, service-role only) |
| `shopify_payouts` | Shopify Payments payouts per store — powers the Accounting Export deposit register |
| `shopify_draft_orders` | Draft orders pulled by the nightly sync |
| `sync_jobs` | Per-connection sync run log (`job_type` has a CHECK constraint — extend it when adding a job type) |
| `accounting_coa_map` | Chart-of-accounts name mapping for `/v2/accounting-export.html`, editable in the UI |
| `calendar_events` | Org Calendar manual events only (meeting/holiday/deadline/milestone; visibility company/finance/private). System dates are projected by `calendar_events_v`, not stored here |
| `product_tracker` | Product development / sample tracker rows |
| `product_sample_tracker_links` | Links sample records to tracker rows |
| `redo_connections` | Per-company Redo (returns/exchanges) API + webhook credentials. Client-side SELECT is `is_admin_user()`-gated — the row carries `webhook_secret` / `api_secret` |
| `redo_returns` | Redo return/exchange records (webhook + REST backfill). Covers only a recent slice of Shopify refund volume — see the nav-config note on `/v2/returns-overview.html` |
| `redo_return_items` | Line items per Redo return |
| `meta_ad_creatives` / `meta_ad_performance_daily` | Meta ad-level creative metadata + daily performance |
| `facebook_page_insights_daily` / `instagram_media_insights` | Meta organic insights |
| `silo_insights_digest` | Nightly AI-written briefing over the deterministic findings behind `/v2/insights.html` |
| `mail_items` | Mailroom queue (subject, sender, priority, assignee, status: open/done/archived) |
| `mail_item_files` | Attachments per mail item (`mail-item-files` storage bucket) |
| `mail_item_activity` | Activity log per mail item (status/assignment/priority changes, notifications sent) |
| `live_sessions` | TikTok Live schedule/claim board — one hourly slot per company (`unique (company_entity_id, slot_start)`); finalize stamps gross sales, $25/hr + 3% commission payout, and links the auto-created `payment_requests` row (`request_type = 'payroll_payment'`, hosts are W-2) |
| `inventory_workboard_v` | View: inventory with sell-through metrics |
| `sales_monthly_product_type_rollup_mv` | Materialized view: monthly sales rollup |
| `v_po_header_summary` | View: PO list with status |
| `v_po_costing_summary` | View: costing rollup |
| `v_po_sku_prior_cost` | View: prior landed costs per SKU |
| `v_po_open_planning_lines` | View: open PO lines for planning scenarios |
| `payment_requests_v` | View: enriched payment requests |
| `payment_request_activity_v` | View: activity with user info |
| `v_launch_po_product_lookup` | View: PO products for launch search |
| `mail_items_v` | View: mail items with assignee/submitter/processor names |
| `live_sessions_v` | View: live sessions with claimer name/email/avatar |
| `calendar_events_v` | View: `security_invoker` UNION ALL of manual events + system dates (launches, tasks, POs, AP, paydays, live slots, mail). Each branch inherits its source's RLS — no calendar-specific ACL |
| `inventory_on_hand_current_v` | View: latest inventory snapshot per SKU/location |
| `sales_velocity_by_sku_location_mv` | Materialized view: sales velocity (refreshed at the end of the Shopify sync) |
| `sales_by_day_verification_v` | View: backs `/v2/sales-verification.html` |
| `v_po_incoming_lines` / `v_po_incoming_summary` | Views: incoming PO lines/rollup |
| `v_marketing_mer_daily` | View: daily marketing efficiency ratio (spend vs revenue) |
| `silo_chat_notes_v` / `silo_chat_managers_v` | Views: Ask SILO notes and access grants with names |

### RPC functions (backend admin)
```
admin_counts()
admin_list_access_requests(p_status)
admin_list_profiles()
admin_update_profile(p_user_id, p_name, p_department, p_role, p_is_active, p_notes)
approve_access_request(p_request_id, p_department, p_role)
deny_access_request(p_request_id)
create_org_invite(p_email, p_role, p_department)
accept_org_invite(p_token)
list_org_invites()
revoke_org_invite(p_invite_id)
```

### Storage buckets
- `payment-request-files` — private, payment request attachments
- `launch-images` — public, launch workbench image uploads
- `mail-item-files` — mailroom attachments (`mail_item_files`)
- `avatars` — profile avatars
- `sample-images` — product sample / tracker images

### Edge functions
Sources live in `supabase/functions/`; deploys are manual (Supabase MCP/CLI), merging a PR does NOT deploy.
```
org-invite-send   -- emails an org invite link; caller must be admin of the invite's entity and present the raw token (JWT-auth)
org-invite-redeem -- PUBLIC (verify_jwt off): peek shows org/email for a token; redeem creates the invitee's confirmed account with their chosen password (no confirmation email — the invite proved the address) and applies the invite
review-send     -- manager sends a review: mints hashed 30-day token, status → sent, emails employee (JWT-auth)
review-portal   -- PUBLIC (verify_jwt off): token IS the auth; get/finish/renew for associates without SILO logins
review-finish   -- SILO-authenticated employee signs in-app from /v2/my-review.html (JWT-auth)
payment-request-submitted-notify -- emails the requester a receipt the moment they submit (caller must be the request's created_by; not gated by the AP manage-permission RPC since it fires from the public intake form)
payment-request-notify           -- emails the requester once AP marks a request paid; gated by current_user_can_manage_payment_requests(); also used by the manual "Resend notification" button
payment-request-forward-melio    -- emails a request's submitted invoice/document to the company's Melio bill-pay forwarding inbox (MELIO_FORWARD_EMAIL secret) for auto-scan bill drafting; gated by current_user_can_manage_payment_requests(); triggered per-request or in bulk from Request Manager
mail-item-notify -- emails the assignee when mail is routed to them, or the submitter when their item is marked done; mailroom has no manage-permission gate, so any authenticated member of the item's active company may trigger it (JWT-auth, RLS via mail_items_v enforces same-company)
google-oauth-start / google-oauth-callback -- OAuth for Google Ads AND GA4 (shared Google Cloud client, scope differs by platform param); callback stores access+refresh tokens on ad_platform_connections. Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
tiktok-oauth-start / tiktok-oauth-callback -- OAuth for TikTok Ads (TikTok for Business app). Secrets: TIKTOK_APP_ID, TIKTOK_APP_SECRET
test-ad-platform-connection -- validates an ad_platform_connections row against the live platform API (refreshing Google tokens as a side effect); with no account id configured it returns the pickable account list instead. Meta Ads has no OAuth pair — a long-lived System User token is pasted directly in the Integrations UI. Google Ads tests additionally need GOOGLE_ADS_DEVELOPER_TOKEN
silo-chat        -- Ask SILO (/v2/silo-chat.html): agentic chat over a read-only SQL tool plus the taught silo_chat_notes; brand/voice context is per-company DATA, never hardcoded here. Secret: ANTHROPIC_API_KEY
shopify-oauth-start / shopify-oauth-callback -- OAuth to connect a Shopify store; callback writes shopify_connections
shopify-sync-run -- on-demand Shopify sync trigger from the Integrations UI (same core as scripts/shopify-sync.mjs)
test-shopify-connection -- validates a shopify_connections row against the live Shopify Admin API
redo-webhook     -- PUBLIC (verify_jwt off): Redo returns/exchanges webhook receiver, authenticated by redo_connections.webhook_secret
```
**Not in this repo:** `notify-slack` is deployed and called by DB triggers
(`supabase/migrations/20260709030000_slack_po_status_accuracy.sql` hits it by URL), but its source is not
checked in. Do not assume `supabase/functions/` is the complete list of deployed functions.
Emails send via Resend from `noreply@silo-baseballism.com` (`RESEND_API_KEY` edge-function secret — separate key from the auth SMTP one). Link base URL: `SILO_SITE_URL` env or hardcoded `https://silo-baseballism.com`. Without the key, sending still works — the manager gets the link to deliver manually. `payment-request-forward-melio` additionally requires `MELIO_FORWARD_EMAIL` (the company's Melio auto-scan forwarding address, e.g. `baseballism_NNN@invoicesmelio.com`) — set as an edge-function secret, never hardcoded or exposed client-side.

### After any DB change
Always run `supabase/verify_v2_schema.sql` in the Supabase SQL Editor. All rows must show `ok`. If anything is missing, run `supabase/apply_all_post_merge.sql` then verify again.

---

## GitHub Actions / data sync

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| `shopify-sync.yml` | Daily **08:30 UTC** | Shopify API sync — sales + inventory + catalog + payouts for all connected stores, then refreshes comp summary, sales velocity MV, and inventory current MV. Moved from 11:00 UTC in 2026-08 so the "as of yesterday" date lands before morning check-ins. **Never schedule before 08:00 UTC** — in PST that is before Pacific midnight and the comp summary would anchor a partial day |
| `nightly-silo-sync.yml` | **Retired** (manual only) | Legacy Google Sheets / Better Reports import — retired 2026-07-08 after verifying Shopify covers every sales + inventory location. BR history remains in `sales_by_day` for pre-API reporting |
| `ar-sync.yml` | Manual / scheduled | AR (accounts receivable) sync |
| `ad-platforms-sync.yml` | Daily 10:30 UTC | Direct platform APIs → `marketing_kpis_daily` (Google Ads, Meta Ads, TikTok Ads, GA4 daily campaign KPIs). Per-connection tokens live on `ad_platform_connections` rows (set via `/v2/integrations.html`); Google connections additionally need the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_ADS_DEVELOPER_TOKEN` repo secrets and are skipped until those exist. Replaced the retired Supermetrics path (never went live) |

**One sync, one source of truth.** Sales and inventory come from the Shopify API via the nightly GitHub Action. There is no dual-write conflict.

Manual-only workflows (`workflow_dispatch`, no cron): `redo-backfill.yml` (Redo returns REST backfill),
`backfill-company-entity-large-tables.yml`, `mailroom-backfill.yml`, `legacy-payment-requests-import.yml`,
`one-time-sales-backfill.yml`, `diagnose-shopify-gross.yml`, `diagnose-shopify-returns.yml`.

Secrets required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (set in GitHub repo settings).
Additionally: `ANTHROPIC_API_KEY` for the insights narrative (falls back to findings-only if unset) and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_ADS_DEVELOPER_TOKEN` for Google ad-platform syncs.

---

## Conventions for new features

### Adding a new v2 page
1. Use Pattern 1 (Full Beacon shell) — copy `v2/projections.html` or `v2/tasks.html` as a starting point
2. Follow the exact asset load order from SILO-BRAND.md (`nav-config.js` before `silo-chrome.js`)
3. Mount SiloChrome after auth succeeds
4. Add the page to `NAV_ITEMS` in **`v2/nav-config.js`** (not `silo-chrome.js` — that only renders what
   `SiloNav` defines). Set `profiles` (`grandfathered` / `standard`), plus `departments` / `roles` /
   `grantTable` if the link should be gated. Nav gating is UX only — the real boundary is RLS
5. Create a stub redirect at `v2/[oldname].html` if you are replacing an existing page's URL

### Adding a new DB table
1. Write a migration file: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
2. Make it idempotent (`if not exists`, `create or replace`)
3. Enable RLS: `alter table public.tablename enable row level security`
4. Add policies (select for all authenticated, write gated by role if needed)
5. Add the table to `supabase/verify_v2_schema.sql`
6. Add the table to `supabase/apply_all_post_merge.sql`
7. Update `supabase/README.md` migration list

### JS logic
- Shared logic used by more than one page → extract to a `.js` file in `v2/` or `pages/`
- Page-specific logic → inline `<script>` at bottom of the HTML file is acceptable
- Do NOT add logic to `silo-chrome.js`, `tool-shell.js`, or `v2-shell.js` — those are framework files.
  `nav-config.js` is the exception: it's data, and adding/gating a nav link belongs there

### Error handling
Use the `bcn-status` pattern — not `alert()`. Every page should have a status element:
```html
<div class="bcn-status" id="status" hidden></div>
```
```js
function setStatus(msg, type = 'info', ms = 0) {
  const el = document.getElementById('status');
  el.className = `bcn-status bcn-status--${type}`;
  el.textContent = msg;
  el.hidden = false;
  if (ms) setTimeout(() => { el.hidden = true; }, ms);
}
```

---

## What NOT to do

- **Do not edit `legacy/` files** — they are archived, not in use
- **Do not hardcode Supabase credentials** in HTML — use `window.__SILO_CONFIG__`
- **Do not reference `profiles.app_role`** — the column does not exist; use `profiles.role::text`
- **Do not add logic to stub pages** (the 24-line redirect files) — rebuild as Pattern 1 instead
- **Do not use `alert()`** for errors — use the `bcn-status` pattern
- **Do not create new CSS variables** — use existing Beacon tokens from `beacon.css`
- **Do not push to main directly** — always use a feature branch
- **Do not build new tools at the repo root** — root `.html` files are legacy iframe targets and
  superseded originals. New pages go in `v2/`
- **Do not copy a root-level page as a starting point** — several have no auth wiring at all. Copy a
  current Pattern 1 page from `v2/` instead
- **Do not assume a nav link means a page is gated** — `nav-config.js` only controls sidebar
  visibility. Authorization is RLS

---

## Current status (as of Aug 2026)

For a change-by-change history read `docs/ops/CHANGELOG.md` — it is kept current and is more detailed
than this section.

### Modules shipped since the multi-tenant work
- **Shopify API sync** — replaced the Google Sheets / Better Reports pipeline as the sole sales +
  inventory source (`shopify_connections`, `scripts/lib/shopify-sync-core.mjs`)
- **Accounting Export** (`/v2/accounting-export.html`) — month → journal-ready entries + deposit
  register, backed by `shopify_payouts` and `accounting_coa_map`
- **Action Items & Insights** (`/v2/insights.html`) — deterministic rules engine + nightly AI briefing
- **Mailroom** (`/v2/mail-intake.html`, `/v2/mailroom.html`) — intake, routing, email notifications
- **Org Calendar** (`/v2/calendar.html`) — one time layer over launches, tasks, POs, AP, payroll,
  live slots and mail via the `security_invoker` `calendar_events_v` union
- **Task Manager** (`/v2/tasks.html`), **TikTok Live schedule** (`/v2/live-schedule.html`),
  **Products** (`/v2/products.html`, replacing the old product-manager pages)
- **Marketing** — direct ad-platform APIs (Google/Meta/TikTok/GA4) into `marketing_kpis_daily`,
  surfaced by `/v2/marketing-overview.html`; Supermetrics was dropped before it went live
- **Integrations** (`/v2/integrations.html`) — admin-only connection management for Shopify, ad
  platforms, and Redo
- **Redo returns** — webhook + REST backfill into `redo_returns`; `/v2/returns-overview.html` exists
  but is deliberately **not** in the nav until coverage is complete
- **Ask SILO** (`/v2/silo-chat.html`) — agentic chat with taught notes (`silo_chat_notes`) and a
  dedicated access grant (`silo_chat_managers`); exec-only in the sidebar during soft launch
- **Nav profiles** (`v2/nav-config.js`) — grandfathered vs standard menus, plus department/role/grant
  gating. This replaced the hardcoded nav that used to live in `silo-chrome.js`

### Multi-tenant isolation — Phase 1 complete
DB-level company isolation is live. Users in multiple companies pick a company at login; all data reads are scoped to `profiles.active_company_id`. See `supabase/README.md` for migration details.

**Deferred:** `inventory_on_hand` and `sales_by_day` backfill, per-company sync pipelines, company switcher in sidebar.

**Attribution:** every table with a `created_by`/`changed_by` column has a `stamp_created_by`/`stamp_changed_by` BEFORE INSERT trigger (auth.uid() when not explicitly passed; service-role syncs stay null). Rows created before 2026-07-14 are unattributed and unrecoverable.

### Tools fully on Beacon shell (Pattern 1)
See the Pattern 1 list above — 33 pages. **Exception:** `v2/backend.html` is *not* on the Beacon shell
despite older notes saying so. It loads Tailwind from `cdn.tailwindcss.com` and mounts neither
`nav-config.js` nor `silo-chrome.js`. It is the only page using Tailwind; treat it as its own thing
until it is rebuilt. `v2/company-picker.html` and `v2/launch-calendar-guide.html` are also
intentionally chrome-less (pre-company-selection / standalone doc).

### Performance Reviews module (complete as of 2026-07-14)
End-to-end flow across five pages + three edge functions:
1. Exec/owner builds templates (`/v2/review-templates.html`) — publish locks questions; revise via duplicate-as-draft
2. Managers roster employees + run reviews (`/v2/reviews.html`, `/v2/review-editor.html`) — manager-scoped RLS: managers see ONLY their own roster/reviews; exec/owner see all; private notes are author-only. An employee can have more than one manager (`employee_managers`, many-to-many) — each co-manager sees them on their own roster and runs their own independent review; the roster page's Managers list lets any current co-manager add another
3. Send emails the employee a hashed 30-day token link (Resend, `noreply@silo-baseballism.com`)
4. SILO-authenticated employees view/sign in-app (`/v2/my-review.html`); associates (no SILO login) use the public portal (`/pages/review.html`) — the token is the entire authorization
5. Signing marks the review finished (immutable — sent/finished reviews cannot be deleted), locks tokens on both paths, and emails the manager
Goals persist on the employee across cycles (`employee_goals`) and surface in every review regardless of template. PDF = print stylesheet on both review views.

### Tools on tool-shell iframe (Pattern 2)
See the Pattern 2 list above. Their iframe targets live at the repo root (or `/pages/`), and most of
them are Google-Sheets-backed with no Supabase and no auth of their own.

### Repo drift to be aware of (audited 2026-08-16)
Not bugs to fix blind — context so you don't mistake leftovers for live code:
- **Retired 2026-08-16:** `accountspayable.html`, `ap-report.html` (superseded by Request Manager),
  and the `allocation` / `aprio` / `cashflow` / `modelapps` / `recon` / `travel` / `wpvaccounts` pairs
  (root target + `v2/` wrapper; stale Google Sheets flows). Their entry points went with them: the
  WPV and Travel Report nav rows, both Home links, and the Cash flow option in the profile
  default-landing-page dropdown
- **Superseded originals still sit at the repo root** with no inbound links: `inventory.html`,
  `projections.html`, `mailroom.html`, `executive.html`, `employeehub.html`. The live versions are the
  `/v2/` ones. Root `inventory.html` still renders its own pre-v2 sidebar ("Classic workbench" /
  "Executive") — that nav is dead
- **Root iframe targets are directly reachable and unauthenticated.** `buyer.html` and
  `checkwriter.html` ship no auth check of their own, so
  `https://silo-baseballism.com/checkwriter.html` loads for anyone. The v2 wrapper's auth gate does
  not cover them
- **Payroll BI was retired 2026-08-17** (`payroll.html` + `v2/hidden/payroll.html`) — a bad flow, per
  Blake. The payroll TABLES remain in Postgres and are still referenced elsewhere: `live-schedule.html`
  files host payouts as `request_type = 'payroll_payment'`, and `calendar_events_v` projects
  `payroll_import_batches.check_date` as payday events. **That calendar branch still deep-links to
  `/payroll.html`, which no longer exists** — see the note in `docs/ops/org-calendar.md`
- **`checkwriter` is kept on purpose** as an internal tool, even though it has no nav entry today and
  its wrapper's `finance/checkwriter` active id no longer exists in `nav-config.js`. Do not sweep it
  up as an orphan
- **`v2/profile.html`'s `LANDING_OPTIONS` list still offers `/finance.html` and `/ops.html`** — neither
  file exists, so picking either sets a `profiles.default_page` that 404s on next login. Pre-existing,
  left alone in the 2026-08-16 cleanup; worth fixing next time that file is open
- **Orphan CSS:** `v2/po-builder-beacon.css` and `v2/purchasing-hub-shell.css` have zero references
- **`v2/hidden/`** is parked-on-purpose (not in nav, no inbound links). **`v2/licensing/`** is a
  standalone microsite. **`config.json`** (JotForm routes) has no reader anywhere in the repo
- **Nav ids in Pattern-2 wrappers can be stale.** Several `data-tool.active` keys
  (`finance/cashflow`, `purchasing/buyer`, `ops/modelapps`, …) no longer exist in `nav-config.js`, so
  those pages highlight nothing in the sidebar

### Open roadmap items
See `docs/ops/roadmap.md` for current priorities. Key items:
- Company switcher in sidebar (without full logout)
- Finish Beacon shell migration for the remaining iframe pages
- `inventory_on_hand` / `sales_by_day` company backfill (Phase 2 multi-tenant)
- Smoke tests

Done since that file was last pruned: per-company nav menu (`v2/nav-config.js`) and insert-side
`company_entity_id` stamping (DB trigger + `withCompany()` helpers).

### Known P2 items
See `docs/ops/bugs.md`. No open P1s.
