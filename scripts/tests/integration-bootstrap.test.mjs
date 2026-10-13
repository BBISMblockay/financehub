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
import vm from 'node:vm';
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
// Async-aware: the browser-module cases below await a fake PostgREST call.
async function test(name, fn) {
  count++;
  try { await fn(); console.log(`  ok   ${name}`); } catch (err) {
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

await test('every integration in the table CHECK has a plan, and vice versa', () => {
  const block = MIGRATION.match(/integration text not null check \(integration in \(([\s\S]*?)\)\)/);
  assert.ok(block, 'could not find the integration CHECK in the migration');
  const inCheck = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
  const planned = Object.keys(BOOTSTRAP_PLANS).sort();
  assert.deepEqual(inCheck, planned);
});

await test('an unknown integration throws rather than planning nothing', () => {
  assert.throws(
    () => planBootstrap({ ...shopJob, integration: 'quickbooks' }),
    /No bootstrap plan/,
  );
});

await test('a job with no company throws', () => {
  assert.throws(() => planBootstrap({ ...shopJob, company_entity_id: null }), /company_entity_id/);
});

await test('a per-connection job with no connection throws', () => {
  assert.throws(() => planBootstrap({ ...shopJob, connection_id: null }), /connection_id/);
});

await test('redo plans without a connection id, because its scripts take the company', () => {
  const planned = planBootstrap(
    { integration: 'redo', company_entity_id: 'co-1', connection_id: null, stages: {} },
    { connection: { api_secret: 'tok' } },
  );
  assert.deepEqual(planned.map((s) => s.stage), ['returns_backfill', 'marketing']);
  assert.equal(planned[0].env.REDO_COMPANY_ENTITY_ID, 'co-1');
});

// ── Shopify: the long stage runs alone, and both stages are scoped ─────────

await test('Shopify is two stages: history first, then everything else', () => {
  const planned = planBootstrap(shopJob);
  assert.deepEqual(planned.map((s) => s.stage), ['sales_history', 'storefront']);
  assert.equal(planned[0].env.SHOPIFY_SYNC_MODE, 'history');
  // NOT 'full': full mode includes history_import, so the second stage would
  // re-import what the first one just fetched.
  assert.equal(planned[1].env.SHOPIFY_SYNC_MODE, 'incremental');
});

await test('the history stage skips every other stage, so a resume re-fetches only orders', () => {
  const [history] = planBootstrap(shopJob);
  for (const key of [
    'SHOPIFY_SKIP_INVENTORY', 'SHOPIFY_SKIP_CATALOG', 'SHOPIFY_SKIP_SESSIONS',
    'SHOPIFY_SKIP_LANDING_PAGES', 'SHOPIFY_SKIP_DISCOUNT_CODES',
    'SHOPIFY_SKIP_DRAFT_ORDERS', 'SHOPIFY_SKIP_PAYOUTS',
  ]) {
    assert.equal(history.env[key], 'true', `${key} should be skipped in the history stage`);
  }
});

await test('both Shopify stages are scoped to the one connection', () => {
  for (const stage of planBootstrap(shopJob)) {
    assert.equal(stage.env.SHOPIFY_ONLY_CONNECTION_ID, 'conn-1');
  }
});

await test('the first sync asks for 60 days of history, which is what a store without read_all_orders can return', () => {
  assert.equal(BOOTSTRAP_DEFAULTS.shopifyHistoryDays, 60);
  assert.equal(planBootstrap(shopJob)[0].env.SHOPIFY_HISTORY_DAYS, '60');
});

await test('collections is enabled for a first sync, and only there', () => {
  const [, storefront] = planBootstrap(shopJob);
  assert.equal(storefront.env.SHOPIFY_COLLECTIONS_ENABLED, 'true');
});

await test('options override the defaults', () => {
  const [history] = planBootstrap(shopJob, { options: { shopifyHistoryDays: 365 } });
  assert.equal(history.env.SHOPIFY_HISTORY_DAYS, '365');
});

// ── Ad platforms and Search Console ───────────────────────────────────────

await test('an ad connection syncs its own platform only, and leaves Search Console alone', () => {
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

await test('a newly connected ad account does not skip organic posts', () => {
  const [kpis] = planBootstrap({
    integration: 'meta_ads', company_entity_id: 'co-1', connection_id: 'ad-9', stages: {},
  });
  assert.equal(kpis.env.ADS_SKIP_ORGANIC, undefined);
});

await test('Search Console gets its own backfill stage', () => {
  const planned = planBootstrap({
    integration: 'search_console', company_entity_id: 'co-1', connection_id: 'sc-1', stages: {},
  });
  assert.deepEqual(planned.map((s) => s.stage), ['backfill']);
  assert.equal(planned[0].env.SC_CONNECTION_ID, 'sc-1');
  assert.equal(planned[0].script, 'scripts/search-console-backfill.mjs');
});

// ── Prerequisites: skipped is a recorded fact, not an omission ─────────────

await test('Redo without an API secret records both stages skipped with a reason', () => {
  const planned = planBootstrap(
    { integration: 'redo', company_entity_id: 'co-1', connection_id: null, stages: {} },
    { connection: { api_secret: null } },
  );
  assert.deepEqual(planned.map((s) => s.skip), ['missing api_secret', 'missing api_secret']);
  // Present, not omitted: an omitted stage would make the job look complete
  // for a different reason than it was.
  assert.equal(planned.length, 2);
});

await test('a stage with its prerequisite met is not skipped', () => {
  const planned = planBootstrap(
    { integration: 'redo', company_entity_id: 'co-1', connection_id: null, stages: {} },
    { connection: { api_secret: 'tok' } },
  );
  assert.deepEqual(planned.map((s) => s.skip), [null, null]);
});

// ── Resume: only what is still owed ───────────────────────────────────────

await test('a finished stage is not run again', () => {
  const job = { ...shopJob, stages: { sales_history: { status: 'done' } } };
  const owed = pendingStages(job, planBootstrap(job));
  assert.deepEqual(owed.map((s) => s.stage), ['storefront']);
});

await test('a skipped stage counts as finished', () => {
  const job = {
    integration: 'redo', company_entity_id: 'co-1', connection_id: null,
    stages: { returns_backfill: { status: 'skipped' }, marketing: { status: 'skipped' } },
  };
  assert.deepEqual(pendingStages(job, planBootstrap(job, { connection: { api_secret: null } })), []);
});

await test('an errored stage IS owed again -- the attempt cap is what ends retrying', () => {
  const job = { ...shopJob, stages: { sales_history: { status: 'error', detail: 'exit code 1' } } };
  const owed = pendingStages(job, planBootstrap(job));
  assert.deepEqual(owed.map((s) => s.stage), ['sales_history', 'storefront']);
});

await test('a stage left running by a killed runner is owed again', () => {
  const job = { ...shopJob, stages: { sales_history: { status: 'running' } } };
  assert.equal(pendingStages(job, planBootstrap(job)).length, 2);
});

// ── Outcome ───────────────────────────────────────────────────────────────

await test('all stages done is done', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'done' }, b: { status: 'done' } }), 'done');
});

await test('done plus skipped is still done', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'done' }, b: { status: 'skipped' } }), 'done');
});

await test('some landed and one failed is partial, not success and not failure', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'done' }, b: { status: 'error' } }), 'partial');
});

await test('nothing landed is error', () => {
  assert.equal(bootstrapOutcome({ a: { status: 'error' } }), 'error');
});

await test('no stage recorded at all is still pending', () => {
  assert.equal(bootstrapOutcome({}), 'pending');
});

// ── Stage records merge rather than replace ───────────────────────────────

await test('recording one stage keeps the others', () => {
  const first = withStageResult({}, 'sales_history', 'done', '93s');
  const second = withStageResult(first, 'storefront', 'running', null);
  assert.deepEqual(Object.keys(second).sort(), ['sales_history', 'storefront']);
  assert.equal(second.sales_history.status, 'done');
  assert.equal(second.sales_history.detail, '93s');
});

await test('a stage detail is truncated rather than storing an entire stack trace', () => {
  const rec = withStageResult({}, 'sales_history', 'error', 'x'.repeat(5000));
  assert.equal(rec.sales_history.detail.length, 2000);
});

// ── Progress ─────────────────────────────────────────────────────────────

await test('progress counts finished stages and names the running one', () => {
  const job = {
    ...shopJob,
    stages: { sales_history: { status: 'done' }, storefront: { status: 'running' } },
  };
  assert.deepEqual(bootstrapProgress(job, planBootstrap(job)), {
    done: 1, total: 2, running: 'storefront',
  });
});

// ── The browser's label table must not drift from the plan ───────────────

await test("v2/integration-bootstrap.js lists exactly the plan's stages, in order", () => {
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

await test('the Shopify Test button only bootstraps a store that has never synced', () => {
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

await test('both Shopify stages tell the child it is a manual-grade run', () => {
  // sync-plan.mjs reads SHOPIFY_RUN_KIND: a nightly tolerates losing a
  // secondary stage, a hand-dispatched backfill does not. A first import is
  // the second kind -- reporting success having lost the stage it exists for
  // is the failure this whole feature was built to remove.
  for (const stage of planBootstrap(shopJob)) {
    assert.equal(stage.env.SHOPIFY_RUN_KIND, 'manual');
  }
});

// ── The browser module, loaded the way the browser loads it ──────────────

const sandbox = { window: {} };
vm.runInNewContext(
  fs.readFileSync(new URL('../../v2/integration-bootstrap.js', import.meta.url), 'utf8'),
  sandbox,
);
const SiloBootstrap = sandbox.window.SiloBootstrap;

// A tiny stand-in for the PostgREST builder: `answer` is what the terminal
// call resolves to, and `inserted` records what an insert carried.
function fakeDb(answer) {
  const calls = { inserted: null, selected: 0 };
  const chain = {
    select() { calls.selected++; return chain; },
    eq() { return chain; },
    is() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    insert(row) { calls.inserted = row; return Promise.resolve(answer); },
    then(res, rej) { return Promise.resolve(answer).then(res, rej); },
  };
  return { calls, from: () => chain };
}

await test('a queue read error is reported as an error, never as an existing job', async () => {
  // The likeliest read error is this feature's own rollout window: the
  // migration is not applied, so the table does not exist. Answering "a job
  // exists" would make the page skip the insert and tell the person nothing.
  const db = fakeDb({ data: null, error: { code: '42P01', message: 'relation "integration_bootstrap_jobs" does not exist' } });
  const out = await SiloBootstrap.latest(db, { companyId: 'co-1', integration: 'shopify', connectionId: 'c1' });
  assert.equal(out.code, '42P01');
  assert.match(out.error, /does not exist/);
  assert.equal(out.status, undefined, 'a read error must not look like a job with a status');
});

await test('a permission error reads the same way', async () => {
  const db = fakeDb({ data: null, error: { code: '42501', message: 'permission denied for table integration_bootstrap_jobs' } });
  const out = await SiloBootstrap.latest(db, { companyId: 'co-1', integration: 'redo' });
  assert.equal(out.code, '42501');
});

await test('no job and no error is simply nothing', async () => {
  const db = fakeDb({ data: [], error: null });
  assert.equal(await SiloBootstrap.latest(db, { companyId: 'co-1', integration: 'shopify', connectionId: 'c1' }), null);
});

await test('a duplicate insert is a success, because an open job already covers it', async () => {
  const db = fakeDb({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
  const res = await SiloBootstrap.enqueue(db, { companyId: 'co-1', integration: 'shopify', connectionId: 'c1' });
  // Field by field: the module runs in its own vm realm, so its objects do
  // not share this realm's Object.prototype and deepEqual would fail on that
  // rather than on the values.
  assert.equal(res.already, true);
  assert.equal(res.queued, false);
  assert.equal(res.error, null);
});

await test('an integration with no plan is refused in the browser too', async () => {
  const db = fakeDb({ error: null });
  const res = await SiloBootstrap.enqueue(db, { companyId: 'co-1', integration: 'quickbooks' });
  assert.match(res.error, /unknown integration/);
  assert.equal(db.calls.inserted, null);
});

// ── Something must land NOW, not only when the queue is drained ──────────

await test('connecting a store runs the deployed per-connection sync immediately', () => {
  const html = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const retest = html.slice(html.indexOf('async function retest(id)'));
  const body = retest.slice(0, retest.indexOf('\n    function '));
  // The 15-minute workflow is late often enough that it cannot be what makes
  // a first connect feel immediate. shopify-sync-run is already deployed and
  // already scoped to one connection, so the stock snapshot happens on the
  // spot and the queue does the long work.
  assert.match(body, /kick: async \(\) => \{[\s\S]*?action: 'inventory_snapshot', connection_id: id/);
  assert.equal((body.match(/action: 'inventory_snapshot'/g) || []).length, 1, 'exactly one immediate pull');
});

await test('choosing an ad account runs that platform\'s own sync immediately where one exists', () => {
  const html = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const chooser = html.slice(html.indexOf('async function chooseAccount(row, option)'));
  const body = chooser.slice(0, chooser.indexOf('\n    async function startAdOauth'));
  assert.match(body, /kick: SYNC_NOW_PLATFORMS\.includes\(row\.platform\)\s*\n\s*\? \(\) => syncAdConnection\(row\.id\)/);
  // Search Console and TikTok have no Sync now function; for them the queued
  // job is the only executor, and claiming otherwise in the UI would be a lie.
  assert.match(body, /: null/);
});

await test('the kick is best effort: a failed immediate pull never loses the queued job', () => {
  const html = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const fn = html.slice(html.indexOf('async function firstConnectBootstrap('));
  const body = fn.slice(0, fn.indexOf('\n    function renderBootstrapBand'));
  assert.match(body, /try \{ await kick\(\); \} catch/);
  // And a queue that could not be read or written still gets the kick: it is
  // then the only sync this connection will get until somebody presses a
  // button.
  const enqueueIdx = body.indexOf('SiloBootstrap.enqueue');
  assert.ok(body.indexOf('if (kick)') > enqueueIdx);
  assert.doesNotMatch(body.slice(body.indexOf('if (res.error)'), body.indexOf('if (kick)')), /return;/);
});

await test('the drainer leases one job at a time, not a batch', () => {
  const src = fs.readFileSync(new URL('../integration-bootstrap.mjs', import.meta.url), 'utf8');
  // A batch is leased when it is CLAIMED. A Shopify history stage can run
  // most of an hour, so a job sitting behind it in an array would lose its
  // 15-minute lease while doing nothing, and the next quarter-hour run would
  // claim it and start it while this process still intends to -- two paid
  // imports and two writers of the same stages JSON.
  assert.match(src, /p_limit: 1,/);
  const main = src.slice(src.indexOf('async function main()'));
  assert.match(main, /for \(let i = 0; i < Math\.max\(MAX_JOBS, 1\); i\+\+\) \{\s*\n\s*const job = await claimJob\(\);/);
  assert.doesNotMatch(main, /p_limit: MAX_JOBS/);
});

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
