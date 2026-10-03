import { validateReviewSnapshot } from './review-snapshot.js';

/** Local scenario-file validation. No I/O, source lookups or state mutation. */
const decimal = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const monthPattern = /^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const overrideFields = ['payment', 'preDebtCash', 'workingCapitalUse', 'otherCashUse'];
const commitmentFields = ['id', 'month', 'amount', 'currency', 'sourceReference', 'paymentType', 'inclusion', 'reviewed'];
const paymentTypes = ['deposit', 'balance', 'other'];
const inclusionTypes = ['incremental', 'included-in-pre-debt-cash', 'included-in-working-capital', 'included-in-other-cash-use'];
const MAX_COMMITMENTS = 500;
const MAX_FACILITIES = 100;
const MAX_FACILITY_MONTHS = 1200;
// Overrides are keyed by month; a scenario cannot usefully carry more months than
// the longest facility schedule, and an unbounded map is how an importable file
// became one that could never be downloaded again (pretty-printed 1.46x larger).
const MAX_OVERRIDE_MONTHS = 1200;
// review-snapshot.js builds fact ids such as `payment:<facility id>:<month>` and
// refuses any id outside /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/. An imported id
// that fails it would make review capture permanently unavailable, so the same
// grammar is enforced here, capped at 100 so every prefixed fact id still fits.
const STABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/;
const ID_RULE = 'a unique ID of at most 100 letters, digits or . _ : / - characters';
const facilityFields = ['id', 'name', 'kind', 'balanceSource', 'accountId', 'manualBalance', 'balanceAsOf', 'balanceProvenance', 'currency',
  'limit', 'borrowingBase', 'reserves', 'lenderAvailable', 'availabilityAsOf', 'availabilityProvenance',
  'scheduleMode', 'monthlyPayment', 'monthlyPayments', 'scheduleComplete', 'scheduleProvenance', 'terms'];
const facilityTermFields = ['annualRatePct', 'frequency', 'repayment', 'firstPaymentMonth', 'maturityMonth', 'amortizationMonths'];
// Matches the pure model's cent-safe, 1,200-month monetary input ceiling.
const MAX_COMMITMENT_AMOUNT = Number.MAX_SAFE_INTEGER / (100 * 1201 * 4);

/** Blank means unknown; JS-only forms such as hexadecimal never become money. */
export function parseInputNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !decimal.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function numericString(value, label) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error(`Invalid ${label}`);
  if (!value.trim()) return '';
  const parsed = parseInputNumber(value);
  if (parsed === null) throw new Error(`Invalid ${label}: enter a finite decimal amount.`);
  // Canonical strings keep the DOM input and the calculation state identical.
  return String(parsed);
}

function validDate(value) {
  if (!/^[1-9]\d{3}-(?:0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

function validateCommitments(items) {
  if (!Array.isArray(items) || items.length > MAX_COMMITMENTS) throw new Error(`The scenario must contain a commitments list with at most ${MAX_COMMITMENTS} rows.`);
  const seen = new Set();
  const seenPayments = new Set();
  return items.map((item, index) => {
    const label = `commitment ${index + 1}`;
    if (!isRecord(item) || commitmentFields.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !commitmentFields.includes(key))) throw new Error(`Invalid ${label}: all commitment fields are required.`);
    if (typeof item.id !== 'string' || !STABLE_ID.test(item.id) || seen.has(item.id)) throw new Error(`Invalid ${label}: each commitment needs ${ID_RULE}.`);
    seen.add(item.id);
    if (typeof item.reviewed !== 'boolean') throw new Error(`Invalid ${label}: reviewed must be true or false.`);
    if (typeof item.month !== 'string' || (item.month !== '' && !monthPattern.test(item.month)) || (item.reviewed && item.month === '')) throw new Error(`Invalid ${label} month.`);
    if (!(item.amount === null && !item.reviewed) && (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0 || item.amount > MAX_COMMITMENT_AMOUNT)) throw new Error(`Invalid ${label} amount: enter a finite nonnegative number within the supported range.`);
    if (typeof item.currency !== 'string' || (!/^[A-Z]{3}$/.test(item.currency) && !(item.currency === '' && !item.reviewed))) throw new Error(`Invalid ${label} currency.`);
    if (typeof item.sourceReference !== 'string' || item.sourceReference.length > 2000 || (item.reviewed && !item.sourceReference.trim())) throw new Error(`Invalid ${label} source reference.`);
    if (!paymentTypes.includes(item.paymentType) && !(item.paymentType === '' && !item.reviewed)) throw new Error(`Invalid ${label} payment type.`);
    if (!inclusionTypes.includes(item.inclusion) && !(item.inclusion === '' && !item.reviewed)) throw new Error(`Invalid ${label} inclusion.`);
    if (item.sourceReference.trim() && monthPattern.test(item.month) && paymentTypes.includes(item.paymentType)) {
      const signature = JSON.stringify([item.sourceReference.trim().toLowerCase().replace(/\s+/g, ' '), item.month, item.paymentType]);
      if (seenPayments.has(signature)) throw new Error(`Invalid ${label}: duplicate source, month and payment type. Combine this payment into one row.`);
      seenPayments.add(signature);
    }
    // Unreviewed drafts retain explicit unknowns; they can never masquerade as
    // reviewed zero-dollar uses. Computation owns currency/horizon/completeness.
    return { id: item.id.trim(), month: item.month, amount: item.amount, currency: item.currency,
      sourceReference: item.sourceReference.trim(), paymentType: item.paymentType, inclusion: item.inclusion, reviewed: item.reviewed };
  });
}

function exactFields(value, fields) {
  return isRecord(value) && fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => fields.includes(key));
}

function draftAmount(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_COMMITMENT_AMOUNT)) throw new Error(`Invalid ${label}: enter a finite nonnegative number within the supported range, or null for unknown.`);
  return value;
}

function draftText(value, label) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

function draftEnum(value, allowed, label) {
  if (typeof value !== 'string' || (value !== '' && !allowed.includes(value))) throw new Error(`Invalid ${label}.`);
  return value;
}

function validateFacilities(items) {
  if (!Array.isArray(items) || items.length > MAX_FACILITIES) throw new Error(`The scenario must contain a facilities list with at most ${MAX_FACILITIES} rows.`);
  const seenIds = new Set();
  const seenAccounts = new Set();
  return items.map((item, index) => {
    const label = `facility ${index + 1}`;
    if (!exactFields(item, facilityFields)) throw new Error(`Invalid ${label}: all facility fields are required and unknown fields are not supported.`);
    if (typeof item.id !== 'string' || !STABLE_ID.test(item.id) || seenIds.has(item.id)) throw new Error(`Invalid ${label}: each facility needs ${ID_RULE}.`);
    seenIds.add(item.id);
    const row = { id: item.id.trim() };
    for (const key of ['name', 'accountId', 'balanceProvenance', 'availabilityProvenance', 'scheduleProvenance']) row[key] = draftText(item[key], `${label} ${key}`);
    row.kind = draftEnum(item.kind, ['loan', 'loc'], `${label} kind`);
    row.balanceSource = draftEnum(item.balanceSource, ['account', 'manual'], `${label} balance source`);
    row.scheduleMode = draftEnum(item.scheduleMode, ['payments', 'terms'], `${label} schedule mode`);
    if (row.kind === 'loc' && row.scheduleMode === 'terms') throw new Error(`Invalid ${label}: LOC facilities require an explicit payment schedule.`);
    if (row.balanceSource === 'account' && row.accountId) {
      if (seenAccounts.has(row.accountId)) throw new Error(`Invalid ${label}: duplicate account match. Each source account can be matched only once.`);
      seenAccounts.add(row.accountId);
    }
    for (const key of ['manualBalance', 'limit', 'borrowingBase', 'reserves', 'lenderAvailable', 'monthlyPayment']) row[key] = draftAmount(item[key], `${label} ${key}`);
    for (const key of ['balanceAsOf', 'availabilityAsOf']) {
      if (typeof item[key] !== 'string' || (item[key] !== '' && !validDate(item[key]))) throw new Error(`Invalid ${label} ${key}.`);
      row[key] = item[key];
    }
    if (typeof item.currency !== 'string' || (item.currency !== '' && !/^[A-Z]{3}$/.test(item.currency))) throw new Error(`Invalid ${label} currency.`);
    row.currency = item.currency;
    if (typeof item.scheduleComplete !== 'boolean') throw new Error(`Invalid ${label}: scheduleComplete must be true or false.`);
    row.scheduleComplete = item.scheduleComplete;
    if (!isRecord(item.monthlyPayments) || Object.keys(item.monthlyPayments).length > MAX_FACILITY_MONTHS) throw new Error(`Invalid ${label} monthly payments: use at most ${MAX_FACILITY_MONTHS} dated amounts.`);
    row.monthlyPayments = {};
    for (const [month, amount] of Object.entries(item.monthlyPayments)) {
      if (!monthPattern.test(month) || amount === null) throw new Error(`Invalid ${label} monthly payment: valid YYYY-MM and an explicit amount are required.`);
      row.monthlyPayments[month] = draftAmount(amount, `${label} monthly payment ${month}`);
    }
    if (!exactFields(item.terms, facilityTermFields)) throw new Error(`Invalid ${label} terms: all term fields are required and unknown fields are not supported.`);
    const terms = item.terms;
    if (terms.annualRatePct !== null && (typeof terms.annualRatePct !== 'number' || !Number.isFinite(terms.annualRatePct) || terms.annualRatePct < 0)) throw new Error(`Invalid ${label} annual rate.`);
    if (terms.amortizationMonths !== null && (!Number.isInteger(terms.amortizationMonths) || terms.amortizationMonths < 1 || terms.amortizationMonths > MAX_FACILITY_MONTHS)) throw new Error(`Invalid ${label} amortization months.`);
    for (const key of ['firstPaymentMonth', 'maturityMonth']) if (typeof terms[key] !== 'string' || (terms[key] !== '' && !monthPattern.test(terms[key]))) throw new Error(`Invalid ${label} ${key}.`);
    row.terms = { annualRatePct: terms.annualRatePct,
      frequency: draftEnum(terms.frequency, ['monthly', 'quarterly', 'annual'], `${label} frequency`),
      repayment: draftEnum(terms.repayment, ['amortizing', 'interest-only', 'balloon'], `${label} repayment`),
      firstPaymentMonth: terms.firstPaymentMonth, maturityMonth: terms.maturityMonth, amortizationMonths: terms.amortizationMonths };
    // This imports assumptions, never their certification. Source identity,
    // matching currency, period coverage and schedule sufficiency are recomputed.
    return row;
  });
}

function validateCashTiming(input) {
  if (!exactFields(input, ['collections', 'inventory', 'distinctReceiptPoolsReviewed'])) throw new Error('The scenario must contain the complete cashTiming assumptions.');
  if (typeof input.distinctReceiptPoolsReviewed !== 'boolean') throw new Error('Invalid cashTiming distinct receipt-pools review.');
  const output = { distinctReceiptPoolsReviewed: input.distinctReceiptPoolsReviewed };
  for (const key of ['collections', 'inventory']) {
    const row = input[key], label = `cashTiming ${key}`;
    if (!exactFields(row, ['enabled', 'amount', 'baselineReceipts', 'fromMonth', 'toMonth', 'sourceReference', 'reviewed'])) throw new Error(`Invalid ${label}: all timing fields are required.`);
    if (typeof row.enabled !== 'boolean' || typeof row.reviewed !== 'boolean') throw new Error(`Invalid ${label} review or enabled flag.`);
    for (const month of ['fromMonth', 'toMonth']) if (typeof row[month] !== 'string' || (row[month] !== '' && !monthPattern.test(row[month]))) throw new Error(`Invalid ${label} ${month}.`);
    output[key] = { enabled: row.enabled, amount: draftAmount(row.amount, `${label} amount`),
      baselineReceipts: draftAmount(row.baselineReceipts, `${label} baselineReceipts`),
      fromMonth: row.fromMonth, toMonth: row.toMonth, sourceReference: draftText(row.sourceReference, `${label} source reference`), reviewed: row.reviewed };
  }
  // Enabled incomplete assumptions remain drafts. The cash-timing model must
  // verify receipt-pool support and chronology before returning any cash path.
  return output;
}

/** Version 4 is a complete snapshot, never a patch over another scenario. */
/** Quick-look state is optional in a file (older v4 files have none). Only the
 * tick and the typed payment are stored per account id; balances, labels and
 * types come back from the live balance sheet on import. */
const MAX_QUICK_DEBTS = 200;
function validateQuick(input) {
  if (input === undefined || input === null) return { debts: [] };
  if (!isRecord(input) || !Array.isArray(input.debts) || input.debts.length > MAX_QUICK_DEBTS || Object.keys(input).some(key => key !== 'debts')) throw new Error(`Invalid quick-look section: expected a debts list of at most ${MAX_QUICK_DEBTS} rows.`);
  const seen = new Set();
  return { debts: input.debts.map((row, index) => {
    const label = `quick-look debt ${index + 1}`;
    if (!isRecord(row) || Object.keys(row).some(key => !['id', 'include', 'monthlyPayment'].includes(key))) throw new Error(`Invalid ${label}: unsupported fields.`);
    if (typeof row.id !== 'string' || !STABLE_ID.test(row.id) || seen.has(row.id)) throw new Error(`Invalid ${label}: needs ${ID_RULE}.`);
    seen.add(row.id);
    if (typeof row.include !== 'boolean') throw new Error(`Invalid ${label}: include must be true or false.`);
    if (row.monthlyPayment !== null && (typeof row.monthlyPayment !== 'number' || !Number.isFinite(row.monthlyPayment) || row.monthlyPayment < 0 || row.monthlyPayment > MAX_COMMITMENT_AMOUNT)) throw new Error(`Invalid ${label}: monthly payment must be null or a finite nonnegative number.`);
    return { id: row.id, include: row.include, monthlyPayment: row.monthlyPayment };
  }) };
}

export function validateScenarioDocument(doc, definitions, companyId) {
  if (isRecord(doc) && doc.format === 'silo-underwriting-scenario' && [1, 2, 3].includes(doc.version)) throw new Error(`Version ${doc.version} scenarios do not include the explicit multi-facility register and debt-source review required by this workspace. Re-enter the facilities and assumptions, choose manual or facility-derived debt, and download a version 4 scenario. Nothing was loaded.`);
  if (!isRecord(doc) || doc.format !== 'silo-underwriting-scenario' || doc.version !== 4) throw new Error('This is not a supported SILO underwriting scenario.');
  if (doc.companyId !== companyId) throw new Error('This scenario belongs to another company. It was not loaded.');
  if (!isRecord(doc.values)) throw new Error('The scenario must contain a complete set of input values.');
  const values = {};
  for (const [id, , type, , , options] of definitions) {
    if (!Object.hasOwn(doc.values, id)) throw new Error(`The scenario is incomplete: missing ${id}. Nothing was loaded.`);
    const value = doc.values[id];
    if (type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error(`Invalid ${id}`);
      values[id] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length > 2000) throw new Error(`Invalid ${id}`);
    if (type === 'number') values[id] = numericString(value, id);
    else {
      if (type === 'select' && !options.some(option => option[0] === value)) throw new Error(`Invalid ${id}`);
      if (type === 'month' && value !== '' && !monthPattern.test(value)) throw new Error(`Invalid ${id}`);
      if (type === 'date' && value !== '' && !validDate(value)) throw new Error(`Invalid ${id}`);
      values[id] = value;
    }
  }
  if (!isRecord(doc.overrides)) throw new Error('The scenario must contain its monthly overrides.');
  if (Object.keys(doc.overrides).length > MAX_OVERRIDE_MONTHS) throw new Error(`The scenario may carry monthly overrides for at most ${MAX_OVERRIDE_MONTHS} months.`);
  const overrides = {};
  for (const [month, row] of Object.entries(doc.overrides)) {
    if (!monthPattern.test(month) || !isRecord(row) || Object.keys(row).some(key => !overrideFields.includes(key))) throw new Error('Invalid monthly override.');
    const parsed = {};
    for (const key of overrideFields) {
      if (Object.hasOwn(row, key)) parsed[key] = numericString(row[key], `${month} ${key}`);
    }
    // A month with nothing entered is not an override; carrying it forward only grows the file.
    if (Object.keys(parsed).length) overrides[month] = parsed;
  }
  const commitments = validateCommitments(doc.commitments);
  const facilities = validateFacilities(doc.facilities);
  const cashTiming = validateCashTiming(doc.cashTiming);
  if (!Object.hasOwn(doc, 'reviewBaseline')) throw new Error('The scenario must explicitly state reviewBaseline; use null when no prior review was captured.');
  const reviewBaseline = doc.reviewBaseline === null ? null : validateReviewSnapshot(doc.reviewBaseline, companyId);
  const quick = validateQuick(doc.quick);
  return { values, overrides, commitments, facilities, cashTiming, reviewBaseline, quick };
}
