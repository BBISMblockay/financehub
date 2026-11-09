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
//   2. GET /api/accounts -- BEST EFFORT. It needs `accounts:read`, a scope the
//      sync itself never uses, so a 403 here is recorded and ignored: the
//      account id, name and timezone stay null and the sync falls back to the
//      company's business timezone. Failing the test over a scope nothing
//      needs would be a worse answer than a partial one.
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
    await supabase.from('klaviyo_connections')
      .update({ last_tested_at: now().toISOString(), updated_at: now().toISOString(), ...patch })
      .eq('id', connection.id);
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
  const metricsRes = await klaviyoGet({
    path: 'metrics', authorization, fetchImpl, query: { 'page[size]': 100 },
  });
  if (!metricsRes.ok) {
    // Klaviyo's own meanings: 403 the key lacks the scope; 400/401 the key is
    // missing or invalid. Said plainly, because the fix differs.
    const error = metricsRes.status === 403
      ? 'The Klaviyo key is valid but lacks the metrics:read scope. Klaviyo cannot add a scope to an existing key — create a new read-only key with campaigns:read, flows:read, metrics:read, segments:read and lists:read.'
      : metricsRes.status === 401 || metricsRes.status === 400
        ? `Klaviyo rejected the credential: ${metricsRes.detail}`
        : `Klaviyo returned ${metricsRes.status}: ${metricsRes.detail}`;
    await record({ last_test_success: false, last_test_error: error });
    return { status: 200, body: { success: false, error, code: metricsRes.status === 403 ? 'insufficient_scope' : 'rejected' } };
  }

  const metrics = (Array.isArray(metricsRes.json?.data) ? metricsRes.json.data : []).map((m) => ({
    id: String(m.id),
    name: m?.attributes?.name ?? null,
    integration: m?.attributes?.integration?.name ?? null,
  }));

  // 2. Account details: best effort, see the note at the top of this file.
  let account = { id: null, name: null, timezone: null, scope_missing: false };
  const accountRes = await klaviyoGet({ path: 'accounts', authorization, fetchImpl });
  if (accountRes.ok) {
    const first = Array.isArray(accountRes.json?.data) ? accountRes.json.data[0] : null;
    account = {
      id: first?.id ? String(first.id) : null,
      name: first?.attributes?.contact_information?.organization_name ?? null,
      timezone: first?.attributes?.timezone ?? null,
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
          ? ['Klaviyo would not return account details (no accounts:read scope). Reporting still works; the window is computed in the company\'s business timezone instead of the account\'s.']
          : []),
        ...(!chosen ? ['Choose which Klaviyo metric counts as a conversion (normally "Placed Order"). Every Klaviyo report requires one.'] : []),
      ],
    },
  };
}
