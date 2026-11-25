/* A purchase order's steps are company DATA (po_status_options,
 * 20261125234500): the real /v2/po-builder.html builds its status dropdown
 * from that table instead of the array that used to live in the page -- and
 * when the read fails, the array is still there, because an empty status
 * dropdown would stop every PO being edited.
 *
 * The card PO Report shows for steps a connected AI set is in
 * po-report-drafted-receipts.test.js, which already has PO Report's fixture.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('po-status-steps');

const CO = 'test-company';

const header = (o) => Object.assign({
  factory_id: 'fac-1', factory_name: 'Incotexco', order_date: '2026-11-01', req_ship_date: '2026-12-01',
  expected_arrival_date: '2026-12-20', date_bucket: 'Holiday 2026', status: 'Sent to Factory',
  wholesale_triggered: false, notes: null, internal_notes: null, pdf_url: null, company_entity_id: CO,
  created_at: '2026-11-01T18:00:00Z', total_units: 0, total_retail_value: 0, total_estimated_cost: 0,
}, o);

/* The company's own list: SILO's default steps with two of its own, one of
 * them withdrawn (is_active false) while a PO is still sitting at it. */
const STEPS = [
  { name: 'Draft', sort_order: 10, is_active: true },
  { name: 'Sent to Factory', sort_order: 30, is_active: true },
  { name: 'At the embroiderer', sort_order: 35, is_active: true },
  { name: 'In Production', sort_order: 50, is_active: true },
  { name: 'Received', sort_order: 90, is_active: true },
  { name: 'Retired step', sort_order: 95, is_active: false },
];

const tables = (steps = STEPS) => ({
  v_po_header_summary: [
    header({ id: 'po-1', po_name: 'Incotexco-900', is_new_product_po: false }),
    header({ id: 'po-2', po_name: 'Incotexco-901', is_new_product_po: false, status: 'Retired step' }),
  ],
  factories: [{ id: 'fac-1', factory_name: 'Incotexco', short_code: 'IN', company_entity_id: CO }],
  po_lines: [],
  products_master: [],
  product_tracker: [],
  launch_product_readiness: [],
  po_status_options: steps.map((s) => Object.assign({ company_entity_id: CO }, s)),
});

const options = (page, sel) => page.$eval(sel, (el) => [...el.options].map((o) => o.value));

(async () => {
  const suite = await startSuite();
  try {
    // ── 1. the builder's steps come from the table ──────────────────────────
    let page = await suite.open('/v2/po-builder.html', tables(),
      { ready: () => document.querySelectorAll('#status option').length > 1 });

    await page.waitForFunction(() => [...document.querySelectorAll('#status option')]
      .some((o) => o.value === 'At the embroiderer'), null, { timeout: 8000 });
    const built = await options(page, '#status');
    R.test('the dropdown is this company\'s own list, in its own order', () => {
      R.eq(built.slice(0, 5), ['Draft', 'Sent to Factory', 'At the embroiderer', 'In Production', 'Received']);
    });
    const filter = await options(page, '#poStatusFilter');
    R.test('a withdrawn step is not one of the five the company offers', () => {
      R.eq(built.indexOf('Retired step') > 4 || built.indexOf('Retired step') === -1, true,
        'it is never offered as a choice of its own');
    });
    R.test('but a PO already sitting at a withdrawn step can still be found and shown', () => {
      R.truthy(filter.includes('Retired step'), 'the filter offers it, because a PO is at it');
      R.truthy(built.includes('Retired step'), 'and the editor can show that PO its own status');
    });
    await page.close();

    // ── 2. the read fails: the page keeps working ───────────────────────────
    // An empty status dropdown would stop every PO being edited, so the
    // page's own array stays as the fallback.
    const broken = tables();
    delete broken.po_status_options;
    page = await suite.open('/v2/po-builder.html', broken,
      { ready: () => document.querySelectorAll('#status option').length > 1 });
    const fallback = await options(page, '#status');
    R.test('without the steps table the built-in list is still there', () => {
      for (const s of ['Draft', 'Sent to Factory', 'In Production', 'Received', 'Closed', 'Cancelled']) {
        R.truthy(fallback.includes(s), `${s} is still offered`);
      }
    });
    await page.close();

  } catch (e) {
    R.ok('suite ran to completion', false, e && e.stack);
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
