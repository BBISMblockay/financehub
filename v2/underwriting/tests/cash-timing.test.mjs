import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCashTimingStress, emptyCashTimingAssumptions } from '../cash-timing.js';
import { computeScenario } from '../scenario-model.js';
import { assessFundingCapacity } from '../capacity-model.js';

// Preflight, before implementation: the new helper has no existing call sites;
// workspace will apply it before computeScenario and assessFundingCapacity.
// It has no I/O, persistence, database policy/grant, retry or destructive path.
// The two fixed receipt pools must never be inferred from sales, PO arrivals,
// inventory value, or borrowing availability. Actual receipts, cash-baseline
// inclusion and nonoverlap remain user-reviewed facts, not proven by fixtures.
// Partial or contradictory enabled inputs return model:null; nothing is partly
// applied. Repeat/concurrent calls have no shared state and preserve the input.
const scenario = (overrides = {}) => ({
  currency: 'USD', startMonth: '2026-01', horizonMonths: 4,
  startingCash: 1000, requiredCashFloor: 100,
  normalizedPreDebtCash: { monthlyAmount: 300, provenance: 'Synthetic normalized cash forecast' },
  existingDebt: { monthlyPayment: 100, complete: true, provenance: 'Synthetic debt schedule' },
  proposal: null, growth: { growthPct: 0 },
  cashCommitments: { complete: true, items: [] },
  stress: { revenueDeclinePct: 0, marginCompressionPct: 0 },
  monthlyOverrides: [], ...overrides,
});
const transfer = (overrides = {}) => ({
  enabled: true, amount: 200, baselineReceipts: 900,
  fromMonth: '2026-01', toMonth: '2026-03',
  sourceReference: 'Synthetic receivables pool A, retained in forecast',
  reviewed: true, ...overrides,
});
const assumptions = (collections = {}, inventory = null, extra = {}) => ({
  ...emptyCashTimingAssumptions(), collections: transfer(collections),
  ...(inventory ? { inventory: transfer({ sourceReference: 'Synthetic inventory-receipt pool B', ...inventory }) } : {}),
  ...extra,
});
const total = (rows, field) => rows.reduce((sum, row) => sum + Math.round(row[field] * 100), 0) / 100;
const blocked = (input, pattern) => {
  const result = applyCashTimingStress(scenario(), input);
  assert.equal(result.ready, false);
  assert.equal(result.model, null);
  assert.equal(result.impactRows.length, 0);
  assert.equal(result.totalDelayed, null);
  if (pattern) assert.match(result.issues.join(' '), pattern);
  return result;
};
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test('disabled timing is an exact no-op, even with stale unused draft values', () => {
  const input = scenario();
  const inactive = emptyCashTimingAssumptions();
  inactive.inventory.amount = -5;
  const result = applyCashTimingStress(input, inactive);
  assert.equal(result.ready, true);
  assert.equal(result.enabled, false);
  assert.equal(result.model, input);
  assert.deepEqual(result.impactRows, []);
  assert.equal(result.totalDelayed, 0);
  assert.equal(result.recoveryBeyondHorizon, 0);
  assert.equal(result.totalCashImpact, 0);
  assert.deepEqual(computeScenario(result.model), computeScenario(input));
});

test('default timing objects are independent and unknown amounts never default to zero', () => {
  const a = emptyCashTimingAssumptions(), b = emptyCashTimingAssumptions();
  assert.equal(a.collections.amount, null);
  assert.equal(a.inventory.baselineReceipts, null);
  assert.equal(a.collections.enabled, false);
  assert.equal(a.collections.reviewed, false);
  assert.equal(a.distinctReceiptPoolsReviewed, false);
  a.collections.amount = 25;
  assert.equal(b.collections.amount, null);
  assert.equal(a.inventory.amount, null);
});

test('missing timing structure or nonboolean enabled flag cannot silently disable stress', () => {
  for (const value of [undefined, null, [], {}, { collections: { enabled: 'true' }, inventory: { enabled: false } }]) blocked(value, /explicit|object|enabled/i);
});

test('slower collections moves existing cash once and conserves total in-horizon receipts', () => {
  const input = scenario();
  const baseline = computeScenario(input);
  const result = applyCashTimingStress(input, assumptions());
  assert.equal(result.ready, true); assert.deepEqual(result.issues, []);
  const adjusted = computeScenario(result.model);
  assert.deepEqual(adjusted.errors, []);
  assert.deepEqual(adjusted.rows.map(row => row.preDebtCash), [100, 300, 500, 300]);
  assert.equal(adjusted.rows[0].closingCash, baseline.rows[0].closingCash - 200);
  assert.equal(adjusted.rows[1].closingCash, baseline.rows[1].closingCash - 200);
  assert.equal(adjusted.rows[2].closingCash, baseline.rows[2].closingCash);
  assert.equal(adjusted.summary.endingCash, baseline.summary.endingCash);
  assert.equal(adjusted.summary.totalPreDebtCash, baseline.summary.totalPreDebtCash);
  assert.equal(adjusted.rows[0].dscr, 1);
  assert.equal(adjusted.rows[2].dscr, 5);
  assert.equal(result.totalDelayed, 200);
  assert.equal(result.recoveryBeyondHorizon, 0);
  assert.equal(result.totalCashImpact, 0);
  assert.deepEqual(result.impactRows.map(row => [row.month, row.cashDelta]), [['2026-01', -200], ['2026-03', 200]]);
});

test('recovery beyond the horizon remains missing cash with a dated warning', () => {
  const input = scenario();
  const result = applyCashTimingStress(input, assumptions({ toMonth: '2026-08' }));
  const adjusted = computeScenario(result.model), baseline = computeScenario(input);
  assert.equal(result.ready, true);
  assert.equal(result.recoveryBeyondHorizon, 200);
  assert.equal(result.totalCashImpact, -200);
  assert.equal(adjusted.summary.endingCash, baseline.summary.endingCash - 200);
  assert.equal(adjusted.summary.totalPreDebtCash, baseline.summary.totalPreDebtCash - 200);
  assert.equal(result.impactRows.length, 1);
  assert.equal(result.transfers[0].recoveryInHorizon, false);
  assert.match(result.warnings.join(' '), /2026-08.*outside|outside.*2026-08/i);
});

test('inventory cash recovery is delayed without moving PO payments, WC, other uses or debt', () => {
  const input = scenario({
    growth: { growthPct: 10, baselineInventory: 600, spreadMonths: 3, provenance: 'Synthetic growth inventory cash' },
    monthlyOverrides: [{ month: '2026-01', otherCashUse: 25, provenanceByField: { otherCashUse: 'Synthetic separate use' } }],
    cashCommitments: { complete: true, items: [{ id: 'po-a', month: '2026-02', amount: 40, currency: 'USD', sourceReference: 'Synthetic PO payable A', paymentType: 'balance', inclusion: 'incremental', reviewed: true }] },
  });
  const timing = emptyCashTimingAssumptions(); timing.inventory = transfer();
  const result = applyCashTimingStress(input, timing);
  const baseline = computeScenario(input), adjusted = computeScenario(result.model);
  assert.equal(result.ready, true);
  assert.deepEqual(result.model.cashCommitments, input.cashCommitments);
  assert.deepEqual(result.model.growth, input.growth);
  assert.deepEqual(result.model.existingDebt, input.existingDebt);
  for (const key of ['workingCapitalUse', 'otherCashUse', 'commitmentCashUse', 'existingDebtService', 'proposedDebtService']) {
    assert.deepEqual(adjusted.rows.map(row => row[key]), baseline.rows.map(row => row[key]), key);
  }
  assert.equal(adjusted.rows[1].commitmentCashUse, 40);
  assert.equal(result.impactRows[0].inventoryDelta, -200);
  assert.equal(result.impactRows[0].collectionsDelta, 0);
});

test('enabled unknown or zero-cent amounts fail rather than becoming silent zero stress', () => {
  for (const amount of [null, undefined, '', '200', true, NaN, Infinity, -1, 0, .001, Number.MAX_SAFE_INTEGER]) {
    blocked(assumptions({ amount }), /amount|cent|range/i);
  }
  for (const baselineReceipts of [null, undefined, '', '900', true, NaN, Infinity, -1, 0, 199, Number.MAX_SAFE_INTEGER]) {
    blocked(assumptions({ baselineReceipts }), /baseline|receipt|range/i);
  }
});

test('each enabled transfer needs evidence and review of the specific retained receipt pool', () => {
  for (const sourceReference of ['', ' ', null, 42, 'a'.repeat(2001)]) blocked(assumptions({ sourceReference }), /reference/i);
  for (const reviewed of [false, null, undefined, 'true', 1]) blocked(assumptions({ reviewed }), /review/i);
});

test('months must be explicit, source in horizon and recovery strictly later', () => {
  for (const fromMonth of ['', null, '2026-00', '2026-13', '0999-12', '2025-12', '2026-05']) blocked(assumptions({ fromMonth }), /month|horizon/i);
  for (const toMonth of ['', null, '2026-00', '2026-13', '2026-01', '2025-12', '10000-01']) blocked(assumptions({ toMonth }), /month|later/i);
});

test('both delays require explicitly reviewed nonoverlapping receipt pools', () => {
  blocked(assumptions({}, {}), /distinct|overlap/i);
  const result = applyCashTimingStress(scenario(), assumptions({}, { amount: 75, toMonth: '2026-04' }, { distinctReceiptPoolsReviewed: true }));
  assert.equal(result.ready, true);
  assert.equal(result.totalDelayed, 275);
  const adjusted = computeScenario(result.model);
  assert.deepEqual(adjusted.rows.map(row => row.preDebtCash), [25, 300, 500, 375]);
  assert.equal(result.impactRows[0].collectionsDelta, -200);
  assert.equal(result.impactRows[0].inventoryDelta, -75);
  assert.equal(result.impactRows[0].cashDelta, -275);
  assert.equal(total(result.impactRows, 'cashDelta'), 0);
});

test('duplicate pool reference and source month blocks even when distinct review is checked', () => {
  blocked(assumptions({}, { sourceReference: '  SYNTHETIC  RECEIVABLES POOL A, retained in forecast  ' }, { distinctReceiptPoolsReviewed: true }), /duplicate|same receipt|overlap/i);
});

test('cross-month receipts can share a document but still require distinct-pool review', () => {
  const result = applyCashTimingStress(scenario(), assumptions({}, { fromMonth: '2026-02', toMonth: '2026-04', sourceReference: transfer().sourceReference }, { distinctReceiptPoolsReviewed: true }));
  assert.equal(result.ready, true);
  assert.deepEqual(computeScenario(result.model).rows.map(row => row.preDebtCash), [100, 100, 500, 500]);
});

test('source and recovery deltas aggregate before rounding, including a shared month', () => {
  const result = applyCashTimingStress(scenario(), assumptions({ amount: 100.01, toMonth: '2026-02' }, { amount: 80.02, fromMonth: '2026-02', toMonth: '2026-03' }, { distinctReceiptPoolsReviewed: true }));
  assert.equal(result.ready, true);
  assert.deepEqual(result.impactRows.map(row => row.cashDelta), [-100.01, 19.99, 80.02]);
  assert.deepEqual(computeScenario(result.model).rows.map(row => row.preDebtCash), [199.99, 319.99, 380.02, 300]);
  assert.equal(total(result.impactRows, 'cashDelta'), 0);
});

test('timing can make net operating cash negative; gross receipt pool is not net cash', () => {
  const result = applyCashTimingStress(scenario(), assumptions({ amount: 800 }));
  assert.equal(result.ready, true);
  assert.equal(computeScenario(result.model).rows[0].preDebtCash, -500);
});

test('per-month cash overrides and all baseline provenance retain exact identity and values', () => {
  const existing = [
    { month: '2026-01', preDebtCash: 120, workingCapitalUse: 25, otherCashUse: 40, provenanceByField: { preDebtCash: '  Cash A  ', workingCapitalUse: 'WC A', otherCashUse: 'Use A' }, extra: 'preserved' },
    { month: '2026-02', otherCashUse: 5, provenance: '  Legacy row evidence  ' },
    { month: '2026-03', preDebtCash: 220, otherCashUse: 10, provenance: '  Legacy cash and use evidence  ' },
  ];
  const input = scenario({ monthlyOverrides: existing });
  const result = applyCashTimingStress(input, assumptions());
  assert.equal(result.ready, true);
  const first = result.model.monthlyOverrides.find(row => row.month === '2026-01');
  const recovered = result.model.monthlyOverrides.find(row => row.month === '2026-03');
  assert.equal(first.preDebtCash, -80);
  assert.deepEqual(first.provenanceByField, existing[0].provenanceByField);
  assert.equal(first.workingCapitalUse, 25); assert.equal(first.otherCashUse, 40); assert.equal(first.extra, 'preserved');
  assert.equal(recovered.preDebtCash, 420); assert.equal(recovered.provenance, existing[2].provenance);
  assert.deepEqual(result.model.monthlyOverrides[1], existing[1]);
  assert.deepEqual(input.monthlyOverrides, existing);
  assert.deepEqual(result.model.normalizedPreDebtCash, input.normalizedPreDebtCash);
  assert.equal(result.impactRows[0].references[0], transfer().sourceReference);
});

test('adding cash to a legacy use-only override preserves its separate evidence without laundering missing use evidence', () => {
  const input = scenario({ monthlyOverrides: [{ month: '2026-01', workingCapitalUse: 25, provenance: '' }] });
  const result = applyCashTimingStress(input, assumptions());
  assert.equal(result.ready, true);
  const row = result.model.monthlyOverrides[0];
  assert.equal(row.provenance, '');
  assert.equal(row.provenanceByField.preDebtCash, input.normalizedPreDebtCash.provenance);
  assert.equal(row.provenanceByField.workingCapitalUse, '');
  assert.match(computeScenario(result.model).errors.join(' '), /workingCapitalUse override requires provenance/);
});

test('field-keyed cash evidence never falls back to another field or legacy row provenance', () => {
  for (const provenanceByField of [{ otherCashUse: 'Unrelated use' }, null, {}]) {
    const input = scenario({ monthlyOverrides: [{ month: '2026-01', preDebtCash: 100, provenance: 'Legacy note', provenanceByField }] });
    const result = applyCashTimingStress(input, assumptions());
    assert.equal(result.ready, false); assert.equal(result.model, null);
    assert.match(result.issues.join(' '), /cash.*evidence|provenance/i);
  }
});

test('missing source or recovery cash baseline blocks; default never replaces explicit missing override', () => {
  for (const month of ['2026-01', '2026-03']) {
    for (const preDebtCash of [null, undefined, '', NaN, Infinity]) {
      const input = scenario({ monthlyOverrides: [{ month, preDebtCash, provenance: 'Synthetic cash evidence' }] });
      const result = applyCashTimingStress(input, assumptions());
      assert.equal(result.ready, false); assert.equal(result.model, null);
    }
  }
  const missingDefault = scenario({ normalizedPreDebtCash: { monthlyAmount: 300, provenance: '' } });
  assert.equal(applyCashTimingStress(missingDefault, assumptions()).ready, false);
});

test('malformed and duplicate monthly overrides are not collapsed by timing application', () => {
  for (const monthlyOverrides of [{}, [null], [{ month: '2026-01' }, { month: '2026-01' }], [{ month: '2027-01' }]]) {
    const result = applyCashTimingStress(scenario({ monthlyOverrides }), assumptions());
    assert.equal(result.ready, false); assert.equal(result.model, null);
    assert.match(result.issues.join(' '), /override|month/i);
  }
});

test('gross-contribution sensitivity stays separately applied once', () => {
  const stress = { monthlyRevenue: 1000, grossMarginPct: 40, revenueDeclinePct: 10, marginCompressionPct: 5 };
  const input = scenario({ stress });
  const result = applyCashTimingStress(input, assumptions());
  const baseline = computeScenario(input), adjusted = computeScenario(result.model);
  assert.deepEqual(result.model.stress, stress);
  assert.deepEqual(adjusted.rows.map(row => row.stressCashReduction), baseline.rows.map(row => row.stressCashReduction));
  assert.equal(adjusted.rows[0].preDebtCash, baseline.rows[0].preDebtCash - 200);
  assert.equal(adjusted.rows[2].preDebtCash, baseline.rows[2].preDebtCash + 200);
  assert.equal(adjusted.summary.totalPreDebtCash, baseline.summary.totalPreDebtCash);
  assert.match(result.methodology.join(' '), /gross.contribution|revenue.*margin/i);
});

test('range, horizon and currency validation is bounded before any adjustment', () => {
  for (const override of [{ horizonMonths: 0 }, { horizonMonths: 1201 }, { horizonMonths: 2.5 }, { startMonth: '9999-12', horizonMonths: 2 }, { currency: '' }]) {
    const result = applyCashTimingStress(scenario(override), assumptions());
    assert.equal(result.ready, false); assert.equal(result.model, null);
  }
  const MAX = Number.MAX_SAFE_INTEGER / (100 * 1201 * 4);
  const result = applyCashTimingStress(scenario({ normalizedPreDebtCash: { monthlyAmount: MAX, provenance: 'Synthetic near ceiling' } }), assumptions({ amount: 10 }));
  assert.equal(result.ready, false); assert.equal(result.model, null);
  assert.match(result.issues.join(' '), /range/i);
});

test('one invalid row prevents partial application of the other valid row', () => {
  blocked(assumptions({}, { amount: null }, { distinctReceiptPoolsReviewed: true }), /amount/i);
});

test('frozen input and repeated calls remain unchanged and deterministic', () => {
  const input = freeze(scenario({ monthlyOverrides: [{ month: '2026-01', preDebtCash: 250, provenanceByField: { preDebtCash: 'Synthetic special month' } }] }));
  const config = freeze(assumptions());
  const before = JSON.stringify({ input, config });
  const a = applyCashTimingStress(input, config), b = applyCashTimingStress(input, config);
  assert.equal(a.ready, true); assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ input, config }), before);
});

test('actual capacity path uses delayed cash instead of original source-month payment room', () => {
  const input = scenario({ horizonMonths: 4, existingDebt: { monthlyPayment: 0, complete: true, provenance: 'Synthetic no existing debt' } });
  const options = { terms: { annualRatePct: 0, termMonths: 3, frequency: 'monthly', repayment: 'amortizing', startMonth: '2026-01', upfrontFees: 0 }, coverageTarget: 1, forecastReviewed: true, termsProvenance: 'Synthetic terms' };
  const baseline = assessFundingCapacity({ ...options, scenario: input });
  const applied = applyCashTimingStress(input, assumptions({ fromMonth: '2026-02', toMonth: '2026-04' }));
  const adjusted = assessFundingCapacity({ ...options, scenario: applied.model });
  assert.equal(applied.ready, true);
  assert.equal(baseline.status, 'feasible'); assert.equal(adjusted.status, 'feasible');
  assert.ok(adjusted.maximumAdditionalPrincipal < baseline.maximumAdditionalPrincipal);
  assert.equal(adjusted.monthlyHeadroom.find(row => row.month === '2026-02').preDebtCash, 100);
});
