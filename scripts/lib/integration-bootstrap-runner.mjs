// scripts/lib/integration-bootstrap-runner.mjs -- running ONE first-connect
// bootstrap job: what it does to the queue row, in which order, and what it
// refuses to do.
//
// WHY THIS IS A MODULE AND NOT PART OF THE SCRIPT. The script
// (scripts/integration-bootstrap.mjs) owns the outside world: the env, the
// Supabase client, spawning child processes, the exit code. Everything that
// is a DECISION about a job lives here behind two injected dependencies --
// `db` and `runStage` -- so the cases that matter can be driven in a test:
// a connection deleted after the job was queued, a connection that had
// already synced, a stage that fails, a job somebody cancels from the page
// while a stage is running, and a resumed job that must not re-run what
// already landed. None of those are reachable through the real script
// without a Shopify store and a 20-minute wait.

import {
  planBootstrap,
  pendingStages,
  bootstrapOutcome,
  withStageResult,
} from './integration-bootstrap-core.mjs';

// Where each integration's connection row lives. Used for two things only:
// deciding whether a stage's prerequisites are met (Redo's api_secret), and
// noticing that the connection has been deleted since the job was queued --
// which is a cancelled job, not an error to retry.
const CONNECTION_SOURCES = {
  shopify: { table: 'shopify_connections', by: 'id', select: 'id, is_active, shop_domain' },
  google_ads: { table: 'ad_platform_connections', by: 'id', select: 'id, is_active, platform' },
  ga4: { table: 'ad_platform_connections', by: 'id', select: 'id, is_active, platform' },
  meta_ads: { table: 'ad_platform_connections', by: 'id', select: 'id, is_active, platform' },
  tiktok_ads: { table: 'ad_platform_connections', by: 'id', select: 'id, is_active, platform' },
  search_console: { table: 'ad_platform_connections', by: 'id', select: 'id, is_active, platform' },
  redo: { table: 'redo_connections', by: 'company_entity_id', select: 'id, is_active, api_secret' },
};

/** One job runner bound to a database and a way to run a stage.
 *
 * `runStage(stage, env) -> { ok, detail }` is the only thing that touches a
 * child process; the test passes a function that records the call and answers
 * however the case needs.
 */
export function createRunner({
  db,
  runStage,
  maxAttempts = 5,
  leaseSeconds = 900,
  log = console,
}) {
  async function loadConnection(job) {
    const src = CONNECTION_SOURCES[job.integration];
    if (!src) return { found: false, row: null };
    const key = src.by === 'id' ? job.connection_id : job.company_entity_id;
    if (!key) return { found: false, row: null };
    const { data, error } = await db
      .from(src.table)
      .select(src.select)
      .eq(src.by, key)
      .maybeSingle();
    if (error) throw new Error(`Could not read ${src.table}: ${error.message}`);
    return { found: !!data, row: data || null };
  }

  /** Update the row the drainer holds.
   *
   * `onlyWhileRunning` is for the writes that END a job: somebody may have
   * cancelled it from the Integrations page while a stage was running, and a
   * terminal status written over that would resurrect work the person asked to
   * stop. Those writes therefore match on `status = 'running'` as well, and a
   * zero-row result is the cancellation standing.
   */
  async function patchJob(id, patch, { onlyWhileRunning = false } = {}) {
    let q = db
      .from('integration_bootstrap_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (onlyWhileRunning) q = q.eq('status', 'running');
    const { error } = await q;
    // A failed write here is worth saying out loud but is not worth abandoning
    // the stage that already ran: the next attempt re-reads the row and the
    // stage records are idempotent.
    if (error) log.error(`[bootstrap] Could not update job ${id}: ${error.message}`);
  }

  /** Push the lease out while a stage is still running.
   *
   * Without this a stage longer than the lease (a 60-day order history can be)
   * becomes claimable by the next drainer while this one is still working, and
   * both would then spend the same API calls. The renewal is deliberately
   * unconditional on status: this drainer holds the row, and the only thing
   * that should take it away is this process dying.
   */
  function startLeaseRenewal(id) {
    const everyMs = Math.max(30_000, Math.floor((leaseSeconds * 1000) / 3));
    const timer = setInterval(() => {
      patchJob(id, {
        lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      }).catch(() => {});
    }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function runJob(job) {
    const label = `${job.integration}${job.connection_id ? ` ${job.connection_id.slice(0, 8)}` : ''}`;
    let conn;
    try {
      conn = await loadConnection(job);
    } catch (err) {
      await patchJob(job.id, { last_error: err.message, lease_until: null });
      log.error(`[bootstrap] ${label}: ${err.message}`);
      return { job, status: 'error' };
    }

    // The connection was deleted, or switched off, between queueing and now.
    // Neither is a failure of this job and neither should be retried: the row
    // is closed as cancelled so the page can say so.
    if (!conn.found || conn.row?.is_active === false) {
      await patchJob(job.id, {
        status: 'cancelled',
        lease_until: null,
        finished_at: new Date().toISOString(),
        last_error: conn.found ? 'connection is inactive' : 'connection no longer exists',
      });
      log.log(`[bootstrap] ${label}: connection gone or inactive, job cancelled`);
      return { job, status: 'cancelled' };
    }

    // A first sync is for a connection that has never synced. A job queued for
    // one that already has (a hand-inserted row, or a Test pressed on a store
    // that predates this feature) would re-fetch a 60-day history for nothing,
    // so it is cancelled with the reason rather than run. Only rows written
    // BEFORE this job was queued count -- a resumed job's own stages write
    // sync_jobs rows too.
    //
    // In practice this guard bites on SHOPIFY, which is also where it matters:
    // measured on production 2026-10-13, every Shopify sync_jobs row carries
    // connection_id (10,498 of 10,498 incremental_sales) while the ad, Search
    // Console and Redo syncs write it as NULL, so for those the browser's own
    // one-job-per-connection check is what prevents a repeat. Do not "fix"
    // that here by matching on company and job_type: a company-wide match
    // would cancel the first sync of its SECOND ad account.
    if (job.connection_id) {
      const { data: prior, error: priorErr } = await db
        .from('sync_jobs')
        .select('id')
        .eq('connection_id', job.connection_id)
        .neq('job_type', 'test_connection')
        .lt('created_at', job.created_at)
        .limit(1);
      if (!priorErr && (prior || []).length) {
        await patchJob(job.id, {
          status: 'cancelled',
          lease_until: null,
          finished_at: new Date().toISOString(),
          last_error: 'this connection had already synced before the job was queued; use Sync now for a refresh',
        }, { onlyWhileRunning: true });
        log.log(`[bootstrap] ${label}: connection already had sync history, job cancelled`);
        return { job, status: 'cancelled' };
      }
    }

    let planned;
    try {
      planned = planBootstrap(job, { connection: conn.row });
    } catch (err) {
      // A job we cannot plan is a job no drainer will ever do. Recording it as
      // an error with the reason beats leaving it pending for ever.
      await patchJob(job.id, {
        status: 'error',
        lease_until: null,
        finished_at: new Date().toISOString(),
        last_error: err.message,
      });
      log.error(`[bootstrap] ${label}: ${err.message}`);
      return { job, status: 'error' };
    }

    const owed = pendingStages(job, planned);
    let stages = job.stages || {};
    if (!owed.length) {
      await patchJob(job.id, {
        status: bootstrapOutcome(stages) === 'error' ? 'error' : 'done',
        lease_until: null,
        finished_at: new Date().toISOString(),
      });
      log.log(`[bootstrap] ${label}: nothing owed`);
      return { job, status: 'done' };
    }

    log.log(`[bootstrap] ${label}: ${owed.length} stage(s) owed of ${planned.length}`);
    const stopRenewal = startLeaseRenewal(job.id);
    try {
      for (const stage of owed) {
        if (stage.skip) {
          stages = withStageResult(stages, stage.stage, 'skipped', stage.skip);
          await patchJob(job.id, { stages });
          log.log(`[bootstrap] ${label}: ${stage.stage} skipped (${stage.skip})`);
          continue;
        }
        stages = withStageResult(stages, stage.stage, 'running', null);
        await patchJob(job.id, { stages });
        const started = Date.now();
        const res = await runStage(stage, stage.env);
        const secs = Math.round((Date.now() - started) / 1000);
        stages = withStageResult(
          stages,
          stage.stage,
          res.ok ? 'done' : 'error',
          res.ok ? `${secs}s` : res.detail,
        );
        await patchJob(job.id, { stages, ...(res.ok ? {} : { last_error: `${stage.stage}: ${res.detail}` }) });
        log.log(`[bootstrap] ${label}: ${stage.stage} ${res.ok ? 'done' : 'FAILED'} in ${secs}s${res.ok ? '' : ` -- ${res.detail}`}`);
        // Stages are independent on purpose: a ShopifyQL wobble in the
        // analytics stage must not cost the store its stock levels. The outcome
        // below is what says the job was not wholly successful.
      }
    } finally {
      stopRenewal();
    }

    const outcome = bootstrapOutcome(stages);
    const settled = outcome === 'done' || job.attempts >= maxAttempts;
    await patchJob(job.id, {
      stages,
      // Not settled means there is an errored stage and attempts left: the row
      // goes back to pending (lease cleared) so the next run retries only the
      // stages that failed, since the successful ones are recorded done.
      status: settled ? outcome : 'pending',
      lease_until: null,
      ...(settled ? { finished_at: new Date().toISOString() } : {}),
    }, { onlyWhileRunning: true });
    log.log(`[bootstrap] ${label}: ${settled ? outcome : 'pending (will retry)'} after attempt ${job.attempts}`);
    return { job, status: settled ? outcome : 'pending' };
  }

  return { runJob, loadConnection, patchJob };
}
