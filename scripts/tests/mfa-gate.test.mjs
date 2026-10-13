// Two-step login gate for edge functions that act with the service role
// (scripts/lib/mfa-gate.mjs, 20261014000000).
//
// The Data API refuses an enrolled user's aal1 session with a pre-request hook.
// Sixteen edge functions verify the caller with auth.getUser() and then work
// ONLY through the service-role client, so the hook never sees the caller's
// token there; each asks PostgREST as the caller first. Found by the 2026-10-13
// audit of every user-facing function (the other fifteen already make a
// mandatory caller-token PostgREST call before acting).
//
// Run: node scripts/tests/mfa-gate.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { checkMfaSession, MFA_REQUIRED_MESSAGE } from '../lib/mfa-gate.mjs';
import { createStartHandler } from '../../supabase/functions/meta-oauth-start/handler.mjs';
import { createReviewHandler } from '../../supabase/functions/meta-oauth-review/handler.mjs';
import { createClaimHandler } from '../../supabase/functions/shopify-install-claim/handler.mjs';
import { loadCategorizer, prepareSource } from './lib/card-categorize-sandbox.mjs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const URL_ = 'https://proj.supabase.co';
const ANON = 'anon-key';
const BEARER = 'Bearer user.jwt.token';

function fakeFetch(status, body, log = []) {
  return async (url, init) => {
    log.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('no body'); return body; } };
  };
}

// The functions whose caller-token check is this gate (audit 2026-10-13).
const INLINE = [
  'comp-request-notify', 'google-oauth-start', 'org-invite-send', 'payment-request-submitted-notify',
  'quickbooks-accounts-sync', 'quickbooks-oauth-start', 'quickbooks-report', 'review-finish', 'review-send',
  'shopify-connect-dev-app', 'shopify-oauth-start', 'tiktok-oauth-start',
];
const HANDLERS = {
  'meta-oauth-start': 'handler.mjs',
  'meta-oauth-review': 'handler.mjs',
  'shopify-install-claim': 'handler.mjs',
  'card-categorize': 'prepare.ts',
};

test('asks PostgREST as the caller, and only `true` lets the request through', async () => {
  const log = [];
  assert.deepEqual(await checkMfaSession({ supabaseUrl: URL_ + '/', anonKey: ANON, authorization: BEARER, fetchImpl: fakeFetch(200, true, log) }), { ok: true });
  assert.equal(log[0].url, `${URL_}/rest/v1/rpc/mfa_session_satisfied`);
  assert.equal(log[0].init.method, 'POST');
  assert.equal(log[0].init.headers.Authorization, BEARER, "the caller's own token, never the service key");
  assert.equal(log[0].init.headers.apikey, ANON);
});

test('an enrolled user without the code is refused 403 mfa_required, by the hook or by the function', async () => {
  for (const [status, body] of [[403, { code: 'mfa_required', message: 'x' }], [200, false]]) {
    const r = await checkMfaSession({ supabaseUrl: URL_, anonKey: ANON, authorization: BEARER, fetchImpl: fakeFetch(status, body) });
    assert.deepEqual(r, { ok: false, status: 403, code: 'mfa_required', message: MFA_REQUIRED_MESSAGE }, `${status}`);
  }
});

test('anything else fails closed: no answer is never a pass', async () => {
  const cases = [
    [fakeFetch(404, { code: 'PGRST202' }), 503], // migration not applied
    [fakeFetch(500, { message: 'boom' }), 503],
    [fakeFetch(200, null), 503],
    [fakeFetch(200, 'true'), 503],
    [fakeFetch(200, undefined), 503], // unparseable
    [fakeFetch(401, { message: 'JWT expired' }), 401],
    [async () => { throw new Error('network'); }, 503],
  ];
  for (const [fetchImpl, status] of cases) {
    const r = await checkMfaSession({ supabaseUrl: URL_, anonKey: ANON, authorization: BEARER, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.status, status);
  }
  let called = false;
  const spy = async () => { called = true; return { ok: true, status: 200, json: async () => true }; };
  for (const args of [{ anonKey: ANON, authorization: BEARER }, { supabaseUrl: URL_, authorization: BEARER },
    { supabaseUrl: URL_, anonKey: ANON }, { supabaseUrl: URL_, anonKey: ANON, authorization: 'user.jwt' },
    { supabaseUrl: URL_, anonKey: ANON, authorization: 'Bearer ' }]) {
    assert.equal((await checkMfaSession({ ...args, fetchImpl: spy })).status, 401);
  }
  assert.equal(called, false, 'a request with no usable caller token is refused before any call');
});

test('every gated function ships the gate byte for byte', () => {
  const original = read('scripts/lib/mfa-gate.mjs');
  for (const fn of [...INLINE, ...Object.keys(HANDLERS)]) {
    assert.equal(read(`supabase/functions/${fn}/mfa-gate.mjs`), original, `re-copy scripts/lib/mfa-gate.mjs into ${fn}/`);
  }
});

// First service-role read or write after the caller is verified: the gate must
// come before it. Matches `db.from(`, `await supabase\n  .from(`, `admin.rpc(`.
const SERVICE_CALL = /\b(?:db|supabase|admin)\s*\.\s*(?:from|rpc)\s*\(/g;
function gateBeforeServiceRole(src, gateCall, label) {
  const authAt = src.search(/\.auth\.getUser\(/);
  assert.ok(authAt > 0, `${label}: no auth.getUser`);
  const gateAt = src.indexOf(gateCall, authAt);
  assert.ok(gateAt > authAt, `${label}: the two-step check runs after the caller is verified`);
  SERVICE_CALL.lastIndex = authAt;
  const first = SERVICE_CALL.exec(src);
  assert.ok(first, `${label}: no service-role call found`);
  assert.ok(gateAt < first.index, `${label}: the two-step check runs before the first service-role call (${first[0]})`);
  assert.match(src.slice(gateAt, gateAt + 400), /if \(!mfa\.ok\) return/, `${label}: a refusal returns`);
}

test('each inline function checks two-step login before its first service-role call', () => {
  for (const fn of INLINE) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /import \{ checkMfaSession \} from '\.\/mfa-gate\.mjs';/, fn);
    gateBeforeServiceRole(src, 'checkMfaSession(', fn);
    assert.match(src, /anonKey: Deno\.env\.get\('SUPABASE_ANON_KEY'\)/, `${fn}: the anon key, never the service key`);
  }
});

test('each handler function checks before its first service-role call, and index.ts wires the real gate', () => {
  for (const [fn, file] of Object.entries(HANDLERS)) {
    gateBeforeServiceRole(read(`supabase/functions/${fn}/${file}`), 'checkMfa(', fn);
    const idx = read(`supabase/functions/${fn}/index.ts`);
    assert.match(idx, /checkMfa: \(authorization: string\) => checkMfaSession\(\{/, `${fn}/index.ts wires checkMfaSession`);
    assert.match(idx, /anonKey: Deno\.env\.get\('SUPABASE_ANON_KEY'\)/, fn);
  }
});

// Behaviour of the four handlers: a refused check returns before any
// service-role read, and an unwired check refuses (503) rather than passing.
function refusingAdmin() {
  const touched = [];
  return {
    touched,
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (t) => { touched.push(t); throw new Error(`service-role read of ${t} before the two-step check`); },
    rpc: (n) => { touched.push(n); throw new Error(`service-role rpc ${n} before the two-step check`); },
  };
}
const post = (body) => new Request('https://fn.local/', {
  method: 'POST', headers: { Authorization: BEARER, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const REFUSE = async () => ({ ok: false, status: 403, code: 'mfa_required', message: MFA_REQUIRED_MESSAGE });
const ENV = {
  META_APP_ID: 'app', META_LOGIN_CONFIG_ID: 'cfg', META_OAUTH_REDIRECT_URI: 'https://x/cb',
  META_REVIEW_COMPANY_IDS: '00000000-0000-0000-0000-000000000001', SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON,
};

test('a refused check stops each handler before any service-role read; an unwired one refuses too', async () => {
  const builds = {
    'meta-oauth-start': (deps) => createStartHandler({ env: ENV, ...deps }),
    'meta-oauth-review': (deps) => createReviewHandler({ env: ENV, fetchImpl: fakeFetch(500, {}), ...deps }),
    'shopify-install-claim': (deps) => createClaimHandler({ ...deps }),
  };
  const bodies = {
    'meta-oauth-start': { company_entity_id: '00000000-0000-0000-0000-000000000001' },
    'meta-oauth-review': { action: 'status' },
    'shopify-install-claim': { action: 'peek', claim: 'a'.repeat(43) },
  };
  for (const [fn, build] of Object.entries(builds)) {
    const admin = refusingAdmin();
    const res = await build({ admin, checkMfa: REFUSE })(post(bodies[fn]));
    assert.equal(res.status, 403, fn);
    assert.equal((await res.json()).code, 'mfa_required', fn);
    assert.deepEqual(admin.touched, [], `${fn}: nothing read with the service role`);
    const unwired = await build({ admin: refusingAdmin() })(post(bodies[fn]));
    assert.equal(unwired.status, 503, `${fn}: no check wired is a refusal, not a pass`);
  }
});

test('card-categorize: a refused check stops the request before the preparer touches the database', async () => {
  const touched = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (t) => { touched.push(t); throw new Error(`read ${t}`); },
    rpc: (n) => { touched.push(n); throw new Error(`rpc ${n}`); },
  };
  const { handler } = loadCategorizer(await prepareSource(), {
    createClient: () => client, fetch: async () => { throw new Error('no model call'); }, checkMfa: REFUSE,
  });
  const res = await handler(new Request('https://fn.local/', {
    method: 'POST', headers: { Authorization: BEARER },
    body: JSON.stringify({ batch_id: '00000000-0000-0000-0000-000000000001', transaction_ids: ['00000000-0000-0000-0000-000000000002'] }),
  }));
  assert.equal(res.status, 403);
  assert.deepEqual(touched, []);
});
