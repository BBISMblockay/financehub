import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  DEFAULT_CHUNK_DAYS,
  fetchShopifyLocations,
  initHistoryBackfillState,
  purgeShopifySalesForCompany,
  readMeta,
  runHistoryChunk,
  runInventorySnapshot,
} from './lib/shopify-sync-core.mjs';
import { connectionReadyForSync } from './lib/shopify-scopes.mjs';

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

async function assertAdminWithConnection(
  userClient: SupabaseClient,
  userId: string,
  connectionId: string,
) {
  const { data: profile } = await userClient
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (!profile || !['owner', 'admin'].includes(String(profile.role))) {
    throw new Error('Admin access required');
  }

  const { data: conn, error } = await userClient
    .from('shopify_connections')
    .select('*')
    .eq('id', connectionId)
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
  userId: string,
  connectionId: string,
) {
  const { data: profile } = await userClient
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (!profile || !['owner', 'admin'].includes(String(profile.role))) {
    throw new Error('Admin access required');
  }

  const { data: conn, error } = await userClient
    .from('shopify_connections')
    .select('*')
    .eq('id', connectionId)
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

async function updateJob(
  admin: SupabaseClient,
  jobId: string,
  update: Record<string, unknown>,
) {
  const { error } = await admin.from('sync_jobs').update(update).eq('id', jobId);
  if (error) throw new Error(`sync_jobs update failed: ${error.message}`);
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

  if (state?.status === 'running' && Number(state.target_days) === historyDays && state.job_id) {
    return handleHistoryChunk(admin, connection, state.job_id as string);
  }

  await purgeShopifySalesForCompany(admin, connection.company_entity_id as string);
  state = initHistoryBackfillState({ historyDays, chunkDays });

  const jobId = existingJobId || await createJob(admin, connection, 'history_import', userId, {
    history_days: historyDays,
    chunk_days: chunkDays,
    windows_total: state.windows_total,
    initiated_from: 'integrations_ui',
  });

  await mergeConnectionMeta(admin, connection.id as string, meta, {
    history_backfill: { ...state, job_id: jobId },
  });

  connection.meta = { ...meta, history_backfill: { ...state, job_id: jobId } };

  const chunkResult = await runHistoryChunk(admin, connection, { batchId });
  const nextState = chunkResult.state;
  await mergeConnectionMeta(admin, connection.id as string, readMeta(connection), {
    history_backfill: nextState,
  });

  const progress = {
    windows_done: nextState.windows_done,
    windows_total: nextState.windows_total,
    orders_total: nextState.orders_total,
    sales_rows_total: nextState.sales_rows_total,
    range_start: nextState.range_start,
    range_end: nextState.range_end,
    cursor: nextState.cursor,
    status: nextState.status,
  };

  if (chunkResult.done) {
    await updateJob(admin, jobId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      result: { ...progress, chunks: [chunkResult.chunk], completed: true },
    });
    await admin.rpc('refresh_sales_verification_store_comp_summary');
  } else {
    await updateJob(admin, jobId, {
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
) {
  const meta = readMeta(connection);
  const state = meta.history_backfill as Record<string, unknown> | undefined;
  if (!state || state.status !== 'running') {
    throw new Error('No history backfill in progress. Start a new import from Settings.');
  }

  const activeJobId = jobId || (state.job_id as string);
  const batchId = `ui-${Date.now()}`;

  const chunkResult = await runHistoryChunk(admin, connection, { batchId });
  const nextState = chunkResult.state;
  await mergeConnectionMeta(admin, connection.id as string, meta, {
    history_backfill: nextState,
  });

  const progress = {
    windows_done: nextState.windows_done,
    windows_total: nextState.windows_total,
    orders_total: nextState.orders_total,
    sales_rows_total: nextState.sales_rows_total,
    range_start: nextState.range_start,
    range_end: nextState.range_end,
    cursor: nextState.cursor,
    status: nextState.status,
  };

  if (activeJobId) {
    if (chunkResult.done) {
      await updateJob(admin, activeJobId, {
        status: 'success',
        finished_at: new Date().toISOString(),
        result: { ...progress, last_chunk: chunkResult.chunk, completed: true },
      });
      await admin.rpc('refresh_sales_verification_store_comp_summary');
    } else {
      await updateJob(admin, activeJobId, {
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

async function handleCancelHistoryBackfill(
  admin: SupabaseClient,
  connection: Record<string, unknown>,
) {
  const meta = readMeta(connection);
  const state = meta.history_backfill as Record<string, unknown> | undefined;
  if (!state) return { ok: true, cancelled: false };

  const nextState = {
    ...state,
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  };
  await mergeConnectionMeta(admin, connection.id as string, meta, {
    history_backfill: nextState,
  });

  const jobId = state.job_id as string | undefined;
  if (jobId) {
    await updateJob(admin, jobId, {
      status: 'error',
      finished_at: new Date().toISOString(),
      error: 'Cancelled by user',
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
    await updateJob(admin, jobId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      result,
    });
    // Refresh materialized view so inventory page reads are instant
    await admin.rpc('refresh_inventory_current_mv').catch((e: Error) =>
      console.error('refresh_inventory_current_mv failed:', e.message)
    );
    return { ok: true, job_id: jobId, result };
  } catch (err) {
    await updateJob(admin, jobId, {
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
      const connection = await assertAdminConnection(userClient, user.id, connectionId);
      const locations = await fetchShopifyLocations(connection);
      return json({ ok: true, locations });
    }

    const connection = await assertAdminWithConnection(userClient, user.id, connectionId);

    switch (action) {
      case 'start_history_backfill': {
        const historyDays = Number(body.history_days || connection.history_days_default || 90);
        const chunkDays = Number(body.chunk_days || DEFAULT_CHUNK_DAYS);
        if (historyDays < 1 || historyDays > 730) {
          return json({ ok: false, error: 'history_days must be between 1 and 730' }, 400);
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
        const result = await handleHistoryChunk(admin, connection, body.job_id);
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
