import { buildDebtSchedule, calculateFacilityAvailability } from './scenario-model.js';

/** Pure facility register: no account writes, source matching by name, or draws. */
const MAX_FACILITIES = 100;
const MAX_MONTHS = 1200;
const MAX_MONEY = Number.MAX_SAFE_INTEGER / (100 * 1201 * 4);
const intervals = { monthly: 1, quarterly: 3, annual: 12 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) && value >= 0 && value <= MAX_MONEY;
const evidence = value => typeof value === 'string' && value.trim().length > 0;
const text = value => evidence(value) ? value.trim() : null;
const currencyValid = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const monthValid = value => typeof value === 'string' && /^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value);
const monthNumber = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthAt = value => `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
const round = value => Math.round(value * 100) / 100;
const sum = values => round(values.reduce((total, value) => total + value, 0));

function dateOnly(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) return null;
  if (value.length > 10 && !Number.isFinite(Date.parse(value))) return null;
  return date;
}

function previousDay(month) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function unknownRows(months) {
  return months.map(month => ({ month, payment: null, principal: null, interest: null, endingBalance: null }));
}

function paymentRows(input, months, label) {
  const issues = [];
  if (!record(input)) return { rows: unknownRows(months), complete: false, issues: [`${label}: explicit payment schedule is missing.`] };
  const defaultKnown = amount(input.monthlyPayment);
  if (input.monthlyPayment != null && !defaultKnown) issues.push(`${label}: default P&I must be a nonnegative numeric amount; blank is unknown, not zero.`);
  const keyed = record(input.monthlyPayments) ? input.monthlyPayments : {};
  if (!record(input.monthlyPayments)) issues.push(`${label}: monthlyPayments must be an explicit object keyed by YYYY-MM.`);
  if (Object.keys(keyed).length > MAX_MONTHS) issues.push(`${label}: monthlyPayments exceeds ${MAX_MONTHS} entries.`);
  else for (const [month, value] of Object.entries(keyed)) {
    if (!monthValid(month) || !amount(value)) issues.push(`${label}: each keyed payment needs a valid YYYY-MM and explicit nonnegative amount.`);
  }
  const rows = months.map(month => {
    const value = has(keyed, month) ? keyed[month] : defaultKnown ? input.monthlyPayment : null;
    return { month, payment: amount(value) ? round(value) : null, principal: null, interest: null, endingBalance: null };
  });
  const missing = rows.filter(row => row.payment === null);
  if (missing.length) issues.push(`${label}: ${missing.length} month(s) have unknown required P&I; enter each month or an explicit default, including zero.`);
  return { rows, complete: issues.length === 0, issues };
}

function resolveBalance(facility, accounts, scenarioCurrency) {
  const issues = [];
  let balance = null, balanceAsOf = null, balanceCurrency = null, balanceProvenance = null;
  if (facility.balanceSource === 'account') {
    const id = text(facility.accountId);
    const matches = accounts.filter(account => record(account) && account.id === id);
    if (!id) issues.push('Choose an explicit source account ID.');
    else if (matches.length !== 1) issues.push(matches.length ? 'Source account ID is ambiguous in the current source list.' : 'Matched account ID is not present in the current company source list; no name match or stale manual fallback is used.');
    else {
      const account = matches[0];
      balance = amount(account.balance) ? round(account.balance) : null;
      balanceAsOf = dateOnly(account.balanceAsOf);
      balanceCurrency = currencyValid(account.balanceCurrency) ? account.balanceCurrency : null;
      balanceProvenance = `Imported account ${id}${text(account.reportId) ? ` / report ${text(account.reportId)}` : ''}`;
      if (balance === null) issues.push('Matched balance is missing or not nonnegative; its sign is not changed automatically.');
      if (!balanceAsOf) issues.push('Matched balance as-of date is missing or invalid.');
      if (!balanceCurrency) issues.push('Matched balance currency is unknown.');
    }
  } else if (facility.balanceSource === 'manual') {
    balance = amount(facility.manualBalance) ? round(facility.manualBalance) : null;
    balanceAsOf = dateOnly(facility.balanceAsOf);
    balanceCurrency = currencyValid(facility.currency) ? facility.currency : null;
    balanceProvenance = text(facility.balanceProvenance);
    if (balance === null) issues.push('Manual opening balance must be an explicit nonnegative numeric amount, including zero.');
    if (!balanceAsOf) issues.push('Document the manual balance as-of date.');
    if (!balanceProvenance) issues.push('Manual balance source evidence is required.');
  } else issues.push('Choose either an explicit account match or a documented manual balance source.');
  if (!currencyValid(facility.currency)) issues.push('Facility currency is required.');
  if (!currencyValid(scenarioCurrency) || facility.currency !== scenarioCurrency || (balanceCurrency && balanceCurrency !== facility.currency)) issues.push('Facility/source currency must match the scenario currency; no FX conversion is inferred.');
  return { balance, balanceAsOf, balanceCurrency, balanceProvenance, comparable: issues.length === 0, issues };
}

function projectTerms(facility, resolved, months, startMonth) {
  const issues = [];
  const notes = [];
  const empty = () => ({ rows: unknownRows(months), complete: false, maturityMonth: null, remainingBalance: null, issues, notes });
  const terms = facility.terms;
  if (facility.kind !== 'loan') issues.push('LOC cash payments must be explicitly documented; term-loan amortization is not inferred for a revolving facility.');
  if (!record(terms)) { issues.push('Loan terms are missing.'); return empty(); }
  const interval = has(intervals, terms.frequency) ? intervals[terms.frequency] : null;
  if (!interval) issues.push('Loan frequency must be monthly, quarterly or annual.');
  if (!monthValid(terms.firstPaymentMonth) || !monthValid(terms.maturityMonth)) issues.push('Document firstPaymentMonth and maturityMonth as YYYY-MM.');
  if (!resolved.comparable) issues.push('Loan term projection needs a documented comparable opening principal balance.');
  if (resolved.balanceAsOf !== `${startMonth}-01` && resolved.balanceAsOf !== previousDay(startMonth)) issues.push('Term projection requires balance dated on forecast opening day or the preceding day; roll an older balance forward explicitly or use a documented monthly payment schedule.');
  if (terms.repayment === 'balloon' && !Number.isInteger(terms.amortizationMonths)) issues.push('Amortizing balloon terms require explicit remaining amortizationMonths longer than the remaining term; use interest-only for no scheduled principal.');
  if (issues.length) return empty();
  const first = monthNumber(terms.firstPaymentMonth), maturity = monthNumber(terms.maturityMonth);
  const offset = first - monthNumber(startMonth);
  if (offset < 0 || offset > interval) issues.push('First payment must be from forecast start through one regular frequency interval later; prior payments or an unsupported grace/stub period cannot be inferred.');
  if (maturity < first || (maturity - first) % interval !== 0) issues.push('Maturity must be on the first-payment frequency grid, at or after the first payment.');
  if (issues.length) return empty();
  const anchor = monthAt(first - interval);
  const projected = buildDebtSchedule({
    principal: resolved.balance > 0 ? resolved.balance : .01,
    startMonth: anchor, termMonths: maturity - first + interval,
    annualRatePct: terms.annualRatePct, frequency: terms.frequency, repayment: terms.repayment,
    ...(terms.amortizationMonths != null ? { amortizationMonths: terms.amortizationMonths } : {}),
  });
  issues.push(...projected.errors);
  if (issues.length) return empty();
  const byMonth = new Map(projected.rows.map(row => [row.month, row]));
  const rows = months.map(month => {
    const row = byMonth.get(month);
    if (resolved.balance === 0 || month > terms.maturityMonth) return { month, payment: 0, principal: 0, interest: 0, endingBalance: 0 };
    return { month, payment: row.payment, principal: row.principal, interest: row.interest, endingBalance: row.endingBalance };
  });
  notes.push('Existing opening principal is not new funding. Full regular-period nominal interest is assumed at the first and later due months, with no partial-period accrual, fees, variable rates or intervening draws. Schedule review confirms that assumption; use explicit payments otherwise.');
  if (terms.maturityMonth > months.at(-1)) notes.push(`Maturity ${terms.maturityMonth} is outside the cash horizon; future principal/interest remains and is not cash-qualified by this window.`);
  return { rows, complete: true, maturityMonth: terms.maturityMonth, remainingBalance: rows.at(-1).endingBalance, issues, notes };
}

/**
 * Exactly one authority feeds computeScenario.existingDebt:
 * - manual: manualDebt is selected; facilities are reconciliation context only
 * - facilities: reviewed facility payments replace, never add to, manualDebt
 *
 * Facility IDs are stable local identities. accountId is the current source
 * accountOptions.id (already a connection/account composite), never a label.
 * The portfolio complete/provenance attestation covers every obligation in the
 * displayed horizon. Individual scheduleComplete/provenance still apply too.
 */
export function assessFacilityPortfolio(input) {
  const errors = [], warnings = [];
  const result = {
    mode: record(input) ? input.mode : null, facilities: [], rows: [], reconciliation: [],
    existingDebt: { monthlyPayment: null, monthlyPayments: {}, complete: false, provenance: null },
    totalBalance: null, totalCommittedLimit: null, knownAvailable: null, totalAvailable: null,
    availabilityComplete: false, scheduleComplete: false, manualScheduleComplete: false,
    errors, warnings,
    methodology: [
      'Facility IDs and explicit current-source account IDs establish identity. Names never establish a lender, facility type, balance, match or duplication exception.',
      'Manual mode selects only the documented manual aggregate. Facilities mode selects only complete per-facility payments. They are reconciled, never added together.',
      'No undrawn LOC availability is automatically drawn or treated as loan proceeds. A committed limit, a book balance, and lender-reported available cash are different quantities.',
      'LOC availability alone is aggregated, in one currency. Unknown LOC availability makes the portfolio total unknown; knownAvailable is a labeled subtotal and cannot replace that total.',
      'Explicit P&I schedules include all required payments and balloons in the horizon; they do not establish principal/interest splits, residual principal or a maturity date.',
      'Term schedules use documented forecast-opening principal, explicit first payment and aligned maturity, and full regular-interval interest. They do not model loan proceeds, fees, accrued-interest adjustments, variable rates or future LOC draws.',
      'Source dates and documents remain user-reviewed evidence. Source reads are not lender confirmation, a current borrowing-base certification or credit approval.',
    ],
  };
  if (!record(input)) { errors.push('Facility portfolio inputs must be an object.'); return result; }
  if (!['manual', 'facilities'].includes(input.mode)) errors.push('Select exactly one existing-debt mode: manual or facilities.');
  if (!monthValid(input.startMonth)) errors.push('Portfolio startMonth must be YYYY-MM.');
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < 1 || input.horizonMonths > MAX_MONTHS) errors.push(`Portfolio horizonMonths must be an integer between 1 and ${MAX_MONTHS}.`);
  if (!currencyValid(input.currency)) errors.push('Portfolio currency must be explicit.');
  if (!Array.isArray(input.facilities) || input.facilities.length > MAX_FACILITIES) errors.push(`facilities must be an explicit array with at most ${MAX_FACILITIES} entries.`);
  if (monthValid(input.startMonth) && Number.isInteger(input.horizonMonths) && monthNumber(input.startMonth) + input.horizonMonths - 1 > monthNumber('9999-12')) errors.push('Portfolio horizon exceeds the supported calendar range.');
  if (errors.length) return result;
  const months = Array.from({ length: input.horizonMonths }, (_, index) => monthAt(monthNumber(input.startMonth) + index));
  const accounts = Array.isArray(input.accountOptions) ? input.accountOptions : [];
  const idCounts = new Map(), accountCounts = new Map();
  for (const facility of input.facilities) {
    if (!record(facility)) continue;
    const id = text(facility.id);
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    const matchedId = facility.balanceSource === 'account' ? text(facility.accountId) : null;
    if (matchedId) accountCounts.set(matchedId, (accountCounts.get(matchedId) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) if (count > 1) errors.push(`Duplicate stable facility ID: ${id}.`);
  for (const [id, count] of accountCounts) if (count > 1) errors.push(`Duplicate matched source account ID: ${id}; one obligation cannot be entered twice through the same source.`);
  for (const [index, facility] of input.facilities.entries()) {
    if (!record(facility)) {
      errors.push(`Facility ${index + 1} must be an object.`);
      result.facilities.push({ id: null, name: `Facility ${index + 1}`, kind: null, balance: null, balanceAsOf: null, availability: null, availabilityDetail: null, rows: unknownRows(months), scheduleComplete: false, comparable: false, issues: ['Malformed facility entry.'], maturityMonth: null, remainingBalance: null });
      continue;
    }
    const id = text(facility.id);
    const blocks = [];
    if (!id || id.length > 128) blocks.push('A stable facility ID of 1–128 characters is required.');
    if (!['loan', 'loc'].includes(facility.kind)) blocks.push('Choose loan or LOC explicitly; type is not inferred from the account name.');
    if (idCounts.get(id) > 1) blocks.push('Duplicate facility ID prevents aggregation.');
    if (facility.balanceSource === 'account' && accountCounts.get(text(facility.accountId)) > 1) blocks.push('Duplicate matched source account prevents aggregation.');
    const resolved = resolveBalance(facility, accounts, input.currency);
    blocks.push(...resolved.issues);
    const baseComparable = resolved.comparable && blocks.length === 0;
    let projected;
    if (facility.scheduleMode === 'payments') {
      projected = paymentRows(facility, months, id ?? `Facility ${index + 1}`);
      projected.maturityMonth = null;
      projected.remainingBalance = null;
      projected.notes = ['Explicit P&I is not an amortization reconciliation: principal/interest split, remaining principal and maturity remain unknown. Confirm every required balloon/maturity payment in the schedule.'];
    } else if (facility.scheduleMode === 'terms') projected = projectTerms(facility, resolved, months, input.startMonth);
    else projected = { rows: unknownRows(months), complete: false, issues: ['Choose an explicit monthly payment schedule or documented loan terms.'], notes: [], maturityMonth: null, remainingBalance: null };
    if (facility.scheduleComplete !== true) blocks.push('This facility payment schedule is not confirmed complete for the selected horizon.');
    if (!evidence(facility.scheduleProvenance)) blocks.push('Payment schedule or term-source provenance is required.');
    const scheduleComplete = baseComparable && blocks.length === 0 && projected.complete;
    let availability = null, availabilityDetail = null;
    const availabilityIssues = [];
    const availabilityAsOf = dateOnly(facility.availabilityAsOf);
    if (facility.kind === 'loc') {
      availabilityDetail = calculateFacilityAvailability({
        limit: facility.limit, bookDrawn: resolved.balance,
        borrowingBase: facility.borrowingBase, reserves: facility.reserves,
        borrowingBaseProvenance: facility.availabilityProvenance,
        lenderAvailable: facility.lenderAvailable, lenderAvailableProvenance: facility.availabilityProvenance,
      });
      availabilityIssues.push(...availabilityDetail.errors, ...availabilityDetail.warnings);
      if (!availabilityAsOf) availabilityIssues.push('LOC availability needs a valid evidence as-of date.');
      if (!evidence(facility.availabilityProvenance)) availabilityIssues.push('LOC availability needs lender or borrowing-base source evidence.');
      if (baseComparable && availabilityAsOf && evidence(facility.availabilityProvenance)) availability = availabilityDetail.available;
      if (availabilityAsOf && resolved.balanceAsOf && availabilityAsOf !== resolved.balanceAsOf) availabilityIssues.push('Balance and availability evidence dates differ; reconcile the current lender draw and restrictions before using this illustrative availability.');
    }
    result.facilities.push({
      id, name: text(facility.name) ?? `Facility ${index + 1}`, kind: facility.kind,
      balance: resolved.balance, balanceAsOf: resolved.balanceAsOf, currency: resolved.balanceCurrency,
      balanceProvenance: resolved.balanceProvenance, accountId: facility.balanceSource === 'account' ? text(facility.accountId) : null,
      comparable: baseComparable, availability, availabilityDetail, availabilityAsOf,
      committedLimit: facility.kind === 'loc' && amount(facility.limit) && availabilityAsOf && evidence(facility.availabilityProvenance) ? round(facility.limit) : null,
      rows: projected.rows, scheduleComplete, maturityMonth: projected.maturityMonth, remainingBalance: projected.remainingBalance,
      issues: [...new Set([...blocks, ...projected.issues, ...(projected.notes ?? []), ...availabilityIssues])],
    });
  }
  const registerAttested = input.complete === true && evidence(input.provenance);
  const identitiesComplete = result.facilities.every(facility => evidence(facility.id) && facility.id.length <= 128 && ['loan', 'loc'].includes(facility.kind));
  if (!registerAttested) warnings.push('The facility register is not attested complete with provenance; it may omit existing obligations or lines of credit.');
  result.scheduleComplete = registerAttested && errors.length === 0 && result.facilities.every(facility => facility.scheduleComplete);
  const allBalances = result.facilities.every(facility => facility.comparable && amount(facility.balance));
  if (errors.length === 0 && allBalances && (result.facilities.length || registerAttested)) result.totalBalance = sum(result.facilities.map(facility => facility.balance));
  const locs = result.facilities.filter(facility => facility.kind === 'loc');
  if (errors.length === 0 && identitiesComplete && locs.every(facility => facility.comparable && amount(facility.committedLimit)) && (locs.length || registerAttested)) result.totalCommittedLimit = sum(locs.map(facility => facility.committedLimit));
  const knownLocs = locs.filter(facility => facility.comparable && amount(facility.availability));
  if (knownLocs.length) result.knownAvailable = sum(knownLocs.map(facility => facility.availability));
  else if (!locs.length && registerAttested && identitiesComplete && errors.length === 0) result.knownAvailable = 0;
  result.availabilityComplete = registerAttested && identitiesComplete && errors.length === 0 && locs.every(facility => facility.comparable && amount(facility.availability));
  if (result.availabilityComplete) result.totalAvailable = sum(locs.map(facility => facility.availability));
  const manual = paymentRows(input.manualDebt, months, 'Manual aggregate');
  result.manualScheduleComplete = record(input.manualDebt) && input.manualDebt.complete === true && evidence(input.manualDebt.provenance) && manual.complete;
  const derivedPayments = {};
  const manualPayments = {};
  const perMonthFacilityKnown = result.facilities.every(facility => facility.scheduleComplete) && errors.length === 0;
  for (const [index, month] of months.entries()) {
    const byFacility = result.facilities.map(facility => ({ id: facility.id, name: facility.name, payment: facility.rows[index].payment }));
    const facilityPayment = perMonthFacilityKnown && (result.facilities.length || registerAttested) ? sum(byFacility.map(row => row.payment)) : null;
    const manualPayment = manual.rows[index].payment;
    derivedPayments[month] = result.scheduleComplete ? facilityPayment : null;
    manualPayments[month] = manualPayment;
    result.rows.push({ month, payment: facilityPayment, byFacility });
    result.reconciliation.push({ month, facilityPayment, manualPayment, difference: amount(facilityPayment) && amount(manualPayment) ? round(facilityPayment - manualPayment) : null });
  }
  // Aggregating many individually safe numbers can exceed supported money.
  if ([result.totalBalance, result.totalCommittedLimit, result.knownAvailable, result.totalAvailable, ...Object.values(derivedPayments)].some(value => value !== null && !amount(value))) {
    errors.push('Aggregate facility amounts exceed the supported numeric range.');
    result.scheduleComplete = false;
    result.availabilityComplete = false;
    result.totalBalance = result.totalCommittedLimit = result.totalAvailable = result.knownAvailable = null;
    for (const month of months) derivedPayments[month] = null;
  }
  if (input.mode === 'manual') {
    result.existingDebt = { monthlyPayment: null, monthlyPayments: Object.fromEntries(Object.entries(manualPayments).filter(([, payment]) => amount(payment))), complete: result.manualScheduleComplete, provenance: text(input.manualDebt?.provenance) };
    warnings.push('Manual mode: the documented manual aggregate is the only authoritative modeled existing P&I. Facility schedules and their issues are reconciliation context only; they are not added again.');
    if (!result.manualScheduleComplete) warnings.push(...manual.issues, 'Manual aggregate completeness and provenance must be confirmed.');
    if (!result.scheduleComplete) warnings.push('Reference facility schedules are incomplete or unresolved. These issues do not replace or invalidate an independently complete manual aggregate.');
  } else {
    result.existingDebt = { monthlyPayment: null, monthlyPayments: Object.fromEntries(Object.entries(derivedPayments).filter(([, payment]) => amount(payment))), complete: result.scheduleComplete, provenance: text(input.provenance) };
    warnings.push('Facilities mode: the reviewed facility total replaces the manual aggregate; manual values are reconciliation context and are not added.');
    if (!result.scheduleComplete) warnings.push('Facility-derived existing P&I is unavailable until every registered obligation and portfolio completeness check is documented.');
  }
  return result;
}
