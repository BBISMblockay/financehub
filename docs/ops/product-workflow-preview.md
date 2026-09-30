# Product workflow preview

Blake requested an additive V3 preview at `/v3/product-workflow.html`. It was
promoted to the Purchasing nav on 2026-09-30 with the Ready for PO gate; see
the last section. Existing concepts, catalog, PO Builder and launch records remain
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
loads its mapped size/color spread, preserving every catalog SKU identity. Ideas are saved here as briefs; this is
not an unverified integration with a separate idea bank.

Save drafts into the shared review queue; reviewed briefs show distinct PO and
launch handoffs. Reopen before handoff to change reviewed content. Create the
PO first if both outputs are wanted: the later launch links it. A launch-only
brief cannot later create a PO, because that would leave the launch's product
selection and measurement ambiguous. A launch date can be chosen at handoff
after the PO has been created. Editing either output later belongs to its
existing module; this preview does not overwrite it.

The restock worksheet shows one product with separate calculations for each mapped SKU across all company locations; it never nets surplus in one size against demand in another. Legacy briefs retain the previous single-SKU layout. Safety units are per SKU.
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
   concept/PO/launch/timezone dependencies, then apply `20260927074820_product_studio_variant_spread.sql`; run `verify_v2_schema.sql` all-ok.
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

### Review-bound evidence

Catalog handoff locks and checks title, product type, variant title and SKU against the captured snapshot. Routine sync timestamp changes alone do not invalidate a review.
If the catalog changed, start a new brief and review it; retrying an existing output
still returns that output. Restock review recomputes the company/product/horizon
basis in the database and requires the submitted evidence to match (apart from
its observation timestamp). Refresh missing or changed evidence first. Missing
sales/stock, stale evidence, ambiguous incoming stock and quantity overrides
require a decision note. A note never authorizes forged evidence. Exact save
retries remain valid even when inventory changes after the successful review.

## Product Studio UI (2026-09-27)

The same direct-link route now presents Product Studio: compact source and saved
brief queues, Overview / Creative / Buy plan / Launch tabs, a visual brief, and
an evidence/checklist rail. On narrow screens the selected brief leads; a Browse
button reveals the queues. No V2 entry button or navigation promotion is added.

Recent concepts load into the source queue without requiring a search. Selecting
a source resumes its most recently updated non-dismissed brief (company-scoped,
not limited to the loaded queue). Completed catalog/restock buys start a fresh
cycle. The explicit “Start another brief from this source” action always reads
the current source before filling an unsaved preset; it preserves intentional
repeat buys and updated-concept revisions. `?concept=<id>` is also supported for
direct links, with an active-company filter. Nothing saves by selecting a source.

Concept reference images and catalog `image_url` are taken from the brief's source
snapshot. Only HTTPS image URLs render. Missing/failed artwork has an explicit
fallback; no generated artwork, invented metrics, or new image-generation service
is included. Source evidence remains separately expandable. Review checklist
items are advisory and do not change server review or handoff rules.

Validation: all 22 V3 unit suites; the real-page browser fixture covers tabs and
unsaved edits, source resume, no implicit saves, keyboard navigation, reference
images/unsafe-URL rejection, foreign-company concept denial, viewer and missing
migration states, save-response retry, review freeze, PO/Pipeline retry, launch,
restock recalculation and phone overflow/browse behavior. Screenshots in
`screenshots/product-studio/` are fixture-based (not production records).


## Product-level SKU spread (follow-up to #813)

New catalog/restock briefs opt into `content.catalog_scope = product`. Search groups
by company + Shopify shop domain + product ID using `shopify_product_skus`, before
the 30-product search limit. `products_master` is SKU-grained and its store/product
fields reflect the last sync, so those fields and product titles do not define a
family. Unmapped SKUs appear explicitly as singletons. A selected mapped product
must resolve every mapping to a unique, nonblank company SKU (maximum 100);
missing/duplicate mappings or a SKU shared by different products in one shop block
the full-spread path. A SKU shared across stores remains company-wide inventory
and demand, and may legitimately appear under each store's product.

Mapping is an observed sync record, not a guaranteed live catalog registry. The
UI displays its oldest observation and asks the buyer to confirm the spread.
Deleted variants may remain. No variants are silently inferred from names or
removed for having zero demand. First save checks every sibling's identity and
source timestamp; reviewed and handoff checks compare consumed identity, allowing
routine timestamp-only syncs after the snapshot has been saved.

Every catalog line remains in the brief exactly once. Enter zero to exclude a
size; blank is undecided. Review requires a quantity for every SKU. Restock review
and handoff both verify all SKU evidence and require a decision note for unknown
or stale evidence and overrides. The draft PO receives only positive lines, with
catalog IDs/SKUs resolved on the server. An all-zero spread cannot create an empty
PO. Creation is transactional; failed lines roll back the header and all lines.
The existing output ID makes retries idempotent. No draft PO is sent or approved.

Concepts use their saved size/color breakdown; users can add or edit the full
spread before SKUs exist. Opening a collection shows its child products instead
of starting a PO for the collection parent. Each child gets its own brief and
spread. This does not combine multiple child products/factories into a single PO.

Read RPCs retain invoker permissions and explicit active-company checks. Validation
helpers have no client EXECUTE grant; existing writer RPCs keep the purchasing
role gate and empty search_path. No table or RLS policy changes. The batch basis
request is bounded to 100 SKU reads and uses the existing scalar evidence rules;
production latency on large spreads remains to be measured. Any timeout aborts
without creating partial operational records. No production migration was applied
while preparing this PR. Post-apply: run the verifier, reconcile a real multi-size
restock, and smoke-test concept → PO → Pipeline plus restock → PO → launch.

## Ready for PO and promotion (2026-09-30, `20260930120000`)

Product Studio is now the Purchasing destination (`purchasing/product-studio`
in `v2/nav-config.js`) and replaces Product Concepts. `/v2/product-concepts.html`
forwards to `/v3/product-workflow.html`, keeping `?concept=<id>`. Ask SILO's
header button and each concept card's **Open in Product Studio** go there too.

One flow: Ask SILO drafts the concept → Studio opens it (evidence, forecast,
recommendation, reference images, **Add reference image**) → a person confirms
the purchasing details and presses **Mark ready for PO** → **Create draft PO**.
The concept list has three views: Ready for PO (default), Ideas / drafts and PO
created (`product_studio_concepts_v`; `?view=draft|ready_for_po|po_created`).

**What Ready for PO requires** (`product_concept_po_readiness_issues()`; the
page's checklist is `readinessIssues()` in `v3/product-workflow-model.js`, and
the database suite fails if the two ever disagree):

- a specific product, not a collection parent with live products
- a product type and a factory in the active company
- a positive whole-unit total, and sizes/variants whose quantities sum to it
  (every line named once, every quantity at least 1)
- an explicit sized / one-size choice (one size = exactly one line). A concept
  with one populated size is never assumed to be one size
- an explicit confirmation of those exact lines. Changing a size, quantity,
  total or sizing withdraws it on the page, and the database refuses a
  confirmation that does not describe the lines being saved

Ask SILO's values prefill as proposals. A concept with no size breakdown gets no
line at all (the old preset made one unsized line with the whole quantity,
which is how KCMTAR-7 came to be). Ask SILO cannot mark anything ready.

**Enforcement.** For a concept brief, "reviewed" now means ready: the save RPC
runs the rules and stamps `po_ready_at/by` and a fingerprint of the concept's
purchasing fields. The PO handoff runs them again, refuses an unmarked brief,
and refuses if the concept's type, factory, quantity, sizes or parent changed
after marking (copy and images do not count). The PO is built from the reviewed
brief, Draft, `generated_from_concept_id` set. `generate_po_from_concept()` (the
legacy `po-builder.html?fromConcept=` link) now hands off the concept's ready
brief through the same function, returns an existing PO, or refuses with a link
back to Studio. A trigger refuses browser writes of `po_lines.source_concept_id`,
`po_headers.generated_from_concept_id` and `po_concept_links`, so the hidden
in-builder concept picker and hand-made API calls cannot bypass the gate;
ordinary PO lines are untouched. Every path locks the concept first, so
concurrent requests from either entry point return one complete PO.

**Existing records are not converted.** An approved concept is not ready.
A concept brief reviewed before this change must be reopened and marked
ready. A concept that already has a PO (e.g. Bat Bros → KCMTAR-7) lists under
PO created, opens that PO, and cannot be marked ready again. Nothing in the
migration writes to existing concepts or POs.

Behaviour change for concept briefs: they can no longer be reviewed without
the purchasing details (a launch-only concept brief now needs them too), and
one concept yields one PO through this flow. A later buy of the same product
is a catalog/restock brief.

Verification: `scripts/tests/product-studio-ready-for-po-database.test.mjs`
(19 cases, 8 mutations), `product-studio-ready-for-po-concurrency.test.mjs`
(real PostgreSQL, 4 overlapping-session cases, 2 lock mutations; CI job
`onboarding-concurrency`), the v3 unit and browser suites, and
`v2/tests/browser/po-builder-from-concept.test.js`.
