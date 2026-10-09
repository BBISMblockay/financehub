# Silo Attribution v1

## Overview, observed rollups and model sensitivity

The existing page opens on Overview; Journeys retains order search and evidence
drilldown. Revenue charts, controls and model comparisons are disclosures. The
overview uses unique orders from the reconciled day ledger, including older
orders with refunds. It never counts a refund day as another journey.

Timed rollups require ready, fully paginated captured visits, valid chronology,
matching evidence timestamps and reproducible published introduction/assist/close
labels. Missing, pending, unknown-source, stale and historically unmappable
evidence is disclosed, not inferred. Consecutive channel repeats collapse; later
returns remain separate. Timing uses the first touch of each channel run. Median
elapsed-to-purchase and each step median have their own sample count; medians
need not add. Role counts overlap and do not add revenue. These are orders with
sales activity, not a purchase-date acquisition cohort or proof of incrementality.

Comparisons never modify stored `silo-last-non-direct-v1.1` allocations:

- Equal-share gives each distinct eligible non-direct channel one equal weight.
- Time-decay uses each channel's latest eligible visit and
  `2^(-days before purchase / halfLifeDays)`, default seven-day half-life,
  configurable 1–60. The selected lookback is the horizon. Repeats do not increase
  a channel's weight simply by volume.
- Role weights default 40/20/40 for first touch, intermediate distinct channels,
  and last touch. Intermediate channels divide the assist weight; a channel can
  hold several roles. Absent assists are omitted and remaining weights normalize.
  Single-touch journeys get 100%. If all available roles have zero weight (e.g.
  assist-only settings on two touches), distinct channels share equally. Negative,
  nonfinite and all-zero settings are rejected.
- Excluded orders retain baseline credit in every model. Net and total cents
  allocate separately per unique order via largest remainder, lexical channel
  tie-breaks, with negative amounts mirroring positive allocations. Aggregation
  remains in the report's single currency and store timezone.

Suggestions separate observation, hypothesis and proposed test/investigation.
Saving requires an owner from the active company's membership and a review date.
The result is a private evergreen `launch_tasks` item with status `open`, titled
`Review draft:` and explicitly unapproved in its notes. Task Manager can edit it.
There is no new draft status or approval pipeline. A deterministic UUID scoped
to creator/company/store/reporting dates/lookback/suggestion prevents repeated
clicks and concurrent retries from creating duplicates; retries retain edits.
No ad-platform write occurs. Supporting IDs (up to 50 in the note) and report
filters are retained; current evidence must be rechecked at review time.

No migration, edge deployment, secret or scheduler change is required for this
add-on. Existing attribution ingestion prerequisites remain. A draft PR does not
make the feature live. The approved concept image could not be downloaded (HTTP
403); exact image matching is unverified. Preview screenshots use synthetic data.

## Coverage scheduler (draft; disabled pending acceptance)

Apply `20261007031733_attribution_coverage.sql` after the original migrations;
verify the general schema. No edge deploy or OAuth changes. The new workflow
runs daily at12:25UTC only if `ATTRIBUTION_COVERAGE_ENABLED=true`; leave unset
during the original pilot. `ATTRIBUTION_COVERAGE_COMPANIES` requires company
UUIDs for a pilot, or explicit `*` after reviewed all-eligible acceptance.
New active/sync-enabled connections in that scope enroll automatically each run.
Existing sync_enabled/is_active opt-outs are respected; optional comma-separated
`ATTRIBUTION_EXCLUDED_CONNECTIONS` stops only attribution for those connections.
Missing read_orders/read_reports grants produce logged scope skips, not enrollment.

Initial history freezes the preceding `ATTRIBUTION_INITIAL_DAYS` complete
store-local days (default31, allowed1–31), NOT lifetime history. The manual
workflow remains available for separately approved older dates. Without
read_all_orders, attempts stay within59 completed local days; an enrollment
floor outside that retention reports permission_limited. Historical reversals
may still have unavailable journeys. No additional permissions are requested.

Each run attempts up to3 missing historical days plus7 recent refresh days per
store. Published atomic snapshots are success checkpoints. The frozen floor
retains outage gaps; a persistent history cursor rotates past failures so later
gaps can progress before a failed day is retried. Current-day successful refresh
snapshots skip repeat work. Stores run least-recently-attempted first, sequentially.
A270-minute admission deadline stops new work within the330-minute job timeout;
an in-flight day can exceed that deadline. Workflow concurrency serializes the
manual/pilot/coverage paths. Direct concurrent CLI calls are unsupported. Legacy
scheduled runs skip while coverage is enabled. API load is up to10 existing day
collections/store/run (paginated ShopifyQL plus per-order journeys,9999-row/day
cap unchanged); production capacity is not yet measured.

The service-only shopify_attribution_coverage row records frozen start_day,
next_day, last_attempt_at, last_status, last_failed_day/at and attempted/succeeded/
failed counts. Upstream error bodies are never stored. Snapshot rows identify
completed dates; workflow receipts include daily reconciliation counts. Failures
continue other stores but fail the workflow. Success describes bounded work,
not an empty backlog; paused identifies interrupted work. Scope skips stay in
workflow output. Before enabling, verify grants/RLS, restart recovery, calendar
boundaries, disconnect, failure isolation and measured pilot API load. Wider
customer rollout requires separate acceptance. Disabling the flag preserves
snapshots, mappings, catalogs and user edits.

Checkpoint-read errors skip the affected store and fail the workflow while other
stores continue. Eligibility, company, store domain and current order-history
permission are checked again immediately before publication. A disconnect during
collection therefore prevents that day from publishing. Preparation failures before
the first enrollment have only a redacted workflow receipt, not a durable attempt
timestamp; many slow failing new stores can consume the admission deadline before
healthy stores run. Pilot capacity and this enrollment fairness limit require
acceptance before widening scope. Existing snapshots older than the trailing-seven
refresh window are not continually re-extracted for later journey changes.

## Preflight and release contract

New path: manual/scheduled attribution workflow → dedicated Node worker →
ShopifyQL order/day sales and independent daily controls → order journeys →
atomic day publication. Existing sales/inventory syncs and their three edge
copies are not modified. Browser reads only published snapshots under tenant RLS.

Live verification: ShopifyQL order_id/day worked for all 30 September days;
all 16,835 Order nodes and paginated journeys were available. Existing order and
connection policies and unique constraints were inspected from pg_catalog.
No existing policies are changed. Historical availability remains store/scope
dependent; null journeys and pending journeys never imply Direct.

Capacity gate: the shared ShopifyQL client rejects results at its 1,000-row
ceiling. Attribution uses stable ORDER BY order_id / LIMIT 500 OFFSET pages,
then validates combined identities and independent daily totals. It supports
at most 9,999 order/day rows per day. Dry-run every requested day before rollout;
a capped, overlapping or incomplete page cannot publish and blocks acceptance.
Shopify's documented LIMIT/OFFSET syntax is used without changing the shared
parser. Verify the high-volume launch day in the production dry-run before
enablement: the September 1 pilot includes 2,549 order/day rows.
An inaccessible historical Order node is explicit unavailable evidence: its
reversal still reconciles and remains Unattributed unless a previously stored
complete journey exists. It does not prevent later days from being processed.

Tests defined before implementation: capped/null analytics fail closed;
duplicate/missing order IDs reject; cents and reversals conserve revenue;
moment pagination exhausts cursors; pending journeys retry; failed publication
does not replace an existing day; stale concurrent runs cannot overwrite newer
snapshots; authenticated users read only their active company and cannot write;
anon cannot read; client roles cannot execute publication. Window tests cover
7/14/30/60-day boundaries, Meta→Redo→Direct, first-touch/assists, unknown visits,
internal referrers and tenant-specific storefront domains.

## Rollout

Three stacked PRs: evidence/ledger, model, Beacon report and journey flow.
Apply migrations in that order after review. Run schema verification. Set
`ATTRIBUTION_CONNECTION_ID` to one connection, leave `ATTRIBUTION_SYNC_ENABLED`
unset until the pilot is accepted. Manual dispatch requires explicit dates and
connection; `commit=false` is read-only. Date range is inclusive, max 31 days
per run. Resume with the first unfinished day from the workflow log.

Start September 1–30 for the main store. Compare daily controls and the pilot,
review Meta→Redo examples, another month and a launch period before enabling
the scheduled trailing-day refresh. Rerunning a day replaces its complete
ledger atomically (including removed rows); prior snapshots survive failures.
Pending evidence is retained and retried on rerun. Historical refunds on older
orders are included because discovery starts from sales activity, not creation.

Do not execute a live backfill, apply migrations or enable the scheduler as
part of opening these PRs. The current local pilot is not a production import.

## Interpretation

Revenue is credited once to the latest identifiable non-direct touch within
the selected window. Introducing and assisting channels are context, not extra
revenue. A 60-day window is not a claim of 60-day tracking completeness. Commerce
channels are distinct from ad credit. Raw landing fields are first-touch
evidence; they cannot override a later observed visit. Missing evidence stays
Unattributed. This is observed attribution, not incrementality or causality.

## Apply and verify

Apply the two `*_silo_attribution_evidence.sql` and
`*_silo_attribution_report.sql` migrations explicitly, in that order. The large
repository-wide rebuild/verifier files are unchanged; this feature's schema
checks live in `supabase/verify_attribution_schema.sql`. Run both that verifier
and the existing general verifier after apply. Snapshot allocation objects are
persisted for all four windows with `model_version`; a rule change requires a
version bump and bounded reprocessing. Campaign matching reads only same-company
catalogs. Assists can overlap and must never be summed into credited revenue.
