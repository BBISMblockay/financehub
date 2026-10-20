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
