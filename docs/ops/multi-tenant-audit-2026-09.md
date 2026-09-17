# Multi-tenant readiness audit — 2026-09-17

Walked against the **live** database (`mkquclffrvlzyecnabyf`) and the repo at
`862b845`, not against migration files. Every finding below was reproduced by
impersonating a real role in a rolled-back transaction; where something was
flagged from reading and then disproved by testing, that is recorded too,
because the false positives are as informative as the findings.

---

## Method

Findings came from grants and policy catalogs, not from migrations — the live
definition is the one that matters, and three of the four real holes were
invisible in the migration history because they were created by a Postgres
*default*, not by a line of SQL anyone wrote.

Impersonation that works against Supabase and is safe to run on production:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<user uuid>","role":"authenticated"}';
-- ...
rollback;
```

---

## What was already sound

This is the larger part of the story and it should not be lost in the finding
list.

- **RLS coverage is complete.** All ~160 public base tables have
  `relrowsecurity = true`. Tables holding credentials or tokens
  (`org_invites`, `*_oauth_states`, `plaid_connection_secrets`,
  `review_access_tokens`, `qbo_history_staging_*`, `sync_state`, `upc_pool`)
  have **zero** policies, i.e. deny-all to clients and service-role only. That
  is fail-closed by construction.
- **Every company-scoped policy AND-s in the tenant clause.** Checked all
  policies on tables carrying `company_entity_id` for the dangerous shape
  `company_entity_id = active_company_id() OR <something>`, which would let an
  exec of tenant A read tenant B. None exist — every one is
  `(company_entity_id = active_company_id()) AND (...)`.
- **`active_company_id()` fails closed.** It is
  `select active_company_id from profiles where id = auth.uid()` — NULL for an
  unresolved caller, never a default. Correct; the bugs were all in callers that
  coalesced that NULL away.
- **Definer views over matviews are correctly layered.** Seven of the eight
  `security_invoker = false` views carry an explicit
  `where company_entity_id = active_company_id()`, which is what supplies the
  tenant filter the matview itself cannot have.
- **The syncs are already multi-tenant.** `shopify-sync.mjs` and
  `ad-platforms-sync.mjs` select *every* active connection and loop; the
  per-company env var only narrows a manual run. A new tenant's connection is
  picked up with no code change.
- **Tenant creation is a product feature.** `handle_new_user`'s founding path
  provisions entity + owner profile + `owner_admin` membership + active company
  in one transaction, with no reference to Baseballism.
- **Canonical reporting is already tenant-neutral.** 21 `system` saved reports
  are global (`company_entity_id IS NULL`) and safe because
  `chat_run_readonly_query` is SECURITY INVOKER.
- **Storage was fixed in September** (`20260904120000`): private-bucket policies
  key off the parent row rather than `bucket_id`.

## Two things flagged from reading, then disproved by testing

Recorded because each would have been a confident, wrong finding.

1. **`cash_forecast_items` looked wide open.** It carries a second policy,
   `cash_plans_finance`, whose expression is just
   `can_manage_journal_entries() OR is_exec_or_owner()` — no tenant clause. Read
   as a permissive policy that is a cross-tenant read/write for every finance
   user. It is **RESTRICTIVE** (`polpermissive = false`), so it is AND-ed with
   the scoped policy, not OR-ed. Verified by inserting a row for each tenant in
   a rolled-back transaction and reading as a Baseballism finance user: only the
   Baseballism row came back. **Not a bug.** It is the only restrictive policy in
   the schema, which is exactly why it read wrong.
2. **`forecast_candidate_cycles` looked ungated.** It is SECURITY DEFINER and
   takes `p_company_entity_id`. It does call `forecast_candidate_may_act()`,
   which pins that argument to `active_company_id()`. **Not a bug.**

---

## Findings

### P0-1 — `purge_better_reports_overlap` deletes any tenant's sales, callable by `anon`

SECURITY DEFINER (so RLS is bypassed), EXECUTE held by **anon and
authenticated**, `DELETE`s from `sales_by_day` for whatever company id it is
given with no membership check — and the argument **defaulted to Baseballism**.

`anon` is not a hypothetical: it is the key published in `pages/config.js`.

Reproduced: called successfully as `set local role anon`, and as a Test Company
user naming Baseballism's entity id. Both returned a row count rather than an
authorization error.

**Fixed** in `20260917200000`: revoked from anon/authenticated, default argument
removed (a destructive function should never have a default target), service-role
guard added.

### P0-2 — `backfill_company_entity_batch` assigns tenancy, callable by `anon`

Same grant profile. Stamps unclaimed (`company_entity_id is null`) rows of
`sales_by_day` / `inventory_on_hand` with **any entity id the caller names** —
a tenant-*assignment* primitive. Any row that lands unstamped is claimable by
anyone.

Reproduced as `anon`, naming Baseballism's entity id. **Fixed** in the same
migration.

### P1-1 — `attach_stamp_company_entity_id_triggers` runs DDL, callable by `anon`

Drops and recreates the stamp trigger on every `company_entity_id` table. Not a
read path, but an unauthenticated lock storm against every tenant table at once,
and it rewrites the triggers that establish tenancy. No in-repo caller at all.
**Fixed** — revoked.

### P1-2 — `refresh_demand_coverage_base_mv` is an unauthenticated 300s refresh

Denial of service, no tenant dimension. **Fixed** — revoked.

### P1-3 — Membership RPCs silently fell back to Baseballism

`admin_update_profile` and `approve_access_request` both resolved the company to
write an `entity_memberships` row into as:

```sql
coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid)
```

So an admin whose own active company was unresolved, approving a user who
belongs to no org yet, **granted that person membership in Baseballism**. A
membership is a grant of access to a tenant's data, so an ambiguous tenant has
to stop the call. Both now raise. **Fixed** in the same migration.

### P1-4 — An unresolved company served Baseballism's sidebar

`resolveNavProfile(null)` returned `'grandfathered'`. Because
`getActiveCompany()` reads sessionStorage (per-**tab**) while the auth session
lives in localStorage, *any* user arriving by bookmark or deep link is fully
authenticated with no cached company — so a second tenant's user was served
Baseballism's menu, BBISM Receivables included.

No data leaked (RLS scopes every query; the extra links render empty pages), but
it is the last silent default-to-Baseballism in the product and the first thing
a prospect would notice. **Fixed**: fails closed to `standard`, and
`silo-chrome.js` repaints once `ensureActiveCompany()` resolves the company, so
Baseballism keeps its menu.

### P1-5 — Backfill scripts defaulted their tenant to Baseballism

`redo-backfill.mjs`, `redo-marketing-probe.mjs`,
`backfill-mailroom-from-sheet.mjs` and `import-payment-requests-legacy.mjs` all
did `process.env.X || '3bd934c9-...'`, and `mailroom-backfill.yml` documented
its blank input as "blank = Baseballism". Running a backfill for a new client
and forgetting the field filed their data under Baseballism — with every row
inserting successfully, so the failure is invisible. **Fixed**: all four refuse
a missing company, and the workflow input is now required.

### P2 — Open, not fixed here

- **`access_requests` accepts anonymous inserts with an arbitrary
  `company_entity_id`** (`WITH CHECK true`), so anyone can enqueue a request
  against any company. Approval is gated, so this is queue spam rather than
  access. Left alone because the intake form is a legacy Baseballism flow and
  narrowing it needs a product decision; invites are the supported path for a
  new tenant.
- **Business timezone hardcoded to Pacific** — `silo_business_today()` /
  `silo_business_yesterday()`, 31 occurrences. A client outside Pacific gets
  "yesterday" wrong for part of every day. Needs to read from the company
  record. This is the largest remaining *correctness* gap for a real second
  tenant.
- **`PRODUCT_CONCEPT_TESTERS = ['blake@baseballism.com']`** hardcoded in the
  `silo-chat` edge function. Acceptable while gated; must become a grant table
  before that feature ships.
- **`ar_sync_status_v`** is a definer view with no tenant filter, but it exposes
  one row of a retired Google Sheets job's status — no tenant data.

---

## The regression guard

The bug class here is a **default**, so a list of the four known-bad functions
would not catch the next one. Three layers now:

1. **The REVOKE** — the actual fix.
2. **An in-body guard** reading `current_setting('role', true)`, which survives
   an accidental re-grant. **It must not read `current_user`**: inside a
   SECURITY DEFINER function `current_user` and `session_user` are both the
   function's *owner*, so the obvious guard never fires while reading in review
   like a working control. The first draft of the migration shipped exactly that
   and a mutation test caught it.
3. **`verify_v2_schema.sql`** — an *allowlist* of anon-executable SECURITY
   DEFINER functions that goes CRITICAL on anything new. Since
   `deployment-drift-check.yml` runs that file against production daily, the
   next instance surfaces as a failed Actions run rather than at the next audit.
   Validated both ways: CRITICAL against production today, `ok` once exactly the
   four are revoked.

`scripts/tests/tenant-boundary.test.mjs` pins both the working guard and the
inert one against a real Postgres. All five mutations of the fix were confirmed
to fail the suite.

---

## Readiness matrix

| Area | Status | Reusable? | Baseballism coupling | Missing | Risk | Action |
|---|---|---|---|---|---|---|
| Tenant model (`entities`, memberships, `active_company_id`) | A | Yes | None | — | Low | None |
| RLS on operational tables | A | Yes | None | — | Low | Keep the verify checks green |
| SECURITY DEFINER surface | **was C, now A** | Yes | Default arg → Baseballism | — | **was High** | Applied + allowlisted |
| Onboarding / signup | A | Yes | None | — | Low | None |
| Invites | A | Yes | None | — | Low | Prefer over access requests |
| Access requests | C | Partly | Legacy intake, anon insert | Company binding | Low | Don't use for new tenants |
| Nav / routing | **was C, now A** | Yes | Was `grandfathered` fallback | — | Low | Done |
| Shopify connector | A | Yes | None | — | Low | Use for the proof |
| QBO / Redo connectors | B | Yes | None | Per-tenant validation pass | Low | Exercise on tenant 2 |
| Google / TikTok connectors | B | Yes | None | Shared app credentials as repo secrets | Med | Register apps |
| Nightly sync + freshness alarm | A | Yes | None | — | Low | None |
| Backfill workflows | **was C, now B** | Yes | Defaulted to Baseballism | — | Med | Done; still manual |
| Canonical / system reports | A | Yes | None | — | Low | Never source a matview |
| BI dashboards (`/v3/`) | B | Yes | Seeded boards are Baseballism-owned rows | Starter board per tenant | Low | Optional |
| Ask SILO | A | Yes | Tester allowlist (gated feature) | Grant table | Low | Before that ships |
| Finance / accounting / card coding | B | Yes | Seeded COA map is config | Per-tenant mapping | Low | Expected setup |
| Date / period logic | **C** | **No** | **Pacific hardcoded** | Company timezone | **Med-High** | Highest-value remaining fix |
| Storage | A | Yes | None | — | Low | Fixed 2026-09-04 |
| Audit trail | A | Yes | None | — | Low | None |
| Edge function deploys | C | N/A | None | Automation | Med | Manual today |
| Licensing / BBISM wholesale / checkwriter | D | No | By design | — | None | **Do not generalize** |

---

## Recommended proof

**Use Baseballism's own second Shopify store, or a real store the team already
controls, as tenant #2 — not a fabricated company.** The technical requirement
is a store whose OAuth can actually be granted and whose orders are real, so
that "historical data syncs" means something. Test Company already proves the
*shape* (2 connections, 5,271 synced rows) but its newest row is 2025-06-20, so
it proves nothing about a currently-running pipeline.

Minimum data for the proof: **Shopify alone.** It populates `sales_by_day`,
`products_master`, `inventory_on_hand` and `shopify_orders`, which is enough to
light up a canonical report, a departmental surface and Ask SILO. Adding QBO or
ad platforms proves nothing further about the architecture and multiplies the
setup.

Evidence worth keeping: the two-row canonical-report table (same SQL, two
tenants, no overlap), a screen recording of signup → invite → connect → first
report, the acceptance-test output, and a green `verify_v2_schema.sql`.

## What still prevents saying "SILO is multi-tenant SaaS ready"

1. No second tenant with a **currently running** sync.
2. Pacific is hardcoded, so period-anchored reporting is wrong for any client
   outside that timezone.
3. Backfills and edge-function deploys still need an operator.
4. Onboarding has no self-serve connector *validation* step that tells a client
   their data is complete — the freshness alarm covers ongoing lag, not initial
   backfill correctness.

None of these is architectural. The architecture holds: after this change,
tenancy is enforced by RLS on every table, by membership on every grant path,
and by explicit revocation on every path that bypasses RLS.
