/* /v2/po-builder.html?fromConcept=<id> -- the direct "Generate PO" link
 * from /v2/product-concepts.html (added 2026-09-30 at Blake's request: the
 * entry point for turning a concept into a PO should live on the concept,
 * not require finding and clicking the (still hidden) in-builder picker).
 *
 * Covers the idempotency short-circuit: a concept that ALREADY produced a
 * PO (a po_concept_links row exists) must open that PO rather than adding
 * its lines a second time -- the exact scenario po_concept_links exists to
 * make representable (a repeat "Generate PO" click, or the same link
 * clicked in two tabs).
 *
 * The "no existing link yet, generate a brand-new PO from scratch" path
 * reuses addFromConcepts(), which was already built (and already covered
 * by the concept-picker modal's own manual QA) but never previously
 * reachable from outside that modal -- this suite does not attempt to
 * fixture that full create-a-PO round trip (saveHeader/refreshAll/
 * syncPipeline all in play at once); see the PR notes for that gap.
 */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('po-builder-from-concept');

const CO = 'test-company';

const header = (o) => Object.assign({
  factory_id: 'fac-inco', factory_name: 'Incotexco', order_date: '2026-09-15', req_ship_date: '2026-12-11',
  expected_arrival_date: '2026-12-25', date_bucket: 'Holiday 2026', status: 'Sent to Factory',
  wholesale_triggered: false, notes: null, internal_notes: null, pdf_url: null, company_entity_id: CO,
  created_at: '2026-09-15T18:00:00Z', total_units: 240, total_retail_value: 8400, total_estimated_cost: 0,
}, o);

const tables = () => ({
  v_po_header_summary: [
    header({ id: 'po-from-concept-1', po_name: 'Incotexco-Sonic-Drop', is_new_product_po: true }),
  ],
  factories: [{ id: 'fac-inco', factory_name: 'Incotexco', short_code: 'IN', company_entity_id: CO }],
  po_lines: [],
  products_master: [],
  product_tracker: [],
  launch_product_readiness: [],
  po_concept_links: [
    { id: 'link-1', po_header_id: 'po-from-concept-1', concept_id: 'concept-sonic', company_entity_id: CO },
  ],
  product_concepts_v: [
    { id: 'concept-sonic', title: 'Sonic summer drop', status: 'approved', phase: 'core_draft',
      parent_concept_id: null, suggested_qty: 500, suggested_factory_id: 'fac-inco',
      suggested_factory_name: 'Incotexco', suggested_product_type: 'T-Shirts',
      suggested_size_breakdown: null, economics: null, evidence_strength: 'moderate', child_count: 0 },
  ],
});

const READY = () => !!document.getElementById('detailTitle') && document.getElementById('detailTitle').textContent !== 'New purchase order';

(async () => {
  const suite = await startSuite();
  try {
    // ── A concept that already produced a PO opens it, never a duplicate ──
    const page = await suite.open('/v2/po-builder.html?fromConcept=concept-sonic', tables(), { ready: READY });

    const title = await page.$eval('#detailTitle', (el) => el.textContent);
    R.test('an already-linked concept opens its existing PO', () => {
      R.eq(title, 'Incotexco-Sonic-Drop', 'detail title after ?fromConcept= with an existing link');
    });

    const poLineWrites = await page.evaluate(() => (window.__QUERIES__ || [])
      .filter((q) => q.table === 'po_lines' && q._op === 'insert'));
    R.test('no duplicate lines are inserted for an already-generated concept', () => {
      R.eq(poLineWrites.length, 0, 'po_lines insert calls');
    });

    const linkInserts = await page.evaluate(() => (window.__QUERIES__ || [])
      .filter((q) => q.table === 'po_concept_links' && q._op === 'insert'));
    R.test('no duplicate po_concept_links row is inserted either', () => {
      R.eq(linkInserts.length, 0, 'po_concept_links insert calls');
    });

    const status = await page.$eval('#poStatus', (el) => el.textContent);
    R.test('the status line says why it landed on this PO', () => {
      R.has(status, 'already', 'poStatus text');
    });
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
