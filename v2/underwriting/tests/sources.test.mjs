import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseReportNumber, parseQboReport, buildAccountOptions, coverageQueries, businessQueries, parseRevenuePlan, parsePurchaseOrderExposure, loadSourceSnapshot } from '../source-data.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const col = (label, start, end, key = label) => ({ ColType: 'Money', ColTitle: label, MetaData: [
  { Name: 'ColKey', Value: key }, ...(start ? [{ Name: 'StartDate', Value: start }] : []), ...(end ? [{ Name: 'EndDate', Value: end }] : []),
] });
const summary = (group, values) => ({ group, Summary: { ColData: [{ value: group }, ...values.map((value) => ({ value }))] } });
const account = (id, values, label = 'Synthetic account') => ({ type: 'Data', ColData: [{ id, value: label }, ...values.map((value) => ({ value }))] });
function report(name, columns, rows, extra = {}) {
  return { id: 'synthetic-report', connection_id: CONNECTION, report_name: name, status: 'ok', fetched_at: '2026-03-04T00:00:00Z',
    params: {}, start_date: '2026-01-01', end_date: '2026-02-28', raw_response: {
      Header: { ReportName: name, ReportBasis: 'Accrual', Currency: 'USD', StartPeriod: '2026-01-01', EndPeriod: '2026-02-28' },
      Columns: { Column: [{ ColType: 'Account' }, ...columns] }, Rows: { Row: rows },
    }, ...extra };
}
const months = [col('Jan', '2026-01-01', '2026-01-31'), col('Feb', '2026-02-01', '2026-02-28')];

test('amount parser preserves unknowns and accepts provider decimal forms', () => {
  for (const value of [null, undefined, '', ' ', 'unknown', '1x', '1e3', true, Infinity, '1,2', '--1', '(-4)', '$12']) assert.equal(parseReportNumber(value), null, String(value));
  for (const [value, expected] of [['0', 0], ['.00', 0], ['-.67', -.67], ['1,234.56', 1234.56], ['(1,234.56)', -1234.56], [-5, -5]]) assert.equal(parseReportNumber(value), expected);
});
test('balance sheet chooses one ending stock column, never sum of months', () => {
  const result = parseQboReport(report('BalanceSheet', months, [summary('TotalAssets', ['100', '250']), account('7', ['20', '30'])]), 'BalanceSheet');
  assert.equal(result.metrics[0].value, 250);
  assert.equal(result.accountBalances[0].balance, 30);
  assert.equal(result.accountBalances[0].asOf, '2026-02-28');
  assert.equal(result.metrics[1].value, null);
});
test('balance sheet refuses duplicate ending columns and unmapped blanks', () => {
  let result = parseQboReport(report('BalanceSheet', [months[1], months[1]], [account('7', ['20', '30'])]), 'BalanceSheet');
  assert.equal(result.status, 'partial'); assert.equal(result.accountBalances.length, 0);
  result = parseQboReport(report('BalanceSheet', months, [account('7', ['20', ''])]), 'BalanceSheet');
  assert.equal(result.accountBalances[0].balance, null);
});
test('account matching uses composite identity and does not classify names', () => {
  const bs = parseQboReport(report('BalanceSheet', months, [account('7', ['20', '30'], 'Anything')]), 'BalanceSheet');
  const chart = [
    { connection_id: CONNECTION, qbo_account_id: '7', name: 'Not a loan', account_type: 'Other Current Liability' },
    { connection_id: 'another-connection', qbo_account_id: '7', name: 'Loan' },
    { connection_id: CONNECTION, qbo_account_id: '8', name: 'Anything' },
  ];
  const options = buildAccountOptions(chart, bs);
  assert.equal(options[0].balance, 30); assert.equal(options[1].balance, null); assert.equal(options[2].balance, null);
  assert.equal(options[0].id, `${CONNECTION}:7`);
  assert.equal(options[0].facilityType, undefined); assert.equal(options[0].requiredPayment, undefined);
});
test('duplicate account rows are ambiguous rather than double counted', () => {
  const bs = parseQboReport(report('BalanceSheet', months, [account('7', ['20', '30']), account('7', ['20', '30'])]), 'BalanceSheet');
  const [option] = buildAccountOptions([{ connection_id: CONNECTION, qbo_account_id: '7' }], bs);
  assert.equal(option.balance, null); assert.equal(option.matchStatus, 'ambiguous');
});
test('P&L Total is read once, separately from constituent months', () => {
  const result = parseQboReport(report('ProfitAndLoss', [...months, col('Total', null, null, 'total')], [summary('NetIncome', ['10', '20', '30'])]), 'ProfitAndLoss');
  assert.equal(result.metrics.find((m) => m.label === 'Net income').value, 30);
  assert.equal(result.metrics[0].periodStart, '2026-01-01');
});
test('P&L without Total uses one latest period, does not assume additive history', () => {
  const result = parseQboReport(report('ProfitAndLoss', months, [summary('NetIncome', ['10', '20'])]), 'ProfitAndLoss');
  const metric = result.metrics.find((m) => m.label === 'Net income');
  assert.equal(metric.value, 20); assert.equal(metric.periodStart, '2026-02-01');
});
test('monthly cash flow excludes cumulative Total and keeps true zeros', () => {
  const rows = ['OperatingActivities', 'InvestingActivities', 'FinancingActivities', 'CashIncrease'].map((g) => summary(g, ['0', '20', '20']));
  const result = parseQboReport(report('CashFlow', [...months, col('Total', null, null, 'total')], rows), 'CashFlow');
  assert.equal(result.monthly.length, 2); assert.equal(result.monthly[0].operating, 0);
  assert.equal(result.monthly[1].operating, 20); assert.equal(result.monthly[1].completeMonth, true);
  assert.match(result.warnings.join(' '), /unnormalized/);
});
test('cumulative cash flow is never invented into monthly data', () => {
  const result = parseQboReport(report('CashFlow', [col('Total', null, null, 'total')], [summary('OperatingActivities', ['120'])]), 'CashFlow');
  assert.equal(result.monthly.length, 0); assert.equal(result.status, 'partial');
});
test('partial months, absent totals, gaps and overlapping monthly columns are explicit', () => {
  const partial = parseQboReport(report('CashFlow', [months[0], col('Mar partial', '2026-03-01', '2026-03-12')], [summary('OperatingActivities', ['', '20'])]), 'CashFlow');
  assert.equal(partial.status, 'partial'); assert.equal(partial.monthly[0].operating, null);
  assert.equal(partial.monthly[1].completeMonth, false); assert.match(partial.warnings.join(' '), /gap/);
  const overlap = parseQboReport(report('CashFlow', [months[0], months[0]], [summary('OperatingActivities', ['10', '20'])]), 'CashFlow');
  assert.equal(overlap.monthly.length, 0); assert.match(overlap.warnings.join(' '), /Overlapping/);
});
test('filtered report cannot populate account balance assumption', () => {
  const result = parseQboReport(report('BalanceSheet', months, [account('7', ['20', '30'])], { params: { department: 'synthetic-department' } }), 'BalanceSheet');
  assert.equal(result.status, 'partial'); assert.equal(result.accountBalances[0].balance, null);
});
test('failed and malformed reports are errors, absent reports are missing', () => {
  assert.equal(parseQboReport(null, 'BalanceSheet').status, 'missing');
  assert.equal(parseQboReport({ status: 'error', error_message: 'Synthetic provider failure' }, 'BalanceSheet').error.code, 'REPORT_RUN_FAILED');
  assert.equal(parseQboReport({ status: 'ok', raw_response: {} }, 'BalanceSheet').error.code, 'REPORT_SHAPE');
});
test('no-report-data preserves missing values and metadata instead of zero', () => {
  const run = report('BalanceSheet', months, []);
  run.raw_response.Header.Option = [{ Name: 'NoReportData', Value: 'true' }];
  const result = parseQboReport(run, 'BalanceSheet');
  assert.equal(result.status, 'missing'); assert.deepEqual(result.metrics, []); assert.equal(result.periodEnd, '2026-02-28');
});
test('fixed aggregate SQL rejects non-UUID inputs and explicitly filters every tenant table', () => {
  assert.throws(() => coverageQueries("x'; select *"), /valid active company/);
  const queries = coverageQueries(COMPANY);
  for (const query of Object.values(queries)) {
    assert.match(query, new RegExp(COMPANY)); assert.doesNotMatch(query, /\b(?:insert|update|delete|refresh|truncate)\b/i);
  }
  assert.match(queries.inventory, /inventory_on_hand_current_v where company_entity_id/);
  assert.match(queries.purchaseOrders, /l\.company_entity_id/);
  assert.match(queries.purchaseOrders, /unit_cost is null/); assert.match(queries.purchaseOrders, /unit_cost = 0/);
  assert.match(queries.bank, /t\.company_entity_id/); assert.match(queries.bank, /c\.company_entity_id/); assert.match(queries.bank, /a\.company_entity_id/);
});

// Minimal Supabase fluent read-client. Any write or non-allowlisted RPC is absent.
function mockDb(handler) {
  const calls = [];
  function builder(table, params) {
    const call = { table, params, operations: [] };
    const query = { then(resolve, reject) { calls.push(call); return Promise.resolve().then(() => handler(call)).then(resolve, reject); } };
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'range', 'abortSignal']) query[method] = (...args) => { call.operations.push({ method, args }); return query; };
    return query;
  }
  return { calls, from: (table) => builder(table), rpc: (name, params) => { assert.equal(name, 'chat_run_readonly_query'); return builder(name, params); } };
}
const filter = (call, key) => call.operations.find((op) => op.method === 'eq' && op.args[0] === key)?.args[1];
const emptyAggregate = (query) => query.includes('inventory_on_hand_current_v') ? [{ row_count: 0, location_count: 0, reported_units: null, missing_quantity_rows: 0, missing_value_rows: 0, zero_value_rows: 0 }] : [];
function defaultHandler(call) {
  if (call.table === 'chat_run_readonly_query') {
    const q = call.params.query;
    if (q.includes('as placed_count')) return { data: [{ placed_count: 0, placed: null, arrival_months: null }], error: null };
    if (q.includes('limit 101') || q.includes('with clock')) return { data: [], error: null };
    return { data: emptyAggregate(q), error: null };
  }
  if (call.table === 'quickbooks_accounts') return { data: [], count: 0, error: null };
  return { data: [], error: null };
}
test('integrated loader: all direct reads use explicit company and RPCs are fixed aggregates', async () => {
  const db = mockDb(defaultHandler);
  const snapshot = await loadSourceSnapshot(db, COMPANY);
  assert.equal(snapshot.companyId, COMPANY); assert.equal(snapshot.currency, null);
  assert.equal(snapshot.sources.balanceSheet.status, 'missing');
  assert.equal(snapshot.sources.inventory.metrics.find((m) => m.label === 'Reported on-hand units').value, null);
  for (const call of db.calls.filter((c) => c.table !== 'chat_run_readonly_query')) assert.equal(filter(call, 'company_entity_id'), COMPANY);
});
test('integrated loader anchors all financial statements to one connection', async () => {
  const db = mockDb((call) => {
    if (call.table === 'quickbooks_report_runs') {
      const name = filter(call, 'report_name');
      if (!name) return { data: [{ connection_id: CONNECTION }], error: null };
      assert.equal(filter(call, 'connection_id'), CONNECTION);
      return { data: [report(name, months, [summary('TotalAssets', ['100', '250'])])], error: null };
    }
    return defaultHandler(call);
  });
  const result = await loadSourceSnapshot(db, COMPANY);
  assert.equal(result.currency, 'USD'); assert.equal(result.sources.balanceSheet.metrics[0].value, 250);
});
test('integrated loader retains independent source errors instead of empty coverage', async () => {
  const db = mockDb((call) => {
    if (call.table === 'chat_run_readonly_query' && call.params.query.includes('inventory_on_hand_current_v')) return { data: null, error: { code: '42501', message: 'Synthetic permission denial' } };
    return defaultHandler(call);
  });
  const result = await loadSourceSnapshot(db, COMPANY);
  assert.equal(result.sources.inventory.status, 'error'); assert.equal(result.sources.inventory.error.code, '42501');
  assert.equal(result.sources.bank.status, 'missing');
});
test('anchor failure is reported on all financial sources without fallback blending', async () => {
  const db = mockDb((call) => call.table === 'quickbooks_report_runs' ? { data: null, error: { message: 'Synthetic network failure' } } : defaultHandler(call));
  const result = await loadSourceSnapshot(db, COMPANY);
  for (const key of ['balanceSheet', 'profitAndLoss', 'cashflow']) assert.equal(result.sources[key].status, 'error');
});
test('bounded paginated chart reports truncation, and includes inactive accounts', async () => {
  const db = mockDb((call) => {
    if (call.table !== 'quickbooks_accounts') return defaultHandler(call);
    const offset = call.operations.find((op) => op.method === 'range').args[0];
    return { count: 2001, error: null, data: Array.from({ length: 250 }, (_, n) => ({ id: String(offset + n), connection_id: CONNECTION, qbo_account_id: String(offset + n), is_active: false })) };
  });
  const result = await loadSourceSnapshot(db, COMPANY);
  assert.equal(result.accountOptions.length, 2000); assert.equal(result.sources.accounts.truncated, true); assert.equal(result.sources.accounts.count, 2001);
  assert.equal(result.accountOptions[0].isActive, false);
});
test('bank available and current balances remain separate, mixed currencies unpooled', async () => {
  const db = mockDb((call) => {
    if (call.table === 'chat_run_readonly_query' && call.params.query.includes('from public.plaid_accounts')) return { error: null, data: [
      { id: 'a', iso_currency_code: 'USD', current_balance: '100', available_balance: '60', pending_count: 2, balance_updated_at: '2026-03-01', connection_status: 'active', environment: 'production' },
      { id: 'b', iso_currency_code: 'CAD', current_balance: null, available_balance: '20', pending_count: 1, balance_updated_at: '2026-03-02', connection_status: 'error', environment: 'production' },
    ] };
    return defaultHandler(call);
  });
  const { sources: { bank } } = await loadSourceSnapshot(db, COMPANY);
  assert.equal(bank.rows[0].current_balance, 100); assert.equal(bank.rows[0].available_balance, 60);
  assert.equal(bank.rows[1].current_balance, null); assert.equal(bank.currency, null); assert.equal(bank.status, 'partial');
  assert.equal(bank.metrics[1].value, 3); assert.equal(bank.liquidity, undefined);
});
test('PO coverage distinguishes missing and zero costs, without unpaid-obligation totals', async () => {
  const db = mockDb((call) => {
    if (call.table === 'chat_run_readonly_query' && call.params.query.includes('with headers')) return { error: null, data: [
      { status: 'Draft', po_count: 2, line_count: 5, missing_cost_lines: 2, zero_cost_lines: 1, negative_cost_lines: 0, pos_without_lines: 0, missing_arrival_dates: 2, known_positive_cost: 45 },
    ] };
    return defaultHandler(call);
  });
  const { sources: { purchaseOrders: po } } = await loadSourceSnapshot(db, COMPANY);
  assert.equal(po.metrics.find((m) => m.label === 'Lines missing cost').value, 2);
  assert.equal(po.metrics.find((m) => m.label === 'Lines with zero cost').value, 1);
  assert.equal(po.status, 'partial'); assert.equal(po.currency, null); assert.equal(po.obligations, undefined);
});
test('pre-aborted load makes no requests; in-flight cancellation never returns a stale snapshot', async () => {
  const controller = new AbortController(); controller.abort();
  const db = mockDb(defaultHandler);
  await assert.rejects(loadSourceSnapshot(db, COMPANY, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(db.calls.length, 0);
  const mid = new AbortController();
  const during = mockDb((call) => { mid.abort(); return defaultHandler(call); });
  await assert.rejects(loadSourceSnapshot(during, COMPANY, { signal: mid.signal }), { name: 'AbortError' });
  for (const call of during.calls) assert.ok(call.operations.some((op) => op.method === 'abortSignal'));
});
test('source implementation has no provider sync/write paths or embedded credentials', async () => {
  const code = await readFile(new URL('../source-data.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\.(?:insert|upsert|update|delete|invoke)\s*\(/);
  assert.doesNotMatch(code, /service_role|SUPABASE_ANON_KEY|https:\/\/[^\s]+supabase/);
});
test('invalid successful aggregate shapes are errors, never empty or zero evidence', async () => {
  const db = mockDb((call) => call.table === 'chat_run_readonly_query' ? { error: null, data: [{}] } : defaultHandler(call));
  const { sources } = await loadSourceSnapshot(db, COMPANY);
  for (const key of ['inventory', 'purchaseOrders', 'bank']) assert.equal(sources[key].status, 'error');
});
test('unknown financial currency stays null and mixed currencies do not pick a default', async () => {
  const db = mockDb((call) => {
    if (call.table !== 'quickbooks_report_runs') return defaultHandler(call);
    const name = filter(call, 'report_name');
    if (!name) return { data: [{ connection_id: CONNECTION }], error: null };
    const run = report(name, months, [summary('TotalAssets', ['100', '250'])]);
    run.raw_response.Header.Currency = name === 'BalanceSheet' ? 'USD' : 'CAD';
    return { data: [run], error: null };
  });
  assert.equal((await loadSourceSnapshot(db, COMPANY)).currency, null);
  const run = report('BalanceSheet', months, [account('7', ['20', '30'])]);
  delete run.raw_response.Header.Currency;
  assert.equal(parseQboReport(run, 'BalanceSheet').currency, null);
});

test('monthly P&L exposes recorded revenue, COGS and margin without summing cumulative Total', () => {
  const run = report('ProfitAndLoss', [...months, col('Total', null, null, 'total')], [
    summary('Income', ['100', '200', '300']), summary('COGS', ['60', '110', '170']),
    summary('GrossProfit', ['40', '90', '130']), summary('Expenses', ['20', '30', '50']),
    summary('NetOperatingIncome', ['20', '60', '80']), summary('NetIncome', ['15', '55', '70']),
  ]);
  const source = parseQboReport(run, 'ProfitAndLoss');
  assert.equal(source.monthly.length, 2);
  assert.equal(source.monthly[0].revenue, 100); assert.equal(source.monthly[1].grossMarginPct, 45);
  assert.equal(source.monthly[1].operatingIncome, 60); assert.equal(source.monthly[1].netIncome, 55);
  assert.equal(source.monthly[1].reportId, 'synthetic-report'); assert.equal(source.monthly[1].basis, 'Accrual');
  run.raw_response.Rows.Row[0].Summary.ColData[1].value = '0';
  assert.equal(parseQboReport(run, 'ProfitAndLoss').monthly[0].grossMarginPct, null);
});
test('monthly BS stocks and account history stay separate for every period', () => {
  const source = parseQboReport(report('BalanceSheet', months, [
    summary('TotalAssets', ['100', '160']), summary('Liabilities', ['40', '50']), summary('Equity', ['60', '110']),
    summary('BankAccounts', ['10', '20']), summary('AP', ['5', '15']), account('1', ['9', '8']),
  ]), 'BalanceSheet');
  assert.deepEqual(source.monthly.map((r) => r.assets), [100, 160]);
  assert.deepEqual(source.monthly.map((r) => r.accountsPayable), [5, 15]);
  assert.equal(source.monthly[0].longTermLiabilities, null);
  assert.deepEqual(source.accountHistory[0].values.map((v) => v.balance), [9, 8]);
  assert.equal(source.accountHistory[0].connectionId, CONNECTION);
});
test('future QBO month columns are not historical actuals and current month stays partial', () => {
  const run = report('ProfitAndLoss', [...months, col('Mar', '2026-03-01', '2026-03-31'), col('Apr', '2026-04-01', '2026-04-30')], [summary('Income', ['100', '200', '20', '0'])]);
  run.raw_response.Header.Time = '2026-03-04T09:00:00-07:00';
  const monthly = parseQboReport(run, 'ProfitAndLoss').monthly;
  assert.equal(monthly.length, 3); assert.equal(monthly[1].completeMonth, true);
  assert.equal(monthly[2].completeMonth, false); assert.equal(monthly[2].observedThrough, '2026-03-04');
});
test('scope-filtered and overlapping statement columns do not become company history', () => {
  const filtered = report('ProfitAndLoss', months, [summary('Income', ['100', '200'])], { params: { department: 'synthetic-department' } });
  assert.deepEqual(parseQboReport(filtered, 'ProfitAndLoss').monthly, []);
  const duplicate = report('BalanceSheet', [months[0], months[0]], [summary('TotalAssets', ['100', '200'])]);
  assert.deepEqual(parseQboReport(duplicate, 'BalanceSheet').monthly, []);
  const cash = report('CashFlow', months, [summary('OperatingActivities', ['100', '200'])], { params: { department: 'synthetic-department' } });
  assert.deepEqual(parseQboReport(cash, 'CashFlow').monthly, []);
});
test('a separate monthly snapshot adds history without replacing latest cumulative headline', async () => {
  const db = mockDb((call) => {
    if (call.table !== 'quickbooks_report_runs') return defaultHandler(call);
    const name = filter(call, 'report_name');
    if (!name) return { data: [{ connection_id: CONNECTION }], error: null };
    if (name !== 'ProfitAndLoss') return { data: [], error: null };
    const history = filter(call, 'raw_response->Header->>SummarizeColumnsBy');
    if (history) {
      assert.equal(history, 'Month'); assert.equal(filter(call, 'company_entity_id'), COMPANY);
      assert.equal(filter(call, 'connection_id'), CONNECTION); assert.equal(filter(call, 'status'), 'ok');
      return { data: [report(name, months, [summary('Income', ['100', '200'])], { id: 'older-monthly', fetched_at: '2026-03-02T00:00:00Z' })], error: null };
    }
    return { data: [report(name, [col('Total', null, null, 'total')], [summary('Income', ['330'])], { id: 'newest-total' })], error: null };
  });
  const { sources: { profitAndLoss: pnl } } = await loadSourceSnapshot(db, COMPANY);
  assert.equal(pnl.reportId, 'newest-total'); assert.equal(pnl.metrics[0].value, 330);
  assert.equal(pnl.monthly[1].revenue, 200); assert.equal(pnl.history.reportId, 'older-monthly');
});
test('monthly history failure and currency mismatch are visible, with no silent mixture', async () => {
  for (const mode of ['error', 'currency']) {
    const db = mockDb((call) => {
      if (call.table !== 'quickbooks_report_runs') return defaultHandler(call);
      const name = filter(call, 'report_name');
      if (!name) return { data: [{ connection_id: CONNECTION }], error: null };
      if (filter(call, 'raw_response->Header->>SummarizeColumnsBy')) {
        if (mode === 'error') return { data: null, error: { code: 'HISTORY_FAILED', message: 'Synthetic history failure' } };
        const run = report(name, months, [summary('Income', ['100', '200'])]); run.raw_response.Header.Currency = 'CAD';
        return { data: [run], error: null };
      }
      return { data: [report(name, [col('Total', null, null, 'total')], [summary('Income', ['330'])])], error: null };
    });
    const { sources: { profitAndLoss: pnl } } = await loadSourceSnapshot(db, COMPANY);
    assert.equal(pnl.monthly.length, 0); assert.ok(pnl.historyError); assert.equal(pnl.metrics[0].value, 330);
  }
});

const planRow = (extra = {}) => ({ month: '2026-02', business_date: '2026-03-04', planned_sales: '100', projected_units: 5,
  actual_net_sales: '90', actual_total_sales: '105', planned_days: 28, actual_days: 28, planned_locations: 1,
  actual_through: '2026-02-28', planned_location_days: 28, unmapped_plan_rows: 0, unplanned_actual_location_days: 0,
  missing_actual_plan_location_days: 0, matched_days: 28, matched_location_days: 28, matched_planned_sales: '100',
  matched_actual_net_sales: '90', updated_at: '2026-01-01T00:00:00Z', ...extra });
test('saved zero revenue plan is retained, missing plan is not invented from actuals', () => {
  const result = parseRevenuePlan([planRow({ planned_sales: '0' }), planRow({ month: '2026-01', planned_sales: null, planned_location_days: 0, planned_days: 0, planned_locations: 0 })]);
  assert.equal(result.plans.length, 1); assert.equal(result.plans[0].monthly.length, 1); assert.equal(result.plans[0].monthly[0].revenue, 0);
  assert.equal(result.monthly[1].plannedSales, null); assert.equal(result.monthly[1].actualNetSales, 90);
  assert.equal(result.currency, null); assert.equal(result.plans[0].currency, null);
  assert.equal(result.monthly[0].comparisonEligible, false); assert.equal(result.plans[0].monthly[0].grossProfit, undefined);
});
test('plan coverage gaps and monthly date boundary are exposed without authoritative variance', () => {
  const result = parseRevenuePlan([planRow({ month: '2026-03', unmapped_plan_rows: 2, missing_actual_plan_location_days: 3, unplanned_actual_location_days: 4, matched_actual_net_sales: null })]);
  const row = result.monthly[0];
  assert.equal(row.completeMonth, false); assert.equal(row.unmappedPlanRows, 2); assert.equal(row.missingActualPlanLocationDays, 3);
  assert.equal(row.unplannedActualLocationDays, 4); assert.equal(row.matchedActualNetSales, null); assert.equal(row.variancePct, undefined);
  assert.equal(result.status, 'partial'); assert.match(result.warnings.join(' '), /measurement basis/);
});
const poDetail = (extra = {}) => ({ id: 'synthetic-po', po_name: 'Synthetic order', status: 'Confirmed', order_date: '2026-01-01', expected_arrival_date: null,
  line_count: 2, units: 5, missing_cost_lines: 1, zero_cost_lines: 0, negative_cost_lines: 0, negative_quantity_lines: 0, known_estimated_cost: 40, ...extra });
test('placed PO exposure keeps undated arrival, missing costs and full ordered quantities explicit', () => {
  const result = parsePurchaseOrderExposure({ placed_count: 1, placed: [poDetail({ status: 'Partially Received' })], arrival_months: [
    { ...poDetail(), month: null, po_count: 1, pos_without_lines: 0 },
  ] });
  assert.equal(result.placed[0].arrivalDate, null); assert.equal(result.placed[0].costComplete, false);
  assert.equal(result.placed[0].knownEstimatedCost, 40); assert.equal(result.placed[0].units, 5);
  assert.equal(result.arrivalMonths[0].month, null); assert.equal(result.placed[0].paymentDate, undefined);
  assert.equal(result.placed[0].unpaidBalance, undefined);
});
test('PO capped detail does not cap aggregate exposure buckets', () => {
  const result = parsePurchaseOrderExposure({ placed_count: 300, placed: Array.from({length:201},(_,i) => poDetail({id:`synthetic-${i}`})),
    arrival_months: [{ ...poDetail(), month: '2026-04', po_count: 300, pos_without_lines: 0, units: 1500 }] });
  assert.equal(result.placed.length, 200); assert.equal(result.placedCount, 300); assert.equal(result.placedTruncated, true);
  assert.equal(result.arrivalMonths[0].poCount, 300); assert.equal(result.arrivalMonths[0].units, 1500);
});
test('new context SQL uses tenant predicates, company day, unique location resolution and nullable costs', () => {
  const sql = businessQueries(COMPANY);
  assert.match(sql.revenuePlan, /silo_business_today/); assert.doesNotMatch(sql.revenuePlan, /current_date/);
  assert.match(sql.revenuePlan, /p\.company_entity_id/); assert.match(sql.revenuePlan, /s\.company_entity_id/);
  assert.match(sql.revenuePlan, /tag_count=1/); assert.match(sql.revenuePlan, /full outer join/);
  assert.match(sql.revenuePlan, /s\.day_date<b\.today/); assert.match(sql.revenuePlan, /p\.scenario='active'/);
  assert.match(sql.purchaseOrderExposure, /Partially Received/); assert.doesNotMatch(sql.purchaseOrderExposure, /'Draft'/);
  assert.match(sql.purchaseOrderExposure, /unit_cost is null/); assert.match(sql.purchaseOrderExposure, /unit_cost = 0/);
  assert.doesNotMatch(sql.purchaseOrderExposure, /coalesce\(.*expected_arrival_date/);
  for (const query of Object.values(sql)) assert.doesNotMatch(query, /\b(?:insert|update|delete|truncate)\b/i);
});
test('integrated added sources retain errors and send abort signals on every read', async () => {
  const controller = new AbortController();
  const db = mockDb((call) => {
    if (call.table === 'chat_run_readonly_query' && call.params.query.includes('with clock')) return { data: [planRow()], error: null };
    if (call.table === 'chat_run_readonly_query' && call.params.query.includes('as placed_count')) return { data: null, error: { code: 'DETAIL_FAILED', message: 'Synthetic detail failure' } };
    return defaultHandler(call);
  });
  const { sources } = await loadSourceSnapshot(db, COMPANY, { signal: controller.signal });
  assert.equal(sources.revenuePlan.plans[0].monthly[0].revenue, 100);
  assert.equal(sources.purchaseOrders.detailError.code, 'DETAIL_FAILED');
  for (const call of db.calls) assert.ok(call.operations.some((op) => op.method === 'abortSignal'));
});
test('unknown snapshot observation date withholds monthly series instead of admitting future zeros', () => {
  for (const name of ['ProfitAndLoss', 'BalanceSheet', 'CashFlow']) {
    const run = report(name, months, [summary('Income', ['0', '0']), account('1', ['0', '0'])], { fetched_at: null });
    run.raw_response.Header.Time = 'invalid date';
    const result = parseQboReport(run, name);
    assert.equal(result.monthly.length, 0); assert.equal(result.accountHistory.length, 0);
    assert.equal(result.status, 'partial'); assert.match(result.warnings.join(' '), /observation date is unknown/);
  }
});
