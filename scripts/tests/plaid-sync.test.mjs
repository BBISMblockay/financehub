import assert from 'node:assert/strict';
import { runPlaidSync, githubIdentityToken } from '../plaid-sync.mjs';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let calls = 0, tokens = 0;
const result = await runPlaidSync({ url: 'https://synthetic.supabase.co',
  getToken: async audience => { assert.equal(audience, 'https://synthetic.supabase.co/functions/v1/plaid-scheduled-sync'); return `token-${++tokens}`; },
  fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.pathname, '/functions/v1/plaid-scheduled-sync');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Content-Type', 'x-silo-scheduler-token']);
    assert.equal(init.headers['x-silo-scheduler-token'], `token-${calls}`);
    assert.deepEqual(JSON.parse(init.body), { after: calls === 1 ? null : id(calls - 1) });
    if (calls === 102) return Response.json({ done: true });
    return Response.json({ done: false, account_id: id(calls), ok: calls !== 2,
      status: calls === 2 ? 502 : 200, exceptions: calls === 1 ? 2 : 0,
      error_code: 'private-provider-message' });
  },
});
assert.deepEqual([result.accounts, result.failed, result.exceptions, tokens], [101, 1, 2, 102]);
assert.doesNotMatch(JSON.stringify(result), /private-provider-message|token-/);
for (const body of [{ done: false }, { done: false, account_id: id(1), ok: true, status: 500, exceptions: 0 }]) {
  await assert.rejects(runPlaidSync({ url: 'https://synthetic.supabase.co', getToken: async () => 'token',
    fetchImpl: async () => Response.json(body) }), /Invalid scheduled sync response/);
}
await assert.rejects(runPlaidSync({ url: 'https://synthetic.supabase.co', getToken: async () => 'token',
  fetchImpl: async () => Response.json({ done: false, account_id: id(1), ok: true, status: 200, exceptions: 0 }) }), /Invalid scheduled sync response/);
await assert.rejects(runPlaidSync({ url: 'https://synthetic.supabase.co', getToken: async () => 'token',
  fetchImpl: async () => Response.json({ error_code: 'private-data' }, { status: 403 }) }), /^Error: Scheduled sync rejected \(403\): request_failed$/);
await assert.rejects(runPlaidSync({ url: 'https://synthetic.supabase.co', getToken: async () => 'token',
  fetchImpl: async () => { throw new Error('secret-token'); } }), /^Error: Scheduled sync response unconfirmed/);
await assert.rejects(runPlaidSync({ url: 'http://synthetic.supabase.co' }), /Invalid Supabase URL/);
await assert.rejects(githubIdentityToken('aud', { env: {} }), /GitHub OIDC unavailable/);
assert.equal(await githubIdentityToken('audience', { env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://synthetic.actions.test/token?existing=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret' },
  fetchImpl: async (url, init) => {
    assert.equal(url.searchParams.get('audience'), 'audience');
    assert.equal(init.headers.Authorization, 'Bearer request-secret');
    assert.equal(init.redirect, 'error');
    return Response.json({ value: 'ephemeral-token' });
  } }), 'ephemeral-token');
console.log('Plaid scheduler: OIDC renewal, 101-account pagination, failures, cursor guards and safe output passed');
