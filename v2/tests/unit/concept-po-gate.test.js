/* v2/concept-po-gate.js -- how /v2/product-concepts.html draws whether a
 * concept can become a PO. The RULE is product_concept_po_missing() in the
 * database (20260930120000, tested in
 * scripts/tests/generate-po-from-concept-database.test.mjs); this file only
 * checks that the page draws that answer faithfully and never invents its own.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');
const { gate, completionPrompt } = loadV2(['concept-po-gate.js']).SiloConceptPoGate;

const r = createReporter('concept-po-gate');

const BAT_BROS = { id: 'c1', title: 'Bat Bros Youth Hoodie', status: 'approved', child_count: 0,
  po_missing: ['Size breakdown', 'Unit cost (FOB)', 'Retail price'] };

{
  const g = gate(BAT_BROS);
  r.ok('an incomplete concept is not ready', g.ready === false);
  r.ok('it lists exactly what the database said is missing',
    JSON.stringify(g.missing) === JSON.stringify(BAT_BROS.po_missing), JSON.stringify(g.missing));
}
r.ok('an empty po_missing is ready', gate({ status: 'approved', po_missing: [] }).ready === true);
r.ok('archived is blocked with its own reason and no checklist',
  (() => { const g = gate({ status: 'archived', po_missing: [] }); return !g.ready && /Archived/.test(g.reason) && !g.missing.length; })());
r.ok('a collection parent is blocked with its own reason',
  (() => { const g = gate({ status: 'approved', child_count: 2, po_missing: [] }); return !g.ready && /collection/i.test(g.reason); })());
{
  const g = gate({ status: 'approved' });
  r.ok('po_missing absent (page ahead of the migration) is unknown, left to the database to refuse',
    g.ready === true && g.unknown === true, JSON.stringify(g));
}

{
  const p = completionPrompt(BAT_BROS, BAT_BROS.po_missing);
  r.ok('the prompt names the concept', p.includes('Bat Bros Youth Hoodie'), p);
  r.ok('the prompt lists every missing item', BAT_BROS.po_missing.every((m) => p.includes(m)), p);
  r.ok('it asks for sizes from a real size curve, summing to the quantity', /size curve/.test(p) && /adding up to the suggested quantity/.test(p), p);
  r.ok('it names the economics keys the database reads', /unit_cost/.test(p) && /msrp/.test(p), p);
  r.ok('it asks for blanks over estimates', /rather than estimating/.test(p), p);
  r.ok('it does not ask to approve a concept that is already approved', !/approve/i.test(p), p);
}
{
  const p = completionPrompt({ title: 'X' }, ['Approval']);
  r.ok('approval alone asks the person, and asks for no data', /only needs approval/.test(p) && !/missing:/i.test(p), p);
  const p2 = completionPrompt({ title: 'X' }, ['Approval', 'Retail price']);
  r.ok('approval is asked about after completion, never listed as a data field',
    /Once it is complete, ask me whether to approve/.test(p2) && !/missing: Approval/i.test(p2), p2);
}

process.exit(r.summary().fail ? 1 : 0);
