// scripts/tests/po-document.test.mjs
//
// The po-document edge function: ONE purchase order as a PDF. It exists because
// SILO's PO had only ever been a browser print window, so an AI sending a PO to
// its factory had nothing to attach (Blake, 2026-11-28: "it would attach said
// pos with drafted copy based on po factors etc").
//
// Two callers, and they are the whole security story:
//   1. ?t=<token>  -- the single-use key minted when a connection claimed that
//      PO's queued email. It must be live, unexpired, and open exactly one PO.
//   2. Authorization: Bearer -- a person's own session. The PO is read with
//      THAT token, so RLS decides; this function has no opinion about who may
//      read a PO and must not be talked into one.
//
// pdf-lib is a Deno/esm.sh import and cannot be loaded here, so the renderer is
// exercised with a RECORDING stand-in: it proves what the document says and in
// what order, which is the part that can silently go wrong. Deno's own type
// check covers the import.
//
// Run: node scripts/tests/po-document.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createPoDocumentHandler } from '../../supabase/functions/po-document/handler.mjs';
import { renderPurchaseOrder, identity, fmtDate, wrap } from '../../supabase/functions/po-document/render.mjs';

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (err) { console.error(`FAIL ${name}\n  ${err?.message || err}`); process.exit(1); }
}

// ── a pdf-lib stand-in that records what was asked of it ──────────────────
function fakePdfLib() {
  const drawn = [];
  const font = (tag) => ({
    tag,
    widthOfTextAtSize: (s, size) => String(s).length * size * 0.5,
  });
  const page = () => ({
    drawText: (s, o) => drawn.push({ kind: 'text', s: String(s), ...o }),
    drawLine: (o) => drawn.push({ kind: 'line', ...o }),
  });
  const pages = [];
  const doc = {
    meta: {},
    setTitle: (t) => { doc.meta.title = t; },
    setProducer: (t) => { doc.meta.producer = t; },
    setCreator: (t) => { doc.meta.creator = t; },
    embedFont: async (tag) => font(tag),
    addPage: (size) => { const p = page(); p.size = size; pages.push(p); return p; },
    getPages: () => pages,
    save: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),   // "%PDF"
  };
  return {
    drawn, pages, doc,
    lib: {
      PDFDocument: { create: async () => doc },
      StandardFonts: { Helvetica: 'reg', HelveticaBold: 'bold' },
      rgb: (r, g, b) => ({ r, g, b }),
    },
  };
}

const PO = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  po_name: 'A-1150',
  factory_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  order_date: '2026-11-25',
  req_ship_date: '2027-01-22',
  expected_arrival_date: '2027-03-08',
  status: 'Draft',
  notes: 'Use the new neck label.',
  is_new_product_po: true,
  company_entity_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
};
const FACTORY = { factory_name: 'Incotexco', contact_name: 'Ana', contact_email: 'ana@incotexco.test',
                  payment_terms: '30/70', shipping_terms: 'FOB Cartagena' };
const LINES = [
  { title_snapshot: 'Vintage Tee', sku_snapshot: 'VT-NVY', variant_title_snapshot: 'M', qty: 900 },
  { title_snapshot: 'Field Hoodie', sku_snapshot: 'FH-CHR', variant_title_snapshot: 'L', qty: 650 },
];

// ── the renderer ──────────────────────────────────────────────────────────
await check('a date is written the same way in every timezone', () => {
  assert.equal(fmtDate('2026-11-25'), '25 Nov 2026');
  assert.equal(fmtDate('2026-11-25T23:00:00Z'), '25 Nov 2026');   // not the 26th anywhere
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDate('not a date'), '');
  assert.equal(fmtDate('2026-13-01'), '');
});

await check('a word too long for the column is cut, not dropped or overflowed', () => {
  const font = { widthOfTextAtSize: (s, size) => s.length * size };
  assert.deepEqual(wrap(font, 'aa bb cc', 1, 5), ['aa bb', 'cc']);
  const one = wrap(font, 'aaaaaaaaaa', 1, 4);
  assert.equal(one.length, 1);
  assert.ok(one[0].length <= 4, 'a long word must be cut to the column');
});

await check('the identity block falls back the way the browser PO does', () => {
  const full = identity({ settings: { legal_name: 'Company A Inc.', city: 'Phoenix', region: 'AZ', postal_code: '85004',
                                      purchasing_contact_name: 'Blake', purchasing_contact_email: 'p@a.test' },
                          entity: { title: 'Company A' } });
  assert.equal(full.name, 'Company A Inc.');
  assert.ok(full.shipTo.includes('Phoenix, AZ 85004'));
  assert.deepEqual(full.contact, ['Blake', 'p@a.test']);
  assert.equal(full.footer, 'Company A Inc. Purchase Order');

  const bare = identity({ settings: {}, entity: { title: 'Company A' }, user: { email: 'me@a.test' } });
  assert.equal(bare.name, 'Company A', 'no legal name falls back to the workspace title');
  assert.deepEqual(bare.contact, ['me@a.test'], 'no purchasing contact falls back to the person');

  const nothing = identity({});
  assert.equal(nothing.name, '');
  assert.deepEqual(nothing.shipTo, [], 'never a placeholder, never another tenant');
  assert.equal(nothing.footer, 'Purchase Order');
});

await check('the document says what the factory needs to read', async () => {
  const fake = fakePdfLib();
  const bytes = await renderPurchaseOrder(
    { po: PO, factory: FACTORY, lines: LINES, identity: identity({ settings: { legal_name: 'Company A Inc.' } }) },
    fake.lib);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, 'it returns bytes');
  const said = fake.drawn.filter((d) => d.kind === 'text').map((d) => d.s);
  const all = said.join(' | ');

  assert.ok(said.includes('PURCHASE ORDER'));
  assert.ok(said.includes('A-1150'), 'the PO name');
  assert.ok(all.includes('Incotexco') && all.includes('ana@incotexco.test'), 'who it is for');
  assert.ok(all.includes('25 Nov 2026') && all.includes('22 Jan 2027'), 'its dates');
  assert.ok(all.includes('30/70') && all.includes('FOB Cartagena'), 'its terms');
  assert.ok(all.includes('Yes — sample before bulk'), 'that it is a new product');
  assert.ok(all.includes('Use the new neck label.'), 'its notes');
  assert.ok(all.includes('Vintage Tee') && all.includes('VT-NVY') && all.includes('Field Hoodie'), 'every line');
  assert.ok(all.includes('1,550'), 'the total units, grouped');
  assert.ok(all.includes('TOTAL  1,550 units'), 'and a total line the factory can confirm against');
  assert.equal(fake.doc.meta.title, 'A-1150');
  assert.equal(fake.doc.meta.producer, 'SILO');
});

await check('a PO with no factory, no notes and no lines still renders', async () => {
  const fake = fakePdfLib();
  const bytes = await renderPurchaseOrder(
    { po: { po_name: 'A-2' }, factory: {}, lines: [], identity: identity({}) }, fake.lib);
  assert.ok(bytes.length > 0);
  const all = fake.drawn.filter((d) => d.kind === 'text').map((d) => d.s).join(' | ');
  assert.ok(all.includes('A-2'));
  assert.ok(all.includes('TOTAL  0 units'));
  assert.ok(!all.includes('undefined') && !all.includes('null'), `a missing value was printed: ${all}`);
});

await check('many lines page, and every page is numbered', async () => {
  const fake = fakePdfLib();
  const many = Array.from({ length: 120 }, (_, i) => ({
    title_snapshot: `Style ${i}`, sku_snapshot: `SKU-${i}`, variant_title_snapshot: 'M', qty: 10,
  }));
  await renderPurchaseOrder({ po: PO, factory: FACTORY, lines: many, identity: identity({}) }, fake.lib);
  assert.ok(fake.pages.length > 1, 'it paginated');
  const said = fake.drawn.filter((d) => d.kind === 'text').map((d) => d.s);
  for (let i = 1; i <= fake.pages.length; i += 1) {
    assert.ok(said.includes(`${i} / ${fake.pages.length}`), `page ${i} has no number`);
  }
  assert.ok(said.filter((s) => s === 'PRODUCT').length > 1,
    'the table header must repeat on each page, or a later page is a wall of unlabelled columns');
  for (const l of many) assert.ok(said.includes(l.sku_snapshot), `${l.sku_snapshot} was lost`);
});

// ── the handler ───────────────────────────────────────────────────────────
const ENV = {
  SUPABASE_URL: 'https://db.example.test',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

/** A PostgREST stand-in. `rowsFor(path)` answers; every call is recorded. */
function fakeFetch(rowsFor) {
  const calls = [];
  const impl = async (url, opts) => {
    const path = String(url).replace(`${ENV.SUPABASE_URL}/rest/v1/`, '');
    calls.push({ path, auth: opts.headers.authorization });
    const out = rowsFor(path, calls);
    if (out && out.status) {
      return { ok: false, status: out.status, text: async () => out.body || '{}' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out || []) };
  };
  impl.calls = calls;
  return impl;
}

const TOKEN = 'a'.repeat(64);
async function tokenHash(t) {
  const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const HASH = await tokenHash(TOKEN);

const liveQueue = (over = {}) => [{
  po_header_id: PO.id, status: 'claimed',
  doc_token_expires_at: new Date(Date.now() + 3600e3).toISOString(), ...over,
}];

function rowsFor(path) {
  if (path.startsWith('po_vendor_emails')) return path.includes(HASH) ? liveQueue() : [];
  if (path.startsWith('po_headers')) return path.includes(PO.id) ? [PO] : [];
  if (path.startsWith('po_lines')) return LINES;
  if (path.startsWith('factories')) return [FACTORY];
  if (path.startsWith('company_settings')) return [{ legal_name: 'Company A Inc.' }];
  if (path.startsWith('entities')) return [{ title: 'Company A' }];
  return [];
}

function make(rows = rowsFor) {
  const fake = fakePdfLib();
  const fetchImpl = fakeFetch(rows);
  const handle = createPoDocumentHandler({
    env: ENV, fetchImpl, pdfLib: fake.lib, renderPurchaseOrder, identity, cryptoImpl: webcrypto,
  });
  return { handle, fetchImpl, fake };
}
const get = (q, headers = {}) => new Request(`https://fn.example.test/po-document${q}`, { headers });

await check('a live token hands over that one PO as a PDF attachment', async () => {
  const { handle, fetchImpl } = make();
  const res = await handle(get(`?t=${TOKEN}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="A-1150.pdf"');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const lookup = fetchImpl.calls[0];
  assert.ok(lookup.path.includes(`doc_token_hash=eq.${HASH}`), 'it looks the token up by its HASH');
  assert.ok(!lookup.path.includes(TOKEN), 'the raw token must never be sent to the database');
});

await check('a token that is not live, or has expired, opens nothing', async () => {
  for (const [over, status] of [[{ status: 'sent' }, 404], [{ status: 'queued' }, 404],
                                [{ doc_token_expires_at: new Date(Date.now() - 1000).toISOString() }, 410]]) {
    const { handle } = make((p) => (p.startsWith('po_vendor_emails') ? liveQueue(over) : rowsFor(p)));
    const res = await handle(get(`?t=${TOKEN}`));
    assert.equal(res.status, status, `${JSON.stringify(over)} should be ${status}`);
  }
  const { handle } = make();
  assert.equal((await handle(get('?t=' + 'b'.repeat(64)))).status, 404, 'an unknown token opens nothing');
  assert.equal((await handle(get('?t=not-a-token'))).status, 400, 'a malformed token is refused before any read');
});

await check('without a token and without a session, nothing is read at all', async () => {
  const { handle, fetchImpl } = make();
  const res = await handle(get(`?po=${PO.id}`));
  assert.equal(res.status, 401);
  assert.equal(fetchImpl.calls.length, 0, 'it must not touch the database for an unauthenticated caller');
});

await check('a signed-in caller reads the PO with their OWN token, so RLS decides', async () => {
  const { handle, fetchImpl } = make();
  const res = await handle(get(`?po=${PO.id}`, { authorization: 'Bearer person-jwt' }));
  assert.equal(res.status, 200);
  assert.ok(fetchImpl.calls.length > 0);
  for (const c of fetchImpl.calls) {
    assert.equal(c.auth, 'Bearer person-jwt',
      `${c.path} was read with ${c.auth} -- the service role must not stand in for the person`);
  }
});

await check('a PO RLS does not return is "not yours", not a crash', async () => {
  const { handle } = make((p) => (p.startsWith('po_headers') ? [] : rowsFor(p)));
  const res = await handle(get(`?po=${PO.id}`, { authorization: 'Bearer person-jwt' }));
  assert.equal(res.status, 404);
  assert.ok(String((await res.json()).message).includes('not yours'));
});

await check('a dead session is reported as a sign-in problem', async () => {
  const { handle } = make((p) => (p.startsWith('po_headers') ? { status: 401, body: '{}' } : rowsFor(p)));
  const res = await handle(get(`?po=${PO.id}`, { authorization: 'Bearer stale' }));
  assert.equal(res.status, 401);
});

await check('one failed detail read does not lose the document', async () => {
  const { handle } = make((p) => (p.startsWith('po_lines') ? { status: 500, body: 'boom' } : rowsFor(p)));
  const res = await handle(get(`?t=${TOKEN}`));
  assert.equal(res.status, 200, 'the PO still renders without its line reads');
});

await check('only GET, and a browser may ask first', async () => {
  const { handle } = make();
  assert.equal((await handle(new Request('https://fn.example.test/po-document', { method: 'OPTIONS' }))).status, 200);
  const post = await handle(new Request('https://fn.example.test/po-document', { method: 'POST' }));
  assert.equal(post.status, 405);
});

await check('a filename cannot be smuggled through the PO name', async () => {
  const nasty = { ...PO, po_name: '../../etc/passwd"; rm -rf /' };
  const { handle } = make((p) => (p.startsWith('po_headers') ? [nasty] : rowsFor(p)));
  const res = await handle(get(`?t=${TOKEN}`));
  const cd = res.headers.get('content-disposition');
  assert.ok(/^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/.test(cd), `unsafe filename: ${cd}`);
  assert.ok(!cd.includes('/') && !cd.includes('"; '), `unsafe filename: ${cd}`);
});

console.log(`\n${passed} checks passed`);
