const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const reply = (body, status = 200) => Response.json(body, { status });
// One import per invocation, and at most this many of its rows: 40 rows is at
// most 40 merchant groups, which at ten per model call and four calls at a
// time is ONE concurrent wave -- so an invocation finishes well inside the
// runner's 145s and the gateway's 150s. It must shrink with the batch size:
// scripts/tests/card-coding-prepare-scheduled.test.mjs reads both and fails
// if this ever needs more than one wave again. The runner's cursor carries the
// rest of an import through further bounded invocations.
export const ROWS_PER_INVOCATION = 40;

// How many rows one run may categorize from saved rules. The rest waits for
// the next run (every bank feed sync, and nightly).
export const RULE_ROWS_PER_RUN = 500;
// Counts only -- never a row, a merchant or an account name in a response.
async function applySavedRules(db) {
  try {
    const { data, error } = await db.rpc('apply_saved_card_coding_rules', { p_limit: RULE_ROWS_PER_RUN });
    if (error || !data || typeof data !== 'object') return null;
    const whole = value => (Number.isInteger(value) && value >= 0 ? value : 0);
    const skipped = data.skipped && typeof data.skipped === 'object' && !Array.isArray(data.skipped)
      ? Object.values(data.skipped).reduce((n, value) => n + whole(value), 0) : 0;
    return { applied: whole(data.applied), skipped, more: data.more === true };
  } catch { return null; }
}

// Scheduled coding preparation. The caller is the scheduler, identified by its
// GitHub OIDC token -- never a person, and never a borrowed person's session.
// It may name a cursor or the import it is still working through; it may NOT
// name a company, an account, an action, or which rows: the database decides
// what needs preparing (next_card_coding_work) and the company is read from the
// import. Preparation writes suggestions only. The one thing that categorizes
// a row here is a rule the company saved (below); accepting a suggestion,
// approval and posting are not reachable from here.
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
    // Saved rules first, once per run (the runner's first call carries no
    // cursor): a row a rule answers is categorized here and never reaches the
    // model. The database decides which rows (apply_saved_card_coding_rules:
    // switched-on accounts, open months, rows no person has saved). Fail-soft
    // by design -- preparation below does not depend on it, and a database
    // that does not have the function yet simply reports null.
    let rules = null;
    if (input.after == null && input.batch == null) rules = await applySavedRules(db);
    let work;
    try {
      const { data, error } = await db.rpc('next_card_coding_work',
        { p_after: input.after ?? null, p_batch: input.batch ?? null, p_limit: ROWS_PER_INVOCATION });
      if (error) throw new Error();
      work = data;
    } catch { return reply({ error_code: 'work_discovery_failed' }, 503); }
    if (!work) return reply({ done: true, ...(rules ? { rules } : {}) });
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
        ...(rules ? { rules } : {}), ...(ok ? {} : { error_code: 'preparation_failed' }) });
    } catch {
      // Whatever finished was saved slice by slice; the claim lease expires.
      return reply({ done: false, batch_id: work.batch_id, ok: false, status: 'unconfirmed', run_id: null, run_status: null,
        suggested: 0, needs_judgment: 0, failed: 0, in_progress: 0, asked: work.transaction_ids.length, remaining,
        ...(rules ? { rules } : {}), error_code: 'preparation_unconfirmed' });
    }
  };
}
