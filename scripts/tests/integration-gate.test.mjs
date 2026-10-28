// Third-party integration gate for edge functions
// (scripts/lib/integration-gate.mjs, 20261020030000).
//
// A third-party OAuth access token is an ORDINARY Supabase session token: it
// reaches PostgREST, Storage and every verify_jwt edge function. The database
// refuses it everywhere but the report RPC, and that covers any function which
// asks PostgREST anything as the caller. This module is for a function that
// does not -- and the point of these tests is that it fails CLOSED on every
// input that is not plainly a signed-in first-party user.
//
// Run: node scripts/tests/integration-gate.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {
  checkIntegrationToken, readTokenClaims,
  INTEGRATION_NOT_ALLOWED, NOT_AUTHENTICATED,
} from '../lib/integration-gate.mjs';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (claims) => `Bearer ${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;

const USER = '11111111-1111-4111-8111-111111111111';
const FIRST_PARTY = { sub: USER, role: 'authenticated', aal: 'aal2' };
const INTEGRATION = { sub: USER, role: 'silo_integration', aal: 'aal1', client_id: 'client-one' };

test('a first-party session passes', () => {
  assert.deepEqual(checkIntegrationToken(token(FIRST_PARTY)), { ok: true });
  assert.deepEqual(checkIntegrationToken(token({ ...FIRST_PARTY, aal: 'aal1' })), { ok: true },
    'assurance is the MFA gate\'s business, not this one\'s');
});

test('a third-party token is refused 403, by client_id and not by role', () => {
  const refused = { ok: false, status: 403, code: 'integration_not_allowed', message: INTEGRATION_NOT_ALLOWED };
  assert.deepEqual(checkIntegrationToken(token(INTEGRATION)), refused);
  // A token carrying client_id while claiming an ordinary role is exactly the
  // shape a bug in the access-token hook would produce, and it must still lose.
  assert.deepEqual(checkIntegrationToken(token({ ...FIRST_PARTY, client_id: 'client-one' })), refused);
});

test('the MCP endpoint is the one deliberate exception', () => {
  assert.deepEqual(checkIntegrationToken(token(INTEGRATION), { allowIntegration: true }), { ok: true });
  // and it does not become a way in for a token that is not authenticated at all
  assert.equal(checkIntegrationToken(token({ role: 'anon' }), { allowIntegration: true }).code, 'not_authenticated');
});

test('it fails closed on everything that is not a signed-in user', () => {
  const cases = [
    ['nothing', undefined],
    ['empty', ''],
    ['no Bearer prefix', b64url(FIRST_PARTY)],
    ['not a JWT', 'Bearer abc'],
    ['two segments', 'Bearer a.b'],
    ['payload is not base64', 'Bearer a.!!!.c'],
    ['payload is not JSON', `Bearer a.${Buffer.from('hello').toString('base64url')}.c`],
    ['payload is a JSON string', `Bearer a.${b64url('nope')}.c`],
    // The project's anon key: a real, signature-valid JWT with no subject.
    // verify_jwt lets it through on its own, so this module must not.
    ['the anon key', token({ role: 'anon', iss: 'supabase' })],
    ['the service key', token({ role: 'service_role', iss: 'supabase' })],
    ['no subject', token({ role: 'authenticated' })],
    ['the dead-end role', token({ sub: USER, role: 'silo_revoked', client_id: 'client-one' })],
  ];
  for (const [name, auth] of cases) {
    const r = checkIntegrationToken(auth);
    assert.equal(r.ok, false, name);
    assert.equal(r.message, NOT_AUTHENTICATED, name);
    assert.equal(r.status, 401, name);
  }
});

test('readTokenClaims decodes base64url padding and non-ASCII', () => {
  const claims = { sub: USER, role: 'authenticated', name: 'Ünïcøde ✓' };
  assert.deepEqual(readTokenClaims(token(claims)), claims);
  assert.equal(readTokenClaims('Bearer a.b'), null);
});

test('the gate module says what the database says', () => {
  const sql = fs.readFileSync(
    new URL('../../supabase/migrations/20261020030000_developer_api_integration_access.sql', import.meta.url),
    'utf8');
  // One wording for one refusal, wherever a caller meets it.
  assert.ok(sql.includes(`'message', 'This connection cannot use that feature.'`),
    'the pre-request hook must use the same message as INTEGRATION_NOT_ALLOWED');
  assert.ok(sql.includes("'code', 'integration_not_allowed'"));
  assert.ok(sql.includes("'silo_revoked'"), 'the dead-end role this module refuses must exist');
});

// ---------------------------------------------------------------------------
// PR1: the per-function copies.
// ---------------------------------------------------------------------------
// A function is gated here when it verifies the caller with auth.getUser() and
// then works ONLY through the service role, so the caller's token never
// reaches PostgREST and the pre-request hook never sees it. That is the same
// condition the two-step-login rule uses, hence the same seventeen -- plus two
// that the hook reaches only AFTER work of their own has already happened:
//
//   silo-chat            meters AI credit, writes the audit row and the answer
//                        row before the caller's first PostgREST read.
//   report-email-deliver reads the schedule named BY THE REQUEST with the
//                        service role before the caller's membership check,
//                        which is the read the hook refuses -- so without the
//                        gate a developer token reopens the schedule-id
//                        existence oracle that the unauthenticated branch
//                        above it closes.
//
// Thirty-four functions take a caller token; the other fifteen make a
// caller-token PostgREST call whose failure aborts, and the database refuses
// them there. A service-role read BEFORE that call is not automatically a gap:
// stripe-billing, stripe-connect and stripe-invoice each read the caller's own
// profile row keyed by the id getUser just verified, which tells a third party
// nothing it does not already have. report-email-deliver is listed because its
// early read is keyed by an id the REQUEST chose. Adding a function to this
// list is cheap; leaving a new service-role-only function off it is the
// failure this test exists to catch.
const INLINE = [
  'comp-request-notify', 'google-oauth-start', 'org-invite-send', 'payment-request-submitted-notify',
  'platform-invite-send', 'quickbooks-accounts-sync', 'quickbooks-oauth-start', 'quickbooks-report',
  'review-finish', 'review-send', 'shopify-connect-dev-app', 'shopify-oauth-start', 'tiktok-oauth-start',
];
// Injected rather than imported, so a test can drive the handler without
// minting a token. index.ts wires the real module.
const INJECTED = {
  'meta-oauth-start': 'handler.mjs',
  'meta-oauth-review': 'handler.mjs',
  'shopify-install-claim': 'handler.mjs',
  'card-categorize': 'prepare.ts',
};
const PRE_AUTH = { 'report-email-deliver': 'handler.mjs' };
const readFn = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('every gated function ships the gate byte for byte', () => {
  const original = readFn('scripts/lib/integration-gate.mjs');
  for (const fn of [...INLINE, ...Object.keys(INJECTED), ...Object.keys(PRE_AUTH)]) {
    assert.equal(readFn(`supabase/functions/${fn}/integration-gate.mjs`), original,
      `re-copy scripts/lib/integration-gate.mjs into ${fn}/`);
  }
});

// The first service-role read or write: the gate must come before it. Same
// shapes mfa-gate.test.mjs matches, plus silo-chat's service-role client.
const SERVICE_CALL = /\b(?:db|supabase|admin|serviceDb|client)\s*\.\s*(?:from|rpc|storage)\s*\(/g;
function gateBeforeServiceRole(src, gateCall, label) {
  const authAt = src.search(/\.auth\.getUser\(/);
  assert.ok(authAt > 0, `${label}: no auth.getUser`);
  const gateAt = src.indexOf(gateCall, authAt);
  assert.ok(gateAt > authAt, `${label}: the third-party check runs after the caller is verified`);
  SERVICE_CALL.lastIndex = authAt;
  const first = SERVICE_CALL.exec(src);
  assert.ok(first, `${label}: no service-role call found`);
  assert.ok(gateAt < first.index,
    `${label}: the third-party check runs before the first service-role call (${first[0]})`);
  const refusal = src.slice(gateAt, gateAt + 400);
  assert.match(refusal, /if \(!integ\.ok\) return/, `${label}: a refusal returns`);
  // The refusal must carry the gate's OWN status. Three of these files answer
  // over several lines, and a one-line copy of the two-step refusal parsed as
  // `return new Response(…, {` with the object never closed -- a file that no
  // longer compiles, while `if (!integ.ok) return` still matched. The missing
  // `integ.status` is the tell, and the whole-file parse below is the backstop.
  assert.match(refusal, /integ\.status/, `${label}: the refusal answers with the gate's status`);
}

// Every gated source still PARSES. stripTypeScriptTypes throws on a syntax
// error, which is the only thing that catches a refusal statement truncated
// mid-expression -- no deno in CI, and `deno check` would not run here anyway.
test('every gated source still parses', () => {
  for (const fn of [...INLINE, 'silo-chat']) {
    const p = `supabase/functions/${fn}/index.ts`;
    assert.doesNotThrow(() => stripTypeScriptTypes(readFn(p), { mode: 'strip' }), p);
  }
  for (const [fn, file] of Object.entries({ ...INJECTED, ...PRE_AUTH })) {
    const p = `supabase/functions/${fn}/${file}`;
    assert.doesNotThrow(() => stripTypeScriptTypes(readFn(p), { mode: 'strip' }), p);
  }
  for (const fn of Object.keys({ ...INJECTED, ...PRE_AUTH })) {
    const p = `supabase/functions/${fn}/index.ts`;
    assert.doesNotThrow(() => stripTypeScriptTypes(readFn(p), { mode: 'strip' }), p);
  }
});

test('each inline function checks the token before its first service-role call', () => {
  for (const fn of INLINE) {
    const src = readFn(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /import \{ checkIntegrationToken \} from '\.\/integration-gate\.mjs';/, fn);
    gateBeforeServiceRole(src, 'checkIntegrationToken(', fn);
  }
});

test('each injected function checks before its first service-role call, and index.ts wires the real gate', () => {
  for (const [fn, file] of Object.entries(INJECTED)) {
    gateBeforeServiceRole(readFn(`supabase/functions/${fn}/${file}`), 'checkIntegration', fn);
    const idx = readFn(`supabase/functions/${fn}/index.ts`);
    assert.match(idx, /import \{ checkIntegrationToken \} from '\.\/integration-gate\.mjs';/, `${fn}/index.ts`);
    assert.match(idx, /checkIntegration: \(authorization: string\) => checkIntegrationToken\(authorization\)/,
      `${fn}/index.ts wires the real gate`);
    // Unwired must refuse, never pass. The behaviour of that is asserted in
    // mfa-gate.test.mjs's sibling case; this pins the fail-closed default.
    assert.match(readFn(`supabase/functions/${fn}/${file}`),
      /: \{ ok: false, status: 503, code: 'integration_check_failed'/, `${fn}: unwired fails closed`);
  }
});

test('silo-chat gates after the caller is verified and before any work of its own', () => {
  const src = readFn('supabase/functions/silo-chat/index.ts');
  assert.match(src, /import \{ checkIntegrationToken \} from '\.\/integration-gate\.mjs';/);
  const authAt = src.search(/callerClient\.auth\.getUser\(\)/);
  const gateAt = src.indexOf('checkIntegrationToken(req.headers.get', authAt);
  assert.ok(authAt > 0 && gateAt > authAt, 'the gate runs after the caller is verified');
  assert.match(src.slice(gateAt, gateAt + 300), /if \(!integ\.ok\) return/, 'a refusal returns');
  // Its service-role client is the credit meter's; everything else runs as the
  // caller. Nothing may be metered, logged or answered before the gate.
  for (const marker of ['creditClient()', "from('silo_chat_audit_log')", "from('silo_chat_responses')"]) {
    const at = src.indexOf(marker, authAt);
    assert.ok(at < 0 || at > gateAt, `silo-chat: ${marker} runs before the third-party check`);
  }
});

test('report-email-deliver gates before the service-role schedule read, and never the cron path', () => {
  const src = readFn('supabase/functions/report-email-deliver/handler.mjs');
  assert.match(src, /import \{ checkIntegrationToken \} from '\.\/integration-gate\.mjs';/);
  const gateAt = src.indexOf('checkIntegrationToken(authHeader)');
  assert.ok(gateAt > 0, 'the gate is called');
  const scheduleAt = src.indexOf("serviceDb.from('report_email_schedules')");
  assert.ok(scheduleAt > 0 && gateAt < scheduleAt,
    'the gate runs before the service-role schedule read, or the existence oracle reopens');
  // The scheduled run carries no user JWT; gating it would stop every delivery.
  assert.match(src.slice(gateAt - 200, gateAt), /if \(!isCron\) \{/, 'the cron path is not gated');
});
