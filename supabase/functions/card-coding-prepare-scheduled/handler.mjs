const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const reply = (body, status = 200) => Response.json(body, { status });
// One import per invocation, and at most this many of its rows: 160 rows is at
// most 160 merchant groups, which is four model calls -- one concurrent wave --
// so an invocation finishes well inside the gateway's 150s.
export const ROWS_PER_INVOCATION = 160;

// Scheduled coding preparation. The caller is the scheduler, identified by its
// GitHub OIDC token -- never a person, and never a borrowed person's session.
// It may name a cursor or the import it is still working through; it may NOT
// name a company, an account, an action, or which rows: the database decides
// what needs preparing (next_card_coding_work) and the company is read from the
// import. Preparation writes suggestions only; accepting, approval and posting
// are not reachable from here.
export function createScheduledPrepareHandler({ env, verifyIdentity, createDb, prepare }) {
  return async req => {
    if (req.method !== 'POST') return reply({ error_code: 'method_not_allowed' }, 405);
    const token = req.headers.get('x-silo-scheduler-token') || '';
    try {
      if (!token || token.length > 16384) throw new Error();
      await verifyIdentity(token, new URL('/functions/v1/card-coding-prepare-scheduled', env('SUPABASE_URL')).href);
    } catch { return reply({ error_code: 'scheduler_identity_rejected' }, 401); }
    if (env('CODING_PREP_BACKGROUND_ENABLED') !== 'true') return reply({ error_code: 'background_preparation_disabled' }, 403);
    const raw = await req.text();
    if (raw.length > 512) return reply({ error_code: 'invalid_request' }, 400);
    let input;
    try { input = JSON.parse(raw); } catch { return reply({ error_code: 'invalid_request' }, 400); }
    if (!input || Array.isArray(input) || typeof input !== 'object' ||
        Object.keys(input).some(key => !['after', 'batch', 'trigger'].includes(key)) ||
        (input.after != null && !uuid(input.after)) || (input.batch != null && !uuid(input.batch)) ||
        !['background', 'nightly'].includes(input.trigger)) return reply({ error_code: 'invalid_request' }, 400);
    let db;
    try { db = createDb(); } catch { return reply({ error_code: 'work_discovery_failed' }, 503); }
    let work;
    try {
      const { data, error } = await db.rpc('next_card_coding_work',
        { p_after: input.after ?? null, p_batch: input.batch ?? null, p_limit: ROWS_PER_INVOCATION });
      if (error) throw new Error();
      work = data;
    } catch { return reply({ error_code: 'work_discovery_failed' }, 503); }
    if (!work) return reply({ done: true });
    if (!uuid(work.batch_id) || !uuid(work.company_entity_id) || !Array.isArray(work.transaction_ids) ||
        !work.transaction_ids.length || !work.transaction_ids.every(uuid) ||
        (input.after && !input.batch && work.batch_id <= input.after) ||
        (input.batch && work.batch_id !== input.batch)) return reply({ error_code: 'work_discovery_failed' }, 503);
    const remaining = Number.isInteger(work.remaining) && work.remaining >= 0 ? work.remaining : 0;
    try {
      const result = await prepare(db, {
        companyId: work.company_entity_id, batchId: work.batch_id, transactionIds: work.transaction_ids,
        trigger: input.trigger, requestedBy: null, retry: false, skipIneligible: true,
      });
      const body = result?.body || {};
      const ok = result?.status === 200 && body.run_status !== 'failed';
      const count = key => (Number.isInteger(body[key]) && body[key] >= 0 ? body[key] : 0);
      return reply({ done: false, batch_id: work.batch_id, ok, status: result?.status ?? 'unconfirmed',
        run_id: uuid(body.run_id) ? body.run_id : null, run_status: typeof body.run_status === 'string' ? body.run_status : null,
        suggested: count('suggested'), needs_judgment: count('needs_judgment'), failed: count('failed'),
        in_progress: count('in_progress'), asked: work.transaction_ids.length, remaining,
        ...(ok ? {} : { error_code: 'preparation_failed' }) });
    } catch {
      // Whatever finished was saved slice by slice; the claim lease expires.
      return reply({ done: false, batch_id: work.batch_id, ok: false, status: 'unconfirmed', run_id: null, run_status: null,
        suggested: 0, needs_judgment: 0, failed: 0, in_progress: 0, asked: work.transaction_ids.length, remaining,
        error_code: 'preparation_unconfirmed' });
    }
  };
}
