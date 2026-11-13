# Meta initial imports

This change uses Integration Bootstrap's existing queue and sync executors. After selecting an ad account, Integrations requests an immediate GitHub worker. The browser may close after the request. GitHub dispatch acceptance is not proof the worker started; the queue's recorded stages are the progress authority.

The Meta plan is:
1. Recent campaign and ad rows (3 days, no organic).
2. Campaign/ad history (365 days), creatives and configured organic history.

A missing ad-level result cannot mark either stage complete. Completed stages are not repeated on recovery. A temporary failure returns the job to pending; the existing 15-minute bootstrap schedule retries it, subject to GitHub schedule delays and the existing five-attempt ceiling. Full ad-platform schedules remain a recovery fallback. This is not a promise of zero queue latency or instant provider history.

“Refresh campaign totals” remains a short interactive action; it does not complete the ad-history import. The status banner polls recorded stage progress while the page is visible. There is no fabricated percentage or ETA.

## Release prerequisites (not applied by this PR)

- Apply `20261113220322_immediate_meta_import_leases.sql` before merging or deploying this code: GitHub schedules read the new workers from `main` after merge. Native Meta fails closed if its lease RPCs are absent; other ad platforms retain their existing behavior. This PR is draft until release ordering is arranged.
- Deploy `integration-bootstrap-wake` and the changed `ad-platform-sync-run`.
- Set server-only `INTEGRATION_BOOTSTRAP_GITHUB_TOKEN` on the wake function: repository-scoped GitHub credential authorized only to dispatch Actions on BBISMblockay/financehub. Never put it in the browser, source or logs. No credential is created by this PR.
- The dispatch target is fixed to `integration-bootstrap.yml` on `main`; the caller cannot supply arbitrary workflows or branches. Caller auth, active-company RLS and the admin gate precede service access. A durable reservation throttles duplicate wake requests.
- A missing/failed dispatch leaves the durable job queued and shows a fallback message. The periodic worker remains necessary.

## Verification after release

Connect a test Meta ad account, choose it, then leave the page. Verify a scoped worker starts without waiting for cron; recent_data and history complete separately; pending/error status remains truthful after an injected ad-level failure. Confirm repeated clicks and a simultaneous scheduled run do not acquire the same connection lease. Check ad rows against campaign coverage and provider results. Test inactive, sync-off, cross-tenant, non-admin and expired-session refusal. No production sync or provider call was run while developing this change.
