# Report management

## Scope and behavior

The Reports library separates creator ownership from visibility:

- My Reports: your active private and company-shared reports
- Company Reports: all active company-shared reports, including yours; creator shown
- Archived: your archived reports, with Restore
- SILO Reports and Dashboards retain their existing meaning

Archive hides a report from active libraries, Ask SILO's saved-answer modal and
new-widget pickers. It does not delete the report, change sharing, change queries
or answers, remove widgets, or revoke authorized reads. Existing dashboards keep
working. Restore returns the same report with its original visibility.

Before archive, the dialog lists the dashboards the caller may read. The existing
usage counter also counts colleagues' private dashboards; those appear as a count,
never private names or ids. Failed dependency lookup blocks confirmation and offers
Retry. Repeated mutation clicks are locked, and RPC retries are idempotent.

Only the report creator in the active company can archive/restore. The existing
exec/owner content-edit permissions do not grant cleanup authority over colleagues'
reports. A table trigger protects direct PATCH as well as the RPC and prevents
reassignment of creator/company as an ownership bypass. System reports stay protected.
No new hard-delete affordance is introduced; Ask SILO's old Delete is replaced by a
Manage reports link.

Standard-profile workspaces retain their default Dashboard-only navigation. The
explicit Manage reports link (`?manage=reports&tab=mine`) exposes organization of
already-readable reports without adding SILO catalog or report-authoring navigation.

## Preflight and verification boundaries

Read all saved-report view call sites: Reports library, Ask SILO saved-answer list,
Add insight picker, add-report handoff, report preview, and widget query changes.
Only lists/pickers filter archive state; existing report and widget reads do not.

A read-only production schema audit on 2026-09-30 found `archived_at` already present
and an unrecorded `WHERE archived_at IS NULL` in the saved-report view. The migration
preserves stored timestamps and recreates the invoker view without this list-only
filter. Policies, constraints, triggers, grants, and active-membership helpers were
read from the live catalog before implementation. No production records were changed.

Tests defined before implementation:

- Owner private/shared archive and restore; colleague/admin denial; tenant, inactive,
  missing membership and system denial; direct PATCH ownership-reassignment denial
- Repeat archive/restore preserving original timestamp and report/widget contents
- Readable dependency names, hidden-board counts, escaped text, no private names
- Scope lists and counts, pagination beyond one API page, search/tab URL state
- Failed/thrown RPC, missing usage, retry, duplicate clicks, cancel/late responses
- Archived picker omission and continued execution of existing widget SQL
- Phone width, long titles, focus trapping/return; existing report edit/preview/save

Local execution uses fixture data only. Browser suites require Chromium; a shell
browser launch restriction must be reported as not run, never as a passing suite.

## Publication blockers

This draft intentionally leaves the two existing aggregate SQL files unchanged
because their publication was blocked. Do not merge until a reviewer integrates:

1. `\i migrations/20260930203350_saved_report_archive.sql` into
   `supabase/apply_all_post_merge.sql`, before the mandatory final catalog cleanup
2. The two checks from `supabase/verify_saved_report_archive.sql` into
   `supabase/verify_v2_schema.sql`, above the Plaid fixture marker

The archive database suite executes the standalone verification now. Its final
apply-all integration assertion intentionally remains failing until item 1 is
resolved, after all 31 database behavior/verification checks have run.

## Rollout

1. Review and merge separately from applying the database migration
2. Apply the saved-report-archive migration in the same release as the frontend
3. Run `supabase/verify_v2_schema.sql` and `supabase/verify_saved_report_archive.sql`; all checks must be `ok`
4. Confirm own private and own shared archive/restore with test reports, and a
   dashboard using one of those reports still renders after archive
5. Confirm another user's company report has no archive action

The new frontend requires the updated view and RPCs. Before the migration is applied,
report-list reads/actions can show a missing-column/function error. Applying the
migration before the frontend briefly allows older unfiltered clients to discover
archived rows; it never changes dashboard/report data or their access policies.
No edge-function deployment, secrets, production archive batch, or merge is part of
this implementation task. Post-merge schema drift remains expected until applied.

## Checks

- `node v3/tests/run.js --unit`
- `node v3/tests/run.js --browser`
- `node v2/tests/run.js --unit`
- `node scripts/tests/saved-report-archive-database.test.mjs`
- `node scripts/tests/plaid-bank-feed-database.test.mjs` (schema-verifier regression)
