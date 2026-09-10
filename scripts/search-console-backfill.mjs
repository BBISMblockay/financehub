// scripts/search-console-backfill.mjs — one-shot history load for
// search_console_{site,page,query}_daily. Manual only, via
// .github/workflows/search-console-backfill.yml.
//
// The nightly (ad-platforms-sync.mjs) re-pulls a trailing window; this fills
// everything before it. Search Console keeps ~16 months (498 final days
// measured 2026-09-10, back to 2025-04-29), so the default range is the
// whole of that, and anything older simply returns no rows -- there is no
// error to catch, only an empty history.
//
// Walks the range in chunks, NEWEST FIRST, each chunk fully written before
// the next is fetched, so a failure keeps every completed chunk and the
// report says exactly which days landed. Re-running any range is an
// idempotent upsert on the same identity as the nightly.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID,
//      GOOGLE_CLIENT_SECRET.
// Optional: SC_BACKFILL_DAYS (default 500), SC_BACKFILL_START / SC_BACKFILL_END
//      (explicit range, both or neither), SC_BACKFILL_CHUNK_DAYS (default 28),
//      SC_LAG_DAYS (default 2), SC_COMPANY_ID, SC_CONNECTION_ID.

import { createClient } from '@supabase/supabase-js';
import {
  runSearchConsoleBackfill,
  searchConsoleWindow,
  DEFAULT_LAG_DAYS,
  SEARCH_CONSOLE_JOB_TYPE,
} from './lib/search-console-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
};

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
if (!GOOGLE_ENV.GOOGLE_CLIENT_ID || !GOOGLE_ENV.GOOGLE_CLIENT_SECRET) throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');

const BACKFILL_DAYS = Number(process.env.SC_BACKFILL_DAYS || 500);
const EXPLICIT_START = process.env.SC_BACKFILL_START || '';
const EXPLICIT_END = process.env.SC_BACKFILL_END || '';
const CHUNK_DAYS = Number(process.env.SC_BACKFILL_CHUNK_DAYS || 28);
const LAG_DAYS = process.env.SC_LAG_DAYS ? Number(process.env.SC_LAG_DAYS) : DEFAULT_LAG_DAYS;
const ONLY_COMPANY_ID = process.env.SC_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.SC_CONNECTION_ID || '';
const BATCH_ID = `search-console-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`;

if ((EXPLICIT_START && !EXPLICIT_END) || (!EXPLICIT_START && EXPLICIT_END)) {
  throw new Error('Set both SC_BACKFILL_START and SC_BACKFILL_END, or neither');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  let q = supabase.from('ad_platform_connections').select('*')
    .eq('platform', 'search_console').eq('is_active', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);
  const { data: conns, error } = await q.order('created_at');
  if (error) throw new Error(`connection load failed: ${error.message}`);
  if (!conns?.length) {
    console.log('[search-console-backfill] no active search_console connection');
    return;
  }

  // Explicit dates are taken as given; the default range ends where the
  // nightly's window ends (LAG_DAYS back, Pacific), so the two never
  // disagree about which day is the newest FINAL one.
  const range = EXPLICIT_START
    ? { startDate: EXPLICIT_START, endDate: EXPLICIT_END }
    : searchConsoleWindow(new Date(), BACKFILL_DAYS - 1, LAG_DAYS);

  console.log(`[search-console-backfill] batch=${BATCH_ID} range=${range.startDate}..${range.endDate} chunk=${CHUNK_DAYS}d`);

  let hadError = false;
  for (const conn of conns) {
    const label = `${conn.display_name || conn.id} (${conn.search_console_site_url || 'no property'})`;
    const { data: job, error: jobErr } = await supabase.from('sync_jobs').insert({
      company_entity_id: conn.company_entity_id,
      job_type: SEARCH_CONSOLE_JOB_TYPE,
      status: 'running',
      started_at: new Date().toISOString(),
    }).select('id').single();
    if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);

    const result = await runSearchConsoleBackfill(supabase, GOOGLE_ENV, conn, {
      ...range,
      chunkDays: CHUNK_DAYS,
      batchId: BATCH_ID,
      onChunk: (r) => console.log(`  [chunk] ${r.window.startDate}..${r.window.endDate}: `
        + `${r.days_with_data} days, ${r.page_rows_upserted} page rows, ${r.query_rows_upserted} query rows`
        + (r.truncated.page || r.truncated.query ? ' [TRUNCATED]' : '')),
      onTokenRefresh: async (accessToken, expiresAt) => {
        await supabase.from('ad_platform_connections')
          .update({ access_token: accessToken, token_expires_at: expiresAt, updated_at: new Date().toISOString() })
          .eq('id', conn.id);
      },
    });

    const status = result.failed ? 'error' : 'success';
    await supabase.from('sync_jobs').update({
      status,
      finished_at: new Date().toISOString(),
      ...(result.failed
        ? { error: `chunk ${result.failed.window.startDate}..${result.failed.window.endDate}: ${result.failed.error}`.slice(0, 2000), result }
        : { result }),
    }).eq('id', job.id);

    if (result.failed) {
      hadError = true;
      console.error(`[error] ${label}: ${result.chunks_completed}/${result.chunks_planned} chunks written`
        + (result.covered ? ` (${result.covered.startDate}..${result.covered.endDate} landed)` : ' (nothing landed)')
        + `; failed at ${result.failed.window.startDate}..${result.failed.window.endDate}: ${result.failed.error}`);
    } else {
      console.log(`[ok] ${label}: ${result.chunks_completed} chunks, ${result.days_with_data} days, `
        + `${result.page_rows_upserted} page rows, ${result.query_rows_upserted} query rows`);
    }
  }
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[search-console-backfill] fatal', err);
  process.exit(1);
});
