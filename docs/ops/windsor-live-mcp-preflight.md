# Live Windsor MCP preflight

Product: one SILO MCP connection in a compatible AI client, with explicitly
published company connectors queried on demand. No separate Windsor key/MCP
installation and no durable source-row ingestion. Existing pillar reports and
stored data remain unchanged. This is a follow-up draft after the merged sync-safety
PR; no production mutation, deployment or source-data read is authorized here.

New tools: list_connections, describe_connection, query_connection. All use
caller-token PostgREST first. SQL requires a live integration grant, data:read,
the grant-bound active company, an explicit per-account mcp_enabled flag and
RLS. Resolver owner silo_api_exec is neither superuser nor BYPASSRLS (verified
live); it owns no source table. Policies/grants are inspected from production.
External reads follow only server-owned Windsor GET URLs with the stored source
and account. Every returned row must match account identity; no prompt filter,
first row or account name establishes ownership. Recheck authorization after
external fetch and before releasing results to handle revocation in flight.

Input surface is bounded UUID connection IDs, discovered field IDs and supported
date presets. Reject unknown arguments, arbitrary URL/source/company/account
inputs and write tool requests. Bound bytes, time, fields, rows and metadata;
report truncation honestly. Preserve raw selected text/dimensions without
aggregation, deduplication or cursor advancement. No result cache or durable rows.
No selector/resource binding inference: unsupported identity still blocks access.

Company admins explicitly publish/unpublish accounts via the existing broker's
user/MFA/integration/company/admin gates. All existing/new connections default
unpublished; no backfill. Publishing informs the admin that approved data:read
SILO AI connections in that company can use it. Reports-only grants remain
insufficient. Existing OAuth/client discovery is reused, not replaced.

Partial failure: failed metadata/data fetch or mixed/missing identity releases
no source rows. Failed post-fetch reauthorization releases no result. SQL and
external HTTP reads are not one transaction; recheck narrows the race but a
revocation immediately after the final check cannot retroactively erase a response.
No writes to source systems, no stored result rows, no scheduler involvement.

Tests: full handler -> scoped SQL resolver fixtures -> synthetic external reads;
real PostgreSQL policies/grants/functions with two companies, a different browser
company, revoked grants, reports-only scope and unpublished connections; malicious
IDs/arguments, mixed/missing identities, response limits, read-only method/path,
revoke-during-fetch, keys/logs, text fidelity; real page publication UI with mocks.
Existing MCP/OAuth, broker, unit and applicable aggregate suites must remain green.
Actual client registration/discovery and live source identity need authorized
post-deploy validation; do not claim universal AI-client support.
