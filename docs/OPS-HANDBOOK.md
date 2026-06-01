# SILO operations handbook

Living reference for **known bugs**, **testing**, **error handling**, **documented fixes**, and **roadmap**. Complements the interactive overview at [`legacy/app-status.html`](../legacy/app-status.html).

| Doc | Purpose |
|-----|---------|
| This file | Ops, QA, bugs, roadmap |
| [`supabase/README.md`](../supabase/README.md) | DB migrations after merge |
| [`planning-scenarios-filter-scope.md`](planning-scenarios-filter-scope.md) | Planning Scenarios acceptance |
| [`planning-scenarios-v2-ux-plan.md`](planning-scenarios-v2-ux-plan.md) | Historical UX analysis (superseded) |
| [`v2/SILO-BRAND.md`](../v2/SILO-BRAND.md) | v2 shell / Beacon UI conventions |

---

## Known bugs & limitations

Track severity as **P0** (data loss / security), **P1** (broken workflow), **P2** (workaround exists), **P3** (cosmetic / polish).

### Database & migrations

| ID | Severity | Issue | Workaround |
|----|----------|-------|------------|
| DB-1 | P1 | PO costing fails with `relation "public.po_headers" does not exist` | Run `supabase/apply_all_post_merge.sql` (see [`supabase/README.md`](../supabase/README.md)) |
| DB-2 | P2 | Costing works but tables missing — app falls back to `[SILO_COSTING]` JSON in `po_headers.internal_notes` | Apply migrations; migrate JSON into `po_costing` |
| DB-3 | P1 | `/v2/profile.html` cannot save without `profiles_select_own` / `profiles_update_own` RLS | Run section 3 in `apply_all_post_merge.sql` |
| DB-4 | P2 | `po_builder_can_write()` / `po_costing_can_write()` role list may not match your `profiles.role` values | Adjust role arrays in SQL migrations |

Verify anytime: paste `supabase/verify_v2_schema.sql` in Supabase SQL Editor — all rows should show `ok`.

### Data sync & dual sources

| ID | Severity | Issue | Workaround |
|----|----------|-------|------------|
| SYNC-1 | P1 | **Two writers** to `sales_by_day` / `inventory_on_hand`: Shopify Express API vs nightly Silo Sheets | Document which source is truth per channel (online vs retail locations) |
| SYNC-2 | P2 | Shopify inventory path **appends snapshots**; reporting views must dedupe or pick latest | Confirm view definitions in Supabase |
| SYNC-3 | P2 | `sales_by_day.row_hash` rules differ between Shopify upserts and Silo script | Expected; do not assume hashes are interchangeable across sources |
| SYNC-4 | P2 | Shopify incremental sync uses a **2-day overlap** from `last_sync_at` | Normal; avoids missing edge orders |
| SYNC-5 | P2 | Nightly Silo job can fail if `config/silo-sources.mjs` CSV URLs are stale or unpublished | Fix Sheet publish URL; re-run workflow |

### Planning Scenarios (`/v2/planning-scenarios.html`)

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| PS-1 | P2 | `revenue_projections` has **no `product_type`** — projection seed is company-wide; Mix/ASP stay historical | By design; see [`planning-scenarios-filter-scope.md`](planning-scenarios-filter-scope.md) |
| PS-2 | P3 | v2 UX regressions vs v1 (destructive seed, tabbed inputs, lazy KPIs) | **Mitigated** — page rebuilt from v1 + Beacon chrome (see UX plan note) |
| PS-3 | P2 | Open PO date filter uses **`to` only** (no `from` on `month_key`) — v1 parity | Document when comparing to other tools |

### Frontend / v2 shell

| ID | Severity | Issue | Workaround |
|----|----------|-------|------------|
| FE-1 | P2 | **Duplicate page paths**: root `*.html` vs `/pages/*` vs `/v2/*` — bookmarks may hit old UI | Prefer `/v2/*` for Beacon shell; update nav in `silo-chrome.js` |
| FE-2 | P2 | Many v2 tools still use **tool-shell iframe** to legacy pages | Full Beacon rebuild per [`v2/SILO-BRAND.md`](../v2/SILO-BRAND.md) migration table |
| FE-3 | P3 | Inconsistent error UX: some pages `alert()`, others `statusLine`, others inline `debugBox` | See [Error handling](#error-handling) |
| FE-4 | P2 | Missing `SUPABASE_URL` / `SUPABASE_ANON_KEY` in `pages/config.js` replaces entire body with error | Fix `config.json` → deployed `pages/config.js` on hosting |

### Auth & access

| ID | Severity | Issue | Workaround |
|----|----------|-------|------------|
| AUTH-1 | P1 | RLS misconfiguration exposes or blocks data despite “signed in” | Fix policies in Supabase; never put service role key in static HTML |
| AUTH-2 | P2 | Role-gated pages (e.g. `v2/backend.html`) show **Access denied** if `profiles.role` not in allowlist | Grant role in `profiles` or adjust page check |
| AUTH-3 | P2 | `EXPECT_EMAIL_CONFIRMATION` in config may block login until email confirmed | User completes Supabase confirmation flow |

### Integrations

| ID | Severity | Issue | Workaround |
|----|----------|-------|------------|
| INT-1 | P2 | Shopify **HTTP 429** — sync slows via retry | `fetchWithRetry` in `server/index.mjs`; widen cron spacing |
| INT-2 | P2 | Optional Supabase views (e.g. `v_po_open_planning_lines`) missing — planning page loads with empty open POs | Create view in Supabase or ignore if unused |

---

## Testing processes

There is **no automated UI test suite** in this repo today. Validation is manual + schema/sync checks.

### 1. Local static preview

```bash
npx --yes serve /workspace
# Open http://localhost:3000/v2/finance.html (or target page)
```

Sign in with a real Supabase user. Confirm `pages/config.js` points at the correct project.

### 2. Supabase schema health (required after every DB-related PR)

1. Supabase Dashboard → SQL → New query  
2. Run `supabase/verify_v2_schema.sql`  
3. All objects `ok`; profile policies `ok`  
4. If anything missing → `supabase/apply_all_post_merge.sql` → re-verify  

### 3. PO module smoke test

| Step | URL | Pass criteria |
|------|-----|---------------|
| 1 | `/v2/po-builder.html` | Create PO header + line (≥1 factory) |
| 2 | `/v2/po-costing.html` | FOB → mark shipped → freight → landed unit |
| 3 | `/v2/profile.html` | Save name + default page |

### 4. Planning Scenarios acceptance

Use the checklist in [`planning-scenarios-filter-scope.md`](planning-scenarios-filter-scope.md):

- Filter scope (All vs product type) changes units/gap/families consistently  
- Historical vs projection seed behavior  
- Export CSV + print  

### 5. Sync & CI jobs

| Workflow | Trigger | Command | Secrets |
|----------|---------|---------|---------|
| `nightly-silo-sync.yml` | Cron `30 10 * * *` + manual | `node scripts/sync-silo-inventory-sales.mjs` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `ar-sync.yml` | Cron `15 9 * * *` + manual | `npm run sync:ar` | Same |
| `one-time-sales-backfill.yml` | Manual | Backfill single `location_tag` | Same |

**Manual sync (local):**

```bash
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
node scripts/sync-silo-inventory-sales.mjs
npm run sync:ar
npm start   # then POST /api/sync/shopify for Shopify
```

Optional flags (Silo script): `SILO_ONLY_SOURCE`, `SILO_SKIP_INVENTORY`, `SILO_SKIP_SALES`, `SILO_SKIP_SUMMARY_REFRESH`, `SILO_SALES_SYNC_MODE=backfill`.

### 6. Maintenance scripts

| Script | Purpose |
|--------|---------|
| `scripts/audit-inventory-product-titles.mjs` | Find inventory title mismatches |
| `scripts/backfill-inventory-titles-from-sheets.mjs` | Repair titles from Sheets |
| `scripts/sql/inventory-workboard-product-title-check.sql` | SQL spot-check |

### 7. Server health

```bash
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/api/sync/shopify -H 'Content-Type: application/json' -d '{}'
```

---

## Error handling

Patterns vary by layer; new code should follow the **recommended** column.

### Static HTML pages (browser)

| Pattern | Where used | Behavior |
|---------|------------|----------|
| **Config gate** | Most v2 pages | If `__SILO_CONFIG__` missing → replace `body` with error message |
| **Auth redirect** | Standard tools | `getSession()` → no session → redirect `/pages/login.html` |
| **Status line** | Planning, inventory, launch calendar | `#statusLine` shows load progress; red text on failure |
| **`alert()`** | Launch calendar saves, some legacy | Blocking dialog on validation/API error |
| **`console.warn` / `console.error`** | Widespread | Logged; user may not see unless DevTools open |
| **Debug panels** | `product-manager`, finance debug mode | `debugBox` shows last operation / error text |
| **Access denied** | `v2/backend.html` | Alert + no data load if role not allowed |

**Recommended for new v2 pages:**

1. Fail fast on missing config (full-page message).  
2. Redirect unauthenticated users to login.  
3. Show recoverable errors in a visible **status strip** (not only `alert`).  
4. Log details with `console.error` for support.  
5. Disable action buttons while `loading`; re-enable in `finally`.  
6. For Supabase writes: check `{ error }` and surface `error.message` (RLS errors often read as permission denied).

### Node sync (`scripts/`, `server/`)

| Pattern | Location | Behavior |
|---------|----------|----------|
| **Startup throw** | All sync entrypoints | Missing `SUPABASE_URL` / service key → process exit code ≠ 0 |
| **Shopify 429 retry** | `server/index.mjs` `fetchWithRetry` | Up to 5 tries with `Retry-After` |
| **Pagination** | Shopify `getAll` | Follow `Link: rel="next"` until exhausted |
| **Chunked upserts** | Shopify sync | 500-row batches to Supabase |
| **Optional views** | Planning scenarios (client) | `loadPagedOptional` → `[]` + `console.warn` on failure |

CI workflows fail the job if the script throws; check GitHub Actions logs for the failing step.

### Supabase / RLS

- Client receives PostgREST errors in `{ error }` — message is safe to show users.  
- **Do not** expose service role key in frontend.  
- Fix data issues in SQL policies or `profiles.role`, not by bypassing RLS in HTML.

---

## Documented fixes (changelog-style)

| Area | Fix | Reference |
|------|-----|-----------|
| Planning Scenarios v2 | Restored v1 `revenuePlanForMonth` (manual revplan → `allRevenueForMonth`) | `planning-scenarios-filter-scope.md` |
| Planning Scenarios v2 | Seed mode on `dataset.seedMode`; removed `selDataSource` bypass | Same |
| Planning Scenarios v2 | KPI strip uses `selectedScenario()` in filtered scope | Same |
| Planning Scenarios v2 | Open PO filter: `to` only (v1 parity) | Same |
| Planning Scenarios v2 | Rebuilt from v1 layout + projection seed + Beacon theme | `planning-scenarios-v2-ux-plan.md` (superseded note) |
| PO costing | Formal tables + views; JSON fallback until migrated | `supabase/README.md` |
| Profile | Self-service RLS + `default_page` column | `20260521130000_profiles_self_service.sql` |

When you land a fix for a row in [Known bugs](#known-bugs--limitations), move it here and strike the bug row or mark **Fixed** with PR link.

---

## Roadmap

Ordered by impact; not calendar-dated.

### Near term (stability & data)

- [ ] **Single source of truth doc** per table (`sales_by_day`, `inventory_on_hand`) — Shopify vs Silo ownership  
- [ ] Enforce post-merge SQL in deployment checklist (automate `verify_v2_schema` in CI if possible)  
- [ ] Inventory title audit/backfill runbook tied to `scripts/audit-inventory-product-titles.mjs`  
- [ ] Align `profiles.role` values with `po_*_can_write()` in production  

### Medium term (v2 UX)

- [ ] Complete **Beacon shell migration** per `v2/SILO-BRAND.md` (reduce iframe `tool-shell` usage)  
- [ ] Standardize error/status component across v2 pages  
- [ ] Consolidate duplicate routes (`/finance.html` → `/v2/finance.html` redirects or canonical URLs)  
- [ ] Planning Scenarios: optional `product_type` on `revenue_projections` if finance needs typed projection seed  

### Longer term (quality & platform)

- [ ] Minimal smoke test script (Playwright or API-only) for auth + one read per critical view  
- [ ] Structured logging for sync jobs (batch id, row counts, duration) → Supabase `job_sync_state` or logs table  
- [ ] Admin “system health” page surfacing last sync times, schema verify, and GitHub Action status  
- [ ] Deprecate unused `legacy/` pages after v2 parity confirmed  

### v2 page inventory (migration snapshot)

| State | Examples |
|-------|----------|
| Full Beacon shell | `projections`, `launch-calendar`, `profile`, `po-builder`, `planning-scenarios` |
| Tool shell (iframe) | `cashflow`, finance mirrors, wholesale mirrors |
| Custom + mirrors CSS | `inventory`, `finance`, `employeehub`, `executive` |

---

## Quick links

- Architecture & modules: [`legacy/app-status.html`](../legacy/app-status.html)  
- Supabase apply order: [`supabase/README.md`](../supabase/README.md)  
- Brand / shell: [`v2/SILO-BRAND.md`](../v2/SILO-BRAND.md)  
- Login: `/pages/login.html` · Config: `/pages/config.js`  

---

## Maintaining this handbook

Update this file when you:

1. Confirm or fix a listed bug  
2. Add a GitHub Action or sync script  
3. Change error-handling conventions on v2 pages  
4. Ship a roadmap item (check the box + note PR)  

Last reviewed: 2026-06-01
