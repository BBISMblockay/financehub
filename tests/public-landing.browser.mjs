// Browser verification of the real HTML, served through local file fixtures.
// Auth is inert. All unrecognized hosts and every non-GET request are blocked.
// No real account, invitation, Supabase project, or production write is used.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
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
const requestLog = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };

const mediaPaths = ['/assets/landing/silo-hero-motion.mp4', '/assets/landing/silo-hero-motion-mobile.mp4'];
const viewports = [['desktop', 1440, 900], ['laptop', 1366, 768], ['mobile', 390, 844],
  ['small-mobile', 320, 640], ['tablet', 768, 1024], ['breakpoint', 900, 800], ['wide', 1920, 1080]];

// Serve the real encoded bytes, including browser byte-range requests for
// seeking/looping. No mocked "playing" event can make these tests pass.
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
  saveData = false, blockedAutoplay = false, failedVideo = false, missingController = false,
  unsupportedVideo = false, simulatedVisibility = false, pendingPlay = false, legacyMedia = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion, serviceWorkers: 'block' });
  const requests = [];
  await context.addInitScript(options => {
    globalThis.__testSession = options.session;
    // Only policy inputs are fixtures; decoded frames and media time remain real.
    const connection = new EventTarget();
    connection.saveData = options.saveData;
    Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
    globalThis.__testPlayCalls = 0;
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      globalThis.__testPlayCalls++;
      if (options.blockedAutoplay && globalThis.__testPlayCalls === 1) {
        return Promise.reject(new DOMException('Fixture autoplay policy', 'NotAllowedError'));
      }
      if (options.pendingPlay && globalThis.__testPlayCalls === 1) return new Promise(() => {});
      return nativePlay.apply(this, arguments);
    };
    if (options.legacyMedia) {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const media = matchMedia(query);
        const add = media.addEventListener.bind(media);
        Object.defineProperty(media, 'addEventListener', { value: undefined });
        media.addListener = callback => add('change', callback);
        return media;
      };
    }
    if (options.unsupportedVideo) HTMLMediaElement.prototype.canPlayType = () => '';
    if (options.simulatedVisibility) {
      globalThis.__testHidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => globalThis.__testHidden });
    }
  }, { session, saveData, blockedAutoplay, unsupportedVideo, simulatedVisibility, pendingPlay, legacyMedia });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // Omit query strings/fragments even though every auth token here is inert.
    const record = { method: request.method(), origin: url.origin, pathname: url.pathname, range: request.headers().range || null };
    requests.push(record);
    requestLog.push(record);
    if (request.method() !== 'GET') {
      failures.push('Unexpected write attempt: ' + request.method() + ' ' + url.pathname);
      return route.abort();
    }
    if (url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/@supabase\/supabase-js@2(?:\/\+esm)?$/.test(url.pathname)) {
      if (unavailable) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: url.pathname.endsWith('/+esm') ? sdk + '\nexport {createClient};' : sdk + '\nwindow.supabase = {createClient};' });
    }
    // The only live network is the pre-existing, public font / Tailwind assets.
    // SILO hosts and the SDK are always fixtures; all data/API hosts are blocked.
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
    const motionAsset = relative === 'assets/landing/silo-hero-motion.js' || mediaPaths.includes(url.pathname);
    if (!allowed.includes(relative) && !/^assets\/landing\/silo-hero(?:-1080)?\.(webp|jpg)$/.test(relative) && !motionAsset) {
      failures.push('Unexpected fixture path: ' + relative);
      return route.abort();
    }
    if (unavailable && relative.startsWith('assets/')) return route.abort();
    if (missingController && relative === 'assets/landing/silo-hero-motion.js') return route.abort();
    if (mediaPaths.includes(url.pathname)) {
      if (failedVideo) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Fixture media unavailable' });
      return fulfillVideo(route, await readFile(path.join(root, relative)));
    }
    const contentType = { '.html': 'text/html', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.js': 'text/javascript' }[path.extname(relative)];
    return route.fulfill({ contentType, body: await readFile(path.join(root, relative)) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  return { context, page, requests, mediaRequests: () => requests.filter(request => mediaPaths.includes(request.pathname)),
    restoreMedia() { failedVideo = false; } };
}

async function decodedStill(page) {
  await page.locator('.lp-visual img').evaluate(image => image.decode());
  assert.equal(await page.locator('.lp-visual img').evaluate(image => image.naturalWidth > 0 && getComputedStyle(image).visibility !== 'hidden'), true);
}

async function expectPlaying(page) {
  await page.waitForFunction(() => {
    const video = document.getElementById('lpHeroVideo');
    return document.getElementById('lpVisual').dataset.motion === 'playing' &&
      !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 &&
      Number(getComputedStyle(video).opacity) === 1 && getComputedStyle(video).display !== 'none' &&
      video.getBoundingClientRect().width > 0;
  }, null, { timeout: 15000 });
  const start = await page.locator('#lpHeroVideo').evaluate(video => ({ time: video.currentTime,
    frames: video.getVideoPlaybackQuality().totalVideoFrames }));
  await page.waitForFunction(initial => {
    const video = document.getElementById('lpHeroVideo');
    return !video.paused && video.currentTime !== initial.time &&
      video.getVideoPlaybackQuality().totalVideoFrames >= initial.frames + 2;
  }, start, { timeout: 10000 });
  assert.equal(await page.locator('#lpMotionToggle').textContent(), 'Pause animation');
  assert.equal(await page.locator('#lpMotionToggle').isVisible(), true);
}

async function expectStill(page) {
  await page.waitForFunction(() => {
    const video = document.getElementById('lpHeroVideo');
    return video.paused && document.getElementById('lpVisual').dataset.motion === 'still' &&
      (getComputedStyle(video).display === 'none' || Number(getComputedStyle(video).opacity) === 0);
  });
  await decodedStill(page);
}

async function expectFrozen(page) {
  assert.equal(await page.locator('#lpHeroVideo').evaluate(video => video.paused), true);
  const time = await page.locator('#lpHeroVideo').evaluate(video => video.currentTime);
  // A pause must hold, not just be true between an automatic pause/replay pair.
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#lpHeroVideo').evaluate(video => video.currentTime), time);
}

async function expectNoMedia(f, { manual = false, message = /motion|data saving/i } = {}) {
  await f.page.locator('#lpVisual').scrollIntoViewIfNeeded();
  await f.page.waitForTimeout(250); // Give the real intersection callback a chance to run.
  await expectStill(f.page);
  assert.equal(await f.page.locator('#lpHeroVideo').getAttribute('src'), null);
  assert.equal(await f.page.evaluate(() => globalThis.__testPlayCalls), 0);
  assert.equal(await f.page.locator('#lpMotionToggle').isVisible(), manual);
  if (manual) await expectManualStatus(f.page, message);
  assert.deepEqual(f.mediaRequests(), [], 'the static policy must not even request MP4 bytes');
}

async function expectManualStatus(page, message) {
  assert.equal(await page.locator('#lpMotionToggle').isVisible(), true);
  assert.equal(await page.locator('#lpMotionToggle').isEnabled(), true);
  assert.equal(await page.locator('#lpMotionToggle').textContent(), 'Play animation');
  assert.equal(await page.locator('#lpMotionStatus').isVisible(), true);
  assert.match(await page.locator('#lpMotionStatus').textContent(), message);
}

async function expectFallbackLink(page) {
  assert.equal(await page.getByRole('link', { name: 'Watch animation', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#lpMotionFallback').getAttribute('href'), mediaPaths[0]);
}

async function expectMotionControlsUsable(page) {
  for (const selector of ['#lpMotionToggle', '#lpMotionFallback']) {
    const control = page.locator(selector);
    if (!await control.isVisible()) continue;
    await control.scrollIntoViewIfNeeded();
    assert.equal(await control.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return element === hit || element.contains(hit);
    }), true, `${selector}: actionable control must not be clipped or obstructed`);
  }
}

async function assertGeometry(page, name, width) {
  const geometry = await page.evaluate(() => {
    const image = document.querySelector('.lp-visual img');
    const video = document.getElementById('lpHeroVideo');
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      imageFit: getComputedStyle(image).objectFit, videoFit: getComputedStyle(video).objectFit,
      image: image.getBoundingClientRect().toJSON(), video: video.getBoundingClientRect().toJSON(),
      actions: [...document.querySelectorAll('.lp-actions a, #lpMotionToggle, #lpMotionFallback')]
        .filter(a => a.getClientRects().length).map(a => a.getBoundingClientRect().toJSON()) };
  });
  assert.ok(geometry.scrollWidth <= geometry.width, `${name}: horizontal overflow`);
  assert.equal(geometry.imageFit, 'contain', `${name}: whole still must fit vertically`);
  assert.equal(geometry.videoFit, 'contain', `${name}: whole video must fit vertically`);
  // In reduced-motion CSS the video is display:none. Otherwise its artwork
  // rectangle must exactly match the still; swapping layers cannot shift layout.
  if (geometry.video.width) {
    for (const key of ['x', 'y', 'width', 'height']) assert.equal(geometry.video[key], geometry.image[key], `${name}: ${key} mismatch`);
  }
  for (const action of geometry.actions) {
    assert.ok(action.height >= 44 && action.width >= 44, `${name}: undersized action`);
    assert.ok(action.x >= 0 && action.right <= width, `${name}: action clipped`);
  }
}

try {
  const { context, page } = await fixture();
  for (const [name, width, height] of viewports) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width, height });
    await page.goto('https://get-silo.com/');
    await page.evaluate(() => document.fonts.ready);
    await decodedStill(page);
    assert.equal(await page.locator('html').getAttribute('data-mode'), 'landing');
    assert.equal(await page.locator('#router').isVisible(), false);
    await page.locator('#lpVisual').scrollIntoViewIfNeeded();
    await expectPlaying(page);
    const media = await page.locator('#lpHeroVideo').evaluate(video => ({ source: new URL(video.currentSrc).pathname,
      width: video.videoWidth, height: video.videoHeight, muted: video.muted, loop: video.loop, inline: video.playsInline }));
    assert.equal(media.source, mediaPaths[width <= 600 ? 1 : 0], `${name}: correct motion variant`);
    assert.equal(media.muted && media.loop && media.inline, true, `${name}: silent inline looping playback`);
    if (width <= 600) {
      assert.ok(media.width > 0 && media.width <= 720, `${name}: smaller mobile encode`);
      assert.ok(Math.abs(media.width / media.height - 1080 / 660) < .01, `${name}: mobile artwork aspect ratio`);
    } else assert.deepEqual([media.width, media.height], [1080, 660], `${name}: desktop encode dimensions`);
    await assertGeometry(page, name, width);
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectStill(page);
    await expectFrozen(page);
    await assertGeometry(page, `${name} still`, width);
    await page.screenshot({ path: path.join(screenshots, `${name}-still.png`), fullPage: true });
    pass(`${name}: real decoded motion and responsive still fallback`);
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

  const motion = await fixture({ simulatedVisibility: true });
  await motion.page.goto('https://get-silo.com/');
  await expectPlaying(motion.page);
  assert.ok(motion.mediaRequests().length > 0, 'real local video bytes must have been requested');
  await motion.page.locator('#lpHeroVideo').evaluate(video => { video.currentTime = video.duration - .2; });
  await motion.page.waitForFunction(() => {
    const video = document.getElementById('lpHeroVideo');
    return !video.paused && video.currentTime < 1;
  }, null, { timeout: 10000 });
  await expectPlaying(motion.page);
  pass('the real MP4 decodes, advances, seeks, and loops across its end');

  // A spacer lets us move the artwork completely offscreen using real scrolling
  // and IntersectionObserver, without changing the production layout.
  await motion.page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '150vh';
    document.body.append(spacer);
  });
  for (let i = 0; i < 2; i++) {
    await motion.page.locator('#lpMotionToggle').focus();
    await motion.page.keyboard.press('Enter');
    assert.equal(await motion.page.locator('#lpVisual').getAttribute('data-motion'), 'paused');
    assert.equal(await motion.page.locator('#lpMotionToggle').textContent(), 'Play animation');
    await expectFrozen(motion.page);
    await motion.page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expectStill(motion.page);
    await motion.page.locator('#lpVisual').scrollIntoViewIfNeeded();
    await motion.page.waitForFunction(() => document.getElementById('lpVisual').dataset.motion === 'paused');
    await motion.page.evaluate(() => { globalThis.__testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await expectStill(motion.page);
    await motion.page.evaluate(() => { globalThis.__testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expectFrozen(motion.page);
    assert.equal(await motion.page.locator('#lpMotionToggle').textContent(), 'Play animation');
    await motion.page.emulateMedia({ reducedMotion: 'reduce' });
    await expectStill(motion.page);
    await motion.page.emulateMedia({ reducedMotion: 'no-preference' });
    await motion.page.waitForFunction(() => document.getElementById('lpVisual').dataset.motion === 'paused');
    await expectFrozen(motion.page);
    await motion.page.locator('#lpMotionToggle').click();
    await expectPlaying(motion.page);
  }
  pass('repeated keyboard Pause/Play and user pause survive offscreen, visibility-event, and preference changes');

  for (let i = 0; i < 2; i++) {
    await motion.page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expectStill(motion.page);
    await expectFrozen(motion.page);
    await motion.page.locator('#lpVisual').scrollIntoViewIfNeeded();
    await expectPlaying(motion.page);
    // Headless tab activation is not a reliable visibility signal. The browser
    // event/input are fixtures here; media pause/resume and frames are real.
    await motion.page.evaluate(() => { globalThis.__testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await expectStill(motion.page);
    await expectFrozen(motion.page);
    await motion.page.evaluate(() => { globalThis.__testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expectPlaying(motion.page);
  }
  await motion.page.emulateMedia({ reducedMotion: 'reduce' });
  await expectStill(motion.page);
  await expectFrozen(motion.page);
  await expectManualStatus(motion.page, /motion.*off|device/i);
  await motion.page.emulateMedia({ reducedMotion: 'no-preference' });
  await expectPlaying(motion.page);
  await motion.page.evaluate(() => { navigator.connection.saveData = true; navigator.connection.dispatchEvent(new Event('change')); });
  await expectStill(motion.page);
  await expectFrozen(motion.page);
  await motion.page.evaluate(() => { navigator.connection.saveData = false; navigator.connection.dispatchEvent(new Event('change')); });
  await expectPlaying(motion.page);
  await motion.page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await expectStill(motion.page);
  await motion.page.evaluate(() => dispatchEvent(new Event('pageshow')));
  await expectPlaying(motion.page);
  await motion.context.close();
  pass('offscreen, simulated hidden/pagehide, live reduced-motion and data-saver changes pause real media and restore the still');

  for (const [name, options, width = 1440, height = 900] of [
    ['reduced-motion', { reducedMotion: 'reduce' }],
    ['reduced-motion-mobile', { reducedMotion: 'reduce' }, 390, 844],
    ['reduced-motion-small-mobile', { reducedMotion: 'reduce' }, 320, 640],
    ['save-data', { saveData: true }],
    ['combined-policies', { reducedMotion: 'reduce', saveData: true }],
    ['legacy-media-query', { reducedMotion: 'reduce', legacyMedia: true }],
  ]) {
    const restricted = await fixture(options);
    await restricted.page.setViewportSize({ width, height });
    await restricted.page.goto('https://get-silo.com/');
    if (options.reducedMotion) assert.equal(await restricted.page.locator('.lp-signin').evaluate(a => getComputedStyle(a).transitionDuration), '0s');
    await expectNoMedia(restricted, { manual: true, message: options.saveData ? /data.*saving|download/i : /motion.*off|device/i });
    await assertGeometry(restricted.page, name, width);
    await expectMotionControlsUsable(restricted.page);
    await restricted.page.screenshot({ path: path.join(screenshots, `${name}-initial.png`), fullPage: true });
    await restricted.page.locator('#lpMotionToggle').focus();
    await restricted.page.keyboard.press('Enter');
    await expectPlaying(restricted.page);
    await expectMotionControlsUsable(restricted.page);
    assert.equal(await restricted.page.locator('#lpVisual').getAttribute('data-user-motion'), 'true');
    assert.ok(restricted.mediaRequests().length > 0, 'only the explicit click should start downloading');
    await restricted.page.screenshot({ path: path.join(screenshots, `${name}-manual.png`), fullPage: true });
    await restricted.page.locator('#lpMotionToggle').click();
    await expectFrozen(restricted.page);
    await restricted.page.locator('#lpMotionToggle').click();
    await expectPlaying(restricted.page);
    if (options.reducedMotion) {
      await restricted.page.emulateMedia({ reducedMotion: 'no-preference' });
      // Chromium may coalesce back-to-back preference updates before dispatching
      // a change event. Observe the first edge revoking the explicit opt-in.
      await restricted.page.waitForFunction(() =>
        document.getElementById('lpVisual').dataset.userMotion !== 'true');
      await restricted.page.emulateMedia({ reducedMotion: 'reduce' });
    } else {
      await restricted.page.evaluate(() => { navigator.connection.saveData = false; navigator.connection.dispatchEvent(new Event('change')); });
      await restricted.page.evaluate(() => { navigator.connection.saveData = true; navigator.connection.dispatchEvent(new Event('change')); });
    }
    await expectStill(restricted.page);
    await expectFrozen(restricted.page);
    assert.equal(await restricted.page.locator('#lpVisual').getAttribute('data-user-motion'), null);
    await expectManualStatus(restricted.page, /motion|data saving/i);
    await restricted.page.locator('#lpMotionToggle').click();
    await expectPlaying(restricted.page);
    const requestedBeforeReload = restricted.mediaRequests().length;
    await restricted.page.reload();
    await restricted.page.locator('#lpVisual').scrollIntoViewIfNeeded();
    await restricted.page.waitForTimeout(250);
    await expectStill(restricted.page);
    assert.equal(await restricted.page.locator('#lpHeroVideo').getAttribute('src'), null, 'opt-in is limited to this page lifetime');
    assert.equal(restricted.mediaRequests().length, requestedBeforeReload, 'reload cannot reuse the previous opt-in to download');
    await restricted.context.close();
    pass(`${name}: static default, explicit keyboard play, pause/resume, policy revocation, and page-local permission`);
  }

  for (const options of [{ missingController: true }, { unsupportedVideo: true }]) {
    const fallback = await fixture(options);
    await fallback.page.goto('https://get-silo.com/');
    await expectNoMedia(fallback);
    await expectFallbackLink(fallback.page);
    assert.equal(await fallback.page.getByRole('link', { name: 'Sign in', exact: true }).isVisible(), true);
    assert.equal(await fallback.page.getByRole('link', { name: 'Create your SILO' }).isVisible(), true);
    const popupPromise = fallback.page.waitForEvent('popup');
    await fallback.page.getByRole('link', { name: 'Watch animation', exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForURL('**/assets/landing/silo-hero-motion.mp4');
    assert.ok(fallback.mediaRequests().length > 0, 'the plain link opens the actual local MP4 without controller help');
    await popup.close();
    await fallback.context.close();
  }
  pass('missing motion JavaScript and unsupported codec keep navigation and a working plain Watch animation link');

  const blocked = await fixture({ blockedAutoplay: true });
  await blocked.page.goto('https://get-silo.com/');
  await blocked.page.waitForFunction(() => document.getElementById('lpMotionStatus').textContent.includes('did not start'));
  await expectStill(blocked.page);
  await expectManualStatus(blocked.page, /did not start/i);
  await blocked.page.waitForTimeout(250);
  assert.equal(await blocked.page.evaluate(() => globalThis.__testPlayCalls), 1, 'failed autoplay must not retry itself');
  await blocked.page.screenshot({ path: path.join(screenshots, 'autoplay-blocked.png'), fullPage: true });
  await blocked.page.locator('#lpMotionToggle').click();
  await expectPlaying(blocked.page);
  assert.equal(await blocked.page.evaluate(() => globalThis.__testPlayCalls), 2);
  await blocked.context.close();
  pass('rejected autoplay keeps the still and a manual retry plays real media');

  for (const waitForWatchdog of [false, true]) {
    const stalled = await fixture({ pendingPlay: true });
    await stalled.page.goto('https://get-silo.com/');
    await stalled.page.waitForFunction(() => globalThis.__testPlayCalls === 1);
    await expectManualStatus(stalled.page, /loading/i);
    if (waitForWatchdog) {
      await stalled.page.waitForFunction(() => document.getElementById('lpMotionStatus').textContent.includes('did not start'), null, { timeout: 8000 });
      await expectStill(stalled.page);
      assert.equal(await stalled.page.evaluate(() => globalThis.__testPlayCalls), 1, 'the watchdog cannot start an automatic retry loop');
    }
    await stalled.page.locator('#lpMotionToggle').click();
    await expectPlaying(stalled.page);
    assert.equal(await stalled.page.evaluate(() => globalThis.__testPlayCalls), 2);
    await stalled.context.close();
  }
  pass('pending autoplay keeps Play reachable immediately and after the watchdog; explicit retry decodes real media');

  for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844], ['small-mobile', 320, 640]]) {
    const broken = await fixture({ failedVideo: true });
    await broken.page.setViewportSize({ width, height });
    await broken.page.goto('https://get-silo.com/');
    await broken.page.locator('#lpVisual').scrollIntoViewIfNeeded();
    await broken.page.waitForFunction(() => document.getElementById('lpHeroVideo').error !== null);
    await expectStill(broken.page);
    await expectFrozen(broken.page);
    assert.equal(await broken.page.locator('#lpMotionToggle').isVisible(), true);
    assert.equal(await broken.page.locator('#lpMotionToggle').textContent(), 'Retry animation');
    assert.equal(await broken.page.locator('#lpMotionStatus').isVisible(), true);
    assert.match(await broken.page.locator('#lpMotionStatus').textContent(), /could not load/i);
    await expectFallbackLink(broken.page);
    assert.ok(broken.mediaRequests().length > 0);
    const failedAttempts = await broken.page.evaluate(() => globalThis.__testPlayCalls);
    await broken.page.emulateMedia({ reducedMotion: 'reduce' });
    await broken.page.waitForFunction(() =>
      document.getElementById('lpMotionToggle').textContent === 'Play animation');
    await broken.page.emulateMedia({ reducedMotion: 'no-preference' });
    await broken.page.waitForFunction(() =>
      document.getElementById('lpMotionToggle').textContent === 'Retry animation');
    await expectStill(broken.page);
    assert.equal(await broken.page.evaluate(() => globalThis.__testPlayCalls), failedAttempts);
    await assertGeometry(broken.page, `${name} failed media`, width);
    await expectMotionControlsUsable(broken.page);
    await broken.page.screenshot({ path: path.join(screenshots, `video-unavailable-${name}.png`), fullPage: true });
    broken.restoreMedia();
    await broken.page.locator('#lpMotionToggle').click();
    await expectPlaying(broken.page);
    assert.equal(await broken.page.locator('#lpMotionFallback').isVisible(), false);
    await broken.context.close();
    pass(`${name}: real load error offers reachable Retry and Watch animation; explicit retry recovers`);
  }

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
  assert.ok(requestLog.every(request => request.method === 'GET'), 'no account or production write attempts');
  assert.ok(requestLog.every(request => !request.origin.includes('supabase')), 'the inert SDK must never call a data project');
  pass('request audit: only local page/media fixtures and allowlisted public static dependencies, with no data calls or writes');
  console.log(`All ${checks.length} browser checks passed. Screenshots: tests/screenshots/`);
} finally {
  await writeFile(path.join(screenshots, 'fixture-requests.json'), JSON.stringify(requestLog, null, 2) + '\n');
  await browser.close();
}
