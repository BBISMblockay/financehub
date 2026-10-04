import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/landing/early-access.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/landing/early-access.css', import.meta.url), 'utf8');

test('existing home and shared config stay byte-identical to main c2b6f1e', () => {
  // Pin the reviewed main bytes so shallow CI needs no git history. A demo
  // change must never silently replace the user's existing homepage/router.
  const unchanged = {
    'index.html': '9a4c9b997ef349698fc572a7769622a89afffeb21c6fb5988d9c11403ce9673e',
    'pages/config.js': 'ee67cc20e8f76d35e1ea818674a24bb0a04f70ac025c14b0ede5ec8830bc6ea5',
  };
  for (const [file, hash] of Object.entries(unchanged)) {
    const bytes = readFileSync(new URL('../' + file, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, file);
  }
});

test('demo is standalone for all visitors, with no auth/session router or home redirect', () => {
  assert.match(html, /<html[^>]*data-mode="landing"/);
  assert.match(html, /<body class="lp-demo-page">/);
  assert.match(html, /href="\/pages\/login\.html">Sign in<\/a>/);
  assert.doesNotMatch(html, /id="router"|type="module"|getSession|createClient|location\.replace|location\.href|http-equiv="refresh"/);
  assert.doesNotMatch(source, /getSession|createClient|location\.replace|localStorage|sessionStorage/);
  assert.match(css, /\.lp-demo-page\s*\{[^}]*margin:\s*0;/);
  assert.match(css, /\.lp-demo-page[^}]*box-sizing:\s*border-box;/);
  assert.match(html, /\/pages\/config\.js[\s\S]*\/assets\/landing\/early-access\.js/);
});

function fixture({ mode = 'landing', config = {}, controllerSource = source, fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) } = {}) {
  const listeners = {};
  const elements = {};
  function element(id, extra = {}) {
    const el = {
      id, value: '', hidden: false, disabled: false, readOnly: false, textContent: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(type, fn) { listeners[id + ':' + type] = fn; },
      focus() { this.focused = true; },
      ...extra,
    };
    elements[id] = el;
    return el;
  }
  element('lpInterestForm', { reportValidity() { return ['lpName', 'lpCompanyName', 'lpEmail'].every(id => elements[id].value); } });
  element('lpJoinButton', { disabled: true, textContent: 'Request Redo access' });
  element('lpFormStatus', { hidden: true });
  element('lpName', { value: ' Test Person ' });
  element('lpCompanyName', { value: ' Example Company ' });
  element('lpEmail', { value: ' test@example.com ' });
  element('lpWebsite');
  element('lpDemoVideo', { hidden: true });
  element('lpDemoPlaceholder');
  element('lpDemoCaption', { textContent: 'A closer look at SILO is on the way.' });
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const window = {
    __SILO_CONFIG__: { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'public-fixture-key', ...config },
    location: { href: 'https://get-silo.com/demo.html', origin: 'https://get-silo.com' },
    fetch(url, options) { requests.push({ url, options }); return fetch(url, options); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(controllerSource, { window, document: {
    documentElement: { getAttribute: () => mode },
    getElementById: id => elements[id],
  }, URL, AbortController });
  return { elements, listeners, timers, requests, submit: () => listeners['lpInterestForm:submit']?.({ preventDefault() {} }) };
}

test('required, labelled intake fields and disabled native submission are present', () => {
  assert.match(html, /<form\b[^>]*id="lpInterestForm"[^>]*method="post"/);
  for (const [id, name, type, length] of [
    ['lpName', 'name', 'text', 120], ['lpCompanyName', 'company_name', 'text', 200], ['lpEmail', 'email', 'email', 254],
  ]) {
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`));
    const input = html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`))[0];
    assert.match(input, new RegExp(`name="${name}"`));
    assert.match(input, new RegExp(`type="${type}"`));
    assert.match(input, new RegExp(`maxlength="${length}"`));
    assert.match(input, /\brequired\b/);
  }
  assert.match(html, /<button[^>]*id="lpJoinButton"[^>]*disabled/);
  assert.match(html, /id="lpFormStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /class="lp-honeypot"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(html, /id="lpWebsite"[^>]*name="website"[^>]*tabindex="-1"/);
});

test('router mode does not attach form or load demo media', () => {
  const f = fixture({ mode: 'router', config: { LANDING_DEMO_VIDEO_URL: '/walkthrough.mp4' } });
  assert.equal(f.elements.lpJoinButton.disabled, true);
  assert.equal(f.listeners['lpInterestForm:submit'], undefined);
  assert.equal(f.elements.lpDemoVideo.src, undefined);
});

test('empty/unsafe configuration fails closed without a request', async () => {
  for (const url of ['', null, 'http://fixture.supabase.co', 'javascript:alert(1)', 'https://user:password@fixture.supabase.co', 'https://fixture.supabase.co/?x=1']) {
    const f = fixture({ config: { SUPABASE_URL: url } });
    assert.equal(f.elements.lpJoinButton.disabled, true, String(url));
    assert.match(f.elements.lpFormStatus.textContent, /temporarily unavailable/);
    await f.submit();
    assert.equal(f.requests.length, 0);
  }
});

test('trimmed required validation precedes network and does not accept spaces', async () => {
  const f = fixture();
  f.elements.lpName.value = '   ';
  await f.submit();
  assert.equal(f.requests.length, 0);
  assert.equal(f.elements.lpJoinButton.disabled, false);
});

test('successful POST sends only intake fields, public apikey, and no session credentials', async () => {
  const f = fixture();
  await f.submit();
  assert.equal(f.requests.length, 1);
  const { url, options } = f.requests[0];
  assert.equal(url, 'https://fixture.supabase.co/functions/v1/onboarding-interest');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(options.body), { name: 'Test Person', company_name: 'Example Company', email: 'test@example.com', website: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(options.headers)), { 'Content-Type': 'application/json', apikey: 'public-fixture-key' });
  assert.equal(options.signal instanceof AbortSignal, true);
  assert.match(f.elements.lpFormStatus.textContent, /request has been received/);
  assert.equal(f.elements.lpFormStatus.focused, true);
  assert.equal(f.elements.lpJoinButton.disabled, true);
  assert.equal(f.elements.lpJoinButton.textContent, 'Request Redo access');
  assert.equal(f.elements.lpName.readOnly, true);
  assert.equal(f.timers.size, 0);
  await f.submit();
  assert.equal(f.requests.length, 1, 'a received request is not immediately re-posted');
});

test('pending request has one in-flight POST, busy status and a 15s timeout', async () => {
  let resolve;
  const f = fixture({ fetch: () => new Promise(r => { resolve = r; }) });
  const first = f.submit();
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.lpInterestForm.attributes['aria-busy'], 'true');
  assert.equal(f.elements.lpName.readOnly, true);
  assert.equal(f.elements.lpJoinButton.textContent, 'Sending…');
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [15000]);
  await f.submit();
  assert.equal(f.requests.length, 1);
  resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await first;
  assert.equal(f.elements.lpInterestForm.attributes['aria-busy'], undefined);
});

test('HTTP failures, malformed JSON and non-boolean ok preserve values and allow retry', async () => {
  const cases = [
    { ok: false, status: 500, json: async () => ({ ok: true, error: 'private database detail' }) },
    { ok: true, status: 200, json: async () => { throw new Error('json'); } },
    { ok: true, status: 200, json: async () => ({ ok: false, duplicate: true, account_exists: true }) },
    { ok: true, status: 200, json: async () => ({ ok: 'true' }) },
    { ok: true, status: 204, json: async () => null },
  ];
  for (const response of cases) {
    const f = fixture({ fetch: async () => response });
    await f.submit();
    assert.match(f.elements.lpFormStatus.textContent, /couldn’t submit/);
    assert.doesNotMatch(f.elements.lpFormStatus.textContent, /private|duplicate|account/);
    assert.equal(f.elements.lpName.value, 'Test Person');
    assert.equal(f.elements.lpCompanyName.value, 'Example Company');
    assert.equal(f.elements.lpEmail.value, 'test@example.com');
    assert.equal(f.elements.lpJoinButton.disabled, false);
    assert.equal(f.elements.lpName.readOnly, false);
    assert.equal(f.timers.size, 0);
    await f.submit();
    assert.equal(f.requests.length, 2);
  }
});

test('rate limits explain when to retry without exposing server details', async () => {
  const f = fixture({ fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: 'ip_limit secret' }) }) });
  await f.submit();
  assert.match(f.elements.lpFormStatus.textContent, /wait a few minutes/);
  assert.doesNotMatch(f.elements.lpFormStatus.textContent, /ip_limit|secret/);
  assert.equal(f.elements.lpJoinButton.disabled, false);
});

test('regression checks reject mutations that report success without a confirmed write', async () => {
  // Mutate only the in-memory source, never the shared checkout. The same
  // checks must reject both a removed HTTP guard and a removed body guard.
  const guard = 'if (!response.ok || body?.ok !== true) {';
  assert.ok(source.includes(guard));
  const cases = [
    ['if (false) {', { ok: false, status: 500, json: async () => ({ ok: false }) }],
    ['if (body?.ok !== true) {', { ok: false, status: 500, json: async () => ({ ok: true }) }],
    ['if (!response.ok) {', { ok: true, status: 200, json: async () => ({ ok: false }) }],
  ];
  function assertFailureState(f) {
    assert.match(f.elements.lpFormStatus.textContent, /couldn’t submit/);
    assert.equal(f.elements.lpJoinButton.disabled, false);
    assert.equal(f.elements.lpEmail.value, 'test@example.com');
  }
  for (const [replacement, response] of cases) {
    const control = fixture({ fetch: async () => response });
    await control.submit();
    assertFailureState(control);
    const mutated = fixture({ controllerSource: source.replace(guard, replacement), fetch: async () => response });
    await mutated.submit();
    assert.throws(() => assertFailureState(mutated), { name: 'AssertionError' });
  }
});

test('network and timeout errors keep inputs and are honestly unconfirmed', async () => {
  const failed = fixture({ fetch: async () => { throw new Error('Disconnected'); } });
  await failed.submit();
  assert.match(failed.elements.lpFormStatus.textContent, /couldn’t confirm/);
  assert.equal(failed.elements.lpEmail.value, 'test@example.com');
  assert.equal(failed.elements.lpJoinButton.disabled, false);
  const timeout = fixture({ fetch: (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('abort')));
  }) });
  const request = timeout.submit();
  [...timeout.timers.values()][0].fn();
  await request;
  assert.match(timeout.elements.lpFormStatus.textContent, /couldn’t confirm/);
  assert.equal(timeout.elements.lpEmail.value, 'test@example.com');
  assert.equal(timeout.elements.lpJoinButton.disabled, false);
  assert.equal(timeout.timers.size, 0);
});

test('optional anon key is not replaced with account Authorization and honeypot is sent', async () => {
  const f = fixture({ config: { SUPABASE_ANON_KEY: '' } });
  f.elements.lpWebsite.value = 'filled-by-bot';
  await f.submit();
  assert.deepEqual(Object.keys(f.requests[0].options.headers), ['Content-Type']);
  assert.equal(JSON.parse(f.requests[0].options.body).website, 'filled-by-bot');
});

test('absent demo stays an honest still with no fake active play or old animation load', () => {
  const f = fixture();
  assert.equal(f.elements.lpDemoVideo.hidden, true);
  assert.equal(f.elements.lpDemoVideo.src, undefined);
  assert.equal(f.elements.lpDemoPlaceholder.hidden, false);
  const landing = html;
  assert.match(landing, /assets\/landing\/silo-hero\.jpg/);
  assert.match(landing, /Redo Marketing Performance/);
  assert.match(landing, /Sample · Last 30 days/);
  assert.match(landing, /lp-bars/);
  assert.doesNotMatch(landing, /silo-web-flow\.png|Silo workspace/);
  assert.doesNotMatch(landing, /<iframe|autoplay|\bloop\b|Play animation|Watch animation|lpMotionToggle|lpMotionFallback/);
  assert.doesNotMatch(html, /<script[^>]*silo-hero-motion/);
});

test('only safe direct media URLs enable native controls and errors restore the still', () => {
  for (const url of ['/assets/demo.mp4', 'https://cdn.example.com/demo.webm?version=1', 'https://get-silo.com/demo.ogv']) {
    const f = fixture({ config: { LANDING_DEMO_VIDEO_URL: url } });
    assert.equal(f.elements.lpDemoVideo.hidden, false, url);
    assert.equal(f.elements.lpDemoPlaceholder.hidden, true);
    assert.match(f.elements.lpDemoVideo.src, /^https:\/\//);
    f.listeners['lpDemoVideo:error']();
    assert.equal(f.elements.lpDemoVideo.hidden, true);
    assert.equal(f.elements.lpDemoPlaceholder.hidden, false);
    assert.match(f.elements.lpDemoCaption.textContent, /couldn’t load/);
  }
  for (const url of ['', 'javascript:alert(1)', 'data:video/mp4,test', '//evil.example/video.mp4', 'https://user:password@cdn.example.com/video.mp4',
    'http://cdn.example.com/video.mp4', 'https://cdn.example.com/embed/1', 'https://cdn.example.com/video.html', 'https://cdn.example.com/a b.mp4', '\\evil.example\\video.mp4']) {
    const f = fixture({ config: { LANDING_DEMO_VIDEO_URL: url } });
    assert.equal(f.elements.lpDemoVideo.src, undefined, url);
    assert.equal(f.elements.lpDemoVideo.hidden, true, url);
    assert.equal(f.elements.lpDemoPlaceholder.hidden, false, url);
  }
  assert.match(html, /<video[^>]*id="lpDemoVideo"[^>]*controls[^>]*playsinline[^>]*preload="none"/);
});
