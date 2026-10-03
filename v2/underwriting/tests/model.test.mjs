import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDebtSchedule,
  calculateFacilityAvailability,
  computeScenario,
  illustrativeLoanPrincipal,
} from '../scenario-model.js';

// Preflight: these exports have no prior call sites and no persistence or network
// effects. Their production consumer is the hidden underwriting page. No database
// policy/grant changes apply. Repeated/concurrent calls must not mutate inputs.
// Tests are defined before implementation. Actual lender terms, borrowing-base
// evidence, normalized cash provenance and source completeness require the UI's
// separate evidence checks; synthetic tests cannot establish those live facts.
const loan = (overrides = {}) => ({
  principal: 12000, annualRatePct: 12, termMonths: 12,
  frequency: 'monthly', repayment: 'amortizing', startMonth: '2026-01',
  ...overrides,
});
const scenario = (overrides = {}) => ({
  startMonth: '2026-01', horizonMonths: 13, startingCash: 10000,
  requiredCashFloor: 2000,
  normalizedPreDebtCash: { monthlyAmount: 3000, provenance: 'Synthetic normalized cash bridge' },
  existingDebt: { monthlyPayment: 500, complete: true, provenance: 'Synthetic complete debt schedule' },
  proposal: loan({ annualRatePct: 0 }),
  growth: { growthPct: 0 },
  stress: { revenueDeclinePct: 0, marginCompressionPct: 0 },
  ...overrides,
});
const total = (rows, field) => Math.round(rows.reduce((n, row) => n + row[field], 0) * 100) / 100;
const near = (actual, expected, epsilon = .011) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
const commitment = (overrides = {}) => ({
  id: 'payment-1', month: '2026-02', amount: 1000, currency: 'USD',
  sourceReference: 'Synthetic PO-101 / reviewed vendor payment terms',
  paymentType: 'deposit', inclusion: 'incremental', reviewed: true,
  ...overrides,
});
const withCommitments = (items = [], complete = true) => ({
  currency: 'USD', cashCommitments: { complete, items },
});

// Revision preflight: commitments are explicit user-reviewed cash assumptions,
// not source records. The UI is still the only production caller. Existing P&I
// remains one monthly aggregate, proposed P&I remains separate, and no facility
// reference is added to either. No new I/O, persistence, policy or concurrency
// surface is introduced. These tests precede the commitment implementation.
test('reviewed empty commitment schedule explicitly confirms no additional planned payments', () => {
  const result = computeScenario(scenario(withCommitments()));
  assert.deepEqual(result.errors, []);
  assert.equal(result.coverage.commitmentsComplete, true);
  assert.equal(result.coverage.cashPathComplete, true);
  assert.equal(result.coverage.growthAdjustedCoverageAvailable, true);
  assert.equal(result.summary.totalCommitmentCashUse, 0);
  assert.equal(result.summary.totalReviewedCommitments, 0);
});

test('incremental planned payment is a separate one-time outflow, never debt service', () => {
  const baseline = computeScenario(scenario(withCommitments()));
  const result = computeScenario(scenario(withCommitments([commitment()])));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].commitmentCashUse, 1000);
  assert.equal(result.rows[0].commitmentCashUse, 0);
  assert.equal(result.rows[2].commitmentCashUse, 0);
  assert.equal(result.rows[1].otherCashUse, 0);
  assert.equal(result.rows[1].workingCapitalUse, 0);
  assert.equal(result.rows[1].closingCash, baseline.rows[1].closingCash - 1000);
  assert.equal(result.summary.endingCash, baseline.summary.endingCash - 1000);
  assert.equal(result.rows[1].dscr, baseline.rows[1].dscr);
  assert.equal(result.rows[1].totalDebtService, 1500);
  near(result.rows[1].growthAdjustedDscr, 2000 / 1500, 1e-12);
  assert.equal(result.summary.totalCommitmentCashUse, 1000);
  assert.equal(result.summary.totalReviewedCommitments, 1000);
  assert.equal(result.rows[1].cashCommitments[0].sourceReference, commitment().sourceReference);
});

test('included-in-pre-debt-cash item is visible but never deducted again', () => {
  const input = scenario(withCommitments([commitment({ inclusion: 'included-in-pre-debt-cash' })]));
  const result = computeScenario(input);
  const baseline = computeScenario({ ...input, ...withCommitments() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.endingCash, baseline.summary.endingCash);
  assert.equal(result.rows[1].commitmentCashUse, 0);
  assert.equal(result.rows[1].includedCommitments.length, 1);
  assert.equal(result.summary.totalIncludedCommitments, 1000);
  assert.match(result.warnings.join(' '), /user.certified.*already included/i);
});

test('included-in-working-capital and other uses are not deducted twice', () => {
  const input = scenario({
    ...withCommitments([
      commitment({ id: 'wc', amount: 2000, inclusion: 'included-in-working-capital' }),
      commitment({ id: 'other', sourceReference: 'Synthetic PO-202', amount: 500, inclusion: 'included-in-other-cash-use' }),
    ]),
    growth: { growthPct: 10, baselineWorkingCapital: 40000, spreadMonths: 2, provenance: 'WC plan includes PO-101' },
    monthlyOverrides: [{ month: '2026-02', otherCashUse: 500, provenance: 'Other plan includes PO-202' }],
  });
  const result = computeScenario(input);
  const baseline = computeScenario({ ...input, ...withCommitments() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.coverage.commitmentsComplete, true);
  assert.equal(result.rows[1].closingCash, baseline.rows[1].closingCash);
  assert.equal(result.rows[1].commitmentCashUse, 0);
  assert.equal(result.rows[1].includedCommitments.length, 2);
  assert.equal(result.summary.totalIncludedCommitments, 2500);
});

test('claimed inclusion exceeding that same month WC or other use fails cash coverage closed', () => {
  for (const inclusion of ['included-in-working-capital', 'included-in-other-cash-use']) {
    const result = computeScenario(scenario(withCommitments([commitment({ inclusion })])));
    assert.equal(result.coverage.commitmentsComplete, false);
    assert.equal(result.summary.endingCash, null);
    assert.equal(result.summary.worstGrowthAdjustedDscr, null);
    assert.equal(result.rows[1].dscr, 2);
    assert.match(result.warnings.join(' '), /exceed/i);
  }
});

test('multiple included payments are checked together against the same cash-use bucket', () => {
  const result = computeScenario(scenario({
    ...withCommitments([
      commitment({ id: 'a', amount: 600, inclusion: 'included-in-other-cash-use' }),
      commitment({ id: 'b', sourceReference: 'Synthetic PO-202', amount: 600, inclusion: 'included-in-other-cash-use' }),
    ]),
    monthlyOverrides: [{ month: '2026-02', otherCashUse: 1000, provenance: 'Reviewed cash-use plan' }],
  }));
  assert.equal(result.coverage.commitmentsComplete, false);
  assert.equal(result.summary.minCashBuffer, null);
});

test('unconfirmed horizon or payment suppresses cash and adjusted coverage but preserves standard DSCR', () => {
  for (const change of [withCommitments([], false), withCommitments([commitment({ reviewed: false })])]) {
    const result = computeScenario(scenario(change));
    assert.deepEqual(result.errors, []);
    assert.equal(result.coverage.commitmentsComplete, false);
    assert.equal(result.coverage.cashPathComplete, false);
    assert.equal(result.coverage.growthAdjustedCoverageAvailable, false);
    assert.equal(result.summary.minCashBuffer, null);
    assert.equal(result.summary.fullHorizonGrowthAdjustedDscr, null);
    assert.equal(result.rows[1].growthAdjustedDscr, null);
    assert.equal(result.rows[1].cashAfterUsesBeforeDebt, null);
    assert.equal(result.rows[1].commitmentCashUse, null);
    assert.equal(result.rows[1].dscr, 2);
    assert.ok(Number.isFinite(result.summary.fullHorizonDscr));
  }
});

test('draft missing commitment values remain unknown without throwing or inferring from PO facts', () => {
  const draft = commitment({ amount: null, month: '', currency: '', sourceReference: '', paymentType: '', inclusion: '', reviewed: false, poTotal: 999999, deliveryMonth: '2026-02' });
  const result = computeScenario(scenario(withCommitments([draft])));
  assert.deepEqual(result.errors, []);
  assert.equal(result.coverage.commitmentsComplete, false);
  assert.equal(result.summary.totalCommitmentCashUse, null);
  assert.equal(result.rows[1].existingDebtService, 500);
  assert.equal(result.rows[1].proposedDebtService, 1000);
  assert.equal(result.rows[1].totalDebtService, 1500);
  assert.equal(result.cashCommitments.items[0].amount, null);
  assert.ok(result.cashCommitments.issues.length >= 5);
});

test('missing or mismatched commitment currency blocks cash; no FX is guessed', () => {
  for (const change of [
    { ...withCommitments([commitment()]), currency: undefined },
    withCommitments([commitment({ currency: 'CAD' })]),
    withCommitments([commitment({ currency: '' })]),
  ]) {
    const result = computeScenario(scenario(change));
    assert.equal(result.coverage.commitmentsComplete, false);
    assert.equal(result.summary.endingCash, null);
    assert.equal(result.rows[1].dscr, 2);
    assert.match(result.warnings.join(' '), /currenc/i);
  }
});

test('out-of-horizon commitment remains inspectable and blocks a falsely complete cash horizon', () => {
  const result = computeScenario(scenario(withCommitments([commitment({ month: '2027-02' })])));
  assert.equal(result.coverage.commitmentsComplete, false);
  assert.equal(result.cashCommitments.items[0].month, '2027-02');
  assert.equal(result.summary.endingCash, null);
  assert.match(result.warnings.join(' '), /outside.*horizon/i);
});

test('duplicate payment IDs and same source/month/stage do not double-count imports', () => {
  const a = commitment();
  for (const b of [
    commitment({ sourceReference: 'Different PO' }),
    commitment({ id: 'payment-2' }),
    commitment({ id: 'payment-2', sourceReference: `  ${a.sourceReference.toUpperCase()}  ` }),
  ]) {
    const result = computeScenario(scenario(withCommitments([a, b])));
    assert.ok(result.errors.length);
    assert.equal(result.summary.endingCash, null);
    assert.match(result.errors.join(' '), /duplicate/i);
  }
});

test('distinct deposit and balance stages for one PO are both counted exactly once', () => {
  const result = computeScenario(scenario(withCommitments([
    commitment({ amount: 300 }),
    commitment({ id: 'payment-2', amount: 700, paymentType: 'balance' }),
  ])));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].commitmentCashUse, 1000);
  assert.equal(result.summary.totalCommitmentCashUse, 1000);
});

test('negative, malformed and excessive commitment payloads error; explicit zero is retained', () => {
  for (const amount of [-1, Infinity, NaN, false, '1000']) {
    assert.ok(computeScenario(scenario(withCommitments([commitment({ amount })]))).errors.length);
  }
  for (const cashCommitments of [null, [], { complete: true }, { complete: true, items: 'wrong' }, { complete: true, items: [null] }, { complete: true, items: Array(501).fill(commitment()) }]) {
    assert.ok(computeScenario(scenario({ currency: 'USD', cashCommitments })).errors.length);
  }
  const zero = computeScenario(scenario(withCommitments([commitment({ amount: 0 })])));
  assert.deepEqual(zero.errors, []);
  assert.equal(zero.coverage.commitmentsComplete, true);
  assert.equal(zero.summary.totalCommitmentCashUse, 0);
  assert.equal(zero.rows[1].cashCommitments[0].amount, 0);
});

test('legacy absence is a visibly excluded commitment scope, never silent evidence of review', () => {
  const result = computeScenario(scenario());
  assert.equal(result.coverage.commitmentsComplete, null);
  assert.ok(Number.isFinite(result.summary.endingCash));
  assert.match(result.warnings.join(' '), /commitment.*not supplied|no commitment schedule/i);
});

test('existing P&I, proposed P&I and combined service remain separate; facilities cannot add a second charge', () => {
  const input = scenario({
    ...withCommitments([commitment()]),
    existingDebt: { monthlyPayment: 500, monthlyPayments: { '2026-03': 5000 }, complete: true, provenance: 'Complete required payments incl balloon' },
    facilities: [{ requiredPayment: 500, balance: 100000 }],
  });
  const result = computeScenario(input);
  assert.equal(result.rows[1].existingDebtService, 500);
  assert.equal(result.rows[1].proposedDebtService, 1000);
  assert.equal(result.rows[1].totalDebtService, 1500);
  assert.equal(result.rows[2].existingDebtService, 5000);
  assert.equal(result.rows[2].totalDebtService, 6000);
  assert.equal(result.summary.totalExistingDebtService, 11000);
  assert.match(result.warnings.join(' '), /aggregate.*terms|terms.*aggregate/i);
});

test('zero-rate amortization includes origination month and pays every cent once', () => {
  const result = buildDebtSchedule(loan({ annualRatePct: 0 }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 13);
  assert.equal(result.rows[0].month, '2026-01');
  assert.equal(result.rows[0].payment, 0);
  assert.equal(result.rows[1].payment, 1000);
  assert.equal(result.rows.at(-1).month, '2027-01');
  assert.equal(total(result.rows, 'principal'), 12000);
  assert.equal(total(result.rows, 'interest'), 0);
  assert.equal(result.rows.at(-1).endingBalance, 0);
});

test('amortization is cent-rounded, reconciles, and never creates negative balance', () => {
  const result = buildDebtSchedule(loan({ principal: 10000.01, annualRatePct: 7.25, termMonths: 37 }));
  assert.deepEqual(result.errors, []);
  assert.equal(total(result.rows, 'principal'), 10000.01);
  for (const row of result.rows) {
    assert.ok(row.endingBalance >= 0);
    near(row.openingBalance - row.principal, row.endingBalance);
    near(row.principal + row.interest, row.payment);
  }
});

test('interest-only has quarterly simple interest and full principal balloon at maturity', () => {
  const result = buildDebtSchedule(loan({ frequency: 'quarterly', repayment: 'interest-only' }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].payment, 0);
  assert.equal(result.rows[3].month, '2026-04');
  assert.equal(result.rows[3].interest, 360);
  assert.equal(result.rows[3].principal, 0);
  assert.equal(result.rows.at(-1).payment, 12360);
  assert.equal(result.summary.balloonPayment, 12000);
  assert.equal(total(result.rows, 'interest'), 1440);
});

test('annual interest and zero-rate interest-only use the specified frequency', () => {
  const annual = buildDebtSchedule(loan({ termMonths: 24, frequency: 'annual', repayment: 'interest-only' }));
  assert.deepEqual(annual.errors, []);
  assert.equal(annual.rows[11].payment, 0);
  assert.equal(annual.rows[12].interest, 1440);
  assert.equal(annual.rows.at(-1).payment, 13440);
  const zero = buildDebtSchedule(loan({ annualRatePct: 0, repayment: 'interest-only' }));
  assert.equal(zero.rows[1].payment, 0);
  assert.equal(zero.rows.at(-1).payment, 12000);
});

test('balloon with longer amortization has scheduled principal and final residual', () => {
  const result = buildDebtSchedule(loan({ annualRatePct: 0, repayment: 'balloon', amortizationMonths: 24 }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].payment, 500);
  assert.equal(result.rows.at(-1).payment, 6500);
  assert.equal(result.summary.balloonPayment, 6000);
  assert.equal(total(result.rows, 'principal'), 12000);
});

test('balloon without amortization explicitly means interest-only with a maturity balloon', () => {
  const result = buildDebtSchedule(loan({ repayment: 'balloon' }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].principal, 0);
  assert.equal(result.rows.at(-1).principal, 12000);
  assert.match(result.methodology.join(' '), /interest-only/i);
});

test('term and amortization must align to frequency; first due date is not moved earlier', () => {
  assert.match(buildDebtSchedule(loan({ frequency: 'quarterly', termMonths: 11 })).errors.join(' '), /align/i);
  assert.match(buildDebtSchedule(loan({ frequency: 'annual', termMonths: 6 })).errors.join(' '), /align/i);
  assert.match(buildDebtSchedule(loan({ frequency: 'quarterly', repayment: 'balloon', amortizationMonths: 25 })).errors.join(' '), /align/i);
});

test('missing, malformed and unsafe loan amounts are rejected rather than coerced to zero', () => {
  for (const field of ['principal', 'annualRatePct', 'termMonths']) {
    for (const value of [undefined, null, '', ' ', false, NaN, Infinity, '12']) {
      assert.ok(buildDebtSchedule(loan({ [field]: value })).errors.length, `${field}: ${String(value)}`);
    }
  }
  for (const override of [
    { principal: 0 }, { principal: -.1 }, { annualRatePct: -1 },
    { termMonths: 12.5 }, { termMonths: 1201 }, { principal: Number.MAX_SAFE_INTEGER },
    { startMonth: '2026-13' }, { startMonth: '2026-1' },
    { frequency: 'weekly' }, { repayment: 'unknown' },
  ]) assert.ok(buildDebtSchedule(loan(override)).errors.length);
  for (const input of [undefined, null, [], 'loan']) assert.ok(buildDebtSchedule(input).errors.length);
});

test('contradictory repayment fields and negative amortization are rejected', () => {
  const bad = [
    { repayment: 'interest-only', requiredPayment: 500 },
    { repayment: 'amortizing', amortizationMonths: 24 },
    { repayment: 'balloon', amortizationMonths: 12 },
    { repayment: 'balloon', amortizationMonths: 24, requiredPayment: 1000 },
    { repayment: 'balloon', requiredPayment: 100 },
    { repayment: 'amortizing', requiredPayment: 500 },
  ];
  for (const override of bad) assert.ok(buildDebtSchedule(loan(override)).errors.length, JSON.stringify(override));
});

test('larger explicit payments can repay early without duplicate final principal', () => {
  const result = buildDebtSchedule(loan({ annualRatePct: 0, requiredPayment: 5000 }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[3].payment, 2000);
  assert.equal(result.rows[4].payment, 0);
  assert.equal(result.rows.at(-1).payment, 0);
  assert.equal(total(result.rows, 'principal'), 12000);
});

test('facility limit less book draw is only a ceiling when borrowing evidence is missing', () => {
  const result = calculateFacilityAvailability({ limit: 100000, bookDrawn: 40000 });
  assert.equal(result.committedHeadroom, 60000);
  assert.equal(result.available, null);
  assert.equal(result.status, 'unknown');
});

test('documented borrowing-base amount and reserves constrain availability', () => {
  const result = calculateFacilityAvailability({
    limit: 100000, bookDrawn: 40000, borrowingBase: 80000, reserves: 10000,
    borrowingBaseProvenance: 'Synthetic dated borrowing-base certificate and reserves',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.available, 30000);
  assert.equal(result.borrowingBaseHeadroom, 30000);
});

test('facility evidence and both base/reserves are required, including explicit zero reserves', () => {
  const base = { limit: 100000, bookDrawn: 40000, borrowingBase: 80000, reserves: 0 };
  assert.equal(calculateFacilityAvailability(base).available, null);
  assert.equal(calculateFacilityAvailability({ ...base, reserves: undefined, borrowingBaseProvenance: 'Certificate' }).available, null);
  assert.equal(calculateFacilityAvailability({ ...base, borrowingBaseProvenance: 'Certificate' }).available, 40000);
});

test('explicit lender availability is evidenced and capped by every documented upper bound', () => {
  const base = { limit: 100000, bookDrawn: 40000, lenderAvailable: 90000 };
  assert.equal(calculateFacilityAvailability(base).available, null);
  assert.equal(calculateFacilityAvailability({ ...base, lenderAvailableProvenance: 'Lender portal today' }).available, 60000);
  assert.equal(calculateFacilityAvailability({ ...base, lenderAvailableProvenance: 'Lender portal today', borrowingBase: 75000, reserves: 5000, borrowingBaseProvenance: 'Certificate' }).available, 30000);
  assert.equal(calculateFacilityAvailability({ ...base, bookDrawn: undefined, lenderAvailableProvenance: 'Lender portal today' }).available, null);
  assert.equal(calculateFacilityAvailability({ ...base, lenderAvailable: 0, lenderAvailableProvenance: 'Lender portal today' }).available, 0);
});

test('overdrawn facility cannot manufacture negative availability or use bank cash', () => {
  const result = calculateFacilityAvailability({ limit: 100, bookDrawn: 150, borrowingBase: 90, reserves: 5, borrowingBaseProvenance: 'Certificate', bankCash: 1000000 });
  assert.equal(result.available, 0);
  assert.equal(result.committedHeadroom, 0);
  assert.ok(result.warnings.length);
  assert.equal(calculateFacilityAvailability({ limit: 100, bookDrawn: -1 }).available, null);
});

test('proposal principal flows into cash once; DSCR numerator never includes it', () => {
  const result = computeScenario(scenario());
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 13);
  assert.equal(result.rows[0].proposalInflow, 12000);
  assert.equal(total(result.rows, 'proposalInflow'), 12000);
  assert.equal(result.rows[1].proposalInflow, 0);
  assert.equal(result.rows[0].closingCash, 24500);
  assert.equal(result.rows[1].closingCash, 26000);
  assert.equal(result.rows[1].preDebtCash, 3000);
  assert.equal(result.rows[1].dscr, 2);
});

test('DSCR uses pre-debt numerator and each principal/interest cash payment exactly once', () => {
  const result = computeScenario(scenario({
    proposal: loan({ principal: 12000, repayment: 'interest-only' }),
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].proposedInterest, 120);
  assert.equal(result.rows[1].totalDebtService, 620);
  near(result.rows[1].dscr, 3000 / 620, 1e-12);
  assert.equal(result.rows[1].closingCash - result.rows[1].openingCash, 2380);
  assert.equal(result.rows.at(-1).totalDebtService, 12620);
  near(result.summary.fullHorizonDscr, 39000 / (6500 + 13440), 1e-12);
  near(result.summary.worstMonthlyDscr, 3000 / 12620, 1e-12);
});

test('incomplete existing obligations suppress cash coverage and DSCR even when entered amounts exist', () => {
  const result = computeScenario(scenario({ existingDebt: { monthlyPayment: 500, complete: false, provenance: 'Partial schedule' } }));
  assert.equal(result.coverage.existingDebtComplete, false);
  assert.equal(result.summary.fullHorizonDscr, null);
  assert.equal(result.summary.minCashBuffer, null);
  assert.equal(result.rows[1].existingDebtService, 500);
  assert.equal(result.rows[1].dscr, null);
  assert.equal(result.rows[1].closingCash, null);
});

test('checkbox alone never fills a missing debt schedule; explicit zero is accepted', () => {
  const absent = computeScenario(scenario({ existingDebt: { complete: true, provenance: 'Attestation' } }));
  assert.equal(absent.coverage.existingDebtComplete, false);
  assert.equal(absent.summary.fullHorizonDscr, null);
  const zero = computeScenario(scenario({ existingDebt: { monthlyPayment: 0, complete: true, provenance: 'No existing debt attested' } }));
  assert.equal(zero.coverage.existingDebtComplete, true);
  assert.equal(zero.rows[1].dscr, 3);
});

test('keyed monthly debt schedule requires every displayed month or an evidenced explicit default', () => {
  const debt = { monthlyPayments: { '2026-01': 0, '2026-02': 500 }, complete: true, provenance: 'Synthetic schedule' };
  const complete = computeScenario(scenario({ horizonMonths: 2, existingDebt: debt }));
  assert.equal(complete.coverage.existingDebtComplete, true);
  assert.equal(complete.rows[0].existingDebtService, 0);
  assert.equal(complete.rows[1].existingDebtService, 500);
  assert.equal(computeScenario(scenario({ horizonMonths: 3, existingDebt: debt })).coverage.existingDebtComplete, false);
  const fallback = computeScenario(scenario({ horizonMonths: 3, existingDebt: { ...debt, monthlyPayment: 200 } }));
  assert.equal(fallback.rows[2].existingDebtService, 200);
  assert.equal(fallback.coverage.existingDebtComplete, true);
});

test('normalized cash needs provenance and is never inferred from profit or bank cash', () => {
  for (const normalizedPreDebtCash of [undefined, { monthlyAmount: 3000 }, { monthlyAmount: '', provenance: 'Note' }]) {
    const result = computeScenario(scenario({ normalizedPreDebtCash, profit: 900000, bankCash: 1000000 }));
    assert.equal(result.summary.fullHorizonDscr, null);
    assert.equal(result.summary.minCashBuffer, null);
  }
});

test('monthly cash override replaces rather than adds and must carry provenance', () => {
  const result = computeScenario(scenario({ monthlyOverrides: [{ month: '2026-02', preDebtCash: 1500, provenance: 'Synthetic seasonal bridge' }] }));
  assert.equal(result.rows[1].preDebtCash, 1500);
  assert.equal(result.rows[1].dscr, 1);
  assert.equal(result.rows[1].closingCash, result.rows[1].openingCash);
  const undocumented = computeScenario(scenario({ monthlyOverrides: [{ month: '2026-02', preDebtCash: 1500 }] }));
  assert.ok(undocumented.errors.length);
});

test('matched-horizon DSCR sums cash and debt for only displayed months, never annualizes one side', () => {
  const result = computeScenario(scenario({ horizonMonths: 2 }));
  assert.equal(result.summary.totalPreDebtCash, 6000);
  assert.equal(result.summary.totalDebtService, 2000);
  assert.equal(result.summary.fullHorizonDscr, 3);
  assert.equal(result.summary.proposedEndingBalance, 11000);
  assert.match(result.warnings.join(' '), /maturity.*outside/i);
});

test('zero debt service is N/A rather than infinity or a fabricated DSCR', () => {
  const result = computeScenario(scenario({ proposal: null, existingDebt: { monthlyPayment: 0, complete: true, provenance: 'No debt' } }));
  assert.equal(result.rows[1].dscr, null);
  assert.equal(result.summary.fullHorizonDscr, null);
  assert.equal(result.summary.worstMonthlyDscr, null);
  assert.equal(result.summary.totalDebtService, 0);
});

test('growth is explicit; positive growth requires an evidenced working-capital or inventory baseline', () => {
  for (const growth of [undefined, {}, { growthPct: 10 }, { growthPct: 10, baselineWorkingCapital: 100000, spreadMonths: 2 }]) {
    assert.ok(computeScenario(scenario({ growth })).errors.length, JSON.stringify(growth));
  }
  assert.deepEqual(computeScenario(scenario({ growth: { growthPct: 0 } })).errors, []);
  const result = computeScenario(scenario({ growth: { growthPct: 10, baselineWorkingCapital: 100000, spreadMonths: 2, provenance: 'Synthetic WC bridge' } }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.growthNeed, 10000);
  assert.equal(result.rows[0].workingCapitalUse, 5000);
  assert.equal(result.rows[1].workingCapitalUse, 5000);
  assert.equal(result.rows[2].workingCapitalUse, 0);
  assert.equal(result.summary.totalWorkingCapitalUse, 10000);
});

test('inventory baseline is an alternative to working capital, never additive to it', () => {
  const growth = { growthPct: 10, baselineInventory: 100000, spreadMonths: 3, provenance: 'Synthetic inventory cost snapshot' };
  const result = computeScenario(scenario({ growth }));
  assert.equal(result.summary.totalWorkingCapitalUse, 10000);
  assert.equal(result.rows[2].workingCapitalUse, 3333.34);
  assert.ok(computeScenario(scenario({ growth: { ...growth, baselineWorkingCapital: 100000 } })).errors.length);
});

test('stress loss is gross-contribution sensitivity on reduced revenue, not an operating cash proxy', () => {
  const result = computeScenario(scenario({ stress: { monthlyRevenue: 10000, grossMarginPct: 50, revenueDeclinePct: 10, marginCompressionPct: 5 } }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].stressCashReduction, 950);
  assert.equal(result.rows[1].preDebtCash, 2050);
  near(result.rows[1].dscr, 2050 / 1500, 1e-12);
  assert.match(result.methodology.join(' '), /gross.*cash/i);
  assert.ok(computeScenario(scenario({ stress: { revenueDeclinePct: 10, marginCompressionPct: 0 } })).errors.length);
  assert.deepEqual(computeScenario(scenario({ stress: { revenueDeclinePct: 0, marginCompressionPct: 0 } })).errors, []);
});

test('monthly use overrides replace calculated growth spending and other uses reduce cash only once', () => {
  const result = computeScenario(scenario({
    growth: { growthPct: 10, baselineWorkingCapital: 100000, spreadMonths: 2, provenance: 'WC bridge' },
    monthlyOverrides: [{ month: '2026-01', workingCapitalUse: 2000, otherCashUse: 500, provenance: 'Synthetic timing plan' }],
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].workingCapitalUse, 2000);
  assert.equal(result.rows[0].otherCashUse, 500);
  assert.equal(result.rows[0].closingCash, 22000);
  assert.equal(result.summary.totalWorkingCapitalUse, 7000);
});

test('growth-adjusted coverage deducts uses, while standard DSCR and closing cash remain distinct', () => {
  const result = computeScenario(scenario({
    growth: { growthPct: 10, baselineWorkingCapital: 100000, spreadMonths: 2, provenance: 'WC bridge' },
  }));
  assert.equal(result.rows[1].preDebtCash, 3000);
  assert.equal(result.rows[1].cashAfterUsesBeforeDebt, -2000);
  assert.equal(result.rows[1].dscr, 2);
  near(result.rows[1].growthAdjustedDscr, -2000 / 1500, 1e-12);
  assert.equal(result.rows[1].closingCash - result.rows[1].openingCash, -3500);
  near(result.summary.fullHorizonGrowthAdjustedDscr, (39000 - 10000) / (6500 + 12000), 1e-12);
  near(result.summary.worstGrowthAdjustedDscr, -2000 / 500, 1e-12);
});

test('null cash-use override is unknown and fails instead of becoming a zero use', () => {
  const unknown = computeScenario(scenario({ monthlyOverrides: [{ month: '2026-01', otherCashUse: null, provenance: 'Input required' }] }));
  assert.ok(unknown.errors.length);
  assert.equal(unknown.summary.endingCash, null);
  assert.deepEqual(computeScenario(scenario({ monthlyOverrides: [{ month: '2026-01', otherCashUse: 0, provenance: 'No initial use' }] })).errors, []);
});

test('missing starting cash or floor does not manufacture liquidity, and does not erase valid DSCR', () => {
  const missingCash = computeScenario(scenario({ startingCash: null }));
  assert.equal(missingCash.summary.endingCash, null);
  assert.equal(missingCash.summary.minCashBuffer, null);
  assert.equal(missingCash.rows[1].dscr, 2);
  const missingFloor = computeScenario(scenario({ requiredCashFloor: null }));
  assert.equal(missingFloor.summary.minCashBuffer, null);
  assert.ok(Number.isFinite(missingFloor.summary.endingCash));
});

test('starting buffer is retained when financing makes the first monthly close look safer', () => {
  const result = computeScenario(scenario({ startingCash: 1000 }));
  assert.equal(result.summary.minCashBuffer, -1000);
  assert.equal(result.summary.minCashBufferMonth, '2026-01 opening');
  assert.equal(result.summary.monthsBelowCashFloor, 0);
  assert.ok(result.rows.every(row => row.cashBuffer > 0));
});

test('no-debt baseline finances identical spending assumptions without conjuring a loan inflow', () => {
  const input = scenario({ monthlyOverrides: [{ month: '2026-01', otherCashUse: 12000, provenance: 'Synthetic loan-funded equipment use' }] });
  const financed = computeScenario(input);
  const unfinanced = computeScenario({ ...input, proposal: null });
  assert.equal(financed.rows[0].otherCashUse, unfinanced.rows[0].otherCashUse);
  assert.equal(unfinanced.summary.totalProposalInflow, 0);
  assert.equal(financed.rows[0].closingCash - unfinanced.rows[0].closingCash, 12000);
  assert.equal(unfinanced.rows[0].closingCash, 500);
});

test('low buffer includes starting liquidity and negative cash is visible rather than floored away', () => {
  const result = computeScenario(scenario({ startingCash: 1000, proposal: null, normalizedPreDebtCash: { monthlyAmount: -1000, provenance: 'Synthetic negative cash bridge' } }));
  assert.equal(result.rows[0].cashBuffer, -2500);
  assert.equal(result.rows[0].closingCash, -500);
  assert.equal(result.summary.monthsBelowCashFloor, 13);
  assert.equal(result.summary.minCashBufferMonth, '2027-01');
  assert.equal(result.summary.startingCashBuffer, -1000);
});

test('invalid and duplicate/out-of-horizon overrides fail clearly', () => {
  for (const monthlyOverrides of [
    [{ month: '2026-13', preDebtCash: 1, provenance: 'Note' }],
    [{ month: '2025-12', preDebtCash: 1, provenance: 'Note' }],
    [{ month: '2026-01', otherCashUse: -10, provenance: 'Note' }],
    [{ month: '2026-01' }, { month: '2026-01' }],
    'invalid',
  ]) assert.ok(computeScenario(scenario({ monthlyOverrides })).errors.length);
});

test('future proposal funds once at specified month; historic proposal is rejected to avoid cash double count', () => {
  const result = computeScenario(scenario({ proposal: loan({ startMonth: '2026-03', annualRatePct: 0 }) }));
  assert.equal(result.rows[0].proposalInflow, 0);
  assert.equal(result.rows[2].proposalInflow, 12000);
  assert.equal(result.rows[3].proposedPrincipal, 1000);
  assert.ok(computeScenario(scenario({ proposal: loan({ startMonth: '2025-12' }) })).errors.length);
});

test('scenario validates input shapes without throwing', () => {
  for (const input of [null, undefined, [], 'scenario']) assert.ok(computeScenario(input).errors.length);
  for (const change of [{ startMonth: 'bad' }, { horizonMonths: 0 }, { horizonMonths: 1.5 }, { requiredCashFloor: -1 }, { existingDebt: [] }, { growth: [] }, { stress: [] }]) {
    assert.ok(computeScenario(scenario(change)).errors.length);
  }
});

test('capacity inversion is fixed monthly amortization, permits zero rate and rejects missing facts', () => {
  assert.equal(illustrativeLoanPrincipal({ monthlyPayment: 1000, annualRatePct: 0, termMonths: 12 }).principal, 12000);
  assert.equal(illustrativeLoanPrincipal({ monthlyPayment: 0, annualRatePct: 12, termMonths: 12 }).principal, 0);
  const capacity = illustrativeLoanPrincipal({ monthlyPayment: 1000, annualRatePct: 12, termMonths: 12 });
  assert.deepEqual(capacity.errors, []);
  const debt = buildDebtSchedule(loan({ principal: capacity.principal }));
  near(debt.summary.periodicPayment, 1000);
  for (const field of ['monthlyPayment', 'annualRatePct', 'termMonths']) {
    assert.ok(illustrativeLoanPrincipal({ monthlyPayment: 1000, annualRatePct: 12, termMonths: 12, [field]: undefined }).errors.length);
  }
});

test('all pure calculations are deterministic and never modify input objects', () => {
  const input = scenario({ monthlyOverrides: [{ month: '2026-02', preDebtCash: 2500, provenance: 'Note' }] });
  const original = structuredClone(input);
  const first = computeScenario(input);
  const second = computeScenario(input);
  assert.deepEqual(input, original);
  assert.deepEqual(first, second);
});

test('upfront financing fees reduce cash once without changing principal or debt service', () => {
  const input = scenario({ proposal: loan({ annualRatePct: 0, upfrontFees: 1200 }) });
  const result = computeScenario(input);
  const noFees = computeScenario({ ...input, proposal: { ...input.proposal, upfrontFees: 0 } });
  const noLoan = computeScenario({ ...input, proposal: null });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].financingFees, 1200);
  assert.equal(result.rows[1].financingFees, 0);
  assert.equal(result.summary.totalFinancingFees, 1200);
  assert.equal(result.summary.endingCash, noFees.summary.endingCash - 1200);
  assert.equal(result.summary.totalProposedDebtService, noFees.summary.totalProposedDebtService);
  assert.equal(result.summary.fullHorizonDscr, noFees.summary.fullHorizonDscr);
  assert.equal(noLoan.summary.totalFinancingFees, 0);
  assert.equal(noLoan.rows[0].financingFees, 0);
});

test('explicit missing or malformed fees cannot become zero; omitted legacy fees are disclosed', () => {
  for (const upfrontFees of [null, '', -1, NaN, '100', undefined]) {
    const result = computeScenario(scenario({ proposal: loan({ upfrontFees }) }));
    assert.ok(result.errors.length);
    assert.equal(result.summary.endingCash, null);
  }
  assert.match(computeScenario(scenario()).warnings.join(' '), /assumes zero upfront loan fees/i);
});

test('a hand-entered existing payment is one cents figure everywhere it appears', () => {
  const input = scenario({ existingDebt: { monthlyPayment: 500.004, monthlyPayments: { '2026-03': 1000.005 }, complete: true, provenance: 'Statement' } });
  const result = computeScenario(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[1].existingDebtService, 500);
  assert.equal(result.rows[1].totalDebtService, result.rows[1].existingDebtService + result.rows[1].proposedDebtService);
  assert.equal(result.rows[2].existingDebtService, 1000.01);
  const summed = Math.round(result.rows.reduce((total, row) => total + row.existingDebtService, 0) * 100) / 100;
  assert.equal(result.summary.totalExistingDebtService, summed, 'summary equals the sum of the rows it describes');
});
