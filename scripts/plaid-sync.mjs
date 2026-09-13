// Scheduled ingestion only. No database key is loaded by this process.
import { pathToFileURL } from 'node:url';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const safeCodes = new Set(['scheduler_identity_rejected', 'background_sync_disabled', 'environment_not_configured',
  'invalid_request', 'account_discovery_failed', 'account_sync_failed', 'account_sync_unconfirmed']);

export async function githubIdentityToken(audience, { env = process.env, fetchImpl = fetch } = {}) {
  const endpoint = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const credential = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !credential) throw new Error('GitHub OIDC unavailable: workflow needs id-token: write');
  const request = new URL(endpoint);
  if (request.protocol !== 'https:' || request.username || request.password) throw new Error('Invalid GitHub OIDC endpoint');
  request.searchParams.set('audience', audience);
  try {
    const response = await fetchImpl(request, { headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(30_000), redirect: 'error' });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.value !== 'string' || !body.value) throw new Error();
    return body.value;
  } catch { throw new Error('GitHub OIDC token request failed'); }
}

export async function runPlaidSync({ url, getToken = githubIdentityToken, fetchImpl = fetch }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid Supabase URL');
  const endpoint = new URL('/functions/v1/plaid-scheduled-sync', base);
  let after = null;
  const results = [];
  for (;;) {
    // Renew for every account: a long run must not reuse an expired identity.
    const token = await getToken(endpoint.href);
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST',
        headers: { 'x-silo-scheduler-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ after }), signal: AbortSignal.timeout(145_000), redirect: 'error' });
    } catch { throw new Error('Scheduled sync response unconfirmed; rerun uses saved account cursors'); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Scheduled sync rejected (${response.status}): ${safeCodes.has(body?.error_code) ? body.error_code : 'request_failed'}`);
    if (body?.done === true) break;
    if (body?.done !== false || !uuid(body.account_id) || (after && body.account_id <= after) ||
        typeof body.ok !== 'boolean' || !Number.isInteger(body.exceptions) || body.exceptions < 0 ||
        !(body.status === 'unconfirmed' || (Number.isInteger(body.status) && body.status >= 100 && body.status <= 599)) ||
        (body.ok && (body.status < 200 || body.status >= 300 || body.status === 'unconfirmed'))) throw new Error('Invalid scheduled sync response');
    results.push({ account_id: body.account_id, ok: body.ok, status: body.status, exceptions: body.exceptions,
      ...(body.ok ? {} : { error_code: safeCodes.has(body.error_code) ? body.error_code : 'account_sync_failed' }) });
    after = body.account_id;
  }
  return { accounts: results.length, failed: results.filter(row => !row.ok).length,
    exceptions: results.reduce((sum, row) => sum + row.exceptions, 0), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runPlaidSync({ url: process.env.SUPABASE_URL });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Bank feed sync failed');
    process.exitCode = 1;
  }
}
