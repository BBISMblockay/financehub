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
  sleep,
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
  viewContent = null, addToCart = null, initiateCheckout = null,
  thruplays = null, leads = null,
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
    view_content: viewContent == null ? null : Math.round(num(viewContent)),
    add_to_cart: addToCart == null ? null : Math.round(num(addToCart)),
    initiate_checkout: initiateCheckout == null ? null : Math.round(num(initiateCheckout)),
    // Preserve the null/0 distinction all the way to the column: null means
    // the platform did not report the metric, 0 means it reported zero.
    // Google rows never carry these and stay null.
    thruplays: thruplays == null ? null : Math.round(num(thruplays)),
    leads: leads == null ? null : Math.round(num(leads)),
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

// Meta returns errors as a 200-range-adjacent HTTP status (403/500/400) with
// a JSON body describing the failure, not a bare 429 — fetchWithRetry's 429
// handling never sees these, so they were surfacing as hard failures on
// every occurrence (hit live: code 4 "Application request limit reached" and
// code 1 "reduce the amount of data" — sometimes with error_subcode 99,
// sometimes without it — on 2026-08-11 through 08-14, and code 2 "Service
// temporarily unavailable" on 2026-08-14). Meta's own `is_transient` flag is
// NOT a reliable signal — the code 2 case above shipped with
// is_transient:false despite the message describing a transient condition —
// so retry on the specific codes we've observed being retry-worthy in
// practice rather than trusting that flag alone.
const META_RETRY_DELAYS_MS = [30_000, 90_000, 180_000];
const META_RETRYABLE_CODES = new Set([1, 2, 4, 17]);

function isMetaTransientError(bodyText) {
  try {
    const err = JSON.parse(bodyText)?.error;
    if (!err) return false;
    return Boolean(err.is_transient) || META_RETRYABLE_CODES.has(err.code);
  } catch {
    return false;
  }
}

async function fetchMetaJsonOrThrow(url, opts, label) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(url, opts);
    const text = await res.text();
    if (res.ok) {
      try { return JSON.parse(text); } catch {
        throw new Error(`${label}: non-JSON response: ${text.slice(0, 200)}`);
      }
    }
    if (attempt < META_RETRY_DELAYS_MS.length && isMetaTransientError(text)) {
      await sleep(META_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new Error(`${label} → ${res.status}: ${text.slice(0, 500)}`);
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

// Meta's `actions` array mixes every event type an ad triggered (clicks,
// video views, add-to-carts, purchases, ...). omni_* covers on+offsite
// events (the convention already used for purchase); falls back to the bare
// event name for accounts where omni_* isn't populated.
function pickAction(actions, eventName) {
  return (actions ?? []).find((a) => a.action_type === `omni_${eventName}`)
    ?? (actions ?? []).find((a) => a.action_type === eventName);
}

/** Sum an actions[] entry across several possible action_type spellings.
 * Meta reports the same conceptual event under different names depending on
 * how the campaign was built -- a lead is `lead` on some campaigns and
 * `onsite_conversion.lead_grouped` on others -- and picking only one name
 * silently returns 0 for the campaigns using the other. Takes the largest
 * single match rather than summing, since the variants overlap and adding
 * them would double count. */
function pickActionAny(actions, names) {
  let best = null;
  for (const n of names) {
    const hit = pickAction(actions, n);
    const v = hit == null ? null : Number(hit.value);
    if (v != null && Number.isFinite(v) && (best == null || v > best)) best = v;
  }
  return best;
}

const LEAD_ACTION_TYPES = [
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
  'onsite_web_lead',
  'leadgen_grouped',
];

/** Thruplays. Meta exposes these as their own top-level insights field
 * (`video_thruplay_watched_actions`), shaped like actions[]. Some campaigns
 * also surface a thruplay entry inside actions[], so fall back to that before
 * giving up -- but return null, never 0, when neither is present: a campaign
 * that does not report thruplays has not scored zero thruplays. */
function pickThruplays(row) {
  const field = row?.video_thruplay_watched_actions;
  if (Array.isArray(field) && field.length) {
    const total = field.reduce((n, a) => n + (Number(a.value) || 0), 0);
    if (Number.isFinite(total)) return total;
  }
  return pickActionAny(row?.actions, ['video_thruplay_watched', 'thruplay']);
}

/** Meta rejects an ENTIRE insights request if any requested field name is
 * invalid -- so adding a field is not a free action: get the name wrong and
 * the nightly marketing sync stops returning anything at all, not just the
 * new column. `video_thruplay_watched_actions` is documented, but it is not
 * verifiable from here, so callers request it behind a flag that the fetch
 * loop clears and retries without on a field-name rejection. Degrading to
 * "no thruplays" beats taking down spend and ROAS with it. */
function metaInsightFields(base, includeThruplays) {
  return includeThruplays ? `${base},video_thruplay_watched_actions` : base;
}

/** Does this Meta error look like the API rejecting a field NAME, rather than
 * a transient failure worth retrying as-is? Matching the message is ugly, but
 * Meta returns the same generic code (100) for several unrelated problems, so
 * the message is the only thing that distinguishes them. */
function isMetaUnknownFieldError(err) {
  const m = String(err?.message || err || '');
  return /(\(#100\)|param.*fields|Unsupported get request|Tried accessing nonexisting field|Syntax error)/i.test(m)
    && /field|fields/i.test(m);
}

/** Campaign-level daily Meta insights for the standard nightly sync. Chunked
 * into short windows internally for the same reason as fetchMetaAdLevelRows
 * below: a wide time_increment=1 window trips Meta's "reduce the amount of
 * data" error (code 1 / subcode 99) once the account has enough campaigns --
 * hit live on the plain 30-day default window starting 2026-08-11. */
export async function fetchMetaAdsRows(connection, window, { chunkDays = 7 } = {}) {
  const token = connection.access_token;
  if (!token) throw new Error('No access token stored on connection');
  if (!connection.meta_ad_account_id) throw new Error('meta_ad_account_id not configured on connection');

  const acct = String(connection.meta_ad_account_id);
  const rows = [];
  const endAll = new Date(`${window.endDate}T00:00:00Z`);
  // Cleared for the rest of the run the first time Meta rejects the field.
  let withThruplays = true;

  for (let s = new Date(`${window.startDate}T00:00:00Z`); s <= endAll;) {
    const e = new Date(Math.min(s.getTime() + (chunkDays - 1) * 86400000, endAll.getTime()));
    const buildUrl = () => `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?` + new URLSearchParams({
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since: isoDateOnly(s), until: isoDateOnly(e) }),
      fields: metaInsightFields('account_id,account_name,campaign_id,campaign_name,impressions,clicks,spend,actions,action_values', withThruplays),
      limit: '500',
      access_token: token,
    }).toString();
    let url = buildUrl();

    while (url) {
      let data;
      try {
        data = await fetchMetaJsonOrThrow(url, {}, 'Meta insights');
      } catch (err) {
        // Drop the optional field and retry once. Losing thruplays costs a
        // column; losing the request costs spend and ROAS with it.
        if (withThruplays && isMetaUnknownFieldError(err)) {
          console.warn('[warn] Meta rejected video_thruplay_watched_actions, retrying without it:', err.message);
          withThruplays = false;
          url = buildUrl();
          continue;
        }
        throw err;
      }
      for (const r of data.data ?? []) {
        // "Conversions" for a store = purchases — the bottom of the funnel;
        // view_content/add_to_cart/initiate_checkout are the stages above it.
        const purchases = pickAction(r.actions, 'purchase');
        const purchaseValue = pickAction(r.action_values, 'purchase');
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
          viewContent: pickAction(r.actions, 'view_content')?.value ?? 0,
          addToCart: pickAction(r.actions, 'add_to_cart')?.value ?? 0,
          initiateCheckout: pickAction(r.actions, 'initiate_checkout')?.value ?? 0,
          // null, not 0 -- a campaign that does not report the metric has not
          // scored zero on it.
          thruplays: pickThruplays(r),
          leads: pickActionAny(r.actions, LEAD_ACTION_TYPES),
        });
      }
      url = data.paging?.next ?? null;
    }
    s = new Date(e.getTime() + 86400000);
  }
  return rows;
}

/** Ad-level Meta insights (level=ad) for the creative report. Chunked into
 * short windows internally: ad-grain requests are much bigger than campaign
 * grain (many ads per campaign) and even a 3-day window still tripped Meta's
 * "reduce the amount of data" error live on 2026-08-14 (chunkDays=7 failed
 * 2026-08-11 through 08-13 before that). Day-by-day is the smallest window
 * the API supports, so this is the floor short of dropping fields/date
 * granularity — if this still trips the error, the retry-with-backoff in
 * fetchMetaJsonOrThrow is the remaining backstop, not a smaller chunk. */
export async function fetchMetaAdLevelRows(connection, window, { chunkDays = 1 } = {}) {
  const token = connection.access_token;
  if (!token) throw new Error('No access token stored on connection');
  if (!connection.meta_ad_account_id) throw new Error('meta_ad_account_id not configured on connection');

  const acct = String(connection.meta_ad_account_id);
  const rows = [];
  const endAll = new Date(`${window.endDate}T00:00:00Z`);

  for (let s = new Date(`${window.startDate}T00:00:00Z`); s <= endAll;) {
    const e = new Date(Math.min(s.getTime() + (chunkDays - 1) * 86400000, endAll.getTime()));
    let url = `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?` + new URLSearchParams({
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since: isoDateOnly(s), until: isoDateOnly(e) }),
      // Ad level deliberately does NOT request thruplays: meta_ad_performance_daily
      // has no column for them, and the creative table is scoped to purchase
      // campaigns, which are judged on ROAS. Requesting an unused field here
      // would risk the whole ad-level request for nothing.
      fields: 'account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,actions,action_values',
      limit: '500',
      access_token: token,
    }).toString();
    while (url) {
      const data = await fetchMetaJsonOrThrow(url, {}, 'Meta ad-level insights');
      for (const r of data.data ?? []) {
        const purchases = pickAction(r.actions, 'purchase');
        const purchaseValue = pickAction(r.action_values, 'purchase');
        rows.push({
          accountId: r.account_id,
          day: r.date_start,
          campaignId: r.campaign_id, campaignName: r.campaign_name,
          adsetId: r.adset_id, adsetName: r.adset_name,
          adId: r.ad_id, adName: r.ad_name,
          impressions: r.impressions, clicks: r.clicks, spend: r.spend,
          conversions: purchases?.value ?? 0,
          conversionValue: purchaseValue?.value ?? 0,
          viewContent: pickAction(r.actions, 'view_content')?.value ?? 0,
          addToCart: pickAction(r.actions, 'add_to_cart')?.value ?? 0,
          initiateCheckout: pickAction(r.actions, 'initiate_checkout')?.value ?? 0,
        });
      }
      url = data.paging?.next ?? null;
    }
    s = new Date(e.getTime() + 86400000);
  }
  return rows;
}

/** Creative metadata (thumbnail, copy, format, status) for a specific set of
 * ad ids — the ads that actually have performance rows in the window. The
 * account-wide /ads listing spans the account's ENTIRE ad history and trips
 * Meta's request-size limits (observed live), and the lighter ?ids= syntax is
 * deprecated, so this uses the Graph batch API: 50 GETs per POST. Dynamic-
 * creative ads may carry copy in asset feeds rather than body/title; we store
 * whatever the creative exposes. */
export async function fetchMetaAdCreatives(connection, adIds) {
  const token = connection.access_token;
  if (!token) throw new Error('No access token stored on connection');
  const ids = [...new Set((adIds || []).map(String))];
  const fields = encodeURIComponent('id,name,effective_status,campaign_id,adset_id,creative{id,thumbnail_url,body,title,object_type}');
  const out = [];

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map((id) => ({
      method: 'GET', relative_url: `${META_API_VERSION}/${id}?fields=${fields}`,
    }));
    const data = await fetchMetaJsonOrThrow(`https://graph.facebook.com/${META_API_VERSION}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token, batch: JSON.stringify(batch) }).toString(),
    }, 'Meta ads batch');
    if (!Array.isArray(data)) throw new Error(`Meta ads batch: unexpected response shape`);
    for (const item of data) {
      if (!item || item.code !== 200 || !item.body) continue;
      let a;
      try { a = JSON.parse(item.body); } catch { continue; }
      if (!a?.id) continue;
      out.push({
        adId: a.id,
        adName: a.name ?? null,
        campaignId: a.campaign_id ?? null,
        adsetId: a.adset_id ?? null,
        effectiveStatus: a.effective_status ?? null,
        creativeId: a.creative?.id ?? null,
        thumbnailUrl: a.creative?.thumbnail_url ?? null,
        body: a.creative?.body ?? null,
        title: a.creative?.title ?? null,
        objectType: a.creative?.object_type ?? null,
      });
    }
  }
  return out;
}

/** Sync Meta ad-level performance + creatives for one connection. Separate
 * from runConnectionSync so a failure here (bigger, chattier pull) never
 * fails the campaign-level KPI sync. */
export async function runMetaAdLevelSync(supabase, connection, {
  batchId,
  now = new Date(),
  daysBackOverride = null,
} = {}) {
  const window = computeWindow(now, daysBackOverride ?? connection.days_back ?? 30);
  const syncedAt = new Date().toISOString();

  const raw = await fetchMetaAdLevelRows(connection, window);
  const perfRows = raw
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.day ?? '')))
    .map((r) => ({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      account_id: r.accountId != null ? String(r.accountId) : null,
      day_date: r.day,
      campaign_id: r.campaignId != null ? String(r.campaignId) : null,
      campaign_name: r.campaignName ?? null,
      adset_id: r.adsetId != null ? String(r.adsetId) : null,
      adset_name: r.adsetName ?? null,
      ad_id: String(r.adId),
      ad_name: r.adName ?? null,
      impressions: Math.round(Number(String(r.impressions ?? '').replace(/[,$\s]/g, '')) || 0),
      clicks: Math.round(Number(String(r.clicks ?? '').replace(/[,$\s]/g, '')) || 0),
      spend: Number(String(r.spend ?? '').replace(/[,$\s]/g, '')) || 0,
      conversions: Number(String(r.conversions ?? '').replace(/[,$\s]/g, '')) || 0,
      conversion_value: Number(String(r.conversionValue ?? '').replace(/[,$\s]/g, '')) || 0,
      view_content: Math.round(Number(String(r.viewContent ?? '').replace(/[,$\s]/g, '')) || 0),
      add_to_cart: Math.round(Number(String(r.addToCart ?? '').replace(/[,$\s]/g, '')) || 0),
      initiate_checkout: Math.round(Number(String(r.initiateCheckout ?? '').replace(/[,$\s]/g, '')) || 0),
      // Identity only, like marketing_kpis_daily — restatements upsert in place.
      row_hash: hashRow([connection.company_entity_id, 'meta_ads_ad', r.accountId, r.adId, r.day]),
      source: PLATFORM_SOURCES.meta_ads,
      synced_at: syncedAt,
      sync_batch_id: batchId || null,
    }));
  const perfUpserted = await upsertInChunks(supabase, 'meta_ad_performance_daily', perfRows, 'row_hash');

  const creatives = await fetchMetaAdCreatives(connection, raw.map((r) => r.adId));
  const creativeRows = creatives.map((c) => ({
    company_entity_id: connection.company_entity_id,
    ad_id: String(c.adId),
    account_id: connection.meta_ad_account_id ?? null,
    ad_name: c.adName,
    campaign_id: c.campaignId != null ? String(c.campaignId) : null,
    adset_id: c.adsetId != null ? String(c.adsetId) : null,
    effective_status: c.effectiveStatus,
    creative_id: c.creativeId != null ? String(c.creativeId) : null,
    thumbnail_url: c.thumbnailUrl,
    body: c.body,
    title: c.title,
    object_type: c.objectType,
    synced_at: syncedAt,
  }));
  const creativesUpserted = await upsertInChunks(
    supabase, 'meta_ad_creatives', creativeRows, 'company_entity_id,ad_id',
  );

  return {
    window,
    ad_rows_fetched: raw.length,
    ad_rows_upserted: perfUpserted,
    creatives_upserted: creativesUpserted,
    synced_at: syncedAt,
  };
}

// ── Meta organic (Instagram + Facebook Page) ────────────────────────────────
// Separate from the paid-ads tables above: organic content has no spend or
// attribution, just reach/engagement. Rides the same meta_ads connection's
// access_token — no new OAuth flow — but that token needs pages_read_
// engagement/instagram_basic/instagram_manage_insights scopes AND the token's
// System User assigned as an admin/analyst on the Page in Business Manager;
// neither exists yet, so these fetchers no-op gracefully (return empty) until
// instagram_business_account_id/facebook_page_id are set on the connection.

/** Per-post/reel lifetime snapshot (Meta's own media insights are cumulative
 * counters, not a daily series). `views` unifies what used to be separate
 * impressions/video_views metrics — Meta deprecated per-type impressions on
 * IG media insights in 2024. */
/** `max` is the TOTAL number of posts to walk back through; `pageSize` is how
 * many the media list returns per request. These were one number before, which
 * silently made the nightly cap (50) double as the page size -- so asking for a
 * year of history would also have asked Meta for a single page of that size,
 * which it caps anyway. Instagram history is NOT bounded by days_back: media
 * insights are lifetime cumulative counters with no date window, so reaching
 * further back means walking more posts, not widening a date range. Each post
 * costs one extra insights request, so the nightly default stays at 50 and a
 * deeper walk is opt-in via ADS_IG_POST_LIMIT. */
export async function fetchInstagramMediaInsights(connection, { max = 50, pageSize = 50 } = {}) {
  const token = connection.access_token;
  const igId = connection.instagram_business_account_id;
  if (!token || !igId) return [];

  const out = [];
  let url = `https://graph.facebook.com/${META_API_VERSION}/${igId}/media?` + new URLSearchParams({
    fields: 'id,media_type,caption,permalink,thumbnail_url,timestamp,like_count,comments_count',
    limit: String(Math.min(pageSize, 100)),
    access_token: token,
  }).toString();

  while (url && out.length < max) {
    const data = await fetchJsonOrThrow(url, {}, 'Instagram media list');
    for (const m of data.data ?? []) {
      // Stop mid-page rather than finishing it: every post costs its own
      // insights request, so overshooting the cap by up to a page is real
      // wasted API budget against a rate limit this account already trips.
      if (out.length >= max) break;
      let insights = {};
      try {
        const insData = await fetchJsonOrThrow(
          `https://graph.facebook.com/${META_API_VERSION}/${m.id}/insights?` + new URLSearchParams({
            metric: 'views,reach,shares,saved',
            access_token: token,
          }).toString(),
          {}, 'Instagram media insights',
        );
        for (const row of insData.data ?? []) {
          insights[row.name] = row.values?.[0]?.value ?? row.total_value?.value ?? null;
        }
      } catch {
        // Per-post insights can 400 on some media types (e.g. carousels
        // pre-API-version); skip metrics for this post rather than the sync.
      }
      out.push({
        mediaId: m.id,
        mediaType: m.media_type ?? null,
        caption: m.caption ?? null,
        permalink: m.permalink ?? null,
        thumbnailUrl: m.thumbnail_url ?? null,
        postedAt: m.timestamp ?? null,
        views: insights.views ?? null,
        reach: insights.reach ?? null,
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null,
        shares: insights.shares ?? null,
        saved: insights.saved ?? null,
      });
    }
    url = out.length < max ? (data.paging?.next ?? null) : null;
  }
  return out;
}

/** Meta retires Page Insights metrics between Graph versions, and the error
 * it returns — "(#100) The value must be a valid insights metric" — does NOT
 * name the offending metric. Requesting all four in one call therefore means
 * one retired name costs every Page metric: that is exactly what happened on
 * 2026-08-28, the first run after facebook_page_id was set, which logged this
 * error and wrote 0 rows while Instagram in the same run wrote 50. So probe
 * individually on that specific error, keep whatever this version still
 * serves, and report what was dropped rather than failing the half. */
// Meta's own deprecation table maps the retired names to replacements, so
// these are the documented successors rather than guesses:
//   page_impressions        (retired 2025-11-15) → page_media_view
//   page_impressions_unique (retired 2025-06-15) → page_total_media_view_unique
//   page_engaged_users      (retired 2024-03-14) → NOTHING. No replacement is
//     listed, so page_engaged_users is simply not requested any more and its
//     column stays null; it is omitted from the row payload rather than
//     written as 0, because "Meta stopped measuring this" is not zero.
// A media view is not the same measurement as an impression, and a unique
// media view is not the same as reach -- these start a NEW series rather than
// continuing the old one. Nothing here has old values to be confused with
// (the table was empty until 2026-08-28), but do not splice them onto
// historical impression/reach numbers from any other source.
const PAGE_INSIGHT_METRICS = [
  { metric: 'page_media_view', field: 'impressions' },
  { metric: 'page_total_media_view_unique', field: 'reach' },
  { metric: 'page_post_engagements', field: 'postEngagements' },
];

function isMetaInvalidMetricError(err) {
  const msg = String(err?.message || '');
  return msg.includes('(#100)') && /valid insights metric/i.test(msg);
}

function pageInsightsUrl(pageId, token, metrics, window) {
  return `https://graph.facebook.com/${META_API_VERSION}/${pageId}/insights?` + new URLSearchParams({
    metric: metrics.join(','),
    period: 'day',
    since: window.startDate,
    until: window.endDate,
    access_token: token,
  }).toString();
}

/** One metric-set request, chunked and paged.
 *
 * Both halves matter for a backfill and neither did anything at 30 days, which
 * is why their absence went unnoticed: a single un-paged request returns only
 * the first page, so a long window would have come back QUIETLY TRUNCATED --
 * fewer days than asked for, with no error to notice. Chunking keeps each
 * request inside the range Meta will serve; following paging.next collects the
 * whole of each chunk. */
async function fetchPageInsightSeries(pageId, token, metrics, window, chunkDays) {
  const series = [];
  const endAll = new Date(`${window.endDate}T00:00:00Z`);
  for (let start = new Date(`${window.startDate}T00:00:00Z`); start <= endAll;) {
    const end = new Date(Math.min(start.getTime() + chunkDays * 86400000, endAll.getTime()));
    let url = pageInsightsUrl(pageId, token, metrics,
      { startDate: isoDateOnly(start), endDate: isoDateOnly(end) });
    while (url) {
      const data = await fetchJsonOrThrow(url, {}, `Facebook Page insights (${metrics.join(',')})`);
      series.push(...(data.data ?? []));
      url = data.paging?.next ?? null;
    }
    if (end >= endAll) break;
    start = new Date(end.getTime() + 86400000);
  }
  return series;
}

/** Page Insights will not accept the System User token the ads pull uses:
 * it answers "(#190) This method must be called with a Page Access Token".
 * A Page token is derived from the user token by reading it off the Page node
 * itself, and is only issued when the System User actually has the Page
 * assigned as an asset (Business settings → System Users → Assign Assets) —
 * so a null here means the asset assignment is missing, not that the metric
 * or the token is wrong. Instagram is unaffected: media insights authenticate
 * as the IG business account and work with the user token directly, which is
 * why Instagram was landing 50 rows while Page insights returned nothing. */
export async function fetchFacebookPageAccessToken(connection) {
  const token = connection.access_token;
  const pageId = connection.facebook_page_id;
  if (!token || !pageId) return null;
  try {
    const data = await fetchJsonOrThrow(
      `https://graph.facebook.com/${META_API_VERSION}/${pageId}?` + new URLSearchParams({
        fields: 'access_token', access_token: token,
      }).toString(), {}, 'Facebook Page access token',
    );
    return data?.access_token || null;
  } catch (err) {
    console.warn('[warn] Could not derive a Page access token — is the System User assigned to the Page?', err.message);
    return null;
  }
}

/** Page-level daily rollup — a genuine time series, unlike media insights.
 * Returns { days, droppedMetrics } so the caller can record which metrics
 * this Graph version no longer serves instead of silently reporting nulls. */
export async function fetchFacebookPageInsights(connection, window, { chunkDays = 90 } = {}) {
  const pageId = connection.facebook_page_id;
  if (!connection.access_token || !pageId) return { days: [], droppedMetrics: [] };

  // Fall back to the user token rather than bailing: if Meta ever stops
  // requiring the exchange, the pull keeps working unchanged.
  const token = (await fetchFacebookPageAccessToken(connection)) || connection.access_token;

  const series = [];
  const droppedMetrics = [];

  try {
    series.push(...await fetchPageInsightSeries(
      pageId, token, PAGE_INSIGHT_METRICS.map((m) => m.metric), window, chunkDays));
  } catch (err) {
    if (!isMetaInvalidMetricError(err)) throw err;
    console.warn('[warn] Facebook Page insights rejected the metric set — probing each metric individually');
    for (const { metric } of PAGE_INSIGHT_METRICS) {
      try {
        series.push(...await fetchPageInsightSeries(pageId, token, [metric], window, chunkDays));
      } catch (metricErr) {
        if (!isMetaInvalidMetricError(metricErr)) {
          // Carry what the probe already established out with the error —
          // otherwise a later metric failing for an unrelated reason (a token
          // problem, say) discards the record of which earlier metrics are
          // genuinely retired, and the next run has to rediscover it.
          metricErr.droppedMetrics = [...droppedMetrics];
          throw metricErr;
        }
        droppedMetrics.push(metric);
      }
    }
    if (droppedMetrics.length) {
      console.warn(`[warn] Facebook Page insights: Graph ${META_API_VERSION} no longer serves ${droppedMetrics.join(', ')} — skipped`);
    }
  }

  const byDay = new Map();
  for (const s of series) {
    for (const point of s.values ?? []) {
      // Meta's day-period end_time is the END of the bucket -- midnight at the
      // START of the next day in the Page's timezone -- so each value
      // describes the day BEFORE its end_time. Labelling rows with end_time's
      // own date shifts the entire series one day late.
      //
      // Confirmed structurally on 2026-08-28: a request for since=2026-07-29
      // until=2026-08-28 came back with 30 buckets stamped 07-30..08-28. The
      // first is 07-30, not the 07-29 that was asked for, which only happens
      // if the stamp marks the end of each bucket. It also explains why the
      // newest row held the highest media views of the window rather than the
      // fraction of a day it would hold if it really were today.
      const endDay = String(point.end_time || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDay)) continue;
      const day = isoDateOnly(addDays(new Date(`${endDay}T00:00:00Z`), -1));
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, { day });
      byDay.get(day)[s.name] = point.value;
    }
  }
  const days = [...byDay.values()].map((d) => {
    const out = { day: d.day };
    for (const { metric, field } of PAGE_INSIGHT_METRICS) out[field] = d[metric] ?? null;
    return out;
  });
  return { days, droppedMetrics };
}

/** Follower count lives on the Page node, not the insights edge — which is
 * why facebook_page_insights_daily.page_fan_count existed since the table was
 * created and was never written by anything. It is a CURRENT snapshot, not a
 * series, so the caller stamps it on the newest day only; older days keep a
 * null we cannot honestly backfill, and each nightly run adds one more day. */
export async function fetchFacebookPageFanCount(connection) {
  const token = connection.access_token;
  const pageId = connection.facebook_page_id;
  if (!token || !pageId) return null;
  try {
    const data = await fetchJsonOrThrow(
      `https://graph.facebook.com/${META_API_VERSION}/${pageId}?` + new URLSearchParams({
        fields: 'fan_count', access_token: token,
      }).toString(), {}, 'Facebook Page fan_count',
    );
    return data?.fan_count == null ? null : Math.round(num(data.fan_count));
  } catch (err) {
    // A follower count is the least important thing here — never let it cost
    // the daily series that did come back.
    console.warn('[warn] Facebook Page fan_count unavailable:', err.message);
    return null;
  }
}

/** Sync organic Instagram + Facebook data for one meta_ads connection.
 * Called from the orchestrator alongside the ad-level sync, non-fatally —
 * returns a no-op summary until instagram_business_account_id/
 * facebook_page_id are configured (nothing to fetch, not an error). */
export async function runMetaOrganicSync(supabase, connection, {
  now = new Date(),
  daysBackOverride = null,
  igPostLimit = null,
} = {}) {
  const window = computeWindow(now, daysBackOverride ?? connection.days_back ?? 30);
  const syncedAt = new Date().toISOString();

  const media = await fetchInstagramMediaInsights(connection,
    igPostLimit ? { max: Number(igPostLimit) } : {});
  const mediaRows = media.map((m) => ({
    company_entity_id: connection.company_entity_id,
    media_id: String(m.mediaId),
    media_type: m.mediaType,
    caption: m.caption,
    permalink: m.permalink,
    thumbnail_url: m.thumbnailUrl,
    posted_at: m.postedAt,
    views: m.views == null ? null : Math.round(num(m.views)),
    reach: m.reach == null ? null : Math.round(num(m.reach)),
    likes: m.likes == null ? null : Math.round(num(m.likes)),
    comments: m.comments == null ? null : Math.round(num(m.comments)),
    shares: m.shares == null ? null : Math.round(num(m.shares)),
    saved: m.saved == null ? null : Math.round(num(m.saved)),
    synced_at: syncedAt,
  }));
  const mediaUpserted = mediaRows.length
    ? await upsertInChunks(supabase, 'instagram_media_insights', mediaRows, 'company_entity_id,media_id')
    : 0;

  // The Facebook half gets its own try/catch so its failure cannot erase the
  // Instagram result: on 2026-08-28 a Page-metric error propagated out of
  // here and the whole organic summary became {error: ...}, hiding the 50
  // Instagram rows that had already been written two statements above.
  let pageUpserted = 0;
  let pageError = null;
  let droppedMetrics = [];
  let fanCount = null;
  try {
    const { days: pageDays, droppedMetrics: dropped } = await fetchFacebookPageInsights(connection, window);
    droppedMetrics = dropped;

    // page_fan_count is deliberately NOT a column on these rows. It is a
    // current snapshot, not a series, so it only belongs on the newest day —
    // and since each night re-upserts a trailing window, carrying the column
    // here at all would rewrite every previously-stamped day back to null and
    // the series could never accumulate. Omitting the key entirely leaves
    // whatever an earlier run stored intact (PostgREST only updates the
    // columns actually present in the payload); the newest day is then
    // stamped by the targeted update below.
    const pageRows = pageDays.map((d) => ({
      company_entity_id: connection.company_entity_id,
      day_date: d.day,
      page_impressions: d.impressions == null ? null : Math.round(num(d.impressions)),
      page_reach: d.reach == null ? null : Math.round(num(d.reach)),
      page_post_engagements: d.postEngagements == null ? null : Math.round(num(d.postEngagements)),
      row_hash: hashRow([connection.company_entity_id, 'facebook_page', d.day]),
      synced_at: syncedAt,
    }));
    pageUpserted = pageRows.length
      ? await upsertInChunks(supabase, 'facebook_page_insights_daily', pageRows, 'row_hash')
      : 0;

    fanCount = await fetchFacebookPageFanCount(connection);
    if (fanCount != null) {
      // Followers are a snapshot read just now, so they belong on the day
      // currently IN PROGRESS -- one past the last complete day Meta reports --
      // not on the newest finished day, which would date today's count to
      // yesterday. Tomorrow's run fills that same row's engagement columns, so
      // the row converges rather than staying a followers-only orphan.
      const latestDay = pageDays.reduce((mx, d) => (d.day > mx ? d.day : mx), '');
      const fanDay = latestDay
        ? isoDateOnly(addDays(new Date(`${latestDay}T00:00:00Z`), 1))
        : isoDateOnly(new Date());
      // Upsert rather than update: on the first run of a day that row does not
      // exist yet, and an update would silently match nothing. Neither payload
      // carries the other's columns, so the two writes cannot blank each other.
      const { error } = await supabase.from('facebook_page_insights_daily').upsert({
        company_entity_id: connection.company_entity_id,
        day_date: fanDay,
        page_fan_count: fanCount,
        row_hash: hashRow([connection.company_entity_id, 'facebook_page', fanDay]),
        synced_at: syncedAt,
      }, { onConflict: 'row_hash' });
      if (error) console.warn('[warn] Facebook Page fan_count not stamped:', error.message);
    }
  } catch (err) {
    pageError = String(err?.message || err);
    if (Array.isArray(err?.droppedMetrics)) droppedMetrics = err.droppedMetrics;
  }

  return {
    configured: Boolean(connection.instagram_business_account_id || connection.facebook_page_id),
    media_fetched: media.length,
    media_upserted: mediaUpserted,
    page_days_upserted: pageUpserted,
    // Present only when there is something to say, so a clean run's summary
    // stays as small as it was before.
    ...(pageError ? { page_error: pageError } : {}),
    ...(droppedMetrics.length ? { page_metrics_dropped: droppedMetrics } : {}),
    ...(fanCount == null ? {} : { page_fan_count: fanCount }),
    synced_at: syncedAt,
  };
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
