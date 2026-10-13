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

The caller refuses a request above 16 MiB compact UTF-8 JSON, 10,000 headers,
50,000 lines or 50,000 sales rows before RPC. The server independently applies
those row limits and 16 MiB of normalized JSONB text (a conservative byte bound
because it includes spaces). Neither side silently subdivides or falls back.
The 600-order / 599-line changed fixture measured 1,282,960 request bytes.
This does not certify production maximums: large affected windows can fail closed
and require a separately reviewed strategy. No staging subsystem was added.

The requested 10,000-order busy-window probe (10,000 distinct sales rows and
10,000 lines) measured **21,294,702 bytes**, so the proposed limit rejects it.
This is a material behavior change for previously valid large windows and a
deployment blocker, not a successful capacity test. Both caller and SQL rejected
before mutations; the unchanged-data assertions passed. In one local Node24 /
PGlite run: JSON encoding 28.95ms, decoding 33.32ms, SQL rejection 376.68ms,
whole probe 688.61ms. RSS before/after was 595,451,904 / 801,165,312 bytes;
process peak RSS was 1,127,735,296 bytes across the full suite, not isolated to
this probe. No accepted 10,000-order publication or concurrency was measured.
Do not raise the cap or add staging without a separate scope decision and tests.

Tests execute SQL under a synthetic service_role and deny actual anon/authenticated
calls, but fixture grants/schema are not proof of deployed privileges or triggers.
Late source conflicts, rollback, empty results, paid fields, malformed order pages
and replay are covered. Missing/wrong-shaped orders arrays abort before publication;
other provider parser behavior is unchanged. Real two-session visibility and hosted
performance remain unverified. Source/date/order semantics are preserved; dependent
materialized-view refresh and historical import atomicity are not part of this fix.

## Local verification record

`node scripts/tests/shopify-atomic-publish-database.test.mjs`: 15 cases passed.
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
not run. These gaps and the busy-window cap prevent a deployment-ready claim.
