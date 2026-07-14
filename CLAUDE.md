# CLAUDE.md — SILO project guide

This file is the authoritative context for AI agents working on this repo. Read it fully before making any changes.

---

## What this is

SILO is an internal operations platform for Baseballism (a baseball-themed brand). It's a static HTML/JS frontend backed by Supabase (Postgres + Auth + Storage). There is no backend server — the browser talks directly to Supabase via the JS SDK.

**Team:** 7 users — blake@baseballism.com is `owner`, the rest are `admin`.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML + CSS + JS (no framework) |
| Database | Supabase (Postgres) |
| Auth | Supabase Auth (email/password) |
| Storage | Supabase Storage (2 buckets: `payment-request-files`, `launch-images`) |
| Hosting | Static file hosting (GitHub Pages or similar) |
| Data sync | GitHub Actions → Node.js scripts → Supabase |
| Config injection | `pages/config.js` sets `window.__SILO_CONFIG__` |

---

## File structure

```
/
├── v2/                        ← ALL active pages live here
│   ├── beacon.css             ← Design system tokens + components (DO NOT EDIT casually)
│   ├── silo-brand.css         ← Page layout, card harmonization
│   ├── beacon-mirrors-unified.css  ← Legacy component overrides
│   ├── v2-mobile.css          ← Responsive overrides
│   ├── silo-chrome.js         ← Sidebar nav component (mount after auth)
│   ├── tool-shell.js          ← iframe wrapper for legacy tools
│   ├── v2-shell.js            ← Thin auth check shell
│   ├── po-costing-lib.js      ← Shared PO costing logic (use for PO pages)
│   └── [page].html            ← One file per tool
├── pages/
│   ├── config.js              ← Sets window.__SILO_CONFIG__ with Supabase credentials
│   ├── login.html             ← Auth page (routes to /v2/finance.html after login)
│   ├── embed.js               ← Used by iframe tool pages
│   └── [legacy-tool].html     ← Legacy tools embedded via tool-shell
├── legacy/                    ← DO NOT TOUCH — old pages, kept for reference only
├── supabase/
│   ├── verify_v2_schema.sql   ← Run this to health-check the DB after any SQL changes
│   ├── apply_all_post_merge.sql ← One-shot apply for all migrations (safe to re-run)
│   ├── migrations/            ← Individual migration files (timestamped)
│   └── seeds/                 ← Seed data SQL
├── scripts/                   ← Node.js / Python data sync scripts
├── .github/workflows/         ← GitHub Actions (nightly sync, AR sync)
├── docs/ops/                  ← Ops documentation (bugs, roadmap, changelog)
└── silo-pitch.html            ← Product pitch deck (standalone, not part of the app)
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

---

## Three page patterns — use the right one

### Pattern 1: Full Beacon shell (preferred for new tools)
Used by: `projections.html`, `launch-calendar.html`, `profile.html`, `po-builder.html`, `po-costing.html`, `planning-scenarios.html`, `reviews.html`, `review-templates.html`, `review-editor.html`, `my-review.html`

Asset load order (must follow exactly):
```html
<link rel="stylesheet" href="beacon.css" />
<link rel="stylesheet" href="silo-brand.css" />
<!-- page-specific <style> block if needed -->
<link rel="stylesheet" href="beacon-mirrors-unified.css" />
<link rel="stylesheet" href="v2-mobile.css" />
<script src="v2-shell.js" defer></script>
<script src="silo-chrome.js"></script>
```

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
Used by: `cashflow.html`, `wholesale.html`, `sales-verification.html`, and most finance mirrors.

Entire file is ~20 lines:
```html
<link rel="stylesheet" href="tool-shell.css" />
<div class="silo-app" id="silo-app">
  <main class="silo-main" data-tool='{"title":"Cash flow","src":"/cashflow.html","active":"finance/cashflow","crumbs":["Finance","Cash flow"]}'></main>
</div>
<script src="silo-chrome.js"></script>
<script src="tool-shell.js"></script>
```

### Pattern 3: Stub redirect (placeholder)
Many pages (allocation.html, aprio.html, etc.) are 24-line stubs that redirect to the finance hub. Do not add logic to these — rebuild them as Pattern 1 when the time comes.

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
const _co = window.__SILO_CONFIG__?.getActiveCompany?.() || null;
// then on every SELECT of a company-scoped table:
if (_co?.id) query = query.eq('company_entity_id', _co.id);
```

**Not yet isolated:** `inventory_on_hand`, `sales_by_day` — backfill deferred. These depend on Baseballism-specific Google Sheets / Better Reports sync pipelines. New companies need their own data pipeline before these tables can be partitioned.

### Role system
`profiles.role` is a Postgres enum (`app_role`) with values: `owner`, `admin`, `executive`, `user`.
- `owner` and `admin` get write access to PO tables
- `executive` outranks `admin`: it passes `is_admin()` and additionally gates review-template building
- `user` is read-only on PO tables
- blake@baseballism.com is `owner`; the other 6 users are `admin`

**Important:** `profiles.role` is an ENUM, not TEXT. Always cast with `role::text` when comparing in SQL.

### Write-access functions
```sql
po_builder_can_write()   -- gates write on factories, po_headers, po_lines
po_costing_can_write()   -- gates write on po_costing, po_costing_lines
is_exec_or_owner()       -- gates review-template writes (owner, executive)
reviews_can_manage()     -- gates roster/review writes (owner, executive, admin)
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
| `employees` | Performance-review roster (manager-scoped; auto-links `profiles` by email; associates exist ONLY here, no SILO auth) |
| `review_templates` | Review question sets (exec-only writes; publish locks questions) |
| `review_template_questions` | Ordered questions: free_text, scale_1_10, single_choice, multi_choice, goals |
| `reviews` | One review per employee per cycle (draft → sent → finished; employee signature fields) |
| `review_answers` | Manager's answers per question (jsonb value) |
| `review_private_notes` | Manager notes — RLS author-only, not even exec/owner |
| `employee_goals` | Goals persist on the employee across review cycles |
| `review_access_tokens` | Hashed 30-day portal tokens — RLS deny-all, edge functions only |
| `inventory_workboard_v` | View: inventory with sell-through metrics |
| `sales_monthly_product_type_rollup_mv` | Materialized view: monthly sales rollup |
| `v_po_header_summary` | View: PO list with status |
| `v_po_costing_summary` | View: costing rollup |
| `v_po_sku_prior_cost` | View: prior landed costs per SKU |
| `v_po_open_planning_lines` | View: open PO lines for planning scenarios |
| `payment_requests_v` | View: enriched payment requests |
| `payment_request_activity_v` | View: activity with user info |
| `v_launch_po_product_lookup` | View: PO products for launch search |

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

### Edge functions (performance reviews)
Sources live in `supabase/functions/`; deploys are manual (Supabase MCP/CLI), merging a PR does NOT deploy.
```
org-invite-send   -- emails an org invite link; caller must be admin of the invite's entity and present the raw token (JWT-auth)
org-invite-redeem -- PUBLIC (verify_jwt off): peek shows org/email for a token; redeem creates the invitee's confirmed account with their chosen password (no confirmation email — the invite proved the address) and applies the invite
review-send     -- manager sends a review: mints hashed 30-day token, status → sent, emails employee (JWT-auth)
review-portal   -- PUBLIC (verify_jwt off): token IS the auth; get/finish/renew for associates without SILO logins
review-finish   -- SILO-authenticated employee signs in-app from /v2/my-review.html (JWT-auth)
```
Emails send via Resend from `noreply@silo-baseballism.com` (`RESEND_API_KEY` edge-function secret — separate key from the auth SMTP one). Link base URL: `SILO_SITE_URL` env or hardcoded `https://silo-baseballism.com`. Without the key, sending still works — the manager gets the link to deliver manually.

### After any DB change
Always run `supabase/verify_v2_schema.sql` in the Supabase SQL Editor. All rows must show `ok`. If anything is missing, run `supabase/apply_all_post_merge.sql` then verify again.

---

## GitHub Actions / data sync

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| `shopify-sync.yml` | Daily 11:00 UTC | Shopify API sync — sales + inventory for all connected stores, then refreshes comp summary, sales velocity MV, and inventory current MV |
| `nightly-silo-sync.yml` | **Retired** (manual only) | Legacy Google Sheets / Better Reports import — retired 2026-07-08 after verifying Shopify covers every sales + inventory location. BR history remains in `sales_by_day` for pre-API reporting |
| `ar-sync.yml` | Manual / scheduled | AR (accounts receivable) sync |

**One sync, one source of truth.** Sales and inventory come from the Shopify API via the nightly GitHub Action. There is no dual-write conflict.

Secrets required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (set in GitHub repo settings).

---

## Conventions for new features

### Adding a new v2 page
1. Use Pattern 1 (Full Beacon shell) — copy `v2/projections.html` as a starting point
2. Follow the exact asset load order from SILO-BRAND.md
3. Mount SiloChrome after auth succeeds
4. Add the page to the sidebar nav in `silo-chrome.js`
5. Create a stub redirect in `v2/[pagename].html` at root level if needed

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
- Do NOT add logic to `silo-chrome.js`, `tool-shell.js`, or `v2-shell.js` — those are framework files

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

---

## Current status (as of Jun 2026)

### Multi-tenant isolation — Phase 1 complete
DB-level company isolation is live. Users in multiple companies pick a company at login; all data reads are scoped to `profiles.active_company_id`. See `supabase/README.md` for migration details.

**Deferred:** `inventory_on_hand` and `sales_by_day` backfill, per-company sync pipelines, insert-side `company_entity_id` auto-stamping, company switcher in sidebar.

### Tools fully on Beacon shell (Pattern 1)
`projections.html`, `launch-calendar.html`, `profile.html`, `po-builder.html`, `po-costing.html`, `planning-scenarios.html`, `backend.html`, `reviews.html`, `review-templates.html`, `review-editor.html`, `my-review.html`

### Performance Reviews module (complete as of 2026-07-14)
End-to-end flow across five pages + three edge functions:
1. Exec/owner builds templates (`/v2/review-templates.html`) — publish locks questions; revise via duplicate-as-draft
2. Managers roster employees + run reviews (`/v2/reviews.html`, `/v2/review-editor.html`) — manager-scoped RLS: managers see ONLY their own roster/reviews; exec/owner see all; private notes are author-only
3. Send emails the employee a hashed 30-day token link (Resend, `noreply@silo-baseballism.com`)
4. SILO-authenticated employees view/sign in-app (`/v2/my-review.html`); associates (no SILO login) use the public portal (`/pages/review.html`) — the token is the entire authorization
5. Signing marks the review finished (immutable — sent/finished reviews cannot be deleted), locks tokens on both paths, and emails the manager
Goals persist on the employee across cycles (`employee_goals`) and surface in every review regardless of template. PDF = print stylesheet on both review views.

### Tools on tool-shell iframe (Pattern 2)
`cashflow.html`, `wholesale.html`, `sales-verification.html`, and most finance mirrors

### Tools with custom layouts (partial migration)
`inventory.html`, `finance.html`, `employeehub.html`

### Open roadmap items
See `docs/ops/roadmap.md` for current priorities. Key items:
- Per-company nav menu (hide Baseballism-specific sections for other entities)
- Insert-side `company_entity_id` auto-stamping on all create forms
- Company switcher in sidebar (without full logout)
- Finish Beacon shell migration for iframe/custom pages
- Smoke tests

### Known P2 items
See `docs/ops/bugs.md`. No open P1s.
