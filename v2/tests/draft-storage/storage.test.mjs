import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { saveDraft, listDrafts } from '../../payment-request2-drafts.js';
import { submitRequest, resumeMessage } from '../../payment-request2-submit.js';
import { FIELD_NAMES } from '../../payment-request2-core.js';
const scope = 'company:user';
const connect = version => new Promise((resolve, reject) => {
  const request = indexedDB.open('silo-payment-request2', version);
  request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const transaction = (db, mode, action) => new Promise((resolve, reject) => {
  const tx = db.transaction('drafts', mode); let result;
  action(tx.objectStore('drafts'), value => { result = value; });
  tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error);
});
const stored = async id => { const db = await connect(2); try { return await transaction(db, 'readonly', (store, done) => { const req = store.get(`${scope}:${id}`); req.onsuccess = () => done(req.result); }); } finally { db.close(); } };
const draft = id => ({ id, revision: 0, status: 'draft', reviewed: true, fields: { ...Object.fromEntries(FIELD_NAMES.map(k => [k, ''])), vendor_name: 'Confidential Vendor', amount_due: '250', currency: 'USD', request_type: 'invoice_vendor_payment', requester_email: 'private@example.invalid' }, poNames: [], files: [{ id: `file-${id}`, name: 'confidential.pdf', blob: new Blob(['confidential bytes']) }], localRead: { text: 'confidential invoice plaintext' }, suggestion: { vendor_name: 'Confidential Vendor' } });
const tombstoneKeys = ['id', 'key', 'revision', 'savedAt', 'scope', 'status'].sort();
function clean(record) { assert.deepEqual(Object.keys(record).sort(), tombstoneKeys); assert.equal(record.status, 'submitted'); assert.equal(JSON.stringify(record).includes('confidential'), false); }
function server({ failUpload = false, failInsert = null, status } = {}) {
  const requests = new Map(), files = new Map(); let inserts = 0;
  const db = { from(table) { const filters = {}; return { select() { return this; }, eq(k, v) { filters[k] = v; return this; }, async maybeSingle() { return { data: [...(table === 'payment_requests' ? requests : files).values()].find(r => Object.entries(filters).every(([k, v]) => r[k] === v)) || null }; }, async insert(row) { if (table === 'payment_requests' && failInsert) return { error: failInsert }; (table === 'payment_requests' ? requests : files).set(row.id, structuredClone(row)); if (table === 'payment_requests') inserts++; return {}; } }; }, storage: { from: () => ({ upload: async () => failUpload ? { error: Error('offline') } : {}, download: async () => ({ error: Error('missing') }) }) }, functions: { invoke: async () => ({ data: { ok: true } }) } };
  return { db, requests, get inserts() { return inserts; }, prepare(d) { if (status) requests.set(d.id, { id: d.id, company_entity_id: 'company', created_by: 'user', workflow_status: status }); }, run: async d => submitRequest({ db, draft: d, userId: 'user', companyId: 'company', assertContext: async () => {}, checkpoint: value => saveDraft(scope, value) }) };
}
// Seed the old shipped version before the new code opens its connection.
const old = await connect(1);
await transaction(old, 'readwrite', store => {
  store.put({ ...draft('legacy-complete'), key: `${scope}:legacy-complete`, scope, revision: 7, status: 'submitted', savedAt: '2026-09-19' });
  store.put({ ...draft('legacy-pending'), key: `${scope}:legacy-pending`, scope, revision: 2, savedAt: '2026-09-19' });
}); old.close();
await listDrafts(scope);
clean(await stored('legacy-complete')); assert.equal((await stored('legacy-pending')).files[0].blob.size, 18);
console.log('PASS upgrade scrubs previously completed content and preserves unfinished drafts');
const d = draft('complete'), api = server();
await saveDraft(scope, d); assert.equal((await stored(d.id)).localRead.text, 'confidential invoice plaintext');
const stale = structuredClone(d);
const result = await api.run(d); assert.equal(result.filesComplete, true); clean(await stored(d.id));
assert.equal((await listDrafts(scope)).some(row => row.id === d.id), false);
console.log('PASS real submission checkpoints leave only a content-free persisted tombstone');
await api.run(d); clean(await stored(d.id)); assert.equal(api.inserts, 1);
api.requests.get(d.id).workflow_status = 'paid';
assert.equal((await api.run(d)).filesComplete, true); clean(await stored(d.id));
await assert.rejects(saveDraft(scope, stale), /changed/);
stale.revision = (await stored(d.id)).revision; await assert.rejects(saveDraft(scope, stale), /changed/);
clean(await stored(d.id));
console.log('PASS retries stay scrubbed and stale tabs cannot resurrect completed content');
const partial = draft('partial'); const offline = server({ failUpload: true });
await assert.rejects(offline.run(partial), /Request saved/);
const retained = await stored(partial.id); assert.equal(retained.files[0].blob.size, 18); assert.equal(retained.localRead.text, 'confidential invoice plaintext'); assert.equal(retained.status, 'submitting');
console.log('PASS attachment failures retain the recoverable invoice and text');
const forwarded = draft('forwarded'), ap = server({ status: 'paid' }); ap.prepare(forwarded);
assert.equal((await ap.run(forwarded)).filesComplete, false);
assert.equal((await stored(forwarded.id)).status, 'needs_ap_help'); assert.equal((await stored(forwarded.id)).files[0].blob.size, 18);
assert.ok((await listDrafts(scope)).some(row => row.id === forwarded.id));
console.log('PASS unfinished AP-forwarded requests keep their remaining documents visible');
// The reason an insert was rejected must survive the reload it is recovered
// through: it rides the same IndexedDB record as the frozen payload, and the
// draft shelf renders it from that record.
const rejected = draft('rejected'); const denied = server({ failInsert: { code: '42501', message: 'new row violates row-level security policy for table "payment_requests"' } });
await assert.rejects(denied.run(rejected), /\[42501\]/);
const kept = (await listDrafts(scope)).find(row => row.id === rejected.id);
assert.equal(kept.status, 'submitting'); assert.ok(kept.payload); assert.equal(kept.lastSubmitError.code, '42501');
assert.match(resumeMessage(kept).message, /row-level security policy for table "payment_requests" \[42501\]/);
assert.equal(resumeMessage(kept).tone, 'neg');
console.log('PASS a rejected submission keeps its reason and code across a reload');
