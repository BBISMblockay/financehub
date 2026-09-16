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

/** The business day is PACIFIC, not UTC, and the difference is not cosmetic.
 * isoDateOnly() is UTC, so between 5pm and midnight Pacific (00:00-07:00 UTC
 * the next day) a UTC "today" is already tomorrow -- and the window would then
 * treat the still-running Pacific day as a finished past day and write it as
 * complete. That is exactly how 2026-08-30 was recorded: a self-heal run at
 * 01:1x UTC on 08-31 (6:1x pm Pacific on the 30th) wrote the 30th as closed
 * with six hours of selling still to go, and nothing corrected it until the
 * next morning.
 *
 * check-sales-freshness.mjs already reasons in Pacific and says so in its own
 * comments; this is the sync finally agreeing with the alarm about what day it
 * is. With the [startDate, endDate) clamp in fetchFacebookPageInsights, an
 * endDate of Pacific-today means the newest day written is always Pacific
 * YESTERDAY -- a genuinely complete day -- no matter what hour the run fires.
 * That is what makes a late or extra cron harmless instead of corrupting. */
export function pacificDateOnly(d = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is the shape every day_date uses.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function computeWindow(now, daysBack) {
  const endDate = pacificDateOnly(new Date(now));
  return {
    startDate: isoDateOnly(addDays(new Date(`${endDate}T00:00:00Z`), -Number(daysBack || 30))),
    endDate,
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
  // Ad level now DOES request thruplays. The old comment here said it
  // deliberately did not, because the table had no column and the creative
  // card was purchase-only -- both stopped being true when the card grew a
  // Thruplays/Subscribers/Followers split, which cannot judge a video buy on
  // a metric nobody fetched. Leads need no new field at all: they come out of
  // the `actions` array this request already asks for.
  //
  // Same guard as campaign level: Meta rejects the ENTIRE insights request on
  // one bad field name, so this is dropped and retried once rather than taking
  // ad-level spend down with it.
  let withThruplays = true;

  for (let s = new Date(`${window.startDate}T00:00:00Z`); s <= endAll;) {
    const e = new Date(Math.min(s.getTime() + (chunkDays - 1) * 86400000, endAll.getTime()));
    const buildUrl = () => `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights?` + new URLSearchParams({
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since: isoDateOnly(s), until: isoDateOnly(e) }),
      fields: metaInsightFields(
        'account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,actions,action_values',
        withThruplays,
      ),
      limit: '500',
      access_token: token,
    }).toString();
    let url = buildUrl();
    while (url) {
      let data;
      try {
        data = await fetchMetaJsonOrThrow(url, {}, 'Meta ad-level insights');
      } catch (err) {
        if (withThruplays && isMetaUnknownFieldError(err)) {
          console.warn('[warn] Meta rejected video_thruplay_watched_actions at ad level, retrying without it:', err.message);
          withThruplays = false;
          url = buildUrl();
          continue;
        }
        throw err;
      }
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
          // null, never 0, exactly as at campaign level: an ad that does not
          // report the metric has not scored zero on it, and 0 would make a
          // video ad look like it failed at the thing it was bought for.
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

/** The optional creative fields, as an ACTIVE SET that loses exactly what Meta
 * refuses -- not a fixed ladder.
 *
 * Two versions of this were wrong, in the same way, and the second claimed to
 * fix the first.
 *
 *   v1 requested all of these as ONE tier with an all-or-nothing downgrade.
 *   Production: `0/126 resolved (none) — link fields REFUSED`. One unacceptable
 *   field cost every other, including asset_feed_spec -- which measurement
 *   later showed supplies EVERY resolved destination on this account.
 *
 *   v2 replaced that with a fixed six-step ladder that always dropped
 *   asset_feed_spec first. It parsed the field Meta named and used it ONLY for
 *   logging. So if the account accepts asset_feed_spec and refuses object_url:
 *   step 1 drops asset_feed_spec and retries the same bad field, step 2 finally
 *   drops object_url -- and a Dynamic Creative ad whose only destination is
 *   asset_feed_spec.link_urls now stores null against a field Meta was happy to
 *   serve. Exactly the "one bad field costs another" the change said it removed.
 *
 * So: Meta names the field in its error, and that is the field that goes. The
 * ordered list below is the fallback for a refusal that names NOTHING, and only
 * then.
 *
 * MEASURED ON THE LIVE ACCOUNT, 2026-09-16, and it inverted the guess this file
 * used to encode. The run log:
 *
 *   [warn] Meta refused creative field effective_object_url per item
 *   [meta] creative links: 82/126 resolved (asset_feed=82)
 *          [asked: object_url,url_tags,asset_feed_spec, refused: effective_object_url]
 *
 *   - effective_object_url is REFUSED by this account as an unknown field, so
 *     it can never resolve anything. It is no longer requested at all. It was
 *     described here as "the only source a page-post ad has"; that was wrong.
 *     All 82 resolved ads ARE object_type SHARE and every one came from
 *     asset_feed_spec. To reinstate it (a different account, a later API
 *     version) add it back to CREATIVE_OPTIONAL_FIELDS, CREATIVE_DROP_ORDER
 *     and resolveCreativeLink's candidate list.
 *   - asset_feed_spec supplies 100% of resolved links. It used to be dropped
 *     FIRST as "the riskiest"; on an unnamed refusal that would have discarded
 *     every destination this account has.
 *
 * The drop order is therefore least-costly-to-lose first: url_tags is UTM
 * metadata, object_url is a destination candidate that currently resolves
 * nothing, asset_feed_spec is everything. */
const CREATIVE_OPTIONAL_FIELDS = ['object_url', 'url_tags', 'asset_feed_spec'];
const CREATIVE_DROP_ORDER = ['url_tags', 'object_url', 'asset_feed_spec'];
/** Fields whose Graph selection is not just the field name. */
const CREATIVE_FIELD_SELECTION = { asset_feed_spec: 'asset_feed_spec{link_urls}' };
/** A refusal can name the SUBfield; map it back to the field that carries it. */
const CREATIVE_FIELD_ALIASES = { link_urls: 'asset_feed_spec' };

function metaCreativeFields(active) {
  const optional = CREATIVE_OPTIONAL_FIELDS
    .filter((f) => active.has(f))
    .map((f) => CREATIVE_FIELD_SELECTION[f] || f);
  const sub = 'id,thumbnail_url,body,title,object_type,'
    + 'effective_object_story_id,object_story_spec'
    + (optional.length ? `,${optional.join(',')}` : '');
  return encodeURIComponent(
    `id,name,effective_status,campaign_id,adset_id,creative{${sub}}`);
}

/** The optional field a refusal message names, or null.
 *
 * Normalised, because Meta writes it as it was SENT: a nested selection comes
 * back as `asset_feed_spec{link_urls}` or as the bare subfield. Anything that
 * does not resolve to one of our optional fields returns null, which is the
 * signal to fall back to CREATIVE_DROP_ORDER rather than to guess. */
function normalizeRefusedField(named) {
  if (!named) return null;
  const k = String(named).trim().toLowerCase().replace(/[{(].*$/, '').trim();
  if (CREATIVE_FIELD_ALIASES[k]) return CREATIVE_FIELD_ALIASES[k];
  return CREATIVE_OPTIONAL_FIELDS.includes(k) ? k : null;
}

/** Remove the named field; fall back to the riskiest remaining one only when
 * the refusal named nothing we recognise. Returns what was dropped, or null
 * when there is nothing left to drop. */
function dropRefusedField(active, named) {
  const key = normalizeRefusedField(named);
  if (key && active.has(key)) { active.delete(key); return key; }
  const next = CREATIVE_DROP_ORDER.find((f) => active.has(f));
  if (next) { active.delete(next); return next; }
  return null;
}

/** True when a batch response carries a per-item error that names a field.
 *
 * Deliberately not "any item failed": a single deleted ad or a permission
 * error on one creative is normal and must not narrow the field set for
 * the whole run. An unknown-field error is deterministic across every item,
 * so seeing one is enough to conclude a field is not accepted. */
function metaBatchRejectedFields(data) {
  if (!Array.isArray(data)) return false;
  return data.some((item) => {
    if (!item || item.code === 200) return false;
    let msg = item.body || '';
    try { msg = JSON.parse(item.body)?.error?.message || msg; } catch { /* keep raw */ }
    return isMetaUnknownFieldError(new Error(String(msg)));
  });
}

/** The field name out of a Meta error message, for dropping and for the log. */
function metaFieldNameFromMessage(msg) {
  const named = /nonexisting field \(([^)]+)\)|field ([\w{}]+)/i.exec(String(msg || ''));
  return named ? (named[1] || named[2]) : null;
}

/** The field name Meta named in a per-item error.
 *
 * Without it a refusal says only that SOMETHING was refused, and the next
 * person re-guesses which -- which is how a three-field tier shipped with its
 * failing member never identified. */
function metaRejectedFieldName(data) {
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (!item || item.code === 200) continue;
    let msg = item.body || '';
    try { msg = JSON.parse(item.body)?.error?.message || msg; } catch { /* keep raw */ }
    const named = metaFieldNameFromMessage(msg);
    if (named) return named;
  }
  return null;
}

/** Where an ad's destination URL comes from, most specific first.
 *
 * Order is the whole design. link_data/video_data hold the destination the
 * ADVERTISER typed on this ad, so they win wherever they exist. asset_feed_spec
 * (Dynamic Creative) and object_url come after, being the creative's resolved
 * destination rather than one typed on the ad.
 *
 * The source is recorded because a resolved destination is not automatically a
 * landing page: on a page-post ad Meta can resolve one to the POST. Measured
 * 2026-09-16, none did -- all 82 were baseballism.com -- but "none did on this
 * run" is not "none can", so every reader still shows the HOST. A facebook.com
 * host visible on screen is the reader finding that out; a bare
 * "/collections/new" that was never on the site is not.
 *
 * Every entry returns a string or null. The first non-null wins, and its key
 * is stored as link_url_source. */
function resolveCreativeLink(creative) {
  const spec = creative?.object_story_spec || {};
  const ctaLink = (d) => d?.call_to_action?.value?.link ?? null;
  const firstCard = (spec.link_data?.child_attachments || [])
    .find((c) => c && typeof c.link === 'string' && c.link.trim());
  const feedUrl = (creative?.asset_feed_spec?.link_urls || [])
    .find((u) => u && typeof u.website_url === 'string' && u.website_url.trim());
  const candidates = [
    ['link_data', spec.link_data?.link],
    ['video_cta', ctaLink(spec.video_data)],
    ['link_data_cta', ctaLink(spec.link_data)],
    ['carousel_card', firstCard?.link],
    ['photo_cta', ctaLink(spec.photo_data)],
    ['asset_feed', feedUrl?.website_url],
    // effective_object_url is deliberately absent: this account refuses it as
    // an unknown field, so it is not requested and could never arrive. Reading
    // a field nothing asks for is dead code that reads like coverage -- and
    // this one read like the page-post ads' lifeline while supplying nothing.
    ['object_url', creative?.object_url],
  ];
  for (const [source, raw] of candidates) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    // Only http(s), and no whitespace -- the same single gate v3 puts between
    // a stored value and an href. A destination that is not a web URL (an
    // app deep link, a messenger thread) is not a landing page, and storing
    // it would put a value in front of a reader that the UI must then refuse
    // to render anyway.
    if (!/^https?:\/\/[^\s<>"']+$/i.test(v)) continue;
    return { url: v, source };
  }
  return { url: null, source: null };
}

/** Creative metadata (thumbnail, copy, format, status) for a specific set of
 * ad ids — the ads that actually have performance rows in the window. The
 * account-wide /ads listing spans the account's ENTIRE ad history and trips
 * Meta's request-size limits (observed live), and the lighter ?ids= syntax is
 * deprecated, so this uses the Graph batch API: 50 GETs per POST.
 *
 * COPY COMES FROM THREE PLACES, and creative.body alone misses most of it.
 * Measured over ads that spent since 2026-06-01:
 *
 *   VIDEO    39 ads, $127,185 spend -- 39 of 39 have creative.body
 *   PHOTO     1 ad                  --  1 of 1
 *   SHARE   271 ads, $1,630,566     -- only 32 of 271. $1,159,168 of spend
 *                                      with no readable copy.
 *
 * A SHARE creative is an ad pointing at an EXISTING PAGE POST rather than
 * carrying its own creative, so creative.body is legitimately empty -- the
 * words live on the post. (This is not the Dynamic-Creative/asset_feed_spec
 * case an earlier comment here guessed at: 100% coverage on VIDEO and PHOTO is
 * not what dynamic-creative fragmentation looks like.)
 *
 * So we ask for object_story_spec too -- which carries the message inline for
 * ads built in place -- and effective_object_story_id, which is the handle for
 * the SHARE case. Posts are then fetched in one extra batch and matched back.
 * bodySource records which path produced the text, so a future reader can see
 * whether the post lookup is earning its request rather than guessing again. */
export async function fetchMetaAdCreatives(connection, adIds) {
  const token = connection.access_token;
  if (!token) throw new Error('No access token stored on connection');
  const ids = [...new Set((adIds || []).map(String))];
  const out = [];
  // ad ids still needing copy, keyed by the post that holds it
  const needPost = new Map();
  // The optional fields still being asked for. It only ever SHRINKS, and it
  // shrinks by exactly what Meta refuses, so an accepted field is never lost
  // to a neighbour's rejection. Recorded, with what was dropped, so the caller
  // can say "no links because field X was refused" rather than "no links
  // because the ads have none" -- two states that produce an identical table
  // of nulls.
  const activeFields = new Set(CREATIVE_OPTIONAL_FIELDS);
  const refusedFields = [];

  const postBatch = async (slice, active) => {
    const fields = metaCreativeFields(active);
    const batch = slice.map((id) => ({
      method: 'GET', relative_url: `${META_API_VERSION}/${id}?fields=${fields}`,
    }));
    return fetchMetaJsonOrThrow(`https://graph.facebook.com/${META_API_VERSION}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token, batch: JSON.stringify(batch) }).toString(),
    }, 'Meta ads batch');
  };

  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    let data;
    // Drop exactly what Meta refuses, then retry. The loop terminates because
    // every iteration removes one field from a finite set and stops when there
    // is nothing left to remove.
    for (;;) {
      try {
        data = await postBatch(slice, activeFields);
      } catch (err) {
        // The outer POST throwing on a field name is the less likely of the
        // two failure modes (batch normally reports per item) but it is the
        // one that would take the whole creative sync down, copy included.
        if (!activeFields.size || !isMetaUnknownFieldError(err)) throw err;
        const dropped = dropRefusedField(activeFields, metaFieldNameFromMessage(err.message));
        if (!dropped) throw err;
        refusedFields.push(dropped);
        console.warn(`[warn] Meta refused creative field ${dropped}, retrying without it:`, err.message);
        continue;
      }
      // The mode that matters: 200 outside, every item failed inside. The
      // parse loop below skips a non-200 item silently, so without this the
      // run writes a full set of creative rows with no copy and no links and
      // warns about nothing.
      if (activeFields.size && metaBatchRejectedFields(data)) {
        const named = metaRejectedFieldName(data);
        const dropped = dropRefusedField(activeFields, named);
        // Nothing recognisable left to drop: keep what came back rather than
        // spinning. Those items stay unparsed, exactly as before this feature.
        if (!dropped) break;
        refusedFields.push(dropped);
        console.warn(`[warn] Meta refused creative field ${dropped} per item`
          + `${named && normalizeRefusedField(named) !== dropped ? ` (named: ${named}, unrecognised)` : ''}`
          + ', retrying without it');
        continue;
      }
      break;
    }
    if (!Array.isArray(data)) throw new Error(`Meta ads batch: unexpected response shape`);
    for (const item of data) {
      if (!item || item.code !== 200 || !item.body) continue;
      let a;
      try { a = JSON.parse(item.body); } catch { continue; }
      if (!a?.id) continue;
      // Inline copy, wherever Meta put it for this ad format. link_data covers
      // link/carousel ads, video_data a video ad, photo_data a photo ad.
      const spec = a.creative?.object_story_spec || {};
      const inline = spec.link_data?.message
        ?? spec.video_data?.message
        ?? spec.photo_data?.caption
        ?? null;
      const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

      const link = resolveCreativeLink(a.creative);

      const row = {
        adId: a.id,
        adName: a.name ?? null,
        campaignId: a.campaign_id ?? null,
        adsetId: a.adset_id ?? null,
        effectiveStatus: a.effective_status ?? null,
        creativeId: a.creative?.id ?? null,
        thumbnailUrl: a.creative?.thumbnail_url ?? null,
        body: clean(a.creative?.body) ?? clean(inline),
        title: a.creative?.title ?? null,
        objectType: a.creative?.object_type ?? null,
        bodySource: clean(a.creative?.body) ? 'creative_body'
                  : clean(inline) ? 'object_story_spec' : null,
        // Null or non-null TOGETHER, always. A source with no url describes
        // nothing, and a url with no source cannot be judged -- the whole
        // point of recording the source is that a resolved destination may be
        // the page post rather than the site. resolveCreativeLink returns
        // them as one object so they cannot drift apart here; the database
        // asserts the same invariant.
        linkUrl: link.url,
        linkUrlSource: link.source,
        // The UTM string as Meta stores it, unparsed. Whoever needs the
        // campaign tag can split it; guessing at a canonical parse here
        // would bake one reading of a free-text field into the table.
        linkUrlTags: clean(a.creative?.url_tags),
      };
      out.push(row);

      // Still nothing, but the ad names a post that has it.
      const storyId = a.creative?.effective_object_story_id;
      if (!row.body && storyId) {
        if (!needPost.has(storyId)) needPost.set(storyId, []);
        needPost.get(storyId).push(row);
      }
    }
  }

  // One extra batched pass for the SHARE case. Skipped entirely when nothing
  // needs it, so an account whose ads all carry inline copy pays nothing.
  const storyIds = [...needPost.keys()];
  // A PAGE token, not the ad-account token. A page post is a Page node, and
  // reading one authenticates as the Page -- the same reason Facebook Page
  // insights derive a token here rather than reusing connection.access_token.
  // The first cut of this pass used the ad token, every per-item read came
  // back non-200, and because those were skipped silently it looked like the
  // posts simply had no message: 113 SHARE ads, all still blank, no warning.
  const postToken = storyIds.length
    ? ((await fetchFacebookPageAccessToken(connection)) || token)
    : token;
  let postItemErr = 0;
  for (let i = 0; i < storyIds.length; i += 50) {
    const slice = storyIds.slice(i, i + 50);
    const batch = slice.map((id) => ({
      // message ONLY. Asking for `description` alongside it failed the whole
      // request -- Meta returns "(#12) deprecate_post_aggregated_fields_for_
      // attachement is deprecated for versions v3.3 and higher" and drops
      // `message` with it, so 100 of 113 post reads came back 400. It was
      // added as a harmless-looking fallback and was the thing that broke the
      // call.
      method: 'GET', relative_url: `${META_API_VERSION}/${id}?fields=message`,
    }));
    let data;
    try {
      data = await fetchMetaJsonOrThrow(`https://graph.facebook.com/${META_API_VERSION}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: postToken, batch: JSON.stringify(batch) }).toString(),
      }, 'Meta post copy batch');
    } catch (err) {
      // Copy is an enrichment, not the point of this sync. A page-post read
      // that fails on scope or a deleted post must not lose the creative rows
      // already collected -- those ads simply keep a null body, exactly as
      // before this pass existed.
      console.warn(`[warn] meta post copy batch: ${err.message || err}`);
      break;
    }
    if (!Array.isArray(data)) break;
    if (i + 50 >= storyIds.length && postItemErr) {
      console.warn(`[warn] meta post copy: ${postItemErr} of ${storyIds.length} post reads failed`);
    }
    slice.forEach((storyId, n) => {
      const item = data[n];
      // Surface the FIRST per-item failure. Skipping these silently is what
      // made a wrong token look like posts with no text -- a batch call can
      // return 200 while every request inside it failed.
      if (!item || item.code !== 200) {
        if (postItemErr++ === 0) {
          let why = item?.body || '(no body)';
          try { why = JSON.parse(item.body)?.error?.message || why; } catch { /* keep raw */ }
          console.warn(`[warn] meta post copy: ${item?.code ?? '?'} on ${storyId} — ${String(why).slice(0, 200)}`);
        }
        return;
      }
      if (!item.body) return;
      let post;
      try { post = JSON.parse(item.body); } catch { return; }
      const msg = typeof post?.message === 'string' && post.message.trim()
        ? post.message.trim()
        : null;
      if (!msg) return;
      for (const r of needPost.get(storyId) || []) {
        r.body = msg;
        r.bodySource = 'page_post';
      }
    });
  }

  // The coverage line, and it earned its place on day one: the first
  // production run printed "0/126 resolved (none)" with REFUSED beside it,
  // which is how the all-or-nothing tier was caught at all. It now also
  // prints the tier the run settled on and the field Meta named, so the
  // NEXT refusal is diagnosable from the log instead of re-guessed.
  //
  // A drop to zero after a Meta API version bump reads here as a changed
  // field list rather than as an account that stopped linking anywhere, and
  // the tier separates "refused" from "absent".
  const withLink = out.filter((r) => r.linkUrl).length;
  const bySource = out.reduce((acc, r) => {
    if (r.linkUrlSource) acc[r.linkUrlSource] = (acc[r.linkUrlSource] || 0) + 1;
    return acc;
  }, {});
  const sourceSummary = Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(' ') || 'none';
  console.log(`[meta] creative links: ${withLink}/${out.length} resolved (${sourceSummary})`
    + ` [asked: ${[...activeFields].join(',') || 'none'}`
    + `${refusedFields.length ? `, refused: ${refusedFields.join(',')}` : ''}]`);

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
      // Null-preserving, unlike the three above: those default to 0 because
      // every ad can report them, whereas a video buy that reports no leads
      // and a lead buy that reports no thruplays are both "not measured here",
      // and 0 would rank them as the worst performer on a metric they were
      // never bought on.
      thruplays: r.thruplays == null ? null
        : Math.round(Number(String(r.thruplays).replace(/[,$\s]/g, '')) || 0),
      leads: r.leads == null ? null
        : Math.round(Number(String(r.leads).replace(/[,$\s]/g, '')) || 0),
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
    body_source: c.bodySource ?? null,
    link_url: c.linkUrl ?? null,
    link_url_source: c.linkUrlSource ?? null,
    link_url_tags: c.linkUrlTags ?? null,
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
    const chunkUntil = isoDateOnly(end);
    let url = pageInsightsUrl(pageId, token, metrics,
      { startDate: isoDateOnly(start), endDate: chunkUntil });
    while (url) {
      const data = await fetchJsonOrThrow(url, {}, `Facebook Page insights (${metrics.join(',')})`);
      const page = data.data ?? [];
      series.push(...page);
      // paging.next on Page Insights walks the time window FORWARD rather than
      // ending at the `until` that was asked for, so following it blindly keeps
      // marching past the window into buckets that have not happened yet. On
      // 2026-08-28 that wrote 90 future-dated rows (08-29..11-26) full of
      // ZEROES -- which is worse than missing data, because a zero reads as a
      // measured value and would have dragged every average down. Stop as soon
      // as a page reaches past the end of this chunk.
      const overshot = page.some((sv) => (sv.values ?? []).some(
        (pt) => String(pt.end_time || '').slice(0, 10) > chunkUntil));
      url = overshot ? null : (data.paging?.next ?? null);
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
      // Belt to the paging guard's braces: keep only days the caller actually
      // asked for. The upper bound is EXCLUSIVE of endDate because endDate is
      // today and today is still in progress -- a bucket stamped endDate would
      // shift to endDate-1, so [startDate, endDate) is exactly the set of
      // COMPLETE days in the window. Guarding here as well as at the paging
      // loop means a stray datapoint can never become a row again, whatever
      // Meta returns.
      if (day < window.startDate || day >= window.endDate) continue;
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

// ── Meta creative destination backfill ──────────────────────────────────────
// The nightly (runMetaAdLevelSync) fetches creatives only for ad ids that have
// INSIGHTS ROWS IN ITS WINDOW -- `connection.days_back ?? 30`. That is the
// right scope for a nightly and it is why destination coverage looked thin:
// measured 2026-09-16, 126 of 4,079 stored creatives had been asked about at
// all, 82 resolved, and $5.3M of SHARE spend sat on ads nobody had ever asked
// Meta about. Those ads were not REFUSED, they were never requested.
//
// A destination is a property of the CREATIVE, not of a date, so an old ad can
// be asked about at any time -- as long as it still exists. Some never will:
// POST_DELETED and PRIVACY_CHECK_FAIL creatives are gone at Meta's end, and
// the batch API reports those per item, which fetchMetaAdCreatives already
// skips without narrowing the field set for everyone else.
//
// THREE WRITE RULES, and each exists because the obvious version loses data:
//
//   1. A resolved link is only ever written, never a null over a non-null one.
//      Re-asking about an ad whose asset_feed_spec was refused mid-run would
//      otherwise DESTROY a destination the nightly had already resolved. A
//      null here keeps its established meaning -- "not resolved" -- and never
//      becomes "asked and has none".
//   2. `body` is written only when it came back non-null. The page-post pass
//      degrades gracefully (a missing scope, a deleted post) and a blanket
//      full-row upsert would blank the copy that pass had already recovered.
//   3. An ad with no row yet gets the FULL row, because there is nothing to
//      clobber and a partial insert would leave ad_name/object_type null
//      forever -- the nightly would never revisit it either.
//
// Chunks are written before the next is fetched, so a failure keeps what
// landed and the caller can say which ads were covered. Re-running is an
// idempotent upsert on the nightly's own identity (company_entity_id,ad_id).

/** Every ad id the account has, newest first, via a paginated ID-ONLY listing.
 *
 * The account-wide /ads listing is noted above (fetchMetaAdCreatives) as
 * tripping Meta's request-size limits -- that was with full creative fields
 * selected. `fields=id` alone is a different request: it is what pagination is
 * for, and it is the only way to reach ads that never landed in our tables.
 *
 * Returns null (rather than throwing) when the listing fails, so discovery is
 * strictly additive: the caller falls back to the ids it already has instead
 * of losing a backfill to an optional widening step. */
export async function fetchMetaAccountAdIds(connection, { pageSize = 500, maxPages = 200 } = {}) {
  const token = connection.access_token;
  const accountId = connection.meta_ad_account_id;
  if (!token || !accountId) return null;
  const act = String(accountId).startsWith('act_') ? String(accountId) : `act_${accountId}`;
  const ids = [];
  let url = `https://graph.facebook.com/${META_API_VERSION}/${act}/ads`
    + `?fields=id&limit=${pageSize}&access_token=${encodeURIComponent(token)}`;
  try {
    for (let page = 0; url && page < maxPages; page++) {
      const data = await fetchMetaJsonOrThrow(url, {}, 'Meta account ads listing');
      for (const r of data?.data ?? []) if (r?.id) ids.push(String(r.id));
      // paging.next carries its own access_token; absent means the last page.
      url = data?.paging?.next || null;
    }
  } catch (err) {
    console.warn(`[warn] Meta account ad listing failed, backfilling stored ids only: ${err.message || err}`);
    return null;
  }
  return [...new Set(ids)];
}

/** Backfill creative destinations for a set of ad ids, chunk by chunk.
 *
 * `knownIds` is the set of ad ids that already have a meta_ad_creatives row;
 * it decides full-row insert vs. partial update per rule 3 above. `onChunk`
 * reports after each chunk is WRITTEN, never before, so a log line means the
 * rows are durable. */
export async function runMetaCreativeBackfill(supabase, connection, {
  adIds,
  knownIds = new Set(),
  chunkSize = 300,
  onChunk = null,
  pauseMs = 0,
} = {}) {
  // No batchId here on purpose: meta_ad_creatives has no sync_batch_id column
  // (that one is on meta_ad_performance_daily), so accepting one would imply a
  // per-row traceability that does not exist. The driver records the batch on
  // the sync_jobs row instead, which is where a run is actually traceable.
  const ids = [...new Set((adIds || []).map(String))];
  const chunksPlanned = Math.ceil(ids.length / chunkSize);
  const result = {
    ads_requested: ids.length,
    chunks_planned: chunksPlanned,
    chunks_completed: 0,
    ads_returned: 0,
    links_resolved: 0,
    link_rows_written: 0,
    body_rows_written: 0,
    new_creative_rows: 0,
    failed: null,
  };

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const chunkNo = Math.floor(i / chunkSize) + 1;
    try {
      const creatives = await fetchMetaAdCreatives(connection, chunk);
      const syncedAt = new Date().toISOString();

      // Rule 3: never seen before -> full row, nothing to clobber.
      const newRows = creatives
        .filter((c) => !knownIds.has(String(c.adId)))
        .map((c) => ({
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
          body_source: c.bodySource ?? null,
          link_url: c.linkUrl ?? null,
          link_url_source: c.linkUrlSource ?? null,
          link_url_tags: c.linkUrlTags ?? null,
          title: c.title,
          object_type: c.objectType,
          synced_at: syncedAt,
        }));

      // Rule 1: only RESOLVED links are written back onto an existing row.
      const linkRows = creatives
        .filter((c) => knownIds.has(String(c.adId)) && c.linkUrl)
        .map((c) => ({
          company_entity_id: connection.company_entity_id,
          ad_id: String(c.adId),
          link_url: c.linkUrl,
          link_url_source: c.linkUrlSource,
          link_url_tags: c.linkUrlTags ?? null,
          synced_at: syncedAt,
        }));

      // Rule 2: only recovered copy is written back.
      const bodyRows = creatives
        .filter((c) => knownIds.has(String(c.adId)) && c.body)
        .map((c) => ({
          company_entity_id: connection.company_entity_id,
          ad_id: String(c.adId),
          body: c.body,
          body_source: c.bodySource ?? null,
        }));

      if (newRows.length) {
        result.new_creative_rows += await upsertInChunks(
          supabase, 'meta_ad_creatives', newRows, 'company_entity_id,ad_id');
      }
      if (linkRows.length) {
        result.link_rows_written += await upsertInChunks(
          supabase, 'meta_ad_creatives', linkRows, 'company_entity_id,ad_id');
      }
      if (bodyRows.length) {
        result.body_rows_written += await upsertInChunks(
          supabase, 'meta_ad_creatives', bodyRows, 'company_entity_id,ad_id');
      }

      // Counted from what Meta returned, not from what was written: a new row
      // carrying a link is a resolved link too, and it lands in newRows.
      const resolvedHere = creatives.filter((c) => c.linkUrl).length;
      result.ads_returned += creatives.length;
      result.links_resolved += resolvedHere;
      result.chunks_completed += 1;
      if (onChunk) {
        onChunk({
          chunk: chunkNo,
          of: chunksPlanned,
          requested: chunk.length,
          returned: creatives.length,
          resolved: resolvedHere,
          new_rows: newRows.length,
          link_rows: linkRows.length,
          body_rows: bodyRows.length,
        });
      }
      if (pauseMs) await sleep(pauseMs);
    } catch (err) {
      // Everything already written stays written; the caller reports how far
      // it got and exits non-zero. Resuming is just re-running -- the default
      // candidate set excludes ads that now have a link.
      result.failed = { chunk: chunkNo, error: String(err?.message || err).slice(0, 500) };
      break;
    }
  }
  return result;
}
