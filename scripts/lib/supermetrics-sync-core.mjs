// Supermetrics API → marketing_kpis_daily sync logic.
// Called by scripts/supermetrics-sync.mjs (nightly GHA orchestrator).
//
// API: https://docs.supermetrics.com/apidocs — Enterprise v2, Bearer-key auth.
// Queries are per data source (ds_id) with day+campaign granularity; large
// ranges may come back async (schedule_id) and get polled until ready.
//
// Ad platforms restate metrics after the fact (conversions trickle in for up
// to ~28 days), so each night re-pulls a trailing window and upserts on
// row_hash. The hash covers row IDENTITY only (company/platform/account/
// campaign/day) — never metric values — so restated numbers update in place.

import {
  fetchWithRetry,
  hashRow,
  isoDateOnly,
  addDays,
  sleep,
  upsertInChunks,
} from './shopify-sync-core.mjs';

export const SM_API_BASE = 'https://api.supermetrics.com/enterprise/v2';
export const SM_SOURCE = 'supermetrics';

/** Default query fields per platform. Supermetrics field ids vary per
 * connector; anything here can be overridden per source via the
 * supermetrics_connections.sources jsonb ("fields" / "field_map" keys) so a
 * connector mismatch is a config edit, not a code change. */
export const DEFAULT_PLATFORM_CONFIG = {
  google_ads: {
    fields: 'date,profile,profileID,campaignname,campaign_id,impressions,clicks,cost,conversions,conversionvalue',
    field_map: {
      day_date: 'date', account_name: 'profile', account_id: 'profileID',
      campaign_name: 'campaignname', campaign_id: 'campaign_id',
      impressions: 'impressions', clicks: 'clicks', spend: 'cost',
      conversions: 'conversions', conversion_value: 'conversionvalue',
    },
  },
  meta_ads: {
    fields: 'date,profile,profileID,campaignname,campaign_id,impressions,clicks,cost,actions_conversions,action_values_total',
    field_map: {
      day_date: 'date', account_name: 'profile', account_id: 'profileID',
      campaign_name: 'campaignname', campaign_id: 'campaign_id',
      impressions: 'impressions', clicks: 'clicks', spend: 'cost',
      conversions: 'actions_conversions', conversion_value: 'action_values_total',
    },
  },
  tiktok_ads: {
    fields: 'date,profile,profileID,campaignname,campaign_id,impressions,clicks,cost,conversions,conversionvalue',
    field_map: {
      day_date: 'date', account_name: 'profile', account_id: 'profileID',
      campaign_name: 'campaignname', campaign_id: 'campaign_id',
      impressions: 'impressions', clicks: 'clicks', spend: 'cost',
      conversions: 'conversions', conversion_value: 'conversionvalue',
    },
  },
  ga4: {
    fields: 'date,profile,profileID,sessiondefaultchannelgroup,sessions,keyevents,totalrevenue',
    field_map: {
      day_date: 'date', account_name: 'profile', account_id: 'profileID',
      // GA4 has no campaigns in this cut — channel group fills the campaign
      // slot so the row identity stays day × account × channel.
      campaign_name: 'sessiondefaultchannelgroup',
      sessions: 'sessions', conversions: 'keyevents', conversion_value: 'totalrevenue',
    },
  },
};

export function computeWindow(now, daysBack) {
  return {
    startDate: isoDateOnly(addDays(new Date(now), -Number(daysBack || 30))),
    endDate: isoDateOnly(new Date(now)),
  };
}

export function resolvePlatformConfig(source) {
  const defaults = DEFAULT_PLATFORM_CONFIG[source.platform];
  if (!defaults) throw new Error(`Unknown platform: ${source.platform}`);
  return {
    fields: source.fields || defaults.fields,
    field_map: source.field_map || defaults.field_map,
  };
}

export function buildQueryBody(source, { startDate, endDate, maxRows = 100000 } = {}) {
  const { fields } = resolvePlatformConfig(source);
  return {
    ds_id: source.ds_id,
    ds_accounts: source.ds_accounts,
    start_date: startDate,
    end_date: endDate,
    fields,
    max_rows: maxRows,
  };
}

/** Normalize a Supermetrics /query/data/json response.
 * Ready responses carry `data` as an array of arrays whose first row is the
 * header labels; pending async responses carry a schedule_id and a
 * non-final status instead of data. */
export function parseQueryResponse(json) {
  const meta = json?.meta || {};
  const status = (meta.status_code || meta.status || '').toString().toUpperCase();
  const scheduleId = meta.schedule_id || meta.request?.schedule_id || null;
  const pending = !Array.isArray(json?.data)
    && (status === 'PENDING' || status === 'RUNNING' || status === 'QUEUED' || !!scheduleId);

  if (pending) return { pending: true, scheduleId, status };

  const raw = Array.isArray(json?.data) ? json.data : [];
  if (!raw.length) return { pending: false, headers: [], rows: [] };
  const [headers, ...rows] = raw;
  return { pending: false, headers: headers.map((h) => String(h)), rows };
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Map parsed table rows to marketing_kpis_daily upsert rows.
 * Header matching is case/space-insensitive because connector header labels
 * ("Campaign name") differ from the field ids used in the request. */
export function rowsToKpiRows({ headers, rows, source, connection, syncedAt, batchId }) {
  const { field_map } = resolvePlatformConfig(source);
  const norm = (s) => String(s).toLowerCase().replace(/[\s_]/g, '');
  const headerIndex = new Map(headers.map((h, i) => [norm(h), i]));
  const col = (fieldId) => {
    if (!fieldId) return -1;
    const i = headerIndex.get(norm(fieldId));
    return i === undefined ? -1 : i;
  };
  const idx = Object.fromEntries(
    Object.entries(field_map).map(([target, fieldId]) => [target, col(fieldId)]),
  );
  if (idx.day_date === -1) {
    throw new Error(
      `${source.platform}: date column '${field_map.day_date}' not found in response headers [${headers.join(', ')}]`,
    );
  }
  const cell = (row, i) => (i >= 0 ? row[i] : null);

  const out = [];
  for (const row of rows) {
    const dayRaw = String(cell(row, idx.day_date) ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) continue; // skip totals/blank rows
    const accountId = cell(row, idx.account_id);
    const campaignId = cell(row, idx.campaign_id);
    const campaignName = cell(row, idx.campaign_name);
    out.push({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      platform: source.platform,
      ds_id: source.ds_id,
      account_id: accountId != null ? String(accountId) : null,
      account_name: cell(row, idx.account_name) ?? null,
      day_date: dayRaw,
      campaign_id: campaignId != null ? String(campaignId) : null,
      campaign_name: campaignName != null ? String(campaignName) : null,
      impressions: Math.round(num(cell(row, idx.impressions))),
      clicks: Math.round(num(cell(row, idx.clicks))),
      spend: num(cell(row, idx.spend)),
      conversions: num(cell(row, idx.conversions)),
      conversion_value: num(cell(row, idx.conversion_value)),
      sessions: idx.sessions >= 0 ? Math.round(num(cell(row, idx.sessions))) : null,
      // Identity only — metrics stay out so restated numbers upsert in place.
      row_hash: hashRow([
        connection.company_entity_id, source.platform, source.ds_id,
        accountId, campaignId ?? campaignName, dayRaw,
      ]),
      source: SM_SOURCE,
      synced_at: syncedAt,
      sync_batch_id: batchId || null,
    });
  }
  return out;
}

async function smFetchJson(apiKey, path, { method = 'GET', body } = {}) {
  const res = await fetchWithRetry(`${SM_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supermetrics ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch {
    throw new Error(`Supermetrics ${path}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

/** Run one source's query, following the async poll loop if needed. */
export async function executeQuery(apiKey, source, window, {
  pollIntervalMs = 5000,
  maxPollMs = 10 * 60 * 1000,
  fetchJson = smFetchJson,
} = {}) {
  let parsed = parseQueryResponse(
    await fetchJson(apiKey, '/query/data/json', { method: 'POST', body: buildQueryBody(source, window) }),
  );
  const deadline = Date.now() + maxPollMs;
  while (parsed.pending) {
    if (!parsed.scheduleId) throw new Error(`${source.platform}: pending response without schedule_id`);
    if (Date.now() > deadline) throw new Error(`${source.platform}: query still pending after ${maxPollMs / 1000}s`);
    await sleep(pollIntervalMs);
    parsed = parseQueryResponse(
      await fetchJson(apiKey, `/query/data/json?schedule_id=${encodeURIComponent(parsed.scheduleId)}`),
    );
  }
  return parsed;
}

/** Sync one configured source for one connection. */
export async function runSourceSync(supabase, apiKey, connection, source, {
  batchId,
  now = new Date(),
  daysBackOverride = null,
  fetchJson = smFetchJson,
} = {}) {
  const window = computeWindow(now, daysBackOverride ?? connection.days_back ?? 30);
  const syncedAt = new Date().toISOString();
  const { headers, rows } = await executeQuery(apiKey, source, window, { fetchJson });
  const kpiRows = rowsToKpiRows({ headers, rows, source, connection, syncedAt, batchId });
  const upserted = await upsertInChunks(supabase, 'marketing_kpis_daily', kpiRows, 'row_hash');
  return {
    platform: source.platform,
    ds_id: source.ds_id,
    window,
    rows_fetched: rows.length,
    kpi_rows_upserted: upserted,
    synced_at: syncedAt,
  };
}
