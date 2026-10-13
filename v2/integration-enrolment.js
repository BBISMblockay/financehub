/* v2/integration-enrolment.js -- is this connection enrolled, paused, or
 * stranded?
 *
 * The Integrations page had no answer to that question. `retest()` gated the
 * first-connect enable-and-enqueue on `!sync_enabled && !last_test_success`,
 * and `last_test_success` LATCHES true on the first successful test, so the
 * branch became unreachable for all time the moment a store tested OK. Every
 * connection made before first-connect auto sync shipped (PR #958,
 * 2026-10-13) is in that class: pressing Re-test on it can never switch its
 * sync on or queue an import. Live at audit time, 2026-10-13:
 * suticompany.myshopify.com had tested OK on 2026-10-08, had never run a
 * single sync_jobs row, and had ZERO rows in sales_by_day -- and the page
 * counted it as "Connected".
 *
 * The hard part is not finding those stores. It is telling them apart from
 * the ones somebody switched off ON PURPOSE: baseballismchicago and
 * baseballismdsg are also `sync_enabled = false` with `last_test_success =
 * true`, and they have ~1,500 sync_jobs rows each, up to 2026-09-20. Turning
 * those back on would re-import two stores nobody asked for. So:
 *
 *   EVIDENCE, NEVER INFERENCE. "Has this connection ever run a sync job"
 *   separates intent from accident perfectly on live data; the test flag does
 *   not. A connection we cannot prove is fresh is treated as paused, and the
 *   page offers no enrolment button for it. Nothing here enables anything by
 *   itself: `never_imported` only means the page may OFFER the operator a
 *   button, and the operator presses it.
 *
 * Going forward the guesswork is unnecessary: switching a store off stamps
 * `meta.sync_paused_at`, which says "a person did this" without depending on
 * how long sync_jobs rows are kept. An old pause carries no stamp, hence the
 * sync_jobs evidence stays the primary signal rather than a migration step.
 */
(function () {
  /** What state is this connection in, for enrolment purposes?
   *
   * @param {object} connection      a shopify_connections row
   * @param {boolean|null} everSynced  has it EVER written a sync_jobs row?
   *        null means the probe did not answer (an error, or it was not run).
   *        Unknown must never read as "fresh": a store with 1,500 jobs whose
   *        probe failed would otherwise be labelled "never imported" and
   *        offered a Start button, which is the one mistake this file exists
   *        to prevent.
   * @returns {'not_tested'|'needs_attention'|'syncing'|'never_imported'|'paused'}
   */
  function enrolmentState(connection, everSynced) {
    const row = connection || {};
    if (row.last_test_status === 'error') return 'needs_attention';
    if (row.last_test_status !== 'ok') return 'not_tested';
    if (row.sync_enabled) return 'syncing';
    // An explicit pause outranks the evidence: a store somebody switched off
    // after one failed import would otherwise look fresh again.
    if (row.meta && row.meta.sync_paused_at) return 'paused';
    if (everSynced === false) return 'never_imported';
    return 'paused';
  }

  /** The one line the row shows, and whether it is worth the operator's eye. */
  function describeState(state) {
    switch (state) {
      case 'never_imported':
        return {
          tone: 'warn',
          label: 'Never imported',
          hint: 'Connected and tested, but nothing from this store has ever been imported. Start the first import to switch its nightly sync on and queue the history.',
          offerStart: true,
          attention: true,
        };
      case 'paused':
        return {
          tone: 'muted',
          label: 'Paused',
          hint: 'Nightly sync is off for this store. Its existing data stays as it is.',
          offerStart: false,
          attention: false,
        };
      case 'syncing':
        return { tone: 'ok', label: 'Syncing', hint: '', offerStart: false, attention: false };
      case 'needs_attention':
        return { tone: 'neg', label: 'Connection failed', hint: '', offerStart: false, attention: true };
      default:
        return { tone: 'muted', label: 'Not tested', hint: '', offerStart: false, attention: false };
    }
  }

  /** meta with a pause stamped on it, everything else left alone.
   *
   * Merged onto the meta as it stands rather than onto whatever the page
   * loaded, because a history import writes history_backfill to the same
   * column and this must not roll it back.
   */
  function withPauseStamp(meta, { at = new Date().toISOString(), by = null } = {}) {
    const base = meta && typeof meta === 'object' ? meta : {};
    return { ...base, sync_paused_at: at, sync_paused_by: by };
  }

  /** meta with the pause cleared -- switching sync back on is un-pausing. */
  function withoutPauseStamp(meta) {
    const base = meta && typeof meta === 'object' ? meta : {};
    return { ...base, sync_paused_at: null, sync_paused_by: null };
  }

  /** Which connections is it worth probing sync_jobs for?
   *
   * Only the ones whose state could still turn out to be `never_imported`:
   * a store that is syncing, failed its test, or carries a pause stamp has
   * its answer already, and probing it would be a query per row per page
   * load for nothing.
   */
  function needsEvidence(connection) {
    const row = connection || {};
    return row.last_test_status === 'ok'
      && !row.sync_enabled
      && !(row.meta && row.meta.sync_paused_at);
  }

  /** Does this bootstrap job mean an import is actually coming?
   *
   * Only `pending` and `running` do. The queue keeps `done`, `partial`,
   * `error` and `cancelled` rows as the record of what was imported, and the
   * unique index that stops a duplicate covers the open states ONLY -- so a
   * terminal row blocks nothing and claims nothing. Treating one as "already
   * queued" would tell the operator an import exists when the queue holds a
   * job that will never run again, which is precisely the state a store
   * whose first job was cancelled before it ran is in.
   */
  function jobCountsAsQueued(job) {
    return job ? job.status === 'pending' || job.status === 'running' : false;
  }

  /** Job types in sync_jobs that are not evidence of an IMPORT.
   *
   * A connection test writes a sync_jobs row and imports nothing;
   * scripts/lib/integration-bootstrap-runner.mjs excludes it from the same
   * question for the same reason. A legacy store whose only row is a
   * successful test is stranded, not synced.
   */
  const NON_IMPORT_JOB_TYPES = ['test_connection'];

  window.SiloEnrolment = {
    jobCountsAsQueued, NON_IMPORT_JOB_TYPES,
    enrolmentState, describeState, withPauseStamp, withoutPauseStamp, needsEvidence,
  };
})();
