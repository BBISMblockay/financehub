import { assertSupportedText } from './payment-request2-text.js';

export const REQUEST_TYPES = {
  invoice_vendor_payment: 'Invoice / vendor payment',
  inventory_deposit: 'Inventory deposit',
  inventory_balance: 'Inventory balance',
  inventory_freight: 'Inventory freight',
  employee_reimbursement: 'Employee reimbursement',
  customer_refund: 'Customer refund',
};
export const ACTIVE_PO_STATUSES = ['Sent to Factory', 'Confirmed', 'In Production', 'Shipped', 'In Transit', 'Partially Received', 'Received'];
export const FIELD_NAMES = ['vendor_name', 'request_type', 'amount_due', 'invoice_number', 'due_date', 'flex_id', 'location_name', 'notes_comments', 'requester_email', 'currency'];
export const normalizeName = value => String(value || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
export const normalizeInvoice = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
export function money(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n <= 9999999999.99 ? n : null;
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validateFields(fields, reviewed) {
  assertSupportedText(fields);
  if (!String(fields.vendor_name || '').trim()) throw Error('Choose who should be paid.');
  if (!Object.hasOwn(REQUEST_TYPES, fields.request_type)) throw Error('Choose a request type.');
  if (money(fields.amount_due) === null) throw Error('Enter the amount requested, with no more than two decimal places.');
  if (fields.currency !== 'USD') throw Error('This payment workflow currently records USD only. Ask AP to resolve the currency before submitting.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.requester_email || '')) throw Error('Enter a valid requester email.');
  if (fields.due_date && !validDate(fields.due_date)) throw Error('Check the due date.');
  if (!reviewed) throw Error('Review the payee, amount and document details, then check the confirmation.');
}
export function requestPayload(draft, userId, companyId) {
  const f = draft.fields;
  validateFields(f, draft.reviewed);
  assertSupportedText({ internal_po_number: draft.poNames.join(', ') });
  return {
    id: draft.id, company_entity_id: companyId, created_by: userId, updated_by: userId,
    vendor_name: f.vendor_name.trim(), vendor_name_norm: normalizeName(f.vendor_name),
    vendor_name_manual: null, vendor_name_manual_norm: normalizeName(f.vendor_name),
    request_type: f.request_type, amount_due: money(f.amount_due),
    invoice_number: f.invoice_number.trim() || null, due_date: f.due_date || null,
    flex_id: f.flex_id.trim() || null,
    internal_po_number: [...new Set(draft.poNames.map(x => x.trim()).filter(Boolean))].join(', ') || null,
    requester_email: f.requester_email.trim(), requester_email_norm: f.requester_email.trim().toLowerCase(),
    location_name: f.location_name.trim() || null, notes_comments: f.notes_comments.trim() || null,
    file_name: null, file_path: null, file_url: null, workflow_status: 'new', completed: false,
  };
}
// Model output can fill only known empty fields. No IDs, state or approval data.
export function applySuggestions(fields, suggestion) {
  const next = { ...fields }, applied = {};
  for (const key of ['vendor_name', 'request_type', 'amount_due', 'invoice_number', 'due_date', 'location_name', 'currency']) {
    if (String(next[key] ?? '').trim()) continue;
    const value = suggestion[key];
    if (value === null || value === undefined || value === '') continue;
    if (key === 'amount_due' && money(value) === null) continue;
    if (key === 'request_type' && !Object.hasOwn(REQUEST_TYPES, value)) continue;
    if (key === 'currency' && !['USD', 'CAD', 'EUR', 'GBP'].includes(value)) continue;
    if (key === 'due_date' && !validDate(value)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    next[key] = String(value).slice(0, 500);
    applied[key] = next[key];
  }
  return { fields: next, applied };
}
export function clearSourceSuggestions(fields, applied) {
  const next = { ...fields };
  for (const [key, value] of Object.entries(applied || {})) {
    if (next[key] === value) next[key] = '';
  }
  return next;
}
export function duplicateMatches(rows, fields, excludeId) {
  const vendor = normalizeName(fields.vendor_name), invoice = normalizeInvoice(fields.invoice_number), amount = money(fields.amount_due);
  return rows.filter(row => row.id !== excludeId && !['rejected', 'cancelled'].includes(row.workflow_status)
    && normalizeName(row.vendor_name) === vendor
    && (invoice ? normalizeInvoice(row.invoice_number) === invoice : amount !== null && Number(row.amount_due) === amount));
}
export function documentMime(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || null;
}
export const safeFileName = name => name.replace(/[^\w.\-]/g, '_').slice(-150) || 'document';
