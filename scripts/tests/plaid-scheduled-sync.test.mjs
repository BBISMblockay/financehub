import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'npm:jose@6.2.12';
import { verifySchedulerIdentity } from '../../supabase/functions/plaid-scheduled-sync/oidc.mjs';
import { createScheduledHandler } from '../../supabase/functions/plaid-scheduled-sync/handler.mjs';
const keys = await generateKeyPair('RS256');
const audience = 'https://synthetic.supabase.co/functions/v1/plaid-scheduled-sync';
const claims = { sub: 'repo:BBISMblockay/financehub:ref:refs/heads/main', repository: 'BBISMblockay/financehub',
  repository_id: '1110494889', repository_owner_id: '227868936', ref: 'refs/heads/main', ref_type: 'branch',
  workflow_ref: 'BBISMblockay/financehub/.github/workflows/plaid-sync.yml@refs/heads/main',
  event_name: 'workflow_dispatch', runner_environment: 'github-hosted' };
async function signed(changes = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, iss: 'https://token.actions.githubusercontent.com', aud: audience,
    iat: now, nbf: now - 1, exp: now + 300, jti: 'synthetic-run', ...changes }).setProtectedHeader({ alg: 'RS256' }).sign(key);
}
const token = await signed();
test('signed identity rejects forks, other jobs, branches, subjects, expired tokens and wrong keys', async () => {
  await verifySchedulerIdentity(token, audience, keys.publicKey);
  await verifySchedulerIdentity(await signed({ event_name: 'schedule' }), audience, keys.publicKey);
  await verifySchedulerIdentity(await signed({ sub: 'repo:BBISMblockay@227868936/financehub@1110494889:ref:refs/heads/main' }), audience, keys.publicKey);
  for (const change of [
    { repository: 'fork/financehub' }, { repository_id: '111' }, { repository_owner_id: '222' },
    { sub: 'repo:BBISMblockay/financehub:pull_request' }, { ref: 'refs/heads/feature' }, { ref_type: 'tag' },
    { workflow_ref: 'BBISMblockay/financehub/.github/workflows/other.yml@refs/heads/main' },
    { event_name: 'pull_request_target' }, { runner_environment: 'self-hosted' },
    { aud: 'other-project' }, { iss: 'https://attacker.test' }, { exp: 1 }, { nbf: 9999999999 }, { iat: 1 },
  ]) await assert.rejects(verifySchedulerIdentity(await signed(change), audience, keys.publicKey));
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifySchedulerIdentity(await signed({}, other.privateKey), audience, keys.publicKey));
  await assert.rejects(verifySchedulerIdentity('unsigned', audience, keys.publicKey));
});
const account = '00000000-0000-0000-0000-000000000001';
function fixture({ enabled = 'true', syncFails = false, empty = false, discoveryFails = false } = {}) {
  const events = [];
  const query = new Proxy({}, { get(_target, name) {
    if (name === 'then') return (resolve, reject) => Promise.resolve({ data: empty ? [] : [{ id: account }], error: discoveryFails ? {} : null }).then(resolve, reject);
    return (...args) => { events.push([name, ...args]); return query; };
  } });
  const handler = createScheduledHandler({ env: key => ({ SUPABASE_URL: 'https://synthetic.supabase.co', PLAID_BACKGROUND_SYNC_ENABLED: enabled, PLAID_ENVIRONMENT: 'sandbox' })[key],
    verifyIdentity: (value, aud) => verifySchedulerIdentity(value, aud, keys.publicKey),
    createDb: () => { events.push(['db']); return { from: name => { events.push(['from', name]); return query; } }; },
    syncAccount: async id => { events.push(['sync', id]); return syncFails
      ? Response.json({ error: 'private-bank-token' }, { status: 502 }) : Response.json({ batch_ids: [], exceptions: 1 }); },
  });
  return { events, request: (body = {}, identity = token) => handler(new Request(audience, { method: 'POST',
    headers: { 'x-silo-scheduler-token': identity }, body: JSON.stringify(body) })) };
}
test('integrated signed request gates all IO, discovers mapped environment accounts and permits only sync', async () => {
  for (const bad of ['', 'invalid', await signed({ event_name: 'pull_request' })]) {
    const f = fixture(); assert.equal((await f.request({}, bad)).status, 401); assert.equal(f.events.length, 0);
  }
  const disabled = fixture({ enabled: 'false' }); assert.equal((await disabled.request()).status, 403); assert.equal(disabled.events.length, 0);
  for (const body of [{ action: 'approve' }, { account_id: account }, { after: 'bad' }, [], null]) {
    const f = fixture(); assert.equal((await f.request(body)).status, 400); assert.equal(f.events.length, 0);
  }
  const f = fixture(); const response = await f.request();
  assert.deepEqual(await response.json(), { done: false, account_id: account, ok: true, status: 200, exceptions: 1 });
  for (const event of [['not', 'source_id', 'is', null], ['eq', 'plaid_connections.status', 'active'],
    ['eq', 'plaid_connections.environment', 'sandbox'], ['limit', 1], ['sync', account]]) assert.ok(f.events.some(e => JSON.stringify(e) === JSON.stringify(event)));
  const failed = fixture({ syncFails: true }); const failure = await (await failed.request()).text();
  assert.match(failure, /account_sync_failed/); assert.doesNotMatch(failure, /private-bank-token/);
  const empty = fixture({ empty: true }); assert.deepEqual(await (await empty.request()).json(), { done: true }); assert.ok(!empty.events.some(e => e[0] === 'sync'));
  const discovery = fixture({ discoveryFails: true }); assert.equal((await discovery.request()).status, 503); assert.ok(!discovery.events.some(e => e[0] === 'sync'));
  const cursor = fixture(); assert.equal((await cursor.request({ after: account })).status, 503); assert.ok(!cursor.events.some(e => e[0] === 'sync'));
});

test('deployed entrypoint wires verified OIDC to fixed in-process ingestion only', async () => {
  const { readFile } = await import('node:fs/promises');
  const { stripTypeScriptTypes } = await import('node:module');
  const vm = await import('node:vm');
  const source = await readFile(new URL('../../supabase/functions/plaid-scheduled-sync/index.ts', import.meta.url), 'utf8');
  const runnable = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, ''), { mode: 'strip' });
  let handler, dbCalls = 0, ingestionCalls = 0;
  const query = new Proxy({}, { get(_target, name) {
    if (name === 'then') return resolve => resolve({ data: [{ id: account }], error: null });
    return () => query;
  } });
  vm.runInNewContext(runnable, { Request, createScheduledHandler,
    verifySchedulerIdentity: (value, aud) => verifySchedulerIdentity(value, aud, keys.publicKey),
    createClient: (url, key) => { assert.equal(url, 'https://synthetic.supabase.co'); assert.equal(key, 'server-only-secret'); dbCalls++; return { from: () => query }; },
    handlePlaidFinance: async req => {
      ingestionCalls++;
      assert.equal(req.headers.get('Authorization'), 'Bearer server-only-secret');
      assert.deepEqual(await req.json(), { action: 'sync_background', account_id: account });
      return Response.json({ batch_ids: [], exceptions: 0 });
    },
    Deno: { serve: fn => { handler = fn; }, env: { get: key => ({ SUPABASE_URL: 'https://synthetic.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret', PLAID_BACKGROUND_SYNC_ENABLED: 'true', PLAID_ENVIRONMENT: 'sandbox' })[key] } },
  });
  const req = identity => new Request(audience, { method: 'POST', headers: { 'x-silo-scheduler-token': identity }, body: '{}' });
  assert.equal((await handler(req('forged'))).status, 401);
  assert.deepEqual([dbCalls, ingestionCalls], [0, 0]);
  const response = await handler(req(token));
  assert.equal(response.status, 200);
  const text = await response.text(); assert.doesNotMatch(text, /server-only-secret/);
  assert.equal(JSON.parse(text).ok, true, 'the fixed in-process ingestion call must succeed');
  assert.deepEqual([dbCalls, ingestionCalls], [1, 1]);
});
