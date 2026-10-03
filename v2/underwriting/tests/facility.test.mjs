import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFacilityPortfolio } from '../facility-model.js';
import { computeScenario } from '../scenario-model.js';

// Preflight: this new pure adapter has no previous callers. The page selects ONE
// existing-debt authority before computeScenario; no source record, policy, grant,
// storage or network action changes. A retry/reorder/rename must be deterministic.
// Tests are defined before implementation. Actual lender documents, source dates,
// balance identity and full-obligation attestations remain live-evidence checks.
const emptyTerms = () => ({ annualRatePct: null, frequency: '', repayment: '', firstPaymentMonth: '', maturityMonth: '', amortizationMonths: null });
const facility = (overrides = {}) => ({
  id: 'f-1', name: 'Synthetic facility', kind: 'loan', balanceSource: 'manual', accountId: '',
  manualBalance: 12000, balanceAsOf: '2025-12-31', balanceProvenance: 'Synthetic opening lender balance', currency: 'USD',
  limit: null, borrowingBase: null, reserves: null, lenderAvailable: null,
  availabilityAsOf: '', availabilityProvenance: '',
  scheduleMode: 'payments', monthlyPayment: 1000, monthlyPayments: {}, scheduleComplete: true,
  scheduleProvenance: 'Synthetic full required P&I schedule including final maturity', terms: emptyTerms(),
  ...overrides,
});
const loc = (overrides = {}) => facility({
  kind: 'loc', limit: 100000, manualBalance: 40000, borrowingBase: 80000, reserves: 10000,
  availabilityAsOf: '2025-12-31', availabilityProvenance: 'Synthetic borrowing-base certificate and reserves',
  monthlyPayment: 500, ...overrides,
});
const termLoan = (overrides = {}) => facility({
  scheduleMode: 'terms', monthlyPayment: null,
  terms: { annualRatePct: 0, frequency: 'monthly', repayment: 'amortizing', firstPaymentMonth: '2026-01', maturityMonth: '2026-12', amortizationMonths: null },
  ...overrides,
});
const input = (overrides = {}) => ({
  facilities: [facility()], accountOptions: [], currency: 'USD', startMonth: '2026-01', horizonMonths: 12,
  mode: 'facilities', complete: true, provenance: 'Synthetic full facility register attestation',
  manualDebt: { monthlyPayment: 2500, monthlyPayments: {}, complete: true, provenance: 'Synthetic manual aggregate' },
  ...overrides,
});
const account = (overrides = {}) => ({
  id: 'conn-1:account-1', label: 'A label does not establish facility type', balance: 12000,
  balanceCurrency: 'USD', balanceAsOf: '2025-12-31', reportId: 'synthetic-report', ...overrides,
});

test('two facilities add P&I once, retaining stable identities and overlapping months', () => {
  const result = assessFacilityPortfolio(input({ facilities: [facility(), facility({ id: 'f-2', name: 'Second', monthlyPayment: 500, monthlyPayments: { '2026-03': 5000 } })] }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.scheduleComplete, true);
  assert.equal(result.existingDebt.complete, true);
  assert.equal(result.existingDebt.monthlyPayments['2026-01'], 1500);
  assert.equal(result.existingDebt.monthlyPayments['2026-03'], 6000);
  assert.equal(result.rows[0].byFacility.length, 2);
  assert.equal(result.totalBalance, 24000);
  assert.equal(result.reconciliation[0].manualPayment, 2500);
  assert.equal(result.reconciliation[0].difference, -1000);
});

test('manual mode stays authoritative and never adds facility service to the aggregate', () => {
  const result = assessFacilityPortfolio(input({ mode: 'manual', facilities: [facility({ monthlyPayment: 9000 })] }));
  assert.equal(result.existingDebt.monthlyPayments['2026-01'], 2500);
  assert.equal(result.existingDebt.complete, true);
  assert.equal(result.reconciliation[0].facilityPayment, 9000);
  assert.equal(result.reconciliation[0].difference, 6500);
  assert.match(result.warnings.join(' '), /manual.*authoritative|manual.*only/i);
});

test('unfinished reference facilities do not block an independently complete manual schedule', () => {
  const draft = facility({ manualBalance: null, scheduleComplete: false, scheduleProvenance: '', monthlyPayment: null });
  const result = assessFacilityPortfolio(input({ mode: 'manual', complete: false, facilities: [draft] }));
  assert.equal(result.scheduleComplete, false);
  assert.equal(result.existingDebt.complete, true);
  assert.equal(result.existingDebt.monthlyPayments['2026-01'], 2500);
  assert.equal(result.reconciliation[0].facilityPayment, null);
  assert.equal(result.reconciliation[0].difference, null);
});

test('facility mode replaces a conflicting manual total and integrates without proceeds', () => {
  const portfolio = assessFacilityPortfolio(input({ facilities: [facility({ monthlyPayment: 500 })] }));
  const modeled = computeScenario({
    startMonth: '2026-01', horizonMonths: 12, currency: 'USD', startingCash: 10000, requiredCashFloor: 0,
    normalizedPreDebtCash: { monthlyAmount: 3000, provenance: 'Synthetic normalized cash' },
    existingDebt: portfolio.existingDebt, proposal: null, growth: { growthPct: 0 }, cashCommitments: { complete: true, items: [] },
  });
  assert.equal(modeled.rows[0].existingDebtService, 500);
  assert.equal(modeled.rows[0].proposalInflow, 0);
  assert.equal(modeled.rows[0].closingCash, 12500);
  assert.equal(modeled.summary.totalProposalInflow, 0);
});

test('explicit zero service is known; blank default and missing keyed month remain unknown', () => {
  const zero = assessFacilityPortfolio(input({ facilities: [facility({ monthlyPayment: 0 })] }));
  assert.equal(zero.existingDebt.complete, true);
  assert.equal(zero.existingDebt.monthlyPayments['2026-01'], 0);
  const missing = assessFacilityPortfolio(input({ facilities: [facility({ monthlyPayment: null, monthlyPayments: { '2026-01': 0 } })] }));
  assert.equal(missing.existingDebt.complete, false);
  assert.equal(missing.existingDebt.monthlyPayments['2026-02'], undefined);
  assert.equal(missing.rows[1].payment, null);
});

test('individual and portfolio completeness/provenance are all required in facilities mode', () => {
  for (const change of [
    { complete: false }, { provenance: '' },
    { facilities: [facility({ scheduleComplete: false })] },
    { facilities: [facility({ scheduleProvenance: '' })] },
  ]) assert.equal(assessFacilityPortfolio(input(change)).existingDebt.complete, false);
});

test('an explicitly complete empty register can represent no debt, otherwise empty is unknown', () => {
  const yes = assessFacilityPortfolio(input({ facilities: [] }));
  assert.equal(yes.existingDebt.complete, true);
  assert.equal(yes.totalBalance, 0);
  assert.equal(yes.totalAvailable, 0);
  assert.equal(yes.existingDebt.monthlyPayments['2026-01'], 0);
  const no = assessFacilityPortfolio(input({ facilities: [], complete: false }));
  assert.equal(no.existingDebt.complete, false);
  assert.equal(no.totalAvailable, null);
});

test('only LOC availability aggregates; committed limit is never a synonym for available', () => {
  const result = assessFacilityPortfolio(input({ facilities: [loc(), facility({ id: 'term', limit: 900000, lenderAvailable: 500000, availabilityProvenance: 'Loan reference', availabilityAsOf: '2025-12-31' })] }));
  assert.equal(result.facilities[0].availability, 30000);
  assert.equal(result.facilities[1].availability, null);
  assert.equal(result.totalCommittedLimit, 100000);
  assert.equal(result.totalAvailable, 30000);
  assert.equal(result.knownAvailable, 30000);
  assert.equal(result.availabilityComplete, true);
});

test('a missing LOC availability stays unknown alongside a known subtotal', () => {
  const result = assessFacilityPortfolio(input({ facilities: [loc(), loc({ id: 'loc-2', borrowingBase: null, reserves: null })] }));
  assert.equal(result.knownAvailable, 30000);
  assert.equal(result.totalAvailable, null);
  assert.equal(result.availabilityComplete, false);
  assert.equal(result.totalCommittedLimit, 200000);
  const allUnknown = assessFacilityPortfolio(input({ facilities: [loc({ availabilityProvenance: '' })] }));
  assert.equal(allUnknown.knownAvailable, null);
  assert.equal(allUnknown.totalAvailable, null);
});

test('lender net available evidence is bounded and is never added to cash or subtracted by draw twice', () => {
  const result = assessFacilityPortfolio(input({ facilities: [loc({ borrowingBase: null, reserves: null, lenderAvailable: 50000 })] }));
  assert.equal(result.totalAvailable, 50000);
  assert.equal(result.existingDebt.monthlyPayments['2026-01'], 500);
  assert.equal(result.rows[0].payment, 500);
  assert.equal(result.facilities[0].availabilityDetail.committedHeadroom, 60000);
});

test('availability as-of evidence is required even when every numeric field is present', () => {
  for (const availabilityAsOf of ['', '2026-02-30', null]) {
    const result = assessFacilityPortfolio(input({ facilities: [loc({ availabilityAsOf })] }));
    assert.equal(result.totalAvailable, null);
  }
});

test('account balance is resolved by explicit current ID, never by name or stale manual fallback', () => {
  const f = facility({ balanceSource: 'account', accountId: 'conn-1:account-1', manualBalance: 999999, name: 'Whatever' });
  const result = assessFacilityPortfolio(input({ facilities: [f], accountOptions: [account()] }));
  assert.equal(result.facilities[0].balance, 12000);
  assert.equal(result.facilities[0].balanceAsOf, '2025-12-31');
  const missing = assessFacilityPortfolio(input({ facilities: [f], accountOptions: [account({ id: 'other', label: 'Whatever' })] }));
  assert.equal(missing.facilities[0].balance, null);
  assert.equal(missing.existingDebt.complete, false);
});

test('duplicate facility IDs and source account matches are blocked without double totals', () => {
  const f = facility({ balanceSource: 'account', accountId: 'conn-1:account-1' });
  for (const second of [{ ...f, name: 'Renamed' }, { ...f, id: 'second' }]) {
    const result = assessFacilityPortfolio(input({ facilities: [f, second], accountOptions: [account()] }));
    assert.ok(result.errors.some(error => /duplicate/i.test(error)));
    assert.equal(result.existingDebt.complete, false);
    assert.equal(result.totalBalance, null);
  }
  const ambiguous = assessFacilityPortfolio(input({ facilities: [f], accountOptions: [account(), account({ balance: 1 })] }));
  assert.equal(ambiguous.facilities[0].balance, null);
  assert.equal(ambiguous.existingDebt.complete, false);
});

test('different connections with the same provider account ID remain different explicit identities', () => {
  const result = assessFacilityPortfolio(input({ facilities: [facility({ balanceSource: 'account', accountId: 'conn-1:account-1' }), facility({ id: 'f-2', balanceSource: 'account', accountId: 'conn-2:account-1' })], accountOptions: [account(), account({ id: 'conn-2:account-1', balance: 8000 })] }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalBalance, 20000);
});

test('currency mismatches never sum currencies or convert using an invented FX rate', () => {
  const result = assessFacilityPortfolio(input({ facilities: [loc(), loc({ id: 'cad', currency: 'CAD' })] }));
  assert.equal(result.totalBalance, null);
  assert.equal(result.totalAvailable, null);
  assert.equal(result.existingDebt.complete, false);
  assert.equal(result.knownAvailable, 30000);
  const matched = assessFacilityPortfolio(input({ facilities: [facility({ balanceSource: 'account', accountId: 'conn-1:account-1' })], accountOptions: [account({ balanceCurrency: 'CAD' })] }));
  assert.equal(matched.existingDebt.complete, false);
});

test('current-month first loan payment uses existing opening principal, not a new-loan funding delay', () => {
  const result = assessFacilityPortfolio(input({ facilities: [termLoan()] }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.scheduleComplete, true);
  assert.equal(result.rows[0].payment, 1000);
  assert.equal(result.rows[11].payment, 1000);
  assert.equal(result.facilities[0].rows[0].principal, 1000);
  assert.equal(result.facilities[0].rows[11].endingBalance, 0);
  assert.equal(result.facilities[0].maturityMonth, '2026-12');
});

test('quarterly existing loan timing is explicit, including final interest-only balloon', () => {
  const result = assessFacilityPortfolio(input({ facilities: [termLoan({ terms: { annualRatePct: 12, frequency: 'quarterly', repayment: 'interest-only', firstPaymentMonth: '2026-02', maturityMonth: '2026-11', amortizationMonths: null } })] }));
  assert.equal(result.scheduleComplete, true);
  assert.equal(result.rows[0].payment, 0);
  assert.equal(result.rows[1].payment, 360);
  assert.equal(result.rows[4].payment, 360);
  assert.equal(result.rows[10].payment, 12360);
  assert.equal(result.rows[11].payment, 0);
});

test('misaligned maturity, unsupported first-payment grace and LOC term projection stay unknown', () => {
  for (const f of [
    termLoan({ terms: { ...termLoan().terms, frequency: 'quarterly', firstPaymentMonth: '2026-01', maturityMonth: '2026-12' } }),
    termLoan({ terms: { ...termLoan().terms, firstPaymentMonth: '2026-04' } }),
    termLoan({ terms: { ...termLoan().terms, firstPaymentMonth: '2025-12' } }),
    termLoan({ kind: 'loc' }),
  ]) {
    const result = assessFacilityPortfolio(input({ facilities: [f] }));
    assert.equal(result.scheduleComplete, false);
    assert.equal(result.existingDebt.complete, false);
  }
});

test('old balance cannot silently become a forecast-opening principal for term calculation', () => {
  const result = assessFacilityPortfolio(input({ facilities: [termLoan({ balanceAsOf: '2025-10-31' })] }));
  assert.equal(result.facilities[0].balance, 12000);
  assert.equal(result.facilities[0].scheduleComplete, false);
  assert.match(result.facilities[0].issues.join(' '), /opening|dated/i);
  assert.equal(assessFacilityPortfolio(input({ facilities: [termLoan({ balanceAsOf: '2026-01-01' })] })).scheduleComplete, true);
});

test('payment-mode P&I does not invent principal splits, remaining balance or maturity from balances', () => {
  const result = assessFacilityPortfolio(input({ facilities: [facility({ monthlyPayment: 100000 })] }));
  assert.equal(result.scheduleComplete, true);
  assert.equal(result.facilities[0].rows[0].principal, null);
  assert.equal(result.facilities[0].rows[0].interest, null);
  assert.equal(result.facilities[0].rows[0].endingBalance, null);
  assert.equal(result.facilities[0].remainingBalance, null);
  assert.equal(result.facilities[0].maturityMonth, null);
});

test('terms extend beyond cash horizon with disclosed residual, without inventing maturity within it', () => {
  const result = assessFacilityPortfolio(input({ facilities: [termLoan({ terms: { ...termLoan().terms, maturityMonth: '2028-12' } })] }));
  assert.equal(result.scheduleComplete, true);
  assert.ok(result.facilities[0].remainingBalance > 0);
  assert.equal(result.facilities[0].maturityMonth, '2028-12');
  assert.match(result.facilities[0].issues.join(' '), /outside.*horizon/i);
});

test('remove/reorder/rename acts by stable ID and recomputes without carrying stale totals', () => {
  const a = facility(); const b = facility({ id: 'f-2', monthlyPayment: 500 });
  const initial = assessFacilityPortfolio(input({ facilities: [a, b] }));
  const renamed = assessFacilityPortfolio(input({ facilities: [{ ...b, name: 'Renamed freely' }, a] }));
  assert.deepEqual(initial.existingDebt, renamed.existingDebt);
  const removed = assessFacilityPortfolio(input({ facilities: [b] }));
  assert.equal(removed.existingDebt.monthlyPayments['2026-01'], 500);
  assert.equal(removed.totalBalance, 12000);
  assert.equal(removed.facilities[0].id, 'f-2');
});

test('malformed inputs and unsafe values fail closed; execution is pure and bounded', () => {
  for (const invalid of [null, undefined, [], 'bad']) assert.equal(assessFacilityPortfolio(invalid).existingDebt.complete, false);
  for (const change of [{ facilities: Array(101).fill(facility()) }, { mode: 'both' }, { horizonMonths: 0 }, { startMonth: '2026-13' }]) assert.ok(assessFacilityPortfolio(input(change)).errors.length);
  for (const manualBalance of [-1, '100', NaN, Infinity, null]) assert.equal(assessFacilityPortfolio(input({ facilities: [facility({ manualBalance })] })).existingDebt.complete, false);
  const normal = input({ facilities: [loc(), termLoan({ id: 'loan-2' })] }); const before = structuredClone(normal);
  assert.deepEqual(assessFacilityPortfolio(normal), assessFacilityPortfolio(normal));
  assert.deepEqual(normal, before);
});

test('unknown facility type cannot certify there are zero LOCs', () => {
  const result = assessFacilityPortfolio(input({ facilities: [facility({ kind: '' })] }));
  assert.equal(result.totalAvailable, null);
  assert.equal(result.knownAvailable, null);
  assert.equal(result.totalCommittedLimit, null);
  assert.equal(result.availabilityComplete, false);
});

test('undocumented limit is not reported as a certified committed amount', () => {
  for (const change of [{ availabilityAsOf: '' }, { availabilityProvenance: '' }]) {
    const result = assessFacilityPortfolio(input({ facilities: [loc(change)] }));
    assert.equal(result.totalCommittedLimit, null);
    assert.equal(result.totalAvailable, null);
  }
});

test('incomplete selected debt uses missing keys, retaining model unknowns without malformed null inputs', () => {
  const portfolio = assessFacilityPortfolio(input({ facilities: [facility({ monthlyPayment: null })] }));
  const modeled = computeScenario({
    startMonth: '2026-01', horizonMonths: 12, startingCash: 10000, requiredCashFloor: 0,
    normalizedPreDebtCash: { monthlyAmount: 3000, provenance: 'Cash bridge' },
    existingDebt: portfolio.existingDebt, proposal: null, growth: { growthPct: 0 },
    currency: 'USD', cashCommitments: { complete: true, items: [] },
  });
  assert.deepEqual(modeled.errors, []);
  assert.equal(modeled.coverage.existingDebtComplete, false);
  assert.equal(modeled.rows[0].existingDebtService, null);
  assert.equal(modeled.rows[0].closingCash, null);
});

test('manual completeness is independent of duplicated reference matches', () => {
  const result = assessFacilityPortfolio(input({ mode: 'manual', facilities: [facility(), facility()] }));
  assert.ok(result.errors.length);
  assert.equal(result.existingDebt.complete, true);
  assert.equal(result.existingDebt.monthlyPayments['2026-01'], 2500);
});

test('zero documented loan balance and first due one interval after opening have explicit schedules', () => {
  const zero = assessFacilityPortfolio(input({ facilities: [termLoan({ manualBalance: 0 })] }));
  assert.equal(zero.scheduleComplete, true);
  assert.ok(zero.rows.every(row => row.payment === 0));
  const later = assessFacilityPortfolio(input({ facilities: [termLoan({ terms: { ...termLoan().terms, firstPaymentMonth: '2026-02', maturityMonth: '2027-01' } })] }));
  assert.equal(later.rows[0].payment, 0);
  assert.equal(later.rows[1].payment, 1000);
  assert.equal(later.facilities[0].remainingBalance, 1000);
});

test('amortizing balloon terms include scheduled principal plus residual at the documented maturity', () => {
  const f = termLoan({ terms: { ...termLoan().terms, repayment: 'balloon', amortizationMonths: 24 } });
  const result = assessFacilityPortfolio(input({ facilities: [f] }));
  assert.equal(result.scheduleComplete, true);
  assert.equal(result.rows[0].payment, 500);
  assert.equal(result.rows[11].payment, 6500);
  assert.equal(result.facilities[0].remainingBalance, 0);
  const missing = assessFacilityPortfolio(input({ facilities: [{ ...f, terms: { ...f.terms, amortizationMonths: null } }] }));
  assert.equal(missing.scheduleComplete, false);
});

test('annual due dates are retained rather than monthly averaged and missing rate is not zero', () => {
  const f = termLoan({ terms: { annualRatePct: 12, frequency: 'annual', repayment: 'interest-only', firstPaymentMonth: '2026-01', maturityMonth: '2027-01', amortizationMonths: null } });
  const result = assessFacilityPortfolio(input({ facilities: [f], horizonMonths: 13 }));
  assert.equal(result.rows[0].payment, 1440);
  assert.equal(result.rows[1].payment, 0);
  assert.equal(result.rows[12].payment, 13440);
  assert.equal(result.facilities[0].remainingBalance, 0);
  assert.equal(assessFacilityPortfolio(input({ facilities: [{ ...f, terms: { ...f.terms, annualRatePct: null } }] })).scheduleComplete, false);
});
