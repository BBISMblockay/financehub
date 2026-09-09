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
| 5 | Project workflow | Tables, tools, page. |
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
