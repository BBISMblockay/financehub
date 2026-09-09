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

  // Nor does a missing Shopify scope: that is a fact about the store's
  // configuration, and it does not change based on who triggered the run.
  eq(runOutcomeReport({
    manual: true,
    outcomes: [{ jobType: 'payouts_sync', state: 'scope_skipped', requested: true }],
  }).exitCode, 0, 'a missing scope is a configuration fact, not a run failure');
}

console.log(`landing-pages-backfill: ${passed} assertions passed`);
