// The reconcile pass end to end: the real script, the real Supabase client,
// against a PostgREST stand-in.
//
// The sibling suite proves the decisions. This one proves the WIRING, which
// is where the damage would be: a column the script forgets to select reads
// as undefined and the connection is skipped in silence, a probe that drops
// its company filter reads another tenant's rows as evidence, and an insert
// that carries the wrong body queues a job no drainer can run. None of those
// are visible from the pure functions, and all of them are the kind of
// failure this pass exists to prevent in other people's syncs.
//
// The stand-in answers the three verbs the script uses -- GET a connection
// table, GET a data table, POST the bootstrap queue -- and records every
// request, so the assertions are about what actually went over the wire.

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';

const CO = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

/** The reconciler measures freshness against the PACIFIC business day
 *  (`pacificToday()` in scripts/reconcile-integrations.mjs), and `daysBetween()`
 *  compares the first ten characters of each value -- so every "today" the
 *  fixture seeds has to carry the Pacific date, including the timestamptz
 *  stamps, whose UTC date runs a day ahead between 00:00 and 08:00 UTC. Seeding
 *  `new Date().toISOString()` put the evidence a day ahead of the clock the code
 *  reads, "synced today" measured as -1 days behind, and the suite went red
 *  overnight and green by morning.
 *
 *  The sales feed is judged on the connection's own stamp (`last_sales_sync_at`),
 *  not on the newest `day_date`, so the stamp is the one that decided this
 *  failure; the day column is seeded the same way because it is compared against
 *  the same clock wherever a feed has no stamp. */
const PACIFIC_TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
/** An instant that falls on PACIFIC_TODAY, for the timestamptz stamps. */
const PACIFIC_TODAY_AT = `${PACIFIC_TODAY}T12:00:00-08:00`;

/** One Shopify store nobody ever imported, in a company of its own, plus the
 *  tables every other feed reads (empty, so those feeds say nothing). */
function fixture() {
  return {
    shopify_connections: [{
      id: 'conn-new', company_entity_id: CO, shop_domain: 'brandnew.myshopify.com',
      display_name: null, is_active: true, sync_enabled: false,
      last_test_status: 'ok', last_test_success: true, last_test_error: null, meta: {},
    }, {
      id: 'conn-live', company_entity_id: CO, shop_domain: 'live.myshopify.com',
      display_name: null, is_active: true, sync_enabled: true,
      last_test_status: 'ok', last_test_success: true, last_test_error: null,
      meta: { last_sales_sync_at: PACIFIC_TODAY_AT },
    }],
    sales_by_day: [{ day_date: PACIFIC_TODAY, shop_domain: 'live.myshopify.com', company_entity_id: CO },
      // The other company's copy of the new store: evidence that must NOT
      // count, because it is not this connection's company.
      { day_date: '2026-10-19', shop_domain: 'brandnew.myshopify.com', company_entity_id: OTHER }],
    inventory_on_hand: [{ snapshot_at: PACIFIC_TODAY_AT, shop_domain: 'live.myshopify.com', company_entity_id: CO }],
  };
}

/** The filters PostgREST was asked for, as {column: value}. */
function filters(url) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (['select', 'limit', 'order', 'offset'].includes(k)) continue;
    out[k] = v.replace(/^eq\./, '');
  }
  return out;
}

async function runPass(env = {}, rows = fixture(), { failTable = null } = {}) {
  const seen = [];
  const posted = [];
  const deleted = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const table = url.pathname.replace('/rest/v1/', '');
    if (table === failTable) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `${table} is unavailable` }));
      req.resume();
      return;
    }
    if (req.method === 'DELETE') {
      deleted.push({ table, where: filters(url) });
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        posted.push({ table, body: JSON.parse(body) });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('[]');
      });
      return;
    }
    const where = filters(url);
    seen.push({ table, where, select: url.searchParams.get('select'), order: url.searchParams.get('order') });
    const match = (rows[table] || []).filter((row) =>
      Object.entries(where).every(([col, val]) => {
        // `in.(a,b)`, which is how the sync_jobs lookup asks for its types.
        const set = /^in\.\((.*)\)$/.exec(val);
        if (set) return set[1].split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(row[col]));
        return String(row[col]) === val;
      }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(url.searchParams.get('limit') ? match.slice(0, 1) : match));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  const child = spawn(process.execPath, ['scripts/reconcile-integrations.mjs'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      RECONCILE_ONLY_FEED: 'sales',
      ...env,
    },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const code = await new Promise((done) => child.on('close', done));
  server.close();
  // Feed-health writes are separated out: every assertion about the queue
  // predates them and must keep meaning "nothing was QUEUED".
  return {
    code, out, seen, deleted,
    posted: posted.filter((p) => p.table !== 'integration_feed_health'),
    health: posted.filter((p) => p.table === 'integration_feed_health'),
  };
}

test('report-only: it names the store nobody imported and queues nothing', async () => {
  const { code, out, posted } = await runPass();
  assert.equal(posted.length, 0, 'the default run must write nothing at all');
  assert.match(out, /brandnew\.myshopify\.com/);
  assert.match(out, /never imported/);
  assert.match(out, /auto-start is off/i);
  assert.equal(code, 1, 'a connection nobody has imported is something a person must decide about');
});

test('the probe asks its own company, so another tenant rows are not evidence', async () => {
  const { seen } = await runPass();
  const probe = seen.find((s) => s.table === 'sales_by_day' && s.where.shop_domain === 'brandnew.myshopify.com');
  assert.ok(probe, 'the new store must be probed');
  assert.equal(probe.where.company_entity_id, CO);
  assert.equal(probe.order, 'day_date.desc', 'the newest row is the one that answers both questions');
});

// The narrowed probe (fastProbe on the sales feed). Asking the full question
// has no index to serve it and walked ~798k rows on production, past the
// statement timeout, so two of Baseballism's stores read 'unknown' every run.
// What matters is that the narrowing can only ever say YES faster: these pin
// both halves over the wire.
test('the narrowed probe is asked first, and a hit answers without the wider one', async () => {
  const rows = fixture();
  // live.myshopify.com has a row carrying the narrowing's value.
  rows.sales_by_day = [{ day_date: PACIFIC_TODAY, shop_domain: 'live.myshopify.com', company_entity_id: CO, source: 'shopify_api' }];
  const { seen } = await runPass({}, rows);
  const probes = seen.filter((s) => s.table === 'sales_by_day' && s.where.shop_domain === 'live.myshopify.com');
  assert.ok(probes.length >= 1, 'the store must be probed');
  assert.equal(probes[0].where.source, 'shopify_api', 'the narrowed ask goes first');
  assert.equal(probes[0].where.company_entity_id, CO, 'and it is still scoped to its own company');
  assert.equal(probes[0].order, 'day_date.desc');
  assert.equal(probes.length, 1, 'a hit answers the question, so the unnarrowed walk is never run');
});

test('a narrowed miss proves nothing and falls through to the full question', async () => {
  const rows = fixture();
  // A row for this store, but NOT one the narrowing can see. The verdict must
  // come from the wider ask, which still finds it -- a narrowed miss must
  // never read as "this connection never produced anything".
  rows.sales_by_day = [{ day_date: PACIFIC_TODAY, shop_domain: 'live.myshopify.com', company_entity_id: CO, source: 'legacy_csv' }];
  const { seen, out } = await runPass({}, rows);
  const probes = seen.filter((s) => s.table === 'sales_by_day' && s.where.shop_domain === 'live.myshopify.com');
  assert.equal(probes.length, 2, 'narrowed first, then the full question');
  assert.equal(probes[0].where.source, 'shopify_api');
  assert.equal(probes[1].where.source, undefined, 'the second ask carries no narrowing');
  assert.doesNotMatch(out, /live\.myshopify\.com[^\n]*never imported/, 'the row the wider ask found is still evidence');
});

// A sync that RAN and had nothing to write (production 2026-11-11: a store
// with nothing stocked, snapshot success, 0 rows). inventory_on_hand holds no
// history, so there is no watermark to read and the run record in sync_jobs is
// the only evidence the snapshot happened -- this pins that it is read, and
// that the pass stops calling it a failure.
test('a feed whose data is its own watermark reads the run record when it is empty', async () => {
  const rows = fixture();
  rows.inventory_on_hand = [];
  rows.sync_jobs = [{
    company_entity_id: CO, job_type: 'inventory_snapshot', status: 'success',
    started_at: PACIFIC_TODAY_AT, finished_at: PACIFIC_TODAY_AT, error: null,
  }];
  const { code, out, seen, health } = await runPass({ RECONCILE_ONLY_FEED: 'inventory' }, rows);
  const lookup = seen.find((s) => s.table === 'sync_jobs');
  assert.ok(lookup, 'the run record must actually be asked for');
  assert.equal(lookup.where.job_type, 'in.(inventory_snapshot)');
  assert.match(out, /wrote nothing/);
  assert.doesNotMatch(out, /the sync is failing/, 'nothing is failing here');
  const states = health.flatMap((h) => (Array.isArray(h.body) ? h.body : [h.body]))
    .filter((r) => r.feed === 'inventory').map((r) => [r.state, r.severity]);
  assert.ok(states.some(([state, severity]) => state === 'synced_but_empty' && severity === 'warn'),
    `expected a warn-level synced_but_empty, got ${JSON.stringify(states)}`);
  assert.equal(code, 0, 'and it does not fail the pass');
});

test('with no run record the same feed keeps the verdict it had', async () => {
  const rows = fixture();
  rows.inventory_on_hand = [];
  rows.sync_jobs = [];
  const { out, code } = await runPass({ RECONCILE_ONLY_FEED: 'inventory' }, rows);
  assert.match(out, /sync is failing|never imported/, 'no evidence must change nothing');
  assert.equal(code, 1);
});

test('with auto-start on it queues exactly one job, in the shape the drainer claims', async () => {
  const { code, out, posted } = await runPass({ RECONCILE_AUTO_START: 'true' });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].table, 'integration_bootstrap_jobs');
  assert.deepEqual(posted[0].body, {
    company_entity_id: CO, integration: 'shopify', connection_id: 'conn-new',
  });
  assert.match(out, /queueing its first import|queued/);
  assert.equal(code, 0, 'the pass fixed it, so the run is not a failure');
});

test('a dry run says what it would do and still writes nothing', async () => {
  const { posted, out } = await runPass({ RECONCILE_AUTO_START: 'true', RECONCILE_DRY_RUN: 'true' });
  assert.equal(posted.length, 0);
  assert.match(out, /would have queued/);
});

test('a connection with a bootstrap job behind it is left alone', async () => {
  const rows = fixture();
  rows.integration_bootstrap_jobs = [{
    id: 'job-1', company_entity_id: CO, integration: 'shopify', connection_id: 'conn-new',
    status: 'error', created_at: '2026-10-01T00:00:00Z', last_error: 'invalid token',
  }];
  const { posted, out } = await runPass({ RECONCILE_AUTO_START: 'true' }, rows);
  assert.equal(posted.length, 0, 're-queueing a failed first import every morning is a paid retry loop');
  assert.match(out, /already exists/);
});

test('a store that is syncing is not mentioned as a problem', async () => {
  const { out } = await runPass();
  const problems = out.split('\n').filter((l) => l.startsWith('  ['));
  assert.ok(problems.every((l) => !l.includes('live.myshopify.com')), 'a healthy store belongs in the count, not the list');
});

// ── Publishing the verdicts (20261103220000) ───────────────────────────────
// The judgement used to live in this log and nowhere else, which is how a
// stalled Plaid feed went eight days unnoticed with every sync green. These
// cover the wiring of putting it in the database: the row shape SILO reads,
// that an unjudged feed does not report a lag of 0, that a run prunes only
// what it looked at, and that a failed write cannot take the pass down with it.

test('every verdict is published for SILO to show, in the shape the view reads', async () => {
  const { health } = await runPass();
  assert.equal(health.length, 1, 'one upsert call carries the run');
  const rows = health[0].body;
  assert.equal(rows.length, 2, 'both stores are published, healthy one included');

  const brandnew = rows.find((r) => r.connection_id === 'conn-new');
  assert.equal(brandnew.company_entity_id, CO);
  assert.equal(brandnew.feed, 'sales');
  assert.equal(brandnew.state, 'never_imported');
  assert.equal(brandnew.severity, 'action');
  assert.equal(brandnew.connection_label, 'brandnew.myshopify.com');
  assert.equal(brandnew.integration, 'shopify');
  assert.equal(brandnew.tolerance_days, 1);
  assert.equal(brandnew.event_driven, false);
  assert.ok(brandnew.observed_at, 'the run stamps its own instant');
  assert.equal(brandnew.lag_days, null,
    'a connection that never imported has no lag: 0 would read as up to date');
  assert.equal(brandnew.measured_through, null);
  assert.match(brandnew.detail, /never imported/);

  const live = rows.find((r) => r.connection_id === 'conn-live');
  assert.equal(live.state, 'ok');
  assert.equal(live.severity, 'ok');
  assert.equal(live.lag_days, 0, 'a store that synced today is 0 days behind, which is a real measurement');

  assert.equal(new Set(rows.map((r) => r.observed_at)).size, 1,
    'one run, one instant -- the prune below depends on it');
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      assert.ok(!/token|secret|password|email/i.test(key), `${key} must not be published to every member of the company`);
    }
  }
});

test('a run prunes only the company and feed it actually looked at', async () => {
  const { deleted, health } = await runPass();
  const prune = deleted.find((d) => d.table === 'integration_feed_health');
  assert.ok(prune, 'a connection that has gone away must stop being reported');
  assert.match(prune.where.company_entity_id || '', /in\.|11111111/);
  assert.match(prune.where.feed || '', /in\.|sales/);
  const stamp = health[0].body[0].observed_at;
  assert.ok(String(prune.where.observed_at || '').includes(stamp.slice(0, 19)),
    'the prune is bounded by this run stamp, so a feed it skipped keeps its last verdict and ages honestly');
});

test('a dry run publishes nothing and says so', async () => {
  const { health, deleted, out } = await runPass({ RECONCILE_DRY_RUN: 'true' });
  assert.equal(health.length, 0);
  assert.equal(deleted.filter((d) => d.table === 'integration_feed_health').length, 0);
  assert.match(out, /would have published/);
});

test('a failed publish is reported loudly and does not change the pass', async () => {
  const clean = await runPass();
  const broken = await runPass({}, fixture(), { failTable: 'integration_feed_health' });
  assert.equal(broken.code, clean.code, 'the verdict about the client data is unchanged by our own write failing');
  assert.match(broken.out, /could not publish feed health/);
  assert.match(broken.out, /stale/, 'it must say what the consequence is, because the surface will look current');
  assert.match(broken.out, /brandnew\.myshopify\.com/, 'the log is still the primary output');
});
