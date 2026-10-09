/* Google OAuth return address: the rules in google-oauth-lib.mjs, the two
 * functions that use them, and the /oauth/google.html page that forwards.
 *
 * Proven:
 *   1. Only https origins with no path are accepted from the secret.
 *   2. The start function never builds a redirect_uri outside the list, and
 *      the callback never honours a return_origin outside it.
 *   3. With the secret unset, both functions keep the legacy supabase.co
 *      callback URL -- deploying the code alone changes nothing.
 *   4. The two copies of the lib are identical (each function deploys its own
 *      directory).
 *   5. The start function checks the caller administers the company.
 *   6. The return page forwards code/state plus its own origin to the
 *      callback, with location.replace and no referrer.
 *
 * No network. Run: node scripts/tests/google-oauth-redirect.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const lib = await import(join(ROOT, 'supabase/functions/google-oauth-start/google-oauth-lib.mjs'));

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };
const ALLOWED = lib.parseOrigins('https://get-silo.com, https://silo-baseballism.com/');

test('parseOrigins keeps https origins only, normalised', () => {
  assert.deepEqual(ALLOWED, ['https://get-silo.com', 'https://silo-baseballism.com']);
  assert.deepEqual(lib.parseOrigins('http://get-silo.com,https://a.com/path,https://u:p@b.com,notaurl,,https://A.com'), ['https://a.com']);
  assert.deepEqual(lib.parseOrigins(undefined), []);
});
test('pickOrigin: the site the person is on, else the first allowed, never another', () => {
  assert.equal(lib.pickOrigin('https://silo-baseballism.com', ALLOWED), 'https://silo-baseballism.com');
  assert.equal(lib.pickOrigin('https://GET-SILO.com/', ALLOWED), 'https://get-silo.com');
  assert.equal(lib.pickOrigin('https://evil.example', ALLOWED), 'https://get-silo.com');
  assert.equal(lib.pickOrigin(null, ALLOWED), 'https://get-silo.com');
  assert.equal(lib.pickOrigin('https://get-silo.com', []), null, 'no secret: no return page');
});
test('acceptReturnOrigin refuses anything outside the list', () => {
  assert.equal(lib.acceptReturnOrigin('https://get-silo.com', ALLOWED), 'https://get-silo.com');
  for (const bad of ['https://get-silo.com.evil.example', 'https://evil-get-silo.com', 'http://get-silo.com', '', null, 'javascript:alert(1)']) {
    assert.equal(lib.acceptReturnOrigin(bad, ALLOWED), null, bad);
  }
  assert.equal(lib.returnUrl('https://get-silo.com'), 'https://get-silo.com/oauth/google.html');
});
test('the lib copies are identical', () => {
  assert.equal(read('supabase/functions/google-oauth-callback/google-oauth-lib.mjs'), read('supabase/functions/google-oauth-start/google-oauth-lib.mjs'));
  // tiktok-oauth-start ships the same copy for mayConnect (security audit 2026-10-08).
  assert.equal(read('supabase/functions/tiktok-oauth-start/google-oauth-lib.mjs'), read('supabase/functions/google-oauth-start/google-oauth-lib.mjs'));
});
test('tiktok start: the named company is authorised with mayConnect before any state is written', () => {
  const s = read('supabase/functions/tiktok-oauth-start/index.ts');
  assert.match(s, /import \{ mayConnect \} from '\.\/google-oauth-lib\.mjs';/);
  const gate = s.indexOf('if (!mayConnect({ profile, profileError, membership, membershipError, companyId: company_entity_id }))');
  const write = s.indexOf(".from('ad_platform_oauth_states').insert(");
  assert.ok(gate > 0 && write > 0 && gate < write, 'mayConnect must run before the state insert');
});
test('tiktok callback: the state is consumed in one platform-scoped, unexpired delete', () => {
  const s = read('supabase/functions/tiktok-oauth-callback/index.ts');
  assert.match(s, /\.from\('ad_platform_oauth_states'\)\s*\.delete\(\)\s*\.eq\('nonce', state\)\s*\.eq\('platform', 'tiktok_ads'\)\s*\.gt\('expires_at', new Date\(\)\.toISOString\(\)\)\s*\.select\(/);
});
test('start: redirect_uri comes from the lib or the legacy URL, and admin access is checked', () => {
  const s = read('supabase/functions/google-oauth-start/index.ts');
  assert.match(s, /const redirectUri = origin \? returnUrl\(origin\) : CALLBACK_URL;/);
  assert.match(s, /redirect_uri: redirectUri,/);
  assert.doesNotMatch(s, /redirect_uri: CALLBACK_URL/);
  assert.match(s, /parseOrigins\(Deno\.env\.get\('GOOGLE_OAUTH_REDIRECT_ORIGINS'\)\)/);
  assert.match(s, /select\('role, active_company_id, is_active'\)/);
  assert.match(s, /if \(!mayConnect\(\{ profile, profileError, membership, membershipError, companyId: company_entity_id \}\)\)/);
  assert.match(s, /Admin access required for this company/);
});
test('mayConnect: an active admin may; a disabled one, a non-admin or an unknown answer may not', () => {
  const CO = 'co-1';
  const active = { is_active: true, role: 'user', active_company_id: CO };
  assert.equal(lib.mayConnect({ profile: active, membership: { role: 'admin' }, companyId: CO }), true);
  assert.equal(lib.mayConnect({ profile: active, membership: { role: 'owner_admin' }, companyId: CO }), true);
  assert.equal(lib.mayConnect({ profile: { ...active, is_active: false }, membership: { role: 'owner_admin' }, companyId: CO }), false,
    'deactivation keeps memberships; a disabled former admin is refused');
  assert.equal(lib.mayConnect({ profile: { ...active, is_active: null }, membership: { role: 'admin' }, companyId: CO }), false);
  assert.equal(lib.mayConnect({ profile: null, membership: { role: 'admin' }, companyId: CO }), false);
  assert.equal(lib.mayConnect({ profile: active, membership: { role: 'member' }, companyId: CO }), false);
  assert.equal(lib.mayConnect({ profile: { ...active, role: 'admin' }, membership: null, companyId: CO }), true, 'legacy profile fallback');
  assert.equal(lib.mayConnect({ profile: { ...active, role: 'admin' }, membership: null, companyId: 'other' }), false);
  assert.equal(lib.mayConnect({ profile: { ...active, role: 'admin', is_active: false }, membership: null, companyId: CO }), false);
  assert.equal(lib.mayConnect({ profile: active, profileError: { message: 'x' }, membership: { role: 'admin' }, companyId: CO }), false, 'fails closed');
  assert.equal(lib.mayConnect({ profile: active, membershipError: { message: 'x' }, membership: null, companyId: CO }), false, 'fails closed');
});
test('callback: exchanges with the same redirect_uri and returns to the same site', () => {
  const s = read('supabase/functions/google-oauth-callback/index.ts');
  assert.match(s, /acceptReturnOrigin\(params\.get\('return_origin'\), REDIRECT_ORIGINS\)/);
  assert.match(s, /redirect_uri: redirectUri,/);
  assert.doesNotMatch(s, /redirect_uri: CALLBACK_URL/);
  assert.match(s, /`\$\{appUrl\}\/v2\/integrations\.html\?oauth_connected=1/);
  assert.match(s, /if \(badOrigin\) return errorRedirect\('invalid_return_origin'\);/);
});
test('return page: forwards code, state and its origin with replace(), no referrer', () => {
  const html = read('oauth/google.html');
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let replaced = null;
  const msg = { innerHTML: '' };
  const window = {
    __SILO_CONFIG__: { SUPABASE_URL: 'https://proj.supabase.co/' },
    location: { search: '?state=abc&code=4%2F0x&scope=x', origin: 'https://get-silo.com', replace: (u) => { replaced = u; } },
  };
  vm.runInNewContext(script, { window, document: { getElementById: () => msg }, encodeURIComponent, String });
  assert.equal(replaced, 'https://proj.supabase.co/functions/v1/google-oauth-callback?state=abc&code=4%2F0x&scope=x&return_origin=https%3A%2F%2Fget-silo.com');
  // Opened with no query: explains itself, goes nowhere.
  replaced = null;
  window.location.search = '';
  vm.runInNewContext(script, { window, document: { getElementById: () => msg }, encodeURIComponent, String });
  assert.equal(replaced, null);
  assert.match(msg.innerHTML, /Back to Integrations/);
});

console.log(`\n${n} passed`);
