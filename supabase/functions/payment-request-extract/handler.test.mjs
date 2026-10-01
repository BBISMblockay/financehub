import assert from 'node:assert/strict';
import { createHandler, sanitizeExtraction, MAX_TEXT } from './handler.mjs';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
const facts = { document_count: 1, vendor_name: 'Northline', invoice_number: '1048', amount_due: 2580, invoice_total: 2580, due_date: '2026-10-18', currency: 'USD', request_type: 'inventory_freight', location_name: null, po_references: ['PO-329', 'PO-330'], warnings: [] };
const body = () => ({ company_id: 'company-a', consent: true, text: 'Vendor: Northline\nInvoice #: 1048\nAmount due: USD 2580.00' });
function fixture(options = {}) {
  let calls = 0, lastRequest; const credit = [];
  const creditDb = options.credit && { rpc: async (name, args) => {
    credit.push({ name, args });
    const answer = options.credit[name];
    return typeof answer === 'function' ? answer(args) : (answer || { data: null, error: { code: 'XX000', message: 'unexpected' } });
  } };
  const handler = createHandler({
    makeCreditClient: () => creditDb || null, newRequestId: () => 'req-1',
    env: key => key === 'ANTHROPIC_API_KEY' && options.noKey ? '' : key,
    makeClient: () => ({ auth: { getUser: async () => ({ data: { user: options.noUser ? null : { id: 'user-a' } } }) },
      from(table) { return { select() { return this; }, eq() { return this; }, async single() { return { data: { is_active: !options.inactive, active_company_id: 'company-a' } }; }, async maybeSingle() { return { data: options.noMembership ? null : { entity_id: 'company-a' } }; } }; },
    }),
    fetchImpl: async (url, init) => {
      calls++; lastRequest = JSON.parse(init.body);
      if (options.timeout) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      if (options.providerError) return new Response('error', { status: 503 });
      if (options.invalidJson) return new Response('not JSON');
      return Response.json({ usage: { input_tokens: 900, output_tokens: 120 }, stop_reason: options.truncated ? 'max_tokens' : 'tool_use', content: [{ type: 'tool_use', name: 'extract_payment_request', input: options.facts || facts }] });
    },
  });
  const call = (data = body(), auth = 'Bearer test') => handler(new Request('https://example.invalid', { method: 'POST', headers: auth ? { authorization: auth } : {}, body: JSON.stringify(data) }));
  return { call, credit, get calls() { return calls; }, get lastRequest() { return lastRequest; } };
}
await test('requires authenticated active company membership before provider call', async () => {
  for (const options of [{ noUser: true }, { inactive: true }, { noMembership: true }]) {
    const f = fixture(options); assert.ok((await f.call()).status >= 400); assert.equal(f.calls, 0);
  }
  const f = fixture(); assert.equal((await f.call(body(), '')).status, 401); assert.equal(f.calls, 0);
});
await test('a caller cannot request extraction in another active company', async () => {
  const f = fixture(); assert.equal((await f.call({ ...body(), company_id: 'company-b' })).status, 409); assert.equal(f.calls, 0);
});
await test('refuses raw documents, missing consent and invalid text before the provider', async () => {
  for (const extra of [{ data: 'base64' }, { media_type: 'application/pdf' }, { url: 'https://example.com' }, { consent: false }, { consent: undefined }, { text: '' }, { text: 123 }, { text: 'A'.repeat(MAX_TEXT + 1) }]) {
    const f = fixture(); assert.ok((await f.call({ ...body(), ...extra })).status >= 400); assert.equal(f.calls, 0);
  }
});
await test('unavailable model and incomplete responses never look successful', async () => {
  for (const options of [{ noKey: true }, { providerError: true }, { truncated: true }, { invalidJson: true }]) { const f = fixture(options); assert.ok((await f.call()).status >= 400); }
});
await test('real handler sends bounded text only and forces suggestion-only output', async () => {
  const f = fixture(); const r = await f.call(); assert.equal(r.status, 200);
  const data = await r.json(); assert.equal(data.company_id, 'company-a'); assert.equal(data.suggestion.amount_due, 2580);
  assert.equal(f.lastRequest.messages[0].content.length, 1); assert.equal(f.lastRequest.messages[0].content[0].type, 'text'); assert.ok(f.lastRequest.messages[0].content[0].text.includes(body().text)); assert.equal(f.lastRequest.messages[0].content[0].source, undefined); assert.equal(f.lastRequest.tool_choice.name, 'extract_payment_request'); assert.equal(f.lastRequest.tools.length, 1);
});
await test('negative/string money, impossible dates and injected fields cannot pass', () => {
  const data = sanitizeExtraction({ ...facts, amount_due: -10, invoice_total: '2,580', due_date: '2026-02-30', workflow_status: 'approved', bank_account: 'secret', request_type: 'payroll_payment' });
  assert.equal(data.amount_due, null); assert.equal(data.invoice_total, null); assert.equal(data.due_date, null); assert.equal(data.workflow_status, undefined); assert.equal(data.bank_account, undefined); assert.equal(data.request_type, null);
  assert.equal(sanitizeExtraction({ ...facts, amount_due: 0 }).amount_due, 0);
});
await test('multiple invoices cannot be silently aggregated', async () => {
  const f = fixture({ facts: { ...facts, document_count: 2 } }); assert.equal((await f.call()).status, 422);
});
await test('unknown currency is explicitly flagged and never defaults to USD', () => {
  const data = sanitizeExtraction({ ...facts, currency: '$' }); assert.equal(data.currency, null); assert.match(data.warnings.join(' '), /Currency/);
});
// AI credit (docs/ops/ai-credits.md). The database decides; the handler holds
// before the model call, charges a usable suggestion, and settles everything
// else free.
const metered = (over = {}) => ({
  ai_credit_open: { data: { ok: true, mode: 'enforce', held_micros: 50000 } },
  ai_credit_settle: (args) => ({ data: { ok: true, enforced: true, outcome: args.p_outcome, charged_micros: args.p_outcome === 'succeeded' ? 12000 : 0 } }),
  ...over,
});
await test('credit: a usable suggestion is held first, then charged on measured usage', async () => {
  const f = fixture({ credit: metered() }); const r = await f.call(); const data = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(f.credit.map(c => c.name), ['ai_credit_open', 'ai_credit_settle']);
  const open = f.credit[0].args;
  assert.equal(open.p_feature, 'payment_request_extract'); assert.equal(open.p_company, 'company-a'); assert.equal(open.p_user, 'user-a');
  assert.equal(open.p_max_output, 1800); assert.ok(open.p_est_input > 0);
  assert.equal(f.credit[1].args.p_outcome, 'succeeded'); assert.equal(f.credit[1].args.p_usage.input, 900); assert.equal(f.credit[1].args.p_usage.output, 120);
  assert.deepEqual(data.ai_credit, { status: 'charged', charged_micros: 12000 });
});
await test('credit: an empty balance refuses BEFORE the model is called', async () => {
  const f = fixture({ credit: metered({ ai_credit_open: { data: { ok: false, mode: 'enforce', reason: 'insufficient_credit' } } }) });
  const r = await f.call(); assert.equal(r.status, 402); assert.equal((await r.json()).credit_exhausted, true);
  assert.equal(f.calls, 0); assert.equal(f.credit.length, 1);
});
await test('credit: an unreadable balance refuses without calling the model', async () => {
  const f = fixture({ credit: metered({ ai_credit_open: { data: null, error: { code: '08006', message: 'connection lost' } } }) });
  assert.equal((await f.call()).status, 503); assert.equal(f.calls, 0);
});
await test('credit: provider errors, truncation, timeouts and multi-invoice refusals are free', async () => {
  for (const [options, outcome] of [[{ providerError: true }, 'failed'], [{ truncated: true }, 'failed'], [{ invalidJson: true }, 'failed'], [{ timeout: true }, 'timed_out'], [{ facts: { ...facts, document_count: 2 } }, 'failed']]) {
    const f = fixture({ ...options, credit: metered() }); assert.ok((await f.call()).status >= 400);
    const settles = f.credit.filter(c => c.name === 'ai_credit_settle');
    assert.equal(settles.length, 1, 'settled exactly once'); assert.equal(settles[0].args.p_outcome, outcome);
  }
});
await test('credit: a read that accepted no fact is free, and keeps its measured usage', async () => {
  const empty = { document_count: 1, vendor_name: null, invoice_number: null, amount_due: null, invoice_total: null, due_date: null, currency: null, request_type: null, location_name: null, po_references: [], warnings: ['The source text was unreadable.'] };
  const rejected = { ...empty, vendor_name: '', amount_due: -10, invoice_total: '2,580', due_date: '2026-02-30', currency: '$', request_type: 'payroll_payment' };
  for (const facts of [empty, rejected]) {
    const f = fixture({ facts, credit: metered() }); const r = await f.call(); const data = await r.json();
    assert.equal(r.status, 200, 'the page still gets the (empty) suggestion and its warnings');
    const settle = f.credit.find(c => c.name === 'ai_credit_settle').args;
    assert.equal(settle.p_outcome, 'failed'); assert.equal(settle.p_error, 'no_usable_fields');
    assert.equal(settle.p_usage.input, 900, 'provider cost is still recorded'); assert.equal(settle.p_usage.output, 120);
    assert.deepEqual(data.ai_credit, { status: 'free', charged_micros: 0 });
  }
  // One accepted fact is enough to be a usable read.
  const one = fixture({ facts: { ...empty, po_references: ['PO-1'] }, credit: metered() }); await one.call();
  assert.equal(one.credit.find(c => c.name === 'ai_credit_settle').args.p_outcome, 'succeeded');
});
await test('credit: not migrated or no service key = unmetered, exactly as before', async () => {
  const missing = fixture({ credit: { ai_credit_open: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } } });
  const r = await missing.call(); assert.equal(r.status, 200); assert.deepEqual((await r.json()).ai_credit, { status: 'not_metered' });
  assert.equal(missing.credit.length, 1, 'no settle without a hold');
  const none = fixture(); assert.equal((await none.call()).status, 200);
});
await test('credit: the three copies of the credit library are identical', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = d => readFile(new URL(`../${d}/ai-credit-lib.mjs`, import.meta.url), 'utf8');
  const mine = await read('payment-request-extract');
  assert.equal(mine, await read('silo-chat')); assert.equal(mine, await read('on-deck-prepare'));
});
console.log(`${passed} extraction handler checks passed.`);
