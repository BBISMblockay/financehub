# Product workflow preview

Blake requested an additive V3 preview, reached only at
`/v3/product-workflow.html`. Do not add navigation or entry buttons until he
promotes it. Existing concepts, catalog, PO Builder and launch records remain
the operational sources of truth.

## Preflight (2026-09-26, before implementation)

The live UI has rich concepts with no brief handoff; PO Builder has a hidden
concept picker, and launch briefs only exist after a launch has been created.
Inventory shows 30-day cover without a purchasing handoff. No dedicated idea
bank was verified: manual ideas are supported, without claiming a bank import.

Inspected live `pg_policies`, `pg_constraint`, `pg_trigger`, function bodies and
EXECUTE grants for the target tables/functions. PO statuses are title case;
launches use `planned`. `po_lines.product_master_id` is the catalog FK. The
line snapshot trigger fills only absent values. Launch product deferral clears
when a PO is linked. No notification trigger fires for these inserts.

New call path: preview → source preset / read-only restock evidence → saved
`product_workflow_briefs` → review → transactional PO or launch RPC. All new
writes require the existing `po_builder_can_write()` authority and an explicit
active-company match. Reads use company RLS. Existing functions are unchanged.
The source snapshot is captured on first save; a later concept edit never
silently rewrites a reviewed brief. Suggested copy never becomes approved copy.

One brief is one purchasing decision (one concept, idea, or catalog variant).
Collections are selected one child concept at a time. A source may intentionally
have multiple briefs; the brief ID deduplicates retries, not all future buys.
Source identity cannot change after save. A reviewed brief is frozen; reopen
before handoff to revise it. The first save refuses a preset if the source's
`updated_at` changed since selection, so the saved evidence cannot silently
describe a newer source than the one that supplied the form. A reviewed brief
stays frozen through handoff. Output creation locks the brief, checks the role
and source company, creates the existing records and records their IDs in one
transaction. Failure rolls everything back; a lost response returns the same
output on retry. A version check rejects a stale editor. Concurrent saves take
a per-brief transaction lock, including first creation.

Pipeline sync uses the existing `SiloPoPipeline.sync` after the PO commits.
Its failure must say the PO exists and offer retry, never repeat PO creation.
There is no automatic purchasing approval, supplier send, publishing, accounting
posting, marketing campaign change, or background suggestion producer here.

Tests defined before implementation: preset provenance and unapproved copy;
90-day denominator distinct from lead/cover; missing/negative/stale evidence;
same-company source checks; viewer/anonymous denial; forged direct writes;
review freeze; stale version; repeat/concurrent handoff; rollback after line
failure; PO remains Draft; launch receives brief fields and source links; no
navigation entry; complete page-to-RPC payload and recoverable errors.

Live-only verification still required after migration: production RLS-backed
page walkthrough with a test company, Pipeline sync, deep links, and acceptable
restock read latency. No production writes were used for this audit.

## Using the preview

Search a concept title or catalog title (SKU search is the fallback), or select
Manual idea and press Search. A concept's size breakdown, factory, audience,
angle, design direction and draft copy prefill the brief. A catalog source
keeps its existing variant identity. Ideas are saved here as briefs; this is
not an unverified integration with a separate idea bank.

Save drafts into the shared review queue; reviewed briefs show distinct PO and
launch handoffs. Reopen before handoff to change reviewed content. Create the
PO first if both outputs are wanted: the later launch links it. A launch-only
brief cannot later create a PO, because that would leave the launch's product
selection and measurement ambiguous. A launch date can be chosen at handoff
after the PO has been created. Editing either output later belongs to its
existing module; this preview does not overwrite it.

The restock worksheet works one catalog SKU at a time across all locations.
`max(0, ceil(units_90d / 90 * (lead_days + cover_days) + safety_units - on_hand - incoming))`.
The sales window ends on company yesterday. Lead time + desired cover is the
incoming cutoff, not the sales denominator. Incoming counts Approved, Sent to
Factory, Confirmed, In Production, Shipped and In Transit POs dated between
company today and that cutoff. Draft/closed/cancelled/received orders do not
count. Overdue, undated and partially received orders need manual review
because this schema does not expose remaining received quantities. Negative
stock, absent sales/stock, multiple as-sold names, old snapshots and saved
evidence age are named. Overrides and warnings require a decision note in the
UI. The evidence is a saved, user-reviewed worksheet snapshot, not an
independently attested demand forecast. No stockout/seasonality correction is
claimed, and a 90-day window does not prove 90 days of feed completeness.

## Deployment / promotion

1. Apply `20260926082115_product_workflow_preview.sql` after its existing
   concept/PO/launch/timezone dependencies; run `verify_v2_schema.sql` all-ok.
   Expected post-merge drift is red until this migration is applied.
2. Open the direct URL with an admin in a test company and a viewer. Confirm
   an absent migration is explained, an unauthorized write is rejected, and
   an independent tab's stale edit is refused.
3. Exercise concept → save → review → PO → Pipeline → launch Brief tab and
   catalog → restock basis → reviewed quantity → draft PO. Confirm source
   quantities, draft copy, catalog identity and date in the existing modules.
4. Check the restock read latency and reconcile one SKU against its complete
   90-day sales, latest inventory snapshot and qualifying incoming orders.
5. Only a later, explicitly authorized promotion adds menu/entry buttons.

No edge deploys, secrets or config changes. Future work: automatic suggestion
producers (including SERP-backed marketing recommendations), evidence-bound
approval policies, a verified idea-bank connector, outcome measurement and
accounting feedback. The preview labels these as not connected rather than
rendering invented progress or accounting status.

## Verification

- `node scripts/tests/product-workflow-database.test.mjs` executes the migration
  twice in PGlite PostgreSQL, then exercises grants/RLS, role and company gates,
  save replay, stale versions, review freeze, transactional handoffs, rollback,
  source reuse, date-window boundaries and deleted-output retry refusal.
- `node v3/tests/run.js --unit` includes presets, 90-day math, unknown evidence,
  review overrides and absence of navigation promotion.
- `node v3/tests/browser/product-workflow.test.js` runs the real page with a
  fake Supabase boundary, including save-response loss and Pipeline recovery.
- Mutation modes in the database suite remove scope, authority, retry or freeze
  guards; each must fail. The unit suite's `MUTATE=denominator` must fail too.

The local database serializes calls; real overlapping PostgreSQL connections
remain a test-company release check. SQL row/advisory locks provide the
concurrency boundary. These tests do not prove live provider freshness or
the state of production's existing modules.
