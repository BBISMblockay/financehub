/* Landing-page backfill: throttles, partial progress, and honest reporting.
 *
 * These assert the five properties that GHA run #354 (2026-09-09) violated.
 * That run was dispatched as a 730-day landing-page backfill with
 * sessions_days=730 alongside skip_sessions=true, finished GREEN in two
 * minutes, and left both tables byte-identical:
 *
 *   1. Shopify refused with HTTP 200 and the rate limit inside the GraphQL
 *      `errors` array. fetchWithRetry only knows status codes, so nothing
 *      retried.
 *   2. ~100 days had been fetched successfully and were held in memory
 *      awaiting one upsert after the loop. The failure discarded all of them.
 *   3. The result reported no coverage figures at all, so a run that wrote
 *      nothing and a run that wrote everything printed the same shape.
 *   4. The sessions stage produced no record of any kind -- no job row, no
 *      log line -- despite a 730-day parameter having been supplied for it.
 *   5. The workflow reported success.
 *
 * Everything is stubbed: a fake global fetch and the in-memory fake Supabase.
 * No network, no database, no secrets.
 */

import assert from 'node:assert/strict';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import {
  runLandingPagesSync,
  isThrottleError,
  throttleWaitMs,
} from '../lib/shopify-sync-core.mjs';
import {
  buildSyncPlan,
  runOutcomeReport,
  shouldRecordSkippedJob,
} from '../lib/sync-plan.mjs';
import { landingPagesProgress, landingPagesCoverage } from '../lib/sync-reporting.mjs';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };

const CONNECTION = {
  id: 'conn-1',
  company_entity_id: 'co-1',
  shop_domain: 'baseballism.myshopify.com',
  access_token: 'shpat_test',
  api_version: '2025-01',
};

/** A Shopify GraphQL response, always HTTP 200 -- which is the whole point. */
function reply(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}

const okRows = (paths) => ({
  data: {
    shopifyqlQuery: {
      __typename: 'ShopifyqlQueryResponse',
      parseErrors: [],
      tableData: {
        columns: [{ name: 'landing_page_path' }, { name: 'sessions' }],
        rows: paths.map((p, i) => ({ landing_page_path: p, sessions: 100 - i })),
      },
    },
  },
});

// The literal message the live API returned on 2026-09-09. No error code, no
// cost metadata -- the analytics limiter, not the calculated-cost one.
const ANALYTICS_THROTTLE = { errors: [{ message: 'Rate limited. Please retry later.' }] };

// The calculated-cost limiter, which does tell you how long to wait.
const COST_THROTTLE = {
  errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
  extensions: {
    cost: {
      requestedQueryCost: 12,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 2, restoreRate: 1000 },
    },
  },
};

/** Install a fake global fetch driven by a per-call handler. Returns a restore fn. */
function stubFetch(handler) {
  const real = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => handler(call++);
  return () => { globalThis.fetch = real; };
}

// ── 1. A throttle arriving inside an HTTP 200 is recognised and retried ──────
{
  eq(isThrottleError(ANALYTICS_THROTTLE.errors), true,
    'the bare "Rate limited. Please retry later." message is a throttle');
  eq(isThrottleError(COST_THROTTLE.errors), true,
    'extensions.code THROTTLED is a throttle');
  eq(isThrottleError([{ message: 'Field \'landing_page_path\' doesn\'t exist' }]), false,
    'a schema error is NOT a throttle -- retrying it six times is the same error, slower');
  eq(isThrottleError([]), false, 'no errors is not a throttle');

  // The arithmetic: 12 requested against 2 available at 1000/sec is 10ms of
  // refill. Taken from Shopify's own numbers rather than guessed at.
  const waited = throttleWaitMs(COST_THROTTLE, { attempt: 0 });
  ok(waited > 250 && waited < 400, `cost metadata drives the wait (got ${waited}ms)`);

  // With no metadata there is nothing to compute from, so it backs off -- and
  // never instantly, which against a limiter that just refused you is how a
  // burst becomes a ban.
  const blind = throttleWaitMs(ANALYTICS_THROTTLE, { attempt: 0 });
  ok(blind >= 2000, `a metadata-free throttle backs off (got ${blind}ms)`);

  // A Retry-After header is used when there is no cost metadata.
  const header = throttleWaitMs(ANALYTICS_THROTTLE, { attempt: 0, retryAfterHeader: '3' });
  eq(header, 3000, 'Retry-After is honoured when Shopify offers no cost metadata');
}

// ── 1b. End to end: throttled 200, then success, and the day IS written ──────
{
  const supabase = createFakeSupabase();
  // Day 1 is throttled twice (using the cost-metadata form so the backoff is
  // milliseconds, not seconds) and then succeeds.
  const restore = stubFetch((i) => reply(i < 2 ? COST_THROTTLE : okRows(['/collections/tees'])));
  const result = await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 1, batchId: 'b1' });
  restore();

  eq(result.complete, true, 'a run that recovered from a throttle is complete');
  eq(result.days_written, 1, 'the throttled day was written once it succeeded');
  eq(result.throttle_waits, 2, 'both backoffs are reported');
  eq(supabase.rows('shopify_landing_pages_daily').length, 1,
    'the row reached the table -- before the fix this whole run threw');
}

// ── 2. Progress survives a mid-run failure ──────────────────────────────────
// The exact shape of #354: N days succeed, then the limiter refuses and keeps
// refusing. Everything already fetched must be in the table.
{
  const supabase = createFakeSupabase();
  const FAIL_AFTER = 4;
  const restore = stubFetch((i) => reply(
    i < FAIL_AFTER ? okRows([`/p/${i}`, `/q/${i}`]) : ANALYTICS_THROTTLE,
  ));
  const result = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 30,
    batchId: 'b2',
    // Give up immediately rather than backing off six times: the point under
    // test is what happens to the four days already fetched, not the backoff.
    throttleTries: 1,
  });
  restore();

  eq(result.days_fetched, FAIL_AFTER, 'four days were fetched before the refusal');
  eq(result.days_written, FAIL_AFTER, 'and all four were written');
  eq(supabase.rows('shopify_landing_pages_daily').length, FAIL_AFTER * 2,
    'the rows are really in the table -- this is the assertion run #354 would have failed');

  // Days go backwards from today, so the stored days must be contiguous and
  // the failure must be the day immediately before the earliest written one.
  const stored = [...new Set(supabase.rows('shopify_landing_pages_daily').map((r) => r.day_date))].sort();
  eq(stored.length, FAIL_AFTER, 'four distinct days stored');
  eq(stored[0], result.earliest_day_written, 'earliest_day_written matches the table');
  eq(stored[stored.length - 1], result.latest_day_written, 'latest_day_written matches the table');
  ok(result.failure && result.failure.day < result.earliest_day_written,
    'the failure is recorded on the day after the last one written (walking backwards)');
  eq(result.failure.throttled, true, 'the failure is identified as a throttle, not a generic error');
}

// ── 3. An incomplete run is never marked complete ───────────────────────────
{
  const supabase = createFakeSupabase();
  const restore = stubFetch((i) => reply(i < 3 ? okRows(['/a']) : ANALYTICS_THROTTLE));
  const result = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 730, batchId: 'b3', throttleTries: 1,
  });
  restore();

  eq(result.complete, false, 'a run that covered 3 of 730 days is NOT complete');
  eq(result.days_requested, 730, 'the requested window is reported as requested');
  eq(result.days_written, 3, 'alongside what was actually written');
  ok(result.rows_upserted > 0, 'and it did write rows');
  ok(result.failure !== null, 'with the failure recorded, not swallowed');

  // The trap this guards: rows_upserted > 0 reads like success. It is not.
  ok(!(result.rows_upserted > 0 && result.complete),
    'writing rows must never by itself imply the window completed');

  // And the happy path still says complete, or the flag would be worthless.
  const supabase2 = createFakeSupabase();
  const restore2 = stubFetch(() => reply(okRows(['/a'])));
  const full = await runLandingPagesSync(supabase2, CONNECTION, { sinceDays: 5, batchId: 'b4' });
  restore2();
  eq(full.complete, true, 'a run that covered its whole window IS complete');
  eq(full.days_written, 5, 'all five days written');
  eq(full.failure, null, 'and no failure recorded');
}

// ── 3b. A quiet day counts as covered, not as a hole ────────────────────────
{
  const supabase = createFakeSupabase();
  const restore = stubFetch(() => reply(okRows([])));   // no traffic at all
  const result = await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 3, batchId: 'b5' });
  restore();

  eq(result.complete, true, 'three days of no traffic is a complete window');
  eq(result.days_written, 3, 'a day Shopify reported nothing for was still COVERED');
  eq(result.rows_upserted, 0, 'even though it wrote no rows');
}

// ── 4. The requested sessions step always leaves a record ───────────────────
// This is run #354's dispatch, exactly: sessions_days=730 AND skip_sessions=true.
{
  const env = {
    SHOPIFY_RUN_KIND: 'workflow_dispatch',
    SHOPIFY_SYNC_MODE: 'incremental',
    SHOPIFY_SKIP_SALES: 'true',
    SHOPIFY_SKIP_INVENTORY: 'true',
    SHOPIFY_SKIP_CATALOG: 'true',
    SHOPIFY_SKIP_SESSIONS: 'true',
    SHOPIFY_SESSIONS_DAYS: '730',
    SHOPIFY_SKIP_LANDING_PAGES: 'false',
    SHOPIFY_LANDING_PAGES_DAYS: '730',
    SHOPIFY_SKIP_DISCOUNT_CODES: 'true',
    SHOPIFY_COLLECTIONS_ENABLED: 'false',
  };
  const plan = buildSyncPlan(env);
  const sessions = plan.stages.find((s) => s.jobType === 'sessions_sync');

  eq(plan.manual, true, 'a workflow_dispatch is a manual run');
  eq(sessions.enabled, false, 'skip_sessions=true still wins -- the flag is not overridden');
  eq(sessions.parameterSupplied, true, 'but the 730 was noticed');
  eq(sessions.contradiction, true, 'and the pair is called contradictory');
  eq(sessions.requested, true, 'so the run counts as having been asked for sessions');
  ok(/730/.test(sessions.skipReason) && /SHOPIFY_SKIP_SESSIONS/.test(sessions.skipReason),
    `the reason names both halves of the contradiction: ${sessions.skipReason}`);
  eq(shouldRecordSkippedJob(sessions, { manual: true }), true,
    'a job row IS written for it -- the absence of one is what made #354 invisible');

  // A contradiction is recorded even on a cron, because it can only come from
  // a person setting both.
  eq(shouldRecordSkippedJob(sessions, { manual: false }), true,
    'a contradiction is recorded whoever triggered it');

  // Landing pages was genuinely requested here.
  const landing = plan.stages.find((s) => s.jobType === 'landing_pages_sync');
  eq(landing.enabled, true, 'landing pages runs');
  eq(landing.contradiction, false, 'and is not contradictory');

  // The stages a scheduled light refresh turns off by design must NOT each
  // mint a job row, or the useful rows drown.
  const nightly = buildSyncPlan({
    SHOPIFY_RUN_KIND: 'schedule',
    SHOPIFY_SYNC_MODE: 'incremental',
    SHOPIFY_SKIP_SESSIONS: 'true',
    SHOPIFY_SESSIONS_DAYS: '',
  });
  const nightlySessions = nightly.stages.find((s) => s.jobType === 'sessions_sync');
  eq(nightly.manual, false, 'a schedule event is not a manual run');
  eq(nightlySessions.contradiction, false, 'no parameter, no contradiction');
  eq(nightlySessions.requested, false, 'the cron did not ask for sessions');
  eq(shouldRecordSkippedJob(nightlySessions, { manual: false }), false,
    'so a policy skip on a cron writes no row');

  // A stage the MODE cannot run is not a per-run choice and needs no row.
  const history = plan.stages.find((s) => s.jobType === 'history_import');
  eq(history.enabled, false, 'history_import does not run in incremental mode');
  eq(history.gate, 'mode', 'and it is gated by the mode, not a flag');
  eq(shouldRecordSkippedJob(history, { manual: true }), false, 'so it mints no row');
}

// ── 5. A manual run goes red when a requested step does not complete ─────────
{
  // The three shapes, all from run #354's dispatch.
  const skippedDespiteRequest = {
    shopDomain: 'baseballism.myshopify.com', jobType: 'sessions_sync',
    state: 'skipped', requested: true, detail: 'skip flag vs 730-day parameter',
  };
  const partial = {
    shopDomain: 'baseballism.myshopify.com', jobType: 'landing_pages_sync',
    state: 'partial', requested: true, detail: 'kept 100/730 days',
  };
  const succeeded = {
    shopDomain: 'baseballism.myshopify.com', jobType: 'payouts_sync',
    state: 'success', requested: true, detail: null,
  };

  const manual = runOutcomeReport({ manual: true, outcomes: [succeeded, partial, skippedDespiteRequest] });
  eq(manual.exitCode, 1, 'a manual backfill fails when a requested step did not complete');
  eq(manual.failures.length, 2, 'both the partial and the silent skip are counted');
  ok(/landing_pages_sync/.test(manual.summary) && /sessions_sync/.test(manual.summary),
    'and the summary names them');

  // #354 exactly: it would now be red instead of green.
  eq(runOutcomeReport({ manual: true, outcomes: [succeeded, skippedDespiteRequest] }).exitCode, 1,
    'the silent skip ALONE is enough to fail a manual run');

  // The nightly keeps its non-fatal policy -- a red nightly that is routinely
  // red is a nightly nobody reads.
  const scheduled = runOutcomeReport({ manual: false, outcomes: [succeeded, partial, skippedDespiteRequest] });
  eq(scheduled.exitCode, 0, 'a scheduled run stays green on a non-fatal analytics failure');
  ok(scheduled.summary !== null, 'but still says what did not complete');

  // A clean manual run passes, or the check would be useless.
  eq(runOutcomeReport({ manual: true, outcomes: [succeeded] }).exitCode, 0,
    'a manual run with everything complete passes');

  // A stage skipped WITHOUT having been requested does not fail anything.
  eq(runOutcomeReport({
    manual: true,
    outcomes: [{ jobType: 'catalog_sync', state: 'skipped', requested: false }],
  }).exitCode, 0, 'a deliberately skipped, unrequested stage is not a failure');

  // A missing Shopify scope DOES fail a requested manual run. This was the
  // other way round until review: the reasoning was that a missing scope is a
  // fact about the store's configuration rather than a failure of the run.
  // True, and beside the point -- the stage still did not happen, and a
  // backfill reporting success because the reason for doing nothing was
  // configuration rather than a rate limit is the same misleading green in a
  // different hat.
  eq(runOutcomeReport({
    manual: true,
    outcomes: [{ jobType: 'sessions_sync', state: 'scope_skipped', requested: true,
      detail: 'missing Shopify scope(s): read_reports' }],
  }).exitCode, 1, 'a requested stage that could not run for want of a scope fails a manual run');

  // ...and stays non-fatal on a cron, or a store that never granted the scope
  // would make the nightly permanently red, which is a nightly nobody reads.
  eq(runOutcomeReport({
    manual: false,
    outcomes: [{ jobType: 'sessions_sync', state: 'scope_skipped', requested: true }],
  }).exitCode, 0, 'the same missing scope does not fail the nightly');

  // A scope skip on a stage this run did NOT ask for is not a failure either.
  eq(runOutcomeReport({
    manual: true,
    outcomes: [{ jobType: 'catalog_sync', state: 'scope_skipped', requested: false }],
  }).exitCode, 0, 'an unrequested stage skipped for scopes is not a failure');
}

// ── 6. Resume: a second run continues instead of re-walking the window ───────
{
  const supabase = createFakeSupabase();

  // First run: 40 of a 90-day window, then the limiter refuses.
  const restore1 = stubFetch((i) => reply(i < 40 ? okRows([`/a${i}`]) : ANALYTICS_THROTTLE));
  const first = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 90, batchId: 'r1', throttleTries: 1, restateDays: 5,
  });
  restore1();
  eq(first.complete, false, 'the first run stopped short');
  eq(first.days_written, 40, 'having written 40 days');
  eq(first.days_already_covered, 0, 'with nothing to resume past on a first run');

  // Second run, same window, Shopify now healthy. It must NOT re-fetch the 40
  // days it already has -- except the ones inside the restatement window,
  // which are deliberately re-asked because Shopify revises them.
  let fetches = 0;
  const restore2 = stubFetch(() => { fetches += 1; return reply(okRows(['/z'])); });
  const second = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 90, batchId: 'r2', restateDays: 5,
  });
  restore2();

  eq(second.complete, true, 'the second run finishes the window');
  eq(second.days_covered, 90, 'covering all 90 days between them');
  eq(second.days_already_covered, 35,
    'the 35 stored days outside the restatement window were skipped, not re-fetched');
  eq(second.days_written, 55, 'so it fetched the 50 new days plus the 5 restatement days');
  eq(fetches, 55, 'and made exactly that many Shopify calls -- this is the resume');

  // Without resume this would have been 90 calls. That difference IS the fix:
  // "partial progress preserved" and "continues from where it stopped" are
  // different claims, and only the second one saves the re-walk.
  ok(fetches < 90, 'a resumed run is strictly cheaper than a restart');

  // Which days each run touched is observable through sync_batch_id, so this
  // asserts the actual partition rather than restating the arithmetic above.
  const rows = supabase.rows('shopify_landing_pages_daily');
  eq(rows.length, 90, 'one row per day across the whole window');
  const byBatch = rows.reduce((acc, r) => { acc[r.sync_batch_id] = (acc[r.sync_batch_id] || 0) + 1; return acc; }, {});
  eq(byBatch, { r1: 35, r2: 55 },
    'the 35 resumed days still carry the FIRST run\'s batch id -- they were genuinely not re-fetched');

  // And the days the second run did re-fetch are the five most recent ones
  // plus everything past where the first run stopped -- not an arbitrary 55.
  const r2Days = rows.filter((r) => r.sync_batch_id === 'r2').map((r) => r.day_date).sort();
  const r1Days = rows.filter((r) => r.sync_batch_id === 'r1').map((r) => r.day_date).sort();
  ok(r2Days[r2Days.length - 1] > r1Days[r1Days.length - 1],
    'the restatement window sits at the recent end, above every resumed day');
  ok(r2Days[0] < r1Days[0],
    'and the newly-reached days sit below every resumed day');
}

// ── 6b. The nightly's behaviour is unchanged ────────────────────────────────
// sinceDays (30) is not greater than restateDays (30), so resume never engages
// and every day is re-stated exactly as before this change.
{
  const supabase = createFakeSupabase();
  const restore1 = stubFetch(() => reply(okRows(['/a'])));
  await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 30, batchId: 'n1' });
  restore1();

  let fetches = 0;
  const restore2 = stubFetch(() => { fetches += 1; return reply(okRows(['/a'])); });
  const again = await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 30, batchId: 'n2' });
  restore2();

  eq(fetches, 30, 'the 30-day nightly still re-fetches all 30 days');
  eq(again.days_already_covered, 0, 'resume does not engage at the default window');
  eq(again.complete, true, 'and it completes');
  // No RPC call at all when the window cannot benefit -- so the nightly does
  // not depend on the new function existing.
  ok(!supabase.calls.rpcs.some((c) => c.fn === 'shopify_landing_pages_covered_days'),
    'the nightly never even asks which days are covered');
}

// ── 6c. A missing migration degrades to the old behaviour, not to an error ──
{
  const supabase = createFakeSupabase();
  supabase.breakRpc('shopify_landing_pages_covered_days');
  const restore = stubFetch(() => reply(okRows(['/a'])));
  const result = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 40, batchId: 'm1', restateDays: 5,
  });
  restore();

  eq(result.complete, true, 'the sync still works when the resume function is absent');
  eq(result.days_written, 40, 'it just re-fetches everything, as it did before');
  ok(result.resume_unavailable, 'and says so rather than silently losing the optimisation');
}

// ── 7. A restated day drops paths that fell out of its top N ────────────────
{
  const supabase = createFakeSupabase();

  // Day one: three paths.
  const restore1 = stubFetch(() => reply(okRows(['/keep', '/also-keep', '/drops-out'])));
  await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 1, batchId: 's1' });
  restore1();
  eq(supabase.rows('shopify_landing_pages_daily').length, 3, 'three paths stored');

  // Shopify restates the same day with only two of them. The third is not
  // "unchanged", it is GONE from the top N -- and an upsert alone would leave
  // it there forever with a stale rank and stale counts.
  const restore2 = stubFetch(() => reply(okRows(['/keep', '/also-keep'])));
  const restated = await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 1, batchId: 's2' });
  restore2();

  const stored = supabase.rows('shopify_landing_pages_daily').map((r) => r.landing_page_path).sort();
  eq(stored, ['/also-keep', '/keep'], 'the path that dropped out was removed');
  eq(restated.stale_rows_removed, 1, 'and the removal is reported, not silent');

  // Ranks must not collide: a leftover row keeps its old rank_in_day, so the
  // day would have had two rows claiming the same rank.
  const ranks = supabase.rows('shopify_landing_pages_daily').map((r) => r.rank_in_day).sort();
  eq(ranks, [1, 2], 'and the surviving ranks are contiguous with no duplicate');
}

// ── 7b. A day that returned NOTHING is never swept ──────────────────────────
// Zero rows is the shape of a bad fetch as much as of a genuinely dead day,
// and from here the two are indistinguishable. Deleting a real day's history
// on a transport hiccup is much worse than keeping stale rows one more run.
{
  const supabase = createFakeSupabase();
  const restore1 = stubFetch(() => reply(okRows(['/a', '/b'])));
  await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 1, batchId: 'z1' });
  restore1();
  eq(supabase.rows('shopify_landing_pages_daily').length, 2, 'two rows stored');

  const restore2 = stubFetch(() => reply(okRows([])));
  const empty = await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 1, batchId: 'z2' });
  restore2();

  eq(supabase.rows('shopify_landing_pages_daily').length, 2,
    'an empty result did NOT wipe the day');
  eq(empty.days_not_swept, 1, 'and the day is reported as not swept');
  eq(empty.complete, true, 'the run itself is still complete -- a quiet day is covered');
  ok(!supabase.calls.rpcs.some((c) => c.fn === 'shopify_landing_pages_sweep_day'
    && c.args && (c.args.p_keep_paths || []).length === 0),
    'the sweep was never even called with an empty keep-list');
}

// ── 7c. A failed sweep is reported, and does not lose the fresh rows ────────
{
  const supabase = createFakeSupabase();
  supabase.breakRpc('shopify_landing_pages_sweep_day');
  const restore = stubFetch(() => reply(okRows(['/a', '/b'])));
  const result = await runLandingPagesSync(supabase, CONNECTION, { sinceDays: 2, batchId: 'f1' });
  restore();

  eq(result.days_not_swept, 2, 'both days are flagged as unswept');
  eq(result.rows_upserted, 4, 'while their fresh rows were still written');
  eq(result.complete, true,
    'a sweep failure leaves stale rows, not wrong new ones, so it does not make the window incomplete');
}


// ── 8. The orchestrator's REAL progress callback ────────────────────────────
// The gap that let a bug through: every test above drove runLandingPagesSync
// with a bespoke inline callback, so the orchestrator's own callback was never
// executed by anything. It referenced `result` -- the const it was being
// passed to as an initializer argument -- and threw
// `ReferenceError: Cannot access 'result' before initialization` on the first
// sweep failure. `?.` does not help: optional chaining guards null and
// undefined, not an unreachable binding.
//
// Worse than a lost warning: the throw happened INSIDE the day loop's try, so
// it was caught as that day's failure and broke the loop -- one failed sweep
// aborted every remaining day and reported the run as failed, blaming a
// message about variable initialization.
{
  const logs = [];
  const warns = [];
  const onProgress = landingPagesProgress({
    shopDomain: 'baseballism.myshopify.com',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });

  // Every payload shape the core actually emits, exactly as it emits them.
  onProgress({ day: '2026-09-01', event: 'throttled', attempt: 2, waitMs: 4000 });
  onProgress({ day: '2026-09-02', event: 'sweep_failed', error: 'boom', topN: 250 });
  onProgress({ day: '2026-09-03', event: 'written', rows: 12 });

  eq(logs.length, 1, 'a throttle is logged');
  ok(/throttled, attempt 2, backing off 4000ms/.test(logs[0]), 'with the attempt and the wait');
  eq(warns.length, 1, 'a failed sweep warns');
  ok(/sweep FAILED \(boom\)/.test(warns[0]), 'naming the error');
  ok(/top 250 remain/.test(warns[0]), 'and the top-N from the PAYLOAD, not from a pending result');
  ok(!/undefined/.test(warns[0]), 'with nothing rendering as undefined');

  // topN absent must degrade, never throw.
  warns.length = 0;
  onProgress({ day: '2026-09-04', event: 'sweep_failed', error: 'boom' });
  ok(/top N remain/.test(warns[0]), 'a missing topN falls back to "N" rather than throwing');

  // An unknown event, and an empty call, must both be inert.
  onProgress({ day: '2026-09-05', event: 'something_new' });
  onProgress();
  eq(warns.length, 1, 'unknown and empty events are ignored');
}

// ── 8b. Integration: a sweep failure through the REAL callback ──────────────
// This is the actual regression. With the pre-fix callback this run reports
// complete:false and a ReferenceError as its failure message.
{
  const supabase = createFakeSupabase();
  supabase.breakRpc('shopify_landing_pages_sweep_day');
  const warns = [];
  const restore = stubFetch(() => reply(okRows(['/a', '/b'])));
  const result = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 5,
    batchId: 'tdz1',
    // The orchestrator's own callback, not a test double.
    onProgress: landingPagesProgress({
      shopDomain: CONNECTION.shop_domain,
      log: () => {},
      warn: (m) => warns.push(m),
    }),
  });
  restore();

  eq(result.complete, true,
    'a failing sweep does NOT truncate the backfill — this is the bug, and it aborted every remaining day');
  eq(result.days_written, 5, 'all five days were still fetched and written');
  eq(result.rows_upserted, 10, 'and their rows stored');
  eq(result.days_not_swept, 5, 'with every day flagged unswept');
  eq(result.failure, null, 'and no failure recorded — a reporting problem is not a sync failure');
  eq(warns.length, 5, 'the warning fired once per affected day');
  ok(!warns.some((w) => /before initialization/.test(w)), 'and none of them is a ReferenceError');
  // The two halves of the fix have to be asserted TOGETHER. Checking only that
  // the callback reads topN from its payload passes even if the core stops
  // putting it there -- found by mutation-testing this very suite, which
  // caught the callback half and missed the core half.
  ok(warns.every((w) => /top 250 remain/.test(w)),
    'and every warning names the REAL top-N, so the core is still passing it through');
  ok(!warns.some((w) => /top N remain|undefined/.test(w)),
    'never the "N" fallback, which here would mean the payload lost topN');
}

// ── 8c. A callback that throws can never fail the sync ──────────────────────
// The TDZ bug is fixed at its source; this is the second lock. A reporting
// callback is not part of the job, so the core swallows its failure and
// records that it happened, rather than letting a logging bug silently
// truncate a backfill and blame Shopify for it.
{
  const supabase = createFakeSupabase();
  const restore = stubFetch(() => reply(okRows(['/a'])));
  const result = await runLandingPagesSync(supabase, CONNECTION, {
    sinceDays: 4,
    batchId: 'throwcb',
    onProgress: () => { throw new Error('logger exploded'); },
  });
  restore();

  eq(result.complete, true, 'a throwing progress callback does not stop the sync');
  eq(result.days_written, 4, 'every day was still fetched');
  eq(result.failure, null, 'and the run records no failure');
  ok(result.progress_errors >= 4, 'but the callback failures ARE counted, not hidden');
}

// ── 8d. The coverage line, also extracted so it can be exercised ────────────
{
  const partial = landingPagesCoverage({
    days_covered: 103, days_requested: 730, days_written: 100, days_already_covered: 3,
    earliest_day_covered: '2026-05-29', latest_day_covered: '2026-09-08',
    rows_upserted: 25000, distinct_paths: 1200, stale_rows_removed: 7,
    days_not_swept: 2, days_hitting_top_n: 40, top_n: 250,
  });
  ok(/103\/730 days covered/.test(partial), 'coverage leads with covered vs requested');
  ok(/100 fetched now, 3 already stored/.test(partial), 'and splits this run from the resumed days');
  ok(/7 superseded row\(s\) removed/.test(partial), 'reporting the sweep');
  ok(/2 day\(s\) NOT swept/.test(partial), 'and the days it could not sweep');
  ok(!/undefined|NaN/.test(partial), 'with no undefined or NaN anywhere');

  // A clean run must not carry the optional clauses at all.
  const clean = landingPagesCoverage({
    days_covered: 30, days_requested: 30, days_written: 30, days_already_covered: 0,
    earliest_day_covered: '2026-08-10', latest_day_covered: '2026-09-08',
    rows_upserted: 7500, distinct_paths: 900, top_n: 250,
  });
  ok(/30\/30 days covered/.test(clean), 'a complete run reports full coverage');
  ok(!/already stored|NOT swept|superseded|resume unavailable/.test(clean),
    'and none of the exception clauses appear');
  ok(!/undefined|NaN/.test(clean), 'with no undefined or NaN');
}

console.log(`landing-pages-backfill: ${passed} assertions passed`);
