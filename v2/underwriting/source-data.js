/** Read-only underwriting evidence. No syncs, postings, saved assumptions or provider calls.
 * All amounts are native currency units (not cents). Null means unknown, never zero.
 * The caller owns authentication, finance access, and active-company lifecycle checks.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 250;
const ACCOUNT_LIMIT = 2000;
const REPORT_NAMES = ['BalanceSheet', 'ProfitAndLoss', 'CashFlow'];
const REPORT_KEYS = ['balanceSheet', 'profitAndLoss', 'cashflow'];
const PLACED_STATUSES = ['Approved', 'Sent to Factory', 'Confirmed', 'In Production', 'Shipped', 'In Transit', 'Partially Received'];
const REPORT_FIELDS = 'id,connection_id,report_name,params,start_date,end_date,raw_response,row_count,status,error_message,fetched_at';
const metric = (label, value, unit = 'count', currency = null) => ({ label, value, unit, currency });
const text = (value) => value == null ? null : String(value);
const currencyCode = (value) => /^[A-Z]{3}$/.test(value || '') ? value : null;
const date = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : null;
};
const meta = (column, name) => column?.MetaData?.find((entry) => entry.Name === name)?.Value;
function requireCounts(row, fields) {
  for (const field of fields) {
    const value = parseReportNumber(row?.[field]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Source aggregate has an invalid ${field}`);
  }
}
function source(label, extra = {}) {
  return { label, status: 'missing', rows: [], count: null, truncated: false, asOf: null,
    fetchedAt: null, periodStart: null, periodEnd: null, basis: null, currency: null,
    metrics: [], warnings: [], error: null, ...extra };
}
function fail(label, error) {
  return source(label, { status: 'error', error: {
    code: text(error?.code || error?.name || 'READ_FAILED'),
    message: text(error?.message || 'Source could not be read'),
  } });
}
function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error('Source loading cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
async function queryResult(query, signal) {
  abortIfNeeded(signal);
  const result = await (signal ? query.abortSignal(signal) : query);
  abortIfNeeded(signal);
  if (result.error) throw result.error;
  if (!Array.isArray(result.data)) throw new Error('Source returned an invalid row list');
  return result;
}
async function guarded(label, task, signal) {
  try { return await task(); }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    return fail(label, error);
  }
}

/** Accept plain provider decimals, grouping commas and accounting parentheses.
 * Blank, malformed, non-finite, and absent values stay null. */
export function parseReportNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let s = value.trim();
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1); }
  if (!(negative ? /^(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?$/ : /^-?(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?$/).test(s)
      || !/\d/.test(s)) return null;
  const n = Number(s.replace(/,/g, '')) * (negative ? -1 : 1);
  return Number.isFinite(n) ? n : null;
}

function flattenReport(node, out = [], depth = 0) {
  if (depth > 30) throw new Error('Stored report nesting exceeds supported depth');
  for (const row of node?.Rows?.Row || []) {
    if (out.length > 10000) throw new Error('Stored report exceeds the supported row limit');
    const append = (cells, kind) => {
      if (!Array.isArray(cells)) return;
      out.push({ label: text(cells[0]?.value) || '', accountId: text(cells[0]?.id),
        group: text(row.group), kind, depth, cells });
    };
    append(row.Header?.ColData, 'header');
    append(row.ColData, row.type === 'Section' ? 'header' : 'data');
    if (row.Rows) flattenReport(row, out, depth + 1);
    append(row.Summary?.ColData, 'summary');
  }
  return out;
}
function monthComplete(start, end) {
  if (!start || !end || start.slice(0, 7) !== end.slice(0, 7) || !start.endsWith('-01')) return false;
  const next = new Date(`${end}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getUTCDate() === 1;
}
function groupValue(rows, group, index) {
  const matches = rows.filter((row) => row.group === group && row.kind !== 'header');
  return matches.length === 1 && index != null ? parseReportNumber(matches[0].cells[index]?.value) : null;
}

/** Parse exactly one saved run. Never add monthly balance-sheet stocks, or a
 * report Total to its constituent periods. No account-name classification. */
export function parseQboReport(run, expectedName) {
  const label = { BalanceSheet: 'QBO balance sheet', ProfitAndLoss: 'QBO profit and loss', CashFlow: 'QBO monthly cash flow' }[expectedName];
  const result = source(label, { reportId: run?.id || null, connectionId: run?.connection_id || null, columns: [], monthly: [], accountBalances: [], accountHistory: [] });
  if (!run) { result.warnings.push('No saved report is visible for this company and selected QBO connection.'); return result; }
  result.fetchedAt = run.fetched_at || null;
  if (run.status !== 'ok') return { ...result, status: 'error', error: { code: 'REPORT_RUN_FAILED', message: run.error_message || 'The latest saved report attempt failed.' } };
  const payload = run.raw_response;
  const header = payload?.Header;
  if (!header || header.ReportName !== expectedName || !Array.isArray(payload?.Columns?.Column) || !Array.isArray(payload?.Rows?.Row)) {
    return { ...result, status: 'error', error: { code: 'REPORT_SHAPE', message: 'Stored report has an unsupported or mismatched shape.' } };
  }
  result.periodStart = date(header.StartPeriod) || date(run.start_date);
  result.periodEnd = date(header.EndPeriod) || date(run.end_date);
  result.asOf = expectedName === 'BalanceSheet' ? result.periodEnd : result.fetchedAt;
  result.basis = text(header.ReportBasis);
  result.requestedBasis = text(run.params?.accounting_method);
  result.currency = currencyCode(header.Currency);
  result.columns = payload.Columns.Column.map((col, index) => ({ index, label: text(col.ColTitle) || '',
    key: text(meta(col, 'ColKey')), type: text(col.ColType), periodStart: date(meta(col, 'StartDate')), periodEnd: date(meta(col, 'EndDate')) }));
  const flattened = flattenReport(payload);
  const moneyColumns = result.columns.filter((col) => ['money', 'amount'].includes((col.type || '').toLowerCase()));
  result.rows = flattened.map(({ cells, ...row }) => ({ ...row, values: moneyColumns.map((col) => ({ columnIndex: col.index, value: parseReportNumber(cells[col.index]?.value) })) }));
  result.count = result.rows.length;
  const noData = header.Option?.some((option) => option.Name === 'NoReportData' && String(option.Value).toLowerCase() === 'true');
  if (noData || !flattened.length) { result.warnings.push('This saved report contains no report data.'); return result; }
  result.status = 'available';
  if (!result.periodEnd || !result.currency) { result.status = 'partial'; result.warnings.push('The report does not state a valid period end or currency.'); }
  if (!result.basis) result.warnings.push('Accounting basis is not stated in the report header; requested basis is not treated as verified.');
  if (Object.entries(run.params || {}).some(([key, value]) => ['account', 'department', 'class', 'customer', 'vendor', 'item'].includes(key) && value != null && value !== '')) {
    result.status = 'partial'; result.warnings.push('This report has a saved scope filter; figures may cover only part of the company.');
    result.scopeFiltered = true;
  }
  if ((date(run.end_date) && result.periodEnd !== run.end_date) || (date(run.start_date) && result.periodStart !== run.start_date)) {
    result.status = 'partial'; result.warnings.push('Saved request dates differ from report-header dates; displayed periods use the report header.');
  }
  const dated = moneyColumns.filter((col) => col.periodStart && col.periodEnd && col.periodStart <= col.periodEnd);
  const totals = moneyColumns.filter((col) => (col.key || '').toLowerCase() === 'total');
  let selected = null;
  if (expectedName === 'BalanceSheet') {
    const ending = dated.filter((col) => col.periodEnd === result.periodEnd);
    if (ending.length === 1) selected = ending[0];
    else if (!dated.length && moneyColumns.length === 1) selected = moneyColumns[0];
  } else if (expectedName === 'ProfitAndLoss') {
    if (totals.length === 1) selected = totals[0];
    else if (moneyColumns.length === 1) selected = moneyColumns[0];
    else if (dated.length) {
      const latestEnd = dated.map((col) => col.periodEnd).sort().at(-1);
      const ending = dated.filter((col) => col.periodEnd === latestEnd);
      if (ending.length === 1) selected = ending[0];
    }
  }
  if (selected) {
    result.selectedColumn = selected;
    if (expectedName === 'ProfitAndLoss' && selected.periodStart && (selected.periodStart !== result.periodStart || selected.periodEnd !== result.periodEnd)) {
      result.warnings.push(`Headline P&L values cover only ${selected.periodStart} to ${selected.periodEnd}; the monthly columns are not added together.`);
    }
    const groups = expectedName === 'BalanceSheet'
      ? [['TotalAssets', 'Total assets'], ['Liabilities', 'Total liabilities'], ['Equity', 'Total equity'], ['BankAccounts', 'Book bank balances']]
      : [['Income', 'Income'], ['GrossProfit', 'Gross profit'], ['NetOperatingIncome', 'Net operating income'], ['NetIncome', 'Net income']];
    result.metrics = groups.map(([group, name]) => ({ ...metric(name, groupValue(flattened, group, selected.index), 'currency', result.currency),
      periodStart: expectedName === 'BalanceSheet' ? null : selected.periodStart || result.periodStart,
      periodEnd: selected.periodEnd || result.periodEnd }));
    if (result.metrics.every((item) => item.value == null)) { result.status = 'partial'; result.warnings.push('Recognized statement totals are absent or ambiguous.'); }
    if (expectedName === 'BalanceSheet') {
      const candidates = flattened.filter((row) => row.kind === 'data' && row.accountId);
      const ids = new Set(candidates.map((row) => row.accountId));
      result.accountBalances = [...ids].map((accountId) => {
        const matching = candidates.filter((row) => row.accountId === accountId);
        return { accountId, connectionId: result.connectionId, balance: matching.length === 1 && !result.scopeFiltered ? parseReportNumber(matching[0].cells[selected.index]?.value) : null,
          ambiguous: matching.length !== 1, asOf: selected.periodEnd || result.periodEnd, currency: result.currency, reportId: result.reportId };
      });
    }
  } else if (expectedName !== 'CashFlow') {
    result.status = 'partial'; result.warnings.push('No unambiguous statement column can be selected; no balance or headline value is inferred.');
  }
  // One dated observation per month from ONE snapshot. Future report columns
  // are not historical actuals just because QBO emitted a numeric zero.
  const observedOn = date(String(header.Time || '').slice(0, 10)) || date(String(run.fetched_at || '').slice(0, 10));
  if (!observedOn) { result.status = 'partial'; result.warnings.push('The snapshot observation date is unknown; monthly history is withheld rather than treating future columns as actuals.'); }
  if (expectedName !== 'CashFlow') {
    const months = dated.filter((col) => col.periodStart.slice(0, 7) === col.periodEnd.slice(0, 7)
      && (col.key || '').toLowerCase() !== 'total' && (observedOn && col.periodStart <= observedOn))
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    if (months.some((col, i) => i > 0 && col.periodStart <= months[i - 1].periodEnd)) {
      result.status = 'partial'; result.warnings.push('Overlapping statement columns cannot be used as monthly history.');
    } else if (!result.scopeFiltered) {
      result.monthly = months.map((column) => {
        const value = (group) => groupValue(flattened, group, column.index);
        const common = { month: column.periodStart.slice(0, 7), periodStart: column.periodStart, periodEnd: column.periodEnd,
          completeMonth: monthComplete(column.periodStart, column.periodEnd) && !!observedOn && column.periodEnd < observedOn,
          observedThrough: observedOn && observedOn < column.periodEnd ? observedOn : column.periodEnd,
          reportId: result.reportId, fetchedAt: result.fetchedAt, basis: result.basis, currency: result.currency };
        if (expectedName === 'ProfitAndLoss') {
          const revenue = value('Income'), grossProfit = value('GrossProfit');
          return { ...common, revenue, cogs: value('COGS'), grossProfit,
            grossMarginPct: revenue != null && revenue > 0 && grossProfit != null ? grossProfit / revenue * 100 : null,
            operatingExpenses: value('Expenses'), operatingIncome: value('NetOperatingIncome'), netIncome: value('NetIncome') };
        }
        return { ...common, assets: value('TotalAssets'), liabilities: value('Liabilities'), equity: value('Equity'),
          bookCash: value('BankAccounts'), accountsReceivable: value('AR'), accountsPayable: value('AP'),
          currentAssets: value('CurrentAssets'), currentLiabilities: value('CurrentLiabilities'),
          longTermLiabilities: value('LongTermLiabilities'), creditCards: value('CreditCards') };
      });
      if (expectedName === 'BalanceSheet' && months.length) {
        const candidates = flattened.filter((row) => row.kind === 'data' && row.accountId);
        result.accountHistory = [...new Set(candidates.map((row) => row.accountId))].map((accountId) => {
          const matching = candidates.filter((row) => row.accountId === accountId);
          return { accountId, connectionId: result.connectionId, label: matching[0].label, ambiguous: matching.length !== 1,
            currency: result.currency, basis: result.basis, reportId: result.reportId, fetchedAt: result.fetchedAt,
            values: months.map((column) => ({ periodEnd: column.periodEnd, balance: matching.length === 1 ? parseReportNumber(matching[0].cells[column.index]?.value) : null })) };
        });
      }
    }
  }
  if (expectedName === 'CashFlow') {
    const months = (result.scopeFiltered ? [] : dated).filter((col) => col.periodStart.slice(0, 7) === col.periodEnd.slice(0, 7) && (col.key || '').toLowerCase() !== 'total' && (observedOn && col.periodStart <= observedOn)).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    let previous = null;
    for (const col of months) {
      if (previous && col.periodStart <= previous.periodEnd) {
        result.status = 'partial'; result.warnings.push('Overlapping cash-flow columns prevent reliable monthly coverage.'); result.monthly = []; break;
      }
      if (previous) {
        const next = new Date(`${previous.periodEnd}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        if (next.toISOString().slice(0, 10) !== col.periodStart) { result.status = 'partial'; result.warnings.push('There is a gap between monthly cash-flow periods.'); }
      }
      result.monthly.push({ periodStart: col.periodStart, periodEnd: col.periodEnd, completeMonth: monthComplete(col.periodStart, col.periodEnd) && !!observedOn && col.periodEnd < observedOn,
        observedThrough: observedOn && observedOn < col.periodEnd ? observedOn : col.periodEnd, reportId: result.reportId, fetchedAt: result.fetchedAt, basis: result.basis, currency: result.currency,
        operating: groupValue(flattened, 'OperatingActivities', col.index), investing: groupValue(flattened, 'InvestingActivities', col.index),
        financing: groupValue(flattened, 'FinancingActivities', col.index), netChange: groupValue(flattened, 'CashIncrease', col.index) });
      previous = col;
    }
    result.metrics = [metric('Monthly periods in saved report', result.monthly.length), metric('Complete calendar months', result.monthly.filter((row) => row.completeMonth).length)];
    if (!result.monthly.length) { result.status = 'partial'; result.warnings.push('Monthly columns are unavailable; a cumulative total is not a monthly observation.'); }
    if (result.monthly.some((row) => [row.operating, row.investing, row.financing, row.netChange].some((v) => v == null))) { result.status = 'partial'; result.warnings.push('One or more monthly cash-flow totals are absent or ambiguous.'); }
    if (result.monthly.some((row) => !row.completeMonth)) { result.status = 'partial'; result.warnings.push('The cash-flow series includes a partial calendar month.'); }
    result.warnings.push('Reported operating cash flow is historical and unnormalized; it is not cash available for debt service.');
  }
  result.warnings.push('Saved QBO snapshot only; loading this page does not refresh QuickBooks.');
  return result;
}

export function buildAccountOptions(accounts, balanceSheet) {
  return accounts.map((account) => {
    const matches = balanceSheet.accountBalances?.filter((row) => row.connectionId && row.connectionId === account.connection_id && row.accountId === String(account.qbo_account_id)) || [];
    const match = matches.length === 1 ? matches[0] : null;
    return { id: `${account.connection_id}:${account.qbo_account_id}`, connectionId: account.connection_id, accountId: String(account.qbo_account_id),
      label: account.fully_qualified_name || account.name || String(account.qbo_account_id), accountType: account.account_type || null,
      isActive: account.is_active, currency: currencyCode(account.currency), balance: match?.balance ?? null,
      balanceAsOf: match?.asOf || null, balanceCurrency: match?.currency || null, reportId: match?.reportId || null,
      matchStatus: match?.ambiguous ? 'ambiguous' : match?.balance != null ? 'matched' : 'unavailable' };
  });
}

async function accountSource(db, companyId, signal) {
  const rows = [];
  let total = null;
  while (rows.length < ACCOUNT_LIMIT) {
    const result = await queryResult(db.from('quickbooks_accounts').select('id,connection_id,qbo_account_id,name,fully_qualified_name,account_type,currency,is_active,synced_at', { count: 'exact' })
      .eq('company_entity_id', companyId).order('id').range(rows.length, rows.length + PAGE_SIZE - 1), signal);
    if (Number.isInteger(result.count)) total = result.count;
    rows.push(...result.data);
    if (!result.data.length || (total != null && rows.length >= total) || (total == null && result.data.length < PAGE_SIZE)) break;
  }
  const truncated = total == null ? rows.length >= ACCOUNT_LIMIT : rows.length < total;
  return source('QBO account mapping', { status: truncated ? 'partial' : rows.length ? 'available' : 'missing', rows, count: total ?? rows.length, truncated,
    asOf: rows.map((row) => row.synced_at).filter(Boolean).sort()[0] || null,
    metrics: [metric('Account options loaded', rows.length)], warnings: [
      'Select accounts manually by connection and QBO account ID. An account name does not establish a debt facility or contractual terms.',
      ...(truncated ? [`Account list is incomplete: loaded ${rows.length} of ${total ?? 'an unknown total'}.`] : []),
    ] });
}

/** Fixed server-side aggregates through SILO's existing invoker/read-only report
 * engine. Only the validated company UUID is interpolated; no scenario input. */
export function coverageQueries(companyId) {
  if (!UUID.test(companyId || '')) throw new TypeError('A valid active company ID is required');
  const company = `'${companyId}'::uuid`;
  return {
    inventory: `select count(*) as row_count, count(distinct location_tag) as location_count,
      min(snapshot_at) as oldest_snapshot, max(snapshot_at) as newest_snapshot,
      sum(total_available_quantity) as reported_units,
      count(*) filter (where total_available_quantity is null) as missing_quantity_rows,
      count(*) filter (where total_available_inventory_value is null) as missing_value_rows,
      count(*) filter (where total_available_inventory_value = 0) as zero_value_rows
      from public.inventory_on_hand_current_v where company_entity_id = ${company}`,
    purchaseOrders: `with headers as (select id, status, expected_arrival_date, updated_at
      from public.po_headers where company_entity_id = ${company}),
      lines as (select l.po_header_id, count(*) as line_count, sum(l.qty) as units,
        count(*) filter (where l.unit_cost is null) as missing_cost_lines,
        count(*) filter (where l.unit_cost = 0) as zero_cost_lines,
        count(*) filter (where l.unit_cost < 0) as negative_cost_lines,
        sum(l.qty * l.unit_cost) filter (where l.unit_cost > 0) as known_positive_cost
        from public.po_lines l join headers h on h.id = l.po_header_id
        where l.company_entity_id = ${company} group by l.po_header_id)
      select h.status, count(*) as po_count, max(h.updated_at) as last_updated,
        count(*) filter (where h.expected_arrival_date is null) as missing_arrival_dates,
        count(*) filter (where l.line_count is null) as pos_without_lines,
        sum(coalesce(l.line_count,0)) as line_count, sum(l.units) as units,
        sum(coalesce(l.missing_cost_lines,0)) as missing_cost_lines,
        sum(coalesce(l.zero_cost_lines,0)) as zero_cost_lines,
        sum(coalesce(l.negative_cost_lines,0)) as negative_cost_lines,
        sum(l.known_positive_cost) as known_positive_cost
        from headers h left join lines l on l.po_header_id = h.id group by h.status order by h.status`,
    bank: `select a.id, a.connection_id, a.name, a.type, a.subtype, a.iso_currency_code,
      a.current_balance, a.available_balance, a.balance_updated_at, a.last_synced_at,
      c.status as connection_status, c.environment, c.institution_name,
      (select count(*) from public.card_transactions t where t.company_entity_id = ${company}
        and t.plaid_account_id = a.id and t.origin = 'plaid' and t.provider_status = 'pending') as pending_count
      from public.plaid_accounts a left join public.plaid_connections c
        on c.id = a.connection_id and c.company_entity_id = ${company}
      where a.company_entity_id = ${company} and a.type = 'depository' order by a.id limit 501`,
  };
}
async function aggregateSource(db, companyId, key, signal) {
  const label = { inventory: 'Inventory snapshot coverage', purchaseOrders: 'PO estimate and cost coverage', bank: 'Saved bank balances' }[key];
  const { data } = await queryResult(db.rpc('chat_run_readonly_query', { query: coverageQueries(companyId)[key], p_offset: 0 }), signal);
  const result = source(label, { status: data.length ? 'available' : 'missing', rows: data, count: data.length });
  if (key === 'inventory') {
    if (data.length !== 1) throw new Error('Inventory aggregate returned an invalid result');
    const r = data[0];
    requireCounts(r, ['row_count', 'location_count', 'missing_quantity_rows', 'missing_value_rows', 'zero_value_rows']);
    result.count = parseReportNumber(r.row_count);
    result.status = result.count ? 'available' : 'missing';
    result.asOf = r.oldest_snapshot || null;
    result.newestAsOf = r.newest_snapshot || null;
    result.metrics = [metric('Snapshot rows', result.count), metric('Reported on-hand units', parseReportNumber(r.reported_units), 'units'),
      metric('Rows missing quantity', parseReportNumber(r.missing_quantity_rows)), metric('Rows missing inventory value', parseReportNumber(r.missing_value_rows)),
      metric('Rows with zero inventory value', parseReportNumber(r.zero_value_rows))];
    result.warnings = ['Current snapshot only, with no reliable collateral valuation or eligibility. Source inventory values are not a borrowing base.'];
    if (!result.asOf || Number(r.missing_quantity_rows) > 0 || Number(r.missing_value_rows) > 0 || Number(r.zero_value_rows) > 0) result.status = result.count ? 'partial' : 'missing';
  } else if (key === 'purchaseOrders') {
    for (const row of data) requireCounts(row, ['po_count', 'line_count', 'missing_cost_lines', 'zero_cost_lines', 'negative_cost_lines', 'pos_without_lines', 'missing_arrival_dates']);
    const sum = (field) => data.length ? data.reduce((total, row) => total + (parseReportNumber(row[field]) ?? 0), 0) : null;
    result.count = sum('po_count');
    result.asOf = data.map((r) => r.last_updated).filter(Boolean).sort().at(-1) || null;
    result.metrics = [metric('Visible POs (all statuses)', result.count), metric('PO lines', sum('line_count')),
      metric('Lines missing cost', sum('missing_cost_lines')), metric('Lines with zero cost', sum('zero_cost_lines')),
      metric('Lines with negative cost', sum('negative_cost_lines')), metric('POs without lines', sum('pos_without_lines')),
      metric('POs missing arrival dates', sum('missing_arrival_dates'))];
    result.warnings = ['All statuses are shown separately. PO estimates are not unpaid obligations; expected arrival dates are planning dates, not debt maturities.',
      'Cost amounts have no recorded currency here and exclude missing, zero and negative costs. They are not presented as a total commitment.',
      'Coverage follows the signed-in user’s PO-header permissions and may omit other users’ POs.'];
    if (data.length >= 1000) { result.truncated = true; result.warnings.push('PO status groups reached the report-engine cap; coverage is incomplete.'); }
    if (result.truncated || sum('missing_cost_lines') || sum('zero_cost_lines') || sum('negative_cost_lines') || sum('pos_without_lines')) result.status = 'partial';
  } else {
    for (const row of data) requireCounts(row, ['pending_count']);
    result.truncated = data.length > 500;
    result.rows = data.slice(0, 500).map((row) => ({ ...row, current_balance: parseReportNumber(row.current_balance), available_balance: parseReportNumber(row.available_balance) }));
    result.count = result.truncated ? null : result.rows.length;
    result.asOf = result.rows.map((row) => row.balance_updated_at).filter(Boolean).sort()[0] || null;
    const currencies = [...new Set(result.rows.map((row) => currencyCode(row.iso_currency_code)))];
    result.currency = currencies.length === 1 ? currencies[0] : null;
    result.metrics = [metric('Depository accounts loaded', result.rows.length), metric('Pending transactions (not subtracted)', result.rows.length ? result.rows.reduce((n, row) => n + Number(row.pending_count || 0), 0) : null)];
    result.warnings = ['Current and provider-available balances remain separate. Pending transactions are not subtracted from either balance.',
      'These saved account balances do not establish unrestricted cash or available liquidity. Each account retains its own currency, timestamp and connection status.'];
    if (result.truncated) result.warnings.push('Bank account rows are capped at 500; source coverage is incomplete.');
    if (result.truncated || result.rows.some((row) => row.current_balance == null || !row.balance_updated_at || row.connection_status !== 'active' || row.environment !== 'production' || !currencyCode(row.iso_currency_code))) result.status = 'partial';
  }
  return result;
}

export async function loadSourceSnapshot(db, companyId, { signal } = {}) {
  if (!UUID.test(companyId || '')) throw new TypeError('A valid active company ID is required');
  abortIfNeeded(signal);
  // Resolve one connection from the newest stored financial-report attempt.
  // All three statements use that connection; never silently blend QBO realms.
  const reportsTask = guarded('QBO report selection', async () => {
    const { data } = await queryResult(db.from('quickbooks_report_runs').select('id,connection_id,report_name,fetched_at')
      .eq('company_entity_id', companyId).in('report_name', REPORT_NAMES).order('fetched_at', { ascending: false }).order('id').limit(1), signal);
    if (!data.length) return REPORT_NAMES.map((name) => parseQboReport(null, name));
    if (!data[0].connection_id) throw new Error('The latest financial snapshot has no QBO connection identity; statements cannot be safely combined.');
    return Promise.all(REPORT_NAMES.map((name) => guarded(`QBO ${name}`, async () => {
      const read = await queryResult(db.from('quickbooks_report_runs').select(REPORT_FIELDS)
        .eq('company_entity_id', companyId).eq('connection_id', data[0].connection_id).eq('report_name', name)
        .order('fetched_at', { ascending: false }).order('id').limit(1), signal);
      const current = parseQboReport(read.data[0], name);
      let history = current;
      if (!current.monthly?.length) {
        try {
          const monthlyRead = await queryResult(db.from('quickbooks_report_runs').select(REPORT_FIELDS)
            .eq('company_entity_id', companyId).eq('connection_id', data[0].connection_id).eq('report_name', name)
            .eq('status', 'ok').eq('raw_response->Header->>SummarizeColumnsBy', 'Month')
            .order('fetched_at', { ascending: false }).order('id').limit(1), signal);
          history = parseQboReport(monthlyRead.data[0], name);
          if (history.status === 'error') throw Object.assign(new Error(history.error.message), { code: history.error.code });
          if (current.currency && history.reportId && current.currency !== history.currency) throw new Error('Monthly history currency differs from the latest statement.');
          if (current.basis && history.reportId && current.basis !== history.basis) throw new Error('Monthly history basis differs from the latest statement.');
          current.monthly = history.monthly || [];
          current.accountHistory = history.accountHistory || [];
          if (history.reportId && history.reportId !== current.reportId) current.warnings.push(`Monthly history uses a separate saved report fetched ${history.fetchedAt || 'at an unknown time'}; headline values retain the latest statement.`);
          current.warnings.push(...history.warnings.filter((warning) => !current.warnings.includes(warning)));
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          current.historyError = { code: error.code || 'HISTORY_READ_FAILED', message: error.message };
          current.warnings.push(`Monthly history could not be read: ${error.message}`);
          if (current.status !== 'error') current.status = 'partial';
          history = null;
        }
      }
      current.history = history ? { reportId: history.reportId, fetchedAt: history.fetchedAt, periodStart: history.periodStart,
        periodEnd: history.periodEnd, basis: history.basis, currency: history.currency, status: history.status } : null;
      return current;
    }, signal)));
  }, signal);
  const [reports, accounts, inventoryBase, purchaseOrdersBase, bank, revenuePlan] = await Promise.all([
    reportsTask, guarded('QBO account mapping', () => accountSource(db, companyId, signal), signal),
    ...['inventory', 'purchaseOrders', 'bank'].map((key) => guarded(key, () => aggregateSource(db, companyId, key, signal), signal)),
    guarded('Active revenue plan and recorded sales', async () => {
      const { data } = await queryResult(db.rpc('chat_run_readonly_query', { query: businessQueries(companyId).revenuePlan, p_offset: 0 }), signal);
      return parseRevenuePlan(data);
    }, signal),
  ]);
  abortIfNeeded(signal);
  const [inventory, purchaseOrders] = await Promise.all([
    enrichBusinessSource(db, companyId, inventoryBase, 'inventoryByType', signal),
    enrichBusinessSource(db, companyId, purchaseOrdersBase, 'purchaseOrderExposure', signal),
  ]);
  abortIfNeeded(signal);
  const financial = Array.isArray(reports) ? reports : REPORT_NAMES.map((name) => fail(`QBO ${name}`, reports.error));
  const sources = Object.fromEntries(REPORT_KEYS.map((key, index) => [key, financial[index]]));
  Object.assign(sources, { bank, inventory, purchaseOrders, accounts, revenuePlan });
  const financialCurrencies = [...new Set(financial.map((item) => item.currency).filter(Boolean))];
  return { companyId, loadedAt: new Date().toISOString(), currency: financialCurrencies.length === 1 ? financialCurrencies[0] : null, sources,
    accountOptions: buildAccountOptions(accounts.rows, sources.balanceSheet),
    warnings: ['All QBO statements use the connection from the newest stored financial-report attempt; no live provider refresh is performed.', 'Sources are independent historical evidence with different dates and coverage. No debt service, borrowing availability or liquidity is inferred.'] };
}

/** Operational business context, never a cash-payment or collateral schedule. */
export function businessQueries(companyId) {
  if (!UUID.test(companyId || '')) throw new TypeError('A valid active company ID is required');
  const company = `'${companyId}'::uuid`;
  const placed = PLACED_STATUSES.map((status) => `'${status}'`).join(',');
  return {
    inventoryByType: `select product_type, count(*) as row_count, count(distinct variant_sku) as sku_count,
      sum(total_available_quantity) as units, sum(total_available_inventory_value) as known_recorded_value,
      count(*) filter (where total_available_inventory_value is null) as missing_value_rows,
      count(*) filter (where total_available_inventory_value = 0) as zero_value_rows,
      min(snapshot_at) as oldest_snapshot, max(snapshot_at) as newest_snapshot
      from public.inventory_on_hand_current_v where company_entity_id = ${company}
      group by product_type order by sum(total_available_quantity) desc nulls last, product_type limit 101`,
    purchaseOrderExposure: `with headers as (select id, po_name, status, order_date, expected_arrival_date, updated_at
      from public.po_headers where company_entity_id = ${company} and status in (${placed})),
      lines as (select l.po_header_id, count(*) as line_count, sum(l.qty) as units,
        count(*) filter (where l.unit_cost is null) as missing_cost_lines,
        count(*) filter (where l.unit_cost = 0) as zero_cost_lines,
        count(*) filter (where l.unit_cost < 0) as negative_cost_lines,
        count(*) filter (where l.qty < 0) as negative_quantity_lines,
        sum(l.qty * l.unit_cost) filter (where l.unit_cost > 0 and l.qty >= 0) as known_estimated_cost
        from public.po_lines l join headers h on h.id=l.po_header_id
        where l.company_entity_id=${company} group by l.po_header_id),
      placed as (select h.*, coalesce(l.line_count,0) as line_count, l.units,
        coalesce(l.missing_cost_lines,0) as missing_cost_lines, coalesce(l.zero_cost_lines,0) as zero_cost_lines,
        coalesce(l.negative_cost_lines,0) as negative_cost_lines, coalesce(l.negative_quantity_lines,0) as negative_quantity_lines,
        l.known_estimated_cost from headers h left join lines l on l.po_header_id=h.id),
      arrivals as (select to_char(expected_arrival_date,'YYYY-MM') as month, count(*) as po_count,
        sum(units) as units, sum(known_estimated_cost) as known_estimated_cost,
        sum(line_count) as line_count, sum(missing_cost_lines) as missing_cost_lines,
        sum(zero_cost_lines) as zero_cost_lines, sum(negative_cost_lines) as negative_cost_lines,
        sum(negative_quantity_lines) as negative_quantity_lines,
        count(*) filter (where line_count=0) as pos_without_lines
        from placed group by to_char(expected_arrival_date,'YYYY-MM'))
      select (select count(*) from placed) as placed_count,
        (select jsonb_agg(to_jsonb(d)) from (select * from placed order by expected_arrival_date nulls last, id limit 201) d) as placed,
        (select jsonb_agg(to_jsonb(a)) from (select * from arrivals order by month nulls last) a) as arrival_months`,
    revenuePlan: `with clock as (select public.silo_business_today() as today),
      bounds as (select today, (date_trunc('month',today)-interval '17 months')::date as start_date,
        (date_trunc('month',today)+interval '13 months')::date as end_date from clock),
      locations as (select id, public.silo_location_slug(coalesce(nullif(location_code,''),location_name)) as tag,
        count(*) over (partition by public.silo_location_slug(coalesce(nullif(location_code,''),location_name))) as tag_count
        from public.locations where company_entity_id=${company}),
      plans as (select p.projection_date as plan_date, p.location_id,
        case when l.tag_count=1 then l.tag end as location_tag,
        sum(p.projected_sales) as planned_sales, sum(p.projected_units) as planned_units,
        max(p.updated_at) as updated_at, count(*) as plan_rows
        from public.revenue_projections p cross join bounds b left join locations l on l.id=p.location_id
        where p.company_entity_id=${company} and p.scenario='active'
          and p.projection_date>=b.start_date and p.projection_date<b.end_date
        group by p.projection_date,p.location_id,l.tag,l.tag_count),
      actual as (select s.day_date as actual_date, s.location_tag,
        sum(s.total_net_sales) as actual_net_sales, sum(s.total_sales) as actual_total_sales
        from public.wow_sales_daily_type_v s cross join bounds b
        where s.company_entity_id=${company} and s.day_date>=b.start_date and s.day_date<b.today
        group by s.day_date,s.location_tag),
      joined as (select p.*, a.actual_date, a.location_tag as actual_location_tag,
        a.actual_net_sales,a.actual_total_sales
        from plans p full outer join actual a on a.actual_date=p.plan_date and a.location_tag=p.location_tag)
      select to_char(coalesce(j.plan_date,j.actual_date),'YYYY-MM') as month,
        (select today from bounds) as business_date, sum(j.planned_sales) as planned_sales,
        sum(j.planned_units) as projected_units, sum(j.actual_net_sales) as actual_net_sales,
        sum(j.actual_total_sales) as actual_total_sales,
        count(distinct j.plan_date) as planned_days, count(distinct j.actual_date) as actual_days,
        count(distinct j.location_id) as planned_locations, max(j.actual_date) as actual_through,
        max(j.updated_at) as updated_at,
        count(*) filter (where j.plan_date is not null) as planned_location_days,
        count(*) filter (where j.plan_date is not null and j.location_tag is null) as unmapped_plan_rows,
        count(*) filter (where j.actual_date is not null and j.plan_date is null) as unplanned_actual_location_days,
        count(*) filter (where j.plan_date < (select today from bounds) and j.actual_date is null) as missing_actual_plan_location_days,
        count(distinct j.actual_date) filter (where j.plan_date is not null) as matched_days,
        count(*) filter (where j.plan_date is not null and j.actual_date is not null) as matched_location_days,
        sum(j.planned_sales) filter (where j.actual_date is not null) as matched_planned_sales,
        sum(j.actual_net_sales) filter (where j.plan_date is not null) as matched_actual_net_sales
        from joined j group by to_char(coalesce(j.plan_date,j.actual_date),'YYYY-MM') order by month`,
  };
}

const nullable = (row, key) => parseReportNumber(row[key]);
export function parseRevenuePlan(rows) {
  const result = source('Active revenue plan and recorded sales', { rows, count: rows.length, monthly: [], plans: [] });
  result.warnings = [
    'The saved plan contains daily projected sales and units only. It has no documented currency, sales definition, margin or cash-collection assumptions.',
    'Recorded actuals are Shopify net and total sales, not QBO revenue. Plan-versus-actual amounts are diagnostic; their measurement basis has not been reconciled.',
    'Actuals exclude the current company day. Missing daily/location records remain missing, not zero; only unambiguous location mappings are matched.',
    'Window: 18 calendar months through the current month, plus 12 future plan months. Current active plan only; this is not the original budget version.',
  ];
  if (!rows.length) return result;
  result.status = 'partial'; // Measurement basis and plan currency are genuinely not stored.
  result.monthly = rows.map((row) => {
    requireCounts(row, ['planned_days','actual_days','planned_locations','planned_location_days','unmapped_plan_rows','unplanned_actual_location_days','missing_actual_plan_location_days','matched_days','matched_location_days']);
    if (!/^\d{4}-\d{2}$/.test(row.month || '') || !date(row.business_date)) throw new Error('Revenue plan returned invalid dates');
    return { month: row.month, plannedSales: nullable(row,'planned_sales'), projectedUnits: nullable(row,'projected_units'),
      actualNetSales: nullable(row,'actual_net_sales'), actualTotalSales: nullable(row,'actual_total_sales'),
      plannedDays: Number(row.planned_days), actualDays: Number(row.actual_days), locations: Number(row.planned_locations),
      plannedLocationDays: Number(row.planned_location_days), actualThrough: row.actual_through || null,
      matchedDays: Number(row.matched_days), matchedLocationDays: Number(row.matched_location_days),
      matchedPlannedSales: nullable(row,'matched_planned_sales'), matchedActualNetSales: nullable(row,'matched_actual_net_sales'),
      unmappedPlanRows: Number(row.unmapped_plan_rows), unplannedActualLocationDays: Number(row.unplanned_actual_location_days),
      missingActualPlanLocationDays: Number(row.missing_actual_plan_location_days),
      completeMonth: row.month < row.business_date.slice(0,7), comparisonEligible: false, updatedAt: row.updated_at || null };
  });
  result.asOf = rows.map((row) => row.actual_through).filter(Boolean).sort().at(-1) || null;
  result.businessDate = rows[0].business_date;
  const planned = result.monthly.filter((row) => row.plannedLocationDays > 0);
  if (planned.length) result.plans = [{ id: 'active', name: 'Active revenue plan', status: 'active', currency: null,
    updatedAt: planned.map((row) => row.updatedAt).filter(Boolean).sort().at(-1) || null,
    monthly: planned.map((row) => ({ month: row.month, revenue: row.plannedSales, projectedUnits: row.projectedUnits, plannedDays: row.plannedDays, locations: row.locations })) }];
  result.metrics = [metric('Months with saved revenue plan', planned.length), metric('Months with recorded actuals', result.monthly.filter((row) => row.actualDays > 0).length)];
  return result;
}

export function parsePurchaseOrderExposure(row) {
  requireCounts(row, ['placed_count']);
  const placed = row.placed || [], arrivals = row.arrival_months || [];
  if (!Array.isArray(placed) || !Array.isArray(arrivals)) throw new Error('PO exposure returned invalid detail arrays');
  const counts = (item, bucket = false) => {
    requireCounts(item, ['line_count','missing_cost_lines','zero_cost_lines','negative_cost_lines','negative_quantity_lines', ...(bucket ? ['po_count','pos_without_lines'] : [])]);
    return { lineCount: Number(item.line_count), missingCostLines: Number(item.missing_cost_lines), zeroCostLines: Number(item.zero_cost_lines),
      negativeCostLines: Number(item.negative_cost_lines), negativeQuantityLines: Number(item.negative_quantity_lines),
      units: nullable(item,'units'), knownEstimatedCost: nullable(item,'known_estimated_cost'),
      costComplete: Number(item.line_count) > 0 && !Number(item.missing_cost_lines) && !Number(item.zero_cost_lines) && !Number(item.negative_cost_lines) && !Number(item.negative_quantity_lines) && (!bucket || !Number(item.pos_without_lines)) };
  };
  if (Number(row.placed_count) < placed.length || (Number(row.placed_count) > 0 && !placed.length)) throw new Error('PO detail counts do not match the result');
  return { placedCount: Number(row.placed_count), placedTruncated: placed.length > 200 || Number(row.placed_count) > placed.length,
    placed: placed.slice(0,200).map((item) => ({ id: item.id, name: item.po_name || null, status: item.status,
      orderDate: date(item.order_date), arrivalDate: date(item.expected_arrival_date), updatedAt: item.updated_at || null, ...counts(item) })),
    arrivalMonths: arrivals.map((item) => ({ month: item.month || null, poCount: Number(item.po_count), posWithoutLines: Number(item.pos_without_lines), ...counts(item, true) })),
  };
}

async function enrichBusinessSource(db, companyId, sourceResult, key, signal) {
  try {
    const { data } = await queryResult(db.rpc('chat_run_readonly_query', { query: businessQueries(companyId)[key], p_offset: 0 }), signal);
    if (key === 'inventoryByType') {
      sourceResult.byProductType = data.slice(0,100).map((row) => {
        requireCounts(row, ['row_count','sku_count','missing_value_rows','zero_value_rows']);
        return { productType: row.product_type || 'Unclassified', rowCount: Number(row.row_count), skuCount: Number(row.sku_count),
          units: nullable(row,'units'), knownRecordedValue: nullable(row,'known_recorded_value'), missingValueRows: Number(row.missing_value_rows),
          zeroValueRows: Number(row.zero_value_rows), oldestSnapshot: row.oldest_snapshot || null, newestSnapshot: row.newest_snapshot || null };
      });
      sourceResult.breakdownTruncated = data.length > 100;
      sourceResult.warnings.push('Inventory detail groups current on-hand units by product type. Recorded value is not independently validated cost or eligible collateral; source currency is not stored.');
      if (sourceResult.breakdownTruncated) sourceResult.warnings.push('Product-type detail is limited to the 100 largest unit groups; summary metrics still cover all visible inventory.');
    } else {
      if (data.length !== 1) throw new Error('PO exposure did not return one summary');
      Object.assign(sourceResult, parsePurchaseOrderExposure(data[0]));
      sourceResult.warnings.push('Placed exposure uses existing approved/in-production/transit statuses. Quantities are ordered units, including full quantities on partially received POs; they are not remaining receipts or unpaid balances. Arrival months never imply payment dates.');
      if (sourceResult.placedTruncated) sourceResult.warnings.push('PO detail is limited to 200 orders; arrival buckets still cover all visible placed orders.');
    }
    return sourceResult;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    sourceResult.detailError = { code: error.code || 'DETAIL_READ_FAILED', message: error.message || 'Business detail could not be read' };
    sourceResult.warnings.push(`Additional business detail could not be read: ${sourceResult.detailError.message}`);
    if (sourceResult.status !== 'error') sourceResult.status = 'partial';
    return sourceResult;
  }
}
