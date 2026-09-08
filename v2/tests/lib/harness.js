/* Browser harness for the v2 inventory suite.
 *
 * Same shape as v3/tests/lib/harness.js: a static server over the repo, plus
 * route stubs for the things the page reaches for that are not under test.
 * The PAGE ITSELF is served unmodified from the checkout — the whole point is
 * that the real v2/inventory.html runs the real v2/inventory-signals.js, with
 * only the outside world faked.
 *
 * What is stubbed:
 *   pages/config.js       real credentials, replaced by a fake pointing at
 *                         the in-memory Supabase stand-in
 *   @supabase/supabase-js the stand-in itself, which serves the fixture rows
 *                         and records what was asked for (so a suite can
 *                         assert on the columns requested, not just on pixels)
 *   nav-config / silo-chrome  served from the repo; the sidebar is not under
 *                         test but the page bails without SiloNav
 *   fonts.googleapis.com  empty CSS
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const stable = '/opt/pw-browsers/chromium';
  if (fs.existsSync(stable)) return stable;
  return undefined;
}

function requirePlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    throw new Error(
      'playwright is not installed. Browser suites need it:\n'
      + '    cd v2/tests && npm install && npx playwright install chromium\n'
      + 'Unit suites need nothing: node v2/tests/run.js --unit');
  }
}

/**
 * The fake Supabase client, as a script the page loads instead of the CDN
 * bundle. `window.__FIXTURE_ROWS__` is set by the suite before navigation.
 * Every select is recorded on `window.__QUERIES__`.
 */
function fakeSupabaseScript() {
  return `
window.__QUERIES__ = [];
(function () {
  // A thenable query builder. Pages await .select(...) directly (no .range),
  // and also chain .gte/.lte/.order/.range, so the builder has to be both a
  // chainable object and a promise.
  function builder(table) {
    var q = { table: table, columns: null, order: null, range: null, filters: [], _op: 'select' };

    function rows() {
      var all = (window.__FIXTURE_TABLES__ || {})[table] || [];
      // Apply the gte/lte/eq filters the pages use, so a suite can assert on
      // what a date or scope change actually fetched.
      //
      // A filter on a column NO fixture row carries is skipped rather than
      // matching nothing. That is almost entirely for company_entity_id: the
      // pages add .eq('company_entity_id', ...) via scopeQ(), but tenancy is
      // enforced by RLS on the real database, not by the fixture -- so
      // honouring it here would silently empty every table and every suite
      // would assert against a blank page.
      q.filters.forEach(function (f) {
        var present = all.some(function (r) { return Object.prototype.hasOwnProperty.call(r, f.col); });
        if (!present) return;
        all = all.filter(function (r) {
          var v = r[f.col];
          if (f.op === 'gte') return String(v) >= String(f.val);
          if (f.op === 'lte') return String(v) <= String(f.val);
          if (f.op === 'eq')  return String(v) === String(f.val);
          return true;
        });
      });
      if (q.range) all = all.slice(q.range[0], q.range[1] + 1);
      return all;
    }

    var api = {
      select: function (cols) { q.columns = cols; window.__QUERIES__.push(q); return api; },
      order:  function (col, opts) { q.order = { col: col, opts: opts }; return api; },
      eq:     function (col, val) { q.filters.push({ op: 'eq',  col: col, val: val }); return api; },
      gte:    function (col, val) { q.filters.push({ op: 'gte', col: col, val: val }); return api; },
      lte:    function (col, val) { q.filters.push({ op: 'lte', col: col, val: val }); return api; },
      in:     function () { return api; },
      limit:  function () { return api; },
      range:  function (from, to) { q.range = [from, to]; return api; },
      insert: function (r) { q._op = 'insert'; q.rows = r; window.__QUERIES__.push(q); return Promise.resolve({ data: r, error: null }); },
      update: function (patch) { q._op = 'update'; q.patch = patch; window.__QUERIES__.push(q); return { eq: function () { return Promise.resolve({ data: [], error: null }); } }; },
      upsert: function (r) { q._op = 'upsert'; q.rows = r; window.__QUERIES__.push(q); return Promise.resolve({ data: r, error: null }); },
      delete: function () { q._op = 'delete'; window.__QUERIES__.push(q); return { eq: function () { return Promise.resolve({ data: [], error: null }); } }; },
      then:   function (res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); }
    };
    return api;
  }

  window.supabase = {
    createClient: function () {
      return {
        auth: {
          // Resolved on a MACROTASK, not a microtask. A real getSession() is a
          // network round trip, and pages rely on that: planning-scenarios.html
          // awaits it in one <script> and defines its boot function in the
          // NEXT one. An instantly-resolved promise runs the continuation
          // before the parser reaches that second block, so the page silently
          // never boots -- a race no real client can lose.
          getSession: function () {
            return new Promise(function (res) {
              setTimeout(function () {
                res({ data: { session: { user: { email: 'test@baseballism.com' } } }, error: null });
              }, 0);
            });
          },
          getUser: function () {
            return Promise.resolve({ data: { user: { id: 'test-user', email: 'test@baseballism.com' } }, error: null });
          },
          signOut: function () { return Promise.resolve({ error: null }); }
        },
        from: builder,
        rpc: function (name, args) {
          window.__QUERIES__.push({ table: 'rpc:' + name, args: args, _op: 'rpc' });
          return Promise.resolve({ data: (window.__FIXTURE_RPC__ || {})[name] || null, error: null });
        }
      };
    }
  };
})();
`;
}

const CONFIG_STUB = `
window.__SILO_CONFIG__ = {
  SUPABASE_URL: 'http://localhost/fake',
  SUPABASE_ANON_KEY: 'fake-anon-key',
  getActiveCompany: function () { return { id: 'test-company' }; },
  ensureActiveCompany: function () { return Promise.resolve({ id: 'test-company' }); },
  withCompany: function (row) { return row; },
  withCompanyRows: function (rows) { return rows; }
};
`;

async function startSuite(options = {}) {
  const viewport = options.viewport || { width: 1440, height: 900 };
  const { chromium } = requirePlaywright();

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(String(req.url).split('?')[0]);
    const file = path.join(REPO_ROOT, rel.replace(/^\/+/, ''));
    if (!file.startsWith(REPO_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://silo.test:${port}`;

  // Some pages (projections.html) switch themselves into a built-in DEMO mode
  // when the hostname looks like localhost -- which a test server always does.
  // Map a neutral hostname onto the loopback server so the page runs its REAL
  // Supabase path against the fixtures, rather than its demo seed data.
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ['--host-resolver-rules=MAP silo.test 127.0.0.1'],
  });
  const context = await browser.newContext({ viewport });

  // Registered FIRST on purpose: Playwright matches the most recently added
  // route first, so every specific stub below overrides this. Anything
  // external that nothing else claims resolves to an empty 200 rather than
  // hanging the page on an unreachable host.
  await context.route('**://**', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });

  await context.route('**/pages/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: CONFIG_STUB }));
  await context.route('**/cdn.jsdelivr.net/**supabase**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript() }));
  await context.route('**/fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }));
  // planning-scenarios.html pulls Tailwind from a CDN. It is a BLOCKING
  // script, so an unreachable CDN stalls parsing and the page never boots --
  // which looks exactly like a page bug. Stub it, and catch anything else
  // external the same way so one unstubbed host cannot hang a suite.
  await context.route('**/cdn.tailwindcss.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'window.tailwind={config:{}};' }));
  await context.route('https://cdn.tailwindcss.com', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'window.tailwind={config:{}};' }));


  /**
   * Open a page with a table -> rows fixture map.
   *   open('/v2/bi-daily-trend.html', { locations: [...], sales_by_day_verification_v: [...] })
   * `ready` is a predicate evaluated in the page; defaults to the inventory
   * page's status line for backwards compatibility with the existing suite.
   */
  async function open(pathOrRows, tablesOrTags, opts) {
    // Back-compat: the inventory suite calls open(rows, tags).
    let path = '/v2/inventory.html';
    let tables = {};
    let ready = () => {
      const n = document.getElementById('statusLine');
      return n && /location rows|failed/.test(n.textContent);
    };
    if (typeof pathOrRows === 'string') {
      path = pathOrRows;
      tables = tablesOrTags || {};
      if (opts && opts.ready) ready = opts.ready;
    } else {
      tables = { inventory_workboard_v: pathOrRows || [], product_tags: tablesOrTags || [] };
    }

    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
    await page.addInitScript((t) => { window.__FIXTURE_TABLES__ = t; }, tables);
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(ready, { timeout: 20000 });
    return page;
  }

  async function close() {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { base, context, open, close };
}

module.exports = { startSuite, REPO_ROOT };
