// test-klaviyo-connection -- prove a company's Klaviyo credential works, and
// resolve the two things the sync cannot run without: the account's own
// timezone and a conversion metric.
//
// The handler lives here rather than in index.ts so node tests can execute it
// (supabase/functions/CLAUDE.md). It takes NO company id from the request: the
// company is the caller's own active_company_id, read with the service role
// after the caller has been identified.
//
// What it asks Klaviyo, and why in this order:
//
//   1. GET /api/metrics  -- needs `metrics:read`, which the sync needs anyway,
//      so this call doubles as the credential test. It also carries the
//      candidate conversion metrics, which is what the UI picker shows.
//   2. GET /api/accounts -- BEST EFFORT. It needs `accounts:read`, which SILO
//      requests at install but an older connection (or a private key made
//      before 2026-11-09) will not carry, so a 403 here is recorded and
//      ignored: the account id, name, timezone and currency stay null, the
//      sync falls back to the company's business timezone, and Klaviyo SMS
//      cost is labelled as an ASSUMED currency wherever it is shown. Failing
//      the whole test over it would be a worse answer than a partial one.
//      Klaviyo cannot widen an existing grant, so a connection made before
//      the scope was requested must re-consent before this call can succeed.
//
// A conversion metric is chosen automatically only when Klaviyo has exactly
// one obvious candidate ("Placed Order"); otherwise the caller picks from the
// list, because guessing which metric means revenue would silently change
// every number the integration reports.

export const KLAVIYO_API_BASE = 'https://a.klaviyo.com/api';
// Must match scripts/lib/klaviyo-sync-core.mjs's KLAVIYO_REVISION: testing one
// revision and syncing another proves nothing.
export const KLAVIYO_REVISION = '2026-10-15';
export const PREFERRED_CONVERSION_METRICS = Object.freeze(['Placed Order', 'Ordered Product']);

export function authHeaderFor(connection) {
  if (connection?.auth_mode === 'oauth') {
    return connection.access_token ? `Bearer ${connection.access_token}` : null;
  }
  return connection?.api_key ? `Klaviyo-API-Key ${connection.api_key}` : null;
}

/** Which metric to measure conversions against, or null to make the admin
 * choose. Order of preference is explicit, and a name match is exact and
 * case-insensitive -- a "Placed Order (legacy)" is not the same metric. */
export function pickConversionMetric(metrics = []) {
  for (const preferred of PREFERRED_CONVERSION_METRICS) {
    const hit = metrics.find((m) => String(m.name || '').trim().toLowerCase() === preferred.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function klaviyoGet({ path, authorization, fetchImpl, query = {} }) {
  const url = new URL(`${KLAVIYO_API_BASE}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: authorization, revision: KLAVIYO_REVISION, accept: 'application/vnd.api+json' },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json, detail: json?.errors?.[0]?.detail || text.slice(0, 300) };
}

/** Every metric in the account, following Klaviyo's cursor.
 *
 * Paged rather than read one page deep: the conversion metric this whole
 * integration measures against is chosen from this list, so a truncated list
 * can mean "Placed Order" is simply never offered on a large account. Capped,
 * so a cursor that never terminates cannot hang the test.
 */
const MAX_METRIC_PAGES = 10;

export async function fetchAllMetrics({ authorization, fetchImpl }) {
  const metrics = [];
  let cursor = null;
  for (let page = 0; page < MAX_METRIC_PAGES; page += 1) {
    const res = await klaviyoGet({
      path: 'metrics', authorization, fetchImpl,
      query: cursor ? { 'page[cursor]': cursor } : {},
    });
    if (!res.ok) return { ok: false, status: res.status, detail: res.detail, metrics: [] };
    for (const m of Array.isArray(res.json?.data) ? res.json.data : []) {
      metrics.push({
        id: String(m.id),
        name: m?.attributes?.name ?? null,
        integration: m?.attributes?.integration?.name ?? null,
      });
    }
    const next = res.json?.links?.next;
    if (!next) break;
    try {
      cursor = new URL(next).searchParams.get('page[cursor]');
    } catch (_) {
      cursor = null;
    }
    if (!cursor) break;
  }
  return { ok: true, status: 200, detail: '', metrics };
}

/**
 * @returns {{ status: number, body: object }}
 */
export async function runKlaviyoTest({ supabase, companyEntityId, fetchImpl = fetch, now = () => new Date() }) {
  const { data: connection, error: connErr } = await supabase
    .from('klaviyo_connections')
    .select('id, company_entity_id, auth_mode, api_key, access_token, reauth_required_at, conversion_metric_id')
    .eq('company_entity_id', companyEntityId)
    .maybeSingle();
  if (connErr) return { status: 500, body: { error: connErr.message } };
  if (!connection) return { status: 404, body: { error: 'No Klaviyo connection for this company' } };

  const record = async (patch) => {
    const row = { last_tested_at: now().toISOString(), updated_at: now().toISOString(), ...patch };
    const write = (r) => supabase.from('klaviyo_connections').update(r).eq('id', connection.id);
    const res = await write(row);
    // account_currency arrives with migration 20261110010000. Until that is
    // applied, PostgREST refuses the WHOLE update over the one unknown column
    // (PGRST204) -- which would silently drop the test result, the account
    // name and the conversion metric along with it. So that one refusal, and
    // only that one, is retried without the column: everything else this
    // write carries is older than the migration and must still land.
    const err = res?.error;
    if (err && 'account_currency' in row && /account_currency/.test(`${err.message || ''} ${err.details || ''}`)) {
      const { account_currency: _unstored, ...rest } = row;
      await write(rest);
    }
  };

  if (connection.reauth_required_at) {
    const error = 'Klaviyo rejected this grant earlier — reconnect the account';
    await record({ last_test_success: false, last_test_error: error });
    return { status: 200, body: { success: false, error, code: 'reauth_required' } };
  }

  const authorization = authHeaderFor(connection);
  if (!authorization) {
    const error = connection.auth_mode === 'oauth'
      ? 'This connection has no access token — reconnect the account'
      : 'No API key saved — paste a Klaviyo private key first';
    await record({ last_test_success: false, last_test_error: error });
    return { status: 200, body: { success: false, error, code: 'not_configured' } };
  }

  // 1. Metrics: the credential test, and the conversion-metric candidates.
  //
  // NO `page[size]`: unlike campaigns and flows, GET /api/metrics does not
  // accept it, and sending it earns a 400 reading "'page_size' is not a valid
  // field for the resource 'metric'" — which is exactly what a real account
  // returned the first time this ran. Metrics page with `page[cursor]` alone.
  const metricsRes = await fetchAllMetrics({ authorization, fetchImpl });
  if (!metricsRes.ok) {
    // Klaviyo's own meanings: 403 the key lacks the scope; 400/401 the key is
    // missing or invalid. Said plainly, because the fix differs.
    const error = metricsRes.status === 403
      ? 'The Klaviyo key is valid but lacks the metrics:read scope. Klaviyo cannot add a scope to an existing key — create a new read-only key with campaigns:read, flows:read, metrics:read, segments:read, lists:read and accounts:read.'
      : metricsRes.status === 401
        ? `Klaviyo rejected the credential: ${metricsRes.detail}`
        : metricsRes.status === 400
          ? `Klaviyo refused the request SILO made — the key was not the problem: ${metricsRes.detail}`
          : `Klaviyo returned ${metricsRes.status}: ${metricsRes.detail}`;
    const code = metricsRes.status === 403 ? 'insufficient_scope'
      : metricsRes.status === 400 ? 'bad_request'
        : 'rejected';
    await record({ last_test_success: false, last_test_error: error });
    return { status: 200, body: { success: false, error, code } };
  }

  const metrics = metricsRes.metrics;

  // 2. Account details: best effort, see the note at the top of this file.
  let account = { id: null, name: null, timezone: null, currency: null, scope_missing: false };
  const accountRes = await klaviyoGet({ path: 'accounts', authorization, fetchImpl });
  if (accountRes.ok) {
    const first = Array.isArray(accountRes.json?.data) ? accountRes.json.data[0] : null;
    account = {
      id: first?.id ? String(first.id) : null,
      name: first?.attributes?.contact_information?.organization_name ?? null,
      timezone: first?.attributes?.timezone ?? null,
      // Klaviyo's own `preferred_currency` (an ISO code, e.g. 'USD'). It is
      // the currency Klaviyo bills SMS sending in, and the only currency this
      // integration can state rather than assume.
      currency: first?.attributes?.preferred_currency ?? null,
      scope_missing: false,
    };
  } else {
    account.scope_missing = accountRes.status === 403;
  }

  // Keep a conversion metric the admin already chose; only fill an empty one.
  const existing = connection.conversion_metric_id
    ? metrics.find((m) => m.id === connection.conversion_metric_id)
    : null;
  const chosen = existing || pickConversionMetric(metrics);

  const patch = {
    last_test_success: true,
    last_test_error: null,
    ...(account.id ? { klaviyo_account_id: account.id } : {}),
    ...(account.name ? { klaviyo_account_name: account.name } : {}),
    ...(account.timezone ? { account_timezone: account.timezone } : {}),
    ...(account.currency ? { account_currency: account.currency } : {}),
    ...(chosen ? { conversion_metric_id: chosen.id, conversion_metric_name: chosen.name } : {}),
  };
  await record(patch);

  return {
    status: 200,
    body: {
      success: true,
      account,
      conversion_metric: chosen ? { id: chosen.id, name: chosen.name } : null,
      // The picker's options. Sorted by name so the list is stable between
      // calls; Klaviyo's own order is not.
      metrics: metrics.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))),
      // Said out loud rather than left for somebody to notice: without a
      // conversion metric no report can run at all.
      needs_conversion_metric: !chosen,
      notes: [
        ...(account.scope_missing
          ? ['Klaviyo would not return account details (no accounts:read scope). Reporting still works; the measurement window is computed in the company\'s business timezone instead of the account\'s, and Klaviyo SMS cost is labelled as an assumed currency. Reconnect to grant the scope.']
          : []),
        ...(!chosen ? ['Choose which Klaviyo metric counts as a conversion (normally "Placed Order"). Every Klaviyo report requires one.'] : []),
      ],
    },
  };
}
