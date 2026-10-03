/** Quick look: three typed inputs, everything else from the books.
 *
 * The detailed workflow asks an analyst to document every assumption. This
 * module answers the question most people actually have -- "can the business
 * carry this loan?" -- from what the saved QuickBooks statements already say,
 * and says plainly which facts the answer rests on and how old they are.
 *
 * Pure: no DOM access, no network. Everything comes in through `quickLook()`.
 *
 * Rules, deliberately simple and printed on the page:
 *   - The payment is the amortizing monthly payment at the typed rate and term.
 *   - The basis is average monthly operating cash flow over the complete months
 *     in the saved cash-flow statement (up to 12), or net operating income from
 *     the P&L when no cash-flow statement is saved. Fewer than 3 complete months
 *     is not enough to judge.
 *   - Combined service = new payment + the monthly payments typed for ticked
 *     existing debts. Share of basis <= 25% reads comfortable, <= 50% tight,
 *     above that does not fit; a non-positive basis does not fit.
 *   - A ticked debt with no payment typed caps the verdict at "tight": a payment
 *     nobody has entered is not a payment of zero.
 * Nothing here is an approval, covenant test or lender policy. */
import { buildDebtSchedule } from './scenario-model.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = v => Number.isFinite(v);
const num = v => { if (typeof v === 'number') return finite(v) ? v : null; const s = String(v ?? '').trim(); if (!s || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return null; const n = Number(s); return finite(n) ? n : null; };
const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;

export const QUICK_RULES = Object.freeze({ comfortableShare: .25, tightShare: .5, minimumMonths: 3, trailingMonths: 12 });

/** Which balance-sheet account types are offered as existing debt, and whether
 * they start ticked. Long-term liabilities and credit cards usually are debt;
 * other current liabilities are usually payables, tax and deferred revenue, so
 * they start unticked and a person opts them in. Account TYPE is metadata
 * QuickBooks maintains; names are never parsed. */
const DEBT_TYPES = {
  'Long Term Liability': { include: true, kind: 'loan' }, LongTermLiability: { include: true, kind: 'loan' },
  'Credit Card': { include: true, kind: 'loc' }, CreditCard: { include: true, kind: 'loc' },
  'Other Current Liability': { include: false, kind: 'loan' }, OtherCurrentLiability: { include: false, kind: 'loan' },
};

/** Draft the existing-debt list from balance-sheet accounts, keeping any
 * tick or payment the person already entered for the same account id. */
export function draftQuickDebts(accountOptions = [], previous = [], { accountHistory = [], asOfMonth = null } = {}) {
  const prior = new Map((previous || []).map(d => [d.id, d]));
  // When a month is chosen, each account's balance is that month's column of
  // the same balance sheet; otherwise the statement's latest column.
  const dated = new Map();
  if (asOfMonth) for (const h of accountHistory || []) {
    const v = (h.values || []).find(x => String(x.periodEnd || '').slice(0, 7) === asOfMonth);
    if (v) dated.set(`${h.connectionId}:${h.accountId}`, { balance: !h.ambiguous && finite(v.balance) ? v.balance : null, asOf: v.periodEnd });
  }
  const options = [...(accountOptions || [])];
  // A failed refresh must not erase a previously classified obligation.
  for (const d of previous || []) if (!options.some(a => a.id === d.id)) options.push({ ...d, balance: null, balanceAsOf: null, balanceCurrency: null });
  return options
    .map(a => { const d = asOfMonth && dated.has(a.id) ? dated.get(a.id) : { balance: asOfMonth && String(a.balanceAsOf || '').slice(0, 7) !== asOfMonth ? null : a.balance, asOf: a.balanceAsOf || null }; return { a, balance: d.balance, asOf: d.asOf }; })
    .filter(({ a, balance }) => (DEBT_TYPES[a.accountType] || prior.has(a.id)) && (!finite(balance) || balance > 0))
    .sort((x, y) => (y.balance ?? -1) - (x.balance ?? -1))
    .map(({ a, balance, asOf }) => {
      const p = prior.get(a.id), rule = DEBT_TYPES[a.accountType] || { include: false, kind: p?.kind || 'loan' };
      return { id: a.id, label: a.label || a.id, accountType: a.accountType, kind: rule.kind, balance: finite(balance) ? balance : null, asOf: finite(balance) ? asOf : null, currency: a.balanceCurrency || null,
        include: p ? p.include === true : rule.include, monthlyPayment: p && finite(p.monthlyPayment) && p.monthlyPayment >= 0 ? p.monthlyPayment : null };
    });
}

/** Source completeness is distinct from a person's decision to exclude a row. */
export function quickDebtCoverage(snapshot, debts = [], asOfMonth = null) {
  const sources = snapshot?.sources || {}, reasons = [];
  for (const [key, label] of [['accounts', 'QBO account mapping'], ['balanceSheet', 'Balance sheet']]) {
    const source = sources[key];
    if (source?.status !== 'available' || source.truncated || source.scopeFiltered) reasons.push(`${label} coverage is incomplete (${source?.status || 'not loaded'}).`);
  }
  const unknown = draftQuickDebts(snapshot?.accountOptions || [], debts, { accountHistory: sources.balanceSheet?.accountHistory, asOfMonth }).filter(d => !finite(d.balance));
  if (unknown.length) reasons.push(`${unknown.length} liability account${unknown.length === 1 ? ' has' : 's have'} an unknown book balance: ${unknown.map(d => d.label || d.id).join(', ')}. Excluding a row does not resolve missing source coverage.`);
  return { complete: reasons.length === 0, unknownBalanceCount: unknown.length, reasons };
}

const monthOf = r => String(r?.month || r?.periodStart || r?.periodEnd || '').slice(0, 7);
/** The statement months a reader can date the Quick look to: complete months
 * on the saved balance sheet, oldest first. Empty when the balance sheet has
 * no monthly columns (then everything reads from its headline column). */
export function quickMonthOptions(snapshot) {
  const rows = snapshot?.sources?.balanceSheet?.monthly || [];
  return [...new Set(rows.filter(r => r.completeMonth && monthOf(r)).map(monthOf))].sort();
}
export function resolveAsOfMonth(snapshot, requested) {
  const options = quickMonthOptions(snapshot);
  if (!options.length) return { month: null, options, requested: requested || null, honoured: !requested };
  const month = options.includes(requested) ? requested : options.at(-1);
  return { month, options, requested: requested || null, honoured: !requested || month === requested };
}
function trailing(rows, key, max = QUICK_RULES.trailingMonths, upTo = null) {
  const complete = (rows || []).filter(r => r.completeMonth && finite(r[key]) && (!upTo || monthOf(r) <= upTo)).slice(-max);
  if (!complete.length) return { months: 0, total: null, average: null, from: null, to: null };
  const total = complete.reduce((t, r) => t + r[key], 0);
  const label = r => String(r.month || r.periodStart || '').slice(0, 7);
  return { months: complete.length, total: round2(total), average: round2(total / complete.length), from: label(complete[0]), to: label(complete.at(-1)) };
}
const latestRow = rows => (rows || []).slice().sort((a, b) => String(a.periodEnd || a.month).localeCompare(String(b.periodEnd || b.month))).at(-1);
const metric = (source, label) => source?.scopeFiltered ? null : source?.metrics?.find(m => m.label === label)?.value ?? null;

export function quickLook({ snapshot, inputs = {}, debts = [], month, asOfMonth = null } = {}) {
  const sources = snapshot?.sources || {}, pl = sources.profitAndLoss || {}, bs = sources.balanceSheet || {}, cf = sources.cashflow || {};
  const amount = num(inputs.amount), rate = num(inputs.rate), term = num(inputs.term);
  const asOf = resolveAsOfMonth(snapshot, asOfMonth);
  const column = asOf.month ? (bs.monthly || []).find(r => monthOf(r) === asOf.month) : null;
  // Once a monthly column is in use, a field it lacks stays UNKNOWN. The
  // headline metric is another period's figure and may only stand in when the
  // statement has no monthly columns at all.
  const b = column || (asOf.month ? {} : latestRow(bs.monthly) || {});
  const fromColumn = (key, headline) => finite(b[key]) ? b[key] : column ? null : metric(bs, headline);
  const currency = bs.currency || pl.currency || cf.currency || null;
  const facts = {
    currency, asOfMonth: asOf.month, asOfOptions: asOf.options, asOfHonoured: asOf.honoured,
    openingCash: { value: fromColumn('bookCash', 'Book bank balances'), asOf: b.periodEnd || bs.periodEnd || null, source: 'QuickBooks balance sheet · bank accounts' },
    totalAssets: { value: fromColumn('assets', 'Total assets'), asOf: b.periodEnd || bs.periodEnd || null, source: 'QuickBooks balance sheet' },
    revenue: trailing(pl.monthly, 'revenue', QUICK_RULES.trailingMonths, asOf.month), grossProfit: trailing(pl.monthly, 'grossProfit', QUICK_RULES.trailingMonths, asOf.month), operatingIncome: trailing(pl.monthly, 'operatingIncome', QUICK_RULES.trailingMonths, asOf.month),
    operatingCash: trailing(cf.monthly, 'operating', QUICK_RULES.trailingMonths, asOf.month),
  };
  const included = (debts || []).filter(d => d.include === true);
  const debtCoverage = quickDebtCoverage(snapshot, debts, asOf.month);
  const knownDebt = round2(included.reduce((t, d) => t + (finite(d.balance) ? d.balance : 0), 0));
  const existingDebt = debtCoverage.complete ? knownDebt : null;
  const knownPayments = included.filter(d => finite(d.monthlyPayment) && d.monthlyPayment >= 0);
  const knownExisting = round2(knownPayments.reduce((t, d) => t + d.monthlyPayment, 0));
  const unknownPaymentCount = included.length - knownPayments.length;

  const errors = [];
  let payment = null, totalInterest = null, maturityMonth = null;
  const inputsComplete = amount !== null && rate !== null && term !== null;
  if (inputsComplete) {
    const s = buildDebtSchedule({ principal: amount, annualRatePct: rate, termMonths: term, frequency: 'monthly', repayment: 'amortizing', startMonth: month, upfrontFees: 0 });
    if (s.errors.length) errors.push(...s.errors);
    else { payment = s.summary.periodicPayment; totalInterest = s.summary.totalInterest; maturityMonth = s.rows.at(-1)?.month || null; }
  }
  const basis = facts.operatingCash.months >= QUICK_RULES.minimumMonths
    ? { key: 'operatingCash', label: 'operating cash flow', source: 'QuickBooks cash flow statement', ...facts.operatingCash }
    : facts.operatingIncome.months >= QUICK_RULES.minimumMonths
      ? { key: 'operatingIncome', label: 'net operating income', source: 'QuickBooks profit and loss', ...facts.operatingIncome }
      : null;
  const combined = payment !== null ? round2(payment + knownExisting) : null;
  const assets = facts.totalAssets.value;
  const ratios = {
    serviceShare: combined !== null && basis && basis.average > 0 ? combined / basis.average : null,
    grossProfitShare: combined !== null && facts.grossProfit.average > 0 ? combined / facts.grossProfit.average : null,
    cashCoverMonths: debtCoverage.complete && combined > 0 && finite(facts.openingCash.value) ? facts.openingCash.value / combined : null,
    debtToAssetsBefore: finite(existingDebt) && finite(assets) && assets > 0 ? existingDebt / assets : null,
    debtToAssetsAfter: finite(existingDebt) && finite(assets) && assets > 0 && amount !== null ? (existingDebt + amount) / (assets + amount) : null,
  };

  const reasons = [];
  let status, title;
  if (errors.length) { status = 'unknown'; title = 'Check the loan inputs'; reasons.push(...errors); }
  else if (payment === null) { status = 'unknown'; title = 'Enter an amount, rate and term'; reasons.push('The quick look needs all three to compute a payment.'); }
  else if (!basis) { status = 'unknown'; title = 'Not enough saved history to judge'; reasons.push(`Fewer than ${QUICK_RULES.minimumMonths} complete months of operating results are in the saved statements. Pull a monthly cash-flow or P&L report in QuickBooks Reports first.`); }
  else if (basis.average <= 0) { status = 'no'; title = 'Does not fit on recent results'; reasons.push(`Average monthly ${basis.label} was ${basis.average <= 0 && basis.average !== 0 ? 'negative' : 'zero'} over ${basis.months} months (${basis.from} to ${basis.to}), so there is no recurring cash to pay this from.`); }
  else {
    const share = ratios.serviceShare;
    status = share <= QUICK_RULES.comfortableShare ? 'comfortable' : share <= QUICK_RULES.tightShare ? 'tight' : 'no';
    title = { comfortable: 'Looks comfortable on recent results', tight: 'Tight on recent results', no: 'Does not fit on recent results' }[status];
    reasons.push(`${pct(share)} of average monthly ${basis.label} (${basis.months} months, ${basis.from} to ${basis.to}) would go to ${knownExisting > 0 ? 'this payment plus the existing payments you entered' : 'this payment'}. Comfortable is up to ${pct(QUICK_RULES.comfortableShare)}, tight up to ${pct(QUICK_RULES.tightShare)}.`);
    if (unknownPaymentCount > 0 && status === 'comfortable') { status = 'tight'; title = 'Tight until existing payments are known'; }
    if (unknownPaymentCount > 0) reasons.push(`${unknownPaymentCount} ticked debt${unknownPaymentCount === 1 ? ' has' : 's have'} no monthly payment entered, so the real combined service is higher than shown.`);
    if (finite(ratios.cashCoverMonths) && ratios.cashCoverMonths < 1) reasons.push(`Book bank balances cover less than one month of combined payments (${ratios.cashCoverMonths.toFixed(1)} months).`);
  }
  if (!debtCoverage.complete) {
    if (status === 'comfortable' || status === 'tight') { status = 'unknown'; title = 'Existing debt coverage is incomplete'; }
    reasons.push(...debtCoverage.reasons, 'Combined payments are only the entered subtotal; funding capacity cannot be established from incomplete debt coverage.');
  }
  if (!finite(facts.openingCash.value)) reasons.push(column ? `The ${asOf.month} balance-sheet column has no bank-balance total; opening cash is unknown rather than another month's figure.` : 'Opening cash is not available from the saved balance sheet.');
  if (column && !finite(facts.totalAssets.value)) reasons.push(`The ${asOf.month} balance-sheet column has no total-assets figure; debt to assets is unknown rather than another month's figure.`);
  if (!asOf.honoured) reasons.push(`${asOf.requested} is not a complete month on the saved balance sheet; figures are as of ${asOf.month}.`);
  if (basis && basis.key === 'operatingIncome') reasons.push('No saved cash-flow statement, so the basis is net operating income, which is not cash.');

  return {
    inputs: { amount, rate, term, purpose: String(inputs.purpose ?? '') }, inputsComplete, month: month || null,
    payment, totalInterest, maturityMonth, existingDebt, knownDebt, debtCoverage, knownExisting, unknownPaymentCount, includedCount: included.length,
    combinedService: combined, basis, facts, ratios, verdict: { status, title, reasons }, errors,
    methodology: [
      'Payment: amortizing monthly payment at the typed rate and term; no fees, no balloon.',
      `Basis: average monthly ${basis ? basis.label : 'operating cash flow'} over complete months in the saved statements (up to ${QUICK_RULES.trailingMonths}). Partial months are excluded.`,
      `Verdict: combined monthly service as a share of that basis -- comfortable up to ${pct(QUICK_RULES.comfortableShare)}, tight up to ${pct(QUICK_RULES.tightShare)}. A ticked debt with no payment entered caps the verdict at tight. Incomplete debt source coverage prevents a positive verdict.`,
      'Existing debt: balance-sheet accounts typed as long-term liability, credit card or other current liability, ticked by you. Balances are book balances as of the statement date; payments are only what you typed.',
      `As-of month: ${asOf.month ? `${asOf.month}; balance-sheet figures and debt balances are that month's column and averages run up to it` : 'the statement\'s latest column (no monthly columns are saved)'}. The Advanced register always reads the latest statement balance.`,
      'This is a quick read of saved QuickBooks snapshots, not an approval, covenant test or lender policy. The advanced workflow is where documented assumptions and full schedules live.',
    ],
  };
}

const pct = v => finite(v) ? `${Math.round(v * 1000) / 10}%` : '—';
const date = v => v ? String(v).slice(0, 10) : 'date unknown';

export function quickFactsHtml(result, money) {
  const f = result.facts;
  const span = (title, value, note) => `<div><span>${esc(title)}</span><strong>${value}</strong><small>${esc(note)}</small></div>`;
  const avg = (t, label) => t.months ? span(label, money(t.average, true), `Average of ${t.months} complete months · ${t.from} to ${t.to}`) : span(label, '—', 'No complete months in the saved statement');
  return span('Book bank balances', money(f.openingCash.value, true), `${f.openingCash.source} · ${date(f.openingCash.asOf)}`)
    + span('Total assets', money(f.totalAssets.value, true), `${f.totalAssets.source} · ${date(f.totalAssets.asOf)}`)
    + avg(f.revenue, 'Monthly revenue') + avg(f.grossProfit, 'Monthly gross profit')
    + avg(f.operatingCash, 'Monthly operating cash flow') + avg(f.operatingIncome, 'Monthly net operating income')
    + span(result.debtCoverage.complete ? 'Existing debt ticked below' : 'Existing debt total unknown', money(result.existingDebt, true), `${result.includedCount} account${result.includedCount === 1 ? '' : 's'} · ${result.unknownPaymentCount ? `${result.unknownPaymentCount} without a payment entered` : 'payments entered'}`)
    + span('Currency', esc(f.currency || 'not stated'), 'From the statement headers');
}

export function quickResultHtml(result, money) {
  const r = result.ratios, kpi = (label, value, note, tone = '') => `<div><div class="uw-kpi-label">${esc(label)}</div><div class="uw-kpi-value ${tone}">${value}</div><div class="uw-kpi-note">${esc(note)}</div></div>`;
  const tone = result.verdict.status === 'no' ? 'uw-negative' : result.verdict.status === 'comfortable' ? 'uw-positive' : '';
  return kpi('Monthly payment', money(result.payment), result.payment !== null ? `${result.inputs.term} months · total interest ${money(result.totalInterest)} · last payment ${result.maturityMonth || '—'}` : 'Enter amount, rate and term')
    + kpi('Share of monthly cash', pct(r.serviceShare), result.basis ? `Entered payment${result.debtCoverage.complete ? 's' : ' subtotal (incomplete debt coverage)'} ÷ average ${result.basis.label}` : 'Needs 3+ complete months of statements', tone)
    + kpi('Months of cash cover', finite(r.cashCoverMonths) ? r.cashCoverMonths.toFixed(1) : '—', result.debtCoverage.complete ? 'Book bank balances ÷ combined monthly payments' : 'Needs complete debt coverage')
    + kpi('Debt to assets after loan', pct(r.debtToAssetsAfter), finite(r.debtToAssetsBefore) ? `${pct(r.debtToAssetsBefore)} today on ticked debt` : result.debtCoverage.complete ? 'Needs total assets' : 'Needs complete debt coverage');
}

export function quickVerdictHtml(result) {
  const v = result.verdict;
  return `<div class="uw-verdict uw-verdict--${esc(v.status)}" role="status" aria-live="polite"><strong>${esc(v.title)}</strong>${v.reasons.map(x => `<p>${esc(x)}</p>`).join('')}</div>`;
}

export function quickDebtsHtml(debts, money, { editable = true } = {}) {
  if (!debts.length) return '<p class="uw-data-warning">No liability accounts with a positive or unknown balance are listed. This alone does not establish zero debt; check source coverage.</p>';
  const rows = debts.map(d => `<tr class="${d.include ? '' : 'uw-quick-debt-off'}"><td>${editable ? `<label class="uw-checkbox"><input type="checkbox" data-quick-debt="${esc(d.id)}" data-field="include" ${d.include ? 'checked' : ''} aria-label="Count ${esc(d.label)} as debt">${esc(d.label)}</label>` : `${d.include ? '✓' : '○'} ${esc(d.label)}`}<span class="uw-subcell">${esc(d.accountType)}</span></td><td>${finite(d.balance) ? money(d.balance) : 'Unknown — no matched balance'}</td><td>${esc(date(d.asOf))}</td><td>${editable ? `<input type="number" step="any" min="0" class="bcn-field" data-quick-debt="${esc(d.id)}" data-field="monthlyPayment" value="${d.monthlyPayment ?? ''}" placeholder="Not entered" aria-label="Monthly payment for ${esc(d.label)}" ${d.include ? '' : 'disabled'}>` : (finite(d.monthlyPayment) ? money(d.monthlyPayment) : 'Not entered')}</td></tr>`);
  return `<div class="uw-table-wrap"><table class="uw-table uw-quick-debts"><thead><tr><th>Balance-sheet account</th><th>Book balance</th><th>As of</th><th>Monthly payment</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** The draft proposal: what you hand an underwriter. Assembled ENTIRELY from the
 * loaded sources plus the three typed inputs -- no manual assumptions -- so it
 * is ready the moment the page loads. Every section names its source and date;
 * a source that did not load says so instead of printing nothing. */
const SOURCE_NAMES = { accounts: 'QBO account mapping', profitAndLoss: 'Profit and loss (QuickBooks)', balanceSheet: 'Balance sheet (QuickBooks)', cashflow: 'Cash flow statement (QuickBooks)', bank: 'Bank balances (Plaid feed)', inventory: 'Inventory on hand (Shopify sync)', purchaseOrders: 'Purchase orders (SILO PO Builder)', revenuePlan: 'Sales plan and recorded sales (SILO)' };
const STATUS_WORDS = { available: 'loaded', partial: 'partial coverage', missing: 'not available', error: 'read failed' };
const pctOf = (a, b) => finite(a) && finite(b) && b !== 0 ? `${(a / b * 100).toFixed(1)}%` : '—';
const n0 = v => finite(v) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v) : '—';
const table = (headers, rows, empty) => `<table class="uw-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}">${esc(empty)}</td></tr>`}</tbody></table>`;
const td = cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
// A bank row carries its own currency; it is formatted in THAT currency or, when
// the row has none, as a plain number -- never in the statement currency.
const bankAmount = (value, currency) => !finite(value) ? '—' : /^[A-Z]{3}$/.test(currency || '') ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value) : `${n0(value)} (currency not recorded)`;
const missingNote = (source, name) => source?.status === 'available' || source?.status === 'partial' ? '' : `<p class="uw-data-warning">${esc(name)}: ${esc(STATUS_WORDS[source?.status] || 'not loaded')}${source?.error?.message ? ` (${esc(source.error.message)})` : ''}.</p>`;

export function quickProposalHtml({ result, debts, snapshot, money, companyTitle, preparedAt }) {
  const sources = snapshot?.sources || {}, pl = sources.profitAndLoss || {}, bs = sources.balanceSheet || {}, cf = sources.cashflow || {}, bank = sources.bank || {}, inv = sources.inventory || {}, po = sources.purchaseOrders || {}, plan = sources.revenuePlan || {};
  const f = result.facts, r = result.ratios;
  // Performance: complete P&L months (up to 12) with the cash-flow month beside them.
  const cfByMonth = new Map((cf.monthly || []).filter(x => x.completeMonth).map(x => [String(x.periodStart).slice(0, 7), x.operating]));
  const perf = (pl.monthly || []).filter(x => x.completeMonth && (!f.asOfMonth || monthOf(x) <= f.asOfMonth)).slice(-QUICK_RULES.trailingMonths);
  const sum = key => perf.length && perf.every(x => finite(x[key])) ? perf.reduce((t, x) => t + x[key], 0) : null;
  const revenueTotal = sum('revenue'), gpTotal = sum('grossProfit'), oiTotal = sum('operatingIncome');
  const cfTotal = perf.length && perf.every(x => finite(cfByMonth.get(x.month))) ? perf.reduce((t, x) => t + cfByMonth.get(x.month), 0) : null;
  const perfRows = perf.map(x => td([esc(x.month), money(x.revenue), money(x.grossProfit), pctOf(x.grossProfit, x.revenue), money(x.operatingIncome), finite(cfByMonth.get(x.month)) ? money(cfByMonth.get(x.month)) : '—']));
  if (perf.length) perfRows.push(td([`<strong>${perf.length}-month total</strong>`, `<strong>${money(revenueTotal)}</strong>`, `<strong>${money(gpTotal)}</strong>`, `<strong>${pctOf(gpTotal, revenueTotal)}</strong>`, `<strong>${money(oiTotal)}</strong>`, `<strong>${money(cfTotal)}</strong>`]));
  // Balance sheet: the latest monthly column, or the headline metrics.
  const column = f.asOfMonth ? (bs.monthly || []).find(x => monthOf(x) === f.asOfMonth) : null;
  const b = column || (f.asOfMonth ? {} : latestRow(bs.monthly) || {});
  const bsAsOf = b.periodEnd || bs.periodEnd || null;
  const fromColumn = (key, headline) => finite(b[key]) ? b[key] : column ? null : metric(bs, headline);
  const bsItems = [['Total assets', fromColumn('assets', 'Total assets')], ['Total liabilities', fromColumn('liabilities', 'Total liabilities')], ['Equity', fromColumn('equity', 'Total equity')],
    ['Bank accounts (book)', f.openingCash.value], ['Accounts receivable', b.accountsReceivable], ['Accounts payable', b.accountsPayable], ['Current assets', b.currentAssets], ['Current liabilities', b.currentLiabilities], ['Long-term liabilities', b.longTermLiabilities], ['Credit cards', b.creditCards]];
  const included = (debts || []).filter(d => d.include);
  // Inventory and purchase orders: units and recorded value, arrivals by month.
  const invUnits = metric(inv, 'Reported on-hand units'), groups = (inv.byProductType || []).slice(0, 6);
  const knownInvValue = (inv.byProductType || []).length ? (inv.byProductType || []).reduce((t, g) => t + (finite(g.knownRecordedValue) ? g.knownRecordedValue : 0), 0) : null;
  const arrivals = (po.arrivalMonths || []).slice(0, 8);
  // Sales plan: last six months actual vs plan, next three planned.
  const planRows = (plan.monthly || []).filter(x => finite(x.plannedSales) || finite(x.actualNetSales));
  const today = String(plan.businessDate || '').slice(0, 7);
  const recent = planRows.filter(x => x.month < today).slice(-6), ahead = planRows.filter(x => x.month >= today && finite(x.plannedSales)).slice(0, 3);
  const coverage = Object.entries(SOURCE_NAMES).map(([key, name]) => { const s = sources[key] || {}; return td([esc(name), esc(STATUS_WORDS[s.status] || 'not loaded'), esc(String(s.asOf || s.periodEnd || 'date unknown').slice(0, 10)), esc(s.periodStart ? `${s.periodStart} to ${s.periodEnd || '?'}` : '')]); });
  return `<header><div class="uw-eyebrow">DRAFT FINANCING PROPOSAL · PREPARED FROM SAVED SOURCES</div><h1>${esc(companyTitle || 'Current company')}</h1><p>Prepared ${esc(String(preparedAt).slice(0, 10))} · ${esc(f.currency || 'currency not stated')}${f.asOfMonth ? ` · figures as of ${esc(f.asOfMonth)}` : ''} · draft for an underwriter's review, not an approval or offer</p></header>`
    + `<section><h2>Request</h2><p><strong>${result.inputsComplete ? `${money(result.inputs.amount)} at ${esc(result.inputs.rate)}% over ${esc(result.inputs.term)} months, amortizing monthly` : 'Amount, rate and term not yet entered'}</strong>${result.inputs.purpose ? ` · ${esc(result.inputs.purpose)}` : ''}</p>${quickVerdictHtml(result)}<div class="uw-kpis">${quickResultHtml(result, money)}</div></section>`
    + `<section><h2>Business performance</h2><p class="uw-fine">Complete calendar months in the saved statements, newest ${perf.length ? `${perf[0].month} to ${perf.at(-1).month}` : 'none'}. Operating cash flow is the cash-flow statement's operating total for the same month; it is historical and unnormalized.</p>${missingNote(pl, SOURCE_NAMES.profitAndLoss)}${missingNote(cf, SOURCE_NAMES.cashflow)}${table(['Month', 'Revenue', 'Gross profit', 'Gross margin', 'Operating income', 'Operating cash flow'], perfRows, 'No complete months in the saved P&L')}</section>`
    + `<section><h2>Balance sheet</h2><p class="uw-fine">${esc(SOURCE_NAMES.balanceSheet)} as of ${esc(bsAsOf || 'date unknown')} · ${esc(bs.basis || 'basis not stated')}.</p>${missingNote(bs, SOURCE_NAMES.balanceSheet)}${column && ['assets', 'liabilities', 'equity', 'bookCash'].some(k => !finite(b[k])) ? `<p class="uw-data-warning">The ${esc(f.asOfMonth)} column lacks ${esc([['assets', 'total assets'], ['liabilities', 'total liabilities'], ['equity', 'equity'], ['bookCash', 'bank balances']].filter(([k]) => !finite(b[k])).map(([, l]) => l).join(', '))}; those lines are left out rather than filled from another month.</p>` : ''}${table(['Line', 'Book balance'], bsItems.filter(([, v]) => finite(v)).map(([k, v]) => td([esc(k), money(v)])), 'No balance sheet loaded')}</section>`
    + `<section><h2>Saved bank balances</h2><p class="uw-fine">Balances as last synced from the bank feed (${esc(SOURCE_NAMES.bank)}), each with its own date and connection status. Loading this page does not call the bank; a balance is only as current as its sync date. Not reconciled to the books; a negative balance can be a sweep or line position.</p>${missingNote(bank, SOURCE_NAMES.bank)}${bank.status === 'partial' ? `<p class="uw-data-warning">Bank coverage is partial: ${esc((bank.warnings || []).find(w => /cap|incomplete/i.test(w)) || 'one or more accounts has a missing balance, date, currency, or an inactive or non-production connection.')}</p>` : ''}${table(['Account', 'Current', 'Available', 'Currency', 'Last synced', 'Connection'], (bank.rows || []).map(x => td([esc(x.name || x.id), bankAmount(x.current_balance, x.iso_currency_code), bankAmount(x.available_balance, x.iso_currency_code), esc(x.iso_currency_code || 'not recorded'), esc(String(x.balance_updated_at || '').slice(0, 10) || 'unknown'), esc([x.connection_status || 'status unknown', x.environment && x.environment !== 'production' ? x.environment : null].filter(Boolean).join(' · '))])), 'No bank accounts loaded')}</section>`
    + `<section><h2>Existing debt</h2><p class="uw-fine">Balance-sheet liability accounts ticked as debt (${included.length}), book balances as of the statement date. Monthly payments are only those entered; ${result.unknownPaymentCount ? `${result.unknownPaymentCount} ticked account${result.unknownPaymentCount === 1 ? ' has' : 's have'} none.` : 'all ticked accounts have one.'}</p>${result.debtCoverage.complete ? '' : `<p class="uw-data-warning">Debt coverage incomplete: ${esc(result.debtCoverage.reasons.join(' '))}</p>`}${quickDebtsHtml(debts || [], money, { editable: false })}<p class="uw-fine">Unticked rows are excluded by classification; unknown balances remain unresolved.</p><p><strong>${result.debtCoverage.complete ? `Total ticked debt ${money(result.existingDebt)}` : `Total ticked debt unknown · known balance subtotal ${money(result.knownDebt)}`}</strong> · entered monthly payments ${money(result.knownExisting)} · debt to assets ${pct(r.debtToAssetsBefore)} today, ${pct(r.debtToAssetsAfter)} after the request</p></section>`
    + `<section><h2>Inventory and purchase commitments</h2>${missingNote(inv, SOURCE_NAMES.inventory)}${missingNote(po, SOURCE_NAMES.purchaseOrders)}<p>On hand <strong>${n0(invUnits)}</strong> units as of ${esc(String(inv.asOf || 'date unknown').slice(0, 10))}${finite(knownInvValue) ? ` · recorded value ${n0(knownInvValue)} (currency not recorded) where a value is recorded` : ''} · placed purchase orders <strong>${n0(po.placedCount)}</strong>.</p>${table(['Product group', 'Units', 'Recorded value (currency not recorded)'], groups.map(g => td([esc(g.productType), n0(g.units), n0(g.knownRecordedValue)])), 'No inventory groups loaded')}${table(['Expected arrival', 'POs', 'Units', 'Known line cost (currency not recorded)'], arrivals.map(a => td([esc(a.month || 'No date'), n0(a.poCount), n0(a.units), n0(a.knownEstimatedCost)])), 'No placed purchase orders')}<p class="uw-fine">Inventory values and PO line costs carry no currency in their sources, so they are shown as plain numbers and never in the statement currency. Inventory values are the sync's recorded values, not an appraisal or borrowing base. PO cost is known line cost, not an unpaid balance; arrival months are planning dates, not payment dates.</p></section>`
    + `<section><h2>Sales plan and recorded sales</h2>${missingNote(plan, SOURCE_NAMES.revenuePlan)}${table(['Month', 'Recorded net sales', 'Planned sales', 'Recorded ÷ plan'], recent.map(x => td([esc(x.month), n0(x.actualNetSales), n0(x.plannedSales), pctOf(x.actualNetSales, x.plannedSales)])), 'No recent months')}${ahead.length ? `<p class="uw-fine">Planned ahead: ${ahead.map(x => `${esc(x.month)} ${n0(x.plannedSales)}`).join(' · ')}</p>` : ''}<p class="uw-fine">Recorded sales are Shopify net sales and the plan is the company's active daily sales plan; neither records a currency or a measurement basis, so both are plain numbers here, not statement-currency amounts, and neither is QuickBooks revenue.</p></section>`
    + `<section><h2>Sources and dates</h2>${table(['Source', 'Status', 'As of', 'Period'], coverage, 'No sources')}</section>`
    + `<section><h2>How this was prepared</h2><ul>${result.methodology.map(m => `<li>${esc(m)}</li>`).join('')}<li>Every figure above is read from a saved snapshot named in Sources and dates; nothing was typed except the request and the ticked debts. Loading this page does not refresh QuickBooks, the bank feed or Shopify.</li></ul></section>`;
}

export function quickPrintHtml(args) { return quickProposalHtml(args); }

