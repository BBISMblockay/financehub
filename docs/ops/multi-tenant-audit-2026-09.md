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

## What this audit got wrong

Read this before the rest of the file, because the first version of it led with
"RLS coverage is complete, the tenant model is sound" and that conclusion was
**wrong** — not in its facts, in what it checked.

RLS coverage *is* complete, and every company-scoped policy *is* correctly
AND-ed. Both statements below are true and both were verified. But every one of
those policies resolves through `active_company_id()`, which reads
`profiles.active_company_id` — **and `authenticated` held UPDATE on that
column**. A policy that scopes rows by a column its own subject can rewrite is
not a boundary, and no amount of reading `pg_policy` shows it: the policies are
fine, the privileges under them were not.

Measured on production, 2026-09-17, in a rolled-back transaction: a Test
Company user ran one ordinary self-`UPDATE` and came back with
`active_company_id` = Baseballism, **1,164,910** `sales_by_day` rows visible
against their own 5,271, `is_admin()` true and `is_exec_or_owner()` true. No
membership, no RPC, no admin. That is a complete cross-tenant compromise
reachable from the browser by any signed-in user of any tenant, and it defeats
every other control in this document.

It was found by the **cycle-2 independent review on PR #722**, reported there as
an escalation into `approve_access_request`. It is much larger than that framing
— the approval RPC is one of the things it defeats, not the point of it.

The methodological lesson, recorded because it is the reusable part: **checking
that policies exist and are correctly shaped is not checking that the boundary
holds.** The question that was never asked is "who can write the inputs these
policies read". `verify_v2_schema.sql` now asks it on every run.
See P0-4 below.

**And the lesson had to be learned twice.** After P0-4 was fixed, reviewed and
green, Blake found P0-5: `memberships_insert_self`, a permissive policy letting
any user enrol themselves into any company as `owner_admin`. Same family, one
layer down, and it **defeats** the P0-4 fix rather than sitting beside it —
because it forges nothing. It creates a real membership row and then walks
through `set_active_company()`, which validates membership and duly validates
against the row just created.

So the corrected question above is still not general enough. "Who can write the
inputs these policies read" found P0-4 and would not have found P0-5, because
`entity_memberships` is not read by a policy — it is read by the *functions* the
policies call. The general form is: **enumerate every input to every
authorization decision, and for each one ask who can write it.** In SILO those
inputs are `profiles.active_company_id`, `profiles.role`, `profiles.department`
and `entity_memberships`. Three of the four were self-writable when this audit
began and called the tenant model sound.

## What was already sound

With the above as the correction, these still hold and are the larger part of
the story.

- **RLS coverage is complete** (necessary, and — see above — not sufficient)**.** All ~160 public base tables have
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

## The authorization-input sweep (applying the generalized rule)

Having missed this class twice, the rule was actually run rather than only
written down. Every function that makes an authorization decision was
enumerated, then every table those functions read, then who may write each one.
This is the list to re-check whenever an authz helper is added.

| Authorization input | Read by | Write gate | Verdict |
|---|---|---|---|
| `profiles.active_company_id` | `active_company_id()` — and therefore **every** company-scoped policy | was: any user, own row | **P0-4, fixed** (`20260917210000`) |
| `profiles.role` / `.department` | `is_admin`, `is_admin_user`, `is_exec_or_owner`, `can_manage_journal_entries`, `current_user_can_manage_payment_requests`, `current_user_can_manage_comp_requests`, `po_builder_can_write`, `po_costing_can_write`, `reviews_can_manage`, `is_active_user` | was: any user, own row | **P0-4, fixed** |
| `entity_memberships` | `is_admin`, `is_admin_user`, `is_entity_admin`, `is_entity_member`, `is_exec_or_owner`, `is_owner_admin`, `is_owner_or_admin`, `can_manage_journal_entries`, `current_user_can_manage_*`, `po_*_can_write`, `shares_active_company` | was: **self-insert, any company, any role** | **P0-5, fixed** (`20260917220000`) |
| `silo_chat_managers` | `can_manage_silo_notes` | `company_entity_id = active_company_id() AND is_exec_or_owner()` | Clean |
| `seo_approvers` | `can_approve_seo_tasks` | `company_entity_id = active_company_id() AND is_exec_or_owner()` | Clean |
| `employee_managers` | `is_employee_manager` | `company_entity_id = active_company_id() AND (is_exec_or_owner() OR (manager_user_id = auth.uid() AND is_employee_creator(employee_id)) OR is_employee_manager(employee_id))` | Clean — **verified empirically**, not only read |
| `employees`, `comp_adjustment_requests` | not read by any authz helper | — | Not an authz input |

`employee_managers` was the one worth testing rather than reading, because it is
the only remaining gate with a self-referential branch (`manager_user_id =
auth.uid()`), which is the exact shape of the P0-5 bug. It differs in the part
that matters: every branch additionally requires exec/owner, **or** being the
creator of that employee row, **or** already managing them. Confirmed on
production in a rolled-back transaction — a Baseballism admin who is none of
those three was refused when self-granting management of an employee.

The two co-manager branches are the documented self-service rostering decision
(see `employees` / `comp_adjustment_requests` in CLAUDE.md, and the note that
self-requests are deliberately allowed). They are within-tenant by construction
and are **not** to be "fixed" without asking.

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

**Fixed** in `20260917210000`: revoked from anon/authenticated, default argument
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

### P0-3 — `approve_access_request` granted membership in another tenant

Found by the **cycle-1 independent review on PR #722**, against the first
version of this migration — which closed the coalesce-to-Baseballism rung and
left this one open. Worth recording as a P0 rather than folding into P1-3,
because it is a different and worse bug than the one it was hiding behind.

The cross-tenant guard read:

```sql
if v_req.company_entity_id is not null
   and v_req.company_entity_id <> public.active_company_id() then
  raise exception 'not authorized';
end if;
```

`x <> null` in SQL is **NULL, not TRUE**. So for an approver whose active
company is unresolved the whole condition is NULL, the `IF` does not fire, and
the guard **passes**. That state is reachable by a real caller: `is_admin()`
falls back to the global `profiles.role` (`owner`/`admin`/`executive`) whenever
there is no membership row for the active company — which includes
`active_company_id()` being null. Handed a request id belonging to Tenant B,
such a caller passed the guard, `coalesce` then selected Tenant B, and this
SECURITY DEFINER RPC **granted the applicant a Tenant B membership** that
Tenant B never approved.

The fail-closed check added by P1-3 does **not** catch it: that check tests the
resolved company, and here the resolved company is non-null — it is Tenant B's.

**Fixed**: the approver's company is resolved once, *before* the request is
read, and a null stops the call; the comparison is `IS DISTINCT FROM`, so it
stays a real boolean. Regression in `scripts/tests/tenant-boundary.test.mjs`
runs the real function text out of the migration against a three-tenant fixture
and asserts all three cases — refused for a null-company admin, refused
cross-tenant, and still **granted** for Tenant B's own admin, because a guard
that refuses everything would pass the first two and be useless.

Note the mutation asymmetry, which is why the operator is also pinned
statically: with the null check present, `<>` and `IS DISTINCT FROM` behave
identically, so reverting only the operator does not fail the behavioural test.
That is correct, not a gap — but it means the belt would decay silently.

### P0-4 — `profiles.active_company_id` and `role` were self-writable

The most serious finding in this document, and the one the first audit missed.
See **What this audit got wrong** above for the measurement.

`authenticated` held `UPDATE` on all eleven columns of `public.profiles`. The
policy `profiles_update_self` is `using (id = auth.uid()) with check (id =
auth.uid())` — which constrains **which row** may be written and says nothing
about **which columns**. RLS has no column dimension; column privileges are the
only mechanism, and they had never been narrowed from the schema default. There
is no guard trigger either (`profiles` carries only `set_updated_at`).

The two columns that matter compose into full access:

- `active_company_id` is what `active_company_id()` returns, and every
  company-scoped policy in SILO is `company_entity_id = active_company_id()`.
  Forging it repoints all of them at another tenant in one statement.
- `role` is what `is_admin()` / `is_exec_or_owner()` fall back to whenever there
  is no membership row for the active company — **exactly** the state a forged
  `active_company_id` produces, since the fallback triggers on `em.role is
  null`.

**Fixed** in `20260917210000`: `authenticated` keeps `UPDATE` on exactly
`(name, default_page, avatar_url, updated_at)` — verified against the only
client-side writer, `v2/profile.html`, which writes `{name, default_page,
updated_at}` on save and `{avatar_url, updated_at}` on avatar upload, and
nothing else in the codebase writes this table from a browser. `INSERT` is
narrowed the same way, and `anon` loses both.

Everything else already had a validating path and is unaffected, because those
are SECURITY DEFINER and run as the owner: `set_active_company()` checks
`entity_memberships` before writing, `admin_update_profile()` checks
`is_admin()` plus same-company membership, `approve_access_request()` as
corrected in P0-3. Confirmed on production that a member's
`set_active_company()` switch still succeeds and a non-member's is still refused
with `Not a member of this company`.

Regression: `scripts/tests/tenant-boundary.test.mjs` asserts both directions —
the privilege columns are unwritable **and** the four the profile page edits
still are. Both mutations caught: restoring the blanket grant, and over-locking
so the profile save would break. The over-lock direction matters because the
likely response to a broken profile page is `grant update on profiles`, which
reopens everything.

### P0-5 — `memberships_insert_self`: any user could enrol themselves as owner_admin

Found by Blake on 2026-09-18, against an isolated database carrying the live
permission definitions **with `20260917210000` already applied**. That detail is
the finding: this hole survives the profiles fix.

`memberships_insert_self` was a PERMISSIVE INSERT policy whose entire WITH CHECK
was `(user_id = auth.uid())`. It constrains **who the row is about** and says
nothing about **which company** or **which role**. Permissive policies are
OR-ed, so it granted exactly what the two `memberships_insert_admin*` policies
beside it exist to withhold.

**Why it is not a smaller sibling of P0-4.** P0-4 forged
`profiles.active_company_id` directly, and the fix was to take the column away.
P0-5 forges nothing. It inserts a *real* membership row, then calls
`set_active_company()` — SECURITY DEFINER, which validates membership before
writing `active_company_id` — and that function duly validates against the row
the attacker just created and performs the write itself. The whole attack runs
through legitimate, validated machinery, which is why narrowing profiles column
privileges does not touch it.

Measured on production, 2026-09-18, in a rolled-back transaction with
`20260917210000`'s grants applied first. One INSERT plus one RPC call:

| | before | after |
|---|---|---|
| `active_company_id()` | Test Company | **Baseballism** |
| `sales_by_day` visible | 5,271 | **1,165,018** |
| `is_admin()` | false | **true** |
| `is_exec_or_owner()` | false | **true** |
| `can_manage_journal_entries()` | false | **true** |

That last row is the new ceiling and is worse than P0-4's: it gates every
card-coding table and the QuickBooks post, so this is write access to another
tenant's general ledger, not only a read of their books.

**Fixed** in `20260917220000`: the policy is dropped, and INSERT/UPDATE/DELETE
are revoked from `authenticated` and `anon`. Nothing legitimate used it — every
membership INSERT runs through a SECURITY DEFINER function (`handle_new_user`,
`accept_org_invite`, `approve_access_request`, `admin_update_profile`,
`create_entity_with_owner`) or the service-role client (`org-invite-redeem`),
and no client-side code writes the table at all. SELECT is untouched: the
company picker and login resolve memberships from it.

The policy drop is what closes the hole today (the remaining INSERT policy
requires `is_entity_admin`); the revoke is the belt that stops a future
permissive policy reopening it alone. The regression pins the vulnerability
**before** applying the migration, so the fix assertion cannot pass against a
fixture that never reproduced the bug.

### P1-6 — Requiring a variable broke the workflows that call the script

Also from the cycle-1 review. Making `REDO_COMPANY_ENTITY_ID` mandatory (P1-5)
broke `redo-backfill.yml` and `redo-marketing-probe.yml`, which invoked the
scripts without it — a dispatch would throw at module load with every secret
correctly set. And requiring `company_entity_id` on `mailroom-backfill.yml`
while leaving `sheet_id` blank-defaulted to Baseballism's legacy sheet created
a *new* cross-tenant path: name Tenant B, leave the sheet blank, and every
Baseballism mail row is stamped Tenant B. Requiring one half of a pair was
worse than requiring neither.

**Fixed**: both workflows take a required company input and pass it; the
mailroom sheet is required in both the workflow and the script.
`scripts/tests/workflow-env-contract.test.mjs` is the generic guard — it derives
each script's required env vars from its own throw sites and asserts every
workflow that runs it supplies them, so this is caught for scripts that do not
exist yet. A `workflow_dispatch`-only job otherwise proves itself only when a
human dispatches it, which for a backfill may be months later, mid-onboarding.

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
| **Privileges under RLS** (`profiles` columns) | **was F, now A** | Yes | None | — | **was Critical** | Fixed; RLS was complete and the column it reads was self-writable |
| **Membership grant path** (`entity_memberships`) | **was F, now A** | Yes | None | — | **was Critical** | Fixed; self-enrollment defeated the profiles fix via the legitimate RPC |
| SECURITY DEFINER surface | **was C, now A** | Yes | Default arg → Baseballism | — | **was High** | Applied + allowlisted |
| Onboarding / signup | A | Yes | None | — | Low | None |
| Invites | A | Yes | None | — | Low | Prefer over access requests |
| Access approval RPC | **was C, now A** | Yes | Was coalesce → Baseballism | — | **was High** | Fixed; `<>` against a null company passed the guard |
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

**Tenant #2 already exists and is already syncing.** An earlier version of this
section said Test Company "proves nothing about a currently-running pipeline,"
on the reasoning that its newest `sales_by_day` row is 2025-06-20. That was
wrong, and the error is worth naming because it is the same mistake this whole
audit is about: **I read the data and inferred the pipeline.**

Measured 2026-09-18, in `sync_jobs`. Test Company's two Shopify connections are
`is_active` and `sync_enabled`, they run the **full** nightly job matrix —
`incremental_sales`, `inventory_snapshot`, `payouts_sync`, `draft_orders_sync`,
`catalog_sync`, `collections_sync`, `discount_codes_sync`, `landing_pages_sync`,
`sessions_sync` — and their last successful run finished **2026-09-18 01:59
UTC**, in the same nightly window as Baseballism's 02:03. Over seven days: 658
success, 280 `skipped` (the documented 14:30 catch-up behaviour, which skips
catalog/sessions/landing-pages/discount-codes by design) and **zero errors**.
Baseballism had 14 errors in the same window.

So the second tenant's pipeline is not merely proven historically, it is running
nightly with a cleaner record than the primary tenant's. The sales series stops
at 2025-06-20 because **those shops stopped selling** — a business fact, not a
pipeline gap. A sync that correctly writes nothing when there is nothing to
write is the pipeline working.

What that leaves genuinely unproven is narrower and worth stating exactly: no
tenant has been onboarded **from zero** since this work — Test Company's
connections predate it — so the *first-run* path (OAuth → initial backfill →
first canonical report) has not been exercised end to end by a new customer.
That is a demo to record, not an architectural gap. If you want one anyway, use
a real store whose OAuth can actually be granted; Shopify alone is enough.

Minimum data for the proof: **Shopify alone.** It populates `sales_by_day`,
`products_master`, `inventory_on_hand` and `shopify_orders`, which is enough to
light up a canonical report, a departmental surface and Ask SILO. Adding QBO or
ad platforms proves nothing further about the architecture and multiplies the
setup.

Evidence worth keeping: the two-row canonical-report table (same SQL, two
tenants, no overlap), a screen recording of signup → invite → connect → first
report, the acceptance-test output, and a green `verify_v2_schema.sql`.

## What still prevents saying "SILO is multi-tenant SaaS ready"

1. ~~No second tenant with a currently running sync.~~ **Resolved — and it was
   never true.** Test Company syncs nightly, full job matrix, zero errors over
   seven days (measured 2026-09-18). Its flat sales series is its shops not
   selling. What remains is that no tenant has been onboarded *from zero* since
   this work, so the first-run path is undemonstrated rather than unbuilt.
2. Pacific is hardcoded, so period-anchored reporting is wrong for any client
   outside that timezone.
3. Backfills and edge-function deploys still need an operator.
4. Onboarding has no self-serve connector *validation* step that tells a client
   their data is complete — the freshness alarm covers ongoing lag, not initial
   backfill correctness.

None of these is architectural. The architecture holds — but note what that
sentence is worth, given P0-4: it held on paper before this change too, and the
boundary was still open, because the privileges underneath the policies had
never been audited. After this change tenancy is enforced by RLS on every table,
by membership on every grant path, by explicit revocation on every path that
bypasses RLS, **and** by column privileges on the two `profiles` columns the
policies themselves resolve through.

The standing lesson: when reviewing tenancy here, do not stop at "is there a
policy and is it shaped correctly". Ask who can write the inputs that policy
reads. That question is now a verify check rather than a habit.
