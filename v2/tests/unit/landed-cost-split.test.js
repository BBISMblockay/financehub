/* How a freight bill is spread over the units it paid for
 * (pages/po-costing-lib.js, used by /v2/po-costing.html Step 3).
 *
 * The rules these pin, and why each one is here:
 *
 *  - A split SUMS TO THE BILL, to the cent. Proportional division leaves a
 *    remainder; left alone the line shares disagree with the invoice, which is
 *    the whole thing the bill bank exists to prevent.
 *  - An allocation naming a SHIPMENT reaches that shipment's lines only. The
 *    bug this replaces spread the first container's freight over every line on
 *    the PO, including units still at the factory.
 *  - An allocation that reaches NO line is REPORTED, never quietly spread
 *    elsewhere or dropped. Silently moving money is how $27,502 of freight
 *    came to be counted twice on production before this.
 *  - Without the bank (a failed read), the old typed totals are used
 *    unchanged. Recomputing freight as 0 because a query errored would erase a
 *    PO's landed cost, which is worse than showing a stale figure.
 *
 * Run: node v2/tests/unit/landed-cost-split.test.js
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadPages } = require('../lib/load');

const r = createReporter('landed-cost-split');
const Lib = loadPages(['po-costing-lib.js']).PoCostingLib;

const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
const cents = (n) => Math.round(n * 100) / 100;

// ── allocateToCents ─────────────────────────────────────────────────────────

r.test('a split sums to the bill exactly', () => {
  // The production case: ARJFK261001106, $5,531.00 across four MasterCap POs,
  // weighed by factory value. Typed by hand it came to $3,999 and left $1,532
  // of paid freight nowhere.
  const shares = Lib.allocateToCents(5531, [8709.25, 1771, 1380, 1335]);
  r.eq(sum(shares), 5531, 'shares must total the bill');
  r.eq(shares.length, 4);
});

r.test('a remainder that cannot divide evenly still totals', () => {
  // 1/3 of a cent three ways.
  const shares = Lib.allocateToCents(0.01, [1, 1, 1]);
  r.eq(sum(shares), 0.01);
  r.eq(shares.filter((s) => s > 0).length, 1, 'exactly one line takes the cent');
});

r.test('100 equal targets still total', () => {
  const shares = Lib.allocateToCents(1000.01, new Array(100).fill(1));
  r.eq(sum(shares), 1000.01);
});

r.test('zero total weight splits evenly rather than dropping the money', () => {
  // A PO whose lines have no cost or no quantity typed yet. Losing the freight
  // would be worse than spreading it.
  const shares = Lib.allocateToCents(100, [0, 0, 0, 0]);
  r.eq(sum(shares), 100);
  r.eq(shares, [25, 25, 25, 25]);
});

r.test('no targets returns nothing rather than throwing', () => {
  r.eq(Lib.allocateToCents(100, []), []);
});

r.test('the split is deterministic, not order-of-floating-point', () => {
  const a = Lib.allocateToCents(7887.5, [1000, 1000, 1000, 1]);
  const b = Lib.allocateToCents(7887.5, [1000, 1000, 1000, 1]);
  r.eq(a, b);
});

// ── spreadAllocations ───────────────────────────────────────────────────────

const LINES = [
  { id: 'l1', sku_snapshot: 'A', unit_cost: 10, qty: 100 },
  { id: 'l2', sku_snapshot: 'B', unit_cost: 10, qty: 100 },
  { id: 'l3', sku_snapshot: 'C', unit_cost: 10, qty: 100 },
  { id: 'l4', sku_snapshot: 'D', unit_cost: 10, qty: 100 },
];
const rows = () => LINES.map((line) => ({
  line, o: {}, qty: line.qty, fobUnit: line.unit_cost, fobExt: line.qty * line.unit_cost,
}));

// Two containers: the first carried l1 and l2, the second l3 and l4.
const SHIP_LINES = [
  { shipment_id: 's1', po_line_id: 'l1', qty: 100 },
  { shipment_id: 's1', po_line_id: 'l2', qty: 100 },
  { shipment_id: 's2', po_line_id: 'l3', qty: 100 },
  { shipment_id: 's2', po_line_id: 'l4', qty: 100 },
];

r.test("a container's freight reaches that container's units only", () => {
  const out = Lib.spreadAllocations(
    rows(),
    [{ amount: 400, shipment_id: 's1', cost_bucket: 'freight', method: 'units' }],
    SHIP_LINES,
  );
  r.eq(out.byLine.l1.freight, 200, 'l1');
  r.eq(out.byLine.l2.freight, 200, 'l2');
  r.eq(out.byLine.l3.freight, 0, 'l3 was still at the factory');
  r.eq(out.byLine.l4.freight, 0, 'l4 was still at the factory');
  r.eq(out.unplaced.length, 0);
});

r.test('two containers each carry their own bill', () => {
  const out = Lib.spreadAllocations(
    rows(),
    [
      { amount: 400, shipment_id: 's1', cost_bucket: 'freight', method: 'units' },
      { amount: 1000, shipment_id: 's2', cost_bucket: 'freight', method: 'units' },
    ],
    SHIP_LINES,
  );
  r.eq(out.byLine.l1.freight, 200);
  r.eq(out.byLine.l3.freight, 500);
  r.eq(out.totals.freight, 1400);
});

r.test('an allocation with no shipment is the whole PO', () => {
  const out = Lib.spreadAllocations(
    rows(), [{ amount: 400, shipment_id: null, cost_bucket: 'freight', method: 'units' }], SHIP_LINES,
  );
  r.eq(LINES.map((l) => out.byLine[l.id].freight), [100, 100, 100, 100]);
});

r.test('a shipment with no lines recorded is reported, not spread elsewhere', () => {
  const out = Lib.spreadAllocations(
    rows(), [{ amount: 400, shipment_id: 's9', cost_bucket: 'freight', method: 'units' }], SHIP_LINES,
  );
  r.eq(out.unplaced.length, 1, 'one unplaced allocation');
  r.eq(out.unplaced[0].reason, 'no_lines');
  r.eq(LINES.map((l) => out.byLine[l.id].freight), [0, 0, 0, 0], 'nothing landed anywhere');
  r.eq(out.totals.freight, 400, 'the money is still counted as on this PO');
});

r.test('a shipment line with null qty weighs the whole PO line', () => {
  // null means "this line's whole quantity" in incoming_shipment_lines.
  const out = Lib.spreadAllocations(
    rows(),
    [{ amount: 400, shipment_id: 's1', cost_bucket: 'freight', method: 'units' }],
    [{ shipment_id: 's1', po_line_id: 'l1', qty: null }, { shipment_id: 's1', po_line_id: 'l2', qty: null }],
  );
  r.eq(out.byLine.l1.freight, 200);
  r.eq(out.byLine.l2.freight, 200);
});

r.test('a partial shipment weighs the units that travelled', () => {
  const out = Lib.spreadAllocations(
    rows(),
    [{ amount: 300, shipment_id: 's1', cost_bucket: 'freight', method: 'units' }],
    [{ shipment_id: 's1', po_line_id: 'l1', qty: 50 }, { shipment_id: 's1', po_line_id: 'l2', qty: 100 }],
  );
  r.eq(out.byLine.l1.freight, 100);
  r.eq(out.byLine.l2.freight, 200);
});

r.test('duty and brokerage bills land in their own buckets', () => {
  const out = Lib.spreadAllocations(
    rows(),
    [
      { amount: 400, cost_bucket: 'freight', method: 'units' },
      { amount: 800, cost_bucket: 'duty', method: 'units' },
      { amount: 40, cost_bucket: 'misc', method: 'units' },
    ],
    [],
  );
  r.eq(out.totals, { freight: 400, duty: 800, misc: 40 });
  r.eq(out.byLine.l1, { freight: 100, duty: 200, misc: 10 });
});

r.test('a tariff bill is duty, matching the view', () => {
  const out = Lib.spreadAllocations(rows(), [{ amount: 100, kind: 'tariff', method: 'units' }], []);
  r.eq(out.totals.duty, 100);
});

// ── computeCosting through the bank ─────────────────────────────────────────

const header = { freight: 9999, duty_pct: 0, misc: 7777, alloc_method: 'proportional' };

r.test('with the bank read, the typed totals are ignored', () => {
  const res = Lib.computeCosting(LINES, header, {}, {
    allocationsLoaded: true,
    allocations: [{ amount: 400, cost_bucket: 'freight', method: 'units' }],
    shipmentLines: [],
  });
  r.eq(res.freight, 400, 'freight is what bills put here');
  r.eq(res.misc, 0, 'misc too');
  r.truthy(res.from_bank, 'from_bank flags which source was used');
  r.eq(cents(res.landed_total), cents(4000 + 400));
});

r.test('without the bank, the stored totals are used unchanged', () => {
  // A failed allocation read must not recompute freight as zero.
  const res = Lib.computeCosting(LINES, { ...header, freight: 1200, misc: 0 }, {});
  r.eq(res.freight, 1200);
  r.eq(res.from_bank, false);
});

r.test('a line override still beats the bill', () => {
  const res = Lib.computeCosting(LINES, header, { l1: { freight_alloc: 350 } }, {
    allocationsLoaded: true,
    allocations: [{ amount: 400, cost_bucket: 'freight', method: 'units' }],
    shipmentLines: [],
  });
  r.eq(res.lines[0].freight_alloc, 350);
});

r.test('duty is the typed percentage plus any duty bill', () => {
  const res = Lib.computeCosting(LINES, { ...header, duty_pct: 10 }, {}, {
    allocationsLoaded: true,
    allocations: [{ amount: 100, cost_bucket: 'duty', method: 'units' }],
    shipmentLines: [],
  });
  // FOB is 4,000; 10% is 400, plus the 100 bill.
  r.eq(cents(res.duty_amount), 500);
  r.eq(cents(res.lines.reduce((s, l) => s + l.duty_alloc, 0)), 500, 'the lines agree with the KPI');
});

r.test('the line shares add back up to the bill', () => {
  const res = Lib.computeCosting(LINES, header, {}, {
    allocationsLoaded: true,
    allocations: [
      { amount: 5531, cost_bucket: 'freight', method: 'value' },
      { amount: 3839.99, cost_bucket: 'freight', method: 'units' },
    ],
    shipmentLines: [],
  });
  r.eq(cents(res.lines.reduce((s, l) => s + l.freight_alloc, 0)), 9370.99);
  r.eq(res.freight, 9370.99);
});

// ── the page no longer offers to overwrite the factory cost ─────────────────

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/load');
const LIB_SRC = fs.readFileSync(path.join(REPO_ROOT, 'pages', 'po-costing-lib.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'po-costing.html'), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

r.test('nothing pushes the landed unit back onto po_lines.unit_cost', () => {
  // That default inflated 134 production PO lines, and every PO total that
  // sums po_lines.unit_cost with them, by $59,620.
  r.not(code(LIB_SRC), 'pushLandedToPoLines', 'the option is gone from the library');
  r.not(code(PAGE_SRC), 'chkPushLanded', 'and its checkbox from the page');
});

r.test('the freight total is not a field anyone types', () => {
  r.not(code(PAGE_SRC), 'id="inFreight"', 'no freight input');
  r.not(code(PAGE_SRC), 'id="inMisc"', 'no misc input');
  r.has(code(PAGE_SRC), 'id="freightBillList"', 'the bills are listed instead');
});

const res = r.summary();
process.exit(res.fail ? 1 : 0);
