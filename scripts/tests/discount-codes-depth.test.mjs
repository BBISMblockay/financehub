/* Discount codes: the window the caller ASKS for is the window that gets queried.
 *
 * Found in review of PR #1244. The first-connect plan was widened to ask for a
 * year of discount-code history (BOOTSTRAP_DEFAULTS.shopifyDiscountCodesDays =
 * 365) so a promo could be compared with last year's run of it. The worker
 * clamped `sinceDays` to 120 -- a bound chosen when the plan asked for 30 --
 * and that clamp failed SILENTLY in every way that matters:
 *
 *   - the worker returned normally, with no error and no warning;
 *   - the bootstrap recorded the storefront stage as `done`;
 *   - the nightly's 30-day window can never fill an older day, so the gap was
 *     permanent;
 *   - and the only test of the new default asserted the number in the PLAN and
 *     the env string, never that the worker honoured it -- so it passed over
 *     the truncation.
 *
 * The property under test is therefore not "the constant is 365". It is that
 * the oldest day the plan asks for is a day Shopify is actually asked about.
 * A test that reads the constant would pass again the next time a worker-side
 * bound is lowered underneath it, which is exactly the failure this file
 * exists for.
 *
 * TIME IS FROZEN, AND THAT IS NOT INCIDENTAL. Review cycle 2 found that the
 * first version of this file measured a day's age as
 * `Math.round((Date.now() - midnightUTC(day)) / 86400000)`, which from 12:00
 * UTC onward rounds UP: at 18:00 UTC the correctly queried oldest day
 * 2025-11-11 measured 366, and yesterday measured 2. The assertions below
 * would have rejected correct worker behaviour, and this file is a mandatory
 * CI step, so the whole suite would have failed for every run in the second
 * half of a UTC day while pointing the finger at the sync. Two separate
 * mistakes caused it: rounding a duration instead of differencing calendar
 * dates, and reading the clock twice (a 365-day loop can straddle midnight, so
 * the window is built before the rollover and the expectation after it).
 *
 * Both are fixed the same way: `runDiscountCodesSync` takes an injectable
 * `now`, the worker and every assertion share ONE frozen instant, and day age
 * is an exact midnight-to-midnight difference with no rounding. The cases
 * below pin 07:00, 11:59, 12:00, 18:00 and 23:59:30 UTC, so the bug that was
 * here cannot come back unnoticed.
 *
 * Everything else is stubbed too: a fake global fetch that records the SINCE
 * date of every query, and the in-memory fake Supabase. No network, no
 * database, no secrets.
 */

import assert from 'node:assert/strict';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import { runDiscountCodesSync, DISCOUNT_CODES_MAX_DAYS } from '../lib/shopify-sync-core.mjs';
import { BOOTSTRAP_DEFAULTS, planBootstrap } from '../lib/integration-bootstrap-core.mjs';

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

/** One row, so every day "succeeds" and the loop runs to the end. */
const okRow = {
  data: {
    shopifyqlQuery: {
      __typename: 'ShopifyqlQueryResponse',
      parseErrors: [],
      tableData: {
        columns: [{ name: 'discount_code' }, { name: 'gross_sales' }, { name: 'orders' }],
        rows: [{ discount_code: 'AFFILIATE10', gross_sales: '100.00', orders: 2 }],
      },
    },
  },
};

/** Fake fetch that records the SINCE date of each ShopifyQL query sent.
 *
 * The ShopifyQL itself travels in the GraphQL variable `q`, not in the `query`
 * field (which is the fixed GraphQL document). Reading the wrong one records
 * zero days and every assertion below silently compares 0 to 0. */
function stubFetchRecordingDays() {
  const real = globalThis.fetch;
  const since = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body || '{}');
    const m = /SINCE (\d{4}-\d{2}-\d{2})/.exec(String(body?.variables?.q ?? ''));
    if (m) since.push(m[1]);
    return { status: 200, headers: { get: () => null }, json: async () => okRow };
  };
  return { since, restore: () => { globalThis.fetch = real; } };
}

/** How many whole calendar days before `refIso` the day `iso` is.
 *
 * Both sides are UTC midnights, so the difference is an exact multiple of
 * 86400000 and there is nothing to round. The previous version differenced a
 * midnight from the CURRENT INSTANT and rounded, which is what carried the
 * time of day into the answer. */
const daysBefore = (iso, refIso) =>
  (Date.parse(`${refIso}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400000;

/** Run the worker at one frozen instant and return the days it queried. */
async function queriedDays(frozenIso, opts) {
  const supabase = createFakeSupabase();
  const { since, restore } = stubFetchRecordingDays();
  const frozen = new Date(frozenIso);
  let result;
  try {
    result = await runDiscountCodesSync(supabase, CONNECTION, { ...opts, now: () => frozen });
  } finally {
    restore();
  }
  return { since, result, today: frozenIso.slice(0, 10) };
}

// ── 1. The depth the FIRST-CONNECT PLAN asks for is the depth queried ────────
//
// Driven by the bootstrap-derived value rather than a literal, so the two
// cannot drift apart: this is the number the plan really emits.
{
  const [, storefront] = planBootstrap({
    integration: 'shopify', company_entity_id: 'co-1', connection_id: 'conn-1', stages: {},
  });
  const requested = Number(storefront.env.SHOPIFY_DISCOUNT_CODES_DAYS);
  eq(requested, 365, 'the first-connect plan asks for a year of discount codes');

  const { since, result, today } = await queriedDays('2026-11-11T07:00:00Z',
    { sinceDays: requested, batchId: 'b1' });

  eq(since.length, requested,
    `one query per day for all ${requested} days (got ${since.length})`);

  // The point of the whole file: the OLDEST day asked for was actually asked
  // about. At a clamp of 120 this is 120, and the promo 200 days ago is gone.
  const oldest = since.reduce((a, b) => (a < b ? a : b));
  eq(daysBefore(oldest, today), requested,
    `the oldest day queried is ${requested} days back, not a clamped subset`);

  // A promotion 200 days ago -- the reviewer's example -- is inside the window.
  ok(daysBefore(oldest, today) >= 200, 'a promo 200 days ago falls inside the queried window');

  // The days are the contiguous run from yesterday back, with no holes: a gap
  // would lose a promo just as completely as a clamp. Today is excluded on
  // purpose -- it is a partial day.
  eq(new Set(since).size, requested, 'no day is queried twice');
  eq(since.map((d) => daysBefore(d, today)).sort((a, b) => a - b),
    Array.from({ length: requested }, (_, i) => i + 1),
    'the window is every day from yesterday back, contiguous, and excludes today');

  ok(result.rows_upserted > 0, 'rows landed');
}

// ── 1b. The same answer at every hour of the UTC day ─────────────────────────
//
// This is the cycle-2 regression. The old arithmetic gave 365 before noon and
// 366 after it, so a correct worker failed CI for half of every day. A short
// window keeps the five runs cheap; the property is about the hour, not the
// depth.
{
  for (const frozen of [
    '2026-11-11T07:00:00Z',
    '2026-11-11T11:59:00Z',
    '2026-11-11T12:00:00Z', // the exact hour the rounding flipped
    '2026-11-11T18:00:00Z',
    '2026-11-11T23:59:30Z', // 30s from the rollover
  ]) {
    const { since, today } = await queriedDays(frozen, { sinceDays: 3, batchId: 'hour' });
    eq(since.map((d) => daysBefore(d, today)).sort((a, b) => a - b), [1, 2, 3],
      `at ${frozen} the window is still yesterday back three days`);
    eq(since.includes(today), false, `at ${frozen} today's partial day is not queried`);
  }
}

// ── 1c. Across a month and a year boundary ──────────────────────────────────
//
// `new Date(t - i*86400000)` is plain millisecond arithmetic, so these cannot
// really break -- which is the point of pinning them: a future "clearer"
// rewrite with setUTCDate or local-time parts would, and silently.
{
  const { since: m, today: mToday } = await queriedDays('2026-03-01T12:00:00Z', { sinceDays: 2 });
  eq(m.sort(), ['2026-02-27', '2026-02-28'], 'crossing into February, including a leap check');
  eq(daysBefore(m[0], mToday), 2, 'the month boundary does not shift the offset');

  const { since: y } = await queriedDays('2026-01-01T18:00:00Z', { sinceDays: 2 });
  eq(y.sort(), ['2025-12-30', '2025-12-31'], 'crossing into the previous year');
}

// ── 2. The worker's ceiling is a COST ceiling, and it still clamps ───────────
//
// Each day is a round trip, so the bound is how many requests one run may
// make -- not how far back Shopify answers. It must be at least what the
// widest caller asks for, which is what stops a clamp eating a promise; it is
// deliberately NOT SHOPIFYQL_MAX_DAYS, because 730 here would be 730 requests.
{
  ok(DISCOUNT_CODES_MAX_DAYS >= BOOTSTRAP_DEFAULTS.shopifyDiscountCodesDays,
    `the worker's ceiling (${DISCOUNT_CODES_MAX_DAYS}) must cover the widest request `
    + `(${BOOTSTRAP_DEFAULTS.shopifyDiscountCodesDays}), or the request is truncated in silence`);

  const { since } = await queriedDays('2026-11-11T07:00:00Z',
    { sinceDays: DISCOUNT_CODES_MAX_DAYS + 500, batchId: 'b2' });
  eq(since.length, DISCOUNT_CODES_MAX_DAYS,
    'a request past the ceiling is clamped to it, so one call cannot spend unbounded requests');
}

// ── 3. The NIGHTLY window stays short ────────────────────────────────────────
//
// The ceiling rose; the default must not. A nightly paying 365 round trips
// every run, every 2 hours, is the cost this stage's shape exists to avoid.
{
  const { since } = await queriedDays('2026-11-11T07:00:00Z', { batchId: 'b3' });
  eq(since.length, 30, 'with no sinceDays the worker still does 30 days, not the ceiling');
}

// ── 4. Production passes no clock ────────────────────────────────────────────
//
// `now` exists for the tests above; the real callers must not have to know
// about it, or a missing default becomes a crash in the nightly.
{
  const { since, restore } = stubFetchRecordingDays();
  try {
    await runDiscountCodesSync(createFakeSupabase(), CONNECTION, { sinceDays: 1 });
  } finally {
    restore();
  }
  eq(since.length, 1, 'called with no `now`, the worker uses the real clock and still runs');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(since[0]), 'and queries a real calendar day');
}

console.log(`discount-codes-depth: ${passed} checks passed`);
