/* /v2/po-builder.html?fromConcept=<id> -- the "Generate PO" link from
 * /v2/product-concepts.html.
 *
 * The page makes ONE call, generate_po_from_concept(), which creates the
 * PO, its lines and the concept link in a single transaction (20260930000000).
 * The page used to write them as three requests, so a failure after the
 * header left an empty PO holding the concept's claim. These scenarios pin
 * the page to the single call:
 *   1. A repeat (the function returns repeated = true) opens that PO and
 *      writes nothing.
 *   2. A fresh generation makes exactly one RPC call, writes no table rows
 *      itself, and lands on the new PO.
 *   3. A refusal (collection, archived, no factory, permission) is shown
 *      as a status message, with no table writes and no dialog.
 *
 * What the function itself does (atomic rollback, locking, refusals, grants)
 * is proven against real Postgres in
 * scripts/tests/generate-po-from-concept-database.test.mjs.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('po-builder-from-concept');

const CO = 'test-company';

const header = (o) => Object.assign({
  factory_id: 'fac-inco', factory_name: 'Incotexco', order_date: '2026-09-15', req_ship_date: '2026-12-11',
  expected_arrival_date: '2026-12-25', date_bucket: 'Holiday 2026', status: 'Draft',
  wholesale_triggered: false, notes: null, internal_notes: null, pdf_url: null, company_entity_id: CO,
  created_at: '2026-09-15T18:00:00Z', total_units: 240, total_retail_value: 8400, total_estimated_cost: 0,
  is_new_product_po: true,
}, o);

const baseTables = () => ({
  factories: [{ id: 'fac-inco', factory_name: 'Incotexco', short_code: 'IN', company_entity_id: CO }],
  po_headers: [],
  po_lines: [],
  products_master: [],
  product_tracker: [],
  launch_product_readiness: [],
  po_concept_links: [],
});

const TITLED = () => !!document.getElementById('detailTitle') && document.getElementById('detailTitle').textContent !== 'New purchase order';

const writes = (page) => page.evaluate(() => (window.__QUERIES__ || [])
  .filter((q) => ['po_headers', 'po_lines', 'po_concept_links'].includes(q.table)
    && ['insert', 'update', 'upsert', 'delete'].includes(q._op))
  .map((q) => q.table + ':' + q._op));

const rpcCalls = (page, name) => page.evaluate((n) => (window.__QUERIES__ || [])
  .filter((q) => q.table === 'rpc:' + n).map((q) => q.args), name);

(async () => {
  const suite = await startSuite();
  try {
    // 1. Repeat: the function returns the PO already made.
    {
      const tables = Object.assign(baseTables(), {
        v_po_header_summary: [header({ id: 'po-existing-1', po_name: 'Incotexco-Sonic-Drop' })],
      });
      const page = await suite.open('/v2/po-builder.html?fromConcept=concept-sonic', tables, {
        ready: TITLED,
        rpc: { generate_po_from_concept: () => ({ po_header_id: 'po-existing-1', repeated: true, line_count: null }) },
      });
      const title = await page.$eval('#detailTitle', (el) => el.textContent);
      const status = await page.$eval('#poStatus', (el) => el.textContent);
      const w = await writes(page);
      const calls = await rpcCalls(page, 'generate_po_from_concept');

      R.ok('a repeat opens the PO the function returned', title === 'Incotexco-Sonic-Drop', title);
      R.ok('the status says the concept already had a PO', /already has a PO/i.test(status), status);
      R.ok('a repeat writes nothing from the page', w.length === 0, JSON.stringify(w));
      R.ok('exactly one generate call is made', calls.length === 1, JSON.stringify(calls));
    }

    // 2. Fresh generation: one call, no page-side writes.
    {
      const tables = Object.assign(baseTables(), {
        v_po_header_summary: [header({ id: 'po-new-1', po_name: 'Incotexco-9001' })],
      });
      const page = await suite.open('/v2/po-builder.html?fromConcept=concept-sonic', tables, {
        ready: () => /Generated a PO/.test((document.getElementById('poStatus') || {}).textContent || ''),
        rpc: { generate_po_from_concept: () => ({ po_header_id: 'po-new-1', repeated: false, line_count: 3 }) },
      });
      const title = await page.$eval('#detailTitle', (el) => el.textContent);
      const status = await page.$eval('#poStatus', (el) => el.textContent);
      const w = await writes(page);
      const calls = await rpcCalls(page, 'generate_po_from_concept');
      const nameCalls = await rpcCalls(page, 'generate_next_po_name');

      R.ok('exactly one generate call, naming the concept', calls.length === 1 && calls[0]?.p_concept_id === 'concept-sonic', JSON.stringify(calls));
      R.ok('the page writes no header, line or link itself', w.length === 0, JSON.stringify(w));
      R.ok('the page does not name the PO itself (the function does)', nameCalls.length === 0, JSON.stringify(nameCalls));
      R.ok('the page lands on the generated PO', title === 'Incotexco-9001', title);
      R.ok('the status reports the line count', /3 lines/.test(status), status);
      const search = await page.evaluate(() => location.search);
      R.ok('the URL now names the PO, so a reload opens it instead of generating again', search === '?po_id=po-new-1', search);
    }

    // 3. Refusal: shown as a status, nothing written, no dialog.
    {
      const tables = Object.assign(baseTables(), { v_po_header_summary: [] });
      const page = await suite.open('/v2/po-builder.html?fromConcept=concept-parent', tables, {
        ready: () => /Could not generate/.test((document.getElementById('poStatus') || {}).textContent || ''),
        dialogAction: 'accept',
        rpc: { generate_po_from_concept: () => ({ __error: { message: 'This concept is a collection. Generate a PO from each product in it', code: '22023' } }) },
      });
      const status = await page.$eval('#poStatus', (el) => el.textContent);
      const cls = await page.$eval('#poStatus', (el) => el.className);
      const title = await page.$eval('#detailTitle', (el) => el.textContent);
      const w = await writes(page);

      R.ok('the refusal reason is shown', /collection/i.test(status), status);
      R.ok('it is shown as an error', /bcn-status--neg/.test(cls), cls);
      await page.waitForTimeout(4000);
      R.ok('and it stays on screen (no auto-hide)', await page.$eval('#poStatus', (el) => !el.hidden));
      R.ok('no dialog is used for it', page.__dialogs.length === 0, JSON.stringify(page.__dialogs));
      R.ok('nothing is written on a refusal', w.length === 0, JSON.stringify(w));
      R.ok('the page stays on a new, unsaved PO', title === 'New purchase order', title);
    }
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
