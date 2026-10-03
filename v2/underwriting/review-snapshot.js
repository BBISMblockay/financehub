/** Pure local review snapshots and comparison. No clock, storage, network or
 * source lookups. Call build only for an explicit capture or a current preview;
 * pass a genuinely captured/imported prior review to compare. The module cannot
 * certify a human review or that a file was saved.
 *
 * Stable IDs describe the fact, not its display label or report-run ID. Callers
 * pass selected numeric evidence/configuration only: no raw source rows, client
 * names, document text, free-form provenance or financial-account credentials.
 */
const FORMAT = 'silo-underwriting-review';
const VERSION = 1;
const MAX_FACTS = 2000;
const MAX_SOURCES = 32;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const factKeys = ['id','label','value','unit','currency','periodStart','periodEnd','basis','sourceId','asOf'];
const sourceKeys = ['id','label','status','asOf','fetchedAt','periodStart','periodEnd','basis','currency','reportId','truncated','metrics'];
const snapshotKeys = ['format','version','companyId','createdAt','assumptions','sources','outcomes'];

function exactKeys(value, allowed, where) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError(`${where} contains unsupported fields or is not a plain object`);
}
function shortText(value, where, max = 160) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${where} must be short plain text`);
  return value.trim() || null;
}
function identity(value, where) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${where} must be a stable identifier`);
  return value;
}
function calendarDate(value) {
  if (!/^[1-9]\d{3}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0,10) === value;
}
function period(value, where) {
  if (value == null) return null;
  if (typeof value === 'string' && (/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value) || calendarDate(value))) return value;
  throw new TypeError(`${where} must be a valid calendar month or date`);
}
function timestamp(value, where, nullable = true) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string'
      || !/^[1-9]\d{3}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
      || !calendarDate(value.slice(0,10)) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${where} must be an explicit valid ISO timestamp`);
  return new Date(value).toISOString();
}
function asOf(value, where) {
  if (value == null) return null;
  if (calendarDate(value)) return value;
  return timestamp(value, where, false);
}
function currency(value, where) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new TypeError(`${where} must be an explicit currency code or null`);
  return value;
}
function valueOf(value, where, allowAssumption) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return Object.is(value,-0) ? 0 : value;
  if (allowAssumption && typeof value === 'boolean') return value;
  // Short configuration enums, month/date selections and stable account IDs.
  // Narratives and names belong in the scenario, never this numeric review.
  if (allowAssumption && typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) return value;
  throw new TypeError(`${where} must be a finite number or explicit null${allowAssumption ? ', boolean or short configuration token' : ''}`);
}
function normalizeFact(input, where, allowAssumption = false) {
  exactKeys(input, factKeys, where);
  if (!own(input, 'value')) throw new TypeError(`${where} must state value explicitly; use null for unknown`);
  const output = { id: identity(input.id, `${where}.id`), label: shortText(input.label, `${where}.label`),
    value: valueOf(input.value, `${where}.value`, allowAssumption), unit: shortText(input.unit, `${where}.unit`, 40),
    currency: currency(input.currency, `${where}.currency`), periodStart: period(input.periodStart, `${where}.periodStart`),
    periodEnd: period(input.periodEnd, `${where}.periodEnd`), basis: shortText(input.basis, `${where}.basis`, 40),
    sourceId: input.sourceId == null ? null : identity(input.sourceId, `${where}.sourceId`), asOf: asOf(input.asOf, `${where}.asOf`) };
  if (output.periodStart && output.periodEnd && output.periodStart > output.periodEnd) throw new TypeError(`${where} has reversed periods`);
  return output;
}
function normalizeList(items, where, normalizer) {
  if (!Array.isArray(items) || items.length > MAX_FACTS) throw new TypeError(`${where} must be a bounded list`);
  const seen = new Set();
  return items.map((input, index) => {
    const item = normalizer(input, `${where}[${index}]`);
    if (seen.has(item.id)) throw new TypeError(`${where} contains a duplicate stable ID`);
    seen.add(item.id);
    return item;
  }).sort(compareIds);
}
function normalizeSource(input, where) {
  exactKeys(input, sourceKeys, where);
  if (!['available','partial','missing','error','unknown'].includes(input.status)) throw new TypeError(`${where}.status is invalid`);
  if (input.truncated !== undefined && typeof input.truncated !== 'boolean') throw new TypeError(`${where}.truncated must be boolean`);
  const output = { id: identity(input.id, `${where}.id`), label: shortText(input.label, `${where}.label`), status: input.status,
    asOf: asOf(input.asOf, `${where}.asOf`), fetchedAt: timestamp(input.fetchedAt, `${where}.fetchedAt`),
    periodStart: period(input.periodStart, `${where}.periodStart`), periodEnd: period(input.periodEnd, `${where}.periodEnd`),
    basis: shortText(input.basis, `${where}.basis`, 40), currency: currency(input.currency, `${where}.currency`),
    reportId: input.reportId == null ? null : identity(input.reportId, `${where}.reportId`), truncated: input.truncated ?? false,
    metrics: normalizeList(input.metrics ?? [], `${where}.metrics`, normalizeFact) };
  if (output.periodStart && output.periodEnd && output.periodStart > output.periodEnd) throw new TypeError(`${where} has reversed periods`);
  if (['missing','error','unknown'].includes(output.status) && output.metrics.some((item) => item.value !== null)) throw new TypeError(`${where} cannot retain numeric values for an unavailable source`);
  return output;
}
function canonicalSnapshot(input, expectedCompanyId) {
  exactKeys(input, snapshotKeys, 'review');
  if (input.format !== FORMAT || input.version !== VERSION) throw new TypeError('This is not a supported underwriting review snapshot');
  if (typeof input.companyId !== 'string' || !UUID.test(input.companyId)) throw new TypeError('Review company ID is invalid');
  const companyId = input.companyId.toLowerCase();
  if (expectedCompanyId != null && (typeof expectedCompanyId !== 'string' || !UUID.test(expectedCompanyId) || companyId !== expectedCompanyId.toLowerCase())) throw new TypeError('Review belongs to a different company');
  if (!Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) throw new TypeError('Review contains too many or invalid sources');
  const snapshot = { format: FORMAT, version: VERSION, companyId, createdAt: timestamp(input.createdAt, 'review.createdAt', false),
    assumptions: normalizeList(input.assumptions, 'review.assumptions', (item, where) => normalizeFact(item, where, true)),
    sources: normalizeList(input.sources, 'review.sources', normalizeSource), outcomes: normalizeList(input.outcomes, 'review.outcomes', normalizeFact) };
  const size = snapshot.assumptions.length + snapshot.outcomes.length + snapshot.sources.reduce((n, item) => n + item.metrics.length, 0);
  if (size > MAX_FACTS) throw new TypeError('Review contains too many facts');
  return snapshot;
}

/** Capture only explicit selected facts. Unknown data must be passed as null.
 * createdAt is required from the caller; no date or prior baseline is invented. */
export function buildReviewSnapshot({ companyId, createdAt, assumptions = [], sources = [], outcomes = [], ...extra } = {}) {
  if (Object.keys(extra).length) throw new TypeError('Review capture contains unsupported fields');
  return canonicalSnapshot({ format: FORMAT, version: VERSION, companyId, createdAt, assumptions, sources, outcomes });
}

/** Used at local-file import. Strict whitelist prevents hidden raw rows or notes
 * from riding along with a review. Returns a fresh canonical object. */
export function validateReviewSnapshot(input, companyId) {
  return canonicalSnapshot(input, companyId);
}

const contextFields = ['unit','currency','periodStart','periodEnd','basis','sourceId'];
function factContext(fact, source = null) {
  return { unit: fact.unit, currency: fact.currency ?? source?.currency ?? null,
    periodStart: fact.periodStart ?? source?.periodStart ?? null, periodEnd: fact.periodEnd ?? source?.periodEnd ?? null,
    basis: fact.basis ?? source?.basis ?? null, sourceId: fact.sourceId ?? source?.id ?? null };
}
const sameContext = (left, right) => contextFields.every((key) => left[key] === right[key]);
function numericDelta(before, after) {
  const delta = after - before;
  return Number.isFinite(delta) && Math.abs(delta) <= Number.MAX_SAFE_INTEGER ? Number(delta.toPrecision(15)) : null;
}
function compareFacts(current, baseline, group, currentSource = null, baselineSource = null) {
  const currentMap = new Map(current.map((item) => [item.id, item]));
  const baselineMap = new Map(baseline.map((item) => [item.id, item]));
  const ids = [...new Set([...currentMap.keys(), ...baselineMap.keys()])].sort();
  const changes = [];
  for (const id of ids) {
    const next = currentMap.get(id), previous = baselineMap.get(id);
    const beforeContext = previous ? factContext(previous, baselineSource) : null;
    const afterContext = next ? factContext(next, currentSource) : null;
    const before = previous?.value ?? null, after = next?.value ?? null;
    const comparableContext = !!previous && !!next && sameContext(beforeContext, afterContext);
    const sourceUnavailable = group === 'source' && (!currentSource || ['error','missing','unknown'].includes(currentSource.status));
    const sourceIncomplete = group === 'source' && (currentSource?.status !== 'available' || baselineSource?.status !== 'available'
      || currentSource?.truncated || baselineSource?.truncated);
    const measuredContext = (fact, source, context) => !!context?.unit
      && (context.unit !== 'currency' || !!context.currency)
      && (!(context.unit === 'currency' && source?.reportId) || !!context.basis)
      && (!!(context.periodStart && context.periodEnd) || !!fact?.asOf || !!source?.asOf);
    const sourceContextMissing = group === 'source' && (!measuredContext(next,currentSource,afterContext) || !measuredContext(previous,baselineSource,beforeContext));
    const sourceStatusChanged = group === 'source' && currentSource?.status !== baselineSource?.status;
    let kind = null, reason = null, delta = null;
    if (!previous) { kind = 'added'; reason = 'No prior value was captured'; }
    else if (!next) { kind = group === 'source' ? 'unavailable' : 'removed'; reason = group === 'source' ? 'This source value is no longer available; no zero is inferred' : 'This fact is absent from the current review'; }
    else if (sourceUnavailable && before !== after) { kind = 'unavailable'; reason = 'The current source is unavailable; no zero is inferred'; }
    else if (!comparableContext) { kind = 'context-changed'; reason = 'Unit, currency, period, basis or source identity changed; no numeric delta is inferred'; }
    else if (before !== after) {
      kind = before === null ? 'became-known' : after === null ? 'became-unknown' : 'changed';
      if (sourceIncomplete || sourceStatusChanged) reason = 'Source coverage is partial, unavailable, changed or truncated; no numeric delta is inferred';
      else if (sourceContextMissing) reason = 'Source unit, currency, period/as-of or accounting basis is not established; no numeric delta is inferred';
      else if (typeof before === 'number' && typeof after === 'number') {
        delta = numericDelta(before, after);
        if (delta === null) reason = 'Numeric difference exceeds the supported range';
      }
    }
    if (kind) changes.push({ group, sourceId: currentSource?.id ?? baselineSource?.id ?? null, id,
      label: next?.label ?? previous?.label ?? id, kind, before, after, delta, beforeContext, afterContext, reason });
  }
  return changes;
}
function lineage(source) {
  if (!source) return null;
  const { id, label: _label, metrics: _metrics, ...metadata } = source;
  return { id, ...metadata };
}
function emptyComparison(status, reason, current = null, prior = null) {
  return { status, reason, companyId: current?.companyId ?? null, currentCreatedAt: current?.createdAt ?? null,
    baselineCreatedAt: prior?.createdAt ?? null, assumptionChanges: [], sourceValueChanges: [], sourceChanges: [], outcomeChanges: [],
    counts: { assumptions: 0, sourceValues: 0, sourceLineage: 0, outcomes: 0, total: 0 } };
}

/** Compare against a real captured review only. A newer period/currency/basis is
 * a context change, not a restatement of the prior numeric fact. Display-name
 * changes alone never become financial or assumption changes. */
export function compareReviewSnapshots(currentInput, baselineInput = null) {
  let current;
  try { current = validateReviewSnapshot(currentInput); }
  catch (error) { return emptyComparison('unavailable', `Current review is invalid: ${error.message}`); }
  if (baselineInput == null) return emptyComparison('unavailable', 'No prior review has been captured or imported', current);
  let baseline;
  try { baseline = validateReviewSnapshot(baselineInput, current.companyId); }
  catch (error) { return emptyComparison('incompatible', `Prior review cannot be compared: ${error.message}`, current); }
  if (baseline.createdAt > current.createdAt) return emptyComparison('incompatible', 'The prior review is dated after the current review', current, baseline);
  const result = emptyComparison('comparable', null, current, baseline);
  result.assumptionChanges = compareFacts(current.assumptions, baseline.assumptions, 'assumption');
  result.outcomeChanges = compareFacts(current.outcomes, baseline.outcomes, 'outcome');
  const nextSources = new Map(current.sources.map((item) => [item.id, item]));
  const priorSources = new Map(baseline.sources.map((item) => [item.id, item]));
  const ids = [...new Set([...nextSources.keys(), ...priorSources.keys()])].sort();
  for (const id of ids) {
    const next = nextSources.get(id), previous = priorSources.get(id);
    const before = lineage(previous), after = lineage(next);
    if (JSON.stringify(before) !== JSON.stringify(after)) result.sourceChanges.push({ id, label: next?.label ?? previous?.label ?? id,
      kind: !previous ? 'added' : !next ? 'unavailable' : next.status !== previous.status || next.truncated !== previous.truncated ? 'coverage-changed' : 'lineage-changed', before, after });
    result.sourceValueChanges.push(...compareFacts(next?.metrics ?? [], previous?.metrics ?? [], 'source', next, previous));
  }
  result.counts = { assumptions: result.assumptionChanges.length, sourceValues: result.sourceValueChanges.length,
    sourceLineage: result.sourceChanges.length, outcomes: result.outcomeChanges.length,
    total: result.assumptionChanges.length + result.sourceValueChanges.length + result.sourceChanges.length + result.outcomeChanges.length };
  return result;
}
