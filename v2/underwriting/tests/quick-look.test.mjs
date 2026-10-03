import test from 'node:test';
import assert from 'node:assert/strict';
import { quickLook, draftQuickDebts, quickDebtsHtml, quickFactsHtml, quickResultHtml, quickVerdictHtml, quickPrintHtml, quickProposalHtml, quickMonthOptions, resolveAsOfMonth, QUICK_RULES } from '../quick-look.js';
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
  assert.equal(noCash.ratios.cashCoverMonths, null); assert.match(noCash.verdict.reasons.join(' '), /Opening cash is not available|no bank-balance total/);
});

test('renderers escape source text and the print packet names every basis', () => {
  const options = snapshot().accountOptions.map(a => a.id === 'c:loan-1' ? { ...a, label: 'Loan <script>alert(1)</script>' } : a);
  const debts = draftQuickDebts(options);
  const r = quickLook({ snapshot: snapshot(), inputs: { ...inputs, purpose: '<b>x</b>' }, debts, month: '2026-10' });
  for (const html of [quickDebtsHtml(debts, money), quickDebtsHtml(debts, money, { editable: false }), quickFactsHtml(r, money), quickResultHtml(r, money), quickVerdictHtml(r), quickPrintHtml({ result: r, debts, money, companyTitle: 'Co <i>', preparedAt: '2026-10-03' })]) {
    assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<b>x</b>')); assert.ok(!html.includes('Co <i>'));
  }
  const print = quickPrintHtml({ result: r, debts, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['DRAFT FINANCING PROPOSAL', 'Monthly payment', 'Business performance', 'Existing debt', 'How this was prepared', 'operating cash flow', '2026-06-30']) assert.ok(print.includes(text), text);
  assert.ok(!print.includes('<input'), 'print is static');
  assert.ok(quickDebtsHtml(debts, money).includes('data-quick-debt="c:loan-1"'));
  assert.match(quickDebtsHtml([], money), /No liability accounts/);
});

const fullSnapshot = () => {
  const snap = snapshot({ operating: 60000 });
  snap.sources.balanceSheet.basis = 'Accrual'; snap.sources.balanceSheet.status = 'available';
  Object.assign(snap.sources.balanceSheet.monthly[0], { liabilities: 3000000, equity: 2000000, accountsReceivable: 400000, accountsPayable: 350000, currentAssets: 2500000, currentLiabilities: 1200000, longTermLiabilities: 1500000, creditCards: 80000 });
  snap.sources.profitAndLoss.status = 'available'; snap.sources.cashflow.status = 'available';
  snap.sources.bank = { status: 'available', asOf: '2026-07-01', rows: [{ id: 'b1', name: 'Operating <b>acct</b>', current_balance: -688009.6, available_balance: -688009.6, iso_currency_code: 'USD', balance_updated_at: '2026-07-01T05:30:00Z' }] };
  snap.sources.inventory = { status: 'partial', asOf: '2026-07-01T02:00:00Z', metrics: [{ label: 'Reported on-hand units', value: 538101 }], byProductType: [{ productType: 'Tees', units: 300000, knownRecordedValue: 9000000 }, { productType: 'Hats', units: 100000, knownRecordedValue: null }] };
  snap.sources.purchaseOrders = { status: 'partial', placedCount: 135, placed: [], arrivalMonths: [{ month: '2026-10', poCount: 12, units: 40000, knownEstimatedCost: 300000 }, { month: null, poCount: 3, units: 900, knownEstimatedCost: null }] };
  snap.sources.revenuePlan = { status: 'partial', businessDate: '2026-07-03', monthly: [
    { month: '2026-05', plannedSales: 2400000, actualNetSales: 2074000, completeMonth: true }, { month: '2026-06', plannedSales: 3500000, actualNetSales: 3169000, completeMonth: true },
    { month: '2026-07', plannedSales: 5300000, actualNetSales: 95000, completeMonth: false }, { month: '2026-08', plannedSales: 1790000, actualNetSales: null, completeMonth: false }] };
  return snap;
};

test('the draft proposal is assembled from every loaded source, names each date, and prints nothing it was not given', () => {
  const snap = fullSnapshot();
  const debts = draftQuickDebts(snap.accountOptions).map(d => d.id === 'c:loan-1' ? { ...d, monthlyPayment: 10000 } : d);
  const r = quickLook({ snapshot: snap, inputs, debts, month: '2026-10' });
  const html = quickProposalHtml({ result: r, debts, snapshot: snap, money, companyTitle: 'Northline <Supply>', preparedAt: '2026-10-03T07:00:00Z' });
  for (const text of ['DRAFT FINANCING PROPOSAL', 'Northline &lt;Supply&gt;', 'Prepared 2026-10-03', '$500,000 at 9.5% over 36 months', 'Holiday buy',
    'Business performance', '6-month total', '$3,750,000', '2026-01 to 2026-06',          // revenue total and window
    'Balance sheet', 'as of 2026-06-30', 'Accrual', 'Long-term liabilities', '$1,500,000',
    'Saved bank balances', 'Operating &lt;b&gt;acct&lt;/b&gt;', '-$688,010', '2026-07-01', 'Last synced', 'active',
    'Existing debt', 'Total ticked debt $1,280,000', '1 ticked account has none',
    'Inventory and purchase commitments', '538,101', 'recorded value 9,000,000 (currency not recorded)', 'placed purchase orders <strong>135', 'No date', '<td>300,000</td>',
    'Sales plan and recorded sales', '2026-06', '90.5%', 'Planned ahead: 2026-07 5,300,000 · 2026-08 1,790,000',
    'Sources and dates', 'Sales plan and recorded sales (SILO)', 'partial coverage', 'How this was prepared', 'nothing was typed except the request']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('<b>acct</b>')); assert.ok(!html.includes('<input'));
  // Amounts whose source records no currency never borrow the statement currency.
  for (const text of ['$9,000,000', '$2,074,000', '$5,300,000', '$1,790,000', 'Live']) assert.ok(!html.includes(text), `must not print ${text}`); // the PO cost cell is asserted plain below; book cash is legitimately in the statement currency
  assert.ok(html.includes('<td>2,074,000</td><td>2,400,000</td>'), 'recorded sales and plan are plain numbers');
  assert.ok(!html.includes('2026-07</td>') || !/2026-07<\/td><td>\$95,000/.test(html), 'the current partial month is not presented as a recorded month');
  // Missing sources are named, not silently skipped.
  const bare = { sources: { profitAndLoss: { status: 'error', error: { message: 'offline' }, monthly: [] } }, accountOptions: [] };
  const empty = quickProposalHtml({ result: quickLook({ snapshot: bare, inputs, debts: [], month: '2026-10' }), debts: [], snapshot: bare, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['Profit and loss (QuickBooks): read failed (offline)', 'Balance sheet (QuickBooks): not loaded', 'Bank balances (Plaid feed): not loaded', 'Saved bank balances', 'No complete months in the saved P&amp;L', 'No bank accounts loaded', 'No placed purchase orders', 'Not enough saved history to judge']) assert.ok(empty.includes(text), text);
  assert.equal(quickPrintHtml({ result: r, debts, snapshot: snap, money, companyTitle: 'X', preparedAt: '2026-10-03' }), html.replace('Northline &lt;Supply&gt;', 'X'));
});

test('a bank row is shown in its own currency or as a plain number, with stale or partial coverage named', () => {
  const snap = fullSnapshot();
  snap.sources.bank = { status: 'partial', warnings: ['Bank account rows are capped at 500; source coverage is incomplete.'], rows: [
    { id: 'b1', name: 'CAD account', current_balance: 1000, available_balance: 900, iso_currency_code: 'CAD', balance_updated_at: '2026-06-20T00:00:00Z', connection_status: 'login_required', environment: 'production' },
    { id: 'b2', name: 'No currency', current_balance: 5000, available_balance: null, iso_currency_code: null, balance_updated_at: null, connection_status: 'active', environment: 'sandbox' }] };
  const r = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' });
  const html = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['CA$1,000', 'CA$900', '2026-06-20', 'login_required', '5,000 (currency not recorded)', 'not recorded', 'unknown', 'active · sandbox', 'Bank coverage is partial', 'capped at 500']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('>$1,000<'), 'a CAD balance is never printed as USD');
});

const datedSnapshot = () => {
  const snap = snapshot({ operating: 60000 });
  snap.sources.balanceSheet.monthly = months.map((m, i) => ({ month: m, periodEnd: `${m}-28`, completeMonth: true, bookCash: 100000 + i * 50000, assets: 4000000 + i * 200000 }));
  snap.sources.balanceSheet.accountHistory = [
    { accountId: 'loan-1', connectionId: 'c', ambiguous: false, values: months.map((m, i) => ({ periodEnd: `${m}-28`, balance: 1500000 - i * 50000 })) },
    { accountId: 'cc-1', connectionId: 'c', ambiguous: false, values: months.map((m, i) => ({ periodEnd: `${m}-28`, balance: i < 3 ? 0 : 80000 })) },
    { accountId: 'ocl-1', connectionId: 'c', ambiguous: true, values: months.map(m => ({ periodEnd: `${m}-28`, balance: 50000 })) },
  ];
  // Cash flow dips late so the window matters.
  snap.sources.cashflow.monthly = cfRows(60000).map((r, i) => ({ ...r, operating: i < 3 ? 100000 : 20000 }));
  return snap;
};

test('the as-of month re-dates the balance sheet, the averages window and the debt balances', () => {
  const snap = datedSnapshot();
  assert.deepEqual(quickMonthOptions(snap), months);
  assert.deepEqual(resolveAsOfMonth(snap, '2026-03'), { month: '2026-03', options: months, requested: '2026-03', honoured: true });
  assert.deepEqual(resolveAsOfMonth(snap, '2026-09'), { month: '2026-06', options: months, requested: '2026-09', honoured: false });
  assert.deepEqual(resolveAsOfMonth(snap, null), { month: '2026-06', options: months, requested: null, honoured: true });
  const latest = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' });
  assert.equal(latest.facts.asOfMonth, '2026-06'); assert.equal(latest.facts.openingCash.value, 350000); assert.equal(latest.facts.openingCash.asOf, '2026-06-28');
  assert.equal(latest.facts.operatingCash.months, 6); assert.equal(latest.facts.operatingCash.average, 60000);
  const march = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10', asOfMonth: '2026-03' });
  assert.equal(march.facts.asOfMonth, '2026-03'); assert.equal(march.facts.openingCash.value, 200000); assert.equal(march.facts.totalAssets.value, 4400000);
  assert.equal(march.facts.operatingCash.months, 3); assert.equal(march.facts.operatingCash.average, 100000); assert.equal(march.facts.operatingCash.to, '2026-03');
  assert.equal(march.facts.revenue.to, '2026-03', 'P&L averages stop at the as-of month too');
  assert.equal(march.verdict.status, 'comfortable'); assert.equal(latest.verdict.status, 'tight', 'the same request reads differently as of a weaker window');
  const bad = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10', asOfMonth: '2026-09' });
  assert.equal(bad.facts.asOfMonth, '2026-06'); assert.match(bad.verdict.reasons.join(' '), /2026-09 is not a complete month.*as of 2026-06/);
  // Debts: balances come from the chosen month's column; a zero-balance month drops the account; ambiguous history falls back to the latest match.
  const opts = snapshot().accountOptions.map(a => ({ ...a, id: a.id.replace('c:', 'c:') }));
  const history = snap.sources.balanceSheet.accountHistory;
  const atMarch = draftQuickDebts(opts, [], { accountHistory: history, asOfMonth: '2026-03' });
  assert.deepEqual(atMarch.map(d => [d.id, d.balance, d.asOf]), [['c:loan-1', 1400000, '2026-03-28'], ['c:ocl-1', 50000, '2026-06-30']], 'card had no balance in March; ambiguous OCL keeps the latest matched balance');
  const atJune = draftQuickDebts(opts, atMarch, { accountHistory: history, asOfMonth: '2026-06' });
  assert.deepEqual(atJune.map(d => [d.id, d.balance]), [['c:loan-1', 1250000], ['c:cc-1', 80000], ['c:ocl-1', 50000]]);
  const html = quickProposalHtml({ result: march, debts: atMarch, snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(html.includes('figures as of 2026-03')); assert.ok(html.includes('as of 2026-03-28')); assert.ok(html.includes('3-month total')); assert.ok(!html.includes('2026-04</td>'));
});

test('a selected month never borrows another month\'s balance-sheet figures', () => {
  const snap = datedSnapshot();
  snap.sources.balanceSheet.metrics = [{ label: 'Book bank balances', value: 999999 }, { label: 'Total assets', value: 8888888 }, { label: 'Total liabilities', value: 7777777 }, { label: 'Total equity', value: 1111111 }];
  const march = snap.sources.balanceSheet.monthly.find(r => r.month === '2026-03');
  march.bookCash = null; march.assets = null;
  const r = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10', asOfMonth: '2026-03' });
  assert.equal(r.facts.openingCash.value, null); assert.equal(r.facts.totalAssets.value, null);
  assert.equal(r.ratios.cashCoverMonths, null); assert.equal(r.ratios.debtToAssetsAfter, null);
  assert.match(r.verdict.reasons.join(' '), /2026-03 balance-sheet column has no bank-balance total/);
  assert.match(r.verdict.reasons.join(' '), /no total-assets figure/);
  const html = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['$999,999', '$8,888,888', '$7,777,777', '$1,111,111']) assert.ok(!html.includes(text), `headline ${text} must not appear under the March header`);
  assert.match(html, /2026-03 column lacks total assets, total liabilities, equity, bank balances/);
  // The latest month, when it is itself a monthly column, follows the same rule.
  const latestRowRef = snap.sources.balanceSheet.monthly.at(-1); latestRowRef.assets = null;
  const latest = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' });
  assert.equal(latest.facts.totalAssets.value, null);
  // With no monthly columns at all, the headline metrics are the only figures and are used.
  const headlineOnly = snapshot(); headlineOnly.sources.balanceSheet.monthly = []; headlineOnly.sources.balanceSheet.metrics = snap.sources.balanceSheet.metrics;
  const h = quickLook({ snapshot: headlineOnly, inputs, debts: [], month: '2026-10' });
  assert.equal(h.facts.asOfMonth, null); assert.equal(h.facts.openingCash.value, 999999); assert.equal(h.facts.totalAssets.value, 8888888);
});
