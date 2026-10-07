/* The sign-in page's handling of an emailed link that cannot be used, and of
 * an account whose email was never confirmed (pages/login.html).
 *
 * Measured 2026-10-06: an invited founder created their account, tried to
 * sign in 14 seconds later, got "Email not confirmed", and stopped. On
 * 2026-09-26 another founder opened their confirmation link a second time
 * and Supabase answered "Email link is invalid or has expired" -- by
 * redirecting back to this page with the reason in the URL, which the page
 * ignored. Both left a person at a sign-in form that could only fail, with no
 * way to get a new link.
 *
 * The three helpers are pure, so they are extracted from the page and run in
 * isolation, the same way onboarding-callbacks.test.js does. The browser suite
 * (v2/tests/browser/login-email-links.test.js) drives the real page. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('login-email-links');
const REPO = path.resolve(__dirname, '..', '..', '..');
const LOGIN = fs.readFileSync(path.join(REPO, 'pages', 'login.html'), 'utf8');

function extract(src, startMarker) {
  const at = src.indexOf(startMarker);
  if (at < 0) return null;
  const i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
  }
  return null;
}

const names = ['readAuthLinkError', 'withoutAuthLinkError', 'isEmailNotConfirmed'];
const sources = names.map((n) => extract(LOGIN, `function ${n}(`));
names.forEach((n, k) => r.ok(`login.html defines ${n}()`, !!sources[k]));

const ctx = vm.createContext({ URL, URLSearchParams });
vm.runInContext(sources.filter(Boolean).join('\n'), ctx);
const fn = (n) => vm.runInContext(`typeof ${n} === 'function' ? ${n} : null`, ctx);
const readAuthLinkError = fn('readAuthLinkError');
const withoutAuthLinkError = fn('withoutAuthLinkError');
const isEmailNotConfirmed = fn('isEmailNotConfirmed');

/* ── readAuthLinkError ───────────────────────────────────────────────────── */

r.test('the implicit-flow hash Supabase actually sends is read', () => {
  // The shape GoTrue redirects with for a used or expired link.
  const got = readAuthLinkError(
    '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '');
  r.eq(got && got.code, 'otp_expired', 'error_code wins over the generic error');
  r.eq(got && got.description, 'Email link is invalid or has expired', '+ decodes to spaces');
});

r.test('the PKCE query shape is read too, and next is not mistaken for it', () => {
  const got = readAuthLinkError('', '?next=%2Fv2%2Fcompany-onboarding.html%3Finvite%3Dabc&error=access_denied&error_description=x');
  r.eq(got && got.code, 'access_denied');
});

r.test('an ordinary visit, and a SUCCESSFUL link, are not errors', () => {
  r.eq(readAuthLinkError('', ''), null, 'nothing');
  r.eq(readAuthLinkError('', '?next=%2Fv2%2Ffinance.html'), null, 'a deep link');
  r.eq(readAuthLinkError('#access_token=abc&refresh_token=def&type=signup', ''), null,
    'a working confirmation link must sign the person in, not show an error');
  r.eq(readAuthLinkError('', '?code=abc'), null, 'a PKCE code');
});

/* ── withoutAuthLinkError ────────────────────────────────────────────────── */

r.test('the error is scrubbed and next/invite survive (a resent link needs next)', () => {
  const out = withoutAuthLinkError(
    'https://get-silo.com/pages/login.html?next=%2Fv2%2Fcompany-onboarding.html%3Finvite%3Dabc' +
    '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid');
  r.eq(out, '/pages/login.html?next=%2Fv2%2Fcompany-onboarding.html%3Finvite%3Dabc');
});

r.test('query-borne errors are removed, other params kept', () => {
  const out = withoutAuthLinkError('https://x.test/pages/login.html?invite=T&error=access_denied&error_code=otp_expired&error_description=y');
  r.eq(out, '/pages/login.html?invite=T');
});

r.test('a hash that is not an error is left alone', () => {
  r.eq(withoutAuthLinkError('https://x.test/pages/login.html#section'), '/pages/login.html#section');
});

/* ── isEmailNotConfirmed ─────────────────────────────────────────────────── */

r.test('recognised by code, and by message for older clients', () => {
  r.eq(isEmailNotConfirmed({ code: 'email_not_confirmed', message: 'x' }), true, 'code');
  r.eq(isEmailNotConfirmed({ message: 'Email not confirmed' }), true, 'message');
  r.eq(isEmailNotConfirmed({ code: 'invalid_credentials', message: 'Invalid login credentials' }), false,
    'a wrong password must NOT offer a confirmation resend');
  r.eq(isEmailNotConfirmed(null), false, 'null');
});

/* ── wiring ──────────────────────────────────────────────────────────────── */

r.test('the link error is read BEFORE the Supabase client is created', () => {
  // createClient(detectSessionInUrl) consumes the URL; reading after it would
  // be reading whatever is left.
  const read = LOGIN.indexOf('const AUTH_LINK_ERROR = readAuthLinkError(');
  const client = LOGIN.indexOf('window.supabase.createClient(');
  r.truthy(read > 0 && client > 0 && read < client, `read at ${read}, client at ${client}`);
});

r.test('the resend asks for a SIGNUP link that returns to the same callback', () => {
  const handler = extract(LOGIN, 'btnResend.addEventListener("click"');
  r.truthy(handler, 'resend handler present');
  r.has(handler, 'type: "signup"');
  r.has(handler, 'emailRedirectTo: authCallbackUrl()');
});

const s = r.summary();
process.exit(s.fail ? 1 : 0);
