// The scheduled coding-preparation endpoint: who may call it, what the caller
// may and may not choose, and what it hands the preparation service. Real
// handler and real OIDC verifier; signed test tokens; a fake database.
//
// Run: node --import ./scripts/tests/plaid-oidc/register.mjs scripts/tests/card-coding-prepare-scheduled.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'npm:jose@6.2.12';
import { verifySchedulerIdentity, WORKFLOWS } from '../../supabase/functions/card-coding-prepare-scheduled/oidc.mjs';
import { createScheduledPrepareHandler, ROWS_PER_INVOCATION } from '../../supabase/functions/card-coding-prepare-scheduled/handler.mjs';

const keys = await generateKeyPair('RS256');
const audience = 'https://synthetic.supabase.co/functions/v1/card-coding-prepare-scheduled';
const claims = { sub: 'repo:BBISMblockay/financehub:ref:refs/heads/main', repository: 'BBISMblockay/financehub',
  repository_id: '1110494889', repository_owner_id: '227868936', ref: 'refs/heads/main', ref_type: 'branch',
  workflow_ref: 'BBISMblockay/financehub/.github/workflows/card-coding-prepare.yml@refs/heads/main',
  event_name: 'schedule', runner_environment: 'github-hosted' };
async function signed(changes = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, iss: 'https://token.actions.githubusercontent.com', aud: audience,
    iat: now, nbf: now - 1, exp: now + 300, jti: 'synthetic-run', ...changes }).setProtectedHeader({ alg: 'RS256' }).sign(key);
}
const token = await signed();

test('only the two preparation workflows on main may call it', async () => {
  for (const workflow of WORKFLOWS) await verifySchedulerIdentity(await signed({ workflow_ref: workflow }), audience, keys.publicKey);
  await verifySchedulerIdentity(await signed({ event_name: 'workflow_dispatch' }), audience, keys.publicKey);
  for (const change of [
    { workflow_ref: 'BBISMblockay/financehub/.github/workflows/sync-tests.yml@refs/heads/main' },
    { workflow_ref: 'BBISMblockay/financehub/.github/workflows/card-coding-prepare.yml@refs/heads/feature' },
    { repository: 'fork/financehub' }, { repository_id: '1' }, { repository_owner_id: '2' },
    { sub: 'repo:BBISMblockay/financehub:pull_request' }, { ref: 'refs/heads/feature' }, { ref_type: 'tag' },
    { event_name: 'pull_request_target' }, { event_name: 'workflow_run' }, { runner_environment: 'self-hosted' },
    { aud: 'https://synthetic.supabase.co/functions/v1/plaid-scheduled-sync' }, { iss: 'https://attacker.test' }, { exp: 1 },
  ]) await assert.rejects(verifySchedulerIdentity(await signed(change), audience, keys.publicKey), undefined, JSON.stringify(change));
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifySchedulerIdentity(await signed({}, other.privateKey), audience, keys.publicKey));
});

const BATCH = '00000000-0000-4000-8000-000000000001', COMPANY = '00000000-0000-4000-8000-000000000006';
const AFTER = '00000000-0000-4000-8000-000000000000';
const txn = (i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
function fixture({ enabled = 'true', work = { batch_id: BATCH, company_entity_id: COMPANY, transaction_ids: [txn(1), txn(2)], remaining: 3 },
  discoveryFails = false, prepareResult = { status: 200, body: { run_id: '00000000-0000-4000-8000-00000000000a', run_status: 'completed', suggested: 2, needs_judgment: 0, failed: 0, in_progress: 0 } },
  prepareThrows = false } = {}) {
  const events = [];
  const handler = createScheduledPrepareHandler({
    env: (key) => ({ SUPABASE_URL: 'https://synthetic.supabase.co', CODING_PREP_BACKGROUND_ENABLED: enabled })[key],
    verifyIdentity: (value, aud) => verifySchedulerIdentity(value, aud, keys.publicKey),
    createDb: () => { events.push(['db']); return { rpc: async (name, args) => { events.push(['rpc', name, args]);
      return discoveryFails ? { data: null, error: { message: 'down' } } : { data: work, error: null }; } }; },
    prepare: async (db, request) => { events.push(['prepare', request]); if (prepareThrows) throw new Error('gateway'); return prepareResult; },
  });
  return { events, request: (body = { trigger: 'background' }, identity = token) => handler(new Request(audience, { method: 'POST',
    headers: { 'x-silo-scheduler-token': identity }, body: JSON.stringify(body) })) };
}

test('nothing is read or spent before the identity, the switch and the request shape all pass', async () => {
  for (const bad of ['', 'not-a-token', await signed({ workflow_ref: 'BBISMblockay/financehub/.github/workflows/other.yml@refs/heads/main' })]) {
    const f = fixture(); assert.equal((await f.request(undefined, bad)).status, 401); assert.equal(f.events.length, 0);
  }
  const off = fixture({ enabled: 'false' }); assert.equal((await off.request()).status, 403); assert.equal(off.events.length, 0);
  // The caller may name a cursor and a trigger. It may not name a company,
  // rows, an action, or a retry of dismissed work.
  for (const body of [{}, { trigger: 'manual' }, { trigger: 'background', company_id: COMPANY },
    { trigger: 'background', transaction_ids: [txn(1)] }, { trigger: 'background', retry: true },
    { trigger: 'background', after: 'x' }, { trigger: 'background', batch: 'x' }, [], null]) {
    const f = fixture(); assert.equal((await f.request(body)).status, 400, JSON.stringify(body)); assert.equal(f.events.length, 0);
  }
});

test('one import per call: the database picks the work, and the service gets an explicit scope and no person', async () => {
  const f = fixture();
  const response = await f.request({ trigger: 'nightly', after: AFTER });
  const body = await response.json();
  assert.equal(response.status, 200);
  const rpc = f.events.find((e) => e[0] === 'rpc');
  assert.deepEqual(rpc, ['rpc', 'next_card_coding_work', { p_after: AFTER, p_batch: null, p_limit: ROWS_PER_INVOCATION }]);
  const [, request] = f.events.find((e) => e[0] === 'prepare');
  assert.deepEqual(request, { companyId: COMPANY, batchId: BATCH, transactionIds: [txn(1), txn(2)],
    trigger: 'nightly', requestedBy: null, retry: false, skipIneligible: true });
  assert.deepEqual(body, { done: false, batch_id: BATCH, ok: true, status: 200, run_id: '00000000-0000-4000-8000-00000000000a',
    run_status: 'completed', suggested: 2, needs_judgment: 0, failed: 0, in_progress: 0, asked: 2, remaining: 3 });
  assert.ok(ROWS_PER_INVOCATION <= 160, 'one invocation stays within one concurrent wave of model calls');
});

test('no work left ends the pass; a work unit that breaks the cursor is refused', async () => {
  const done = fixture({ work: null });
  assert.deepEqual(await (await done.request()).json(), { done: true });
  assert.equal(done.events.some((e) => e[0] === 'prepare'), false);
  const backwards = fixture({ work: { batch_id: AFTER, company_entity_id: COMPANY, transaction_ids: [txn(1)], remaining: 0 } });
  assert.equal((await backwards.request({ trigger: 'background', after: BATCH })).status, 503);
  const wrongBatch = fixture();
  assert.equal((await wrongBatch.request({ trigger: 'background', batch: AFTER })).status, 503);
  const down = fixture({ discoveryFails: true });
  assert.equal((await down.request()).status, 503);
});

test('a failed or unconfirmed preparation is reported as such, never as progress', async () => {
  const failed = fixture({ prepareResult: { status: 200, body: { run_status: 'failed', failed: 2 } } });
  const a = await (await failed.request()).json();
  assert.equal(a.ok, false); assert.equal(a.error_code, 'preparation_failed'); assert.equal(a.failed, 2);
  const refused = fixture({ prepareResult: { status: 409, body: { error: 'Reopen the batch' } } });
  const b = await (await refused.request()).json();
  assert.equal(b.ok, false); assert.equal(b.status, 409);
  const thrown = fixture({ prepareThrows: true });
  const c = await (await thrown.request()).json();
  assert.equal(c.ok, false); assert.equal(c.status, 'unconfirmed'); assert.equal(c.error_code, 'preparation_unconfirmed');
});
