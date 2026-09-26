# SEO competitor research — scope, data source, and what can be done before one is chosen

Written 2026-09-14 as part of the SEO project's second phase. **Status
2026-09-26 (evening):** the provider-independent schema below is BUILT and
APPLIED (`20260926120000`), **DataForSEO is chosen, opened, verified and
probed** (repo secrets `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` set; the
probe's measurements are in "What the provider actually does" below), and
**the weekly writer is built** (`20260926140000`,
`scripts/lib/seo-serp-sync-core.mjs`, `seo-serp-sync.yml`). No company's
`seo_serp_schedules` row is switched on yet, so SILO still holds no
provider-written SERP row.
The rest of this file records the scope, the provider comparison and cost
model, the keyword-set method that needs no provider, and the boundary between
measured, modelled and editorial.

## Three kinds of number, never mixed

| Kind | What it is | Where it would come from |
|---|---|---|
| **Measured ranking** | One SERP fetched on a date, for a location and device, recording position, URL and domain | A live-SERP API (or, for a dated pilot, a person) |
| **Estimated search volume** | A modelled figure: Google Ads rounded buckets, clickstream calibration, a vendor blend | A keyword-data product; always labelled as modelled |
| **Editorial judgment** | Intent classification, gap prioritisation, positioning | A person, with the two above as evidence |

SILO's own Search Console rows are a fourth thing: **our** measured
impressions, clicks and average position per query and per page. They say
nothing about who else ranks, and their query cut recovers only ~57% of clicks
(the rest belong to no returned query row), so they seed a keyword set; they
do not measure a SERP.

## Search competitors are not commercial competitors

A commercial competitor sells to the same customer (other baseball-apparel
brands). A **search competitor is whoever appears on the SERP for a keyword we
care about** — for "baseball dad hat" that may be a marketplace, a team store,
a big-box retailer or a media site, none of which compete for wholesale
accounts. The two lists are kept separately, and only the search list is
derived from data: a domain is a search competitor for a keyword because it
was OBSERVED at a position on a date, not because someone knows the brand.

## The bounded keyword set (provider-independent, doable now)

Grounded in four sources SILO already holds, in this order of authority:

1. **Search Console queries** — `search_console_query_daily` over the last 90
   ingested days: top queries by clicks and by impressions, with the window's
   unattributed share stated beside the list (it is ~43%; a query not in the
   table may still bring traffic). Position here is *our* average position
   for the query.
2. **Collections** — `shopify_collections` handles and titles for collections
   that are published, non-empty and have landing traffic
   (`seo_collection_candidates(90)` with `candidate_status = 'reviewable'`).
   Each yields a head term (the collection subject) and a modifier set.
3. **Products** — `products_master` product types with live Shopify status,
   for the product-type vocabulary ("dad hat", "raglan", "hoodie").
4. **Business priorities** — the launches on `launch_calendar` for the next
   two quarters and the inventory position (`inventory_workboard_v` weeks of
   cover): a keyword whose product is out of stock is not a priority, and a
   launch with no ranking page is.

Selection rule for a pilot of **150 keywords**: 60 from (1) by clicks, 30 from
(1) by impressions with position worse than 10 (opportunity), 40 from (2)+(3)
collection/product head terms not already in the first two groups, 20 from (4)
named launches and priorities. Every keyword carries `source` (which of the
four), `our_position` if measured in Search Console, and `commercial_note`
(stock and launch context). Ongoing: 300, same proportions.

That list can be built today with SQL over existing tables and reviewed by
Travis; it needs no provider. Building it as a stored table
(`seo_keyword_set`) is the first item of the next PR so the pilot has an
identity to attach observations to.

## Provider comparison

**Sourcing caveat.** The comparison was assembled 2026-09-14 by an agent
whose egress policy blocked every provider domain (dataforseo.com, serpapi.com,
serper.dev, trajectdata.com, semrush.com, ahrefs.com, developers.google.com
all returned 403 from the proxy). Every price below is therefore from
**secondary sources read that day**, not the official pricing pages, and must
be confirmed by opening those pages before any budget is committed. The only
firsthand sources were two vendor client READMEs on GitHub (SerpApi, DataForSEO),
used for auth and parameter facts.

| | DataForSEO | SerpApi | Serper.dev | ValueSERP (Traject) | Semrush API | Ahrefs API v3 | Google Custom Search |
|---|---|---|---|---|---|---|---|
| Measures | Live SERP per task, plus modelled volume products | Live SERP | Live SERP | Live SERP | Semrush's own index + Position Tracking projects | Ahrefs' index (`serp-overview`) | Programmable Search index, not the google.com SERP |
| Position + URL + domain | Yes | Yes | Yes | Yes | Position + URL per line | Position + URL | URL only; positions not comparable |
| Location / device | location + device | location, gl, hl, device | gl, hl, location; device unconfirmed | location + device | database=us; device on some reports | country; device unconfirmed | gl/cr only, no device |
| Search volume | Modelled (Google Ads buckets, clickstream blends) | None | None | None | Modelled | Modelled | None |
| Pricing unit | Per SERP page: Standard ~$0.60/1k, Live ~$2/1k | Per search: $25/1k … $150/15k per month | Credits: $50/50k | Credits/month from ~$50/25k | Plan $549/mo + unit packs, pack price unpublished | Plan-included units from $129–$449/mo; API inclusion contradictory across sources | $5/1k, closed to new customers, ends 2027-01-01 |
| Minimum | $50 deposit | Monthly plan | $50 pack (6-month expiry) | Monthly pack | $549/mo floor | Monthly | n/a |
| Terms that matter | Storing results in your own DB is the intended use; no competing with search engines | No resale; legal shield only from the $150 tier; Google sued SerpApi Dec 2025 (secondary) | Storage allowed for the use case; no mirroring | Not read | Index data, not a dated observation | Not read | Irrelevant |
| Auth | HTTP Basic | `api_key` query param | `X-API-KEY` header | `api_key` query param | `key` query param | Bearer token | key query param |

### Cost model (explicit assumptions)

One observation = 1 keyword × 1 location (United States, country-level) × 1
device × 1 date, top-10 only. Top-20 costs about 1.75× on DataForSEO and 2× on
Serper; SerpApi and ValueSERP bill per search regardless.

- **Pilot:** 150 keywords × 2 devices (desktop, mobile) × weekly × 8 weeks =
  **2,400 observations** across two billing months; plus one search-volume
  lookup for 300 keywords.
- **Ongoing:** 300 keywords × 2 devices × weekly = **2,600 observations per
  month**.

| Provider | Pilot (2,400 obs + volume) | Ongoing per month (2,600 obs) | Basis |
|---|---|---|---|
| DataForSEO Standard | 2,400 × $0.0006 = $1.44 (Live queue $4.80); volume ≈ $0.08. **Cash outlay is the $50 minimum deposit**, most of it left over | 2,600 × $0.0006 = **$1.56** | Secondary list prices |
| SerpApi | $75/5k tier × 2 months = **$150**; no volume product | **$75** ($150 with the legal-shield tier) | Secondary |
| Serper.dev | 2,400 credits inside the 2,500 free, or a $50 pack; no volume | ≈ **$8** effective ($50 pack per 6 months) | Secondary; device support unverified |
| ValueSERP | $50 × 2 = **$100**; no volume | **$50** | Secondary; pack sizes disagree across sources |
| Semrush API | $549 × 2 = **$1,098** plus an unpublished unit pack | **$549 + pack** | Plan price secondary; unit price hearsay |
| Ahrefs API | ~1.1M units ≈ Advanced plan × 2 = **$898** | **$449**, possibly over | Unit burn estimated from one third-party log |
| Google Custom Search | Not available to new customers | — | Official status via search |

### Recommendation (editorial)

**DataForSEO**, pending confirmation of the prices above from its official
pages. It is the only candidate that supplies both a measured SERP with
location, device, position, URL and domain **and** a modelled volume lookup,
under one pay-as-you-go account, and at this scale the arithmetic is a $50
deposit covering roughly two years of the ongoing programme. Its terms are
built for storing results in your own tables, which is what a
`seo_serp_observations` table would do. Volume figures would be stored with
`source = 'google_ads_modelled'` and never placed beside Search Console
clicks as if comparable. **Runner-up: SerpApi** — the best-documented
location and device parameters and a legal shield from the $150 tier, against
no volume product, roughly 50 to 100 times the cost, and an active Google
lawsuit. ValueSERP is the budget alternate if Serper's device support proves
absent.

**Decision needed from Blake:** which provider, and whether to open the
account. Nothing is purchased, subscribed, credentialed or committed here.

## What a manual pilot can and cannot be

A person can open a private browser window, set the US locale, and record for
30 keywords on one date the top-10 URLs, domains and positions on desktop and
(via device emulation) mobile — about 60 SERPs, half a day. That yields
**measured observations on one date** and is genuinely useful to validate the
keyword list and see which domains appear. It must **not** be presented as
monitoring: there is no repeatability (personalisation, location and Google
experiments differ per session), no second date for a delta, no volume, and
no audit trail beyond a spreadsheet. Monitoring means the same query,
location, device and depth on a schedule, stored with the date, which is what
an API provides and a person cannot. If a manual pilot is run, each row
carries the date, location, device, browser state and the person's name, and
it lands in the same observation table as API rows with `source = 'manual'`.

## Competitor pages are never fetched through page-inspect

`page-inspect` is bounded to hosts Shopify vouches for on the company's own
connections (`shopify_shop_domains`, no client write policy, HTTPS only,
public-unicast resolution on every hop, TLS pinned to the storefront name).
A competitor host is refused at admission and would be swept from the
allowlist by the next sync even if hand-inserted. **Competitor URLs are not
added to that allowlist**, casually or otherwise. Reading a competitor's
ranking page needs a separately reviewed path: a second, differently sourced
allowlist with its own provenance (a curated competitor-domain registry, exec
approved, per company), the same SSRF stack, plus the robots and rate-limit
decision page-inspect explicitly defers. Until that exists, the sanctioned
route to competitor content is Ask SILO's `web_search` tool, whose results
are search-engine excerpts with a date, not captures.

## Repeatable comparisons over time — the schema (shipped 2026-09-26)

`20260926120000_seo_competitor_serp_schema.sql`, verified by
`scripts/tests/seo-serp-database.test.mjs` against a real PostgreSQL as
authenticated users, with three mutations in CI. What it holds, and where it
departs from the sketch that used to sit here:

- `seo_keyword_set` — keyword, generated `keyword_norm` (the identity, and the
  join key to `search_console_query_daily.query`, which is stored verbatim),
  `source` (the four above plus `manual`), `commercial_note`, `priority`,
  `is_active`. Any member adds; the creator or an approver edits or removes.
- `seo_competitor_domains` — the curated list: `domain`, generated
  `domain_norm` (lowercased, `www.` stripped -- lower FIRST; the first draft
  stripped first and `WWW.` survived), `relationship`
  (`commercial` / `search` / `both`), note, `added_by`. Approver-only writes.
  Search competitors are DERIVED in `seo_competitor_share_v` and never merged
  into this list.
- `seo_serp_runs` — one fetch identity: `provider` (`dataforseo` / `manual`),
  `observed_on`, `location_code` / `location_name`, `language_code`, `device`
  (`desktop` / `mobile`), `search_engine`, `depth`, cost and counts,
  `completed_at` stamped LAST by every writer. Unique on the identity.
- `seo_serp_run_keywords` — **not in the sketch, and the most important
  addition.** Which keywords a run ASKED about, with `result_count` and the
  per-keyword `provider_request_id` / `cost_usd`. Without it, "observed and
  we were outside the depth" and "never observed" are the same absence.
  `result_count 0` is a measured zero; an absent row is never-asked.
- `seo_serp_observations` — one row per keyword × `observed_on` × location ×
  device × provider × `result_type` × `position`: `domain`, generated
  `domain_norm`, `url`, `title`. **Observation date, location, device and
  provider are NOT NULL columns**, denormalised from the run so the row is
  self-describing. Append-only: a select policy and no client write policy at
  all. Composite FKs tie both `run_id` and `keyword_id` to the same tenant,
  and a third FK `(run_id, keyword_id) → seo_serp_run_keywords` makes a
  result for a keyword the run never asked about unrepresentable (found in
  the first independent review).
- **Writers.** The provider sync (service role; the next PR) and
  `seo_import_manual_serp_observations(rows, observed_on, location_name,
  device, note)` — SECURITY DEFINER, any active member, attributed via
  `recorded_by`, one call = one date × location × device, refuses a keyword
  already recorded on that manual run (an observation is never overwritten;
  record a new date) and refuses a position beyond the manual depth of 10 —
  a person reads one results page, so 50 is a typo, not an observation. The
  manual pilot described above lands through it, as
  `provider = 'manual'`, and is never pooled with a provider run.
- **Newest completed run wins** — `trg_seo_serp_newest_run_wins` on all
  three run tables, the Search Console trigger's rule: an update carrying an
  older `synced_at` is dropped, an insert into a run a newer writer already
  completed is dropped, equal timestamps pass.
- `seo_keyword_landscape_v` — every keyword in the set, per run identity:
  `latest_top_results` (ordered, each flagged `is_own_domain` and with the
  registry `relationship`), `our_serp_position`, `previous_observed_on`,
  `our_previous_serp_position`, `our_serp_movement` (previous − current,
  positive = up the page), and BESIDE them `search_console_avg_position_28d`
  / `_clicks_28d` / `_impressions_28d` — Google's impression-weighted average
  over the last 28 ingested days, a different measure under a different name.
  `results_in_latest_run` 0 = asked, nothing returned; NULL = never asked.
- `seo_competitor_share_v` — per domain in the latest completed run per
  identity: `keywords_in_top_10`, `keywords_in_top_3`, `best_position`,
  `avg_position`, `is_own_domain`, `relationship`, and `keywords_observed`
  (what the run asked about — the only valid denominator). No percentage is
  stored.
- `seo_derive_keyword_candidates(p_days)` — the selection rule above as a
  reviewable list: 60 click leaders (**position ≤ 10 or unmeasured** — a
  position-14 query with a trickle of clicks is an opportunity, not a leader,
  and the two groups otherwise fight over it in a small set), 30
  opportunities at position > 10 by impressions, 40 collection / live
  product-type head terms, 20 upcoming launches; `already_in_set` and the
  window's unattributed share on every Search Console row. Never an
  auto-insert.
- `sync_jobs.job_type` gained `seo_serp_weekly` for the writer to come.

Ask SILO reads all of it through `run_sql` — there is deliberately **no chat
tool that fetches a SERP on demand**: that would spend provider credit per
question, the tool loop has no per-call fetch timeout, and monitoring means
the same query, location, device and depth on a schedule (above), which a
chat turn is not. The prompt's three "no SERP source" sentences are gone,
replaced by: absence is NEVER OBSERVED; a position is one dated snapshot per
provider / device / location, named in the sentence; observed rank and
Search Console average are different measures; `web_search` is never a
ranking source. `evidence-scope.mjs` treats `device`, `provider` and
`result_type` as scope dimensions, so a position pooled across desktop and
mobile is reported as pooled and "desktop" in an answer over a pooled result
is flagged.

## What the provider actually does (measured 2026-09-26)

`.github/workflows/seo-serp-probe.yml` (`scripts/seo-serp-probe.mjs`, read-only
against SILO) ran five times on the live account (runs 36220772020 →
36222764424). What it found, and what each decided:

| Measured | Consequence |
|---|---|
| Live endpoint takes ONE task per request (`40000 You can set only one task at a time`; 3 of 4 refused) | The sync uses the standard queue (`task_post`, up to 100 per request) and collects later |
| Queue: 4 tasks ready in 106–139 s; $0.0012 per task at depth 20, priority normal. Live: $0.002 at depth 10, $0.004 at depth 20 | 300 keywords × 2 devices = **$0.72 per week**, $37 a year. The doc's $0.0006 figure above was depth-10 list price; depth 20 is what is bought |
| `depth` counts ABSOLUTE SERP slots: depth 10 returned 7–8 organic ranks (AI overview, People Also Ask, images, knowledge panel, reviews take the rest); depth 20 returned 16–19 | Schedule default `depth = 20`. Observations store `rank_group` (the organic rank), never `rank_absolute` |
| Desktop and mobile shared 1 of 9 domains on the brand term, 17 of 19 on "baseball dad hat" | Device stays a run-identity dimension, never pooled (as the schema already says) |
| Two fetches of `baseballism` / desktop / 2840 minutes apart disagreed on whether baseballism.com was in the top 20 at all (absent in the live fetch, #1 in the queued one) | A stored position is ONE snapshot; movement between two runs is evidence of a trend only over several runs. Ask SILO's dated-snapshot rule stands |
| `item_types` returned inline: `organic`, `ai_overview`, `people_also_ask`, `images`, `related_searches`, `knowledge_graph`, `google_reviews`, `popular_products`, `people_also_search` | Organic rows only are stored as observations; the ledger keeps `item_types` per keyword so "a shopping pack exists for this query" is answerable |
| `location_code 2840` = United States (Country), from 62,864 US locations | Country-level runs; a city-level run would be a different identity |
| Organic `domain` sometimes arrives with `www.`; URLs carry `srsltid` tracking params | `domain_norm` strips www.; URLs are stored verbatim |

## The provider sync (built 2026-09-26)

`scripts/lib/seo-serp-sync-core.mjs`, driven by `scripts/seo-serp-sync.mjs`
from `seo-serp-sync.yml` (Mondays 09:15 UTC, catch-up 15:15 UTC). Per active
`seo_serp_schedules` row, per device:

1. the run row (`completed_at` NULL while in flight);
2. post the keywords the ledger does not yet hold, 100 per request, tagged
   `run|keyword`; write a `seo_serp_provider_tasks` row per accepted task
   BEFORE any collection;
3. poll `tasks_ready`; for each of ours: `task_get`, then the
   `seo_serp_run_keywords` row (asked, N results), then the organic
   observations, then the ledger's `collected` mark;
4. once nothing is pending, `completed_at`, last.

A collection deadline (20 min by default) leaves the run in flight; the
catch-up resumes from the ledger and posts nothing. A provider error on a task
marks the ledger `failed` and writes NO asked-row: asked-and-unanswered is
"never observed" for that run, not `result_count 0`. Two bounds from the
schedule row: `max_keywords_per_run` (by priority, then age) and
`max_cost_per_run_usd` (the provider's own reported cost, checked between
batches). `is_active` defaults to false and only an approver may change it.

**To switch a company on:** insert its `seo_serp_schedules` row (defaults are
the measured ones), review its keyword set (`seo_derive_keyword_candidates()`
→ `seo_keyword_set`), set `is_active = true`, and dispatch `SEO SERP Sync`
once with the company id rather than waiting for Monday.

**Still to do:** volume, if bought, in its own table with `source =
'google_ads_modelled'`, never beside Search Console clicks; the
`/v2/seo-keywords.html` page.
