import { buildDebtSchedule, computeScenario } from './scenario-model.js';

/**
 * Bounded scenario arithmetic, never a lender policy or offer. The continuous
 * interval is derived from UNROUNDED per-dollar debt coefficients, not a rounded
 * $1 loan. The reported INNER interval satisfies every constraint even under
 * worst-case cent-rounding error. Endpoints/interior probes are then checked with
 * the production schedule. No global cash-monotonicity assumption is used.
 */
const MAX_MONEY = Number.MAX_SAFE_INTEGER / (100 * 1201 * 4);
const EPS = 1e-10;
const intervals = { monthly: 1, quarterly: 3, annual: 12 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0 && value <= MAX_MONEY;
const evidence = value => typeof value === 'string' && value.trim().length > 0;
const round = value => Math.round(value * 100) / 100;
const monthNumber = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthAt = value => `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
const bound = (month, reason, amount) => ({ month, reason, amount });

function resultShell() {
  return {
    status: 'incomplete', scope: 'window-only', errors: [], warnings: [], reasons: [],
    rawCashGap: null, rawCashGapMonth: null, preFundingShortfall: null,
    minimumAdditionalPrincipal: null, minimumPositivePrincipal: null,
    maximumAdditionalPrincipal: null, zeroFeasible: false, suggestedPrincipal: null,
    limitingNeed: null, limitingCapacity: null, monthlyHeadroom: [],
    continuousBounds: { minimum: null, maximum: null },
    verification: { exact: false, minimum: false, maximum: false, suggested: false, interval: false, checkedCandidates: 0 },
    residualAtWindowEnd: null, maturityMonth: null, firstPaymentMonth: null,
    remainingDebtServiceAfterWindow: null, fundingGapAtCapacity: null,
    intervalConservative: true,
    methodology: [
      'Raw cash gap is the plan shortfall without a proposed loan or loan fees. It is not the borrowing amount needed after servicing that loan.',
      'Normalized pre-debt cash is after operating expense, tax, maintenance capex and baseline working capital. Incremental growth, reviewed PO/inventory uses and other uses remain separate and are included once.',
      'Monthly additional payment headroom = pre-debt cash / the user-entered coverage target minus existing required P&I. Negative headroom is retained. No target is supplied by this model.',
      'For principal P, modeled month-end cash = unfinanced cash minus funded upfront fees + P × (funding indicator minus cumulative proposed P&I per dollar). Positive cash coefficients create lower bounds; negative coefficients create upper bounds. The result is an interval intersection, not a monotonic loan search.',
      'The cash floor and standard pre-growth DSCR target are separate constraints. Proposed proceeds never enter the DSCR numerator. A month with no existing or proposed service has no DSCR test.',
      'Fixed upfront fees are paid only for a positive funded loan. Zero borrowing pays no fees, so it can be feasible separately from the positive-principal interval.',
      'The reported positive interval is a conservative inner interval, certified against an upper bound on cent-rounding effects in every month. Its minimum may exceed the smallest workable amount and its ceiling may be below the largest workable amount. Endpoints and interior probes also pass the actual payment schedule. Merely valid endpoints would not establish a safe interval.',
      'Capacity is confined to documented scenario months. Full-term scope requires origination through maturity, including the final payment, and explicit forecast/term review. No refinancing, lender approval, facility draw or future cash beyond that window is assumed.',
      'Opening cash is pre-funding evidence. A new loan cannot repair an earlier cash shortfall. Only the stated month-end cash constraints are sized; no within-month cash timing is invented.',
    ],
  };
}

/** Unrounded normalized loan plus bounds for all cent-rounding discrepancies. */
function coefficients(terms) {
  const interval = intervals[terms.frequency];
  const rate = terms.annualRatePct / 100 * interval / 12;
  const periods = (terms.amortizationMonths ?? terms.termMonths) / interval;
  const interestOnly = terms.repayment === 'interest-only'
    || (terms.repayment === 'balloon' && terms.amortizationMonths == null);
  const payment = interestOnly ? rate : rate === 0 ? 1 / periods : rate / -Math.expm1(-periods * Math.log1p(rate));
  const rows = new Map();
  let balance = 1;
  let cumulative = 0;
  let balanceError = 0;
  let cumulativeError = 0;
  let cumulativeUpperError = 0;
  for (let index = 0; index <= terms.termMonths; index += 1) {
    let service = 0;
    let serviceError = 0;
    let serviceUpperError = 0;
    if (index > 0 && index % interval === 0) {
      const interest = balance * rate;
      const principal = index === terms.termMonths ? balance : interestOnly ? 0 : Math.min(balance, Math.max(0, payment - interest));
      service = principal + interest;
      // Rounding each regular payment and interest to cents changes balance by
      // at most .01 per interval, propagated at (1+r). Payoff clipping cannot
      // increase this bound because min/max are 1-Lipschitz. The final payoff
      // clears the balance; the interest-only balance is exact until maturity.
      serviceError = interestOnly ? rate === 0 ? 0 : .005 : (1 + rate) * balanceError + .005;
      // An early payoff can reduce a regular payment, but cannot make it larger
      // than the rounded regular amount. Outer necessary bounds use the absolute
      // error; the sufficient inner bounds need only its upper error.
      serviceUpperError = interestOnly || index === terms.termMonths ? serviceError : .005;
      if (!interestOnly) balanceError = index === terms.termMonths ? 0 : (1 + rate) * balanceError + .01;
      balance = Math.max(0, balance - principal);
      cumulative += service;
      cumulativeError += serviceError;
      cumulativeUpperError += serviceUpperError;
      // At zero-rate maturity every cent of principal, and nothing else, has
      // been repaid regardless of how individual payments were rounded.
      if (rate === 0 && index === terms.termMonths) { cumulative = 1; cumulativeError = 0; cumulativeUpperError = 0; }
    }
    rows.set(monthAt(monthNumber(terms.startMonth) + index), { service, serviceError, serviceUpperError, cumulative, cumulativeError, cumulativeUpperError, balance });
  }
  return rows;
}

/**
 * @param {{scenario:object,terms:object,coverageTarget:number,
 * forecastReviewed:boolean,termsProvenance:string}} input
 * Terms are independent of an entered principal. Fixed requiredPayment is not
 * supported for reverse sizing; it would not be proportional to principal.
 */
export function assessFundingCapacity(input) {
  const result = resultShell();
  if (!record(input) || !record(input.scenario) || !record(input.terms)) {
    result.errors.push('Capacity needs explicit scenario and loan-term objects.');
    return result;
  }
  const { scenario, terms, coverageTarget } = input;
  if (!finite(coverageTarget) || coverageTarget <= 0) result.errors.push('Enter an explicit positive coverageTarget; no lender threshold is assumed.');
  if (input.forecastReviewed !== true) result.errors.push('Review the cash and existing-payment assumptions for the entire displayed forecast before sizing.');
  if (!evidence(input.termsProvenance)) result.errors.push('Document the proposed loan-term source or explicit scenario assumptions.');
  if (!nonnegative(terms.upfrontFees)) result.errors.push('Enter explicit nonnegative upfrontFees, including 0 when none.');
  if (terms.requiredPayment != null) {
    result.status = 'unassessed';
    result.reasons.push('Reverse sizing with a fixed requiredPayment is unsupported; choose defined amortizing or balloon terms.');
    return result;
  }
  // Validation uses the production schedule, but no rounded reference value is
  // used to derive payment coefficients or reported as an assessed principal.
  const termCheck = buildDebtSchedule({ ...terms, principal: 1000000 });
  result.errors.push(...termCheck.errors.map(error => `Terms: ${error}`));
  const baseline = computeScenario({ ...scenario, proposal: null });
  result.errors.push(...baseline.errors);
  if (!baseline.coverage.cashPathComplete || !baseline.coverage.cashFloorKnown
    || baseline.coverage.commitmentsComplete !== true || !baseline.coverage.dscrAvailable) {
    result.errors.push('Complete documented cash, cash floor, existing debt and PO/inventory commitment review are required; unknown values cannot support a funding conclusion.');
  }
  if (result.errors.length) return result;
  const rows = baseline.rows;
  const endMonth = rows.at(-1).month;
  if (terms.startMonth < scenario.startMonth || terms.startMonth > endMonth) {
    result.errors.push('The proposed funding month must be inside the displayed forecast.');
    return result;
  }
  result.maturityMonth = termCheck.summary.maturityMonth;
  result.firstPaymentMonth = termCheck.summary.firstPaymentMonth;
  const floor = round(scenario.requiredCashFloor);
  const fees = round(terms.upfrontFees);
  const openingGap = Math.max(0, round(floor - scenario.startingCash));
  result.rawCashGap = openingGap;
  result.rawCashGapMonth = openingGap > 0 ? `${scenario.startMonth} opening` : null;
  if (openingGap > 0) result.preFundingShortfall = { amount: openingGap, month: `${scenario.startMonth} opening` };
  for (const row of rows) {
    const gap = Math.max(0, round(floor - row.closingCash));
    if (gap > result.rawCashGap) { result.rawCashGap = gap; result.rawCashGapMonth = row.month; }
    if (row.month < terms.startMonth && gap > (result.preFundingShortfall?.amount ?? 0)) result.preFundingShortfall = { amount: gap, month: row.month };
  }
  result.scope = result.maturityMonth <= endMonth && !result.preFundingShortfall ? 'full-term' : 'window-only';
  if (result.maturityMonth > endMonth) result.warnings.push(`Window-only: cash assumptions end ${endMonth}, before maturity ${result.maturityMonth}. Future service and any balloon are not cash-qualified.`);
  if (result.preFundingShortfall) result.warnings.push(`Pre-funding shortfall of ${result.preFundingShortfall.amount.toFixed(2)} at ${result.preFundingShortfall.month} remains a separate timing issue; the sized loan cannot retroactively fix it.`);
  const unit = coefficients(terms);
  let previous = { cumulative: 0, cumulativeError: 0, cumulativeUpperError: 0 };
  let lower = 0, upper = Infinity, outerLower = 0, outerUpper = Infinity;
  let innerLower = 0, innerUpper = Infinity, innerBlocked = false;
  let observedPayments = 0;
  const fixedFailures = [];
  const lowerBound = (value, row, reason) => {
    if (value > lower) { lower = value; result.limitingNeed = bound(row.month, reason, value); }
  };
  const upperBound = (value, row, reason) => {
    if (value < upper) { upper = value; result.limitingCapacity = bound(row.month, reason, value); }
  };
  for (const row of rows) {
    const current = unit.get(row.month);
    if (current) previous = current;
    const funded = row.month >= terms.startMonth;
    const cumulative = funded ? previous.cumulative : 0;
    const cumulativeError = funded ? previous.cumulativeError : 0;
    const cumulativeUpperError = funded ? previous.cumulativeUpperError : 0;
    const k = current?.service ?? 0;
    const paymentError = current?.serviceError ?? 0;
    const paymentUpperError = current?.serviceUpperError ?? 0;
    let a = (funded ? 1 : 0) - cumulative;
    if (terms.annualRatePct === 0 && row.month >= result.maturityMonth) a = 0;
    const headroom = row.preDebtCash / coverageTarget - row.existingDebtService;
    const deficit = floor - row.closingCash + (funded ? fees : 0);
    const dscrApplicable = k > 0 || row.existingDebtService > 0;
    const monthly = {
      month: row.month, preDebtCash: row.preDebtCash, existingDebtService: row.existingDebtService,
      availableForNewDebtService: headroom, proposedDebtServicePerDollar: k,
      coveragePrincipalCeiling: k > 0 ? headroom / k : null, cashCoefficient: a,
      dscrApplicable, baselineClosingCash: row.closingCash,
    };
    result.monthlyHeadroom.push(monthly);
    if (k > 0) {
      observedPayments += 1;
      upperBound(headroom / k, row, 'Selected monthly DSCR target');
      outerUpper = Math.min(outerUpper, (headroom + paymentError) / k);
      innerUpper = Math.min(innerUpper, (headroom - paymentUpperError) / k);
    } else if (row.existingDebtService > 0 && headroom < -EPS) {
      fixedFailures.push(`${row.month}: existing P&I already misses the selected coverage target; borrowing does not improve the pre-debt numerator.`);
    }
    if (a > 0) {
      lowerBound(deficit / a, row, 'Cash floor after planned uses, fixed fees and the loan’s own service');
      outerLower = Math.max(outerLower, (deficit - cumulativeError) / a);
      innerLower = Math.max(innerLower, (deficit + cumulativeUpperError) / a);
    } else if (a < 0) {
      upperBound(deficit / a, row, 'Cash floor after repayment; extra principal lowers cash in this month');
      outerUpper = Math.min(outerUpper, (deficit - cumulativeError) / a);
      innerUpper = Math.min(innerUpper, (deficit + cumulativeUpperError) / a);
    } else if (deficit > cumulativeError + EPS) {
      fixedFailures.push(`${row.month}: borrowing has no marginal cash benefit here and cannot close the cash-floor gap${funded ? ' after repayment' : ' before funding'}.`);
    }
    if (a === 0 && deficit > -cumulativeUpperError + EPS) innerBlocked = true;
    if (![k, a, headroom, deficit, cumulativeError, paymentError, cumulativeUpperError, paymentUpperError].every(finite)) {
      result.status = 'unassessed'; result.reasons.push('Terms produce numerically unstable payment or rounding bounds; no amount is inferred.'); return result;
    }
  }
  result.continuousBounds = { minimum: Math.max(0, lower), maximum: finite(upper) ? Math.max(0, upper) : null };
  result.zeroFeasible = rows.every(row => row.closingCash >= floor && (row.existingDebtService === 0 || row.preDebtCash + EPS >= coverageTarget * row.existingDebtService));
  if (result.zeroFeasible) result.minimumAdditionalPrincipal = 0;
  if (fixedFailures.length) {
    result.status = 'infeasible'; result.reasons.push(...fixedFailures);
    // Fixed fees apply only to positive borrowing. The zero branch may remain
    // possible even if no positive principal can absorb a fixed fee at maturity.
    if (result.zeroFeasible) { result.status = 'feasible'; result.maximumAdditionalPrincipal = 0; result.suggestedPrincipal = 0; result.verification = { exact: true, minimum: true, maximum: true, suggested: true, interval: true, checkedCandidates: 1 }; }
    return result;
  }
  if (!observedPayments || !finite(outerUpper)) {
    result.status = 'unassessed'; result.reasons.push('No proposed principal-plus-interest payment is observed inside this window, so a payment-supported principal ceiling is not established.'); return result;
  }
  if (!finite(outerLower) || !finite(outerUpper) || Math.abs(outerLower) > MAX_MONEY || Math.abs(outerUpper) > MAX_MONEY) {
    result.status = 'unassessed'; result.reasons.push('The mathematical interval exceeds supported numeric verification bounds; that limit is not borrowing capacity.'); return result;
  }
  const firstOuterCent = Math.max(1, Math.ceil((outerLower - EPS) * 100));
  const lastOuterCent = Math.floor((outerUpper + EPS) * 100);
  if (firstOuterCent > lastOuterCent) {
    result.status = result.zeroFeasible ? 'feasible' : 'infeasible';
    result.reasons.push('No positive principal overlaps both the cash-funding need and selected payment/cash constraints in this window.');
    if (result.zeroFeasible) {
      result.maximumAdditionalPrincipal = result.suggestedPrincipal = 0;
      result.verification.exact = result.verification.minimum = result.verification.maximum = result.verification.suggested = true;
      result.verification.interval = true;
    }
    return result;
  }
  if (innerBlocked || !finite(innerLower) || !finite(innerUpper) || innerLower > innerUpper || innerUpper < .01) {
    result.status = 'unassessed'; result.reasons.push('Cent-rounding uncertainty leaves no certified continuous positive-principal interval. No range is claimed from isolated feasible amounts.'); return result;
  }
  const firstCent = Math.max(1, Math.ceil(innerLower * 100));
  const lastCent = Math.floor(innerUpper * 100);
  if (firstCent > lastCent) { result.status = 'unassessed'; result.reasons.push('No whole-cent positive amount fits the conservative certified interval.'); return result; }
  const cache = new Map();
  const check = principal => {
    if (cache.has(principal)) return cache.get(principal);
    result.verification.checkedCandidates += 1;
    const schedule = buildDebtSchedule({ ...terms, principal });
    if (schedule.errors.length) { cache.set(principal, false); return false; }
    const byMonth = new Map(schedule.rows.map(row => [row.month, row]));
    let servicePaid = 0;
    let okay = true;
    for (const row of rows) {
      const proposedService = byMonth.get(row.month)?.payment ?? 0;
      servicePaid = round(servicePaid + proposedService);
      const funded = row.month >= terms.startMonth;
      const closingCash = round(row.closingCash + (funded ? principal - fees : 0) - servicePaid);
      const combinedService = round(row.existingDebtService + proposedService);
      if (closingCash < floor || (combinedService > 0 && row.preDebtCash + EPS < coverageTarget * combinedService)) { okay = false; break; }
    }
    cache.set(principal, okay);
    return okay;
  };
  const probes = new Set([firstCent, lastCent, Math.min(lastCent, firstCent + 1), Math.max(firstCent, lastCent - 1)]);
  for (const fraction of [.25, .5, .75]) probes.add(firstCent + Math.floor((lastCent - firstCent) * fraction));
  if ([...probes].some(value => !check(value / 100))) {
    result.status = 'unassessed'; result.reasons.push('Actual cent-rounded schedule did not confirm the conservative interval; no amount is suggested.'); return result;
  }
  result.minimumPositivePrincipal = firstCent / 100;
  result.minimumAdditionalPrincipal = result.zeroFeasible ? 0 : result.minimumPositivePrincipal;
  result.maximumAdditionalPrincipal = lastCent / 100;
  result.suggestedPrincipal = result.minimumAdditionalPrincipal;
  result.verification.exact = result.verification.minimum = result.verification.maximum = result.verification.suggested = true;
  result.verification.interval = true;
  result.status = 'feasible';
  const suggested = computeScenario({ ...scenario, proposal: result.suggestedPrincipal > 0 ? { ...terms, principal: result.suggestedPrincipal } : null });
  // Final production roll-forward validation includes every use and fee. Its
  // minCashBuffer includes pre-funding opening cash, so evaluate month ends here.
  if (suggested.errors.length || suggested.rows.some(row => row.closingCash < floor || (row.totalDebtService > 0 && row.preDebtCash + EPS < coverageTarget * row.totalDebtService))) {
    result.status = 'unassessed'; result.reasons.push('Final integrated cash validation did not confirm the candidate; no suggestion is claimed.');
    result.suggestedPrincipal = null; result.verification.exact = false; result.verification.suggested = false; return result;
  }
  result.residualAtWindowEnd = suggested.summary.proposedEndingBalance;
  result.remainingDebtServiceAfterWindow = round((suggested.proposalSchedule?.rows ?? []).filter(row => row.month > endMonth).reduce((total, row) => total + row.payment, 0));
  const atCapacity = computeScenario({ ...scenario, proposal: { ...terms, principal: result.maximumAdditionalPrincipal } });
  result.fundingGapAtCapacity = Math.max(0, ...atCapacity.rows.map(row => round(floor - row.closingCash)));
  return result;
}
