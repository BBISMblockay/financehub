# SEO project — evidence, workflow, implementation plan

Status as of 2026-09-08: **step 1 shipped** (evidence-discipline rules + catalog
caveats). Everything below step 1 is planned, not built.

The goal is a grounded SEO project: prioritised recommendations and
ready-to-publish copy, each traceable to evidence, with results measured
against a baseline. Today Ask SILO can produce SEO-shaped prose but cannot
support most of it — the audit that motivated this is summarised below.

---

## What the audit found (2026-09-08, verified against prod)

A live SEO answer made four claims that the data did not support. None were
query bugs; each turned "absent from what I fetched" into "not real".

| Claim | Why it was wrong |
|---|---|
| Eight collections "don't exist" | Drawn from a `LIMIT 30` query over `shopify_landing_pages_daily`, which is **itself a top-250-per-day slice** — for `baseballism.myshopify.com`, the only shop with real web traffic, **all 42 of 42 days hit the cap**. Its history began 2026-07-28, so the 60-day window asked for was really 42 days. And it records landing *sessions*: a collection with no traffic is absent whether or not it exists. **SILO stores no registry of collections at all.** |
| Google Ads has no category-level reporting | True of our ingestion, false as stated. `scripts/lib/ad-platforms-sync-core.mjs` queries `FROM campaign` and nothing else. Google Ads **supports** ad groups, keywords, search terms and PMax asset groups, and the already-granted `https://www.googleapis.com/auth/adwords` scope **permits querying them** — SILO does not ingest them. Note this says nothing about which of those structures the Baseballism account actually has configured; only a query against the account can answer that. |
| Top sellers recommended for emphasis | No stock or size check. `inventory_on_hand_current_v` was current (same-day snapshot, 20,420 SKUs, 376 distinct `variant_title` sizes) and already exposed to the agent. |
| "Missing integrations" | Only Search Console and page fetching are genuinely missing. Shopify collections/SEO and Ads sub-grains are **ingestion** work on integrations that already exist with sufficient scope. |

Access that already exists and needs no new grant:

- Shopify: `read_products`, `read_publications`, `read_online_store_pages`,
  `read_online_store_navigation`, `read_content`, `read_product_listings`.
  `scopes_missing` is `[]` on every active connection.
- Google Ads: full `adwords` scope.
- GA4: `analytics.readonly`.

Genuinely absent: Search Console (no integration, no scope, no table), and any
ability to fetch a live page.

---

## Step 1 — evidence discipline (shipped)

`supabase/functions/silo-chat/index.ts` — four EVIDENCE DISCIPLINE rules added
to `BASE_PROMPT_AFTER_SCHEMA`, plus a `Not ingested` confidence state and an
SEO/search honesty paragraph.

The rule that already existed — "ABSENCE OF HISTORY IS NOT EVIDENCE AGAINST" —
was correct and **unreachable**: it lives in `PRODUCT_CONCEPT_SYSTEM_BLOCK`,
appended only for concept-mode testers, so an ordinary question never saw it.
A rule in the wrong prompt block is invisible rather than wrong, which is why
`supabase/functions/silo-chat/prompt.test.mjs` asserts *which block* each rule
is in rather than that the text exists somewhere.

`supabase/migrations/20260908150000_chat_catalog_evidence_caveats.sql` — the
same caveats where the model actually reads schema facts. The old landing-pages
description warned against *summing* and that warning worked; it said nothing
about negative claims, and a caveat only covers the failure it names.

Deployed as silo-chat **v59** on 2026-09-09 via
`.github/workflows/deploy-edge-function.yml` (the CLI reads the file off the
checkout; deploying a 123KB function inline through an API client is what
truncated two deploys and took Ask SILO down on 2026-08-25 — do not do that).

### Live results — improvement, not yet consistent compliance

Four real questions against the deployed function (`silo_chat_audit_log`,
2026-09-09 01:45–01:59 UTC). Recorded because a passing prompt test proves
only that a rule reaches the prompt.

| Rule | Result |
|---|---|
| Coverage window disclosed | Fired — volunteered "only goes back to 2026-07-28, ~6 weeks" unprompted |
| Truncation / absence≠zero | Fired strongly on the question built to break it: returned a bottom-10 *and* said the true bottom is unknowable from a top-250-per-day slice, then volunteered that SILO has no page/URL registry to check existence against. Omitted in an earlier answer that stated "zero sessions" flatly |
| Not ingested vs provider capability | Fired, with the reviewed wording intact: "the sync only pulls `FROM campaign`… even though Google Ads' API supports them" |
| Search evidence unavailable | Fired — labelled `Unavailable`, bounded GA4 to channel-level volume "never which query drove it", named GSC and the Ads search-terms report as where it actually lives |
| **Qualifiers survive simplification** | **Failed.** "simplify that" dropped the 6-week window entirely and turned a hedged "likely no indexed hub" into an assertion |

Caveats on the above: two of the four ran in a thread already primed by
earlier answers, which flatters the result; the Google Ads case is the
cleanest signal since that topic had not come up in the thread. n=1 per
behaviour. **These support improvement, not consistent compliance.**

The one failure is addressed by the follow-up rule change (bind the qualifier
into the claim sentence rather than parking it beside the claim): the caveat
that survived compression was the one that *was* the finding, so the
distinguishing property is detachability, not importance.

---

## Workflow design

### Reuse assessment (checked, not assumed)

- **`launch_tasks`** backs `/v2/tasks.html`. `launch_id` is nullable, so a
  launch-less task is structurally possible — but the page joins
  `launch_calendar`, and the table has no column for target URL, target
  queries, current-vs-proposed copy, publication verification or evidence.
  *Verify before deciding:* whether the Task Manager renders a row with a null
  `launch_id` or silently drops it. If it drops it, SEO tasks written there
  would be invisible, which settles the question.
- **`product_concepts` / `product_concept_revisions`** is the pattern to copy:
  a structured artifact drafted in chat, `draft → approved`, immutable history
  via a `BEFORE UPDATE` trigger writing to a revisions table with **no client
  write policy**, a browse page, and `?concept=<id>` deep-linking back into chat
  so a refinement *revises the row* instead of creating a second one. Reuse the
  revision mechanism and the chat-continuation pattern directly.
- **`silo_chat_saved_reports`** stores re-runnable SQL. Good for a live metric;
  wrong for a baseline, which must be frozen (see below).

### Tables

- `seo_projects` — name, objective, status, target window.
- `seo_tasks` — one prioritised recommendation: target URL, target queries,
  task type (metadata / body copy / internal linking / new collection /
  redirect), priority **plus the evidence that set it**, current vs. proposed
  copy, status.
- `seo_task_revisions` — trigger-written, no client write policy.
- `seo_measurements` — baselines and follow-ups, discriminated by `kind`.

### Measurement integrity

Every measurement row records **source** (`gsc` / `ga4` / `shopify`),
**reporting period** (start and end), **capture time**, **dimensions**,
**filters applied**, and **completeness** (sampled? truncated? provider still
restating?). A number without those is not comparable to another number.

- **GSC query/page metrics and GA4 landing-page sessions stay in separate
  rows and are never joined into one figure.** Sessions cannot be attributed
  to individual search queries — no join exists that would make that true, and
  presenting one would be the same class of error as the audit found.
- **Baseline is captured by a deterministic function, before publication** —
  never by the model writing numbers into a row. Model-assembled baselines look
  queried without being reproducible, which is the exact failure this project
  exists to correct. GSC restates its data, so a frozen snapshot is the only
  thing a later comparison can honestly be measured against.
- **Publication date is recorded as an event**, not inferred from approval.
- **Follow-ups use comparable windows** (same length, same dimensions, same
  filters, seasonality noted).
- **A before/after change is evidence of movement, not proof of causation.**
  Rankings move for reasons that have nothing to do with the edit. Language in
  every surface must say "moved", never "caused" or "delivered".

### Status model

`draft → approved → published → measured`, with one hard rule:

> **Approval never advances status to `published`.** `published` requires a
> recorded confirmation — a human confirming the change is live, or an
> automated verification that fetched the URL and found the change. Publishing
> stays manual and outside SILO. Approved drafts export for someone to apply.

Nothing here needs Shopify write scope, and nothing in the audit argues for it.

### Approval permission

A dedicated SEO approval grant — **not** `is_admin_user()`, which passes for
any membership `admin`, and 28 of 29 Baseballism profiles are membership
`admin`. Same reasoning that made `can_manage_journal_entries()` its own gate.
Company-isolated, enforced server-side in RLS, following the
`silo_chat_managers` precedent for a narrow per-user grant.

**Open: confirm the initial approver list before assigning it.**

### Fetch tool protections

Implemented in the edge function (Supabase infra — the egress restriction is
the dev sandbox's, not production's). Arbitrary URL fetching is an SSRF
surface, so: allowlist only, built from `shopify_connections.shop_domain`
**plus verified custom storefront domains** (the public site is not a
`myshopify.com` host, so a Shopify-domain-only allowlist would fail on every
real page); private/link-local IP ranges blocked; redirects re-checked against
the allowlist rather than followed blindly.

---

## Collections registry — shipped and scheduled (2026-09-09)

Ingestion runs on the **08:30 UTC nightly only** — not the 14:30 catch-up,
not the 2-hourly refresh — and stays non-fatal.

Enabled on three manual single-shop runs against `baseballism.myshopify.com`,
byte-identical each time: 153 pages, **349 collections**, 51,713 memberships,
`completed_at` set, `marked_missing` 0. After the publication fix, all 349
resolve, with 6 `false` values that are all app scaffolding (`Smart Products
Filter Index - Do not delete`, `[XCloud Search app] All products`, and
similar) rather than merchandising — which is what makes the boolean
believable rather than merely non-null.

### Open, in priority order

1. **Product-grain mapping table.** Collection membership joins
   `products_master` on `shopify_product_id` at **94.1% observed coverage**
   (2,299 of 2,442 distinct products, measured 2026-09-09). This is a GRAIN
   MISMATCH, not missing data, and will not improve by re-syncing:
   `products_master` is one row per `(company_entity_id, sku)`, and
   `runCatalogSync` keeps the first variant per SKU, so when two Shopify
   products share a SKU the row records whichever was seen first and the
   other product id becomes unreachable. Verified: 49 of the 51 SKUs behind
   unmatched products ARE present, stamped with a different product id.
   Build a product-grain table before collection membership drives any
   sales/inventory prioritisation. Until then, quote 94.1% as *observed join
   coverage* and never as "6% of products are missing".

2. **One traffic handle absent from the registry.** Exactly one
   `/collections/{handle}` path with recorded sessions has no matching
   registry row. Most likely a rename, a redirect, or historical traffic to
   a since-deleted collection — unconfirmed. Worth resolving because it is
   the one case where the registry and the traffic data actually disagree.

3. **277 collections have no hub-traffic row.** An INVESTIGATION SET, never
   a claim of zero traffic: `shopify_landing_pages_daily` keeps only the top
   ~250 paths per day and the online store hits that cap every day, so a
   collection can have real traffic and no row. Anything derived from this
   list must carry that qualifier.

4. **Run-level reporting.** Verification queries currently join
   `shopify_collection_sync_runs` to *current* table state, so a query about
   run 1 silently reports what the table looks like today — three historical
   runs all appeared to have resolved publication when only the third did.
   Snapshot the per-run counts onto the run row so a past run's result stays
   readable.

## Sequence

| # | Step | Notes |
|---|---|---|
| 1 | Evidence discipline | **Shipped.** Needs deploy. |
| 2 | Search Console integration | The long pole. Search-performance and URL-Inspection are separate deliverables with separate quotas. |
| 3 | Page inspection tool | Allowlisted fetch, per above. |
| 4 | Shopify collections/pages sync | Registry + SEO fields + publication status; add `shopify_product_id`/`handle` to the catalog sync so membership joins work — `products_master` has no Shopify identifier today. |
| 5 | Project workflow | **Schema shipped** (`20260909240000`), applied. Tools and page still to build. |
| 6 | GA4 landing-page dataset | **Separate dataset, not a dimension added to `marketing_kpis_daily`.** Adding `landingPage` to the existing campaign/channel ingestion would multiply rows against a table whose grain is day × platform × account × campaign and silently break every existing spend total. Needs its own table and its own grain-safety check. |
| 7 | Google Ads sub-grains | Paid search only; not an SEO prerequisite. |

Tasks and drafts (step 5) may ship before Search Console if useful. Copy
preparation grounded in sales, inventory and on-site traffic is legitimate work
— it just must be labelled *search evidence unavailable* and never presented as
a measured search opportunity or a ranking claim.

## To verify before building step 2

Not asserted here, and to be checked against current Google documentation
rather than recalled: Search Analytics row caps per request and pagination
behaviour, the data lag (believed ~2–3 days), the retention window (believed
16 months), and URL Inspection's daily quota — that last one decides whether
indexing checks are on-demand or a slow background crawl. The property must
also be verified and match the storefront domain.

### Step 2a — connection plumbing (shipped, unmeasured)

How much of step 2 was actually new turned out to be smaller than this
document implied. The Google OAuth path is *already* scope-parameterised by
platform (`google-oauth-start`'s `SCOPES` map), tokens already live on
`ad_platform_connections`, the callback already handles a missing refresh
token, and `test-ad-platform-connection` already has the "no account
configured → return the pickable list" shape. The one thing that genuinely
blocked reuse was `ad_platform_connections_platform_check`, which permitted
only `google_ads | meta_ads | tiktok_ads | ga4`.

So step 2a is: extend both platform CHECKs, add `search_console_site_url`,
one `SCOPES` entry (`webmasters.readonly`), a Connect button, and a tester
that lists verified properties. `ad-platforms-sync.mjs` skips
`search_console` **by name** — it has no `JOB_TYPES` entry, and falling
through would insert a null `job_type` and fail the CHECK, turning "not
wired yet" into a nightly error on a healthy connection.

**No metric tables ship in 2a, deliberately.** Their grain depends on five
things nobody here has measured, and `scripts/search-console-probe.mjs`
(read-only, `workflow_dispatch`) measures all five against the live account:
lag, retention, the real row cap, cross-dimension loss, and — the one that
decides whether a negative claim is ever safe — **what share of a day's
clicks Search Console will attribute to a query at all**. Rare queries are
withheld for privacy, so the sum of per-query clicks is structurally less
than the day's total. That is the same trap as
`shopify_landing_pages_daily`'s top-250-per-day slice, and worse, because a
query table looks complete. The probe compares an undimensioned total
against the summed per-query and per-page cuts and prints the gap as a
percentage, which is what lets the catalog state a number instead of a
warning nobody can act on.

Two things remain genuinely unknown and are settled by running it, not by
reasoning: whether the consent screen's configuration makes
`webmasters.readonly` (a sensitive scope) a re-verification event, and
whether `www.baseballism.com` is verified as a URL-prefix property
(`https://www.baseballism.com/`) or a domain property
(`sc-domain:baseballism.com`). Those cover different traffic and are not
interchangeable, which is why `search_console_site_url` stores whatever
`sites.list` returned verbatim rather than a normalised host.

Order of operations: apply the migration → deploy `google-oauth-start`,
`google-oauth-callback` and `test-ad-platform-connection` → enable the
Search Console API in the existing Cloud project → Connect (a fresh consent
is required; an existing refresh token does not carry a newly added scope)
→ Test to list properties → paste the identifier → run the probe.

## Step 5 — project workflow schema (shipped 2026-09-09)

### Why new tables rather than the existing task system

**Correction to the first version of this section and to commit `b1d0a8d`'s
message.** They said reusing `launch_tasks` "would mean minting a
`launch_calendar` row per SEO project". That is wrong. `launch_id` is nullable,
`/v2/tasks.html` fetches `launch_tasks` and `launch_calendar` as two separate
queries rather than joining them, it renders the launch cell conditionally, and
it ships an explicit `__evergreen__` filter (`if (t.launch_id) return false;`)
for exactly this case. **Launch-less tasks are a first-class, already-supported
concept there.** No fake launch row would have been required, and the open
question recorded in the Reuse assessment above — whether the Task Manager
drops a null-`launch_id` row — is answered: it does not.

The real reasons are narrower, and they are about the invariants rather than
about launches:

- `launch_tasks` carries `task_title`, `task_type`, `status`, `priority`,
  `due_date`, `assigned_to`, `notes`, `sort_order`, `is_private`. It has no
  target URL/handle/type, no current-vs-proposed copy, no rationale or
  evidence, no approver identity, no revision history, no publication event,
  and no measurement linkage.
- Its `status` is a single freely-writable text column. Both invariants below
  require the opposite: **no** publication column at all, and approval gated in
  a policy `WITH CHECK`. Retrofitting those onto a table that backs a live
  tool — where any member can change `status` today — would change the
  semantics of something already in use and risk breaking the Task Manager for
  launch work.

So: separate tables, to keep the guarantee without touching a live surface. The
*patterns* are borrowed — immutable revisions via a `BEFORE UPDATE` trigger
from `product_concepts`, a narrow grant table beside a role check from
`silo_chat_managers`.

There is also **no generic `tasks` table** in this database; `/v2/tasks.html`
is built entirely on `launch_tasks`. That part was checked and is accurate.

### The two invariants, and why they are structural

**1. Approval never publishes anything.** `seo_tasks` has *no publication
column* — not a flag, not a status value the pipeline can advance into.
A task is published if and only if a row exists in `seo_task_publications`,
and `seo_tasks_v.is_published` derives it from there. There is no code path,
policy gap or well-meaning `UPDATE` that can mark something live because it was
approved. `verify_v2_schema.sql` fails loudly if a `%publish%` column ever
appears on `seo_tasks`.

`method` is either `manual_confirmation` (a person states they made the change
live) or `verified_capture`, which a CHECK constraint requires to carry a
`page_inspections` id — a "verified" publication with nothing to verify against
is a claim wearing a stronger word. `published_at` is the *actual* date the
change went live; `recorded_at` is when someone typed it in. Follow-up windows
measure from the former.

**2. A baseline must predate the change it is a baseline for.** Enforced by
trigger on the reporting **period**, not on `captured_at` — recording a
baseline late is normal, measuring one over a window that runs past publication
is a follow-up mislabelled.

### What is deliberately absent

There is **no baseline-vs-follow-up delta view**. A change between two windows
is evidence of *movement*, never proof of causation — seasonality, promotions,
paid spend and site-wide changes move the same numbers — and a view handing
back a tidy "+18%" invites exactly the claim the rest of this work exists to
prevent. The caveat is carried in the `seo_measurements` catalog entry, which
`verify_v2_schema.sql` checks is still there.

`seo_measurements.source` is a constrained list so the two search sources stay
nameable and separable, and the catalog entry states the rule directly: never
combine `search_console_query` rows with GA4/Shopify session rows, and never
attribute sessions to an individual query. `is_complete` is tri-state — null
means nobody established completeness, which is not the same as incomplete.

### Approvers

`can_approve_seo_tasks()` = `is_exec_or_owner()` **or** a `seo_approvers` grant
for the caller's **active** company. Company isolation is inside the function,
so an approver at one tenant cannot approve at another. Deliberately *not*
`is_admin_user()` — 28 of 29 profiles here carry membership `admin`.

`seo_approvers` is intentionally **empty**: the decision was exec/owner level,
and those seven already pass without a grant. The table exists so access can be
handed to someone specific later without promoting them to `executive`
company-wide.

Who passes today (2026-09-09): Blake Evetts (owner), Ben Atkinson, Chris
Clements, Kalin Boodman, Jon Loomis, Travis Chock, and **Daniel Lopez
(`dlopez.wpv@gmail.com`)** — the only non-`baseballism.com` address in the set,
carrying a pre-existing `executive` profile role. Flagged for confirmation
rather than changed.

### Testing

`scripts/sql/verify_seo_workflow.sql` exercises the behaviour against a real
database and rolls back. All nine assertions pass, including both invariants.
It runs as service role, so it does **not** exercise the RLS policies
themselves — approval enforcement is asserted structurally in
`verify_v2_schema.sql`, and confirming it end to end needs impersonation, the
way the storage-isolation work was checked. That is the open gap in this step.

### Still to build

The tools and the page. The schema is the contract; nothing writes to it yet.

## Review fixes (2026-09-09, forward-corrective)

Review of the first cut found six blockers. All six were reproduced before
being fixed; the two migrations were already applied to production, so the
schema fixes are a **forward-corrective migration** (`20260909260000`) rather
than edits to already-applied files.

| # | Finding | Fix |
|---|---|---|
| 1 | Exact hostname matching does not stop an allowlisted domain **resolving** to a private/link-local address; stale primary domains were never retired; http was permitted | HTTPS only; every hop's host is resolved and every returned address must be public unicast, checked at the fetch layer; the shop-domain sync now **deletes** hosts a shop no longer serves |
| 2 | The 2 MiB and 15 s limits were decorative — the timer was cleared in a `finally` that ran *before* the body was read, and `response.text()` downloads everything then truncates | One controller and one timer spanning redirects **and** body download; the body is streamed and stops at `MAX_BYTES + 1` |
| 3 | The baseline invariant checked only on measurement insert, so a publication recorded afterwards could land inside an existing baseline window; same-day windows passed | Reciprocal trigger on `seo_task_publications`; shared `seo_baseline_conflicts()` so the two cannot disagree; `>=` rejects a baseline ending on the publication date |
| 4 | Children carried their own `company_entity_id` next to a single-column FK, so a row could cite another tenant's parent and still look native to every downstream join | Composite `(id, company_entity_id)` foreign keys throughout; cited evidence is `ON DELETE RESTRICT`, not `SET NULL` |
| 5 | A capture whose insert failed returned `ok: true` with a null id — evidence that looks like it worked | Returns 500 `capture_not_stored` |
| 6 | Neither new suite ran in CI, and the workflow had no path trigger for the function directory | Both added to `sync-tests.yml`, plus `supabase/functions/page-inspect/**` |

### The SSRF claim, restated honestly

The first version said an exact-match allowlist excluded private-range access
"structurally". It does not. It stops an attacker **naming** an internal
address; it says nothing about an allowlisted name **resolving** to one. The
mitigation is now a stack: exact-match allowlist of domains Shopify vouched
for, HTTPS only, resolution validated on every hop, stale domains retired
promptly.

**Residual risk, stated rather than glossed:** this is check-then-connect, so a
zone returning a public address to our lookup and a private one to the
connection a moment later (DNS rebinding) is not defeated by it. Closing that
needs connecting to the validated address with an explicit `Host` header, which
`fetch()` does not expose.

### Still not covered

`scripts/sql/verify_seo_workflow.sql` runs as service role, so it exercises
constraints, triggers and the view — **not** the RLS policies. Approval
enforcement and company isolation are asserted structurally in
`verify_v2_schema.sql`; confirming them end to end needs impersonation, the way
the storage-isolation work was checked. That remains the open gap.

## Second review round (2026-09-09)

Four further gaps, all reproduced before fixing.

### 1 — DNS rebinding is now closed, not just reduced

The previous version validated the resolved addresses and then called
`fetch(host)`. That is **two independent lookups**: the one we approved and the
one the connection used, with nothing binding them. A zone answering
differently a moment later won, which is why the last PR could only claim the
blocker was *reduced*.

The connection is now made to the **validated address** via `Deno.connectTls`,
with `servername` set to the hostname — so TLS SNI and certificate validation
remain pinned to the storefront name. Connecting by address does not weaken
authentication: an attacker who can point DNS at their box still cannot present
a valid certificate for `www.baseballism.com`.

That means speaking HTTP/1.1 ourselves. The request is shaped to keep the
reader minimal — `Connection: close` (no keep-alive framing to desynchronise)
and `Accept-Encoding: identity` (no decompression in the path). Chunked
transfer-encoding is still handled, because a server may use it regardless.
Parsing lives in `inspect-lib.mjs` and is unit-tested: header-end location,
status/header parsing, duplicated `Location` keeping the **first** value,
chunked decode with and without its terminator, chunk extensions, bad chunk
sizes, and the byte cap applied to a chunked body.

**Deployment risk, stated plainly:** whether `Deno.connectTls` is available in
the Supabase Edge runtime is **unverified**. The code **fails closed** if it is
absent — it raises `tls_connect_unavailable` rather than falling back to
`fetch()`, because a silent fallback would reopen exactly the hole this closes.
So if the runtime lacks it, page-inspect will not work at all until that is
resolved. That is the deliberate trade: no captures beats captures made through
an unpinned connection.

A non-443 port is now also refused. A storefront is served on 443; an explicit
alternate port is not a storefront, and allowing one widens what an allowlisted
name can reach on a host we do not otherwise control.

### 2 — The deadline now covers DNS

Neither `Deno.resolveDns` nor the DNS-over-HTTPS fallback took the abort
signal, so a hanging resolver sat entirely outside the 15 s budget.
`resolveHostAddresses` now races `resolveDns` against the abort and passes
`signal` to the DoH request, and the TLS socket is closed on abort. No step is
left outside the budget.

### 3 — A failed retirement sweep is no longer logged as success

`sweep_error` was returned and ignored. The dangerous combination is precisely
the one that used to print `[ok]`: hosts written, retirement failed — new hosts
authorised while retired ones stay authorised, indefinitely and invisibly. The
orchestrator now warns explicitly and names the consequence, and a successful
run reports what it retired.

### 4 — The baseline boundary was session-dependent

`seo_baseline_conflicts()` compared a `date` against `timestamptz::date`, which
reads the session `TimeZone`, while being declared `IMMUTABLE`. Measured on
this database:

```
set time zone 'UTC';                  '2026-09-01T02:00:00Z'::date => 2026-09-01
set time zone 'America/Los_Angeles';  same value            ::date => 2026-08-31
```

A publication at 02:00 UTC on the 1st is 19:00 Pacific on the 31st, so the
boundary the entire invariant rests on moved by a day between connections — and
`IMMUTABLE` entitled the planner to fold a result computed under one timezone
and reuse it under another.

Now an explicit `AT TIME ZONE 'America/Los_Angeles'`, matching
`silo_business_today()`, which exists in this repo for the same reason.
`timestamptz AT TIME ZONE '<literal>'` is genuinely immutable, so the marking
becomes true rather than being downgraded. Verified identical under UTC and
Asia/Tokyo sessions after the change. Pacific is hardcoded for the same reason
it is in `silo_business_today()`: a tenant elsewhere needs it read from their
company record, which is a wider change.

## Third review round (2026-09-09) — pinned connect, and the deploy gate

### `connectTls` replaced with `connect` → `startTls`

Same guarantee, expressed so it cannot be tidied away:

```
Deno.connect  -> plain TCP to the VALIDATED ADDRESS   (this is the pin)
Deno.startTls -> TLS over that socket, hostname = the STOREFRONT NAME
                 (this is what SNI carries and what the cert is checked against)
```

`connectTls({ hostname, servername })` did the same job, but reads as an option
on a call whose `hostname` is doing the connecting — one plausible "simplify
this" later collapses the two into a single hostname, the connection
re-resolves, and the pin is gone with nothing failing. Splitting the steps makes
the two values visibly independent. `startTls` is also the more widely available
of the two APIs.

Both are feature-detected and **fail closed**: if either is missing the function
raises `tls_connect_unavailable` rather than falling back to `fetch()`.

### The integration test

`scripts/tests/page-inspect-tls.test.mjs`, all on localhost, in CI:

- a real split header block and chunked body, read off a socket and parsed by
  the actual helpers — the title tag is deliberately split *across* two chunks
- the server sees `Host:` = the storefront name, never the address
- **TLS validates the NAME while TCP went to the pinned ADDRESS**, asserted from
  both ends: the server records SNI = storefront and peer = `127.0.0.1`
- **claiming a different name over the same address FAILS certificate
  validation** — the assertion that says pinning by address does not weaken
  authentication
- an untrusted certificate is rejected even for the right name

Node's `net`/`tls` stand in for `Deno.connect`/`Deno.startTls`: the same two-step
shape. This proves the *shape* and the parser. It cannot prove the Deno runtime
exposes those APIs — that is the live smoke test below.

The TLS half mints a throwaway certificate with `openssl` and **skips (does not
fail)** without it, the same stance as the v3 browser suites. Verified both
ways: 5/5 with openssl, 2/2 and a reported skip without it, exit 0 either way.

### Deploy gate — page-inspect stays undeployed until this passes

The one thing no test here can settle is whether the Supabase Edge runtime
exposes `Deno.connect` and `Deno.startTls`. **Do not consider page-inspect
shipped, and do not wire any UI to it, until one live call succeeds.**

Order:

1. Merge, then deploy `page-inspect` (`verify_jwt: true`).
2. One call, as a signed-in admin whose active company has a
   `shopify_shop_domains` row:
   `POST /functions/v1/page-inspect  {"url":"https://www.baseballism.com/"}`

**Passes** when the response has `ok: true`, a non-null `inspection_id`,
`http_status: 200`, a non-empty `title`, and `fetch_error: null` — and the
matching `page_inspections` row exists.

**Fails closed** if the response carries
`fetch_error: "tls_connect_unavailable: ..."`. That is not a security problem —
the function refuses to fetch rather than falling back to an unpinned
connection, and it still records the attempt — but the tool is inert until the
runtime question is resolved. In that case the options are a Deno version with
those APIs, or moving the fetch to a runner that has them (the GitHub Actions
path the probes already use).

Nothing is deployed as of this writing.

### Fourth round — the deadline claim was still false

Review caught that the previous round's comment ("no step is left outside the
budget") was not yet true. `Deno.connect` and `Deno.startTls` were both plain
awaits, and the abort handler was attached only *after* the handshake resolved —
so an abort during either did nothing, and an abort mid-handshake had no socket
to close.

Fixed, and the bound is now a tested function rather than a claim:

- `opts.signal` is passed into `Deno.connect` **and** the call is raced against
  the abort. Relying on the option alone would make the deadline depend on a
  runtime detail we cannot check from here.
- The closer is attached to the **raw TCP socket before the handshake is
  awaited**, and only re-pointed at the TLS connection once the handshake
  succeeds — the raw socket is consumed by `startTls` and must not be closed
  separately afterwards.
- The handshake is raced too. A peer that completes TCP and then never finishes
  TLS is exactly the shape that hides inside an unbounded await.

`raceAbort()` lives in `inspect-lib.mjs` and is unit-tested, including the part
that is easy to get wrong invisibly: **losing the race does not cancel the
underlying connect**, so a socket that arrives after the abort is closed rather
than leaked. Without that, every timed-out inspection leaks a live connection
and the leak is unobservable because the request already returned. Also tested:
a genuine failure still surfaces as itself rather than as a timeout, and the
abort listener is removed so it cannot accumulate across redirect hops.

The comment now enumerates what is bounded step by step instead of asserting a
summary. Three rounds of review each found another step outside the deadline,
and each time the summary sentence is what stopped anyone looking.

## After the first full multi-shop nightly (2026-09-09)

### The product-grain prediction was confirmed

PR #639 recorded a falsifiable prediction: coverage through
`products_master` would **fall** after a multi-shop sync, and if it held steady
the stated mechanism was wrong. Measured after the nightly:

| | One shop synced | After the nightly |
|---|---|---|
| `products_master` rows stamped | 9,868, all one shop | 23,986, across 20 shops |
| Collection products joinable via `products_master` | 2,299 / 2,442 = **94.1%** | 4,099 / 12,890 = **31.8%** |
| Joinable via `shopify_product_skus` | — | 12,890 / 12,890 = **100%** |

One row per `(company, sku)` means the product id belongs to whichever shop
synced last, so the join degrades as shops are added. The mapping table is the
difference between 32% and 100%.

`shopify_collection_skus_v` now resolves fully: 315,644 rows, 0 unresolved,
16,319 distinct SKUs.

### Empty collections were invisible (fixed, 20260909320000)

The view LEFT-joined product→SKU but INNER-joined collection→membership, so a
collection with no products vanished — the same absence-semantics mistake one
join further up. **45 collections were invisible, 42 of them published to the
online store**: live pages with nothing on them, which is a real SEO finding
the view was hiding.

Found because Ask SILO answered "all 341 collections" from the view while the
registry held 349. The model reported the view faithfully; the view was wrong.

Now two flags, each meaning one thing: `collection_is_empty` (a live page with
no products — a merchandising question) and `sku_unresolved` (it has a product
but no SKU mapping yet — a sync-coverage question). On an empty collection
`sku_unresolved` is false, because there is nothing to resolve.

Verified after the fix: 636 registry collections, 636 reachable in the view on
`(company, shop, collection)`, zero missing.

### Duplicate hosts in the allowlist are intentional

`baseballismchicago.myshopify.com` and `baseballismdsg.myshopify.com` each
appear twice in `shopify_shop_domains`, once for Baseballism and once for Test
Company, because **both tenants hold active connections to those shops as a
deliberate multi-tenant test fixture** (confirmed 2026-09-09). The unique index
is `(company_entity_id, host)`, so two rows are correct, and the allowlist is
faithfully recording what Shopify vouched for per company.

Recorded here because it looks exactly like a cross-tenant leak to anyone
reading the table cold, and it is not one. The same duplication is why a
distinct count of bare `shopify_collection_id` (626) is lower than the registry
row count (636) — ten collections exist under both companies. Compare on the
full identity.

---

## Readiness ledger (2026-09-09)

What is actually usable today, so a plan is never built on a capability that
does not exist. Each line is a claim about the SYSTEM, not about intent.

| Capability | Status | What that means in practice |
|---|---|---|
| **Shopify evidence** | **Operational** | `shopify_landing_pages_daily` holds 730 days (2024-09-09 → 2026-09-08), 182,502 rows, 7,162 paths for the DTC store. `shopify_sessions_daily` holds 744 days of store-level totals. `shopify_collections` registry is complete and swept nightly. |
| **Page inspection** | **Operational** | `page-inspect` v1 deployed, `verify_jwt: true`, host allowlist read under the caller's JWT from `shopify_shop_domains`. Verified live against `/collections/mlb`. |
| **Candidate selection** | **Operational (new)** | `seo_collection_candidates(p_days, p_shop_domain)` returns collection landing pages with a shop-scoped `inspect_url` already built. |
| **Search Console** | **Awaiting access / OAuth** | Connection plumbing shipped (`search_console` platform + scope). No property connected, no data. **No queries, impressions, clicks, CTR, positions or indexing status exist anywhere in SILO.** |
| **Competitor SERP monitoring** | **Not integrated** | No SERP data source of any kind. Competitor rank snapshots cannot be produced. |
| **Google Ads search-term / keyword / ad-asset grains** | **Not integrated** | `marketing_kpis_daily` is CAMPAIGN grain only — 8 Google campaigns. No search terms, keywords, negatives or RSA assets. |
| **Draft → approval → baseline → 30d → 90d workflow** | **Schema only, not built** | `20260909240000` created the tables and invariants; nothing writes to them and there is no UI. Recommendations today are chat output, not tracked projects. |

### The pre-Search-Console workflow (shipped 2026-09-09)

Ask SILO can now run an on-page SEO review end to end without the user
supplying a single URL: query `seo_collection_candidates(90)`, shortlist on
evidence, inspect up to five pages sequentially, and return paste-ready draft
edits with their evidence and limits. It stops at draft — there is no Shopify
write path and no ad mutation path, in the prompt or in the tool list.

**Two hazards this had to solve, neither of them obvious:**

**The wrong-store URL.** Baseballism owns two `primary` storefront hosts —
`www.baseballism.com` (DTC, 182,502 landing rows) and `baseballismb2b.com`
(wholesale, 32 rows). Both are legitimately allowlisted for the same company,
so `page-inspect` will fetch either. Pairing a DTC path with the B2B host
returns HTTP 200 from a real page that has nothing to do with the traffic being
discussed — a confident, well-formatted, entirely wrong answer. **The SSRF
allowlist cannot catch this, because nothing about it is a security
violation.** `seo_collection_candidates` joins the host on
`(company_entity_id, shop_domain)` — the same shop the sessions were measured
on — and returns a NULL `inspect_url` rather than borrowing a sibling store's
domain.

**Collection roots vs subpaths.** Of 1,311 distinct landing paths in the last
90 days, only 85 are collection roots (`/collections/handle`); 290 are
subpaths (`/collections/handle/product-slug`), which are PRODUCT pages reached
in a collection context. Attributing a product page's sessions to a collection
and then rewriting the collection's copy is a silent, plausible error. Only
anchored roots are returned.

### What the workflow may never claim

Enforced in the prompt and asserted in `scripts/tests/seo-orchestration.test.mjs`:

- `shopify_sessions_daily` (store totals) and `shopify_landing_pages_daily`
  (per-page, truncated) are different grains and are **never added together**.
- Landing-page data is truncated to the top ranked pages per day — on this
  store **every one of 730 days hit the cap** — so a page's absence is never
  evidence of zero traffic, and the coverage window must be stated.
- These are **on-site sessions**, never "organic traffic".
- No queries, keywords, indexing status, rankings, impressions, CTR or
  organic-search attribution. A page fetching successfully is **not** evidence
  Google indexed it.
- No competitor rank snapshots without a real SERP source.
- No search-term, keyword or RSA conclusions from campaign-grain ad totals.
- **No "official" / "officially licensed" language at all.** There is no
  licensing field anywhere in the schema, so a "verify licensing first" rule
  would be unfollowable — the honest rule is not to make the claim.
- "For love of the game" is protected and reproduced exactly or not at all.
- Everything produced is a draft for human review.
