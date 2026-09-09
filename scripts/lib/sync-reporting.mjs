// scripts/lib/sync-reporting.mjs — how a sync run describes itself.
//
// WHY THIS IS A MODULE AND NOT AN INLINE CLOSURE.
//
// It was an inline closure in shopify-sync.mjs, and it carried a bug that CI
// could not see: the progress callback referenced `result`, the const whose
// own initializer it was being passed to.
//
//   const result = await runLandingPagesSync(supabase, connection, {
//     onProgress: ({ event }) => {
//       if (event === 'sweep_failed') console.warn(`... top ${result?.top_n} ...`);
//     },
//   });
//
// `result` is in its temporal dead zone for the entire call, and `?.` does not
// help -- optional chaining guards null and undefined, not an unreachable
// binding. So the first sweep failure threw
// `ReferenceError: Cannot access 'result' before initialization`.
//
// And it threw INSIDE the day loop's try block, so the damage was not a lost
// warning: it was caught by the per-day handler, recorded as that day's
// failure, and broke the loop -- one failed sweep aborted every remaining day
// of the backfill and reported the run as failed, attributed to a message
// about variable initialization. A non-fatal warning path turned into the
// exact silent-truncation shape this whole change set exists to remove.
//
// The tests covered runLandingPagesSync thoroughly and never once ran the
// orchestrator's real callback. So the callback lives here, exported, and the
// tests drive it with the real payloads. Anything the orchestrator formats
// from a result belongs here for the same reason.

/** Build the progress callback for a landing-page sync.
 *
 * Everything it needs arrives IN THE PAYLOAD. It closes over nothing that is
 * still being computed -- that is the property that was violated, and keeping
 * the function pure over its arguments is what makes it impossible to violate
 * again rather than merely fixed once.
 */
export function landingPagesProgress({ shopDomain, log = console.log, warn = console.warn } = {}) {
  return function onProgress(event = {}) {
    const { day, event: kind, attempt, waitMs, error, topN } = event;
    if (kind === 'throttled') {
      log(`[wait] ${shopDomain} landing_pages_sync ${day}: throttled, attempt ${attempt}, backing off ${waitMs}ms`);
      return;
    }
    if (kind === 'sweep_failed') {
      // topN comes from the payload, not from the pending result.
      warn(
        `[warn] ${shopDomain} landing_pages_sync ${day}: fresh rows written but stale-path ` +
        `sweep FAILED (${error}) — paths that dropped out of this day's top ${topN ?? 'N'} remain`,
      );
    }
    // 'written' is deliberately not logged: one line per day is 730 lines of
    // nothing on a backfill. The coverage summary reports it in one line.
  };
}

/** One line describing what a landing-page run actually covered.
 *
 * Reads only fields that exist on a returned result, so a partial run and a
 * complete one format the same way and neither can accidentally read as the
 * other.
 */
export function landingPagesCoverage(result = {}) {
  return `${result.days_covered}/${result.days_requested} days covered`
    + (result.days_already_covered
      ? ` (${result.days_written} fetched now, ${result.days_already_covered} already stored)`
      : '')
    + (result.earliest_day_covered ? ` ${result.earliest_day_covered} → ${result.latest_day_covered}` : '')
    + `, ${result.rows_upserted} rows, ${result.distinct_paths} paths`
    + (result.stale_rows_removed ? `, ${result.stale_rows_removed} superseded row(s) removed` : '')
    + (result.days_not_swept ? `, ${result.days_not_swept} day(s) NOT swept` : '')
    + (result.days_hitting_top_n ? `, ${result.days_hitting_top_n} day(s) hit the top-${result.top_n} cap` : '')
    + (result.resume_unavailable ? `, resume unavailable (${result.resume_unavailable})` : '');
}
