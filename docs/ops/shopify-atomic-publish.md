# Atomic incremental Shopify publication

## Preflight and scope

The approved change is incremental sales only: `scripts/shopify-sync.mjs`
awaits `runIncrementalSales`, then updates connection watermarks and records
job success. `shopify-sync.yml` invokes that script, as does bootstrap's
`storefront` stage. Bootstrap's `sales_history` stage, other history callers and
the independent `shopify-sync-run` edge implementation remain separate writers.
They do not acquire this new lock; this is not an all-importer atomicity claim.

Inputs: connection id/company/shop, computed affected date windows, converted
headers/lines/sales/refunds. Fetch orders, locations, catalog and paid dates
before publishing. Preserve adjacent-day overfetch for facts, positive sales
only inside the window, and additive immutable refunds outside it. Missing paid
keys preserve stored values; explicit null still clears a measured value.

Each contiguous window publishes in one service-role-only, SECURITY INVOKER RPC.
A transaction-scoped company/shop advisory lock prevents cooperating publishers
from interleaving. It does not order snapshots by freshness: last publisher wins.
No staging, generations, persistent receipts, schema tables or queue changes.
No fallback to separate writes if the RPC or required schema is missing.

Deletion is restricted to positive Shopify sales in the supplied scoped window,
and lines of exactly the supplied order headers. Validate connection ownership,
payload scope, allowed columns, keys and line parents before mutation. Errors
roll back that window; earlier committed windows may remain. No watermark or
success result is returned until every window commits. A lost response may
leave committed data without an advanced watermark; rerun is idempotent for
the same payload. Concurrent stale retries remain last-publisher-wins.

Local verification plan, written before implementation: execute the migration
and real importer wiring; independent money/order ledger, >500 lines, deletion
and intermediate-insertion rollback, removed lines, empty windows, refunds,
cancellations/gift cards/location mapping, paid absence/null, duplicate replay,
lost response, invalid tenant/shop/connection and untouched-scope digests.
Mutate rollback/scoping behavior and verify the tests reject it.

Live policies, constraints/default grants and deployed table shapes cannot be
inspected in this authorized preparation: no hosted SQL is allowed. Migration
must explicitly revoke PUBLIC/anon/authenticated execution, grant service_role,
and be reviewed against live privileges before application. The CLI and a local
PostgreSQL server/container were not found; no tooling installation is authorized.
PGlite tests are single-session SQL execution, not concurrent-reader evidence.

## Deployment order (not performed)

1. Review live schema/constraints/grants and payload limits in the test project.
2. Apply the RPC migration with separate authorization; verify its privileges and
   `verify_v2_schema.sql`, then verify two-session old-or-new visibility.
3. Enable the importer revision only after the RPC exists. Missing RPC fails the
   job closed. Rolling back importer code restores the old non-atomic behavior.
4. No edge deployment, credentials, billing or access expansion is required.

The known main Finance database test failure in `ai-credit-database.test.mjs`
(multiple commands in a prepared statement after 35 passes) is out of scope.

## Bounds and remaining verification

The caller refuses a request above the proposed 16 MiB compact UTF-8 JSON limit,
10,000 headers, 50,000 lines or 50,000 sales rows before RPC. This is an
implementation proposal, NOT a verified Supabase transport constraint. The server
bounds the complete normalized JSON request at 16 MiB as well. No unit is split.

Shared company/shop/connection/sync-time/batch metadata is passed once per table.
Every persisted field is retained; absent keys remain absent and explicit null
remains null. Metadata is scalar, scope-validated, and cannot be overridden by a
row. A conservative 32 MiB serialized-expansion bound is checked BEFORE allocating
each expanded array; it does not bound PostgreSQL/process working memory.

The exact 10,000-order/10,000-line/10,000-distinct-sales-row fixture measured
21,294,702 bytes before compaction and 14,975,380 after; server-normalized compact
JSON is 16,235,424 bytes. Complete local publication, changed-payload rollback,
then changed publication and identical replay all passed independent exact totals.
No records or monetary fields were dropped. Missing/null/undefined batch fields
and mixed paid-key round trips are tested separately.

One isolated Node24/PGlite probe measured encode 21.33ms, decode 23.66ms,
publication 2717.97ms, rollback 2509.38ms. RSS baseline/after was 398,344,192 /
1,127,260,160 bytes; baseline process high-water was 1,156,677,632 and final
isolated-process peak 1,240,588,288 bytes. This harness retains original/compact/
decoded comparisons and includes PGlite startup; it is not production worker RSS.
Only about 542KB of normalized-byte margin remains for this fixture. Richer or
larger valid windows can still fail the proposed bounds. Do not infer general
large-store readiness or raise caps/add staging without review. No hosted or
separate-reader concurrency acceptance was performed.

Tests execute SQL under a synthetic service_role and deny actual anon/authenticated
calls, but fixture grants/schema are not proof of deployed privileges or triggers.
Late source conflicts, rollback, empty results, paid fields, malformed order pages
and replay are covered. Missing/wrong-shaped orders arrays abort before publication;
other provider parser behavior is unchanged. Real two-session visibility and hosted
performance remain unverified. Source/date/order semantics are preserved; dependent
materialized-view refresh and historical import atomicity are not part of this fix.

## Local verification record

`node scripts/tests/shopify-atomic-publish-database.test.mjs`: 16 cases passed.
`SHOPIFY_ATOMIC_MUTATION=keep-lines`, `keep-sales`, and `public-execute` each
failed the appropriate removal/ledger/privilege assertion. The three independent
review findings (late source collision, actual invoker-role execution, malformed
order-page rejection) were corrected and reviewed again before opening the draft.

Matching regression suites passed: collections-sync, shopify-readonly,
shopify-order-terms, shopify-order-paid-at, shopify-order-terms-database,
shopify-store-name-fallback, integration-bootstrap-runner, integration-bootstrap,
business-timezone-westmost, and plaid-bank-feed-database (the verify-file guard).
The existing shopify-auth suite passed 12 cases then failed its LF-only Deploy
step extraction on this Windows CRLF checkout; no auth/deploy code was changed.
The known AI-credit database failure reproduced after 35 passes. YAML parser
verification could not run because PyYAML is unavailable; no tooling installed.
`git diff --check` passed. Hosted schema checks and two-session visibility were
not run. These gaps and unverified production-window bounds prevent a deployment-ready claim.
