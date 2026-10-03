import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputNumber, validateScenarioDocument } from '../scenario-file.js';
import { computeScenario } from '../scenario-model.js';
import { assessFacilityPortfolio } from '../facility-model.js';
import { buildReviewSnapshot } from '../review-snapshot.js';
import { applyCashTimingStress } from '../cash-timing.js';

const definitions = [
  ['amount', 'Loan amount', 'number'], ['debtComplete', 'Complete', 'checkbox'],
  ['currency', 'Currency', 'select', '', '', [['', 'Choose'], ['USD', 'USD']]],
  ['startMonth', 'Month', 'month'], ['maturity', 'Maturity', 'date'],
  ['cashEvidence', 'Evidence', 'text'],
  ['commitmentsComplete', 'Commitments reviewed', 'checkbox'],
  ['upfrontFees', 'Upfront fees', 'number'], ['forecastMonths', 'Forecast months', 'number'],
  ['cashForecastReviewed', 'Cash forecast reviewed', 'checkbox'], ['termsProvenance', 'Terms source', 'text'],
  ['existingDebtMode', 'Debt source', 'select', 'manual', '', [['manual', 'Manual'], ['facilities', 'Facilities']]],
  ['facilitiesComplete', 'All facilities included', 'checkbox'], ['facilitiesProvenance', 'Portfolio scope', 'text'],
];
const timingRow = () => ({ enabled: false, amount: null, baselineReceipts: null, fromMonth: '', toMonth: '', sourceReference: '', reviewed: false });
const cashTiming = () => ({ collections: timingRow(), inventory: timingRow(), distinctReceiptPoolsReviewed: false });
const doc = () => ({ format: 'silo-underwriting-scenario', version: 4, companyId: 'company-a',
  values: { amount: '1000', debtComplete: false, currency: 'USD', startMonth: '2026-10', maturity: '', cashEvidence: '', commitmentsComplete: false,
    upfrontFees: '0', forecastMonths: '12', cashForecastReviewed: false, termsProvenance: '', existingDebtMode: 'manual', facilitiesComplete: false, facilitiesProvenance: '' },
  overrides: {}, commitments: [], facilities: [], cashTiming: cashTiming(), reviewBaseline: null,
});
const commitment = () => ({ id: 'po-a-deposit', month: '2026-10', amount: 500, currency: 'USD',
  sourceReference: 'PO A deposit · supplier terms reviewed', paymentType: 'deposit', inclusion: 'incremental', reviewed: true });
const validate = input => validateScenarioDocument(input, definitions, 'company-a');

test('input numbers preserve unknowns and reject non-decimal JS coercions', () => {
  for (const value of ['', '   ', '\t\n', null, undefined, true, false, [], '0x10', '0b10', 'Infinity', 'NaN', '1,000', '1.', '1e999']) assert.equal(parseInputNumber(value), null, String(value));
  for (const [value, expected] of [['0', 0], ['-0', -0], ['.5', .5], ['-.5', -.5], ['1e3', 1000], ['1E-3', .001], [' 12.5 ', 12.5]]) assert.equal(parseInputNumber(value), expected);
});

test('complete scenario imports preserve explicit unknowns and booleans', () => {
  const input = doc();
  assert.deepEqual(validate(input), { values: input.values, overrides: {}, commitments: [], facilities: [], cashTiming: cashTiming(), reviewBaseline: null, quick: { asOfMonth: null, basis: null, debts: [] } });
  input.values.amount = '';
  assert.equal(validate(input).values.amount, '');
});

test('incomplete scenarios cannot be patches over existing evidence', () => {
  for (const field of definitions.map(def => def[0])) {
    const input = doc(); delete input.values[field];
    assert.throws(() => validate(input), new RegExp(`missing ${field}`));
  }
  for (const value of [null, [], 'values']) assert.throws(() => validate({ ...doc(), values: value }));
  const noOverrides = doc(); delete noOverrides.overrides;
  assert.throws(() => validate(noOverrides), /monthly overrides/);
});

test('numeric imports canonicalize whitespace and exponents for native inputs', () => {
  const input = doc();
  input.values.amount = '   ';
  input.overrides = { '2026-10': { payment: '\t', preDebtCash: ' 1e3 ', workingCapitalUse: '-.5' } };
  const cleaned = validate(input);
  assert.equal(cleaned.values.amount, '');
  assert.deepEqual(cleaned.overrides['2026-10'], { payment: '', preDebtCash: '1000', workingCapitalUse: '-0.5' });
  assert.equal(input.values.amount, '   ', 'validator does not mutate input');
});

test('invalid numeric values are rejected in main fields and monthly overrides', () => {
  for (const value of ['0x10', '0b10', 'Infinity', '1e999', true, 10, null, '1,000', '1.']) {
    const input = doc(); input.values.amount = value;
    assert.throws(() => validate(input), /Invalid amount/);
    const monthly = doc(); monthly.overrides = { '2026-10': { payment: value } };
    assert.throws(() => validate(monthly), /Invalid 2026-10 payment/);
  }
});

test('scenario identity, field types, selections and calendar strings are checked', () => {
  for (const input of [null, [], { ...doc(), version: 5 }, { ...doc(), companyId: 'company-b' }]) assert.throws(() => validate(input));
  for (const [field, value] of [['debtComplete', 'true'], ['currency', 'NOT_A_CURRENCY'], ['startMonth', '2026-13'], ['maturity', '2026-02-29'], ['cashEvidence', {}]]) {
    const input = doc(); input.values[field] = value;
    assert.throws(() => validate(input), new RegExp(`Invalid ${field}`));
  }
  const leap = doc(); leap.values.maturity = '2028-02-29';
  assert.equal(validate(leap).values.maturity, '2028-02-29');
});

test('monthly override containers and keys are validated', () => {
  for (const overrides of [[], null, { '2026-13': {} }, { '2026-10': [] }, { '2026-10': { principal: '100' } }]) assert.throws(() => validate({ ...doc(), overrides }));
});

test('older versions require multi-facility re-entry rather than inferring debt-source policy', () => {
  for (const version of [1, 2, 3]) {
    const input = { ...doc(), version };
    for (const key of ['upfrontFees', 'forecastMonths', 'cashForecastReviewed', 'termsProvenance']) delete input.values[key];
    assert.throws(() => validate(input), new RegExp(`Version ${version}.*multi-facility register.*Re-enter.*version 4.*Nothing was loaded`));
  }
});

test('commitments are a required complete replacement, including an explicit empty list', () => {
  const input = doc(); delete input.commitments;
  assert.throws(() => validate(input), /commitments list/);
  assert.deepEqual(validate(doc()).commitments, []);
  const original = commitment();
  const clean = validate({ ...doc(), commitments: [original] });
  assert.deepEqual(clean.commitments, [original]);
  assert.notEqual(clean.commitments[0], original);
});

test('unreviewed commitment drafts retain explicit unknown values instead of zero', () => {
  const draft = { id: 'draft-1', month: '', amount: null, currency: '', sourceReference: '', paymentType: '', inclusion: '', reviewed: false };
  assert.deepEqual(validate({ ...doc(), commitments: [draft] }).commitments, [draft]);
  assert.throws(() => validate({ ...doc(), commitments: [{ ...draft, reviewed: true }] }), /commitment 1 month/);
});

test('reviewed commitments require valid dates, amounts, currency, evidence and enums', () => {
  const bad = { month: ['', '2026-13', '2026-02-31'], amount: [null, '', '500', -1, Infinity, NaN, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER / (100 * 1201 * 4) + 1],
    currency: ['', 'usd', 'US', 'USD CAD'], sourceReference: ['', '  ', 'x'.repeat(2001)],
    paymentType: ['', 'principal'], inclusion: ['', 'included', 'ignore'], reviewed: ['true', 1, null] };
  for (const [field, values] of Object.entries(bad)) for (const value of values) {
    assert.throws(() => validate({ ...doc(), commitments: [{ ...commitment(), [field]: value }] }), /Invalid commitment/, `${field}: ${value}`);
  }
  for (const paymentType of ['deposit', 'balance', 'other']) for (const inclusion of ['incremental', 'included-in-pre-debt-cash', 'included-in-working-capital', 'included-in-other-cash-use']) {
    const entry = { ...commitment(), amount: 0, paymentType, inclusion };
    assert.deepEqual(validate({ ...doc(), commitments: [entry] }).commitments[0], entry);
  }
});

test('commitment rows are bounded and require distinct complete identities', () => {
  for (const commitments of [null, {}, Array.from({ length: 501 }, (_, i) => ({ ...commitment(), id: String(i) })), [commitment(), commitment()],
    [commitment(), { ...commitment(), id: ' po-a-deposit ' }], [{ ...commitment(), id: '' }], [{ ...commitment(), id: 'x'.repeat(129) }],
    [{ ...commitment(), companyId: 'other-company' }]]) assert.throws(() => validate({ ...doc(), commitments }), /commitment/i);
  for (const field of Object.keys(commitment())) {
    const entry = commitment(); delete entry[field];
    assert.throws(() => validate({ ...doc(), commitments: [entry] }), /all commitment fields are required/);
  }
});

test('the same source, month and payment stage cannot be imported twice', () => {
  const first = { ...commitment(), sourceReference: ' PO A  deposit ' };
  const repeated = { ...commitment(), id: 'different-id', sourceReference: 'po a\tdeposit' };
  assert.throws(() => validate({ ...doc(), commitments: [first, repeated] }), /duplicate source, month and payment type/);
  for (const changed of [{ ...repeated, month: '2026-11' }, { ...repeated, paymentType: 'balance' }]) {
    assert.equal(validate({ ...doc(), commitments: [first, changed] }).commitments.length, 2);
  }
  const draft = { ...first, month: '', reviewed: false };
  assert.equal(validate({ ...doc(), commitments: [draft, { ...draft, id: 'draft-other' }] }).commitments.length, 2);
});

const computeImported = imported => computeScenario({ startMonth: imported.values.startMonth, horizonMonths: 12,
  currency: imported.values.currency, startingCash: 5000, requiredCashFloor: 0,
  normalizedPreDebtCash: { monthlyAmount: 1000, provenance: 'Synthetic cash bridge' },
  existingDebt: { monthlyPayment: 100, complete: true, provenance: 'Synthetic complete debt schedule' },
  proposal: null, growth: { growthPct: 0 },
  cashCommitments: { complete: imported.values.commitmentsComplete, items: imported.commitments },
});

test('imported reviewed commitments enter cash once and remain separate from debt service', () => {
  const input = doc(); input.values.commitmentsComplete = true; input.commitments = [commitment()];
  const result = computeImported(validate(input));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].commitmentCashUse, 500);
  assert.equal(result.rows[0].existingDebtService, 100);
  assert.equal(result.rows[0].closingCash, 5400);
  assert.equal(result.rows[0].dscr, 10);
  assert.equal(result.summary.totalCommitmentCashUse, 500);
});

test('reopened explicit draft unknowns block cash coverage without blocking documented debt service', () => {
  const input = doc(); input.values.commitmentsComplete = true;
  input.commitments = [{ id: 'draft-1', month: '', amount: null, currency: '', sourceReference: '', paymentType: '', inclusion: '', reviewed: false }];
  const result = computeImported(validate(input));
  assert.deepEqual(result.errors, []);
  assert.equal(result.coverage.commitmentsComplete, false);
  assert.equal(result.summary.endingCash, null);
  assert.equal(result.rows[0].commitmentCashUse, null);
  assert.equal(result.rows[0].dscr, 10);
});

test('import does not certify mismatched currency, out-of-horizon dates or unsupported inclusion amounts', () => {
  for (const change of [{ currency: 'CAD' }, { month: '2027-11' }, { inclusion: 'included-in-other-cash-use' }]) {
    const input = doc(); input.values.commitmentsComplete = true; input.commitments = [{ ...commitment(), ...change }];
    const result = computeImported(validate(input));
    assert.equal(result.coverage.commitmentsComplete, false, JSON.stringify(change));
    assert.equal(result.summary.endingCash, null, JSON.stringify(change));
  }
});

const facilityTerms = () => ({ annualRatePct: null, frequency: '', repayment: '', firstPaymentMonth: '', maturityMonth: '', amortizationMonths: null });
const facility = () => ({ id: 'facility-a', name: 'Synthetic operating LOC', kind: 'loc', balanceSource: 'account', accountId: 'connection-a:42',
  manualBalance: null, balanceAsOf: '', balanceProvenance: '', currency: 'USD', limit: 100000, borrowingBase: 80000, reserves: 5000,
  lenderAvailable: 35000, availabilityAsOf: '2026-10-01', availabilityProvenance: 'Synthetic lender certificate',
  scheduleMode: 'payments', monthlyPayment: 300, monthlyPayments: { '2026-12': 10300 }, scheduleComplete: true,
  scheduleProvenance: 'Synthetic monthly payment schedule and December payoff', terms: facilityTerms() });
const draftFacility = () => ({ id: 'draft-a', name: '', kind: '', balanceSource: '', accountId: '',
  manualBalance: null, balanceAsOf: '', balanceProvenance: '', currency: '', limit: null, borrowingBase: null, reserves: null,
  lenderAvailable: null, availabilityAsOf: '', availabilityProvenance: '', scheduleMode: '', monthlyPayment: null, monthlyPayments: {},
  scheduleComplete: false, scheduleProvenance: '', terms: facilityTerms() });

test('v4 requires an explicit facility replacement list and explicit debt-source policy', () => {
  const input = doc(); delete input.facilities;
  assert.throws(() => validate(input), /facilities list/);
  for (const field of ['existingDebtMode', 'facilitiesComplete', 'facilitiesProvenance']) {
    const input = doc(); delete input.values[field];
    assert.throws(() => validate(input), new RegExp(`missing ${field}`));
  }
  for (const value of ['', 'both', 'automatic', null, true]) {
    const input = doc(); input.values.existingDebtMode = value;
    assert.throws(() => validate(input), /Invalid existingDebtMode/);
  }
  for (const mode of ['manual', 'facilities']) {
    const input = doc(); input.values.existingDebtMode = mode; input.facilities = [facility()];
    assert.equal(validate(input).values.existingDebtMode, mode);
    assert.deepEqual(validate(input).facilities, [facility()]);
  }
});

test('facilities import as independently cloned complete rows, with no inherited defaults', () => {
  const input = { ...doc(), facilities: [facility()] };
  const before = JSON.stringify(input); const result = validate(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result.facilities, input.facilities);
  assert.notEqual(result.facilities[0], input.facilities[0]);
  assert.notEqual(result.facilities[0].terms, input.facilities[0].terms);
  assert.notEqual(result.facilities[0].monthlyPayments, input.facilities[0].monthlyPayments);
  result.facilities[0].monthlyPayments['2026-12'] = 0;
  assert.equal(input.facilities[0].monthlyPayments['2026-12'], 10300);
  for (const field of Object.keys(facility())) {
    const row = facility(); delete row[field];
    assert.throws(() => validate({ ...doc(), facilities: [row] }), /all facility fields are required/, field);
  }
  for (const field of Object.keys(facilityTerms())) {
    const row = facility(); delete row.terms[field];
    assert.throws(() => validate({ ...doc(), facilities: [row] }), /all term fields are required/, field);
  }
  for (const extra of [{ companyId: 'company-b' }, { bookDrawn: 0 }, { available: 100000 }]) {
    assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), ...extra }] }), /unknown fields/);
  }
});

test('facility drafts preserve unknown fields and explicit zero amounts separately', () => {
  const draft = draftFacility();
  assert.deepEqual(validate({ ...doc(), facilities: [draft] }).facilities, [draft]);
  const zero = { ...draft, manualBalance: 0, limit: 0, borrowingBase: 0, reserves: 0, lenderAvailable: 0, monthlyPayment: 0,
    monthlyPayments: { '2026-10': 0 }, terms: { ...facilityTerms(), annualRatePct: 0 } };
  assert.deepEqual(validate({ ...doc(), facilities: [zero] }).facilities, [zero]);
  const reviewedDraft = { ...draft, scheduleComplete: true };
  assert.deepEqual(validate({ ...doc(), facilities: [reviewedDraft] }).facilities, [reviewedDraft], 'import preserves user assertions; the model must independently check sufficiency');
});

test('facility arrays and identities are bounded and duplicate source matches are rejected', () => {
  for (const facilities of [null, {}, 'facilities', [null], [[]], Array.from({ length: 101 }, (_, i) => ({ ...draftFacility(), id: String(i) }))]) {
    assert.throws(() => validate({ ...doc(), facilities }), /facilit/i);
  }
  for (const id of ['', '  ', 'x'.repeat(129), 42, null]) assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), id }] }), /unique ID/);
  assert.throws(() => validate({ ...doc(), facilities: [draftFacility(), { ...draftFacility(), id: ' draft-a ' }] }), /unique ID/);
  assert.throws(() => validate({ ...doc(), facilities: [facility(), { ...facility(), id: 'different-id' }] }), /duplicate account match/);
  assert.throws(() => validate({ ...doc(), facilities: [facility(), { ...facility(), id: 'different-id', accountId: ' connection-a:42 ' }] }), /duplicate account match/);
  const distinct = [facility(), { ...facility(), id: 'facility-b', accountId: 'connection-b:42' }];
  assert.equal(validate({ ...doc(), facilities: distinct }).facilities.length, 2, 'same raw QBO ID on different connections is distinct');
  const drafts = Array.from({ length: 100 }, (_, i) => ({ ...draftFacility(), id: String(i) }));
  assert.equal(validate({ ...doc(), facilities: drafts }).facilities.length, 100);
});

test('facility monetary fields reject coercion, negatives and unsupported numeric ranges', () => {
  const limit = Number.MAX_SAFE_INTEGER / (100 * 1201 * 4);
  for (const key of ['manualBalance', 'limit', 'borrowingBase', 'reserves', 'lenderAvailable', 'monthlyPayment']) {
    for (const amount of ['', '100', false, -1, Infinity, NaN, limit + 1, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), [key]: amount }] }), /Invalid facility/, `${key}: ${amount}`);
    }
    assert.equal(validate({ ...doc(), facilities: [{ ...facility(), [key]: limit }] }).facilities[0][key], limit);
  }
});

test('facility enums, text, currency, full dates and term dates are strictly typed', () => {
  const invalid = { kind: ['bank', 'LOC', null], balanceSource: ['inferred', 'QBO', null], scheduleMode: ['both', 'estimated', null],
    scheduleComplete: [null, 'true', 1], currency: ['usd', 'US', 'USD CAD', null], name: [null, {}, 'x'.repeat(2001)],
    accountId: [42, {}, 'x'.repeat(2001)], balanceAsOf: ['2026-02-29', '2026-10', '2026-10-01T00:00:00Z', null],
    availabilityAsOf: ['2026-04-31', '2026-00-01', null], balanceProvenance: [null, []], availabilityProvenance: [null, 'x'.repeat(2001)], scheduleProvenance: [true] };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), [key]: value }] }), /Invalid facility/, `${key}: ${value}`);
  }
  const terms = { annualRatePct: [-1, NaN, Infinity, '0', false], frequency: ['weekly', null], repayment: ['revolver', null],
    firstPaymentMonth: ['2026-00', '2026-10-01', null], maturityMonth: ['2026-13', null], amortizationMonths: [0, -1, 1.5, 1201, '12', false] };
  for (const [key, values] of Object.entries(terms)) for (const value of values) {
    assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), terms: { ...facilityTerms(), [key]: value } }] }), /Invalid facility/, `${key}: ${value}`);
  }
  const leap = { ...facility(), balanceAsOf: '2028-02-29', currency: 'CAD' };
  assert.equal(validate({ ...doc(), facilities: [leap] }).facilities[0].currency, 'CAD', 'import does not imply consolidated-currency eligibility');
  assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), scheduleMode: 'terms' }] }), /LOC facilities require/);
});

test('facility monthly payment overrides are explicit dated bounded numbers', () => {
  for (const monthlyPayments of [null, [], { '2026-13': 1 }, { '2026-10': null }, { '2026-10': '' }, { '2026-10': '100' },
    { '2026-10': -1 }, { '2026-10': Infinity }, { '2026-10': Number.MAX_SAFE_INTEGER },
    Object.fromEntries(Array.from({ length: 1201 }, (_, i) => [`${2000 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`, 0]))]) {
    assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), monthlyPayments }] }), /Invalid facility/);
  }
  const complete = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`${2000 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`, 0]));
  assert.equal(Object.keys(validate({ ...doc(), facilities: [{ ...facility(), monthlyPayments: complete }] }).facilities[0].monthlyPayments).length, 1200);
});

test('facility imports cannot cross the active company boundary', () => {
  assert.throws(() => validate({ ...doc(), companyId: 'company-b', facilities: [facility()] }), /another company/);
  const input = { ...doc(), facilities: [facility()] };
  assert.equal(validate(input).facilities[0].accountId, 'connection-a:42', 'source membership is re-resolved by the current-company model, never certified by JSON');
});

test('v4 cash-timing assumptions are required complete replacements, with explicit draft unknowns', () => {
  const input = doc(); delete input.cashTiming;
  assert.throws(() => validate(input), /cashTiming assumptions/);
  const original = cashTiming(); original.collections.enabled = true;
  const output = validate({ ...doc(), cashTiming: original }).cashTiming;
  assert.deepEqual(output, original);
  assert.notEqual(output.collections, original.collections);
  assert.equal(output.collections.amount, null);
  for (const key of Object.keys(original)) {
    const incomplete = cashTiming(); delete incomplete[key];
    assert.throws(() => validate({ ...doc(), cashTiming: incomplete }), /cashTiming/);
  }
  for (const key of Object.keys(timingRow())) {
    const incomplete = cashTiming(); delete incomplete.inventory[key];
    assert.throws(() => validate({ ...doc(), cashTiming: incomplete }), /all timing fields are required/);
  }
});

test('cash timing rejects malformed, oversized and unknown fields even on disabled rows', () => {
  for (const value of [null, [], {}, { ...cashTiming(), inferredRevenue: 100 }]) assert.throws(() => validate({ ...doc(), cashTiming: value }), /cashTiming/);
  const invalid = { enabled: ['true', null, 1], reviewed: ['true', null, 1], amount: ['', '0', -1, Infinity, Number.MAX_SAFE_INTEGER],
    baselineReceipts: ['', '0', -1, NaN, Number.MAX_SAFE_INTEGER], fromMonth: [null, '2026-13', '2026-10-01'], toMonth: [null, '2026-00'],
    sourceReference: [null, [], 'x'.repeat(2001)] };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    const timing = cashTiming(); timing.collections[key] = value;
    assert.throws(() => validate({ ...doc(), cashTiming: timing }), /Invalid cashTiming/, `${key}: ${value}`);
  }
  const extra = cashTiming(); extra.collections.cash = 100;
  assert.throws(() => validate({ ...doc(), cashTiming: extra }), /all timing fields/);
  for (const value of [null, 'true', 1]) assert.throws(() => validate({ ...doc(), cashTiming: { ...cashTiming(), distinctReceiptPoolsReviewed: value } }), /cashTiming/);
  const zero = cashTiming(); zero.inventory.amount = 0; zero.inventory.baselineReceipts = 0;
  assert.equal(validate({ ...doc(), cashTiming: zero }).cashTiming.inventory.amount, 0);
});

const importedPortfolio = (input, accountOptions = [{ id: 'connection-a:42', balance: 40000, balanceCurrency: 'USD', balanceAsOf: '2026-09-30' }]) => {
  const imported = validate(input);
  return assessFacilityPortfolio({ facilities: imported.facilities, accountOptions, currency: imported.values.currency,
    startMonth: imported.values.startMonth, horizonMonths: 12, mode: imported.values.existingDebtMode,
    complete: imported.values.facilitiesComplete, provenance: imported.values.facilitiesProvenance,
    manualDebt: { monthlyPayment: 900, monthlyPayments: {}, complete: true, provenance: 'Independent synthetic manual debt schedule' } });
};

test('imported debt mode selects exactly one authoritative schedule and never adds facility payments twice', () => {
  const input = doc(); input.facilities = [facility()];
  Object.assign(input.values, { facilitiesComplete: true, facilitiesProvenance: 'Synthetic all-obligation scope review' });
  let portfolio = importedPortfolio(input);
  assert.equal(portfolio.existingDebt.complete, true);
  assert.equal(portfolio.existingDebt.monthlyPayments['2026-10'], 900);
  assert.equal(portfolio.reconciliation[0].facilityPayment, 300);
  input.values.existingDebtMode = 'facilities';
  portfolio = importedPortfolio(input);
  assert.equal(portfolio.existingDebt.complete, true);
  assert.equal(portfolio.existingDebt.monthlyPayments['2026-10'], 300);
  assert.equal(portfolio.existingDebt.monthlyPayments['2026-12'], 10300);
  const computed = computeScenario({ startMonth: '2026-10', horizonMonths: 12, currency: 'USD', startingCash: 5000, requiredCashFloor: 0,
    normalizedPreDebtCash: { monthlyAmount: 1000, provenance: 'Synthetic cash forecast' }, existingDebt: portfolio.existingDebt,
    proposal: null, growth: { growthPct: 0 }, cashCommitments: { complete: true, items: [] } });
  assert.equal(computed.rows[0].existingDebtService, 300);
  assert.equal(computed.rows[0].proposalInflow, 0);
  assert.equal(computed.rows[0].closingCash, 5700);
});

test('reopened facility review flags cannot certify missing source matches, currency or draft schedules', () => {
  const input = doc(); input.facilities = [facility()];
  Object.assign(input.values, { existingDebtMode: 'facilities', facilitiesComplete: true, facilitiesProvenance: 'Synthetic scope review' });
  let portfolio = importedPortfolio(input, []);
  assert.equal(portfolio.existingDebt.complete, false);
  assert.equal(portfolio.facilities[0].balance, null);
  assert.equal(portfolio.totalAvailable, null);
  for (const change of [{ currency: 'CAD' }, { monthlyPayment: null }, { scheduleProvenance: '' }, { scheduleComplete: false }]) {
    portfolio = importedPortfolio({ ...input, facilities: [{ ...facility(), ...change }] });
    assert.equal(portfolio.existingDebt.complete, false, JSON.stringify(change));
  }
  input.facilities = [{ ...draftFacility(), scheduleComplete: true }];
  assert.equal(importedPortfolio(input).existingDebt.complete, false);
  input.values.existingDebtMode = 'manual';
  assert.equal(importedPortfolio(input).existingDebt.complete, true, 'incomplete reference facilities never replace documented manual debt');
});

test('review baseline must be explicit, canonical and bound to the active company', () => {
  const input = doc(); delete input.reviewBaseline;
  assert.throws(() => validate(input), /explicitly state reviewBaseline/);
  assert.equal(validate(doc()).reviewBaseline, null);
  const companyId = '11111111-1111-4111-8111-111111111111';
  const baseline = buildReviewSnapshot({ companyId, createdAt: '2026-10-01T12:00:00Z',
    assumptions: [{ id: 'opening-cash', value: 5000, unit: 'currency', currency: 'USD' }],
    sources: [{ id: 'bank', status: 'available', asOf: '2026-09-30', currency: 'USD', metrics: [{ id: 'book-cash', value: 5000 }] }],
    outcomes: [{ id: 'cash-gap', value: 1000, unit: 'currency', currency: 'USD' }] });
  const full = { ...doc(), companyId, reviewBaseline: baseline };
  const clean = validateScenarioDocument(full, definitions, companyId);
  assert.deepEqual(clean.reviewBaseline, baseline);
  assert.notEqual(clean.reviewBaseline, baseline);
  assert.notEqual(clean.reviewBaseline.assumptions[0], baseline.assumptions[0]);
  assert.equal(clean.reviewBaseline.createdAt, '2026-10-01T12:00:00.000Z');
  assert.throws(() => validateScenarioDocument({ ...full, reviewBaseline: { ...baseline, companyId: '22222222-2222-4222-8222-222222222222' } }, definitions, companyId), /different company/);
  for (const reviewBaseline of [undefined, [], { ...baseline, rawRows: [] }, { ...baseline, conclusionsVerified: true },
    { ...baseline, createdAt: '' }, { ...baseline, sources: [{ ...baseline.sources[0], metrics: [{ id: 'unsafe', value: 'private narrative' }] }] }]) {
    assert.throws(() => validateScenarioDocument({ ...full, reviewBaseline }, definitions, companyId));
  }
});

const timingModel = () => ({ startMonth: '2026-10', horizonMonths: 12, currency: 'USD', startingCash: 5000, requiredCashFloor: 0,
  normalizedPreDebtCash: { monthlyAmount: 1000, provenance: 'Synthetic net cash bridge' },
  existingDebt: { monthlyPayment: 100, monthlyPayments: {}, complete: true, provenance: 'Synthetic debt schedule' },
  proposal: null, growth: { growthPct: 0 }, cashCommitments: { complete: true, items: [] },
  stress: { monthlyRevenue: 1000, revenueDeclinePct: 10, grossMarginPct: 40, marginCompressionPct: 0 },
  monthlyOverrides: [{ month: '2026-10', otherCashUse: 100, provenanceByField: { otherCashUse: 'Synthetic use evidence' } }] });

test('imported receipt timing adjusts cash once while preserving separate downside, debt and use evidence', () => {
  const input = doc(); input.cashTiming.collections = { enabled: true, amount: 200, baselineReceipts: 500,
    fromMonth: '2026-10', toMonth: '2026-11', sourceReference: 'Synthetic retained receipt pool', reviewed: true };
  const model = timingModel(), before = JSON.stringify(model);
  const timing = applyCashTimingStress(model, validate(input).cashTiming);
  assert.equal(timing.ready, true);
  assert.equal(JSON.stringify(model), before);
  assert.deepEqual(timing.model.stress, model.stress);
  assert.deepEqual(timing.model.existingDebt, model.existingDebt);
  assert.equal(timing.model.monthlyOverrides[0].provenanceByField.otherCashUse, 'Synthetic use evidence');
  assert.equal(timing.model.monthlyOverrides[0].provenanceByField.preDebtCash, 'Synthetic net cash bridge');
  const baseline = computeScenario(model), result = computeScenario(timing.model);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].closingCash, baseline.rows[0].closingCash - 200);
  assert.equal(result.rows[1].closingCash, baseline.rows[1].closingCash);
  assert.equal(result.rows[0].existingDebtService, baseline.rows[0].existingDebtService);
  assert.equal(result.rows[0].otherCashUse, baseline.rows[0].otherCashUse);
  assert.equal(result.summary.endingCash, baseline.summary.endingCash);
});

test('imported timing drafts and unsupported receipt pools cannot fall back to an unstressed cash model', () => {
  for (const change of [{ amount: null }, { baselineReceipts: 100 }, { reviewed: false }, { fromMonth: '' }, { sourceReference: '' }]) {
    const input = doc(); input.cashTiming.collections = { enabled: true, amount: 200, baselineReceipts: 500,
      fromMonth: '2026-10', toMonth: '2026-11', sourceReference: 'Synthetic retained receipt pool', reviewed: true, ...change };
    const timing = applyCashTimingStress(timingModel(), validate(input).cashTiming);
    assert.equal(timing.ready, false, JSON.stringify(change));
    assert.equal(timing.model, null);
    assert.equal(timing.totalCashImpact, null);
  }
  const input = doc(); input.cashTiming.collections = { enabled: true, amount: 200, baselineReceipts: 500,
    fromMonth: '2026-10', toMonth: '2027-10', sourceReference: 'Synthetic recovery beyond the forecast', reviewed: true };
  const timing = applyCashTimingStress(timingModel(), validate(input).cashTiming);
  assert.equal(timing.ready, true);
  assert.equal(timing.recoveryBeyondHorizon, 200);
  assert.equal(computeScenario(timing.model).summary.endingCash, computeScenario(timingModel()).summary.endingCash - 200);
});

test('imported facility and commitment IDs must fit the review-snapshot identifier grammar', () => {
  // review-snapshot.js refuses a fact id outside /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/,
  // and builds `payment:<facility id>:<month>`; an id that cannot form one would
  // leave review capture permanently unavailable after import.
  for (const id of ['<img src=x onerror=alert(1)> loan', 'has space', '-leading-dash', 'x'.repeat(101), 'tab\there']) {
    assert.throws(() => validate({ ...doc(), facilities: [{ ...facility(), id }] }), /unique ID/, `facility ${id}`);
    assert.throws(() => validate({ ...doc(), commitments: [{ ...commitment(), id }] }), /unique ID/, `commitment ${id}`);
  }
  for (const id of ['11111111-1111-4111-8111-111111111111', 'facility-1700000000000-0', 'po:A/1.2_b', 'x'.repeat(100)]) {
    assert.equal(validate({ ...doc(), facilities: [{ ...facility(), id }] }).facilities[0].id, id);
    assert.equal(validate({ ...doc(), commitments: [{ ...commitment(), id }] }).commitments[0].id, id);
  }
  const snapshotFromImported = validate({ ...doc(), facilities: [{ ...facility(), id: 'x'.repeat(100) }] });
  assert.ok(snapshotFromImported.facilities.length === 1);
});

test('monthly overrides are bounded and empty months are not carried', () => {
  const months = [];
  for (let year = 1000; months.length <= 1200; year++) for (let month = 1; month <= 12 && months.length <= 1200; month++) months.push(`${year}-${String(month).padStart(2, '0')}`);
  assert.throws(() => validate({ ...doc(), overrides: Object.fromEntries(months.map(month => [month, {}])) }), /at most 1200/);
  assert.deepEqual(validate({ ...doc(), overrides: Object.fromEntries(months.slice(0, 1200).map(month => [month, {}])) }).overrides, {}, 'empty rows are dropped');
  assert.deepEqual(validate({ ...doc(), overrides: { '2026-10': {}, '2026-11': { preDebtCash: '5' } } }).overrides, { '2026-11': { preDebtCash: '5' } });
});

test('the optional quick-look section stores only ticks and typed payments per account id', () => {
  assert.deepEqual(validate(doc()).quick, { asOfMonth: null, basis: null, debts: [] }, 'absent means none');
  const input = { ...doc(), quick: { debts: [{ id: 'conn-a:42', include: true, monthlyPayment: 1250.5 }, { id: 'conn-a:43', include: false, monthlyPayment: null }] } };
  assert.deepEqual(validate(input).quick, { asOfMonth: null, basis: null, ...input.quick });
  assert.equal(validate({ ...doc(), quick: { basis: 'plan', debts: [] } }).quick.basis, 'plan');
  assert.equal(validate({ ...doc(), quick: { basis: 'trailing', debts: [] } }).quick.basis, 'trailing');
  for (const basis of ['auto', 'PLAN', 1]) assert.throws(() => validate({ ...doc(), quick: { basis, debts: [] } }), /basis/);
  assert.equal(validate({ ...doc(), quick: { asOfMonth: '2026-03', debts: [] } }).quick.asOfMonth, '2026-03');
  assert.equal(validate({ ...doc(), quick: { asOfMonth: '', debts: [] } }).quick.asOfMonth, null);
  for (const asOfMonth of ['2026-3', '2026-13', 'latest', 3]) assert.throws(() => validate({ ...doc(), quick: { asOfMonth, debts: [] } }), /asOfMonth/);
  for (const quick of ['x', [], { debts: 'x' }, { debts: [], extra: 1 }, { debts: [{ id: 'conn-a:42', include: true }] }, { debts: [{ id: 'conn-a:42', include: 'yes', monthlyPayment: null }] },
    { debts: [{ id: 'conn-a:42', include: true, monthlyPayment: -1 }] }, { debts: [{ id: 'conn-a:42', include: true, monthlyPayment: '5' }] }, { debts: [{ id: 'bad id', include: true, monthlyPayment: null }] },
    { debts: [{ id: 'conn-a:42', include: true, monthlyPayment: null }, { id: 'conn-a:42', include: false, monthlyPayment: null }] }, { debts: [{ id: 'conn-a:42', include: true, monthlyPayment: null, balance: 5 }] }]) {
    assert.throws(() => validate({ ...doc(), quick }), /quick-look/i, JSON.stringify(quick));
  }
});
