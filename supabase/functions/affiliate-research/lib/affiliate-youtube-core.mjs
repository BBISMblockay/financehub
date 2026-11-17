// scripts/lib/affiliate-youtube-core.mjs -- real channel numbers for YouTube
// prospects, from the official YouTube Data API v3, and one structured
// creator profile per prospect. Shipped VERBATIM in
// supabase/functions/affiliate-research/lib/ (pinned by
// scripts/tests/affiliate-research-edge.test.mjs).
//
// Why the official API: it is the platform's own public data, under its own
// terms, with SILO's one key (YOUTUBE_API_KEY, a Supabase secret). Clients
// sign up for nothing and nothing is scraped. Quota, not money: about 3 units
// a creator against the free 10,000 a day.
//
// What one creator costs: channels.list (1 unit) for subscribers, views,
// country, topics and the public description; playlistItems.list on the
// uploads playlist (1) and videos.list for those uploads (1) for engagement
// and sponsor mentions.
//
// Rules this file keeps:
//   * NULL means not measured: a hidden subscriber count, a video with likes
//     turned off, a channel the API does not know -- each stays null, never 0;
//   * ratios are pooled from their parts (sum of likes + comments over sum of
//     views), never an average of per-video rates;
//   * an email is kept only if the channel's own public description states it,
//     with the channel as its source;
//   * every field in the profile says where it came from.
//
// Nothing here throws for one creator's failure: no key, a quota error or an
// unknown channel all mean "no YouTube numbers", and the prospect is unchanged.

import { classifyProfileUrl, statedEmail } from './affiliate-discovery-core.mjs';

export const YT_API = 'https://www.googleapis.com/youtube/v3';
export const YT_SOURCE = 'youtube_api';
export const RECENT_UPLOADS = 12;
export const YT_TIMEOUT_MS = 8000;
export const YT_CONCURRENCY = 4;
// A channel checked this recently is not checked again by a refresh.
export const YT_STALE_DAYS = 7;
export const PROFILE_VERSION = 1;

// Links in descriptions that are platforms or link tools, not brands.
const NOT_A_BRAND = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|facebook\.com|fb\.me|twitch\.tv|pinterest\.com|snapchat\.com|threads\.net|linkedin\.com|discord\.gg|discord\.com|patreon\.com|linktr\.ee|beacons\.ai|bit\.ly|tinyurl\.com|goo\.gl|spotify\.com|apple\.com|google\.com|amzn\.to|amazon\.com|geni\.us|ko-fi\.com|buymeacoffee\.com|stan\.store|shor\.by|lnk\.bio|t\.co|ow\.ly)$/;
const SPONSOR_RE = /\b(sponsored by|thanks to .{1,40} for sponsoring|this video is sponsored|paid (promotion|partnership)|partnered with|in partnership with|use (my )?code|promo code|discount code|#ad\b|#sponsored\b)/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** What to ask the API for this profile URL: { forHandle } | { id } | { forUsername } | null. Pure. */
export function channelRef(profileUrl) {
  const p = classifyProfileUrl(profileUrl);
  if (!p || p.platform !== 'youtube') return null;
  let u; try { u = new URL(p.profile_url); } catch { return null; }
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0]?.startsWith('@')) return { forHandle: seg[0] };
  if (seg[0] === 'channel' && /^UC[\w-]{22}$/.test(seg[1] || '')) return { id: seg[1] };
  if (seg[0] === 'user' && seg[1]) return { forUsername: seg[1] };
  // /c/<custom> names cannot be looked up by the API without a paid search.
  return null;
}

const intOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

async function ytGet({ path, params, apiKey, fetchImpl }) {
  const u = new URL(`${YT_API}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('key', apiKey);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), YT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(u.toString(), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason || `http_${res.status}`;
      const err = new Error(`youtube ${reason}`); err.reason = reason; throw err;
    }
    return body;
  } finally { clearTimeout(timer); }
}

/** Topic names from topicDetails.topicCategories (Wikipedia URLs). Pure. */
export function topicNames(categories) {
  return [...new Set((categories || []).map((c) => {
    try { return decodeURIComponent(new URL(c).pathname.split('/').pop() || '').replace(/_/g, ' ').trim(); } catch { return ''; }
  }).filter(Boolean))].slice(0, 8);
}

/**
 * Engagement and brand mentions from a channel's recent uploads. Pure.
 * videos: videos.list items (snippet + statistics).
 */
export function summarizeUploads(videos) {
  const vs = (videos || []).filter((v) => v && v.statistics);
  let views = 0, likes = 0, comments = 0, viewN = 0, rateViews = 0;
  let sponsored = 0;
  const domains = new Map();
  for (const v of vs) {
    const vw = intOrNull(v.statistics.viewCount);
    const lk = intOrNull(v.statistics.likeCount);
    const cm = intOrNull(v.statistics.commentCount);
    if (vw !== null) { views += vw; viewN += 1; }
    // A video counts toward the rate only when all three are public, so a
    // hidden like count never reads as zero likes.
    if (vw !== null && lk !== null && cm !== null) { rateViews += vw; likes += lk; comments += cm; }
    const desc = String(v.snippet?.description || '');
    if (SPONSOR_RE.test(desc)) sponsored += 1;
    const seen = new Set();
    for (const raw of desc.match(URL_RE) || []) {
      let host; try { host = new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
      if (!host.includes('.') || NOT_A_BRAND.test(host) || seen.has(host)) continue;
      seen.add(host); domains.set(host, (domains.get(host) || 0) + 1);
    }
  }
  const brandDomains = [...domains.entries()].filter(([, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)
    .map(([domain, videosN]) => ({ domain, videos: videosN }));
  return {
    sample: vs.length,
    avg_views: viewN ? Math.round(views / viewN) : null,
    avg_likes: rateViews ? Math.round(likes / vs.filter((v) => intOrNull(v.statistics.likeCount) !== null && intOrNull(v.statistics.commentCount) !== null && intOrNull(v.statistics.viewCount) !== null).length) : null,
    avg_comments: rateViews ? Math.round(comments / vs.filter((v) => intOrNull(v.statistics.likeCount) !== null && intOrNull(v.statistics.commentCount) !== null && intOrNull(v.statistics.viewCount) !== null).length) : null,
    engagement_rate: rateViews > 0 ? Math.round(((likes + comments) / rateViews) * 10000) / 10000 : null,
    sponsored_videos: vs.length ? sponsored : null,
    brand_domains: brandDomains,
    last_upload_at: vs.map((v) => v.snippet?.publishedAt).filter(Boolean).sort().pop() || null,
  };
}

/** Other profiles the channel's own description links to. Pure. */
export function linkedProfiles(description, channelUrl) {
  const out = []; const seen = new Set();
  for (const raw of String(description || '').match(URL_RE) || []) {
    const p = classifyProfileUrl(raw.replace(/[.,;:!?]+$/, ''));
    if (!p || p.platform === 'youtube') continue;
    const k = p.profile_url.toLowerCase(); if (seen.has(k)) continue;
    seen.add(k); out.push({ platform: p.platform, handle: p.handle, profile_url: p.profile_url, source_url: channelUrl });
  }
  return out.slice(0, 8);
}

/**
 * One channel, looked up. -> the `youtube` evidence block, or null when the
 * API does not know the channel. Throws only on an API/network error.
 */
export async function fetchChannelStats({ profileUrl, apiKey, fetchImpl = fetch, now = () => new Date() }) {
  const ref = channelRef(profileUrl);
  if (!ref) return null;
  const ch = await ytGet({ path: 'channels', params: { part: 'snippet,statistics,contentDetails,topicDetails', ...ref, maxResults: 1 }, apiKey, fetchImpl });
  const c = ch?.items?.[0];
  if (!c) return null;
  const uploads = c.contentDetails?.relatedPlaylists?.uploads || null;
  let videos = [];
  if (uploads) {
    const pl = await ytGet({ path: 'playlistItems', params: { part: 'contentDetails', playlistId: uploads, maxResults: RECENT_UPLOADS }, apiKey, fetchImpl });
    const ids = (pl?.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const vr = await ytGet({ path: 'videos', params: { part: 'snippet,statistics', id: ids.join(',') }, apiKey, fetchImpl });
      videos = vr?.items || [];
    }
  }
  const channelUrl = `https://www.youtube.com/channel/${c.id}`;
  const description = String(c.snippet?.description || '');
  const email = statedEmail(description);
  return {
    source: YT_SOURCE,
    channel_id: c.id,
    channel_url: channelUrl,
    title: String(c.snippet?.title || '').slice(0, 200) || null,
    custom_url: c.snippet?.customUrl || null,
    country: c.snippet?.country || null,
    subscribers: c.statistics?.hiddenSubscriberCount ? null : intOrNull(c.statistics?.subscriberCount),
    total_views: intOrNull(c.statistics?.viewCount),
    video_count: intOrNull(c.statistics?.videoCount),
    topics: topicNames(c.topicDetails?.topicCategories),
    thumbnail_url: c.snippet?.thumbnails?.high?.url || c.snippet?.thumbnails?.medium?.url || c.snippet?.thumbnails?.default?.url || null,
    description_email: email,
    linked_profiles: linkedProfiles(description, channelUrl),
    recent: summarizeUploads(videos),
    as_of: now().toISOString().slice(0, 10),
  };
}

const field = (value, source, source_url = null, as_of = null) => (value === null || value === undefined ? null : { value, source, source_url, as_of });

/**
 * One structured creator profile from whatever a prospect's evidence holds,
 * every field with its source. Pure; called whenever evidence changes.
 */
export function buildCreatorProfile(prospect) {
  const e = prospect?.evidence || {};
  const yt = e.youtube || null;
  const ytFollowers = yt && yt.subscribers !== null && yt.subscribers !== undefined;
  const followers = ytFollowers
    ? field(yt.subscribers, YT_SOURCE, prospect.profile_url || yt.channel_url, yt.as_of)
    : (Number.isFinite(Number(e.followers)) && e.followers !== null && e.followers !== ''
      ? field(Number(e.followers), e.provider === 'import' ? 'your_list' : (e.followers_source_kind === 'profile' ? 'their_profile' : 'web_page'), e.followers_source_url || null, e.followers_as_of || null)
      : null);
  const r = yt?.recent || null;
  const engagement = r && (r.avg_views !== null || r.engagement_rate !== null)
    ? { avg_views: r.avg_views, avg_likes: r.avg_likes, avg_comments: r.avg_comments, rate: r.engagement_rate, sample: r.sample, source: YT_SOURCE, source_url: yt.channel_url, as_of: yt.as_of }
    : null;
  const contact = prospect?.contact_email
    ? { value: prospect.contact_email, source: prospect.contact_source_url ? 'stated_on_page' : 'entered', source_url: prospect.contact_source_url || null }
    : (yt?.description_email ? { value: yt.description_email, source: YT_SOURCE, source_url: yt.channel_url } : null);
  return {
    version: PROFILE_VERSION,
    platform: prospect?.platform || null,
    handle: prospect?.handle || null,
    name: prospect?.display_name || yt?.title || null,
    profile_url: prospect?.profile_url || null,
    followers,
    engagement,
    topics: yt?.topics?.length ? { value: yt.topics, source: YT_SOURCE, source_url: yt.channel_url } : null,
    country: yt?.country ? field(yt.country, YT_SOURCE, yt.channel_url, yt.as_of) : null,
    brand_mentions: r && r.sample ? { domains: r.brand_domains || [], sponsored_videos: r.sponsored_videos, sample: r.sample, source: YT_SOURCE, source_url: yt.channel_url, as_of: yt.as_of } : null,
    contact,
    other_profiles: yt?.linked_profiles?.length ? yt.linked_profiles : [],
    last_post_at: r?.last_upload_at || null,
  };
}

/**
 * Look up YouTube prospects of ONE company (the caller already proved it) and
 * write `evidence.youtube` + `evidence.creator_profile`. Each prospect:
 * { id, platform, handle, display_name, profile_url, contact_email,
 *   contact_source_url, evidence }. Only ADDS: a value the API did not return
 * never blanks one already stored. A public email in the channel description
 * fills contact_email only when none is on file. Never throws.
 * -> { checked, updated, failed, skipped, quota }.
 */
export async function enrichYouTubeProspects({ service, company, prospects, apiKey, fetchImpl = fetch, now = () => new Date(), deadline = Infinity, concurrency = YT_CONCURRENCY }) {
  const out = { checked: 0, updated: 0, failed: 0, skipped: 0, quota: false };
  if (!apiKey) { out.skipped = (prospects || []).length; return out; }
  const queue = (prospects || []).filter((p) => p?.id && channelRef(p.profile_url));
  out.skipped = (prospects || []).length - queue.length;
  const worker = async () => {
    while (queue.length && Date.now() < deadline && !out.quota) {
      const p = queue.shift();
      out.checked += 1;
      try {
        const yt = await fetchChannelStats({ profileUrl: p.profile_url, apiKey, fetchImpl, now });
        if (!yt) continue;
        const prior = p.evidence?.youtube || {};
        const merged = { ...prior, ...Object.fromEntries(Object.entries(yt).filter(([, v]) => v !== null && v !== undefined)) };
        const evidence = { ...(p.evidence || {}), youtube: merged };
        const patch = {};
        if (!p.contact_email && merged.description_email) {
          patch.contact_email = merged.description_email;
          patch.contact_source_url = merged.channel_url;
        }
        evidence.creator_profile = buildCreatorProfile({ ...p, ...patch, evidence });
        const { error } = await service.from('affiliate_prospects').update({ evidence, ...patch, updated_at: now().toISOString() })
          .eq('id', p.id).eq('company_entity_id', company);
        if (error) out.failed += 1; else out.updated += 1;
      } catch (err) {
        out.failed += 1;
        if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(String(err?.reason || err?.message))) out.quota = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

/** True when a prospect's YouTube numbers are missing or older than YT_STALE_DAYS. Pure. */
export function needsYouTubeRefresh(prospect, now = new Date()) {
  if (!channelRef(prospect?.profile_url)) return false;
  const at = prospect?.evidence?.youtube?.as_of;
  if (!at) return true;
  return now.getTime() - new Date(`${at}T00:00:00Z`).getTime() >= YT_STALE_DAYS * 86400000;
}
