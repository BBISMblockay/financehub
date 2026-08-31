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
`product-concepts`, `products`, `profile`, `projections`, `purchase_request`, `request_manager`, `returns-overview`,
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

**Key column:** `company_entity_id uuid` on all operational tables, fully backfilled — including `inventory_on_hand` and `sales_by_day`, which older notes list as deferred. Verified 2026-08-25: 3,471,114/3,471,114 and 1,137,938/1,137,938 rows stamped, across 2 companies.

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

**Isolation status:** every operational table is isolated, `inventory_on_hand` and `sales_by_day` included. Both have RLS enabled with `select` and write policies scoped to `company_entity_id = active_company_id()` (verified 2026-08-25 against `pg_policies`). The backfill that older notes call deferred was completed — see `.github/workflows/backfill-company-entity-large-tables.yml`. A new company still needs its own sync pipeline to POPULATE these tables, but that is a data-availability question, not an isolation gap.

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
employee_has_open_comp_request(p_employee_id)  -- SECURITY DEFINER, same bypass pattern: "does this employee have a comp request that has actually been submitted (status <> 'draft')". Exists so employees_active_select can let a FINANCE reviewer read the one employee a queued request is about, without a raw EXISTS against comp_adjustment_requests (which would recurse into that table's RLS, which itself calls is_employee_manager back into employees). Added 2026-08-25 after impersonation testing showed finance passing the comp gate but seeing an EMPTY Finance Queue: the page renders comp_adjustment_requests_v, which INNER JOINs employees, and the view is security_invoker -- so employees' RLS ran inside it and dropped every row for a reviewer who manages nobody. It does NOT widen the review roster: an employee with no submitted comp request stays invisible to finance
is_employee_creator(p_employee_id)  -- SECURITY DEFINER, same bypass pattern: "is auth.uid() the profiles.id recorded in employees.manager_user_id" without a raw EXISTS against employees, which employees_active_select would deny for a brand-new employee with no employee_managers link yet (self-service creation's bootstrap step)
can_manage_silo_notes()  -- is_exec_or_owner() OR a silo_chat_managers grant for the caller's active company; gates silo_chat_notes writes so Ask SILO access can be handed out without promoting someone to executive company-wide
can_manage_journal_entries()  -- gates every card-coding table and the QBO post. Same population as the comp gate (membership owner_admin, or profile owner, or department finance/exec) and deliberately NOT is_admin_user(), which passes for any membership 'admin' -- 28 of 29 Baseballism profiles are membership 'admin', so that gate would let nearly the whole company post journal entries to the general ledger
normalize_merchant(text)  -- IMMUTABLE. Collapses a card descriptor to a stable merchant key: strips the processor prefix (SQ *, TST*), a '*'-introduced reference code, trailing store digits, and a trailing alphanumeric code. Stripping only trailing DIGITS is not enough and fails on the highest-volume vendor -- 'AMZN Mktp US*2A4XY9' keeps its order code, so every Amazon charge becomes its own merchant and no rule matches twice. `/v2/card-coding.html` MIRRORS this function in JS; changing one without the other silently stops rules matching, which is why verify_v2_schema.sql asserts three specific inputs rather than just the function's existence
current_user_can_manage_comp_requests()  -- NARROWER than current_user_can_manage_payment_requests() since 2026-08-25: membership owner_admin (or profile owner), or profile department finance/exec. It began as a verbatim copy of the AP gate, which passes for ANY membership 'admin' -- and 28 of 29 Baseballism profiles are membership 'admin', so that copy let nearly the whole company read and decide every comp request (salary figures included). This is the divergence the original migration anticipated. Executives keep access regardless: every policy calling it also ORs in is_exec_or_owner(). Gates who can move a comp_adjustment_requests row past 'draft'
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
| `launch_calendar` | Marketing launches. `launch_end_date` (nullable) bounds a multi-day campaign; null means a point-in-time drop. **Some older multi-day campaigns are still entered as TWO rows** (a start plus a separate "… End" / `launch_type = 'Promotion End'` row) rather than one row with an end date — those measure as two independent point launches until merged, which is a human data decision since merging discards whatever was typed on the losing row |
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
| `review_template_questions` | Ordered questions: free_text, **scale_1_4**, single_choice, multi_choice, goals. A rating question stores BOTH halves of its answer in one `review_answers.value` jsonb — `{"score": 3, "comment": "..."}` — because the score and the manager's written justification for it are one answer, not two; there is no separate comment column and adding one would split them. `scale_1_10` is legacy: nothing creates one (the builder only offers 1–4) but the kind stays in the CHECK constraint and in every renderer's `SCALE_MAX` map, because a stored score is only meaningful next to the kind that produced it and dropping it would reprint every historical 7/10 as 7/4. **The CHECK also carries `rating_scale`, which exists in no migration, no page, and no edge function in this repo and which zero rows use** — prod drift found 2026-08-27 via `pg_constraint`; preserved rather than removed, since dropping it is its own decision |
| `reviews` | One review per employee per cycle (draft → sent → finished; employee signature fields) |
| `review_answers` | Manager's answers per question (jsonb value) |
| `review_private_notes` | Manager notes — RLS author-only, not even exec/owner |
| `employee_goals` | Goals persist on the employee across review cycles. `target_date` is the goal's due date and is editable on carried-forward goals too, not only on goals created in the review being edited — before 2026-08-27 a carried goal's date was read-only text, so the only way to re-date a slipped goal was to drop it and retype it, losing its history. Every goal surface flags a past-due `open`/`carried` goal as overdue |
| `review_access_tokens` | Hashed 30-day portal tokens — RLS deny-all, edge functions only |
| `comp_adjustment_requests` | Team module phase 2: a manager's raise/bonus/promotion/equity request for one of their `employees` reports, routed to finance for review. `status` is `draft` (freely editable/deletable by the creator) → `submitted` → `in_review` → `needs_info` (kicks back to the manager, who can edit/resubmit) → `approved`/`denied`. Insert: `is_employee_manager(employee_id)` or `is_exec_or_owner()`, always as yourself (`created_by = auth.uid()`). **Self-requests are deliberately allowed** (decision 2026-08-25): rostering is self-service, so anyone can add themselves as an employee, become their own manager, and file their own raise request. Verified by impersonation, not theory. Left open on purpose at ~29 people where finance approves every request with the requester's name attached and the org chart is common knowledge -- the visibility is the control. Revisit if headcount grows or approvals stop being read closely; the fix would be one clause denying insert when the employee's `profile_id = auth.uid()`. Do not "fix" this as a bug without asking. Update: the creator only while still `draft`; `current_user_can_manage_comp_requests()` or `is_exec_or_owner()` at any stage — same "requester creates, the approving team owns the rest" boundary as `payment_requests_internal_update`. Select: the creator, the employee's manager, `is_exec_or_owner()`, or `current_user_can_manage_comp_requests()` **but only for `status <> 'draft'`** (since 2026-08-25) -- a manager's unsent draft stays private from the approving team, same as `payment_requests`. `comp_adjustment_requests_v` joins employee/requester/reviewer names and INNER JOINs `employees`, so a reader who cannot see the employee row sees no request either -- see `employee_has_open_comp_request()` |
| `comp_adjustment_request_activity` | Activity log per comp request (submission, status changes, notification sends) — same shape as `payment_request_activity`. Visibility/write inherits the parent request's own RLS via an EXISTS subquery |
| `ad_platform_connections` | Per-company ad platform credentials + sync config (google_ads / meta_ads / tiktok_ads / ga4); tokens written by OAuth callbacks or Integrations UI, read by the nightly sync. Client-side SELECT is `is_admin_user()`-gated (matches the write policy) since the row carries live OAuth tokens — same treatment as `redo_connections.webhook_secret`/`api_secret`. Edge functions always use the service-role key, unaffected either way |
| `ad_platform_oauth_states` | Single-use 10-min OAuth CSRF nonces (RLS deny-all, service-role only) |
| `marketing_kpis_daily` | Daily campaign-level marketing KPIs per company × platform × account × campaign, upserted on identity row_hash |
| `silo_chat_notes` | Ask SILO's taught knowledge, `category` = `general` (a correction/fact, e.g. "Pin of Month is a one-time monthly drop, not a restock signal") or `brand` (foundational brand identity/voice/tagline — nothing about brand is hardcoded in the edge function, so this is what makes Ask SILO's voice genuinely per-company). The `save_note` tool records it; every future chat request re-reads it into its system prompt. Read: any active company member. Write (insert/delete): `can_manage_silo_notes()` — `is_exec_or_owner()` OR a `silo_chat_managers` grant (below); shared memory needs a narrower write gate than most tables. Managed via the "Notes" button on `/v2/silo-chat.html`; `silo_chat_notes_v` for querying directly |
| `silo_chat_managers` | Per-user Ask SILO write-access grants, decoupled from `profiles.role` on purpose — promoting someone to `executive` also unlocks review-template building and whole-company roster visibility, more than "can teach Ask SILO." Granted/revoked via the "Ask SILO access" button in the profile edit dialog on `/v2/backend.html`, `is_exec_or_owner()`-gated either way. A granted user can see their own row (RLS) to self-check status; only exec/owner see the full list. `silo_chat_managers_v` for querying with names |
| `silo_chat_saved_reports` | Ask SILO answers pinned from chat via the "Save report" button on `/v2/silo-chat.html` — stores the question, the final answer, and the exact SQL (`queries_run`) that produced it, so the "Saved reports" modal can re-run that SQL through `chat_run_readonly_query` against live data at zero LLM cost (no edge-function involvement — the silo-chat function already returned `queries_run` to the client, so saving and re-running are pure client+DB). `visibility` splits the list (save dialog asks which): `'company'` (default — shared team report, read by any active company member, like notes) vs `'private'` ("My reports" — creator-only, hidden even from exec/owner, same author-only stance as `review_private_notes`; for personal daily-routine reports the company list doesn't need). Insert: any member. Update/delete: creator or `is_exec_or_owner()` (which in practice only reaches company-visible rows, since private ones aren't selectable by others). `silo_chat_saved_reports_v` joins creator name |
| `silo_chat_schema_catalog` | Ask SILO's database map — one row per public table/view/matview. `columns` (names+types) auto-generated from `pg_catalog` by `refresh_chat_schema_catalog()` (service-role only; **re-run it after any migration that changes public tables/views** — `verify_v2_schema.sql` flags staleness); `description`/`keywords` are curated business meaning, preserved across refreshes. The silo-chat edge function injects a per-question slice (full columns for the most relevant tables, one-line index for the rest) — **schema facts belong here now, never hand-typed into the edge function's prompt** (that hand-typed cheat sheet caused every column-name failure of 2026-08 and was removed). Read: authenticated. Write: nobody client-side; `is_hidden` hides credential/internal tables from the model's index (noise reduction, not security — RLS remains the boundary) |
| `silo_chat_health_v` | Per-day Ask SILO reliability scoreboard over `silo_chat_audit_log`: questions, errors, error %, forced finals at round cap, avg/p90 tool rounds, distinct users. `security_invoker` — each caller sees stats over the audit rows their RLS shows them |
| `product_concepts` | Ask SILO's product-generation branch (in testing, gated to a hardcoded tester allowlist in the `silo-chat` edge function -- see that function's comment): a chat walkthrough drafts a new product idea -- title, marketing angle/audience, suggested buy qty/factory/channels/retail-DTC split/launch timing, and the reasoning behind each -- grounded in `launch_calendar` history and `products_master` seasonality, before any PO exists. `status` is `draft` → `approved` (human sign-off) → `archived`; approving reuses `po_builder_can_write()` since it's a purchasing-adjacent decision, not a narrower gate. Insert: any active company member. Update/approve: the creator can keep editing their own draft; only `po_builder_can_write()` users can approve or edit someone else's. The concept -> PO hop is BUILT BUT DELIBERATELY NOT SURFACED (decision reaffirmed 2026-08-26): `/v2/po-builder.html` carries a complete, wired `FROM CONCEPT` path -- concept picker (approved by default, drafts optional), one-PO-one-factory guard at selection time, `suggested_size_breakdown` turned into one PO line per size, `po_lines.source_concept_id` stamped per line -- behind a `#btnFromConcept` button with a hardcoded `hidden` attribute that nothing unhides. Surfacing it is removing that one attribute; do NOT do so without asking, and do not read the finished plumbing as evidence it was meant to ship. Same stance as comp-requests being kept out of the nav until its workflow was reviewed end to end. `reference_image_urls text[]` holds inspiration/reference images the user attached in chat (uploaded client-side to the `product-concept-images` bucket, passed to the model as real image content, saved back onto the row by create/update_product_concept) -- not AI-generated art, a separate and much bigger vendor decision deliberately not built here. `resulting_po_header_id uuid references po_headers(id)` is a prep column for that later PO Builder wiring (a future additive dropdown lets a buyer pick an approved concept, pre-filling `po_name` from `title`, `factory_id` from `suggested_factory_id`, and auto-checking `is_new_product_po`, then stamping this column) -- still not written by any code: the concept->PO trace runs through the line-level `po_lines.source_concept_id` instead, which survives any title/SKU edit a buyer makes because it is a uuid. Every concept can produce a full launch brief (Loomis note, 2026-08-21), not just a qty/angle sketch: `suggested_size_breakdown`/`suggested_channel_split`/`suggested_marketing_spend`/`suggested_weekly_revenue_projection`/`suggested_email_sms_plan` (all jsonb) plus `suggested_launch_time`/`suggested_marketing_copy` (text) -- grounded in comparable launches' actual size curve, channel mix, ad-platform efficiency, and revenue shape where available, flagged as a rough estimate otherwise. Generation is two-phase to keep it fast: phase 1 drafts only the core fields (title/angle/qty/factory/channels/timing) and explicitly asks whether to build out the rest before spending more tool budget; phase 2 fills in the launch-plan fields above only once asked. `parent_concept_id uuid references product_concepts(id)` (self-referencing) supports collections -- a themed drop of a few products sharing one strategic brief (most releases are). A parent concept (`parent_concept_id` null) holds the shared angle/audience/timing/channel-split/spend/copy; a child concept (`parent_concept_id` set) holds only what's genuinely per-product (title/qty/factory/size breakdown) and inherits the rest from its parent rather than duplicating it. Each child is approved individually since `approve_product_concept` → PO Builder is inherently one-factory-one-PO; approving the parent is optional bookkeeping. `suggested_product_type` names the category in `products_master.product_type`'s own vocabulary and is what carries into `po_lines.product_type_snapshot` when a concept becomes a PO -- without it a concept loses its categorization at the first hop out of chat. **Structured brief + evidence (2026-08-25):** beyond the `suggested_*` draft fields, a concept carries a real brief -- `objective`/`primary_goal`, `historical_evidence`, `economics`, `forecast` (conservative/base/upside), `risks`, `unknowns`, `recommendation`/`next_decision` -- plus `field_evidence` jsonb classifying each important value as INPUT (user-supplied) / DATA (queried from SILO) / ASSUMPTION / RECOMMENDATION with a qualitative strength, and `provenance` recording which tables/date ranges/metrics backed each claim. `evidence_strength` is constrained to `strong`/`moderate`/`early` -- deliberately never a percentage, since a computed-looking confidence number implies precision the data does not support. `unknowns` exists so "we could not ground this" is recorded explicitly rather than being indistinguishable from "nobody filled it in". **This table always holds the CURRENT state, one row per concept** -- refinements are revisions (see `product_concept_revisions`), NOT new rows, so no query here ever needs an `is_current` filter. Note the two independent axes: `parent_concept_id` is the COLLECTION axis (sibling products), revisions are the TIME axis; a revision is never a child concept. `product_concepts_v` joins creator/approver/factory names, the resulting PO's `po_name`, the parent's `title` as `parent_title`, and a `revision_count` |
| `product_concept_revisions` | Immutable history for `product_concepts` -- one row per SUPERSEDED state, holding the full `to_jsonb()` `snapshot` of the concept as it was, its `revision_number`, the `changed_fields`/`change_summary` of the edit that replaced it, and `supersedes_revision_id` chaining to the prior revision. Written ONLY by the `record_product_concept_revision()` BEFORE UPDATE trigger on `product_concepts` (SECURITY DEFINER); the table has a select policy and **no insert/update/delete policy at all**, so no client can rewrite or erase concept history -- same function-writes-only stance as `sample_notification_log`. The trigger ignores no-op updates (and ignores `updated_at`/`current_revision_number`/`revision_note` when diffing) so a patch that changes nothing mints no revision. Set `revision_note` in the same UPDATE to caption the revision it creates. The current state is never in this table -- it is the live `product_concepts` row -- so query this only when someone explicitly asks how a concept changed. `product_concept_revisions_v` adds the concept title and author name |
| `shopify_connections` | Per-company Shopify store credentials + sync config; drives `scripts/shopify-sync.mjs` and the `shopify-sync-run` edge function |
| `shopify_oauth_states` | Single-use Shopify OAuth CSRF nonces (RLS deny-all, service-role only) |
| `shopify_payouts` | Shopify Payments payouts per store — powers the Accounting Export deposit register |
| `shopify_draft_orders` | Draft orders pulled by the nightly sync |
| `shopify_orders` | One row per Shopify order — the pre-collapse counterpart to `sales_by_day` (which flattens every order's line items into per-SKU/day aggregate rows and discards order identity/channel/customer in the process). Captures `source_name` (Shopify's raw sales-channel field — `web`, `pos`, or an app id/slug for a third-party channel like TikTok/Faire), financial/fulfillment status, customer, and order totals. Populated from the same order objects `sales_by_day` sync already fetches — no extra Shopify API calls. Plain upsert keyed on `(shop_domain, order_id)`, not a delta feed like `sales_by_day` — a row just reflects current state. Query `shopify_orders_v` for the resolved channel name; no UI yet, query via `/v2/silo-chat.html` (Ask SILO) or SQL |
| `shopify_order_lines` | Per-SKU line items within each `shopify_orders` row (quantity, price, discounts, tax, vendor, product_type) — for basket-level questions. Keyed on `(shop_domain, order_id, line_item_id)`; stale lines from an edited order are deleted before each resync |
| `shopify_channel_map` | Admin-editable `source_name → display_name` lookup per company (same pattern as `accounting_coa_map`) — Shopify's `source_name` for third-party channels is often an opaque app id/slug, not a clean "TikTok"/"Faire" string, so this needs to be hand-corrected rather than hardcoded. Read: any active company member. Write: `is_admin_user()` |
| `card_sources` | One row per card feed (Amex, Brex, Divvy, Flex, Parker, PayPal, Shopify CC) for `/v2/card-coding.html`. Holds the **balancing account** that feed settles to — chosen by a person from the pulled QBO chart, never derived from the card's name, because the chart carries `Parker` (Accounts Payable) AND `Parker Card` (Credit Card), plus three plausible Amex accounts across two types. `credit_vendor_qbo_id`/`credit_vendor_name` exist because **QuickBooks rejects a JournalEntry line on an AP/AR account unless the line carries an Entity** — and Brex/Divvy/FlexOne/Parker all settle to AP accounts here, so the vendor is configuration rather than a surprise at post time. `column_map` is the CSV header → canonical field mapping, learned once per card (every issuer exports a different shape) plus `flip_sign` for issuers that export charges as negatives. `posting_enabled` defaults **false**: a new card cannot reach the ledger by accident |
| `card_import_batches` | One CSV upload = one journal entry. `draft` → `categorized` → `approved` → `posted`/`voided`. `posting_id` links the `quickbooks_journal_postings` row. `card_import_batches_v` adds counts, the source's credit account, and the posted JE id |
| `card_transactions` | One row per CSV line. `card_name` is the issuer's card/cost centre — **filled from the cardholder's name (or email) when the export leaves it blank**, which Divvy often does. `clean_merchant` is the issuer's own normalisation (`APPLE.COM/BILL` → `Apple`), preferred over ours for the rule key because the issuer knows the merchant id behind the descriptor. The original row is kept in `raw` so a mis-mapped column is recoverable without re-exporting a statement. **`amount` is signed: positive = a charge (debits an expense), negative = a refund.** `coding_source` records how the row got its account — `rule` and `manual` are auditable claims, `ai` is a suggestion a person is expected to read (`confidence` under 0.6 is surfaced amber). RLS blocks edits once the batch is `posted`, so SILO cannot describe an entry QuickBooks does not have |
| `card_coding_rules` | Merchant → account/location/**entity**, or **card name** → the same (`match_field`). The card-name rule is what makes an internal card a coding dimension: Divvy's "Card Name" is a cost centre here (`Software`, `Supplies - HQ`, `Lease & Rent`, `COLAB`), and for a payment processor it is BETTER evidence than the merchant — `BILL.COM* WASHINGTON P` means nothing, but on the `Lease & Rent` card it is rent, and two of those rows are $102,900 and $205,800. Merchant rules outrank card-name rules (knowing the vendor is more specific than knowing which card paid); a card-name rule is only learned where every coded row on that card agrees, since a mixed card is a cost centre, not an account. Merchant rules key on `normalize_merchant(coalesce(clean_merchant, description))`. **This is the asset that accrues**: every confirmed row can be learned as a rule, so month two of a card is mostly coded before the model is asked anything. `source_id` null = applies to every card (a vendor codes the same way whichever card paid it). Conflicting codings for one merchant deliberately teach NOTHING rather than picking one |
| `quickbooks_customers` / `quickbooks_vendors` | QBO customer and vendor lists, pulled by `quickbooks-accounts-sync`. They exist because **QuickBooks rejects a JournalEntry line on an Accounts Receivable or Accounts Payable account unless the line carries an Entity** — and Baseballism codes card spend to ~26 intercompany receivables (`Sugar Hill Receivable`, `La Palma Receivable`, `Two Wrongs Receivable`, `COLAB Receivable`, `Jackie's Receivable`, `Due From LFRE/RFRE`), every one of which is an AR account. Read: any active member (names, not credentials). Write: service-role sync only |
| `sync_jobs` | Per-connection sync run log (`job_type` has a CHECK constraint — extend it when adding a job type) |
| `accounting_coa_map` | Chart-of-accounts name mapping for `/v2/accounting-export.html`, editable in the UI |
| `calendar_events` | Org Calendar manual events only (meeting/holiday/deadline/milestone; visibility company/finance/private). System dates are projected by `calendar_events_v`, not stored here |
| `product_tracker` | Product development / sample tracker rows |
| `product_samples` | Physical sample records — factory samples through the dev pipeline, and (since 2026-08-17) standalone catalog pulls via `/v2/products.html`'s Catalog tab "+ Request Sample" button (`launch_id`/`tracker_id` both nullable, no CHECK forcing either). `request_source` tags which flow created the row — `'catalog_photo_request'` for a Catalog-sourced pull (bulk/on-hand stock, e.g. a reshoot), `null` for a pipeline/pre-production sample — read by `sample-notify` to phrase the size-request notification differently per context |
| `product_sample_tracker_links` | Links sample records to tracker rows |
| `sample_notification_log` | One row per `sample-notify` send attempt (auto trigger-fired or manual "Notify now"), written only by that function's service-role client — no client insert/update/delete policy. Records which channels actually delivered (`email_sent`/`slack_sent`/`slack_dm_sent`) and, on failure, why (`*_reason`, e.g. `missing_scope`) — added after a Slack OAuth scope gap silently dropped DMs with no visible signal anywhere in the app. Backs the Samples tab's "Notification Log" button and the post-save toast that follows up on the async DB-trigger send. `sample_notification_log_v` joins in the sample's title/ref |
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
| `inventory_workboard_v` | View: inventory with sell-through metrics. **Check `velocity_matched` before trusting any qty/avg column.** The velocity join (added 20260821170000 to stop SKU-colliding products blending) requires `inventory_on_hand.product_title` to equal `sales_by_day.product_name` exactly — but those are different things: the first is Shopify's CURRENT title, the second is the AS-SOLD line-item title frozen at order time. It is a LEFT JOIN, so a title mismatch returns NULL velocity, and `coalesce(...,0)` then renders that as a hard "0 units sold" — a definite claim, and a false one — while `last_sold_date` stays NULL on the same row. Found 2026-08-27 when Ask SILO produced a slow-moving-inventory list full of products that sell fine, including one SKU split across two spellings of its own name. `velocity_matched = false` means every qty/avg on that row is a coalesce artefact meaning "unknown", not "none" — never rank or flag a row as slow-moving on it. **Fixed 20260827190000**: title match is preferred, and when the title has drifted the join falls back to SKU+location — but ONLY where that SKU has exactly one as-sold name, so a genuine collision still splits instead of blending. `velocity_source` records which path ran (`title` / `sku_fallback` / `none`). The measured damage before the fix: Shopify's #2 and #4 best sellers (Bubbles and Doubles tee 19,362 units, shorts 13,219) read as ZERO here under the drifted spelling "Doubles and Bubbles", and Ask SILO put them on a dead-stock list for an exec — then invented a "returns offset sales" story for the zeros. Verify with `scripts/sql/verify_velocity_fallback.sql`. **No longer slow, and do NOT "optimise" it again** (verified 2026-08-31 against `pg_matviews` / `pg_get_viewdef`): the note here used to say this view rebuilds the snapshot from `inventory_on_hand` (~3.47M rows, 5.2GB) per query. It does not. `inventory_on_hand_current_v` is now just `select ... from inventory_on_hand_current_mv where company_entity_id = active_company_id()` (70MB), and the velocity side is `sales_velocity_by_sku_location_v` over `sales_velocity_by_sku_location_mv` (22MB) with the same filter — so the whole chain reads ~92MB of materialised views. **The `active_company_id()` filter lives in the VIEW layer precisely because the MVs have none**, so pointing this view at `inventory_on_hand_current_mv` directly — which the stale note above invites — would silently drop tenant scoping and leak inventory across companies. Leave the layering alone. (Both MVs are refreshed at the end of the Shopify sync; a query returning 0 rows from a service-role/SQL-editor connection is `active_company_id()` returning null, not an empty view.) |
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
| `shopify_orders_v` | View: `shopify_orders` with `resolved_channel_name` joined in from `shopify_channel_map` (falls back to raw `source_name` when unmapped) |
| `launch_actuals_v` | View: what each launch actually sold vs. what it planned. Measures BOTH launch shapes — a **period** (`launch_end_date` set, e.g. a Back To School or Labor Day sale) via `units_in_period`, and a **point drop** via 30/60/90/365-day tails from `launch_date`; `units_preview` covers `[preview_start_date, launch_date)`. Resolves SKUs **only** through `linked_po_id` → `po_lines.sku_snapshot` — `launch_calendar.product_sku` is PRODUCT-level and does not match `sales_by_day`'s size-prefixed variant SKUs (0 of 2 match), so a fallback would silently report 0 units for a launch that sold well. `sku_source = null` means NOT MEASURABLE, never "sold nothing". Two caveats it documents: `pct_of_po_units_sold` is only valid for `is_new_product_po` (a restock mixes in units from earlier POs and can exceed 100% — measured 141% on one), and `expected_arrival_date` is a warehouse date, not a selling start |
| `launch_product_actuals_v` | View: the launch measurement that actually has data (~17 launches). Resolves a launch through the PRODUCTS ATTACHED to it (`launch_product_readiness`) rather than through `linked_po_id`, which is why it measures launches `launch_actuals_v` cannot. One row per launch with `units_sold`, `net_sales`, `expected_units`, `pct_of_expected_units`, and `resolution_note` / `products_resolved` — **read the note before reading the number**: a partially resolved launch is missing measurement, not selling badly (this distinction caught a 43% understatement on its first real use). Verified 2026-08-26 against Back To School 2026: 9,819 units / $216,835, all 8 products resolved |
| `launch_product_sales_v` | View: the per-product grain under `launch_product_actuals_v` — one row per attached product with its own `units_sold` / `net_sales` / `expected_units` / `pct_of_expected_units`. Use it when comparing products WITHIN a launch. Note that "best performer" is ambiguous here and has already been reported wrong once: the top product by units sold is not the top by sell-through rate (Back To School 2026 — School of Base Knocks led on units at 78% of plan, while Stuck On The Game shorts hit 97%). Name the metric |
| `launch_measurability_v` | View: per launch, can it be measured and why not. 43 of 61 launches cannot be, because nobody attached products or linked a PO — unrecoverable after the fact, since launches overlap heavily |
| `demand_coverage_by_type_v` | View: per product type, whether sales history / inventory / purchase history exist at all. The cheap "do we have the data to answer this" pre-check |
| `sales_by_product_title_daily_v` | View: sales rolled up from SKU variants to **product title**, per location per day — the rung between SKU (20,453) and product type (129) where buying decisions are actually made (4,585 titles). The one place the `sales_by_day.sku` → `products_master.sku` → `product_title` join is defined; do not hand-roll it again. 99.09% of rows join (97.9% of units); the rest keep `sales_by_day.product_name` and are flagged `title_source = 'sales_fallback'` rather than dropped. Do NOT substitute `sales_by_day.product_name` for a title — it matches `product_title` on only 83.6% of rows, so grouping by it splits one product across spellings. `'x-redo'` (Package Protection) is the Redo checkout line item, not merchandise — exclude it when ranking products |

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
- `product-concept-images` — public, Ask SILO Product Concepts reference/inspiration image uploads (in testing)

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
comp-request-notify -- DEPLOYED (v2, confirmed 2026-08-25). Two actions in one function: 'submitted' emails the active company's finance-DEPARTMENT profiles only -- deliberately narrower than who may act on the request, see the comment in the function (caller must be the request's created_by, same "requester triggers their own receipt" shape as payment-request-submitted-notify); 'decided' emails the requesting manager once finance records a status (caller must pass current_user_can_manage_comp_requests(), re-checked via a caller-scoped anon client per the payment-request-notify pattern)
sample-notify    -- PUBLIC (verify_jwt off): fired by the trg_sample_notify DB trigger (not called by the browser, except for the sample drawer's manual "Notify now" button — same public invoke) on SAMPLE_REQUESTED / SAMPLE_RECEIVED / SAMPLE_WAREHOUSE_READY / SAMPLE_SIZE_REQUEST / SAMPLE_ASSIGNED. When product_samples.assigned_to is set, emails + Slack-DMs that one person directly (DM via SLACK_BOT_TOKEN — users.lookupByEmail on their SILO email, then conversations.open + chat.postMessage; silently skipped if the token is unset or their email isn't in the Slack workspace); otherwise falls back to emailing the active company's logistics-department members (via RESEND_API_KEY). Also posts to the separate #samples-channel webhook if SLACK_SAMPLES_WEBHOOK_URL is set, regardless of assignee — both Slack paths are optional and skipped silently if unset, same as email without RESEND_API_KEY. Phrases the requested/size-request message differently when product_samples.request_source = 'catalog_photo_request' (names the requester, calls out "photo samples from bulk/on-hand inventory") vs a plain pipeline sample
google-oauth-start / google-oauth-callback -- OAuth for Google Ads AND GA4 (shared Google Cloud client, scope differs by platform param); callback stores access+refresh tokens on ad_platform_connections. Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
tiktok-oauth-start / tiktok-oauth-callback -- OAuth for TikTok Ads (TikTok for Business app). Secrets: TIKTOK_APP_ID, TIKTOK_APP_SECRET
test-ad-platform-connection -- validates an ad_platform_connections row against the live platform API (refreshing Google tokens as a side effect); with no account id configured it returns the pickable account list instead. Meta Ads has no OAuth pair — a long-lived System User token is pasted directly in the Integrations UI. Google Ads tests additionally need GOOGLE_ADS_DEVELOPER_TOKEN
silo-chat        -- Ask SILO (/v2/silo-chat.html): agentic chat over a read-only SQL tool plus the taught silo_chat_notes; brand/voice context is per-company DATA, never hardcoded here. Secret: ANTHROPIC_API_KEY. Also carries Product Concepts (create/update/approve_product_concept, writing to product_concepts) -- Ask SILO's product-generation branch, still gated to a hardcoded PRODUCT_CONCEPT_TESTERS email allowlist in-function (and a matching client-side check unhiding the suggested-question chip + reference-image attach button on silo-chat.html) while it's tested; remove both gates, not widen them, once it ships to everyone. History entries can carry an `imageUrls` field (public URLs already uploaded client-side to `product-concept-images`) that the function turns into real Anthropic image content blocks -- no fetch/base64 tool needed since the bucket is public. Concept refinement is a REVISION of the existing row (`update_product_concept`), never a second stamped concept -- a DB trigger snapshots the prior state into `product_concept_revisions`, so repeated refinement no longer scatters one idea across several rows. The response carries an additive `concepts` array of the rows touched that turn, which `/v2/silo-chat.html` renders as a structured card (header/exec read/key numbers/why-SILO-thinks-this/risks/recommendation/next decision) with evidence badges; a non-concept question omits the field entirely and general chat behavior is unchanged. **Two budgets bound a request, and they are different things.** Per QUERY: `chat_run_readonly_query` enforces a 30s statement timeout (raised from 10s in 20260826100000 — phase-2 grounding queries were dying at 10s and being recorded as `unknowns`, which is why `economics`/`forecast` sat empty on 18 concepts). Per REQUEST: the agent loop stops starting new tool rounds at 95s (`WALL_CLOCK_BUDGET_MS`) and skips the max_tokens continuation past 125s, because Supabase's edge gateway kills the request at 150s with a bare 504 — and a killed request never writes an audit row, so the failure is INVISIBLE in `silo_chat_health_v`. `MAX_TOOL_ROUNDS = 20` does not bound time; the old 10s statement timeout had been acting as an accidental wall-clock governor, and raising it removed that governor. A deadline stop is not an error: it takes the same forced-answer path as the round cap and logs which limit stopped it, so wall-clock saturation and round-cap saturation stay distinguishable
card-categorize  -- suggests a QBO account/location for card rows no learned rule answered. The CALLER applies its rules first and sends only the leftovers, keyed by normalised merchant, so a file with 400 Amazon charges asks about "amzn mktp us" once. Offered only the codeable account types (Expense/COGS/Fixed Asset/Other Current Asset) -- handing it all 450 accounts invites expensing a purchase to a revenue account. A returned account name not in the chart is dropped to "no account" with the invented name quoted, never passed through. Secret: ANTHROPIC_API_KEY. Finance-gated
quickbooks-post-journal -- THE ONLY WRITE PATH TO QUICKBOOKS. Posts a coded card batch as a JournalEntry. Rebuilds the entry from `card_transactions` rather than trusting the browser; requires batch status 'approved' AND `card_sources.posting_enabled`; re-checks permission through the CALLER's token (`can_manage_journal_entries` via an anon client) rather than a check it writes itself while holding service-role. **It inserts the 'posted' row in `quickbooks_journal_postings` BEFORE calling Intuit** -- the partial unique index on (company, source, source_ref) means a concurrent second call loses the race rather than both reaching Intuit and creating two entries; a subsequent failure flips that row to 'failed' so a fixed batch can be retried. After Intuit accepts, the entry is READ BACK and compared on line count and both totals, recorded in `readback_matches` -- "Intuit returned 200" is not the same as "the books hold what we meant"
shopify-oauth-start / shopify-oauth-callback -- OAuth to connect a Shopify store; callback writes shopify_connections
shopify-sync-run -- on-demand Shopify sync trigger from the Integrations UI (same core as scripts/shopify-sync.mjs)
test-shopify-connection -- validates a shopify_connections row against the live Shopify Admin API
redo-webhook     -- PUBLIC (verify_jwt off): Redo returns/exchanges webhook receiver, authenticated by redo_connections.webhook_secret
```
**Not in this repo:** `notify-slack` is deployed and called by DB triggers
(`supabase/migrations/20260709030000_slack_po_status_accuracy.sql` hits it by URL), but its source is not
checked in. **Also not in this repo, found 2026-08-17 while building sample-notify:** the trigger function
`notify_slack_sample_created()` (fires on every `product_samples` INSERT, posts `type: 'SAMPLE_CREATED'` to
`notify-slack`) has no matching migration file — applied directly to prod like `notify-slack` itself, discovered
only via `pg_get_functiondef`, not by reading this repo. **Also found in the same pass:** the deployed function
list includes `bright-action`, `replace-product-tags`, and `oneoff-meta-sync` — none documented here, none with
an obvious source file in `supabase/functions/`. Do not assume `supabase/functions/` is the complete list of
deployed functions, and when working on any table that already has triggers, check `pg_trigger` /
`pg_get_functiondef` directly rather than grepping migrations — a grep-only search missed
`notify_slack_sample_created()` here and nearly caused sample-notify to double-post to Slack on every new sample.
Emails send via Resend from `noreply@silo-baseballism.com` (`RESEND_API_KEY` edge-function secret — separate key from the auth SMTP one). Link base URL: `SILO_SITE_URL` env or hardcoded `https://silo-baseballism.com`. Without the key, sending still works — the manager gets the link to deliver manually. `payment-request-forward-melio` additionally requires `MELIO_FORWARD_EMAIL` (the company's Melio auto-scan forwarding address, e.g. `baseballism_NNN@invoicesmelio.com`) — set as an edge-function secret, never hardcoded or exposed client-side. `sample-notify` additionally reads `SLACK_SAMPLES_WEBHOOK_URL` (a Slack Incoming Webhook URL, for the shared #samples-channel post) and `SLACK_BOT_TOKEN` (a Slack bot token with `users:read.email` + `im:write` + `chat:write` scopes, for per-assignee DMs) — both optional and independent of each other; neither is configured as of this writing, so Slack delivery is currently a no-op until someone creates the webhook/app and sets the secrets. Email delivery does not depend on either.

### After any DB change
Always run `supabase/verify_v2_schema.sql` in the Supabase SQL Editor. All rows must show `ok`. If anything is missing, run `supabase/apply_all_post_merge.sql` then verify again.

---

## GitHub Actions / data sync

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| `shopify-sync.yml` | **08:30 UTC** (full) + **14:30 UTC** (sales catch-up) | Shopify API sync — sales + inventory + catalog + payouts for all connected stores, then refreshes comp summary, sales velocity MV, and inventory current MV. Moved from 11:00 UTC in 2026-08 so the "as of yesterday" date lands before morning check-ins. **Never schedule before 08:00 UTC** — in PST that is before Pacific midnight and the comp summary would anchor a partial day. The 14:30 UTC entry is a catch-up added 2026-08-27 after GitHub silently DROPPED that day's 08:30 run (scheduled triggers are best-effort, and a dropped run leaves no trace in the Actions list — it just never appears). It skips catalog/sessions/landing-pages/discount-codes via `github.event.schedule` and does sales + inventory only; there is deliberately NO `concurrency` group -- one was tried the same day and removed within the hour, because `cancel-in-progress: false` QUEUES a newly-arrived run and a queued run is cancelled the moment another enters the group, so the group can silently kill a scheduled nightly (the exact failure the catch-up exists to prevent) and it did kill a manual run mid-sales. The crons are 6h apart against a ~75min run, so they cannot collide on their own, and every write in the sync is an idempotent upsert |
| `nightly-silo-sync.yml` | **Retired** (manual only) | Legacy Google Sheets / Better Reports import — retired 2026-07-08 after verifying Shopify covers every sales + inventory location. BR history remains in `sales_by_day` for pre-API reporting |
| `sales-freshness-check.yml` | 11:00 / 17:00 / 23:00 UTC | Independent alarm for "a nightly sync did not run". Checks BOTH feeds — `sales_by_day` (via `shopify_connections`) and `marketing_kpis_daily` (via `ad_platform_connections`) — because on 2026-08-27 GitHub dropped `shopify-sync` AND `ad-platforms-sync` on the same morning; checking only sales would have left Meta quietly ~4.5h short on its most recent day. Queries the newest `day_date` per company per feed, and FAILS the run if it is more than `MAX_LAG_DAYS` (default 1) behind the last complete **Pacific** day. **It SELF-HEALS, it does not just alert**: on finding a feed stale it runs that feed's sync INLINE in its own job, then re-checks and only fails if still behind — an alarm alone just moves the firefighting earlier, and the point is that nobody runs a fix on the morning of a meeting. Inline rather than dispatching the other workflow because GitHub blocks workflows triggered by the built-in `GITHUB_TOKEN` from starting new workflow runs (recursion guard); dispatching would need a PAT, a new long-lived credential, while running the same script here needs only the Supabase secrets it already has. When it does fail, reporting is the exit code — a failed Actions run emails the repo owner, so there is no extra secret or webhook to configure or let rot. **It is deliberately a separate workflow, not a step in `shopify-sync.yml`**: a check inside the sync cannot detect a dropped sync, because a dropped sync never reaches the check. That is exactly what happened 2026-08-27. Lag 1 is HEALTHY (sales are only ever complete through yesterday); 2 means a nightly was missed |
| `ar-sync.yml` | Manual / scheduled | AR (accounts receivable) sync |
| `ad-platforms-sync.yml` | **10:30 UTC** + **16:30 UTC** (catch-up) | Direct platform APIs → `marketing_kpis_daily` (Google Ads, Meta Ads, TikTok Ads, GA4 daily campaign KPIs). Per-connection tokens live on `ad_platform_connections` rows (set via `/v2/integrations.html`); Google connections additionally need the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_ADS_DEVELOPER_TOKEN` repo secrets and are skipped until those exist. Replaced the retired Supermetrics path (never went live) |

**One sync, one source of truth.** Sales and inventory come from the Shopify API via the nightly GitHub Action. There is no dual-write conflict.

Manual-only workflows (`workflow_dispatch`, no cron): `redo-backfill.yml` (Redo returns REST backfill),
`shopify-orders-backfill.yml` (historical `shopify_orders`/`shopify_order_lines` backfill — order facts
only, no `sales_by_day` involvement, idempotent per range; the nightly sync only covers orders touched in
its ~2-day window going forward), `backfill-company-entity-large-tables.yml`, `mailroom-backfill.yml`,
`legacy-payment-requests-import.yml`, `one-time-sales-backfill.yml`, `diagnose-shopify-gross.yml`,
`diagnose-shopify-returns.yml`.

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
8. **If you applied it straight to prod (Supabase MCP/CLI), open the PR in the
   same session.** Prod must never sit ahead of `main` with the repo record
   parked on an unmerged branch — that is the same drift as an undeployed edge
   function, just pointing the other way, and it is worse: rebuilding from
   `apply_all_post_merge.sql` on `main` would produce a database missing an
   object that exists in production. Applying directly is fine (a view or an
   additive column is reversible); leaving it unPRed is not.

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
- **Compensation Requests** (`/v2/comp-requests.html`) — Team module phase 2, on top of Performance
  Reviews' `employees`/`employee_managers` roster: a manager requests a raise/bonus/promotion/equity
  change for a report, routed to finance for review/decision (`comp_adjustment_requests`, same
  approval boundary as `payment_requests`). **In the nav as of 2026-08-25**, alongside the
  Performance Reviews rollout
- **Card Coding** (`/v2/card-coding.html`) — upload a card CSV, code it, post the entry. Replaces a spreadsheet tab per card per month hand-fed to a SaaS JE uploader. Rules first (deterministic, free, auditable), then AI on whatever is left — both run automatically on import, so the feed is already coded when you first look at it — human review always, then a previewed journal entry. The coding table renders account/location as text and builds a `<select>` only for the cell being edited: at 420 rows the per-row-select version took 5.1s to open a batch and 500ms per edit (78,120 option elements); click-to-edit is 0.65s and 32ms. Search plus row selection is the bulk path — click a normalised merchant to search it, select all, set the account once. Finance-gated in the nav and by `can_manage_journal_entries()` in RLS. **Posting is off per card until switched on**; the CSV export still emits their existing uploader template, so the tool is useful before the direct post is enabled
- **Redo returns** — webhook + REST backfill into `redo_returns`; `/v2/returns-overview.html` exists
  but is deliberately **not** in the nav until coverage is complete
- **Product Concepts** (`/v2/product-concepts.html`) — browse/filter concepts drafted in Ask SILO with the full evidence brief, collection children nested under their parent; "Open in Ask SILO" deep-links via `?concept=<id>`, which arms the composer against that row so a refinement revises it instead of creating a second concept. Reachable from the **Concepts** button in Ask SILO's header (unhidden for the same tester allowlist); deliberately **not** in the nav yet, same stance as comp-requests
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
- Smoke tests

Done since that file was last pruned: per-company nav menu (`v2/nav-config.js`) and insert-side
`company_entity_id` stamping (DB trigger + `withCompany()` helpers).

### Known P2 items
See `docs/ops/bugs.md`. No open P1s.
