// Scheduled ingestion only. This script cannot approve or post journals.
import { pathToFileURL } from 'node:url';

export async function runPlaidSync({ url, serviceKey, fetchImpl = fetch }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid Supabase URL');
  if (!serviceKey) throw new Error('Missing Supabase service key');
  const headers = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' };
  // Keyset pagination avoids silently skipping accounts behind the REST row cap.
  let lastId = null;
  const results = [];
  for (;;) {
    const query = new URL('/rest/v1/plaid_accounts', base);
    query.searchParams.set('select', 'id,plaid_connections!inner(status)');
    query.searchParams.set('source_id', 'not.is.null');
    query.searchParams.set('plaid_connections.status', 'eq.active');
    query.searchParams.set('order', 'id.asc');
    query.searchParams.set('limit', '100');
    if (lastId) query.searchParams.set('id', `gt.${lastId}`);
    const response = await fetchImpl(query, { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Account discovery failed (${response.status})`);
    const accounts = await response.json();
    if (!Array.isArray(accounts) || accounts.some(row => typeof row.id !== 'string' || (lastId && row.id <= lastId))) throw new Error('Invalid account page');
    for (const account of accounts) {
      try {
        const sync = await fetchImpl(new URL('/functions/v1/plaid-finance', base), {
          method: 'POST', headers, body: JSON.stringify({ action: 'sync_background', account_id: account.id }),
          signal: AbortSignal.timeout(145_000), redirect: 'error',
        });
        const body = await sync.json().catch(() => null);
        if (!sync.ok || !body || !Array.isArray(body.batch_ids) || !Number.isInteger(body.exceptions)) {
          results.push({ account_id: account.id, ok: false, status: sync.status });
        } else results.push({ account_id: account.id, ok: true, exceptions: body.exceptions });
      } catch { results.push({ account_id: account.id, ok: false, status: 'unconfirmed' }); }
    }
    if (accounts.length < 100) break;
    lastId = accounts.at(-1).id;
  }
  return { accounts: results.length, failed: results.filter(row => !row.ok).length,
    exceptions: results.reduce((sum, row) => sum + (row.exceptions || 0), 0), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runPlaidSync({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    // Never print provider response bodies or credential-bearing request objects.
    console.error(error instanceof Error ? error.message : 'Bank feed sync failed');
    process.exitCode = 1;
  }
}
