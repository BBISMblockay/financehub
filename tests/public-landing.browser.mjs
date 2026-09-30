// Browser verification of the real HTML, served through local file fixtures.
// Auth is inert. All unrecognized hosts and every non-GET request are blocked.
// No real account, invitation, Supabase project, or production write is used.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = fileURLToPath(new URL('./screenshots/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch();
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
const pass = name => { checks.push(name); console.log('PASS ' + name); };

async function fixture({ session = null, reducedMotion = 'no-preference', unavailable = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion, serviceWorkers: 'block' });
  await context.addInitScript(value => { globalThis.__testSession = value; }, session);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      failures.push('Unexpected write attempt: ' + request.method() + ' ' + url.pathname);
      return route.abort();
    }
    if (url.hostname === 'cdn.jsdelivr.net') {
      if (unavailable) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: url.pathname.endsWith('/+esm') ? sdk + '\nexport {createClient};' : sdk + '\nwindow.supabase = {createClient};' });
    }
    if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com'].includes(url.hostname)) return route.continue();
    if (!['get-silo.com', 'silo-baseballism.com'].includes(url.hostname)) {
      failures.push('Unexpected external request: ' + url.origin + url.pathname);
      return route.abort();
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({status: 204});
    if (url.pathname === '/pages/config.js') {
      return route.fulfill({ contentType: 'text/javascript', body: 'window.__SILO_CONFIG__ = {SUPABASE_URL:"https://fixture.supabase.co", SUPABASE_ANON_KEY:"' + 'fixture-'.repeat(10) + '"};' });
    }
    // Routing destinations are stop pages so no application data code runs.
    if (['/v2/finance.html', '/v3/dashboards.html', '/pages/set-password.html'].includes(url.pathname)) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture destination</title><h1>Routing destination verified</h1>' });
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const allowed = ['index.html', 'pages/login.html', 'v2/company-onboarding.html', 'v2/beacon.css', 'v2/silo-brand.css', 'legal/privacy.html'];
    if (!allowed.includes(relative) && !/^assets\/landing\/silo-hero(?:-1080)?\.(webp|jpg)$/.test(relative)) {
      failures.push('Unexpected fixture path: ' + relative);
      return route.abort();
    }
    if (unavailable && relative.startsWith('assets/')) return route.abort();
    const contentType = { '.html': 'text/html', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg' }[path.extname(relative)];
    return route.fulfill({ contentType, body: await readFile(path.join(root, relative)) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  return { context, page };
}

try {
  const { context, page } = await fixture();
  for (const [name, width, height] of [['desktop', 1440, 900], ['laptop', 1366, 768], ['mobile', 390, 844], ['small-mobile', 320, 640], ['tablet', 768, 1024], ['breakpoint', 900, 800], ['wide', 1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.goto('https://get-silo.com/');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.lp-visual img').evaluate(image => image.decode());
    assert.equal(await page.locator('html').getAttribute('data-mode'), 'landing');
    assert.equal(await page.locator('#router').isVisible(), false);
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      fit: getComputedStyle(document.querySelector('.lp-visual img')).objectFit,
      actions: [...document.querySelectorAll('.lp-actions a')].map(a => a.getBoundingClientRect().toJSON()),
    }));
    assert.ok(geometry.scrollWidth <= geometry.width, `${name}: horizontal overflow`);
    assert.equal(geometry.fit, 'contain', 'whole artwork must fit vertically');
    for (const action of geometry.actions) {
      assert.ok(action.height >= 44 && action.width >= 44);
      assert.ok(action.x >= 0 && action.right <= width, `${name}: action clipped`);
    }
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
    pass(`${name}: responsive layout and image decode`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('https://get-silo.com/');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Sign in');
  assert.equal(await page.locator('.lp-signin').evaluate(a => getComputedStyle(a).outlineStyle), 'solid');
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(() => document.activeElement.textContent.trim()), /^Create your SILO/);
  await page.keyboard.press('Enter');
  await page.waitForURL('**/v2/company-onboarding.html');
  assert.equal(await page.locator('#obTitle').textContent(), 'You need an invitation');
  assert.equal(await page.locator('#obForm').isVisible(), false);
  assert.equal(await page.locator('#obSupport').isVisible(), true);
  assert.equal(await page.locator('#obSupport a').getAttribute('href'), 'mailto:support@get-silo.com');
  await page.screenshot({ path: path.join(screenshots, 'onboarding-support.png'), fullPage: true });
  pass('keyboard activation opens the invitation gate with visible support');

  await page.goBack();
  await page.waitForURL('https://get-silo.com/');
  await page.goForward();
  await page.waitForURL('**/v2/company-onboarding.html');
  assert.equal(await page.locator('#obSupport').isVisible(), true);
  await page.goBack();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/pages/login.html');
    assert.equal(await page.locator('#formPassword').isVisible(), true);
    assert.equal(await page.locator('#btnGoSignup').isVisible(), false);
    await page.goBack();
    await page.waitForURL('https://get-silo.com/');
  }
  pass('Sign in, repeated navigation, and Back/Forward preserve the guest flow');

  const token = 'fixture+token/value=';
  await page.goto('https://get-silo.com/v2/company-onboarding.html?invite=' + encodeURIComponent(token));
  await page.waitForURL('**/pages/login.html?next=*');
  const loginUrl = new URL(page.url());
  assert.equal(loginUrl.searchParams.get('next'), '/v2/company-onboarding.html?invite=' + encodeURIComponent(token));
  assert.equal(loginUrl.searchParams.get('invite'), null);
  assert.equal(await page.locator('#btnGoSignup').isVisible(), true);
  await page.locator('#btnGoSignup').click();
  assert.equal(await page.locator('#dlgSignup').isVisible(), true);
  await page.locator('#btnCloseSignup').click();
  assert.equal(await page.locator('#dlgSignup').isVisible(), false);
  assert.equal(page.url(), loginUrl.href);
  await page.locator('#btnGoSignup').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dlgSignup').isVisible(), false);
  assert.equal(page.url(), loginUrl.href);
  pass('founder invite survives login and interrupted account-creation dialog');

  await page.goto('https://get-silo.com/#access_token=fixture&type=recovery');
  await page.waitForURL('**/pages/set-password.html#access_token=fixture&type=recovery');
  await page.goto('https://silo-baseballism.com/');
  await page.waitForURL('**/pages/login.html');
  pass('recovery hash and non-public-host router remain intact');
  await context.close();

  const reduced = await fixture({ reducedMotion: 'reduce' });
  await reduced.page.goto('https://get-silo.com/');
  assert.equal(await reduced.page.locator('.lp-signin').evaluate(a => getComputedStyle(a).transitionDuration), '0s');
  assert.equal(await reduced.page.locator('video').count(), 0);
  await reduced.context.close();
  pass('reduced motion: static artwork and no button transition');

  const signedIn = await fixture({ session: { user: { id: 'fixture-user' } } });
  await signedIn.page.goto('https://get-silo.com/');
  await signedIn.page.waitForURL('**/v3/dashboards.html');
  await signedIn.context.close();
  pass('signed-in visitor keeps the saved profile destination');

  const offline = await fixture({ unavailable: true });
  await offline.page.goto('https://get-silo.com/');
  assert.equal(await offline.page.getByRole('heading', { name: 'Welcome to Silo.' }).isVisible(), true);
  assert.equal(await offline.page.getByRole('link', { name: 'Sign in', exact: true }).isVisible(), true);
  assert.equal(await offline.page.getByRole('link', { name: 'Create your SILO' }).isVisible(), true);
  await offline.context.close();
  pass('unavailable SDK and artwork do not remove public navigation');

  assert.deepEqual(failures, [], 'page errors or unapproved network requests');
  console.log(`All ${checks.length} browser checks passed. Screenshots: tests/screenshots/`);
} finally {
  await browser.close();
}
