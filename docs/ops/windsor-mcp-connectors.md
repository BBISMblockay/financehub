# Windsor LLM / MCP connectors

## Product boundary

Pillar integrations continue feeding SILO reporting. Non-pillar connectors can
be queried live through one SILO MCP connection in a compatible AI client. No
separate Windsor key or per-source MCP installation is given to the customer.
Existing stored data, sync contracts and reports remain intact. This does not
make arbitrary sources reportable or implement a universal importer.

The existing URL-only `/v2/windsor-test.html` management page supplies searchable
integration/field pickers and explicit **Allow LLM access** / **Disable LLM
access** controls. It remains a rollout/testing surface, not a new navigation
section. Connecting an account, enabling stored sync and publishing LLM access
are separate decisions. Every existing/new account starts unpublished.
Publishing authorizes that company's approved `data:read` SILO AI connections;
`reports:read` alone is insufficient. Admin confirmation is required in the UI.

## Implemented live path (draft; not activated by this PR)

`list_connections`, `describe_connection` and `query_connection` run through the
existing MCP handler. The caller's token invokes `silo_api_windsor_connections`:
existing signature verification, live grant, session, membership, assurance and
scope checks precede any source request. The company is the live grant company,
not a browser selection or client-supplied company. The non-owner/non-BYPASSRLS
`silo_api_exec` resolver uses company RLS and explicit publication predicates.
Integration clients gain no direct table access or publication write permission.

The server chooses the stored connector and account, discovers offered fields,
and performs only fixed-host Windsor GET requests. Unknown arguments, arbitrary
URLs, source/account overrides and write tools are rejected. Every returned row
must carry a matching `account_id`, including rows beyond the display limit.
Missing/mixed/foreign identities fail the entire response. Authorization and
binding are checked again before release. A revocation after that final check
cannot retroactively erase an already released response.

Selected raw rows preserve multiplicity and text; no account/day aggregation,
deduplication, source-row storage, cache, sync cursor or history advancement is
involved. Connection and authorization metadata still live in SILO. Limits:
29 requested fields (plus identity), 200 returned rows, 24,000 row characters,
16 MiB per upstream response, 20 seconds per upstream request, date presets of
7/14/30 days or an explicit range of at most 800 days. A query makes metadata and data requests; latency can approach
40 seconds plus authorization calls. Metadata lists page at 100 items.
Responses identify source, fields, period, fetch time and truncation. They are
bounded exploratory answers, **not certified complete datasets or totals**.
There is no upstream pagination or completeness contract in this implementation.
Generic rollups (`day`, `week`, `month`, `total`) now fail closed with a readable
error. Numeric types do not establish additivity or row grain, so no generic
source has an approved summation contract. Use `rollup: "none"`; this does not
change the direct pillars or existing stored reporting. Responses explicitly
carry `completeness_status: "unverified"`; empty responses contain no synthetic
zero rows and explain that the cause (history, range, compatibility) is unknown.
Field discovery exposes report groups as hints, not compatibility guarantees.
Text-only sources get suggested text fields; the picker can filter by report
group and warns when selected fields span groups.

A row too large to return intact fails rather than silently losing text.

A source in the picker is not proof that its returned identity equals the stored
selector. The YouTube `71274` mismatch remains unresolved and blocked. Sources
without verifiable `account_id` remain unavailable. No names, first-row guesses
or unverified one-to-many bindings establish ownership. Actual source schemas,
latency, quotas and pagination require authorized live validation.

Windsor's [MCP overview](https://windsor.ai/introducing-windsor-mcp/) describes
account-wide access and write actions. SILO therefore does not proxy or expose
that shared MCP or its credentials. Tool read-only annotations are advisory;
fixed server URLs/methods and strict inputs enforce read-only behavior. Source
text is untrusted data. No vendor errors, credentials or raw transport URLs are
returned. No durable SILO storage does not imply Windsor has no vendor cache.

## Client compatibility and reporting

This reuses SILO's existing remote MCP transport, OAuth discovery and grant
lifecycle; there is no Claude-specific branch or new OAuth scope. Clients must
support that remote MCP/OAuth flow and request `data:read`. Older reports-only
connections need renewed consent. Synthetic transport tests are not proof that
every AI client supports registration/discovery; real client sign-in remains a
post-deploy acceptance step. Do not advertise universal client compatibility.

Existing MCP `query`, report tools and fact-table permissions remain unchanged.
Connection plumbing (`windsor_links`, `windsor_linked_accounts`) is hidden from
the general AI schema catalog; only the scoped resolver advertises published
accounts. This deliberately prevents generic SQL discovery of private connection
metadata. Windsor daily facts were already catalog-visible but not reportable;
this PR does not flip reportable flags or create reports. Stored/hybrid snapshots
may be a later explicit product choice for repeatable history, joins or totals.
Live reads instead depend on source availability, freshness, quotas and latency.

## Verification and activation

`windsor-live-mcp-database.test.mjs` drives the real MCP handler through real
PostgreSQL grant/RLS/resolver functions into synthetic Windsor responses. JWT
signature verification is mocked at the PostgREST boundary; production uses
PostgREST. It covers two companies, spoofed company claims, scope/session/MFA/
membership denial, unpublished accounts, identity failures, revocation during
fetch, limits, text and row grain, plus mutation checks. Broker and browser
fixtures cover publication confirmation, failure/retry and disabling. No live
customer source data was read to validate this feature.

After review/merge, activation requires separate authorization:

1. Apply `20261103210000_windsor_live_mcp.sql` and verify its effects/ACLs. It
   defaults all publication off and never backfills it on replay.
2. Deploy `mcp` and `windsor-broker` from the reviewed commit, including their
   bundled modules. The MCP function now needs the server-side Windsor key.
   No migration or function deployment was performed by this draft work.
3. Verify one compatible client with a company-scoped `data:read` grant, then
   explicitly publish a verified source and exercise authorized read-only
   metadata/query/revocation checks. Do not publish YouTube until its identity
   mismatch has a separately verified resolution.

Apply the migration before the UI/function rollout. If the new column is absent,
the UI retains existing connection/preview behavior and disables publication;
the new RPC tools fail closed. Rollback can unpublish accounts and restore prior
functions without deleting stored facts. Disabling publication affects future
and in-flight reads at the reauthorization check, not data already delivered.

Safety PR #1110 merged as `8d00e31520e8a6bd5421ad94f59964444d8afe7d`.
Read-only inspection after Blake ran SQL found the sync-consent column/default
and expected backfill present, despite no migration-history record. Baseballism
Klaviyo/TikTok remained enabled; BlockayOps YouTube disabled and Sheets absent.
At that inspection broker version 5 still lacked `set_sync`; a separate broker
deploy was needed. The live MCP migration/publication column was not applied.
These are time-specific observations, not deployment completion claims.
