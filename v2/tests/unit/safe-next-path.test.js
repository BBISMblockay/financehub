/* ?next= redirect validation on the sign-in page and the company picker
 * (pages/login.html isSafeInternalPath, v2/company-picker.html safeNext).
 *
 * Security audit 2026-10-08: both accepted anything starting "/" but not "//".
 * Browsers read "\" as "/" and strip tabs and newlines, so "/\evil.com" and
 * "/<tab>/evil.com" resolve OFF the site -- an open redirect that also rode
 * into the magic-link emailRedirectTo. The helpers are extracted from the
 * pages and run in isolation, as login-email-links.test.js does. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const r = createReporter('safe-next-path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

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

const loginSrc = extract(read('pages/login.html'), 'function isSafeInternalPath(');
const pickerSrc = extract(read('v2/company-picker.html'), 'function safeNext(');
r.ok('login.html defines isSafeInternalPath()', !!loginSrc);
r.ok('company-picker.html defines safeNext()', !!pickerSrc);

const loginCtx = vm.createContext({ URL });
vm.runInContext(loginSrc || '', loginCtx);
const isSafe = (raw) => vm.runInContext('isSafeInternalPath', loginCtx)(raw);

const pickerNext = (next) => {
  const ctx = vm.createContext({ URL, URLSearchParams, window: { location: { search: '?next=' + encodeURIComponent(next) } } });
  vm.runInContext(pickerSrc || '', ctx);
  return vm.runInContext('safeNext()', ctx);
};

// Each would leave the site in a real browser.
const OFFSITE = [
  '//evil.com', '/\\evil.com', '/\\/evil.com', '\\\\evil.com', '/\t/evil.com', '/\n/evil.com', '/\r/evil.com',
  'https://evil.com', 'javascript:alert(1)', '', 'evil.com',
];
// Real deep links the app produces today.
const INTERNAL = ['/v2/finance.html', '/v2/tasks.html?id=42#notes', '/v2/company-onboarding.html?invite=abc', '/v3/dashboard.html?d=1'];

r.test('login: every off-site form is refused', () => {
  for (const raw of OFFSITE) r.eq(isSafe(raw), false, JSON.stringify(raw));
});
r.test('login: real internal deep links still pass, and login itself does not', () => {
  for (const raw of INTERNAL) r.eq(isSafe(raw), true, raw);
  r.eq(isSafe('/pages/login.html?next=/v2/x'), false, 'no loop back to login');
});
r.test('picker: every off-site form is refused', () => {
  for (const raw of OFFSITE) r.eq(pickerNext(raw), null, JSON.stringify(raw));
});
r.test('picker: real internal deep links still pass; login and the picker do not', () => {
  for (const raw of INTERNAL) r.eq(pickerNext(raw), raw, raw);
  r.eq(pickerNext('/v2/company-picker.html'), null);
  r.eq(pickerNext('/pages/login.html'), null);
});

const s = r.summary();
process.exit(s.fail ? 1 : 0);
