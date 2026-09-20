# Canned report accuracy pass

## Preflight

The September 20 audit found mismatched day boundaries, stock excluded by PO history,
incoming stock hiding current shortages, partial velocity joins labelled as dead stock,
zero-spend conversion rows discarded, and missing marketing data rendered as zero.
The UI confirms central reports are read-only; this change is a migration, not private copies.

Consumers: report-builder preview, dashboard rendering and pagination, saved filter views,
and report tie-outs. Existing UUIDs, query index 0, column names and parameter keys stay.
Live dashboard configuration was checked before implementation. No report visibility,
tenant policy, source table, sync job or dashboard configuration is changed.

Live policies were inspected: system rows have NULL company and no client UPDATE path;
tie-outs are SELECT-only for clients. All queries continue through the caller's RLS and
scoped view wrappers. The migration is transactional, scoped to system/global rows and
idempotent. Failure rolls back the batch; repeating it does not create copies.

Tests defined before implementation:
- Execute the migration twice against isolated PostgreSQL fixtures and compare IDs.
- Run stored SQL through the actual parameter resolver, including explicit date overrides.
- Test company-local midnight, leap day and daylight-saving boundaries.
- Stock without PO history remains included; incoming units cannot hide low on-hand cover.
- A product selling at a zero-stock location, or carrying unknown velocity, is not dead stock.
- Paid conversions on zero-spend rows count; GA4 remains excluded.
- Missing spend/revenue remains NULL and ratios are not manufactured.
- Corrupt results deliberately to prove reconciliation checks fail.

## Deployment

Deploy the frontend after merge first, then apply the canned_report_accuracy
migration and run verify_v2_schema.sql. Reload open dashboard/report tabs for
company-calendar parameter support. Run `run_report_tieouts()` authenticated
as each relevant company; review every MISMATCH, NO DATA or ERROR.
No edge function or secret changes. No production migration was applied in this PR.

## Verification

- Isolated PGlite: all 16 changed templates execute after applying the migration
  twice. Exact-date overrides, company midnight, leap day, early-January
  prior-year comparisons and both daylight-saving transitions are covered.
- Adversarial fixtures cover missing PO history, incoming stock masking low
  on-hand cover, unknown velocity, sales at zero-stock locations, offsetting
  sales/returns, duplicate online-location labels, zero-spend attribution,
  GA4 exclusion and missing marketing days.
- Mutations prove that a one-dollar rollup discrepancy, changed inventory,
  a stale query fingerprint and inflated tolerance cannot produce a passing check.
- All 16 v3 unit suites and all 37 Plaid database regressions passed locally.
- All 16 revised queries executed under authenticated Baseballism read-only
  access against the live schema; no definitions or data were saved there.
- Browser regressions were added for rolling filter reloads and preserved
  company calendars when copying a central report. Local browser execution
  is pending: the Chromium download timed out / returned HTTP 502.

This is definition and calculation validation, not an end-to-end guarantee
of complete ingestion or production deployment. Existing personal copies and
explicitly saved absolute-date filters remain as authored; reset those filters
to use the new rolling defaults. Mixed company/browser-calendar parameters
with the same key show a conflict instead of claiming one shared calendar.

## Remaining source freshness risk

Rolling windows do not refresh source data. The audit measured the cached sales rollups
behind the raw sales feed for the most recent day. Tight tie-outs must expose that difference;
they must not excuse it with large tolerances. Inspect sync completion and rollup refreshes
before treating a failed reconciliation as a report-formula issue. This PR does not certify
ingestion completeness, repair a missed sync, or reconstruct historical inventory.
