// External authority is used only after the caller-token RPC resolves an
// explicitly published, grant-company connection. No arbitrary host or method.
import { WINDSOR_CONNECTORS, connectorForSource, parseFields, parseDatePreset,
  normalizeFields, previewDefaults, rowsOf, filterRowsToAccount, previewOptions,
  PREVIEW_MAX_ROWS, IDENTITY_ERROR } from '../windsor-broker/windsor-lib.mjs';

export const LIVE_BYTE_LIMIT = 2 * 1024 * 1024;
export const LIVE_OUTPUT_CHARS = 24000;

async function readJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) });
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
    throw new Error('Windsor could not return a bounded response. Try fewer fields or a shorter range.');
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
  if (!rows) throw new Error('Windsor did not return a field catalog.');
  const fields = normalizeFields(rows).map(f => ({...f,type:f.type.slice(0,64)}));
  if (!fields.some(f => f.id === 'account_id')) {
    throw new Error('This source has no verifiable account identity field. Live access is unavailable.');
  }
  return fields;
}

export async function liveQuery({ connection, fields, datePreset, fetchImpl, key }) {
  if (!key) throw new Error('Live Windsor access is not configured.');
  const source = sourceOf(connection);
  const parsed = parseFields(fields.join(','));
  const preset = parseDatePreset(datePreset);
  if (!parsed.ok || !preset.ok) throw new Error('Invalid fields or date range.');
  const catalog = await liveFields({ connection, fetchImpl });
  const allowed = new Set(catalog.map(f => f.id));
  if (!parsed.value.every(f => allowed.has(f))) throw new Error('A requested field is not offered by this source. Describe the connection again.');
  const url = new URL(`${WINDSOR_CONNECTORS}/${source}`);
  for (const [k,v] of Object.entries({ api_key:key, select_accounts:connection.account_id,
    fields:parsed.value.join(','), date_preset:preset.value, _max_rows:String(PREVIEW_MAX_ROWS) })) url.searchParams.set(k,v);
  const options = previewOptions(source); if (options) url.searchParams.set('options',options);
  const body = await readJson(fetchImpl, url.toString());
  const rows = rowsOf(body);
  if (!rows || (!Array.isArray(body) && body.error)) throw new Error('Windsor did not return data rows.');
  // Validate ALL rows, including ones outside the display limit, before release.
  const { kept, foreign, unattributed } = filterRowsToAccount(rows, connection.account_id, connection.source);
  if (foreign || unattributed) throw new Error(IDENTITY_ERROR);
  const output = []; let size = 0;
  for (const row of kept.slice(0, PREVIEW_MAX_ROWS)) {
    const selected = Object.fromEntries(parsed.value.filter(f => Object.hasOwn(row,f)).map(f => [f,row[f]]));
    const chars = JSON.stringify(selected).length;
    if (chars > LIVE_OUTPUT_CHARS && !output.length) throw new Error('A source row exceeds the response limit. Request fewer fields.');
    if (size + chars > LIVE_OUTPUT_CHARS) break;
    size += chars; output.push(selected);
  }
  return { connection_id:connection.id, source:connection.source, fields:parsed.value,
    date_preset:preset.value, fetched_at:new Date().toISOString(), rows:output,
    returned:rows.length, shown:output.length,
    maybe_truncated: rows.length >= PREVIEW_MAX_ROWS || output.length < rows.length,
    completeness:'Bounded live response; not a certified complete dataset. Do not treat a truncated response as a total.',
    persisted:false };
}

export function describeLiveFields(fields, { search = '', offset = 0 } = {}) {
  const term = search.toLowerCase();
  const found = fields.filter(f => `${f.id} ${f.name}`.toLowerCase().includes(term));
  const page = found.slice(offset, offset+100);
  return { fields:page, total_fields:found.length, next_offset: offset+page.length < found.length ? offset+page.length : null,
    suggested_fields:previewDefaults(fields), account_identity:'account_id must match the published account', persisted:false };
}
