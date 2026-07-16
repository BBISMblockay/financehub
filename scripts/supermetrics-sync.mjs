// scripts/supermetrics-sync.mjs — nightly GHA orchestrator for marketing KPIs.
// Pulls Google Ads / Meta Ads / TikTok Ads / GA4 daily campaign metrics from
// the Supermetrics API into marketing_kpis_daily (see supermetrics-sync-core).
//
// Deliberately a NO-OP (exit 0) when SUPERMETRICS_API_KEY is absent, so the
// workflow can be merged and scheduled before the key exists as a secret.

import { createClient } from '@supabase/supabase-js';
import { runSourceSync } from './lib/supermetrics-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPERMETRICS_API_KEY = process.env.SUPERMETRICS_API_KEY || '';

const ONLY_COMPANY_ID = process.env.SM_ONLY_COMPANY_ID || '';
const ONLY_PLATFORM = (process.env.SM_ONLY_PLATFORM || '').toLowerCase();
const DAYS_BACK = process.env.SM_DAYS_BACK ? Number(process.env.SM_DAYS_BACK) : null;

const BATCH_ID =
  process.env.SM_SYNC_BATCH_ID ||
  `supermetrics-${new Date().toISOString().replace(/[:.]/g, '-')}`;

if (!SUPERMETRICS_API_KEY) {
  console.log('[supermetrics-sync] SUPERMETRICS_API_KEY not set — skipping (add the repo secret to activate)');
  process.exit(0);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function startJob(connection) {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      company_entity_id: connection.company_entity_id,
      job_type: 'supermetrics_kpis',
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
    .from('supermetrics_connections')
    .select('*')
    .eq('is_active', true)
    .eq('sync_enabled', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  const { data, error } = await q.order('display_name');
  if (error) throw new Error(`supermetrics_connections load failed: ${error.message}`);
  return data || [];
}

async function syncConnection(connection) {
  const results = { connection: connection.display_name, sources: [] };
  const sources = (connection.sources || []).filter(
    (s) => !ONLY_PLATFORM || s.platform === ONLY_PLATFORM,
  );
  if (!sources.length) {
    console.log(`[skip] ${connection.display_name}: no matching sources configured`);
    return results;
  }

  const jobId = await startJob(connection);
  const meta = { ...(connection.meta || {}) };
  let hadError = false;

  for (const source of sources) {
    try {
      const result = await runSourceSync(supabase, SUPERMETRICS_API_KEY, connection, source, {
        batchId: BATCH_ID,
        daysBackOverride: DAYS_BACK,
      });
      results.sources.push(result);
      meta[`last_sync_${source.platform}`] = result.synced_at;
      console.log(`[ok] ${connection.display_name} ${source.platform}: ${result.kpi_rows_upserted} rows (${result.window.startDate}..${result.window.endDate})`);
    } catch (err) {
      hadError = true;
      const message = err?.message || String(err);
      results.sources.push({ platform: source.platform, error: message });
      console.error(`[error] ${connection.display_name} ${source.platform}: ${message}`);
    }
  }

  await supabase
    .from('supermetrics_connections')
    .update({ meta, updated_at: new Date().toISOString() })
    .eq('id', connection.id);

  if (hadError) {
    await finishJob(jobId, 'error', { error: 'one or more sources failed', sources: results.sources });
    throw new Error('one or more sources failed');
  }
  await finishJob(jobId, 'success', results);
  return results;
}

async function main() {
  console.log(`[supermetrics-sync] batch=${BATCH_ID}${ONLY_PLATFORM ? ` platform=${ONLY_PLATFORM}` : ''}${DAYS_BACK ? ` days_back=${DAYS_BACK}` : ''}`);

  const connections = await loadConnections();
  if (!connections.length) {
    console.log('[supermetrics-sync] no active connections with sync_enabled=true');
    return;
  }

  let hadError = false;
  const allResults = [];
  for (const connection of connections) {
    console.log(`[supermetrics-sync] → ${connection.display_name}`);
    try {
      allResults.push(await syncConnection(connection));
    } catch (err) {
      hadError = true;
      allResults.push({ connection: connection.display_name, error: String(err?.message || err) });
    }
  }

  console.log('[supermetrics-sync] done', JSON.stringify(allResults, null, 2));
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[supermetrics-sync] fatal', err);
  process.exit(1);
});
