/**
 * Bounded, pure receipt-timing sensitivity. This changes only the timing of
 * explicitly documented cash receipts already included in the input forecast.
 * It never derives cash from revenue, inventory value, PO arrival or credit.
 */
const MAX_MONTHS = 1200;
const MAX_MONEY = Number.MAX_SAFE_INTEGER / (100 * (MAX_MONTHS + 1) * 4);
const pools = Object.freeze({ collections: 'Slower collections', inventory: 'Delayed inventory cash recovery' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const money = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_MONEY;
const nonnegative = value => money(value) && value >= 0;
const monthValid = value => typeof value === 'string' && /^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value);
const monthNumber = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthAt = value => `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
const evidence = value => typeof value === 'string' && value.trim().length > 0;
const cents = value => Math.round((value + Number.EPSILON) * 100);
const cashEvidence = row => has(row, 'provenanceByField')
  ? record(row.provenanceByField) ? row.provenanceByField.preDebtCash : null
  : row.provenance;

/** Independent drafts: disabled means no cash timing is selected, not known 0. */
export function emptyCashTimingAssumptions() {
  const empty = () => ({
    enabled: false, amount: null, baselineReceipts: null,
    fromMonth: '', toMonth: '', sourceReference: '', reviewed: false,
  });
  return { collections: empty(), inventory: empty(), distinctReceiptPoolsReviewed: false };
}

function resultShell(model) {
  return {
    model, enabled: false, ready: true, issues: [], warnings: [],
    impactRows: [], transfers: [], totalDelayed: 0,
    recoveryBeyondHorizon: 0, totalCashImpact: 0,
    methodology: [
      'Receipt timing moves an explicit cash amount already included in the source-month forecast to a later recovery month; it does not estimate collection rates or convert accounting revenue, planned sales or inventory value into cash.',
      'Each reviewed baselineReceipts is the documented cash receipt pool still collectible under the separate revenue and margin downside. The delayed amount cannot exceed that pool. Review confirms it is not also counted as a gross-contribution loss or another cash-use adjustment.',
      'Collections and inventory recovery are two distinct user-reviewed receipt pools. Different references do not prove distinct underlying receipts; when both are enabled, an explicit nonoverlap review is required.',
      'The source month loses cash once. Recovery adds it back once only when the selected month is inside the forecast. Receipts delayed beyond the window remain unreceived in that window and do not support its cash or debt coverage.',
      'Pre-debt cash overrides are adjusted by the net monthly timing amount; original cash, working-capital and other-use provenance remains intact. Timing references are separate evidence. Gross-contribution sensitivity, PO payment timing, working-capital uses, existing debt and proposal terms are unchanged.',
      'A reviewed receipt pool may exceed net pre-debt cash because operating outflows are already deducted; delaying receipts can therefore create negative net cash. Inventory is never treated as borrowing availability or assumed debt repayment capacity.',
    ],
  };
}

/**
 * @param {object} model Input contract for computeScenario (not its result).
 * @param {{collections:object,inventory:object,distinctReceiptPoolsReviewed:boolean}} assumptions
 * Each fixed pool is {enabled, amount, baselineReceipts, fromMonth, toMonth,
 * sourceReference, reviewed}. Numbers are native-currency numbers, never strings.
 * The caller must invalidate review when these fields or the cash forecast change.
 *
 * ready:false always returns model:null, null totals, and no partial impact rows.
 * The caller must block cash/coverage/capacity conclusions; it must not fall back
 * to the unchanged model as if the requested timing stress had been assessed.
 * Disabled pools have no effect, including stale draft data. Disabled results
 * return the exact input. Enabled results copy only the touched model structures;
 * neither the source forecast nor assumptions are mutated. Apply once to the
 * original forecast each render, never cumulatively to the prior return value.
 */
export function applyCashTimingStress(model, assumptions) {
  const result = resultShell(model);
  const { issues, warnings } = result;
  const fail = () => ({ ...result, model: null, ready: false, impactRows: [], transfers: [],
    totalDelayed: null, recoveryBeyondHorizon: null, totalCashImpact: null });
  if (!record(assumptions)) {
    issues.push('Cash timing needs explicit collections and inventory assumption objects, including enabled flags.');
    return fail();
  }
  for (const key of Object.keys(pools)) {
    if (!record(assumptions[key]) || typeof assumptions[key].enabled !== 'boolean') {
      issues.push(`${pools[key]} needs an explicit boolean enabled flag.`);
    }
  }
  result.enabled = Object.keys(pools).some(key => assumptions[key]?.enabled === true);
  if (issues.length) return fail();
  if (!result.enabled) return result;
  if (!record(model)) {
    issues.push('Cash timing requires an explicit source forecast object.');
    return fail();
  }
  if (!monthValid(model.startMonth) || !Number.isInteger(model.horizonMonths)
    || model.horizonMonths < 1 || model.horizonMonths > MAX_MONTHS
    || monthNumber(model.startMonth) + model.horizonMonths - 1 > monthNumber('9999-12')) {
    issues.push(`Cash timing requires a valid start month and a forecast horizon of 1–${MAX_MONTHS} months inside the supported calendar.`);
  }
  if (typeof model.currency !== 'string' || !/^[A-Z]{3}$/.test(model.currency)) {
    issues.push('Select an explicit forecast currency before moving receipts; no currency conversion is inferred.');
  }
  if (issues.length) return fail();
  const first = monthNumber(model.startMonth), last = first + model.horizonMonths - 1;
  const inHorizon = month => monthValid(month) && monthNumber(month) >= first && monthNumber(month) <= last;
  const overrides = model.monthlyOverrides ?? [];
  const byMonth = new Map();
  if (!Array.isArray(overrides)) issues.push('Cash timing requires monthlyOverrides to be an array when provided.');
  else for (const row of overrides) {
    if (!record(row) || !inHorizon(row.month)) {
      issues.push('Every existing monthly override must identify a month inside the forecast; cash timing cannot repair an invalid override.');
      continue;
    }
    if (byMonth.has(row.month)) issues.push(`Duplicate monthly override for ${row.month}; cash timing cannot discard one.`);
    if (has(row, 'provenanceByField') && !record(row.provenanceByField)) issues.push(`${row.month} cash override provenanceByField must remain an explicit object.`);
    byMonth.set(row.month, row);
  }
  const enabled = Object.keys(pools).filter(key => assumptions[key].enabled);
  if (enabled.length > 1 && assumptions.distinctReceiptPoolsReviewed !== true) {
    issues.push('Confirm the collections and inventory entries are distinct, nonoverlapping receipt pools; the same cash cannot be delayed twice.');
  }
  const transfers = [];
  const identities = new Set();
  for (const key of enabled) {
    const row = assumptions[key], label = pools[key];
    if (!nonnegative(row.amount) || cents(row.amount) < 1) {
      issues.push(`${label}: delayed amount must be an explicit positive number of at least one cent within the supported range.`);
    }
    if (!nonnegative(row.baselineReceipts) || cents(row.baselineReceipts) < 1) {
      issues.push(`${label}: baseline receipts must be an explicit positive cash receipt amount already included in the source-month forecast.`);
    } else if (money(row.amount) && row.amount > row.baselineReceipts) {
      issues.push(`${label}: delayed amount exceeds the explicitly documented baseline receipts; no extra cash is inferred.`);
    }
    if (!inHorizon(row.fromMonth)) issues.push(`${label}: source month must be an explicit month inside the displayed forecast horizon.`);
    if (!monthValid(row.toMonth)) issues.push(`${label}: recovery month must be an explicit valid YYYY-MM month.`);
    else if (monthValid(row.fromMonth) && row.toMonth <= row.fromMonth) issues.push(`${label}: recovery month must be strictly later than the original receipt month.`);
    if (!evidence(row.sourceReference) || row.sourceReference.length > 2000) issues.push(`${label}: a source reference of 1–2000 characters is required for the retained receipt pool and its timing.`);
    if (row.reviewed !== true) issues.push(`${label}: review cash-baseline inclusion, delayed amount, recovery timing and nonoverlap with gross-contribution losses or other cash uses.`);
    if (evidence(row.sourceReference) && monthValid(row.fromMonth)) {
      const identity = JSON.stringify([row.sourceReference.trim().toLowerCase().replace(/\s+/g, ' '), row.fromMonth]);
      if (identities.has(identity)) issues.push(`${label}: duplicate source reference and receipt month; the same receipt pool cannot appear twice.`);
      identities.add(identity);
    }
    transfers.push({ ...row, key, label, recoveryInHorizon: inHorizon(row.toMonth) });
  }
  if (issues.length) return fail();

  const deltas = new Map();
  function addDelta(month, key, amountCents, sourceReference) {
    const entry = deltas.get(month) ?? { collections: 0, inventory: 0, references: [] };
    entry[key] += amountCents;
    if (!entry.references.includes(sourceReference)) entry.references.push(sourceReference);
    deltas.set(month, entry);
  }
  let delayedCents = 0, beyondCents = 0;
  for (const row of transfers) {
    const amountCents = cents(row.amount);
    delayedCents += amountCents;
    addDelta(row.fromMonth, row.key, -amountCents, row.sourceReference);
    if (row.recoveryInHorizon) addDelta(row.toMonth, row.key, amountCents, row.sourceReference);
    else {
      beyondCents += amountCents;
      warnings.push(`${row.label}: ${model.currency} ${(amountCents / 100).toFixed(2)} recovers in ${row.toMonth}, outside the forecast ending ${monthAt(last)}; it remains unreceived in this window.`);
    }
  }
  if (!nonnegative(delayedCents / 100)) issues.push('Combined delayed receipt amounts exceed the supported numeric range.');
  const adjustedRows = new Map();
  const impacts = [];
  for (const [month, delta] of [...deltas].sort(([a], [b]) => a.localeCompare(b))) {
    const original = byMonth.get(month);
    const hasOverride = original && has(original, 'preDebtCash');
    const amount = hasOverride ? original.preDebtCash : model.normalizedPreDebtCash?.monthlyAmount;
    const provenance = hasOverride ? cashEvidence(original) : model.normalizedPreDebtCash?.provenance;
    if (!money(amount) || !evidence(provenance)) {
      issues.push(`${month}: an explicit cash baseline and its own provenance are required before delaying or recovering receipts; an unknown cash override never falls back to the default.`);
      continue;
    }
    const deltaCents = delta.collections + delta.inventory;
    const adjusted = (cents(amount) + deltaCents) / 100;
    if (!money(adjusted)) {
      issues.push(`${month}: adjusted pre-debt cash exceeds the supported numeric range.`);
      continue;
    }
    const adjustedRow = { ...(original ?? { month }), preDebtCash: adjusted };
    if (!hasOverride) {
      // Adding a cash override must not overwrite a legacy whole-row evidence
      // label, nor let new cash evidence validate unrelated cash-use fields.
      const provenanceByField = has(original ?? {}, 'provenanceByField')
        ? { ...original.provenanceByField }
        : Object.fromEntries(['workingCapitalUse', 'otherCashUse']
          .filter(key => has(original ?? {}, key)).map(key => [key, original.provenance]));
      provenanceByField.preDebtCash = provenance;
      adjustedRow.provenanceByField = provenanceByField;
    }
    adjustedRows.set(month, adjustedRow);
    impacts.push({ month, collectionsDelta: delta.collections / 100, inventoryDelta: delta.inventory / 100,
      cashDelta: deltaCents / 100, baselinePreDebtCash: cents(amount) / 100,
      adjustedPreDebtCash: adjusted, references: [...delta.references] });
  }
  if (issues.length) return fail();
  const adjustedOverrides = overrides.map(row => adjustedRows.get(row.month) ?? row);
  for (const [month, row] of adjustedRows) if (!byMonth.has(month)) adjustedOverrides.push(row);
  return {
    ...result, model: { ...model, monthlyOverrides: adjustedOverrides },
    impactRows: impacts, transfers, totalDelayed: delayedCents / 100,
    recoveryBeyondHorizon: beyondCents / 100, totalCashImpact: beyondCents ? -beyondCents / 100 : 0,
  };
}
