# SEO competitor research — scope, data source, and what can be done before one is chosen

Written 2026-09-14 as part of the SEO project's second phase. **Status
2026-09-26:** the provider-independent schema below is BUILT
(`20260926120000_seo_competitor_serp_schema.sql`, not yet applied to
production) and **Blake chose DataForSEO**; no account, credential or
subscription exists yet, so SILO still holds no provider-written SERP rows.
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
  all. Composite FKs tie both `run_id` and `keyword_id` to the same tenant.
- **Writers.** The provider sync (service role; the next PR) and
  `seo_import_manual_serp_observations(rows, observed_on, location_name,
  device, note)` — SECURITY DEFINER, any active member, attributed via
  `recorded_by`, one call = one date × location × device, refuses a keyword
  already recorded on that manual run (an observation is never overwritten;
  record a new date). The manual pilot described above lands through it, as
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

## The provider PR (next) — DataForSEO

Chosen by Blake 2026-09-26; nothing opened yet. In order:

1. **Confirm the prices** on DataForSEO's own pricing page (every figure above
   is secondary-sourced) and open the account with the $50 minimum deposit.
2. **Secret.** The key is SILO-owned, one key for every tenant, so it is a
   GitHub repo secret (`DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`, HTTP Basic)
   on the `GOOGLE_ADS_DEVELOPER_TOKEN` precedent — never a per-tenant row. A
   per-company config row (`seo_serp_schedules`: active, devices, location,
   depth, weekly keyword cap) bounds cost by construction.
3. **Probe first.** `seo-serp-probe.yml` + `scripts/seo-serp-probe.mjs`,
   manual dispatch, READ ONLY, writes nothing to Supabase: does `location_code`
   / `device` do what the docs say, what the top-10 result shape is, what one
   observation actually costs, whether `shopping` / `paa` rows come back
   inline. Same convention as `search-console-probe.yml`.
4. **Writer.** `scripts/lib/seo-serp-sync-core.mjs` on
   `redo-marketing-sync-core.mjs`'s shape (injectable `fetchImpl` / `sleep`,
   429 backoff, `sync_jobs` lifecycle, a fake-fetch test): run row → keyword
   requests → observations → `completed_at` last. Weekly workflow with a
   primary and a catch-up cron.
5. **Volume**, if bought, in its own table with `source =
   'google_ads_modelled'`, never beside Search Console clicks.
