// scripts/lib/creative-image-archive.mjs -- keep a copy of each Meta ad's image.
//
// WHY. meta_ad_creatives.thumbnail_url is Meta's DEFAULT 64x64 thumbnail on a
// signed fbcdn URL that expires (`oe=`) about four days after it is fetched.
// Measured 2026-09-27: 686 of the 811 ads with $100+ spend already carried an
// expired URL, so Ad Studio's gallery of past winners would be mostly broken
// images. meta-creative-probe.yml (images mode, same day) measured that the
// creative node answers `thumbnail_width=1080&thumbnail_height=1080` with a
// 1080x1080 photo / 540-1080 video frame, for ads that ended a year ago too --
// and that every such URL still expires. So the image is downloaded ONCE and
// stored in the private `ad-creative-images` bucket (20260927190000).
//
// WHAT IS SAFE BY CONSTRUCTION, not by the caller being careful:
//   1. Nothing here can make an ad LOSE an image. A failed attempt writes only
//      image_attempted_at / image_error; the image columns are written only
//      after the object is stored, and only together.
//   2. The row update is conditioned on the creative_id the image was fetched
//      FOR. An ad edited mid-run keeps its new creative unarchived rather than
//      being labelled with the old creative's picture.
//   3. Content-addressed paths (<company>/<sha256>.<ext>): two ads sharing an
//      image share one object, a retry re-uploads identical bytes to the same
//      path, and a catalog template shows up as one hash on many ads.
//   4. The type comes from the file's own magic bytes, never the header, and
//      only https URLs on Meta's CDN hosts are fetched -- the URL is Meta's,
//      but it is still a URL this job was handed.
//   5. The access token never reaches a stored error or a log line.
//   6. A backoff: an ad that failed within the last `retryAfterHours` is not
//      asked again, so a permanently broken creative does not cost a Graph
//      call every night.
//
// Never throws for a per-ad failure; returns counts. The caller decides
// whether the run as a whole failed.

import { createHash } from 'node:crypto';

export const ARCHIVE_BUCKET = 'ad-creative-images';
export const ARCHIVE_SIZE = 1080;
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_HOST = /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com)$/i;

/** Pixel size and type from a JPEG / PNG / WEBP / GIF header. */
export function sniffImage(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { ext: 'png', type: 'image/png', w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { ext: 'jpg', type: 'image/jpeg', w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
    return { ext: 'jpg', type: 'image/jpeg', w: null, h: null };
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    return { ext: 'webp', type: 'image/webp', w: null, h: null };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { ext: 'gif', type: 'image/gif', w: v.getUint16(6, true), h: v.getUint16(8, true) };
  }
  return null;
}

/** An error message with any access token scrubbed out, capped. */
export function scrubError(err) {
  return String(err?.message || err || 'unknown error')
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]')
    .replace(/(EAA[A-Za-z0-9]{20,})/g, '[redacted]')
    .slice(0, 300);
}

/** Meta ad account ids arrive both as `act_123` and `123`. */
export function normalizeAccountId(v) {
  const s = String(v ?? '').trim();
  return s ? s.replace(/^act_/i, '') : '';
}

/**
 * May this connection's token be used for this creative? Only for its OWN ad
 * account: a company can hold several Meta accounts, each with its own token,
 * and asking with the wrong one fails -- and that failure would put the ad in
 * backoff for the connection that CAN read it. A row with no account id is
 * attributable only when the company has exactly one Meta connection
 * (`soleConnection`); otherwise nobody claims it.
 */
export function ownedByConnection(row, connection, { soleConnection = false } = {}) {
  const mine = normalizeAccountId(connection?.meta_ad_account_id);
  const theirs = normalizeAccountId(row?.account_id);
  if (!theirs) return Boolean(soleConnection);
  return Boolean(mine) && mine === theirs;
}

/** Does this ad need its image (re)archived? */
export function needsArchive(row, { now = Date.now(), retryAfterHours = 20 } = {}) {
  if (!row?.creative_id) return false;
  if (row.image_path && String(row.image_creative_id) === String(row.creative_id)) return false;
  if (row.image_error && row.image_attempted_at
      && now - Date.parse(row.image_attempted_at) < retryAfterHours * 3600_000) return false;
  return true;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

/**
 * Archive images for the given ad ids of one connection.
 *
 * deps (injected for tests): graphGet(url, label) -> json; fetchImpl(url) -> Response.
 */
export async function archiveCreativeImages(supabase, connection, {
  adIds,
  limit = 300,
  concurrency = 4,
  retryAfterHours = 20,
  apiVersion,
  graphGet,
  fetchImpl = fetch,
  now = Date.now(),
  onAd = null,
  soleConnection = false,
} = {}) {
  const company = connection.company_entity_id;
  const token = connection.access_token;
  const result = { asked: 0, archived: 0, failed: 0, skipped: 0, already: 0, other_account: 0, bytes: 0, errors: [] };
  if (!token || !company || !graphGet || !apiVersion) return { ...result, disabled: true };
  const ids = [...new Set((adIds || []).map(String))];
  if (!ids.length) return result;

  // Current state of each asked ad, in chunks a URL can carry.
  const rows = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('meta_ad_creatives')
      .select('ad_id, account_id, creative_id, image_path, image_creative_id, image_attempted_at, image_error')
      .eq('company_entity_id', company)
      .in('ad_id', ids.slice(i, i + 200));
    if (error) throw new Error(`meta_ad_creatives read failed: ${error.message}`);
    rows.push(...(data || []));
  }
  const byId = new Map(rows.map((r) => [String(r.ad_id), r]));
  const todo = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    // Never with another account's token -- see ownedByConnection().
    if (!ownedByConnection(r, connection, { soleConnection })) { result.other_account += 1; continue; }
    if (r.image_path && String(r.image_creative_id) === String(r.creative_id)) { result.already += 1; continue; }
    if (!needsArchive(r, { now, retryAfterHours })) { result.skipped += 1; continue; }
    todo.push(r);
  }
  const batch = todo.slice(0, limit);
  result.skipped += todo.length - batch.length;

  await mapLimit(batch, concurrency, async (r) => {
    result.asked += 1;
    const attemptedAt = new Date(now).toISOString();
    try {
      const json = await graphGet(
        `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(r.creative_id)}`
        + `?fields=thumbnail_url&thumbnail_width=${ARCHIVE_SIZE}&thumbnail_height=${ARCHIVE_SIZE}`
        + `&access_token=${encodeURIComponent(token)}`,
        `Meta creative ${r.creative_id} image`);
      const src = json?.thumbnail_url;
      if (!src) throw new Error('Meta returned no thumbnail_url');
      let host;
      try { const u = new URL(src); if (u.protocol !== 'https:') throw new Error('not https'); host = u.hostname; }
      catch { throw new Error('thumbnail_url is not an https URL'); }
      if (!ALLOWED_HOST.test(host)) throw new Error(`thumbnail host ${host} is not Meta's CDN`);

      const res = await fetchImpl(src);
      if (!res.ok) throw new Error(`image download ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) throw new Error('image download was empty');
      if (buf.length > MAX_BYTES) throw new Error(`image is ${buf.length} bytes, over ${MAX_BYTES}`);
      const kind = sniffImage(buf);
      if (!kind) throw new Error('downloaded file is not a JPEG/PNG/WEBP/GIF');

      const sha = createHash('sha256').update(buf).digest('hex');
      const path = `${company}/${sha}.${kind.ext}`;
      const up = await supabase.storage.from(ARCHIVE_BUCKET)
        .upload(path, buf, { contentType: kind.type, upsert: true });
      if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);

      // Only now, and only for the creative this image belongs to.
      const { data: updated, error: updErr } = await supabase.from('meta_ad_creatives')
        .update({
          image_path: path,
          image_sha256: sha,
          image_width: kind.w,
          image_height: kind.h,
          image_bytes: buf.length,
          image_content_type: kind.type,
          image_creative_id: String(r.creative_id),
          image_archived_at: attemptedAt,
          image_attempted_at: attemptedAt,
          image_error: null,
        })
        .eq('company_entity_id', company)
        .eq('ad_id', r.ad_id)
        .eq('creative_id', r.creative_id)
        .select('ad_id');
      if (updErr) throw new Error(`creative row update failed: ${updErr.message}`);
      if (!updated?.length) { result.skipped += 1; onAd?.({ ad_id: r.ad_id, status: 'creative_changed' }); return; }
      result.archived += 1;
      result.bytes += buf.length;
      onAd?.({ ad_id: r.ad_id, status: 'archived', path });
    } catch (err) {
      const message = scrubError(err);
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push({ ad_id: r.ad_id, error: message });
      await supabase.from('meta_ad_creatives')
        .update({ image_attempted_at: attemptedAt, image_error: message })
        .eq('company_entity_id', company)
        .eq('ad_id', r.ad_id);
      onAd?.({ ad_id: r.ad_id, status: 'failed', error: message });
    }
  });
  return result;
}
