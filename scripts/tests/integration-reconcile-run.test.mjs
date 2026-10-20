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
      meta: { last_sales_sync_at: new Date().toISOString() },
    }],
    sales_by_day: [{ day_date: new Date().toISOString().slice(0, 10), shop_domain: 'live.myshopify.com', company_entity_id: CO },
      // The other company's copy of the new store: evidence that must NOT
      // count, because it is not this connection's company.
      { day_date: '2026-10-19', shop_domain: 'brandnew.myshopify.com', company_entity_id: OTHER }],
    inventory_on_hand: [{ snapshot_at: new Date().toISOString(), shop_domain: 'live.myshopify.com', company_entity_id: CO }],
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

async function runPass(env = {}, rows = fixture()) {
  const seen = [];
  const posted = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const table = url.pathname.replace('/rest/v1/', '');
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
      Object.entries(where).every(([col, val]) => String(row[col]) === val));
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
  return { code, out, seen, posted };
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
