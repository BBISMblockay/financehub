/* A purchase order as a PDF.
 *
 * WHY THIS EXISTS. SILO's purchase order has only ever been a browser print
 * window (v2/po-builder.html builds the sheet and calls window.print()). That
 * is fine for a person at a desk and useless to anything else: an AI sending
 * the PO to the factory has nothing to attach, and neither does a page that
 * wants a Download button. This renders the same document server-side.
 *
 * PURE. It takes the rows and returns bytes; it reads no database, no
 * environment and no clock it was not given. That is what makes it testable
 * under node as well as Deno (po-document.test.mjs runs it with fixtures).
 *
 * NOTHING COMPANY-SPECIFIC. Every word printed comes from the arguments. The
 * identity block follows the same rule as v2/po-document-identity.js: no legal
 * name falls back to the workspace title, no purchasing contact falls back to
 * nothing at all, and a missing block is simply absent -- never a placeholder,
 * never another tenant's details.
 */

const A4 = { w: 595.28, h: 841.89 };
const M = 48;                       // page margin
const INK = [0.09, 0.09, 0.11];
const MUTED = [0.45, 0.45, 0.48];
const RULE = [0.80, 0.80, 0.83];

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const money = (n) => Number(n || 0).toLocaleString('en-US');

/** A date as "25 Nov 2026", or '' — never a locale-dependent string. */
export function fmtDate(iso) {
  const s = clean(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = s.split('-');
  const mi = Number(m) - 1;
  if (mi < 0 || mi > 11) return '';
  return `${Number(d)} ${MONTHS[mi]} ${y}`;
}

/** The company block, by the same rules the browser PO uses. */
export function identity({ settings = {}, entity = {}, user = {} } = {}) {
  const name = clean(settings.legal_name) || clean(entity.title);
  const cityLine = [clean(settings.city), [clean(settings.region), clean(settings.postal_code)].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  const address = [clean(settings.address_line1), clean(settings.address_line2), cityLine, clean(settings.country)]
    .filter(Boolean);
  let contact = [clean(settings.purchasing_contact_name), clean(settings.purchasing_contact_phone),
                 clean(settings.purchasing_contact_email)].filter(Boolean);
  if (!contact.length) contact = [clean(user.name), clean(user.email)].filter(Boolean);
  return {
    name,
    shipTo: name ? [name, ...address] : address,
    contact,
    footer: name ? `${name} Purchase Order` : 'Purchase Order',
  };
}

/** Cut `text` to the widest run of characters that fits `width` at `size`. */
function fit(font, text, size, width) {
  let s = clean(text);
  if (!s) return '';
  while (s.length > 1 && font.widthOfTextAtSize(s, size) > width) s = s.slice(0, -1);
  return font.widthOfTextAtSize(s, size) > width ? '' : s;
}

/** Wrap `text` into lines no wider than `width`. */
export function wrap(font, text, size, width) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    if (line) lines.push(line);
    line = font.widthOfTextAtSize(w, size) <= width ? w : fit(font, w, size, width);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * @param {object} data   { po, factory, lines, identity }
 * @param {object} pdfLib { PDFDocument, StandardFonts, rgb }
 * @returns {Promise<Uint8Array>}
 */
export async function renderPurchaseOrder(data, pdfLib) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const po = data.po || {};
  const factory = data.factory || {};
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const id = data.identity || { name: '', shipTo: [], contact: [], footer: 'Purchase Order' };

  const doc = await PDFDocument.create();
  doc.setTitle(clean(po.po_name) || 'Purchase Order');
  doc.setProducer('SILO');
  doc.setCreator('SILO');

  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);

  const totalUnits = lines.reduce((n, l) => n + Number(l.qty || 0), 0);
  const inner = A4.w - M * 2;

  let page = null;
  let y = 0;
  const newPage = () => { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; };
  const text = (s, x, size, font, color) => {
    page.drawText(String(s), { x, y, size, font, color: rgb(...(color || INK)) });
  };
  const rule = (yy, color) => {
    page.drawLine({ start: { x: M, y: yy }, end: { x: A4.w - M, y: yy }, thickness: 0.75, color: rgb(...(color || RULE)) });
  };

  // ── cover ───────────────────────────────────────────────────────────────
  newPage();
  if (id.name) { text(fit(bold, id.name, 10, inner * 0.6), M, 10, bold, MUTED); y -= 22; }
  text('PURCHASE ORDER', M, 26, bold); y -= 4;

  const poName = clean(po.po_name) || '—';
  const poW = bold.widthOfTextAtSize(poName, 18);
  page.drawText(poName, { x: A4.w - M - poW, y: y + 4, size: 18, font: bold, color: rgb(...INK) });
  y -= 18;
  rule(y, INK); y -= 24;

  // two columns: who it is for, and what it is
  const colW = (inner - 24) / 2;
  const left = M;
  const right = M + colW + 24;
  let leftY = y;
  let rightY = y;

  const block = (x, startY, title, rows) => {
    let yy = startY;
    page.drawText(title, { x, y: yy, size: 8, font: bold, color: rgb(...MUTED) });
    yy -= 14;
    for (const [k, v] of rows) {
      if (!clean(v)) continue;
      page.drawText(fit(reg, k, 8.5, colW * 0.45), { x, y: yy, size: 8.5, font: reg, color: rgb(...MUTED) });
      const vl = wrap(bold, v, 9.5, colW - colW * 0.45 - 6);
      vl.forEach((ln, i) => {
        page.drawText(ln, { x: x + colW * 0.45 + 6, y: yy - i * 11, size: 9.5, font: bold, color: rgb(...INK) });
      });
      yy -= Math.max(16, vl.length * 11 + 5);
    }
    return yy;
  };

  leftY = block(left, leftY, 'FACTORY', [
    ['Factory', factory.factory_name],
    ['Attention', factory.contact_name],
    ['Email', factory.contact_email],
    ['Payment terms', factory.payment_terms],
    ['Shipping terms', factory.shipping_terms],
  ]);

  rightY = block(right, rightY, 'ORDER', [
    ['Order date', fmtDate(po.order_date)],
    ['Requested ship', fmtDate(po.req_ship_date)],
    ['Expected arrival', fmtDate(po.expected_arrival_date)],
    ['Styles', String(lines.length)],
    ['Total units', money(totalUnits)],
    ['New product', po.is_new_product_po ? 'Yes — sample before bulk' : ''],
  ]);

  y = Math.min(leftY, rightY) - 6;

  if (id.shipTo.length || id.contact.length) {
    rule(y); y -= 18;
    let shipY = block(left, y, 'SHIP TO', id.shipTo.map((l, i) => [i === 0 ? 'Company' : '', l]));
    let contactY = block(right, y, 'BUYER CONTACT', id.contact.map((l, i) => [i === 0 ? 'Contact' : '', l]));
    y = Math.min(shipY, contactY) - 6;
  }

  const notes = clean(po.notes);
  if (notes) {
    rule(y); y -= 18;
    text('NOTES', M, 8, bold, MUTED); y -= 14;
    for (const ln of wrap(reg, notes, 9.5, inner)) { text(ln, M, 9.5, reg); y -= 12; }
    y -= 4;
  }

  // ── lines ───────────────────────────────────────────────────────────────
  const COLS = [
    { k: 'title_snapshot', h: 'PRODUCT', w: 0.42, align: 'l' },
    { k: 'sku_snapshot', h: 'SKU', w: 0.26, align: 'l' },
    { k: 'variant_title_snapshot', h: 'VARIANT', w: 0.18, align: 'l' },
    { k: 'qty', h: 'QTY', w: 0.14, align: 'r' },
  ];
  const head = () => {
    let x = M;
    for (const c of COLS) {
      const w = inner * c.w;
      const label = c.h;
      const lw = bold.widthOfTextAtSize(label, 7.5);
      page.drawText(label, {
        x: c.align === 'r' ? x + w - lw : x, y, size: 7.5, font: bold, color: rgb(...MUTED),
      });
      x += w;
    }
    y -= 8;
    rule(y, INK);
    y -= 14;
  };

  if (y < M + 120) newPage();
  rule(y); y -= 18;
  text(`LINES · ${lines.length} styles · ${money(totalUnits)} units`, M, 8, bold, MUTED);
  y -= 18;
  head();

  for (const l of lines) {
    if (y < M + 40) { newPage(); head(); }
    let x = M;
    for (const c of COLS) {
      const w = inner * c.w;
      const raw = c.k === 'qty' ? money(l.qty) : l[c.k];
      const val = fit(c.k === 'qty' ? bold : reg, raw, 9, w - 8);
      if (val) {
        const vw = (c.k === 'qty' ? bold : reg).widthOfTextAtSize(val, 9);
        page.drawText(val, {
          x: c.align === 'r' ? x + w - vw : x,
          y, size: 9, font: c.k === 'qty' ? bold : reg, color: rgb(...INK),
        });
      }
      x += w;
    }
    y -= 8;
    rule(y);
    y -= 12;
  }

  if (y < M + 30) newPage(); else y -= 6;
  const totalLabel = `TOTAL  ${money(totalUnits)} units`;
  const tw = bold.widthOfTextAtSize(totalLabel, 11);
  page.drawText(totalLabel, { x: A4.w - M - tw, y, size: 11, font: bold, color: rgb(...INK) });

  // ── footer on every page ────────────────────────────────────────────────
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M - 14 }, end: { x: A4.w - M, y: M - 14 }, thickness: 0.75, color: rgb(...RULE) });
    p.drawText(fit(reg, id.footer, 8, inner * 0.7), { x: M, y: M - 26, size: 8, font: reg, color: rgb(...MUTED) });
    const n = `${i + 1} / ${pages.length}`;
    const nw = reg.widthOfTextAtSize(n, 8);
    p.drawText(n, { x: A4.w - M - nw, y: M - 26, size: 8, font: reg, color: rgb(...MUTED) });
  });

  return doc.save();
}
