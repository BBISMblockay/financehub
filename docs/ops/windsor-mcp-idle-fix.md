# Live MCP activity correction

Review of merged #1112 found that the live connection resolver omitted
`silo_api_touch_grant()`. The current grant resolver rejects connections idle
for 30 days, so successful live-only use did not keep its connection active.
The initial test fixture used the original pre-idle grant definition and missed
this behavior. Independent review reproduced it with the current SQL.

The forward migration `20261103220000_windsor_live_mcp_activity.sql` calls the
existing activity helper immediately after the integration/data:read scope gate,
matching existing data/report RPCs. The helper updates only the resolved usable
grant, at most once an hour; it cannot revive an idle/revoked/expired grant or
extend absolute expiry. No identity, RLS, account publication or source access
rules change. No source rows are stored. This correction needs SQL application
after the original live MCP migration; it needs no additional Edge deployment.

Preflight/verification: the real handler/database fixture now loads the shipped
idle-window, grant and touch function bodies from the idle-disconnect migration,
including the helper's executor-only permission. Test all three live tools near
the idle threshold, same-hour throttling, fixed absolute expiry, idle/never-used
refusal without external calls or activity changes, and failed-scope non-touch.
Mutations removing either the activity call or idle predicate must fail. Existing
cross-company, identity and revocation checks remain in the same suite.

This is a draft follow-up to a merged PR, not an amendment of applied history.
No SQL was applied or production settings changed. Release owner must apply the
forward migration after review and verify live grant activity with an authorized
client. General live MCP activation gates from windsor-mcp-connectors.md remain.

RLS caveat verified in the fixture: PostgreSQL ORs the new permissive SELECT
policy with the existing company-admin policy. An admin executor can therefore
read its own unpublished mapping directly (but not another company's mapping).
The integration role has no direct SELECT grant; the resolver's explicit
company/publication predicates independently refuse unpublished IDs and omit
them from lists, before any source call. Both admin and non-admin cases are
tested. This fix does not claim that RLS alone enforces publication, and does
not narrow the existing admin UI's legitimate mapping visibility.

## Drift verifier correction

Deployment drift run 41714798210 (main 727ef664) reported two stale schema
assertions: the integration RPC allowlist lacked the new resolver, and the broker
check required exactly one SELECT policy. Integration-reconcile run 41715144916
is separate and is not evidence of this Windsor drift.

The verifier now admits only the exact resolver signature for silo_integration,
not an overload or a silo_revoked grant. It requires the existing company-admin
policy and permits only the exact additional company/publication executor SELECT
policy; extra policies, wrong roles, missing predicates and wider access fail.
The separate live-MCP check still requires the new policy's installation. Tests
execute the changed predicates/whole broker check and deliberately introduce
invalid grants and policies; the pre-MCP broker fixture remains supported.

This is a verifier correction, not a schema reapplication. The same drift run
also found old mcp handler/index and windsor-broker handler deployments; that is
real source drift and remains a separately authorized deployment step. Do not
reapply all migrations to address either symptom.
