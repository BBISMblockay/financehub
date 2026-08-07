// Direct ad-platform APIs → marketing_kpis_daily sync logic.
// Called by scripts/ad-platforms-sync.mjs (nightly GHA orchestrator).
// Replaces the Supermetrics middleman (scripts/lib/supermetrics-sync-core.mjs,
// removed) with one fetcher per platform:
//   google_ads — Google Ads API GAQL search (OAuth refresh token per
//     connection + shared GOOGLE_ADS_DEVELOPER_TOKEN env)
//   meta_ads   — Meta Marketing API insights (long-lived System User token
//     stored on the connection)
//   tiktok_ads — TikTok Marketing API integrated report (OAuth token stored
//     on the connection)
//   ga4        — GA4 Data API runReport (OAuth refresh token; channel group
//     fills the campaign slot so row identity stays day × property × channel)
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
  upsertInChunks,
} from './shopify-sync-core.mjs';

// Both platforms retire API versions on a schedule (Google Ads majors ~12
// months, Meta Graph ~2 years) — a sunset version fails with an HTML 404
// (Google) or an explicit version error (Meta). Bump these when tests start
// failing that way; keep GOOGLE_ADS_API_VERSION in sync with the copy in
// supabase/functions/test-ad-platform-connection/index.ts.
export const GOOGLE_ADS_API_VERSION = 'v24';
export const META_API_VERSION = 'v25.0';
export const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export function computeWindow(now, daysBack) {
  return {
    startDate: isoDateOnly(addDays(new Date(now), -Number(daysBack || 30))),
    endDate: isoDateOnly(new Date(now)),
  };
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function kpiRow(connection, platform, { accountId, accountName, day, campaignId, campaignName,
  impressions = 0, clicks = 0, spend = 0, conversions = 0, conversionValue = 0, sessions = null,
}, { syncedAt, batchId, source }) {
  return {
    company_entity_id: connection.company_entity_id,
    connection_id: connection.id,
    platform,
    ds_id: platform, // legacy Supermetrics data-source column; not null, so platform stands in
    account_id: accountId != null ? String(accountId) : null,
    account_name: accountName ?? null,
    day_date: day,
    campaign_id: campaignId != null ? String(campaignId) : null,
    campaign_name: campaignName != null ? String(campaignName) : null,
    impressions: Math.round(num(impressions)),
    clicks: Math.round(num(clicks)),
    spend: num(spend),
    conversions: num(conversions),
    conversion_value: num(conversionValue),
    sessions: sessions == null ? null : Math.round(num(sessions)),
    // Identity only — metrics stay out so restated numbers upsert in place.
    row_hash: hashRow([
      connection.company_entity_id, platform, platform,
      accountId, campaignId ?? campaignName, day,
    ]),
    source,
    synced_at: syncedAt,
    sync_batch_id: batchId || null,
  };
}

async function fetchJsonOrThrow(url, opts, label) {
  const res = await fetchWithRetry(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} → ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch {
    throw new Error(`${label}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

// ── Google OAuth ────────────────────────────────────────────────────────────

export async function refreshGoogleAccessToken(env, refreshToken) {
  const data = await fetchJsonOrThrow('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  }, 'Google token refresh');
  if (!data.access_token) throw new Error('Google token refresh: no access_token in response');
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
  };
}

// ── Google Ads ──────────────────────────────────────────────────────────────

export async function fetchGoogleAdsRows(env, connection, accessToken, window) {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN not set');
  if (!connection.google_customer_id) throw new Error('google_customer_id not configured on connection');

  const cid = String(connection.google_customer_id).replace(/-/g, '');
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (connection.google_login_customer_id) {
    headers['login-customer-id'] = String(connection.google_login_customer_id).replace(/-/g, '');
  }

  const query = `
    SELECT
      customer.id, customer.descriptive_name,
      campaign.id, campaign.name,
      segments.date,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${window.startDate}' AND '${window.endDate}'
  `;

  const rows = [];
  let pageToken = null;
  do {
    const body = { query, ...(pageToken ? { pageToken } : {}) };
    const data = await fetchJsonOrThrow(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cid}/googleAds:search`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      'Google Ads search',
    );
    for (const r of data.results ?? []) {
      rows.push({
        accountId: r.customer?.id ?? cid,
        accountName: r.customer?.descriptiveName ?? null,
        day: r.segments?.date,
        campaignId: r.campaign?.id,
        campaignName: r.campaign?.name,
        impressions: r.metrics?.impressions,
        clicks: r.metrics?.clicks,
        spend: Number(r.metrics?.costMicros ?? 0) / 1e6,
        conversions: r.metrics?.conversions,
        conversionValue: r.metrics?.conversionsValue,
      });
    }
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);
  return rows;
}

// ── Meta Ads ────────────────────────────────────────────────────────────────

export async function fetchMetaAdsRows(connection, window) {
  const token = connection.access_token;
  if (!token) throw new Error('No access token stored on connection');
  if (!connection.meta_ad_account_id) throw new Error('meta_ad_account_id not configured on connection');

  const acct = String(connection.meta_ad_account_id);
  const rows = [];
  let url = `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?` + new URLSearchParams({
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since: window.startDate, until: window.endDate }),
    fields: 'account_id,account_name,campaign_id,campaign_name,impressions,clicks,spend,actions,action_values',
    limit: '500',
    access_token: token,
  }).toString();

  while (url) {
    const data = await fetchJsonOrThrow(url, {}, 'Meta insights');
    for (const r of data.data ?? []) {
      // "Conversions" for a store = purchases. Meta's actions array mixes
      // every event type; omni_purchase covers on+offsite purchase counts.
      const purchases = (r.actions ?? []).find((a) => a.action_type === 'omni_purchase')
        ?? (r.actions ?? []).find((a) => a.action_type === 'purchase');
      const purchaseValue = (r.action_values ?? []).find((a) => a.action_type === 'omni_purchase')
        ?? (r.action_values ?? []).find((a) => a.action_type === 'purchase');
      rows.push({
        accountId: r.account_id,
        accountName: r.account_name,
        day: r.date_start,
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        impressions: r.impressions,
        clicks: r.clicks,
        spend: r.spend,
        conversions: purchases?.value ?? 0,
        conversionValue: purchaseValue?.value ?? 0,
      });
    }
    url = data.paging?.next ?? null;
  }
  return rows;
}

// ── TikTok Ads ──────────────────────────────────────────────────────────────

export async function fetchTiktokAdsRows(connection, window) {
  const token = connection.access_token;
  if (!token) throw new Error('No access token stored on connection');
  if (!connection.tiktok_advertiser_id) throw new Error('tiktok_advertiser_id not configured on connection');

  const advertiserId = String(connection.tiktok_advertiser_id);
  const rows = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const params = new URLSearchParams({
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
      metrics: JSON.stringify([
        'campaign_name', 'impressions', 'clicks', 'spend',
        'complete_payment', 'total_complete_payment_rate',
      ]),
      start_date: window.startDate,
      end_date: window.endDate,
      page: String(page),
      page_size: '1000',
    });
    const data = await fetchJsonOrThrow(
      `${TIKTOK_API_BASE}/report/integrated/get/?${params}`,
      { headers: { 'Access-Token': token } },
      'TikTok report',
    );
    if (data.code !== 0) throw new Error(`TikTok report: ${data.message}`);
    for (const r of data.data?.list ?? []) {
      const d = r.dimensions ?? {};
      const m = r.metrics ?? {};
      rows.push({
        accountId: advertiserId,
        accountName: connection.display_name ?? null,
        day: String(d.stat_time_day ?? '').slice(0, 10),
        campaignId: d.campaign_id,
        campaignName: m.campaign_name,
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.spend,
        // complete_payment = purchase count; total_complete_payment_rate is
        // TikTok's name for total purchase VALUE (not a rate).
        conversions: m.complete_payment,
        conversionValue: m.total_complete_payment_rate,
      });
    }
    const pageInfo = data.data?.page_info ?? {};
    totalPages = Number(pageInfo.total_page ?? 1);
    page += 1;
  }
  return rows;
}

// ── GA4 ─────────────────────────────────────────────────────────────────────

export async function fetchGa4Rows(connection, accessToken, window) {
  if (!connection.ga4_property_id) throw new Error('ga4_property_id not configured on connection');
  const prop = String(connection.ga4_property_id).replace(/^properties\//, '');

  const rows = [];
  let offset = 0;
  const limit = 10000;
  let total = Infinity;

  while (offset < total) {
    const data = await fetchJsonOrThrow(
      `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: window.startDate, endDate: window.endDate }],
          dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
          limit: String(limit),
          offset: String(offset),
        }),
      },
      'GA4 runReport',
    );
    total = Number(data.rowCount ?? 0);
    for (const r of data.rows ?? []) {
      const dims = (r.dimensionValues ?? []).map((d) => d.value);
      const mets = (r.metricValues ?? []).map((m) => m.value);
      const raw = String(dims[0] ?? ''); // YYYYMMDD
      const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      rows.push({
        accountId: prop,
        accountName: connection.display_name ?? null,
        day,
        campaignId: null,
        // GA4 has no campaigns in this cut — channel group fills the campaign
        // slot so the row identity stays day × property × channel.
        campaignName: dims[1] ?? null,
        sessions: mets[0],
        conversions: mets[1],
        conversionValue: mets[2],
      });
    }
    offset += limit;
    if (!(data.rows ?? []).length) break;
  }
  return rows;
}

// ── Orchestration entry ─────────────────────────────────────────────────────

export const PLATFORM_SOURCES = {
  google_ads: 'google_ads_api',
  meta_ads: 'meta_ads_api',
  tiktok_ads: 'tiktok_ads_api',
  ga4: 'ga4_api',
};

/** Sync one connection. `env` carries GOOGLE_* secrets; `onTokenRefresh` lets
 * the orchestrator persist a rotated Google access token back to the row. */
export async function runConnectionSync(supabase, env, connection, {
  batchId,
  now = new Date(),
  daysBackOverride = null,
  onTokenRefresh = null,
} = {}) {
  const window = computeWindow(now, daysBackOverride ?? connection.days_back ?? 30);
  const syncedAt = new Date().toISOString();
  const platform = connection.platform;

  let raw;
  if (platform === 'google_ads' || platform === 'ga4') {
    if (!connection.refresh_token) throw new Error('No refresh token — reconnect via OAuth');
    const { accessToken, expiresAt } = await refreshGoogleAccessToken(env, connection.refresh_token);
    if (onTokenRefresh) await onTokenRefresh(accessToken, expiresAt);
    raw = platform === 'google_ads'
      ? await fetchGoogleAdsRows(env, connection, accessToken, window)
      : await fetchGa4Rows(connection, accessToken, window);
  } else if (platform === 'meta_ads') {
    raw = await fetchMetaAdsRows(connection, window);
  } else if (platform === 'tiktok_ads') {
    raw = await fetchTiktokAdsRows(connection, window);
  } else {
    throw new Error(`Unknown platform: ${platform}`);
  }

  const source = PLATFORM_SOURCES[platform];
  const kpiRows = raw
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.day ?? '')))
    .map((r) => kpiRow(connection, platform, r, { syncedAt, batchId, source }));

  const upserted = await upsertInChunks(supabase, 'marketing_kpis_daily', kpiRows, 'row_hash');
  return {
    platform,
    window,
    rows_fetched: raw.length,
    kpi_rows_upserted: upserted,
    synced_at: syncedAt,
  };
}
