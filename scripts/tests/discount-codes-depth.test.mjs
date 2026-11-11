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
 * Everything is stubbed: a fake global fetch that records the SINCE date of
 * every query, and the in-memory fake Supabase. No network, no database, no
 * secrets.
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

/** Fake fetch that records the SINCE date of each ShopifyQL query sent. */
function stubFetchRecordingDays() {
  const real = globalThis.fetch;
  const since = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body || '{}');
    // The ShopifyQL itself travels in the GraphQL variable `q`, not in the
    // `query` field (which is the fixed GraphQL document). Reading the wrong
    // one records zero days and the assertions below would all read 0.
    const m = /SINCE (\d{4}-\d{2}-\d{2})/.exec(String(body?.variables?.q ?? ''));
    if (m) since.push(m[1]);
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => okRow,
    };
  };
  return { since, restore: () => { globalThis.fetch = real; } };
}

const dayOffset = (iso) => Math.round((Date.now() - Date.parse(`${iso}T00:00:00Z`)) / 86400000);

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

  const supabase = createFakeSupabase();
  const { since, restore } = stubFetchRecordingDays();
  const result = await runDiscountCodesSync(supabase, CONNECTION, {
    sinceDays: requested, batchId: 'b1',
  });
  restore();

  eq(since.length, requested,
    `one query per day for all ${requested} days (got ${since.length})`);

  // The point of the whole file: the OLDEST day asked for was actually asked
  // about. At a clamp of 120 this is 120, and the promo 200 days ago is gone.
  const oldest = since.reduce((a, b) => (a < b ? a : b));
  eq(dayOffset(oldest), requested,
    `the oldest day queried is ${requested} days back, not a clamped subset`);

  // A promotion 200 days ago -- the reviewer's example -- is inside the window.
  ok(dayOffset(oldest) >= 200, 'a promo 200 days ago falls inside the queried window');

  // And the days are the contiguous run from yesterday back, with no holes:
  // a gap would lose a promo just as completely as a clamp.
  eq(new Set(since).size, requested, 'no day is queried twice');
  eq(since.map(dayOffset).sort((a, b) => a - b), Array.from({ length: requested }, (_, i) => i + 1),
    'the window is every day from yesterday back, contiguous');

  ok(result.rows_upserted > 0, 'rows landed');
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

  const supabase = createFakeSupabase();
  const { since, restore } = stubFetchRecordingDays();
  await runDiscountCodesSync(supabase, CONNECTION, {
    sinceDays: DISCOUNT_CODES_MAX_DAYS + 500, batchId: 'b2',
  });
  restore();
  eq(since.length, DISCOUNT_CODES_MAX_DAYS,
    'a request past the ceiling is clamped to it, so one call cannot spend unbounded requests');
}

// ── 3. The NIGHTLY window stays short ────────────────────────────────────────
//
// The ceiling rose; the default must not. A nightly paying 365 round trips
// every run, every 2 hours, is the cost this stage's shape exists to avoid.
{
  const supabase = createFakeSupabase();
  const { since, restore } = stubFetchRecordingDays();
  await runDiscountCodesSync(supabase, CONNECTION, { batchId: 'b3' });
  restore();
  eq(since.length, 30, 'with no sinceDays the worker still does 30 days, not the ceiling');
}

console.log(`discount-codes-depth: ${passed} checks passed`);
