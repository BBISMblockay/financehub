# Windsor → LLM / MCP connectors

## Product boundary

Blake's goal is connect → save company data → ask through SILO's LLM/MCP →
repeat across sources. Non-pillar sources belong in an **LLM / MCP connectors**
management surface, not automatically in SILO's main reporting areas. Existing
Klaviyo, TikTok, saved reports and dashboards remain intact. The safety PR does
not rename navigation or imply a working arbitrary-source importer.

Connection, sync consent, and LLM publication are three separate decisions.
An integration in Windsor's picker proves availability of a connection flow,
not that SILO has verified identity, schema, pagination or lossless row grain.
A read-only preview proves only the rows in that response passed account checks.

## Verified current path (2026-11-03)

- Windsor broker attributes a linked account through the company's issued link
  token; the source/account pair is globally unique. Preview uses an authenticated
  admin's active company, an own-account lookup and exact returned account checks.
- Current persisted data is daily typed/numeric facts: TikTok campaign metrics,
  Klaviyo account/campaign/flow reports, and historical `windsor_metrics_daily`
  account/campaign facts. It is not generic spreadsheet storage. Klaviyo's known
  descriptive attributes are retained; arbitrary unknown text is not.
- Live `klaviyo_performance_daily` has 28 catalog columns and
  `windsor_metrics_daily` has 25. Both are visible to the AI schema catalog but
  `reportable=false`. The guided builder (`v3/js/report-builder-ui.js`) selects
  only reportable relations with nonempty columns. Original migrations seed empty
  columns; a catalog refresh has populated them live. This PR intentionally does
  not flip reportable, create global reports, or change existing reports.
- The app's report engine is `chat_run_readonly_query`, SECURITY INVOKER under
  the caller's RLS. MCP forwards the caller's token, not a service-role key.
  `reports:read` gates list/run-report; `data:read` separately gates schema/query.
  MCP SQL executes as `silo_api_exec` (no BYPASSRLS; inherits authenticated), with
  active company bound to the live OAuth grant, read-only execution, pagination,
  catalog/name/function restrictions. An older reports-only grant cannot query
  raw data. Revoked grants and scope checks remain the existing API's responsibility.
- Live Windsor fact SELECT policies filter active_company_id. Linked-account
  SELECT is also admin-gated; link-token tables have no client SELECT grant.
  Their current catalog visibility is not permission to read tokens. This PR
  adds no table grants, MCP scope, API endpoint or automatic publication.

The new synthetic test in `developer-api-query-tool-database.test.mjs` runs the
real sync transformations into tables built from the real Windsor migrations,
then the existing real MCP query RPC. It verifies two tenants, distinct same-day
campaigns, text subjects, explicit cross-company predicates returning nothing,
reports-only scope denial, write denial and link-token denial. Windsor HTTP,
user/grant lookup and active-company setup are fixture collaborators; this is
not a production OAuth or live-source certification. Existing report-runner and
MCP transport suites are run separately.

## This draft: containment and explicit consent

New accounts start paused. Existing successful explicit datasets are enabled
once on migration apply; a replay does not undo pauses. Only sources with an
explicit dataset definition can sync. Unknown sources do not fetch or store any
rows even if their boolean consent is forced true. Account identity, required
object identity, exact real calendar dates and unique report grain are checked
before core/hunted merging. Invalid windows do not advance history. Earlier
successful windows/datasets can remain committed. Pause applies to subsequent
runs, not cancellation of a run already admitted.

This is deliberately a guard, not an implementation of generic storage or the
LLM publication control. It prevents the proven loss while leaving known
working flows and existing stored data intact.

## Next draft: lossless storage and explicit publication

A source adapter must produce a reviewed, versioned dataset contract from actual
source metadata. The user chooses recognizable dataset/field names in a picker;
no vendor IDs or arbitrary column-name text boxes. Do not infer keys from names,
from the first row, or from `date`/`account_id` merely existing in a public catalog.
Each contract needs:

1. Ownership: exact Windsor selector equality or an independently verified set
   of resource IDs, scoped to the linked account and company. One-to-many bindings
   must be stored and verified explicitly; no cross-tenant name matching.
2. Schema: field IDs, readable labels, types, nullable fields, retained text and
   dimensions, schema version/fingerprint and an explicit policy for drift.
3. Grain: dataset/report identity plus a stable composite source row key, or
   complete snapshot semantics for sources without a key. Dates are optional for
   snapshots; never fabricate a day or aggregate arbitrary rows into daily facts.
4. Completeness: pagination, continuation, truncation and error semantics. Stage
   every page of a snapshot and atomically publish only a fully validated version.
   Never advertise an incomplete page as a full dataset or advance its cursor.
5. Retry: idempotency by tenant/connection/dataset/version/source key; preserve
   repeated rows where the source has meaningful multiplicity. No hashing only
   metrics, no last-write-wins collapse of ambiguous dimensions.

Use separate private staging and approved published data. Staging preserves full
selected row values (including text) and provenance, is service-only, and is not
in the AI catalog. Published records carry company, connection, dataset, version,
row identity and source values; projection metadata carries readable fields.
An admin must separately approve publication for that connection/dataset.
Existing `data:read` is necessary but not sufficient: reads must also satisfy
publication and grant-company predicates. Revocation must hide already-published
records at read time, without deleting source data or widening an OAuth grant.
Only the approved projection is discoverable to MCP, never staging, tokens or
connection secrets. Do not enable guided reporting globally; later deliberate
saved reports can use an approved projection through existing report permissions.

Tests for that draft must cover two tenants with identical source row IDs,
multiple objects per date, keyless snapshot duplicates, text/null/type fidelity,
late pages, pagination loops, schema drift, failed atomic publication, retries,
publication revocation, stale OAuth scopes and reports-only vs data:read access.
The complete synthetic journey must include connect attribution, staging,
publication, MCP discovery/query and denial paths. Do not claim those tests from
this PR's narrower fixed-report test.

## Evidence required before enabling another source

No spreadsheet contents were accessed. Sheets is disconnected and must not be
reconnected as part of this draft. No current verified source-specific schema,
pagination contract or selector/resource binding exists for Sheets or YouTube.
Public connector metadata alone does not establish these facts. The YouTube
selector mismatch remains unresolved. Actual source-owner authorization and a
separately approved scoped validation are required to collect that evidence.
The next adapter is blocked on those facts, not on a need to weaken isolation.

Blake owns deployment/migration approval and the choice to authorize a real
source validation. Retention and which datasets/fields to publish need explicit
product choices before exposing generic rows to LLM clients. Until then no new
source or projection is enabled. This draft makes no production changes.

## Open product choice: live MCP queries instead of storing source data

Blake subsequently asked whether MCP requires persistence. It does not. The
lossless-storage design above is an option, not an approved requirement for all
non-pillar connectors. Do not build it until the live/stored/hybrid choice is made.
The current safety draft is useful under any of these choices.

A live path would add a separately authorized MCP read operation that calls the
Windsor broker's source-read logic on demand. It cannot reuse the existing
admin-only browser preview endpoint by impersonating a user or bypassing its
integration-token rejection. Existing MCP has no service role and only database
RPC calls; a controlled external-query path needs an explicit design/review.

Authorization must resolve the live OAuth grant, scopes, person and bound company
on each call, then require that company's explicitly published connection/dataset.
Never let a request choose an owner key, source URL, company ID or arbitrary
unowned account. Source selection and requested fields come from that approved
connection and discovered schema. Fetch only the selected account, verify every
returned identity against an established selector/resource binding, and fail the
whole response if identity cannot be proven. A user-supplied filter is not proof.
A reports-only grant must not gain live-source access. Whether `data:read` plus
explicit per-connection publication is adequate or a separate consented scope is
needed is a product/security decision; existing frozen grants must not silently
expand. Revocation must apply on every request, not only when connecting.

Keep text and source dimensions intact in the live response. Require bounded
field sets, read-only operations, timeout, row/page/call limits, continuation and
honest truncation markers. Do not run arbitrary connector URLs or SQL against a
source. Return provenance (source, account label, requested period, fetched-at,
completeness); no credentials, access tokens or unrelated rows in responses/logs.
The YouTube identity mismatch blocks a live path just as it blocks stored sync.
Source responses are data, not instructions for the LLM.

| Mode | Benefits | Costs and limits |
| --- | --- | --- |
| Live only | Fresh source response; no durable copy of operational rows in SILO | Windsor/source latency, availability and quota affect each answer; historical responses may restate; repeated questions repeat calls; joins across systems are harder |
| Stored | Repeatable queries, historical snapshots, joins, predictable report/MCP response times | Sync/storage costs, lag, retention decisions, full schema/grain/completeness contracts |
| Hybrid | Live for exploration, explicitly retained snapshots for recurring needs | More policy/state to explain; caches must be tenant/connection/dataset/field/filter scoped, expire, and honor revocation |

Even live-only needs connection/grant metadata, source capabilities and safe
operational audit metadata; it need not persist result rows. Transient buffers
are still needed to validate a whole bounded response before releasing any row.
Do not silently add a result cache or retain prompts/raw payloads. Actual source
pagination, rate limits, latency and available fields have not been measured here.
No live MCP tool, new scope, source-data read, storage pipeline or publication
control is implemented/enabled in this draft. Await Blake's mode/consent decision
before choosing that follow-up implementation.

Windsor's [official MCP overview](https://windsor.ai/introducing-windsor-mcp/)
confirms that one connection reaches all sources/accounts in its Windsor account,
and that supported platforms expose write actions. It also describes on-demand
fetches with a short-term vendor cache. Consequently, SILO must never hand its
shared Windsor MCP connection or owner credentials to tenant clients. Naming a
client in a prompt is not authorization. A live SILO connector must expose only a
server-owned allowlist of read operations; neither tool annotations nor a prompt
asking the model to avoid writes is an enforcement boundary. Live-only here means
no durable SILO result store, not a claim that Windsor itself never caches data.

Confirmed boundary requirement: the live read path must resolve the MCP grant's
company (not the user's currently selected browser company), use that identity
for an RLS-backed connection lookup, enforce the stored account selector, then
validate the entire external response. RLS on the connection row alone cannot
filter Windsor's HTTP response. Adversarial acceptance tests must supply another
company's connection/account IDs, malicious company/source parameters, mixed and
missing response identities, revoked grants, and write-tool requests. Each must
return no source rows; a preauthorization failure must make zero Windsor calls.
Only the returned-identity checks and existing broker/MCP boundaries have tests
in this safety draft; a future combined live-MCP path still needs its own real
wiring tests before enablement.
