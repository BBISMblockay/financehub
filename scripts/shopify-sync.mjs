// scripts/shopify-sync.mjs — nightly GHA orchestrator (incremental + optional windowed history).
// User-initiated backfill runs via edge function shopify-sync-run + Integrations UI.

import { createClient } from '@supabase/supabase-js';
import {
  connectionReadyForSync,
} from './lib/shopify-scopes.mjs';
import {
  DEFAULT_CHUNK_DAYS,
  runCatalogSync,
  runDraftOrdersSync,
  runIncrementalSales,
  runInventorySnapshot,
  runPayoutsSync,
  runSessionsSync,
  runLandingPagesSync,
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
const SKIP_CATALOG = process.env.SHOPIFY_SKIP_CATALOG === 'true';
const SKIP_PAYOUTS = process.env.SHOPIFY_SKIP_PAYOUTS === 'true';
const SKIP_DRAFT_ORDERS = process.env.SHOPIFY_SKIP_DRAFT_ORDERS === 'true';
const SKIP_SESSIONS = process.env.SHOPIFY_SKIP_SESSIONS === 'true';
// 90 days keeps the nightly call small while re-stating recent history, since
// Shopify revises analytics for a few days after the fact. Raise it once (or
// run with SHOPIFY_SESSIONS_DAYS=365) to seed as much history as Shopify will
// serve -- how far back that goes is recorded per run as
// earliest_day_returned, and it decides when year-over-year becomes possible.
const SESSIONS_DAYS = Number(process.env.SHOPIFY_SESSIONS_DAYS || 90);
// Landing pages cost one ShopifyQL query PER DAY (see runLandingPagesSync for
// why it cannot be one wide window), so the default window is much shorter
// than sessions'. The weekly report needs two weeks; 30 gives margin.
const SKIP_LANDING_PAGES = process.env.SHOPIFY_SKIP_LANDING_PAGES === 'true';
const LANDING_PAGES_DAYS = Number(process.env.SHOPIFY_LANDING_PAGES_DAYS || 30);
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
        const { error: metaErr } = await supabase.from('shopify_connections').update({ meta }).eq('id', connection.id);
        if (metaErr) throw new Error(`meta update failed: ${metaErr.message}`);
        // Without this, connection.meta stays the stale pre-run snapshot for
        // the rest of this function -- the draft_orders_sync block below
        // does its own read-modify-write off connection.meta, so it would
        // silently stomp the last_order_sync_at/last_sales_sync_at written
        // above back to whatever they were before this run even started.
        // That's exactly what happened in production: last_order_sync_at
        // was pinned to 2026-07-22 for weeks (draft_orders_sync always ran
        // after and always won) while sync_jobs.result showed it computing
        // the correct, advancing date every single day -- the write was
        // never failing, it was being overwritten a few lines later. Each
        // day's incremental_sales then re-fetched the same ~3-week-old
        // "touched since" backlog instead of the intended ~2 days, and that
        // compounding backlog is what finally OOM-crashed the flagship
        // store's sync on 2026-08-13.
        connection.meta = meta;
      }
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      console.log(`[ok] ${connection.shop_domain} incremental_sales: ${result.sales_rows_upserted} rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      throw err;
    }
  }

  if (!SKIP_PAYOUTS && (SYNC_MODE === 'incremental' || SYNC_MODE === 'full')) {
    const jobId = await startJob(connection, 'payouts_sync');
    try {
      const result = await runPayoutsSync(supabase, connection, { batchId: BATCH_ID });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      if (result.skipped) {
        console.log(`[skip] ${connection.shop_domain} payouts_sync: ${result.reason || result.missing?.join(',')}`);
      } else {
        console.log(`[ok] ${connection.shop_domain} payouts_sync: ${result.payouts_upserted} payouts since ${result.since}`);
      }
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      throw err;
    }
  }

  // Storefront funnel + customer mix from ShopifyQL. Cheap -- two aggregated
  // queries returning one row per day -- and it is what the Week over Week
  // conversion funnel and returning-customer rate read.
  if (!SKIP_SESSIONS && (SYNC_MODE === 'incremental' || SYNC_MODE === 'full')) {
    const jobId = await startJob(connection, 'sessions_sync');
    try {
      const result = await runSessionsSync(supabase, connection, {
        batchId: BATCH_ID,
        sinceDays: SESSIONS_DAYS,
      });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      if (result.skipped) {
        console.log(`[skip] ${connection.shop_domain} sessions_sync: ${result.missing?.join(',')}`);
      } else {
        console.log(
          `[ok] ${connection.shop_domain} sessions_sync: ${result.sessions_rows_upserted} session days, ` +
          `${result.customer_rows_upserted} customer days, earliest ${result.earliest_day_returned || 'n/a'}`,
        );
      }
    } catch (err) {
      // Analytics is a nice-to-have next to sales and inventory. A ShopifyQL
      // failure should not take the whole nightly run down with it.
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      console.warn(`[warn] ${connection.shop_domain} sessions_sync failed: ${err.message || err}`);
    }
  }

  if (!SKIP_LANDING_PAGES && (SYNC_MODE === 'incremental' || SYNC_MODE === 'full')) {
    const jobId = await startJob(connection, 'landing_pages_sync');
    try {
      const result = await runLandingPagesSync(supabase, connection, {
        batchId: BATCH_ID,
        sinceDays: LANDING_PAGES_DAYS,
      });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      console.log(
        `[ok] ${connection.shop_domain} landing_pages_sync: ${result.rows_upserted} rows, ` +
        `${result.distinct_paths} paths` +
        (result.days_hitting_top_n ? `, ${result.days_hitting_top_n} day(s) hit the top-${result.top_n} cap` : ''),
      );
    } catch (err) {
      // Same stance as sessions: analytics must not take down sales sync.
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      console.warn(`[warn] ${connection.shop_domain} landing_pages_sync failed: ${err.message || err}`);
    }
  }

  if (!SKIP_DRAFT_ORDERS && (SYNC_MODE === 'incremental' || SYNC_MODE === 'full')) {
    const jobId = await startJob(connection, 'draft_orders_sync');
    try {
      const result = await runDraftOrdersSync(supabase, connection, { batchId: BATCH_ID, daysBack: DAYS_BACK });
      if (result.last_draft_order_sync_at) {
        const meta = { ...(connection.meta || {}), last_draft_order_sync_at: result.last_draft_order_sync_at };
        const { error: metaErr } = await supabase.from('shopify_connections').update({ meta }).eq('id', connection.id);
        if (metaErr) throw new Error(`meta update failed: ${metaErr.message}`);
        connection.meta = meta;
      }
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      if (result.skipped) {
        console.log(`[skip] ${connection.shop_domain} draft_orders_sync: missing scopes ${result.missing?.join(',')}`);
      } else {
        console.log(`[ok] ${connection.shop_domain} draft_orders_sync: ${result.draft_orders_upserted} drafts`);
      }
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

  if (!SKIP_CATALOG && (SYNC_MODE === 'incremental' || SYNC_MODE === 'full')) {
    const jobId = await startJob(connection, 'catalog_sync');
    try {
      const result = await runCatalogSync(supabase, connection, { batchId: BATCH_ID });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      if (result.skipped) {
        console.log(`[skip] ${connection.shop_domain} catalog_sync: missing scopes ${result.missing?.join(',')}`);
      } else {
        console.log(`[ok] ${connection.shop_domain} catalog_sync: ${result.products_master_rows_upserted} SKUs`);
      }
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

    const { error: rollupError } = await supabase.rpc('refresh_sales_monthly_rollup_mv');
    if (rollupError) {
      hadError = true;
      console.error(`[error] monthly rollup mv refresh: ${rollupError.message}`);
    }

    // The retired Sheets sync used to refresh this after its inventory
    // import — with Shopify as the sole inventory source, it happens here.
    if (!SKIP_INVENTORY) {
      const { error: invMvError } = await supabase.rpc('refresh_inventory_current_mv');
      if (invMvError) {
        hadError = true;
        console.error(`[error] inventory mv refresh: ${invMvError.message}`);
      }
    }
  }

  console.log('[shopify-sync] done', JSON.stringify(allResults, null, 2));
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[shopify-sync] fatal', err);
  process.exit(1);
});
