// scripts/tests/integration-bootstrap.test.mjs -- the plan, the resume and
// the page's reading of a first-connect bootstrap job.
//
// What these cover, in the order that matters:
//   * every integration has a plan, and an unknown one FAILS rather than
//     reporting a job complete having run nothing;
//   * the Shopify plan splits the long history stage from the rest, and
//     scopes both to one connection;
//   * a resumed job re-runs only what it still owes, which is what stops a
//     retry paying twice for the same API calls;
//   * the outcome of a half-finished attempt is `partial`, not success and
//     not failure;
//   * the browser's STAGES label table has not drifted from the plan the
//     drainer executes -- a drifted label would show "7 of 7" while two
//     stages were still owed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BOOTSTRAP_PLANS,
  BOOTSTRAP_DEFAULTS,
  planBootstrap,
  pendingStages,
  bootstrapOutcome,
  withStageResult,
  bootstrapProgress,
} from '../lib/integration-bootstrap-core.mjs';

let count = 0;
let failures = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok   ${name}`); } catch (err) {
    failures++; console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const shopJob = {
  id: 'j1', integration: 'shopify', company_entity_id: 'co-1',
  connection_id: 'conn-1', status: 'pending', stages: {}, attempts: 1,
};

// ── The plan exists for every integration the table accepts ────────────────

// The CHECK constraint in 20261013060000 and this plan table have to agree:
// an integration the table accepts but nothing can plan is a row that sits in
// the queue for ever, and one the table rejects can never be enqueued.
const MIGRATION = fs.readFileSync(
  new URL('../../supabase/migrations/20261013060000_integration_bootstrap_jobs.sql', import.meta.url),
  'utf8',
);

test('every integration in the table CHECK has a plan, and vice versa', () => {
  const block = MIGRATION.match(/integration text not null check \(integration in \(([\s\S]*?)\)\)/);
  assert.ok(block, 'could not find the integration CHECK in the migration');
  const inCheck = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
  const planned = Object.keys(BOOTSTRAP_PLANS).sort();
  assert.deepEqual(inCheck, planned);
});

test('an unknown integration throws rather than planning nothing', () => {
  assert.throws(
    () => planBootstrap({ ...shopJob, integration: 'quickbooks' }),
    /No bootstrap plan/,
  );
});

test('a job with no company throws', () => {
  assert.throws(() => planBootstrap({ ...shopJob, company_entity_id: null }), /company_entity_id/);
});

test('a per-connection job with no connection throws', () => {
  assert.throws(() => planBootstrap({ ...shopJob, connection_id: null }), /connection_id/);
});

test('redo plans without a connection id, because its scripts take the company', () => {
  const planned = planBootstrap(
    { integration: 'redo', company_entity_id: 'co-1', connection_id: null, stages: {} },
    { connection: { api_secret: 'tok' } },
  );
  assert.deepEqual(planned.map((s) => s.stage), ['returns_backfill', 'marketing']);
  assert.equal(planned[0].env.REDO_COMPANY_ENTITY_ID, 'co-1');
});

// ── Shopify: the long stage runs alone, and both stages are scoped ─────────

test('Shopify is two stages: history first, then everything else', () => {
  const planned = planBootstrap(shopJob);
  assert.deepEqual(planned.map((s) => s.stage), ['sales_history', 'storefront']);
  assert.equal(planned[0].env.SHOPIFY_SYNC_MODE, 'history');
  // NOT 'full': full mode includes history_import, so the second stage would
  // re-import what the first one just fetched.
  assert.equal(planned[1].env.SHOPIFY_SYNC_MODE, 'incremental');
});

test('the history stage skips every other stage, so a resume re-fetches only orders', () => {
  const [history] = planBootstrap(shopJob);
  for (const key of [
    'SHOPIFY_SKIP_INVENTORY', 'SHOPIFY_SKIP_CATALOG', 'SHOPIFY_SKIP_SESSIONS',
    'SHOPIFY_SKIP_LANDING_PAGES', 'SHOPIFY_SKIP_DISCOUNT_CODES',
    'SHOPIFY_SKIP_DRAFT_ORDERS', 'SHOPIFY_SKIP_PAYOUTS',
  ]) {
    assert.equal(history.env[key], 'true', `${key} should be skipped in the history stage`);
  }
});

test('both Shopify stages are scoped to the one connection', () => {
  for (const stage of planBootstrap(shopJob)) {
    assert.equal(stage.env.SHOPIFY_ONLY_CONNECTION_ID, 'conn-1');
  }
});

test('the first sync asks for 60 days of history, which is what a store without read_all_orders can return', () => {
  assert.equal(BOOTSTRAP_DEFAULTS.shopifyHistoryDays, 60);
  assert.equal(planBootstrap(shopJob)[0].env.SHOPIFY_HISTORY_DAYS, '60');
});

test('collections is enabled for a first sync, and only there', () => {
  const [, storefront] = planBootstrap(shopJob);
  assert.equal(storefront.env.SHOPIFY_COLLECTIONS_ENABLED, 'true');
});

test('options override the defaults', () => {
  const [history] = planBootstrap(shopJob, { options: { shopifyHistoryDays: 365 } });
  assert.equal(history.env.SHOPIFY_HISTORY_DAYS, '365');
});

// ── Ad platforms and Search Console ───────────────────────────────────────

test('an ad connection syncs its own platform only, and leaves Search Console alone', () => {
  const planned = planBootstrap({
    integration: 'meta_ads', company_entity_id: 'co-1', connection_id: 'ad-9', stages: {},
  });
  assert.deepEqual(planned.map((s) => s.stage), ['kpis']);
  assert.equal(planned[0].env.ADS_ONLY_PLATFORM, 'meta_ads');
  assert.equal(planned[0].env.ADS_ONLY_CONNECTION_ID, 'ad-9');
  // Search Console is its own integration row with its own much longer
  // backfill; running it here would do it twice.
  assert.equal(planned[0].env.ADS_SKIP_SEARCH_CONSOLE, 'true');
});

test('a newly connected ad account does not skip organic posts', () => {
  const [kpis] = planBootstrap({
    integration: 'meta_ads', company_entity_id: 'co-1', connection_id: 'ad-9', stages: {},
  });
  assert.equal(kpis.env.ADS_SKIP_ORGANIC, undefined);
});

test('Search Console gets its own backfill stage', () => {
  const planned = planBootstrap({
    integration: 'search_console', company_entity_id: 'co-1', connection_id: 'sc-1', stages: {},
  });
  assert.deepEqual(planned.map((s) => s.stage), ['backfill']);
  assert.equal(planned[0].env.SC_CONNECTION_ID, 'sc-1');
  assert.equal(planned[0].script, 'scripts/search-console-backfill.mjs');
});

// ── Prerequisites: skipped is a recorded fact, not an omission ─────────────

test('Redo without an API secret records both stages skipped with a reason', () => {
  const planned = planBootstrap(
    { integration: 'redo', company_entity_id: 'co-1', connection_id: null, stages: {} },
    { connection: { api_secret: null } },
  );
  assert.deepEqual(planned.map((s) => s.skip), ['missing api_secret', 'missing api_secret']);
  // Present, not omitted: an omitted stage would make the job look complete
  // for a different reason than it was.
  assert.equal(planned.length, 2);
});

test('a stage with its prerequisite met is not skipped', () => {
  const planned = planBootstrap(
    { integration: 'redo', company_entity_id: 'co-1', connection_id: null, stages: {} },
    { connection: { api_secret: 'tok' } },
  );
  assert.deepEqual(planned.map((s) => s.skip), [null, null]);
});

// ── Resume: only what is still owed ───────────────────────────────────────

test('a finished stage is not run again', () => {
  const job = { ...shopJob, stages: { sales_history: { status: 'done' } } };
  const owed = pendingStages(job, planBootstrap(job));
  assert.deepEqual(owed.map((s) => s.stage), ['storefront']);
});

test('a skipped stage counts as finished', () => {
  const job = {
    integration: 'redo', company_entity_id: 'co-1', connection_id: null,
    stages: { returns_backfill: { status: 'skipped' }, marketing: { status: 'skipped' } },
  };
  assert.deepEqual(pendingStages(job, planBootstrap(job, { connection: { api_secret: null } })), []);
});

test('an errored stage IS owed again -- the attempt cap is what ends retrying', () => {
  const job = { ...shopJob, stages: { sales_history: { status: 'error', detail: 'exit code 1' } } };
  const owed = pendingStages(job, planBootstrap(job));
  assert.deepEqual(owed.map((s) => s.stage), ['sales_history', 'storefront']);
});

test('a stage left running by a killed runner is owed again', () => {
  const job = { ...shopJob, stages: { sales_history: { status: 'running' } } };
  assert.equal(pendingStages(job, planBootstrap(job)).length, 2);
});

// ── Outcome ───────────────────────────────────────────────────────────────

test('all stages done is done', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'done' }, b: { status: 'done' } }), 'done');
});

test('done plus skipped is still done', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'done' }, b: { status: 'skipped' } }), 'done');
});

test('some landed and one failed is partial, not success and not failure', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'done' }, b: { status: 'error' } }), 'partial');
});

test('nothing landed is error', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'error' } }), 'error');
});

test('no stage recorded at all is still pending', () => {
  assert.equal(bootstrapOutcome({}), 'pending');
});

// ── Stage records merge rather than replace ───────────────────────────────

test('recording one stage keeps the others', () => {
  const first = withStageResult({}, 'sales_history', 'done', '93s');
  const second = withStageResult(first, 'storefront', 'running', null);
  assert.deepEqual(Object.keys(second).sort(), ['sales_history', 'storefront']);
  assert.equal(second.sales_history.status, 'done');
  assert.equal(second.sales_history.detail, '93s');
});

test('a stage detail is truncated rather than storing an entire stack trace', () => {
  const rec = withStageResult({}, 'sales_history', 'error', 'x'.repeat(5000));
  assert.equal(rec.sales_history.detail.length, 2000);
});

// ── Progress ─────────────────────────────────────────────────────────────

test('progress counts finished stages and names the running one', () => {
  const job = {
    ...shopJob,
    stages: { sales_history: { status: 'done' }, storefront: { status: 'running' } },
  };
  assert.deepEqual(bootstrapProgress(job, planBootstrap(job)), {
    done: 1, total: 2, running: 'storefront',
  });
});

// ── The browser's label table must not drift from the plan ───────────────

test("v2/integration-bootstrap.js lists exactly the plan's stages, in order", () => {
  const js = fs.readFileSync(new URL('../../v2/integration-bootstrap.js', import.meta.url), 'utf8');
  const block = js.match(/const STAGES = \{([\s\S]*?)\n  \};/);
  assert.ok(block, 'could not find the STAGES table in v2/integration-bootstrap.js');
  // integration -> the stage keys it lists, parsed from the ['key', 'label']
  // pairs, so the test reads the same text a reviewer does.
  const listed = {};
  let current = null;
  for (const line of block[1].split('\n')) {
    const head = line.match(/^\s{4}([a-z0-9_]+):\s*\[/);
    if (head) { current = head[1]; listed[current] = []; }
    for (const m of line.matchAll(/\['([a-z0-9_]+)',/g)) listed[current].push(m[1]);
  }
  for (const [integration, plan] of Object.entries(BOOTSTRAP_PLANS)) {
    assert.deepEqual(
      listed[integration],
      plan.map((s) => s.stage),
      `v2/integration-bootstrap.js STAGES.${integration} has drifted from the plan`,
    );
  }
  assert.deepEqual(Object.keys(listed).sort(), Object.keys(BOOTSTRAP_PLANS).sort());
});

// ── The page must not treat "Test" on an old store as a first connect ────

test('the Shopify Test button only bootstraps a store that has never synced', () => {
  const html = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const retest = html.slice(html.indexOf('async function retest(id)'));
  const body = retest.slice(0, retest.indexOf('\n    function '));
  // The same button says "Connect" for a new store and "Re-test" for one
  // that has been syncing for a year. Without this gate, pressing it on an
  // established store would switch sync on (already on) and queue a 60-day
  // history re-import: a paid call, and a write over data that is already
  // there.
  assert.match(body, /sync_enabled, last_test_success/, 'retest must read the flags BEFORE the test overwrites them');
  assert.match(body, /const neverSynced = !conn\.sync_enabled && !conn\.last_test_success;/);
  assert.match(
    body,
    /if \(neverSynced\) \{\s*\n\s*await firstConnectBootstrap\('shopify'/,
    'the bootstrap call must be gated on neverSynced',
  );
});

test('both Shopify stages tell the child it is a manual-grade run', () => {
  // sync-plan.mjs reads SHOPIFY_RUN_KIND: a nightly tolerates losing a
  // secondary stage, a hand-dispatched backfill does not. A first import is
  // the second kind -- reporting success having lost the stage it exists for
  // is the failure this whole feature was built to remove.
  for (const stage of planBootstrap(shopJob)) {
    assert.equal(stage.env.SHOPIFY_RUN_KIND, 'manual');
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
