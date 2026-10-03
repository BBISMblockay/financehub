import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFundingCapacity } from '../capacity-model.js';
import { computeScenario } from '../scenario-model.js';

const scenario = (changes = {}) => ({
  startMonth: '2026-01', horizonMonths: 12, currency: 'USD', startingCash: 10000, requiredCashFloor: 2000,
  normalizedPreDebtCash: { monthlyAmount: 3000, provenance: 'Synthetic reviewed operating cash bridge' },
  existingDebt: { monthlyPayment: 500, complete: true, provenance: 'Synthetic complete debt schedule' },
  cashCommitments: { complete: true, items: [] },
  growth: { growthPct: 0 }, stress: { revenueDeclinePct: 0, marginCompressionPct: 0 },
  ...changes,
});
const terms = (changes = {}) => ({ startMonth: '2026-01', termMonths: 36, annualRatePct: 0, frequency: 'monthly', repayment: 'amortizing', upfrontFees: 0, ...changes });
const input = (changes = {}) => ({ scenario: scenario(), terms: terms(), coverageTarget: 1.25, forecastReviewed: true, termsProvenance: 'Synthetic explicit term assumptions', ...changes });
const use = (amount, month = '2026-01') => [{ month, otherCashUse: amount, provenance: 'Synthetic fixed use of funds' }];
const exactPasses = (args, principal) => {
  const result = computeScenario({ ...args.scenario, proposal: principal > 0 ? { ...args.terms, principal } : null });
  assert.deepEqual(result.errors, []);
  assert.ok(result.rows.every(row => row.closingCash >= args.scenario.requiredCashFloor - .001));
  assert.ok(result.rows.every(row => row.totalDebtService === 0 || row.preDebtCash + 1e-9 >= args.coverageTarget * row.totalDebtService));
};

test('zero-rate payment headroom derives a transparent window-only principal ceiling', () => {
  const args = input(); const result = assessFundingCapacity(args);
  assert.deepEqual(result.errors, []);
  assert.equal(result.status, 'feasible');
  assert.equal(result.scope, 'window-only');
  assert.equal(result.rawCashGap, 0);
  assert.equal(result.minimumAdditionalPrincipal, 0);
  assert.equal(result.zeroFeasible, true);
  assert.equal(result.monthlyHeadroom[1].availableForNewDebtService, 1900);
  assert.ok(Math.abs(result.maximumAdditionalPrincipal - 68400) < 1);
  assert.equal(result.verification.maximum, true);
  exactPasses(args, result.maximumAdditionalPrincipal);
});

test('funding need covers the loan own payments, not only the raw unfunded gap', () => {
  const args = input({ scenario: scenario({ startingCash: 2000, normalizedPreDebtCash: { monthlyAmount: 500, provenance: 'Synthetic cash' }, monthlyOverrides: use(10000) }), coverageTarget: .5 });
  const result = assessFundingCapacity(args);
  assert.equal(result.rawCashGap, 10000);
  assert.equal(result.scope, 'window-only');
  assert.ok(result.minimumAdditionalPrincipal > result.rawCashGap);
  assert.ok(result.minimumAdditionalPrincipal < 14500);
  // Eleven observed payments can each round upward by half a cent. The
  // certified inner bound reserves that error before dividing by retained
  // principal (25/36); a merely passing unrounded boundary is insufficient.
  assert.equal(result.minimumAdditionalPrincipal, 14400.08);
  assert.equal(result.limitingNeed.month, '2026-12');
  assert.equal(result.verification.minimum, true);
  exactPasses(args, result.suggestedPrincipal);
});

test('fixed upfront fees shift funding need once, without changing principal payment coefficients', () => {
  const sc = scenario({ startingCash: 2000, monthlyOverrides: use(10000) });
  const without = assessFundingCapacity(input({ scenario: sc }));
  const args = input({ scenario: sc, terms: terms({ upfrontFees: 1000 }) });
  const result = assessFundingCapacity(args);
  assert.equal(result.rawCashGap, without.rawCashGap);
  assert.ok(result.minimumAdditionalPrincipal >= without.minimumAdditionalPrincipal + 1000);
  assert.equal(result.monthlyHeadroom[1].proposedDebtServicePerDollar, without.monthlyHeadroom[1].proposedDebtServicePerDollar);
  exactPasses(args, result.minimumAdditionalPrincipal);
});

test('zero borrowing incurs no fee even if every positive loan has a higher minimum', () => {
  const args = input({ scenario: scenario({ startingCash: 2000, normalizedPreDebtCash: { monthlyAmount: 500, provenance: 'Synthetic cash' } }), terms: terms({ upfrontFees: 1000 }), coverageTarget: .5 });
  const result = assessFundingCapacity(args);
  assert.equal(result.zeroFeasible, true);
  assert.equal(result.minimumAdditionalPrincipal, 0);
  assert.ok(result.minimumPositivePrincipal >= 1000);
  exactPasses(args, 0);
  exactPasses(args, result.minimumPositivePrincipal);
});

test('need exceeding service-supported amount is a modeled conflict, with remaining gap at ceiling', () => {
  const result = assessFundingCapacity(input({ scenario: scenario({ startingCash: 2000, monthlyOverrides: use(200000) }) }));
  assert.equal(result.status, 'infeasible');
  assert.equal(result.suggestedPrincipal, null);
  assert.ok(result.continuousBounds.minimum > result.continuousBounds.maximum);
  assert.ok(result.limitingNeed && result.limitingCapacity);
});

test('existing service already below the selected target is explicit, not clamped to spare capacity zero', () => {
  const result = assessFundingCapacity(input({ scenario: scenario({ existingDebt: { monthlyPayment: 3000, complete: true, provenance: 'Debt schedule' } }) }));
  assert.equal(result.status, 'infeasible');
  assert.equal(result.monthlyHeadroom[0].availableForNewDebtService, -600);
  assert.match(result.reasons.join(' '), /existing.*target/i);
});

test('negative cash with no debt that month is DSCR N/A and still a cash constraint', () => {
  const result = assessFundingCapacity(input({ scenario: scenario({ existingDebt: { monthlyPayment: 0, complete: true, provenance: 'No debt' }, monthlyOverrides: [{ month: '2026-01', preDebtCash: -500, provenance: 'Negative seasonal cash' }] }) }));
  assert.equal(result.monthlyHeadroom[0].coveragePrincipalCeiling, null);
  assert.equal(result.monthlyHeadroom[0].dscrApplicable, false);
  assert.ok(!result.reasons.some(reason => /existing.*target/i.test(reason)));
});

test('annual first payment outside the observed window never becomes unlimited numerical capacity', () => {
  const result = assessFundingCapacity(input({ terms: terms({ frequency: 'annual' }) }));
  assert.equal(result.status, 'unassessed');
  assert.equal(result.maximumAdditionalPrincipal, null);
  assert.equal(result.suggestedPrincipal, null);
  assert.match(result.reasons.join(' '), /no proposed.*payment/i);
});

test('zero-rate interest-only balloon outside the window has no payment-supported ceiling', () => {
  const result = assessFundingCapacity(input({ terms: terms({ repayment: 'interest-only' }) }));
  assert.equal(result.status, 'unassessed');
  assert.equal(result.maximumAdditionalPrincipal, null);
  assert.equal(result.scope, 'window-only');
});

test('funding plus 12 payments needs 13 cash rows for full-term scope', () => {
  const a = assessFundingCapacity(input({ terms: terms({ termMonths: 12 }) }));
  const b = assessFundingCapacity(input({ scenario: scenario({ horizonMonths: 13 }), terms: terms({ termMonths: 12 }) }));
  assert.equal(a.scope, 'window-only');
  assert.equal(b.scope, 'full-term');
  assert.equal(b.verification.maximum, true);
});

test('balloon inside horizon creates a negative cash coefficient and a real upper bound', () => {
  const args = input({ scenario: scenario({ horizonMonths: 13 }), terms: terms({ termMonths: 12, annualRatePct: 12, repayment: 'interest-only' }) });
  const result = assessFundingCapacity(args);
  assert.equal(result.scope, 'full-term');
  assert.ok(result.monthlyHeadroom.at(-1).cashCoefficient < 0);
  assert.equal(result.limitingCapacity.month, '2027-01');
  exactPasses(args, result.maximumAdditionalPrincipal);
});

test('no amount can fix a terminal deficit after zero-rate balloon principal has been repaid', () => {
  const result = assessFundingCapacity(input({
    scenario: scenario({ horizonMonths: 13, startingCash: 2000, monthlyOverrides: use(100000, '2027-01') }),
    terms: terms({ termMonths: 12, repayment: 'interest-only' }),
  }));
  assert.equal(result.status, 'infeasible');
  assert.equal(result.suggestedPrincipal, null);
  assert.match(result.reasons.join(' '), /no marginal|cannot.*cash|unchanged/i);
});

test('pre-funding opening deficit is disclosed and never upgraded to a full-term funding claim', () => {
  const result = assessFundingCapacity(input({ scenario: scenario({ horizonMonths: 13, startingCash: 1000 }), terms: terms({ termMonths: 12 }) }));
  assert.deepEqual(result.preFundingShortfall, { amount: 1000, month: '2026-01 opening' });
  assert.equal(result.scope, 'window-only');
  assert.ok(result.warnings.some(w => /pre.funding/i.test(w)));
});

test('cash shortage before a later funding date is not repaired retroactively', () => {
  const result = assessFundingCapacity(input({ scenario: scenario({ startingCash: 2000, monthlyOverrides: use(20000) }), terms: terms({ startMonth: '2026-03' }) }));
  assert.equal(result.status, 'infeasible');
  assert.ok(result.preFundingShortfall.amount > 0);
});

test('missing forecast review, terms evidence, fees, target or data never produces a candidate', () => {
  for (const changes of [
    { forecastReviewed: false }, { termsProvenance: '' }, { coverageTarget: null }, { coverageTarget: 0 },
    { terms: terms({ upfrontFees: null }) },
    { scenario: scenario({ cashCommitments: { complete: false, items: [] } }) },
    { scenario: scenario({ existingDebt: { monthlyPayment: 500, complete: false, provenance: 'Partial' } }) },
    { scenario: scenario({ normalizedPreDebtCash: { monthlyAmount: 3000, provenance: '' } }) },
  ]) {
    const result = assessFundingCapacity(input(changes));
    assert.equal(result.suggestedPrincipal, null);
    assert.ok(['incomplete', 'unassessed'].includes(result.status));
  }
});

test('documented included PO cash remains included once in baseline need', () => {
  const item = { id: 'p1', month: '2026-01', amount: 10000, currency: 'USD', sourceReference: 'PO-1 terms', paymentType: 'balance', inclusion: 'included-in-other-cash-use', reviewed: true };
  const sc = scenario({ startingCash: 2000, monthlyOverrides: use(10000) });
  const a = assessFundingCapacity(input({ scenario: sc }));
  const b = assessFundingCapacity(input({ scenario: { ...sc, cashCommitments: { complete: true, items: [item] } } }));
  assert.equal(a.rawCashGap, b.rawCashGap);
  assert.equal(a.minimumAdditionalPrincipal, b.minimumAdditionalPrincipal);
});

test('higher target cannot increase maximum capacity, and exact cent candidates pass varied terms', () => {
  for (const frequency of ['monthly', 'quarterly']) for (const annualRatePct of [0, 7.37, 12]) {
    const args = input({ terms: terms({ frequency, annualRatePct }) });
    const lower = assessFundingCapacity(args);
    const higher = assessFundingCapacity({ ...args, coverageTarget: 1.5 });
    assert.equal(lower.status, 'feasible');
    assert.equal(higher.status, 'feasible');
    assert.ok(higher.maximumAdditionalPrincipal <= lower.maximumAdditionalPrincipal);
    assert.equal(lower.verification.exact, true);
    exactPasses(args, lower.maximumAdditionalPrincipal);
    exactPasses({ ...args, coverageTarget: 1.5 }, higher.maximumAdditionalPrincipal);
  }
});

test('raising cash uses cannot lower needed borrowing under the same fixed terms', () => {
  let previous = 0;
  for (const amount of [10000, 12000, 15000, 18000]) {
    const args = input({ scenario: scenario({ startingCash: 2000, monthlyOverrides: use(amount) }), terms: terms({ annualRatePct: 9.25 }) });
    const result = assessFundingCapacity(args);
    assert.equal(result.status, 'feasible');
    assert.ok(result.minimumAdditionalPrincipal >= previous);
    exactPasses(args, result.minimumAdditionalPrincipal);
    previous = result.minimumAdditionalPrincipal;
  }
});

test('malformed input is bounded and pure; unsupported fixed payment does not get reinterpreted', () => {
  for (const value of [null, undefined, [], 'bad']) assert.equal(assessFundingCapacity(value).suggestedPrincipal, null);
  const args = input({ terms: terms({ requiredPayment: 1000 }) });
  assert.equal(assessFundingCapacity(args).status, 'unassessed');
  const normal = input(); const saved = structuredClone(normal);
  assert.deepEqual(assessFundingCapacity(normal), assessFundingCapacity(normal));
  assert.deepEqual(normal, saved);
});

test('reported interval avoids cent-rounding holes at amortizing final payment', () => {
  const args = input({
    scenario: scenario({ horizonMonths: 13, normalizedPreDebtCash: { monthlyAmount: 3100, provenance: 'Cash' }, monthlyOverrides: [{ month: '2027-01', preDebtCash: 3000, provenance: 'Final month cash' }] }),
    terms: terms({ termMonths: 12 }),
  });
  const result = assessFundingCapacity(args);
  assert.equal(result.status, 'feasible');
  assert.equal(result.intervalConservative, true);
  assert.equal(result.verification.interval, true);
  // Previously two passing endpoints enclosed 54 failing amounts in this band.
  assert.ok(result.maximumAdditionalPrincipal < 22799.68);
  for (let cents = 0; cents <= 150; cents += 1) exactPasses(args, Math.round(result.maximumAdditionalPrincipal * 100 - cents) / 100);
});

test('every cent of small certified intervals passes across rate, frequency and repayment properties', () => {
  for (const repayment of ['amortizing', 'interest-only']) for (const annualRatePct of [0, 9.25]) for (const frequency of ['monthly', 'quarterly']) {
    const args = input({
      scenario: scenario({ horizonMonths: 13, startingCash: 100, requiredCashFloor: 10, normalizedPreDebtCash: { monthlyAmount: .8, provenance: 'Synthetic small cash' }, existingDebt: { monthlyPayment: .1, complete: true, provenance: 'Small debt' } }),
      terms: terms({ termMonths: 12, annualRatePct, repayment, frequency }),
    });
    const result = assessFundingCapacity(args);
    if (result.status !== 'feasible' || result.maximumAdditionalPrincipal === 0) continue;
    assert.equal(result.verification.interval, true);
    for (let p = Math.round(result.minimumPositivePrincipal * 100); p <= Math.round(result.maximumAdditionalPrincipal * 100); p += 1) exactPasses(args, p / 100);
  }
});

test('late cash use can make post-repayment cash, rather than DSCR, the limiting upper bound', () => {
  const args = input({
    scenario: scenario({ horizonMonths: 13, monthlyOverrides: use(40400, '2027-01') }),
    terms: terms({ termMonths: 12, annualRatePct: 12, repayment: 'interest-only' }),
  });
  const result = assessFundingCapacity(args);
  assert.equal(result.status, 'feasible');
  assert.match(result.limitingCapacity.reason, /after repayment/i);
  assert.equal(result.limitingCapacity.month, '2027-01');
  assert.ok(result.maximumAdditionalPrincipal < 834);
  for (const pct of [0, .1, .25, .5, .75, 1]) {
    const principal = Math.max(.01, Math.floor(result.maximumAdditionalPrincipal * pct * 100) / 100);
    exactPasses(args, principal);
  }
});

test('even a one-cent fee cannot be hidden by zero-rate terminal rounding uncertainty', () => {
  const args = input({ scenario: scenario({ horizonMonths: 13, startingCash: 2000, normalizedPreDebtCash: { monthlyAmount: 500, provenance: 'Cash' } }), terms: terms({ termMonths: 12, upfrontFees: .01 }), coverageTarget: .5 });
  const result = assessFundingCapacity(args);
  assert.equal(result.zeroFeasible, true);
  assert.equal(result.maximumAdditionalPrincipal, 0);
  assert.equal(result.suggestedPrincipal, 0);
});

test('certified zero borrowing is reported as feasible even when no positive cent interval survives rounding', () => {
  // Coverage target so high that only P = 0 passes: the outer interval holds
  // whole cents but the rounding-safe inner interval is empty. The two sibling
  // exits already report feasible/0 here; this one used to say "unassessed".
  const result = assessFundingCapacity(input({ coverageTarget: 1000000, scenario: scenario({ existingDebt: { monthlyPayment: 0, complete: true, provenance: 'Synthetic: no existing debt' } }) }));
  assert.ok(result.continuousBounds.maximum > 0 && result.continuousBounds.maximum < .5, 'outer interval holds cents, inner does not');
  assert.equal(result.zeroFeasible, true);
  assert.equal(result.status, 'feasible');
  assert.equal(result.maximumAdditionalPrincipal, 0);
  assert.equal(result.suggestedPrincipal, 0);
  assert.equal(result.verification.interval, true);
  assert.equal(result.verification.exact, true);
  assert.match(result.reasons.join(' '), /Cent-rounding uncertainty/);
  assert.equal(result.residualAtWindowEnd, null, 'nothing borrowed, nothing remains');
});

test('post-window residual describes the headline ceiling, never the zero suggestion', () => {
  const args = input({ terms: terms({ termMonths: 24, annualRatePct: 12 }) });
  const result = assessFundingCapacity(args);
  assert.equal(result.scope, 'window-only');
  assert.equal(result.suggestedPrincipal, 0);
  assert.ok(result.maximumAdditionalPrincipal > 0);
  const atCeiling = computeScenario({ ...args.scenario, proposal: { ...args.terms, principal: result.maximumAdditionalPrincipal } });
  assert.equal(result.residualAtWindowEnd, atCeiling.summary.proposedEndingBalance);
  assert.ok(result.residualAtWindowEnd > 0);
  assert.ok(result.remainingDebtServiceAfterWindow > result.residualAtWindowEnd, 'remaining service includes interest beyond the window');
});
