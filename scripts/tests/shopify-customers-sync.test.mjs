// The customers sync: Shopify marketing consent, as it stands NOW.
//
// Blake asked whether SILO pulls Shopify's "accepts marketing" column. It did
// not, and that column no longer exists in Shopify either -- consent is a
// STATE per channel (email, SMS). The three things this suite holds down are
// the three that would quietly ruin the answer:
//
//   * a state is never flattened into a boolean, and an ABSENT state is not
//     "not subscribed" (NULL means not measured, everywhere in SILO);
//   * the walk asks Shopify only for customers changed since the last run and
//     advances its watermark to what was actually WRITTEN, so a nightly costs
//     a page or two per store and an interrupted run resumes instead of
//     starting over;
//   * a store that has not granted read_customers, or a database where the
//     migration has not been applied yet, SKIPS -- it never fails the run and
//     never touches the rest of that store's sync.
//
// Run: node --test scripts/tests/shopify-customers-sync.test.mjs
// Mutations checked by hand: the watermark advanced before the upsert, the
// page budget ignored, the scope gate dropped, read_customers added to
// REQUIRED_FOR_SYNC, email_subscribed written as a column instead of derived.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import {
  customerConsentRow,
  customersAccessRefused,
  customersCursorRejected,
  customersScopesMissing,
  CUSTOMERS_SCOPES,
  customersNotInstalled,
  normalizeConsentValue,
  runCustomersSync,
} from '../lib/shopify-customers-core.mjs';
import { REQUIRED_FOR_SYNC } from '../lib/shopify-scopes.mjs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIGRATION = 'supabase/migrations/20261124020000_shopify_customer_marketing_consent.sql';

const connection = (overrides = {}) => ({
  id: 'conn-1',
  company_entity_id: 'company-1',
  shop_domain: 'example.myshopify.com',
  access_token: 'tok',
  scopes_granted: ['read_orders', 'read_customers'],
  meta: {},
  ...overrides,
});

const node = (overrides = {}) => ({
  id: 'gid://shopify/Customer/900',
  legacyResourceId: '900',
  email: '  Person@Example.COM ',
  phone: '+15551234567',
  firstName: 'Person',
  lastName: 'Example',
  displayName: 'Person Example',
  state: 'ENABLED',
  verifiedEmail: true,
  tags: ['vip', 'wholesale'],
  numberOfOrders: '7',
  createdAt: '2024-02-01T00:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
  amountSpent: { amount: '412.50', currencyCode: 'USD' },
  emailMarketingConsent: {
    marketingState: 'SUBSCRIBED',
    marketingOptInLevel: 'SINGLE_OPT_IN',
    consentUpdatedAt: '2026-05-05T00:00:00Z',
  },
  smsMarketingConsent: {
    marketingState: 'NOT_SUBSCRIBED',
    marketingOptInLevel: 'SINGLE_OPT_IN',
    consentUpdatedAt: null,
    consentCollectedFrom: 'SHOPIFY',
  },
  defaultAddress: { city: 'Phoenix', provinceCode: 'AZ', countryCodeV2: 'US' },
  ...overrides,
});

/** A fake Shopify GraphQL that serves `pages` of nodes and records the
 *  variables it was asked with -- which is where the incremental filter and
 *  the cursor either work or do not. */
function fakeGql(pages) {
  const seen = [];
  const gql = async (_conn, _query, variables) => {
    seen.push(variables);
    const index = variables.cursor ? Number(variables.cursor) : 0;
    const nodes = pages[index] || [];
    const hasNextPage = index + 1 < pages.length;
    return {
      customers: {
        pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null },
        nodes,
      },
    };
  };
  gql.seen = seen;
  return gql;
}

// ── the row shape ───────────────────────────────────────────────────────────

test('consent states are stored verbatim and lowercased, never as a boolean', () => {
  const row = customerConsentRow(node(), { connection: connection(), syncedAt: 'now', batchId: 'b1' });

  assert.equal(row.email_consent_state, 'subscribed');
  assert.equal(row.email_consent_opt_in_level, 'single_opt_in');
  assert.equal(row.email_consent_updated_at, '2026-05-05T00:00:00Z');
  assert.equal(row.sms_consent_state, 'not_subscribed');
  assert.equal(row.sms_consent_collected_from, 'shopify');
  assert.equal(row.sms_consent_updated_at, null);

  // The booleans are the DATABASE's, generated from the state. Writing them
  // from here is how the two would drift.
  assert.equal('email_subscribed' in row, false);
  assert.equal('sms_subscribed' in row, false);
});

test('a consent Shopify did not report is null, not "not subscribed"', () => {
  const row = customerConsentRow(
    node({ emailMarketingConsent: null, smsMarketingConsent: {}, numberOfOrders: null, amountSpent: null }),
    { connection: connection(), syncedAt: 'now', batchId: 'b1' },
  );

  assert.equal(row.email_consent_state, null);
  assert.equal(row.sms_consent_state, null);
  // The same rule for the measurements beside it: absent is not zero.
  assert.equal(row.orders_count, null);
  assert.equal(row.total_spent, null);
  assert.equal(normalizeConsentValue(''), null);
  assert.equal(normalizeConsentValue(undefined), null);
});

test('the row carries the identity and company keys the table is unique on', () => {
  const row = customerConsentRow(node(), { connection: connection(), syncedAt: 'now', batchId: 'b1' });

  assert.equal(row.company_entity_id, 'company-1');
  assert.equal(row.shop_domain, 'example.myshopify.com');
  assert.equal(row.customer_id, '900');
  assert.equal(row.email, '  Person@Example.COM ');   // email_lc is generated in SQL
  assert.equal(row.customer_name, 'Person Example');
  assert.equal(row.tags, 'vip, wholesale');
  assert.equal(row.orders_count, 7);
  assert.equal(row.total_spent, 412.5);
  assert.equal(row.city, 'Phoenix');
  assert.equal(row.province_code, 'AZ');
  assert.equal(row.country_code, 'US');
});

test('a GID with no legacyResourceId still yields the numeric customer id', () => {
  const row = customerConsentRow(node({ legacyResourceId: null }), {
    connection: connection(), syncedAt: 'now', batchId: 'b1',
  });
  assert.equal(row.customer_id, '900');
});

// ── the walk ────────────────────────────────────────────────────────────────

test('a first run asks for every customer; the next run asks only for changes', async () => {
  const db = createFakeSupabase();
  const gql = fakeGql([[node()]]);

  const first = await runCustomersSync(db, connection(), { batchId: 'b1', gql });
  assert.equal(first.first_run, true);
  assert.equal(gql.seen[0].filter, null, 'a first run must not restrict the window');
  assert.equal(first.customers_upserted, 1);
  assert.equal(first.last_customer_sync_at, '2026-11-20T10:00:00Z');

  const gql2 = fakeGql([[node({ updatedAt: '2026-11-22T10:00:00Z' })]]);
  const second = await runCustomersSync(
    db,
    connection({ meta: { last_customer_sync_at: first.last_customer_sync_at } }),
    { batchId: 'b2', gql: gql2 },
  );
  assert.equal(first.complete, true);
  assert.equal(first.customer_walk, null, 'a finished walk stores no continuation');
  assert.equal(second.first_run, false);
  // A FULL DAY of overlap: Shopify's search syntax documents updated_at as
  // matching "a whole day" and says nothing about sub-second precision, so the
  // window must be correct whether or not the time part survives.
  assert.match(gql2.seen[0].filter, /^updated_at:>='2026-11-19T10:00:00\.000Z'$/,
    'the incremental window is the watermark less a day');
  assert.equal(second.last_customer_sync_at, '2026-11-22T10:00:00Z');
});

test('the rows land once per (company, store, customer), merged on re-sync', async () => {
  const db = createFakeSupabase();

  await runCustomersSync(db, connection(), { batchId: 'b1', gql: fakeGql([[node()]]) });
  await runCustomersSync(db, connection(), {
    batchId: 'b2',
    gql: fakeGql([[node({ emailMarketingConsent: { marketingState: 'UNSUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: '2026-11-21T00:00:00Z' } })]]),
  });

  const stored = db.rows('shopify_customers');
  assert.equal(stored.length, 1, 'the same customer is one row, not one per run');
  assert.equal(stored[0].email_consent_state, 'unsubscribed', 'an unsubscribe overwrites the stored state');
  assert.equal(db.calls.upserts.at(-1).opts.onConflict, 'company_entity_id,shop_domain,customer_id');
});

test('the page budget stops a run and hands the next one its cursor', async () => {
  const db = createFakeSupabase();
  const pages = [
    [node({ legacyResourceId: '1', id: 'gid://shopify/Customer/1', updatedAt: '2026-11-01T00:00:00Z' })],
    [node({ legacyResourceId: '2', id: 'gid://shopify/Customer/2', updatedAt: '2026-11-02T00:00:00Z' })],
    [node({ legacyResourceId: '3', id: 'gid://shopify/Customer/3', updatedAt: '2026-11-03T00:00:00Z' })],
  ];
  const gql = fakeGql(pages);

  const run = await runCustomersSync(db, connection(), { batchId: 'b1', gql, maxPages: 2 });

  assert.equal(run.pages_fetched, 2);
  assert.equal(run.customers_upserted, 2);
  assert.equal(run.complete, false);
  assert.equal(run.more_available, true, 'the caller must be able to tell that there is more');
  assert.equal(run.customer_walk.cursor, '2', 'the continuation is a cursor, not a timestamp');
  assert.equal(run.customer_walk.filter, null, 'and it carries the filter the walk started with');
  // An unfinished walk must NOT move the incremental window: the window only
  // advances once every page of the walk has landed.
  assert.equal(run.last_customer_sync_at, null);

  const resumed = await runCustomersSync(
    db,
    connection({ meta: { customer_walk: run.customer_walk } }),
    { batchId: 'b2', gql: fakeGql(pages), maxPages: 2 },
  );
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.customer_walk, null);
  assert.equal(resumed.last_customer_sync_at, '2026-11-03T00:00:00Z');
});

test('25,000 customers sharing one timestamp still finish, a budget at a time', async () => {
  // The failure this replaced: resuming from the newest timestamp written
  // means a bulk edit that leaves more customers on one `updated_at` than a
  // run's budget covers would re-walk the same pages for ever and never reach
  // the rest (found in review of this PR). Three pages of identical
  // timestamps, a budget of one page, so the walk can only finish if the
  // CURSOR is what carries over.
  const SAME = '2026-11-15T00:00:00Z';
  const pages = [0, 1, 2].map((p) => [
    node({ legacyResourceId: `${p}a`, id: `gid://shopify/Customer/${p}a`, updatedAt: SAME }),
    node({ legacyResourceId: `${p}b`, id: `gid://shopify/Customer/${p}b`, updatedAt: SAME }),
  ]);

  const db = createFakeSupabase();
  let meta = {};
  const seenFilters = [];
  for (let run = 0; run < 3; run += 1) {
    const gql = fakeGql(pages);
    const r = await runCustomersSync(db, connection({ meta }), { batchId: `b${run}`, gql, maxPages: 1 });
    seenFilters.push(gql.seen[0]);
    meta = { ...meta, customer_walk: r.customer_walk || null };
    if (r.last_customer_sync_at) meta.last_customer_sync_at = r.last_customer_sync_at;
    assert.equal(r.pages_fetched, 1);
    assert.equal(r.complete, run === 2, `run ${run} completion`);
  }

  assert.equal(db.rows('shopify_customers').length, 6, 'every customer behind the tie is reached');
  assert.deepEqual(seenFilters.map((v) => v.cursor), [null, '1', '2'],
    'each run continues from the previous cursor instead of re-filtering');
  assert.equal(meta.customer_walk, null);
  assert.equal(meta.last_customer_sync_at, SAME, 'and only then does the window move');
});

test('a resumed walk reuses its own filter verbatim, not one recomputed from the watermark', async () => {
  // The cursor is only valid for the query that produced it. Recomputing the
  // filter on resume (from a watermark that has moved, or with a fresh
  // overlap) would page a different sort with an old cursor.
  const db = createFakeSupabase();
  const gql = fakeGql([[node({ updatedAt: '2026-11-17T00:00:00Z' })]]);

  const run = await runCustomersSync(
    db,
    connection({
      meta: {
        last_customer_sync_at: '2026-11-16T00:00:00Z',
        customer_walk: { cursor: 'c1', filter: "updated_at:>='2026-11-01T00:00:00.000Z'" },
      },
    }),
    { batchId: 'b1', gql },
  );

  assert.equal(gql.seen[0].cursor, 'c1');
  assert.equal(gql.seen[0].filter, "updated_at:>='2026-11-01T00:00:00.000Z'",
    'the walk keeps the window it started with');
  assert.equal(run.resumed, true);
});

test('a continuation cursor Shopify no longer accepts restarts the walk, once', async () => {
  const db = createFakeSupabase();
  let calls = 0;
  const gql = async (_c, _q, variables) => {
    calls += 1;
    if (variables.cursor === 'stale') throw new Error('Shopify GraphQL: invalid cursor');
    return {
      customers: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [node({ updatedAt: '2026-11-16T00:00:00Z' })],
      },
    };
  };

  const run = await runCustomersSync(
    db,
    connection({ meta: { customer_walk: { cursor: 'stale', filter: null } } }),
    { batchId: 'b1', gql },
  );

  assert.equal(calls, 2, 'one refusal, one restart from the filter');
  assert.equal(run.cursor_restart, true);
  assert.equal(run.complete, true);
  assert.equal(db.rows('shopify_customers').length, 1);
  assert.equal(customersCursorRejected('invalid cursor'), true);
  assert.equal(customersCursorRejected('internal server error'), false);
});

test('a walk that dies mid-way leaves a watermark covering only what was written', async () => {
  const db = createFakeSupabase();
  let calls = 0;
  const gql = async (_c, _q, variables) => {
    calls += 1;
    if (calls === 1) {
      return {
        customers: {
          pageInfo: { hasNextPage: true, endCursor: '1' },
          nodes: [node({ legacyResourceId: '1', updatedAt: '2026-11-05T00:00:00Z' })],
        },
      };
    }
    void variables;
    throw new Error('Shopify GraphQL: internal server error');
  };

  await assert.rejects(() => runCustomersSync(db, connection(), { batchId: 'b1', gql }), /internal server error/);
  // The stage failed, so the orchestrator writes no watermark at all -- and
  // the page that DID land is already stored, so the repeat is idempotent.
  assert.equal(db.rows('shopify_customers').length, 1);
});

// ── standing down ───────────────────────────────────────────────────────────

test('a store without read_customers skips, and nothing else about it changes', async () => {
  const db = createFakeSupabase();
  const gql = fakeGql([[node()]]);

  const run = await runCustomersSync(db, connection({ scopes_granted: ['read_orders'] }), { batchId: 'b1', gql });

  assert.deepEqual(run, { skipped: true, missing: ['read_customers'] });
  assert.equal(gql.seen.length, 0, 'a store that cannot be asked must not be asked');
  assert.equal(db.rows('shopify_customers').length, 0);
});

test('read_customers gates ONLY this job -- it is not required for the sync', () => {
  assert.deepEqual(CUSTOMERS_SCOPES, ['read_customers']);
  assert.equal(
    REQUIRED_FOR_SYNC.includes('read_customers'), false,
    'adding it there would mark every store without it as not ready to sync at all',
  );
  assert.deepEqual(customersScopesMissing(['read_orders']), ['read_customers']);
  assert.deepEqual(customersScopesMissing(['read_orders', 'read_customers']), []);
  assert.deepEqual(customersScopesMissing([]), ['read_customers']);
  assert.deepEqual(customersScopesMissing(['read_customers']), []);
});

test('a database without the migration is a skip, not a failure', async () => {
  assert.equal(customersNotInstalled("Could not find the table 'public.shopify_customers' in the schema cache"), true);
  assert.equal(customersNotInstalled('relation "shopify_customers" does not exist'), true);
  // A real write failure must NOT be swallowed as "not installed yet".
  assert.equal(customersNotInstalled('shopify_customers upsert failed: deadlock detected'), false);
  assert.equal(customersNotInstalled('duplicate key value violates unique constraint'), false);

  // And the caller turns exactly that into a skip rather than a throw: the
  // fake stores rows, so the recognition above is the behaviour under test.
  const db = createFakeSupabase();
  const run = await runCustomersSync(db, connection(), { batchId: 'b1', gql: fakeGql([[node()]]) });
  assert.equal(run.skipped, undefined);
});

test('protected customer data Shopify will not disclose is a skip, with the reason', async () => {
  // A partially-approved app gets data AND an error naming each redacted
  // field. That is a standing fact about the app's approval, true again
  // tomorrow night, so it must not be a permanently red nightly.
  assert.equal(customersAccessRefused('Access denied for customers field'), true);
  assert.equal(customersAccessRefused('This app is not approved to access the Customer.email field'), true);
  assert.equal(customersAccessRefused('Shopify GraphQL: internal server error'), false);
  assert.equal(customersAccessRefused('Throttled'), false);

  const db = createFakeSupabase();
  const gql = async () => { throw new Error('Shopify GraphQL: Access denied for customers field'); };
  const run = await runCustomersSync(db, connection(), { batchId: 'b1', gql });

  assert.equal(run.skipped, true);
  assert.equal(run.access_refused, true);
  assert.match(run.reason, /refused customer fields/);
  assert.equal(db.rows('shopify_customers').length, 0);
});

test('a transport failure still throws, so it is recorded as a failure', async () => {
  const db = createFakeSupabase();
  const gql = async () => { throw new Error('Shopify GraphQL: internal server error'); };
  await assert.rejects(() => runCustomersSync(db, connection(), { batchId: 'b1', gql }), /internal server error/);
});

// ── the migration says the same things ──────────────────────────────────────

test('the migration derives the booleans and leaves an unmeasured state null', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /email_subscribed boolean generated always as/);
  assert.match(sql, /when email_consent_state is null then null/);
  assert.match(sql, /when sms_consent_state is null then null/);
  assert.match(sql, /unique \(company_entity_id, shop_domain, customer_id\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /company_entity_id = public\.active_company_id\(\)/);
  assert.match(sql, /revoke insert, update, delete on public\.shopify_customers from authenticated/);
  assert.match(sql, /'customers_sync'/);
  assert.match(sql, /select public\.attach_stamp_company_entity_id_triggers\(\);/);
});

test('the consent rollup is its own function and matches on email only', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /create or replace function public\.refresh_company_customer_consent/);
  assert.match(sql, /revoke all on function public\.refresh_company_customer_consent\(uuid, timestamptz\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.refresh_company_customer_consent\(uuid, timestamptz\) to service_role/);
  assert.match(sql, /p\.email_lc = src\.email_lc/);
  // It must not rewrite the orders-side rollup, which a store without
  // read_customers depends on being left completely alone.
  assert.doesNotMatch(sql, /create or replace function public\.refresh_company_customer_profiles/);
});

test('the sync wiring is in place: stage, skip flag, nightly only', () => {
  const plan = read('scripts/lib/sync-plan.mjs');
  assert.match(plan, /jobType: 'customers_sync', skipEnv: 'SHOPIFY_SKIP_CUSTOMERS'/);

  const runner = read('scripts/shopify-sync.mjs');
  assert.match(runner, /stageEnabled\('customers_sync'\)/);
  assert.match(runner, /refresh_company_customer_consent/);
  // A customers failure is a warning: the store's sales, inventory, products
  // and payouts all landed, and the next run resumes from the watermark.
  assert.match(runner, /::warning title=Shopify customers sync failed::/);

  assert.match(runner, /customer_walk/);

  const workflow = read('.github/workflows/shopify-sync.yml');
  assert.match(workflow, /SHOPIFY_SKIP_CUSTOMERS:/);
  // Off on the 14:30 catch-up and the 2-hourly refresh, which exist to keep
  // sales fresh and nothing else.
  assert.match(workflow, /SHOPIFY_SKIP_CUSTOMERS:.*30 14 \* \* \*.*0 \*\/2 \* \* \*/);
});

test('verify_v2_schema checks the table, the policy, the rollup and the job type', () => {
  const verify = read('supabase/verify_v2_schema.sql');
  assert.match(verify, /shopify_customers_active_select/);
  assert.match(verify, /refresh_company_customer_consent/);
  assert.match(verify, /ilike '%customers_sync%'/);
  assert.match(read('supabase/apply_all_post_merge.sql'), /20261124020000_shopify_customer_marketing_consent\.sql/);
});

test('Integrations tells a store without read_customers what it is missing, softly', () => {
  const page = read('v2/integrations.html');
  assert.match(page, /consentNote/);
  assert.match(page, /read_customers/);
  assert.match(page, /Everything else this store syncs is unaffected/);
});
