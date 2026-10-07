# CLAUDE.md — SILO project guide

The rules every session needs. Detail, history and per-table notes live in
[`docs/agents/`](docs/agents/README.md) — **read the matching file there before changing that area.**
Directory rules load from `supabase/CLAUDE.md`, `supabase/functions/CLAUDE.md`, `v3/CLAUDE.md` and
`scripts/CLAUDE.md`. Change history: `docs/ops/CHANGELOG.md`. Open issues: `docs/ops/bugs.md`.

Older code comments and docs that say "see CLAUDE.md" mean the pre-2026-10-07 version of this file; that text is preserved verbatim in `docs/agents/`.

---

## What this is

SILO is Baseballism's internal operations platform, now multi-tenant (other companies use it too). It is
a static HTML/JS frontend talking directly to Supabase (Postgres + Auth + Storage) through the JS SDK, so
**RLS is the security boundary**. `server/` is a separate Express service for AR sync only; the browser
never calls it. blake@baseballism.com is `owner`; most others are `admin`; `executive` and `member` users
exist. Do not assume a headcount — query `profiles` / `entity_memberships`.

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML + CSS + JS, no framework. Static hosting (GitHub Pages) |
| Backend | Supabase: Postgres, Auth (email/password), Storage, Edge Functions (Deno) |
| Data sync | GitHub Actions → Node scripts in `scripts/` → Supabase |
| Config | `pages/config.js` sets `window.__SILO_CONFIG__` |

## Layout

| Path | What it is |
|------|-----------|
| `v2/` | **All current pages. Build new tools here.** `nav-config.js` defines the sidebar (`window.SiloNav`) |
| `v3/` | Two features — the dashboard / report runtime and Product Studio (`product-workflow.html`). Not a successor to `v2/`. See `v3/CLAUDE.md` |
| `pages/` | `config.js`, `login.html`, `set-password.html`, public `review.html`, shared libs, a few legacy tools |
| `*.html` at root | Legacy iframe targets. Several have no auth. Never copy one as a starting point |
| `legacy/` | Archived. **Do not touch** |
| `supabase/` | `migrations/`, `functions/`, `verify_v2_schema.sql`, `apply_all_post_merge.sql` |
| `scripts/` | Sync and backfill scripts; sync cores in `scripts/lib/`; tests in `scripts/tests/` |
| `.github/workflows/` | Syncs, checks, deploys — see `docs/agents/github-actions.md` |
| `docs/ops/` | Runbooks, bugs, roadmap, changelog |

## Config, auth and the active company

```js
const cfg = window.__SILO_CONFIG__ || {};   // never hardcode credentials anywhere
const _co = await window.__SILO_CONFIG__?.ensureActiveCompany?.(db) || null;
if (_co?.id) query = query.eq('company_entity_id', _co.id);   // on every company-scoped SELECT
```
- **Use `ensureActiveCompany(db)`**, not `getActiveCompany()`, for anything that feeds a query or write.
  `getActiveCompany()` reads per-tab `sessionStorage` and returns `null` in a bookmarked or new tab,
  while the auth session (in `localStorage`) is still valid — logic gated on it silently no-ops.
- Wrap insert payloads in `withCompany()` / `withCompanyRows()`; a DB trigger is the backstop.
- Missing config shows "Missing Supabase config" — that is intentional.

## Pages

**Pattern 1 — full Beacon shell. Use it for every new page.** Copy `v2/projections.html` or
`v2/tasks.html`. Asset order, exactly:
```html
<link rel="stylesheet" href="beacon.css" />
<link rel="stylesheet" href="silo-brand.css" />
<!-- page-specific <style> if needed -->
<link rel="stylesheet" href="beacon-mirrors-unified.css" />
<link rel="stylesheet" href="v2-mobile.css" />
<script src="v2-shell.js" defer></script>
<script src="nav-config.js"></script>   <!-- REQUIRED before silo-chrome.js, or no sidebar renders -->
<script src="avatar.js"></script>       <!-- optional -->
<script src="silo-chrome.js"></script>
```
Skeleton: `.silo-app#silo-app > main.silo-main > header.bcn-header` (+ optional `.bcn-kpi-band`,
`.bcn-filter-bar`). Mount after auth:
`window.SiloChrome.mount({ appEl: '#silo-app', active: '<nav key>', user: { email, role }, crumbs: [...], supabaseClient: db })`.

**Pattern 2** (iframe wrapper, `tool-shell.js`) — only `baseballismwholesale` remains. A wrapper's auth
does not protect its target's own URL. **Pattern 3** (stub redirect) — URL-compat shims; add no logic.

Exceptions: `v2/backend.html` uses Tailwind and no chrome. `company-picker`, `company-onboarding` and
`launch-calendar-guide` are chrome-less on purpose. Full lists: `docs/agents/architecture.md`.

### Beacon design system
Always use Beacon classes; never invent patterns or new CSS variables. Common classes: `bcn-header`,
`bcn-kpi-band`/`bcn-kpi`, `bcn-filter-bar`, `bcn-card` (+`-header`, `-body`, `-foot`), `bcn-table`,
`bcn-btn` (`--primary`/`--ghost`/`--dark`/`--danger`), `bcn-pill`, `bcn-field`, `bcn-tabs`,
`bcn-status`, `bcn-mono`/`bcn-num`. Tokens: `--bcn-accent`, `--bcn-pos`, `--bcn-neg`, `--bcn-warn`,
`--bcn-band`, `--bcn-ink`/`-2`/`-3`. Fonts: Plus Jakarta Sans for UI, **IBM Plex Mono for KPI values,
table numbers and status labels.** Beacon styles `table.bcn-table` with element+class, so an override
needs the element selector too. Full list: `docs/agents/architecture.md`.

### Status and errors
No `alert()`. Every page has `<div class="bcn-status" id="status" hidden></div>` and a `setStatus(msg,
type, ms)` that sets `bcn-status bcn-status--${type}`.

### Navigation
Add links in `v2/nav-config.js` (`profiles`, `departments`, `roles`, `grantTable`; `requiresGrant: true`
makes the grant the only way in). **Nav gating is UX only — RLS is the boundary.** Do not put logic in
`silo-chrome.js`, `tool-shell.js` or `v2-shell.js`.

## Database essentials

Full reference (every table's invariants, every gate function, RPCs, buckets): `docs/agents/database.md`.
Database rules: `supabase/CLAUDE.md`.

- **Multi-tenant.** Every operational table carries `company_entity_id`; RLS scopes reads to
  `active_company_id()` (from `profiles.active_company_id`, set by `set_active_company()`). All public views
  are `security_invoker = true`. Baseballism's entity id: `3bd934c9-4cdd-429b-9076-f8f6b45d4eb7`.
- **Roles are per company**: gates judge `entity_memberships.role` (`owner_admin`/`admin`/`member`/
  `viewer`) for the active company, falling back to the legacy global `profiles.role` only without a
  membership. `profiles.role` is an ENUM — compare with `role::text`. `profiles.app_role` does not exist.
- **`is_admin_user()` passes for nearly everyone** (most profiles are membership `admin`). Money and
  people authority uses narrower gates: `can_manage_journal_entries()`, `can_manage_client_invoices()`,
  `current_user_can_manage_comp_requests()`, `is_exec_or_owner()`, `is_platform_admin()`. Never widen
  one of those to `is_admin_user()`.
- **Global profile flags** (`profiles.role`, `department`, `is_active`) are written only when the user
  belongs to no other company — `department` alone grants journal-entry authority.
- **`chat_run_readonly_query()`** is the shared report engine (Ask SILO, saved reports, every v3 tile):
  SECURITY INVOKER, SELECT-only, 1000-row pages. Build new report surfaces on it, not beside it.

## Edge functions (summary)

Sources are in `supabase/functions/`. **Merging does not deploy.** Deploy with the "Deploy Edge
Function" workflow from `main`, never by pasting source through an API client. Several deployed functions
and triggers have no source here. Rules: `supabase/functions/CLAUDE.md`. Per-function reference:
`docs/agents/edge-functions.md`.

## Checks that run on production

| Check | What it catches |
|-------|-----------------|
| `deployment-drift-check.yml` (daily + push to `supabase/**`) | A migration not applied (`verify_v2_schema.sql`) or a function whose deployed source differs from `main`. Red right after a merge means "apply / deploy now" |
| `report-tieouts-nightly.yml` | A SILO report whose numbers no longer reconcile, or whose tie-outs are stale |
| `sales-freshness-check.yml` | A nightly sync that did not run (it re-runs the sync itself) |

Workflow list and schedules: `docs/agents/github-actions.md`.

---

## Working method — required

Full text: `docs/agents/working-method.md`.

1. **Preflight, read-only, before editing.** Name every call site of what you will change (including
   workflow- and edge-function-only callers), every input, every policy/grant touched (read them live
   from `pg_policy` / `has_function_privilege`, not from migration files), every partial-failure path,
   retry and resume behaviour, every destructive operation and what makes it safe by construction,
   concurrency, and whether success / skip / error are distinguishable in the stored record. Write down
   the assumptions needing live verification and the tests, before implementing.
2. **Implement.**
3. **Adversarially review the final integrated call path** — run the real wiring, not just the helpers.
   Mutation-test: break each fix and confirm a test fails.
4. **Language.** Never say "ready", "done" or "complete" until review and verification both happened.
   Until then: "implementation complete, verification pending", plus the specific unknowns.

**PRs:** `/steward` (`.claude/skills/steward/SKILL.md`) is the PR ownership protocol. It never merges,
deploys, applies migrations or touches production data — those are Blake's.

## Conventions

**New v2 page:** Pattern 1 → exact asset order → mount chrome after auth → add to `v2/nav-config.js` →
stub redirect at the old URL if replacing one.

**New table** (details in `supabase/CLAUDE.md`): timestamped idempotent migration → RLS on + policies →
if it has `company_entity_id`, end with `select public.attach_stamp_company_entity_id_triggers();` → add
to `verify_v2_schema.sql`, `apply_all_post_merge.sql` and `supabase/README.md`. If you applied it to
production directly, open the PR in the same session.

**Shared JS** used by more than one page goes in a `.js` file in `v2/` or `pages/`.

## Do not

- Edit `legacy/`, hardcode credentials, use `alert()`, or create CSS variables
- Push to `main` — always a feature branch
- Build new tools at the repo root or treat `v3/` as the new home for pages
- Assume a nav link means a page is gated

## Deliberately hidden or unusual — ask before "fixing"

- `#btnFromConcept` in `po-builder.html` stays `hidden`; the concept → PO path is Product Studio's
  Ready-for-PO gate
- `v2/je-composer.js` is two-step (draft, then re-read from the database for approval). Do not
  collapse it into one confirm
- Compensation requests allow a manager to file for themselves (decision 2026-08-25)
- `/v2/returns-overview.html` stays out of the nav until Redo coverage is complete
- Billing is a tab of Workspace Settings and visible to admins (decision 2026-09-20) — do not hide it
- `review_template_questions` CHECK carries an unused `rating_scale` kind — preserved, not removed

Module-by-module status and known leftovers: `docs/agents/current-status.md`.
