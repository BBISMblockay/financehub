# Silo Attribution v1

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
ceiling. This release supports at most 999 order/day rows per day. Dry-run every
requested day before rollout; a capped day cannot publish and blocks acceptance.
Stores with larger days require a separately verified partitioned query path
before enablement. Do not bypass the ceiling or publish partial sales.
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
