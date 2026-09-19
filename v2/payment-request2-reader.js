import { validDate } from './payment-request2-core.js';

export const MAX_TEXT = 40000;
export const MAX_PAGES = 10;
const unique = values => [...new Set(values)];
// Narrow labels only: a total is not necessarily the outstanding balance.
export function suggestFromText(text) {
  const lines = text.replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean);
  // PDF layouts often put a label and its value on adjacent text lines.
  const labelOnly = /^(?:vendor|supplier|payee|from|invoice\s*(?:number|no\.?|#)|amount due|balance due|total due|amount payable|payment due|invoice total|grand total|total|due date|(?:purchase order|p\.?o\.?)\s*(?:number|no\.?|#)?)\s*[:#]?$/i;
  for (let i = 0; i < lines.length - 1; i++) {
    if (labelOnly.test(lines[i]) && !labelOnly.test(lines[i + 1])) { lines[i] = lines[i].replace(/:$/, '') + ': ' + lines[i + 1]; lines.splice(i + 1, 1); }
  }
  const warnings = [], evidence = {};
  const pick = (key, pattern, parse = x => x.trim()) => {
    const hits = lines.map(line => { const m = line.match(pattern); return m ? { line, value: parse(m[1]) } : null; }).filter(Boolean);
    const values = unique(hits.map(h => h.value));
    if (values.length === 1 && values[0] !== null && values[0] !== '') { evidence[key] = hits[0].line; return values[0]; }
    if (hits.length) warnings.push(`Check ${key.replaceAll('_', ' ')}: the document value is unclear or conflicting.`);
    return null;
  };
  const amount = raw => {
    const value = raw.replace(/\b(?:USD|CAD|EUR|GBP|AUD|NZD|JPY|CNY|CHF)\b/gi, '').replace(/[$€£]/g, '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) return null;
    const n = Number(value.replaceAll(',', ''));
    return Number.isFinite(n) && n <= 9999999999.99 ? n : null;
  };
  const invoicePattern = /^invoice\s*(?:number|no\.?|#)\s*[:#-]?\s*(\S.{0,149})$/i;
  const invoiceRefs = unique(lines.map(l => l.match(invoicePattern)?.[1]?.trim()).filter(Boolean));
  const suggestion = {
    vendor_name: pick('vendor_name', /^(?:vendor|supplier|payee|from)\s*:\s*(.{2,300})$/i),
    invoice_number: pick('invoice_number', invoicePattern),
    amount_due: pick('amount_due', /^(?:amount due|balance due|total due|amount payable|payment due)\s*:?\s+(.+)$/i, amount),
    invoice_total: pick('invoice_total', /^(?:invoice total|grand total|total)\s*:?\s+(.+)$/i, amount),
    due_date: pick('due_date', /^due date\s*:?\s+(.+)$/i, value => validDate(value) ? value : null),
    currency: null, request_type: null, location_name: null,
    po_references: unique(lines.map(l => l.match(/^(?:purchase order|p\.?o\.?)\s*(?:number|no\.?|#)?\s*[:#]\s*([\w-]{1,150})$/i)?.[1]).filter(Boolean)), warnings,
  };
  const currencies = unique((text.match(/\b(?:USD|CAD|EUR|GBP|AUD|NZD|JPY|CNY|CHF)\b/g) || []));
  if (currencies.length === 1) suggestion.currency = currencies[0];
  else warnings.push('Confirm the currency; it was missing or more than one currency was found.');
  if (invoiceRefs.length > 1) {
    for (const key of Object.keys(suggestion)) if (!['warnings', 'po_references'].includes(key)) suggestion[key] = null;
    suggestion.po_references = []; Object.keys(evidence).forEach(key => delete evidence[key]);
    warnings.push('More than one invoice reference was found. Enter each payment separately; no fields were suggested.');
  }
  return { suggestion, evidence, multipleInvoices: invoiceRefs.length > 1 };
}

export function needsOCR(text) { return text.replace(/\s/g, '').length < 40; }
export function textFromPdfItems(items) {
  let text = '', y;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const nextY = item.transform?.[5];
    if (y !== undefined && nextY !== undefined && Math.abs(nextY - y) > 3 && !text.endsWith('\n')) text += '\n';
    text += item.str + (item.hasEOL ? '\n' : ' '); y = nextY;
  }
  return text.trim();
}

// IO is injected so tests drive this exact ordering without contacting a provider.
export async function readLocally(file, { openPdf, recognize, signal, progress = () => {} }) {
  const check = () => { if (signal?.aborted) throw Error('Reading stopped. Your document is still attached.'); };
  check();
  if (!file.blob?.size || file.blob.size > 4 * 1024 * 1024) throw Error('Read a PDF or image under 4 MB. You can still enter details manually.');
  let text = '', scannedPages = 0, pdf;
  const append = chunk => { if (text.length + (text ? 2 : 0) + chunk.length > MAX_TEXT) throw Error('This document has too much text to suggest details safely. Enter one invoice at a time.'); text += (text ? '\n\n' : '') + chunk; };
  try {
    if (/\.pdf$/i.test(file.name)) {
      progress('Reading PDF text on this device…'); pdf = await openPdf(file.blob, signal); check();
      if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw Error('Read one invoice with no more than 10 pages.');
      for (let n = 1; n <= pdf.numPages; n++) {
        check(); const page = await pdf.getPage(n);
        try {
          const embedded = textFromPdfItems((await page.getTextContent()).items); check();
          // Image operators also trigger OCR: mixed pages can have an embedded
          // header but the payable details only in an image.
          const scan = needsOCR(embedded) || await page.hasImages();
          if (scan) { progress(`Reading scanned page ${n} of ${pdf.numPages} on this device…`); append(await recognize(await page.image(), signal)); scannedPages++; }
          else append(embedded);
        } finally { page.cleanup?.(); }
      }
    } else if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
      progress('Reading image text on this device…'); append(await recognize(file.blob, signal)); scannedPages++;
    } else throw Error('Automatic fill supports PDFs and images. Enter this document manually.');
    check();
    if (!text.trim()) throw Error('No readable text was found. Try a clearer image or enter the details manually.');
    const result = suggestFromText(text);
    return { ...result, text, method: scannedPages ? 'ocr' : 'pdf-text', scannedPages };
  } finally { await pdf?.destroy(); }
}

export async function interpretMissing(read, { consent, companyId, invoke }) {
  if (!consent) throw Error('Choose AI assistance before sending extracted text.');
  if (!read?.text || read.text.length > MAX_TEXT || read.multipleInvoices) throw Error('Read a single invoice locally before asking for help.');
  let response;
  try { response = await invoke('payment-request-extract', { body: { company_id: companyId, text: read.text, consent: true } }); }
  catch { throw Error('AI assistance is unavailable. Your locally read details are still available; you can finish manually.'); }
  const { data, error } = response || {};
  if (error || data?.error || data?.company_id !== companyId || !data.suggestion) throw Error('AI assistance is unavailable. Your locally read details are still available; you can finish manually.');
  // Never replace deterministic evidence. AI only offers missing fields.
  const suggestion = { ...read.suggestion, warnings: [...read.suggestion.warnings, ...(data.suggestion.warnings || [])] };
  for (const key of ['vendor_name', 'invoice_number', 'amount_due', 'invoice_total', 'due_date', 'currency', 'request_type', 'location_name']) {
    if (suggestion[key] === null || suggestion[key] === '') suggestion[key] = data.suggestion[key] ?? null;
  }
  if (!suggestion.po_references.length) suggestion.po_references = data.suggestion.po_references || [];
  return suggestion;
}
