/* Shopify authorization: the shared rules (scripts/lib/shopify-auth-lib.mjs)
 * and every place that must use them.
 *
 * Proven:
 *   1. Every copy of the lib is byte-identical (each edge function deploys its
 *      own directory, so a copy that drifts is a function with other rules).
 *   2. Shop domains: only *.myshopify.com, because SILO sends a secret there.
 *   3. mayConnect: a disabled account never connects a store; any lookup
 *      error refuses; membership role before the legacy profile role.
 *   4. The OAuth app choice: the public app only once BOTH its keys are set;
 *      a state row with no app is the legacy app.
 *   5. Signatures: OAuth hmac (hex over sorted params) and webhook hmac
 *      (base64 over the raw body) verify with the right secret only, and the
 *      webhook reports WHICH app signed.
 *   6. Client credentials: the exact request Shopify documents, the secret
 *      never in an error, the same-organization refusal named as such.
 *   7. ensureShopifyAccessToken: untouched for OAuth / pasted tokens; reuses a
 *      token with time left; mints and writes back one near expiry; a missing
 *      credential row is an error, never a silent unauthenticated sync.
 *   8. Privacy webhooks: what each topic does, and shop/redact never erases a
 *      store's customer details while another connection still syncs it.
 *   9. The wiring: each function and sync entry point calls these rules in
 *      the order that makes them mean something.
 *
 * Mutations (each must make this file FAIL):
 *   SHOPIFY_AUTH_MUTATION=disabled-admin   (mayConnect ignores is_active)
 *   SHOPIFY_AUTH_MUTATION=no-refresh       (tokenNeedsRefresh always false)
 *   SHOPIFY_AUTH_MUTATION=redact-anyway    (shop/redact ignores a live connection)
 *   SHOPIFY_AUTH_MUTATION=any-domain       (normalizeShopDomain accepts any host)
 *
 * No network, no database. Run: node scripts/tests/shopify-auth.test.mjs */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.SHOPIFY_AUTH_MUTATION || '';
assert.ok(['', 'disabled-admin', 'no-refresh', 'redact-anyway', 'any-domain'].includes(mutation), `Unknown mutation ${mutation}`);

let libSrc = read('scripts/lib/shopify-auth-lib.mjs');
const swap = (from, to) => { assert.ok(libSrc.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`); libSrc = libSrc.replace(from, to); };
if (mutation === 'disabled-admin') swap("if (!profile || profile.is_active !== true) return false;", 'if (!profile) return false;');
if (mutation === 'no-refresh') swap("if (connection?.auth_method !== 'client_credentials') return false;", 'return false;');
if (mutation === 'redact-anyway') swap('redactOrders: stillLive.length === 0', 'redactOrders: true');
if (mutation === 'any-domain') swap("return /^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/.test(s) ? s : null;", 'return s;');
const dir = mkdtempSync(join(tmpdir(), 'shopify-auth-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'lib.mjs'), libSrc);
const L = await import(pathToFileURL(join(dir, 'lib.mjs')).href);

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

await test('every copy of the lib is identical', () => {
  const canon = read('scripts/lib/shopify-auth-lib.mjs');
  for (const p of [
    'supabase/functions/shopify-oauth-start/shopify-auth-lib.mjs',
    'supabase/functions/shopify-oauth-callback/shopify-auth-lib.mjs',
    'supabase/functions/shopify-connect-dev-app/shopify-auth-lib.mjs',
    'supabase/functions/shopify-compliance-webhook/shopify-auth-lib.mjs',
    'supabase/functions/test-shopify-connection/shopify-auth-lib.mjs',
    'supabase/functions/shopify-sync-run/lib/shopify-auth-lib.mjs',
  ]) assert.equal(read(p), canon, `${p} has drifted from scripts/lib/shopify-auth-lib.mjs`);
});

await test('shop domains: only *.myshopify.com', () => {
  assert.equal(L.normalizeShopDomain('Bat-Nutz'), 'bat-nutz.myshopify.com');
  assert.equal(L.normalizeShopDomain('https://bat-nutz.myshopify.com/admin'), 'bat-nutz.myshopify.com');
  for (const bad of ['evil.com', 'bat-nutz.myshopify.com.evil.com', 'a@b.myshopify.com', '', null, 'x.myshopify.co']) {
    assert.equal(L.normalizeShopDomain(bad), null, String(bad));
  }
});

await test('mayConnect: active admins only, and an unknown answer is no', () => {
  const CO = 'co';
  const active = { is_active: true, role: 'user', active_company_id: CO };
  assert.equal(L.mayConnect({ profile: active, membership: { role: 'admin' }, companyId: CO }), true);
  assert.equal(L.mayConnect({ profile: active, membership: { role: 'member' }, companyId: CO }), false);
  assert.equal(L.mayConnect({ profile: { ...active, is_active: false }, membership: { role: 'owner_admin' }, companyId: CO }), false,
    'a disabled account keeps its memberships; it must not connect a store');
  assert.equal(L.mayConnect({ profile: { ...active, role: 'admin' }, membership: null, companyId: CO }), true);
  assert.equal(L.mayConnect({ profile: { ...active, role: 'admin' }, membership: null, companyId: 'other' }), false);
  assert.equal(L.mayConnect({ profile: active, profileError: {}, membership: { role: 'admin' }, companyId: CO }), false);
  assert.equal(L.mayConnect({ profile: active, membershipError: {}, membership: null, companyId: CO }), false);
});

await test('OAuth app choice: public only with both keys; no app on a state row = legacy', () => {
  const legacy = { SHOPIFY_CLIENT_ID: 'L', SHOPIFY_CLIENT_SECRET: 'Ls' };
  assert.equal(L.chooseOAuthApp(legacy).app, 'legacy');
  assert.equal(L.chooseOAuthApp({ ...legacy, SHOPIFY_PUBLIC_CLIENT_ID: 'P' }).app, 'legacy', 'a public id without its secret is not a usable app');
  assert.equal(L.chooseOAuthApp({ ...legacy, SHOPIFY_PUBLIC_CLIENT_ID: 'P', SHOPIFY_PUBLIC_CLIENT_SECRET: 'Ps' }).app, 'public');
  assert.equal(L.chooseOAuthApp({}), null);
  assert.equal(L.appCredentials(legacy, null).clientSecret, 'Ls');
  assert.equal(L.appCredentials(legacy, 'public'), null);
  assert.ok(L.PUBLIC_SCOPES.every((s) => s.startsWith('read_')), 'the public app asks to read, never to write');
  assert.equal(L.PUBLIC_SCOPES.length, 8);
});

await test('OAuth callback hmac: sorted params, hex, right secret only', async () => {
  const params = new URLSearchParams({ code: 'c0de', shop: 'x.myshopify.com', state: 'n', timestamp: '1' });
  const msg = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
  params.set('hmac', createHmac('sha256', 'sec').update(msg).digest('hex'));
  assert.equal(await L.verifyOAuthHmac(params, 'sec'), true);
  assert.equal(await L.verifyOAuthHmac(params, 'other'), false);
  params.set('code', 'tampered');
  assert.equal(await L.verifyOAuthHmac(params, 'sec'), false);
});

await test('webhook hmac: base64 over the raw body, and which app signed it', async () => {
  const env = { SHOPIFY_CLIENT_ID: 'L', SHOPIFY_CLIENT_SECRET: 'Ls', SHOPIFY_PUBLIC_CLIENT_ID: 'P', SHOPIFY_PUBLIC_CLIENT_SECRET: 'Ps' };
  const body = new TextEncoder().encode('{"shop_domain":"x.myshopify.com"}');
  const sig = (secret) => createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(await L.webhookSigningApp(body, sig('Ps'), env), 'public');
  assert.equal(await L.webhookSigningApp(body, sig('Ls'), env), 'legacy');
  assert.equal(await L.webhookSigningApp(body, sig('nope'), env), null);
  assert.equal(await L.webhookSigningApp(body, '', env), null);
});

await test('client credentials: the documented request, secret never in an error', async () => {
  let seen = null;
  const ok = await L.mintClientCredentialsToken({
    shop: 'bat-nutz', clientId: 'id', clientSecret: 'SECRET123', now: 0,
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ access_token: 'tok', scope: 'read_orders,read_products', expires_in: 86399 })); },
  });
  assert.equal(seen.url, 'https://bat-nutz.myshopify.com/admin/oauth/access_token');
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(seen.init.body).get('grant_type'), 'client_credentials');
  assert.equal(ok.accessToken, 'tok');
  assert.equal(ok.expiresAt, new Date(86399 * 1000).toISOString());
  assert.deepEqual(ok.scopes, ['read_orders', 'read_products']);

  let err = null;
  try {
    await L.mintClientCredentialsToken({ shop: 'bat-nutz', clientId: 'id', clientSecret: 'SECRET123',
      fetchImpl: async () => new Response('{"error":"bad SECRET123"}', { status: 400 }) });
  } catch (e) { err = e; }
  assert.ok(err && !err.message.includes('SECRET123'), 'the secret must never reach an error message');
  let sameOrg = null;
  try {
    await L.mintClientCredentialsToken({ shop: 'bat-nutz', clientId: 'id', clientSecret: 's',
      fetchImpl: async () => new Response('{"error_description":"Client credentials cannot be performed on this shop."}', { status: 400 }) });
  } catch (e) { sameOrg = e; }
  assert.equal(sameOrg.sameOrgRefusal, true);
  assert.match(sameOrg.message, /SAME Shopify organization/);
});

function fakeAdmin({ cred = { client_id: 'id', client_secret: 's' } } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, filters: [], patch: null };
      Object.assign(q, {
        select() { return q; },
        eq(c, v) { q.filters.push([c, v]); return q; },
        update(p) { q.patch = p; calls.push({ table, op: 'update', patch: p }); return q; },
        maybeSingle: async () => ({ data: table === 'shopify_client_credentials' ? cred : null, error: null }),
        then(res) { return Promise.resolve({ error: null }).then(res); },
      });
      return q;
    },
  };
}
const NOW = Date.parse('2026-09-28T12:00:00Z');
const minted = async () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 86399 }));

await test('ensureShopifyAccessToken: OAuth and pasted tokens are left alone', async () => {
  const admin = fakeAdmin();
  for (const auth_method of [null, 'oauth', 'manual_token']) {
    const conn = { id: 'c', shop_domain: 'x.myshopify.com', auth_method, access_token: 'old' };
    assert.equal(await L.ensureShopifyAccessToken(admin, conn, { fetchImpl: minted, now: NOW }), 'old');
  }
  assert.equal(admin.calls.length, 0);
});

await test('ensureShopifyAccessToken: reuses a token with time left, mints one near expiry', async () => {
  const admin = fakeAdmin();
  const fresh = { id: 'c', shop_domain: 'x.myshopify.com', auth_method: 'client_credentials', access_token: 'keep',
    token_expires_at: new Date(NOW + 10 * 3600e3).toISOString() };
  assert.equal(await L.ensureShopifyAccessToken(admin, fresh, { fetchImpl: minted, now: NOW }), 'keep');
  const stale = { ...fresh, access_token: 'old', token_expires_at: new Date(NOW + 30 * 60e3).toISOString() };
  assert.equal(await L.ensureShopifyAccessToken(admin, stale, { fetchImpl: minted, now: NOW }), 'fresh',
    'a token with 30 minutes left would die mid-sync');
  assert.equal(stale.access_token, 'fresh');
  const upd = admin.calls.find((c) => c.table === 'shopify_connections');
  assert.equal(upd.patch.access_token, 'fresh');
  assert.equal(upd.patch.token_expires_at, new Date(NOW + 86399e3).toISOString());
});

await test('ensureShopifyAccessToken: no stored credentials is an error, not a silent pass', async () => {
  const admin = fakeAdmin({ cred: null });
  const conn = { id: 'c', shop_domain: 'x.myshopify.com', auth_method: 'client_credentials', access_token: null };
  await assert.rejects(L.ensureShopifyAccessToken(admin, conn, { fetchImpl: minted, now: NOW }), /no stored app credentials/);
});

await test('privacy webhooks: each topic, and shop/redact keeps data another connection holds', () => {
  assert.equal(L.planCompliance('customers/data_request', { shop_domain: 'x.myshopify.com', customer: { id: 7 } }).action, 'record_only');
  const r = L.planCompliance('customers/redact', { shop_domain: 'x.myshopify.com', customer: { id: 7 }, orders_to_redact: [1, 2, 'x'] });
  assert.deepEqual([r.action, r.customerId, r.orderIds], ['redact_customer', '7', ['1', '2']]);
  assert.equal(L.planCompliance('shop/redact', { shop_domain: 'x.myshopify.com' }).action, 'redact_shop');
  assert.equal(L.planCompliance('orders/create', { shop_domain: 'x.myshopify.com' }).action, 'ignore');
  assert.equal(L.planCompliance('shop/redact', { shop_domain: 'evil.com' }).action, 'ignore');

  const legacyLive = { id: 'L1', auth_method: null, oauth_app: null, is_active: true, access_token: 'tok' };
  const publicTest = { id: 'P1', auth_method: 'oauth', oauth_app: 'public', is_active: true, access_token: 'tok2' };
  const keep = L.planShopRedact([legacyLive, publicTest], 'public');
  assert.deepEqual(keep.closeConnectionIds, ['P1']);
  assert.equal(keep.redactOrders, false, 'Baseballism test-installing the public app must not erase what the legacy connection syncs');
  const gone = L.planShopRedact([publicTest], 'public');
  assert.deepEqual([gone.closeConnectionIds, gone.redactOrders], [['P1'], true]);
  const cc = { id: 'C1', auth_method: 'client_credentials', is_active: true, access_token: 't' };
  assert.equal(L.planShopRedact([cc], 'public').redactOrders, false, 'a client-credentials connection is not the public app\'s to close');
});

await test('wiring: every function and entry point uses the rules in the right order', () => {
  const start = read('supabase/functions/shopify-oauth-start/index.ts');
  assert.match(start, /if \(!mayConnect\(\{ profile, profileError, membership, membershipError, companyId: company_entity_id \}\)\)/);
  assert.match(start, /oauth_app: APP\.app/);
  assert.match(start, /scope: APP\.app === 'public' \? PUBLIC_SCOPES\.join\(','\) : LEGACY_SCOPES/);

  const cb = read('supabase/functions/shopify-oauth-callback/index.ts');
  const iVerify = cb.indexOf('verifyOAuthHmac(params, creds.clientSecret)');
  const iDelete = cb.indexOf(".from('shopify_oauth_states').delete()");
  const iExchange = cb.indexOf('/admin/oauth/access_token');
  assert.ok(iVerify > 0 && iVerify < iDelete && iDelete < iExchange, 'callback: verify the signature before consuming the state or exchanging the code');
  assert.match(cb, /appCredentials\(ENV, stateRow\.oauth_app\)/);

  const dev = read('supabase/functions/shopify-connect-dev-app/index.ts');
  const iAuth = dev.indexOf('if (!mayConnect(');
  const iMint = dev.indexOf('await mintClientCredentialsToken(');
  const iSave = dev.indexOf("admin.rpc('shopify_save_client_credentials_connection'");
  assert.ok(iAuth > 0 && iAuth < iMint && iMint < iSave, 'connect: authorize, then let Shopify accept the pair, then save');
  assert.doesNotMatch(dev, /from\('shopify_(connections|client_credentials)'\)\s*\.(insert|update|upsert|delete)/,
    'token and secret are saved together by one RPC, never by separate writes');

  const hook = read('supabase/functions/shopify-compliance-webhook/index.ts');
  assert.ok(hook.indexOf("return new Response('Unauthorized', { status: 401 })") < hook.indexOf('createClient('),
    'the webhook checks the signature before touching the database');
  assert.match(hook, /admin\.rpc\('shopify_close_connections'/, 'credentials and token are closed in one transaction');
  assert.match(hook, /if \(connErr\) errors\.push/, 'a failed connection lookup is a failure');
  assert.match(hook, /if \(logErr\) errors\.push/, 'a failed log insert is a failure (Shopify retries)');
  assert.match(hook, /status: errors\.length \? 500 : 200/);

  const t = read('supabase/functions/test-shopify-connection/index.ts');
  assert.match(t, /access_token = await ensureShopifyAccessToken\(admin, conn\)/);
  assert.match(t, /full_order_history: hasFullOrderHistory\(scopesGranted\)/);

  for (const p of ['scripts/shopify-sync.mjs', 'scripts/shopify-orders-backfill.mjs']) {
    assert.match(read(p), /await ensureShopifyAccessToken\(supabase, connection\);/, p);
  }
  const run = read('supabase/functions/shopify-sync-run/index.ts');
  assert.equal((run.match(/await ensureShopifyAccessToken\(admin, connection\);/g) || []).length, 2, 'both sync-run paths refresh the token');

  // access_token is withheld from members by column privilege: no reader
  // acting as the caller may name it or ask for '*'.
  assert.doesNotMatch(t, /supabase\s*\.from\('shopify_connections'\)\s*\.select\('[^']*access_token/, 'test fn reads the token only as service role');
  assert.doesNotMatch(run, /userClient\s*\.from\('shopify_connections'\)\s*\.select\('\*'\)/, 'sync-run reads the full row only as service role');

  const page = read('v2/integrations.html');
  assert.doesNotMatch(page, /from\('shopify_connections'\)\.select\('\*'\)/, "select('*') on shopify_connections is refused for members");
  assert.doesNotMatch(page, /SHOPIFY_CONNECTION_COLUMNS = \[[^\]]*'access_token'/, 'the page never names the token column');
  assert.match(page, /body: JSON\.stringify\(\{ connection_id: conn\.id \}\)/, 'the Test button sends an id, never a token');
  assert.doesNotMatch(page, /\.select\('shop_domain, access_token'\)/, 'the page no longer reads a Shopify token to test it');

  const deploy = read('.github/workflows/deploy-edge-function.yml');
  assert.match(deploy, /"shopify-compliance-webhook" \]; then[\s\S]*?--no-verify-jwt/, 'Shopify has no Supabase JWT to present');
});

console.log(`\n${n} passed`);
