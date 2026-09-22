// PostgreSQL text cannot contain NUL. A lone UTF-16 surrogate is also not a
// Unicode scalar; preserve valid pairs (emoji), all languages and whitespace.
const unsupported = /\u0000|[\uD800-\uDFFF]/u;
export const hasUnsupportedText = value => typeof value === 'string' && unsupported.test(value);
export const repairText = value => value.replace(/\u0000/gu, '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
export const visibleText = value => value.replace(/\u0000|[\uD800-\uDFFF]/gu, char => `[U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
export const TEXT_LABELS = {
  vendor_name: 'Vendor / payee', invoice_number: 'Invoice reference',
  flex_id: 'Flex ID', internal_po_number: 'PO references',
  requester_email: 'Requester email', location_name: 'Location / department',
  notes_comments: 'Notes for AP',
};
export function assertSupportedText(record) {
  const bad = Object.entries(record).filter(([, value]) => hasUnsupportedText(value));
  if (bad.length) throw Error(`Unsupported characters in ${bad.map(([key]) => TEXT_LABELS[key] || key).join(', ')}. Use Review text repair before submitting.`);
}
export function textRepairPlan(draft) {
  if (!draft) return [];
  if (draft.payload && (draft.lastSubmitError?.code !== '22P05' || draft.requestSaved || draft.receiptAttempted || draft.status !== 'submitting')) return [];
  const source = draft.payload || { ...draft.fields, internal_po_number: draft.poNames.join(', ') };
  return Object.entries(TEXT_LABELS).filter(([key]) => hasUnsupportedText(source[key]))
    .map(([key, label]) => ({ key, label, before: source[key], after: repairText(source[key]) }));
}
