// scripts/shopify-sync.mjs — nightly GHA orchestrator (incremental + optional windowed history).
// User-initiated backfill runs via edge function shopify-sync-run + Integrations UI.

import { createClient } from '@supabase/supabase-js';
import {
  connectionReadyForSync,
} from './lib/shopify-scopes.mjs';
import { buildSyncPlan, runOutcomeReport, shouldRecordSkippedJob } from './lib/sync-plan.mjs';
import { landingPagesProgress, landingPagesCoverage } from './lib/sync-reporting.mjs';
import {
  DEFAULT_CHUNK_DAYS,
  runCatalogSync,
  runDraftOrdersSync,
  runIncrementalSales,
  runInventorySnapshot,
  runPayoutsSync,
  runSessionsSync,
  runLandingPagesSync,
  runCollectionsSync,
  runShopDomainsSync,
  runDiscountCodesSync,
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
// The SHOPIFY_SKIP_* flags are no longer read individually here. Every stage
// gate goes through the plan (see PLAN below) so that turning a stage off
// produces a record instead of silence.
// 90 days keeps the nightly call small while re-stating recent history, since
// Shopify revises analytics for a few days after the fact. Raise it once (or
// run with SHOPIFY_SESSIONS_DAYS=365) to seed as much history as Shopify will
// serve -- how far back that goes is recorded per run as
// earliest_day_returned, and it decides when year-over-year becomes possible.
const SESSIONS_DAYS = Number(process.env.SHOPIFY_SESSIONS_DAYS || 90);
// Landing pages cost one ShopifyQL query PER DAY (see runLandingPagesSync for
// why it cannot be one wide window), so the default window is much shorter
// than sessions'. The weekly report needs two weeks; 30 gives margin.
const LANDING_PAGES_DAYS = Number(process.env.SHOPIFY_LANDING_PAGES_DAYS || 30);
// The collections registry: what pages exist, as opposed to what got
// traffic. Cheap relative to sales (one GraphQL page per 50 collections
// plus follow-ups only for collections with >250 products).
//
// OPT-IN, unlike its siblings, which are opt-OUT skips. It started that way
// because it had never run against live Shopify and a SKIP_ flag defaulting
// to false would have switched it on for the nightly, the catch-up AND the
// two-hourly refresh the moment it merged -- "we'll run it manually for one
// shop first" is not a plan if the code does not enforce it.
//
// It stays opt-in now that it IS enabled, because the workflow turns it on
// for the 08:30 nightly ONLY (see shopify-sync.yml). An opt-out flag would
// make "on everywhere" the default again the next time someone adds a cron.
// (The flag itself is now read by buildSyncPlan, as SYNC_STAGES' one enableEnv.)
const DISCOUNT_CODES_DAYS = Number(process.env.SHOPIFY_DISCOUNT_CODES_DAYS || 30);
const SKIP_SUMMARY_REFRESH = process.env.SHOPIFY_SKIP_SUMMARY_REFRESH === 'true';

const BATCH_ID =
  process.env.SHOPIFY_SYNC_BATCH_ID ||
  `shopify-${new Date().toISOString().replace(/[:.]/g, '-')}`;

// What this run was ASKED to do. Every stage gate below reads this instead of
// re-deriving `!SKIP_X && mode-is-right` at the point of use, so that a stage
// which does not run leaves the same trail as one that does. See
// scripts/lib/sync-plan.mjs for why (short version: a manual backfill once
// finished green having written nothing, because a skipped stage produced no
// record of any kind).
const PLAN = buildSyncPlan(process.env);
const STAGES = new Map(PLAN.stages.map((s) => [s.jobType, s]));
const stageEnabled = (jobType) => STAGES.get(jobType)?.enabled === true;

// Every stage outcome across every connection, for the exit-code decision.
const OUTCOMES = [];
const record = (connection, jobType, state, detail = null) => {
  OUTCOMES.push({
    shopDomain: connection?.shop_domain ?? null,
    jobType,
    state,
    requested: STAGES.get(jobType)?.requested ?? true,
    detail,
  });
};

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
  // `result` is written whatever the status, which it was not before. A stage
  // that fetched 100 days and then hit a rate limit HAS 100 days in the
  // table; if the only record of a failed run is an error string, the next
  // person cannot tell that from a run that wrote nothing, and the safe
  // assumption ("nothing was written") is the wrong one -- it invites a
  // pointless re-run of work already done.
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) update.result = payload;
  // 'skipped' is not an error and must not populate `error` -- the reason it
  // did not run lives in `result`, and writing it here too would make a
  // deliberate skip indistinguishable from a failure in every error report.
  if (status !== 'success' && status !== 'skipped') {
    update.error = String(
      payload?.error || payload?.failure?.message || payload?.reason || payload,
    ).slice(0, 2000);
  }
  await supabase.from('sync_jobs').update(update).eq('id', jobId);
}

/** Finish a stage that ran but declined to do anything, because the store has
 * not granted the Shopify scope it needs.
 *
 * Recorded as 'skipped', NOT 'success'. It was 'success' until review caught
 * it, and that is the same misleading green as run #354 wearing a different
 * hat: the row said the stage succeeded, when what happened is that it did
 * nothing and said why in a field nobody reads. A stage that returns no data
 * is not a stage that succeeded.
 */
async function finishScopeSkipped(jobId, connection, jobType, result) {
  const missing = result.missing?.join(', ') || result.reason || 'unknown';
  await finishJob(jobId, 'skipped', {
    ...result,
    reason: `missing Shopify scope(s): ${missing}`,
    scope_skipped: true,
  });
  record(connection, jobType, 'scope_skipped', `missing Shopify scope(s): ${missing}`);
  console.log(`[skip] ${connection.shop_domain} ${jobType}: missing scope(s) ${missing}`);
}

/** Record a stage that was NOT run, and why.
 *
 * This is the whole point of the 2026-09-09 fix: a step that does not run has
 * to leave the same kind of trace as one that does, or "the backfill didn't
 * happen" and "the backfill happened and found nothing" are indistinguishable
 * from outside.
 *
 * Only on manual runs, and only for stages gated by their own flag. A
 * scheduled light refresh turns four stages off by design twelve times a day
 * across every connection -- writing that down would add ~900 rows a day
 * saying nothing, and bury the rows that mean something. A contradiction is
 * always recorded, whoever triggered it.
 */
async function recordSkippedJob(connection, stage) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('sync_jobs').insert({
    company_entity_id: connection.company_entity_id,
    connection_id: connection.id,
    job_type: stage.jobType,
    status: 'skipped',
    started_at: now,
    finished_at: now,
    result: {
      skipped: true,
      reason: stage.skipReason,
      requested: stage.requested,
      contradiction: stage.contradiction,
      parameter_supplied: stage.parameterSupplied
        ? { env: stage.daysEnv, value: stage.parameterValue }
        : null,
      sync_mode: PLAN.mode,
      run_kind: PLAN.manual ? 'manual' : 'scheduled',
      batch_id: BATCH_ID,
    },
  });
  // A failure to record the skip must not be silent either -- that would
  // reintroduce the exact invisibility this function exists to remove.
  if (error) console.warn(`[warn] ${connection.shop_domain} could not record skipped ${stage.jobType}: ${error.message}`);
}

/** Announce and (where it matters) persist every stage this run will not do. */
async function reportSkippedStages(connection) {
  for (const stage of PLAN.stages) {
    if (stage.enabled) continue;
    record(connection, stage.jobType, 'skipped', stage.skipReason);

    const line = `${connection.shop_domain} ${stage.jobType}: ${stage.skipReason}`;
    if (stage.contradiction) console.warn(`[warn] NOT RUN — ${line}`);
    else console.log(`[skip] ${line}`);

    if (shouldRecordSkippedJob(stage, { manual: PLAN.manual })) {
      await recordSkippedJob(connection, stage);
    }
  }
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

  // Before anything runs, say what will not run and why.
  await reportSkippedStages(connection);

  if (stageEnabled('history_import')) {
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
      record(connection, 'history_import', 'success');
      console.log(`[ok] ${connection.shop_domain} history_import: ${result.sales_rows_total} sales rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'history_import', 'error', err.message || String(err));
      throw err;
    }
  }

  if (stageEnabled('incremental_sales')) {
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
      record(connection, 'incremental_sales', 'success');
      console.log(`[ok] ${connection.shop_domain} incremental_sales: ${result.sales_rows_upserted} rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'incremental_sales', 'error', err.message || String(err));
      throw err;
    }
  }

  if (stageEnabled('payouts_sync')) {
    const jobId = await startJob(connection, 'payouts_sync');
    try {
      const result = await runPayoutsSync(supabase, connection, { batchId: BATCH_ID });
      results.jobs.push(result);
      if (result.skipped) {
        await finishScopeSkipped(jobId, connection, 'payouts_sync', result);
      } else {
        await finishJob(jobId, 'success', result);
        record(connection, 'payouts_sync', 'success');
        console.log(`[ok] ${connection.shop_domain} payouts_sync: ${result.payouts_upserted} payouts since ${result.since}`);
      }
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'payouts_sync', 'error', err.message || String(err));
      throw err;
    }
  }

  // Storefront funnel + customer mix from ShopifyQL. Cheap -- two aggregated
  // queries returning one row per day -- and it is what the Week over Week
  // conversion funnel and returning-customer rate read.
  if (stageEnabled('sessions_sync')) {
    const jobId = await startJob(connection, 'sessions_sync');
    try {
      const result = await runSessionsSync(supabase, connection, {
        batchId: BATCH_ID,
        sinceDays: SESSIONS_DAYS,
      });
      results.jobs.push(result);
      if (result.skipped) {
        await finishScopeSkipped(jobId, connection, 'sessions_sync', result);
      } else {
        await finishJob(jobId, 'success', result);
        record(connection, 'sessions_sync', 'success');
        console.log(
          `[ok] ${connection.shop_domain} sessions_sync: ${result.sessions_rows_upserted} session days, ` +
          `${result.customer_rows_upserted} customer days, earliest ${result.earliest_day_returned || 'n/a'}`,
        );
      }
    } catch (err) {
      // Analytics is a nice-to-have next to sales and inventory, so this does
      // not throw: a ShopifyQL wobble must not take the nightly's sales sync
      // down with it. On a MANUAL run the recorded outcome still fails the
      // workflow at the end -- see runOutcomeReport. Non-fatal here means
      // "keep going", not "pretend it worked".
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'sessions_sync', 'error', err.message || String(err));
      console.warn(`[warn] ${connection.shop_domain} sessions_sync failed: ${err.message || err}`);
    }
  }

  if (stageEnabled('landing_pages_sync')) {
    const jobId = await startJob(connection, 'landing_pages_sync');
    try {
      const result = await runLandingPagesSync(supabase, connection, {
        batchId: BATCH_ID,
        sinceDays: LANDING_PAGES_DAYS,
        // A 730-day window is ~12 minutes of per-day queries plus whatever
        // backoff it takes. Without this the run looks hung.
        //
        // Built by a factory rather than written inline HERE, on purpose: the
        // inline version referenced `result` -- the very const it was an
        // initializer argument to -- and threw a temporal-dead-zone
        // ReferenceError on the first sweep failure, inside the day loop's
        // try, aborting the rest of the backfill. See sync-reporting.mjs.
        onProgress: landingPagesProgress({ shopDomain: connection.shop_domain }),
      });
      const coverage = landingPagesCoverage(result);

      // A window that did not complete is recorded as an ERROR carrying its
      // real progress, never as a success. The rows it wrote are good and are
      // kept; what is not true is that the backfill happened.
      results.jobs.push(result);
      if (result.complete) {
        await finishJob(jobId, 'success', result);
        record(connection, 'landing_pages_sync', 'success');
        console.log(`[ok] ${connection.shop_domain} landing_pages_sync: ${coverage}`);
      } else {
        await finishJob(jobId, 'error', result);
        record(connection, 'landing_pages_sync', 'partial',
          `kept ${coverage}; stopped at ${result.failure?.day} — ${result.failure?.message}`);
        console.warn(
          `[warn] ${connection.shop_domain} landing_pages_sync INCOMPLETE: kept ${coverage}; ` +
          `stopped at ${result.failure?.day}: ${result.failure?.message}`,
        );
      }
    } catch (err) {
      // Same stance as sessions: analytics must not take down sales sync.
      // runLandingPagesSync catches its own per-day failures, so reaching here
      // means something outside the day loop broke.
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'landing_pages_sync', 'error', err.message || String(err));
      console.warn(`[warn] ${connection.shop_domain} landing_pages_sync failed: ${err.message || err}`);
    }
  }

  if (SYNC_MODE === 'incremental' || SYNC_MODE === 'full') {
    // One request, and it is what authorises page-inspect to fetch anything at
    // all. Deliberately NOT wrapped in a sync_jobs row: it needs no job_type
    // CHECK extension, and its own failure is already non-fatal — a shop whose
    // domains we cannot read simply has no inspectable pages, which is the
    // correct outcome rather than an error worth a job record.
    try {
      const result = await runShopDomainsSync(supabase, connection);
      if (result.skipped) {
        console.warn(`[warn] ${connection.shop_domain} shop_domains: ${result.error}`);
      } else if (result.sweep_error) {
        // The upsert succeeding and the sweep failing is the dangerous
        // combination, and it is the one that used to be reported as success:
        // new hosts are authorised while retired ones stay authorised too, so
        // a domain that was sold or transferred keeps its permission to be
        // fetched, indefinitely and invisibly. Never log this as [ok].
        console.warn(
          `[warn] ${connection.shop_domain} shop_domains: hosts written (${result.hosts.join(', ')}) ` +
          `but RETIREMENT FAILED (${result.sweep_error}) — stale domains may still be authorised for page-inspect`,
        );
      } else {
        const retired = (result.hosts_retired || []).length
          ? `, retired ${result.hosts_retired.join(', ')}`
          : '';
        console.log(`[ok] ${connection.shop_domain} shop_domains: ${result.hosts.join(', ')}${retired}`);
      }
    } catch (err) {
      console.warn(`[warn] ${connection.shop_domain} shop_domains failed: ${err.message || err}`);
    }
  }

  if (stageEnabled('collections_sync')) {
    const jobId = await startJob(connection, 'collections_sync');
    try {
      const result = await runCollectionsSync(supabase, connection, { batchId: BATCH_ID });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      record(connection, 'collections_sync', 'success');
      console.log(
        `[ok] ${connection.shop_domain} collections_sync: ${result.collections_seen} collections, ` +
        `${result.memberships_seen} memberships, ${result.pages_fetched} pages` +
        (result.publication_resolved ? '' : ` — publication UNKNOWN (${result.publication_error})`),
      );
    } catch (err) {
      // Same stance as sessions/landing pages: the registry must not take
      // down sales sync. A failed run leaves completed_at null, so nothing
      // downstream will read the partial fetch as a set of deletions.
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'collections_sync', 'error', err.message || String(err));
      console.warn(`[warn] ${connection.shop_domain} collections_sync failed: ${err.message || err}`);
    }
  }

  if (stageEnabled('discount_codes_sync')) {
    const jobId = await startJob(connection, 'discount_codes_sync');
    try {
      const result = await runDiscountCodesSync(supabase, connection, {
        batchId: BATCH_ID,
        sinceDays: DISCOUNT_CODES_DAYS,
      });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      record(connection, 'discount_codes_sync', 'success');
      console.log(
        `[ok] ${connection.shop_domain} discount_codes_sync: ${result.rows_upserted} rows, ` +
        `${result.distinct_codes} codes`,
      );
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'discount_codes_sync', 'error', err.message || String(err));
      console.warn(`[warn] ${connection.shop_domain} discount_codes_sync failed: ${err.message || err}`);
    }
  }

  if (stageEnabled('draft_orders_sync')) {
    const jobId = await startJob(connection, 'draft_orders_sync');
    try {
      const result = await runDraftOrdersSync(supabase, connection, { batchId: BATCH_ID, daysBack: DAYS_BACK });
      if (result.last_draft_order_sync_at) {
        const meta = { ...(connection.meta || {}), last_draft_order_sync_at: result.last_draft_order_sync_at };
        const { error: metaErr } = await supabase.from('shopify_connections').update({ meta }).eq('id', connection.id);
        if (metaErr) throw new Error(`meta update failed: ${metaErr.message}`);
        connection.meta = meta;
      }
      results.jobs.push(result);
      if (result.skipped) {
        await finishScopeSkipped(jobId, connection, 'draft_orders_sync', result);
      } else {
        await finishJob(jobId, 'success', result);
        record(connection, 'draft_orders_sync', 'success');
        console.log(`[ok] ${connection.shop_domain} draft_orders_sync: ${result.draft_orders_upserted} drafts`);
      }
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'draft_orders_sync', 'error', err.message || String(err));
      throw err;
    }
  }

  if (stageEnabled('inventory_snapshot')) {
    const jobId = await startJob(connection, 'inventory_snapshot');
    try {
      const result = await runInventorySnapshot(supabase, connection, { batchId: BATCH_ID });
      await finishJob(jobId, 'success', result);
      results.jobs.push(result);
      record(connection, 'inventory_snapshot', 'success');
      console.log(`[ok] ${connection.shop_domain} inventory_snapshot: ${result.inventory_rows_upserted} rows`);
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'inventory_snapshot', 'error', err.message || String(err));
      throw err;
    }
  }

  if (stageEnabled('catalog_sync')) {
    const jobId = await startJob(connection, 'catalog_sync');
    try {
      const result = await runCatalogSync(supabase, connection, { batchId: BATCH_ID });
      results.jobs.push(result);
      if (result.skipped) {
        await finishScopeSkipped(jobId, connection, 'catalog_sync', result);
      } else {
        await finishJob(jobId, 'success', result);
        record(connection, 'catalog_sync', 'success');
        console.log(`[ok] ${connection.shop_domain} catalog_sync: ${result.products_master_rows_upserted} SKUs`);
      }
    } catch (err) {
      await finishJob(jobId, 'error', { error: err.message || String(err) });
      record(connection, 'catalog_sync', 'error', err.message || String(err));
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
  console.log(`[shopify-sync] mode=${SYNC_MODE} batch=${BATCH_ID} trigger=${PLAN.manual ? 'manual' : 'scheduled'}`);
  // Print the plan up front. A reader of the log should be able to see what
  // this run intends to do before it does any of it, rather than inferring
  // it afterwards from which [ok] lines happen to be present -- which is
  // exactly what could not be done for run #354.
  console.log('[shopify-sync] plan: ' + PLAN.stages
    .map((s) => `${s.jobType}=${s.enabled ? 'run' : (s.contradiction ? 'SKIP(contradictory)' : 'skip')}`)
    .join(' '));
  const contradictions = PLAN.stages.filter((s) => s.contradiction);
  for (const s of contradictions) {
    console.warn(`[warn] contradictory inputs — ${s.skipReason}`);
  }

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

    // Week over Week reads its sales figures from this rollup rather than from
    // sales_by_day directly -- 137k rows against 1.14M. Without the refresh the
    // report silently reports yesterday's numbers, so a failure here is a real
    // error, not a warning.
    const { error: wowRollupError } = await supabase.rpc('refresh_wow_sales_daily_mv');
    if (wowRollupError) {
      hadError = true;
      console.error(`[error] wow sales daily mv refresh: ${wowRollupError.message}`);
    }

    // The product-title rollup. Materialized 20260907120000 because the
    // unbounded reads over it (max(day_date) inside the Top products report,
    // an open-ended date_from on the Logistics tile) had to build the whole
    // 700k-group rollup to answer -- 6.9s before a single displayed row.
    // Without this refresh those tiles report the previous sync's numbers, so
    // a failure here is a real error, not a warning.
    const { error: titleRollupError } = await supabase.rpc('refresh_sales_by_product_title_mv');
    if (titleRollupError) {
      hadError = true;
      console.error(`[error] product title mv refresh: ${titleRollupError.message}`);
    }

    // The retired Sheets sync used to refresh this after its inventory
    // import — with Shopify as the sole inventory source, it happens here.
    if (stageEnabled('inventory_snapshot')) {
      const { error: invMvError } = await supabase.rpc('refresh_inventory_current_mv');
      if (invMvError) {
        hadError = true;
        console.error(`[error] inventory mv refresh: ${invMvError.message}`);
      }
    }

    // Demand coverage is derived from the sales rollup and the inventory
    // snapshot, so it refreshes LAST -- refreshing it before those two would
    // rebuild it from yesterday's numbers and it would be a day stale until
    // the next run. It backs seven Logistics dashboard tiles.
    const { error: coverageMvError } = await supabase.rpc('refresh_demand_coverage_base_mv');
    if (coverageMvError) {
      hadError = true;
      console.error(`[error] demand coverage mv refresh: ${coverageMvError.message}`);
    }
  }

  console.log('[shopify-sync] done', JSON.stringify(allResults, null, 2));

  // The judgement, kept separate from the work.
  //
  // A manual backfill exists FOR a particular stage, so a requested stage
  // that errored, stopped short of its window, or was never run fails the
  // run -- otherwise a green tick says the backfill happened when it did not,
  // and the only remaining way to find out is to query the tables by hand.
  //
  // A scheduled run keeps the existing non-fatal policy: a nightly that
  // synced every sale should not go red because ShopifyQL rate-limited the
  // analytics stage, and a nightly that is routinely red is a nightly nobody
  // reads. sales-freshness-check.yml is the alarm for the feeds that truly
  // cannot lapse.
  const outcome = runOutcomeReport({ manual: PLAN.manual, outcomes: OUTCOMES });
  if (outcome.summary) {
    console.warn(`[shopify-sync] ${outcome.summary}`);
  }
  if (hadError || outcome.exitCode) process.exit(1);
}

main().catch((err) => {
  console.error('[shopify-sync] fatal', err);
  process.exit(1);
});
