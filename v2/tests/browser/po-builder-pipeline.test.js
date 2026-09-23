/* /v2/po-builder.html -> the Products Pipeline, end to end.
 *
 * The real page, the real v2/po-pipeline-sync.js, a fake Supabase. What is
 * under test is the WIRING the unit suite cannot reach: that a change to a
 * new-product PO's lines ends in product_tracker writes carrying each
 * product's total across every size line, with nobody pressing Save or
 * -> TRK -- and that a restock PO adds nothing on its own.
 *
 * The fake does not apply writes to its fixture tables, which suits this:
 * every sync reads the same PO lines, so the figure written is the PO's total
 * whatever the line edit was, and each assertion reads the WRITE the page
 * sent, not a re-read of what the fake chose to keep.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('po-builder-pipeline');

const CO = 'test-company';
const MEN = 'Elevate & Celebrate T-Shirt';
const YOUTH = 'Elevate & Celebrate T-Shirt - Youth';
const RESTOCK = 'Caught Stealin Tee';

const header = (o) => Object.assign({
  factory_id: 'fac-inco', factory_name: 'Incotexco', order_date: '2026-09-15', req_ship_date: '2026-12-11',
  expected_arrival_date: '2026-12-25', date_bucket: 'Holiday 2026', status: 'Sent to Factory',
  wholesale_triggered: false, notes: null, internal_notes: null, pdf_url: null, company_entity_id: CO,
  created_at: '2026-09-15T18:00:00Z', total_units: 0, total_retail_value: 0, total_estimated_cost: 0,
}, o);

let n = 0;
const line = (po, title, type, variant, qty) => ({
  id: `line-${++n}`, po_header_id: po, company_entity_id: CO, title_snapshot: title, product_type_snapshot: type,
  variant_title_snapshot: variant, sku_snapshot: `${variant}-SKU`, upc_snapshot: null, retail_price: 35,
  unit_cost: 0, qty, retail_value: qty * 35, line_notes: null, created_at: `2026-09-15T18:00:${String(n).padStart(2, '0')}Z`,
});

const LINES = [
  ...[['S', 75], ['M', 75], ['L', 95], ['XL', 40], ['2XL', 30], ['3XL', 10]].map(([v, q]) => line('po-496', MEN, 'T-Shirts', v, q)),
  ...[['YS', 95], ['YM', 180], ['YL', 170], ['YXL', 105]].map(([v, q]) => line('po-496', YOUTH, 'Youth', v, q)),
  ...[['S', 12], ['M', 24], ['L', 20]].map(([v, q]) => line('po-restock', RESTOCK, 'T-Shirts', v, q)),
];

const tables = (tracker = [], readiness = []) => ({
  v_po_header_summary: [
    header({ id: 'po-496', po_name: 'Incotexco-496', is_new_product_po: true }),
    header({ id: 'po-restock', po_name: 'Incotexco-501', is_new_product_po: false }),
  ],
  factories: [{ id: 'fac-inco', factory_name: 'Incotexco', short_code: 'IN', company_entity_id: CO }],
  po_lines: LINES,
  products_master: [],
  product_tracker: tracker,
  launch_product_readiness: readiness,
});

const READY = () => document.querySelectorAll('[data-line-row]').length > 0;

const writes = (page, table) => page.evaluate((t) => (window.__QUERIES__ || [])
  .filter((q) => q.table === t && q._op !== 'select')
  .map((q) => ({ op: q._op, rows: q.rows, patch: q.patch })), table);

const waitForWrite = (page, table, op) => page.waitForFunction(({ t, o }) => (window.__QUERIES__ || [])
  .some((q) => q.table === t && q._op === o), { t: table, o: op }, { timeout: 8000 });

/** Type into a line's qty cell the way a person does, which fires autosave. */
async function editQty(page, variantSku, value) {
  const id = await page.evaluate((sku) => {
    const rows = [...document.querySelectorAll('[data-line-row]')];
    const row = rows.find((r) => r.querySelector('[data-line-field="sku_snapshot"]').value === sku);
    return row && row.getAttribute('data-line-row');
  }, variantSku);
  const input = `[data-line-field="qty"][data-line-id="${id}"]`;
  await page.fill(input, String(value));
  return id;
}

const status = (page) => page.$eval('#poStatus', (el) => el.textContent);

(async () => {
  const suite = await startSuite();
  try {
    // ── 1. a new-product PO: one qty edit puts BOTH products in the Pipeline ─
    let page = await suite.open('/v2/po-builder.html?po_id=po-496', tables(), { ready: READY });

    const trkCount = await page.$$eval('[data-line-tracker]', (els) => els.length);
    const meta = await page.$eval('#linesCardMeta', (el) => el.textContent);
    R.test('-> TRK is not offered on a new-product PO, and the card says the sync is automatic', () => {
      R.eq(trkCount, 0, '-> TRK buttons on a new-product PO');
      R.has(meta, 'sync to the Pipeline automatically');
    });

    await editQty(page, 'YXL-SKU', 110);
    await waitForWrite(page, 'product_tracker', 'insert');
    await page.waitForFunction(() => (window.__QUERIES__ || []).filter((q) => q.table === 'product_tracker' && q._op === 'insert').length >= 2, null, { timeout: 8000 });
    let w = await writes(page, 'product_tracker');
    const inserted = Object.fromEntries(w.filter((x) => x.op === 'insert').map((x) => [x.rows.product_title, x.rows]));

    R.test('a qty edit on one line adds every product on the PO, with no Save or -> TRK press', () => {
      R.eq(Object.keys(inserted).sort(), [MEN, YOUTH]);
    });
    R.test('expected units is each product\'s total across every size line (550, not 105)', () => {
      R.eq(inserted[YOUTH].expected_units, 550);
      R.eq(inserted[MEN].expected_units, 325);
    });
    R.test('the item records which PO it came from, and its manufacturer', () => {
      R.eq(inserted[YOUTH].po_header_id, 'po-496');
      R.eq(inserted[YOUTH].manufacturer, 'Incotexco');
      R.eq(inserted[YOUTH].factory_id, 'fac-inco');
      R.eq(inserted[YOUTH].bulk_eta, '2026-12-25');
      R.eq(inserted[YOUTH].company_entity_id, CO);
      R.eq(inserted[YOUTH].notes, 'Auto-added from PO: Incotexco-496');
    });
    const said = await status(page);
    R.test('the page says what it did', () => { R.has(said, '2 products added to the Pipeline'); });
    await page.close();

    // ── 2. import: lines that arrive in bulk reach the Pipeline too ─────────
    page = await suite.open('/v2/po-builder.html?po_id=po-496', tables(), { ready: READY });
    await page.click('#btnImportLines');
    await page.fill('#importText', `product_type,title,variant,sku,upc,barcode,retail_price,unit_cost,qty,notes\nYouth,${YOUTH},2YL,2YL-SKU,,,29,0,40,`);
    await page.click('#btnProcessImport');
    await waitForWrite(page, 'product_tracker', 'insert');
    w = await writes(page, 'product_tracker');
    R.test('an import syncs the Pipeline without any line being edited', () => {
      R.eq(w.filter((x) => x.op === 'insert').map((x) => x.rows.product_title).sort(), [MEN, YOUTH]);
    });
    await page.close();

    // ── 3. an item holding one line's qty (the reported row) is corrected ───
    const stale = [{ id: 'trk-youth', product_title: YOUTH, po_header_id: null, expected_units: 105,
      factory_id: 'fac-inco', manufacturer: null, product_type: 'Youth', bulk_eta: '2026-12-25',
      launch_id: 'lch-1', notes: 'Auto-added from PO: Incotexco-496', company_entity_id: CO }];
    page = await suite.open('/v2/po-builder.html?po_id=po-496', tables(stale, [{ id: 'lpr-1', product_tracker_id: 'trk-youth', expected_units: 105, company_entity_id: CO }]), { ready: READY });
    await editQty(page, 'S-SKU', 76);
    await waitForWrite(page, 'launch_product_readiness', 'update');
    w = await writes(page, 'product_tracker');
    R.test('the stored 105 is replaced by the PO total and linked to the PO, not duplicated', () => {
      const upd = w.filter((x) => x.op === 'update');
      R.eq(upd.length, 1);
      R.eq(upd[0].patch, { po_header_id: 'po-496', expected_units: 550, manufacturer: 'Incotexco' });
      R.eq(w.filter((x) => x.op === 'insert').map((x) => x.rows.product_title), [MEN], 'only the product with no item is added');
    });
    const lpr = await writes(page, 'launch_product_readiness');
    R.test('its launch readiness copy follows', () => {
      R.eq(lpr.map((x) => x.patch), [{ expected_units: 550 }]);
    });
    await page.close();

    // ── 4. a restock PO adds nothing on its own; -> TRK adds one product ────
    page = await suite.open('/v2/po-builder.html?po_id=po-restock', tables(), { ready: READY });
    await editQty(page, 'M-SKU', 25);
    await page.waitForFunction(() => (window.__QUERIES__ || []).some((q) => q.table === 'po_lines' && q._op === 'update'), null, { timeout: 8000 });
    await page.waitForTimeout(600);
    const restockWrites = await writes(page, 'product_tracker');
    const restockTrk = await page.$$eval('[data-line-tracker]', (els) => els.length);
    R.test('an edit on a restock PO writes nothing to the Pipeline; -> TRK is offered', () => {
      R.eq(restockWrites.length, 0, 'product_tracker writes from a restock edit');
      R.eq(restockTrk, 3, '-> TRK on each restock line');
    });
    await page.click('[data-line-tracker]');
    await waitForWrite(page, 'product_tracker', 'insert');
    w = await writes(page, 'product_tracker');
    R.test('-> TRK (which did nothing before) adds that product with its full total', () => {
      R.eq(w.length, 1);
      R.eq(w[0].rows.product_title, RESTOCK);
      R.eq(w[0].rows.expected_units, 56, '12 + 24 + 20');
      R.eq(w[0].rows.po_header_id, 'po-restock');
    });
    const trkSaid = await status(page);
    R.test('-> TRK says what it added, with the size-line count', () => {
      R.has(trkSaid, `"${RESTOCK}" added to the Pipeline — 56 expected units across 3 size lines`);
    });
    await page.close();
  } catch (e) {
    R.ok('suite ran to completion', false, e && e.stack);
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
