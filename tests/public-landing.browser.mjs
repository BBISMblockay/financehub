// Browser verification of get-silo.com index: early-access landing + auth router.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = fileURLToPath(new URL('./screenshots/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const sdk = `function createClient() {
  return {
    auth: {
      getSession: async () => ({data: {session: globalThis.__testSession || null}, error: null}),
      onAuthStateChange: () => ({data: {subscription: {unsubscribe() {}}}})
    },
    from: () => ({select: () => ({eq: () => ({maybeSingle: async () => ({
      data: {is_active: true, default_page: '/v3/dashboards.html'}, error: null
    })})})})
  };
}`;
const failures = [];
const checks = [];
const requestLog = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };

const viewports = [['desktop', 1440, 900], ['mobile', 390, 844]];

async function fixture({ session = null, unavailable = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const requests = [];
  await context.addInitScript(options => {
    globalThis.__testSession = options.session;
  }, { session });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requestLog.push({ method: request.method(), origin: url.origin, pathname: url.pathname });
    if (request.method() !== 'GET') {
      failures.push('Unexpected write attempt: ' + request.method() + ' ' + url.pathname);
      return route.abort();
    }
    if (url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/@supabase\/supabase-js@2(?:\/\+esm)?$/.test(url.pathname)) {
      if (unavailable) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: url.pathname.endsWith('/+esm') ? sdk + '\nexport {createClient};' : sdk + '\nwindow.supabase = {createClient};' });
    }
    if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com'].includes(url.hostname)) return route.continue();
    if (!['get-silo.com', 'silo-baseballism.com'].includes(url.hostname)) {
      failures.push('Unexpected external request: ' + url.origin + url.pathname);
      return route.abort();
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/pages/config.js') {
      return route.fulfill({ contentType: 'text/javascript', body: 'window.__SILO_CONFIG__ = {SUPABASE_URL:"https://fixture.supabase.co", SUPABASE_ANON_KEY:"' + 'fixture-'.repeat(10) + '"};' });
    }
    if (['/v2/finance.html', '/v3/dashboards.html', '/pages/set-password.html'].includes(url.pathname)) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture destination</title><h1>Routing destination verified</h1>' });
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.join(root, relative);
    const allowedPrefix = /^(index\.html|pages\/|v2\/|assets\/(landing\/|silo-icon|brands\/)|legal\/)/;
    if (!allowedPrefix.test(relative) && !/^assets\/landing\/silo-hero(?:-1080)?\.(webp|jpg)$/.test(relative)) {
      failures.push('Unexpected fixture path: ' + relative);
      return route.abort();
    }
    if (unavailable && relative.startsWith('assets/')) return route.abort();
    const contentType = { '.html': 'text/html', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(relative)];
    return route.fulfill({ contentType, body: await readFile(filePath) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  return { context, page };
}

try {
  const { context, page } = await fixture();
  for (const [name, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto('https://get-silo.com/');
    assert.equal(await page.locator('html').getAttribute('data-mode'), 'landing');
    assert.equal(await page.locator('#router').isVisible(), false);
    assert.equal(await page.getByRole('heading', { name: 'What you get' }).isVisible(), true);
    assert.equal(await page.locator('#lpAccess').isVisible(), true);
    assert.equal(await page.locator('#lpDemoVideo').getAttribute('src'), null);
    await page.screenshot({ path: path.join(screenshots, `index-${name}.png`), fullPage: true });
    pass(`${name}: early-access landing with honest walkthrough placeholder`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('https://get-silo.com/');
  await page.getByRole('link', { name: /Create your SILO/ }).click();
  await page.waitForFunction(() => location.hash === '#lpAccess');
  assert.equal(await page.locator('#lpInterestForm').isVisible(), true);
  pass('Create your SILO reaches the intake form on the same page');

  assert.equal(await page.getByRole('button', { name: 'Create your SILO', exact: true }).isVisible(), true);
  await page.locator('header .lp-signin').click();
  await page.waitForURL('**/pages/login.html');
  assert.equal(await page.locator('#formPassword').isVisible(), true);
  pass('Sign in reaches login from the landing header');

  const legalPage = await context.newPage();
  for (const [url, heading] of [['/legal/privacy.html', 'SILO — Privacy Policy'],
    ['/legal/eula.html', 'SILO — End-User License Agreement']]) {
    await legalPage.goto('https://get-silo.com' + url);
    assert.equal(await legalPage.getByRole('heading', { name: heading, exact: true }).isVisible(), true);
  }
  await legalPage.close();
  pass('privacy and terms are readable without authentication');

  await page.goto('https://get-silo.com/#access_token=fixture&type=recovery');
  await page.waitForURL('**/pages/set-password.html#access_token=fixture&type=recovery');
  await page.goto('https://silo-baseballism.com/');
  await page.waitForURL('**/pages/login.html');
  pass('recovery hash and non-public-host router remain intact');

  const token = 'fixture+token/value=';
  await page.goto('https://get-silo.com/v2/company-onboarding.html?invite=' + encodeURIComponent(token));
  await page.waitForURL('**/pages/login.html?next=*');
  const loginUrl = new URL(page.url());
  assert.equal(loginUrl.searchParams.get('next'), '/v2/company-onboarding.html?invite=' + encodeURIComponent(token));
  pass('founder invite still routes through login when opened directly');

  await context.close();

  const signedIn = await fixture({ session: { user: { id: 'fixture-user' } } });
  await signedIn.page.goto('https://get-silo.com/');
  await signedIn.page.waitForURL('**/v3/dashboards.html');
  await signedIn.context.close();
  pass('signed-in visitor keeps the saved profile destination');

  const offline = await fixture({ unavailable: true });
  await offline.page.goto('https://get-silo.com/');
  assert.equal(await offline.page.getByRole('link', { name: /Create your SILO/ }).isVisible(), true);
  assert.equal(await offline.page.locator('#lpInterestForm').isVisible(), true);
  await offline.context.close();
  pass('unavailable assets do not remove public navigation or the intake form');

  assert.deepEqual(failures, [], 'page errors or unapproved network requests');
  assert.ok(requestLog.every(request => request.method === 'GET'));
  pass('request audit: only allowlisted static fixtures, no data writes');
  console.log(`All ${checks.length} browser checks passed. Screenshots: tests/screenshots/`);
} finally {
  await writeFile(path.join(screenshots, 'fixture-requests.json'), JSON.stringify(requestLog, null, 2) + '\n');
  await browser.close();
}
