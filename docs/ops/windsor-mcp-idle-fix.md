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
