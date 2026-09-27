// scripts/meta-creative-images.mjs — archive Meta ad images for EVERY stored
// creative, not just the ones the nightly touched.
//
// WHY. The nightly archives images only for ads whose creatives it fetched in
// its trailing window (ad-platforms-sync.mjs → archiveCreativeImages). The
// baselines Ad Studio shows are mostly OLDER winners -- measured 2026-09-27,
// 686 of the 811 ads with $100+ spend had an expired thumbnail. Asking Meta for
// a creative's image returns a fresh URL whatever the ad's age (probe, same
// day: ads that ended in 2025 answered 1080px), so this walks every stored
// creative that has no current image and archives it.
//
// Resumable by construction: an ad whose image is stored for its current
// creative is skipped, so a re-run continues where the last stopped. An ad
// that failed within 20 hours is skipped too unless META_IMAGES_RETRY_FAILED
// is true -- a permanently broken creative should not cost a Graph call on
// every run.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: META_IMAGES_LIMIT (0 = no cap), META_IMAGES_CHUNK (default 200),
//           META_IMAGES_CONCURRENCY (default 4), META_IMAGES_RETRY_FAILED,
//           META_COMPANY_ID, META_CONNECTION_ID.

import { createClient } from '@supabase/supabase-js';
import { META_API_VERSION, fetchMetaJsonOrThrow } from './lib/ad-platforms-sync-core.mjs';
import { archiveCreativeImages, needsArchive, ownedByConnection, scrubError } from './lib/creative-image-archive.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

const LIMIT = Number(process.env.META_IMAGES_LIMIT || 0);
const CHUNK = Number(process.env.META_IMAGES_CHUNK || 200);
const CONCURRENCY = Number(process.env.META_IMAGES_CONCURRENCY || 4);
const RETRY_FAILED = (process.env.META_IMAGES_RETRY_FAILED || 'false').trim().toLowerCase() === 'true';
const ONLY_COMPANY_ID = process.env.META_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.META_CONNECTION_ID || '';
// sync_jobs.job_type has a CHECK; this is the same family of work as the
// destination backfill, so it records under that type with mode 'images'.
const JOB_TYPE = 'meta_creative_backfill';

if (!Number.isFinite(CHUNK) || CHUNK < 1) throw new Error('META_IMAGES_CHUNK must be >= 1');
if (!Number.isFinite(LIMIT) || LIMIT < 0) throw new Error('META_IMAGES_LIMIT must be >= 0');
if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 8) throw new Error('META_IMAGES_CONCURRENCY must be 1-8');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** The stored creatives THIS connection may archive, paged past PostgREST's
 *  row cap, newest-synced first so a run that stops early covered the recent
 *  end. Only the connection's own ad account: a company can hold several Meta
 *  accounts with separately scoped tokens, and asking with the wrong one would
 *  fail and put the ad in backoff for the connection that can read it. */
async function loadCandidates(connection, soleConnection) {
  const out = [];
  let stored = 0, otherAccount = 0;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('meta_ad_creatives')
      .select('ad_id, account_id, creative_id, image_path, image_creative_id, image_attempted_at, image_error, synced_at')
      .eq('company_entity_id', connection.company_entity_id)
      .order('synced_at', { ascending: false, nullsFirst: false })
      .order('ad_id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`meta_ad_creatives load failed: ${error.message}`);
    if (!data?.length) break;
    stored += data.length;
    for (const r of data) {
      if (!ownedByConnection(r, connection, { soleConnection })) { otherAccount += 1; continue; }
      if (needsArchive(r, { retryAfterHours: RETRY_FAILED ? 0 : 20 })) out.push(String(r.ad_id));
    }
    if (data.length < PAGE) break;
  }
  return { candidates: out, stored, otherAccount };
}

/** Is this the company's only active Meta connection? Asked of the database,
 *  not of this run's list, which META_CONNECTION_ID may have narrowed. */
async function isSoleConnection(connection) {
  const { data, error } = await supabase.from('ad_platform_connections').select('id')
    .eq('platform', 'meta_ads').eq('is_active', true)
    .eq('company_entity_id', connection.company_entity_id);
  if (error) throw new Error(`connection count failed: ${error.message}`);
  return (data || []).length === 1;
}

async function runConnection(connection) {
  const label = `${connection.display_name || connection.id}`;
  const soleConnection = await isSoleConnection(connection);
  const { candidates: all, stored, otherAccount } = await loadCandidates(connection, soleConnection);
  const candidates = LIMIT ? all.slice(0, LIMIT) : all;
  console.log(`[meta-creative-images] ${label}: ${candidates.length} to archive (stored creatives ${stored}, `
    + `another account's ${otherAccount}, needing an image ${all.length})`);
  if (!candidates.length) return { skipped: true };

  const { data: job, error: jobErr } = await supabase.from('sync_jobs').insert({
    company_entity_id: connection.company_entity_id,
    job_type: JOB_TYPE,
    status: 'running',
    started_at: new Date().toISOString(),
  }).select('id').single();
  if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);

  const total = { mode: 'images', account_id: connection.meta_ad_account_id ?? null, asked: 0, archived: 0, failed: 0, skipped: 0, already: 0, bytes: 0,
    chunks_planned: Math.ceil(candidates.length / CHUNK), chunks_completed: 0, errors: [], aborted: null };
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    try {
      const r = await archiveCreativeImages(supabase, connection, {
        adIds: chunk, limit: chunk.length, concurrency: CONCURRENCY, retryAfterHours: RETRY_FAILED ? 0 : 20, soleConnection,
        apiVersion: META_API_VERSION,
        graphGet: (url, lbl) => fetchMetaJsonOrThrow(url, {}, lbl),
      });
      for (const k of ['asked', 'archived', 'failed', 'skipped', 'already', 'bytes']) total[k] += r[k] || 0;
      for (const e of r.errors || []) if (total.errors.length < 20) total.errors.push(e);
      total.chunks_completed += 1;
      console.log(`  [chunk ${total.chunks_completed}/${total.chunks_planned}] archived ${r.archived}, failed ${r.failed}, skipped ${r.skipped}`
        + (r.errors?.length ? ` -- e.g. ${r.errors[0].error}` : ''));
    } catch (err) {
      // A read failure (not a per-ad one): stop, keep what landed, say where.
      total.aborted = { chunk: total.chunks_completed + 1, error: scrubError(err) };
      break;
    }
  }
  // Nothing archived and something failed is a broken run (a missing bucket,
  // an expired token), not a run with a few bad creatives.
  const broken = Boolean(total.aborted) || (total.archived === 0 && total.failed > 0);
  const { error: updErr } = await supabase.from('sync_jobs').update({
    status: broken ? 'error' : 'success',
    finished_at: new Date().toISOString(),
    result: total,
    ...(broken ? { error: (total.aborted?.error || total.errors[0]?.error || 'no image archived').slice(0, 2000) } : {}),
  }).eq('id', job.id);
  if (updErr) {
    console.error(`[error] ${label}: archived ${total.archived}, failed ${total.failed}, but the sync_jobs row could not be closed: ${updErr.message}`);
    throw new Error(`sync_jobs update failed for job ${job.id}: ${updErr.message}`);
  }
  return { ...total, broken };
}

async function main() {
  let q = supabase.from('ad_platform_connections').select('*').eq('platform', 'meta_ads').eq('is_active', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);
  const { data: conns, error } = await q.order('created_at');
  if (error) throw new Error(`connection load failed: ${error.message}`);
  if (!conns?.length) { console.log('[meta-creative-images] no active meta_ads connection'); return; }

  let hadError = false;
  for (const conn of conns) {
    const label = `${conn.display_name || conn.id}`;
    const r = await runConnection(conn);
    if (r.skipped) { console.log(`[ok] ${label}: every stored creative already has its image`); continue; }
    const line = `${label}: archived ${r.archived}, failed ${r.failed}, already stored ${r.already}, backing off ${r.skipped}, ${Math.round(r.bytes / 1024)} KB`;
    if (r.broken) { hadError = true; console.error(`[error] ${line}${r.aborted ? ` -- stopped at chunk ${r.aborted.chunk}: ${r.aborted.error}` : ''}`); }
    else console.log(`[ok] ${line}`);
  }
  if (hadError) process.exit(1);
}

main().catch((err) => { console.error('[meta-creative-images] fatal', scrubError(err)); process.exit(1); });
