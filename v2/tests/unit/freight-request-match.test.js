/* Freight prefill on /v2/po-costing.html (v2/freight-request-match.js).
 *
 * The bug: both payment-request intake pages store the POs a freight invoice
 * covers as ONE text value joined with ", ", and Costing matched that value
 * with = against one PO name -- so a request shared by several POs never
 * prefilled any of them (2 of 15 freight requests list more than one name on
 * 2026-10-08: one names two POs, one is a PO plus a typed description).
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
  r.ok('notice quotes what else the request lists', /also lists: Creytex-329-s, Creytex-331/.test(plan.notice));
  r.ok('notice offers the only-this-PO reading too', /covers only this PO, enter the full amount/.test(plan.notice));
  r.ok('notice never asserts the invoice is shared', !/is shared with/.test(plan.notice));
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
  r.ok('pages through requests', html.includes('SiloFreightMatch.findFreightRequest(') && html.includes('.range(from, to)'));
  r.ok('no fixed scan window', !/FREIGHT_REQUEST_SCAN|\.limit\(\s*FREIGHT/.test(html));
  r.ok('stable order for paging', /order\('created_at'[^)]*\)\s*\.order\('id'/.test(html));
  r.ok('uses prefillPlan', html.includes('SiloFreightMatch.prefillPlan('));
  r.ok('no exact match on internal_po_number', !/\.eq\(\s*'internal_po_number'/.test(html));
  r.ok('still company-scoped', /prefillFreightFromPaymentRequest[\s\S]{0,1500}eq\('company_entity_id', _co\.id\)/.test(html));
  r.ok('notice element', html.includes('id="freightShareNote"'));
  r.ok('a lookup belongs to the fill that started it', html.includes("seq === freightLookupSeq && ctx?.header?.po_name === poName"));
  r.ok('every form fill retires the lookup in flight', /const freightSeq = \+\+freightLookupSeq;[\s\S]{0,300}prefillFreightFromPaymentRequest\(ctx\.header\.po_name, freightSeq\)/.test(html));
  r.ok('a stale answer is dropped', /if \(!current\(\)\) return;/.test(html));
  r.ok('a failed lookup is shown only for the current fill', /catch \(err\)[\s\S]{0,300}if \(current\(\) && note\)[\s\S]{0,200}SiloFreightMatch\?\.LOOKUP_FAILED/.test(html));
});

r.test('the failure message says nothing was prefilled', () => {
  r.ok('names the failure', /Could not check freight requests/.test(F.LOOKUP_FAILED));
  r.ok('says nothing was prefilled', /nothing was prefilled/.test(F.LOOKUP_FAILED));
});

// ── paging (async) ──────────────────────────────────────────────────────────
(async () => {
  const OTHER = (i) => ({ amount_due: 1, invoice_number: 'X' + i, vendor_name: 'v', internal_po_number: 'Other-' + i });
  // 1,203 requests newest first; the only one naming Old-1 is the 1,201st.
  const ALL = Array.from({ length: 1203 }, (_, i) => OTHER(i));
  ALL[1200] = { amount_due: 55, invoice_number: 'OLD', vendor_name: 'v', internal_po_number: 'Old-1' };
  const calls = [];
  const fetchPage = async (from, to) => { calls.push([from, to]); return { data: ALL.slice(from, to + 1), error: null }; };

  try {
    const res = await F.findFreightRequest(fetchPage, 'Old-1', 500);
    r.ok('a request beyond the first pages is still found', res.match && res.match.request.invoice_number === 'OLD');
    r.eq(calls, [[0, 499], [500, 999], [1000, 1499]], 'pages requested in order, stopping at the match');

    calls.length = 0;
    const none = await F.findFreightRequest(fetchPage, 'Nope', 500);
    r.ok('no match: walks to the end and stops on the empty page', none.match === null && calls.length === 4);
    r.eq(calls[3], [1203, 1702], 'the next page starts after the rows actually returned');

    // A server capping pages below the asked size (PostgREST max-rows) must
    // not read as the end: every page here is "short".
    const capped = [];
    const cappedFetch = async (from, to) => { capped.push(from); return { data: ALL.slice(from, Math.min(to + 1, from + 100)), error: null }; };
    const deep = await F.findFreightRequest(cappedFetch, 'Old-1', 500);
    r.ok('a request beyond a server cap is still found', deep.match && deep.match.request.invoice_number === 'OLD');
    r.eq(capped.slice(0, 3), [0, 100, 200], 'pages advance by the rows returned');

    // An exact multiple of the page size ends on an empty page, not a loop.
    const EXACT = Array.from({ length: 1000 }, (_, i) => OTHER(i));
    let n = 0;
    const exact = await F.findFreightRequest(async (a, b) => { n += 1; return { data: EXACT.slice(a, b + 1), error: null }; }, 'Nope', 500);
    r.ok('exact multiple of the page ends on the empty page', exact.match === null && n === 3);

    let threw = false;
    try { await F.findFreightRequest(async () => ({ data: null, error: new Error('boom') }), 'X', 500); }
    catch (e) { threw = /boom/.test(e.message); }
    r.ok('a page error rejects (never read as "no request")', threw);
  } catch (e) {
    r.ok('paging tests threw: ' + e.message, false);
  }
  process.exit(r.summary().fail ? 1 : 0);
})();
