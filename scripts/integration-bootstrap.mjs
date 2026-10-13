// scripts/integration-bootstrap.mjs -- drains integration_bootstrap_jobs:
// the first full sync of an integration somebody just connected, run on the
// server so it finishes whether or not they stay on the page.
//
// The plan and the judgement live in scripts/lib/integration-bootstrap-core.mjs
// (pure, tested). This file does the three things that need the outside
// world: claim rows under a lease, spawn each stage's real sync script, and
// keep the row honest about what happened.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY     -- required
//   BOOTSTRAP_MAX_JOBS       default 5    jobs claimed per run
//   BOOTSTRAP_LEASE_SECONDS  default 900  lease length, renewed while a stage runs
//   BOOTSTRAP_MAX_ATTEMPTS   default 5    attempts before a row is left alone
//   BOOTSTRAP_STAGE_TIMEOUT_MS default 3300000 (55m) per stage
//   BOOTSTRAP_ONLY_JOB_ID    optional     one row, for debugging a single job
//   Everything each stage's own script needs (Shopify, Google, Meta, Redo
//   credentials) is inherited from the environment -- the workflow passes the
//   same secrets the scheduled syncs use.

import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { createRunner } from './lib/integration-bootstrap-runner.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const MAX_JOBS = Number(process.env.BOOTSTRAP_MAX_JOBS || 5);
const LEASE_SECONDS = Number(process.env.BOOTSTRAP_LEASE_SECONDS || 900);
const MAX_ATTEMPTS = Number(process.env.BOOTSTRAP_MAX_ATTEMPTS || 5);
const STAGE_TIMEOUT_MS = Number(process.env.BOOTSTRAP_STAGE_TIMEOUT_MS || 55 * 60 * 1000);
const ONLY_JOB_ID = process.env.BOOTSTRAP_ONLY_JOB_ID || '';
const MANUAL = (process.env.GITHUB_EVENT_NAME || '') === 'workflow_dispatch';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Run one stage as its own process.
 *
 * Its own process, rather than an import, because these entry points are
 * written as scripts: they read process.env at module load, call
 * process.exit, and several of them set an exit code to mean "this stage
 * failed". A child keeps all of that intact, keeps one stage's env out of the
 * next one's, and means a stage that hangs can be killed without taking the
 * drainer with it.
 */
function runStage(stage, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [stage.script], {
      // GITHUB_EVENT_NAME is dropped rather than inherited: the drainer uses
      // it to decide whether ITS run should go red, and a stage that read it
      // would judge a first import by the schedule that happened to drain the
      // queue. Each stage's own strictness is set explicitly in its env (see
      // SHOPIFY_RUN_KIND in integration-bootstrap-core.mjs).
      env: { ...process.env, GITHUB_EVENT_NAME: '', ...extraEnv },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A stage that ignores SIGTERM still has to end, or the drainer never
      // releases the row.
      setTimeout(() => child.kill('SIGKILL'), 20_000).unref?.();
    }, STAGE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `could not start: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, detail: `timed out after ${Math.round(STAGE_TIMEOUT_MS / 60000)}m` });
        return;
      }
      if (code === 0) { resolve({ ok: true, detail: null }); return; }
      resolve({
        ok: false,
        detail: signal ? `killed by ${signal}` : `exit code ${code}`,
      });
    });
  });
}

// Everything a job does to its row lives in the runner module, bound here to
// the real database and the real child-process launcher.
const { runJob } = createRunner({
  db,
  runStage,
  maxAttempts: MAX_ATTEMPTS,
  leaseSeconds: LEASE_SECONDS,
});

async function claimJobs() {
  if (ONLY_JOB_ID) {
    const { data, error } = await db
      .from('integration_bootstrap_jobs')
      .select('*')
      .eq('id', ONLY_JOB_ID)
      .maybeSingle();
    if (error) throw new Error(`Could not read job ${ONLY_JOB_ID}: ${error.message}`);
    return data ? [data] : [];
  }
  const { data, error } = await db.rpc('claim_integration_bootstrap_jobs', {
    p_limit: MAX_JOBS,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw new Error(`Could not claim jobs: ${error.message}`);
  return data || [];
}

async function main() {
  const jobs = await claimJobs();
  if (!jobs.length) {
    console.log('[bootstrap] nothing to do');
    return;
  }
  console.log(`[bootstrap] claimed ${jobs.length} job(s)`);
  const results = [];
  // Sequential on purpose: these stages are the same syncs the nightlies run,
  // against the same APIs and the same rate limits, and two of them at once
  // on one runner is how a first sync starts getting throttled.
  for (const job of jobs) {
    results.push(await runJob(job));
  }
  const failed = results.filter((r) => r.status === 'error' || r.status === 'partial');
  console.log(
    `[bootstrap] ${results.length} job(s): `
    + ['done', 'partial', 'error', 'cancelled', 'pending']
      .map((s) => `${results.filter((r) => r.status === s).length} ${s}`)
      .join(', '),
  );
  // A scheduled run that hit a stage failure has already recorded it on the
  // row and will retry it; going red every time one tenant's token expires
  // would make the workflow's colour meaningless. A hand-dispatched run is
  // somebody watching one job, and they want the exit code.
  if (failed.length && MANUAL) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[bootstrap] fatal: ${err.message}`);
  process.exitCode = 1;
});
