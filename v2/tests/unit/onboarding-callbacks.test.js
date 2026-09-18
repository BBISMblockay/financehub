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

// All three emailed callbacks must use it -- magic link, signup confirmation
// and password reset. The signup one was the only one carrying anything, and
// it carried only the org invite.
const usages = (LOGIN.match(/const redirectTo = authCallbackUrl\(\);/g) || []).length;
r.ok('all three emailed callbacks build their URL through authCallbackUrl()',
  usages === 3, `found ${usages}`);
r.ok('no emailed callback still builds a bare page URL by hand',
  !/const redirectTo = window\.location\.origin \+ window\.location\.pathname/.test(LOGIN));

process.exit(r.summary().fail ? 1 : 0);
