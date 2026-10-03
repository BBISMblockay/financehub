import assert from 'node:assert/strict';
import { clientSideReason, makeFinishJob, runConnections } from '../lib/ad-sync-client-errors.mjs';

let n = 0; const t = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };

// Verbatim shape of the BlockayOps failure in run 37033270496 (2026-10-02).
const blockayOps = 'Google Ads search → 403: {\n  "error": {\n    "code": 403,\n    "message": "The caller does not have permission",\n    "status": "PERMISSION_DENIED",\n    "details": [\n      {\n        "@type": "type.googleapis.com/google.ads.googleads.v24.errors.GoogleAdsFailure",\n        "errors": [\n          {\n            "errorCode": {\n              "authorizationError": "CUSTOMER_NOT_ENABLED"\n            },\n            "message": "The customer account can\'t be accessed because it is not yet enabled or has been deactivated."\n          }\n ';
const googleBody = (code) => blockayOps.replace('CUSTOMER_NOT_ENABLED', code);

t('a cancelled client Google Ads account is client-side', () => {
  assert.match(clientSideReason(blockayOps), /not enabled/);
});
t('other account-owner Google Ads codes are client-side', () => {
  for (const code of ['CUSTOMER_NOT_FOUND', 'USER_PERMISSION_DENIED', 'NOT_ADS_USER']) assert.ok(clientSideReason(googleBody(code)), code);
});
t("SILO's own developer-token refusals still fail the run", () => {
  for (const code of ['DEVELOPER_TOKEN_NOT_APPROVED', 'DEVELOPER_TOKEN_PROHIBITED']) assert.equal(clientSideReason(googleBody(code)), null, code);
});
t('revoked Google access and a never-finished connection are client-side', () => {
  assert.ok(clientSideReason('Google token refresh → 400: {"error":"invalid_grant","error_description":"Token has been expired or revoked."}'));
  assert.ok(clientSideReason('No refresh token — reconnect via OAuth'));
  // invalid_grant anywhere else is not assumed to be the client's.
  assert.equal(clientSideReason('Some other call → 400: {"error":"invalid_grant"}'), null);
});
t('an invalidated Meta token is client-side; other Meta errors are not', () => {
  assert.ok(clientSideReason('Meta insights → 400: {"error":{"message":"Error validating access token","type":"OAuthException","code":190,"error_subcode":460}}'));
  assert.equal(clientSideReason('Meta insights → 400: {"error":{"message":"Invalid parameter","type":"OAuthException","code":100}}'), null);
});
t('5xx, timeouts, bugs and empty messages are SILO-side', () => {
  for (const m of ['Google Ads search → 500: internal', 'fetch failed', "TypeError: Cannot read properties of undefined (reading 'rows')", '', null, undefined]) assert.equal(clientSideReason(m), null, String(m));
});

// The orchestrator, with the real failure path: syncConnection's catch records
// the error through finishJob, then rethrows.
const fakeDb = (fail) => { const writes = []; return { writes, from: () => ({ update: (u) => ({ eq: async () => { writes.push(u); return fail ? { error: { message: 'connection reset' } } : { error: null }; } }) }) }; };
const syncWith = (finishJob, failure) => async (c) => {
  if (!failure) { await finishJob('job-' + c.id, 'success', {}); return { connection: c.id }; }
  try { throw new Error(failure); } catch (err) { await finishJob('job-' + c.id, 'error', { error: err.message }); throw err; }
};
const tasync = async (name, fn) => { await fn(); console.log(`ok ${++n} - ${name}`); };
await tasync('a client-side failure with its error recorded leaves the run green and reports it', async () => {
  const db = fakeDb(false), finishJob = makeFinishJob(db);
  const out = await runConnections([{ id: 'ok' }, { id: 'blockay' }], (c) => syncWith(finishJob, c.id === 'blockay' ? blockayOps : null)(c));
  assert.equal(out.hadError, false); assert.equal(out.clientSide.length, 1); assert.equal(out.clientSide[0].connection.id, 'blockay');
  assert.equal(db.writes.at(-1).status, 'error');
});
await tasync('the same client-side failure goes RED when its error record cannot be written', async () => {
  const finishJob = makeFinishJob(fakeDb(true));
  const out = await runConnections([{ id: 'blockay' }], syncWith(finishJob, blockayOps));
  assert.equal(out.hadError, true); assert.equal(out.clientSide.length, 0);
  assert.match(out.results[0].error, /sync_jobs update failed/);
});
await tasync('a SILO-side failure is red; a success write that fails is red too', async () => {
  const ok = makeFinishJob(fakeDb(false));
  assert.equal((await runConnections([{ id: 'x' }], syncWith(ok, 'Google Ads search → 500: internal'))).hadError, true);
  assert.equal((await runConnections([{ id: 'x' }], syncWith(makeFinishJob(fakeDb(true)), null))).hadError, true);
});
console.log(`${n} client-side classification checks passed`);
