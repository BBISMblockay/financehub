/* test-ad-platform-connection names a Google Ads refusal by its error code.
 * The code sits past the first 300 characters of the body, where the old
 * message was cut; these bodies are the real shape (v24).
 * Run: node scripts/tests/google-ads-errors.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = await import(join(ROOT, 'supabase/functions/test-ad-platform-connection/google-ads-errors.mjs'));
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };

const body = (errorCode, message) => JSON.stringify({ error: {
  code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED',
  details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v24.errors.GoogleAdsFailure',
    errors: [{ errorCode, message }], requestId: 'abc' }] } }, null, 2);

test('the code the old 300-character cut hid is named, with the fix', () => {
  const b = body({ authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, 'The developer token is only approved for use with test accounts.');
  assert.ok(b.indexOf('DEVELOPER_TOKEN_NOT_APPROVED') > 300, 'fixture reproduces the truncation');
  const s = lib.describeGoogleAdsError('Google Ads search', 403, b);
  assert.match(s, /^Google Ads search 403 DEVELOPER_TOKEN_NOT_APPROVED: The developer token is only approved/);
  assert.match(s, /Apply for Basic access/);
});
test('account access is told apart from the token', () => {
  const s = lib.describeGoogleAdsError('Google Ads search', 403, body({ authorizationError: 'USER_PERMISSION_DENIED' }, "User doesn't have permission to access customer."));
  assert.match(s, /USER_PERMISSION_DENIED/);
  assert.match(s, /manager \(MCC\)/);
  assert.doesNotMatch(s, /Basic access/);
});
test('an unknown code is still named, without invented advice', () => {
  const s = lib.describeGoogleAdsError('Google Ads search', 403, body({ quotaError: 'RESOURCE_EXHAUSTED' }, 'Too many.'));
  assert.equal(s, 'Google Ads search 403 RESOURCE_EXHAUSTED: Too many.');
});
test('a body that is not a Google Ads failure falls back to the raw start', () => {
  assert.equal(lib.describeGoogleAdsError('listAccessibleCustomers', 500, '<html>oops</html>'), 'listAccessibleCustomers 500: <html>oops</html>');
  assert.equal(lib.parseGoogleAdsError('{"error":{"code":401}}'), null);
});
test('both Google Ads calls in the test function use it', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/test-ad-platform-connection/index.ts'), 'utf8');
  assert.match(src, /describeGoogleAdsError\('listAccessibleCustomers', res\.status, await res\.text\(\)\)/);
  assert.match(src, /describeGoogleAdsError\('Google Ads search', res\.status, await res\.text\(\)\)/);
  assert.doesNotMatch(src, /Google Ads search \$\{res\.status\}: \$\{\(await res\.text\(\)\)\.slice/);
});
console.log(`\n${n} passed`);
