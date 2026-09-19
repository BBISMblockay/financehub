import assert from 'node:assert/strict';
import { createHandler, sanitizeExtraction, MAX_FILE_BYTES } from './handler.mjs';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
const facts = { document_count: 1, vendor_name: 'Northline', invoice_number: '1048', amount_due: 2580, invoice_total: 2580, due_date: '2026-10-18', currency: 'USD', request_type: 'inventory_freight', location_name: null, po_references: ['PO-329', 'PO-330'], warnings: [] };
const body = () => ({ company_id: 'company-a', media_type: 'application/pdf', data: btoa('%PDF-test') });
function fixture(options = {}) {
  let calls = 0, lastRequest;
  const handler = createHandler({
    env: key => key === 'ANTHROPIC_API_KEY' && options.noKey ? '' : key,
    makeClient: () => ({ auth: { getUser: async () => ({ data: { user: options.noUser ? null : { id: 'user-a' } } }) },
      from(table) { return { select() { return this; }, eq() { return this; }, async single() { return { data: { is_active: !options.inactive, active_company_id: 'company-a' } }; }, async maybeSingle() { return { data: options.noMembership ? null : { entity_id: 'company-a' } }; } }; },
    }),
    inspectPdf: async () => { if (options.badPdf) throw Error('encrypted'); return options.pages ?? 2; },
    fetchImpl: async (url, init) => {
      calls++; lastRequest = JSON.parse(init.body);
      if (options.providerError) return new Response('error', { status: 503 });
      if (options.invalidJson) return new Response('not JSON');
      return Response.json({ stop_reason: options.truncated ? 'max_tokens' : 'tool_use', content: [{ type: 'tool_use', name: 'extract_payment_request', input: options.facts || facts }] });
    },
  });
  const call = (data = body(), auth = 'Bearer test') => handler(new Request('https://example.invalid', { method: 'POST', headers: auth ? { authorization: auth } : {}, body: JSON.stringify(data) }));
  return { call, get calls() { return calls; }, get lastRequest() { return lastRequest; } };
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
await test('rejects oversized, disguised and invalid documents before provider call', async () => {
  for (const doc of [{ ...body(), data: btoa('<html>not a PDF</html>') }, { ...body(), data: '?' }, { ...body(), data: 'A'.repeat(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) }, { ...body(), media_type: 'text/html' }]) {
    const f = fixture(); assert.ok((await f.call(doc)).status >= 400); assert.equal(f.calls, 0);
  }
});
await test('encrypted, invalid, empty and overlong PDFs are refused', async () => {
  for (const options of [{ badPdf: true }, { pages: 0 }, { pages: 11 }]) { const f = fixture(options); assert.equal((await f.call()).status, 422); assert.equal(f.calls, 0); }
});
await test('unavailable model and incomplete responses never look successful', async () => {
  for (const options of [{ noKey: true }, { providerError: true }, { truncated: true }, { invalidJson: true }]) { const f = fixture(options); assert.ok((await f.call()).status >= 400); }
});
await test('real handler supplies document blocks and forces extraction-only output', async () => {
  const f = fixture(); const r = await f.call(); assert.equal(r.status, 200);
  const data = await r.json(); assert.equal(data.company_id, 'company-a'); assert.equal(data.suggestion.amount_due, 2580);
  assert.equal(f.lastRequest.messages[0].content[0].type, 'document'); assert.equal(f.lastRequest.tool_choice.name, 'extract_payment_request'); assert.equal(f.lastRequest.tools.length, 1);
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
console.log(`${passed} extraction handler checks passed.`);
