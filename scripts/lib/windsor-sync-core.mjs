// Windsor.ai -> SILO tables. Called by scripts/windsor-sync.mjs (GitHub
// Actions, service role).
//
// SILO holds ONE Windsor owner key, so anything read with it can include
// every client's accounts. The tenant boundary is windsor_linked_accounts,
// which the windsor-broker edge function fills only from links SILO minted for
// a company (20261102220000). This sync never decides a company itself:
//   - it reads one mapping row at a time and asks Windsor for THAT account
//     only (select_accounts);
//   - it keeps only returned rows whose account_id is that account's
//     (filterRowsToAccount; a row without one is dropped, not guessed);
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
// Any other data source is recorded as 'unsupported' and skipped.
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
  describeShape, filterRowsToAccount, previewOptions,
} from '../../supabase/functions/windsor-broker/windsor-lib.mjs';
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
  }],
  klaviyo: [
    {
      key: 'account', table: 'klaviyo_performance_daily',
      fields: ['date', 'account_id', 'account_name', ...fieldsOf(KLAVIYO_ACCOUNT_COLUMNS, [
        'revenue_per_recipient', 'sent_sms', 'received_sms', 'clicked_sms', 'checkout_started',
        'checkout_started_value', 'added_to_cart', 'ordered_product', 'ordered_product_value',
        'fulfilled_order', 'fulfilled_order_value', 'cancelled_order', 'refunded_order', 'refunded_order_value'])],
      columnFields: KLAVIYO_ACCOUNT_COLUMNS.map((c) => c[1]),
      toRow: klaviyoRow('account', { columns: KLAVIYO_ACCOUNT_COLUMNS, objectId: () => '' }),
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
    },
  ],
});

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
    return { rows, dropped };
  }
  throw new Error(`${dataset.key}: too many refused fields`);
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
}) {
  const ctx = {
    companyId: account.company_entity_id, accountId: String(account.account_id),
    accountName: account.account_name ?? null, syncedAt: now.toISOString(), batchId,
  };
  const datasets = DATASETS[account.ds_id];
  const conn = connectorForSource(account.ds_id);
  const summary = { ds_id: account.ds_id, account_id: ctx.accountId, status: 'success', windows: [], rows_written: 0, dropped_fields: [], error: null };
  const record = async (patch) => {
    if (dryRun) return;
    const { error } = await supabase.from('windsor_linked_accounts')
      .update({ last_synced_at: ctx.syncedAt, ...patch })
      .eq('id', account.id).eq('company_entity_id', ctx.companyId);
    if (error) throw new Error(`could not record sync state: ${error.message}`);
  };
  if (!ctx.companyId) throw new Error('mapping row has no company');
  if (!datasets || !conn.ok) {
    summary.status = 'unsupported';
    await record({ last_sync_status: 'unsupported', last_sync_error: `no SILO table for data source ${account.ds_id} yet` });
    return summary;
  }

  const plan = planWindows({ today: pacificToday(now), historyFrom: account.history_from, historyMonths, maxHistoryWindows });
  let historyFrom = account.history_from && account.history_from < plan.recentStart ? account.history_from : plan.recentStart;
  try {
    let incomplete = false;
    for (const w of plan.windows) {
      const wSum = { ...w, datasets: {} };
      summary.windows.push(wSum);
      for (const dataset of datasets) {
        const { rows: raw, dropped } = await fetchDataset({
          key, fetchImpl, connector: conn.value, accountId: ctx.accountId, dataset, from: w.from, to: w.to, counter,
        });
        for (const d of dropped) if (!summary.dropped_fields.includes(`${dataset.key}.${d}`)) summary.dropped_fields.push(`${dataset.key}.${d}`);
        const prep = prepareRows(raw, { accountId: ctx.accountId, from: w.from, to: w.to, dataset, ctx });
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
          ...(dryRun ? { sample_keys: raw[0] && typeof raw[0] === 'object' ? Object.keys(raw[0]).sort() : [] } : {}),
        };
        log(`  ${account.ds_id} ${ctx.accountId} ${w.from}..${w.to} ${dataset.key}: ${raw.length} returned, ${prep.rows.length} kept`);
      }
      // Resume point: history is saved only after every dataset of the
      // window landed, so a failure re-pulls the whole window next time.
      // A window with a skipped dataset is not covered: progress stops here
      // so the next run asks again rather than moving past missing data.
      if (incomplete) break;
      if (w.kind === 'history') historyFrom = w.from;
      if (w.kind === 'recent') await record({ synced_through: plan.end, history_from: historyFrom });
      else await record({ history_from: historyFrom });
    }
    const historyDone = historyFrom <= plan.target;
    summary.history_from = historyFrom;
    summary.history_complete = historyDone;
    summary.status = summary.dropped_fields.length ? 'partial' : 'success';
    await record({
      last_sync_status: summary.status,
      last_sync_error: summary.dropped_fields.length ? `Windsor refused: ${summary.dropped_fields.join(', ')}`.slice(0, 500) : null,
    });
  } catch (e) {
    summary.status = e?.budget ? 'partial' : 'error';
    summary.error = redact(e?.message || String(e), key);
    summary.history_from = historyFrom;
    await record({ last_sync_status: summary.status, last_sync_error: summary.error }).catch(() => {});
  }
  return summary;
}
