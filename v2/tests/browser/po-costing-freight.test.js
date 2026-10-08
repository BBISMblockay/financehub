/* /v2/po-costing.html freight prefill, in the real page (v2/freight-request-match.js).
 *
 * The lookup pages through the company's freight requests. A page that fails
 * must be VISIBLE for the form fill that asked -- otherwise it reads exactly
 * like "no request exists" and someone saves freight without it. A lookup a
 * later fill has replaced (another PO, the same PO reopened, freight saved)
 * must paint nothing at all: neither its error nor its prefill.
 */
'use strict';
const assert = require('node:assert/strict');
const { startSuite, fakeSupabaseScript } = require('../lib/harness');

const PAGE = 500; // the page's FREIGHT_REQUEST_PAGE

(async () => {
  const suite = await startSuite();
  let passed = 0;
  let failed = 0;
  // Each check stands alone, so one failure does not hide the rest.
  const check = async (name, fn) => {
    try { await fn(); console.log(`  PASS ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}: ${err.message}`); failed++; }
  };

  // Requests for payment_requests pages after the first are controllable:
  //   window.__HOLD_EACH__  each one waits in window.__HELD__ until released
  //                         with 'ok' or 'fail', in whatever order a test picks
  //   window.__FAIL_LATER__ otherwise, each one fails (else it is served)
  // Page one is always served from the fixture.
  const ANCHOR = "if (broken()) return Promise.resolve({ data: null, error: { message: 'fixture: ' + table + ' is unreadable' } }).then(res, rej);";
  const script = fakeSupabaseScript();
  assert.equal(script.split(ANCHOR).length, 2, 'harness anchor moved; update this suite');
  await suite.context.route('**/cdn.jsdelivr.net/**supabase**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: script.replace(ANCHOR, ANCHOR + `
        if (table === 'payment_requests' && q.range && q.range[0] > 0) {
          var how = window.__HOLD_EACH__
            ? new Promise(function (r) { (window.__HELD__ = window.__HELD__ || []).push(r); })
            : Promise.resolve(window.__FAIL_LATER__ ? 'fail' : 'ok');
          return how.then(function (h) {
            return h === 'fail'
              ? { data: null, error: { message: 'fixture: later page failed' } }
              : { data: rows(), error: null };
          }).then(res, rej);
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
  const failedText = (page) => page.evaluate(() => window.SiloFreightMatch.LOOKUP_FAILED);
  const reopen = (page, id) => page.evaluate((poId) => document.querySelector(`[data-po-id="${poId}"]`)?.click(), id);
  const heldCount = (page, n) => page.waitForFunction((k) => (window.__HELD__ || []).length === k, n, { timeout: 5000 });
  const release = (page, i, how) => page.evaluate(([k, h]) => window.__HELD__[k](h), [i, how]);
  const settle = (page) => page.waitForTimeout(300);
  // Old-1 open with its boot lookup finished, so nothing from the boot is in flight.
  const openOld = async () => {
    const page = await suite.open('/v2/po-costing.html?po_id=po-old', fixture, { ready: opened('Old-1') });
    await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-OLD', null, { timeout: 5000 });
    return page;
  };
  // Two overlapping lookups for the SAME PO: reopen it twice, both held.
  const twoLookups = async () => {
    const page = await openOld();
    await page.evaluate(() => { window.__HOLD_EACH__ = true; window.__HELD__ = []; });
    await reopen(page, 'po-old'); await heldCount(page, 1);
    await reopen(page, 'po-old'); await heldCount(page, 2);
    return page;
  };

  try {
    await check('a request on a later page is found and prefilled', async () => {
      const page = await openOld();
      const v = await read(page);
      assert.equal(v.freight, '55.00');
      assert.equal(v.noteHidden, true);
      await page.close();
    });

    await check('a failed later page is shown for the open PO, never read as "no request"', async () => {
      const page = await openOld();
      await page.evaluate(() => { window.__FAIL_LATER__ = true; });
      await reopen(page, 'po-old');
      await page.waitForFunction(() => !document.getElementById('freightShareNote').hidden, null, { timeout: 5000 });
      const v = await read(page);
      assert.equal(v.note, await failedText(page));
      assert.equal(v.state, 'error');
      assert.equal(v.ref, '', 'nothing prefilled');
      assert.ok(['', '0'].includes(v.freight), 'no amount prefilled');
      const color = await page.evaluate(() => getComputedStyle(document.getElementById('freightShareNote')).color);
      const plain = await page.evaluate(() => {
        const p = document.createElement('p'); p.className = 'cost-hint'; document.body.appendChild(p);
        const c = getComputedStyle(p).color; p.remove(); return c;
      });
      assert.notEqual(color, plain, 'error note is styled differently from a hint');
      await page.close();
    });

    await check('a failure for a PO already left stays silent', async () => {
      const page = await suite.open('/v2/po-costing.html?po_id=po-new', fixture, { ready: opened('New-2') });
      await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-NEW', null, { timeout: 5000 });
      await page.evaluate(() => { window.__HOLD_EACH__ = true; window.__HELD__ = []; });
      // Old-1's lookup stops on page two, held; then the user moves to New-2.
      await reopen(page, 'po-old'); await heldCount(page, 1);
      await reopen(page, 'po-new');
      await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-NEW', null, { timeout: 5000 });
      await release(page, 0, 'fail'); await settle(page);
      const v = await read(page);
      assert.equal(v.po, 'New-2');
      assert.equal(v.noteHidden, true, 'no error note for the PO left behind');
      assert.equal(v.freight, '240.00');
      await page.close();
    });

    await check('same PO reopened: an older failure never paints over the newer prefill', async () => {
      const page = await twoLookups();
      await release(page, 1, 'ok');
      await page.waitForFunction(() => document.getElementById('inFreightRef').value === 'FX-OLD', null, { timeout: 5000 });
      await release(page, 0, 'fail'); await settle(page);
      const v = await read(page);
      assert.equal(v.freight, '55.00');
      assert.equal(v.noteHidden, true, 'no "nothing was prefilled" over prefilled values');
      assert.equal(v.state, null);
      await page.close();
    });

    await check('same PO reopened: an older success never prefills under the newer failure', async () => {
      const page = await twoLookups();
      await release(page, 1, 'fail');
      await page.waitForFunction(() => !document.getElementById('freightShareNote').hidden, null, { timeout: 5000 });
      await release(page, 0, 'ok'); await settle(page);
      const v = await read(page);
      assert.equal(v.state, 'error', 'the newer failure stands');
      assert.equal(v.ref, '', 'the older answer did not prefill');
      assert.ok(['', '0'].includes(v.freight));
      await page.close();
    });

    await check('a lookup in flight when freight is saved paints nothing afterwards', async () => {
      const page = await openOld();
      await page.evaluate(() => { window.__HOLD_EACH__ = true; window.__HELD__ = []; });
      await reopen(page, 'po-old'); await heldCount(page, 1);
      // What a save does: the page refills the form from the saved costing.
      // Freight is now non-zero, so this fill starts no lookup of its own.
      await page.evaluate(() => { ctx.headerInputs.freight = 99; fillFormFromCtx(); });
      await release(page, 0, 'fail'); await settle(page);
      const v = await read(page);
      assert.equal(v.freight, '99');
      assert.equal(v.noteHidden, true, 'no "reopen before saving" after the save');
      await page.close();
    });

    await check('refilling the form clears a shown error, including its error state', async () => {
      const page = await openOld();
      await page.evaluate(() => { window.__FAIL_LATER__ = true; });
      await reopen(page, 'po-old');
      await page.waitForFunction(() => document.getElementById('freightShareNote').dataset.state === 'error', null, { timeout: 5000 });
      // Saved freight: this fill starts no lookup, so only the fill can clear it.
      await page.evaluate(() => { ctx.headerInputs.freight = 99; fillFormFromCtx(); });
      const v = await read(page);
      assert.equal(v.noteHidden, true);
      assert.equal(v.state, null, 'no leftover error styling');
      await page.close();
    });
  } finally {
    await suite.close();
  }
  console.log(`po-costing-freight: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
