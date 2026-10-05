// Execute a standalone landing page (/demo.html, or LANDING_PAGE=redo-welcome.html) and its controller using local fixtures. The only allowed POST
// is intercepted below and answered in-process: no production database, account,
// invite, payment or real interest entry is touched by this suite.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// What differs between the two pages that share the early-access controller.
const PROFILES = {
  'demo.html': { css: 'assets/landing/early-access.css', image: '#lpDemoPlaceholder img', button: 'Join for early access',
    company: 'Company Name', email: 'Email', heroCta: false, marker: (page) => page.getByText('Product walkthrough coming soon', { exact: true }) },
  'redo-welcome.html': { css: 'assets/landing/redo-welcome.css', image: '.lp-hub-core', button: 'Request Redo access',
    company: 'Company', email: 'Work email', heroCta: true, marker: (page) => page.getByRole('heading', { name: 'Redo Marketing Performance' }) },
};
const PAGE = process.env.LANDING_PAGE || 'demo.html';
const P = PROFILES[PAGE];
assert.ok(P, 'Unknown LANDING_PAGE ' + PAGE);
const PAGE_URL = 'https://get-silo.com/' + PAGE;
const screenshots = fileURLToPath(new URL('./screenshots/early-access/' + PAGE.replace('.html', '') + '/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
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
const endpoint = 'https://fixture.supabase.co/functions/v1/onboarding-interest';
const videoPath = '/fixtures/product-demo.mp4';
const viewports = [['desktop', 1440, 900], ['laptop', 1366, 768], ['mobile', 390, 844],
  ['small-mobile', 320, 640], ['tablet', 768, 1024], ['breakpoint', 900, 800], ['wide', 1920, 1080]];

// A valid local MP4 stands in only for the configured video asset. Its decoded
// frames are real, and this helper is also exercised by the Node unit suite.
async function fulfillVideo(route, bytes) {
  const headers = { 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  const range = route.request().headers().range;
  if (!range) return route.fulfill({ contentType: 'video/mp4', headers, body: bytes });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
  const end = match?.[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
    return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } });
  }
  return route.fulfill({ status: 206, contentType: 'video/mp4', headers: {
    ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1),
  }, body: bytes.subarray(start, end + 1) });
}

async function fixture({ session = null, reducedMotion = 'no-preference', unavailable = false,
  missingConfig = false, videoUrl = '', failedVideo = false,
  respond = async () => ({ status: 200, body: { ok: true } }) } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion, serviceWorkers: 'block' });
  const requests = [];
  const submissions = [];
  let receivedSubmission;
  const firstSubmission = new Promise(resolve => { receivedSubmission = resolve; });
  await context.addInitScript(value => { globalThis.__testSession = value; }, session);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const record = { method: request.method(), origin: url.origin, pathname: url.pathname, fixture: false };
    requests.push(record); requestLog.push(record);
    if (url.href === endpoint && ['POST', 'OPTIONS'].includes(request.method())) {
      record.fixture = true;
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'apikey, content-type' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const payload = request.postDataJSON();
      submissions.push({ payload, headers: request.headers() });
      receivedSubmission();
      const result = await respond(submissions.length, payload);
      if (result.abort) return route.abort('failed');
      return route.fulfill({ status: result.status, contentType: 'application/json', headers,
        body: typeof result.body === 'string' ? result.body : JSON.stringify(result.body) });
    }
    if (request.method() !== 'GET') {
      failures.push('Unexpected write attempt: ' + request.method() + ' ' + url.pathname);
      return route.abort();
    }
    if (url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/@supabase\/supabase-js@2(?:\/\+esm)?$/.test(url.pathname)) {
      record.fixture = true;
      if (unavailable) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: url.pathname.endsWith('/+esm') ? sdk + '\nexport {createClient};' : sdk + '\nwindow.supabase = {createClient};' });
    }
    // Only pre-existing public typography and Tailwind may use live GETs.
    // Every SILO host, SDK, data call and video is a fixture; APIs cannot escape.
    if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com'].includes(url.hostname)) return route.continue();
    if (!['get-silo.com', 'silo-baseballism.com'].includes(url.hostname)) {
      failures.push('Unexpected external request: ' + url.origin + url.pathname);
      return route.abort();
    }
    record.fixture = true;
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/pages/config.js') {
      const config = missingConfig ? {} : { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'fixture-'.repeat(10), LANDING_DEMO_VIDEO_URL: videoUrl };
      return route.fulfill({ contentType: 'text/javascript', body: 'window.__SILO_CONFIG__ = ' + JSON.stringify(config) + ';' });
    }
    if (url.pathname === videoPath) {
      if (failedVideo) return route.fulfill({ status: 404, body: 'Fixture media unavailable' });
      return fulfillVideo(route, await readFile(path.join(root, 'assets/landing/silo-hero-motion.mp4')));
    }
    const relative = url.pathname.slice(1);
    const allowed = [PAGE, 'pages/login.html', 'v2/beacon.css', 'v2/silo-brand.css',
      'legal/privacy.html', 'assets/landing/early-access.js', P.css,
      'assets/landing/redo-welcome-motion.js'];
    if (!allowed.includes(relative) && !/^assets\/landing\/silo-hero(?:-1080)?\.(webp|jpg)$/.test(relative)
      && !/^assets\/landing\/redo-demo-(?:chart|dashboard|ask-silo)\.png$/.test(relative)
      && !/^assets\/landing\/redo-demo-returns-marketing\.jpg$/.test(relative)) {
      failures.push('Unexpected fixture path: ' + relative);
      return route.abort();
    }
    if (unavailable && /\.(webp|jpg)$/.test(relative)) return route.abort();
    const filePath = path.join(root, relative);
    if (!existsSync(filePath)) return route.fulfill({ status: 404, body: 'Not found' });
    const contentType = { '.html': 'text/html', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript' }[path.extname(relative)];
    return route.fulfill({ contentType, body: await readFile(filePath) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  return { context, page, requests, submissions, firstSubmission, mediaRequests: () => requests.filter(request => request.pathname.endsWith('.mp4')) };
}

async function fillInterest(page) {
  await page.getByLabel('Name', { exact: true }).fill('Pat Example');
  await page.getByLabel(P.company, { exact: true }).fill('Example Company');
  await page.getByLabel(P.email, { exact: true }).fill('pat@example.test');
}

async function assertPreserved(page) {
  assert.equal(await page.locator('#lpName').inputValue(), 'Pat Example');
  assert.equal(await page.locator('#lpCompanyName').inputValue(), 'Example Company');
  assert.equal(await page.locator('#lpEmail').inputValue(), 'pat@example.test');
}

async function assertGeometry(page, name, width) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll('.lp-signin, #lpName, #lpCompanyName, #lpEmail, #lpJoinButton')]
      .map(element => ({ id: element.id || element.className, ...element.getBoundingClientRect().toJSON() })) }));
  assert.ok(geometry.scrollWidth <= geometry.width, `${name}: horizontal overflow`);
  for (const control of geometry.controls) {
    assert.ok(control.height >= 44 && control.width >= 44, `${name}: undersized ${control.id}`);
    assert.ok(control.x >= 0 && control.right <= width, `${name}: clipped ${control.id}`);
  }
}

try {
  const { context, page, mediaRequests } = await fixture();
  for (const [name, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(PAGE_URL);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(P.image).evaluate(el => {
      if (el instanceof HTMLImageElement) return el.decode();
    });
    assert.equal(await page.locator('html').getAttribute('data-mode'), 'landing');
    assert.equal(await page.locator('#router').count(), 0, 'standalone demo must not contain the homepage auth router');
    assert.equal(await page.locator('#lpDemoVideo').isVisible(), false);
    assert.equal(await page.locator('#lpDemoVideo').getAttribute('src'), null);
    assert.equal(await P.marker(page).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: P.button, exact: true }).isVisible(), true);
    assert.equal(await page.locator('#lpInterestForm input[required]').count(), 3);
    await assertGeometry(page, name, width);
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
    pass(`${name}: responsive, labeled early-access form and honest walkthrough placeholder`);
  }
  assert.deepEqual(mediaRequests(), [], 'no configured walkthrough means no media downloads');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE_URL);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Sign in');
  assert.equal(await page.locator('.lp-signin').evaluate(a => getComputedStyle(a).outlineStyle), 'solid');
  if (P.heroCta) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'lpHeroCta');
  }
  for (const id of ['lpName', 'lpCompanyName', 'lpEmail', 'lpJoinButton']) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), id);
  }
  pass('keyboard order reaches sign-in, all required fields and the primary action, skipping the honeypot');

  for (let i = 0; i < 2; i++) {
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/pages/login.html');
    assert.equal(await page.locator('#formPassword').isVisible(), true);
    assert.equal(await page.locator('#btnGoSignup').isVisible(), false);
    await page.goBack(); await page.waitForURL(PAGE_URL);
  }
  await page.goForward(); await page.waitForURL('**/pages/login.html');
  await page.goBack(); await page.waitForURL(PAGE_URL);
  pass('Sign in, repeated navigation and Back/Forward preserve the guest flow');

  await context.close();

  let releaseSubmit;
  const submitted = await fixture({ respond: async () => new Promise(resolve => { releaseSubmit = resolve; }) });
  await submitted.page.goto(PAGE_URL);
  await submitted.page.locator('#lpJoinButton').click();
  assert.equal(submitted.submissions.length, 0);
  assert.equal(await submitted.page.locator('#lpName').evaluate(input => input.validity.valueMissing), true);
  await fillInterest(submitted.page);
  await submitted.page.locator('#lpEmail').fill('not-an-email');
  await submitted.page.locator('#lpJoinButton').click();
  assert.equal(submitted.submissions.length, 0);
  await submitted.page.locator('#lpEmail').fill('pat@example.test');
  await submitted.page.locator('#lpInterestForm').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await submitted.page.waitForFunction(() => document.getElementById('lpJoinButton').disabled);
  await submitted.firstSubmission;
  assert.equal(submitted.submissions.length, 1, 'in-flight repeated submits send one request');
  assert.deepEqual(submitted.submissions[0].payload, { name: 'Pat Example', company_name: 'Example Company', email: 'pat@example.test', website: '' });
  releaseSubmit({ status: 200, body: { ok: true } });
  await submitted.page.waitForFunction(() => document.getElementById('lpFormStatus').textContent.includes('received'));
  const acknowledgement = await submitted.page.locator('#lpFormStatus').textContent();
  assert.match(acknowledgement, /early-access request has been received/i);
  assert.doesNotMatch(acknowledgement, /account created|invitation sent|signed up|already|duplicate/i);
  assert.equal(await submitted.page.locator('#lpJoinButton').isDisabled(), true);
  await submitted.page.locator('#lpInterestForm').evaluate(form => form.requestSubmit());
  assert.equal(submitted.submissions.length, 1, 'successful page cannot accidentally resubmit');
  await submitted.page.screenshot({ path: path.join(screenshots, 'interest-success.png'), fullPage: true });
  await submitted.context.close();
  pass('required validation, exact payload, in-flight duplicate protection and accessible non-enumerating success');

  const repeat = await fixture();
  await repeat.page.goto(PAGE_URL); await fillInterest(repeat.page);
  await repeat.page.locator('#lpJoinButton').click();
  await repeat.page.waitForFunction(() => document.getElementById('lpFormStatus').textContent.includes('received'));
  assert.equal(await repeat.page.locator('#lpFormStatus').textContent(), acknowledgement);
  await repeat.context.close();
  pass('a later duplicate submission receives the same acknowledgement without exposing queue membership');

  for (const [name, response] of [
    ['server error', { status: 500, body: { error: 'private backend details: existing email' } }],
    ['rate limit', { status: 429, body: { error: 'private rate-limit details' } }],
    ['invalid success body', { status: 200, body: { ok: false, status: 'already exists' } }],
    ['malformed response', { status: 200, body: 'not JSON' }],
    ['network interruption', { abort: true }],
  ]) {
    const failed = await fixture({ respond: async count => count === 1 ? response : { status: 200, body: { ok: true } } });
    await failed.page.goto(PAGE_URL); await fillInterest(failed.page);
    await failed.page.locator('#lpJoinButton').click();
    await failed.page.waitForFunction(() => document.getElementById('lpFormStatus').textContent.includes('try again'));
    assert.equal(await failed.page.locator('#lpJoinButton').isEnabled(), true);
    await assertPreserved(failed.page);
    const message = await failed.page.locator('#lpFormStatus').textContent();
    assert.doesNotMatch(message, /private|existing email|already exists/i);
    if (response.status === 429) assert.match(message, /few minutes/);
    await failed.page.screenshot({ path: path.join(screenshots, `interest-${name.replaceAll(' ', '-')}.png`), fullPage: true });
    await failed.page.locator('#lpJoinButton').click();
    await failed.page.waitForFunction(() => document.getElementById('lpFormStatus').textContent.includes('received'));
    assert.equal(failed.submissions.length, 2);
    await failed.context.close();
    pass(`${name}: generic error preserves all fields and explicit retry succeeds`);
  }

  const missing = await fixture({ missingConfig: true });
  await missing.page.goto(PAGE_URL); await fillInterest(missing.page);
  assert.equal(await missing.page.locator('#lpJoinButton').isDisabled(), true);
  await missing.page.waitForFunction(() => document.getElementById('lpFormStatus').textContent.length > 0);
  await assertPreserved(missing.page); assert.equal(missing.submissions.length, 0);
  assert.equal(await missing.page.locator('.lp-signin').isVisible(), true);
  await missing.context.close(); pass('missing configuration fails visibly without losing input or sending data');

  for (const url of ['', 'javascript:alert(1)', 'https://example.test/embed', 'http://example.test/demo.mp4']) {
    const invalid = await fixture({ videoUrl: url });
    await invalid.page.goto(PAGE_URL);
    assert.equal(await invalid.page.locator('#lpDemoVideo').isVisible(), false);
    assert.equal(await invalid.page.locator('#lpDemoVideo').getAttribute('src'), null);
    assert.equal(await invalid.page.locator('#lpDemoPlaceholder').isVisible(), true);
    assert.deepEqual(invalid.mediaRequests(), []);
    await invalid.context.close();
  }
  pass('empty/invalid/unsafe walkthrough configuration leaves the honest placeholder and downloads no video');

  const demo = await fixture({ videoUrl: 'https://get-silo.com' + videoPath, reducedMotion: 'reduce' });
  await demo.page.goto(PAGE_URL);
  assert.equal(await demo.page.locator('#lpDemoVideo').isVisible(), true);
  assert.equal(await demo.page.locator('#lpDemoPlaceholder').isVisible(), false);
  const videoState = await demo.page.locator('#lpDemoVideo').evaluate(video => ({ controls: video.controls, preload: video.preload, paused: video.paused, autoplay: video.autoplay }));
  assert.deepEqual(videoState, { controls: true, preload: 'none', paused: true, autoplay: false });
  assert.deepEqual(demo.mediaRequests(), [], 'configured video is still opt-in and does not preload');
  await demo.page.locator('#lpDemoVideo').evaluate(video => video.play());
  await demo.page.waitForFunction(() => { const video = document.getElementById('lpDemoVideo'); return video.videoWidth > 0 && video.currentTime > 0; });
  await demo.page.locator('#lpDemoVideo').evaluate(video => video.pause());
  assert.ok(demo.mediaRequests().length > 0);
  await demo.page.screenshot({ path: path.join(screenshots, 'configured-product-video.png'), fullPage: true });
  await demo.context.close(); pass('configured walkthrough uses real decoded, manually controlled video without autoplay or preload');

  const signedIn = await fixture({ session: { user: { id: 'fixture-user' } } });
  await signedIn.page.goto(PAGE_URL);
  assert.equal(signedIn.page.url(), PAGE_URL);
  assert.equal(await signedIn.page.locator('#lpInterestForm').isVisible(), true);
  assert.equal(await signedIn.page.locator('#lpJoinButton').isEnabled(), true);
  assert.equal(signedIn.submissions.length, 0);
  assert.ok(!signedIn.requests.some(request => request.origin.includes('jsdelivr') || request.origin.includes('supabase')),
    'demo visibility must never depend on auth SDK/session reads');
  await signedIn.page.goto(PAGE_URL + '#access_token=fixture&type=recovery');
  assert.equal(signedIn.page.url(), PAGE_URL + '#access_token=fixture&type=recovery');
  assert.equal(await signedIn.page.locator('#lpInterestForm').isVisible(), true);
  await signedIn.context.close(); pass('standalone demo remains viewable with an existing session and makes no auth reads or redirects');

  const offline = await fixture({ unavailable: true });
  await offline.page.goto(PAGE_URL);
  assert.equal(await offline.page.getByRole('link', { name: 'Sign in', exact: true }).isVisible(), true);
  await fillInterest(offline.page); await offline.page.locator('#lpJoinButton').click();
  await offline.page.waitForFunction(() => document.getElementById('lpFormStatus').textContent.includes('received'));
  await offline.context.close(); pass('unavailable artwork does not remove sign-in or break the standalone interest form');

  assert.deepEqual(failures, [], 'page errors or unapproved network requests');
  assert.ok(requestLog.every(request => request.method === 'GET' ||
    request.fixture && request.origin === 'https://fixture.supabase.co' && request.pathname === '/functions/v1/onboarding-interest'), 'all submissions are intercepted local fixtures');
  assert.ok(requestLog.filter(request => request.origin.includes('supabase')).every(request => request.fixture), 'no request reaches a data project');
  pass('request audit: every submission was mocked, with no account, invitation or production writes');
  console.log(`All ${checks.length} standalone-demo browser checks passed. Screenshots: tests/screenshots/early-access/`);
} finally {
  await writeFile(path.join(screenshots, 'fixture-requests.json'), JSON.stringify(requestLog, null, 2) + '\n');
  await browser.close();
}
