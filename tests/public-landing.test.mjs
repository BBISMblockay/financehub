// Run the actual root-page scripts with inert auth fixtures. No network or
// credentials, account creation, invite redemption, or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = readFileSync(`${root}index.html`, 'utf8');
const inline = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.equal(inline.length, 2, 'test must exercise both actual inline scripts');

async function openRoot({ hostname = 'get-silo.com', hash = '', session = null,
  config = true, profile = {}, sessionError = null, profileError = null } = {}) {
  const attributes = new Map();
  const elements = new Map();
  const redirects = [];
  const timers = [];
  let authReads = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', style: {},
      classList: { add() {} } });
    return elements.get(id);
  };
  const location = { hostname, hash, replace: url => redirects.push(url) };
  const context = vm.createContext({
    location,
    window: { location, __SILO_CONFIG__: config ? { SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'fixture' } : {} },
    document: { documentElement: { setAttribute: (k, v) => attributes.set(k, v), getAttribute: k => attributes.get(k) }, getElementById: element },
    console: { error() {} },
    setTimeout: cb => timers.push(cb),
    createClient: () => ({
      auth: { getSession: async () => { authReads++; return { data: { session }, error: sessionError }; } },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: profileError }) }) }) }),
    }),
  });
  vm.runInContext(inline[0], context);
  const firstPaintMode = attributes.get('data-mode');
  vm.runInContext(inline[1].replace(/^\s*import .*;$/m, '').replace(/\binit\(\);\s*$/, 'globalThis.finished = init();'), context);
  await context.finished;
  timers.forEach(cb => cb());
  return { firstPaintMode, mode: attributes.get('data-mode'), redirects, authReads, element };
}

test('signed-out public hosts stay on the welcome page', async () => {
  for (const hostname of ['get-silo.com', 'www.get-silo.com', 'preview.get-silo.com']) {
    const page = await openRoot({ hostname });
    assert.equal(page.firstPaintMode, 'landing');
    assert.equal(page.mode, 'landing');
    assert.deepEqual(page.redirects, []);
  }
});

test('other hosts retain the existing signed-out login router', async () => {
  for (const hostname of ['silo-baseballism.com', 'get-silo.com.example.net', 'fakeget-silo.com', 'localhost']) {
    const page = await openRoot({ hostname });
    assert.equal(page.firstPaintMode, 'router');
    assert.deepEqual(page.redirects, ['/pages/login.html']);
  }
});

test('auth hashes take precedence and are preserved exactly, without reading a session', async () => {
  for (const hostname of ['get-silo.com', 'silo-baseballism.com']) {
    for (const hash of ['#access_token=test&refresh_token=refresh&type=recovery', '#refresh_token=test', '#type=invite&token=one%2Btwo', '#type=recovery', '#type=magiclink', '#type=signup', '#TYPE=RECOVERY']) {
      const page = await openRoot({ hostname, hash, config: false });
      assert.equal(page.firstPaintMode, 'router');
      assert.deepEqual(page.redirects, [`/pages/set-password.html${hash}`]);
      assert.equal(page.authReads, 0);
    }
  }
});

test('ordinary fragments do not turn the public page into the auth router', async () => {
  const page = await openRoot({ hash: '#welcome' });
  assert.equal(page.mode, 'landing');
  assert.deepEqual(page.redirects, []);
});

test('signed-in public visitors retain default and profile destinations', async () => {
  for (const [profile, expected] of [[{}, '/v2/finance.html'], [{ default_page: '/v3/dashboards.html' }, '/v3/dashboards.html']]) {
    const page = await openRoot({ session: { user: { id: 'fixture-user' } }, profile });
    assert.equal(page.mode, 'router');
    assert.deepEqual(page.redirects, [expected]);
  }
});

test('invalid profile destinations retain the existing safe Finance fallback', async () => {
  for (const default_page of ['https://example.net', '//example.net', '/', '/index.html', '/pages/login.html']) {
    const page = await openRoot({ session: { user: { id: 'fixture-user' } }, profile: { default_page } });
    assert.deepEqual(page.redirects, ['/v2/finance.html']);
  }
});

test('disabled profiles remain blocked instead of seeing the app', async () => {
  const page = await openRoot({ session: { user: { id: 'fixture-user' } }, profile: { is_active: false } });
  assert.equal(page.mode, 'router');
  assert.deepEqual(page.redirects, []);
  assert.equal(page.element('statusText').textContent, 'Account access is not active.');
});

test('profile lookup failures retain the existing app fallback', async () => {
  const page = await openRoot({ session: { user: { id: 'fixture-user' } }, profileError: new Error('offline') });
  assert.deepEqual(page.redirects, ['/v2/finance.html']);
});

test('missing config or failed session reads leave public links usable', async () => {
  for (const options of [{ config: false }, { sessionError: new Error('offline') }]) {
    const page = await openRoot(options);
    assert.equal(page.mode, 'landing');
    assert.deepEqual(page.redirects, []);
  }
});

test('non-public router still reports config/session errors without looping', async () => {
  for (const options of [{ config: false }, { sessionError: new Error('offline') }]) {
    const page = await openRoot({ hostname: 'silo-baseballism.com', ...options });
    assert.deepEqual(page.redirects, []);
    assert.match(page.element('manualLink').innerHTML, /href="\/pages\/login.html"/);
  }
});

test('welcome actions keep sign-in and collect only requested early-access information', () => {
  assert.match(html, /<a\b[^>]*class="bcn-btn lp-signin"[^>]*href="\/pages\/login\.html"[^>]*>Sign in<\/a>/);
  assert.match(html, /id="lpInterestForm"/);
  for (const [id, name, type] of [['lpName', 'name', 'text'], ['lpCompanyName', 'company_name', 'text'], ['lpEmail', 'email', 'email']]) {
    const input = html.match(new RegExp('<input\\b[^>]*id="' + id + '"[^>]*>'))?.[0];
    assert.ok(input, id + ' is present');
    assert.match(input, new RegExp('name="' + name + '"'));
    assert.match(input, new RegExp('type="' + type + '"'));
    assert.match(input, /\brequired\b/);
    assert.match(html, new RegExp('<label\\b[^>]*for="' + id + '"'));
  }
  assert.match(html, /id="lpJoinButton"[^>]*>Join for early access<\/button>/);
  assert.match(html, /id="lpWebsite"[^>]*name="website"/);
  assert.match(html, /id="lpFormStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /Create your SILO|lp-create|pricing|type="password"/i);
  for (const file of ['pages/login.html', 'v2/company-onboarding.html', 'legal/privacy.html']) assert.ok(existsSync(root + file));
  assert.match(readFileSync(root + 'v2/company-onboarding.html', 'utf8'), /if \(!token\) \{[\s\S]*?You need an invitation[\s\S]*?return;/);
});

test('unconfigured walkthrough is an honest placeholder, not decorative autoplay', () => {
  assert.match(html, /<source type="image\/webp"[^>]+silo-hero-1080.webp 1080w, \/assets\/landing\/silo-hero.webp 1800w/);
  assert.match(html, /<img src="\/assets\/landing\/silo-hero.jpg" width="1800" height="1100"/);
  for (const [file, budget] of [['silo-hero-1080.webp', 50000], ['silo-hero.webp', 120000], ['silo-hero.jpg', 200000]]) {
    assert.ok(statSync(root + 'assets/landing/' + file).size < budget, `${file} exceeds its byte budget`);
  }
  assert.match(html, /Product walkthrough coming soon/);
  const video = html.match(/<video\b[^>]*>[\s\S]*?<\/video>/g);
  assert.equal(video?.length, 1, 'exactly one configurable product video slot');
  assert.match(video[0], /id="lpDemoVideo"/);
  for (const attribute of ['controls', 'playsinline', 'preload="none"', 'hidden']) assert.ok(video[0].includes(attribute));
  assert.doesNotMatch(video[0], /\s(?:src|autoplay|loop)\s*(?:=|>|\s)/);
  assert.doesNotMatch(video[0], /<source\b/);
  assert.doesNotMatch(html, /lpHeroVideo|lpMotionToggle|lpMotionFallback|silo-hero-motion\.js/);
  assert.match(html, /<script src="\/assets\/landing\/early-access\.js\?v=\d+" defer><\/script>/);
});

test('keyboard focus, reduced motion, and mobile layout are explicit', () => {
  const css = html + readFileSync(root + 'assets/landing/early-access.css', 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: (?:900|640|600)px\)/);
  assert.match(html, /<nav aria-label="Legal and contact">/);
});

test('browser media fixtures serve actual, bounded MP4 byte ranges', async () => {
  const browserTest = readFileSync(new URL('./public-landing.browser.mjs', import.meta.url), 'utf8');
  const helper = browserTest.match(/^async function fulfillVideo\(route, bytes\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(helper, 'exercise the same Range response helper that the browser uses');
  const fulfillVideo = vm.runInNewContext('(' + helper + ')');
  const bytes = Buffer.from('0123456789');
  const request = range => fulfillVideo({ request: () => ({ headers: () => ({ range }) }), fulfill: result => result }, bytes);
  const full = await request(undefined);
  assert.equal(full.contentType, 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.ok(full.body.equals(bytes));
  for (const [range, contentRange, body] of [
    ['bytes=0-', 'bytes 0-9/10', '0123456789'],
    ['bytes=2-5', 'bytes 2-5/10', '2345'],
    ['bytes=8-999', 'bytes 8-9/10', '89'],
    ['bytes=-3', 'bytes 7-9/10', '789'],
    ['bytes=0-0', 'bytes 0-0/10', '0'],
  ]) {
    const result = await request(range);
    assert.equal(result.status, 206, range);
    assert.equal(result.contentType, 'video/mp4');
    assert.equal(result.headers['content-range'], contentRange, range);
    assert.equal(result.headers['content-length'], String(body.length), range);
    assert.equal(result.body.toString(), body, range);
  }
  for (const range of ['bytes=20-', 'bytes=5-2', 'bytes=-', 'bytes=0-1,3-4', 'not-a-range']) {
    const result = await request(range);
    assert.equal(result.status, 416, range);
    assert.equal(result.headers['content-range'], 'bytes */10');
  }
});

async function openGuestOnboarding(search = '') {
  const onboarding = readFileSync(root + 'v2/company-onboarding.html', 'utf8');
  const script = [...onboarding.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const elements = new Map();
  for (const tag of onboarding.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(tag[1], { hidden: /\bhidden\b/.test(tag[0]), textContent: '', className: '' });
  }
  let authReads = 0;
  const location = { search, href: '' };
  const context = vm.createContext({
    URLSearchParams,
    encodeURIComponent,
    window: { location, __SILO_CONFIG__: { SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'fixture' },
      supabase: { createClient: () => ({ auth: { getSession: async () => { authReads++; return { data: { session: null } }; } } }) } },
    document: { getElementById: id => elements.get(id) },
  });
  await vm.runInContext(script, context);
  return { location, authReads, elements };
}

test('existing company-onboarding guest destination shows the invitation gate and clickable onboarding support', async () => {
  const { location, authReads, elements } = await openGuestOnboarding();
  assert.equal(location.href, '', 'a guest without an invite must not be bounced to login');
  assert.equal(authReads, 0);
  assert.equal(elements.get('obTitle').textContent, 'You need an invitation');
  assert.equal(elements.get('obForm').hidden, true);
  assert.equal(elements.get('obResume').hidden, true);
  assert.equal(elements.get('obSupport').hidden, false);
  assert.match(readFileSync(root + 'v2/company-onboarding.html', 'utf8'), /id="obSupport"[^>]*>[^<]*<a href="mailto:support@get-silo.com">support@get-silo.com<\/a>/);
});

test('a signed-out founder invite keeps its exact token in the login return path', async () => {
  for (const token of ['fixture-token', 'fixture+slash/token=']) {
    const { location, authReads, elements } = await openGuestOnboarding('?invite=' + encodeURIComponent(token));
    const destination = new URL(location.href, 'https://get-silo.com');
    assert.equal(destination.pathname, '/pages/login.html');
    assert.equal(destination.searchParams.get('next'), '/v2/company-onboarding.html?invite=' + encodeURIComponent(token));
    assert.equal(destination.searchParams.get('invite'), null, 'founder tokens must not become organization invite tokens');
    assert.equal(authReads, 1);
    assert.equal(elements.get('obForm').hidden, true);
  }
});
