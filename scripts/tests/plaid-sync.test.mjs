import assert from 'node:assert/strict';
import { runPlaidSync } from '../plaid-sync.mjs';

let calls = [];
const result = await runPlaidSync({ url: 'https://synthetic.supabase.co', serviceKey: 'synthetic-service',
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.redirect, 'error');
    if (url.pathname.startsWith('/rest/')) return Response.json([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
    const body = JSON.parse(init.body);
    assert.equal(body.action, 'sync_background');
    if (body.account_id === 'one') return Response.json({ batch_ids: [], exceptions: 2 });
    if (body.account_id === 'two') return Response.json({ error: 'synthetic' }, { status: 502 });
    return Response.json({}); // HTTP 200 without a committed result is a failure.
  },
});
assert.deepEqual([result.accounts, result.failed, result.exceptions], [3, 2, 2]);
assert.equal(calls.length, 4, 'one failed account does not skip the next account');
assert.match(calls[0].url, /source_id=not.is.null/);
assert.match(calls[0].url, /plaid_connections.status=eq.active/);
assert.ok(calls.every(call => !/approve|quickbooks/.test(call.url)));

let pages = 0;
const paged = await runPlaidSync({ url: 'https://synthetic.supabase.co', serviceKey: 'synthetic-service',
  fetchImpl: async (url) => {
    if (url.pathname.startsWith('/rest/')) {
      pages++;
      if (pages === 1) return Response.json(Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, '0') })));
      assert.equal(url.searchParams.get('id'), 'gt.099');
      return Response.json([{ id: '100' }]);
    }
    return Response.json({ batch_ids: [], exceptions: 0 });
  },
});
assert.equal(paged.accounts, 101);
assert.equal(pages, 2);
await assert.rejects(runPlaidSync({ url: 'https://synthetic.supabase.co', serviceKey: 'synthetic',
  fetchImpl: async () => new Response('secret provider payload', { status: 500 }) }), /Account discovery failed \(500\)/);
await assert.rejects(runPlaidSync({ url: 'http://synthetic.supabase.co', serviceKey: 'synthetic' }), /Invalid Supabase URL/);
await assert.rejects(runPlaidSync({ url: 'https://synthetic.supabase.co', serviceKey: '' }), /Missing Supabase service key/);
console.log('Plaid scheduler: partial failures, response validation, pagination, authorization scope and safe errors passed');
