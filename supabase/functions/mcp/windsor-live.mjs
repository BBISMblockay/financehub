// External authority is used only after the caller-token RPC resolves an
// explicitly published, grant-company connection. No arbitrary host or method.
import { WINDSOR_CONNECTORS, connectorForSource, parseFields, parseDatePreset,
  normalizeFields, previewDefaults, rowsOf, filterRowsToAccount, previewOptions,
  PREVIEW_MAX_ROWS, IDENTITY_ERROR } from '../windsor-broker/windsor-lib.mjs';

export const LIVE_BYTE_LIMIT = 16 * 1024 * 1024;
export const LIVE_OUTPUT_CHARS = 24000;
// A rolled-up read totals every source row, so it asks the source for many
// rows and refuses (never returns partial totals) when that cap is reached.
export const LIVE_SOURCE_MAX_ROWS = 20000;
// About two years plus a margin, so "this year vs last year" fits in one call.
export const LIVE_RANGE_MAX_DAYS = 800;
// Sources such as TikTok answer a year-long read slowly; a rollup waits longer.
// Both stay well inside the edge function's wall-clock limit.
export const LIVE_TIMEOUT_MS = 20000;
export const LIVE_ROLLUP_TIMEOUT_MS = 90000;
export const ROLLUPS = ['none', 'day', 'week', 'month', 'total'];
const SUMMABLE_TYPES = ['NUMERIC', 'INTEGER', 'NUMBER', 'FLOAT', 'CURRENCY'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function isoDay(raw) {
  if (typeof raw !== 'string' || !ISO_DATE.test(raw)) return null;
  const t = Date.parse(raw + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === raw ? t : null;
}

/** One of: a preset, or an explicit date_from..date_to of at most
 * LIVE_RANGE_MAX_DAYS ending no later than tomorrow (UTC; covers every
 * company timezone's "today"). Never both. */
export function parseLiveRange({ datePreset, dateFrom, dateTo, now = Date.now() } = {}) {
  if (dateFrom == null && dateTo == null) {
    const preset = parseDatePreset(datePreset);
    return preset.ok ? { ok: true, preset: preset.value } : { ok: false, reason: 'Unsupported date_preset.' };
  }
  if (datePreset != null) return { ok: false, reason: 'Pass date_preset or date_from/date_to, not both.' };
  const from = isoDay(dateFrom), to = isoDay(dateTo);
  if (from == null || to == null) return { ok: false, reason: 'date_from and date_to must both be YYYY-MM-DD dates.' };
  if (from > to) return { ok: false, reason: 'date_from must be on or before date_to.' };
  if (to > Math.floor(now / DAY_MS) * DAY_MS + DAY_MS) return { ok: false, reason: 'date_to cannot be in the future.' };
  if ((to - from) / DAY_MS + 1 > LIVE_RANGE_MAX_DAYS) return { ok: false, reason: `A range can cover at most ${LIVE_RANGE_MAX_DAYS} days.` };
  return { ok: true, from: dateFrom, to: dateTo };
}

function periodOf(day, rollup) {
  if (rollup === 'day') return day;
  if (rollup === 'month') return day.slice(0, 7);
  if (rollup === 'total') return 'total';
  const t = isoDay(day); // week: the Monday that starts the ISO week
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** Sum summable measures per period and per text dimension. A blank measure
 * stays blank (null) when every row in the group is blank: blank is not zero. */
export function rollupRows(rows, { fields, catalog, rollup }) {
  const typeOf = new Map(catalog.map(f => [f.id, f.type]));
  const dims = fields.filter(f => f !== 'date' && !SUMMABLE_TYPES.includes(typeOf.get(f)));
  const measures = fields.filter(f => SUMMABLE_TYPES.includes(typeOf.get(f)));
  const groups = new Map();
  for (const row of rows) {
    const day = typeof row.date === 'string' ? row.date.slice(0, 10) : null;
    if (rollup !== 'total' && isoDay(day) == null) throw new Error('A source row has no usable date, so it cannot be rolled up.');
    const period = rollup === 'total' ? 'total' : periodOf(day, rollup);
    const keyParts = [period, ...dims.map(d => row[d] == null ? null : String(row[d]))];
    const key = JSON.stringify(keyParts);
    let g = groups.get(key);
    if (!g) {
      g = { period, dims: Object.fromEntries(dims.map(d => [d, row[d] ?? null])), sums: Object.fromEntries(measures.map(m => [m, null])), days: new Set(), source_rows: 0 };
      groups.set(key, g);
    }
    g.source_rows += 1; if (day) g.days.add(day);
    for (const m of measures) {
      const v = row[m];
      if (v == null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`Field ${m} returned a non-numeric value, so it cannot be totalled.`);
      g.sums[m] = (g.sums[m] ?? 0) + n;
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0)
    .map(g => ({ period: g.period, ...g.dims, ...g.sums, days_with_rows: g.days.size, source_rows: g.source_rows }));
}

async function readJson(fetchImpl, url, timeoutMs = LIVE_TIMEOUT_MS) {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || Number(res.headers.get('content-length')) > LIVE_BYTE_LIMIT) {
      await res.body?.cancel();
      throw new Error('Source response unavailable or too large');
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder(); let text = ''; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > LIVE_BYTE_LIMIT) { await reader.cancel(); throw new Error('Response too large'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally { reader.releaseLock(); }
  } catch (_) {
    // Never echo vendor text, URLs, keys, headers or raw transport errors.
    throw new Error('The source could not return a bounded response in time. Try fewer fields or a shorter range.');
  }
}

function sourceOf(connection) {
  const source = connectorForSource(connection.source);
  if (!source.ok || typeof source.value !== 'string' || !/^[a-z0-9_]{1,64}$/.test(source.value)
    || !connection.company_entity_id || typeof connection.account_id !== 'string' || !connection.account_id.trim()) {
    throw new Error('This connection has no valid source/account binding.');
  }
  return source.value;
}

export async function liveFields({ connection, fetchImpl }) {
  const source = sourceOf(connection);
  const body = await readJson(fetchImpl, `${WINDSOR_CONNECTORS}/${source}/fields`);
  const rows = Array.isArray(body) ? body : rowsOf(body);
  if (!rows) throw new Error('The source did not return a field catalog.');
  const fields = normalizeFields(rows).map(f => ({...f,type:f.type.slice(0,64)}));
  if (!fields.some(f => f.id === 'account_id')) {
    throw new Error('This source has no verifiable account identity field. Live access is unavailable.');
  }
  return fields;
}

export async function liveQuery({ connection, fields, datePreset, dateFrom, dateTo, rollup = 'none', fetchImpl, key, now }) {
  if (!key) throw new Error('Live access to connected sources is not configured.');
  const source = sourceOf(connection);
  const parsed = parseFields(fields.join(','));
  const range = parseLiveRange({ datePreset, dateFrom, dateTo, now });
  if (!parsed.ok) throw new Error('Invalid fields.');
  if (!range.ok) throw new Error(range.reason);
  if (!ROLLUPS.includes(rollup)) throw new Error('Unsupported rollup.');
  const rolled = rollup !== 'none';
  if (rolled && rollup !== 'total' && !parsed.value.includes('date')) throw new Error('A day, week or month rollup needs the date field.');
  const catalog = await liveFields({ connection, fetchImpl });
  const allowed = new Set(catalog.map(f => f.id));
  if (!parsed.value.every(f => allowed.has(f))) throw new Error('A requested field is not offered by this source. Describe the connection again.');
  if (rolled) {
    const typeOf = new Map(catalog.map(f => [f.id, f.type]));
    const unsummable = parsed.value.filter(f => typeOf.get(f) === 'PERCENT');
    if (unsummable.length) throw new Error(`These fields are rates and cannot be added up: ${unsummable.join(', ')}. Request the underlying counts and divide the totals.`);
    if (!parsed.value.some(f => SUMMABLE_TYPES.includes(typeOf.get(f)))) throw new Error('A rollup needs at least one numeric field to total.');
  }
  const url = new URL(`${WINDSOR_CONNECTORS}/${source}`);
  const window = range.preset ? { date_preset: range.preset } : { date_from: range.from, date_to: range.to };
  const sourceCap = rolled ? LIVE_SOURCE_MAX_ROWS : PREVIEW_MAX_ROWS;
  for (const [k,v] of Object.entries({ api_key:key, select_accounts:connection.account_id,
    fields:parsed.value.join(','), ...window, _max_rows:String(sourceCap) })) url.searchParams.set(k,v);
  const options = previewOptions(source); if (options) url.searchParams.set('options',options);
  const body = await readJson(fetchImpl, url.toString(), rolled ? LIVE_ROLLUP_TIMEOUT_MS : LIVE_TIMEOUT_MS);
  const rows = rowsOf(body);
  if (!rows || (!Array.isArray(body) && body.error)) throw new Error('The source did not return data rows.');
  // Validate ALL rows, including ones outside the display limit, before release.
  const { kept, foreign, unattributed } = filterRowsToAccount(rows, connection.account_id, connection.source);
  if (foreign || unattributed) throw new Error(IDENTITY_ERROR);
  // Never total a partial read: a capped source response is refused outright.
  if (rolled && rows.length >= sourceCap) {
    throw new Error('This range returns too many source rows to total safely. Use a shorter range, a coarser rollup, or fewer text fields.');
  }
  const shaped = rolled ? rollupRows(kept, { fields: parsed.value, catalog, rollup }) : kept;
  const output = []; let size = 0;
  for (const row of shaped.slice(0, PREVIEW_MAX_ROWS)) {
    const selected = rolled ? row : Object.fromEntries(parsed.value.filter(f => Object.hasOwn(row,f)).map(f => [f,row[f]]));
    const chars = JSON.stringify(selected).length;
    if (chars > LIVE_OUTPUT_CHARS && !output.length) throw new Error('A source row exceeds the response limit. Request fewer fields.');
    if (size + chars > LIVE_OUTPUT_CHARS) break;
    size += chars; output.push(selected);
  }
  const common = { connection_id:connection.id, source:connection.source, fields:parsed.value, ...window,
    fetched_at:new Date().toISOString(), rows:output, persisted:false };
  if (rolled) {
    return { ...common, rollup, source_rows:rows.length, groups:shaped.length, shown:output.length,
      maybe_truncated: output.length < shaped.length,
      completeness:'Totals cover every row the source returned for this range. A blank (null) measure means the source had no value for it in that period; it is not zero. Rates must be recomputed from totals, never summed. days_with_rows shows partial periods at the edges of the range.' };
  }
  return { ...common, rollup:'none', returned:rows.length, shown:output.length,
    maybe_truncated: rows.length >= PREVIEW_MAX_ROWS || output.length < rows.length,
    completeness:'Bounded live response; not a certified complete dataset. Do not treat a truncated response as a total.' };
}

export function describeLiveFields(fields, { search = '', offset = 0 } = {}) {
  const term = search.toLowerCase();
  const found = fields.filter(f => `${f.id} ${f.name}`.toLowerCase().includes(term));
  const page = found.slice(offset, offset+100);
  return { fields:page, total_fields:found.length, next_offset: offset+page.length < found.length ? offset+page.length : null,
    suggested_fields:previewDefaults(fields), account_identity:'account_id must match the published account', persisted:false };
}
