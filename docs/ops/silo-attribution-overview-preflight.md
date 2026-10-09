# Attribution overview preflight

Base: 878cf8a2c41ccfef405bd83196ac98ff8336bafc. Fresh task checkout.

Call path: silo-attribution.html -> silo-attribution-page.js -> mountReport/loadRows
in silo-attribution-report.js. The sync also imports silo-attribution-model.js;
its published allocation semantics will not change. The old visuals remain
available behind disclosure. New analysis consumes reconciled unique orders and
tenant/store-scoped evidence, with exact fetched_at matching. It never republishes.

Inputs: active company, authorized store, inclusive sales dates, 7/14/30/60-day
lookback, captured timestamps and published allocation. Reject stale evidence,
duplicates, wrong identities and changed filters; pending/missing/unpaginated or
invalid chronology is explicitly excluded from timing and modeled allocations.
Ledger cents remain allocated to baseline for excluded orders. A longer lookback
does not create history. Refund days are not separate journeys.

Task path: user reviews a suggestion, selects owner and review date, explicitly
saves a private evergreen launch_tasks review task. Deterministic UUID scoped to
company/store/dates/window/suggestion/user prevents click/retry duplicates using
the existing primary key. Insert-only; duplicate recovery reads the existing task
without overwriting edits. No ad-platform or business-data writes during testing.
No destructive operations, schema changes or paid AI calls.

Live preflight uses catalog-only pg_policy/grant queries for attribution reads,
launch_tasks and membership/profile owner reads. Tests use synthetic data only.
Test plan: chronology/repeated touches; direct/internal/unknown sources; pending,
stale and missing evidence; per-order signed cents conservation; role overlap;
tenant/store/filter switches; duplicate and concurrent draft saves; integrated
desktop/mobile browser interaction, keyboard/dialog behavior and empty states;
focused attribution and aggregate v2 suites, followed by independent review.

Reference image: approved Library id libfile_96a1e339e1a88191b1e76e2ec30a911f.
Materialization returned authorized transfers but the required helper downloaded
no bytes (HTTP 403 on two fresh attempts). Pixels unavailable; use the supplied
concept description and existing Beacon styling, and report this limitation.

## Verification record (2026-10-09)

- Live catalog-only checks confirmed active-company attribution SELECT policies,
  private creator/assignee task SELECT, active-company task INSERT, authenticated
  task SELECT/INSERT and report RPC EXECUTE. Membership IDs reference auth.users,
  so owners are loaded by explicit membership IDs, not an assumed profile FK.
- Live launch_tasks triggers: company/creator timestamps and initiative linkage;
  no outbound notification trigger was present. No production writes were run.
- Existing attribution evidence/probe/coverage/database/model/report/access/nav
  tests passed. Database fixtures confirmed atomicity, tenant RLS and grants.
- New six-case overview suite passed: signed cents, repeats, coverage, historical
  mapping, scope, concurrent task retries and stale-context zero-write behavior.
- All 33 aggregate v2 unit suites passed. Initial Windows CRLF-sensitive failures
  disappeared with LF checkout normalization; no unrelated source fixes included.
- Real page and SILO shell browser test passed at 1440x1050 and 390x844, with
  network-blocked synthetic DB fixtures: dialogs, evidence links, draft retries,
  invalid model input, tabs, filter invalidation, stale evidence and empty report.
- Independent reviewer found markup and historical-mapping issues; both fixed.
  Final review reported no blocking finding and independently ran 3,540 signed
  allocation cases plus stale-context zero-insert check.
- Mutation tests caught deliberately broken cent remainder and mapping guards;
  original code restored. Modified CI YAML parsed successfully.
- Screenshot PNGs were visually inspected. Library upload helper reported
  `Library prepare_uploads is not available`; local files remain the deliverable.

No schema migrations, edge deploys, credentials, scheduler changes or production
data changes are included. Live authenticated rendering and task creation remain
an acceptance check after Blake chooses to merge; local tests never used real data.
