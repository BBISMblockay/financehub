# Workspace module menu visibility

Local implementation scope: an owner_admin or admin of the active company can
toggle menu groups in Workspace Settings → Silo Modules. Existing links, pages,
permissions, integrations and billing remain unchanged. Missing settings mean on.

Preflight (2026-11-04): navigation callers are silo-chrome's sidebar and command
palette, finance.html's home links, and navigation tests. Workspace settings uses
WORKSPACE_SETTINGS_PAGES and its shared tab renderer. No workflow or edge function
calls these navigation functions. The new table is independent of operating data.
Live read-only inspection confirmed active_company_id, is_active_user,
is_entity_member and is_entity_admin (owner_admin/admin membership in the supplied
company), membership SELECT policies and the company stamp trigger. No existing
policy or grant is changed. New policies require active company, active user and
membership; writes additionally require company admin. No global role fallback.

Tests planned before implementation: defaults and malformed/missing/error reads;
each group and all groups off; preservation of role/department/grant/company gates;
late loads after switching; per-toggle persistence and refused writes; owner/admin
versus member/viewer/nonmember/inactive/anonymous database cases; direct URLs
unchanged; settings tab and actual shell wiring. Mutate the company/admin/module
guards and prove the relevant tests fail.

Each toggle is one upsert of one (company, module) row, acknowledged only after a
returned matching row. Retry is idempotent; unrelated simultaneous toggles cannot
overwrite one another. Same-toggle concurrent writes are last committed write wins.
An uncertain save asks the person to reload before retrying. Reads fail open for
menu visibility; the settings page fails closed for editing. No destructive action.

Rollout dependency: review and apply the additive migration separately before user
enablement. The initial implementation was local only. Blake subsequently
authorized a draft PR and Steward review cycles; production SQL, merge and
deployment remain outside the authorized scope.
Real hosted authentication/PostgREST and multi-tab acceptance remain rollout gates;
local tests use synthetic identities and database fixtures.

Local verification results:
- 57 navigation/settings/Accounting/SEO/Ad Studio/attribution tests passed.
- 36 PostgreSQL assertions passed: actual migration policies and grants in PGlite,
  synthetic auth/company helper definitions matched to the live read-only inspection.
  Catalog refresh and stamp attachment are stubbed in this isolated fixture.
- 25 Chromium assertions passed through the actual settings page and sidebar,
  using synthetic Supabase transport: roles, toggles, persistence across page loads,
  direct URL, company-switch refusal, unavailable reads, denied/zero-row saves.
- Existing Chromium company-switch (15) and Home cards (19) assertions passed.
- Four mutations failed as required: module filter removed, stale response guard
  removed, admin write gate broadened, active-company policy removed.
- JavaScript syntax and git diff whitespace checks passed. No compiled frontend
  build exists; this app serves static HTML/JS.

Tooling: Supabase CLI migration creation was attempted but unavailable here (v3
writes a read-only home directory; v2 installation exits without a binary). The
migration filename uses the environment's UTC timestamp. The changelog fetch was
blocked by the network proxy; current official RLS documentation was consulted.

Next step: review the local diff and the migration. Before user enablement, the
release owner must authorize the migration/frontend release and verify with real
owner/admin/member accounts in two workspaces: save a switch, reload/new tab,
switch company, try a direct URL, and confirm original permissions still apply.
Hosted verification is pending, not denied; no production writes were attempted.
