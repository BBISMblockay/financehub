const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const core = await import(pathToFileURL(path.resolve(__dirname, '../../payment-request2-core.js')));
  const { submitRequest, safeInsertFailure, insertFailureMessage } = await import(pathToFileURL(path.resolve(__dirname, '../../payment-request2-submit.js')));
  let checks = 0;
  async function test(name, fn) { await fn(); checks++; console.log('PASS', name); }
  const fresh = () => ({ id: 'request-1', status: 'draft', reviewed: true, fields: { vendor_name: 'Northline Packaging', request_type: 'inventory_freight', amount_due: '2580.00', invoice_number: '1048', due_date: '2026-10-18', flex_id: 'F-19', requester_email: 'tester@example.com', location_name: 'Main warehouse', notes_comments: 'Two POs', currency: 'USD' }, poNames: ['PO-329', 'PO-330'], files: [{ id: 'file-1', name: 'invoice.pdf', type: 'application/pdf', blob: new Blob(['%PDF-test']) }] });
  function fixture(options = {}) {
    const state = { requests: new Map(), files: new Map(), objects: new Map(), insertAttempts: 0, receipts: 0, uploads: 0, checkpoints: [], contextCalls: 0 };
    const db = {
      from(table) {
        const filters = {};
        return {
          select() { return this; }, eq(k, v) { filters[k] = v; return this; },
          async maybeSingle() {
            if (options.readFailure) return { error: Error('network') };
            const rows = table === 'payment_requests' ? state.requests : state.files;
            return { data: [...rows.values()].find(r => Object.entries(filters).every(([k, v]) => r[k] === v)) || null };
          },
          async insert(row) {
            const rows = table === 'payment_requests' ? state.requests : state.files;
            if (table === 'payment_requests') state.insertAttempts++;
            if (options.metadataFailure && table === 'payment_request_files') return { error: Error('metadata failed') };
            if (rows.has(row.id)) return { error: { code: '23505' } };
            if (options.insertReject && table === 'payment_requests') return { error: Error('insert failed') };
            rows.set(row.id, { ...row });
            if (options.lostInsertResponse && table === 'payment_requests') return { error: Error('response lost') };
            return { error: null };
          },
        };
      },
      storage: { from() { return {
        async upload(key, blob) {
          state.uploads++;
          if (options.uploadFailure) return { error: Error('offline') };
          if (state.objects.has(key)) return { error: Error('exists') };
          state.objects.set(key, blob);
          return { error: options.lostUploadResponse ? Error('timeout') : null };
        },
        async download(key) { return { data: state.objects.get(key), error: !state.objects.has(key) ? Error('missing') : null }; },
      }; } },
      functions: { async invoke() { state.receipts++; if (options.receiptFailure) throw Error('timeout'); return { data: { ok: true } }; } },
    };
    const args = {
      db, userId: 'user-1', companyId: 'company-1',
      async assertContext() { state.contextCalls++; if (options.companyChanged) throw Error('company changed'); },
      async checkpoint(draft) { if (options.checkpointFailure) throw Error('draft conflict'); state.checkpoints.push(structuredClone(draft)); },
    };
    return { state, args, options };
  }
  await test('database insert failures remain visible and safe', async () => {
    const failure = safeInsertFailure({ code: '42501', message: ' new row\nviolates row-level security policy ', details: 'x'.repeat(300) });
    assert.deepEqual(failure, {
      code: '42501',
      message: 'new row violates row-level security policy',
      details: 'x'.repeat(180),
      hint: null,
    });
    assert.equal(insertFailureMessage(failure), 'Request was not created: new row violates row-level security policy [42501]');
  });
  await test('empty/negative/overprecise amounts are refused, zero remains zero', () => {
    for (const value of ['', ' ', null, undefined, '-1', '1.001', 'NaN', '1e4']) assert.equal(core.money(value), null);
    assert.equal(core.money('0'), 0); assert.equal(core.money('2580.00'), 2580);
    const d = fresh(); d.fields.amount_due = ''; assert.throws(() => core.requestPayload(d, 'u', 'c'), /amount/);
  });
  await test('six request types, PO links and existing fields survive the payload', () => {
    for (const type of Object.keys(core.REQUEST_TYPES)) { const d = fresh(); d.fields.request_type = type; const p = core.requestPayload(d, 'u', 'c'); assert.equal(p.request_type, type); assert.equal(p.internal_po_number, 'PO-329, PO-330'); assert.equal(p.flex_id, 'F-19'); assert.equal(p.workflow_status, 'new'); assert.equal(p.completed, false); }
  });
  await test('human review and USD are required', () => {
    const d = fresh(); d.reviewed = false; assert.throws(() => core.requestPayload(d, 'u', 'c'), /Review/);
    d.reviewed = true; d.fields.currency = 'CAD'; assert.throws(() => core.requestPayload(d, 'u', 'c'), /USD/);
  });
  await test('impossible dates are refused without throwing from date parsing', () => {
    assert.equal(core.validDate('2026-02-30'), false); assert.equal(core.validDate('2026-99-99'), false); assert.equal(core.validDate('2024-02-29'), true);
  });
  await test('suggestions preserve human edits and cannot supply approval fields', () => {
    const { fields, applied } = core.applySuggestions({ vendor_name: 'Human vendor', amount_due: '', due_date: '' }, { vendor_name: 'AI vendor', amount_due: 0, workflow_status: 'paid', id: 'evil', due_date: '2026-02-30' });
    assert.equal(fields.vendor_name, 'Human vendor'); assert.equal(fields.amount_due, '0'); assert.equal(fields.due_date, ''); assert.equal(fields.workflow_status, undefined); assert.equal(fields.id, undefined); assert.deepEqual(applied, { amount_due: '0' });
  });
  await test('switching source clears only unchanged auto-filled values', () => {
    assert.deepEqual(core.clearSourceSuggestions({ vendor_name: 'Edited', amount_due: '12' }, { vendor_name: 'Suggested', amount_due: '12' }), { vendor_name: 'Edited', amount_due: '' });
  });
  await test('duplicates include partial balances and ignore self/cancelled', () => {
    const d = fresh(); const rows = [
      { id: 'one', vendor_name: d.fields.vendor_name, invoice_number: '1048', amount_due: 100, workflow_status: 'new' },
      { id: 'two', vendor_name: d.fields.vendor_name, invoice_number: '1048', amount_due: 2580, workflow_status: 'cancelled' },
      { id: d.id, vendor_name: d.fields.vendor_name, invoice_number: '1048', amount_due: 2580, workflow_status: 'new' },
    ]; assert.deepEqual(core.duplicateMatches(rows, d.fields, d.id).map(r => r.id), ['one']);
  });
  await test('happy path writes one request, then attachment, then receipt', async () => {
    const { state, args } = fixture(); const d = fresh(); const result = await submitRequest({ ...args, draft: d });
    assert.equal(result.filesComplete, true); assert.equal(state.requests.size, 1); assert.equal(state.files.size, 1); assert.equal(state.receipts, 1); assert.equal(state.checkpoints[0].requestSaved, undefined); assert.ok(state.checkpoints[0].payload); assert.equal(d.status, 'submitted');
  });
  await test('lost insert response reconciles same ID and retry never reinserts', async () => {
    const { state, args } = fixture({ lostInsertResponse: true }); const d = fresh(); await submitRequest({ ...args, draft: d }); await submitRequest({ ...args, draft: d });
    assert.equal(state.insertAttempts, 1); assert.equal(state.requests.size, 1); assert.equal(state.files.size, 1); assert.equal(state.receipts, 1);
  });
  await test('failed insert stays frozen and retry uses the saved payload', async () => {
    const f = fixture({ insertReject: true }); const d = fresh(); await assert.rejects(submitRequest({ ...f.args, draft: d }), /Request was not created: insert failed/);
    assert.equal(d.lastSubmitError.message, 'insert failed');
    d.fields.amount_due = '1'; f.options.insertReject = false;
    await submitRequest({ ...f.args, draft: d }); assert.equal(f.state.requests.get(d.id).amount_due, 2580); assert.equal(f.state.requests.size, 1); assert.equal(d.lastSubmitError, undefined);
  });
  await test('upload failure preserves request and resumes attachments after reload', async () => {
    const f = fixture({ uploadFailure: true }); let d = fresh(); await assert.rejects(submitRequest({ ...f.args, draft: d }), /Request saved/);
    assert.equal(f.state.requests.size, 1); assert.equal(f.state.receipts, 0);
    d = structuredClone(f.state.checkpoints.at(-1)); f.options.uploadFailure = false;
    await submitRequest({ ...f.args, draft: d }); assert.equal(f.state.insertAttempts, 1); assert.equal(f.state.files.size, 1);
  });
  await test('metadata failure reuses identical uploaded bytes and stable metadata ID', async () => {
    const f = fixture({ metadataFailure: true }); const d = fresh(); await assert.rejects(submitRequest({ ...f.args, draft: d }), /link/);
    f.options.metadataFailure = false; await submitRequest({ ...f.args, draft: d });
    assert.equal(f.state.insertAttempts, 1); assert.equal(f.state.objects.size, 1); assert.equal(f.state.files.size, 1);
  });
  await test('lost upload response is resolved by byte comparison', async () => {
    const f = fixture({ lostUploadResponse: true }); await submitRequest({ ...f.args, draft: fresh() }); assert.equal(f.state.files.size, 1);
  });
  await test('an existing attachment with different bytes is never overwritten', async () => {
    const f = fixture(); const d = fresh(); f.state.objects.set('request-1/file-1-invoice.pdf', new Blob(['other']));
    await assert.rejects(submitRequest({ ...f.args, draft: d }), /differs/); assert.equal(f.state.files.size, 0); assert.equal(await f.state.objects.get('request-1/file-1-invoice.pdf').text(), 'other');
  });
  await test('a checkpoint conflict never writes, even when retried in memory', async () => {
    const f = fixture({ checkpointFailure: true }); const d = fresh();
    await assert.rejects(submitRequest({ ...f.args, draft: d }), /conflict/); await assert.rejects(submitRequest({ ...f.args, draft: d }), /conflict/); assert.equal(f.state.insertAttempts, 0);
  });
  await test('company drift and unverified request reads stop writes', async () => {
    const f = fixture({ companyChanged: true }); await assert.rejects(submitRequest({ ...f.args, draft: fresh() }), /company/); assert.equal(f.state.requests.size, 0);
    const r = fixture({ readFailure: true }); await assert.rejects(submitRequest({ ...r.args, draft: fresh() }), /confirm/); assert.equal(r.state.insertAttempts, 0);
  });
  await test('ambiguous receipt delivery is not automatically repeated', async () => {
    const f = fixture({ receiptFailure: true }); const d = fresh(); const result = await submitRequest({ ...f.args, draft: d }); assert.match(result.message, /could not be confirmed/);
    await submitRequest({ ...f.args, draft: d }); assert.equal(f.state.receipts, 1);
  });
  await test('AP-owned later states do not receive resumed attachments', async () => {
    const f = fixture(); const d = fresh(); f.state.requests.set(d.id, { id: d.id, created_by: 'user-1', company_entity_id: 'company-1', workflow_status: 'paid' });
    const r = await submitRequest({ ...f.args, draft: d }); assert.equal(r.filesComplete, false); assert.equal(f.state.uploads, 0); assert.equal(f.state.receipts, 0);
  });
  console.log(`${checks} Payment Request 2 checks passed.`);
})().catch(error => { console.error(error); process.exit(1); });
