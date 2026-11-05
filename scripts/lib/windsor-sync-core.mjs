// Windsor.ai -> SILO tables. Called by scripts/windsor-sync.mjs (GitHub
// Actions, service role).
//
// SILO holds ONE Windsor owner key, so anything read with it can include
// every client's accounts. The tenant boundary is windsor_linked_accounts,
// which the windsor-broker edge function fills only from links SILO minted for
// a company (20261102220000). This sync never decides a company itself:
//   - it reads one mapping row at a time and asks Windsor for THAT account
//     only (select_accounts);
//   - every response must contain only rows attributable to that account;
//     unexpected identity fails the window before progress is recorded;
//   - company_entity_id on every written row is copied from the mapping row,
//     never from Windsor's payload.
//
// What it writes:
//   tiktok  -> marketing_kpis_daily (platform tiktok_ads, source 'windsor').
//              Same row identity as the direct TikTok sync, so if SILO's own
//              TikTok app replaces Windsor later the rows are updated in
//              place rather than counted twice.
//   klaviyo -> klaviyo_performance_daily, three reports (account, campaign,
//              flow message).
//   other sources -> blocked until a reviewed lossless dataset contract exists.
// For every dataset, every numeric field Windsor lists is also asked for, in
// batches (fetchDatasetHunted), and stored by name; a field Windsor will not
// return is listed on the mapping row (refused_fields), not silently dropped.
//
// History: each run re-pulls the trailing RECENT_DAYS (platforms restate
// numbers for weeks) and then walks older history back one ~month window at a
// time toward `historyMonths`, saving how far it got after EVERY window, so a
// run that stops (call budget, error, timeout) resumes there next time.
//
// Every write is an idempotent upsert on row_hash, which covers row IDENTITY
// only (company / account / report / object / day), never metric values.

import {
  WINDSOR_CONNECTORS, connectorForSource, windsorUrl, redact, parseBody, rowsOf,
  describeShape, filterRowsToAccount, previewOptions, DIRECT_SYNC_SOURCES,
  STANDARD_FIELDS, NUMERIC_TYPES, assertAccountRows,
} from '../../supabase/functions/windsor-broker/windsor-lib.mjs';

export { DIRECT_SYNC_SOURCES, STANDARD_FIELDS };
import { hashRow, upsertInChunks } from './shopify-sync-core.mjs';

export const WINDSOR_SYNC_JOB_TYPE = 'windsor_sync';
export const WINDSOR_SOURCE = 'windsor';
export const RECENT_DAYS = 35;
export const HISTORY_CHUNK_DAYS = 31;
export const DEFAULT_HISTORY_MONTHS = 24;
const MAX_FIELD_RETRIES = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Dates (UTC date arithmetic on YYYY-MM-DD strings) ───────────────────────
export function shiftDate(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function shiftMonths(day, months) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Pacific today, the same westernmost bound the other syncs use: the newest
 *  day written is always a finished day everywhere SILO supports. */
export function pacificToday(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** The windows this run pulls for one account: the recent window first, then
 *  older history, newest first, until the target or the window cap. */
export function planWindows({ today, historyFrom, historyMonths, maxHistoryWindows }) {
  const end = shiftDate(today, -1);
  const recentStart = shiftDate(end, -(RECENT_DAYS - 1));
  const windows = [{ kind: 'recent', from: recentStart, to: end }];
  const target = shiftMonths(end, -Math.max(0, Number(historyMonths) || 0));
  let edge = historyFrom && DATE_RE.test(historyFrom) && historyFrom < recentStart ? historyFrom : recentStart;
  while (edge > target && windows.length - 1 < maxHistoryWindows) {
    const to = shiftDate(edge, -1);
    let from = shiftDate(to, -(HISTORY_CHUNK_DAYS - 1));
    if (from < target) from = target;
    windows.push({ kind: 'history', from, to });
    edge = from;
  }
  return { windows, target, recentStart, end };
}

// ── Values ──────────────────────────────────────────────────────────────────
const isBlank = (v) => v === undefined || v === null || v === '';
/** A number, or null when Windsor did not report one. Never 0 for blank. */
export function numOrNull(v) {
  if (isBlank(v)) return null;
  const n = Number(String(v).replace(/[,$\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const intOrNull = (v) => { const n = numOrNull(v); return n == null ? null : Math.round(n); };
const strOrNull = (v) => (isBlank(v) ? null : String(v));

/** Every numeric field in `row` not already mapped to a column. */
function leftoverNumbers(row, mapped) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (mapped.has(k)) continue;
    const n = numOrNull(v);
    if (n != null && typeof v !== 'boolean') out[k] = n;
  }
  return out;
}

// ── Datasets ────────────────────────────────────────────────────────────────
// Field ids are Windsor's (https://connectors.windsor.ai/<connector>/fields).
// Windsor refuses a request naming a field it does not know for that source;
// fetchDataset drops exactly the fields an error names and asks again.

const TIKTOK_MAPPED = new Set(['date', 'account_id', 'account_name', 'campaign_id', 'campaign',
  'impressions', 'clicks', 'spend', 'complete_payment', 'total_complete_payment_rate',
  'initiate_checkout', 'web_event_add_to_cart', 'form']);

function tiktokRow(r, ctx) {
  const campaignId = strOrNull(r.campaign_id);
  const campaignName = strOrNull(r.campaign);
  return {
    company_entity_id: ctx.companyId,
    connection_id: null,
    platform: 'tiktok_ads',
    ds_id: 'tiktok_ads', // the column the direct sync fills with the platform
    account_id: ctx.accountId,
    account_name: strOrNull(r.account_name) ?? ctx.accountName,
    day_date: r.date,
    campaign_id: campaignId,
    campaign_name: campaignName,
    impressions: intOrNull(r.impressions) ?? 0,
    clicks: intOrNull(r.clicks) ?? 0,
    spend: numOrNull(r.spend) ?? 0,
    // complete_payment = website purchases; total_complete_payment_rate is
    // TikTok's name for their VALUE (not a rate). Same as the direct sync.
    conversions: numOrNull(r.complete_payment) ?? 0,
    conversion_value: numOrNull(r.total_complete_payment_rate) ?? 0,
    initiate_checkout: intOrNull(r.initiate_checkout),
    add_to_cart: intOrNull(r.web_event_add_to_cart),
    leads: intOrNull(r.form),
    extra: leftoverNumbers(r, TIKTOK_MAPPED),
    // Identity identical to the direct sync's kpiRow (ad-platforms-sync-core).
    row_hash: hashRow([ctx.companyId, 'tiktok_ads', 'tiktok_ads', ctx.accountId, campaignId ?? campaignName, r.date]),
    source: WINDSOR_SOURCE,
    synced_at: ctx.syncedAt,
    sync_batch_id: ctx.batchId,
  };
}

function klaviyoRow(report, map) {
  return (r, ctx) => {
    const objectId = report === 'account' ? '' : (strOrNull(map.objectId(r)) ?? '');
    const out = {
      company_entity_id: ctx.companyId,
      account_id: ctx.accountId,
      account_name: strOrNull(r.account_name) ?? ctx.accountName,
      report,
      day_date: r.date,
      object_id: objectId,
      object_name: map.objectName ? strOrNull(map.objectName(r)) : null,
      parent_id: map.parentId ? strOrNull(map.parentId(r)) : null,
      parent_name: map.parentName ? strOrNull(map.parentName(r)) : null,
      channel: map.channel ? strOrNull(map.channel(r)) : null,
      metrics: {},
      attributes: {},
      source: WINDSOR_SOURCE,
      row_hash: hashRow([ctx.companyId, 'klaviyo', ctx.accountId, report, objectId, r.date]),
      synced_at: ctx.syncedAt,
      sync_batch_id: ctx.batchId,
    };
    const used = new Set(['date', 'account_id', 'account_name', ...(map.used || [])]);
    for (const [col, field, kind] of map.columns) {
      used.add(field);
      out[col] = kind === 'int' ? intOrNull(r[field]) : numOrNull(r[field]);
    }
    for (const f of map.attributes || []) {
      used.add(f);
      if (!isBlank(r[f])) out.attributes[f] = String(r[f]);
    }
    out.metrics = leftoverNumbers(r, used);
    return out;
  };
}

const KLAVIYO_ACCOUNT_COLUMNS = [
  ['recipients', 'sent_emails', 'int'], ['delivered', 'received_emails', 'int'],
  ['opens', 'opens', 'int'], ['clicks', 'clicks', 'int'], ['conversions', 'conversions', 'num'],
  ['revenue', 'revenue', 'num'], ['bounced', 'bounced_email', 'int'],
];
const prefixed = (p) => [
  ['recipients', `${p}recipients`, 'int'], ['delivered', `${p}delivered`, 'int'],
  ['opens', `${p}opens`, 'int'], ['opens_unique', `${p}opens_unique`, 'int'],
  ['clicks', `${p}clicks`, 'int'], ['clicks_unique', `${p}clicks_unique`, 'int'],
  ['conversions', `${p}conversions`, 'num'], ['revenue', `${p}conversion_value`, 'num'],
  ['unsubscribes', `${p}unsubscribes`, 'int'], ['bounced', `${p}bounced`, 'int'],
  ['spam_complaints', `${p}spam_complaints`, 'int'],
];
const fieldsOf = (cols, more) => cols.map((c) => c[1]).concat(more);

export const DATASETS = Object.freeze({
  tiktok: [{
    key: 'campaign', table: 'marketing_kpis_daily',
    fields: ['date', 'account_id', 'account_name', 'campaign_id', 'campaign', 'impressions', 'clicks',
      'spend', 'reach', 'conversion', 'complete_payment', 'total_complete_payment_rate', 'initiate_checkout',
      'web_event_add_to_cart', 'form', 'onsite_shopping', 'total_onsite_shopping_value'],
    toRow: tiktokRow,
    mergeKey: (r) => r.campaign_id ?? r.campaign,
    hunt: { tables: null },
  }],
  klaviyo: [
    {
      key: 'account', table: 'klaviyo_performance_daily',
      fields: ['date', 'account_id', 'account_name', ...fieldsOf(KLAVIYO_ACCOUNT_COLUMNS, [
        'revenue_per_recipient', 'checkout_started',
        'checkout_started_value', 'added_to_cart', 'ordered_product', 'ordered_product_value',
        'fulfilled_order', 'fulfilled_order_value', 'cancelled_order', 'refunded_order', 'refunded_order_value'])],
      columnFields: KLAVIYO_ACCOUNT_COLUMNS.map((c) => c[1]),
      toRow: klaviyoRow('account', { columns: KLAVIYO_ACCOUNT_COLUMNS, objectId: () => '' }),
      mergeKey: () => '',
      hunt: { tables: ['metrics'] },
    },
    {
      key: 'campaign', table: 'klaviyo_performance_daily',
      fields: ['date', 'account_id', 'campaign_id', 'campaign', 'campaign_channel', 'subject', 'status',
        'sent_at', ...fieldsOf(prefixed('campaign_report_'), ['campaign_report_failed',
          'campaign_report_conversion_uniques', 'campaign_report_average_order_value'])],
      columnFields: ['campaign_id', ...prefixed('campaign_report_').map((c) => c[1])],
      toRow: klaviyoRow('campaign', {
        columns: prefixed('campaign_report_'),
        objectId: (r) => r.campaign_id, objectName: (r) => r.campaign, channel: (r) => r.campaign_channel,
        used: ['campaign_id', 'campaign', 'campaign_channel'],
        attributes: ['subject', 'status', 'sent_at'],
      }),
      mergeKey: (r) => r.campaign_id,
      hunt: { tables: ['campaign-reports'] },
    },
    {
      key: 'flow', table: 'klaviyo_performance_daily',
      fields: ['date', 'account_id', 'flow_id', 'flow_name', 'flow_message_id', 'flow_message_name',
        'flow_status', 'flow_trigger_type', ...fieldsOf(prefixed('flow_'), ['flow_failed',
          'flow_conversion_uniques', 'flow_average_order_value'])],
      columnFields: ['flow_id', 'flow_message_id', ...prefixed('flow_').map((c) => c[1])],
      toRow: klaviyoRow('flow', {
        columns: prefixed('flow_'),
        objectId: (r) => r.flow_message_id ?? r.flow_id, objectName: (r) => r.flow_message_name,
        parentId: (r) => r.flow_id, parentName: (r) => r.flow_name,
        used: ['flow_id', 'flow_name', 'flow_message_id', 'flow_message_name'],
        attributes: ['flow_status', 'flow_trigger_type'],
      }),
      mergeKey: (r) => r.flow_message_id ?? r.flow_id,
      hunt: { tables: ['flows'] },
    },
  ],
});

// Field discovery enriches explicit datasets only; a catalog is not a row-grain contract.

const FIELD_ID_RE = /^[a-z0-9_.]{1,64}$/i;
const NUMERIC = new Set(NUMERIC_TYPES);

/** Windsor's field list for a connector, as [{ id, type, table }], or null
 *  when it cannot be read. */
export async function fetchFieldCatalog({ fetchImpl, connector }) {
  let res;
  try {
    res = await fetchImpl(`${WINDSOR_CONNECTORS}/${encodeURIComponent(connector)}/fields`,
      { method: 'GET', signal: AbortSignal.timeout(60000) });
  } catch { return null; }
  if (!res.ok) return null;
  const body = parseBody(await res.text().catch(() => ''));
  const list = Array.isArray(body) ? body : rowsOf(body);
  if (!list) return null;
  return list
    .filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && FIELD_ID_RE.test(f.id))
    .map((f) => ({ id: f.id, type: String(f.type || '').toUpperCase(), table: f.table ?? null }));
}

/** Numeric field ids in the catalog, optionally only from some of Windsor's
 *  tables, in catalog order. */
export function huntFields(catalog, { tables = null } = {}) {
  const want = tables ? new Set(tables) : null;
  return (catalog || [])
    .filter((f) => NUMERIC.has(f.type) && (!want || want.has(f.table)))
    .map((f) => f.id);
}

const REQUIRED_FIELDS = new Set(['date', 'account_id']);

/** Field ids from `fields` that an error text names, longest first so
 *  `flow_opens_unique` is matched before `flow_opens`. */
export function fieldsNamedIn(text, fields) {
  const t = String(text || '');
  const named = [];
  for (const f of [...fields].sort((a, b) => b.length - a.length)) {
    if (REQUIRED_FIELDS.has(f)) continue;
    const re = new RegExp(`(^|[^a-z0-9_])${f.replace(/[.]/g, '\\.')}([^a-z0-9_]|$)`, 'i');
    if (re.test(t) && !named.some((n) => n.includes(f))) named.push(f);
  }
  return named;
}

/** Shortest window a read is split down to. This is the only bound splitting
 *  needs: the halves are read depth-first and the first one that still fails
 *  throws, so an unanswered 35-day window costs two whole-window attempts and
 *  then one pair per halving -- eight reads -- before the dataset gives up,
 *  and a dataset error ends the account for this run. */
export const MIN_SPLIT_DAYS = 7;

/** The two halves of [from, to], or null when the window is already at or
 *  under MIN_SPLIT_DAYS. Halves are disjoint and cover the whole window, so
 *  no day is read twice and none is skipped. */
export function splitWindow(from, to) {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (!Number.isFinite(days) || days <= MIN_SPLIT_DAYS) return null;
  const mid = shiftDate(from, Math.ceil(days / 2) - 1);
  return [[from, mid], [shiftDate(mid, 1), to]];
}

/** Read one dataset for one account and window. Returns the raw rows and the
 *  fields Windsor refused. Throws (redacted) on anything else.
 *
 *  A window Windsor will not answer for at all -- the Klaviyo account report
 *  over 35 days has been timing out twice in a row since 2026-11-04 -- is
 *  asked for in halves instead. This happens ONLY after the whole window has
 *  failed, so a working full-window read is never replaced by split reads and
 *  the two cannot disagree; every half must succeed or the window still
 *  fails, unwritten, as before. Rows carry their own date, so the halves
 *  concatenate without being combined. */
export async function fetchDataset({ key, fetchImpl, connector, accountId, dataset, from, to, counter }) {
  let fields = [...dataset.fields];
  const dropped = [];
  for (let attempt = 0; attempt <= MAX_FIELD_RETRIES; attempt += 1) {
    const r = await readOnceRetrying({ key, fetchImpl, connector, accountId, fields, from, to, counter });
    if (r.rows) return { rows: r.rows, dropped };
    // A timeout, rate limit or server failure is never evidence that a field
    // is unsupported, even if the response mentions one of our field names.
    if (!r.transient && r.named.length && attempt < MAX_FIELD_RETRIES) {
      dropped.push(...r.named);
      fields = fields.filter((f) => !r.named.includes(f));
      continue;
    }
    const halves = r.transient ? splitWindow(from, to) : null;
    if (halves) {
      const rows = [];
      for (const [a, b] of halves) {
        const part = await fetchDataset({ key, fetchImpl, connector, accountId,
          dataset: { ...dataset, fields }, from: a, to: b, counter });
        rows.push(...part.rows);
        for (const f of part.dropped) if (!dropped.includes(f)) dropped.push(f);
      }
      return { rows, dropped };
    }
    throw new Error(`${dataset.key}: ${r.error}`);
  }
  throw new Error(`${dataset.key}: too many refused fields`);
}

// ── Hunting: every numeric field, in batches ────────────────────────────────
export const HUNT_BATCH_SIZE = 60;

/** How long one read waits for Windsor. A first, full-width ask gets the long
 *  one: 60 hunted fields over 35 days is genuinely slow. A read that has
 *  already been narrowed — a half, a Windsor table, a grain probe — is a
 *  SUBSET of a question Windsor has already been asked, so it has no business
 *  taking longer; waiting the full two minutes on each of those is what made
 *  one failing account take 29 minutes (run 41977825834). A narrowed read that
 *  times out is halved again rather than trusted, so the shorter wait costs
 *  reads, never data. */
export const READ_TIMEOUT_MS = 120000;
export const NARROWED_READ_TIMEOUT_MS = 60000;

/** One Windsor read of `fields` for one account and window. Resolves
 *  { rows } or { error, named } -- an error never throws, so the caller
 *  decides what a refusal costs. Counts against the call budget. */
async function readOnce({ key, fetchImpl, connector, accountId, fields, from, to, counter, timeoutMs = READ_TIMEOUT_MS }) {
  if (counter) {
    if (counter.used >= counter.limit) throw Object.assign(new Error('call budget used up'), { budget: true });
    counter.used += 1;
  }
  const url = windsorUrl(WINDSOR_CONNECTORS, `/${connector}`, {
    api_key: key, fields: fields.join(','), date_from: from, date_to: to, select_accounts: accountId,
    options: previewOptions(connector),
  });
  let res;
  let text;
  try {
    // `timeoutMs` rides along so a test can see which budget a read used;
    // fetch ignores options it does not know.
    res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), timeoutMs });
    text = await res.text();
  } catch (e) {
    // No answer is not a refusal: the fields may well exist.
    return { error: e?.name === 'TimeoutError' ? 'timed out' : 'network error', named: [], transient: true };
  }
  const body = parseBody(text);
  const errText = !res.ok ? text : (body && typeof body === 'object' && !Array.isArray(body) && body.error ? JSON.stringify(body.error) : '');
  if (!res.ok || errText) {
    return { error: `Windsor answered ${res.status}: ${redact(errText, key)}`, named: fieldsNamedIn(errText, fields),
      // A server error or rate limit says nothing about the fields asked for.
      transient: res.status >= 500 || res.status === 429 };
  }
  const rows = rowsOf(body);
  if (!rows) return { error: `not a list of rows (${describeShape(body)})`, named: [] };
  assertAccountRows(rows, accountId, connector);
  return { rows };
}

/** One read, asked once more if Windsor did not answer (timeout, network,
 *  5xx, 429). A second non-answer stays transient: the caller must not treat
 *  it as a refusal. */
async function readOnceRetrying(io) {
  const r = await readOnce(io);
  return r.transient ? readOnce(io) : r;
}

/** Read one batch of hunted fields. A field Windsor names is dropped and the
 *  rest asked again; a refusal that names nothing is retried once per Windsor
 *  table, so one table that cannot be combined does not cost the others.
 *  Returns { rows: [...] per successful read, refused: [...], incomplete }.
 *  `incomplete` = Windsor did not answer for some fields: the window must not
 *  be written (it would replace stored values) nor counted as covered. */
async function readHuntBatch({ fields, tableOf, state, ...io }) {
  const out = { rows: [], refused: [], unanswered: [], incomplete: false };
  const dims = io.dims;
  let batch = [...fields];
  for (let attempt = 0; attempt <= MAX_FIELD_RETRIES && batch.length; attempt += 1) {
    const r = await readOnceRetrying({ ...io, fields: [...dims, ...batch] });
    if (r.rows) { state.answered += 1; out.rows.push({ fields: [...batch], rows: r.rows }); return out; }
    if (r.transient) {
      // Windsor did not answer this batch. A wide batch can be too slow for
      // it even when each field is fine, so ask again in halves.
      state.failures += 1;
      await readSplitting({ ...io, fields: batch, state, out });
      return out;
    }
    const named = r.named.filter((f) => batch.includes(f));
    if (named.length) { out.refused.push(...named); batch = batch.filter((f) => !named.includes(f)); continue; }
    // Nothing named: split by Windsor table once, then give up on a part.
    const byTable = new Map();
    for (const f of batch) {
      const t = tableOf.get(f) ?? '';
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t).push(f);
    }
    if (byTable.size <= 1) { out.refused.push(...batch); return out; }
    for (const part of byTable.values()) {
      const p = await readOnceRetrying({ ...io, fields: [...dims, ...part], timeoutMs: NARROWED_READ_TIMEOUT_MS });
      if (p.rows) { state.answered += 1; out.rows.push({ fields: [...part], rows: p.rows }); }
      else if (p.transient) { state.failures += 1; await readSplitting({ ...io, fields: part, state, out }); }
      else out.refused.push(...part);
    }
    return out;
  }
  if (batch.length) out.refused.push(...batch);
  return out;
}

/** Unanswered reads a window may spend splitting before it gives up. Each
 *  costs up to two timeouts, so this bounds a Windsor outage's cost. */
export const MAX_UNANSWERED_PER_WINDOW = 8;

/** Ask for `fields` in halves until each part answers. A part that is down to
 *  one field and still gets no answer goes to out.unanswered; when the
 *  window's unanswered budget is spent, whatever is left marks the window
 *  incomplete instead. */
async function readSplitting({ fields, state, out, ...io }) {
  if (state.failures > MAX_UNANSWERED_PER_WINDOW) { out.incomplete = true; return; }
  if (fields.length <= 1) {
    // out.unanswered is where a field can be written off for the rest of the
    // run, so a narrowed read's shorter budget must not be what decides it:
    // that budget is a speed measure, not evidence about the field. Give the
    // last ask the full wait before concluding Windsor will never answer.
    if (fields.length) {
      const last = await readOnce({ ...io, fields: [...io.dims, ...fields], timeoutMs: READ_TIMEOUT_MS });
      if (last.rows) { state.answered += 1; out.rows.push({ fields: [...fields], rows: last.rows }); return; }
      if (!last.transient) { out.refused.push(...fields); return; }
      state.failures += 1;
    }
    out.unanswered.push(...fields);
    return;
  }
  const mid = Math.ceil(fields.length / 2);
  for (const half of [fields.slice(0, mid), fields.slice(mid)]) {
    if (state.failures > MAX_UNANSWERED_PER_WINDOW) { out.incomplete = true; return; }
    const r = await readOnce({ ...io, fields: [...io.dims, ...half], timeoutMs: NARROWED_READ_TIMEOUT_MS });
    if (r.rows) { state.answered += 1; out.rows.push({ fields: [...half], rows: r.rows }); continue; }
    if (r.transient) { state.failures += 1; await readSplitting({ ...io, fields: half, state, out }); continue; }
    const named = r.named.filter((f) => half.includes(f));
    if (named.length) {
      out.refused.push(...named);
      const rest = half.filter((f) => !named.includes(f));
      if (rest.length) await readSplitting({ ...io, fields: rest, state, out });
      continue;
    }
    if (half.length === 1) out.refused.push(...half);
    else await readSplitting({ ...io, fields: half, state, out });
  }
}

/** Reads one hunted batch may spend finding which field broke the row grain.
 *  Bisecting a 60-field batch down to one offender costs about a dozen; the
 *  allowance is double that so a batch with two or three of them still
 *  resolves rather than leaving its window unwritten run after run. */
export const MAX_GRAIN_READS = 24;

/** A hunted read came back at a shape the dataset's row identity cannot
 *  address -- two rows for one account/day/object, or an object id missing.
 *  That is ONE field's doing (TikTok's catalog carries advertiser-level and
 *  lifetime fields that do not belong on a daily campaign row), so the batch
 *  is bisected to find it, it is refused like any other unusable field, and
 *  the rest of the batch still lands. Before this, one such field cost the
 *  whole window. The core read is never isolated this way: it decides which
 *  rows exist, so a core grain failure still fails the window. */
async function isolateGrainOffenders({ fields, validate, state, out, ...io }) {
  if (fields.length <= 1) { out.refused.push(...fields); return; }
  const mid = Math.ceil(fields.length / 2);
  for (const half of [fields.slice(0, mid), fields.slice(mid)]) {
    // Out of reads: these fields have NOT been shown to be the problem, so
    // they are left unresolved rather than refused. An ambiguous batch is no
    // evidence against the fields that travelled in it.
    if (state.grainReads >= MAX_GRAIN_READS) { out.incomplete = true; continue; }
    state.grainReads += 1;
    const r = await readOnce({ ...io, fields: [...io.dims, ...half], timeoutMs: NARROWED_READ_TIMEOUT_MS });
    if (!r.rows) {
      // A refusal names the fields: that is evidence, and they are dropped
      // like any other unusable field. No answer at all is not evidence --
      // treating a timeout as a refusal would let a provider blip erase
      // stored values and still advance the cursor, so the window is marked
      // incomplete and asked again next run instead.
      if (r.transient) out.incomplete = true;
      else out.refused.push(...half);
      continue;
    }
    try {
      validate(r.rows);
      out.good.push(r.rows);
    } catch (e) {
      if (!e?.grain) throw e;
      await isolateGrainOffenders({ ...io, fields: half, validate, state, out });
    }
  }
}

const mergeId = (dataset, r) => `${r?.account_id ?? ''}\u0000${String(r?.date ?? '').slice(0, 10)}\u0000${dataset.mergeKey ? (dataset.mergeKey(r) ?? '') : ''}`;

/** Copy hunted values onto the core rows they belong to (same account, day
 *  and object). A core value is never overwritten, and a hunted row with no
 *  core row is not turned into one: the core read decides which rows exist.
 *  Reports the totals and, per hunted read, how many of ITS rows found a core
 *  row: one read's rows are no evidence about another's, so the verdict has to
 *  be per read. The caller decides what that means. */
export function mergeHunted(dataset, coreRows, huntedRowSets) {
  const index = new Map();
  for (const r of coreRows) if (r && typeof r === 'object') index.set(mergeId(dataset, r), r);
  let unmatched = 0;
  let matched = 0;
  const sets = [];
  for (const set of huntedRowSets) {
    const per = { rows: 0, matched: 0, unmatched: 0 };
    sets.push(per);
    for (const h of set || []) {
      if (!h || typeof h !== 'object') continue;
      per.rows += 1;
      const target = index.get(mergeId(dataset, h));
      if (!target) { unmatched += 1; per.unmatched += 1; continue; }
      matched += 1;
      per.matched += 1;
      for (const [k, v] of Object.entries(h)) if (!(k in target)) target[k] = v;
    }
  }
  return { rows: coreRows, unmatched, matched, sets };
}

/** Core read (dataset.fields, refusals negotiated as before) plus every
 *  numeric field the connector's catalog lists for the dataset's tables, in
 *  batches. Fields refused earlier this run (`skip`) are not asked again. */
export async function fetchDatasetHunted({ key, fetchImpl, connector, accountId, dataset, from, to, counter, catalog, skip = new Set() }) {
  let stage = 'core';
  try {
    const core = await fetchDataset({ key, fetchImpl, connector, accountId, dataset, from, to, counter });
    const validate = (rows) => prepareRows(rows, { accountId, from, to, dataset,
      ctx: { companyId: 'validation-only', accountId, dsId: connector } });
    validate(core.rows);
    if (!dataset.hunt || !catalog || !core.rows.length) return { ...core, refused: [], unmatched: 0, incomplete: false };
    const have = new Set(dataset.fields);
    const extra = huntFields(catalog, dataset.hunt).filter((f) => !have.has(f) && !skip.has(f));
    if (!extra.length) return { ...core, refused: [], unmatched: 0, incomplete: false };
    const tableOf = new Map(catalog.map((f) => [f.id, f.table]));
    // The identity fields go in every batch so hunted rows can be matched.
    const dims = dataset.fields.filter((f) => f === 'date' || f === 'account_id'
      || ['campaign_id', 'campaign', 'flow_id', 'flow_message_id'].includes(f));
    const sets = [];
    const refused = [];
    const unanswered = [];
    let incomplete = false;
    const state = { answered: 0, failures: 0, grainReads: 0 };
    for (let i = 0; i < extra.length; i += HUNT_BATCH_SIZE) {
      stage = `hunted batch ${Math.floor(i / HUNT_BATCH_SIZE) + 1}`;
      const b = await readHuntBatch({ key, fetchImpl, connector, accountId, from, to, counter, dims,
        fields: extra.slice(i, i + HUNT_BATCH_SIZE), tableOf, state });
      for (const set of b.rows) {
        try {
          validate(set.rows);
          sets.push(set.rows);
        } catch (e) {
          if (!e?.grain) throw e;
          const iso = { refused: [], good: [], incomplete: false };
          await isolateGrainOffenders({ key, fetchImpl, connector, accountId, from, to, counter, dims,
            fields: set.fields, validate, state, out: iso });
          refused.push(...iso.refused);
          sets.push(...iso.good);
          // Something in this batch could not be told apart. Writing now
          // would replace stored values without it and count the window as
          // covered, so the window waits for the next run.
          if (iso.incomplete) incomplete = true;
        }
      }
      refused.push(...b.refused);
      unanswered.push(...b.unanswered);
      if (b.incomplete) incomplete = true;
    }
    if (unanswered.length) {
      // Windsor answered for other hunted fields in this window but never for
      // these, even one at a time: the field is the problem, not Windsor. They
      // are dropped like a refusal so the rest of the window still lands. If
      // Windsor answered for none, it is down: keep the window unwritten.
      if (state.answered === 0) incomplete = true;
      else refused.push(...unanswered);
    }
    stage = 'hunted merge';
    const merged = mergeHunted(dataset, core.rows, sets);
    // A hunted read can name an object the core read left out — a campaign
    // with no spend but a nonzero other metric. Dropping that row loses
    // nothing: it was never going to be written, because the core read
    // decides which rows exist, and no core row is left without a value by
    // dropping it. The count is kept in the window's record as
    // `hunted_unmatched`.
    //
    // The verdict is per READ, never over the batch as a whole. One read's
    // rows say nothing about another's, so a read that answered and whose
    // rows matched NOTHING in the core is not excused by a sibling that
    // matched: its fields contributed nothing, and writing the window would
    // replace a stored row's metrics with a row collected without them and
    // count the window as covered.
    const answered = merged.sets.filter((x) => x.rows);
    const blind = answered.filter((x) => !x.matched);
    if (blind.length && blind.length === answered.length) {
      // Not one hunted row anywhere found its core row: the two reads are not
      // describing the same objects at all. That is the grain shift this
      // guard is for, and it is worth failing loudly.
      throw new Error('Hunted rows do not match the core row grain; window not saved');
    }
    // Some reads matched and some matched nothing: not a grain shift, not
    // something to drop either. The window waits for the next run.
    if (blind.length) incomplete = true;
    return { rows: merged.rows, dropped: core.dropped, refused, unmatched: merged.unmatched, incomplete };
  } catch (e) {
    // Only local contract names, planned dates and a batch ordinal: never
    // include account values, response rows or credential-bearing URLs.
    e.message = `${connector}/${dataset.key} ${from}..${to} ${stage}: ${e.message}`;
    throw e;
  }
}

/** Fields whose value lands in a typed column. If Windsor refuses one of
 *  these, writing the window would overwrite a value stored by an earlier run
 *  with 0 or NULL, so that dataset's window is not written at all. */
export function columnFields(dataset) {
  if (dataset.columnFields) return dataset.columnFields;
  return dataset.toRow === tiktokRow ? TIKTOK_COLUMN_FIELDS : [];
}
const TIKTOK_COLUMN_FIELDS = ['impressions', 'clicks', 'spend', 'complete_payment', 'total_complete_payment_rate',
  'initiate_checkout', 'web_event_add_to_cart', 'form', 'campaign_id', 'campaign'];

/** Rows that may be written for this account and window: this account's
 *  rows only, with a real date inside the window, one per identity. */
export function prepareRows(rows, { accountId, from, to, dataset, ctx }) {
  const { kept, foreign, unattributed } = filterRowsToAccount(rows, accountId, ctx.dsId);
  if (foreign || unattributed) throw new Error('Windsor account identity could not be verified; window not saved');
  let outOfWindow = 0;
  let duplicates = 0;
  const byHash = new Map();
  for (const r of kept) {
    const day = String(r.date ?? '').slice(0, 10);
    if (typeof r.date !== 'string' || r.date !== day || !DATE_RE.test(day)
      || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day
      || day < from || day > to) throw new Error('Invalid or out-of-window date; window not saved');
    if (dataset.key !== 'account' && isBlank(dataset.mergeKey?.(r))) {
      // `grain`: the rows came back at a shape this dataset's identity cannot
      // address. For a hunted batch that is one field's fault and is isolated
      // (fetchDatasetHunted); for the core read it still fails the window.
      throw Object.assign(new Error('Missing object identity for row grain; window not saved'), { grain: true });
    }
    const row = dataset.toRow({ ...r, date: day }, ctx);
    if (byHash.has(row.row_hash)) throw Object.assign(new Error('Ambiguous duplicate row grain; window not saved'), { grain: true });
    byHash.set(row.row_hash, row);
  }
  return { rows: [...byHash.values()], foreign, unattributed, outOfWindow, duplicates };
}

/**
 * Sync one windsor_linked_accounts row. Never throws for a Windsor or data
 * problem: the outcome is written to the mapping row and returned, so one
 * client's broken account cannot stop the rest. Returns
 * { status, windows: [...], rows_written, error }.
 */
export async function syncAccount({
  supabase, fetchImpl, key, account, now = new Date(), historyMonths = DEFAULT_HISTORY_MONTHS,
  maxHistoryWindows = 6, counter = null, batchId = null, dryRun = false, log = () => {},
  catalogCache = new Map(), overrides = {},
  // false until 20261103080000 is applied: only hand-made connectors run and
  // refused_fields (a column it adds) is not written.
  anyConnector = true,
}) {
  const ctx = {
    dsId: account.ds_id, companyId: account.company_entity_id, accountId: String(account.account_id),
    accountName: account.account_name ?? null, syncedAt: now.toISOString(), batchId,
  };
  const conn = connectorForSource(account.ds_id);
  const summary = { ds_id: account.ds_id, account_id: ctx.accountId, status: 'success', windows: [], rows_written: 0,
    dropped_fields: [], refused_fields: [], error: null };
  const record = async (patch) => {
    if (dryRun) return;
    const { error } = await supabase.from('windsor_linked_accounts')
      .update({ last_synced_at: ctx.syncedAt, ...patch })
      .eq('id', account.id).eq('company_entity_id', ctx.companyId);
    if (error) throw new Error(`could not record sync state: ${error.message}`);
  };
  // History progress is saved only if the company's field mapping has not
  // changed since this run read it. A change (windsor_field_mappings_rewind)
  // bumps mapping_generation and clears history_from; a run still working
  // under the old mapping must not put its old cursor back over that rewind.
  // Returns false when the mapping moved: stop advancing, the next run
  // re-pulls history under the new mapping.
  const guarded = anyConnector && Number.isInteger(account.mapping_generation);
  const recordProgress = async (patch) => {
    if (dryRun) return true;
    if (!guarded) { await record(patch); return true; }
    const { data, error } = await supabase.from('windsor_linked_accounts')
      .update({ last_synced_at: ctx.syncedAt, ...patch })
      .eq('id', account.id).eq('company_entity_id', ctx.companyId)
      .eq('mapping_generation', account.mapping_generation)
      .select('id');
    if (error) throw new Error(`could not record sync state: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  };
  if (!ctx.companyId) throw new Error('mapping row has no company');
  if (!conn.ok) {
    summary.status = 'unsupported';
    await record({ last_sync_status: 'unsupported', last_sync_error: `not a Windsor data source SILO can read: ${account.ds_id}` });
    return summary;
  }
  // A catalog cannot establish a lossless row grain. Never auto-map unknown sources.
  const datasets = Object.hasOwn(DATASETS, account.ds_id) ? DATASETS[account.ds_id] : null;
  if (!datasets) {
    summary.status = 'unsupported';
    summary.error = 'Sync blocked: this source needs a reviewed identity, date and row-grain contract. Preview remains available.';
    await record({ last_sync_status: 'unsupported', last_sync_error: summary.error });
    return summary;
  }
  if (account.sync_enabled !== true) {
    summary.status = 'paused';
    return summary; // Do not touch history, last sync result, or Windsor while paused.
  }
  if (!catalogCache.has(conn.value)) catalogCache.set(conn.value, await fetchFieldCatalog({ fetchImpl, connector: conn.value }));
  const catalog = catalogCache.get(conn.value);
  const refusedThisRun = new Set();

  const plan = planWindows({ today: pacificToday(now), historyFrom: account.history_from, historyMonths, maxHistoryWindows });
  let historyFrom = account.history_from && account.history_from < plan.recentStart ? account.history_from : plan.recentStart;
  try {
    let incomplete = false;
    for (const w of plan.windows) {
      const wSum = { ...w, datasets: {} };
      summary.windows.push(wSum);
      for (const dataset of datasets) {
        const { rows: raw, dropped, refused, unmatched, incomplete: unanswered } = await fetchDatasetHunted({
          key, fetchImpl, connector: conn.value, accountId: ctx.accountId, dataset, from: w.from, to: w.to, counter,
          catalog, skip: refusedThisRun,
        });
        for (const f of refused) {
          refusedThisRun.add(f);
          if (!summary.refused_fields.includes(f)) summary.refused_fields.push(f);
        }
        for (const d of dropped) if (!summary.dropped_fields.includes(`${dataset.key}.${d}`)) summary.dropped_fields.push(`${dataset.key}.${d}`);
        const prep = prepareRows(raw, { accountId: ctx.accountId, from: w.from, to: w.to, dataset, ctx });
        if (unanswered) {
          // Windsor did not answer for some hunted fields. Writing would
          // replace the stored extra/metrics JSON without them, so this
          // dataset's window is left as it is and asked again next run.
          incomplete = true;
          summary.unanswered = true;
          wSum.datasets[dataset.key] = { returned: raw.length, skipped: 'Windsor did not answer for some fields; asked again next run' };
          continue;
        }
        const blocking = dropped.filter((d) => columnFields(dataset).includes(d));
        if (blocking.length) {
          // Writing would replace stored values of a refused field with 0 or
          // NULL. Skip this dataset's window and do not count it as covered.
          incomplete = true;
          wSum.datasets[dataset.key] = { returned: raw.length, skipped: `Windsor refused ${blocking.join(', ')}` };
          continue;
        }
        const written = dryRun ? 0 : await upsertInChunks(supabase, dataset.table, prep.rows, 'row_hash');
        summary.rows_written += written;
        wSum.datasets[dataset.key] = {
          returned: raw.length, kept: prep.rows.length, written, foreign: prep.foreign,
          unattributed: prep.unattributed, out_of_window: prep.outOfWindow, duplicates: prep.duplicates,
          hunted_unmatched: unmatched, refused: refused.length,
          ...(dryRun ? { field_count: raw[0] && typeof raw[0] === 'object' ? Object.keys(raw[0]).length : 0 } : {}),
        };
        log(`  ${account.ds_id} ${ctx.accountId} ${w.from}..${w.to} ${dataset.key}: ${raw.length} returned, ${prep.rows.length} kept`);
      }
      // Resume point: history is saved only after every dataset of the
      // window landed, so a failure re-pulls the whole window next time.
      // A window with a skipped dataset is not covered: progress stops here
      // so the next run asks again rather than moving past missing data.
      if (incomplete) break;
      if (w.kind === 'history') historyFrom = w.from;
      const kept = w.kind === 'recent'
        ? await recordProgress({ synced_through: plan.end, history_from: historyFrom })
        : await recordProgress({ history_from: historyFrom });
      if (!kept) { summary.mapping_changed = true; break; }
    }
    const historyDone = historyFrom <= plan.target;
    summary.history_from = historyFrom;
    summary.history_complete = historyDone;
    summary.status = summary.dropped_fields.length || summary.unanswered ? 'partial' : 'success';
    const problems = [
      summary.dropped_fields.length ? `Windsor refused: ${summary.dropped_fields.join(', ')}` : null,
      summary.unanswered ? 'Windsor did not answer for some fields; that window is asked again next run' : null,
    ].filter(Boolean);
    await record({
      last_sync_status: summary.status,
      last_sync_error: problems.length ? problems.join('. ').slice(0, 500) : null,
      // Hunted fields Windsor would not return for this account, by name:
      // visible on the mapping row rather than silently missing.
      ...(anyConnector ? { refused_fields: summary.refused_fields.slice(0, 2000) } : {}),
    });
  } catch (e) {
    summary.status = e?.budget ? 'partial' : 'error';
    summary.error = redact(e?.message || String(e), key);
    summary.history_from = historyFrom;
    await record({ last_sync_status: summary.status, last_sync_error: summary.error }).catch(() => {});
  }
  return summary;
}
