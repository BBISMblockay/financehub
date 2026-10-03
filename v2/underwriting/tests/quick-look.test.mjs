import test from 'node:test';
import assert from 'node:assert/strict';
import { quickLook, draftQuickDebts, quickDebtsHtml, quickFactsHtml, quickResultHtml, quickVerdictHtml, quickPrintHtml, QUICK_RULES } from '../quick-look.js';
import { buildDebtSchedule } from '../scenario-model.js';

const money = (v, compact = false) => Number.isFinite(v) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 0 }).format(v) : '—';
const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const plRows = (operatingIncome = 40000) => months.map((m, i) => ({ month: m, periodStart: `${m}-01`, periodEnd: `${m}-28`, completeMonth: true, revenue: 600000 + i * 10000, grossProfit: 240000, operatingIncome }));
const cfRows = (operating = 50000, complete = true) => months.map(m => ({ periodStart: `${m}-01`, periodEnd: `${m}-28`, completeMonth: complete, operating }));
const snapshot = ({ operating = 50000, cf = true, bookCash = 300000, assets = 5000000, cfComplete = true } = {}) => ({
  currency: 'USD',
  sources: {
    balanceSheet: { currency: 'USD', periodEnd: '2026-06-30', metrics: [], monthly: [{ month: '2026-06', periodEnd: '2026-06-30', completeMonth: true, bookCash, assets }] },
    profitAndLoss: { currency: 'USD', metrics: [], monthly: plRows() },
    cashflow: cf ? { currency: 'USD', metrics: [], monthly: cfRows(operating, cfComplete) } : { status: 'missing', monthly: [] },
  },
  accountOptions: [
    { id: 'c:loan-1', label: 'Bank term loan', accountType: 'Long Term Liability', balance: 1200000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:cc-1', label: 'Company card', accountType: 'Credit Card', balance: 80000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:ocl-1', label: 'Sales tax payable', accountType: 'Other Current Liability', balance: 50000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:ocl-2', label: 'Overpaid note', accountType: 'Other Current Liability', balance: -4000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:ap', label: 'Accounts payable', accountType: 'Accounts Payable', balance: 900000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:unmatched', label: 'Unmatched loan', accountType: 'Long Term Liability', balance: null },
  ],
});
const inputs = { amount: '500000', rate: '9.5', term: '36', purpose: 'Holiday buy' };

test('existing debt is drafted from liability account types, never from names, and keeps prior ticks', () => {
  const debts = draftQuickDebts(snapshot().accountOptions);
  assert.deepEqual(debts.map(d => [d.id, d.include]), [['c:loan-1', true], ['c:cc-1', true], ['c:ocl-1', false]], 'LTL and cards ticked, OCL unticked, AP/negative/unmatched absent, sorted by balance');
  const again = draftQuickDebts(snapshot().accountOptions, [{ id: 'c:ocl-1', include: true, monthlyPayment: 1200 }, { id: 'c:loan-1', include: false, monthlyPayment: -5 }]);
  assert.equal(again.find(d => d.id === 'c:ocl-1').include, true); assert.equal(again.find(d => d.id === 'c:ocl-1').monthlyPayment, 1200);
  assert.equal(again.find(d => d.id === 'c:loan-1').include, false); assert.equal(again.find(d => d.id === 'c:loan-1').monthlyPayment, null, 'a negative payment is not kept');
});

test('payment equals the production amortizing schedule and the verdict follows the stated thresholds', () => {
  const debts = draftQuickDebts(snapshot().accountOptions).map(d => ({ ...d, monthlyPayment: d.id === 'c:loan-1' ? 10000 : 0 }));
  const r = quickLook({ snapshot: snapshot({ operating: 60000 }), inputs, debts, month: '2026-10' });
  const s = buildDebtSchedule({ principal: 500000, annualRatePct: 9.5, termMonths: 36, frequency: 'monthly', repayment: 'amortizing', startMonth: '2026-10', upfrontFees: 0 });
  assert.equal(r.payment, s.summary.periodicPayment); assert.equal(r.maturityMonth, '2029-10');
  assert.equal(r.existingDebt, 1280000); assert.equal(r.knownExisting, 10000); assert.equal(r.unknownPaymentCount, 0);
  assert.equal(r.combinedService, Math.round((s.summary.periodicPayment + 10000) * 100) / 100);
  assert.equal(r.basis.key, 'operatingCash'); assert.equal(r.basis.months, 6); assert.equal(r.basis.average, 60000);
  assert.ok(Math.abs(r.ratios.serviceShare - r.combinedService / 60000) < 1e-12);
  assert.equal(r.verdict.status, 'tight', `${r.ratios.serviceShare} is between 25% and 50%`);
  assert.ok(Math.abs(r.ratios.cashCoverMonths - 300000 / r.combinedService) < 1e-9);
  assert.ok(Math.abs(r.ratios.debtToAssetsAfter - (1280000 + 500000) / (5000000 + 500000)) < 1e-12);
  const easy = quickLook({ snapshot: snapshot({ operating: 200000 }), inputs, debts, month: '2026-10' });
  assert.equal(easy.verdict.status, 'comfortable');
  const hard = quickLook({ snapshot: snapshot({ operating: 20000 }), inputs, debts, month: '2026-10' });
  assert.equal(hard.verdict.status, 'no');
  assert.equal(QUICK_RULES.comfortableShare, .25); assert.equal(QUICK_RULES.tightShare, .5);
});

test('a ticked debt with no payment entered caps the verdict at tight and says so', () => {
  const debts = draftQuickDebts(snapshot().accountOptions);
  const r = quickLook({ snapshot: snapshot({ operating: 200000 }), inputs, debts, month: '2026-10' });
  assert.equal(r.unknownPaymentCount, 2);
  assert.equal(r.verdict.status, 'tight');
  assert.match(r.verdict.title, /until existing payments are known/);
  assert.match(r.verdict.reasons.join(' '), /2 ticked debts have no monthly payment entered/);
});

test('negative operating cash, thin history and missing inputs never produce a comfortable verdict', () => {
  const debts = [];
  assert.equal(quickLook({ snapshot: snapshot({ operating: -5000 }), inputs, debts, month: '2026-10' }).verdict.status, 'no');
  const thin = snapshot(); thin.sources.cashflow.monthly = thin.sources.cashflow.monthly.slice(0, 2); thin.sources.profitAndLoss.monthly = thin.sources.profitAndLoss.monthly.slice(0, 2);
  const t = quickLook({ snapshot: thin, inputs, debts, month: '2026-10' });
  assert.equal(t.verdict.status, 'unknown'); assert.match(t.verdict.reasons.join(' '), /Fewer than 3 complete months/);
  const partial = quickLook({ snapshot: snapshot({ cfComplete: false }), inputs, debts, month: '2026-10' });
  assert.equal(partial.basis.key, 'operatingIncome', 'partial cash-flow months are excluded, so the P&L becomes the basis');
  assert.match(partial.verdict.reasons.join(' '), /not cash/);
  const blank = quickLook({ snapshot: snapshot(), inputs: { amount: '', rate: '9.5', term: '36' }, debts, month: '2026-10' });
  assert.equal(blank.payment, null); assert.equal(blank.verdict.status, 'unknown'); assert.equal(blank.ratios.serviceShare, null);
  const bad = quickLook({ snapshot: snapshot(), inputs: { amount: '500000', rate: '9.5', term: '0' }, debts, month: '2026-10' });
  assert.equal(bad.verdict.status, 'unknown'); assert.ok(bad.errors.length > 0);
  const noCash = quickLook({ snapshot: snapshot({ bookCash: null }), inputs, debts, month: '2026-10' });
  assert.equal(noCash.ratios.cashCoverMonths, null); assert.match(noCash.verdict.reasons.join(' '), /Opening cash is not available/);
});

test('renderers escape source text and the print packet names every basis', () => {
  const options = snapshot().accountOptions.map(a => a.id === 'c:loan-1' ? { ...a, label: 'Loan <script>alert(1)</script>' } : a);
  const debts = draftQuickDebts(options);
  const r = quickLook({ snapshot: snapshot(), inputs: { ...inputs, purpose: '<b>x</b>' }, debts, month: '2026-10' });
  for (const html of [quickDebtsHtml(debts, money), quickDebtsHtml(debts, money, { editable: false }), quickFactsHtml(r, money), quickResultHtml(r, money), quickVerdictHtml(r), quickPrintHtml({ result: r, debts, money, companyTitle: 'Co <i>', preparedAt: '2026-10-03' })]) {
    assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<b>x</b>')); assert.ok(!html.includes('Co <i>'));
  }
  const print = quickPrintHtml({ result: r, debts, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['Quick look · Co', 'Monthly payment', 'From the books', 'Existing debt', 'How this was judged', 'operating cash flow', '2026-06-30']) assert.ok(print.includes(text), text);
  assert.ok(!print.includes('<input'), 'print is static');
  assert.ok(quickDebtsHtml(debts, money).includes('data-quick-debt="c:loan-1"'));
  assert.match(quickDebtsHtml([], money), /No liability accounts/);
});
