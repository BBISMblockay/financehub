// scripts/lib/affiliate-photo-core.mjs -- creator profile photos for
// Affiliate Studio. Shipped VERBATIM in supabase/functions/affiliate-research/lib/
// (pinned by scripts/tests/affiliate-research-edge.test.mjs).
//
// SILO opens the creator's OWN profile page (the prospect's profile_url),
// reads the profile image the page declares for itself (og:image, else
// twitter:image), downloads it and keeps a copy in SILO's public
// affiliate-feed-images bucket at <company>/creator-photos/<prospect>.<ext>.
// A copy, because platform photo links (Instagram, TikTok) expire within days.
//
// Safety, because profile_url can be any website (blogs):
//   * https only, default port, no IP-literal or local host names, and every
//     redirect hop is checked the same way (redirects are followed by hand);
//   * every body is read with a byte cap and a timeout;
//   * only a real JPEG / PNG / WebP / GIF is stored (type AND magic bytes);
//   * a page that declares no image, or refuses us, just means no photo --
//     never an error for the run that asked.

export const PHOTO_BUCKET = 'affiliate-feed-images';
export const PAGE_MAX_BYTES = 1_500_000;
export const IMAGE_MAX_BYTES = 2_000_000;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_REDIRECTS = 3;
export const PHOTO_CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (compatible; SILO-AffiliateStudio/1.0)';

/** A URL SILO may fetch: https, default port, a real public-looking host name. Returns the URL or null. */
export function safeHttpsUrl(raw, base) {
  let u;
  try { u = base ? new URL(String(raw), base) : new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h.startsWith('[') || /^[\d.]+$/.test(h) || /:/.test(h)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(h)) return null;
  return u.href;
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The profile image a page declares for itself (og:image, else twitter:image), as an absolute https URL, or null. Pure. */
export function profileImageFromHtml(html, pageUrl) {
  const head = String(html || '').slice(0, PAGE_MAX_BYTES);
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
      const name = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!name || name.toLowerCase() !== key) continue;
      const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      const url = content && safeHttpsUrl(decodeEntities(content.trim()), pageUrl);
      if (url) return url;
    }
  }
  return null;
}

/** The image format from its first bytes, or null. Pure. */
export function imageKind(bytes) {
  const b = bytes || new Uint8Array();
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: 'image/gif', ext: 'gif' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: 'image/webp', ext: 'webp' };
  return null;
}

async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length') || 0);
  if (len > max) return null;
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = res.body.getReader(); const parts = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** GET with every redirect hop checked by safeHttpsUrl; the body capped. -> { url, bytes, type } or null. */
export async function safeGet(raw, { fetchImpl, max, accept, timeoutMs = FETCH_TIMEOUT_MS }) {
  let url = safeHttpsUrl(raw);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: accept } });
      if (res.status >= 300 && res.status < 400) { url = safeHttpsUrl(res.headers?.get?.('location') || '', url); continue; }
      if (!res.ok) return null;
      const bytes = await readCapped(res, max);
      return bytes ? { url, bytes, type: String(res.headers?.get?.('content-type') || '').toLowerCase() } : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

/**
 * One creator's photo: the image their own profile page declares, else
 * `fallbackImageUrl` (a photo URL AI research proved was on that page).
 * -> { bytes, type, ext, imageUrl } or null.
 */
export async function grabProfilePhoto({ profileUrl, fallbackImageUrl = null, fetchImpl }) {
  let imageUrl = null;
  const page = await safeGet(profileUrl, { fetchImpl, max: PAGE_MAX_BYTES, accept: 'text/html,application/xhtml+xml' });
  if (page && /html|xml|^$/.test(page.type)) imageUrl = profileImageFromHtml(new TextDecoder().decode(page.bytes), page.url);
  for (const candidate of [imageUrl, safeHttpsUrl(fallbackImageUrl || '')]) {
    if (!candidate) continue;
    const img = await safeGet(candidate, { fetchImpl, max: IMAGE_MAX_BYTES, accept: 'image/*' });
    const kind = img && /^image\//.test(img.type) ? imageKind(img.bytes) : null;
    if (kind) return { bytes: img.bytes, type: kind.type, ext: kind.ext, imageUrl: candidate };
  }
  return null;
}

/**
 * Grab and keep photos for prospects of ONE company (the caller already
 * proved the company). Each prospect: { id, profile_url, evidence }.
 * Writes the copy, then the prospect's evidence (profile_image_url = the
 * copy's public address). Never throws for one creator's failure.
 * -> { checked, stored }.
 */
export async function storeProspectPhotos({ service, company, prospects, fetchImpl, now = () => new Date(), deadline = Infinity, concurrency = PHOTO_CONCURRENCY }) {
  const out = { checked: 0, stored: 0 };
  const queue = (prospects || []).filter((p) => p?.id && safeHttpsUrl(p.profile_url));
  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const p = queue.shift();
      out.checked += 1;
      try {
        const photo = await grabProfilePhoto({ profileUrl: p.profile_url, fallbackImageUrl: p.evidence?.profile_image_stored ? null : p.evidence?.profile_image_url, fetchImpl });
        if (!photo) continue;
        const path = `${company}/creator-photos/${p.id}.${photo.ext}`;
        const bucket = service.storage.from(PHOTO_BUCKET);
        const { error: upErr } = await bucket.upload(path, photo.bytes, { contentType: photo.type, upsert: true });
        if (upErr) continue;
        const at = now();
        const publicUrl = `${bucket.getPublicUrl(path).data.publicUrl}?v=${at.getTime()}`;
        const evidence = { ...(p.evidence || {}), profile_image_url: publicUrl, profile_image_source_url: p.profile_url, profile_image_as_of: at.toISOString().slice(0, 10), profile_image_stored: true };
        const { error } = await service.from('affiliate_prospects').update({ evidence }).eq('id', p.id).eq('company_entity_id', company);
        if (!error) out.stored += 1;
      } catch { /* one creator's photo never stops the rest */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}
