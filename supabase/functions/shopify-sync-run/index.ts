import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  DEFAULT_UI_CHUNK_DAYS,
  computeBackfillProgress,
  deserializeSkuMetaCache,
  fetchShopifyLocations,
  effectiveHistoryDays,
  initHistoryBackfillState,
  readMeta,
  runHistoryChunk,
  runInventorySnapshot,
  serializeSkuMetaCache,
} from './lib/shopify-sync-core.mjs';
import { chunkRequestVerdict, planChunkPersist } from './lib/history-chunk-persist.mjs';
import { connectionReadyForSync } from './lib/shopify-scopes.mjs';
import { ensureShopifyAccessToken, mayConnect } from './lib/shopify-auth-lib.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Action =
  | 'start_history_backfill'
  | 'history_chunk'
  | 'cancel_history_backfill'
  | 'inventory_snapshot'
  | 'list_shopify_locations';

interface RequestBody {
  action: Action;
  connection_id: string;
  history_days?: number;
  chunk_days?: number;
  job_id?: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Admin of the connection's OWN company, judged the way every other connect
// path judges it (mayConnect: active account, membership owner_admin/admin
// there, legacy global role only without a membership). The global
// profiles.role alone is not enough: it admits a plain member of this company
// who is an admin elsewhere, and a deactivated admin whose JWT still
// refreshes -- and start_history_backfill PURGES the store's sales history.
async function assertCompanyAdmin(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  connectionId: string,
) {
  // The caller's read proves the connection is in their active company.
  const { data: visible, error: visErr } = await userClient
    .from('shopify_connections')
    .select('id, company_entity_id')
    .eq('id', connectionId)
    .single();
  if (visErr || !visible) throw new Error('Connection not found');
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('role, active_company_id, is_active')
    .eq('id', userId)
    .maybeSingle();
  const { data: membership, error: membershipError } = await admin
    .from('entity_memberships')
    .select('role')
    .eq('entity_id', visible.company_entity_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!mayConnect({ profile, profileError, membership, membershipError, companyId: visible.company_entity_id })) {
    throw new Error('Admin access required');
  }
  return visible.id as string;
}

async function assertAdminWithConnection(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  connectionId: string,
) {
  // The full row (access_token is not a column members may select) comes
  // from the service role, by the id the caller's own read returned.
  const visibleId = await assertCompanyAdmin(userClient, admin, userId, connectionId);
  const { data: conn, error } = await admin
    .from('shopify_connections')
    .select('*')
    .eq('id', visibleId)
    .single();

  if (error || !conn) throw new Error('Connection not found');
  if (!conn.access_token) throw new Error('Connection has no access token');
  if (!connectionReadyForSync(conn)) {
    throw new Error('Connection is missing required Shopify scopes');
  }

  return conn;
}

async function assertAdminConnection(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  connectionId: string,
) {
  // The full row (access_token is not a column members may select) comes
  // from the service role, by the id the caller's own read returned.
  const visibleId = await assertCompanyAdmin(userClient, admin, userId, connectionId);
  const { data: conn, error } = await admin
    .from('shopify_connections')
    .select('*')
    .eq('id', visibleId)
    .single();

  if (error || !conn) throw new Error('Connection not found');
  if (!conn.access_token) throw new Error('Connection has no access token');

  return conn;
}

async function mergeConnectionMeta(
  admin: SupabaseClient,
  connectionId: string,
  existingMeta: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  const meta = { ...existingMeta, ...patch };
  const { error } = await admin
    .from('shopify_connections')
    .update({ meta })
    .eq('id', connectionId);
  if (error) throw new Error(`Failed to update connection meta: ${error.message}`);
  return meta;
}

async function createJob(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  jobType: string,
  userId: string,
  initialResult: Record<string, unknown> = {},
) {
  const { data, error } = await admin
    .from('sync_jobs')
    .insert({
      company_entity_id: connection.company_entity_id,
      connection_id: connection.id,
      job_type: jobType,
      status: 'running',
      started_at: new Date().toISOString(),
      result: initialResult,
      created_by: userId,
    })
    .select('id')
    .single();
  if (error) throw new Error(`sync_jobs insert failed: ${error.message}`);
  return data.id as string;
}

// Scoped to the connection being worked: the job id can arrive from the
// request body, and an unscoped service-role update would let it name another
// company's job.
async function updateJob(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  jobId: string,
  update: Record<string, unknown>,
) {
  const { error } = await admin.from('sync_jobs').update(update)
    .eq('id', jobId)
    .eq('connection_id', connection.id)
    .eq('company_entity_id', connection.company_entity_id);
  if (error) throw new Error(`sync_jobs update failed: ${error.message}`);
}

function buildProgress(state: Record<string, unknown>) {
  const normalized = computeBackfillProgress(state) as Record<string, unknown>;
  return {
    windows_done: normalized.windows_done,
    windows_total: normalized.windows_total,
    orders_total: normalized.orders_total,
    sales_rows_total: normalized.sales_rows_total,
    range_start: normalized.range_start,
    range_end: normalized.range_end,
    cursor: normalized.cursor,
    status: normalized.status,
    chunk_days: normalized.chunk_days,
  };
}

/** The row's meta as it stands NOW, not as this request first read it. */
async function readStoredMeta(admin: SupabaseClient, connectionId: string) {
  const { data, error } = await admin
    .from('shopify_connections')
    .select('meta')
    .eq('id', connectionId)
    .maybeSingle();
  // Falling back to the meta this request opened with is the bug this
  // function exists to fix, so a failed read fails the request instead. The
  // window just imported is re-fetched on the next Resume; its upsert is
  // idempotent, so that costs time rather than data.
  if (error) throw new Error(`Could not re-read connection meta: ${error.message}`);
  if (!data) throw new Error('Connection row disappeared mid-import');
  const meta = (data as Record<string, unknown>).meta;
  return meta && typeof meta === 'object' ? meta as Record<string, unknown> : {};
}

async function runHistoryChunkPersisted(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  batchId: string,
) {
  const meta = readMeta(connection);
  const preState = meta.history_backfill as Record<string, unknown> | undefined;
  const cacheRaw = meta.history_backfill_caches as Record<string, unknown> | undefined;
  const chunkResult = await runHistoryChunk(admin, connection, {
    batchId,
    skuMetaCache: deserializeSkuMetaCache(cacheRaw?.skuMeta),
  });

  const nextState = chunkResult.state as Record<string, unknown>;
  const skuMetaJson = chunkResult.caches?.skuMeta
    ? serializeSkuMetaCache(chunkResult.caches.skuMeta)
    : cacheRaw?.skuMeta ?? null;

  // A window takes minutes, and Cancel (or the scheduled sync's watermark, or
  // a fresh Start) can land on this row while it runs. Decide against what is
  // stored now rather than against the meta this request opened with.
  const plan = planChunkPersist({
    preState,
    storedMeta: await readStoredMeta(admin, connection.id as string),
    nextState,
    skuMetaJson,
    done: chunkResult.done,
  });

  if (plan.action === 'superseded') {
    // Another import owns the connection. Its rows are written; its state is
    // not, and this request stops rather than reviving a replaced plan.
    const staleJobId = preState?.job_id as string | undefined;
    if (staleJobId) {
      await finalizeSupersededJob(
        admin,
        connection,
        staleJobId,
        (plan.state?.job_id as string | undefined) ?? null,
      );
    }
    return { ...chunkResult, state: plan.state, done: true, superseded: true };
  }

  const { error } = await admin
    .from('shopify_connections')
    .update({ meta: plan.meta })
    .eq('id', connection.id as string);
  if (error) throw new Error(`Failed to update connection meta: ${error.message}`);
  connection.meta = plan.meta;

  return {
    ...chunkResult,
    state: plan.state,
    // A cancelled import is finished as far as the browser loop is concerned.
    done: plan.cancelled ? true : chunkResult.done,
    cancelled: plan.cancelled,
  };
}

async function handleStartHistoryBackfill(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  userId: string,
  historyDays: number,
  chunkDays: number,
  existingJobId?: string,
) {
  const batchId = `ui-${Date.now()}`;
  const meta = readMeta(connection);
  let state = meta.history_backfill as Record<string, unknown> | undefined;

  if (state?.status === 'running'
    && Number(state.target_days) === effectiveHistoryDays(connection, historyDays).days
    && state.job_id) {
    return handleHistoryChunk(admin, connection, state.job_id as string, chunkDays);
  }

  // Nothing is deleted here. Each window is purged by runHistoryChunk once
  // Shopify has answered for that window, so an import that stops early can
  // only have rebuilt the windows it actually fetched. This function used to
  // delete every shopify_api row for the shop before the first fetch, so
  // clicking "90d" on a store with nine years of sales left ninety days.
  //
  // The plan is also clamped to the window this token can read: without
  // read_all_orders Shopify answers only the last 60 days, and the UI's
  // "import the last 60 days anyway" used to send 365 or 730 unchanged.
  const planned = effectiveHistoryDays(connection, historyDays);
  state = initHistoryBackfillState({ historyDays: planned.days, chunkDays });

  const jobId = existingJobId || await createJob(admin, connection, 'history_import', userId, {
    history_days: planned.days,
    requested_days: historyDays,
    ...(planned.clamped ? { clamped_to: planned.days, clamped_reason: 'read_all_orders not granted' } : {}),
    chunk_days: chunkDays,
    windows_total: state.windows_total,
    initiated_from: 'integrations_ui',
  });

  await mergeConnectionMeta(admin, connection.id as string, meta, {
    history_backfill: { ...state, job_id: jobId },
    history_backfill_caches: null,
  });

  connection.meta = {
    ...meta,
    history_backfill: { ...state, job_id: jobId },
    history_backfill_caches: null,
  };

  const chunkResult = await runHistoryChunkPersisted(admin, connection, batchId);
  const nextState = chunkResult.state as Record<string, unknown>;
  const progress = buildProgress(nextState);
  // `done` also goes true when the import was cancelled or superseded mid
  // window, which stops the browser loop but is not a completed import: the
  // cancel handler already finished the job, and a superseded run's job
  // belongs to the import that replaced it.
  const finished = chunkResult.done && !chunkResult.cancelled && !chunkResult.superseded;

  if (finished) {
    await updateJob(admin, connection, jobId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      result: { ...progress, chunks: [chunkResult.chunk], completed: true },
    });
    await admin.rpc('purge_better_reports_overlap', {
      p_company_entity_id: connection.company_entity_id,
    });
    await admin.rpc('refresh_sales_verification_store_comp_summary');
  } else if (!chunkResult.cancelled && !chunkResult.superseded) {
    await updateJob(admin, connection, jobId, {
      result: { ...progress, last_chunk: chunkResult.chunk },
    });
  }

  return {
    ok: true,
    job_id: jobId,
    continue: !chunkResult.done,
    progress,
    chunk: chunkResult.chunk,
  };
}

async function handleHistoryChunk(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  jobId?: string,
  chunkDaysOverride?: number,
) {
  const meta = readMeta(connection);
  let state = meta.history_backfill as Record<string, unknown> | undefined;
  if (!state || state.status !== 'running') {
    throw new Error('No history backfill in progress. Start a new import from Settings.');
  }

  if (chunkDaysOverride && Number(chunkDaysOverride) > 0) {
    state = { ...state, chunk_days: Number(chunkDaysOverride) };
    const merged = await mergeConnectionMeta(admin, connection.id as string, meta, {
      history_backfill: state,
    });
    connection.meta = merged;
  }

  // A delayed request from a replaced import must not touch the live plan.
  const verdict = chunkRequestVerdict({ suppliedJobId: jobId ?? null, state });
  if (!verdict.ok) {
    if (jobId) await finalizeSupersededJob(admin, connection, jobId, verdict.jobId);
    return {
      ok: true,
      job_id: verdict.jobId,
      continue: false,
      superseded: true,
      progress: buildProgress(state),
    };
  }

  const activeJobId = verdict.jobId as string;
  const batchId = `ui-${Date.now()}`;

  const chunkResult = await runHistoryChunkPersisted(admin, connection, batchId);
  const nextState = chunkResult.state as Record<string, unknown>;
  const progress = buildProgress(nextState);

  const finished = chunkResult.done && !chunkResult.cancelled && !chunkResult.superseded;

  if (activeJobId) {
    if (finished) {
      await updateJob(admin, connection, activeJobId, {
        status: 'success',
        finished_at: new Date().toISOString(),
        result: { ...progress, last_chunk: chunkResult.chunk, completed: true },
      });
      await admin.rpc('purge_better_reports_overlap', {
        p_company_entity_id: connection.company_entity_id,
      });
      await admin.rpc('refresh_sales_verification_store_comp_summary');
    } else if (!chunkResult.cancelled && !chunkResult.superseded) {
      // Writing progress over a cancelled job's result would erase the record
      // of WHY it stopped, which is the only thing that record is for.
      await updateJob(admin, connection, activeJobId, {
        result: { ...progress, last_chunk: chunkResult.chunk },
      });
    }
  }

  return {
    ok: true,
    job_id: activeJobId,
    continue: !chunkResult.done,
    progress,
    chunk: chunkResult.chunk,
  };
}

/** A job the row has moved on from is finished, not running: leaving it
 *  `running` corrupts every operational read of sync_jobs. It is recorded
 *  `skipped` for the same reason a cancellation is -- nothing failed. */
async function finalizeSupersededJob(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  staleJobId: string,
  replacementJobId: string | null,
) {
  await updateJob(admin, connection, staleJobId, {
    status: 'skipped',
    finished_at: new Date().toISOString(),
    result: {
      status: 'superseded',
      reason: 'A newer import replaced this one',
      ...(replacementJobId ? { replaced_by_job_id: replacementJobId } : {}),
    },
  });
}

async function handleCancelHistoryBackfill(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
) {
  // Merge onto the row as it stands: a window may have written progress since
  // this request read the connection, and that progress must survive the
  // cancellation (its rows are in sales_by_day).
  const meta = await readStoredMeta(admin, connection.id as string);
  const state = meta.history_backfill as Record<string, unknown> | undefined;
  if (!state) return { ok: true, cancelled: false };

  const nextState = {
    ...state,
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  };
  await mergeConnectionMeta(admin, connection.id as string, meta, {
    history_backfill: nextState,
    history_backfill_caches: null,
  });

  const jobId = state.job_id as string | undefined;
  if (jobId) {
    // An operator stopping an import is not a failed sync: `error` put it in
    // every error report beside real failures, and the Node runner records the
    // same outcome as `skipped`. The reason lives in `result`.
    await updateJob(admin, connection, jobId, {
      status: 'skipped',
      finished_at: new Date().toISOString(),
      result: {
        ...buildProgress(nextState),
        status: 'cancelled',
        cancelled_at: nextState.cancelled_at,
        reason: 'Cancelled by user',
      },
    });
  }

  return { ok: true, cancelled: true };
}

async function handleInventorySnapshot(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
  userId: string,
) {
  const batchId = `ui-${Date.now()}`;
  const jobId = await createJob(admin, connection, 'inventory_snapshot', userId);

  try {
    const result = await runInventorySnapshot(admin, connection, { batchId });

    // The refresh is awaited and its error READ, before the job is called a
    // success. supabase-js resolves an RPC with { data, error } instead of
    // rejecting, so a bare `await admin.rpc(...)` silently discards a database
    // failure -- which is what this did, and it reported ok: true regardless.
    //
    // 20261012210000 made that worse rather than merely untidy:
    // refresh_inventory_current_mv() now also refreshes the derived
    // inventory_workboard_mv, and a failure there raises, which aborts the
    // whole statement -- so BOTH matviews roll back and the snapshot this job
    // just stored is visible in nothing the page reads. Reporting success then
    // tells the operator their inventory is current when no matview moved at
    // all. The scheduled orchestrator and the workflow retry step already
    // check this RPC's error; this was the one caller that did not.
    const { error: refreshError } = await admin.rpc('refresh_inventory_current_mv');
    if (refreshError) {
      throw new Error(
        `inventory snapshot stored, but the matview refresh failed, so the inventory page and dead-stock inputs still show the previous snapshot: ${refreshError.message}`,
      );
    }

    await updateJob(admin, connection, jobId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      result,
    });
    return { ok: true, job_id: jobId, result };
  } catch (err) {
    await updateJob(admin, connection, jobId, {
      status: 'error',
      finished_at: new Date().toISOString(),
      error: String(err).slice(0, 2000),
    });
    throw err;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await req.json() as RequestBody;
    const { action, connection_id: connectionId } = body;
    if (!action || !connectionId) {
      return json({ ok: false, error: 'action and connection_id are required' }, 400);
    }

    if (action === 'list_shopify_locations') {
      const connection = await assertAdminConnection(userClient, admin, user.id, connectionId);
      await ensureShopifyAccessToken(admin, connection);
      const locations = await fetchShopifyLocations(connection);
      return json({ ok: true, locations });
    }

    const connection = await assertAdminWithConnection(userClient, admin, user.id, connectionId);
    // A client-credentials store's token lasts 24 hours: mint a fresh one with
    // the service role (the only reader of the client secret). No-op otherwise.
    await ensureShopifyAccessToken(admin, connection);

    switch (action) {
      case 'start_history_backfill': {
        const historyDays = Number(body.history_days || connection.history_days_default || 90);
        const chunkDays = Number(body.chunk_days || DEFAULT_UI_CHUNK_DAYS);
        if (historyDays < 1 || historyDays > 730) {
          return json({ ok: false, error: 'history_days must be between 1 and 730' }, 400);
        }
        if (chunkDays < 1 || chunkDays > 30) {
          return json({ ok: false, error: 'chunk_days must be between 1 and 30' }, 400);
        }
        const result = await handleStartHistoryBackfill(
          admin,
          connection,
          user.id,
          historyDays,
          chunkDays,
          body.job_id,
        );
        return json(result);
      }
      case 'history_chunk': {
        const result = await handleHistoryChunk(
          admin,
          connection,
          body.job_id,
          body.chunk_days,
        );
        return json(result);
      }
      case 'cancel_history_backfill': {
        const result = await handleCancelHistoryBackfill(admin, connection);
        return json(result);
      }
      case 'inventory_snapshot': {
        const result = await handleInventorySnapshot(admin, connection, user.id);
        return json(result);
      }
      default:
        return json({ ok: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
