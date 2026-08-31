// scripts/ad-platforms-sync.mjs — nightly GHA orchestrator for marketing KPIs.
// Pulls Google Ads / Meta Ads / TikTok Ads / GA4 daily campaign metrics
// DIRECTLY from each platform's API into marketing_kpis_daily (see
// ad-platforms-sync-core). Replaces the retired Supermetrics path.
//
// Per-connection credentials (OAuth refresh tokens, Meta System User token)
// live on ad_platform_connections rows — same model as shopify_connections.
// The only GHA secrets are Supabase service-role + the shared Google OAuth
// client (GOOGLE_CLIENT_ID/SECRET, needed to redeem refresh tokens) and
// GOOGLE_ADS_DEVELOPER_TOKEN. Google connections are skipped with a notice
// when those envs are absent, so the workflow is safe to schedule before the
// dev-portal setup is finished; Meta/TikTok connections sync regardless.

import { createClient } from '@supabase/supabase-js';
import { runConnectionSync, runMetaAdLevelSync, runMetaOrganicSync } from './lib/ad-platforms-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
};

const ONLY_COMPANY_ID = process.env.ADS_ONLY_COMPANY_ID || '';
const ONLY_PLATFORM = (process.env.ADS_ONLY_PLATFORM || '').toLowerCase();
const ONLY_CONNECTION_ID = process.env.ADS_ONLY_CONNECTION_ID || '';
const DAYS_BACK = process.env.ADS_DAYS_BACK ? Number(process.env.ADS_DAYS_BACK) : null;
// Instagram history is walked post-by-post, not by date window, so it needs
// its own knob -- ADS_DAYS_BACK has no effect on it. Each post costs an extra
// insights request, hence opt-in rather than a raised default.
const IG_POST_LIMIT = process.env.ADS_IG_POST_LIMIT ? Number(process.env.ADS_IG_POST_LIMIT) : null;
// The hourly refresh exists to keep SPEND current. Organic is the expensive
// half -- one insights request per Instagram post, 50 by default -- and post
// engagement does not need hourly resolution, so the hourly cron skips it and
// the nightly still does it in full.
const SKIP_ORGANIC = String(process.env.ADS_SKIP_ORGANIC || '').toLowerCase() === 'true';

const BATCH_ID =
  process.env.ADS_SYNC_BATCH_ID ||
  `ad-platforms-${new Date().toISOString().replace(/[:.]/g, '-')}`;

// Sentinel for "skipped on purpose", so the existing non-fatal catch around
// the organic sync can tell it apart from a real failure.
class SkipOrganic extends Error {}

const JOB_TYPES = {
  google_ads: 'google_ads_kpis',
  meta_ads: 'meta_ads_kpis',
  tiktok_ads: 'tiktok_ads_kpis',
  ga4: 'ga4_kpis',
};

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function googleEnvReady() {
  return GOOGLE_ENV.GOOGLE_CLIENT_ID && GOOGLE_ENV.GOOGLE_CLIENT_SECRET;
}

async function startJob(connection) {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      company_entity_id: connection.company_entity_id,
      job_type: JOB_TYPES[connection.platform],
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`sync_jobs insert failed: ${error.message}`);
  return data.id;
}

async function finishJob(jobId, status, payload) {
  const update = { status, finished_at: new Date().toISOString() };
  if (status === 'success') update.result = payload;
  else update.error = String(payload?.error || payload).slice(0, 2000);
  await supabase.from('sync_jobs').update(update).eq('id', jobId);
}

async function loadConnections() {
  let q = supabase
    .from('ad_platform_connections')
    .select('*')
    .eq('is_active', true)
    .eq('sync_enabled', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_PLATFORM) q = q.eq('platform', ONLY_PLATFORM);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);
  const { data, error } = await q.order('platform').order('display_name');
  if (error) throw new Error(`ad_platform_connections load failed: ${error.message}`);
  return data || [];
}

async function syncConnection(connection) {
  const label = `${connection.display_name || connection.id} (${connection.platform})`;

  if ((connection.platform === 'google_ads' || connection.platform === 'ga4') && !googleEnvReady()) {
    console.log(`[skip] ${label}: GOOGLE_CLIENT_ID/SECRET not set — add the repo secrets to activate`);
    return { connection: label, skipped: 'google_env_missing' };
  }

  const jobId = await startJob(connection);
  try {
    const result = await runConnectionSync(supabase, GOOGLE_ENV, connection, {
      batchId: BATCH_ID,
      daysBackOverride: DAYS_BACK,
      onTokenRefresh: async (accessToken, expiresAt) => {
        await supabase
          .from('ad_platform_connections')
          .update({ access_token: accessToken, token_expires_at: expiresAt, updated_at: new Date().toISOString() })
          .eq('id', connection.id);
      },
    });

    // Meta additionally gets ad-level performance + creative metadata for the
    // creative report. Failures here are logged but never fail the
    // campaign-level KPI sync above.
    if (connection.platform === 'meta_ads') {
      try {
        const adResult = await runMetaAdLevelSync(supabase, connection, {
          batchId: BATCH_ID,
          daysBackOverride: DAYS_BACK,
        });
        result.ad_level = adResult;
        console.log(`[ok] ${label}: ad-level ${adResult.ad_rows_upserted} rows, ${adResult.creatives_upserted} creatives`);
      } catch (err) {
        result.ad_level = { error: String(err?.message || err) };
        console.error(`[warn] ${label}: ad-level sync failed: ${result.ad_level.error}`);
      }

      // Organic Instagram/Facebook — no-ops cleanly until
      // instagram_business_account_id/facebook_page_id are set on the
      // connection (needs new Meta permissions marketing hasn't granted
      // yet). Same non-fatal wrapping as ad-level above.
      try {
        if (SKIP_ORGANIC) {
          result.organic = { skipped: 'ADS_SKIP_ORGANIC' };
          throw new SkipOrganic();
        }
        const organicResult = await runMetaOrganicSync(supabase, connection, {
          daysBackOverride: DAYS_BACK, igPostLimit: IG_POST_LIMIT,
        });
        result.organic = organicResult;
        if (organicResult.configured) {
          console.log(`[ok] ${label}: organic ${organicResult.media_upserted} posts, ${organicResult.page_days_upserted} page-days`);
          // A fetch that stops exactly on the cap means there is more history
          // behind it -- say so, rather than letting a truncated walk look complete.
          if (IG_POST_LIMIT && organicResult.media_fetched >= IG_POST_LIMIT) {
            console.log(`[note] ${label}: Instagram stopped at the ${IG_POST_LIMIT}-post cap — raise ig_post_limit for more history`);
          }
        }
      } catch (err) {
        // A deliberate skip is not a failure and must not be logged as one.
        if (!(err instanceof SkipOrganic)) {
          result.organic = { error: String(err?.message || err) };
          console.error(`[warn] ${label}: organic sync failed: ${result.organic.error}`);
        }
      }
    }

    const meta = { ...(connection.meta || {}), last_sync_at: result.synced_at };
    await supabase
      .from('ad_platform_connections')
      .update({ meta, updated_at: new Date().toISOString() })
      .eq('id', connection.id);

    await finishJob(jobId, 'success', result);
    console.log(`[ok] ${label}: ${result.kpi_rows_upserted} rows (${result.window.startDate}..${result.window.endDate})`);
    return { connection: label, ...result };
  } catch (err) {
    const message = err?.message || String(err);
    await finishJob(jobId, 'error', { error: message });
    console.error(`[error] ${label}: ${message}`);
    throw err;
  }
}

async function main() {
  console.log(`[ad-platforms-sync] batch=${BATCH_ID}${ONLY_PLATFORM ? ` platform=${ONLY_PLATFORM}` : ''}${DAYS_BACK ? ` days_back=${DAYS_BACK}` : ''}`);

  const connections = await loadConnections();
  if (!connections.length) {
    console.log('[ad-platforms-sync] no active connections with sync_enabled=true');
    return;
  }

  let hadError = false;
  const allResults = [];
  for (const connection of connections) {
    console.log(`[ad-platforms-sync] → ${connection.display_name || connection.id} (${connection.platform})`);
    try {
      allResults.push(await syncConnection(connection));
    } catch (err) {
      hadError = true;
      allResults.push({
        connection: `${connection.display_name || connection.id} (${connection.platform})`,
        error: String(err?.message || err),
      });
    }
  }

  console.log('[ad-platforms-sync] done', JSON.stringify(allResults, null, 2));
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[ad-platforms-sync] fatal', err);
  process.exit(1);
});
