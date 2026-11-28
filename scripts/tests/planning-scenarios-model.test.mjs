// The scenario planning model: revenue x mix / price, the historical-lift
// mode with its per-channel assumptions, the channel allocation and the
// inventory gap.
//
// These numbers are what someone commits a factory order to, and the compact
// page must agree with the page people use today, so each path is pinned to an
// arithmetic a reader can check by hand rather than to a snapshot.
//
// Run: node scripts/tests/planning-scenarios-model.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

await import('../../v2/planning-scenarios-model.js');   // sets globalThis.SiloScenarioModel
const M = globalThis.SiloScenarioModel;

/* One tidy company: two product types, two channels, a year of history.
   Last year (2025-01, 2025-02) only, so the planned months fall back to the
   same month a year earlier -- which is the normal case for a plan. */
const sales = [
  { month_key: '2025-01', product_type: 'Tees', location: 'online', units: 1000, net: 40000 },
  { month_key: '2025-01', product_type: 'Hats', location: 'scottsdale', units: 500, net: 10000 },
  { month_key: '2025-02', product_type: 'Tees', location: 'online', units: 500, net: 20000 },
  { month_key: '2025-02', product_type: 'Hats', location: 'scottsdale', units: 250, net: 5000 },
].map(M.mapSalesRow);

const inventory = [
  { product_title: 'Classic tee', sku: 'TEE-M', product_type: 'Tees', location_tag: 'online', total_available_quantity: 300, total_available_inventory_value: 9000, sold_30: 90, qty_365d: 1200 },
  { product_title: 'Logo hat', sku: 'HAT-OS', product_type: 'Hats', location_tag: 'scottsdale', total_available_quantity: 100, total_available_inventory_value: 2000, sold_30: 20, qty_365d: 400 },
].map(M.mapInventoryRow);

const openPo = [
  { product_title: 'Classic tee', sku: 'TEE-M', product_type: 'Tees', location_tag: 'online', incoming_units: 200, month_key: '2026-01', po_name: 'PO-1', factory_name: 'Acme' },
].map(M.mapOpenPORow);

const projections = [
  { projection_date: '2026-01-15', location_id: 7, projected_sales: 30000, scenario: 'active' },
  { projection_date: '2026-01-20', location_id: 8, projected_sales: 20000, scenario: 'active' },
  { projection_date: '2026-02-10', location_id: 7, projected_sales: 11000, scenario: 'draft' },
].map(M.mapProjRow);

const base = {
  sales, inventory, openPo, projections,
  filters: { planMode: 'revenue_plan', planSource: 'history', from: '2026-01', to: '2026-02', safetyPct: 0 },
  overrides: {},
};
const withFilters = (extra, overrides) => ({
  ...base,
  filters: { ...base.filters, ...extra },
  overrides: overrides || {},
});

test('a month with no history of its own is read from the same month a year earlier', () => {
  assert.equal(M.baselineMonthFor(sales, '2026-01'), '2025-01');
  assert.equal(M.baselineMonthFor(sales, '2025-02'), '2025-02');
  assert.equal(M.baselineMonthFor(sales, '2024-05'), '2024-05', 'nothing either side: the month stands');
});

test('channel comes from the row, and an unclassified location counts as retail', () => {
  assert.equal(M.channelOf({ location: 'online' }), 'online');
  assert.equal(M.channelOf({ location: 'faire_wholesale' }), 'wholesale');
  assert.equal(M.channelOf({ location: 'scottsdale' }), 'retail');
  assert.equal(M.channelOfInventory({ location_tag: 'pop_up_chicago' }), 'wholesale');
});

test('revenue plan: each month is plan x mix / price, and the lift is on top', () => {
  const s = M.computeScenario(withFilters({ productType: 'Tees' }), 0.25);
  const jan = s.monthRows.find((r) => r.month === '2026-01');
  // January 2025: $50,000 of revenue, $40,000 of it Tees, 1,000 Tees units.
  assert.equal(jan.last_year, 50000);
  assert.equal(jan.plan_revenue, 50000);
  assert.equal(Number(jan.mix.toFixed(4)), 0.8);
  assert.equal(jan.asp, 40);
  assert.equal(jan.product_revenue, 50000 * 0.8 * 1.25);
  assert.equal(jan.units, (50000 * 0.8 * 1.25) / 40);
  const feb = s.monthRows.find((r) => r.month === '2026-02');
  assert.equal(feb.product_revenue, 25000 * 0.8 * 1.25);
  assert.equal(s.total.revenue, jan.product_revenue + feb.product_revenue);
  assert.equal(Math.round(s.total.units), Math.round(jan.units + feb.units));
});

test('the gap is what the plan needs beyond stock on hand and open POs', () => {
  const s = M.computeScenario(withFilters({ productType: 'Tees', safetyPct: 0.1 }), 0.25);
  assert.equal(s.total.on_hand, 300);
  assert.equal(s.total.incoming_po_units, 200);
  assert.equal(s.total.available_units, 500);
  assert.equal(s.total.gap, Math.ceil(s.total.units - 500));
  assert.equal(s.total.gap_buffer, Math.max(0, Math.ceil(s.total.gap + s.total.units * 0.1)));
  const covered = M.computeScenario(withFilters({ productType: 'Tees' }), -1);
  assert.equal(covered.total.gap_buffer, 0, 'a plan under cover never reports a negative buy');
});

test('plan from Projections uses them, and falls back to history for a month they do not cover', () => {
  const s = M.computeScenario(withFilters({ productType: 'Tees', planSource: 'projections' }), 0);
  const jan = s.monthRows.find((r) => r.month === '2026-01');
  assert.equal(jan.plan_revenue, 50000, 'both locations, the active scenario only');
  assert.equal(jan.plan_source, 'projections');
  const feb = s.monthRows.find((r) => r.month === '2026-02');
  assert.equal(feb.plan_revenue, 25000);
  assert.equal(feb.plan_source, 'history', 'a draft projection is not the plan');

  const oneLoc = M.computeScenario(withFilters({ productType: 'Tees', planSource: 'projections', locationId: 7 }), 0);
  assert.equal(oneLoc.monthRows[0].plan_revenue, 30000);
  const draft = M.computeScenario(withFilters({ productType: 'Tees', planSource: 'projections', projScenario: 'draft' }), 0);
  assert.equal(draft.monthRows.find((r) => r.month === '2026-02').plan_revenue, 11000);
});

/* Review of PR #1427, P1: a projection is stored per location and carries no
 * channel, so with Online selected the plan was every location's projection
 * added together -- the retail revenue inflated the Online plan. */
test('a projection belongs to its location\'s channel, so a channel filter narrows the plan', () => {
  const locations = [
    { id: 7, location_code: 'online', location_name: 'Online', store_type: 'online' },
    { id: 8, location_code: 'scottsdale', location_name: 'Scottsdale', store_type: 'retail' },
  ];
  const ctx = (extra) => ({
    ...base,
    locations,
    filters: { ...base.filters, productType: 'Tees', planSource: 'projections', ...extra },
    overrides: {},
  });

  assert.equal(M.channelOfLocation(locations[0]), 'online');
  assert.equal(M.channelOfLocation(locations[1]), 'retail');
  assert.equal(M.channelOfLocation({ location_code: 'faire_wholesale' }), 'wholesale',
    'no store_type: the name still classifies it');
  assert.equal(M.channelOfLocation({ location_code: 'shop_33', store_type: 'ecommerce' }), 'online',
    'store_type is read first, even when the name says nothing');

  const all = M.computeScenario(ctx({}), 0);
  assert.equal(all.monthRows[0].plan_revenue, 50000, 'every channel: both locations');

  const online = M.computeScenario(ctx({ channel: 'online' }), 0);
  assert.equal(online.monthRows[0].plan_revenue, 30000, 'Online only, not 50000');
  assert.equal(online.monthRows[0].plan_source, 'projections');

  const retail = M.computeScenario(ctx({ channel: 'retail' }), 0);
  assert.equal(retail.monthRows[0].plan_revenue, 20000);

  // a channel with no projection of its own falls back to history, it is not zero
  const wholesale = M.computeScenario(ctx({ channel: 'wholesale' }), 0);
  assert.equal(wholesale.monthRows[0].plan_source, 'history');

  // an unclassified location is left out of a channel's plan, never counted in
  const unknown = M.computeScenario({
    ...ctx({ channel: 'online' }),
    locations: [{ id: 7, location_code: 'online', store_type: 'online' }],
  }, 0);
  assert.equal(unknown.monthRows[0].plan_revenue, 30000);

  // with no locations in context there is nothing to attribute by
  const noLocs = M.computeScenario({ ...ctx({ channel: 'online' }), locations: [] }, 0);
  assert.equal(noLocs.monthRows[0].plan_revenue, 50000);
});

test('a typed plan, mix or price wins over the history, and says so', () => {
  const s = M.computeScenario(withFilters({ productType: 'Tees' }, {
    rev: { '2026-01': 100000 }, mix: { '2026-01': 50 }, asp: { '2026-01': 25 },
  }), 0);
  const jan = s.monthRows.find((r) => r.month === '2026-01');
  assert.equal(jan.plan_revenue, 100000);
  assert.equal(jan.mix, 0.5);
  assert.equal(jan.asp, 25);
  assert.equal(jan.product_revenue, 50000);
  assert.equal(jan.units, 2000);
  assert.deepEqual([jan.plan_source, jan.mix_source, jan.asp_source], ['typed', 'typed', 'typed']);
  assert.equal(jan.auto_revenue, 50000, 'the automatic value is kept, so clearing the box restores it');
});

test('channels are allocated on their share of baseline revenue', () => {
  const s = M.computeScenario(withFilters({}), 0);   // all product types
  const online = s.rows.find((r) => r.key === 'online');
  const retail = s.rows.find((r) => r.key === 'retail');
  // Baseline over both months: online 60,000, retail 15,000 -> 80% / 20%.
  assert.equal(Number((online.revenue / s.total.revenue).toFixed(4)), 0.8);
  assert.equal(Number((retail.revenue / s.total.revenue).toFixed(4)), 0.2);
  assert.equal(online.incoming_po_units, 200 * 0.8);
  assert.equal(Math.round(online.revenue + retail.revenue), Math.round(s.total.revenue));
});

test('historical lift: last year\'s units grown, priced at last year\'s price', () => {
  // Historical lift grows the actuals IN the range, so the range is the year
  // being grown -- it does not fall back to the prior year the way the revenue
  // plan does. That is the live page's behaviour and is kept deliberately.
  const s = M.computeScenario(withFilters({ planMode: 'historical', productType: 'Tees', from: '2025-01', to: '2025-02' }), 0.2);
  const online = s.rows.find((r) => r.key === 'online');
  assert.equal(online.hist_units, 1500);          // 1,000 + 500
  assert.equal(online.hist_asp, 40);              // 60,000 / 1,500
  assert.equal(online.units, 1800);
  assert.equal(online.revenue, 72000);
  assert.equal(s.total.units, 1800);
});

test('historical lift honours the per-channel assumptions, one at a time', () => {
  const chan = (overrides, lift = 0) => M.computeScenario(
    withFilters({ planMode: 'historical', productType: 'Tees', from: '2025-01', to: '2025-02' }, { channels: overrides }), lift,
  ).rows.find((r) => r.key === 'online');

  assert.equal(chan({ online: { bucketLift: 0.1 } }, 0.2).units, 1500 * 1.3, 'bucket lift adds to the scenario lift');
  assert.equal(chan({ online: { aspOverride: 50 } }).revenue, 1500 * 50);
  assert.equal(chan({ online: { aspChange: 0.25 } }).plan_asp, 50);
  const rev = chan({ online: { revenueOverride: 30000 } });
  assert.equal(rev.revenue, 30000);
  assert.equal(rev.units, 750);
  assert.equal(rev.mode, 'bucket revenue override');
  const off = chan({ online: { enabled: false } });
  assert.equal(off.revenue, 0);
  assert.equal(off.units, 0);
  assert.equal(off.mode, 'disabled');
});

test('a total revenue override is split by each channel\'s own mix', () => {
  const s = M.computeScenario(
    { ...base, filters: { ...base.filters, planMode: 'historical', from: '2025-01', to: '2025-02', totalRevenueOverride: 100000 } }, 0,
  );
  const online = s.rows.find((r) => r.key === 'online');
  const retail = s.rows.find((r) => r.key === 'retail');
  assert.equal(online.revenue, 80000);   // 60,000 of 75,000 baseline
  assert.equal(retail.revenue, 20000);
  assert.equal(online.mode, 'total revenue × mix');
});

test('the product-family search narrows inventory and POs, not the revenue plan', () => {
  const { inventory: inv, openPo: po, sales: sal } = M.filterRows(
    { sales, inventory, openPo }, { productType: '__ALL__', channel: '__ALL__', productSearch: 'hat', from: '', to: '' },
  );
  assert.equal(inv.length, 1);
  assert.equal(inv[0].sku, 'HAT-OS');
  assert.equal(po.length, 0);
  assert.equal(sal.length, 4, 'the monthly revenue rollup has no product title to search');
});

test('the ladder runs every scenario on the same assumptions', () => {
  const ladder = M.computeLadder(withFilters({ productType: 'Tees' }));
  assert.equal(ladder.length, M.SCENARIOS.length);
  assert.equal(ladder[0].total.revenue, M.computeScenario(withFilters({ productType: 'Tees' }), 0).total.revenue);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i].total.revenue > ladder[i - 1].total.revenue, 'more growth is more revenue');
  }
});

test('the monthly facts handed to the AI carry history, not row data', () => {
  const facts = M.monthlyFacts(withFilters({ productType: 'Tees', planSource: 'projections' }));
  assert.deepEqual(facts.map((r) => r.month), ['2026-01', '2026-02']);
  assert.deepEqual(Object.keys(facts[0]).sort(), [
    'asp', 'asp_source', 'auto_asp', 'auto_mix', 'auto_revenue', 'baseline_month',
    'last_year', 'mix', 'mix_source', 'month', 'plan_revenue', 'plan_source', 'projection',
  ]);
});

test('product families pool inventory and incoming units per product', () => {
  const fams = M.productFamilies(inventory, openPo);
  const tee = fams.find((f) => f.product === 'Classic tee');
  assert.equal(tee.avail_qty, 300);
  assert.equal(tee.incoming_units, 200);
  assert.equal(tee.sku_count, 1);
});

test('months are listed from the range, not from what history happens to have', () => {
  assert.deepEqual(M.selectMonths(sales, { from: '2026-01', to: '2026-03' }), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(M.selectMonths(sales, { from: '', to: '' }), ['2025-01', '2025-02']);
  assert.equal(M.addMonths('2025-12', 1), '2026-01');
});

/* --- the scenario half of the projection-draft function ------------------ */
import {
  buildScenarioMessage, clampScenarioAnswer, readScenarioToolUse, validateScenarioRequest,
} from '../../supabase/functions/projection-draft/draft-lib.mjs';

const MONTHS = [
  { month: '2026-01', last_year: 50000, projection: 52000, plan: 52000, mix_pct: 80, price: 40 },
  { month: '2026-02', last_year: 25000, projection: 0, plan: 25000, mix_pct: 80, price: 40 },
];

test('a scenario request is refused unless it names months and an ask', () => {
  assert.match(validateScenarioRequest({}).error, /instruction is required/);
  assert.match(validateScenarioRequest({ instruction: 'grow' }).error, /months is required/);
  assert.match(validateScenarioRequest({ instruction: 'grow', months: [{ month: 'nope' }] }).error, /YYYY-MM/);
  assert.match(
    validateScenarioRequest({ instruction: 'grow', months: Array.from({ length: 60 }, () => ({ month: '2026-01' })) }).error,
    /at most 48 months/,
  );
  const ok = validateScenarioRequest({ instruction: ' push outerwear ', months: MONTHS, product_type: 'Tees', plan_mode: 'historical' });
  assert.equal(ok.instruction, 'push outerwear');
  assert.equal(ok.months.length, 2);
  assert.equal(ok.planMode, 'historical');
  assert.equal(ok.channel, '__ALL__');
});

test('the scenario prompt carries the months and the scope, and nothing else', () => {
  const msg = buildScenarioMessage(validateScenarioRequest({ instruction: 'grow 25%', months: MONTHS, product_type: 'Tees' }));
  assert.match(msg, /product type Tees, channel all/);
  assert.match(msg, /2026-01 50000 52000 52000 80 40/);
  assert.match(msg, /2026-02 25000 none 25000 80 40/, 'no projection is "none", never 0');
  assert.match(msg, /grow 25%/);
});

test('a scenario answer is clamped to the months offered and to sane values', () => {
  const out = clampScenarioAnswer({
    rationale: 'Grew 25%.',
    growth_pct: 25,
    months: [
      { month: '2026-01', plan_revenue: 60000, mix_pct: 85.456, price: 41.239 },
      { month: '2026-03', plan_revenue: 60000 },          // not offered
      { month: '2026-02', mix_pct: 140 },                 // not a percentage
      { month: '2026-02', price: -3 },                    // not a price
    ],
  }, MONTHS);
  assert.equal(out.growth_pct, 25);
  assert.deepEqual(out.months, [{ month: '2026-01', plan_revenue: 60000, mix_pct: 85.46, price: 41.24 }]);
  assert.equal(out.rationale, 'Grew 25%.');
  assert.equal(clampScenarioAnswer({}, MONTHS).growth_pct, 0, 'no growth given is no growth, not NaN');
  assert.equal(clampScenarioAnswer({ growth_pct: 9000 }, MONTHS).growth_pct, 500, 'an absurd lift is capped');
});

test('an answer with no tool call sets nothing', () => {
  const r = clampScenarioAnswer(readScenarioToolUse({ content: [{ type: 'text', text: 'I cannot' }] }), MONTHS);
  assert.deepEqual(r.months, []);
  assert.equal(r.growth_pct, 0);
  const good = readScenarioToolUse({ content: [{ type: 'tool_use', name: 'set_scenario', input: { growth_pct: 10, months: [] } }] });
  assert.equal(good.growth_pct, 10);
});
