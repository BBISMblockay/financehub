/* /v2/klaviyo-install.html -- the Klaviyo-initiated install page.
 *
 * This is the URL on SILO's Klaviyo app listing, so it is hit COLD: by someone
 * not signed in, with no active workspace, or without admin of the one they
 * have. Those paths are the page, not edge cases, and this suite executes the
 * page's own module rather than reading it.
 *
 * Run: node scripts/tests/klaviyo-install.test.mjs
 * Mutations (each must fail the suite): KLAVIYO_INSTALL_MUTATION=
 *   no-login-next | get-active-company | auto-redirect | client-id-raw |
 *   start-without-company | page-no-js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.KLAVIYO_INSTALL_MUTATION || '';

const MUTATIONS = {
  // v2/klaviyo-install.js
  'no-login-next': ["return '/pages/login.html?next=' + encodeURIComponent(PAGE);", "return '/pages/login.html';"],
  'get-active-company': [
    'const co = await (cfg.ensureActiveCompany ? cfg.ensureActiveCompany(db) : null);',
    'const co = cfg.getActiveCompany ? cfg.getActiveCompany() : null;',
  ],
  'auto-redirect': ["btn.addEventListener('click', async () => {", 'const _auto = (async () => {'],
  'client-id-raw': ["if (/KLAVIYO_CLIENT_ID/.test(out?.error || '')) {", 'if (false) {'],
  'start-without-company': [
    "body: JSON.stringify({ company_entity_id: co.id }),",
    'body: JSON.stringify({}),',
  ],
  // v2/klaviyo-install.html
  'page-no-js': ['<script src="klaviyo-install.js"></script>', ''],
};
assert.ok(mutation === '' || MUTATIONS[mutation], `Unknown mutation ${mutation}`);

const MUTATION_FILE = { 'page-no-js': 'v2/klaviyo-install.html' };

function mutated(path) {
  let src = read(path);
  if (MUTATIONS[mutation] && (MUTATION_FILE[mutation] || 'v2/klaviyo-install.js') === path) {
    const [from, to] = MUTATIONS[mutation];
    assert.ok(src.includes(from), `mutation ${mutation} no longer matches ${path}`);
    src = src.replace(from, to);
  }
  return src;
}

const jsSrc = mutated('v2/klaviyo-install.js');
const htmlSrc = mutated('v2/klaviyo-install.html');

let n = 0;
const run = async (name, fn) => {
  try { await fn(); n += 1; console.log(`ok ${n} - ${name}`); } catch (err) { console.error(`FAILED: ${name}`); throw err; }
};

// ── a DOM thin enough to run the page's module against ─────────────────────
function makeDom({ hasSub = true } = {}) {
  const nodes = new Map();
  const mk = (id) => {
    const el = {
      id, hidden: true, disabled: false, className: '', textContent: '', _html: '',
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      querySelector() { return el._child || (el._child = { textContent: '' }); },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
    return el;
  };
  for (const id of ['kiSub', 'kiTitle', 'kiScopes', 'kiActions', 'kiConnect', 'status']) nodes.set(id, mk(id));
  if (!hasSub) nodes.delete('kiSub');
  return {
    nodes,
    document: { getElementById: (id) => nodes.get(id) || null },
  };
}

/** Execute the page module with a fake window/document, and return what it did. */
async function runPage({
  session = { access_token: 'tok' },
  company = { id: 'co-1', title: 'State Forty Eight' },
  startResponse = { status: 200, body: { url: 'https://www.klaviyo.com/oauth/authorize?x=1' } },
  configured = true,
} = {}) {
  const dom = makeDom();
  const nav = { assigned: [] };
  const fetches = [];
  const cfg = configured ? {
    SUPABASE_URL: 'https://db.example',
    SUPABASE_ANON_KEY: 'anon',
    ensureActiveCompany: async () => company,
    // Present on purpose: the per-tab reader a cold link must NOT use.
    getActiveCompany: () => null,
  } : {};

  const win = {
    __SILO_CONFIG__: cfg,
    supabase: {
      createClient: () => ({
        auth: { getSession: async () => ({ data: { session } }) },
      }),
    },
    get location() { return nav.location; },
    set location(v) { nav.assigned.push(String(v)); },
  };
  nav.location = {
    get href() { return `https://app.example/v2/klaviyo-install.html`; },
    set href(v) { nav.assigned.push(String(v)); },
  };

  const fetchImpl = async (url, init) => {
    fetches.push({ url: String(url), init });
    return {
      ok: startResponse.status >= 200 && startResponse.status < 300,
      status: startResponse.status,
      json: async () => startResponse.body,
    };
  };

  const sandbox = { window: win, document: dom.document, fetch: fetchImpl, location: nav.location, console };
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `${jsSrc}\n;return window.SiloKlaviyoInstall;`);
  const api = fn(...keys.map((k) => sandbox[k]));
  // The module's main() is async; let its microtasks settle.
  await new Promise((r) => setTimeout(r, 0));
  return { api, dom, nav, fetches };
}

// ── pure helpers ───────────────────────────────────────────────────────────
await run('a visitor who is not signed in is sent to login and back here', async () => {
  const { api, nav } = await runPage({ session: null });
  assert.match(api.loginUrl(), /^\/pages\/login\.html\?next=/);
  assert.equal(decodeURIComponent(api.loginUrl().split('next=')[1]), '/v2/klaviyo-install.html');
  assert.deepEqual(nav.assigned, [api.loginUrl()], 'and nothing else happens');
});

await run('a visitor with no active workspace picks one and comes back here', async () => {
  const { api, nav, fetches } = await runPage({ company: null });
  assert.match(api.pickerUrl(), /^\/v2\/company-picker\.html\?next=/);
  assert.deepEqual(nav.assigned, [api.pickerUrl()]);
  assert.deepEqual(fetches, [], 'klaviyo-oauth-start is not called without a workspace');
});

await run('an unregistered Klaviyo app is explained, not quoted', async () => {
  const { api } = await runPage();
  const msg = api.startError(500, { error: 'KLAVIYO_CLIENT_ID not configured' });
  assert.ok(!/KLAVIYO_CLIENT_ID/.test(msg), 'the variable name means nothing to whoever is reading it');
  assert.match(msg, /private API key/, 'and the path that does work is named');
});

await run('a non-admin is told who can do this, and a stale session to sign in', async () => {
  const { api } = await runPage();
  assert.match(api.startError(403, {}), /admin/i);
  assert.match(api.startError(401, {}), /sign in/i);
  // Anything else keeps the function's own words.
  assert.match(api.startError(502, { error: 'Klaviyo is down' }), /Klaviyo is down/);
});

// ── the signed-in path ─────────────────────────────────────────────────────
await run('the workspace is named before the visitor leaves for Klaviyo', async () => {
  const { dom, fetches } = await runPage();
  assert.equal(dom.nodes.get('kiActions').hidden, false, 'the button is shown');
  assert.equal(dom.nodes.get('kiSub')._child.textContent, 'State Forty Eight');
  assert.deepEqual(fetches, [], 'and nothing has been started yet');
});

await run('nothing leaves for Klaviyo without a click', async () => {
  // A top-level redirect to a third party straight out of a page load is both
  // a poor consent screen and a way to attach the wrong workspace unseen.
  const { nav, fetches } = await runPage();
  assert.deepEqual(nav.assigned, []);
  assert.deepEqual(fetches, []);
});

await run('the click starts the grant for THIS workspace and forwards the browser', async () => {
  const { dom, nav, fetches } = await runPage();
  await dom.nodes.get('kiConnect').listeners.click[0]();
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /\/functions\/v1\/klaviyo-oauth-start$/);
  assert.equal(fetches[0].init.method, 'POST');
  assert.equal(JSON.parse(fetches[0].init.body).company_entity_id, 'co-1',
    'the company is named explicitly; the function re-checks the caller administers it');
  assert.match(fetches[0].init.headers.Authorization, /^Bearer tok$/);
  assert.deepEqual(nav.assigned, ['https://www.klaviyo.com/oauth/authorize?x=1']);
});

await run('a refused start leaves the visitor here, told why, able to retry', async () => {
  const { dom, nav } = await runPage({ startResponse: { status: 403, body: {} } });
  await dom.nodes.get('kiConnect').listeners.click[0]();
  assert.deepEqual(nav.assigned, [], 'no half-started hop to Klaviyo');
  assert.match(dom.nodes.get('status').textContent, /admin/i);
  assert.equal(dom.nodes.get('kiConnect').disabled, false, 'the button comes back');
});

await run('a 200 carrying no url is a failure, not a redirect to nowhere', async () => {
  const { dom, nav } = await runPage({ startResponse: { status: 200, body: {} } });
  await dom.nodes.get('kiConnect').listeners.click[0]();
  assert.deepEqual(nav.assigned, []);
  assert.equal(dom.nodes.get('status').hidden, false);
});

await run('a deployment with no Supabase config says so and starts nothing', async () => {
  const { dom, nav, fetches } = await runPage({ configured: false });
  assert.match(dom.nodes.get('status').textContent, /Missing Supabase config/);
  assert.deepEqual(nav.assigned, []);
  assert.deepEqual(fetches, []);
});

// ── the page itself ────────────────────────────────────────────────────────
await run('the page loads its logic and the shared config', async () => {
  assert.match(htmlSrc, /<script src="klaviyo-install\.js"><\/script>/);
  assert.match(htmlSrc, /\.\.\/pages\/config\.js/, 'credentials come from config.js, never from this page');
  assert.ok(!/pk_[A-Za-z0-9]/.test(htmlSrc), 'no key is ever written into a page');
});

await run('it is noindex, and chrome-less by design', async () => {
  assert.match(htmlSrc, /name="robots" content="noindex"/);
  assert.ok(!/nav-config\.js|silo-chrome\.js/.test(htmlSrc),
    'the visitor may not be signed in; a sidebar around a sign-in bounce is noise');
});

await run('it says what the grant does and does not do', async () => {
  // Klaviyo reviews this page. A consent screen that does not say it never
  // sends is a consent screen that has not earned the scopes it asks for.
  assert.match(htmlSrc, /[Nn]ever sends/);
  assert.match(htmlSrc, /turn the sync on/);
});

console.log(`\n# klaviyo-install: ${n} checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
