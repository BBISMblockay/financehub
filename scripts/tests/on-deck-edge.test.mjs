import assert from 'node:assert/strict';
import { createHandler } from '../../supabase/functions/on-deck-prepare/handler.mjs';
import { prepareViaEdge } from '../on-deck-prepare.mjs';
const id = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const proposal = { id, version: 3, kind: 'launch', company_entity_id: 'company-a', source: { title: 'Fall' } };
const draft = { recommend: true, subject: 'Fall', summary: '', body: 'For baseball days.', reason: 'Upcoming launch', missing: [], tasks: [{ title: 'Review copy', detail: 'Review before publishing' }] };
const input = { proposal_id: id, version: 3, request_id: requestId };
const request = (body = input, token = 'service-test') => new Request('https://example.test/functions/v1/on-deck-prepare', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function fixture({ cap = false, missing = false, network = false, settlement = false, apiKey = 'edge-only-key', credit = null } = {}) {
  const calls = [], claims = new Set(), creditCalls = []; let paid = 0, reads = 0;
  const db = {
    from(table) {
      assert.equal(table, 'on_deck_proposals'); const filters = [];
      return { select() { return this; }, eq(k,v) { filters.push([k,v]); return this; }, async maybeSingle() { reads++; assert.deepEqual(filters, [['id', id], ['version', 3]]); return { data: missing ? null : proposal }; } };
    },
    async rpc(name, args) {
      // Customer AI credit RPCs are recorded apart; with no `credit` script
      // they answer as a database the credit migration has not reached (off).
      if (name.startsWith('ai_credit_')) {
        creditCalls.push({ name, args });
        if (!credit) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        return { data: credit(name, args), error: null };
      }
      calls.push({ name, args });
      if (name === 'on_deck_reserve') {
        assert.equal(args.p_version, 3); assert.equal(args.p_id, id);
        if (cap) return { data: { claimed: false, reason: 'budget_cap' } };
        if (claims.has(args.p_request)) return { data: { claimed: false, state: 'succeeded' } };
        claims.add(args.p_request); return { data: { claimed: true } };
      }
      assert.equal(name, 'on_deck_finish');
      return settlement ? { error: { message: 'private diagnostic' } } : { data: null };
    },
  };
  const handler = createHandler({ createDb: () => db, serviceKey: 'service-test', apiKey, fetcher: async (url, options) => {
    paid++; assert.equal(calls.at(-1).name, 'on_deck_reserve'); assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.headers['x-api-key'], 'edge-only-key');
    const body = JSON.parse(options.body); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 4000);
    assert.match(body.messages[0].content, /Fall/);
    if (network) throw Error('private provider diagnostic');
    return new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify(draft) }] }));
  } });
  return { handler, db, calls, creditCalls, paid: () => paid, reads: () => reads };
}
let checks = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
await test('unauthenticated, anon and normal-user callers cannot read or spend', async () => {
  const f = fixture(); for (const key of ['', 'anon', 'user-jwt', 'service-tesx']) assert.equal((await f.handler(request(input, key))).status, 401);
  assert.equal(f.reads(), 0); assert.equal(f.paid(), 0);
});
await test('missing server credential fails closed before database or provider', async () => {
  const f = fixture({ apiKey: '' }); assert.equal((await f.handler(request())).status, 503); assert.equal(f.reads(), 0);
  const h = createHandler({ createDb: () => { throw Error('must not read'); }, serviceKey: '', apiKey: 'present' });
  assert.equal((await h(request(input, ''))).status, 401);
});
await test('payload cannot supply prompts, another company, model or malformed identifiers', async () => {
  const f = fixture(); for (const body of [{ ...input, prompt: 'override' }, { ...input, company_id: 'b' }, { ...input, model: 'x' }, { ...input, version: -1 }, { ...input, request_id: 'invalid' }, 'bad-json']) assert.equal((await f.handler(request(body))).status, 400);
  assert.equal((await f.handler(request('x'.repeat(1025)))).status, 413); assert.equal(f.reads(), 0);
});
await test('non-POST requests do not start work', async () => { const f = fixture(); assert.equal((await f.handler(new Request('https://example.test'))).status, 405); assert.equal(f.paid(), 0); });
await test('version mismatch returns changed without spending', async () => { const f = fixture({ missing: true }); assert.deepEqual(await (await f.handler(request())).json(), { outcome: 'changed' }); assert.equal(f.paid(), 0); });
await test('database cap refuses paid work inside Edge', async () => { const f = fixture({ cap: true }); assert.deepEqual(await (await f.handler(request())).json(), { outcome: 'budget_cap' }); assert.equal(f.paid(), 0); });
await test('scheduler reaches Edge and returns only outcome; Edge reserves and settles once', async () => {
  const f = fixture(); const db = { functions: { invoke: async (slug, options) => { assert.equal(slug, 'on-deck-prepare'); assert.deepEqual(options.body, input); const response = await f.handler(request(options.body)); return { data: await response.json(), error: null }; } } };
  assert.equal(await prepareViaEdge({ db, proposal, requestId }), 'prepared');
  await prepareViaEdge({ db, proposal, requestId }); assert.equal(f.paid(), 1);
  assert.equal(f.calls.filter(c => c.name === 'on_deck_finish').length, 1); assert.deepEqual(f.calls[1].args.p_content, draft);
});
await test('provider uncertainty is settled as unknown, without a retry', async () => { const f = fixture({ network: true }); assert.deepEqual(await (await f.handler(request())).json(), { outcome: 'provider_outcome_unknown' }); assert.equal(f.paid(), 1); assert.equal(f.calls[1].args.p_input, null); });
await test('settlement failure returns generic error and leaves reconciliation to the worker', async () => { const f = fixture({ settlement: true }); const r = await f.handler(request()); assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'preparation_failed' }); assert.equal(f.paid(), 1); });
await test('transport failure cannot be reported as prepared or retried automatically', async () => { let calls = 0; await assert.rejects(() => prepareViaEdge({ db: { functions: { invoke: async () => { calls++; return { error: { message: 'private' } }; } } }, proposal }), /edge_preparation_failed/); assert.equal(calls, 1); });
const meteredCredit = (open = { ok: true, mode: 'enforce', held_micros: 9000 }) => (name, args) =>
  name === 'ai_credit_open' ? open : { ok: true, outcome: args.p_outcome, enforced: true, charged_micros: args.p_outcome === 'succeeded' ? 900 : 0 };
await test('AI credit: an empty balance pauses preparation before the On Deck cap or the provider', async () => {
  const f = fixture({ credit: meteredCredit({ ok: false, mode: 'enforce', reason: 'insufficient_credit' }) });
  assert.deepEqual(await (await f.handler(request())).json(), { outcome: 'credit_exhausted' });
  assert.equal(f.paid(), 0); assert.equal(f.calls.length, 0, 'no On Deck attempt was reserved');
});
await test('AI credit: a prepared draft is charged once, with the provider usage, as on_deck', async () => {
  const f = fixture({ credit: meteredCredit() });
  assert.deepEqual(await (await f.handler(request())).json(), { outcome: 'prepared' });
  const [open, settle] = f.creditCalls;
  assert.equal(open.name, 'ai_credit_open'); assert.equal(open.args.p_feature, 'on_deck'); assert.equal(open.args.p_company, 'company-a');
  assert.equal(open.args.p_request, requestId); assert.equal(open.args.p_user, null); assert.equal(open.args.p_max_output, 4000);
  assert.equal(settle.name, 'ai_credit_settle'); assert.equal(settle.args.p_outcome, 'succeeded');
  assert.equal(settle.args.p_usage.input, 1000); assert.equal(settle.args.p_usage.output, 100);
  assert.equal(f.creditCalls.length, 2);
});
await test('AI credit: a provider failure is free to the customer', async () => {
  const f = fixture({ network: true, credit: meteredCredit() });
  await f.handler(request());
  assert.equal(f.creditCalls.at(-1).args.p_outcome, 'failed');
});
await test('AI credit: an On Deck cap refusal releases the credit hold', async () => {
  const f = fixture({ cap: true, credit: meteredCredit() });
  assert.deepEqual(await (await f.handler(request())).json(), { outcome: 'budget_cap' });
  assert.equal(f.creditCalls.at(-1).args.p_outcome, 'cancelled'); assert.equal(f.paid(), 0);
});
await test('AI credit: a failed settlement write is not charged', async () => {
  const f = fixture({ settlement: true, credit: meteredCredit() });
  assert.equal((await f.handler(request())).status, 503);
  assert.equal(f.creditCalls.at(-1).args.p_outcome, 'failed');
});
await test('AI credit: the two copies of the credit library are identical', async () => {
  const { readFile } = await import('node:fs/promises');
  const a = await readFile(new URL('../../supabase/functions/silo-chat/ai-credit-lib.mjs', import.meta.url), 'utf8');
  const b = await readFile(new URL('../../supabase/functions/on-deck-prepare/ai-credit-lib.mjs', import.meta.url), 'utf8');
  assert.equal(a, b, 'copy supabase/functions/silo-chat/ai-credit-lib.mjs to on-deck-prepare/');
});
console.log(`${checks} Edge checks passed`);
