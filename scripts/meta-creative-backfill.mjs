// scripts/meta-creative-backfill.mjs — one-shot destination/copy backfill for
// meta_ad_creatives. Manual only, via .github/workflows/meta-creative-backfill.yml.
//
// WHY THIS EXISTS. The nightly (ad-platforms-sync.mjs → runMetaAdLevelSync)
// asks Meta about creatives only for ad ids that have insights rows in its
// trailing window (`days_back ?? 30`). Measured 2026-09-16 on Baseballism:
// 126 of 4,079 stored creatives had ever been asked about, 82 resolved a
// destination, and $5,304,686 of SHARE spend sat on ads that had never been
// requested at all. This fills that in.
//
// It does NOT touch performance data. It writes destinations (and recovered
// page-post copy) onto creative rows, under the three write rules documented
// on runMetaCreativeBackfill -- the short version being that it only ever
// ADDS: a resolved link, or recovered copy, or a full row for an ad that had
// none. It never writes a null over something the nightly already found.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional:
//   META_BACKFILL_MODE      missing (default) | all
//                           `missing` = stored creatives with no link_url
//                                       OR no preview_shareable_link.
//                           `all`     = every stored creative, re-asked.
//   META_BACKFILL_DISCOVER  true (default) | false — also enumerate the
//                           account's own ad ids, reaching ads that have
//                           never landed in our tables. Additive: a listing
//                           failure logs and falls back to stored ids.
//   META_BACKFILL_LIMIT     cap on ads per connection (0 = no cap)
//   META_BACKFILL_CHUNK     ads per fetch+write chunk (default 300)
//   META_BACKFILL_PAUSE_MS  pause between chunks (default 0)
//   META_COMPANY_ID, META_CONNECTION_ID

import { createClient } from '@supabase/supabase-js';
import {
  runMetaCreativeBackfill,
  fetchMetaAccountAdIds,
} from './lib/ad-platforms-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const MODE = (process.env.META_BACKFILL_MODE || 'missing').trim().toLowerCase();
if (!['missing', 'all'].includes(MODE)) {
  throw new Error(`META_BACKFILL_MODE must be "missing" or "all", got "${MODE}"`);
}
// Default ON: the point of this script is maximum coverage, and discovery is
// the only path to an ad that never appeared in a sync window.
const DISCOVER = (process.env.META_BACKFILL_DISCOVER || 'true').trim().toLowerCase() !== 'false';
const LIMIT = Number(process.env.META_BACKFILL_LIMIT || 0);
const CHUNK = Number(process.env.META_BACKFILL_CHUNK || 300);
const PAUSE_MS = Number(process.env.META_BACKFILL_PAUSE_MS || 0);
const ONLY_COMPANY_ID = process.env.META_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.META_CONNECTION_ID || '';
const JOB_TYPE = 'meta_creative_backfill';
const BATCH_ID = `meta-creative-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`;

if (!Number.isFinite(CHUNK) || CHUNK < 1) throw new Error('META_BACKFILL_CHUNK must be >= 1');
if (!Number.isFinite(LIMIT) || LIMIT < 0) throw new Error('META_BACKFILL_LIMIT must be >= 0');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Every stored creative for this company, paged past PostgREST's row cap.
 * Returns the full id set (for the known/new decision) and the subset that
 * still has no destination or no preview link (the default candidate set). */
async function loadStoredCreatives(companyId) {
  const known = new Set();
  const missingLink = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('meta_ad_creatives')
      .select('ad_id, link_url, preview_shareable_link, synced_at')
      .eq('company_entity_id', companyId)
      // Newest-synced first: the most recently active ads are the ones a
      // marketer is most likely to ask about, so a run that dies partway
      // has still covered the useful end. Not spend-ordered -- that would
      // need a join this client cannot express -- but it correlates.
      .order('synced_at', { ascending: false, nullsFirst: false })
      .order('ad_id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`meta_ad_creatives load failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      known.add(String(r.ad_id));
      // Either gap makes an ad worth re-asking: one Meta read answers both.
      if (!r.link_url || !r.preview_shareable_link) missingLink.push(String(r.ad_id));
    }
    if (data.length < PAGE) break;
  }
  return { known, missingLink };
}

async function backfillConnection(connection) {
  const label = `${connection.display_name || connection.id}`;
  const { known, missingLink } = await loadStoredCreatives(connection.company_entity_id);

  let candidates = MODE === 'all' ? [...known] : missingLink;
  let discovered = 0;
  if (DISCOVER) {
    const accountIds = await fetchMetaAccountAdIds(connection);
    if (accountIds) {
      // Ads the account has that we have never stored. Appended AFTER the
      // stored candidates: those are ordered newest-first and are the ones
      // someone is asking about today; an unseen id has no such ordering.
      const unseen = accountIds.filter((id) => !known.has(id));
      discovered = unseen.length;
      candidates = [...candidates, ...unseen];
      console.log(`[discover] ${label}: account lists ${accountIds.length} ads, ${unseen.length} not stored here`);
    }
  }
  candidates = [...new Set(candidates)];
  if (LIMIT) candidates = candidates.slice(0, LIMIT);

  console.log(`[meta-creative-backfill] ${label}: mode=${MODE} candidates=${candidates.length}`
    + ` (stored=${known.size}, missing_link_or_preview=${missingLink.length}, discovered=${discovered})`);
  if (!candidates.length) return { skipped: true, ads_requested: 0 };

  const { data: job, error: jobErr } = await supabase.from('sync_jobs').insert({
    company_entity_id: connection.company_entity_id,
    job_type: JOB_TYPE,
    status: 'running',
    started_at: new Date().toISOString(),
  }).select('id').single();
  if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);

  const result = await runMetaCreativeBackfill(supabase, connection, {
    adIds: candidates,
    knownIds: known,
    chunkSize: CHUNK,
    pauseMs: PAUSE_MS,
    onChunk: (c) => console.log(
      `  [chunk ${c.chunk}/${c.of}] asked ${c.requested}, returned ${c.returned}, `
      + `resolved ${c.resolved} (new rows ${c.new_rows}, link ${c.link_rows}, body ${c.body_rows})`),
  });
  result.discovered_unseen = discovered;
  result.mode = MODE;
  // The run's identity lands on the sync_jobs row, since the creative table
  // has no per-row batch column to carry it.
  result.batch_id = BATCH_ID;

  // The terminal update is NOT fire-and-forget. If it fails after the creative
  // writes landed, discarding its error would print [ok], exit 0, and leave
  // the durable job row stuck on 'running' -- so sync_jobs would say a run is
  // still going while the process is gone, which is exactly the state someone
  // diagnosing a half-finished backfill has to trust. Better to exit non-zero
  // over a run whose DATA succeeded than to record a status that is false:
  // re-running is cheap and idempotent (the default `missing` mode skips
  // whatever resolved), whereas a wrong job row is not self-correcting.
  const { error: jobUpdateErr } = await supabase.from('sync_jobs').update({
    status: result.failed ? 'error' : 'success',
    finished_at: new Date().toISOString(),
    ...(result.failed
      ? { error: `chunk ${result.failed.chunk}: ${result.failed.error}`.slice(0, 2000), result }
      : { result }),
  }).eq('id', job.id);
  if (jobUpdateErr) {
    // Print what the run actually achieved before throwing: the counts are
    // the only record left once the job row is known to be wrong.
    console.error(`[error] ${label}: creative writes finished`
      + ` (${result.chunks_completed}/${result.chunks_planned} chunks,`
      + ` ${result.links_resolved} destinations resolved,`
      + ` ${result.link_rows_written} links and ${result.body_rows_written} bodies written)`
      + ` but the sync_jobs row could not be closed out: ${jobUpdateErr.message}`);
    throw new Error(`sync_jobs update failed for job ${job.id}: ${jobUpdateErr.message}`);
  }

  return result;
}

async function main() {
  let q = supabase.from('ad_platform_connections').select('*')
    .eq('platform', 'meta_ads').eq('is_active', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);
  const { data: conns, error } = await q.order('created_at');
  if (error) throw new Error(`connection load failed: ${error.message}`);
  if (!conns?.length) {
    console.log('[meta-creative-backfill] no active meta_ads connection');
    return;
  }

  console.log(`[meta-creative-backfill] batch=${BATCH_ID} mode=${MODE} discover=${DISCOVER} chunk=${CHUNK}`);

  let hadError = false;
  for (const conn of conns) {
    const label = `${conn.display_name || conn.id}`;
    const result = await backfillConnection(conn);
    if (result.skipped) { console.log(`[ok] ${label}: nothing to backfill`); continue; }
    if (result.failed) {
      hadError = true;
      console.error(`[error] ${label}: ${result.chunks_completed}/${result.chunks_planned} chunks written`
        + ` (${result.links_resolved} links resolved before the failure);`
        + ` failed at chunk ${result.failed.chunk}: ${result.failed.error}`);
    } else {
      console.log(`[ok] ${label}: ${result.chunks_completed} chunks, ${result.ads_returned} ads returned,`
        + ` ${result.links_resolved} destinations resolved`
        + ` (${result.new_creative_rows} new rows, ${result.link_rows_written} links written,`
        + ` ${result.body_rows_written} bodies recovered,`
        + ` ${result.preview_rows_written} preview links written of ${result.previews_returned} returned)`);
    }
  }
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[meta-creative-backfill] fatal', err);
  process.exit(1);
});
