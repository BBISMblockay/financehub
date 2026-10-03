/**
 * Pure, illustrative underwriting arithmetic. No source data is fetched here.
 * Amounts are in one caller-selected currency; all numeric inputs must be finite
 * numbers. Empty strings, null, booleans and numeric strings are never zero.
 * Monetary cash flows are rounded to cents. No loan approval, equity valuation,
 * credit-score multiplier or automatic inference from profit/bank cash is made.
 */

const MAX_MONTHS = 1200;
const MAX_MONEY = Number.MAX_SAFE_INTEGER / (100 * (MAX_MONTHS + 1) * 4);
const INTERVALS = Object.freeze({ monthly: 1, quarterly: 3, annual: 12 });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => value !== undefined && value !== null;
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const number = value => typeof value === 'number' && Number.isFinite(value);
const provenance = value => typeof value === 'string' && value.trim().length > 0;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const cents = value => Math.round(value * 100);
const money = value => number(value) && Math.abs(value) <= MAX_MONEY;
const nonnegative = value => money(value) && value >= 0;
const monthValid = value => typeof value === 'string' && /^(?:[1-9]\d{3})-(?:0[1-9]|1[0-2])$/.test(value);
const monthNumber = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthAt = value => `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
const addMonths = (value, count) => monthAt(monthNumber(value) + count);
const validCount = value => Number.isInteger(value) && value > 0 && value <= MAX_MONTHS;
const sum = (rows, key) => round(rows.reduce((result, row) => result + row[key], 0));
const knownSum = (rows, key) => rows.every(row => number(row[key])) ? sum(rows, key) : null;
const ratio = (cash, debt) => number(cash) && number(debt) && debt > 0 ? cash / debt : null;
const evidence = value => provenance(value) ? value.trim() : null;
// A field-keyed map is authoritative: missing evidence must not borrow another
// field's reference. Legacy callers may still explicitly document a whole row.
const overrideEvidence = (row, field) => has(row, 'provenanceByField')
  ? isRecord(row.provenanceByField) ? row.provenanceByField[field] : null
  : row.provenance;
const minKnown = values => values.length ? Math.min(...values) : null;
const monthlyAnnuity = (principal, rate, periods) => rate === 0
  ? principal / periods
  : principal * rate / -Math.expm1(-periods * Math.log1p(rate));

function validateLoan(input, errors) {
  if (!isRecord(input)) {
    errors.push('Debt terms must be an object with explicit principal, rate, term, frequency, repayment and start month.');
    return;
  }
  if (!nonnegative(input.principal) || cents(input.principal) < 1) errors.push('principal must be an explicit positive amount of at least one cent within the supported numeric range.');
  if (!number(input.annualRatePct) || input.annualRatePct < 0) errors.push('annualRatePct must be an explicit nonnegative number; enter 0 for zero interest.');
  if (!validCount(input.termMonths)) errors.push(`termMonths must be an explicit integer between 1 and ${MAX_MONTHS}.`);
  if (!has(INTERVALS, input.frequency)) errors.push('frequency must be monthly, quarterly or annual.');
  if (!['amortizing', 'interest-only', 'balloon'].includes(input.repayment)) errors.push('repayment must be amortizing, interest-only or balloon.');
  if (!monthValid(input.startMonth)) errors.push('startMonth must be YYYY-MM with a valid four-digit year and month.');
  if (validCount(input.termMonths) && has(INTERVALS, input.frequency) && input.termMonths % INTERVALS[input.frequency] !== 0) errors.push('termMonths must align exactly with the payment frequency; stub periods are not modeled.');
  if (present(input.requiredPayment) && (!nonnegative(input.requiredPayment) || cents(input.requiredPayment) < 1)) errors.push('requiredPayment must be a positive total principal-plus-interest amount per payment interval.');
  if (present(input.amortizationMonths)) {
    if (!validCount(input.amortizationMonths)) errors.push(`amortizationMonths must be an integer between 1 and ${MAX_MONTHS}.`);
    else if (has(INTERVALS, input.frequency) && input.amortizationMonths % INTERVALS[input.frequency] !== 0) errors.push('amortizationMonths must align exactly with the payment frequency.');
    if (input.repayment === 'balloon' && input.amortizationMonths <= input.termMonths) errors.push('A balloon amortizationMonths must be longer than termMonths.');
    if (input.repayment === 'amortizing' && input.amortizationMonths !== input.termMonths) errors.push('Amortizing repayment must amortize over termMonths; choose balloon for a longer amortization.');
    if (input.repayment === 'interest-only') errors.push('interest-only repayment cannot also specify amortizationMonths.');
  }
  if (present(input.requiredPayment) && input.repayment === 'interest-only') errors.push('interest-only payments are determined by rate and frequency; requiredPayment would conflict with that definition.');
  if (present(input.requiredPayment) && present(input.amortizationMonths)) errors.push('Specify requiredPayment or amortizationMonths, not both.');
  if (monthValid(input.startMonth) && validCount(input.termMonths) && monthNumber(input.startMonth) + input.termMonths > monthNumber('9999-12')) errors.push('Debt maturity exceeds the supported calendar range.');
}

/**
 * Origination is the start of startMonth. Rows include monthIndex 0 with no
 * service. First payment is exactly 1/3/12 months later; maturity is start+term.
 * Interest is simple nominal annual rate divided by payments per year, on the
 * outstanding balance at that payment interval's start. Intermediate monthly
 * rows show zero CASH interest, not accrued interest. No daily-rate convention,
 * capitalized interest, fees, prepayment penalties or rate changes are assumed.
 *
 * requiredPayment is total P+I per frequency interval, never a monthly amount
 * for quarterly/annual debt. Balloon without an amortization/payment means
 * interest-only plus principal at maturity. Every final residual is included.
 */
export function buildDebtSchedule(input) {
  const errors = [];
  const warnings = [];
  const methodology = [
    'Illustrative fixed-rate cash debt schedule, not a lender quote or approval.',
    'Funding is at the start of startMonth; first payment is one full frequency interval later; final maturity is startMonth plus termMonths.',
    'Interest is nominal annual rate divided by payments per year, on interval-opening principal. Nonpayment months show zero cash interest, not zero accrued interest.',
    'Payments and interest are rounded to cents each due date; the final payment clears remaining principal. No fees, daily accrual convention, capitalization, penalties or variable rates are modeled.',
  ];
  validateLoan(input, errors);
  if (errors.length) return { rows: [], errors, warnings, methodology, summary: null };

  const intervalMonths = INTERVALS[input.frequency];
  const periods = input.termMonths / intervalMonths;
  const periodicRate = input.annualRatePct / 100 * intervalMonths / 12;
  const principalCents = cents(input.principal);
  const principal = principalCents / 100;
  const amortizationPeriods = (input.amortizationMonths ?? input.termMonths) / intervalMonths;
  const isInterestOnly = input.repayment === 'interest-only'
    || (input.repayment === 'balloon' && !present(input.amortizationMonths) && !present(input.requiredPayment));
  let periodicPayment = isInterestOnly
    ? principal * periodicRate
    : monthlyAnnuity(principal, periodicRate, amortizationPeriods);
  if (present(input.requiredPayment)) periodicPayment = input.requiredPayment;
  if (!nonnegative(periodicPayment) || !nonnegative(principal * periodicRate)) {
    errors.push('Computed interest or payment exceeds the supported numeric range.');
    return { rows: [], errors, warnings, methodology, summary: null };
  }
  const paymentCents = cents(periodicPayment);
  if (!isInterestOnly && paymentCents < cents(principal * periodicRate)) errors.push('requiredPayment is less than first-period interest; negative amortization is not supported.');
  if (input.repayment === 'amortizing' && present(input.requiredPayment)
    && input.requiredPayment + .005 < monthlyAnnuity(principal, periodicRate, periods)) {
    errors.push('requiredPayment does not fully amortize the debt within termMonths; use explicit balloon repayment for a residual.');
  }
  if (errors.length) return { rows: [], errors, warnings, methodology, summary: null };
  if (isInterestOnly) methodology.push('Interest-only: all original principal is repaid in one final maturity balloon, including when repayment is balloon with no amortization length or required payment.');
  else if (input.repayment === 'balloon') methodology.push('Balloon: regular principal-plus-interest payments use the longer amortization or explicit periodic payment, followed by all residual principal at contractual maturity.');
  methodology.push(`Payment interval is ${intervalMonths} month(s); requiredPayment, when provided, is total principal plus interest for that interval.`);
  let balanceCents = principalCents;
  let balloonCents = 0;
  let paidOffMonth = null;
  const rows = [];
  for (let index = 0; index <= input.termMonths; index += 1) {
    const openingCents = balanceCents;
    const isPaymentMonth = index > 0 && index % intervalMonths === 0;
    let interestCents = 0;
    let paidPrincipalCents = 0;
    let finalBalloonCents = 0;
    if (isPaymentMonth && balanceCents > 0) {
      interestCents = Math.round(balanceCents * periodicRate);
      const scheduledPrincipal = isInterestOnly ? 0 : Math.min(balanceCents, Math.max(0, paymentCents - interestCents));
      paidPrincipalCents = scheduledPrincipal;
      if (index === input.termMonths) {
        if (input.repayment !== 'amortizing') finalBalloonCents = balanceCents - scheduledPrincipal;
        paidPrincipalCents = balanceCents;
      }
      balanceCents -= paidPrincipalCents;
      if (balanceCents === 0) paidOffMonth = addMonths(input.startMonth, index);
    }
    balloonCents += finalBalloonCents;
    rows.push({
      month: addMonths(input.startMonth, index), monthIndex: index,
      openingBalance: openingCents / 100, principal: paidPrincipalCents / 100,
      interest: interestCents / 100, payment: (paidPrincipalCents + interestCents) / 100,
      endingBalance: balanceCents / 100, isPaymentMonth, balloonPrincipal: finalBalloonCents / 100,
    });
  }
  if (paidOffMonth && paidOffMonth < addMonths(input.startMonth, input.termMonths)) warnings.push(`The explicit payment pays off principal early in ${paidOffMonth}; subsequent scheduled payments are zero.`);
  return {
    rows, errors, warnings, methodology,
    summary: {
      principal, periodicPayment: paymentCents / 100, intervalMonths,
      firstPaymentMonth: addMonths(input.startMonth, intervalMonths),
      maturityMonth: addMonths(input.startMonth, input.termMonths), paidOffMonth,
      totalPrincipal: sum(rows, 'principal'), totalInterest: sum(rows, 'interest'),
      totalPayments: sum(rows, 'payment'), balloonPayment: balloonCents / 100,
      endingBalance: balanceCents / 100,
    },
  };
}

/**
 * A committed limit less book draw is a ceiling, never proof of availability.
 * A documented base requires BOTH borrowingBase and reserves (0 is explicit).
 * LenderAvailable is already NET available and is not reduced by draw twice.
 * A lender override requires provenance and is conservatively bounded by every
 * other documented ceiling; it cannot override a known lower borrowing base.
 */
export function calculateFacilityAvailability(input) {
  const errors = [];
  const warnings = [];
  const methodology = [
    'Committed headroom = max(0, limit minus book drawn); it is an upper bound, not accessible cash.',
    'Documented base headroom = max(0, borrowing base minus reserves minus book drawn). Base and reserves must both be supplied, with evidence.',
    'A documented lender available amount is already net of draw. Availability is capped by committed headroom and every documented base constraint; bank cash is never used.',
    'Missing amount, restriction, or provenance remains unknown; this is illustrative, not confirmation of lender consent or covenant compliance.',
  ];
  if (!isRecord(input)) return { available: null, committedHeadroom: null, borrowingBaseHeadroom: null, source: null, status: 'unknown', errors: ['Facility inputs must be an object.'], warnings, methodology };
  for (const field of ['limit', 'bookDrawn', 'borrowingBase', 'reserves', 'lenderAvailable']) {
    if (present(input[field]) && !nonnegative(input[field])) errors.push(`${field} must be an explicit nonnegative amount.`);
  }
  const committedHeadroom = nonnegative(input.limit) && nonnegative(input.bookDrawn) ? round(Math.max(0, input.limit - input.bookDrawn)) : null;
  const baseDocumented = nonnegative(input.borrowingBase) && nonnegative(input.reserves) && provenance(input.borrowingBaseProvenance);
  const borrowingBaseHeadroom = baseDocumented && nonnegative(input.bookDrawn) ? round(Math.max(0, input.borrowingBase - input.reserves - input.bookDrawn)) : null;
  const lenderDocumented = nonnegative(input.lenderAvailable) && provenance(input.lenderAvailableProvenance);
  if (!nonnegative(input.limit) || !nonnegative(input.bookDrawn)) warnings.push('Limit and book drawn are both required to establish a bounded availability amount.');
  if (!baseDocumented && !lenderDocumented) warnings.push('Availability unknown: provide a documented borrowing base and explicit reserves, or lender-reported net availability with provenance.');
  if (present(input.lenderAvailable) && !provenance(input.lenderAvailableProvenance)) warnings.push('Lender availability was not used because its provenance is missing.');
  if (present(input.borrowingBase) && !baseDocumented) warnings.push('Borrowing base was not used because the base, reserves or supporting provenance is missing.');
  if (nonnegative(input.limit) && nonnegative(input.bookDrawn) && input.bookDrawn > input.limit) warnings.push('Book drawn exceeds the committed limit.');
  if (baseDocumented && nonnegative(input.bookDrawn) && input.borrowingBase - input.reserves < input.bookDrawn) warnings.push('Book drawn exceeds the documented borrowing base after reserves.');
  let available = null;
  if (errors.length === 0 && committedHeadroom !== null && (borrowingBaseHeadroom !== null || lenderDocumented)) {
    available = round(Math.min(committedHeadroom, borrowingBaseHeadroom ?? Infinity, lenderDocumented ? input.lenderAvailable : Infinity));
    if (lenderDocumented && available < input.lenderAvailable) warnings.push('The lender-entered amount is reduced to the lower documented availability ceiling; reconcile dates and restrictions before relying on it.');
  }
  return {
    available, committedHeadroom, borrowingBaseHeadroom,
    source: available === null ? null : lenderDocumented ? 'documented-lender-available' : 'documented-borrowing-base',
    provenance: { borrowingBase: evidence(input.borrowingBaseProvenance), lenderAvailable: evidence(input.lenderAvailableProvenance) },
    status: available === null ? 'unknown' : 'illustrative', errors, warnings, methodology,
  };
}

/** Present value of a fixed monthly payment stream. Does not choose that payment. */
export function illustrativeLoanPrincipal(input) {
  const errors = [];
  const methodology = ['Illustrative fully amortizing monthly-payment present value only, with first payment one month after funding. No fees, balloon, revolving draw, credit-score adjustment or approval is implied.'];
  if (!isRecord(input)) return { principal: null, errors: ['Capacity inputs must be an object.'], methodology };
  if (!nonnegative(input.monthlyPayment)) errors.push('monthlyPayment must be an explicit nonnegative amount.');
  if (!number(input.annualRatePct) || input.annualRatePct < 0) errors.push('annualRatePct must be an explicit nonnegative number.');
  if (!validCount(input.termMonths)) errors.push(`termMonths must be an explicit integer between 1 and ${MAX_MONTHS}.`);
  if (errors.length) return { principal: null, errors, methodology };
  const rate = input.annualRatePct / 1200;
  const principal = rate === 0 ? input.monthlyPayment * input.termMonths
    : input.monthlyPayment * -Math.expm1(-input.termMonths * Math.log1p(rate)) / rate;
  if (!nonnegative(principal)) errors.push('Computed principal exceeds the supported numeric range.');
  return { principal: errors.length ? null : round(principal), errors, methodology };
}

function parseGrowth(input, startMonth, horizonMonths, errors, warnings) {
  if (!isRecord(input) || !nonnegative(input.growthPct)) {
    errors.push('growth.growthPct is required and must be nonnegative; enter 0 explicitly for no incremental growth cash use.');
    return { need: null, uses: [] };
  }
  if (input.growthPct === 0) return { need: 0, uses: Array(horizonMonths).fill(0) };
  const hasWC = present(input.baselineWorkingCapital);
  const hasInventory = present(input.baselineInventory);
  if (hasWC === hasInventory) errors.push('Positive growth requires one baselineWorkingCapital or baselineInventory, not both; do not double count inventory within working capital.');
  const baseline = hasWC ? input.baselineWorkingCapital : input.baselineInventory;
  if (!nonnegative(baseline)) errors.push('Growth baseline must be an explicit nonnegative working-capital or inventory-cost amount.');
  if (!provenance(input.provenance)) errors.push('Positive growth requires provenance for its working-capital or inventory baseline and assumptions.');
  if (!validCount(input.spreadMonths)) errors.push(`growth.spreadMonths must be an integer between 1 and ${MAX_MONTHS}.`);
  const growthStartMonth = input.startMonth ?? startMonth;
  if (!monthValid(growthStartMonth) || monthNumber(growthStartMonth) < monthNumber(startMonth)) errors.push('Growth startMonth must be a valid month at or after scenario startMonth.');
  const need = baseline * input.growthPct / 100;
  if (!nonnegative(need)) errors.push('Computed growth need exceeds the supported numeric range.');
  if (errors.length) return { need: null, uses: [] };
  const offset = monthNumber(growthStartMonth) - monthNumber(startMonth);
  if (offset + input.spreadMonths > horizonMonths) warnings.push('Some planned working-capital growth cash use lies outside the displayed horizon.');
  const needCents = cents(need);
  const eachCents = Math.floor(needCents / input.spreadMonths);
  const uses = Array.from({ length: horizonMonths }, (_, index) => {
    const position = index - offset;
    if (position < 0 || position >= input.spreadMonths) return 0;
    return (position === input.spreadMonths - 1 ? needCents - eachCents * (input.spreadMonths - 1) : eachCents) / 100;
  });
  return { need: needCents / 100, uses };
}

function parseStress(input, errors) {
  if (!present(input)) return 0;
  if (!isRecord(input)) {
    errors.push('stress must be an object.');
    return null;
  }
  const decline = input.revenueDeclinePct ?? 0;
  const compression = input.marginCompressionPct ?? 0;
  if (!number(decline) || decline < 0 || decline > 100) errors.push('stress.revenueDeclinePct must be between 0 and 100.');
  if (!number(compression) || compression < 0 || compression > 100) errors.push('stress.marginCompressionPct must be between 0 and 100 percentage points.');
  if (decline === 0 && compression === 0) return 0;
  if (!nonnegative(input.monthlyRevenue)) errors.push('Nonzero stress requires an explicit monthlyRevenue baseline.');
  if (!number(input.grossMarginPct) || input.grossMarginPct < 0 || input.grossMarginPct > 100) errors.push('Nonzero stress requires grossMarginPct between 0 and 100.');
  if (errors.length) return null;
  // Loss of gross contribution is applied ONCE: margin compression acts on
  // revenue remaining after the decline, not on original revenue a second time.
  return round(input.monthlyRevenue * input.grossMarginPct / 100
    - input.monthlyRevenue * (1 - decline / 100) * (input.grossMarginPct - compression) / 100);
}

function parseOverrides(input, months, errors) {
  const overrides = new Map();
  if (!present(input)) return overrides;
  if (!Array.isArray(input)) {
    errors.push('monthlyOverrides must be an array of objects keyed by month.');
    return overrides;
  }
  for (const override of input) {
    if (!isRecord(override) || !months.includes(override.month)) {
      errors.push('Each monthly override must name a valid month inside the displayed horizon.');
      continue;
    }
    if (overrides.has(override.month)) errors.push(`Duplicate monthly override for ${override.month}.`);
    if (has(override, 'provenanceByField') && !isRecord(override.provenanceByField)) errors.push(`${override.month} provenanceByField must be an object.`);
    for (const key of ['preDebtCash', 'workingCapitalUse', 'otherCashUse']) {
      if (!has(override, key)) continue;
      if (!(key === 'preDebtCash' ? money(override[key]) : nonnegative(override[key]))) errors.push(`${override.month} ${key} must be an explicit ${key === 'preDebtCash' ? 'finite' : 'nonnegative'} amount.`);
      if (!provenance(overrideEvidence(override, key))) errors.push(`${override.month} ${key} override requires provenance.`);
    }
    overrides.set(override.month, override);
  }
  return overrides;
}

/**
 * A PO is evidence, not an unpaid amount or a payment date. Only explicitly
 * reviewed cash-payment entries reach the cash model. Draft omissions are
 * issues that block cash conclusions while leaving the debt schedule visible.
 */
function parseCashCommitments(input, supplied, currency, months, errors) {
  const issues = [];
  const items = [];
  if (!supplied) return {
    provided: false, complete: null, items,
    issues: ['No commitment schedule was supplied; this legacy cash scenario excludes unmodeled PO and inventory payments and does not establish that they were reviewed.'],
  };
  if (!isRecord(input) || !Array.isArray(input.items)) {
    errors.push('cashCommitments must be an object with an explicit items array and complete review flag.');
    return { provided: true, complete: false, items, issues };
  }
  if (input.items.length > 500) {
    errors.push('cashCommitments supports at most 500 explicit planned payment entries.');
    return { provided: true, complete: false, items, issues };
  }
  if (input.complete !== true) issues.push('Commitment review is not confirmed complete for the displayed horizon; confirm every planned payment or explicitly review an empty schedule.');
  const currencyKnown = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
  if (!currencyKnown) issues.push('Scenario currency is required before planned commitment payments can be included. No currency conversion is inferred.');
  const ids = new Set();
  const identities = new Set();
  const inclusions = ['incremental', 'included-in-pre-debt-cash', 'included-in-working-capital', 'included-in-other-cash-use'];
  const paymentTypes = ['deposit', 'balance', 'other'];
  let enteredTotal = 0;
  for (const [index, item] of input.items.entries()) {
    if (!isRecord(item)) {
      errors.push(`Commitment ${index + 1} must be an explicit payment object.`);
      continue;
    }
    const id = evidence(item.id);
    const prefix = `Commitment ${id ?? index + 1}`;
    const rowIssues = [];
    if (!id) rowIssues.push(`${prefix}: a stable payment ID is required.`);
    else {
      if (id.length > 128) errors.push(`${prefix}: payment ID exceeds 128 characters.`);
      if (ids.has(id)) errors.push(`Duplicate commitment payment ID: ${id}.`);
      ids.add(id);
    }
    const month = monthValid(item.month) ? item.month : null;
    if (!month) rowIssues.push(`${prefix}: an explicit payment month is required; a PO delivery date is not a payment date.`);
    else if (!months.includes(month)) rowIssues.push(`${prefix}: payment month ${month} is outside the displayed horizon; revise the horizon or schedule explicitly.`);
    let amount = null;
    if (!present(item.amount) || item.amount === '') rowIssues.push(`${prefix}: the planned unpaid cash amount is unknown; PO total and deposit percentages are not substituted.`);
    else if (!nonnegative(item.amount)) errors.push(`${prefix}: amount must be an explicit nonnegative finite number within the supported numeric range.`);
    else {
      amount = round(item.amount);
      enteredTotal += amount;
    }
    const itemCurrency = typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency) ? item.currency : null;
    if (!itemCurrency) rowIssues.push(`${prefix}: payment currency is required.`);
    else if (!currencyKnown || itemCurrency !== currency) rowIssues.push(`${prefix}: payment currency ${itemCurrency} does not match the scenario currency; no FX rate is guessed.`);
    const sourceReference = evidence(item.sourceReference);
    if (!sourceReference) rowIssues.push(`${prefix}: a payment source reference is required.`);
    else if (sourceReference.length > 2000) errors.push(`${prefix}: source reference exceeds 2000 characters.`);
    const paymentType = paymentTypes.includes(item.paymentType) ? item.paymentType : null;
    if (!paymentType) rowIssues.push(`${prefix}: select deposit, balance or other payment stage.`);
    const inclusion = inclusions.includes(item.inclusion) ? item.inclusion : null;
    if (!inclusion) rowIssues.push(`${prefix}: explicitly decide whether the payment is incremental or already included in another cash assumption.`);
    if (item.reviewed !== true) rowIssues.push(`${prefix}: payment timing, unpaid amount, currency, source and inclusion have not been confirmed reviewed.`);
    if (sourceReference && month && paymentType) {
      const identity = JSON.stringify([sourceReference.trim().toLowerCase().replace(/\s+/g, ' '), month, paymentType]);
      if (identities.has(identity)) errors.push(`${prefix}: duplicate source reference, payment month and stage; combine that payment instead of entering it twice.`);
      identities.add(identity);
    }
    issues.push(...rowIssues);
    items.push({
      id, month, amount, currency: itemCurrency, sourceReference, paymentType,
      inclusion, reviewed: item.reviewed === true,
      ready: rowIssues.length === 0 && amount !== null,
    });
  }
  if (!nonnegative(enteredTotal)) errors.push('Total entered commitment payments exceed the supported numeric range.');
  return { provided: true, complete: input.complete === true && issues.length === 0 && errors.length === 0, items, issues };
}

function reconcileCommitmentInclusions(commitments, months, overrides, growth) {
  if (!commitments.provided) return;
  for (const [index, month] of months.entries()) {
    const override = overrides.get(month) ?? {};
    const uses = {
      'included-in-working-capital': has(override, 'workingCapitalUse') ? override.workingCapitalUse : growth.uses[index],
      'included-in-other-cash-use': override.otherCashUse ?? 0,
    };
    for (const [inclusion, modeledUse] of Object.entries(uses)) {
      const included = commitments.items.filter(item => item.ready && item.month === month && item.inclusion === inclusion);
      const totalIncluded = sum(included, 'amount');
      if (totalIncluded > round(modeledUse)) {
        commitments.issues.push(`${month}: payments marked ${inclusion} total ${totalIncluded.toFixed(2)} and exceed that month's entered cash use of ${round(modeledUse).toFixed(2)}; reconcile inclusion before relying on cash coverage.`);
        commitments.complete = false;
      }
    }
  }
}

/**
 * Scenario contract:
 * - normalizedPreDebtCash: {monthlyAmount, provenance}. Monthly overrides replace
 *   it; they never add to it. A provenance label is user evidence, not validation.
 * - existingDebt: {monthlyPayment?, monthlyPayments?: {'YYYY-MM': number},
 *   complete: true, provenance}. Keyed entries replace the explicit default.
 *   Missing entries without a default are unknown, including after a checkbox.
 * - growth: {growthPct, baselineWorkingCapital? OR baselineInventory?, spreadMonths,
 *   startMonth?, provenance}. Explicit 0 requires no baseline. Positive growth is
 *   baseline * growthPct, spread once, without assuming incremental future cash.
 * - stress: {monthlyRevenue,grossMarginPct,revenueDeclinePct,marginCompressionPct}.
 *   Gross-contribution sensitivity is deducted from normalized cash; it never
 *   creates normalized cash from sales or accounting profit.
 * - monthlyOverrides: [{month,preDebtCash?,workingCapitalUse?,otherCashUse?,
 *   provenanceByField:{preDebtCash?,workingCapitalUse?,otherCashUse?}}]. Each
 *   supplied value requires its own evidence. Legacy whole-row provenance is
 *   accepted only when provenanceByField is absent, never as a missing-key fallback.
 *   A workingCapitalUse override REPLACES that month's planned growth cash use.
 * - currency is an explicit ISO-style three-uppercase-letter currency label when
 *   cashCommitments is supplied. No FX conversion occurs here.
 * - cashCommitments: {complete, items:[{id,month,amount,currency,sourceReference,
 *   paymentType:'deposit'|'balance'|'other', reviewed,
 *   inclusion:'incremental'|'included-in-pre-debt-cash'|
 *   'included-in-working-capital'|'included-in-other-cash-use'}]}.
 *   Incremental payments are a separate cash use. Included references are NOT
 *   deducted again. Complete review and every entry's explicit facts are needed
 *   for cash and growth-adjusted conclusions. PO totals/delivery are never inputs.
 * - proposal is the buildDebtSchedule input, or null for no new borrowing.
 *
 * Standard DSCR uses stressed normalized pre-debt cash before incremental growth
 * and other discretionary uses. Growth-adjusted coverage deducts those uses and
 * incremental reviewed PO/inventory payments. Standard DSCR stays inspectable
 * when commitment review is incomplete; it does not imply funds cover those uses.
 * Both use principal PLUS interest only once, never subtract service in numerator.
 * Cash balances are withheld if any debt schedule entry is unconfirmed/missing.
 */
export function computeScenario(input) {
  const errors = [];
  const warnings = [];
  const methodology = [
    'Illustrative scenario only, not loan approval, a lender covenant calculation, or confirmation of borrowing availability.',
    'Normalized pre-debt cash is after operating expenses, tax, maintenance capex and baseline working capital, but before principal and interest. It must be an explicit amount with provenance. Incremental growth and PO uses remain separate. Accounting profit and net bank cash never become operating cash or debt capacity automatically.',
    'Standard DSCR = stressed normalized pre-debt cash / total principal-plus-interest debt service, before incremental growth, PO/inventory payments and other discretionary cash uses. Debt service is not also deducted from the numerator.',
    'Growth-adjusted DSCR = cash after incremental working-capital, reviewed incremental PO/inventory payments and other uses, before debt service / total debt service. The cash buffer is a separate constraint.',
    'Cash roll-forward = opening cash + pre-debt cash + one-time proposal proceeds - existing and proposed debt service - incremental working-capital use - incremental commitment cash use - other cash use - upfront financing fees.',
    'Explicit fixed upfront loan fees are deducted once in the funding month and do not increase scheduled principal. A no-loan baseline pays no loan fees. Fees paid in another cash-use input must be removed there to avoid counting them twice.',
    'Existing P&I is one explicit monthly payment schedule and proposed principal/interest is separate; combined debt service adds each exactly once. Matched facility references do not create an extra payment or automatic draw.',
    'PO/inventory commitment amounts, payment months, stage, currency and source references are explicitly user-reviewed. A PO total is not unpaid cash and delivery is not payment timing. No deposit percentage, payment date or FX rate is inferred.',
    'Only incremental commitment entries reduce cash again. Included-reference entries certify that the same amount is already in pre-debt cash, working capital or other uses; included amounts must fit the corresponding same-month use where it is measurable. Distinct references can still describe the same obligation, so deduplication cannot replace review.',
    'Growth need = documented working-capital OR inventory-cost baseline multiplied by explicit growth percentage, spent once over the stated months. Inventory is not added again when already included in working capital. No equity support or assumed growth revenue is added.',
    'Revenue and margin stress are a gross-contribution sensitivity deducted from evidenced cash, with no expense offset or collection lag. Gross profit itself is not treated as operating cash. Margin compression applies to revenue after the decline.',
    'Full-horizon DSCR pools cash and debt for exactly the displayed months; monthly ratios are not averaged. Zero service is N/A. Funding month is included and maturity outside the horizon is explicitly warned.',
    'Amounts share one currency and cash uses/payments are cent-rounded. Starting liquidity and monthly closing buffers are both checked; within-month troughs are not modeled.',
  ];
  const blank = () => ({ rows: [], errors, warnings, methodology, coverage: { dscrAvailable: false, cashPathComplete: false, commitmentsComplete: false, growthAdjustedCoverageAvailable: false, reasons: [...errors] }, proposalSchedule: null, cashCommitments: null, summary: emptySummary() });
  if (!isRecord(input)) {
    errors.push('Scenario inputs must be an object.');
    return blank();
  }
  if (!monthValid(input.startMonth)) errors.push('Scenario startMonth must be YYYY-MM.');
  if (!validCount(input.horizonMonths)) errors.push(`horizonMonths must be an integer between 1 and ${MAX_MONTHS}.`);
  if (present(input.startingCash) && !money(input.startingCash)) errors.push('startingCash must be an explicit finite amount.');
  if (present(input.requiredCashFloor) && !nonnegative(input.requiredCashFloor)) errors.push('requiredCashFloor must be an explicit nonnegative amount.');
  if (present(input.existingDebt) && !isRecord(input.existingDebt)) errors.push('existingDebt must be an object.');
  if (present(input.normalizedPreDebtCash) && !isRecord(input.normalizedPreDebtCash)) errors.push('normalizedPreDebtCash must be an object.');
  if (monthValid(input.startMonth) && validCount(input.horizonMonths) && monthNumber(input.startMonth) + input.horizonMonths - 1 > monthNumber('9999-12')) errors.push('Scenario horizon exceeds the supported calendar range.');
  if (errors.length) return blank();
  const months = Array.from({ length: input.horizonMonths }, (_, index) => addMonths(input.startMonth, index));
  const overrides = parseOverrides(input.monthlyOverrides, months, errors);
  const growth = parseGrowth(input.growth, input.startMonth, input.horizonMonths, errors, warnings);
  const stressCashReduction = parseStress(input.stress, errors);
  const cashCommitments = parseCashCommitments(input.cashCommitments, has(input, 'cashCommitments'), input.currency, months, errors);
  const proposalSchedule = present(input.proposal) ? buildDebtSchedule(input.proposal) : null;
  let upfrontFees = 0;
  if (proposalSchedule) {
    errors.push(...proposalSchedule.errors.map(message => `Proposal: ${message}`));
    warnings.push(...proposalSchedule.warnings);
    if (has(input.proposal, 'upfrontFees')) {
      if (!nonnegative(input.proposal.upfrontFees)) errors.push('Proposal upfrontFees must be an explicit nonnegative amount, including 0 when none.');
      else upfrontFees = round(input.proposal.upfrontFees);
    } else warnings.push('Legacy proposal has no upfrontFees input; this calculation assumes zero upfront loan fees. Confirm fees before sizing funding.');
    if (!proposalSchedule.errors.length && input.proposal.startMonth < input.startMonth) errors.push('Proposal startMonth precedes the scenario; existing funded debt belongs in the existing debt schedule to avoid counting proceeds twice.');
    if (!proposalSchedule.errors.length && input.proposal.startMonth > months.at(-1)) errors.push('Proposal funding must occur inside the displayed horizon.');
    if (!proposalSchedule.errors.length && proposalSchedule.summary.maturityMonth > months.at(-1)) warnings.push(`Proposal maturity (${proposalSchedule.summary.maturityMonth}) falls outside the displayed horizon; outstanding principal and future debt service remain. Full loan schedule must be reviewed separately.`);
  }
  const debt = input.existingDebt ?? {};
  if (present(debt.monthlyPayments) && !isRecord(debt.monthlyPayments)) errors.push('existingDebt.monthlyPayments must be an object keyed by YYYY-MM.');
  if (present(debt.monthlyPayment) && !nonnegative(debt.monthlyPayment)) errors.push('existingDebt.monthlyPayment must be an explicit nonnegative amount.');
  if (isRecord(debt.monthlyPayments)) {
    for (const [month, payment] of Object.entries(debt.monthlyPayments)) {
      if (!monthValid(month) || !nonnegative(payment)) errors.push('Each existingDebt.monthlyPayments entry must have a valid YYYY-MM key and explicit nonnegative principal-plus-interest payment.');
    }
  }
  if (errors.length) return { ...blank(), proposalSchedule, cashCommitments };
  reconcileCommitmentInclusions(cashCommitments, months, overrides, growth);
  const commitmentsReady = !cashCommitments.provided || cashCommitments.complete;
  warnings.push(...cashCommitments.issues);
  if (cashCommitments.items.some(item => item.ready && item.inclusion !== 'incremental')) warnings.push('Included commitment amounts are user-certified as already included in the selected same-month cash baseline or use; they are visible references and are not deducted again.');

  const reasons = [];
  const normalized = input.normalizedPreDebtCash ?? {};
  const normalizedDefaultKnown = money(normalized.monthlyAmount) && provenance(normalized.provenance);
  // Rounded at ingestion, like normalizedAmounts below, so a typed aggregate of
  // 500.004 reads as the same cents figure in every row, in totalDebtService,
  // in summary.totalExistingDebtService and in the capacity headroom.
  const toCents = value => (Number.isFinite(value) ? round(value) : value);
  const debtAmounts = months.map(month => has(debt.monthlyPayments ?? {}, month)
    ? toCents(debt.monthlyPayments[month]) : nonnegative(debt.monthlyPayment) ? round(debt.monthlyPayment) : null);
  const existingDebtComplete = debt.complete === true && provenance(debt.provenance) && debtAmounts.every(nonnegative);
  if (debtAmounts.some(amount => amount > 0)) warnings.push('Existing debt service is an entered aggregate; loan-by-loan contract terms, payment timing and principal/interest splits are not inferred or independently verified. Confirm the entered schedule includes every required maturity and balloon.');
  const normalizedAmounts = months.map(month => {
    const override = overrides.get(month);
    return override && has(override, 'preDebtCash') ? round(override.preDebtCash)
      : normalizedDefaultKnown ? round(normalized.monthlyAmount) : null;
  });
  const normalizedCashComplete = normalizedAmounts.every(money);
  const startingCashKnown = money(input.startingCash);
  const cashFloorKnown = nonnegative(input.requiredCashFloor);
  if (!existingDebtComplete) reasons.push('Existing debt is not confirmed complete with provenance and an explicit payment (including zero) for every displayed month; cash coverage and DSCR are unavailable.');
  if (!normalizedCashComplete) reasons.push('Normalized pre-debt cash is missing a finite amount or provenance for one or more displayed months; complete-horizon cash coverage and DSCR are unavailable.');
  if (!startingCashKnown) reasons.push('Starting cash is unknown; cash balances and buffers are unavailable.');
  if (!cashFloorKnown) reasons.push('Required cash floor is unknown; cash buffers are unavailable.');
  if (!commitmentsReady) reasons.push('PO/inventory commitment review or inclusion is incomplete; cash balances, buffers and growth-adjusted coverage are unavailable. Standard DSCR is shown before those cash uses.');
  const dscrAvailable = existingDebtComplete && normalizedCashComplete;
  const growthAdjustedCoverageAvailable = dscrAvailable && commitmentsReady;
  const cashPathComplete = existingDebtComplete && normalizedCashComplete && startingCashKnown && commitmentsReady;
  const proposalByMonth = new Map((proposalSchedule?.rows ?? []).map(row => [row.month, row]));
  let closingCash = cashPathComplete ? round(input.startingCash) : null;
  let proposedEndingBalance = 0;
  const rows = months.map((month, index) => {
    const override = overrides.get(month) ?? {};
    const proposed = proposalByMonth.get(month);
    const proposedPrincipal = proposed?.principal ?? 0;
    const proposedInterest = proposed?.interest ?? 0;
    const proposedDebtService = proposed?.payment ?? 0;
    if (proposed) proposedEndingBalance = proposed.endingBalance;
    const existingDebtService = debtAmounts[index];
    const totalDebtService = existingDebtService === null ? null : round(existingDebtService + proposedDebtService);
    const normalizedPreDebtCash = normalizedAmounts[index];
    const preDebtCash = normalizedPreDebtCash === null ? null : round(normalizedPreDebtCash - stressCashReduction);
    const workingCapitalUse = round(has(override, 'workingCapitalUse') ? override.workingCapitalUse : growth.uses[index]);
    const otherCashUse = round(override.otherCashUse ?? 0);
    const monthlyCommitments = cashCommitments.items.filter(item => item.month === month);
    const includedCommitments = monthlyCommitments.filter(item => item.inclusion && item.inclusion !== 'incremental');
    const commitmentCashUse = commitmentsReady ? sum(monthlyCommitments.filter(item => item.ready && item.inclusion === 'incremental'), 'amount') : null;
    const cashAfterUsesBeforeDebt = preDebtCash === null || !commitmentsReady ? null : round(preDebtCash - workingCapitalUse - otherCashUse - commitmentCashUse);
    const proposalInflow = proposalSchedule && month === input.proposal.startMonth ? proposalSchedule.summary.principal : 0;
    const financingFees = proposalSchedule && month === input.proposal.startMonth ? upfrontFees : 0;
    const openingCash = closingCash;
    closingCash = cashPathComplete ? round(openingCash + cashAfterUsesBeforeDebt + proposalInflow - totalDebtService - financingFees) : null;
    return {
      month, openingCash, normalizedPreDebtCash, stressCashReduction, preDebtCash,
      proposalInflow, financingFees, existingDebtService, proposedPrincipal, proposedInterest, proposedDebtService, totalDebtService,
      workingCapitalUse, otherCashUse, commitmentCashUse, cashCommitments: monthlyCommitments, includedCommitments,
      cashAfterUsesBeforeDebt, closingCash,
      cashBuffer: closingCash !== null && cashFloorKnown ? round(closingCash - input.requiredCashFloor) : null,
      dscr: existingDebtComplete ? ratio(preDebtCash, totalDebtService) : null,
      growthAdjustedDscr: existingDebtComplete && commitmentsReady ? ratio(cashAfterUsesBeforeDebt, totalDebtService) : null,
      cashProvenance: has(override, 'preDebtCash') ? evidence(overrideEvidence(override, 'preDebtCash')) : evidence(normalized.provenance),
      usesProvenance: {
        workingCapitalUse: has(override, 'workingCapitalUse') ? evidence(overrideEvidence(override, 'workingCapitalUse')) : evidence(input.growth.provenance),
        otherCashUse: has(override, 'otherCashUse') ? evidence(overrideEvidence(override, 'otherCashUse')) : null,
      },
    };
  });
  const totalPreDebtCash = knownSum(rows, 'preDebtCash');
  const totalDebtService = knownSum(rows, 'totalDebtService');
  const startingCashBuffer = startingCashKnown && cashFloorKnown ? round(input.startingCash - input.requiredCashFloor) : null;
  const monthlyBuffers = rows.map(row => row.cashBuffer).filter(number);
  const allBuffers = startingCashBuffer !== null ? [startingCashBuffer, ...monthlyBuffers] : monthlyBuffers;
  const minCashBuffer = cashPathComplete && cashFloorKnown ? minKnown(allBuffers) : null;
  const minCashBufferMonth = minCashBuffer === null ? null
    : startingCashBuffer === minCashBuffer ? `${input.startMonth} opening` : rows.find(row => row.cashBuffer === minCashBuffer).month;
  if (overrides.size && rows.some(row => has(overrides.get(row.month) ?? {}, 'workingCapitalUse'))) warnings.push('Monthly working-capital overrides replace planned uses; total modeled uses may differ from the baseline-derived growth need. Reconcile the timing plan.');
  return {
    rows, errors, warnings: [...warnings, ...reasons], methodology, proposalSchedule, cashCommitments,
    coverage: { existingDebtComplete, normalizedCashComplete, startingCashKnown, cashFloorKnown, cashPathComplete, dscrAvailable, commitmentsComplete: cashCommitments.complete, growthAdjustedCoverageAvailable, reasons },
    summary: {
      startingCashBuffer, minCashBuffer, minCashBufferMonth,
      endingCash: closingCash, fullHorizonDscr: dscrAvailable ? ratio(totalPreDebtCash, totalDebtService) : null,
      worstMonthlyDscr: dscrAvailable ? minKnown(rows.map(row => row.dscr).filter(number)) : null,
      fullHorizonGrowthAdjustedDscr: growthAdjustedCoverageAvailable ? ratio(sum(rows, 'cashAfterUsesBeforeDebt'), totalDebtService) : null,
      worstGrowthAdjustedDscr: growthAdjustedCoverageAvailable ? minKnown(rows.map(row => row.growthAdjustedDscr).filter(number)) : null,
      totalPreDebtCash, totalExistingDebtService: knownSum(rows, 'existingDebtService'),
      totalProposedDebtService: sum(rows, 'proposedDebtService'), totalDebtService,
      totalProposalInflow: sum(rows, 'proposalInflow'), totalWorkingCapitalUse: sum(rows, 'workingCapitalUse'),
      totalFinancingFees: sum(rows, 'financingFees'),
      totalOtherCashUse: sum(rows, 'otherCashUse'), growthNeed: growth.need,
      totalCommitmentCashUse: commitmentsReady ? sum(rows, 'commitmentCashUse') : null,
      totalIncludedCommitments: commitmentsReady ? sum(cashCommitments.items.filter(item => item.ready && item.inclusion !== 'incremental'), 'amount') : null,
      totalReviewedCommitments: sum(cashCommitments.items.filter(item => item.ready), 'amount'),
      monthsBelowCashFloor: cashPathComplete && cashFloorKnown ? rows.filter(row => row.cashBuffer < 0).length : null,
      proposedEndingBalance,
    },
  };
}

function emptySummary() {
  return Object.fromEntries([
    'startingCashBuffer', 'minCashBuffer', 'minCashBufferMonth', 'endingCash',
    'fullHorizonDscr', 'worstMonthlyDscr', 'fullHorizonGrowthAdjustedDscr', 'worstGrowthAdjustedDscr',
    'totalPreDebtCash', 'totalExistingDebtService', 'totalProposedDebtService', 'totalDebtService',
    'totalProposalInflow', 'totalFinancingFees', 'totalWorkingCapitalUse', 'totalOtherCashUse', 'growthNeed',
    'totalCommitmentCashUse', 'totalIncludedCommitments', 'totalReviewedCommitments',
    'monthsBelowCashFloor', 'proposedEndingBalance',
  ].map(key => [key, null]));
}
