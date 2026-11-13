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

// Where each integration's connection row lives, and what the runner has to
// prove about it before spending anybody's API quota:
//
//   by            the column the job's id matches
//   platform      for the shared ad_platform_connections table, the value
//                 `platform` must hold for this integration
//   syncFlag      true where the table HAS sync_enabled (redo does not), so
//                 switching sync off between queueing and draining stops the
//                 import rather than being ignored
//
// Every read is also filtered by the job's company. connection_id carries no
// foreign key (the target table differs per integration), so the queue cannot
// refuse a well-formed id belonging to somebody else: an admin of company A
// may insert a job of their own company naming company B's store. Filtering
// the load by company_entity_id is what makes that job unplannable instead of
// a sync of B's store, and it is the tenant boundary on this whole path.
const CONNECTION_SOURCES = {
  shopify: {
    table: 'shopify_connections', by: 'id', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, shop_domain',
  },
  google_ads: {
    table: 'ad_platform_connections', by: 'id', platform: 'google_ads', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, platform',
  },
  ga4: {
    table: 'ad_platform_connections', by: 'id', platform: 'ga4', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, platform',
  },
  meta_ads: {
    table: 'ad_platform_connections', by: 'id', platform: 'meta_ads', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, platform',
  },
  tiktok_ads: {
    table: 'ad_platform_connections', by: 'id', platform: 'tiktok_ads', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, platform',
  },
  search_console: {
    table: 'ad_platform_connections', by: 'id', platform: 'search_console', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, platform',
  },
  redo: {
    table: 'redo_connections', by: 'company_entity_id', syncFlag: false,
    select: 'id, is_active, company_entity_id, api_secret',
  },
  // One row per company, like Redo. syncFlag is true because Klaviyo's own
  // sync reads only connections with sync_enabled: without it the backfill
  // would run, find nothing and be recorded `done` having imported nothing.
  // Enabling sync in Integrations is what queues (or requeues) this job.
  klaviyo: {
    table: 'klaviyo_connections', by: 'company_entity_id', syncFlag: true,
    select: 'id, is_active, sync_enabled, company_entity_id, api_key, access_token, refresh_token',
  },
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
    let q = db.from(src.table).select(src.select).eq(src.by, key);
    // The company filter, always, even when the id alone would find the row:
    // see CONNECTION_SOURCES. A job naming another tenant's connection reads
    // as not found and is cancelled.
    if (src.by !== 'company_entity_id') q = q.eq('company_entity_id', job.company_entity_id);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`Could not read ${src.table}: ${error.message}`);
    return { found: !!data, row: data || null, src };
  }

  // attempts is incremented atomically by claim and serves as the ownership
  // generation. An expired owner cannot renew or overwrite its successor,
  // even when both processes still hold the same job id.
  async function patchJob(job, patch, { onlyWhileRunning = false } = {}) {
    let q = db
      .from('integration_bootstrap_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('attempts', job.attempts)
      .eq('status', 'running')
      .gt('lease_until', new Date().toISOString());
    const { data, error } = await q.select('id');
    if (error || !data?.length) throw new Error(`Bootstrap lease lost for ${job.id}; no further stages may run`);
  }

  function startLeaseRenewal(job, controller) {
    const everyMs = Math.max(30_000, Math.floor((leaseSeconds * 1000) / 3));
    let renewing = false;
    const timer = setInterval(async () => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      try {
        await patchJob(job, {
          lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
        });
      } catch (error) { controller.abort(error); }
      finally { renewing = false; }
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
      await patchJob(job, { last_error: err.message, lease_until: null });
      log.error(`[bootstrap] ${label}: ${err.message}`);
      return { job, status: 'error' };
    }

    // Everything that means "do not run this job", each a cancellation rather
    // than an error, because none of them gets better by retrying:
    //   * the connection was deleted, or belongs to another company (the read
    //     above is company-filtered, so both read as not found);
    //   * it was switched off, or its API sync was turned off, between
    //     queueing and now -- the cron is late often enough for that to be a
    //     real gap, and running anyway would override somebody's decision;
    //   * the row is not the integration the job says it is, which no honest
    //     enqueue produces.
    const why = (() => {
      if (!conn.found) return 'connection no longer exists, or does not belong to this company';
      if (conn.row?.is_active === false) return 'connection is inactive';
      // `!== true` rather than `=== false`: the column is selected for every
      // source that has it, so anything but a plain true (false, or a null
      // nobody expected) means nobody has said yes to syncing this one.
      if (conn.src?.syncFlag && conn.row?.sync_enabled !== true) return 'API sync is switched off for this connection';
      if (conn.src?.platform && conn.row?.platform !== conn.src.platform) {
        return `connection is ${conn.row?.platform || 'unknown'}, not ${job.integration}`;
      }
      return null;
    })();
    if (why) {
      await patchJob(job, {
        status: 'cancelled',
        lease_until: null,
        finished_at: new Date().toISOString(),
        last_error: why,
      });
      log.log(`[bootstrap] ${label}: ${why}, job cancelled`);
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
        await patchJob(job, {
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
      await patchJob(job, {
        status: 'error',
        lease_until: null,
        finished_at: new Date().toISOString(),
        last_error: err.message,
      });
      log.error(`[bootstrap] ${label}: ${err.message}`);
      return { job, status: 'error' };
    }

    const owed = pendingStages(job, planned);
    // Discard obsolete plan keys (e.g. Meta's former single kpis stage).
    let stages = Object.fromEntries(Object.entries(job.stages || {}).filter(([key]) => planned.some((s) => s.stage === key)));
    if (!owed.length) {
      await patchJob(job, {
        status: bootstrapOutcome(stages) === 'error' ? 'error' : 'done',
        lease_until: null,
        finished_at: new Date().toISOString(),
      });
      log.log(`[bootstrap] ${label}: nothing owed`);
      return { job, status: 'done' };
    }

    log.log(`[bootstrap] ${label}: ${owed.length} stage(s) owed of ${planned.length}`);
    const controller = new AbortController();
    const stopRenewal = startLeaseRenewal(job, controller);
    try {
      for (const stage of owed) {
        controller.signal.throwIfAborted();
        if (stage.skip) {
          stages = withStageResult(stages, stage.stage, 'skipped', stage.skip);
          await patchJob(job, { stages });
          log.log(`[bootstrap] ${label}: ${stage.stage} skipped (${stage.skip})`);
          continue;
        }
        stages = withStageResult(stages, stage.stage, 'running', null);
        await patchJob(job, { stages });
        const started = Date.now();
        const res = await runStage(stage, stage.env, controller.signal);
        controller.signal.throwIfAborted();
        if (res.deferred) {
          stages = withStageResult(stages, stage.stage, 'pending', res.detail);
          await patchJob(job, { stages, status: 'pending', deferrals: (job.deferrals || 0) + 1,
            last_error: null, lease_until: new Date(Date.now() + 15 * 60_000).toISOString() });
          return { job, status: 'pending', deferred: true };
        }
        const secs = Math.round((Date.now() - started) / 1000);
        stages = withStageResult(
          stages,
          stage.stage,
          res.ok ? 'done' : 'error',
          res.ok ? `${secs}s` : res.detail,
        );
        await patchJob(job, { stages, ...(res.ok ? {} : { last_error: `${stage.stage}: ${res.detail}` }) });
        log.log(`[bootstrap] ${label}: ${stage.stage} ${res.ok ? 'done' : 'FAILED'} in ${secs}s${res.ok ? '' : ` -- ${res.detail}`}`);
        // Stages are independent on purpose: a ShopifyQL wobble in the
        // analytics stage must not cost the store its stock levels. The outcome
        // below is what says the job was not wholly successful.
      }
    } finally {
      stopRenewal();
    }

    const outcome = bootstrapOutcome(stages);
    const settled = outcome === 'done' || job.attempts - (job.deferrals || 0) >= maxAttempts;
    await patchJob(job, {
      stages,
      // Not settled means there is an errored stage and attempts left: the row
      // goes back to pending (lease cleared) so the next run retries only the
      // stages that failed, since the successful ones are recorded done.
      status: settled ? outcome : 'pending',
      ...(outcome === 'done' ? { last_error: null } : {}),
      lease_until: settled ? null : new Date(Date.now() + 15 * 60_000).toISOString(),
      ...(settled ? { finished_at: new Date().toISOString() } : {}),
    }, { onlyWhileRunning: true });
    log.log(`[bootstrap] ${label}: ${settled ? outcome : 'pending (will retry)'} after attempt ${job.attempts}`);
    return { job, status: settled ? outcome : 'pending' };
  }

  return { runJob, loadConnection, patchJob };
}
