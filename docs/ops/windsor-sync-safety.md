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

## Core retry and failure diagnostics (2026-11-04)

Investigation baseline: `b5318432` (main); no Windsor core change since the
failed run's `098ee535`. Run `41889105953` reported Klaviyo `account: timed out`,
TikTok duplicate grain, and intentionally unsupported YouTube. The Klaviyo
message originates in the core request, before hunted-field retry/splitting.
Its first window is 35 days. TikTok's old duplicate message does not distinguish
core from hunted validation, so it cannot establish the offending request.

The patch reuses the existing two-attempt transient read helper for core reads.
Timeouts, network/body read failures, 429 and 5xx retry the identical request
once, each attempt charged to the existing global budget. A persistent failure
stops the dataset before writes/progress. A 5xx naming a field cannot negotiate
that field away. Empty HTTP error bodies remain HTTP failures. Field refusal
negotiation is still capped at four iterations (at most eight attempts per core
fetch, 120 seconds each); hunted splitting and its existing cap are unchanged.
Errors now identify source/dataset, date window, and core/hunted batch/merge
stage, without adding account values, row payloads or URLs to diagnostics.
Existing provider-error redaction remains in place.

Preflight scope: workflow -> script -> syncAccount -> fetchDatasetHunted ->
fetchDataset/readOnceRetrying/readOnce; hunted callers also use readOnce.
Public core functions are additionally exercised by the sync tests; the
synthetic developer API database suite imports syncAccount. Company/history/
window/budget/dry-run inputs, source/consent gates, tenant attribution, writes,
policy/grant definitions, mapping-generation guard and workflow concurrency do
not change. No live policy query was needed because no policy/grant is touched.
Successful earlier datasets/windows remain committed; failed windows retain
old progress and repeat on the next run. Budget exhaustion remains partial;
other request/validation failures remain errors. Paused/unsupported behavior
is unchanged. No new destructive operation or rollout dependency is introduced.

Acceptance tests use the real syncAccount path with deterministic HTTP and
in-memory database doubles: core retry/recovery, exhausted retry, exhausted
budget, body interruption, empty 503, persistent 503 naming a field, permanent
401, secret redaction, duplicate core versus hunted diagnostics, retained rows
and cursors. Existing identity, consent, grain, options, mapping-generation and
hunted split tests remain. PGlite exercises database isolation, grants and
consent without production access. Mutation checks must catch removal of each
new fix and the existing safety guards.

### Remaining evidence and verification gate

This is a resilience/diagnostic improvement, not proof the live sync is fixed.
An identical retry may still time out. Date subdivision is deferred: daily row
identity alone does not prove that all requested metrics (including hunted
metrics) have identical semantics under a shorter query range. Before adding
it, verify stable daily values and consistent field availability across ranges;
then require all subranges to validate before writing a dataset window, no
cursor advance on any failure, and a bounded request/time cap.

TikTok's `hunt.tables: null` selects numeric fields across catalog tables.
[Windsor's field reference](https://windsor.ai/data-field/tiktok/) documents
`cash_spend` as advertiser-level/lifetime and `include_inactive` as adding
inactive entity rows. That establishes a structural compatibility risk, not
the cause of this particular duplicate. No field/table allowlist, row key,
aggregation or source enablement is changed here. A catalog table label does
not establish compatible grain.

Before changing the TikTok contract, obtain a read-only, privacy-safe capture
for the failing account/window: exact requested field names/options, core vs
hunted stage, duplicate counts at account/date/campaign grain, and the differing
dimension names (with identity values consistently anonymized). Compare core
alone with the offending hunted field group, and confirm provider semantics for
the proposed grain. Do not save raw customer payloads or credentials in logs.

Blake/parent owns publication and rollout. After review and authorized merge,
verify the next authorized run: transient recovery if applicable, diagnostic
stage for persistent failures, retained cursors on failures, and no newly
supported YouTube import. Production execution and metric reconciliation remain
release-verification gates; no live rerun, write, merge, deploy or migration
apply was performed in this investigation.

## What the 2026-11-04 run proved, and the two fixes it pointed at (2026-11-05)

The dry run Blake dispatched after #1135 merged (run `41919728554`, main
`7782a69`) failed, and said exactly why — which is what the diagnostics were
for:

```
klaviyo/account 2026-09-30..2026-11-03 core: account: timed out
tiktok/campaign 2026-09-30..2026-11-03 hunted batch 4: Ambiguous duplicate row grain; window not saved
```

Seven of 3000 calls. YouTube stayed unsupported, as intended.

**Klaviyo — the retry is not enough, the window is.** Asking the identical
35-day question twice got nothing twice. The core read now halves a window
Windsor did not answer for, down to a floor of `MIN_SPLIT_DAYS` = 7. Three
guards make this safe to do without the range-semantics evidence the previous
note asked for:

- It happens **only after the whole window has already failed**, so a working
  full-window read is never replaced by split reads, and a stored value never
  changes because of how the question was asked. The two cannot disagree,
  because the two never both exist.
- The halves are **disjoint and cover the window**, and every row still carries
  its own date, so the halves are concatenated, never summed. No metric is
  aggregated across a range by this code.
- **Every half must succeed.** A half that still fails throws, the window is
  not written, and the cursor does not advance — the behaviour before this
  change. Halves are read depth-first, so the first failing one ends it: an
  unanswered 35-day window costs two whole-window attempts and one pair per
  halving, eight reads, and then the account's run ends as before.

What this does not establish: that Windsor returns the same daily values over a
7-day range as over a 35-day one. It cannot be established while the 35-day
range returns nothing at all. If a later comparison shows the values differ by
range, the fix is to narrow `RECENT_DAYS`, not to re-widen on failure.

**TikTok — the offending field is now found instead of costing the window.**
`hunted batch 4` told us this is a hunted field, not the core request. A
duplicate or missing-identity row from a hunted batch now marks the error
`grain` and the batch is bisected (`isolateGrainOffenders`, at most
`MAX_GRAIN_READS` = 12 reads) until the field that does it is identified. It is
then refused by name, recorded on the mapping row and not asked again this run,
and the rest of the batch still lands. A group that cannot be told apart —
because the reads stop answering — is dropped whole rather than trusted.

**An ambiguous batch is no evidence against the fields that travelled in it.**
Isolation refuses a field only when a read *answered* and that field was shown
to be the problem, or when Windsor refused it by name. A subgroup the provider
stops answering for, and a subgroup the read allowance never reaches, are left
unresolved and mark the window `incomplete` — so it is not written and the
cursor does not advance, the same handling an unanswered hunted field already
had. Treating either as a refusal would let a provider blip replace stored
metrics with a row collected without them, count the window as covered, and
skip those fields for the rest of the run. (Raised as P2 on #1141 review cycle
1; the allowance is 24 reads so that a batch with two or three real offenders
still resolves instead of leaving its window unwritten run after run.)

The core read is deliberately **not** isolated this way: it decides which rows
exist, so an ambiguous core grain still fails the window unwritten.

This matches what Windsor documents for TikTok (advertiser-level and lifetime
fields such as `cash_spend`, and `include_inactive` adding inactive entity
rows): such a field cannot sit on a daily campaign row, and now it is dropped
by name instead of taking the window with it.

**Still unverified.** Neither fix has run against Windsor. The next authorized
run is the gate: Klaviyo should either land rows or fail naming a half-window,
and TikTok should either land rows with one or more fields listed in
`refused_fields` or fail somewhere new. Metric reconciliation against the
provider remains a separate release gate.
