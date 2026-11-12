const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const reply = (body, status = 200) => Response.json(body, { status });
// A recovery attempt's outcome, reduced to bounded scalars for the run log.
// The sync reports its own recoveries (a date-range top-up, a request to the
// institution to re-fetch) alongside the counts, and this used to read only
// the counts -- so "the bank had nothing" and "the recovery itself failed"
// looked identical in the log and in the database. Only these fields travel,
// so a provider message can never reach a workflow log through here.
const recovery = source => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const summary = {};
  if (Number.isInteger(source.imported)) summary.imported = source.imported;
  if (Number.isInteger(source.examined)) summary.examined = source.examined;
  if (source.requested === true) summary.requested = true;
  if (typeof source.failed === 'string' && source.failed) summary.failed = source.failed.slice(0, 64);
  return Object.keys(summary).length ? summary : null;
};

// One account per invocation bounds runtime. Account selection and the service
// credential remain server-side. The caller cannot submit an action or payload.
export function createScheduledHandler({ env, verifyIdentity, createDb, syncAccount }) {
  return async req => {
    if (req.method !== 'POST') return reply({ error_code: 'method_not_allowed' }, 405);
    const token = req.headers.get('x-silo-scheduler-token') || '';
    try {
      if (!token || token.length > 16384) throw new Error();
      await verifyIdentity(token, new URL('/functions/v1/plaid-scheduled-sync', env('SUPABASE_URL')).href);
    } catch { return reply({ error_code: 'scheduler_identity_rejected' }, 401); }
    if (env('PLAID_BACKGROUND_SYNC_ENABLED') !== 'true') return reply({ error_code: 'background_sync_disabled' }, 403);
    if (!['sandbox', 'production'].includes(env('PLAID_ENVIRONMENT'))) return reply({ error_code: 'environment_not_configured' }, 503);
    const raw = await req.text();
    if (raw.length > 256) return reply({ error_code: 'invalid_request' }, 400);
    let input;
    try { input = JSON.parse(raw); } catch { return reply({ error_code: 'invalid_request' }, 400); }
    if (!input || Array.isArray(input) || typeof input !== 'object' ||
        Object.keys(input).some(key => key !== 'after') ||
        (input.after != null && !uuid(input.after))) return reply({ error_code: 'invalid_request' }, 400);
    try {
      const db = createDb();
      let query = db.from('plaid_accounts').select('id,plaid_connections!inner(status,environment)')
        .not('source_id', 'is', null).eq('plaid_connections.status', 'active')
        .eq('plaid_connections.environment', env('PLAID_ENVIRONMENT'))
        .order('id', { ascending: true }).limit(1);
      if (input.after) query = query.gt('id', input.after);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) return reply({ error_code: 'account_discovery_failed' }, 503);
      if (!data.length) return reply({ done: true });
      const id = data[0].id;
      if (!uuid(id) || (input.after && id <= input.after)) return reply({ error_code: 'account_discovery_failed' }, 503);
      try {
        const result = await syncAccount(id);
        const body = await result.json().catch(() => null);
        const ok = result.ok && Array.isArray(body?.batch_ids) && Number.isInteger(body?.exceptions) && body.exceptions >= 0;
        const topUp = ok ? recovery(body.top_up) : null;
        const refetch = ok ? recovery(body.refetch) : null;
        return reply({ done: false, account_id: id, ok, status: result.status,
          exceptions: ok ? body.exceptions : 0, ...(ok ? {} : { error_code: 'account_sync_failed' }),
          ...(topUp ? { top_up: topUp } : {}), ...(refetch ? { refetch } : {}) });
      } catch {
        // The existing ingestion lease/cursor protocol governs uncertain writes.
        return reply({ done: false, account_id: id, ok: false, status: 'unconfirmed', exceptions: 0,
          error_code: 'account_sync_unconfirmed' });
      }
    } catch { return reply({ error_code: 'account_discovery_failed' }, 503); }
  };
}
