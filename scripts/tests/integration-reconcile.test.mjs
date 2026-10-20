// What the daily reconcile pass may say, and -- the part that matters -- what
// it may DO.
//
// The pass exists because SILO's only independent alarm covers two feeds and
// only looks at connections with sync_enabled = true, so a store nobody ever
// switched on is invisible to it. Measured on production 2026-10-13:
// suticompany was connected, tested OK, and had zero rows in sales_by_day
// since 2026-10-08, while baseballismchicago and baseballismdsg had ~1,500
// sync_jobs each and were switched off on purpose. Both pairs look identical
// in the connection row. Starting an import for the second pair would
// re-import a store somebody deliberately paused, so every test below that
// touches the write path is really asking: can this pass be talked into that?

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  INTEGRATION_FEEDS, EXPIRY_WARN_DAYS, coverageState, daysBetween, expiryState, feedCovers,
  clientBlock, freshnessState, integrationFor, interpretProbe, lastAttemptIso, mayAutoStart,
  planFirstImport, probeColumn,
  reconcileConnection, reconcileExitCode,
} from '../lib/integration-reconcile-core.mjs';
import { BOOTSTRAP_PLANS } from '../lib/integration-bootstrap-core.mjs';

const feed = (label) => INTEGRATION_FEEDS.find((f) => f.label === label);
const SCRIPT = fs.readFileSync(new URL('../reconcile-integrations.mjs', import.meta.url), 'utf8');
const WORKFLOW = fs.readFileSync(
  new URL('../../.github/workflows/reconcile-integrations.yml', import.meta.url), 'utf8',
);

/** A Shopify connection that tested OK and is switched off: the shape of all
 *  four production rows the enrolment work was built around. */
const offStore = (over = {}) => ({
  id: 'c1', company_entity_id: 'e1', shop_domain: 'suticompany.myshopify.com',
  is_active: true, sync_enabled: false, last_test_status: 'ok', meta: {}, ...over,
});

// ── Coverage: paused versus never started ──────────────────────────────────

test('a store with no data and no pause is the one to start', () => {
  assert.equal(coverageState({ connection: offStore(), everProduced: false }), 'never_imported');
  const v = reconcileConnection({ feed: feed('sales'), connection: offStore(), everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(v.state, 'never_imported');
  assert.equal(v.autoStart.start, true);
});

test('a pause outranks an empty table', () => {
  const paused = offStore({ meta: { sync_paused_at: '2026-09-20T00:00:00Z' } });
  assert.equal(coverageState({ connection: paused, everProduced: false }), 'paused');
  const v = reconcileConnection({ feed: feed('sales'), connection: paused, everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(v.autoStart.start, false, 'a store switched off before its first import is still switched off');
  assert.equal(v.severity, 'ok', 'a deliberate pause is not an alarm');
});

test('evidence we do not have never reads as startable', () => {
  for (const unknown of [null, undefined]) {
    const v = reconcileConnection({ feed: feed('sales'), connection: offStore(), everProduced: unknown, today: '2026-10-20', autoStart: true });
    assert.equal(v.state, 'unknown');
    assert.equal(v.autoStart.start, false, 'a failed probe must not be the reason an import starts');
    assert.equal(v.severity, 'warn');
  }
});

test('a sync that is already on and has produced nothing is a sync fault, not an enrolment one', () => {
  const on = offStore({ sync_enabled: true });
  assert.equal(coverageState({ connection: on, everProduced: false }), 'enabled_but_empty');
  const v = reconcileConnection({ feed: feed('sales'), connection: on, everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(v.severity, 'action');
  assert.equal(v.autoStart.start, false, 'queueing a bootstrap would paper over whatever is failing');
});

test('a connection that has synced before is never offered a first import', () => {
  // Production's Meta "App Review test" account: switched off, zero rows in
  // marketing_kpis_daily, and a last_sync_at from 2026-10-08. Reading only
  // the data would call that a store nobody ever imported and queue one.
  const conn = { id: 'a2', company_entity_id: 'e1', platform: 'meta_ads', is_active: true,
    sync_enabled: false, meta: { last_sync_at: '2026-10-08T05:44:46Z' } };
  const v = reconcileConnection({ feed: feed('marketing'), connection: conn, everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(v.state, 'synced_but_empty');
  assert.equal(v.autoStart.start, false);
  assert.equal(v.severity, 'action');
});

test('a storefront two companies hold is never imported into either by this pass', () => {
  // Production holds three such pairs; baseballismmlb's second copy, in
  // another company, has no rows and no stamp of its own, so on evidence
  // alone it reads as a store nobody ever imported. Which tenant is meant to
  // hold it has never been answered, and importing it into the wrong one
  // puts another company's sales in their books.
  const twin = offStore({ id: 'c2', company_entity_id: 'e2' });
  const v = reconcileConnection({ feed: feed('sales'), connection: twin, everProduced: false, today: '2026-10-20', autoStart: true, duplicate: true });
  assert.equal(v.state, 'duplicate_elsewhere');
  assert.equal(v.autoStart.start, false);
  assert.equal(v.severity, 'warn', 'it is a question for a person, not a daily failure');
  assert.match(v.detail, /suticompany/);
});

test('the probe asks only about the connection own company', () => {
  const probeBody = SCRIPT.slice(SCRIPT.indexOf('async function probe('), SCRIPT.indexOf('async function queueFirstImport('));
  assert.match(probeBody, /\.eq\('company_entity_id', conn\.company_entity_id\)/,
    "one company's rows are not evidence about another company's connection");
  assert.equal(feed('sales').identityColumn, 'shop_domain');
  assert.equal(feed('marketing').identityColumn, undefined, 'connection-id feeds cannot collide');
});

test('an inactive or failed connection is never started', () => {
  const inactive = reconcileConnection({ feed: feed('sales'), connection: offStore({ is_active: false }), everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(inactive.autoStart.start, false);
  const failed = reconcileConnection({ feed: feed('sales'), connection: offStore({ last_test_status: 'error', last_test_error: 'invalid token' }), everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(failed.state, 'connection_failed');
  assert.equal(failed.autoStart.start, false);
  assert.match(failed.detail, /invalid token/);
});

test('plaid connections are judged on status, not is_active', () => {
  assert.equal(coverageState({ connection: { status: 'revoked' }, everProduced: true }), 'inactive');
  assert.equal(coverageState({ connection: { status: 'active' }, everProduced: true }), 'covered');
});

// ── The write gate ─────────────────────────────────────────────────────────

test('auto-start stays off unless it is switched on', () => {
  const v = reconcileConnection({ feed: feed('sales'), connection: offStore(), everProduced: false, today: '2026-10-20' });
  assert.equal(v.autoStart.start, false);
  assert.equal(v.severity, 'action', 'report-only still has to report it');
});

test('feeds that cost money or have no plan are never started', () => {
  for (const label of ['seo_serp', 'banking', 'quickbooks']) {
    const v = mayAutoStart({ feed: feed(label), coverage: 'never_imported', autoStart: true });
    assert.equal(v.start, false, `${label} must never be started automatically`);
  }
});

test('never-auto-start beats having a plan', () => {
  // SERP and Plaid refuse twice over today (no plan AND the flag), so the
  // flag itself needs a feed that could otherwise be started: starting a
  // SERP run spends money at DataForSEO, and that must stay true the day
  // somebody adds a plan for it.
  const costly = { label: 'seo_serp', integration: 'shopify', neverAutoStart: true };
  const v = mayAutoStart({ feed: costly, coverage: 'never_imported', autoStart: true });
  assert.equal(v.start, false);
  assert.match(v.reason, /never started automatically/);
});

test('every startable feed names an integration the bootstrap drainer knows', () => {
  for (const f of INTEGRATION_FEEDS) {
    if (f.neverAutoStart) continue;
    if (f.integrationFromPlatform) {
      // The connection's own platform is the plan; the ad platforms it can
      // hold are exactly the ones with a plan, bar Search Console which is
      // its own feed.
      continue;
    }
    assert.ok(BOOTSTRAP_PLANS[f.integration], `${f.label} names integration "${f.integration}", which has no bootstrap plan`);
  }
  for (const platform of ['google_ads', 'ga4', 'meta_ads', 'tiktok_ads']) {
    assert.ok(BOOTSTRAP_PLANS[platform], `${platform} connections are startable but have no plan`);
    assert.equal(integrationFor(feed('marketing'), { platform }), platform);
  }
});

test('a prior bootstrap job of any kind stops a re-queue', () => {
  assert.equal(planFirstImport().queue, true);
  for (const status of ['pending', 'running', 'done', 'partial', 'error', 'cancelled']) {
    const plan = planFirstImport({ priorJob: { status, created_at: '2026-10-01T00:00:00Z' } });
    assert.equal(plan.queue, false, `a ${status} job must not be re-queued the next morning`);
    assert.match(plan.reason, new RegExp(status));
  }
});

test('a queue we cannot read is a queue we do not write', () => {
  const plan = planFirstImport({ priorError: { message: 'relation "integration_bootstrap_jobs" does not exist' } });
  assert.equal(plan.queue, false, 'inserting blind would lose the only guard against a re-import loop');
  assert.match(plan.reason, /unreadable/);
});

test('a dry run writes nothing', () => {
  assert.equal(planFirstImport({ dryRun: true }).queue, false);
  assert.match(planFirstImport({ dryRun: true }).reason, /would have queued/);
});

test('the script refuses the write through that one planner', () => {
  const body = SCRIPT.slice(SCRIPT.indexOf('async function queueFirstImport'));
  const planAt = body.indexOf('planFirstImport(');
  const insertAt = body.indexOf('.insert({');
  assert.ok(planAt > 0 && insertAt > planAt, 'the plan must be made before the insert');
  assert.match(body, /if \(!plan\.queue\) return/);
});

test('the queue insert carries only the three columns the page writes', () => {
  const insert = /\.insert\(\{([\s\S]*?)\}\)/.exec(SCRIPT.slice(SCRIPT.indexOf('queueFirstImport')))[1];
  const keys = [...insert.matchAll(/^\s*([a-z_]+)[,:]/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['company_entity_id', 'connection_id', 'integration'],
    'this pass enables nothing and edits no connection; it only queues the same job the page does');
});

// ── Freshness, per feed ────────────────────────────────────────────────────

test('each feed is judged by its own tolerance', () => {
  const sales = (stampIso) => freshnessState({ feed: feed('sales'), stampIso, today: '2026-10-20' }).state;
  assert.equal(sales('2026-10-20T01:06:17Z'), 'ok');
  assert.equal(sales('2026-10-18T01:06:17Z'), 'stale');
  // Search Console serves final data two days back and its sync runs in the
  // evening, so a 1-day tolerance here would be red most mornings.
  const sc = (stampIso) => freshnessState({ feed: feed('search_console'), stampIso, today: '2026-10-20' }).state;
  assert.equal(sc('2026-10-17T21:19:34Z'), 'ok');
  assert.equal(sc('2026-10-16T21:19:34Z'), 'stale');
  // Inventory has no connection stamp: the snapshot IS the attempt.
  assert.equal(freshnessState({ feed: feed('inventory'), newestIso: '2026-10-19', today: '2026-10-20' }).state, 'ok');
  assert.equal(freshnessState({ feed: feed('inventory'), newestIso: '2026-10-17', today: '2026-10-20' }).state, 'stale');
});

test('a store with no orders since March is not a broken store', () => {
  // Ten of production's 24 Shopify connections had a newest sales day months
  // old on 2026-10-20 while every one of them synced that morning:
  // sales_by_day holds a row per day that HAD sales. Judging freshness on
  // the newest day in the table would have opened this check with ten false
  // alarms, which is how a check stops being read.
  const seasonal = offStore({ sync_enabled: true, meta: { last_sales_sync_at: '2026-10-20T01:05:46Z' } });
  const v = reconcileConnection({ feed: feed('sales'), connection: seasonal, everProduced: true, newestIso: '2026-03-23', today: '2026-10-20' });
  assert.equal(v.state, 'ok');
  assert.equal(lastAttemptIso(feed('sales'), seasonal), '2026-10-20T01:05:46Z');
});

test('a store that stopped syncing is caught however much history it holds', () => {
  const stopped = offStore({ sync_enabled: true, meta: { last_sales_sync_at: '2026-10-07T05:21:22Z' } });
  const v = reconcileConnection({ feed: feed('sales'), connection: stopped, everProduced: true, newestIso: '2026-10-19', today: '2026-10-20' });
  assert.equal(v.state, 'stale');
  assert.equal(v.severity, 'action');
  assert.match(v.detail, /13d ago/);
});

test('data without a sync stamp of its own is reported, not called fresh', () => {
  // The duplicate connections: two rows share one shop_domain, so both see
  // the same sales history, and only the row that actually syncs carries a
  // stamp. Reading the shared data as freshness would call the dead twin
  // healthy.
  const twin = offStore({ sync_enabled: true, meta: {} });
  const v = reconcileConnection({ feed: feed('sales'), connection: twin, everProduced: true, newestIso: '2026-10-19', today: '2026-10-20' });
  assert.equal(v.state, 'never_synced');
  assert.equal(v.severity, 'action');
});

test('a store switched off with history behind it is paused, not stale', () => {
  // baseballismchicago and baseballismdsg: ~1,500 sync_jobs each, switched
  // off on 2026-09-20. The same rule v2/integration-enrolment.js applies.
  const v = reconcileConnection({ feed: feed('sales'), connection: offStore({ sync_enabled: false }), everProduced: true, today: '2026-10-20', autoStart: true });
  assert.equal(v.state, 'paused');
  assert.equal(v.severity, 'ok');
  assert.equal(v.autoStart.start, false);
});

test('an account only the client can fix is reported once, not red every morning', () => {
  // ad-platforms-sync stamps meta.client_side_block for a cancelled Google
  // Ads account or an ad account Meta has blocked, and clears it on the next
  // success. One of those used to turn two workflows red on every run.
  const conn = { id: 'a1', company_entity_id: 'e1', platform: 'meta_ads', is_active: true, sync_enabled: true,
    meta: { last_sync_at: '2026-10-07T05:21:22Z', client_side_block: { reason: 'ad account is disabled', at: '2026-10-20T00:59:36Z' } } };
  const v = reconcileConnection({ feed: feed('marketing'), connection: conn, everProduced: true, today: '2026-10-20' });
  assert.equal(v.state, 'client_blocked');
  assert.equal(v.severity, 'warn', 'SILO cannot fix a dead client account, so it must not fail the run daily');
  assert.match(v.detail, /account owner/);
  assert.equal(clientBlock({ meta: {} }), null);
});

test('a quiet returns feed is not a broken one', () => {
  const f = feed('redo');
  assert.equal(f.eventDriven, true);
  const v = reconcileConnection({ feed: f, connection: { id: 'r1', company_entity_id: 'e1', is_active: true, last_event_at: '2026-01-02T00:00:00Z' }, everProduced: true, newestIso: null, today: '2026-10-20' });
  assert.equal(v.severity, 'ok', 'a store with no returns this month is not an outage');
});

test('a webhook that arrived counts as evidence even with no rows behind it', () => {
  const f = feed('redo');
  const conn = { id: 'r1', company_entity_id: 'e1', is_active: true, last_event_at: '2026-10-19T00:00:00Z' };
  assert.equal(interpretProbe({ feed: f, connection: conn, row: null, error: null }).everProduced, true);
  assert.equal(interpretProbe({ feed: f, connection: { ...conn, last_event_at: null }, row: null, error: null }).everProduced, false);
});

test('a probe error answers neither question', () => {
  const p = interpretProbe({ feed: feed('sales'), connection: offStore(), row: null, error: { message: 'relation does not exist' } });
  assert.equal(p.everProduced, null);
  assert.equal(p.newestIso, null);
  assert.match(p.note, /relation does not exist/);
});

test('a probe reads the newest row through the column its feed orders by', () => {
  assert.equal(probeColumn(feed('sales')), 'day_date');
  assert.equal(probeColumn(feed('inventory')), 'snapshot_at');
  assert.equal(probeColumn(feed('redo')), null);
  const p = interpretProbe({ feed: feed('inventory'), connection: offStore(), row: { snapshot_at: '2026-10-19T14:00:00Z' }, error: null });
  assert.equal(p.newestIso, '2026-10-19');
});

// ── Expiry ─────────────────────────────────────────────────────────────────

test('an authorisation about to run out is the loudest thing here', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const soon = new Date(now.getTime() + 10 * 86400000).toISOString();
  const v = reconcileConnection({ feed: feed('quickbooks'), connection: { id: 'q1', company_entity_id: 'e1', is_active: true, refresh_token_expires_at: soon }, everProduced: true, today: '2026-10-20', now });
  assert.equal(v.state, 'expiring');
  assert.equal(v.severity, 'action');
  assert.match(v.detail, /re-authorise/);
  const far = new Date(now.getTime() + (EXPIRY_WARN_DAYS + 5) * 86400000).toISOString();
  assert.equal(expiryState({ expiresAt: far, now }).state, 'ok');
});

test('a connection nobody uses does not shout about its token', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const soon = new Date(now.getTime() + 3 * 86400000).toISOString();
  const v = reconcileConnection({ feed: feed('quickbooks'), connection: { id: 'q1', company_entity_id: 'e1', is_active: false, refresh_token_expires_at: soon }, everProduced: true, today: '2026-10-20', now });
  assert.equal(v.severity, 'ok');
});

test('a connection with no expiry column is simply judged on its data', () => {
  assert.equal(expiryState({ expiresAt: null }).state, 'n/a');
  assert.equal(expiryState({ expiresAt: 'not a date' }).state, 'n/a');
});

// ── Feed wiring ────────────────────────────────────────────────────────────

test('search console and marketing share a table and are not the same feed', () => {
  assert.equal(feedCovers(feed('marketing'), { platform: 'search_console' }), false);
  assert.equal(feedCovers(feed('marketing'), { platform: 'google_ads' }), true);
  assert.equal(feedCovers(feed('search_console'), { platform: 'search_console' }), true);
  assert.equal(feedCovers(feed('search_console'), { platform: 'meta_ads' }), false);
});

test('every feed can actually read the column it matches on', () => {
  // A connColumn the script does not SELECT reads as undefined, and the probe
  // then skips the connection silently -- the exact failure this pass exists
  // to prevent.
  const lists = [...SCRIPT.matchAll(/^\s{2}(\w+): '([^']+)',$/gm)]
    .reduce((acc, m) => ({ ...acc, [m[1]]: m[2].split(',').map((c) => c.trim()) }), {});
  for (const f of INTEGRATION_FEEDS) {
    const cols = lists[f.connTable];
    assert.ok(cols, `${f.connTable} has no column list in the script`);
    assert.ok(cols.includes('id') && cols.includes('company_entity_id'), `${f.connTable} must select its keys`);
    if (f.match) assert.ok(cols.includes(f.match.connColumn), `${f.label} matches on ${f.match.connColumn}, which the script does not select`);
    if (f.expiryColumn) assert.ok(cols.includes(f.expiryColumn), `${f.label} reads ${f.expiryColumn}, which the script does not select`);
    if (f.activityColumn) assert.ok(cols.includes(f.activityColumn), `${f.label} reads ${f.activityColumn}, which the script does not select`);
  }
});

test('no connection table is read with select(*)', () => {
  assert.doesNotMatch(SCRIPT, /\.select\('\*'\)/, 'selecting * pulls access tokens into this process and its logs');
});

test('the pass covers every integration SILO can connect', () => {
  const covered = new Set(INTEGRATION_FEEDS.map((f) => f.connTable));
  for (const table of ['shopify_connections', 'ad_platform_connections', 'redo_connections',
    'plaid_connections', 'quickbooks_connections', 'seo_serp_schedules']) {
    assert.ok(covered.has(table), `${table} has no feed, so nothing would ever notice it going quiet`);
  }
});

// ── The run's verdict ──────────────────────────────────────────────────────

test('a first import this pass started is not a failure', () => {
  const started = reconcileConnection({ feed: feed('sales'), connection: offStore(), everProduced: false, today: '2026-10-20', autoStart: true });
  assert.equal(reconcileExitCode([started]), 0, 'the pass fixed it; failing the run would just be noise');
  const reported = reconcileConnection({ feed: feed('sales'), connection: offStore(), everProduced: false, today: '2026-10-20' });
  assert.equal(reconcileExitCode([reported]), 1);
  assert.equal(reconcileExitCode([]), 0);
});

test('a warning does not fail the run', () => {
  const warn = reconcileConnection({ feed: feed('sales'), connection: offStore(), everProduced: null, today: '2026-10-20' });
  assert.equal(reconcileExitCode([warn]), 0, 'a check that is red for something nobody can act on is a check nobody reads');
});

test('day arithmetic survives a timestamp in place of a day', () => {
  assert.equal(daysBetween('2026-10-20', '2026-10-19T23:00:00Z'), 1);
  assert.equal(daysBetween('2026-10-20', 'nonsense'), null);
});

// ── The workflow ───────────────────────────────────────────────────────────

test('the scheduled run is report-only until somebody changes the default', () => {
  assert.match(WORKFLOW, /RECONCILE_AUTO_START: \$\{\{ github\.event\.inputs\.auto_start \|\| 'false' \}\}/,
    'day one must start nothing on its own');
  assert.match(WORKFLOW, /node scripts\/reconcile-integrations\.mjs/);
  assert.match(WORKFLOW, /cron: "0 15 \* \* \*"/);
});
