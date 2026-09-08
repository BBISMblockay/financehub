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
  function builder(table) {
    var q = { table: table, columns: null, order: null, range: null, _op: 'select' };
    var api = {
      select: function (cols) { q.columns = cols; window.__QUERIES__.push(q); return api; },
      order: function (col, opts) { q.order = { col: col, opts: opts }; return api; },
      eq: function () { return api; },
      insert: function (rows) { q._op = 'insert'; q.rows = rows; window.__QUERIES__.push(q); return Promise.resolve({ data: rows, error: null }); },
      update: function (patch) { q._op = 'update'; q.patch = patch; window.__QUERIES__.push(q); return { eq: function () { return Promise.resolve({ data: [], error: null }); } }; },
      range: function (from, to) {
        q.range = [from, to];
        var all = (table === 'product_tags')
          ? (window.__FIXTURE_TAGS__ || [])
          : (window.__FIXTURE_ROWS__ || []);
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      }
    };
    return api;
  }
  window.supabase = {
    createClient: function () {
      return {
        auth: {
          getSession: function () {
            return Promise.resolve({ data: { session: { user: { email: 'test@baseballism.com' } } }, error: null });
          },
          signOut: function () { return Promise.resolve({ error: null }); }
        },
        from: builder,
        rpc: function () { return Promise.resolve({ data: null, error: null }); }
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
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport });

  await context.route('**/pages/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: CONFIG_STUB }));
  await context.route('**/cdn.jsdelivr.net/**supabase**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeSupabaseScript() }));
  await context.route('**/fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }));

  async function open(rows, tags) {
    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
    await page.addInitScript(({ r, t }) => {
      window.__FIXTURE_ROWS__ = r;
      window.__FIXTURE_TAGS__ = t;
    }, { r: rows || [], t: tags || [] });
    await page.goto(`${base}/v2/inventory.html`, { waitUntil: 'domcontentloaded' });
    // The page is ready once its status line reports a load.
    await page.waitForFunction(
      () => { const n = document.getElementById('statusLine'); return n && /location rows|failed/.test(n.textContent); },
      { timeout: 20000 });
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
