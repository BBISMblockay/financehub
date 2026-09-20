/* The two browser-side findings from PR #724's cycle-1 review.
 *
 * Both are the same shape: code that LOOKS like it handles a failure and does
 * not, in a place that then makes a confident false statement to the user.
 * Neither was caught by the database suite, because neither is in the
 * database, and neither would be caught by a grep, because the broken and the
 * fixed versions differ by behaviour rather than by a token.
 *
 *   1. `must()` in v2/setup-checklist.html. supabase-js does NOT throw on a
 *      failed request -- it RESOLVES with `{ data: null, error }`. So a probe
 *      written as `(await db.from(...)).data || []` swallowed every error into
 *      an empty array, and a permission failure on shopify_connections
 *      rendered as "no store connected": a definite claim, and a false one, on
 *      the one page whose whole job is to distinguish "not done" from "could
 *      not check". A try/catch never saw it because nothing was ever thrown.
 *
 *   2. `authCallbackUrl()` in pages/login.html. A company-creation invite
 *      lives INSIDE `next` (/v2/company-onboarding.html?invite=TOKEN), and the
 *      emailed confirmation callback preserved only the separate org-invite
 *      token. A founder who confirmed their email came back to a bare login
 *      page with no membership and no destination, and hit the "isn't part of
 *      an organization" stop instead of the company creation they were
 *      invited to.
 *
 * Both functions are small and pure, so they are extracted from the page
 * source and evaluated in isolation rather than driven through a browser.
 * The structural checks at the end are what stop the next probe from being
 * added without must(). */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('onboarding-callbacks');
const REPO = path.resolve(__dirname, '..', '..', '..');
const CHECKLIST = fs.readFileSync(path.join(REPO, 'v2', 'setup-checklist.html'), 'utf8');
const LOGIN = fs.readFileSync(path.join(REPO, 'pages', 'login.html'), 'utf8');

/** Pull one named declaration's source out of a page, by brace matching. */
function extract(src, startMarker) {
  const at = src.indexOf(startMarker);
  if (at < 0) return null;
  let i = src.indexOf('{', at);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  return null;
}

/* ── 1. must(): a resolved error is an error ──────────────────────────────── */

const mustSrc = extract(CHECKLIST, 'const must = (res) =>');
r.ok('setup-checklist defines must()', !!mustSrc,
  'the probe pipeline must unwrap responses through a helper that throws');

if (mustSrc) {
  const ctx = vm.createContext({});
  vm.runInContext(mustSrc + ';', ctx);
  const must = vm.runInContext('must', ctx);

  // The case the review named: RESOLVED, not rejected, with an error.
  let threw = false;
  try { must({ data: null, error: { message: 'permission denied for table shopify_connections' } }); }
  catch (e) { threw = true; r.ok('must() rethrows the returned error message',
    /permission denied/.test(e.message || String(e)), JSON.stringify(e)); }
  r.ok('must() throws on a RESOLVED { data: null, error }', threw,
    'this is the shape supabase-js actually returns; nothing is ever rejected');

  // An empty result is not an error and must stay distinguishable from one.
  let ok1 = true;
  try { r.ok('must() passes an empty array through', JSON.stringify(must({ data: [], error: null })) === '[]'); }
  catch (_) { ok1 = false; }
  r.ok('must() does not throw on a genuinely empty result', ok1,
    '"no rows" and "could not read" are different facts');

  let ok2 = true;
  try { r.ok('must() passes a null single-row result through', must({ data: null, error: null }) === null); }
  catch (_) { ok2 = false; }
  r.ok('must() does not throw on maybeSingle() finding nothing', ok2);

  let rowsOk = true;
  try {
    const rows = must({ data: [{ id: 1 }], error: null });
    r.ok('must() returns the data unchanged', Array.isArray(rows) && rows[0].id === 1);
  } catch (_) { rowsOk = false; }
  r.ok('must() returns rows without throwing', rowsOk);
}

/* ── Structural: every probe goes through must() ──────────────────────────── */

const probeCalls = CHECKLIST.match(/probe\(async \(\) => [^\n]*/g) || [];
r.ok('setup-checklist has probes to check', probeCalls.length >= 6,
  `found ${probeCalls.length}`);
const unwrapped = probeCalls.filter((c) => !c.includes('must('));
r.ok('every probe unwraps its response through must()', unwrapped.length === 0,
  unwrapped.join('\n        '));

// The empty-state card must not speak about absence off a FAILED probe either.
r.ok('the empty-state card gates on the probe having succeeded',
  /const noShopify = shopify\.ok &&/.test(CHECKLIST) && /const noSync = syncs\.ok &&/.test(CHECKLIST),
  '"could not check" must not print as "you have no store"');

/* ── 2. authCallbackUrl(): the destination survives the email round trip ──── */

const cbSrc = extract(LOGIN, 'function authCallbackUrl()');
r.ok('login defines authCallbackUrl()', !!cbSrc);

function callbackWith({ invite, next }) {
  const ctx = vm.createContext({
    URLSearchParams,
    window: { location: { origin: 'https://get-silo.com', pathname: '/pages/login.html' } },
    getInviteToken: () => invite || '',
    // The real one rejects anything that is not a same-origin path; the stub
    // returns whatever the caller says it already validated.
    safeNextPath: () => next || null,
  });
  vm.runInContext(cbSrc + '; authCallbackUrl;', ctx);
  return vm.runInContext('authCallbackUrl()', ctx);
}

if (cbSrc) {
  const bare = callbackWith({});
  r.ok('no invite and no next gives the plain page URL',
    bare === 'https://get-silo.com/pages/login.html', bare);

  const withNext = callbackWith({ next: '/v2/company-onboarding.html?invite=abc123' });
  r.ok('a company-creation destination survives the callback',
    withNext.includes('next=') && decodeURIComponent(withNext.split('next=')[1])
      === '/v2/company-onboarding.html?invite=abc123', withNext);

  const withInvite = callbackWith({ invite: 'orgtoken' });
  r.ok('an org invite token still survives the callback',
    withInvite.includes('invite=orgtoken'), withInvite);

  const both = callbackWith({ invite: 'orgtoken', next: '/v2/setup-checklist.html' });
  r.ok('both are carried together when both are present',
    both.includes('invite=orgtoken') && both.includes('next='), both);

  // safeNextPath() returning null is how an off-site or looping next is
  // rejected; the callback must not reintroduce it.
  const unsafe = callbackWith({ next: null });
  r.ok('a next that failed validation is not carried',
    !unsafe.includes('next='), unsafe);
}

/* ── 2b. Signup is offered only for a company-founder invitation ─────────── */

const founderPathSrc = extract(LOGIN, 'function isCompanyOnboardingPath(raw)');
r.ok('login defines the founder-signup path gate', !!founderPathSrc);

if (founderPathSrc) {
  const ctx = vm.createContext({
    URL,
    window: { location: { origin: 'https://get-silo.com' } },
  });
  vm.runInContext(founderPathSrc + '; isCompanyOnboardingPath;', ctx);
  const accepts = (raw) => vm.runInContext(`isCompanyOnboardingPath(${JSON.stringify(raw)})`, ctx);

  r.ok('a platform founder invitation may create its auth account',
    accepts('/v2/company-onboarding.html?invite=founder-token'));
  r.ok('the ordinary login page is not a public signup surface', !accepts(null));
  r.ok('company onboarding without an invite does not expose signup',
    !accepts('/v2/company-onboarding.html'));
  r.ok('an arbitrary internal destination does not expose signup',
    !accepts('/v2/finance.html?invite=founder-token'));
  r.ok('an off-site lookalike does not expose signup',
    !accepts('https://evil.example/v2/company-onboarding.html?invite=founder-token'));
}

r.ok('the standalone Create account action is hidden in the shipped markup',
  /id="btnGoSignup"[^>]*class="[^"]*\bhidden\b/.test(LOGIN));
r.ok('only the company-onboarding path gate reveals that action',
  /if \(isCompanyOnboardingPath\(safeNextPath\(\)\)\) \{\s*btnGoSignup\.classList\.remove\("hidden"\)/.test(LOGIN));

/* ── 3. The onboarding page never offers what the RPC will reject ─────────── */

const ONBOARD = fs.readFileSync(path.join(REPO, 'v2', 'company-onboarding.html'), 'utf8');

// Zero supported timezones is a real state: marking the last row unsupported is
// the lever `supported_business_timezones` exists to provide. Without an
// explicit branch the page rendered an empty select, let the founder fill in
// everything else, and failed at submit with "business timezone is required" --
// naming the field and not the reason.
r.ok('the onboarding page refuses when NO timezone is supported',
  /if \(!supported\.length\)/.test(ONBOARD),
  'an empty select plus a submit that cannot succeed is the opposite of the page\'s claim');

// The refusal has to come before the form is revealed, or it is just a message
// above a form that still cannot work.
{
  const refusal = ONBOARD.indexOf('if (!supported.length)');
  const reveal = ONBOARD.indexOf('form.hidden = false');
  r.ok('that refusal happens BEFORE the form is shown',
    refusal > 0 && reveal > 0 && refusal < reveal,
    `refusal at ${refusal}, form revealed at ${reveal}`);
}

// This page puts DB values in the DOM (the invited email, the suggested company
// name, the timezone label). It is the one page in this PR that could, so it
// uses textContent throughout. The earlier version hand-escaped `<` in a
// timezone label and assigned innerHTML -- partial escaping is the shape of the
// bug even where the source table is migration-writable only.
{
  const assigns = (ONBOARD.match(/\.innerHTML\s*=/g) || []);
  r.ok('the onboarding page assigns no innerHTML at all', assigns.length === 0,
    `found ${assigns.length}`);
  r.ok('it does not hand-roll HTML escaping either',
    !/replace\(\/<\/g/.test(ONBOARD),
    'partial escaping into innerHTML is what this replaced');
}

// All three emailed callbacks must use it -- magic link, signup confirmation
// and password reset. The signup one was the only one carrying anything, and
// it carried only the org invite.
const usages = (LOGIN.match(/const redirectTo = authCallbackUrl\(\);/g) || []).length;
r.ok('all three emailed callbacks build their URL through authCallbackUrl()',
  usages === 3, `found ${usages}`);
r.ok('no emailed callback still builds a bare page URL by hand',
  !/const redirectTo = window\.location\.origin \+ window\.location\.pathname/.test(LOGIN));

/* ── 4. Recovering a company that already exists ───────────────────────────
 *
 * Cycle-3 finding (P2). Zero supported timezones pauses CREATION, which is
 * right: a new company would have no reliable day boundary. But that gate was
 * an unconditional `return`, and it sat ABOVE the accepted-invite handling --
 * so the exact sequence the whole retry path exists for (the company commits,
 * the response is lost, the founder reopens the same link) hit "Company
 * creation is paused" for a company that was already sitting there, with no
 * way through. A company that already exists already HAS a timezone; it was
 * chosen when it was founded.
 *
 * Driven, not grepped. The broken and the fixed pages differ by the ORDER of
 * two blocks, and a regex over the source is satisfied by both -- it was a
 * source-pattern assertion that let the first version of the timezone gate
 * ship on top of this. So the page's own IIFE is executed against a synthetic
 * DOM and stub RPCs, and what is asserted is what the founder ends up with. */

const ONBOARD_SRC = ONBOARD.slice(ONBOARD.indexOf('(async function ()'),
  ONBOARD.lastIndexOf('})();') + 5);
r.ok('the onboarding IIFE was extracted from the page', ONBOARD_SRC.length > 500);

function fakeEl(id) {
  return {
    id, textContent: '', className: '', value: '', hidden: true, disabled: false,
    children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    append(...parts) { this.children.push(...parts); },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  };
}

/** Run the page against one synthetic world and report what it did. */
async function runOnboarding({ peek, zones, redeem }) {
  const els = {};
  const calls = [];
  const out = { redirectedTo: null, cached: null };
  const $ = (id) => (els[id] = els[id] || fakeEl(id));
  ['obTitle', 'obSub', 'status', 'invitedAs', 'obForm', 'companyName', 'timezone',
    'currency', 'tzWarn', 'btnCreate', 'busyHint', 'obResume', 'btnResume', 'resumeHint']
    .forEach($);

  const db = {
    auth: { getSession: async () => ({ data: { session: { user: { email: 'founder@prospect.com' } } } }) },
    rpc: async (name, args) => {
      calls.push(name);
      if (name === 'peek_platform_invite') return { data: peek, error: null };
      if (name === 'redeem_platform_invite') return redeem(args);
      throw new Error('unexpected rpc ' + name);
    },
    from: () => ({ select: () => ({ order: async () => ({ data: zones, error: null }) }) }),
  };

  const sandbox = {
    console,
    setTimeout,
    URLSearchParams,
    document: {
      getElementById: $,
      createElement: (tag) => fakeEl(tag),
    },
    sessionStorage: { setItem: (k, v) => { out.cached = JSON.parse(v); } },
    window: {
      __SILO_CONFIG__: { SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'k' },
      supabase: { createClient: () => db },
      get location() { return out.loc; },
    },
  };
  // A redirect is the page's terminal action, so it is recorded rather than
  // performed -- and reading it back is how "did the founder get in" is asked.
  out.loc = { search: '?invite=TOK', set href(v) { out.redirectedTo = v; }, get href() { return out.redirectedTo; } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  await vm.runInContext(ONBOARD_SRC, sandbox);
  return { els, calls, out };
}

const PACIFIC = [{ tz_name: 'America/Los_Angeles', label: 'Pacific', is_supported: true }];
const NONE = [{ tz_name: 'America/Los_Angeles', label: 'Pacific', is_supported: false }];
const ACCEPTED = { ok: true, email: 'founder@prospect.com', already_redeemed: true };
const PENDING = { ok: true, email: 'founder@prospect.com', already_redeemed: false };
const REDEEMED = {
  data: { ok: true, repeated: true, entity_id: 'e1', entity_key: 'acme', company: 'Acme' },
  error: null,
};

(async () => {
  /* The regression itself: an accepted invite with NOTHING supported. */
  const paused = await runOnboarding({
    peek: ACCEPTED, zones: NONE, redeem: () => REDEEMED,
  });
  r.ok('an already-redeemed invite offers a way through even with zero supported timezones',
    !paused.els.obResume.hidden);
  r.ok('the page must not say creation is paused for a company that exists',
    !/paused/i.test(paused.els.obTitle.textContent),
    `said: "${paused.els.obTitle.textContent}"`);
  r.ok('and it does not redeem on load -- the founder chooses to continue',
    !paused.calls.includes('redeem_platform_invite'));

  // Guarded: with the bug restored the button is never wired, and an
  // unguarded [0] would CRASH here -- taking the failure report with it and
  // leaving a mutation that "fails" without naming what broke.
  const click = (paused.els.btnResume.listeners.click || [])[0];
  r.ok('the continue button is wired to an action', typeof click === 'function');
  if (click) await click();
  r.ok('continuing calls the SERVER, so the peek is never the authorization',
    paused.calls.includes('redeem_platform_invite'));
  r.ok('and lands the founder in the company that already exists',
    paused.out.redirectedTo === '/v2/setup-checklist.html?welcome=1',
    `redirected to: ${paused.out.redirectedTo}`);
  r.ok('caching entity_key, so the first page paints with the right nav profile',
    paused.out.cached && paused.out.cached.entity_key === 'acme',
    `cached: ${JSON.stringify(paused.out.cached)}`);

  /* The gate it must NOT have loosened. */
  const blocked = await runOnboarding({
    peek: PENDING, zones: NONE, redeem: () => { throw new Error('must not redeem'); },
  });
  r.ok('a PENDING invite with zero supported timezones is still refused',
    /paused/i.test(blocked.els.obTitle.textContent));
  r.ok('and is offered no way around the refusal', blocked.els.obResume.hidden);
  r.ok('and no creation form', blocked.els.obForm.hidden);

  /* The ordinary accepted case, which must be unchanged. */
  const normal = await runOnboarding({
    peek: ACCEPTED, zones: PACIFIC, redeem: () => REDEEMED,
  });
  r.ok('an accepted invite resumes with Pacific supported too', !normal.els.obResume.hidden);
  await normal.els.btnResume.listeners.click[0]();
  r.ok('and lands in the same place',
    normal.out.redirectedTo === '/v2/setup-checklist.html?welcome=1',
    `redirected to: ${normal.out.redirectedTo}`);

  process.exit(r.summary().fail ? 1 : 0);
})();
