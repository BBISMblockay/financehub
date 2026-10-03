import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardOutlook, quickLook, draftQuickDebts, quickDebtsHtml, quickFactsHtml, quickResultHtml, quickVerdictHtml, quickPrintHtml, quickProposalHtml, quickMonthOptions, resolveAsOfMonth, QUICK_RULES } from '../quick-look.js';
import { buildDebtSchedule } from '../scenario-model.js';

const money = (v, compact = false) => Number.isFinite(v) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 0 }).format(v) : '—';
const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const plRows = (operatingIncome = 40000) => months.map((m, i) => ({ month: m, periodStart: `${m}-01`, periodEnd: `${m}-28`, completeMonth: true, revenue: 600000 + i * 10000, grossProfit: 240000, operatingIncome }));
const cfRows = (operating = 50000, complete = true) => months.map(m => ({ periodStart: `${m}-01`, periodEnd: `${m}-28`, completeMonth: complete, operating }));
const snapshot = ({ operating = 50000, cf = true, bookCash = 300000, assets = 5000000, cfComplete = true } = {}) => ({
  currency: 'USD',
  sources: {
    accounts: { status: 'available' },
    balanceSheet: { status: 'available', currency: 'USD', periodEnd: '2026-06-30', metrics: [], monthly: [{ month: '2026-06', periodEnd: '2026-06-30', completeMonth: true, bookCash, assets }] },
    profitAndLoss: { currency: 'USD', metrics: [], monthly: plRows() },
    cashflow: cf ? { currency: 'USD', metrics: [], monthly: cfRows(operating, cfComplete) } : { status: 'missing', monthly: [] },
  },
  accountOptions: [
    { id: 'c:loan-1', label: 'Bank term loan', accountType: 'Long Term Liability', balance: 1200000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:cc-1', label: 'Company card', accountType: 'Credit Card', balance: 80000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:ocl-1', label: 'Sales tax payable', accountType: 'Other Current Liability', balance: 50000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:ocl-2', label: 'Overpaid note', accountType: 'Other Current Liability', balance: -4000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
    { id: 'c:ap', label: 'Accounts payable', accountType: 'Accounts Payable', balance: 900000, balanceAsOf: '2026-06-30', balanceCurrency: 'USD' },
  ],
});
const inputs = { amount: '500000', rate: '9.5', term: '36', purpose: 'Holiday buy' };

test('existing debt is drafted from liability account types, never from names, and keeps prior ticks', () => {
  const debts = draftQuickDebts(snapshot().accountOptions);
  assert.deepEqual(debts.map(d => [d.id, d.include]), [['c:loan-1', true], ['c:cc-1', true], ['c:ocl-1', false]], 'LTL and cards ticked, OCL unticked, AP/negative absent, sorted by balance');
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
  snap.sources.bank = { status: 'available', asOf: '2026-06-30', rows: [{ id: 'b1', name: 'Operating <b>acct</b>', current_balance: -688009.6, available_balance: -688009.6, iso_currency_code: 'USD', balance_updated_at: '2026-06-30T05:30:00Z' }] };
  snap.sources.inventory = { status: 'partial', asOf: '2026-06-29T02:00:00Z', newestAsOf: '2026-06-30T02:00:00Z', missingSnapshotRows: 0, metrics: [{ label: 'Reported on-hand units', value: 538101 }], byProductType: [{ productType: 'Tees', units: 300000, knownRecordedValue: 9000000 }, { productType: 'Hats', units: 100000, knownRecordedValue: null }] };
  snap.sources.purchaseOrders = { status: 'partial', placedCount: 3, placedTruncated: false, placed: [
    { id: 'po-1', orderDate: '2026-05-10', arrivalDate: '2026-10-05', units: 25000, knownEstimatedCost: 200000 }, { id: 'po-2', orderDate: '2026-06-20', arrivalDate: '2026-10-20', units: 15000, knownEstimatedCost: 100000 },
    { id: 'po-3', orderDate: '2026-06-28', arrivalDate: null, units: 900, knownEstimatedCost: null }], arrivalMonths: [{ month: '2026-10', poCount: 2, units: 40000, knownEstimatedCost: 300000 }, { month: null, poCount: 1, units: 900, knownEstimatedCost: null }] };
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
    'Saved bank balances', 'Operating &lt;b&gt;acct&lt;/b&gt;', '-$688,010', '2026-06-30', 'Last synced', 'active',
    'Existing debt', 'Total ticked debt $1,280,000', '1 ticked account has none',
    'Inventory and purchase commitments', '538,101', 'recorded value 9,000,000 (currency not recorded)', 'of 3 orders placed today, 3 were ordered by the end of 2026-06', 'No date', '<td>300,000</td>',
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

test('the as-of month bounds every dated section: nothing held after it is printed as a figure', () => {
  // Today is 2026-10-03; the person picks 2026-08. The bank feed, the on-hand snapshot and the PO register hold the
  // October position; September sales are recorded. None of that belongs under "figures as of 2026-08".
  const snap = fullSnapshot();
  snap.sources.balanceSheet.monthly = ['2026-07', '2026-08', '2026-09'].map((m, i) => ({ ...snap.sources.balanceSheet.monthly[0], month: m, periodStart: `${m}-01`, periodEnd: `${m}-${['31', '31', '30'][i]}`, completeMonth: true }));
  snap.sources.bank = { status: 'available', asOf: '2026-10-02', rows: [
    { id: 'b1', name: 'Operating', current_balance: -700000, available_balance: -700000, iso_currency_code: 'USD', balance_updated_at: '2026-10-02T05:30:00Z', connection_status: 'active', environment: 'production' },
    { id: 'b2', name: 'Old savings', current_balance: 12000, available_balance: 12000, iso_currency_code: 'USD', balance_updated_at: '2026-08-15T05:30:00Z', connection_status: 'active', environment: 'production' }] };
  snap.sources.inventory = { status: 'partial', asOf: '2026-10-02T02:00:00Z', newestAsOf: '2026-10-02T02:30:00Z', missingSnapshotRows: 0, metrics: [{ label: 'Reported on-hand units', value: 538101 }], byProductType: [{ productType: 'Tees', units: 300000, knownRecordedValue: 9000000 }] };
  snap.sources.purchaseOrders = { status: 'partial', placedCount: 3, placedTruncated: false, placed: [
    { id: 'po-1', orderDate: '2026-08-10', arrivalDate: '2026-11-05', units: 25000, knownEstimatedCost: 200000 }, { id: 'po-2', orderDate: '2026-09-20', arrivalDate: '2026-11-20', units: 15000, knownEstimatedCost: 100000 },
    { id: 'po-3', orderDate: null, arrivalDate: null, units: 900, knownEstimatedCost: null }], arrivalMonths: [{ month: '2026-11', poCount: 2, units: 40000, knownEstimatedCost: 300000 }, { month: null, poCount: 1, units: 900, knownEstimatedCost: null }] };
  snap.sources.revenuePlan = { status: 'partial', businessDate: '2026-10-03', monthly: [
    { month: '2026-07', plannedSales: 5300000, actualNetSales: 5400000, completeMonth: true }, { month: '2026-08', plannedSales: 1790000, actualNetSales: 1971000, completeMonth: true },
    { month: '2026-09', plannedSales: 1217000, actualNetSales: 1522000, completeMonth: true }, { month: '2026-10', plannedSales: 1620000, actualNetSales: 105000, completeMonth: false },
    { month: '2026-11', plannedSales: 6300000, actualNetSales: null, completeMonth: false }, { month: '2026-12', plannedSales: 2645000, actualNetSales: null, completeMonth: false }] };
  const r = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-11', asOfMonth: '2026-08' });
  assert.equal(r.facts.asOfMonth, '2026-08');
  const html = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  // Bank: the October row is named and left out, the August row stays.
  assert.ok(html.includes('1 of 2 bank balances are dated after 2026-08 (last synced 2026-10-02)')); assert.ok(html.includes('Old savings')); assert.ok(!html.includes('-$700,000')); assert.ok(!html.includes('2026-10-02T'));
  // Inventory: no on-hand figure as of August, and no October units anywhere.
  assert.ok(html.includes('On-hand inventory is held only as its latest sync (rows dated 2026-10-02 to 2026-10-02), after 2026-08')); assert.ok(!html.includes('538,101')); assert.ok(!html.includes('<td>Tees</td>'));
  // Purchase orders: only the order placed by August, as a named lower bound; the undated one is counted out.
  assert.ok(html.includes('of 3 orders placed today, 1 were ordered by the end of 2026-08 (1 more carry no order date and are left out)')); assert.ok(html.includes('lower bound'));
  assert.ok(html.includes('<td>2026-11</td><td>1</td><td>25,000</td><td>200,000</td>')); assert.ok(!html.includes('<td>40,000</td>'));
  // Sales plan: recorded months stop at August; "planned ahead" starts in September.
  assert.ok(html.includes('<td>2026-08</td><td>1,971,000</td>')); assert.ok(!html.includes('<td>2026-09</td><td>1,522,000</td>')); assert.ok(!html.includes('<td>2026-10</td><td>105,000</td>'));
  assert.ok(html.includes('Planned ahead: 2026-09 1,217,000 · 2026-10 1,620,000 · 2026-11 6,300,000'));
  assert.ok(html.includes('Figures above are as of 2026-08'));
  // The latest month shows everything again: nothing is dated after it.
  const latest = quickProposalHtml({ result: quickLook({ snapshot: snap, inputs, debts: [], month: '2026-11', asOfMonth: '2026-09' }), debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(latest.includes('<td>2026-09</td><td>1,522,000</td>')); assert.ok(latest.includes('2 were ordered by the end of 2026-09'));
  assert.ok(latest.includes('1 of 2 bank balances are dated after 2026-09')); assert.ok(latest.includes('after 2026-09; SILO keeps no on-hand history'));
  // A capped PO detail list cannot be dated and says so instead of counting.
  snap.sources.purchaseOrders.placedTruncated = true; snap.sources.purchaseOrders.placedCount = 240;
  const capped = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(capped.includes('capped at 3 of 240 placed orders')); assert.ok(capped.includes('No purchase commitment shown as of 2026-08')); assert.ok(!capped.includes('<td>2026-11</td>'));
  // An UNDATED current balance or snapshot cannot be placed on either side of the cutoff, so it is left out too --
  // the loader admits both (status partial), and "Last synced unknown" beside a current balance is still a current balance.
  snap.sources.bank.rows.push({ id: 'b3', name: 'Undated card', current_balance: -45000, available_balance: null, iso_currency_code: 'USD', balance_updated_at: null, connection_status: 'active', environment: 'production' });
  snap.sources.inventory = { status: 'partial', asOf: null, newestAsOf: null, missingSnapshotRows: 12, metrics: [{ label: 'Reported on-hand units', value: 538101 }], byProductType: [{ productType: 'Tees', units: 300000, knownRecordedValue: 9000000 }] };
  const undated = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(undated.includes('2 of 3 bank balances are dated after 2026-08 or undated (1 undated; last synced 2026-10-02)')); assert.ok(!undated.includes('Undated card')); assert.ok(!undated.includes('-$45,000')); assert.ok(undated.includes('Old savings'));
  assert.ok(undated.includes('On-hand inventory carries no snapshot date, so it cannot be placed before or after the cutoff')); assert.ok(!undated.includes('538,101')); assert.ok(!undated.includes('<td>Tees</td>'));
  snap.sources.bank.rows = [snap.sources.bank.rows[2]];
  assert.ok(quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' }).includes('1 of 1 bank balance is undated. The feed holds only the position at its last sync, so it is not shown as of 2026-08.'));
  // The aggregate is dated by BOTH ends: Store A synced in July and Store B in October is October stock under an
  // August cutoff, whatever the oldest row says; a dated aggregate with undated rows in it is undatable too.
  const mixed = (inventory) => quickProposalHtml({ result: r, debts: [], snapshot: { ...snap, sources: { ...snap.sources, inventory } }, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  const units = { metrics: [{ label: 'Reported on-hand units', value: 538101 }], byProductType: [{ productType: 'Tees', units: 300000, knownRecordedValue: 9000000 }] };
  const mixedAge = mixed({ status: 'partial', asOf: '2026-07-15T02:00:00Z', newestAsOf: '2026-10-02T02:00:00Z', missingSnapshotRows: 0, ...units });
  assert.ok(mixedAge.includes('rows dated 2026-07-15 to 2026-10-02), after 2026-08')); assert.ok(!mixedAge.includes('538,101'));
  const someUndated = mixed({ status: 'partial', asOf: '2026-07-15T02:00:00Z', newestAsOf: '2026-08-20T02:00:00Z', missingSnapshotRows: 3, ...units });
  assert.ok(someUndated.includes('3 on-hand rows carry no snapshot date, so the aggregate cannot be placed before or after the cutoff')); assert.ok(!someUndated.includes('538,101'));
  const uncounted = mixed({ status: 'partial', asOf: '2026-07-15T02:00:00Z', newestAsOf: '2026-08-20T02:00:00Z', ...units });
  assert.ok(uncounted.includes('Some on-hand rows carry no snapshot date')); assert.ok(!uncounted.includes('538,101'));
  const inRange = mixed({ status: 'available', asOf: '2026-07-15T02:00:00Z', newestAsOf: '2026-08-20T02:00:00Z', missingSnapshotRows: 0, ...units });
  assert.ok(inRange.includes('On hand <strong>538,101</strong> units as of 2026-07-15')); assert.ok(inRange.includes('<td>Tees</td>'));
  // Without an as-of month an undated row still prints, as before, with its date unknown.
  const noColumns = fullSnapshot(); noColumns.sources.balanceSheet.monthly = []; noColumns.sources.bank.rows[0].balance_updated_at = null;
  const plain = quickProposalHtml({ result: quickLook({ snapshot: noColumns, inputs, debts: [], month: '2026-10' }), debts: [], snapshot: noColumns, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(plain.includes('-$688,010')); assert.ok(plain.includes('<td>unknown</td>'));
});

test('a bank row is shown in its own currency or as a plain number, with stale or partial coverage named', () => {
  const snap = fullSnapshot();
  snap.sources.bank = { status: 'partial', warnings: ['Bank account rows are capped at 500; source coverage is incomplete.'], rows: [
    { id: 'b1', name: 'CAD account', current_balance: 1000, available_balance: 900, iso_currency_code: 'CAD', balance_updated_at: '2026-06-20T00:00:00Z', connection_status: 'login_required', environment: 'production' },
    { id: 'b2', name: 'No currency', current_balance: 5000, available_balance: null, iso_currency_code: null, balance_updated_at: '2026-06-25T00:00:00Z', connection_status: 'active', environment: 'sandbox' }] };
  const r = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' });
  const html = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['CA$1,000', 'CA$900', '2026-06-20', 'login_required', '5,000 (currency not recorded)', 'not recorded', '2026-06-25', 'active · sandbox', 'Bank coverage is partial', 'capped at 500']) assert.ok(html.includes(text), text);
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
  assert.equal(march.verdict.status, 'unknown', 'ambiguous historical debt prevents a positive verdict'); assert.equal(latest.verdict.status, 'unknown', 'ambiguous debt also prevents a verdict in the latest window');
  const bad = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10', asOfMonth: '2026-09' });
  assert.equal(bad.facts.asOfMonth, '2026-06'); assert.match(bad.verdict.reasons.join(' '), /2026-09 is not a complete month.*as of 2026-06/);
  // Debts: balances come from the chosen month's column; a zero-balance month drops the account; ambiguous history stays unknown.
  const opts = snapshot().accountOptions.map(a => ({ ...a, id: a.id.replace('c:', 'c:') }));
  const history = snap.sources.balanceSheet.accountHistory;
  const atMarch = draftQuickDebts(opts, [], { accountHistory: history, asOfMonth: '2026-03' });
  assert.deepEqual(atMarch.map(d => [d.id, d.balance, d.asOf]), [['c:loan-1', 1400000, '2026-03-28'], ['c:ocl-1', null, null], ['c:ocl-2', null, null]], 'card had no balance in March; ambiguous OCL stays unknown');
  const atJune = draftQuickDebts(opts, atMarch, { accountHistory: history, asOfMonth: '2026-06' });
  assert.deepEqual(atJune.map(d => [d.id, d.balance]), [['c:loan-1', 1250000], ['c:cc-1', 80000], ['c:ocl-1', null]]);
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



test('unknown loan balances stay visible, count unknown payments, and block positive verdicts and totals', () => {
  const snap = snapshot({ operating: 200000 });
  snap.accountOptions.push({ id: 'c:unmatched', label: 'Unmatched loan', accountType: 'Long Term Liability', balance: null });
  const debts = draftQuickDebts(snap.accountOptions);
  assert.equal(debts.at(-1).include, true);
  const r = quickLook({ snapshot: snap, inputs, debts, month: '2026-10' });
  assert.equal(r.unknownPaymentCount, 3);
  assert.equal(r.verdict.status, 'unknown');
  assert.equal(r.existingDebt, null);
  assert.equal(r.knownDebt, 1280000);
  assert.equal(r.ratios.debtToAssetsBefore, null);
  assert.equal(r.ratios.cashCoverMonths, null);
  assert.equal(r.ratios.debtToAssetsAfter, null);
  assert.match(quickDebtsHtml(debts, money), /Unknown — no matched balance/);
  const html = quickPrintHtml({ result: r, debts, snapshot: snap, money, preparedAt: '2026-10-03' });
  for (const text of ['Unmatched loan', 'Debt coverage incomplete', 'QBO account mapping', 'Total ticked debt unknown', 'known balance subtotal']) assert.ok(html.includes(text), text);
  // Entered P&I is still real evidence, but cannot certify missing balances.
  debts.at(-1).monthlyPayment = 1200;
  assert.equal(quickLook({ snapshot: snap, inputs, debts }).knownExisting, 1200);
});

test('missing, failed, partial or truncated debt sources never masquerade as zero debt', () => {
  for (const key of ['accounts', 'balanceSheet']) for (const status of [undefined, 'missing', 'error', 'partial']) {
    const snap = snapshot({ operating: 200000 }); snap.accountOptions = [];
    snap.sources[key].status = status;
    const r = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' });
    assert.equal(r.verdict.status, 'unknown', `${key}: ${status}`);
    assert.equal(r.existingDebt, null);
  }
  const snap = snapshot({ operating: 200000 }); snap.sources.accounts.truncated = true;
  assert.equal(quickLook({ snapshot: snap, inputs }).verdict.status, 'unknown');
});

test('matched zero/repaid balances are not unknown debt; complete sources permit a zero-debt verdict', () => {
  const snap = snapshot({ operating: 200000 });
  snap.accountOptions = [{ id: 'paid', accountType: 'Long Term Liability', balance: 0, balanceAsOf: '2026-06-30' }, { id: 'credit', accountType: 'Credit Card', balanceAsOf: '2026-06-30', balance: -10 }];
  const debts = draftQuickDebts(snap.accountOptions);
  assert.deepEqual(debts, []);
  const r = quickLook({ snapshot: snap, inputs, debts, month: '2026-10' });
  assert.equal(r.existingDebt, 0); assert.equal(r.verdict.status, 'comfortable');
});

test('explicit exclusions survive refresh without hiding unknown source coverage or including nonloan liabilities', () => {
  const options = [{ id: 'loan', label: 'Excluded loan', accountType: 'Long Term Liability', balance: null }, { id: 'tax', label: 'Tax', accountType: 'Other Current Liability', balance: null }];
  const debts = draftQuickDebts(options, [{ id: 'loan', include: false, monthlyPayment: 20 }]);
  assert.ok(debts.every(d => !d.include));
  const snap = snapshot({ operating: 200000 }); snap.accountOptions = options;
  const r = quickLook({ snapshot: snap, inputs, debts, month: '2026-10' });
  assert.equal(r.includedCount, 0); assert.equal(r.knownExisting, 0); assert.equal(r.verdict.status, 'unknown');
  assert.match(quickPrintHtml({ result: r, debts, snapshot: snap, money }), /○ Excluded loan/);
  const failedRefresh = draftQuickDebts([], debts);
  assert.equal(failedRefresh.length, 2); assert.ok(failedRefresh.every(d => d.balance === null && !d.include));
});


test('selected-month missing debt history never borrows a latest balance, while historical zero stays zero', () => {
  const snap = datedSnapshot();
  snap.accountOptions = [snap.accountOptions[0]];
  snap.sources.balanceSheet.accountHistory[0].values = [{ periodEnd: '2026-06-30', balance: 1200000 }];
  const args = { accountHistory: snap.sources.balanceSheet.accountHistory, asOfMonth: '2026-03' };
  const debts = draftQuickDebts(snap.accountOptions, [], args);
  assert.equal(debts[0].balance, null); assert.equal(debts[0].asOf, null);
  const r = quickLook({ snapshot: snap, inputs, debts, month: '2026-10', asOfMonth: '2026-03' });
  assert.equal(r.verdict.status, 'unknown'); assert.equal(r.existingDebt, null);
  snap.sources.balanceSheet.accountHistory[0].values.push({ periodEnd: '2026-03-31', balance: 0 });
  const zero = draftQuickDebts(snap.accountOptions, debts, args);
  assert.deepEqual(zero, []);
  assert.equal(quickLook({ snapshot: snap, inputs, debts: zero, month: '2026-10', asOfMonth: '2026-03' }).existingDebt, 0);
});


test('default latest-complete month checks debt coverage for that month, not a newer partial headline', () => {
  const snap = snapshot({ operating: 200000 });
  snap.accountOptions = [{ id: 'c:loan', label: 'Loan', accountType: 'Long Term Liability', balance: 100, balanceAsOf: '2026-07-10' }];
  snap.sources.balanceSheet.monthly.push({ month: '2026-07', periodEnd: '2026-07-10', completeMonth: false, bookCash: 1000, assets: 10000 });
  const r = quickLook({ snapshot: snap, inputs, debts: draftQuickDebts(snap.accountOptions), month: '2026-10' });
  assert.equal(r.facts.asOfMonth, '2026-06'); assert.equal(r.debtCoverage.complete, false); assert.equal(r.verdict.status, 'unknown');
});

const plannedSnapshot = () => {
  const snap = snapshot({ operating: 60000 }); // Jan–Jun 2026 complete P&L and cash-flow months
  snap.sources.revenuePlan = { status: 'partial', businessDate: '2026-07-03', monthly: [
    ...months.map((m, i) => { const actual = 800000 + (i === 0 ? 100000 : 0) - (i === 1 ? 100000 : 0); return { month: m, plannedSales: 1000000, actualNetSales: actual, matchedPlannedSales: 1000000, matchedActualNetSales: actual, matchedLocationDays: 90, unmappedPlanRows: 0, unplannedActualLocationDays: 0, missingActualPlanLocationDays: 0, completeMonth: true }; }),
    { month: '2026-07', plannedSales: 1200000, actualNetSales: 95000, completeMonth: false },
    { month: '2026-08', plannedSales: 900000, actualNetSales: null, completeMonth: false },
    { month: '2026-09', plannedSales: 600000, actualNetSales: null, completeMonth: false },
    { month: '2026-10', plannedSales: 1500000, actualNetSales: null, completeMonth: false },
    { month: '2026-11', plannedSales: 4000000, actualNetSales: null, completeMonth: false },
    { month: '2026-12', plannedSales: 1800000, actualNetSales: null, completeMonth: false },
  ] };
  return snap;
};

test('the forward outlook turns the sales plan into projected cash with measured attainment and conversion', () => {
  const snap = plannedSnapshot();
  const o = forwardOutlook(snap);
  assert.equal(o.available, true);
  assert.equal(o.attainment, .8); assert.equal(o.attainmentMonths, 6); assert.equal(o.attainmentFrom, '2026-01'); assert.equal(o.attainmentTo, '2026-06');
  assert.ok(Math.abs(o.conversion - 360000 / 4800000) < 1e-12, 'operating cash per recorded sales dollar'); assert.equal(o.conversionLabel, 'operating cash flow'); assert.equal(o.conversionMonths, 6);
  assert.deepEqual(o.months.map(m => m.month), ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'], 'starts at the business month, current partial month included as plan');
  assert.equal(o.months[4].projectedCash, 4000000 * .8 * .075); assert.equal(o.totalPlanned, 10000000); assert.equal(o.totalProjected, 600000); assert.equal(o.averageProjected, 100000);
  assert.equal(o.weakest.month, '2026-09');
  // As of an earlier month: calibration stops there and the window starts after it.
  const march = forwardOutlook(snap, { asOfMonth: '2026-03' });
  assert.equal(march.attainmentMonths, 3); assert.equal(march.months[0].month, '2026-04'); assert.equal(march.months.length, 9);
  // Not enough matched months: no forward basis, with the reason named.
  const thin = plannedSnapshot(); thin.sources.cashflow.monthly = thin.sources.cashflow.monthly.slice(0, 2); thin.sources.profitAndLoss.monthly = thin.sources.profitAndLoss.monthly.slice(0, 2);
  const t = forwardOutlook(thin); assert.equal(t.available, false); assert.match(t.reasons.join(' '), /cash-flow statement covers only 2 of those months/); assert.equal(t.conversion, null);
  assert.equal(forwardOutlook(snapshot()).available, false);
  // Without a cash-flow statement the conversion falls back to net operating income and says so.
  const noCf = plannedSnapshot(); noCf.sources.cashflow = { status: 'missing', monthly: [] };
  const n = forwardOutlook(noCf); assert.equal(n.conversionLabel, 'net operating income'); assert.match(n.reasons.join(' '), /not cash/);
});

test('the plan is the default basis, the trailing share stays beside it, and the proposal shows the plan table in plain numbers', () => {
  const snap = plannedSnapshot();
  const r = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' });
  assert.equal(r.basisChoice, 'plan'); assert.equal(r.basis.key, 'plan'); assert.equal(r.basis.average, 100000);
  assert.ok(Math.abs(r.ratios.serviceShare - r.combinedService / 100000) < 1e-12);
  assert.ok(Math.abs(r.ratios.trailingShare - r.combinedService / 60000) < 1e-12);
  assert.ok(Math.abs(r.ratios.planWeakestShare - r.combinedService / 36000) < 1e-9);
  assert.match(r.verdict.title, /on the sales plan/);
  assert.match(r.verdict.reasons.join(' '), /planned sales 10,000,000 × 80% plan attainment \(6 months\) × 7\.5¢ of operating cash flow per recorded sales dollar/);
  assert.match(r.verdict.reasons.join(' '), /Weakest plan month 2026-09/);
  assert.match(r.verdict.reasons.join(' '), /On the last 6 months of actual operating cash flow .* the share is/);
  const t = quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10', basis: 'trailing' });
  assert.equal(t.basisChoice, 'trailing'); assert.match(t.verdict.title, /on recent results/); assert.match(t.verdict.reasons.join(' '), /On the sales plan for the next 6 months .* the share would be/);
  const none = quickLook({ snapshot: snapshot(), inputs, debts: [], month: '2026-10', basis: 'plan' });
  assert.equal(none.basisChoice, 'trailing'); assert.match(none.verdict.reasons.join(' '), /sales-plan basis was requested but is not available/);
  // A negative conversion reads as "does not fit on the sales plan", never as a projection of positive cash.
  const neg = plannedSnapshot(); neg.sources.cashflow.monthly.forEach(x => { x.operating = -10000; });
  const nr = quickLook({ snapshot: neg, inputs, debts: [], month: '2026-10' });
  assert.equal(nr.verdict.status, 'no'); assert.match(nr.verdict.title, /on the sales plan/); assert.match(nr.verdict.reasons.join(' '), /conversion is negative/);
  const html = quickProposalHtml({ result: r, debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  for (const text of ['Forward outlook from the sales plan', '80% plan attainment', '7.5¢ of operating cash flow', '<td>2026-11</td><td>4,000,000</td><td>$240,000</td>', '6-month total', '<strong>10,000,000</strong>', '<strong>$600,000</strong>']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('$4,000,000'), 'planned sales are never printed in the statement currency');
  const facts = quickFactsHtml(r, money);
  assert.ok(facts.includes('Projected monthly operating cash · sales plan')); assert.ok(facts.includes('$100.0K')); assert.ok(facts.includes('Plan attainment')); assert.ok(facts.includes('80%'));
});

test('the forward basis fails closed on thin attainment, a thin cash-flow statement, and unmapped plan rows', () => {
  // Two plan/actual months, six cash-flow months: attainment is not measured, so nothing is projected at face value.
  const young = plannedSnapshot();
  young.sources.revenuePlan.monthly = young.sources.revenuePlan.monthly.map(r => r.completeMonth && r.month < '2026-05' ? { ...r, plannedSales: null, matchedPlannedSales: null, matchedLocationDays: 0 } : r);
  const y = forwardOutlook(young);
  assert.equal(y.available, false); assert.equal(y.attainment, null); assert.match(y.reasons.join(' '), /attainment is not measured: only 2 months have both a plan and recorded sales for the same locations/);
  assert.equal(quickLook({ snapshot: young, inputs, debts: [], month: '2026-10' }).basisChoice, 'trailing');
  // A saved cash-flow statement with two negative matched months is incomplete coverage, never a reason to read P&L profit as cash.
  const sparse = plannedSnapshot();
  sparse.sources.cashflow.monthly = sparse.sources.cashflow.monthly.slice(0, 2).map(x => ({ ...x, operating: -5000 }));
  const sp = forwardOutlook(sparse);
  assert.equal(sp.available, false); assert.equal(sp.conversion, null); assert.match(sp.reasons.join(' '), /cash-flow statement covers only 2 of those months.*Net operating income is not used/);
  const spLook = quickLook({ snapshot: sparse, inputs, debts: [], month: '2026-10' });
  assert.equal(spLook.basisChoice, 'trailing'); assert.ok(!/net operating income/.test(spLook.forward.conversionLabel || ''));
  // A plan row that maps to no location breaks the like-for-like comparison, in history or ahead.
  const unmappedHistory = plannedSnapshot(); unmappedHistory.sources.revenuePlan.monthly[2].unmappedPlanRows = 4;
  assert.match(forwardOutlook(unmappedHistory).reasons.join(' '), /plan rows that map to no location \(2026-03\)/);
  const unmappedAhead = plannedSnapshot(); unmappedAhead.sources.revenuePlan.monthly.find(r => r.month === '2026-11').unmappedPlanRows = 1;
  assert.match(forwardOutlook(unmappedAhead).reasons.join(' '), /ahead \(2026-11\) carry plan rows that map to no location/);
});

test('attainment is measured on matched locations while conversion counts every recorded sales dollar', () => {
  // The plan covers one store; Shopify also records an unplanned online stream.
  const snap = plannedSnapshot();
  snap.sources.revenuePlan.monthly = snap.sources.revenuePlan.monthly.map(r => r.completeMonth
    ? { ...r, plannedSales: 1000000, matchedPlannedSales: 1000000, matchedActualNetSales: 500000, actualNetSales: 1500000, unplannedActualLocationDays: 30 }
    : r);
  const o = forwardOutlook(snap);
  assert.equal(o.available, true);
  assert.equal(o.attainment, .5, 'matched actual ÷ matched planned, not whole-month 1.5M ÷ 1M');
  assert.ok(Math.abs(o.conversion - 360000 / 9000000) < 1e-12, 'cash per dollar of ALL recorded sales, the conservative denominator');
  assert.equal(o.unplannedStreams, true); assert.match(o.reasons.join(' '), /locations the plan does not cover.*understates rather than overstates/);
  assert.equal(o.months[4].projectedCash, 4000000 * .5 * .04);
  const html = quickProposalHtml({ result: quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' }), debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(html.includes('50% plan attainment')); assert.ok(html.includes('for the same locations')); assert.ok(html.includes('locations the plan does not cover'));
});

test('a plan month that was barely recorded cannot calibrate attainment, and unrecorded planned dollars count as unattained', () => {
  // Three complete months, each planned for thirty location-days at $100 with ONE recorded day at $200:
  // 200% on the recorded day, 29 planned location-days with no record. Matched sums alone would admit all three at 200%.
  const sparse = plannedSnapshot();
  sparse.sources.revenuePlan.monthly = sparse.sources.revenuePlan.monthly.map(r => r.completeMonth
    ? { ...r, plannedSales: 3000, matchedPlannedSales: 100, matchedActualNetSales: 200, actualNetSales: 200, matchedLocationDays: 1, missingActualPlanLocationDays: 29 }
    : r);
  const sp = forwardOutlook(sparse);
  assert.equal(sp.available, false); assert.equal(sp.attainment, null); assert.deepEqual(sp.months, []);
  assert.match(sp.reasons.join(' '), /6 plan months \(2026-01 96\.7%, .*2026-06 96\.7%\) had more than 20% of planned sales with no recorded sales for that location-day/);
  assert.equal(quickLook({ snapshot: sparse, inputs, debts: [], month: '2026-10' }).basisChoice, 'trailing');
  // The bound is in DOLLARS, not location-days: a month missing a third of its location-days but 8% of its planned
  // dollars (daily-planned event locations that did not trade) still calibrates -- against EVERY planned dollar.
  const seasonal = plannedSnapshot();
  seasonal.sources.revenuePlan.monthly = seasonal.sources.revenuePlan.monthly.map(r => r.completeMonth
    ? { ...r, plannedSales: 1000000, matchedPlannedSales: 920000, matchedActualNetSales: 800000, actualNetSales: 800000, matchedLocationDays: 320, missingActualPlanLocationDays: 160 }
    : r);
  const se = forwardOutlook(seasonal);
  assert.equal(se.available, true);
  assert.equal(se.attainment, .8, '800,000 ÷ 1,000,000 planned, not ÷ 920,000 matched (86.96%)');
  assert.equal(se.unmeasuredPlanShare, .08);
  assert.match(se.reasons.join(' '), /8% of planned sales in the calibration months fell on location-days with no recorded sales.*count as unattained/);
  // Exactly at the bound qualifies; one dollar past it does not.
  const edge = plannedSnapshot();
  edge.sources.revenuePlan.monthly = edge.sources.revenuePlan.monthly.map(r => r.completeMonth ? { ...r, plannedSales: 1000000, matchedPlannedSales: 800000, matchedActualNetSales: 700000, actualNetSales: 700000 } : r);
  assert.equal(forwardOutlook(edge).available, true);
  edge.sources.revenuePlan.monthly = edge.sources.revenuePlan.monthly.map(r => r.completeMonth ? { ...r, matchedPlannedSales: 799999 } : r);
  assert.equal(forwardOutlook(edge).available, false);
  // Only the months that fail coverage are dropped; the rest still calibrate when enough remain.
  const mixed = plannedSnapshot();
  mixed.sources.revenuePlan.monthly = mixed.sources.revenuePlan.monthly.map(r => r.completeMonth && r.month < '2026-04'
    ? { ...r, plannedSales: 3000, matchedPlannedSales: 100, matchedActualNetSales: 200, actualNetSales: 200, missingActualPlanLocationDays: 29 } : r);
  const mx = forwardOutlook(mixed);
  assert.equal(mx.available, true); assert.equal(mx.attainmentMonths, 3); assert.equal(mx.attainmentFrom, '2026-04'); assert.equal(mx.attainment, .8);
  // The proposal and the fact strip say what the figure is and what it leaves out.
  const html = quickProposalHtml({ result: quickLook({ snapshot: seasonal, inputs, debts: [], month: '2026-10' }), debts: [], snapshot: seasonal, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(html.includes('every planned dollar')); assert.ok(html.includes('8% of planned sales in the calibration months'));
  const facts = quickFactsHtml(quickLook({ snapshot: seasonal, inputs, debts: [], month: '2026-10' }), money);
  assert.ok(facts.includes('8% of plan unrecorded, counted as unattained'));
});

test('a net-negative unplanned stream cannot inflate the conversion', () => {
  // Planned locations sell $500k against a $1m plan; an unplanned location books $400k of net returns, so the
  // whole-month total is $100k; operating cash is $50k. Dividing cash by the $100k total would read 50% conversion
  // and project $250k per $1m of plan, five times the $50k the month actually produced.
  const snap = plannedSnapshot();
  snap.sources.revenuePlan.monthly = snap.sources.revenuePlan.monthly.map(r => r.completeMonth
    ? { ...r, plannedSales: 1000000, matchedPlannedSales: 1000000, matchedActualNetSales: 500000, actualNetSales: 100000, unplannedActualLocationDays: 30 }
    : r);
  snap.sources.cashflow.monthly.forEach(x => { x.operating = 50000; });
  const o = forwardOutlook(snap);
  assert.equal(o.available, true);
  assert.equal(o.attainment, .5); assert.equal(o.conversion, .1, 'cash ÷ the planned locations\' sales, not ÷ the smaller total');
  assert.equal(o.months[4].projectedCash, 4000000 * .05, 'attainment × conversion equals measured cash ÷ plan');
  assert.deepEqual(o.netNegativeUnplanned, months.slice());
  assert.match(o.reasons.join(' '), /In 2026-01, .*2026-06 recorded sales net below the planned locations' own sales/);
  // A positive unplanned stream is unchanged: all recorded sales stay the denominator.
  const pos = plannedSnapshot();
  pos.sources.revenuePlan.monthly = pos.sources.revenuePlan.monthly.map(r => r.completeMonth ? { ...r, matchedActualNetSales: 500000, actualNetSales: 1500000 } : r);
  const po = forwardOutlook(pos); assert.deepEqual(po.netNegativeUnplanned, []); assert.ok(Math.abs(po.conversion - 360000 / 9000000) < 1e-12);
  // The invariant the wording claims: projected cash per planned dollar never exceeds measured cash per planned dollar.
  assert.ok(o.attainment * o.conversion <= 50000 / 1000000 + 1e-12); assert.ok(po.attainment * po.conversion <= 60000 / 1000000 + 1e-12);
  const html = quickProposalHtml({ result: quickLook({ snapshot: snap, inputs, debts: [], month: '2026-10' }), debts: [], snapshot: snap, money, companyTitle: 'Co', preparedAt: '2026-10-03' });
  assert.ok(html.includes('net returns at a location the plan does not cover'));
});
