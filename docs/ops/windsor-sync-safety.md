# Windsor sync safety: preflight and rollout

## Outcome and acceptance

Company admins connect sources and preview them on `v2/windsor-test.html`.
Connection is not permission to import arbitrary data. New accounts start paused;
only the existing explicit TikTok and Klaviyo dataset definitions can be enabled.
Other sources remain previewable, with sync blocked pending a reviewed schema,
identity binding, date semantics, dimensions and stable row key. No arbitrary
spreadsheet importer, selector binding inference, or existing data deletion is
part of this change.

## Preflight (2026-11-03)

Call path: `windsor-sync.yml` -> `scripts/windsor-sync.mjs` -> `syncAccount` ->
`fetchDatasetHunted` -> core/hunted reads -> `prepareRows` -> upserts -> progress.
Manual company/history/window/budget/dry-run inputs cannot override source or
consent gates. Preview and catalog stay read-only through `windsor-broker`;
new sync controls use its existing user/MFA/integration/active-company/admin
gates and `ownAccount`, never a company supplied in the request.

Live read-only preflight: linked accounts have authenticated SELECT only,
company/admin SELECT RLS, service_role writes, a company stamp INSERT trigger,
unique (source, account), and a composite company/link FK. No client write grants
or policies are added. Migration adds a false-default consent column; initial
backfill enables only already-successful explicit datasets, once. Reapplying
must not undo an admin pause. No production changes were authorized or performed.

Failure: unsupported source, missing consent, bad identity/date or duplicate grain
must not advance the failed window. Earlier completed windows/datasets are not
rolled back. Numeric field negotiation remains bounded; unmatched or ambiguous
hunted rows must fail before merging. Existing schemas retain their explicit
text attributes and numeric fields. Generic catalog shape alone proves neither
ownership nor row grain, so automatic mapping is removed from the sync path.

Pause applies to subsequent runs; it does not cancel a run already admitted.
The UI states this limitation. Reconcile updates metadata without resetting
consent. Missing consent schema fails closed; rollout requires applying the
migration before the changed scheduler runs. Existing successful TikTok and
Klaviyo rows are backfilled, without changing their history or metrics.

Tests: broker cross-tenant/admin/boolean/source enforcement; migration defaults,
one-time backfill, reapply, grants/RLS; real sync with synthetic core and hunted
responses (mixed identity, missing/invalid dates, duplicate same-day grain,
unsupported text schemas, no advancement, retry, distinct valid campaigns,
Klaviyo text attributes); real page with mocked broker/database and toggle
failure/recovery. Mutation tests remove key guards. No production data fetch.

## Release gates

Blake owns migration apply and broker deployment after review; neither happens
in this PR. Apply migration before merge/scheduler rollout, verify schema, then
deploy broker from main via Deploy Edge Function. A missing migration stops the
new scheduler rather than falling back to automatic ingestion. Old broker
cannot toggle sync; the UI must show its failure without claiming success.
After deployment, verify existing fixed accounts remain enabled, new accounts
are paused, unsupported accounts cannot enable, tenant boundaries hold, and
pause/resume persists. Live Windsor schemas, row contents and scheduled execution
are unverified here. Arbitrary-source ingestion requires a separate reviewed
contract/storage design; a successful preview does not certify it for sync.

## Broader goal

See [Windsor → LLM / MCP connectors](windsor-mcp-connectors.md) for the traced
existing permission path, current reporting activation state, and the next
lossless-storage/publication contract. Non-pillar connectors are not automatically
added to main reporting. No new MCP data access is enabled by this PR.

Migration tooling note: the installed latest Supabase CLI failed before command
execution because it tried to write its config under the read-only home; a pinned
CLI installation also failed. The repository-format migration was created locally
and is exercised with PGlite; neither CLI attempt applied anything.
