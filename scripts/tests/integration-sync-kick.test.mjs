/** The immediate first sync for the company-scoped pillars
 * (supabase/functions/integration-sync-kick).
 *
 * Runs the REAL handler, and one case runs it wired to the REAL Klaviyo sync
 * core (the function's own copy) with Klaviyo answered by a fake fetch and
 * Supabase by an in-memory fake -- so the path a click takes is the path
 * tested, not a helper in isolation.
 *
 * Run: node scripts/tests/integration-sync-kick.test.mjs
 * Mutations (each must fail the suite): KICK_MUTATION=
 *   no-rls-check | no-flag-check | no-clamp | no-job-params | trust-body-id |
 *   skip-as-success | swallow-core-error | skip-message-dropped | page-no-kick |
 *   page-own-verdict
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = 'supabase/functions/integration-sync-kick';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.KICK_MUTATION || '';

const MUTATIONS = {
  // handler.mjs
  'no-rls-check': [
    "if (visErr || !visible) return json({ error: `No ${spec.label} connection found for this workspace` }, 404);",
    'const _unused = visErr;',
  ],
  'no-flag-check': ['const off = (spec.requireTrue || []).find((flag) => conn[flag] !== true);', 'const off = null;'],
  'no-clamp': ['return Math.min(days, MAX_KICK_DAYS);', 'return days;'],
  'no-job-params': ["jobParams: { trigger: 'kick', integration: key, days_back: daysBack },", ''],
  'trust-body-id': [".from(spec.table).select(spec.columns).eq('id', visible.id)", ".from(spec.table).select(spec.columns).eq('id', body?.connection_id || visible.id)"],
  'skip-as-success': ['if (out?.skipped) {', 'if (false) {'],
  'swallow-core-error': [
    "return json({ ok: false, error: String(err?.message ?? err).slice(0, 800) }, 502);",
    'out = { window: null };',
  ],
  'skip-message-dropped': ['return SKIP_MESSAGES[reason] || `Nothing was synced (${reason}).`;', "return 'Nothing was synced.';"],
  // index.ts
  'no-oauth-env': ['syncKlaviyoConnection({ ...args, ...klaviyoOauth })', 'syncKlaviyoConnection({ ...args })'],
  // v2/integrations.html
  'page-no-kick': ["          const out = await integrationSyncKick('klaviyo');", ''],
  'page-own-verdict': ['throw new Error(out?.error || `HTTP ${res.status}`);', "throw new Error('The sync was refused.');"],
};
assert.ok(mutation === '' || MUTATIONS[mutation], `Unknown mutation ${mutation}`);

// Which file each mutation belongs to, so one is never silently applied to the
// wrong source (or to none, which would make its case pass for free).
const MUTATION_FILE = {
  'page-no-kick': 'v2/integrations.html',
  'page-own-verdict': 'v2/integrations.html',
  'no-oauth-env': `${FN}/index.ts`,
};

function mutated(path) {
  let src = read(path);
  if (MUTATIONS[mutation] && (MUTATION_FILE[mutation] || `${FN}/handler.mjs`) === path) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(src.includes(from), `mutation ${mutation} no longer matches ${path}`);
    src = src.replace(from, to);
  }
  return src;
}

const handlerSrc = mutated(`${FN}/handler.mjs`);
const H = await import('data:text/javascript,' + encodeURIComponent(handlerSrc));
const pageSrc = mutated('v2/integrations.html');
const indexSrc = mutated(`${FN}/index.ts`);

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };
const fail = (name, err) => { console.error(`FAILED: ${name}`); throw err; };
const run = async (name, fn) => { try { await test(name, fn); } catch (err) { fail(name, err); } };

// ── fakes ───────────────────────────────────────────────────────────────────
const CO = 'co-1';
const USER = { id: 'user-1' };

/** An in-memory Supabase double. Only the shapes the handler and the cores
 * actually use, and a failed write is a RETURNED error, never a throw, the way
 * PostgREST reports one. */
function makeDb({ rows = {}, visible = true } = {}) {
  const log = { inserts: [], updates: [], upserts: [], deletes: [] };
  const tables = { sync_jobs: [], ...rows };
  function query(table, { rls }) {
    const filters = [];
    let limited = false;
    const api = {
      select() { return api; },
      eq(col, val) { filters.push([col, val]); return api; },
      limit() { limited = true; return api; },
      order() { return api; },
      match(obj) { Object.entries(obj).forEach((e) => filters.push(e)); return api; },
      insert(payload) {
        const list = Array.isArray(payload) ? payload : [payload];
        list.forEach((p) => {
          const row = { id: `${table}-${tables[table] ? tables[table].length + 1 : 1}`, ...p };
          (tables[table] = tables[table] || []).push(row);
          log.inserts.push({ table, payload: p, row });
        });
        const inserted = tables[table][tables[table].length - 1];
        return {
          select: () => ({
            single: async () => ({ data: { id: inserted.id }, error: null }),
            maybeSingle: async () => ({ data: { id: inserted.id }, error: null }),
          }),
          then: (res) => res({ data: null, error: null }),
        };
      },
      upsert(payload) {
        log.upserts.push({ table, payload });
        return { then: (res) => res({ data: null, error: null }) };
      },
      // The cores' sweep builds long filter chains (eq/lt/gte/in/not/select)
      // whose exact shape is klaviyo-sync.test.mjs's business, not this
      // suite's: any filter method returns the chain, and awaiting it answers
      // the way PostgREST does.
      delete() {
        log.deletes.push({ table, filters });
        const resolved = { data: [], error: null };
        const chain = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') return (res) => res(resolved);
            return () => chain;
          },
        });
        return chain;
      },
      update(patch) {
        log.updates.push({ table, patch, filters });
        const chain = {
          eq(col, val) { filters.push([col, val]); return chain; },
          then: (res) => res({ data: null, error: null }),
        };
        return chain;
      },
      maybeSingle: async () => {
        const matching = (tables[table] || []).filter(
          (row) => filters.every(([col, val]) => row[col] === val),
        );
        // The RLS-scoped client sees the row only when `visible`.
        if (rls && !visible) return { data: null, error: null };
        const row = matching[0] || null;
        return { data: row ? (limited ? { id: row.id } : row) : null, error: null };
      },
    };
    return api;
  }
  const client = (rls) => ({
    from: (table) => query(table, { rls }),
    auth: { getUser: async (token) => (token ? { data: { user: USER }, error: null } : { data: null, error: 'no token' }) },
  });
  return { service: client(false), userClient: client(true), tables, log };
}

const post = (body, { auth = 'Bearer tok' } = {}) => new Request('https://fn/integration-sync-kick', {
  method: 'POST',
  headers: auth ? { Authorization: auth, 'Content-Type': 'application/json' } : {},
  body: JSON.stringify(body),
});

const KLAVIYO_ROW = {
  id: 'kl-1',
  company_entity_id: CO,
  is_active: true,
  sync_enabled: true,
  auth_mode: 'api_key',
  api_key: 'pk_test',
  conversion_metric_id: 'SPuq4n',
  account_timezone: 'America/Los_Angeles',
  days_back: 60,
  meta: {},
};
const REDO_ROW = {
  id: 'redo-1', company_entity_id: CO, is_active: true,
  api_secret: 'sec', meta: { redo_store_id: 'store-1' },
};

/** The handler with fake cores, so a case can assert what the core was ASKED
 * for without also exercising a provider. */
function handlerWith({ rows, visible = true, coreResult = {}, coreThrows = null } = {}) {
  const db = makeDb({ rows, visible });
  const calls = [];
  const core = async (args) => {
    calls.push(args);
    if (coreThrows) throw new Error(coreThrows);
    return { company: CO, ...coreResult };
  };
  const handle = H.createHandler({
    service: db.service,
    userClientFor: () => db.userClient,
    cores: { syncKlaviyoConnection: core, syncRedoMarketingConnection: core },
    now: () => new Date('2026-11-09T12:00:00Z'),
  });
  return { handle, calls, db };
}

// ── the function's copies of the cores are the repo's cores ─────────────────
for (const lib of ['klaviyo-sync-core.mjs', 'redo-marketing-sync-core.mjs']) {
  await run(`${lib} in the function is verbatim scripts/lib/${lib}`, async () => {
    assert.equal(
      read(`${FN}/lib/${lib}`),
      read(`scripts/lib/${lib}`),
      `${FN}/lib/${lib} has drifted from scripts/lib/${lib} — copy it again, do not edit one side`,
    );
  });
}

// ── request shape ──────────────────────────────────────────────────────────
await run('no bearer token is 401 before anything is read', async () => {
  const { handle, db } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW] } });
  const res = await handle(new Request('https://fn/x', { method: 'POST', body: '{}' }));
  assert.equal(res.status, 401);
  assert.deepEqual(db.log.inserts, []);
});

await run('a GET is refused', async () => {
  const { handle } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW] } });
  assert.equal((await handle(new Request('https://fn/x'))).status, 405);
});

await run('an unknown integration is 400 and names the ones that exist', async () => {
  const { handle, calls } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW] } });
  const res = await handle(post({ integration: 'shopify' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /klaviyo/);
  assert.match(body.error, /redo_marketing/);
  assert.deepEqual(calls, []);
});

await run('a prototype key is not an integration', async () => {
  // `integration: "constructor"` must not resolve through Object.prototype.
  const { handle, calls } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW] } });
  assert.equal((await handle(post({ integration: 'constructor' }))).status, 400);
  assert.deepEqual(calls, []);
});

// ── authorization ──────────────────────────────────────────────────────────
await run('a row the caller cannot see through RLS is not synced', async () => {
  const { handle, calls } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW] }, visible: false });
  const res = await handle(post({ integration: 'klaviyo' }));
  assert.equal(res.status, 404);
  assert.deepEqual(calls, [], 'the sync core must not run for a row RLS hid');
});

await run('a connection_id in the body cannot redirect the sync', async () => {
  const other = { ...KLAVIYO_ROW, id: 'kl-other', company_entity_id: 'co-2' };
  const { handle, calls } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW, other] } });
  const res = await handle(post({ integration: 'klaviyo', connection_id: 'kl-other' }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connection.id, 'kl-1', 'the row RLS returned is the row synced');
});

// ── consent ────────────────────────────────────────────────────────────────
await run('sync switched off is 409 and names the switch', async () => {
  const { handle, calls } = handlerWith({
    rows: { klaviyo_connections: [{ ...KLAVIYO_ROW, sync_enabled: false }] },
  });
  const res = await handle(post({ integration: 'klaviyo' }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'sync_off');
  assert.match(body.error, /switched off/i);
  assert.deepEqual(calls, [], 'a kick must not be a way around the switch the nightly obeys');
});

await run('an inactive connection is 409, and says inactive rather than switched off', async () => {
  const { handle } = handlerWith({ rows: { redo_connections: [{ ...REDO_ROW, is_active: false }] } });
  const res = await handle(post({ integration: 'redo_marketing' }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /inactive/i);
});

await run('Redo is not required to carry a sync_enabled column', async () => {
  // redo_connections has is_active only. A shared flag list would 409 every
  // Redo kick on a column that does not exist.
  const { handle, calls } = handlerWith({ rows: { redo_connections: [REDO_ROW] } });
  assert.equal((await handle(post({ integration: 'redo_marketing' }))).status, 200);
  assert.equal(calls.length, 1);
});

// ── the window ─────────────────────────────────────────────────────────────
await run('a connection configured deeper than the cap is clamped, not refused', async () => {
  const { handle, calls } = handlerWith({ rows: { klaviyo_connections: [{ ...KLAVIYO_ROW, days_back: 365 }] } });
  assert.equal((await handle(post({ integration: 'klaviyo' }))).status, 200);
  assert.equal(calls[0].daysBack, H.MAX_KICK_DAYS);
  assert.ok(H.MAX_KICK_DAYS < 365);
});

await run('no days_back uses the short default', async () => {
  const { handle, calls } = handlerWith({ rows: { redo_connections: [REDO_ROW] } });
  await handle(post({ integration: 'redo_marketing' }));
  assert.equal(calls[0].daysBack, H.DEFAULT_KICK_DAYS);
  assert.ok(H.DEFAULT_KICK_DAYS <= 7, 'the kick is a slice, not the history import');
});

await run('the run is identifiable as a kick in the stored job', async () => {
  const { handle, calls } = handlerWith({ rows: { klaviyo_connections: [KLAVIYO_ROW] } });
  await handle(post({ integration: 'klaviyo' }));
  assert.deepEqual(calls[0].jobParams, { trigger: 'kick', integration: 'klaviyo', days_back: H.MAX_KICK_DAYS });
});

// ── outcomes ───────────────────────────────────────────────────────────────
await run('a skip is reported as a skip, with a reason and no claim of success', async () => {
  const { handle } = handlerWith({
    rows: { klaviyo_connections: [KLAVIYO_ROW] },
    coreResult: { skipped: 'no_conversion_metric' },
  });
  const res = await handle(post({ integration: 'klaviyo' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'no_conversion_metric');
  assert.match(body.error, /Test connection/);
});

await run('a skip reason the map has not caught up with still reaches the screen', async () => {
  const { handle } = handlerWith({
    rows: { klaviyo_connections: [KLAVIYO_ROW] },
    coreResult: { skipped: 'something_new' },
  });
  const body = await (await handle(post({ integration: 'klaviyo' }))).json();
  assert.equal(body.ok, false);
  assert.match(body.error, /something_new/);
});

await run('a core error is reported, never answered ok', async () => {
  const { handle } = handlerWith({
    rows: { klaviyo_connections: [KLAVIYO_ROW] },
    coreThrows: 'Klaviyo returned 500',
  });
  const res = await handle(post({ integration: 'klaviyo' }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Klaviyo returned 500/);
});

await run('a success says what is still queued', async () => {
  const { handle } = handlerWith({
    rows: { klaviyo_connections: [KLAVIYO_ROW] },
    coreResult: { window: { startDate: '2026-11-02', endDate: '2026-11-08' }, chunks: [{}] },
  });
  const body = await (await handle(post({ integration: 'klaviyo' }))).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.window, { startDate: '2026-11-02', endDate: '2026-11-08' });
  assert.ok(body.queue_only.length >= 1, 'a kick is never the whole history');
});

await run('the handler keeps no sync_jobs bookkeeping of its own', async () => {
  // The cores write their own row. A second one here would double-count every
  // kick in the sync log.
  const { handle, db } = handlerWith({
    rows: { klaviyo_connections: [KLAVIYO_ROW] },
    coreResult: { window: { startDate: '2026-11-02', endDate: '2026-11-08' } },
  });
  await handle(post({ integration: 'klaviyo' }));
  assert.deepEqual(db.log.inserts.filter((i) => i.table === 'sync_jobs'), []);
});

// ── the real core, through the real handler ────────────────────────────────
await run('the real Klaviyo core records a kick-tagged sync_jobs row', async () => {
  const { syncKlaviyoConnection } = await import(join(ROOT, FN, 'lib/klaviyo-sync-core.mjs'));
  const db = makeDb({ rows: { klaviyo_connections: [KLAVIYO_ROW] } });
  // Every Klaviyo call answered empty: enough for the core to open its job,
  // write nothing and close it, which is all this case is about.
  const fetchImpl = async (url) => {
    const u = String(url);
    const body = u.includes('flow-series-reports')
      // The series report is an array per statistic over `date_times`; an
      // empty day list is the shape an account with no flows answers with.
      ? { data: { attributes: { results: [], date_times: [] } } }
      : u.includes('-reports')
        ? { data: { attributes: { results: [] } } }
        : { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const handle = H.createHandler({
    service: db.service,
    userClientFor: () => db.userClient,
    cores: {
      syncKlaviyoConnection: (args) => syncKlaviyoConnection({ ...args, fetchImpl, sleep: async () => {} }),
      syncRedoMarketingConnection: async () => ({}),
    },
    now: () => new Date('2026-11-09T12:00:00Z'),
  });
  const res = await handle(post({ integration: 'klaviyo' }));
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  const job = db.log.inserts.find((i) => i.table === 'sync_jobs');
  assert.ok(job, 'the core must open a sync_jobs row');
  assert.equal(job.payload.params?.trigger, 'kick');
  assert.equal(job.payload.params?.integration, 'klaviyo');
});

// ── OAuth refresh reaches the core ─────────────────────────────────────────
await run('an expired OAuth token is refreshed, not reported as a failure', async () => {
  // The nightly passes the OAuth app's credentials; a kick that did not would
  // 502 on exactly the connection that works on a schedule. The wiring lives
  // in index.ts, so this case reproduces it from that source rather than
  // trusting it.
  assert.match(indexSrc, /KLAVIYO_CLIENT_ID/, 'index.ts must read the OAuth client id');
  assert.match(indexSrc, /KLAVIYO_CLIENT_SECRET/, 'index.ts must read the OAuth client secret');
  const wires = /syncKlaviyoConnection\(\{\s*\.\.\.args,\s*\.\.\.klaviyoOauth\s*\}\)/.test(indexSrc);

  const { syncKlaviyoConnection } = await import(join(ROOT, FN, 'lib/klaviyo-sync-core.mjs'));
  const expired = {
    ...KLAVIYO_ROW,
    auth_mode: 'oauth',
    api_key: null,
    access_token: 'stale',
    refresh_token: 'rt-1',
    token_expires_at: '2026-11-09T11:00:00Z', // before `now`
  };
  const db = makeDb({ rows: { klaviyo_connections: [expired] } });
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/oauth/token')) {
      assert.match(init.headers.Authorization, /^Basic /, 'the refresh is authenticated with the app credentials');
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = u.includes('flow-series-reports')
      ? { data: { attributes: { results: [], date_times: [] } } }
      : u.includes('-reports') ? { data: { attributes: { results: [] } } } : { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  // The same closure index.ts builds, so the mutation that unwires it lands here.
  const oauth = { clientId: 'cid', clientSecret: 'csec' };
  const handle = H.createHandler({
    service: db.service,
    userClientFor: () => db.userClient,
    cores: {
      syncKlaviyoConnection: (args) => syncKlaviyoConnection({
        ...args, ...(wires ? oauth : {}), fetchImpl, sleep: async () => {},
      }),
      syncRedoMarketingConnection: async () => ({}),
    },
    now: () => new Date('2026-11-09T12:00:00Z'),
  });
  const res = await handle(post({ integration: 'klaviyo' }));
  const body = await res.json();
  assert.equal(res.status, 200, `expected the refresh to carry the sync: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  assert.ok(seen.some((u) => u.includes('/oauth/token')), 'the expired token must be refreshed');
});

// ── the page ───────────────────────────────────────────────────────────────
const strip = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|<!--|\*)/.test(l)).join('\n');

/** One page function's body, so an assertion cannot be satisfied by a mention
 * of the kick somewhere else in a 4,000-line file. */
function pageFunction(name) {
  const page = strip(pageSrc);
  const at = page.indexOf(`async function ${name}(`);
  assert.ok(at >= 0, `v2/integrations.html no longer has ${name}()`);
  const rest = page.slice(at);
  const end = rest.indexOf('\n    }');
  return rest.slice(0, end === -1 ? rest.length : end);
}

await run('switching Klaviyo sync on kicks the sync as well as queueing it', async () => {
  const body = pageFunction('toggleKlaviyoSync');
  assert.match(body, /integrationSyncKick\('klaviyo'\)/);
  assert.match(body, /firstConnectBootstrap\('klaviyo'/, 'the queue still guarantees the history');
});

await run('switching sync back on still pulls now, though it queues no second import', async () => {
  const body = pageFunction('toggleKlaviyoSync');
  assert.match(body, /already_queued/,
    'firstConnectBootstrap returns before its own kick for an account already imported');
});

await run('pasting a Redo secret kicks the marketing sync', async () => {
  const body = pageFunction('updateRedoConnection');
  assert.match(body, /integrationSyncKick\('redo_marketing'\)/);
  assert.match(body, /patch\.api_secret/, 'only once the secret that makes it syncable exists');
});

await run('the page states no verdict of its own about a refused kick', async () => {
  const page = strip(pageSrc);
  const fn = page.slice(page.indexOf('async function integrationSyncKick'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /out\?\.error/, 'the handler distinguishes the cases; the page must render its words');
  for (const verdict of ['refused the credential', 'The sync was refused', 'Sync failed:']) {
    assert.ok(!body.includes(verdict), `the page must not label the failure itself ("${verdict}")`);
  }
});

console.log(`\n# integration-sync-kick: ${n} checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
