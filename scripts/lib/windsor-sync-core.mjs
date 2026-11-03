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
//   any other connector -> mapped from Windsor's own field list (autoDataset):
//              ad-like ones into marketing_kpis_daily as '<connector>_ads',
//              the rest into windsor_metrics_daily. A company can choose which
//              field fills each SILO measure (windsor_field_mappings).
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
  describeShape, filterRowsToAccount, previewOptions, FIXED_SOURCES, DIRECT_SYNC_SOURCES,
  STANDARD_FIELDS, NUMERIC_TYPES, adPlatformName, chooseMeasures, assertAccountRows,
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
const strOrNull = (v) => (isBlank(v) ? null : String(v).slice(0, 500));

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
      if (!isBlank(r[f])) out.attributes[f] = String(r[f]).slice(0, 500);
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

// ── Any other connector: decided from Windsor's own field list ──────────────
// Windsor publishes every connector's fields with a type
// (https://connectors.windsor.ai/<connector>/fields, public, no key). A
// connector without a hand-made dataset above is mapped from that list:
//   ad-like (spend + impressions + clicks + a campaign) -> marketing_kpis_daily
//   anything else                                        -> windsor_metrics_daily
// and every numeric field the list names is asked for (hunted), so nothing
// the connector reports is left behind.

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

/** The dataset for a connector with no hand-made one, or null when Windsor's
 *  field list cannot place a row (no date or no account_id). */
export function autoDataset(dsId, catalog, overrides = {}) {
  const ids = new Set((catalog || []).map((f) => f.id));
  if (!ids.has('date') || !ids.has('account_id')) return null;
  const campaignId = ids.has('campaign_id') ? 'campaign_id' : null;
  const campaignName = ids.has('campaign') ? 'campaign' : null;
  const dims = ['date', 'account_id', ...(ids.has('account_name') ? ['account_name'] : []),
    ...(campaignId ? [campaignId] : []), ...(campaignName ? [campaignName] : [])];
  // The company's own choices (windsor_field_mappings) win over the
  // automatic pick; the same function decides what the mapping page shows.
  const choice = chooseMeasures(dsId, catalog, overrides);
  const chosen = choice.chosen;
  const mergeKey = (r) => (campaignId ? r[campaignId] : null) ?? (campaignName ? r[campaignName] : null) ?? '';

  if (choice.kind === 'ad') {
    const platform = adPlatformName(dsId);
    if (!platform) return null;
    const core = ['impressions', 'clicks', 'spend', 'conversions', 'revenue'].map((c) => chosen[c]).filter(Boolean);
    const mapped = new Set([...dims, ...core]);
    return {
      key: 'auto', table: 'marketing_kpis_daily', auto: 'ad', platform, ignoredOverrides: choice.ignored,
      fields: [...new Set([...dims, ...core])],
      columnFields: [...core, ...dims.filter((d) => d !== 'date' && d !== 'account_id' && d !== 'account_name')],
      mergeKey, hunt: { tables: null },
      toRow: (r, ctx) => {
        const cid = campaignId ? strOrNull(r[campaignId]) : null;
        const cname = campaignName ? strOrNull(r[campaignName]) : null;
        return {
          company_entity_id: ctx.companyId, connection_id: null, platform, ds_id: platform,
          account_id: ctx.accountId, account_name: strOrNull(r.account_name) ?? ctx.accountName,
          day_date: r.date, campaign_id: cid, campaign_name: cname,
          impressions: intOrNull(r[chosen.impressions]) ?? 0,
          clicks: intOrNull(r[chosen.clicks]) ?? 0,
          spend: numOrNull(r[chosen.spend]) ?? 0,
          // NOT NULL columns. A platform with no conversion field writes 0
          // here and says so in extra._unmapped, so it is not read as zero.
          conversions: chosen.conversions ? (numOrNull(r[chosen.conversions]) ?? 0) : 0,
          conversion_value: chosen.revenue ? (numOrNull(r[chosen.revenue]) ?? 0) : 0,
          extra: {
            ...leftoverNumbers(r, mapped),
            ...(chosen.conversions && chosen.revenue ? {} : {
              _unmapped: ['conversions', 'revenue'].filter((c) => !chosen[c]),
            }),
          },
          // Same identity convention as the direct syncs (platform, platform,
          // account, campaign, day).
          row_hash: hashRow([ctx.companyId, platform, platform, ctx.accountId, cid ?? cname, r.date]),
          source: WINDSOR_SOURCE, synced_at: ctx.syncedAt, sync_batch_id: ctx.batchId,
        };
      },
    };
  }

  const core = Object.values(chosen).filter(Boolean);
  return {
    key: 'auto', table: 'windsor_metrics_daily', auto: 'metrics', ignoredOverrides: choice.ignored,
    fields: [...new Set([...dims, ...core])],
    columnFields: [...core, ...dims.filter((d) => d !== 'date' && d !== 'account_id' && d !== 'account_name')],
    mergeKey, hunt: { tables: null },
    toRow: (r, ctx) => {
      const oid = mergeKey(r);
      const objectId = isBlank(oid) ? '' : String(oid).slice(0, 500);
      const out = {
        company_entity_id: ctx.companyId, ds_id: dsId,
        account_id: ctx.accountId, account_name: strOrNull(r.account_name) ?? ctx.accountName,
        day_date: r.date,
        object_type: campaignId || campaignName ? 'campaign' : 'account',
        object_id: objectId,
        object_name: campaignName ? strOrNull(r[campaignName]) : null,
        metrics: leftoverNumbers(r, new Set(['date', 'account_id', 'account_name'])),
        source: WINDSOR_SOURCE,
        row_hash: hashRow([ctx.companyId, 'windsor', dsId, ctx.accountId, objectId, r.date]),
        synced_at: ctx.syncedAt, sync_batch_id: ctx.batchId,
      };
      for (const col of Object.keys(STANDARD_FIELDS)) out[col] = chosen[col] ? numOrNull(r[chosen[col]]) : null;
      return out;
    },
  };
}

// Never dropped by field negotiation: without them a row cannot be placed.
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

/** Read one dataset for one account and window. Returns the raw rows and the
 *  fields Windsor refused. Throws (redacted) on anything else. */
export async function fetchDataset({ key, fetchImpl, connector, accountId, dataset, from, to, counter }) {
  let fields = [...dataset.fields];
  const dropped = [];
  for (let attempt = 0; attempt <= MAX_FIELD_RETRIES; attempt += 1) {
    if (counter) {
      if (counter.used >= counter.limit) throw Object.assign(new Error('call budget used up'), { budget: true });
      counter.used += 1;
    }
    const url = windsorUrl(WINDSOR_CONNECTORS, `/${connector}`, {
      api_key: key, fields: fields.join(','), date_from: from, date_to: to, select_accounts: accountId,
      // Same server-owned per-connector options as the preview: TikTok sends
      // no rows for inactive campaigns without include_inactive.
      options: previewOptions(connector),
    });
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(120000) });
    } catch (e) {
      throw new Error(`${dataset.key}: ${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
    }
    const text = await res.text().catch(() => '');
    const body = parseBody(text);
    const errText = !res.ok ? text : (body && typeof body === 'object' && !Array.isArray(body) && body.error ? JSON.stringify(body.error) : '');
    if (errText) {
      const named = fieldsNamedIn(errText, fields);
      if (named.length && attempt < MAX_FIELD_RETRIES) {
        dropped.push(...named);
        fields = fields.filter((f) => !named.includes(f));
        continue;
      }
      throw new Error(`${dataset.key}: Windsor answered ${res.status}: ${redact(errText, key)}`);
    }
    const rows = rowsOf(body);
    if (!rows) throw new Error(`${dataset.key}: not a list of rows (${describeShape(body)})`);
    assertAccountRows(rows, accountId);
    return { rows, dropped };
  }
  throw new Error(`${dataset.key}: too many refused fields`);
}

// ── Hunting: every numeric field, in batches ────────────────────────────────
export const HUNT_BATCH_SIZE = 60;

/** One Windsor read of `fields` for one account and window. Resolves
 *  { rows } or { error, named } -- an error never throws, so the caller
 *  decides what a refusal costs. Counts against the call budget. */
async function readOnce({ key, fetchImpl, connector, accountId, fields, from, to, counter }) {
  if (counter) {
    if (counter.used >= counter.limit) throw Object.assign(new Error('call budget used up'), { budget: true });
    counter.used += 1;
  }
  const url = windsorUrl(WINDSOR_CONNECTORS, `/${connector}`, {
    api_key: key, fields: fields.join(','), date_from: from, date_to: to, select_accounts: accountId,
    options: previewOptions(connector),
  });
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(120000) });
  } catch (e) {
    // No answer is not a refusal: the fields may well exist.
    return { error: e?.name === 'TimeoutError' ? 'timed out' : 'network error', named: [], transient: true };
  }
  const text = await res.text().catch(() => '');
  const body = parseBody(text);
  const errText = !res.ok ? text : (body && typeof body === 'object' && !Array.isArray(body) && body.error ? JSON.stringify(body.error) : '');
  if (errText) {
    return { error: `Windsor answered ${res.status}: ${redact(errText, key)}`, named: fieldsNamedIn(errText, fields),
      // A server error or rate limit says nothing about the fields asked for.
      transient: res.status >= 500 || res.status === 429 };
  }
  const rows = rowsOf(body);
  if (!rows) return { error: `not a list of rows (${describeShape(body)})`, named: [] };
  assertAccountRows(rows, accountId);
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
    if (r.rows) { state.answered += 1; out.rows.push(r.rows); return out; }
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
      const p = await readOnceRetrying({ ...io, fields: [...dims, ...part] });
      if (p.rows) { state.answered += 1; out.rows.push(p.rows); }
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
  if (fields.length <= 1) { out.unanswered.push(...fields); return; }
  const mid = Math.ceil(fields.length / 2);
  for (const half of [fields.slice(0, mid), fields.slice(mid)]) {
    if (state.failures > MAX_UNANSWERED_PER_WINDOW) { out.incomplete = true; return; }
    const r = await readOnce({ ...io, fields: [...io.dims, ...half] });
    if (r.rows) { state.answered += 1; out.rows.push(r.rows); continue; }
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

const mergeId = (dataset, r) => `${r?.account_id ?? ''}\u0000${String(r?.date ?? '').slice(0, 10)}\u0000${dataset.mergeKey ? (dataset.mergeKey(r) ?? '') : ''}`;

/** Copy hunted values onto the core rows they belong to (same account, day
 *  and object). A core value is never overwritten, and a hunted row with no
 *  core row is not turned into one: the core read decides which rows exist. */
export function mergeHunted(dataset, coreRows, huntedRowSets) {
  const index = new Map();
  for (const r of coreRows) if (r && typeof r === 'object') index.set(mergeId(dataset, r), r);
  let unmatched = 0;
  for (const set of huntedRowSets) {
    for (const h of set || []) {
      if (!h || typeof h !== 'object') continue;
      const target = index.get(mergeId(dataset, h));
      if (!target) { unmatched += 1; continue; }
      for (const [k, v] of Object.entries(h)) if (!(k in target)) target[k] = v;
    }
  }
  return { rows: coreRows, unmatched };
}

/** Core read (dataset.fields, refusals negotiated as before) plus every
 *  numeric field the connector's catalog lists for the dataset's tables, in
 *  batches. Fields refused earlier this run (`skip`) are not asked again. */
export async function fetchDatasetHunted({ key, fetchImpl, connector, accountId, dataset, from, to, counter, catalog, skip = new Set() }) {
  const core = await fetchDataset({ key, fetchImpl, connector, accountId, dataset, from, to, counter });
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
  const state = { answered: 0, failures: 0 };
  for (let i = 0; i < extra.length; i += HUNT_BATCH_SIZE) {
    const b = await readHuntBatch({ key, fetchImpl, connector, accountId, from, to, counter, dims,
      fields: extra.slice(i, i + HUNT_BATCH_SIZE), tableOf, state });
    sets.push(...b.rows);
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
  const merged = mergeHunted(dataset, core.rows, sets);
  return { rows: merged.rows, dropped: core.dropped, refused, unmatched: merged.unmatched, incomplete };
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
  const { kept, foreign, unattributed } = filterRowsToAccount(rows, accountId);
  if (foreign || unattributed) throw new Error('Windsor account identity could not be verified; window not saved');
  let outOfWindow = 0;
  let duplicates = 0;
  const byHash = new Map();
  for (const r of kept) {
    const day = String(r.date ?? '').slice(0, 10);
    if (!DATE_RE.test(day) || day < from || day > to) { outOfWindow += 1; continue; }
    const row = dataset.toRow({ ...r, date: day }, ctx);
    if (byHash.has(row.row_hash)) duplicates += 1;
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
    companyId: account.company_entity_id, accountId: String(account.account_id),
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
  // Windsor's field list for this connector: what to hunt, and for a
  // connector with no hand-made dataset, how to map it at all. Read once per
  // connector per run.
  if (!catalogCache.has(conn.value)) catalogCache.set(conn.value, await fetchFieldCatalog({ fetchImpl, connector: conn.value }));
  const catalog = catalogCache.get(conn.value);
  let datasets = DATASETS[account.ds_id];
  if (!datasets && !anyConnector) {
    summary.status = 'unsupported';
    await record({ last_sync_status: 'unsupported', last_sync_error: `${account.ds_id} needs migration 20261103080000 (any connector)` });
    return summary;
  }
  if (!datasets) {
    if (!catalog) {
      summary.status = 'error';
      summary.error = `could not read Windsor's field list for ${conn.value}`;
      await record({ last_sync_status: 'error', last_sync_error: summary.error });
      return summary;
    }
    const auto = autoDataset(account.ds_id, catalog, overrides);
    if (!auto) {
      summary.status = 'unsupported';
      await record({ last_sync_status: 'unsupported', last_sync_error: `Windsor lists no date or account_id field for ${account.ds_id}` });
      return summary;
    }
    datasets = [auto];
    summary.mapped_to = auto.table;
    if (auto.ignoredOverrides.length) summary.ignored_mappings = auto.ignoredOverrides;
  }
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
