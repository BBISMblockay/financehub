// Execute the actual platform-admin inline script with inert DOM/SDK fixtures.
// This tests wiring and event handlers; SQL/RLS enforcement is separately tested
// by the database suite, and the real browser suite covers layout/accessibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../v2/platform-admin.html', import.meta.url), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = (id = 'fixture-1', extra = {}) => ({ id, name: 'Pat Example', company_name: 'Example Company',
  email: 'pat@example.test', created_at: '2026-10-01T00:00:00Z', status: 'pending', ...extra });

async function openAdmin(options = {}) {
  const state = { signedIn: true, authorized: true, rows: [row()], readError: null, saveError: null, conflict: false, ...options };
  const elements = new Map();
  const queries = [];
  const rpcs = [];
  const nodes = [];
  class Element {
    constructor(id = '') { this.id = id; this.textContent = ''; this.innerHTML = ''; this.hidden = false;
      this.disabled = false; this.value = id === 'interestFilter' ? 'pending' : ''; this.handlers = {}; this.dataset = {}; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    querySelector(selector) { if (selector === 'tbody') return this.body ||= new Element(); return null; }
    querySelectorAll(selector) { return this.id === 'tblInterest' && selector === 'button, select' ? nodes : []; }
  }
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(tag[1]);
    element.hidden = /\bhidden\b/.test(tag[0]); element.disabled = /\bdisabled\b/.test(tag[0]);
    elements.set(tag[1], element);
  }
  const db = {
    auth: { getSession: async () => ({ data: { session: state.signedIn ? { user: { id: 'fixture-user' } } : null } }) },
    rpc: async name => { rpcs.push(name); return { data: name === 'is_platform_admin' ? state.authorized : [], error: null }; },
    from(table) {
      const query = { table, filters: [], orders: [] };
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(column, value) { query.filters.push([column, value]); return builder; },
        order(column, options) { query.orders.push([column, options]); return builder; },
        update(values) { query.update = values; return builder; },
        async range(start, end) {
          query.range = [start, end]; queries.push(query);
          const filtered = state.rows.filter(row => query.filters.every(([key, value]) => row[key] === value));
          return { data: filtered.slice(start, end + 1), error: state.readError };
        },
        async maybeSingle() {
          queries.push(query);
          if (table === 'profiles') return { data: { email: 'admin@example.test', role: 'owner' }, error: null };
          if (state.saveDelay) await state.saveDelay;
          if (state.saveError) return { data: null, error: state.saveError };
          if (state.conflict) return { data: null, error: null };
          const match = state.rows.find(row => query.filters.every(([key, value]) => row[key] === value));
          if (!match) return { data: null, error: null };
          Object.assign(match, query.update);
          return { data: { id: match.id }, error: null };
        },
      };
      return builder;
    },
  };
  const location = { pathname: '/v2/platform-admin.html', origin: 'https://get-silo.com', href: '' };
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), querySelector: () => new Element(), querySelectorAll: () => [] },
    window: { location, __SILO_CONFIG__: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'inert', ensureActiveCompany: async () => {} },
      supabase: { createClient: () => db }, SiloChrome: { mount() {} } },
    location, console: { error() {} }, setTimeout() {}, encodeURIComponent, confirm: () => false });
  const code = (state.source || source).replace('(async function boot() {', 'globalThis.booted = (async function boot() {');
  vm.runInContext(code, context);
  await context.booted;
  await tick();
  const queueQueries = () => queries.filter(query => query.table === 'onboarding_interest_queue');
  return { state, elements, queries, rpcs, location, queueQueries,
    // The queue is a list of rows rendered straight into #tblInterest (#899).
    body: () => elements.get('tblInterest').innerHTML,
    async changeFilter(value) {
      elements.get('interestFilter').value = value;
      elements.get('interestFilter').handlers.change(); await tick();
    },
    async click(id) { elements.get(id).handlers.click(); await tick(); },
    beginSave(id, original, next) {
      const select = new Element(); select.value = next;
      const button = new Element(); button.dataset = { interestSave: id, originalStatus: original };
      button.closest = () => ({ querySelector: () => select });
      nodes.splice(0, nodes.length, select, button);
      const event = { target: { closest: selector => selector === '[data-interest-save]' ? button : null } };
      const finished = elements.get('tblInterest').handlers.click(event);
      return { finished, select, button, repeat: () => elements.get('tblInterest').handlers.click(event) };
    },
  };
}

function assertDenied(page) {
  assert.equal(page.elements.get('gate').hidden, false, 'platform access gate must be shown');
  assert.equal(page.elements.get('admin').hidden, true, 'admin controls must remain hidden');
  assert.equal(page.elements.get('btnReload').hidden, true);
  assert.deepEqual(page.queueQueries(), [], 'denied users must never request the queue');
  assert.deepEqual(page.rpcs, ['is_platform_admin']);
}

test('signed-out users retain login return route and make no queue or RPC requests', async () => {
  const page = await openAdmin({ signedIn: false });
  assert.equal(page.location.href, '/pages/login.html?next=%2Fv2%2Fplatform-admin.html');
  assert.deepEqual(page.queries, []); assert.deepEqual(page.rpcs, []);
  assert.equal(page.elements.get('admin').hidden, true);
});

test('owner without an explicit platform grant cannot see or request the queue', async () => {
  for (const authorized of [false, null, undefined, 'true', 1]) assertDenied(await openAdmin({ authorized }));
});

test('platform gate regression assertion catches removing the integrated gate', async () => {
  const mutant = source.replace('if (isPlatform !== true)', 'if (false)');
  assert.notEqual(mutant, source, 'mutation must target the actual gate');
  const page = await openAdmin({ authorized: false, source: mutant });
  assert.throws(() => assertDenied(page), /platform access gate must be shown/);
  assert.ok(page.queueQueries().length > 0, 'mutation really executes the otherwise-protected queue path');
});

test('platform admins load only the six queue columns with bounded stable ordering', async () => {
  const page = await openAdmin();
  assert.equal(page.elements.get('gate').hidden, true);
  assert.equal(page.elements.get('admin').hidden, false);
  const query = page.queueQueries()[0];
  assert.equal(query.columns, 'id, name, company_name, email, created_at, status');
  assert.deepEqual(JSON.parse(JSON.stringify(query.orders)), [['created_at', { ascending: false }], ['id', { ascending: false }]]);
  assert.deepEqual(query.filters, [['status', 'pending']]); assert.deepEqual(query.range, [0, 25]);
  assert.match(page.body(), /Pat Example/); assert.match(page.body(), /Example Company/);
  assert.match(page.body(), /pat@example.test/); assert.equal(page.elements.get('interestPage').textContent, 'Page 1');
});

test('untrusted names, company names, email and row IDs are escaped in text and attributes', async () => {
  const injection = '<img src=x onerror="globalThis.pwned=true">&\'X';
  const page = await openAdmin({ rows: [row(injection, { name: injection, company_name: injection, email: injection })] });
  const markup = page.body();
  assert.doesNotMatch(markup, /<img|onerror="/);
  assert.match(markup, /&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;&amp;&#39;X/);
  assert.match(markup, /aria-label="Status for &lt;img/);
});

test('pagination fetches one bounded look-ahead row and filters reset to page one', async () => {
  const page = await openAdmin({ rows: Array.from({ length: 28 }, (_, i) => row('fixture-' + i)) });
  assert.equal((page.body().match(/data-interest-save=/g) || []).length, 25);
  assert.equal(page.elements.get('interestPrevious').disabled, true);
  assert.equal(page.elements.get('interestNext').disabled, false);
  await page.click('interestNext');
  assert.deepEqual(page.queueQueries().at(-1).range, [25, 50]);
  assert.equal(page.elements.get('interestPage').textContent, 'Page 2');
  assert.equal(page.elements.get('interestNext').disabled, true);
  assert.equal(page.elements.get('interestPrevious').disabled, false);
  await page.changeFilter('all');
  assert.deepEqual(page.queueQueries().at(-1).filters, []);
  assert.deepEqual(page.queueQueries().at(-1).range, [0, 25]);
  await page.changeFilter('closed');
  assert.deepEqual(page.queueQueries().at(-1).filters, [['status', 'closed']]);
  assert.match(page.body(), /No interest in this view/);
});

test('queue load error is generic and Reload can recover', async () => {
  const page = await openAdmin({ readError: { message: 'secret backend detail' } });
  assert.match(page.body(), /Could not load the queue/); assert.doesNotMatch(page.body(), /secret/);
  assert.equal(page.elements.get('interestNext').disabled, true);
  page.state.readError = null; await page.click('btnReload');
  assert.match(page.body(), /Pat Example/);
});

test('status update changes only status with both ID and original-status guards', async () => {
  const page = await openAdmin();
  const save = page.beginSave('fixture-1', 'pending', 'contacted'); await save.finished;
  const update = page.queueQueries().find(query => query.update);
  assert.deepEqual(JSON.parse(JSON.stringify(update.update)), { status: 'contacted' });
  assert.deepEqual(update.filters, [['id', 'fixture-1'], ['status', 'pending']]);
  assert.equal(update.columns, 'id');
  assert.equal(page.elements.get('status').textContent, 'Interest status saved.');
  assert.equal(page.state.rows[0].status, 'contacted');
  assert.match(page.body(), /No interest in this view/);
  assert.ok(!page.rpcs.some(name => /create|invite|send/.test(name) && name !== 'list_platform_invites'));
});

test('status errors and conflicts preserve the selected value and never claim success', async () => {
  for (const state of [{ saveError: { message: 'private error detail' } }, { conflict: true }]) {
    const page = await openAdmin(state);
    const save = page.beginSave('fixture-1', 'pending', 'closed'); await save.finished;
    assert.equal(save.select.value, 'closed'); assert.equal(save.select.disabled, false);
    assert.equal(page.state.rows[0].status, 'pending');
    assert.doesNotMatch(page.elements.get('status').textContent, /private|saved/i);
    assert.match(page.elements.get('status').textContent, state.conflict ? /Reload before trying again/ : /selection is kept/);
    assert.equal(page.queueQueries().filter(query => !query.update).length, 1, 'failed save must not erase selection by reloading');
  }
});

test('pending save blocks repeat writes, filter changes and pagination until it resolves', async () => {
  let release;
  const page = await openAdmin({ saveDelay: new Promise(resolve => { release = resolve; }) });
  const save = page.beginSave('fixture-1', 'pending', 'contacted');
  assert.equal(save.select.disabled, true); assert.equal(save.button.disabled, true);
  assert.equal(page.elements.get('interestFilter').disabled, true);
  assert.equal(page.elements.get('interestPrevious').disabled, true);
  assert.equal(page.elements.get('interestNext').disabled, true);
  await save.repeat();
  assert.equal(page.queueQueries().filter(query => query.update).length, 1);
  release(); await save.finished;
  assert.equal(page.elements.get('interestFilter').disabled, false);
});
