# Additive attribution history — preflight and execution contract

Implementation is for review; no production migration or backfill is authorized.

Outcome: an operator can stage bounded history, inspect its digest and reconciliation,
then separately apply that exact artifact. Existing days are never replaced by this
path; existing journeys, allocations and timestamps are never refreshed by it.

Reuse `collectDay` unchanged for absent days, with its publication callback writing a
local artifact rather than calling the replacement RPC. Its `commit` flag means
invoke callback, not necessarily write to a database. Existing callers remain
`shopify-attribution-sync.mjs` and evidence tests. New caller is the additive CLI.
Existing code-only candidates use a small Order query without journey pagination.
No scheduler or existing workflow inputs are changed.

Live preflight, 2026-10-28: orders/days have primary keys (connection, order/day),
company and connection FKs, object/array checks and company-stamping INSERT triggers.
Authenticated has tenant SELECT only, no UPDATE; publication RPC is service-only.
The old publisher takes `hashtextextended(connection::text || day::text,0)` before
writing. The new RPC uses that same lock, plus row locks/unique constraints on orders.
It locks and validates the connection's company, domain and eligibility before apply.
Stage/apply take explicit company, connection, domain and file path. Apply requires
the SHA-256 of the complete staged file; stage is the default and performs no database
writes or token refresh. Different scopes/artifacts cannot reuse an apply receipt.

Failure design: each artifact is one atomic database transaction. Any invalid row,
revenue disagreement, code conflict or tenant mismatch rolls it all back. Concurrent
insert races are resolved by the unique key, then the stored row is re-read under a
lock. Lock timeout/deadlock/network uncertainty is retried using the SAME artifact and
run ID. Successful/identical reruns return the atomic sync_jobs receipt. Failed apply
attempts are recorded in local receipt files; a missing receipt is not proof of no
commit. Stages and receipts contain evidence: keep them private and out of git.

Code protection: a backfill provenance marker accompanies only codes filled by this
path (including new evidence). An UPDATE trigger preserves those codes and marker
when a normal publisher supplies missing codes, and rejects a different populated
value. This protects parallel/older extractions without changing their allocation
algorithm. Existing non-backfilled codes are never replaced by the additive RPC.
Normal publisher refreshes otherwise retain their existing semantics; this is not a
global freeze on normal attribution processing.

Before implementation tests: tenant mismatch and client denial; malformed/null versus
empty arrays; duplicate IDs; bounds; exact cents reconciliation; existing-day conflict;
existing evidence/allocations/fetched_at unchanged; missing-only fill; rollback of a
multi-order conflict; repeat artifacts; receipt collision; old publisher before/after
enrichment; unknown Order nodes; API budget exhaustion; no credential-refresh calls;
staged digest and scope validation; partial failure followed by resume.

Execution gates: inspect the first approved staged historical window for exact code
coverage, rate/cost and high-volume-day capacity. Existing sync evidence already
proves historical Shopify access; no standalone sampling pipeline is needed. The
maintenance runner rechecks live identity/scopes as part of its normal preflight. No claim of complete YTD coverage until every expected
day and unresolved order is accounted for. See the CLI usage and verification below.


## Operator usage (after review; no production execution performed)

The existing collector can process the longer period. Keep its maximum 31-day
window, split YTD into months, and resume using artifacts rather than replaying
published days. This CLI does not add a schedule or change the existing workflows.
The CLI uses the existing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment
variables. Never put credentials in artifacts or command-line arguments.

Stage codes for existing days (default mode/kind), or stage absent days with
`ATTRIBUTION_APPEND_KIND=day`. Set all of:

- `ATTRIBUTION_COMPANY_ID`, `ATTRIBUTION_CONNECTION_ID`, `ATTRIBUTION_SHOP_DOMAIN`
- `ATTRIBUTION_START` and `ATTRIBUTION_END` (inclusive; 1–31 complete local days)
- `ATTRIBUTION_STAGE_DIR` (private directory outside the served tree, or ignored
  `.attribution-stage/` for synthetic/local use)
- Optional `ATTRIBUTION_MAX_REQUESTS` (default 1000; explicit positive safe integer)

Run `node scripts/shopify-attribution-append.mjs`. Each artifact is a complete
reconciled day or at most 100 code observations. The printed SHA-256 identifies
exact bytes for review. Existing days are skipped in day mode; code mode explicitly
reports absent days. Unknown/inaccessible orders remain null observations. Stage
never writes Supabase, including credentials or sync_jobs. Existing stage files
are checked for scope, complete batch candidate IDs and coverage of currently missing
observations, then resumed without overwriting or re-fetching. A changed cohort stops
with an explicit restage instruction. Complete artifacts are published atomically from
private temporary files; interrupted partial files are ignored.

For an approved apply, set `ATTRIBUTION_APPEND_MODE=apply`,
`ATTRIBUTION_STAGE_FILE` and `ATTRIBUTION_STAGE_SHA256`, keeping the explicit company,
connection and domain. Apply rechecks live identity/scopes and calls ONLY
`append_shopify_attribution`. No bulk-apply command is supplied. Artifacts older than
24 hours must be restaged in a fresh directory; if an earlier apply was uncertain,
first read `sync_jobs` by its run ID to resolve the outcome, even after 24 hours.

Request limits count logical client operations: shared Shopify clients have their
own bounded retry loops, so HTTP attempts can exceed this count. A 30-minute
admission deadline stops new requests; an in-flight operation can finish later.
An incomplete day writes no artifact; completed code batches survive interruption.
High-volume days may require an explicitly raised budget and still have the
existing collector's 9,999 order/day cap. No runtime estimate is promised until a
pilot measures throttling and API cost. Code-only work avoids journey fetches.
There is no separate 10,000-operation ceiling: a 4,994-order day already needs at
least 10,001 operations, and 9,999 accessible orders need at least 20,021 before
extra journey pages. Choose the finite budget explicitly for the reviewed workload;
raising it never bypasses the 30-minute admission deadline or enables database writes.

The apply RPC records one atomic success/identical-day receipt in `sync_jobs`
(job_type `attribution_append`), keyed by the artifact run ID and payload fingerprint.
Local `.receipt.json` confirms a response; `.attempt.json` marks failure or an
uncertain outcome without storing upstream error bodies. A missing local receipt
can mean the database committed: inspect the server receipt before restaging.
There is no automatic retry that invents a new run ID. A conflicting existing day
refuses the transaction; an identical existing day returns `existing_day` without
applying staged evidence. Use code mode separately to enrich it.

## Review and verification checklist

Before apply, record snapshot hashes, total net/total cents and evidence excluding
`order.discountCodes`/`discount_codes_backfill` for existing scoped rows. Review
stage identity, date coverage, Shopify control totals, unavailable orders, and a
sample of nonempty/empty codes. Current permissions are queried from Shopify rather
than trusting the old stored scope list. No scope changes or token refresh happen.

After each approved bounded pilot:

1. Read the atomic receipt and independently count the changed keys.
2. Existing day hashes and totals must be identical. Only previously absent days
   may appear; each new day's ledger must sum to its independent control totals.
3. Existing evidence minus the two code paths, allocations and `fetched_at` must be
   unchanged. Existing non-null code arrays, including `[]`, must be unchanged.
4. Compare missing, JSON null, malformed, empty and nonempty counts by month; list
   unavailable orders explicitly. Never label an incomplete cohort as zero codes.
5. Match Shopify samples to the ledger view using company+connection+order and one
   attribution window. Count distinct scoped orders, not four attribution windows
   or separate refund activity days. Audit the saved report's connection key.
6. Reapply the identical artifact: same receipt, zero further effects. Compare other
   tenants and connections' baselines while allowing unrelated normal sync activity.
7. Verify every requested calendar day exists; successful bounded runs do not imply
   that the YTD backlog is empty. Older returns can involve pre-YTD orders.

The dedicated migration is not applied and is intentionally outside
`apply_all_post_merge.sql`, matching its attribution prerequisites. No new table
or browser privilege is introduced. It extends the live sync_jobs allowlist and
adds a service-only RPC plus a trigger. Run the dedicated attribution schema
verifier and general verifier after an approved migration apply.

## Independent review and real PostgreSQL verification

Independent review found two P2 recovery defects: changed candidate cohorts could be
silently skipped on resume, and interrupted writes could leave a truncated final
artifact. Both are fixed with regressions: full candidate coverage checks and atomic
non-overwriting artifact publication. The corrective independent review passed with
no further blocker. The reviewer confirmed this is maintenance orchestration around
the unchanged collector, not another ongoing report-specific Shopify sync.

The standalone `scripts/tests/shopify-attribution-append-concurrency.py` owns a
network-less PostgreSQL 17 Docker container with temporary storage, no host ports,
no production credentials and automatic cleanup. It runs real simultaneous sessions,
observes their PostgreSQL lock waits, and verifies publisher-first and append-first
ordering, shared-order/different-day races, concurrent receipt replay, unique-key
races, disconnect during apply, lock timeout/replay, conflicting code rollback, and
a deliberately forced publisher/append deadlock with safe replay. All nine scenarios
passed on PostgreSQL 17.11 on 2026-10-28. Test containers were removed.
The image is pinned by digest. This test is also included in Attribution tests CI.
No live Shopify collection, production migration, deploy or backfill has run.

Local verification on 2026-10-28: additive CLI and database suites passed; existing
attribution evidence, probe, database and six coverage tests passed. Mutation tests
removing the tenant check, revenue reconciliation and backfilled-code preservation
each failed their intended assertion. The CLI suite runs the real `collectDay`
with synthetic upstream responses and tests interruption after one staged batch,
resume, digest mismatch, cross-company rejection, unknown nodes and uncertain apply.

The available Supabase CLI failed before migration creation because its startup
requires an unwritable home directory; the timestamped migration was authored
locally under the repository convention. Supabase changelog access also failed
(403 / unsupported markdown response); implementation uses existing repository SQL
patterns, validated by the local database harness, with live deployment unverified.

## Existing Shopify evidence reused (2026-10-28 read-only assessment)

No new Shopify probe or workflow was dispatched. Production SELECTs establish:

- Main-store `orders_backfill` run `fb4e1613-e52d-4ccb-87ad-5d47adcccd32`
  succeeded October 6: July 7–October 5, 76,229 orders fetched/upserted.
- Run `d2859cfe-39a8-4191-a998-d4b1675f4b4c` succeeded August 18:
  May 20–August 18, 90,577 orders fetched/upserted.
- Existing attribution evidence contains five orders captured more than 60 days
  after creation with actual discount-code arrays. Earliest is July 11 order
  `6537757687878`, fetched October 27. Latest such capture is October 28.
  All five arrays are empty: measured no-code evidence, not missing evidence.
- The October 28 discount-code aggregate sync succeeded with 2,461 rows and 2,120
  distinct codes over 30 requested days. Three days hit its top-200 cap. This is
  useful ingestion evidence, but the aggregate is not a complete order-level source.

These records establish functioning ingestion and older-order access. They do not
establish the missing January–June `discountCodes` values, full YTD ledger coverage,
or the throughput of this exact historical journey collection. The first approved
bounded stage will establish those specific facts; repeating generic access probes
adds no useful evidence. Ongoing capture remains in the existing `fetchJourney` /
attribution sync pipeline already shipped in PR #1031. This CLI is targeted repair
and replay tooling only; no production schedule or report-specific sync was added.
