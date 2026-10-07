# Architecture reference — stack, files, config, page patterns, Beacon

> Moved verbatim from the root `CLAUDE.md` on 2026-10-07 (agent-guide restructure). The root file keeps the rules; this file keeps the detail and history. Update here, not in the root.

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
│   ├── licensing/             ← Retained microsite assets; entry page retired 2026-10-01
│   └── [page].html            ← One file per tool
├── v3/                        ← ONE feature, not the new home for pages: the dashboard runtime
│   ├── dashboards.html        ← List / create dashboards
│   ├── dashboard.html         ← The canvas (?id=<uuid>, &edit=1 to edit)
│   ├── dashboard.css
│   ├── js/chart-adapter.js    ← The only file that talks to ECharts
│   ├── js/metrics.js          ← How a column COMBINES (ratios pooled, never averaged) and what a change means
│   ├── js/filter-bar.js       ← The dashboard's filter controls; built once, updated in place
│   ├── js/dashboard-renderer.js ← Draws widgets from config; shared by view AND edit mode
│   ├── js/dashboard-builder.js  ← Edit mode: report picker, inspector, buffered save
│   └── README.md              ← Read this before touching v3
├── pages/
│   ├── config.js              ← window.__SILO_CONFIG__: credentials + active-company helpers
│   ├── login.html             ← Auth page (routes to /v2/finance.html after login)
│   ├── set-password.html      ← Password set/reset landing
│   ├── review.html            ← PUBLIC review portal (token = the authorization)
│   ├── embed.js               ← Loaded by iframe tool pages
│   ├── po-costing-lib.js      ← Shared PO costing logic (used by v2/po-builder + v2/po-costing)
│   └── [legacy-tool].html     ← factories, wholesale, baseballismwholesale, sales-verification
│                                — some iframed by v2 wrappers, some linked directly
├── *.html (repo root)         ← Legacy standalone tools / iframe targets
│                                (buyer and checkwriter retired 2026-10-06).
│                                Superseded originals were retired 2026-10-01; see retirement runbook
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
└── docs/ops/legacy-page-retirement.md ← 2026-10-01 page retirement and recovery record
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
Now the majority of `v2/` — 34 pages. Anything in `v2/` that loads `silo-chrome.js` but **not**
`tool-shell.js` is Pattern 1: `accounting-export`, `ad-studio`, `bi-daily-trend`, `bi-product-search`,
`bi-product-types`, `bi-sales-overview`, `bi-top-sellers`, `calendar`, `finance`,
`integrations`, `inventory`, `launch-calendar`, `live-schedule`, `mail-intake`, `mailroom`,
`marketing-overview`, `my-review`, `planning-scenarios`, `po-builder`, `po-costing`, `po-report`,
`products`, `profile`, `projections`, `purchase_request`, `request_manager`, `returns-overview`,
`settings-company`, `settings-team`, `settings-notifications`, `platform-admin`,
`review-editor`, `review-templates`, `reviews`, `sales-verification`, `seo-keywords`, `seo-overview`, `seo-studio`, `seo-tasks`, `setup-checklist`, `silo-chat`, `tasks`.

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
1 page remains: `baseballismwholesale`.
The `buyer` and `wholesale` wrappers were retired 2026-10-01, and `checkwriter` (wrapper and target)
plus the root `buyer.html` target on 2026-10-06.
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
Four: `v2/employeehub.html` → `/v2/finance.html`, `v2/product-manager.html` /
`v2/product-samples.html` → `/v2/products.html` (URL-compat shims that forward their query string), and
`v2/product-concepts.html` → `/v3/product-workflow.html` (Product Studio, keeping `?concept=`).
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
