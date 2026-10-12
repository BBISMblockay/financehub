# Attribution restructure + spend preflight (2026-10-12)

Base: `81fb0b7` (main). Goal (Blake, 2026-10-12): the page answers "how do our
channels work together, and what does each one return for what we spend?"
before it answers "can we trust the numbers?".

## Call path

`v2/silo-attribution.html` -> `silo-attribution-page.js` (auth, Baseballism
pilot gate, `withCompany` re-check around every read) -> `mountReport` /
`loadRows` in `silo-attribution-report.js` -> `mountOverview` in
`silo-attribution-overview-ui.js` (analysis in `silo-attribution-overview.js`).
No workflow or edge function calls these modules. Tests: `scripts/tests/
silo-attribution-{report,overview,access}.test.mjs`, `v2/tests/browser/
silo-attribution-overview.test.js`, CI `attribution-tests.yml`.

## Spend sources (live, read-only catalog + aggregate checks)

| Source | Channel | RLS (live `pg_policy`) | Notes |
|---|---|---|---|
| `marketing_kpis_daily` (`platform` meta_ads / google_ads / tiktok_ads) | Meta Ads / Google Ads / TikTok Ads | SELECT `company_entity_id = active_company_id()`, authenticated | Campaign x day. No currency column. Day is the ad account's day. Company-wide, not per Shopify store. Sept 2026: Meta $262,309, Google $18,114, no TikTok rows. Matches `meta_ad_performance_daily` total. |
| `redo_marketing_daily` (`channel` EMAIL / SMS) | Redo Email / Redo SMS | SELECT `company_entity_id = active_company_id()`, authenticated | Message x channel x day; `spend` is USD **sending cost**, not ad spend; `spend_currency` stored. ~3.7k rows/month, so reads must page. |

Attribution snapshots exist only for `baseballism.myshopify.com` (Sept 1-30,
USD, America/Los_Angeles). The company has 22 active Shopify stores; ad spend
cannot be split by store.

## Decisions

- Spend is read client-side under the existing SELECT policies, scoped by
  `company_entity_id` and wrapped in the page's `withCompany` re-check. No
  migration, RPC, grant or edge change.
- Unknown is never $0: a source with no rows in the period, or synced through
  a day before the period end, is shown as missing / partial, not as zero spend.
- Ad spend is shown only when the report currency is USD (the KPI table has no
  currency); Redo rows whose `spend_currency` differs from the report are
  excluded and counted.
- ROAS = credited net sales / spend, shown for both last-non-direct credit and
  shared (equal-split) credit. It is observed return, not incremental lift.
- The "Draft review task" path (private `launch_tasks` insert) is removed; its
  only write goes with it. Findings link to their supporting orders instead.

## Partial failure

Report load fails -> nothing renders (unchanged). Journey load fails -> sales,
spend and credited ROAS still render; teamwork columns say unavailable. Spend
load fails -> everything else renders and spend shows "unavailable: reason".
A filter change mid-load discards every late result (sequence guard).

## Assumptions needing live verification

- Ad-account day boundaries vs the store's Pacific day (small edge shift).
- Ad account currency is USD (true today; not stored).
- Authenticated render against production snapshots (only synthetic data used).

## Tests planned

Spend mapping, paging, currency, coverage/freshness, unknown-vs-zero; teamwork
rows reconcile (credited and shared credit each sum to net); ROAS edge cases
(zero/negative/missing spend); findings never headline Unattributed/Pending;
access test: spend read denied after a company switch; browser: desktop/mobile,
light/dark, tabs, path drilldown, journeys role filter, spend-unavailable state.

## Verification record (2026-10-12)

- All nine `attribution-tests.yml` steps pass, plus all 33 v2 unit suites and
  `home-cards` 19/19.
- Browser suite on the real page and shell with synthetic data, light and dark,
  1440px and 390px (no horizontal scroll). It covers KPIs with spend, the
  teamwork headline and findings, scorecard values, channel drilldown and the
  role filter, Trust & method, stale journeys (scorecard and spend remain), spend
  failure (attribution remains) and the empty period.
- Mutation checks, each caught by a test: never-synced spend shown as $0, partial
  sync treated as complete, unscoped KPI query, paging stopping after one page or
  on a short page, Redo currency unchecked, per-row rounding, spend read skipping
  the company re-check, introducer double-counted as an assist, an evidence gap
  counted as a closer, missing shared credit, wrong path revenue, spend failure
  blanking the overview, spend error not shown, stale journeys blanking the overview.
- Review fixes found during it: stale journey evidence no longer removes the
  scorecard; spend pages against an exact row count so a server row cap below
  1,000 cannot undercount.
- Not done: an authenticated render against production snapshots and spend.
