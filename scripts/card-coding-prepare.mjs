// Scheduled coding preparation. No database key is loaded by this process:
// it proves which workflow it is with a GitHub OIDC token, and the Edge
// Function decides what needs preparing.
//
// One import per call. The runner stays on an import while it is making
// progress (a large month can need several calls) and moves on as soon as a
// call prepares nothing -- rows it cannot prepare now are someone else's
// (claimed), backing off, or blocked, and asking again would only spin.
import { pathToFileURL } from 'node:url';
import { githubIdentityToken } from './plaid-sync.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const safeCodes = new Set(['scheduler_identity_rejected', 'background_preparation_disabled', 'invalid_request',
  'work_discovery_failed', 'preparation_failed', 'preparation_unconfirmed']);
export const MAX_CALLS = 200;          // a hard stop for one scheduled run
export const MAX_REPEATS_PER_IMPORT = 10;

export async function runCodingPreparation({ url, trigger, getToken = githubIdentityToken, fetchImpl = fetch, maxCalls = MAX_CALLS }) {
  if (!['background', 'nightly'].includes(trigger)) throw new Error('CODING_PREP_TRIGGER must be background or nightly');
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid Supabase URL');
  const endpoint = new URL('/functions/v1/card-coding-prepare-scheduled', base);
  let after = null, batch = null, repeats = 0, calls = 0;
  const results = [];
  for (;;) {
    if (calls >= maxCalls) { results.push({ stopped: 'call_limit' }); break; }
    calls++;
    // Renewed for every call: a long run must not reuse an expired identity.
    const token = await getToken(endpoint.href);
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST',
        headers: { 'x-silo-scheduler-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ after, batch, trigger }), signal: AbortSignal.timeout(145_000), redirect: 'error' });
    } catch {
      // Finished model calls were saved; claims expire. The next run resumes.
      throw new Error('Scheduled preparation response unconfirmed; the next run resumes from saved suggestions');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Scheduled preparation rejected (${response.status}): ${safeCodes.has(body?.error_code) ? body.error_code : 'request_failed'}`);
    if (body?.done === true) break;
    const count = key => Number.isInteger(body?.[key]) && body[key] >= 0;
    if (body?.done !== false || !uuid(body.batch_id) || typeof body.ok !== 'boolean'
        || !['suggested', 'needs_judgment', 'failed', 'in_progress', 'asked', 'remaining'].every(count)
        || (batch && body.batch_id !== batch) || (!batch && after && body.batch_id <= after)) throw new Error('Invalid scheduled preparation response');
    const prepared = body.suggested + body.needs_judgment + body.failed;
    results.push({ batch_id: body.batch_id, ok: body.ok, run_status: body.run_status ?? null, prepared,
      suggested: body.suggested, needs_judgment: body.needs_judgment, failed: body.failed, in_progress: body.in_progress,
      remaining: body.remaining, ...(body.ok ? {} : { error_code: safeCodes.has(body.error_code) ? body.error_code : 'preparation_failed' }) });
    // Stay on this import only while it is getting somewhere.
    if (body.ok && prepared > 0 && body.remaining > 0 && repeats < MAX_REPEATS_PER_IMPORT) { batch = body.batch_id; repeats++; }
    else { after = body.batch_id; batch = null; repeats = 0; }
  }
  const units = results.filter(r => r.batch_id);
  return { calls, imports: new Set(units.map(r => r.batch_id)).size, failed: units.filter(r => !r.ok).length,
    suggested: units.reduce((n, r) => n + r.suggested, 0), needs_judgment: units.reduce((n, r) => n + r.needs_judgment, 0),
    failures_recorded: units.reduce((n, r) => n + r.failed, 0), stopped: results.find(r => r.stopped)?.stopped ?? null, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error('SUPABASE_URL is required');
    const result = await runCodingPreparation({ url, trigger: process.env.CODING_PREP_TRIGGER || 'background' });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Coding preparation failed');
    process.exitCode = 1;
  }
}
