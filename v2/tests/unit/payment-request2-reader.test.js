const assert = require('node:assert/strict');
(async () => {
  const { suggestFromText, readLocally, interpretMissing, MAX_TEXT, textFromPdfItems } = await import('../../payment-request2-reader.js');
  const { FIELD_NAMES, applySuggestions, validateFields, clearSourceSuggestions } = await import('../../payment-request2-core.js');
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
  const text = 'Vendor: Example Supply\nInvoice #: INV-1042\nAmount due: USD 250.00\nInvoice total: USD 1000.00\nDue date: 2026-10-15\nPO #: PO-2041';
  const file = (name = 'invoice.pdf') => ({ name, blob: new Blob(['test fixture']) });
  function fixture(pages) {
    const state = { ocr: 0, destroyed: 0, cleaned: 0, rendered: 0 };
    return { state, io: { async openPdf() { return { numPages: pages.length, async getPage(n) { const p = pages[n - 1]; return { async getTextContent() { return { items: [{ str: p.text || '', hasEOL: true }] }; }, async hasImages() { return !!p.image; }, async image() { state.rendered++; return p.ocr; }, cleanup() { state.cleaned++; } }; }, async destroy() { state.destroyed++; } }; }, async recognize(input) { state.ocr++; return typeof input === 'string' ? input : text; } } };
  }
  await test('labels keep partial amount due separate from invoice total and PO', () => {
    const { suggestion: s } = suggestFromText(text); assert.equal(s.amount_due, 250); assert.equal(s.invoice_total, 1000); assert.equal(s.currency, 'USD'); assert.equal(s.vendor_name, 'Example Supply'); assert.equal(s.invoice_number, 'INV-1042'); assert.deepEqual(s.po_references, ['PO-2041']); assert.equal(s.due_date, '2026-10-15'); assert.equal(s.request_type, null);
  });
  await test('PDF labels on adjacent lines still produce explicit suggestions', () => {
    const s = suggestFromText('Vendor:\nExample Supply\nInvoice #\nINV-9\nAmount due\nUSD 12.00').suggestion;
    assert.equal(s.vendor_name, 'Example Supply'); assert.equal(s.invoice_number, 'INV-9'); assert.equal(s.amount_due, 12);
  });
  await test('bare-dollar local read preserves USD through fill-empty and validation', async () => {
    const f = fixture([{ text: text.replaceAll('USD ', '$') }]);
    const local = await readLocally(file(), f.io);
    assert.equal(local.suggestion.currency, null);
    const draftFields = Object.fromEntries(FIELD_NAMES.map(k => [k, '']));
    Object.assign(draftFields, { currency: 'USD', request_type: 'invoice_vendor_payment', requester_email: 'test@example.invalid' });
    const result = applySuggestions(draftFields, local.suggestion);
    assert.equal(result.fields.currency, 'USD'); assert.equal(result.applied.currency, undefined);
    validateFields(result.fields, true);
    assert.equal(clearSourceSuggestions(result.fields, result.applied).currency, 'USD');
    assert.equal(applySuggestions({ currency: '' }, { currency: 'USD' }).applied.currency, 'USD');
    assert.equal(applySuggestions({ currency: '' }, { currency: null }).fields.currency, '');
    assert.equal(applySuggestions({ currency: '' }, { currency: 'OTHER' }).applied.currency, undefined);
    assert.equal(applySuggestions({ currency: 'USD' }, { currency: 'CAD' }).fields.currency, 'USD');
  });
  await test('digital invoice logo never requires OCR when embedded payment details are available', async () => {
    const f = fixture([{ text, image: true }]); f.io.recognize = async () => { throw Error('OCR assets blocked'); };
    const r = await readLocally(file(), f.io); assert.equal(r.suggestion.amount_due, 250); assert.equal(r.suggestion.invoice_number, 'INV-1042'); assert.equal(r.method, 'pdf-text'); assert.equal(f.state.rendered, 0);
  });
  await test('supplemental OCR failure preserves usable embedded text', async () => {
    const f = fixture([{ text: 'Invoice #: INV-1042', image: true }]); f.io.recognize = async () => { throw Error('OCR assets blocked'); };
    const r = await readLocally(file(), f.io); assert.equal(r.suggestion.invoice_number, 'INV-1042'); assert.equal(r.suggestion.amount_due, null); assert.match(r.suggestion.warnings.join(' '), /could not be read/); assert.match(r.text, /INV-1042/);
  });
  await test('OCR fills missing fields without replacing accurate embedded amounts', async () => {
    const f = fixture([{ text: 'Amount due: USD 250.00', image: true, ocr: text.replace('250.00', '999.00') }]);
    const r = await readLocally(file(), f.io); assert.equal(r.suggestion.amount_due, 250); assert.equal(r.suggestion.invoice_number, 'INV-1042'); assert.match(r.suggestion.warnings.join(' '), /embedded PDF value was kept/);
  });
  await test('supplemental OCR cannot resolve conflicting embedded amounts silently', async () => {
    const f = fixture([{ text: 'Amount due: USD 250.00\nBalance due: USD 500.00', image: true, ocr: text }]);
    const r = await readLocally(file(), f.io); assert.equal(r.suggestion.amount_due, null); assert.match(r.suggestion.warnings.join(' '), /unclear or conflicting/);
  });
  await test('different invoices across embedded and scanned pages still suppress suggestions', async () => {
    const f = fixture([{ text }, { text: '', image: true, ocr: text.replace('INV-1042', 'INV-1043') }]);
    const r = await readLocally(file(), f.io); assert.equal(r.multipleInvoices, true); assert.equal(r.suggestion.amount_due, null);
  });
  await test('total alone, negatives, European numbers and conflicting amounts remain unresolved', () => {
    assert.equal(suggestFromText('Total: USD 500.00').suggestion.amount_due, null);
    for (const value of ['-12.00', '(12.00)', '1.234,56', '12.345', '12,34', '1e4']) assert.equal(suggestFromText('Amount due: ' + value).suggestion.amount_due, null);
    assert.equal(suggestFromText('Amount due: 12.00\nBalance due: 24.00').suggestion.amount_due, null);
    assert.equal(suggestFromText('Amount due: 0.00').suggestion.amount_due, 0);
  });
  await test('bare dollar signs and ambiguous dates never become USD or assumed dates', () => {
    const s = suggestFromText('Amount due: $12.00\nDue date: 10/11/2026').suggestion; assert.equal(s.currency, null); assert.equal(s.due_date, null);
    assert.equal(suggestFromText('Currency USD and CAD').suggestion.currency, null);
  });
  await test('multiple invoice numbers suppress all payment suggestions', () => {
    const r = suggestFromText(text + '\nInvoice #: INV-1043'); assert.equal(r.multipleInvoices, true); assert.equal(r.suggestion.amount_due, null); assert.equal(r.suggestion.vendor_name, null); assert.deepEqual(r.evidence, {});
  });
  await test('PDF line changes preserve labels and values', () => {
    const result = textFromPdfItems([{ str: 'Amount due:', transform: [0,0,0,0,0,100] }, { str: 'USD 250.00', transform: [0,0,0,0,0,100] }, { str: 'Invoice #: A', transform: [0,0,0,0,0,80] }]); assert.equal(suggestFromText(result).suggestion.amount_due, 250);
  });
  await test('digital PDF reads text without OCR or a provider', async () => {
    const f = fixture([{ text }]); const r = await readLocally(file(), f.io); assert.equal(r.method, 'pdf-text'); assert.equal(r.suggestion.amount_due, 250); assert.equal(f.state.ocr, 0); assert.equal(f.state.rendered, 0); assert.equal(f.state.destroyed, 1);
  });
  await test('scan and mixed image/text pages use OCR with cleanup', async () => {
    for (const embedded of ['', 'Header only with enough embedded text to look like a complete document']) {
      const f = fixture([{ text: embedded, image: true, ocr: text }]); const r = await readLocally(file(), f.io); assert.equal(r.method, 'ocr'); assert.equal(r.suggestion.amount_due, 250); assert.equal(f.state.ocr, 1); assert.equal(f.state.cleaned, 1); assert.equal(f.state.destroyed, 1);
    }
  });
  await test('images use OCR directly without opening a PDF', async () => {
    const f = fixture([]); f.io.openPdf = () => { throw Error('must not open'); }; const r = await readLocally(file('receipt.png'), f.io); assert.equal(r.suggestion.amount_due, 250); assert.equal(f.state.ocr, 1);
  });
  await test('oversize, page bounds, empty text, cancellation and read errors fail safely', async () => {
    const f = fixture(Array(11).fill({ text })); await assert.rejects(readLocally(file(), f.io), /10 pages/); assert.equal(f.state.destroyed, 1);
    await assert.rejects(readLocally({ name: 'a.pdf', blob: { size: 5 * 1024 * 1024 } }, f.io), /4 MB/);
    const long = fixture([{ text: 'A'.repeat(MAX_TEXT + 1) }]); await assert.rejects(readLocally(file(), long.io), /too much text/); assert.equal(long.state.destroyed, 1);
    const empty = fixture([{ text: '', ocr: '' }]); await assert.rejects(readLocally(file(), empty.io), /No readable text/);
    const control = new AbortController(); control.abort(); await assert.rejects(readLocally(file(), { ...f.io, signal: control.signal }), /stopped/);
    const bad = fixture([{ image: true }]); bad.io.recognize = async () => { throw Error('OCR failure'); }; await assert.rejects(readLocally(file(), bad.io), /OCR failure/); assert.equal(bad.state.destroyed, 1);
  });
  await test('AI never runs without consent; explicit assistance sends only text', async () => {
    const read = { ...suggestFromText(text), text }; let calls = 0;
    const options = { companyId: 'company-a', invoke: async (name, request) => { calls++; assert.equal(name, 'payment-request-extract'); assert.deepEqual(request.body, { company_id: 'company-a', text, consent: true }); return { data: { company_id: 'company-a', suggestion: { vendor_name: 'WRONG AI VENDOR', amount_due: 999, request_type: 'inventory_freight' } } }; } };
    await assert.rejects(interpretMissing(read, options), /Choose AI/); assert.equal(calls, 0);
    const s = await interpretMissing(read, { ...options, consent: true }); assert.equal(calls, 1); assert.equal(s.vendor_name, 'Example Supply'); assert.equal(s.amount_due, 250); assert.equal(s.request_type, 'inventory_freight');
  });
  await test('unavailable AI preserves locally extracted results; mixed invoices never invoke it', async () => {
    const read = { ...suggestFromText(text), text }; const before = structuredClone(read);
    await assert.rejects(interpretMissing(read, { consent: true, companyId: 'a', invoke: async () => ({ error: Error('not deployed') }) }), /locally read/); assert.deepEqual(read, before);
    await assert.rejects(interpretMissing({ ...read, multipleInvoices: true }, { consent: true, invoke: () => { throw Error('must not invoke'); } }), /single invoice/);
  });
  console.log(`${passed} local reading checks passed.`);
})().catch(error => { console.error(error); process.exit(1); });
