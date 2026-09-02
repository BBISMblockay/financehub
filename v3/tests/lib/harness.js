/* Browser harness: serve the repo, stub the CDN, hand back a page.
 *
 * Every browser suite needs the same six lines of setup -- a static server
 * over the repo, and route stubs for the four CDN scripts the v3 pages load
 * plus Google Fonts. Those lines were copy-pasted across five files, which
 * is how the hardcoded Chromium path in each of them would have gone stale
 * one at a time. One copy, here.
 *
 * What is stubbed and why:
 *   pages/config.js       real credentials -- replaced by a fake pointing at
 *                         the fake Supabase client
 *   @supabase/supabase-js an in-memory stand-in (fixtures/fake-supabase.js),
 *                         so a suite can assert on what reached the RPC
 *   echarts, gridstack    served from node_modules rather than the CDN, so
 *                         the suite runs offline and pins the same versions
 *                         the pages pin
 *   fonts.googleapis.com  empty CSS; a font fetch is not under test
 *
 * NOTE the pages themselves are served UNMODIFIED from the repo. The point
 * of these suites is that the real dashboard.html runs the real
 * dashboard-renderer.js; only the outside world is faked. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(__dirname, '..', 'browser', 'fixtures');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

/**
 * Where Chromium lives.
 *
 * Three ways, most explicit first, because this has to work in two very
 * different places: a sandbox with a pre-installed browser at a pinned
 * build number, and GitHub Actions after `npx playwright install chromium`.
 * Returning undefined lets Playwright resolve it itself, which is correct
 * in CI and wrong in the sandbox (the image's build number and the npm
 * package's expected build number do not match).
 */
function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  // Stable symlink provided by the Claude Code sandbox image.
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
      + '    cd v3/tests && npm install && npx playwright install chromium\n'
      + 'Unit suites need nothing: node v3/tests/run.js --unit');
  }
}

/** Resolve a file inside v3/tests/node_modules, or the repo's own. */
function vendored(rel) {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', rel),
    path.join(REPO_ROOT, 'node_modules', rel),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`missing vendored asset ${rel} — run npm install in v3/tests`);
  return hit;
}

/**
 * Start a suite: static server + browser + stubbed context.
 *
 * `extraRoutes` is a { globPattern: {contentType, body} } map for the few
 * suites that need more (the Ask SILO page pulls in marked/dompurify).
 */
async function startSuite(options = {}) {
  const viewport = options.viewport || { width: 1440, height: 900 };
  const { chromium } = requirePlaywright();

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(String(req.url).split('?')[0]);
    const file = path.join(REPO_ROOT, rel);
    // Never serve outside the repo, even in a test.
    if (!file.startsWith(REPO_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
    return res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const launchOpts = {};
  const exe = chromiumPath();
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);

  const serve = (file, contentType) => ({ status: 200, contentType, body: fs.readFileSync(file) });

  /* Applied to EVERY context, not just the first. A suite that opens a
     second context (the mobile-width checks do) needs the identical stub
     set, and wiring it by hand there is how the two drift apart. */
  async function stub(context) {
    await context.route('**/pages/config.js', (r) => r.fulfill(serve(path.join(FIXTURES, 'fake-config.js'), 'text/javascript')));
    await context.route('**/@supabase/supabase-js**', (r) => r.fulfill(serve(path.join(FIXTURES, 'fake-supabase.js'), 'text/javascript')));
    await context.route('**/echarts**', (r) => r.fulfill(serve(vendored('echarts/dist/echarts.min.js'), 'text/javascript')));
    await context.route('**/gridstack-all.js', (r) => r.fulfill(serve(vendored('gridstack/dist/gridstack-all.js'), 'text/javascript')));
    await context.route('**/gridstack.min.css', (r) => r.fulfill(serve(vendored('gridstack/dist/gridstack.min.css'), 'text/css')));
    await context.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    for (const [pattern, body] of Object.entries(options.extraRoutes || {})) {
      await context.route(pattern, (r) => r.fulfill({
        status: 200,
        contentType: body.contentType || 'text/javascript',
        body: body.body,
      }));
    }
    return context;
  }

  /** A second browser context with the same stubs -- e.g. a phone viewport. */
  async function newContext(opts) {
    return stub(await browser.newContext(opts));
  }

  const ctx = await newContext({ viewport });

  /**
   * A page plus the console/page errors it produced. Every suite asserts
   * "no page errors throughout" at the end, and that assertion is only
   * meaningful if the listener is attached before the first navigation.
   */
  async function newPage() {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    return { page, errors };
  }

  async function close() {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  return { BASE, ctx, browser, newPage, newContext, close };
}

/** Opt the fake DB into surviving a reload, for suites that seed then reload. */
const PERSIST_FAKE_DB = () => {
  try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch (e) { /* ignore */ }
};

module.exports = { startSuite, chromiumPath, REPO_ROOT, FIXTURES, PERSIST_FAKE_DB };
