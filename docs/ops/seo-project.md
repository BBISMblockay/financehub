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
| Eight collections "don't exist" | Drawn from a `LIMIT 30` query over `shopify_landing_pages_daily`, which is **itself a top-250-per-day slice** — 10,553 of 10,763 rows carry `is_truncated = true`. Its history began 2026-07-28, so the 60-day window asked for was really 42 days. And it records landing *sessions*: a collection with no traffic is absent whether or not it exists. **SILO stores no registry of collections at all.** |
| Google Ads has no category-level reporting | True of our ingestion, false as stated. `scripts/lib/ad-platforms-sync-core.mjs` queries `FROM campaign` and nothing else. Ad groups, keywords, search terms and PMax asset groups are reachable under the **already-granted** `https://www.googleapis.com/auth/adwords` scope. |
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

**Requires a manual edge-function deploy to take effect.** Merging does not
deploy.

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
