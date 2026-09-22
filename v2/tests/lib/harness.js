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
 *
 * open() options:
 *   ready            predicate evaluated in the page to decide "loaded"
 *   rpc              name -> rows (or a function of the args)
 *   broken           table names whose every read errors
 *   missingColumns   { table: ['col'] } -- reads and writes naming one of
 *                    those columns fail with PostgREST's real 42703, so a
 *                    page that feature-detects an unapplied migration can be
 *                    tested in BOTH database states
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

    function broken() {
      return ((window.__FIXTURE_BROKEN__ || []).indexOf(table) !== -1);
    }

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
      function matchIlike(v, pat) {
        // '%' is the only wildcard these pages use; everything else is
        // literal. Comparing lowercased substrings avoids building a regex
        // (and the backslash escaping that goes with it) entirely.
        var hay = String(v == null ? '' : v).toLowerCase();
        var needle = String(pat).toLowerCase();
        if (needle.indexOf('%') === -1) return hay === needle;
        var segs = needle.split('%').filter(function (x) { return x.length; });
        var pos = 0;
        for (var si = 0; si < segs.length; si++) {
          var at = hay.indexOf(segs[si], pos);
          if (at === -1) return false;
          pos = at + segs[si].length;
        }
        return true;
      }

      function matchOne(r, col, op, val) {
        var v = r[col];
        if (op === 'eq')    return String(v == null ? '' : v) === String(val);
        if (op === 'is')    return val === 'null' ? (v === null || v === undefined) : String(v) === String(val);
        if (op === 'ilike') return matchIlike(v, val);
        if (op === 'neq')   return String(v) !== String(val);
        return true;
      }

      q.filters.forEach(function (f) {
        if (f.op === 'or') {
          // "col.op.value,col.op.value" -- any clause may match. Split on
          // commas the page did not escape (it escapes a literal comma inside
          // a value with a backslash).
          var BSLASH = String.fromCharCode(92);
          var parts = [];
          var buf = '';
          for (var ci = 0; ci < f.expr.length; ci++) {
            var ch = f.expr[ci];
            if (ch === BSLASH && f.expr[ci + 1] === ',') { buf += ','; ci++; continue; }
            if (ch === ',') { parts.push(buf); buf = ''; continue; }
            buf += ch;
          }
          parts.push(buf);
          var clauses = parts.map(function (c) {
            var idx1 = c.indexOf('.');
            if (idx1 === -1) return null;
            var idx2 = c.indexOf('.', idx1 + 1);
            if (idx2 === -1) return null;
            return { col: c.slice(0, idx1).trim(), op: c.slice(idx1 + 1, idx2), val: c.slice(idx2 + 1) };
          }).filter(Boolean);
          if (!clauses.length) return;
          all = all.filter(function (r) {
            return clauses.some(function (c) { return matchOne(r, c.col, c.op, c.val); });
          });
          return;
        }
        if (f.op === 'not') {
          all = all.filter(function (r) { return !matchOne(r, f.col, f.innerOp, f.val); });
          return;
        }
        var present = all.some(function (r) { return Object.prototype.hasOwnProperty.call(r, f.col); });
        if (!present && f.op !== 'is') return;
        all = all.filter(function (r) {
          var v = r[f.col];
          if (f.op === 'gte') return String(v) >= String(f.val);
          if (f.op === 'lte') return String(v) <= String(f.val);
          if (f.op === 'eq')  return String(v) === String(f.val);
          if (f.op === 'neq') return String(v) !== String(f.val);
          if (f.op === 'lt')  return Number(v) < Number(f.val);
          if (f.op === 'gt')  return Number(v) > Number(f.val);
          if (f.op === 'ilike') return matchIlike(v, f.val);
          if (f.op === 'in') return (f.vals || []).map(String).indexOf(String(v)) !== -1;
          if (f.op === 'is') {
            if (f.val === null || f.val === 'null') return v === null || v === undefined;
            return String(v) === String(f.val);
          }
          return true;
        });
      });
      // order() is recorded but not applied by the fixture layer, so a
      // limit is honoured only alongside the order the suite fixture is
      // already written in.
      if (q.order && q.order.opts && q.order.opts.ascending === false) {
        var col = q.order.col;
        if (all.length && Object.prototype.hasOwnProperty.call(all[0], col)) {
          all = all.slice().sort(function (a, b) { return String(b[col]) > String(a[col]) ? 1 : String(b[col]) < String(a[col]) ? -1 : 0; });
        }
      }
      if (q.range) all = all.slice(q.range[0], q.range[1] + 1);
      if (q.limit) all = all.slice(0, q.limit);
      return all;
    }

    // An UNAPPLIED MIGRATION, modelled honestly. A page that feature-detects a
    // column needs the real answer PostgREST gives for one that does not
    // exist -- code 42703 -- not an empty result, because an empty result is
    // indistinguishable from "the column is there and no row has a value".
    // Set window.__FIXTURE_MISSING_COLUMNS__ = { table: ['col', ...] }.
    function missingColumn(cols) {
      var miss = (window.__FIXTURE_MISSING_COLUMNS__ || {})[table] || [];
      if (!miss.length || !cols) return null;
      var asked = String(cols).split(',').map(function (c) { return c.trim(); });
      for (var i = 0; i < miss.length; i++) {
        if (asked.indexOf(miss[i]) !== -1 || asked.indexOf('*') !== -1 && false) return miss[i];
      }
      return null;
    }

    var api = {
      // PostgREST's count option, implemented for real: a head+exact count
      // returns {data:null, count:N}, and a page that reads .count off a
      // stubbed-to-rows select would silently read undefined and render 0 --
      // which is a NUMBER, so it looks like a measurement rather than a gap.
      select: function (cols, opts) { q.columns = cols; q.count = opts && opts.count; q.head = !!(opts && opts.head); window.__QUERIES__.push(q); return api; },
      order:  function (col, opts) { q.order = { col: col, opts: opts }; return api; },
      eq:     function (col, val) { q.filters.push({ op: 'eq',  col: col, val: val }); return api; },
      // .is(col, null) is how a page asks for "this was never set" -- and a
      // missing method here is a TypeError the page swallows, which reads
      // exactly like the page failing to measure something.
      is:     function (col, val) { q.filters.push({ op: 'is', col: col, val: val }); return api; },
      gte:    function (col, val) { q.filters.push({ op: 'gte', col: col, val: val }); return api; },
      lte:    function (col, val) { q.filters.push({ op: 'lte', col: col, val: val }); return api; },
      // Implemented for real: loadSplits() reads split lines with .in() on a
      // page of transaction ids, and a no-op would hand every fixture split
      // to whichever page asked first.
      in:     function (col, vals) { q.filters.push({ op: 'in', col: col, vals: vals || [] }); return api; },
      lt:     function (col, val) { q.filters.push({ op: 'lt',  col: col, val: val }); return api; },
      gt:     function (col, val) { q.filters.push({ op: 'gt',  col: col, val: val }); return api; },
      neq:    function (col, val) { q.filters.push({ op: 'neq', col: col, val: val }); return api; },
      ilike:  function (col, val) { q.filters.push({ op: 'ilike', col: col, val: val }); return api; },
      // PostgREST's .not(col, op, val). Implemented for real, not stubbed to
      // a no-op: products.html builds its product-type list with
      // .not('product_type','is',null), and a no-op would hand it the null
      // rows it explicitly excluded -- a blank entry in a dropdown, which
      // looks like a real category with no name.
      not:    function (col, op, val) { q.filters.push({ op: 'not', col: col, innerOp: op, val: val }); return api; },
      // PostgREST's or() takes "col.op.value,col.op.value". Implemented for
      // real rather than stubbed to true: the exception filters on
      // sales-verification.html ARE an or(), and a no-op here would let a
      // suite assert on rows the page never actually filtered.
      or:     function (expr) { q.filters.push({ op: 'or', expr: String(expr) }); return api; },
      limit:  function (n) { q.limit = Number(n); return api; },
      range:  function (from, to) { q.range = [from, to]; return api; },
      // Chainable, not a bare promise: products.html (and anything else that
      // needs the id of the row it just created) does
      // .insert(payload).select().single(). A promise has no .select, so a
      // bare one is a TypeError the page swallows -- which reads exactly like
      // the save silently failing. Still thenable with the same resolved
      // shape, so 'await ...insert(r)' keeps working unchanged.
      insert: function (r) {
        q._op = 'insert'; q.rows = r; window.__QUERIES__.push(q);
        var one = Array.isArray(r) ? r[0] : r;
        var created = Object.assign({ id: 'fixture-inserted-id' }, one);
        var mcw = missingColumn(Object.keys(one || {}).join(','));
        var wErr = mcw ? { code: '42703', message: 'column ' + table + '.' + mcw + ' does not exist' } : null;
        var ins = {
          select: function () { return ins; },
          single: function () { return Promise.resolve(wErr ? { data: null, error: wErr } : { data: created, error: null }); },
          maybeSingle: function () { return Promise.resolve(wErr ? { data: null, error: wErr } : { data: created, error: null }); },
          then: function (res, rej) { return Promise.resolve(wErr ? { data: null, error: wErr } : { data: r, error: null }).then(res, rej); }
        };
        return ins;
      },
      update: function (patch) {
        q._op = 'update'; q.patch = patch; window.__QUERIES__.push(q);
        var mcu = missingColumn(Object.keys(patch || {}).join(','));
        var uErr = mcu ? { code: '42703', message: 'column ' + table + '.' + mcu + ' does not exist' } : null;
        return { eq: function () { return Promise.resolve({ data: uErr ? null : [], error: uErr }); } };
      },
      upsert: function (r) { q._op = 'upsert'; q.rows = r; window.__QUERIES__.push(q); return Promise.resolve({ data: r, error: null }); },
      delete: function () { q._op = 'delete'; window.__QUERIES__.push(q); return { eq: function () { return Promise.resolve({ data: [], error: null }); } }; },
      // A single-row read. Pages use both, and a missing method is a
      // TypeError that reads exactly like a page bug.
      single: function () {
        if (broken()) return Promise.resolve({ data: null, error: { message: 'fixture: ' + table + ' is unreadable' } });
        var r = rows();
        return Promise.resolve(r.length
          ? { data: r[0], error: null }
          : { data: null, error: { message: 'no rows' } });
      },
      maybeSingle: function () {
        if (broken()) return Promise.resolve({ data: null, error: { message: 'fixture: ' + table + ' is unreadable' } });
        var r = rows();
        return Promise.resolve({ data: r.length ? r[0] : null, error: null });
      },
      then:   function (res, rej) {
        var mc = missingColumn(q.columns);
        if (mc) return Promise.resolve({ data: null, error: { code: '42703', message: 'column ' + table + '.' + mc + ' does not exist' } }).then(res, rej);
        if (broken()) return Promise.resolve({ data: null, error: { message: 'fixture: ' + table + ' is unreadable' } }).then(res, rej);
        var got = rows();
        var out = { data: q.head ? null : got, error: null };
        if (q.count) out.count = got.length;
        return Promise.resolve(out).then(res, rej);
      }
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
                // Carries an access_token and a user id because a real one
                // does, and pages legitimately depend on both: v2/silo-chat.html
                // reads a fresh token per request (a tab open past the token's
                // lifetime was posting an expired one) and scopes its stored
                // conversation by user id. Without these a page that is working
                // correctly refuses to send, which reads as a page bug.
                res({
                  data: {
                    session: {
                      access_token: 'fake-access-token',
                      user: { id: 'test-user', email: 'test@baseballism.com' },
                    },
                  },
                  error: null,
                });
              }, 0);
            });
          },
          getUser: function () {
            return Promise.resolve({ data: { user: { id: 'test-user', email: 'test@baseballism.com' } }, error: null });
          },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
          signOut: function () { return Promise.resolve({ error: null }); }
        },
        from: builder,
        // Storage and edge functions: present so a page that touches them
        // renders, absent-shaped so nothing here can be mistaken for a real
        // file. products.html reads sample photos out of the sample-images
        // bucket on every drawer open, and an undefined .storage is a
        // TypeError that aborts the handler mid-way -- the drawer opens with
        // half its fields filled, which looks like a page bug.
        storage: {
          from: function () {
            return {
              list: function () { return Promise.resolve({ data: [], error: null }); },
              upload: function () { return Promise.resolve({ data: null, error: null }); },
              remove: function () { return Promise.resolve({ data: null, error: null }); },
              getPublicUrl: function (p) { return { data: { publicUrl: 'about:blank#' + p } }; }
            };
          }
        },
        functions: {
          invoke: function (name, opts) {
            (window.__INVOKES__ = window.__INVOKES__ || []).push({ name: name, body: opts && opts.body });
            return Promise.resolve({ data: {}, error: null });
          }
        },
        // RPCs are CHAINED like table queries on some pages
        // (bi-product-search does sb.rpc(...).range(...)), so this returns
        // the same thenable builder rather than a bare promise.
        rpc: function (name, args) {
          var q = { table: 'rpc:' + name, args: args, _op: 'rpc', range: null };
          window.__QUERIES__.push(q);
          var rows = function () {
            var fx = window.__FIXTURE_RPC__ || {};
            var all = fx[name];
            // Fall back to a table fixture of the same name so a suite does
            // not have to restate the same rows twice.
            if (all === undefined) all = (window.__FIXTURE_TABLES__ || {})[name];
            if (all === undefined) all = [];
            if (typeof all === 'function') all = all(args) || [];
            if (q.range) all = all.slice(q.range[0], q.range[1] + 1);
            return all;
          };
          var api = {
            range: function (a, b) { q.range = [a, b]; return api; },
            select: function () { return api; },
            eq: function () { return api; },
            order: function () { return api; },
            then: function (res, rej) {
              return Promise.resolve({ data: rows(), error: null }).then(res, rej);
            }
          };
          return api;
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
  // Secure-context suites need real Web Locks/crypto, not a shim. Loopback is
  // trustworthy in Chromium; the insecure-origin override did not make the
  // silo.test context secure in CI. Keep the neutral host for demo-aware pages.
  const base = `http://${options.secureContext ? '127.0.0.1' : 'silo.test'}:${port}`;

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
    // Function fixtures cannot cross the addInitScript boundary, so RPC
    // fixtures are passed as source and rebuilt inside the page.
    const rpcSrc = {};
    Object.entries((opts && opts.rpc) || {}).forEach(([k, v]) => { rpcSrc[k] = String(v); });
    await page.addInitScript(({ t, rpc, broken, missingColumns }) => {
      window.__FIXTURE_TABLES__ = t;
      window.__FIXTURE_BROKEN__ = broken;
      window.__FIXTURE_MISSING_COLUMNS__ = missingColumns;
      window.__FIXTURE_RPC__ = {};
      Object.entries(rpc).forEach(([k, src]) => {
        // eslint-disable-next-line no-eval
        window.__FIXTURE_RPC__[k] = eval('(' + src + ')');
      });
    }, { t: tables, rpc: rpcSrc, broken: (opts && opts.broken) || [], missingColumns: (opts && opts.missingColumns) || {} });
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

module.exports = { startSuite, REPO_ROOT, fakeSupabaseScript, CONFIG_STUB };
