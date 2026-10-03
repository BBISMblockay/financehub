// Node integration harness for the actual workspace bindings. No browser, network,
// customer sources, server, or production auth bypass is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../scenario-model.js';
import * as charts from '../charts.js';
import { businessView } from '../business-view.js';
import { assessFundingCapacity } from '../capacity-model.js';
import { assessFacilityPortfolio } from '../facility-model.js';
import * as facilityView from '../facility-view.js';
import * as cashTimingModel from '../cash-timing.js';
import * as timingView from '../timing-view.js';
import * as reviewView from '../review-view.js';
import { compareReviewSnapshots } from '../review-snapshot.js';
import { createLoadGuard } from '../context.js';
import { parseInputNumber, validateScenarioDocument } from '../scenario-file.js';
import * as quickLookModule from '../quick-look.js';

const workspace = (await readFile(new URL('../workspace.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '')
  .replace(/boot\(\)\.catch\(error=>clearSensitive\(error.message\)\);\s*$/, '');
function harness({ readContext, loadSourceSnapshot } = {}) {
  const nodes = new Map(); const downloads = [];
  const createElement = tag => ({ tag, value: '', checked: false, hidden: false, options: [], innerHTML: '', textContent: '', className: '', children: [],
    dataset: {}, attributes: {}, contains: () => false, closest: () => ({ hidden: false }), querySelectorAll: () => [], querySelector: () => null,
    setAttribute(key, value) { this.attributes[key] = value; }, hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
    focus() { document.activeElement = this; }, click() { this.clicked = true; },
    replaceChildren(...children) { this.children = children; this.innerHTML = ''; this.textContent = ''; }, addEventListener(name, callback) { this[name] = callback; },
  });
  const node = id => { if (!nodes.has(id)) nodes.set(id, createElement('div')); return nodes.get(id); };
  const document = { getElementById: node, createElement, activeElement: null, addEventListener() {}, querySelectorAll: () => [], querySelector: selector => selector === '.uw-flow' ? node('flow') : null };
  const steps = ['business', 'funding', 'test', 'review'];
  const panels = steps.map(step => Object.assign(node('panel-' + step), { dataset: { stepPanel: step } }));
  const tabs = steps.map(step => Object.assign(node('tab-' + step), { dataset: { step } }));
  document.querySelectorAll = selector => selector === '[data-step-panel]' ? panels : selector === '[role="tab"][data-step]' ? tabs : [];
  const auth = { onAuthStateChange(callback) { this.callback = callback; } };
  const sandbox = { ...model, ...charts, ...facilityView, ...cashTimingModel, ...timingView, ...reviewView, ...quickLookModule, businessView, assessFundingCapacity, assessFacilityPortfolio, createLoadGuard, number: parseInputNumber, validateScenarioDocument,
    readContext: readContext || (async () => ({ key: 'user:11111111-1111-4111-8111-111111111111', company: { id: '11111111-1111-4111-8111-111111111111', title: 'Synthetic company A' } })),
    loadSourceSnapshot: loadSourceSnapshot || (async () => ({ sources: {} })),
    document, JSON, Blob, TextEncoder, URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:synthetic-download'; }, revokeObjectURL() {} }, setTimeout: callback => callback(), window: { print() { this.printed = true; }, location: { reload() {} }, addEventListener() {},
      __SILO_CONFIG__: { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_ANON_KEY: 'synthetic-only' },
      supabase: { createClient: () => ({ auth }) } }, AbortController, Intl, Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${workspace}\nglobalThis.api={state,allDefs,inputModel,assessCurrentCapacity,capacityTerms,importScenario,load,boot,render,renderMonthlyEditor,renderCommitmentEditor,renderSources,sourceRows,clearSensitive,captureReview,printProposal,buildPrintPacket,setStep,setMode,renderQuick,download,revalidate,resumeView,renderFacility,choosePreset,presetFromValues};`, sandbox);
  const api = sandbox.api;
  api.state.ready = true;
  api.state.context = { key: 'user:11111111-1111-4111-8111-111111111111', company: { id: '11111111-1111-4111-8111-111111111111' } };
  api.state.sources = { sources: {} };
  for (const [id, , type, initial, , options] of api.allDefs) {
    api.state.values[id] = initial;
    node(id).value = initial;
    if (type === 'select') node(id).options = options.map(([value]) => ({ value }));
  }
  Object.assign(api.state.values, { amount: '1000', rate: '0', term: '12', startMonth: '2026-10', useOfProceeds: '0',
    startingCash: '500', cashFloor: '100', normalizedCash: '100', existingPayment: '0', currency: 'USD',
    debtComplete: true, commitmentsComplete: true, cashProvenance: 'Prior cash evidence', debtProvenance: 'Prior debt evidence',
    cashEvidence: 'Prior opening-cash evidence', purpose: 'Prior cash-use purpose',
    upfrontFees: '0', forecastMonths: '12', cashForecastReviewed: true, termsProvenance: 'Synthetic explicit loan assumptions',
  });
  const scenario = () => ({ format: 'silo-underwriting-scenario', version: 4, companyId: '11111111-1111-4111-8111-111111111111',
    values: { ...api.state.values }, overrides: {}, commitments: [], facilities: [], cashTiming: cashTimingModel.emptyCashTimingAssumptions(), reviewBaseline: null,
  });
  const file = doc => ({ size: 5000, text: async () => JSON.stringify(doc) });
  return { api, node, document, scenario, file, auth, window: sandbox.window, downloads };
}

const reviewedPayment = () => ({ id: 'payment-1', month: '2026-10', amount: 100, currency: 'USD', sourceReference: 'Synthetic PO A / contract', paymentType: 'deposit', inclusion: 'incremental', reviewed: true });
async function mountedHarness() {
  const h = harness(); const values = { ...h.api.state.values };
  await h.api.boot(); Object.assign(h.api.state.values, values);
  return h;
}

test('partial imports reject atomically instead of inheriting prior complete evidence', async () => {
  const { api, scenario, file } = harness();
  const before = JSON.stringify(api.state.values);
  const input = scenario(); input.values = { amount: '2000' };
  await assert.rejects(api.importScenario(file(input)), /incomplete/);
  assert.equal(JSON.stringify(api.state.values), before);
  assert.equal(api.state.result, null);
});

test('complete import replaces prior evidence and keeps whitespace cash unknown', async () => {
  const { api, node, scenario, file } = harness();
  const input = scenario();
  Object.assign(input.values, { normalizedCash: '   ', cashProvenance: '', cashEvidence: '', debtProvenance: '', debtComplete: false });
  await api.importScenario(file(input));
  assert.equal(api.state.values.normalizedCash, '');
  assert.equal(node('normalizedCash').value, '');
  assert.equal(api.state.values.debtComplete, false);
  assert.equal(api.state.values.cashEvidence, '');
  assert.equal(api.inputModel().normalizedPreDebtCash.monthlyAmount, null);
  assert.equal(api.state.result.summary.fullHorizonDscr, null);
});

test('funding-month WC evidence cannot borrow the cash-use purpose', () => {
  const { api } = harness();
  api.state.overrides = { '2026-10': { workingCapitalUse: '100' } };
  const input = api.inputModel();
  assert.equal(input.monthlyOverrides[0].provenanceByField.workingCapitalUse, '');
  assert.match(model.computeScenario(input).errors.join(' '), /workingCapitalUse override requires provenance/);
});

test('combined overrides retain independently validated cash, WC and use evidence', () => {
  const { api } = harness();
  api.state.values.wcProvenance = 'WC timing plan';
  api.state.overrides = { '2026-10': { preDebtCash: '200', workingCapitalUse: '100', otherCashUse: '20' } };
  const input = api.inputModel();
  const result = model.computeScenario(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].cashProvenance, 'Prior cash evidence');
  assert.deepEqual(result.rows[0].usesProvenance, { workingCapitalUse: 'WC timing plan', otherCashUse: 'Prior cash-use purpose' });
  api.state.values.cashProvenance = '';
  assert.match(model.computeScenario(api.inputModel()).errors.join(' '), /preDebtCash override requires provenance/);
});

test('field-keyed provenance never falls back to a legacy row reference', () => {
  const { api } = harness();
  const input = api.inputModel();
  input.monthlyOverrides = [{ month: '2026-10', preDebtCash: 200, workingCapitalUse: 100,
    provenance: 'Unrelated whole-row note', provenanceByField: { preDebtCash: 'Cash bridge' } }];
  assert.match(model.computeScenario(input).errors.join(' '), /workingCapitalUse override requires provenance/);
  input.monthlyOverrides[0].provenanceByField = null;
  assert.match(model.computeScenario(input).errors.join(' '), /provenanceByField must be an object/);
});

test('invalid monthly edit clears every stale result cell while preserving the input', () => {
  const { api, node, document } = harness();
  const input = { value: '-1' }; document.activeElement = input;
  const cells = [{ textContent: '$1,000' }, { textContent: '2.00×' }, { textContent: '$2,000' }, { textContent: '3.00×' }];
  const editor = node('monthlyEditor');
  editor.contains = element => element === input;
  editor.innerHTML = 'existing editor markup'; editor.querySelectorAll = () => cells;
  api.state.overrides = { '2026-10': { otherCashUse: '-1' } };
  const result = model.computeScenario(api.inputModel());
  assert.equal(result.rows.length, 0);
  api.renderMonthlyEditor(result.rows);
  assert.ok(cells.every(cell => cell.textContent === '—'));
  assert.equal(editor.innerHTML, 'existing editor markup');
  assert.equal(document.activeElement, input); assert.equal(input.value, '-1');
});

test('bank balances show each timestamp, connection status and environment safely', () => {
  const { api } = harness();
  const html = api.sourceRows('bank', { rows: [
    { name: 'Test account', current_balance: 25, available_balance: null, iso_currency_code: 'USD', balance_updated_at: '2026-10-01T01:02:03Z', connection_status: 'inactive', environment: 'sandbox' },
    { name: '<img src=x onerror=alert(1)>', current_balance: null },
  ] });
  for (const text of ['Balance as of', 'Connection status', 'Environment', '2026-10-01T01:02:03Z', 'inactive', 'sandbox', 'Unknown']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
});

test('source-strip dates stay compact while source detail retains full timestamps', () => {
  const { api, node } = harness();
  api.state.sources.sources.bank = { status: 'partial', asOf: '2026-10-01T01:02:03Z', rows: [] };
  api.renderSources();
  assert.ok(node('sourceStrip').innerHTML.includes('2026-10-01'));
  assert.ok(!node('sourceStrip').innerHTML.includes('T01:02:03Z'));
  assert.ok(node('sourceDetail').innerHTML.includes('2026-10-01T01:02:03Z'));
});

test('signed-out and uncertain gates offer safe static recovery actions', () => {
  let setup = harness();
  setup.api.clearSensitive('Signed out. Sign in to SILO and refresh this page.');
  assert.equal(setup.node('gate').children[1].tag, 'a');
  assert.equal(setup.node('gate').children[1].href, '/pages/login.html?next=%2Fv2%2Funderwriting%2Findex.html');
  assert.equal(setup.api.state.ready, false);
  setup = harness(); setup.api.clearSensitive('Company changed. Refresh to continue.');
  assert.equal(setup.node('gate').children[1].tag, 'button');
  assert.equal(setup.node('gate').children[1].textContent, 'Refresh page');
  assert.equal(typeof setup.node('gate').children[1].click, 'function');
});

test('late source response cannot repaint after a newer load has completed', async () => {
  let finishOld, markOldStarted;
  const oldSource = new Promise(resolve => { finishOld = resolve; });
  const oldStarted = new Promise(resolve => { markOldStarted = resolve; });
  const freshSnapshot = { currency: 'USD', sources: { bank: { status: 'available', asOf: '2026-10-02T12:00:00Z' } } };
  let sourceCalls = 0;
  const { api, node } = harness({ loadSourceSnapshot: async () => {
    if (++sourceCalls === 1) { markOldStarted(); return oldSource; }
    return freshSnapshot;
  } });
  const first = api.load();
  await oldStarted;
  await api.load();
  assert.equal(api.state.sources, freshSnapshot);
  assert.equal(api.state.ready, true);
  const painted = node('sourceStrip').innerHTML;
  finishOld({ currency: 'USD', sources: { bank: { status: 'available', asOf: '2025-01-01T00:00:00Z' } } });
  await first;
  assert.equal(api.state.sources, freshSnapshot);
  assert.equal(node('sourceStrip').innerHTML, painted);
  assert.ok(painted.includes('2026-10-02'));
  assert.equal(node('refresh').disabled, false);
});

test('company change during source loading clears the snapshot and prior scenario', async () => {
  let reads = 0;
  const { api, node } = harness({
    readContext: async () => {
      const company = ++reads === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      return { key: `user:${company}`, company: { id: company } };
    },
    loadSourceSnapshot: async () => ({ currency: 'USD', sources: { bank: { status: 'available', asOf: '2026-10-02' } } }),
  });
  api.state.overrides = { '2026-10': { payment: '1500' } };
  api.state.facilities = [{ id: 'prior-company-facility' }];
  api.state.cashTiming.collections.enabled = true;
  api.state.reviewBaseline = { priorCompanySentinel: true };
  await api.load();
  assert.equal(reads, 2);
  assert.equal(api.state.sources, null);
  assert.equal(api.state.context, null);
  assert.equal(api.state.result, null);
  assert.equal(api.state.ready, false);
  assert.equal(api.state.values.amount, '');
  assert.equal(Object.keys(api.state.overrides).length, 0);
  assert.equal(api.state.facilities.length, 0);
  assert.equal(api.state.cashTiming.collections.enabled, false);
  assert.equal(api.state.reviewBaseline, null);
  assert.equal(node('workspace').hidden, true);
  assert.equal(node('gate').hidden, false);
  assert.match(node('gate').children[0].textContent, /Company changed while sources were loading/);
});

test('input errors are visible beside the proposal without replacing source-read status', () => {
  const { api, node } = harness();
  node('status').textContent = 'One source read failed.';
  Object.assign(api.state.values, { amount: '-1', rate: '-1', term: '1.5' });
  api.render();
  const html = node('proposalResult').innerHTML;
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('principal must be an explicit positive amount'));
  assert.ok(html.includes('annualRatePct must be an explicit nonnegative number'));
  assert.ok(html.includes('1 more input error(s) in Calculation notes'));
  assert.equal(node('status').textContent, 'One source read failed.');
  Object.assign(api.state.values, { amount: '1000', rate: '0', term: '12' });
  api.render();
  assert.ok(!node('proposalResult').innerHTML.includes('role="status"'));
  assert.equal(node('status').textContent, 'One source read failed.');
});

test('an existing-only scenario remains usable with no proposal inputs', () => {
  const { api, node } = harness();
  Object.assign(api.state.values, { amount: '', rate: '', term: '', existingPayment: '50' });
  api.render();
  assert.equal(api.inputModel().proposal, null);
  assert.deepEqual(api.state.result.errors, []);
  assert.equal(api.state.result.coverage.cashPathComplete, true);
  assert.equal(api.state.result.rows[0].proposedDebtService, 0);
  assert.equal(api.state.result.rows[0].closingCash, 550);
  assert.ok(node('debtSchedule').innerHTML.includes('2026-10'));
  assert.equal(api.state.capacity.status, 'incomplete', 'absent loan terms cannot establish debt capacity');
});

test('saved commitments replace current rows and preserve explicit review state', async () => {
  const { api, scenario, file, node } = harness();
  api.state.commitments = [{ ...reviewedPayment(), id: 'old-payment', sourceReference: 'Old commitment' }];
  const input = scenario(); input.commitments = [reviewedPayment()];
  await api.importScenario(file(input));
  assert.equal(api.state.commitments.length, 1);
  assert.equal(api.state.commitments[0].id, 'payment-1');
  assert.equal(api.state.commitments[0].reviewed, true);
  assert.equal(api.state.values.commitmentsComplete, true);
  assert.equal(api.state.result.rows[0].commitmentCashUse, 100);
  assert.ok(!node('commitmentEditor').innerHTML.includes('Old commitment'));
  input.commitments = [];
  await api.importScenario(file(input));
  assert.equal(api.state.commitments.length, 0);
});

test('editing commitment data invalidates row and horizon reviews without losing focus', async () => {
  const { api, node, document } = await mountedHarness();
  api.state.commitments = [reviewedPayment()];
  const target = { id: '', dataset: { commitment: 'payment-1', field: 'amount' }, value: '150' };
  document.activeElement = target;
  node('commitmentEditor').contains = el => el === target;
  const checkbox = { dataset: { commitment: 'payment-1' }, checked: true };
  node('commitmentEditor').querySelectorAll = () => [checkbox];
  node('workspace').change({ target });
  assert.equal(api.state.commitments[0].amount, 150);
  assert.equal(api.state.commitments[0].reviewed, false);
  assert.equal(checkbox.checked, false);
  assert.equal(api.state.values.commitmentsComplete, false);
  assert.equal(api.state.result.coverage.cashPathComplete, false);
  assert.equal(document.activeElement, target);
});

test('removing a focused commitment repaints rows and requires horizon re-review', async () => {
  const { api, node, document } = await mountedHarness();
  api.state.commitments = [reviewedPayment()]; api.renderCommitmentEditor(true);
  const remove = { dataset: { removeCommitment: 'payment-1' } };
  document.activeElement = remove; node('commitmentEditor').contains = () => true;
  node('workspace').click({ target: { closest: selector => selector === '[data-remove-commitment]' ? remove : null } });
  assert.equal(api.state.commitments.length, 0);
  assert.equal(api.state.values.commitmentsComplete, false);
  assert.ok(!node('commitmentEditor').innerHTML.includes('data-commitment="payment-1"'));
  assert.ok(node('commitmentEditor').innerHTML.includes('No payment assumptions entered'));
});

test('adding a commitment and changing currency or horizon require a new review', async () => {
  const { api, node } = await mountedHarness();
  node('addCommitment').click();
  assert.equal(api.state.commitments.length, 1);
  assert.equal(api.state.commitments[0].amount, null);
  assert.equal(api.state.commitments[0].reviewed, false);
  assert.equal(api.state.values.commitmentsComplete, false);
  for (const [id, value] of [['currency', 'CAD'], ['startMonth', '2026-11']]) {
    api.state.values.commitmentsComplete = true;
    node('workspace').change({ target: { id, value, dataset: {} } });
    assert.equal(api.state.values.commitmentsComplete, false);
  }
});

test('sign-out clears scenario, commitments and sources and hides the company workspace', async () => {
  const { api, node, auth } = await mountedHarness();
  api.state.commitments = [reviewedPayment()];
  auth.callback('SIGNED_OUT');
  assert.equal(api.state.ready, false);
  assert.equal(api.state.sources, null);
  assert.equal(api.state.context, null);
  assert.equal(api.state.commitments.length, 0);
  assert.equal(api.state.values.amount, '');
  assert.equal(node('workspace').hidden, true);
  assert.equal(node('gate').hidden, false);
});

test('business headline nulls cannot borrow a different statement period', () => {
  const rendered = businessView({ sources: {
    profitAndLoss: { currency: 'USD', monthly: [{ periodStart: '2026-09-01', periodEnd: '2026-09-30', revenue: null, grossProfit: 100 }],
      metrics: [{ label: 'Income', value: 123456 }, { label: 'Gross profit', value: 654321 }] },
    balanceSheet: { currency: 'USD', monthly: [{ periodEnd: '2026-09-30', bookCash: null, assets: null, equity: null, liabilities: null }],
      metrics: [{ label: 'Book bank balances', value: 123456 }, { label: 'Total assets', value: 123456 }, { label: 'Total equity', value: 123456 }] },
  } });
  assert.ok(!rendered.kpis.includes('$123.5K'));
  assert.match(rendered.kpis, /Gross margin<\/div><div class="uw-kpi-value">—/);
  assert.ok(!rendered.liquidity.includes('$123.5K'));
});

test('missing PO detail cannot be displayed as a known count of zero', () => {
  const rendered = businessView({ sources: { purchaseOrders: { status: 'partial', detailError: { message: 'Synthetic detail failure' } } } });
  assert.match(rendered.exposure, /Placed orders<\/span><strong>—/);
  assert.ok(rendered.exposure.includes('Synthetic detail failure'));
});

test('blank retained-cash floor cannot produce a confident funding-gap conclusion', () => {
  const { api, node } = harness();
  api.state.values.cashFloor = '';
  api.render();
  assert.equal(api.state.result.coverage.cashFloorKnown, false);
  assert.ok(node('cashInsights').innerHTML.includes('Review required'));
  assert.ok(!node('cashInsights').innerHTML.includes('floor at null'));
});

test('reopened draft stage and inclusion values stay visibly unknown', async () => {
  const { api, node, scenario, file } = harness();
  const input = scenario(); input.values.commitmentsComplete = false;
  input.commitments = [{ id: 'draft-1', month: '', amount: null, currency: '', sourceReference: '', paymentType: '', inclusion: '', reviewed: false }];
  await api.importScenario(file(input));
  const html = node('commitmentEditor').innerHTML;
  for (const key of ['paymentType', 'inclusion']) {
    const options = html.match(new RegExp(`data-field="${key}"[^>]*>(.*?)</select>`))?.[1];
    assert.ok(options?.includes('value="" selected'), `${key} must show its blank draft state`);
  }
});

test('scope-filtered headline totals cannot masquerade as company-wide figures', () => {
  const rendered = businessView({ sources: {
    profitAndLoss: { scopeFiltered: true, currency: 'USD', monthly: [], metrics: [{ label: 'Income', value: 123456 }, { label: 'Gross profit', value: 50000 }] },
    balanceSheet: { scopeFiltered: true, currency: 'USD', monthly: [], metrics: [{ label: 'Book bank balances', value: 123456 }, { label: 'Total assets', value: 123456 }] },
  } });
  assert.match(rendered.kpis, /Reported revenue<\/div><div class="uw-kpi-value">—/);
  assert.match(rendered.kpis, /Book bank balances<\/div><div class="uw-kpi-value">—/);
  assert.ok(!rendered.liquidity.includes('$123.5K'));
});

test('DSCR target changes actual reverse-sized capacity without requiring an entered loan amount', () => {
  const { api } = harness();
  Object.assign(api.state.values, { amount: '', rate: '9.5', term: '12', forecastMonths: '13', existingPayment: '10', coverageTarget: '1.25' });
  const first = api.assessCurrentCapacity(api.inputModel());
  api.state.values.coverageTarget = '1.5';
  const higher = api.assessCurrentCapacity(api.inputModel());
  assert.equal(api.inputModel().proposal, null);
  assert.equal(first.status, 'feasible');
  assert.equal(higher.status, 'feasible');
  assert.ok(higher.maximumAdditionalPrincipal < first.maximumAdditionalPrincipal);
});

test('capacity requires forecast review, opening-cash evidence and an explicit plan use', () => {
  for (const changes of [{ cashForecastReviewed: false }, { cashEvidence: '' }, { useOfProceeds: '' }, { useOfProceeds: '-1' }, { upfrontFees: '' }, { termsProvenance: '' }]) {
    const { api } = harness(); Object.assign(api.state.values, changes);
    const cap = api.assessCurrentCapacity(api.inputModel());
    assert.equal(cap.status, 'incomplete', JSON.stringify(changes));
    assert.equal(cap.suggestedPrincipal, null);
  }
});

test('funding month counts toward the horizon and extending it requires new reviews', async () => {
  const { api, node } = await mountedHarness();
  let cap = api.assessCurrentCapacity(api.inputModel());
  assert.equal(cap.scope, 'window-only');
  node('workspace').change({ target: { id: 'forecastMonths', value: '13', dataset: {} } });
  assert.equal(api.inputModel().horizonMonths, 13);
  assert.equal(api.state.values.cashForecastReviewed, false);
  assert.equal(api.state.values.debtComplete, false);
  assert.equal(api.state.values.commitmentsComplete, false);
  Object.assign(api.state.values, { cashForecastReviewed: true, debtComplete: true, commitmentsComplete: true });
  cap = api.assessCurrentCapacity(api.inputModel());
  assert.equal(cap.scope, 'full-term');
  assert.equal(cap.maturityMonth, '2027-10');
});

test('monthly cash and debt edits invalidate their corresponding horizon attestation', async () => {
  const { api, node } = await mountedHarness();
  node('workspace').change({ target: { id: '', value: '80', dataset: { month: '2026-11', key: 'preDebtCash' } } });
  assert.equal(api.state.values.cashForecastReviewed, false);
  assert.equal(api.state.values.debtComplete, true);
  api.state.values.cashForecastReviewed = true;
  node('workspace').change({ target: { id: '', value: '25', dataset: { month: '2026-11', key: 'payment' } } });
  assert.equal(api.state.values.debtComplete, false);
  assert.equal(api.state.values.cashForecastReviewed, true);
});

test('upfront fees reduce funding cash once and never become debt service', () => {
  const { api } = harness(); api.state.values.upfrontFees = '25';
  const result = model.computeScenario(api.inputModel());
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].proposalInflow, 1000);
  assert.equal(result.rows[0].financingFees, 25);
  assert.equal(result.rows[0].totalDebtService, 0);
  assert.equal(result.rows[0].closingCash, 1575);
  assert.equal(result.summary.totalFinancingFees, 25);
});

test('alternative funding structures discard inherited balloon amortization terms', () => {
  const { api, node } = harness();
  Object.assign(api.state.values, { repayment: 'balloon', amortizationMonths: '24', forecastMonths: '13' });
  api.render();
  const table = node('structureComparison').innerHTML;
  assert.ok(table.includes('Amortizing'));
  assert.ok(table.includes('Interest-only'));
  assert.equal((table.match(/\d\.\d\d×/g) || []).length, 2, 'both entered-amount comparisons retain computed DSCR');
});

test('unobserved annual payments explain why repayment capacity is unassessed', () => {
  const { api, node } = harness();
  Object.assign(api.state.values, { frequency: 'annual', term: '36' });
  api.render();
  assert.equal(api.state.capacity.status, 'unassessed');
  assert.equal(api.state.capacity.maximumAdditionalPrincipal, null);
  assert.match(node('capacityExplanation').innerHTML, /No proposed principal-plus-interest payment is observed/);
});

test('pre-funding shortfall is not mislabeled as a maturity outside the forecast', () => {
  const { api, node } = harness();
  Object.assign(api.state.values, { startingCash: '50', cashFloor: '100', forecastMonths: '13' });
  api.render();
  assert.ok(api.state.capacity.preFundingShortfall);
  assert.equal(api.state.capacity.maturityMonth, '2027-10');
  assert.match(node('capacityExplanation').innerHTML, /[Pp]re-funding|[Oo]pening.*shortfall/);
  assert.ok(!node('capacityExplanation').innerHTML.includes('beyond this 13-month forecast'));
});

test('amortizing-balloon selection requires an explicit amortization length', () => {
  const { api, node } = harness();
  Object.assign(api.state.values, { repayment: 'balloon', amortizationMonths: '', forecastMonths: '13' });
  api.render();
  assert.match(api.state.result.errors.join(' '), /amortizationMonths must be an integer/);
  assert.equal(api.state.result.proposalSchedule.rows.length, 0);
  assert.equal(api.state.capacity.status, 'incomplete');
  assert.equal(api.state.capacity.suggestedPrincipal, null);
  assert.ok(node('proposalResult').innerHTML.includes('amortizationMonths'));
  api.state.values.repayment = 'interest-only';
  api.render();
  assert.deepEqual(api.state.result.errors, []);
  assert.equal(api.state.result.rows.at(-1).proposedPrincipal, 1000);
  assert.equal(api.state.capacity.status, 'feasible');
});

test('a debt-free nonpayment month cannot be labeled the tightest repayment month', () => {
  const { api, node } = harness();
  Object.assign(api.state.values, { frequency: 'annual', term: '12', forecastMonths: '13', existingPayment: '0' });
  api.state.overrides = { '2026-10': { preDebtCash: '1' } };
  api.render();
  assert.equal(api.state.capacity.monthlyHeadroom[0].dscrApplicable, false);
  assert.equal(api.state.capacity.monthlyHeadroom[0].availableForNewDebtService, .8);
  // ICU versions may retain a zero decimal in compact currency ($80 vs $80.0).
  assert.match(node('capacitySummary').innerHTML, /Tightest incremental P&amp;I room<\/div><div class="uw-kpi-value ">\$80(?:\.0+)?<\/div><div class="uw-kpi-note">2027-10 · /);
});

test('entered loan amount is assessed against capacity without redefining cash need or the range', async () => {
  const { api, node } = await mountedHarness();
  Object.assign(api.state.values, { amount: '500', forecastMonths: '13' });
  api.render();
  const original = { gap: api.state.capacity.rawCashGap, minimum: api.state.capacity.minimumPositivePrincipal, maximum: api.state.capacity.maximumAdditionalPrincipal };
  assert.match(node('capacityExplanation').innerHTML, /Entered amount \$500\.00 is inside this conservative full-forecast interval/);
  node('workspace').change({ target: { id: 'amount', value: String(original.maximum + 100), dataset: {} } });
  assert.match(node('capacityExplanation').innerHTML, /Entered amount .* is outside this conservative full-forecast interval/);
  assert.equal(api.state.capacity.rawCashGap, original.gap);
  assert.equal(api.state.capacity.minimumPositivePrincipal, original.minimum);
  assert.equal(api.state.capacity.maximumAdditionalPrincipal, original.maximum);
});


const registeredFacility = (overrides = {}) => ({ ...facilityView.createFacility('facility-a', 'loc', 'USD'),
  name: 'Synthetic operating line', accountId: 'connection-a:42', limit: 100000, borrowingBase: 80000, reserves: 5000,
  lenderAvailable: 50000, availabilityAsOf: '2026-09-30', availabilityProvenance: 'Synthetic lender certificate',
  monthlyPayment: 10, scheduleComplete: true, scheduleProvenance: 'Synthetic complete payment schedule', ...overrides });
function seedFacilities(h, facilities = [registeredFacility()]) {
  h.api.state.sources.accountOptions = [
    { id: 'connection-a:42', accountId: '42', connectionId: 'connection-a', label: 'Synthetic operating line', balance: 40000, balanceAsOf: '2026-09-30', balanceCurrency: 'USD' },
    { id: 'connection-a:43', accountId: '43', connectionId: 'connection-a', label: 'Synthetic second line', balance: 10000, balanceAsOf: '2026-09-30', balanceCurrency: 'USD' },
  ];
  h.api.state.facilities = facilities;
  Object.assign(h.api.state.values, { facilitiesComplete: true, facilitiesProvenance: 'Synthetic full-company obligation review' });
}
function changeFacility(h, field, value, { id = 'facility-a', type = 'text', term = false, paymentMonth = '' } = {}) {
  h.node('workspace').change({ target: { id: '', type, value, checked: value, dataset: { facility: id, field, ...(term ? { term: 'true' } : {}), ...(paymentMonth ? { paymentMonth } : {}) } } });
}
function clickData(h, selector, dataset) {
  const target = { dataset, closest: query => query === selector ? target : null };
  return h.node('workspace').click({ target });
}

test('dynamic credit register retains complete source facts, evidence and bounded undrawn availability', () => {
  const h = harness(); seedFacilities(h); h.api.render();
  assert.equal(h.api.state.portfolio.facilities[0].balance, 40000);
  assert.equal(h.api.state.portfolio.facilities[0].accountId, 'connection-a:42');
  assert.equal(h.api.state.portfolio.totalAvailable, 35000);
  const html = h.node('currentCreditRegister').innerHTML + h.node('facilityEditor').innerHTML;
  for (const text of ['Synthetic operating line', 'connection-a:42', '2026-09-30', 'USD', '$40,000', '$100,000', '$35,000',
    'Borrowing base', 'Reserves / restrictions', 'Lender net available', 'value="80000"', 'value="5000"', 'value="50000"', 'Synthetic lender certificate']) assert.ok(html.includes(text), text);
  h.api.state.facilities[0].name = '<img src=x onerror=alert(1)>';
  h.api.state.facilities[0].availabilityProvenance = '<script>bad()</script>'; h.api.render();
  assert.ok(!h.node('currentCreditRegister').innerHTML.includes('<img'));
  assert.ok(h.node('facilityEditor').innerHTML.includes('&lt;script&gt;'));
});

test('dynamic credit unknown restrictions, net availability and currency mismatch stay distinct', () => {
  const h = harness(); seedFacilities(h); const row = h.api.state.facilities[0];
  Object.assign(row, { reserves: null, lenderAvailable: null }); h.api.render();
  assert.equal(h.api.state.portfolio.totalAvailable, null);
  Object.assign(row, { lenderAvailable: 50000, availabilityProvenance: '' }); h.api.render();
  assert.equal(h.api.state.portfolio.totalAvailable, null);
  row.availabilityProvenance = 'Synthetic lender net availability'; h.api.render();
  assert.equal(h.api.state.portfolio.totalAvailable, 50000);
  row.lenderAvailable = 90000; h.api.render();
  assert.equal(h.api.state.portfolio.totalAvailable, 60000);
  h.api.state.sources.accountOptions[0].balanceCurrency = 'CAD'; h.api.render();
  assert.equal(h.api.state.portfolio.totalAvailable, null);
  assert.equal(h.api.state.portfolio.facilities[0].comparable, false);
  assert.ok(h.node('facilityEditor').innerHTML.includes('currency must match'));
});

test('existing credit does not reduce gross funding need or add cash in manual or facility mode', () => {
  const h = harness(); Object.assign(h.api.state.values, { amount: '700', useOfProceeds: '1000', forecastMonths: '13', existingPayment: '10' });
  h.api.render(); const before = JSON.stringify(h.api.state.result.rows), gap = h.api.state.capacity.rawCashGap;
  seedFacilities(h); h.api.render();
  assert.equal(h.api.state.capacity.rawCashGap, gap);
  assert.equal(JSON.stringify(h.api.state.result.rows), before);
  h.api.state.values.existingDebtMode = 'facilities'; h.api.render();
  assert.equal(h.api.state.result.rows[0].existingDebtService, 10);
  assert.equal(h.api.state.result.rows[0].proposalInflow, 700);
  assert.equal(JSON.stringify(h.api.state.result.rows), before);
  assert.equal(h.api.state.capacity.rawCashGap, gap);
  assert.ok(h.node('currentCreditRegister').innerHTML.includes('not automatically drawn or netted'));
});

test('facility mode replaces the manual aggregate and mode changes invalidate portfolio review', async () => {
  const h = await mountedHarness(); seedFacilities(h, [registeredFacility(), registeredFacility({ id: 'facility-b', accountId: 'connection-a:43', monthlyPayment: 20 })]);
  h.api.state.values.existingPayment = '80'; h.api.render();
  assert.equal(h.api.state.result.rows[0].existingDebtService, 80);
  assert.equal(h.api.state.portfolio.reconciliation[0].facilityPayment, 30);
  h.node('workspace').change({ target: { id: 'existingDebtMode', value: 'facilities', dataset: {} } });
  assert.equal(h.api.state.values.facilitiesComplete, false);
  assert.equal(h.api.state.result.coverage.dscrAvailable, false);
  h.node('workspace').change({ target: { id: 'facilitiesComplete', type: 'checkbox', checked: true, dataset: {} } });
  assert.equal(h.api.state.result.rows[0].existingDebtService, 30);
  assert.equal(h.node('existingPayment').disabled, true);
  assert.ok(h.node('monthlyEditor').innerHTML.includes('data-key="payment"'));
  assert.ok(h.node('monthlyEditor').innerHTML.includes('disabled'));
});

test('account and balance-source switches clear only the affected facility assumptions', async () => {
  const h = await mountedHarness(); seedFacilities(h); h.api.render();
  const before = JSON.stringify(h.api.inputModel()); const values = { ...h.api.state.values };
  changeFacility(h, 'accountId', 'connection-a:43', { type: 'select-one' });
  const row = h.api.state.facilities[0];
  assert.equal(row.id, 'facility-a'); assert.equal(row.name, 'Synthetic operating line'); assert.equal(row.accountId, 'connection-a:43');
  for (const key of ['limit', 'borrowingBase', 'reserves', 'lenderAvailable', 'monthlyPayment']) assert.equal(row[key], null, key);
  for (const key of ['balanceProvenance', 'availabilityProvenance', 'scheduleProvenance']) assert.equal(row[key], '', key);
  assert.equal(row.scheduleComplete, false); assert.equal(h.api.state.values.facilitiesComplete, false);
  assert.equal(h.api.state.values.amount, values.amount); assert.equal(h.api.state.values.startingCash, values.startingCash);
  assert.equal(JSON.stringify(h.api.inputModel()), before, 'manual cash and proposal do not depend on cleared reference terms');
  Object.assign(row, { manualBalance: 100, availabilityProvenance: 'Old source', monthlyPayment: 12 });
  changeFacility(h, 'balanceSource', 'manual', { type: 'select-one' });
  assert.equal(row.manualBalance, null); assert.equal(row.availabilityProvenance, ''); assert.equal(row.monthlyPayment, null);
});

test('first account match preserves explicitly entered terms, while an unavailable saved match cannot transfer terms', async () => {
  const h = await mountedHarness(); seedFacilities(h, [registeredFacility({ accountId: '' })]);
  changeFacility(h, 'accountId', 'connection-a:42', { type: 'select-one' });
  assert.equal(h.api.state.facilities[0].limit, 100000);
  changeFacility(h, 'accountId', 'connection-a:42', { type: 'select-one' });
  assert.equal(h.api.state.facilities[0].limit, 100000);
  const input = h.scenario(); input.facilities = [registeredFacility({ accountId: 'old-connection:42' })];
  await h.api.importScenario(h.file(input));
  assert.ok(h.node('facilityEditor').innerHTML.includes('Saved account unavailable'));
  assert.equal(h.api.state.portfolio.facilities[0].balance, null);
  changeFacility(h, 'accountId', 'connection-a:43', { type: 'select-one' });
  assert.equal(h.api.state.facilities[0].limit, null);
  assert.equal(h.api.state.facilities[0].scheduleProvenance, '');
});

test('facility add, rename, edit and remove use stable IDs and invalidate the appropriate reviews', async () => {
  const h = await mountedHarness(); seedFacilities(h); h.api.render();
  changeFacility(h, 'name', 'Renamed line');
  assert.equal(h.api.state.facilities[0].id, 'facility-a');
  assert.equal(h.api.state.facilities[0].scheduleComplete, true); assert.equal(h.api.state.values.facilitiesComplete, true);
  changeFacility(h, 'monthlyPayment', '11', { type: 'number' });
  assert.equal(h.api.state.facilities[0].scheduleComplete, false); assert.equal(h.api.state.values.facilitiesComplete, false);
  h.api.state.values.facilitiesComplete = true;
  clickData(h, '[data-add-facility]', { addFacility: 'loan' });
  assert.equal(h.api.state.facilities.length, 2); assert.equal(h.api.state.values.facilitiesComplete, false);
  assert.notEqual(h.api.state.facilities[1].id, 'facility-a'); assert.equal(h.api.state.facilities[1].manualBalance, null);
  h.node('facilityEditor').contains = () => true; h.document.activeElement = { focused: true };
  clickData(h, '[data-remove-facility]', { removeFacility: 'facility-a' });
  assert.equal(h.api.state.facilities.length, 1);
  assert.ok(!h.node('facilityEditor').innerHTML.includes('data-facility="facility-a"'));
});

test('facility drafts reopen visibly unknown and leaving balloon clears hidden amortization', async () => {
  const h = await mountedHarness();
  const input = h.scenario(); input.facilities = [{ ...facilityView.createFacility('draft', '', ''), balanceSource: '', scheduleMode: '', terms: { annualRatePct: null, frequency: '', repayment: '', firstPaymentMonth: '', maturityMonth: '', amortizationMonths: null } }];
  await h.api.importScenario(h.file(input));
  for (const key of ['kind', 'balanceSource', 'scheduleMode']) {
    const options = h.node('facilityEditor').innerHTML.match(new RegExp(`data-field="${key}"[^>]*>(.*?)</select>`))?.[1];
    assert.ok(options?.includes('value="" selected'), `${key} must show explicit unknown`);
  }
  seedFacilities(h, [registeredFacility({ kind: 'loan', scheduleMode: 'terms', terms: { annualRatePct: 5, frequency: 'monthly', repayment: 'balloon', firstPaymentMonth: '2026-11', maturityMonth: '2027-10', amortizationMonths: 24 } })]);
  changeFacility(h, 'repayment', 'interest-only', { term: true, type: 'select-one' });
  assert.equal(h.api.state.facilities[0].terms.amortizationMonths, null);
  assert.ok(!h.api.state.portfolio.facilities[0].issues.some(x => x.includes('cannot also specify amortizationMonths')));
});

const reviewedTiming = () => ({ enabled: true, amount: 20, baselineReceipts: 50, fromMonth: '2026-10', toMonth: '2026-11', sourceReference: 'Synthetic retained customer receipt pool', reviewed: true });
function changeTiming(h, key, field, value, type = 'text') {
  h.node('workspace').change({ target: { id: '', type, value, checked: value, dataset: { timing: key, field } } });
}

test('negative manual payment edits withhold cash and DSCR without preserving focused stale outputs', () => {
  const h = harness(); const input = { value: '-1' }; h.document.activeElement = input;
  const cells = [{ textContent: '$5,000' }, { textContent: '2.0×' }];
  Object.assign(h.node('monthlyEditor'), { contains: element => element === input, innerHTML: 'focused input markup', querySelectorAll: () => cells });
  h.api.state.overrides = { '2026-10': { payment: '-1' } }; h.api.render();
  assert.equal(h.api.state.result.rows[0].closingCash, null);
  assert.equal(h.api.state.result.rows[0].dscr, null);
  assert.ok(cells.every(cell => cell.textContent === '—'));
  assert.equal(input.value, '-1'); assert.equal(h.node('monthlyEditor').innerHTML, 'focused input markup');
  assert.ok(h.node('methodology').innerHTML.includes('explicit nonnegative amount'));
});

test('enabled incomplete timing removes prior cash/capacity conclusions and reports its missing evidence', async () => {
  const h = await mountedHarness(); h.api.state.values.forecastMonths = '13'; h.api.render();
  assert.equal(h.api.state.capacity.status, 'feasible');
  changeTiming(h, 'collections', 'enabled', true, 'checkbox');
  assert.equal(h.api.state.cashTimingResult.ready, false);
  assert.equal(h.api.state.result.summary.endingCash, null);
  assert.equal(h.api.state.result.summary.worstMonthlyDscr, null);
  assert.equal(h.api.state.capacity.status, 'incomplete');
  assert.ok(h.node('cashTimingImpact').innerHTML.includes('delayed amount'));
  assert.ok(!h.node('proposalMemo').innerHTML.includes('Within modeled constraints'));
  assert.ok(h.node('proposalMemo').innerHTML.includes('Unassessed'));
});

test('reviewed timing applies once and forecast or timing edits invalidate its evidence', async () => {
  const h = await mountedHarness(); h.api.state.cashTiming.collections = reviewedTiming(); h.api.render();
  const first = JSON.stringify(h.api.state.result.rows);
  assert.equal(h.api.state.cashTimingResult.ready, true);
  assert.equal(h.api.state.cashTimingResult.impactRows[0].cashDelta, -20);
  h.api.render(); assert.equal(JSON.stringify(h.api.state.result.rows), first);
  changeTiming(h, 'collections', 'amount', '25', 'number');
  assert.equal(h.api.state.cashTiming.collections.reviewed, false);
  assert.equal(h.api.state.cashTimingResult.ready, false);
  h.api.state.cashTiming.collections = reviewedTiming(); h.api.state.cashTiming.distinctReceiptPoolsReviewed = true;
  h.node('workspace').change({ target: { id: 'normalizedCash', value: '110', dataset: {} } });
  assert.equal(h.api.state.cashTiming.collections.reviewed, false);
  assert.equal(h.api.state.cashTiming.distinctReceiptPoolsReviewed, false);
  assert.equal(h.api.state.values.cashForecastReviewed, false);
});

test('both receipt-delay pools require a separate nonoverlap review through the actual change handler', async () => {
  const h = await mountedHarness(); h.api.state.cashTiming.collections = reviewedTiming();
  h.api.state.cashTiming.inventory = { ...reviewedTiming(), sourceReference: 'Synthetic separate inventory receipts' }; h.api.render();
  assert.equal(h.api.state.cashTimingResult.ready, false);
  h.node('workspace').change({ target: { id: '', checked: true, dataset: {}, hasAttribute: key => key === 'data-timing-distinct' } });
  assert.equal(h.api.state.cashTimingResult.ready, true);
  assert.equal(h.api.state.cashTimingResult.totalDelayed, 40);
  changeTiming(h, 'inventory', 'toMonth', '2026-12');
  assert.equal(h.api.state.cashTiming.distinctReceiptPoolsReviewed, false);
  assert.equal(h.api.state.cashTiming.inventory.reviewed, false);
});

test('review baseline is created only by explicit capture and changes survive a valid v4 reopen', async () => {
  const h = await mountedHarness(); h.api.render();
  assert.equal(h.api.state.reviewBaseline, null);
  assert.ok(h.api.state.currentReview, h.node('reviewChanges').innerHTML);
  assert.ok(h.node('reviewChanges').innerHTML.includes('No prior review'));
  await h.node('captureReview').click();
  assert.ok(h.api.state.reviewBaseline);
  const captured = JSON.stringify(h.api.state.reviewBaseline);
  h.node('workspace').change({ target: { id: 'amount', value: '1200', dataset: {} } });
  assert.equal(JSON.stringify(h.api.state.reviewBaseline), captured);
  assert.ok(h.node('reviewChanges').innerHTML.includes('Loan amount'));
  const input = h.scenario(); input.reviewBaseline = JSON.parse(captured); input.facilities = [registeredFacility()]; input.cashTiming.collections = reviewedTiming();
  await h.api.importScenario(h.file(input));
  assert.equal(JSON.stringify(h.api.state.reviewBaseline), captured);
  assert.equal(h.api.state.facilities.length, 1);
  assert.equal(h.api.state.cashTiming.collections.reviewed, true);
});

test('keyboard tabs switch a single panel, selected state and focus with wraparound', async () => {
  const h = await mountedHarness(); let prevented = 0;
  for (const [key, step] of [['ArrowRight', 'funding'], ['End', 'review'], ['ArrowRight', 'business'], ['ArrowLeft', 'review'], ['Home', 'business']]) {
    h.node('flow').keydown({ key, preventDefault() { prevented++; } });
    assert.equal(h.api.state.step, step);
    assert.equal(h.document.activeElement, h.node('tab-' + step));
    for (const name of ['business', 'funding', 'test', 'review']) {
      assert.equal(h.node('panel-' + name).hidden, name !== step);
      assert.equal(h.node('tab-' + name).attributes['aria-selected'], String(name === step));
      assert.equal(h.node('tab-' + name).tabIndex, name === step ? 0 : -1);
    }
  }
  assert.equal(prevented, 5);
});

test('signed-out gates clear facility, timing, review and print material', async () => {
  const h = await mountedHarness(); h.api.setMode('advanced'); seedFacilities(h); h.api.state.cashTiming.collections = reviewedTiming(); h.api.render();
  await h.api.captureReview(); await h.api.printProposal();
  assert.ok(h.node('printPacket').innerHTML.includes('Supporting schedules'));
  h.auth.callback('SIGNED_OUT');
  assert.equal(h.api.state.facilities.length, 0);
  assert.equal(h.api.state.portfolio, null);
  assert.equal(h.api.state.reviewBaseline, null); assert.equal(h.api.state.currentReview, null);
  assert.equal(h.api.state.cashTiming.collections.enabled, false); assert.equal(h.api.state.cashTimingResult, null);
  for (const id of ['facilityEditor', 'currentCreditRegister', 'cashTimingImpact', 'proposalMemo', 'reviewChanges', 'printPacket']) assert.equal(h.node(id).innerHTML, '', id);
  h.window.printed = false; await h.api.printProposal(); assert.equal(h.window.printed, false);
});

test('memo distinguishes a pre-funding shortfall from unobserved maturity and never states approval', () => {
  const h = harness(); Object.assign(h.api.state.values, { startingCash: '50', cashFloor: '100', forecastMonths: '13' }); h.api.render();
  assert.ok(h.api.state.capacity.preFundingShortfall);
  assert.ok(h.node('proposalMemo').innerHTML.includes('Funding arrives after'));
  assert.ok(!h.node('proposalMemo').innerHTML.includes('outside the cash forecast'));
  assert.ok(h.node('proposalMemo').innerHTML.includes('no credit approval'));
});

test('memo status requires tested maturity and no unresolved pre-funding deficit', () => {
  const h = harness(); h.api.state.values.amount = '500'; h.api.render();
  assert.equal(h.api.state.capacity.scope, 'window-only');
  assert.ok(h.node('proposalMemo').innerHTML.includes('Window-only · maturity unassessed'));
  assert.ok(!h.node('proposalMemo').innerHTML.includes('uw-tag-ok'));
  h.api.state.values.forecastMonths = '13'; h.api.render();
  assert.equal(h.api.state.capacity.scope, 'full-term');
  assert.ok(h.node('proposalMemo').innerHTML.includes('Within modeled constraints'));
  h.api.state.values.startingCash = '50'; h.api.render();
  assert.ok(h.api.state.capacity.preFundingShortfall);
  assert.ok(!h.node('proposalMemo').innerHTML.includes('uw-tag-ok'));
});

test('a blank cash assumption is never printed as a zero-dollar repayment baseline', () => {
  const h = harness(); h.api.state.values.normalizedCash = ''; h.api.render();
  assert.equal(h.api.state.result.summary.endingCash, null);
  assert.ok(!h.node('proposalMemo').innerHTML.includes('$0 baseline monthly cash before debt'));
  assert.ok(h.node('proposalMemo').innerHTML.includes('Unassessed'));
});

test('printed proposal includes facility and receipt-timing evidence and static supporting schedules', async () => {
  const h = await mountedHarness(); h.api.setMode('advanced'); seedFacilities(h); h.api.state.cashTiming.collections = reviewedTiming();
  h.api.state.facilities[0].scheduleProvenance = 'Synthetic payment evidence <script>unsafe()</script>';
  await h.api.printProposal(); const print = h.node('printPacket').innerHTML;
  for (const text of ['Facility evidence and remaining terms', 'Existing P&I by facility', 'Receipt timing assumptions',
    'Synthetic lender certificate', 'Synthetic retained customer receipt pool', '2026-11', 'Receipt pool already in forecast', 'Monthly input overrides']) assert.ok(print.includes(text), text);
  assert.ok(print.includes('&lt;script&gt;')); assert.ok(!print.includes('<script>'));
  assert.equal(h.window.printed, true);
});

test('review snapshots retain each monetary currency and suppress numeric deltas after a currency change', () => {
  const h = harness(); seedFacilities(h); h.api.state.cashTiming.collections = reviewedTiming(); h.api.render();
  const prior = h.api.state.currentReview;
  assert.equal(prior.assumptions.find(f => f.id === 'amount').currency, 'USD');
  assert.equal(prior.assumptions.find(f => f.id === 'facility:facility-a:limit').currency, 'USD');
  h.api.state.values.currency = 'CAD'; h.api.state.values.amount = '1200'; h.api.render();
  const changed = compareReviewSnapshots(h.api.state.currentReview, prior).assumptionChanges.find(f => f.id === 'amount');
  assert.equal(changed.kind, 'context-changed'); assert.equal(changed.delta, null);
  assert.equal(h.api.state.currentReview.assumptions.find(f => f.id === 'facility:facility-a:limit').currency, 'USD', 'facility currency is never overwritten by scenario currency');
});

test('v4 download roundtrips all dynamic state without inventing a reviewed baseline', async () => {
  const h = await mountedHarness(); seedFacilities(h); h.api.state.cashTiming.collections = reviewedTiming(); h.api.render();
  assert.equal(h.api.state.reviewBaseline, null);
  await h.api.download();
  assert.equal(h.downloads.length, 1);
  const payload = JSON.parse(await h.downloads[0].text());
  assert.equal(payload.version, 4); assert.equal(payload.reviewBaseline, null);
  const imported = validateScenarioDocument(payload, h.api.allDefs, h.api.state.context.company.id);
  assert.equal(imported.facilities[0].accountId, 'connection-a:42');
  assert.equal(imported.cashTiming.collections.amount, 20);
  await h.api.importScenario(h.file(payload));
  assert.equal(h.api.state.facilities.length, 1); assert.equal(h.api.state.cashTiming.collections.reviewed, true);
  assert.equal(h.api.state.reviewBaseline, null);
  h.api.state.values.documentReferences = 'x'.repeat(2000001);
  await assert.rejects(h.api.download(), /2 MB import limit/);
  assert.equal(h.downloads.length, 1, 'oversized scenario is never downloaded as an unopenable file');
});

test('changing the forecast horizon marks modeled outcomes as different-period facts rather than numeric deltas', () => {
  const h = harness(); h.api.render(); const prior = h.api.state.currentReview;
  assert.equal(prior.outcomes.find(f => f.id === 'existingDebtService').periodStart, '2026-10');
  h.api.state.values.forecastMonths = '13'; h.api.render();
  const current = h.api.state.currentReview;
  assert.notEqual(current.outcomes[0].periodEnd, prior.outcomes[0].periodEnd);
  const changes = compareReviewSnapshots(current, prior).outcomeChanges;
  assert.ok(changes.length > 0);
  for (const change of changes) { assert.equal(change.kind, 'context-changed'); assert.equal(change.delta, null); }
});

const printMoney = value => Number.isFinite(value) ? `$${value.toLocaleString('en-US')}` : '—';
function printFact(html, label) {
  const escaped = label.replaceAll('&', '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<dt>${escaped}</dt><dd>(.*?)</dd>`))?.[1];
}

test('polished print evidence keeps relevant lender facts and resolved balances with safe human labels', () => {
  const h = harness(); seedFacilities(h); h.api.state.cashTiming.collections = reviewedTiming();
  h.api.state.facilities[0].name = '<img src=x onerror=alert(1)>';
  h.api.state.facilities[0].availabilityProvenance = 'Certificate <script>unsafe()</script>';
  h.api.render();
  const printed = reviewView.printEvidenceHtml(h.api.state, printMoney);
  assert.equal(printFact(printed.facilities, 'Outstanding balance'), '$40,000');
  assert.equal(printFact(printed.facilities, 'Balance as of'), '2026-09-30');
  assert.equal(printFact(printed.facilities, 'Matched account ID'), 'connection-a:42');
  assert.equal(printFact(printed.facilities, 'Usable undrawn · calculated'), '$35,000');
  assert.ok(printed.facilities.includes('Synthetic complete payment schedule'));
  assert.ok(!printed.facilities.includes('<img')); assert.ok(printed.facilities.includes('&lt;script&gt;'));
  assert.ok(!printed.facilities.includes('availabilityProvenance'));
  assert.ok(!printed.facilities.includes('Nominal annual rate'));
  assert.ok(!printed.facilities.includes('Remaining amortization months'));
  assert.ok(printed.timing.includes('Receipt pool already in forecast'));
  assert.ok(printed.timing.includes('Synthetic retained customer receipt pool'));
  assert.ok(!printed.timing.includes('Delayed inventory cash recovery'));
  h.api.state.cashTiming.collections.enabled = false;
  assert.equal(reviewView.printEvidenceHtml(h.api.state, printMoney).timing, '<p>No receipt delays selected.</p>');
});

test('polished loan print excludes revolving fields and shows only the selected remaining-term assumptions', () => {
  const h = harness(); seedFacilities(h, [registeredFacility({ kind: 'loan', scheduleMode: 'terms', terms: {
    annualRatePct: 5, frequency: 'monthly', repayment: 'amortizing', firstPaymentMonth: '2026-11', maturityMonth: '2027-10', amortizationMonths: null } })]);
  h.api.render(); const html = reviewView.printEvidenceHtml(h.api.state, printMoney).facilities;
  assert.equal(printFact(html, 'Nominal annual rate'), '5%');
  assert.equal(printFact(html, 'First payment month'), '2026-11');
  assert.equal(printFact(html, 'Final payment month'), '2027-10');
  for (const label of ['Committed limit · entered', 'Borrowing base · entered', 'Lender net availability · entered', 'Baseline monthly P&I', 'Remaining amortization months']) assert.equal(printFact(html, label), undefined, label);
});

test('printed facility inputs retain their own currency and unknown currency is never scenario-denominated', () => {
  const h = harness(); seedFacilities(h, [registeredFacility({ currency: 'CAD' })]);
  h.api.state.sources.accountOptions[0].balanceCurrency = 'CAD'; h.api.render();
  let html = reviewView.printEvidenceHtml(h.api.state, printMoney).facilities;
  assert.equal(printFact(html, 'Outstanding balance'), 'Unknown or currency mismatch');
  for (const label of ['Committed limit · entered', 'Borrowing base · entered', 'Reserves / restrictions · entered', 'Lender net availability · entered', 'Baseline monthly P&I']) {
    assert.match(printFact(html, label), /CAD|CA\$/, label);
  }
  h.api.state.facilities[0].currency = ''; h.api.render();
  html = reviewView.printEvidenceHtml(h.api.state, printMoney).facilities;
  const unknown = printFact(html, 'Committed limit · entered');
  assert.ok(!unknown.includes('$'), 'unknown currency does not inherit scenario dollars');
  assert.match(unknown, /currency.*unknown|unknown.*currency|not documented/i);
});

test('printed draft facility choices stay unknown rather than becoming documented loan facts', () => {
  const h = harness(); seedFacilities(h, [{ ...facilityView.createFacility('draft', '', ''), balanceSource: '', scheduleMode: '' }]);
  h.api.render(); const html = reviewView.printEvidenceHtml(h.api.state, printMoney).facilities;
  for (const label of ['Facility type', 'Balance evidence', 'Payment method']) assert.equal(printFact(html, label), 'Not documented', label);
  assert.ok(!html.includes('Documented monthly P&amp;I'));
  assert.ok(!html.includes('Documented manual lender balance'));
  assert.ok(!html.includes('Term loan'));
});

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const contextA = () => ({ key: `user:${COMPANY_A}`, company: { id: COMPANY_A, title: 'Synthetic company A' } });
const offline = () => Object.assign(new Error('Your current company could not be verified. Check your connection and retry.'), { transient: true });

test('a transient verification failure holds the workspace and keeps the unsaved scenario', async () => {
  // resumeView, the held print, the held download and the first Retry each
  // re-verify; all four must fail before the fifth read succeeds.
  let failures = 4;
  const { api, node, document, window, downloads } = harness({ readContext: async () => { if (failures-- > 0) throw offline(); return contextA(); } });
  document.visibilityState = 'visible';
  api.state.commitments = [reviewedPayment()]; api.state.values.amount = '4321'; api.state.facilities = [{ id: 'kept' }];
  await api.resumeView();
  assert.equal(api.state.held, true); assert.equal(api.state.ready, true);
  assert.equal(node('workspace').hidden, true); assert.equal(node('gate').hidden, false);
  assert.match(node('gate').children[0].textContent, /kept in this tab/);
  assert.equal(node('gate').children[1].textContent, 'Retry verification');
  assert.equal(api.state.values.amount, '4321'); assert.equal(api.state.commitments.length, 1); assert.equal(api.state.facilities.length, 1);
  await api.printProposal(); assert.notEqual(window.printed, true, 'nothing prints while held');
  await api.download(); assert.equal(downloads.length, 0, 'nothing downloads while held');
  // Retry: still failing keeps the hold; a successful read releases it with state intact.
  await node('gate').children[1].click();
  assert.equal(api.state.held, true);
  await node('gate').children[1].click();
  assert.equal(api.state.held, false); assert.equal(node('gate').hidden, true); assert.equal(node('workspace').hidden, false);
  assert.equal(api.state.values.amount, '4321');
});

test('a definitive verification failure still clears the scenario', async () => {
  const { api, node } = harness({ readContext: async () => { throw new Error('Finance or executive access is required for this company.'); } });
  api.state.values.amount = '4321';
  await api.resumeView();
  assert.equal(api.state.ready, false); assert.equal(api.state.values.amount, '');
  assert.equal(node('gate').children[1].textContent, 'Refresh page');
});

test('a transient failure during Refresh sources keeps the sources already loaded', async () => {
  const { api, node } = harness({ readContext: async () => { throw offline(); } });
  const kept = api.state.sources;
  api.state.values.amount = '4321';
  await api.load();
  assert.equal(api.state.ready, true); assert.equal(api.state.sources, kept); assert.equal(api.state.values.amount, '4321');
  assert.equal(node('workspace').hidden, false);
  assert.match(node('status').textContent, /previously loaded sources are still shown/);
  assert.equal(node('refresh').disabled, false);
});

test('a transient failure on first load offers a retry that loads rather than a page refresh', async () => {
  let attempts = 0;
  const { api, node } = harness({ readContext: async () => { if (++attempts === 1) throw offline(); return contextA(); }, loadSourceSnapshot: async () => ({ currency: 'USD', sources: {} }) });
  api.state.ready = false; api.state.sources = null; api.state.context = null;
  await api.load();
  assert.equal(api.state.held, true); assert.equal(node('gate').children[1].textContent, 'Retry verification');
  await node('gate').children[1].click();
  assert.equal(api.state.ready, true); assert.equal(api.state.held, false); assert.equal(node('workspace').hidden, false);
});

test('the print packet is rebuilt from current inputs for every print, button or browser menu', async () => {
  const h = await mountedHarness();
  h.api.state.values.amount = '1000'; h.api.buildPrintPacket();
  const first = h.node('printPacket').innerHTML; assert.ok(first.includes('$1,000'), 'packet names the entered amount');
  h.api.state.values.amount = '2000'; h.api.buildPrintPacket();
  const second = h.node('printPacket').innerHTML;
  assert.notEqual(second, first); assert.ok(second.includes('$2,000')); assert.ok(!first.includes('$2,000'));
  await h.api.printProposal(); assert.equal(h.window.printed, true);
  assert.ok(h.node('printPacket').innerHTML.includes('$2,000'));
});

test('downloads are compact so any file that imports can be downloaded again', async () => {
  const h = await mountedHarness(); h.api.render();
  await h.api.download();
  const text = await h.downloads[0].text();
  assert.ok(!text.includes('\n'), 'no pretty-printing');
  assert.equal(text, JSON.stringify(JSON.parse(text)));
});

test('the pressed stress preset is derived from the values in force', async () => {
  const { api, node, scenario, file } = harness();
  const input = scenario(); Object.assign(input.values, { growthPct: '20', revenueDecline: '0', marginCompression: '0' });
  await api.importScenario(file(input));
  assert.equal(api.state.preset, 'growth'); assert.match(node('presetNote').textContent, /20%/);
  const custom = scenario(); Object.assign(custom.values, { growthPct: '7', revenueDecline: '0', marginCompression: '0' });
  await api.importScenario(file(custom));
  assert.equal(api.state.preset, null); assert.match(node('presetNote').textContent, /Custom/);
  api.choosePreset('downside');
  assert.equal(api.state.preset, 'downside'); assert.equal(api.state.values.revenueDecline, '10');
  assert.equal(api.presetFromValues({ growthPct: '0', revenueDecline: '10', marginCompression: '3' }), 'downside');
  assert.equal(api.presetFromValues({ growthPct: '', revenueDecline: '10', marginCompression: '3' }), null, 'an unknown value never matches a preset');
});

test('a forced facility editor rebuild returns focus to the control being edited', () => {
  const { api, node, document } = harness(); api.render();
  const editor = node('facilityEditor');
  const editing = { dataset: { facility: 'f-1', field: 'rate', term: 'true' }, focus() { this.focused = true; } };
  const rebuilt = { focus(options) { this.focused = options; } };
  let asked = null;
  document.activeElement = editing; editor.contains = el => el === editing; editor.querySelectorAll = () => [];
  editor.querySelector = selector => { asked = selector; return rebuilt; };
  api.renderFacility(true);
  assert.equal(asked, '[data-facility="f-1"][data-field="rate"][data-term="true"]');
  assert.equal(rebuilt.focused?.preventScroll, true);
  const monthCell = { dataset: { facility: 'f-1', paymentMonth: '2026-11' } };
  document.activeElement = monthCell; editor.contains = el => el === monthCell;
  api.renderFacility(true);
  assert.equal(asked, '[data-facility="f-1"][data-payment-month="2026-11"]');
});

const quickAccounts = () => [
  { id: 'connection-a:42', label: 'Bank term loan', accountType: 'Long Term Liability', balance: 400000, balanceAsOf: '2026-08-31', balanceCurrency: 'USD' },
  { id: 'connection-a:77', label: 'Sales tax payable', accountType: 'Other Current Liability', balance: 9000, balanceAsOf: '2026-08-31', balanceCurrency: 'USD' },
];
const quickSnapshot = () => ({ currency: 'USD', accountOptions: quickAccounts(), sources: {
  balanceSheet: { currency: 'USD', periodEnd: '2026-08-31', metrics: [], monthly: [{ month: '2026-08', periodEnd: '2026-08-31', completeMonth: true, bookCash: 125000, assets: 2000000 }] },
  profitAndLoss: { currency: 'USD', metrics: [], monthly: [] },
  cashflow: { currency: 'USD', metrics: [], monthly: ['2026-05', '2026-06', '2026-07', '2026-08'].map(m => ({ periodStart: `${m}-01`, periodEnd: `${m}-28`, completeMonth: true, operating: 60000 })) },
} });

test('the quick look lands first, mirrors its three inputs into the advanced proposal and seeds opening cash once', async () => {
  const { api, node } = harness({ loadSourceSnapshot: async () => quickSnapshot() });
  await api.boot(); // binds the change/click listeners and runs the first load
  assert.equal(api.state.mode, 'quick'); assert.equal(node('step-quick').hidden, false); assert.equal(node('flow').hidden, true);
  assert.equal(api.state.quick.debts.map(d => [d.id, d.include]).length, 2);
  assert.equal(api.state.values.startingCash, '125000'); assert.match(api.state.values.cashEvidence, /balance sheet.*2026-08-31.*auto-filled/);
  api.state.values.startingCash = '99'; await api.load(); assert.equal(api.state.values.startingCash, '99', 'a typed opening cash is never overwritten');
  node('workspace').change({ target: { id: 'q-amount', dataset: { quick: 'amount' }, value: '250000' } });
  node('workspace').change({ target: { id: 'q-rate', dataset: { quick: 'rate' }, value: '8' } });
  node('workspace').change({ target: { id: 'q-term', dataset: { quick: 'term' }, value: '24' } });
  assert.equal(api.state.values.amount, '250000'); assert.equal(node('amount').value, '250000'); assert.equal(api.state.values.term, '24');
  assert.ok(api.state.quickResult.payment > 0); assert.ok(node('quickResult').innerHTML.includes('Monthly payment'));
  assert.equal(api.state.quickResult.verdict.status, 'tight', 'the term loan is ticked with no payment entered');
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:42', field: 'monthlyPayment' }, value: '100' } });
  assert.equal(api.state.quick.debts[0].monthlyPayment, 100);
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:42', field: 'include' }, checked: false } });
  assert.equal(api.state.quick.debts[0].include, false); assert.equal(api.state.quickResult.includedCount, 0);
  assert.equal(api.state.quickResult.verdict.status, 'comfortable');
  api.setMode('advanced'); assert.equal(node('step-quick').hidden, true); assert.equal(node('flow').hidden, false); assert.equal(node('panel-business').hidden, false);
  api.setMode('quick'); assert.equal(node('panel-business').hidden, true);
});

test('quick mode prints a static one-page packet and the ticks survive a download and reopen', async () => {
  const h = harness({ loadSourceSnapshot: async () => quickSnapshot() });
  await h.api.boot();
  h.api.state.values.amount = '250000'; h.api.state.values.rate = '8'; h.api.state.values.term = '24'; h.api.render();
  h.api.buildPrintPacket();
  const packet = h.node('printPacket').innerHTML;
  assert.ok(packet.includes('DRAFT FINANCING PROPOSAL')); assert.ok(packet.includes('Synthetic company A')); assert.ok(packet.includes('Sources and dates')); assert.ok(!packet.includes('<input'));
  h.node('quickProposalDetails').open = true; h.node('quickProposalDetails').toggle();
  assert.ok(h.node('quickProposalPreview').innerHTML.includes('Business performance'), 'opening the preview renders the same proposal on screen');
  h.node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:42', field: 'monthlyPayment' }, value: '4321' } });
  h.node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:77', field: 'include' }, checked: true } });
  await h.api.download();
  const payload = JSON.parse(await h.downloads[0].text());
  assert.deepEqual(payload.quick, { debts: [{ id: 'connection-a:42', include: true, monthlyPayment: 4321 }, { id: 'connection-a:77', include: true, monthlyPayment: null }] });
  assert.deepEqual(payload.facilities.map(f => [f.id, f.monthlyPayment]), [['quick:connection-a:42', 4321], ['quick:connection-a:77', null]], 'the register travels with the file');
  h.api.state.quick.debts[0].monthlyPayment = null; h.api.state.quick.debts[1].include = false;
  await h.api.importScenario(h.file(payload));
  assert.equal(h.api.state.quick.debts[0].monthlyPayment, 4321); assert.equal(h.api.state.quick.debts[1].include, true);
  assert.equal(h.api.state.quick.debts[0].balance, 400000, 'balances still come from the live balance sheet, not the file');
  h.api.clearSensitive('Signed out. Sign in to SILO and refresh this page.');
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.state.quick)), { debts: [] }); assert.equal(h.node('quickVerdict').innerHTML, '');
});

const plain = value => JSON.parse(JSON.stringify(value));
test('ticked quick debts are the advanced facility register, in both directions', async () => {
  const { api, node } = harness({ loadSourceSnapshot: async () => quickSnapshot() });
  api.state.values.existingPayment = '';
  await api.boot();
  // Load: the long-term liability starts ticked and is already a facility; the OCL is not.
  assert.deepEqual(plain(api.state.facilities.map(f => [f.id, f.accountId, f.kind, f.name, f.scheduleMode, f.balanceSource])), [['quick:connection-a:42', 'connection-a:42', 'loan', 'Bank term loan', 'payments', 'account']]);
  assert.equal(api.state.facilities[0].monthlyPayment, null);
  assert.equal(api.state.values.existingDebtMode, 'facilities', 'capacity reads the register once facilities exist and the manual aggregate is blank');
  // Payment typed in Quick look is the facility's monthly payment.
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:42', field: 'monthlyPayment' }, value: '2500' } });
  assert.equal(api.state.facilities[0].monthlyPayment, 2500); assert.match(api.state.facilities[0].scheduleProvenance, /Quick look/);
  // Tick the OCL: a second facility, kind loan.
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:77', field: 'include' }, checked: true } });
  assert.deepEqual(plain(api.state.facilities.map(f => f.id)), ['quick:connection-a:42', 'quick:connection-a:77']);
  // Payment edited in Advanced flows back to Quick look.
  node('workspace').change({ target: { dataset: { facility: 'quick:connection-a:42', field: 'monthlyPayment' }, type: 'number', value: '3100' } });
  assert.equal(api.state.quick.debts[0].monthlyPayment, 3100);
  // Untick removes the facility Quick look made.
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:77', field: 'include' }, checked: false } });
  assert.deepEqual(plain(api.state.facilities.map(f => f.id)), ['quick:connection-a:42']);
  // A hand-built facility for the same account is kept and the row stays ticked.
  api.state.facilities.push({ ...api.state.facilities[0], id: 'hand-made', accountId: 'connection-a:77', name: 'My note', monthlyPayment: 900 });
  api.state.quick.debts[1].include = true; api.render();
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:77', field: 'include' }, checked: false } });
  assert.equal(api.state.facilities.some(f => f.id === 'hand-made'), true); assert.equal(api.state.quick.debts[1].include, true);
  assert.match(node('status').textContent, /set up in the Advanced workflow/);
  // Removing a facility in Advanced unticks the row.
  node('workspace').click({ target: { closest: selector => selector === '[data-remove-facility]' ? { dataset: { removeFacility: 'quick:connection-a:42' } } : null } });
  assert.equal(api.state.quick.debts[0].include, false); assert.deepEqual(plain(api.state.facilities.map(f => f.id)), ['hand-made']);
  // The mode choice is made once: switching back to manual survives later ticks.
  api.state.values.existingDebtMode = 'manual';
  node('workspace').change({ target: { dataset: { quickDebt: 'connection-a:42', field: 'include' }, checked: true } });
  assert.equal(api.state.values.existingDebtMode, 'manual'); assert.equal(api.state.facilities.length, 2);
});

test('a reopened file keeps its facilities as the truth for the quick ticks', async () => {
  const h = harness({ loadSourceSnapshot: async () => quickSnapshot() });
  h.api.state.values.existingPayment = '';
  await h.api.boot();
  h.api.state.facilities[0].monthlyPayment = 4321; h.api.render();
  await h.api.download();
  const payload = JSON.parse(await h.downloads[0].text());
  assert.equal(payload.facilities[0].id, 'quick:connection-a:42');
  payload.quick.debts[0].include = false; payload.quick.debts[0].monthlyPayment = null; // stale tick in the file
  await h.api.importScenario(h.file(payload));
  assert.equal(h.api.state.quick.debts[0].include, true, 'the facility in the file wins over a stale tick');
  assert.equal(h.api.state.quick.debts[0].monthlyPayment, 4321);
  assert.deepEqual(plain(h.api.state.facilities.map(f => f.id)), ['quick:connection-a:42']);
});
