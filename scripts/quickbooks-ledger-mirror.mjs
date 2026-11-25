// Reads QuickBooks' general ledger back into SILO. No database key and no
// QuickBooks credential is loaded by this process: it proves which workflow it
// is with a GitHub OIDC token, and the Edge Function decides which
// company-month is due and whether what QuickBooks returned is acceptable.
//
// One company-month per call, until nothing is due. A month that could not be
// read is recorded by the function and not offered again for six hours, so
// this loop cannot spin on it.
import { pathToFileURL } from 'node:url';
import { githubIdentityToken } from './plaid-sync.mjs';

const safeCodes = new Set(['scheduler_identity_rejected', 'ledger_mirror_disabled', 'invalid_request',
  'work_discovery_failed', 'failure_not_recorded', 'report_refused', 'store_failed', 'reconnect_required',
  'not_configured', 'token_refresh_failed', 'token_persist_failed', 'quickbooks_unreachable', 'quickbooks_busy',
  'quickbooks_read_failed', 'connection_unreadable', 'environment_mismatch']);
// Only the company can fix these (connect QuickBooks again), so they are
// reported and do not turn the run red. See scripts/CLAUDE.md.
export const OWNER_SIDE = new Set(['reconnect_required']);
// A first run reads thirteen months per company; later runs two or three.
export const MAX_CALLS = 120;

export async function runLedgerMirror({ url, getToken = githubIdentityToken, fetchImpl = fetch, maxCalls = MAX_CALLS }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid Supabase URL');
  const endpoint = new URL('/functions/v1/quickbooks-ledger-mirror-scheduled', base);
  const summary = { calls: 0, read: 0, changed: 0, unchanged: 0, lines: 0, failed: 0, owner_side: 0, errors: {}, stopped: null };
  for (;;) {
    if (summary.calls >= maxCalls) { summary.stopped = 'call_limit'; break; }
    summary.calls++;
    // Renewed for every call: a long run must not reuse an expired identity.
    const token = await getToken(endpoint.href);
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST',
        headers: { 'x-silo-scheduler-token': token, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(145_000), redirect: 'error' });
    } catch {
      // Nothing is half-written: a month is replaced in one transaction or not at all.
      throw new Error('Ledger mirror response unconfirmed; the next run reads whatever is still due');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Ledger mirror rejected (${response.status}): ${safeCodes.has(body?.error_code) ? body.error_code : 'request_failed'}`);
    if (body?.done === true) break;
    if (body?.done !== false || typeof body.ok !== 'boolean' || typeof body.changed !== 'boolean'
        || !Number.isInteger(body.lines) || body.lines < 0) throw new Error('Invalid ledger mirror response');
    if (body.ok) {
      summary.read++;
      summary.lines += body.lines;
      if (body.changed) summary.changed++; else summary.unchanged++;
    } else {
      const code = safeCodes.has(body.error_code) ? body.error_code : 'read_failed';
      summary.errors[code] = (summary.errors[code] || 0) + 1;
      if (OWNER_SIDE.has(code)) summary.owner_side++; else summary.failed++;
    }
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error('SUPABASE_URL is required');
    const result = await runLedgerMirror({ url });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Ledger mirror failed');
    process.exitCode = 1;
  }
}
