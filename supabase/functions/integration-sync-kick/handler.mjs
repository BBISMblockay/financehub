// integration-sync-kick -- the immediate first sync for the COMPANY-SCOPED
// pillars, from /v2/integrations.html.
//
// WHY IT EXISTS. Connecting an integration queues a server-side first sync in
// integration_bootstrap_jobs, drained every 15 minutes. Shopify and the ad
// platforms do not wait for that drain: the page calls their deployed
// per-connection sync function the moment a connection is saved, so numbers
// appear while somebody is still looking at the page. Klaviyo and Redo had no
// such function, so for them the queue was the ONLY path and the card sat
// empty for up to a quarter of an hour -- longer whenever GitHub's schedules
// arrive late on this repo, which they routinely do.
//
// WHAT IT RUNS. The SAME cores the nightly workflows run -- syncKlaviyoConnection
// from scripts/lib/klaviyo-sync-core.mjs and syncRedoMarketingConnection from
// scripts/lib/redo-marketing-sync-core.mjs, copied verbatim into ./lib and
// pinned there by scripts/tests/integration-sync-kick.test.mjs. Nothing here
// is a second implementation of a sync, and because both cores upsert on the
// same identity columns, overlapping with the queue or the nightly is
// harmless: the later writer wins with the same values.
//
// WHAT IT IS NOT. It is not the history import. The queued job still does the
// full window (365 days for Klaviyo, all of it for Redo returns) and remains
// what GUARANTEES the data; this is the first slice of it happening now. The
// response names both the window it synced and what stays queue-only, so
// "synced" is never read as "everything synced".
//
// Redo RETURNS are deliberately not offered. That backfill walks Redo's whole
// order history page by page, which does not fit an interactive request; it
// stays queued. The kick covers Redo MARKETING only, and says so.
//
// Authorization is the page's own: the connection must be readable through the
// CALLER's RLS. Both tables' select policies are scoped to
// `company_entity_id = active_company_id()` plus an admin gate, so a caller
// who cannot see the row cannot sync it. Credentials are then read with the
// service role, exactly as test-klaviyo-connection does, and never returned.
//
// It vendors neither mfa-gate.mjs nor integration-gate.mjs, deliberately and
// for the same reason ad-platform-sync-run does not: both rules exempt a
// function whose FIRST read after getUser is a caller-token PostgREST call
// whose error aborts, which is exactly the RLS visibility read below. The
// pre-request hook refuses a password-only session and a developer-platform
// token there, before any service-role call is made. Do not "fix" this by
// adding a gate -- move that read and the exemption is gone.
//
// The cores write their own sync_jobs row (running -> success / skipped /
// error) and distinguish a configuration state from a failure themselves, so
// this handler deliberately keeps NO bookkeeping of its own. Adding a second
// row here would double-count every kick in the sync log.

/** The integrations this function will kick, and how to load each one.
 *
 * `core` is the key under which index.ts passes that integration's sync
 * function, so adding a pillar is one entry here plus one import there -- not
 * a branch in the request path. Both of these are company-scoped (one
 * connection row per company), which is why neither takes a connection_id:
 * the caller's RLS already narrows the table to their active company.
 */
export const KICK_INTEGRATIONS = {
  klaviyo: {
    label: 'Klaviyo',
    table: 'klaviyo_connections',
    core: 'syncKlaviyoConnection',
    // Only what the core reads. Listing * would pull api_key and the OAuth
    // tokens into this module's scope for no reason; these are the same
    // columns scripts/klaviyo-sync.mjs loads.
    columns: 'id, company_entity_id, is_active, sync_enabled, auth_mode, api_key,'
      + ' access_token, refresh_token, token_expires_at, oauth_scope,'
      + ' reauth_required_at, klaviyo_account_id, account_timezone,'
      + ' conversion_metric_id, days_back, meta',
    // The same flags scripts/klaviyo-sync.mjs filters on. Connecting an
    // account is not consent to sync it, so a kick must not be a way around
    // the switch the nightly obeys. Redo has no sync_enabled column -- its
    // nightly runs on is_active alone -- so this is per integration, not a
    // shared assumption about what every connection table carries.
    requireTrue: ['is_active', 'sync_enabled'],
    queueOnly: ['the rest of the 365-day history'],
  },
  redo_marketing: {
    label: 'Redo marketing',
    table: 'redo_connections',
    core: 'syncRedoMarketingConnection',
    columns: 'id, company_entity_id, is_active, api_secret, meta',
    requireTrue: ['is_active'],
    // Named in the response, so nobody reads a green marketing kick as the
    // returns history having landed.
    queueOnly: ['the returns history', 'the rest of the marketing history'],
  },
};

// A kick has to finish inside the gateway's 150s, and it is competing for the
// same provider rate budget as whatever the queue is doing. 7 days is chosen
// to be the smallest window that puts real numbers on the card: Klaviyo's
// campaign report is billed per REQUEST, not per campaign or per day, so a
// 7-day window is one grouped request on the tightest endpoint in that API
// (campaign-values-reports: 1/sec, 2/min, 225/day).
export const DEFAULT_KICK_DAYS = 7;
// A connection configured deeper is CLAMPED rather than refused: days_back is
// the nightly's setting, and someone who set it to 365 wants that from the
// nightly, not from a request a browser is waiting on.
export const MAX_KICK_DAYS = 30;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

/** How many days this kick should ask for. Pure. */
export function kickDaysBack(conn) {
  const configured = Number(conn?.days_back);
  const days = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_KICK_DAYS;
  return Math.min(days, MAX_KICK_DAYS);
}

/** The sentence an operator sees for a core's `skipped` outcome.
 *
 * Every one of these is a configuration state the person reading it can act
 * on, which is why none of them is reported as a failure of the sync. An
 * unknown reason is passed through rather than reworded: a reason this map has
 * not caught up with must still reach the screen.
 */
export const SKIP_MESSAGES = {
  not_configured: 'No credential is stored for this connection yet.',
  no_conversion_metric: 'Run Test connection first — the conversion metric is not set.',
  reauth_required: 'This connection needs reconnecting before it can sync.',
  insufficient_scope: 'The stored key is missing a read scope, so there was nothing to sync.',
  bad_credential: 'The provider rejected the stored credential.',
};

export function skipMessage(reason) {
  return SKIP_MESSAGES[reason] || `Nothing was synced (${reason}).`;
}

/**
 * @param deps.service        service-role Supabase client
 * @param deps.userClientFor  (authHeader) => Supabase client carrying the caller's JWT
 * @param deps.cores          { syncKlaviyoConnection, syncRedoMarketingConnection }
 */
export function createHandler({ service, userClientFor, cores, now = () => new Date(), log = () => {} }) {
  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const { data: auth, error: authErr } = await service.auth.getUser(token);
    if (authErr || !auth?.user) return json({ error: 'Unauthorized' }, 401);

    let body;
    try { body = await req.json(); } catch { body = null; }
    const key = typeof body?.integration === 'string' ? body.integration : '';
    const spec = Object.prototype.hasOwnProperty.call(KICK_INTEGRATIONS, key)
      ? KICK_INTEGRATIONS[key]
      : null;
    if (!spec) {
      return json({ error: `integration must be one of: ${Object.keys(KICK_INTEGRATIONS).join(', ')}` }, 400);
    }
    const run = cores?.[spec.core];
    if (typeof run !== 'function') return json({ error: `${spec.label} sync is not configured on the server` }, 503);

    // The authorization: visible through the caller's own RLS, or not at all.
    // Company-scoped, so no id is sent from the browser and none is trusted --
    // RLS decides which row this caller is allowed to touch.
    const { data: visible, error: visErr } = await userClientFor(authHeader)
      .from(spec.table).select('id').limit(1).maybeSingle();
    if (visErr || !visible) return json({ error: `No ${spec.label} connection found for this workspace` }, 404);

    const { data: conn, error: connErr } = await service
      .from(spec.table).select(spec.columns).eq('id', visible.id).maybeSingle();
    if (connErr || !conn) return json({ error: `No ${spec.label} connection found for this workspace` }, 404);

    // 409, not 404: the row exists and the caller can see it. Naming the flag
    // is the point -- "inactive" and "sync is switched off" send an operator
    // to two different switches.
    const off = (spec.requireTrue || []).find((flag) => conn[flag] !== true);
    if (off) {
      return json({
        ok: false,
        code: 'sync_off',
        error: off === 'sync_enabled'
          ? `${spec.label} sync is switched off for this workspace.`
          : `This ${spec.label} connection is inactive.`,
      }, 409);
    }

    const daysBack = kickDaysBack(conn);
    let out;
    try {
      out = await run({
        supabase: service,
        connection: conn,
        daysBack,
        // `params` on the sync_jobs row the core writes, so this run is
        // identifiable in the sync log as a kick rather than a schedule.
        jobParams: { trigger: 'kick', integration: key, days_back: daysBack },
        now,
        log,
      });
    } catch (err) {
      // The core has already recorded this run as `error` on its own
      // sync_jobs row and rethrown, so there is nothing to write here -- only
      // to report. 502: the failure is the provider's or SILO's, not the
      // caller's request.
      return json({ ok: false, error: String(err?.message ?? err).slice(0, 800) }, 502);
    }

    if (out?.skipped) {
      // 200, not an error status: the request was correct and the stored
      // record says exactly what happened. The page renders this message
      // verbatim rather than labelling it itself.
      return json({ ok: false, code: out.skipped, error: skipMessage(out.skipped), integration: key });
    }

    return json({
      ok: true,
      integration: key,
      label: spec.label,
      window: out?.window ?? null,
      time_zone: out?.time_zone ?? null,
      chunks: Array.isArray(out?.chunks) ? out.chunks.length : 0,
      // Always present, always true: the queue is still doing the rest.
      queue_only: spec.queueOnly,
    });
  };
}
