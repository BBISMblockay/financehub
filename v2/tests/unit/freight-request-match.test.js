/* Freight prefill on /v2/po-costing.html (v2/freight-request-match.js).
 *
 * The bug: both payment-request intake pages store the POs a freight invoice
 * covers as ONE text value joined with ", ", and Costing matched that value
 * with = against one PO name -- so a request shared by several POs never
 * prefilled any of them (2 of 15 freight requests on 2026-10-08).
 *
 * What must hold:
 *   - a request naming several POs is found from each of them
 *   - a lookalike name never matches ("PO-33" is not "PO-330")
 *   - a SHARED request never prefills its amount into one PO -- that would
 *     overstate landed cost once per PO -- it fills ref/carrier and says so
 *   - a single-PO request behaves exactly as before
 *   - a value already in the form is never overwritten
 *   - the newest matching request wins
 *   - the page loads the module and routes the prefill through it
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { loadV2, V2 } = require('../lib/load');

const r = createReporter('freight-request-match');
const F = loadV2(['freight-request-match.js']).SiloFreightMatch;

const SHARED = { amount_due: 3000, invoice_number: 'FX-77', vendor_name: 'Andes Logistics',
  internal_po_number: 'Creytex-329-s, Creytex-330, Creytex-331' };
const SINGLE = { amount_due: 812.5, invoice_number: 'FX-12', vendor_name: 'Andes Logistics',
  internal_po_number: 'Creytex-330' };
const LOOKALIKE = { amount_due: 99, invoice_number: 'FX-9', vendor_name: 'X', internal_po_number: 'PO-330' };
const EMPTY = { freight: '', ref: '', carrier: '' };

r.test('poNamesOf splits on commas, trims, drops blanks and repeats', () => {
  r.eq(F.poNamesOf('A,  B ,,C, A'), ['A', 'B', 'C']);
  r.eq(F.poNamesOf(null), []);
  r.eq(F.poNamesOf('  Creytex-330  '), ['Creytex-330']);
});

r.test('a shared request is found from every PO it names', () => {
  for (const po of ['Creytex-329-s', 'Creytex-330', 'Creytex-331']) {
    const m = F.pickFreightRequest([SHARED], po);
    r.ok(po, m && m.request === SHARED && m.shared === true);
  }
  r.eq(F.pickFreightRequest([SHARED], 'Creytex-331').others, ['Creytex-329-s', 'Creytex-330']);
});

r.test('a lookalike PO name never matches', () => {
  r.eq(F.pickFreightRequest([LOOKALIKE], 'PO-33'), null);
  r.eq(F.pickFreightRequest([LOOKALIKE], 'PO-3300'), null);
  r.eq(F.pickFreightRequest([SHARED], 'Creytex-33'), null);
  r.eq(F.pickFreightRequest([SHARED], 'Creytex-329'), null, 'not a prefix of Creytex-329-s');
  r.eq(F.pickFreightRequest([SHARED], ''), null);
});

r.test('the newest matching request wins (rows arrive newest first)', () => {
  const m = F.pickFreightRequest([LOOKALIKE, SINGLE, SHARED], 'Creytex-330');
  r.ok('single, the newer one', m.request === SINGLE && m.shared === false);
});

r.test('a single-PO request prefills amount, ref and carrier, as before', () => {
  const plan = F.prefillPlan(F.pickFreightRequest([SINGLE], 'Creytex-330'), EMPTY);
  r.eq(plan, { freight: '812.50', ref: 'FX-12', carrier: 'Andes Logistics' });
});

r.test('a shared request never prefills the amount; it says the invoice is shared', () => {
  const plan = F.prefillPlan(F.pickFreightRequest([SHARED], 'Creytex-330'), EMPTY);
  r.ok('no amount', !('freight' in plan));
  r.eq(plan.ref, 'FX-77');
  r.eq(plan.carrier, 'Andes Logistics');
  r.ok('notice names the other POs', /Creytex-329-s, Creytex-331/.test(plan.notice));
  r.ok('notice names the invoice and total', /FX-77/.test(plan.notice) && /\$3000\.00/.test(plan.notice));
  r.ok('notice asks for this PO\'s share', /share/.test(plan.notice));
  r.ok('notice points to Combined shipment', /Combined shipment/.test(plan.notice));
});

r.test('values already in the form are never overwritten', () => {
  const plan = F.prefillPlan(F.pickFreightRequest([SINGLE], 'Creytex-330'),
    { freight: '450', ref: 'MY-REF', carrier: 'Mine' });
  r.eq(plan, {});
  // A 0 or blank freight is "not entered", matching the page's old !Number() test.
  r.eq(F.prefillPlan(F.pickFreightRequest([SINGLE], 'Creytex-330'), { freight: '0', ref: 'x', carrier: 'y' }).freight, '812.50');
});

r.test('no match, or no amount, prefills nothing it does not have', () => {
  r.eq(F.prefillPlan(null, EMPTY), {});
  const noAmount = { ...SINGLE, amount_due: null };
  r.eq(F.prefillPlan(F.pickFreightRequest([noAmount], 'Creytex-330'), EMPTY), { ref: 'FX-12', carrier: 'Andes Logistics' });
});

r.test('page wiring: module loaded, routed through it, no exact-match lookup left', () => {
  const html = fs.readFileSync(path.join(V2, 'po-costing.html'), 'utf8');
  r.ok('script tag', html.includes('<script src="freight-request-match.js"></script>'));
  r.ok('uses pickFreightRequest', html.includes('SiloFreightMatch.pickFreightRequest('));
  r.ok('uses prefillPlan', html.includes('SiloFreightMatch.prefillPlan('));
  r.ok('no exact match on internal_po_number', !/\.eq\(\s*'internal_po_number'/.test(html));
  r.ok('still company-scoped', /prefillFreightFromPaymentRequest[\s\S]{0,1500}eq\('company_entity_id', _co\.id\)/.test(html));
  r.ok('notice element', html.includes('id="freightShareNote"'));
  r.ok('stale answer for another PO is dropped', html.includes("ctx?.header?.po_name !== poName"));
});

process.exit(r.summary().fail ? 1 : 0);
