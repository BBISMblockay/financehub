/* Shopify-initiated install of the public app: the decisions
 * (scripts/lib/shopify-install-lib.mjs), and both edge function handlers
 * EXECUTED with fake Shopify + fake Supabase -- not just read.
 *
 * Proven:
 *   1. Every copy of both libs in the new functions is byte-identical.
 *   2. Launch timestamps: fresh only within the window; request kinds.
 *   3. Claim tokens: shape, hash, and that the redirect carries the token in
 *      the FRAGMENT; error redirects carry only known codes.
 *   4. shopify-app-install: nothing is written for an unsigned request; a
 *      signed launch starts OAuth at once with the public scopes; a stale
 *      launch is refused; the callback consumes its state, refuses another
 *      shop, exchanges the code and parks ONLY the claim's hash.
 *   5. shopify-install-claim: sign-in required; malformed claims refused;
 *      peek lists only workspaces the person may connect, with what each
 *      would do; a claim for a workspace they do not administer never reaches
 *      the database; a good claim calls the RPC with the hash.
 *   6. The page helper reads #claim / #error and refuses a malformed claim.
 *   7. The deploy workflow keeps shopify-app-install public and the claim
 *      function JWT-verified.
 *
 * Mutations (each must make this file FAIL):
 *   SHOPIFY_INSTALL_MUTATION=no-hmac       (the install handler skips the signature)
 *   SHOPIFY_INSTALL_MUTATION=any-claimer   (the claim handler skips mayConnect)
 *   SHOPIFY_INSTALL_MUTATION=stale-ok      (launchIsFresh always true)
 *
 * No network, no database. Run: node scripts/tests/shopify-install.test.mjs */
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mutation = process.env.SHOPIFY_INSTALL_MUTATION || '';
assert.ok(['', 'no-hmac', 'any-claimer', 'stale-ok'].includes(mutation), `Unknown mutation ${mutation}`);

// Build each function in a temp dir so a mutation never touches the repo.
const tmp = mkdtempSync(join(tmpdir(), 'shopify-install-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
function stage(fn, edits = {}) {
  const dir = join(tmp, fn);
  execFileSync('mkdir', ['-p', dir]);
  for (const f of ['handler.mjs', 'shopify-auth-lib.mjs', 'shopify-install-lib.mjs']) {
    let src = read(`supabase/functions/${fn}/${f}`);
    for (const [from, to] of edits[f] || []) {
      assert.ok(src.includes(from), `mutation anchor missing in ${fn}/${f}: ${from.slice(0, 60)}`);
      src = src.replace(from, to);
    }
    writeFileSync(join(dir, f), src);
  }
  return pathToFileURL(join(dir, 'handler.mjs')).href;
}
const libEdits = mutation === 'stale-ok'
  ? { 'shopify-install-lib.mjs': [['return ageSec <= LAUNCH_MAX_AGE_SEC && ageSec >= -LAUNCH_MAX_FUTURE_SEC;', 'return true;']] } : {};
const installEdits = { ...libEdits };
if (mutation === 'no-hmac') installEdits['handler.mjs'] = [["if (!(await verifyOAuthHmac(params, clientSecret))) return fail('invalid_signature');", '']];
const claimEdits = mutation === 'any-claimer'
  ? { 'handler.mjs': [['if (!mayConnect({ profile, profileError, membership, membershipError, companyId: company })) {', 'if (false) {']] } : {};
const { createInstallHandler } = await import(stage('shopify-app-install', installEdits));
const { createClaimHandler } = await import(stage('shopify-install-claim', claimEdits));
const L = await import(pathToFileURL(join(tmp, 'shopify-app-install', 'shopify-install-lib.mjs')).href);
const A = await import(pathToFileURL(join(tmp, 'shopify-app-install', 'shopify-auth-lib.mjs')).href);

let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok ${n} - ${name}`); };

// ── A tiny fake of the supabase-js query builder ─────────────────────────────
function fakeDb(tables = {}, rpcs = {}) {
  const log = [];
  const db = {
    log, tables,
    rpc: async (name, args) => { log.push(['rpc', name, args]); return rpcs[name] ? rpcs[name](args) : { data: null, error: null }; },
    auth: { getUser: async (jwt) => ({ data: { user: db.users?.[jwt] ?? null } }) },
    from(table) {
      const rows = (tables[table] ||= []);
      const filters = [];
      let op = 'select', payload = null;
      const match = (r) => filters.every(([k, v, kind]) => {
        const val = k.includes('.') ? k.split('.').reduce((o, p) => o?.[p], r) : r[k];
        return kind === 'in' ? v.includes(val) : val === v;
      });
      const run = () => {
        if (op === 'insert') { rows.push(payload); log.push(['insert', table, payload]); return { data: null, error: null }; }
        if (op === 'delete') {
          for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i])) rows.splice(i, 1);
          log.push(['delete', table, filters]); return { data: null, error: null };
        }
        return { data: rows.filter(match), error: null };
      };
      const b = {
        select() { return b; },
        insert(p) { op = 'insert'; payload = p; return b; },
        delete() { op = 'delete'; return b; },
        eq(k, v) { filters.push([k, v, 'eq']); return b; },
        in(k, v) { filters.push([k, v, 'in']); return b; },
        gt() { return b; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  };
  return db;
}

const SECRET = 'shpss_test_secret';
const ENV = {
  SHOPIFY_PUBLIC_CLIENT_ID: 'pub-id', SHOPIFY_PUBLIC_CLIENT_SECRET: SECRET,
  SILO_APP_URL: 'https://get-silo.com', SHOPIFY_INSTALL_CALLBACK_URL: 'https://x.supabase.co/functions/v1/shopify-app-install',
};
function signed(params, secret = SECRET) {
  const p = new URLSearchParams(params);
  const msg = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
  p.set('hmac', createHmac('sha256', secret).update(msg).digest('hex'));
  return `https://x.supabase.co/functions/v1/shopify-app-install?${p}`;
}
const NOW = 1_800_000_000_000;
const ts = String(Math.floor(NOW / 1000));
const get = (url) => new Request(url, { method: 'GET' });
const locationOf = (res) => res.headers.get('Location');

// ── 1. copies ────────────────────────────────────────────────────────────────
await test('every copy of both libs is identical', () => {
  for (const fn of ['shopify-app-install', 'shopify-install-claim']) {
    assert.equal(read(`supabase/functions/${fn}/shopify-auth-lib.mjs`), read('scripts/lib/shopify-auth-lib.mjs'), `${fn} auth lib drifted`);
    assert.equal(read(`supabase/functions/${fn}/shopify-install-lib.mjs`), read('scripts/lib/shopify-install-lib.mjs'), `${fn} install lib drifted`);
  }
});

// ── 2-3. decisions ───────────────────────────────────────────────────────────
await test('launch freshness and request kinds', () => {
  assert.equal(L.launchIsFresh(ts, NOW), true);
  assert.equal(L.launchIsFresh(String(Number(ts) - 301), NOW), false, 'older than 5 minutes');
  assert.equal(L.launchIsFresh(String(Number(ts) + 120), NOW), false, 'too far in the future');
  assert.equal(L.launchIsFresh('abc', NOW), false);
  const k = (o) => L.installRequestKind(new URLSearchParams(o));
  assert.equal(k({ shop: 's', hmac: 'h', timestamp: '1' }), 'launch');
  assert.equal(k({ shop: 's', hmac: 'h', code: 'c', state: 'n' }), 'callback');
  assert.equal(k({ shop: 's', hmac: 'h', code: 'c' }), 'invalid', 'code without state');
  assert.equal(k({ shop: 's', timestamp: '1' }), 'invalid', 'no signature');
});

await test('claim tokens: shape, hash, fragment-only redirect, known error codes only', async () => {
  const t = L.newClaimToken();
  assert.ok(L.isClaimToken(t));
  assert.notEqual(L.newClaimToken(), t);
  assert.equal(await L.hashClaim(t), createHash('sha256').update(t).digest('hex'));
  assert.equal(L.claimRedirect('https://a', t), `https://a/v2/shopify-install.html#claim=${t}`);
  assert.equal(L.errorRedirect('https://a', 'shop_mismatch'), 'https://a/v2/shopify-install.html#error=shop_mismatch');
  assert.equal(L.errorRedirect('https://a', '<script>'), 'https://a/v2/shopify-install.html#error=invalid_request');
  assert.equal(L.claimPlan(null), 'connect');
  assert.equal(L.claimPlan({ is_active: false, auth_method: 'client_credentials' }), 'connect');
  assert.equal(L.claimPlan({ is_active: true, auth_method: 'oauth', oauth_app: 'public' }), 'refresh');
  assert.equal(L.claimPlan({ is_active: true, auth_method: 'oauth', oauth_app: 'legacy' }), 'refuse');
  assert.equal(L.claimPlan({ is_active: true, auth_method: 'client_credentials' }), 'refuse');
});

// ── 4. shopify-app-install, executed ─────────────────────────────────────────
await test('install: not configured and unsigned requests write nothing', async () => {
  const db = fakeDb();
  const off = createInstallHandler({ env: {}, db, fetchImpl: () => { throw new Error('no network'); }, now: () => NOW });
  assert.match(locationOf(await off(get(signed({ shop: 'bat-nutz.myshopify.com', timestamp: ts })))), /#error=not_configured$/);
  const h = createInstallHandler({ env: ENV, db, fetchImpl: () => { throw new Error('no network'); }, now: () => NOW });
  const forged = await h(get(signed({ shop: 'bat-nutz.myshopify.com', timestamp: ts }, 'wrong-secret')));
  assert.match(locationOf(forged), /#error=invalid_signature$/);
  assert.equal(db.log.length, 0, 'nothing was written or purged for an unsigned request');
  assert.match(locationOf(await h(get('https://x/functions/v1/shopify-app-install?shop=evil.com&hmac=1&timestamp=1'))), /#error=invalid_request$/);
});

await test('install: a signed launch starts OAuth at once with the public scopes; a stale one is refused', async () => {
  const db = fakeDb();
  const h = createInstallHandler({ env: ENV, db, fetchImpl: () => { throw new Error('no network'); }, now: () => NOW });
  const res = await h(get(signed({ shop: 'bat-nutz.myshopify.com', timestamp: ts, host: 'abc' })));
  assert.equal(res.status, 302);
  const u = new URL(locationOf(res));
  assert.equal(u.origin + u.pathname, 'https://bat-nutz.myshopify.com/admin/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'pub-id');
  assert.equal(u.searchParams.get('scope'), A.PUBLIC_SCOPES.join(','));
  assert.equal(u.searchParams.get('redirect_uri'), ENV.SHOPIFY_INSTALL_CALLBACK_URL);
  const state = db.tables.shopify_install_states[0];
  assert.equal(u.searchParams.get('state'), state.nonce);
  assert.equal(state.shop_domain, 'bat-nutz.myshopify.com');
  const stale = await h(get(signed({ shop: 'bat-nutz.myshopify.com', timestamp: String(Number(ts) - 3600) })));
  assert.match(locationOf(stale), /#error=stale_launch$/);
  assert.equal(db.tables.shopify_install_states.length, 1, 'the stale launch stored no state');
});

await test('install: the callback consumes its state, exchanges the code and parks only the hash', async () => {
  const future = new Date(NOW + 60_000).toISOString();
  const db = fakeDb({ shopify_install_states: [
    { nonce: 'n1', shop_domain: 'bat-nutz.myshopify.com', expires_at: future },
    { nonce: 'n2', shop_domain: 'other.myshopify.com', expires_at: future },
  ] });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    if (url.endsWith('/admin/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'shpat_new', scope: 'read_orders,read_products' }));
    return new Response(JSON.stringify({ shop: { name: 'Bat Nutz', currency: 'USD' } }));
  };
  const h = createInstallHandler({ env: ENV, db, fetchImpl, now: () => NOW });

  const mismatch = await h(get(signed({ shop: 'bat-nutz.myshopify.com', code: 'c', state: 'n2', timestamp: ts })));
  assert.match(locationOf(mismatch), /#error=shop_mismatch$/);
  assert.equal(calls.length, 0, 'no exchange for another store\'s state');
  assert.equal(db.tables.shopify_install_states.some((s) => s.nonce === 'n2'), false, 'the state was still consumed');

  const ok = await h(get(signed({ shop: 'bat-nutz.myshopify.com', code: 'the-code', state: 'n1', timestamp: ts })));
  const loc = locationOf(ok);
  assert.match(loc, /^https:\/\/get-silo\.com\/v2\/shopify-install\.html#claim=[A-Za-z0-9_-]{43}$/);
  const token = loc.split('#claim=')[1];
  assert.deepEqual(JSON.parse(calls[0][1].body), { client_id: 'pub-id', client_secret: SECRET, code: 'the-code' });
  const parked = db.tables.shopify_pending_installs[0];
  assert.equal(parked.claim_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(parked).includes(token), 'the claim token itself is never stored');
  assert.equal(parked.access_token, 'shpat_new');
  assert.deepEqual(parked.scopes_granted, ['read_orders', 'read_products']);
  assert.equal(parked.shop_name, 'Bat Nutz');
  assert.equal(db.tables.shopify_install_states.length, 0, 'single-use state');

  const replay = await h(get(signed({ shop: 'bat-nutz.myshopify.com', code: 'the-code', state: 'n1', timestamp: ts })));
  assert.match(locationOf(replay), /#error=invalid_or_expired_state$/);
});

// ── 5. shopify-install-claim, executed ───────────────────────────────────────
const coA = '11111111-1111-1111-1111-111111111111', coB = '22222222-2222-2222-2222-222222222222';
const CLAIM = L.newClaimToken();
function claimDb() {
  const db = fakeDb({
    shopify_pending_installs: [{ claim_hash: createHash('sha256').update(CLAIM).digest('hex'), shop_domain: 'bat-nutz.myshopify.com',
      shop_name: 'Bat Nutz', expires_at: new Date(Date.now() + 3_600_000).toISOString() }],
    profiles: [{ id: 'u1', role: 'user', active_company_id: coA, is_active: true }],
    entity_memberships: [
      { user_id: 'u1', entity_id: coA, role: 'admin', entity: { title: 'Bat Nutz', entity_type: 'company' } },
      { user_id: 'u1', entity_id: coB, role: 'member', entity: { title: 'Other Co', entity_type: 'company' } },
    ],
    shopify_connections: [],
  }, { shopify_claim_pending_install: () => ({ data: [{ outcome: 'connected', connection_id: 'c1', shop_domain: 'bat-nutz.myshopify.com' }], error: null }) });
  db.users = { jwt1: { id: 'u1' } };
  return db;
}
const post = (body, jwt = 'jwt1') => new Request('https://x/functions/v1/shopify-install-claim', {
  method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

await test('claim: sign-in required, malformed claims refused, unknown claims expired', async () => {
  const h = createClaimHandler({ admin: claimDb() });
  assert.equal((await h(post({ action: 'peek', claim: CLAIM }, 'nobody'))).status, 401);
  assert.equal((await h(post({ action: 'peek', claim: 'short' }))).status, 400);
  assert.equal((await h(post({ action: 'drop', claim: CLAIM }))).status, 400);
  assert.equal((await h(post({ action: 'peek', claim: L.newClaimToken() }))).status, 410);
});

await test('claim: peek lists only workspaces this person may connect, with the plan for each', async () => {
  const h = createClaimHandler({ admin: claimDb() });
  const res = await h(post({ action: 'peek', claim: CLAIM }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.shop_domain, 'bat-nutz.myshopify.com');
  assert.deepEqual(body.workspaces, [{ company_entity_id: coA, title: 'Bat Nutz', plan: 'connect' }], 'a member-only workspace is not offered');
});

await test('claim: a workspace the person does not administer never reaches the database', async () => {
  const db = claimDb();
  const h = createClaimHandler({ admin: db });
  const res = await h(post({ action: 'claim', claim: CLAIM, company_entity_id: coB }));
  assert.equal(res.status, 403);
  assert.equal(db.log.some((e) => e[0] === 'rpc'), false, 'the claim RPC was not called');
});

await test('claim: a good claim calls the RPC with the hash, never the token', async () => {
  const db = claimDb();
  const h = createClaimHandler({ admin: db });
  const res = await h(post({ action: 'claim', claim: CLAIM, company_entity_id: coA }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).outcome, 'connected');
  const [, name, args] = db.log.find((e) => e[0] === 'rpc');
  assert.equal(name, 'shopify_claim_pending_install');
  assert.deepEqual(args, { p_claim_hash: createHash('sha256').update(CLAIM).digest('hex'), p_company: coA, p_user: 'u1' });
});

// ── 6. page helper ───────────────────────────────────────────────────────────
await test('the page reads #claim / #error and refuses a malformed claim', () => {
  const ctx = { window: {}, URLSearchParams, encodeURIComponent };
  vm.runInNewContext(read('v2/shopify-install.js'), ctx);
  const P = ctx.window.SiloShopifyInstall;
  assert.equal(P.parseFragment(`#claim=${CLAIM}`).claim, CLAIM);
  assert.equal(P.parseFragment('#claim=short').claim, null);
  assert.equal(P.parseFragment('#error=stale_launch').error, 'stale_launch');
  assert.match(P.errorText('stale_launch'), /expired/);
  assert.equal(P.errorText('<b>'), P.errorText('invalid_request'), 'unknown codes get the generic text');
  assert.equal(P.loginUrl(), '/pages/login.html?next=%2Fv2%2Fshopify-install.html');
  for (const code of L.INSTALL_ERRORS) assert.ok(P.errorText(code), `page has words for ${code}`);
});

// ── 7. deploy workflow ───────────────────────────────────────────────────────
await test('deploy: shopify-app-install is public on every path; the claim function keeps JWT', () => {
  const wf = read('.github/workflows/deploy-edge-function.yml');
  const m = /NO_JWT_FUNCTIONS="([^"]*)"/.exec(wf);
  assert.ok(m, 'NO_JWT_FUNCTIONS not found');
  const list = m[1].split(/\s+/);
  assert.ok(list.includes('shopify-app-install'), 'Shopify presents no Supabase JWT to the App URL');
  assert.ok(!list.includes('shopify-install-claim'), 'the claim function must verify the caller');
});

console.log(`\n${n} passed`);
