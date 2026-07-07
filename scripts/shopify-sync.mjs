// scripts/shopify-sync.mjs — nightly GHA orchestrator (incremental + optional windowed history).
// User-initiated backfill runs via edge function shopify-sync-run + Integrations UI.

import { createClient } from '@supabase/supabase-js';
import {
  connectionReadyForSync,
} from './lib/shopify-scopes.mjs';
import {
  DEFAULT_CHUNK_DAYS,
  runIncrementalSales,
  runInventorySnapshot,
  runWindowedHistory,
} from './lib/shopify-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const SYNC_MODE = (process.env.SHOPIFY_SYNC_MODE || 'incremental').toLowerCase();
const DAYS_BACK = Number(process.env.SHOPIFY_DAYS_BACK || 2);
const HISTORY_DAYS = process.env.SHOPIFY_HISTORY_DAYS
  ? Number(process.env.SHOPIFY_HISTORY_DAYS)
  : null;
const HISTORY_CHUNK_DAYS = Number(process.env.SHOPIFY_HISTORY_CHUNK_DAYS || DEFAULT_CHUNK_DAYS);
const ONLY_COMPANY_ID = process.env.SHOPIFY_ONLY_COMPANY_ID || '';
const ONLY_CONNECTION_ID = process.env.SHOPIFY_ONLY_CONNECTION_ID || '';
const SKIP_SALES = process.env.SHOPIFY_SKIP_SALES === 'true';
const SKIP_INVENTORY = process.env.SHOPIFY_SKIP_INVENTORY === 'true';
const SKIP_SUMMARY_REFRESH = process.env.SHOPIFY_SKIP_SUMMARY_REFRESH === 'true';

const BATCH_ID =
  process.env.SHOPIFY_SYNC_BATCH_ID ||
  `shopify-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function startJob(connection, jobType) {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      job_type: jobType,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`sync_jobs insert failed: ${error.message}`);
  return data.id;
}

async function finishJob(jobId, status, payload) {
  const update = {
    status,
    finished_at: new Date().toISOString(),
  };
  if (status === 'success') update.result = payload;
  else update.error = String(payload?.error || payload).slice(0, 2000);
  await supabase.from('sync_jobs').update(update).eq('id', jobId);
}

async function loadConnections() {
  let q = supabase
    .from('shopify_connections')
    .select('*')
    .eq('is_active', true)
    .eq('sync_enabled', true)
    .not('access_token', 'is', null);

  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  if (ONLY_CONNECTION_ID) q = q.eq('id', ONLY_CONNECTION_ID);

  const { data, error } = await q.order('shop_domain');
  if (error) throw new Error(`shopify_connections load failed: ${error.message}`);
  return (data || []).filter(connectionReadyForSync);
}

async function syncConnection(connection) {
  const results = { shop_domain: connection.shop_domain, jobs: [] };

  if (!SKIP_SALES && (SYNC_MODE === 'history' || SYNC_MODE === 'full')) {
    const days = HISTORY_DAYS || connection.history_days_default || 90;
    const jobId = await startJob(connection, 'history_import');
    try {
      const result = await runWindowedHistory(supabase, connection, {
        batchId: BATCH_ID,
        historyDays: days,
        chunkDays: HISTORY_CHUNK_DAYS,
      });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      console.log(`[ok] ${connection.shop_domain} history_import: ${result.sales_rows_total} sales rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      throw err;
    }
  }

  if (!SKIP_SALES && SYNC_MODE === 'incremental') {
    const jobId = await startJob(connection, 'incremental_sales');
    try {
      const result = await runIncrementalSales(supabase, connection, {
        batchId: BATCH_ID,
        daysBack: DAYS_BACK,
      });
      if (result.last_order_sync_at) {
        const meta = { ...(connection.meta || {}), last_order_sync_at: result.last_order_sync_at, last_sales_sync_at: result.last_sales_sync_at };
        await supabase.from('shopify_connections').update({ meta }).eq('id', connection.id);
      }
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      console.log(`[ok] ${connection.shop_domain} incremental_sales: ${result.sales_rows_upserted} rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      throw err;
    }
  }

  if (!SKIP_INVENTORY && (SYNC_MODE === 'incremental' || SYNC_MODE === 'full')) {
    const jobId = await startJob(connection, 'inventory_snapshot');
    try {
      const result = await runInventorySnapshot(supabase, connection, { batchId: BATCH_ID });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      console.log(`[ok] ${connection.shop_domain} inventory_snapshot: ${result.inventory_rows_upserted} rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      throw err;
    }
  }

  return results;
}

async function purgeBetterReportsOverlap(companyEntityId) {
  const { data, error } = await supabase.rpc('purge_better_reports_overlap', {
    p_company_entity_id: companyEntityId,
  });
  if (error) throw new Error(`purge_better_reports_overlap failed: ${error.message}`);
  const deleted = data?.[0]?.deleted_rows ?? 0;
  console.log(`[purge] better_reports overlap removed ${deleted} rows for ${companyEntityId}`);
  return deleted;
}

async function main() {
  console.log(`[shopify-sync] mode=${SYNC_MODE} batch=${BATCH_ID}`);

  const connections = await loadConnections();
  if (!connections.length) {
    console.log('[shopify-sync] no active connections with sync_enabled=true and scopes OK');
    return;
  }

  let hadError = false;
  const allResults = [];

  for (const connection of connections) {
    console.log(`[shopify-sync] → ${connection.shop_domain}`);
    try {
      allResults.push(await syncConnection(connection));
    } catch (err) {
      hadError = true;
      console.error(`[error] ${connection.shop_domain}: ${err.message || err}`);
      allResults.push({ shop_domain: connection.shop_domain, error: String(err) });
    }
  }

  if (!SKIP_SUMMARY_REFRESH) {
    const companyIds = [...new Set(connections.map((c) => c.company_entity_id).filter(Boolean))];
    for (const companyId of companyIds) {
      try {
        await purgeBetterReportsOverlap(companyId);
      } catch (err) {
        hadError = true;
        console.error(`[error] purge overlap ${companyId}: ${err.message || err}`);
      }
    }

    const { error } = await supabase.rpc('refresh_sales_verification_store_comp_summary');
    if (error) {
      hadError = true;
      console.error(`[error] summary refresh: ${error.message}`);
    }

    const { error: velocityError } = await supabase.rpc('refresh_sales_velocity_mv');
    if (velocityError) {
      hadError = true;
      console.error(`[error] velocity mv refresh: ${velocityError.message}`);
    }
  }

  console.log('[shopify-sync] done', JSON.stringify(allResults, null, 2));
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[shopify-sync] fatal', err);
  process.exit(1);
});
