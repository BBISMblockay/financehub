/* /v2/po-costing.html freight prefill, in the real page (v2/freight-request-match.js).
 *
 * The lookup pages through the company's freight requests. A page that fails
 * must be VISIBLE for the PO still open -- otherwise it reads exactly like "no
 * request exists" and someone saves freight without it -- and must stay silent
 * for a PO the user has already left.
 */
'use strict';
const assert = require('node:assert/strict');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');

const PAGE = 500; // the page's FREIGHT_REQUEST_PAGE

(async () => {
  const suite = await startSuite();
  let passed = 0;
  const check = async (name, fn) => { await fn(); console.log(`  PASS ${name}`); passed++; };

  // Later pages of payment_requests can be held (__LATER_GATE__) and/or fail
  // (__FAIL_LATER__). Page one is always served from the fixture.
  const ANCHOR = "if (broken()) return Promise.resolve({ data: null, error: { message: 'fixture: ' + table + ' is unreadable' } }).then(res, rej);";
  const script = fakeSupabaseScript();
  assert.equal(script.split(ANCHOR).length, 2, 'harness anchor moved; update this suite');
  await suite.context.route('**/cdn.jsdelivr.net/**supabase**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: script.replace(ANCHOR, ANCHOR + `
        if (table === 'payment_requests' && q.range && q.range[0] > 0) {
          var later = Promise.resolve(window.__LATER_GATE__).then(function () {
            return window.__FAIL_LATER__
              ? { data: null, error: { message: 'fixture: later page failed' } }
              : { data: rows(), error: null };
          });
          return later.then(res, rej);
        }`),
  }));

  const POS = [
    { id: 'po-old', po_name: 'Old-1', factory_name: 'Creytex', status: 'shipped' },
    { id: 'po-new', po_name: 'New-2', factory_name: 'Andes', status: 'shipped' },
  ];
  const filler = Array.from({ length: PAGE }, (_, i) => ({
    request_type: 'inventory_freight', amount_due: 1, invoice_number: 'Z' + i, vendor_name: 'z', internal_po_number: 'Filler-' + i,
  }));
  // New-2's request is on page one; Old-1's is the first row of page two.
  filler[0] = { request_type: 'inventory_freight', amount_due: 240, invoice_number: 'FX-NEW', vendor_name: 'Andes Logistics', internal_po_number: 'New-2' };
  const requests = filler.concat([
    { request_type: 'inventory_freight', amount_due: 55, invoice_number: 'FX-OLD', vendor_name: 'Creytex Freight', internal_po_number: 'Old-1' },
  ]);
  const fixture = {
    profiles: [{ id: 'test-user', name: 'Test Owner', email: 'owner@example.test', role: 'owner', is_active: true }],
    v_po_costing_summary: POS.map((p) => ({ po_header_id: p.id, po_name: p.po_name, po_status: p.status })),
    v_po_header_summary: POS,
    po_headers: POS.map((p) => ({ id: p.id, po_name: p.po_name, status: p.status, internal_notes: '' })),
    po_lines: [{ id: 'l1', po_header_id: 'po-old', sku_snapshot: 'S1', title_snapshot: 'Tee', variant_title_snapshot: 'M', unit_cost: 5, qty: 100, retail_price: 30, created_at: '2026-01-01' }],
    po_costing: [], po_costing_lines: [],
    payment_requests: requests,
  };
  const opened = (name) => new Function(`return document.getElementById('ctxPoName')?.textContent === ${JSON.stringify(name)};`);
  const read = (page) => page.evaluate(() => {
    const n = document.getElementById('freightShareNote');
    return {
      po: document.getElementById('ctxPoName').textContent,
      freight: document.getElementById('inFreight').value,
      ref: document.getElementById('inFreightRef').value,
      noteHidden: n.hidden, note: n.textContent, state: n.dataset.state || null,
    };
  });
  const failedText = async (page) => page.evaluate(() => window.SiloFreightMatch.LOOKUP_FAILED);

  try {
    await check('a request on a later page is found and prefilled', async () => {
      const page = await suite.open('/v2/po-costing.html?po_id=po-old', fixture, { ready: opened('Old-1') });
      await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-OLD', null, { timeout: 5000 });
      const v = await read(page);
      assert.equal(v.freight, '55.00');
      assert.equal(v.noteHidden, true);
      await page.close();
    });

    await check('a failed later page is shown for the open PO, never read as "no request"', async () => {
      const p2 = await suite.open('/v2/po-costing.html?po_id=po-old', fixture, { ready: opened('Old-1') });
      await p2.evaluate(() => { window.__FAIL_LATER__ = true; });
      // The boot lookup may already have finished page two; reopen the PO so
      // the failure is the one under test.
      await p2.evaluate(() => document.querySelector('[data-po-id="po-old"]')?.click());
      await p2.waitForFunction(() => !document.getElementById('freightShareNote').hidden, null, { timeout: 5000 });
      const v = await read(p2);
      assert.equal(v.note, await failedText(p2));
      assert.equal(v.state, 'error');
      assert.equal(v.ref, '', 'nothing prefilled');
      assert.ok(['', '0'].includes(v.freight), 'no amount prefilled');
      const color = await p2.evaluate(() => getComputedStyle(document.getElementById('freightShareNote')).color);
      const plain = await p2.evaluate(() => {
        const p = document.createElement('p'); p.className = 'cost-hint'; document.body.appendChild(p);
        const c = getComputedStyle(p).color; p.remove(); return c;
      });
      assert.notEqual(color, plain, 'error note is styled differently from a hint');
      await p2.close();
    });

    await check('a failure for a PO already left stays silent', async () => {
      const page = await suite.open('/v2/po-costing.html?po_id=po-new', fixture, { ready: opened('New-2') });
      await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-NEW', null, { timeout: 5000 });
      await page.evaluate(() => {
        window.__FAIL_LATER__ = true;
        window.__LATER_GATE__ = new Promise((r) => { window.__RELEASE_LATER__ = r; });
      });
      // Old-1's lookup stops on page two, held; then the user moves to New-2.
      await page.evaluate(() => document.querySelector('[data-po-id="po-old"]')?.click());
      await page.waitForFunction(opened('Old-1'));
      await page.evaluate(() => document.querySelector('[data-po-id="po-new"]')?.click());
      await page.waitForFunction(opened('New-2'));
      await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-NEW', null, { timeout: 5000 });
      await page.evaluate(() => window.__RELEASE_LATER__());
      await page.waitForTimeout(300);
      const v = await read(page);
      assert.equal(v.po, 'New-2');
      assert.equal(v.noteHidden, true, 'no error note for the PO left behind');
      assert.equal(v.freight, '240.00');
      await page.close();
    });
  } catch (err) {
    console.error('  FAIL', err.message);
    process.exitCode = 1;
  } finally {
    await suite.close();
  }
  console.log(`po-costing-freight: ${passed} passed`);
})();
