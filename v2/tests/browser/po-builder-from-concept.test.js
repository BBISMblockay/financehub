/* /v2/po-builder.html?fromConcept=<id> -- the direct "Generate PO" link
 * from /v2/product-concepts.html (added 2026-09-30 at Blake's request: the
 * entry point for turning a concept into a PO should live on the concept,
 * not require finding and clicking the (still hidden) in-builder picker).
 *
 * Three scenarios against the real page:
 *   1. A concept that already has a PO (po_headers.generated_from_concept_id)
 *      opens it, never creates a second one.
 *   2. A fresh concept generates a brand-new, pre-populated PO from scratch.
 *   3. A concurrent generation this caller LOST the race for (the
 *      po_headers insert fails with the partial unique index's 23505) does
 *      not fall back to creating a duplicate PO -- it fails safely.
 *
 * The race itself (two real concurrent inserts hitting the actual Postgres
 * unique index) is proven separately in
 * scripts/tests/generate-po-from-concept-database.test.mjs against real
 * PGlite Postgres; this suite proves the PAGE'S reaction to that outcome,
 * via the harness's window.__FIXTURE_INSERT_ERRORS__ hook (added alongside
 * this test) rather than a live race.
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
  generated_from_concept_id: null,
}, o);

const CONCEPT = {
  id: 'concept-sonic', title: 'Sonic summer drop', status: 'approved', phase: 'core_draft',
  parent_concept_id: null, suggested_qty: 500, suggested_factory_id: 'fac-inco',
  suggested_factory_name: 'Incotexco', suggested_product_type: 'T-Shirts',
  suggested_size_breakdown: null, economics: null, evidence_strength: 'moderate', child_count: 0,
};

const baseTables = () => ({
  factories: [{ id: 'fac-inco', factory_name: 'Incotexco', short_code: 'IN', company_entity_id: CO }],
  po_lines: [],
  products_master: [],
  product_tracker: [],
  launch_product_readiness: [],
  po_concept_links: [],
  product_concepts_v: [CONCEPT],
});

const READY = () => !!document.getElementById('detailTitle') && document.getElementById('detailTitle').textContent !== 'New purchase order';

const inserts = (page, table) => page.evaluate((t) => (window.__QUERIES__ || [])
  .filter((q) => q.table === t && q._op === 'insert'), table);

(async () => {
  const suite = await startSuite();
  try {
    // ── 1. Already generated: opens the existing PO, no duplicate writes ──
    {
      const tables = Object.assign(baseTables(), {
        po_headers: [{ id: 'po-existing-1', generated_from_concept_id: 'concept-sonic', company_entity_id: CO }],
        v_po_header_summary: [
          header({ id: 'po-existing-1', po_name: 'Incotexco-Sonic-Drop', is_new_product_po: true, generated_from_concept_id: 'concept-sonic' }),
        ],
      });

      const page = await suite.open('/v2/po-builder.html?fromConcept=concept-sonic', tables, { ready: READY });

      const title = await page.$eval('#detailTitle', (el) => el.textContent);
      const lineInserts = await inserts(page, 'po_lines');
      const headerInserts = await inserts(page, 'po_headers');
      const status = await page.$eval('#poStatus', (el) => el.textContent);

      R.ok('an already-generated concept opens its existing PO', title === 'Incotexco-Sonic-Drop', title);
      R.ok('no duplicate lines are inserted for an already-generated concept', lineInserts.length === 0, `po_lines inserts: ${lineInserts.length}`);
      R.ok('no second po_headers row is inserted either', headerInserts.length === 0, `po_headers inserts: ${headerInserts.length}`);
      R.ok('the status line says why it landed on this PO', /already/i.test(status), status);
    }

    // ── 2. A fresh concept generates a brand-new, pre-populated PO ─────────
    {
      const tables = Object.assign(baseTables(), {
        po_headers: [],
        // The harness fabricates 'fixture-inserted-id' for every insert --
        // seeding the SAME id here is what lets openPO() (called by
        // addFromConcepts() right after the insert) find and render it,
        // exactly as it would find a freshly-committed real row. openPO()
        // reads THIS static fixture, not the insert's own return value, so
        // po_name here must match what the seeded generate_next_po_name RPC
        // below returns -- a real refreshAll() would instead re-read the
        // row this test's insert actually wrote.
        v_po_header_summary: [header({ id: 'fixture-inserted-id', po_name: 'Incotexco-9001', is_new_product_po: true })],
      });

      const page = await suite.open('/v2/po-builder.html?fromConcept=concept-sonic', tables, {
        ready: READY,
        rpc: { generate_next_po_name: () => 'Incotexco-9001' },
      });

      const headerInserts = await inserts(page, 'po_headers');
      const lineInserts = await inserts(page, 'po_lines');
      const linkInserts = await inserts(page, 'po_concept_links');
      const title = await page.$eval('#detailTitle', (el) => el.textContent);

      R.ok('exactly one po_headers row is inserted', headerInserts.length === 1, `po_headers inserts: ${headerInserts.length}`);
      R.ok('the insert carries the claim column', headerInserts[0]?.rows?.generated_from_concept_id === 'concept-sonic',
        JSON.stringify(headerInserts[0]?.rows));
      R.ok('the concept\'s line is inserted onto the newly-claimed header', lineInserts.length >= 1 && lineInserts[0]?.rows?.[0]?.po_header_id === 'fixture-inserted-id',
        JSON.stringify(lineInserts[0]?.rows));
      R.ok('the concept -> PO link is recorded too', linkInserts.length === 1, `po_concept_links inserts: ${linkInserts.length}`);
      R.ok('the page lands on the newly-generated PO, populated', title === 'Incotexco-9001', title);
    }

    // ── 3. This caller LOST the race: fails safely, no duplicate created ──
    {
      const tables = Object.assign(baseTables(), { po_headers: [], v_po_header_summary: [] });

      // The alert() this scenario ends in fires DURING boot(), not from a
      // later click -- a page.once('dialog', ...) attached only after
      // open() resolves can lose the race to it entirely (Playwright
      // auto-dismisses an unlistened dialog with nothing left to read it,
      // which is exactly what silently hung this suite the first time).
      // dialogAction registers the listener in the harness BEFORE goto().
      // ready waits for both po_headers touches (the failed claim attempt,
      // then the recovery lookup) so open() does not return before the
      // alert has actually fired and been recorded.
      const page = await suite.open('/v2/po-builder.html?fromConcept=concept-sonic', tables, {
        ready: () => (window.__QUERIES__ || []).filter((q) => q.table === 'po_headers').length >= 2,
        dialogAction: 'accept',
        insertErrors: {
          po_headers: [{ message: 'duplicate key value violates unique constraint "po_headers_generated_from_concept_uniq"' }],
        },
      });

      const dialogText = page.__dialogs[0];
      const lineInserts = await inserts(page, 'po_lines');
      const linkInserts = await inserts(page, 'po_concept_links');

      R.ok('a dialog was actually shown', page.__dialogs.length === 1, `dialogs: ${JSON.stringify(page.__dialogs)}`);
      R.ok('a lost race with no recoverable winner fails with a clear message, not a crash',
        /already has a PO/i.test(dialogText || ''), dialogText);
      R.ok('no lines were inserted for a generation attempt that lost the race', lineInserts.length === 0, `po_lines inserts: ${lineInserts.length}`);
      R.ok('no po_concept_links row was inserted either', linkInserts.length === 0, `po_concept_links inserts: ${linkInserts.length}`);
    }
  } finally {
    await suite.close();
  }
  process.exit(R.summary().fail ? 1 : 0);
})();
