# Roadmap

Three buckets only. Check items off in PRs when done.

Last reconciled against the live database 2026-08-26. Where this file and
CLAUDE.md disagree, CLAUDE.md is the authority on how things work; this file
is the authority on what is still to do.

---

## Now (stability)

- **A materialized view behind `sales_by_product_title_daily_v`.** It resolves
  `sales_by_day.sku → products_master.sku → product_title` on every query, and a
  30-day product rollup measures ~3s (it was ~9-12s before the Commercial overview
  tiles that did not need the join were pointed elsewhere). It is now the slowest
  tile on any dashboard and the floor on a board refresh. The fix is the pattern
  already used by `wow_sales_daily_type_mv` and `inventory_on_hand_current_mv`:
  materialize it, wrap it in a `security_invoker` view carrying the
  `active_company_id()` filter (Postgres does NOT apply RLS to a matview), and
  refresh at the end of the Shopify sync. Measured 2026-09-03.

- [x] **`silo-chat` prompt drift: repo is ahead of prod.** Closed 2026-08-26 —
      deployed as version 56; the deployed source was diffed against `main`
      and matches. The `silo_chat_notes` stopgap row from 06:55 that day
      ("supersedes older guidance in the system prompt") is now redundant with
      the function itself and should be deleted, or it becomes the next drift
- [ ] **Launch capture discipline.** 43 of 61 launches cannot be measured
      because nobody attached products or linked a PO, and nothing in the UI
      asks. This is unrecoverable after the fact — launches overlap heavily,
      so you cannot reconstruct which one sold what. Cheapest fix in the
      system: prompt for it in the launch form
- [ ] Post-merge SQL checklist on every DB PR (`verify_v2_schema.sql`)
- [x] Sync architecture: one GitHub Action (`shopify-sync.yml`, daily 08:30 UTC)
      pulls sales + inventory + catalog + payouts straight from the Shopify
      API. The Google Sheets / Better Reports path it replaced was retired
      2026-07-08 (`nightly-silo-sync.yml` is manual-only now)
- [x] Align `profiles.role` with `po_builder_can_write` / `po_costing_can_write`
      (30 active profiles as of 2026-08-26, 23 of them `admin`; the enum is
      `owner/admin/executive/user`)

---

## Analysis loop (concept → PO → launch → measurement)

The spine works end to end and is proven, not theoretical: Back To School
measured at 9,819 units / $216,835 across 31 SKUs, cross-checked two ways.
What remains is coverage and one missing branch.

- [x] Concept drafted and refined in Ask SILO; refinements are revisions of one
      row (`product_concept_revisions`), never new concepts
- [x] Concept → PO plumbing in `/v2/po-builder.html` — picker, one-factory
      guard, size breakdown to lines, `po_lines.source_concept_id` stamped.
      **Built but hidden by decision** — see "Decided" below
- [x] PO → launch link persists (`launch_calendar.linked_po_id`). The picker
      previously held the PO's uuid and saved only its NAME as text, which is
      why the column was null on all 61 launches
- [x] Launch measured through attached products (`launch_product_actuals_v`,
      `launch_product_sales_v`) — 17 launches measurable today. `resolution_note`
      distinguishes "not measured" from "sold little", which caught a 43%
      understatement on its first real use
- [x] `launch_measurability_v` — per launch, can it be measured and why not
- [x] Ask SILO query timeout 10s → 30s. Phase-2 grounding queries were timing
      out and being recorded as unknowns, leaving `economics`/`forecast`/
      `provenance` empty on all 18 concepts
- [ ] **Campaign → launch mapping.** The last structural gap. Ad spend and
      launch results never meet, so "what did we spend on this drop and did it
      pull its own weight, or was it just a reason to run a sale" is
      unanswerable. A mapping table (same shape as `shopify_channel_map`) plus
      a picker
- [x] Verify phase 2 fills `economics` / `forecast` with the 30s budget —
      confirmed 2026-08-26 on the Back To School 2027 concept, which also ran
      clean on time (11 rounds, 9 queries, no forced final). Its `unknowns` no
      longer cite timeouts, which settles this item's own conditional: it is
      NOT the `shopify_orders` seq scan
- [ ] `provenance` is still empty on the one concept that reached phase 2 with
      the column available (n=1, so not yet a pattern). It is not a code
      problem — the field is in both tool schemas, and sibling arrays
      (`historical_evidence`, `risks`, `unknowns`) wrote fine in the same call.
      Watch the next phase-2 run; if it misses again, enforce it the way the
      phase-1 draft nudge is enforced (`forceNudgeTool`), not with more prompt
      text
- [ ] Concept → PO surfacing decision (currently hidden on purpose)

---

## Reporting and data grain

- [ ] **The Marketing RPCs hardcode `location_tag = 'online'`, which is a
      multi-tenant bug.** `locations` already carries `store_type` per company
      and CLAUDE.md already documents `locations.store_type = 'online'` as the
      definition — the literal is drift from the repo's own stated rule. It
      works only because Baseballism happened to name their online location
      "online"; the second company's codes are `baseballismdsg_dsg` and
      `chicago`, so every report would return zeros and read as a quiet week
      rather than a misconfiguration. Fix is a lookup
      (`location_tag in (select location_code from locations where
      store_type = 'online')`) in each `wow_*` RPC and the rollup. No new
      mapping needed in Integrations. Do it with the before/after md5
      comparison used for the sales rollup — that method caught the one real
      difference last time
- [ ] **Retail has no ad measurement anywhere.** Retail is $7.59M of $25.2M YTD
      (30%), a live `PMax Store Visits` campaign spent $24,069, and every
      Marketing page reads online-store revenue only. `wow_paid_media_reality()`
      computes `mer_blended` (2.20) against `mer_online` (1.23) and is the sole
      place the difference exists. Store-visit attribution is modelled, not
      measured, so the honest first step is establishing what CAN be tied to
      POS before any retail ROAS is published
- [ ] Surface `wow_paid_media_reality()` — spend / claimed / actual / claim
      ratio / MER online vs blended / NCAC. Built, grain-aware, displayed
      nowhere. Would stop anyone carrying an Explorer ROAS into a revenue
      conversation without having to remember which page means what
- [ ] Cost per thruplay and cost per lead exist per ad only from 2026-08-02 —
      the columns are new and Meta must be re-pulled for history. A
      `days_back=400` backfill needs the 240-minute timeout raised in #580;
      the first attempt was killed at exactly 60 and wrote nothing, because
      the ad-level fetch holds every row until one upsert at the end
- [x] Marketing Explorer (`/v2/marketing-explorer.html`) — any date range by
      day, prior-period comparison, Google + Meta drill from platform to ad,
      CSV export at every level
- [x] Marketing measure layer (`marketing_facts_daily_v`,
      `marketing_campaign_summary_v`, `marketing_daily_totals_v`,
      `meta_ad_performance_v`) — ratio metrics computed from summed components
      at the reported grain, so ROAS/CPA/CTR/CPM cannot be averaged wrong
- [x] **Product-title sales rollup.** `sales_by_product_title_daily_v`
      (20260826230000) — company × product title × type × location × day,
      `security_invoker`, in the Ask SILO schema catalog with a curated
      description. 99.09% of rows join by `(company_entity_id, sku)`; the rest
      fall back to `sales_by_day.product_name` flagged `title_source =
      'sales_fallback'` rather than being dropped. Note the behavioural half
      was already fixed separately by a `silo_chat_notes` row (2026-08-25)
      telling the model to use title grain — this removes the hand-built join,
      not a wrong answer
- [ ] FB / Instagram organic. Tables exist, 0 rows. Blocked on Meta, not on us:
      the token needs `pages_read_engagement` / `instagram_basic` /
      `instagram_manage_insights`, the System User needs admin or analyst on
      the Page, then set `facebook_page_id` + `instagram_business_account_id`
      on the Meta connection in Integrations
- [ ] TikTok Ads has never synced — in the platform list, zero rows
- [ ] Google Ads has no ad-group or ad-level detail; Meta is the only platform
      with sub-campaign depth, and only from 2026-07-08

---

## Multi-tenant (Phase 1 complete 2026-06-16; Phase 2 mostly closed)

Architecture: one Supabase project, multiple companies isolated at the DB level.
See CLAUDE.md for the full mechanism — this section tracks only what is left.

- [x] Entity registry, memberships, `active_company_id()`, `set_active_company()`,
      `*_active_*` RLS policies, `security_invoker` on all views, login company
      resolution, `withCompany()` insert helpers, per-company nav profiles
- [x] `inventory_on_hand` backfill — 3,471,109 rows, 0 unstamped (verified
      2026-08-26). Previously listed as deferred
- [x] `sales_by_day` backfill — 1,140,089 rows, 0 unstamped (verified
      2026-08-26). Previously listed as deferred, and described as blocked on a
      Google Sheets sync that no longer exists
- [ ] Materialized views (`sales_monthly_product_type_rollup_mv`,
      `sales_sku_location_rollup_mv`) cannot use `security_invoker`. The sales
      backfill that blocked this is done, so it is now actionable
- [ ] Company switcher in the sidebar (without a full logout/login)
- [ ] A new company still needs its own sync pipeline to POPULATE sales and
      inventory. That is data availability, not an isolation gap

---

## Next (v2 product)

- [ ] Finish Beacon shell migration — 4 iframe wrappers left
      (`baseballismwholesale`, `buyer`, `checkwriter`, `wholesale`)
- [ ] One canonical URL per tool (`/v2/...` preferred)
- [ ] Same error/status pattern on all v2 pages
- [ ] `v2/profile.html`'s `LANDING_OPTIONS` still offers `/finance.html` and
      `/ops.html`; neither exists, so picking either 404s on next login

---

## Later (platform)

- [ ] Smoke tests (auth + one read per critical page)
- [ ] Sync health page — `sync_jobs` and `silo_chat_health_v` hold the data,
      nothing surfaces it
- [ ] Retire unused `legacy/` pages after v2 parity

---

## Decided — do not re-open without asking

These look like oversights and are not. Each was settled deliberately.

- **`FROM CONCEPT` stays hidden in PO Builder.** The plumbing is complete and
  one `hidden` attribute away from live. Finished plumbing is not evidence of
  intent to ship (reaffirmed 2026-08-26)
- **No period-lift estimation of launches.** Measuring a launch as window sales
  against a trailing baseline cannot work here: of 61 launches exactly ONE has
  a non-overlapping window. The metric does not merely go vague, it inverts —
  a launch following a big event scores badly because its baseline contains
  that event's surge. Overlapping launches can only be separated by which SKUs
  sold, never by time
- **Comp self-requests are allowed.** See CLAUDE.md's `comp_adjustment_requests`
  entry — the visibility is the control at this headcount
- **`/v2/returns-overview.html` and `/v2/product-concepts.html` stay out of the
  nav** until their coverage/workflow is complete
- **`checkwriter` is kept** as an internal tool despite having no nav entry

---

## v2 migration snapshot (audited 2026-08-16)

33 pages on the full Beacon shell; 4 still iframe a legacy page via
`tool-shell.js`. Live per-page breakdown: [../../v2/SILO-BRAND.md](../../v2/SILO-BRAND.md).
`v2/backend.html` is the exception — it loads Tailwind and mounts no chrome.

Payroll BI retired 2026-08-17 (`payroll.html` + `v2/hidden/payroll.html`) — bad
flow. Tables stay, and `calendar_events_v` still deep-links to the dead
`/payroll.html`.

Retired 2026-08-16: `allocation`, `aprio`, `cashflow`, `modelapps`, `recon`,
`travel`, `wpvaccounts`, plus standalone `accountspayable.html` / `ap-report.html`.

## Security — Deferred

### launch_task_templates RLS (P2)
Overly broad INSERT/UPDATE policy. Acceptable while users are admin-only, but
must be tightened before the launch module opens to non-admin users. Scope
writes to `company_entity_id = active_company_id()` and role-gate mutations.
