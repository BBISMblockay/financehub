// PUBLIC (verify_jwt off): Meta redirects the browser here after Facebook
// Login for Business. The state row (written by meta-oauth-start for a signed-
// in admin) is the authorization; nothing is written without one.
//
//   ?code&state  -> consume state -> exchange code -> (long-lived swap if the
//                   token expires) -> read the client business -> write the
//                   token onto a NEW meta_ads connection, or onto the one a
//                   reconnect named -> back to Integrations
//   ?error...    -> back to Integrations with the reason
//
// The Integrations return handler (afterAdOauth) then opens the ad-account
// picker, which already lists accounts for any Meta token. Logic here so node
// can execute it; index.ts wires the real collaborators.
//
// App Review test mode: a state row whose nonce meta-oauth-start minted as
// 'rt_<uuid>' returns to /testing/meta-oauth.html instead, and must ALSO pass,
// before any code is exchanged, the same review checks start made (allow-
// listed workspace, still the caller's active one, still an admin of it); a
// reconnect may only target a review row. The prefix chooses the page and
// adds those checks; the consumed database row stays the authorization.
import {
  codeExchangeUrl, longLivedExchangeUrl, tokenExpiry, mayReconnect, newConnectionMeta,
  callbackError, META_GRAPH_VERSION,
  isReviewState, reviewCompanyIds, mayUseReviewWorkspace, isReviewConnection, REVIEW_PAGE_PATH,
} from './meta-oauth-lib.mjs';

export function createCallbackHandler({ env, admin, fetchImpl, now = () => Date.now() }) {
  const appUrl = env.SILO_APP_URL || 'https://silo-baseballism.com';
  const go = (location) => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  const pageFor = (review) => `${appUrl}${review ? REVIEW_PAGE_PATH : '/v2/integrations.html'}`;
  const getJson = async (url) => {
    const res = await fetchImpl(url);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  };

  return async function handle(req) {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const params = new URL(req.url).searchParams;
    // Which page shows the outcome. Before the state is consumed this is only
    // a display choice; afterwards it comes from the consumed row.
    let back = pageFor(isReviewState(params.get('state')));
    const fail = (code) => go(`${back}?oauth_error=${callbackError(code)}&platform=meta_ads`);
    if (params.get('error')) return fail('access_denied');
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return fail('missing_params');
    if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_OAUTH_REDIRECT_URI) return fail('server_misconfigured');

    // Consume the state in ONE statement and continue only if this request is
    // the one that deleted it: a separate read and delete would let a failed
    // delete, or a second request racing the first, exchange another code.
    const { data: consumed, error: consumeErr } = await admin.from('ad_platform_oauth_states')
      .delete().eq('nonce', state).eq('platform', 'meta_ads').gt('expires_at', new Date(now()).toISOString())
      .select('*');
    if (consumeErr || !Array.isArray(consumed) || consumed.length !== 1) return fail('invalid_or_expired_state');
    const stateRow = consumed[0];
    const review = isReviewState(stateRow.nonce);
    back = pageFor(review);

    if (review) {
      const allowlist = reviewCompanyIds(env.META_REVIEW_COMPANY_IDS);
      const { data: profile, error: profileError } = await admin.from('profiles')
        .select('role, active_company_id, is_active').eq('id', stateRow.user_id).maybeSingle();
      const { data: membership, error: membershipError } = await admin.from('entity_memberships')
        .select('role').eq('entity_id', stateRow.company_entity_id).eq('user_id', stateRow.user_id).maybeSingle();
      if (!mayUseReviewWorkspace({ allowlist, companyId: stateRow.company_entity_id, profile, profileError, membership, membershipError })) {
        return fail('review_not_allowed');
      }
    }

    let token, expiresAt, tokenType;
    try {
      const ex = await getJson(codeExchangeUrl({
        appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, redirectUri: env.META_OAUTH_REDIRECT_URI, code,
      }));
      if (!ex.ok) return fail('token_exchange_failed');
      token = ex.data?.access_token;
      if (!token) return fail('no_access_token');
      expiresAt = tokenExpiry(ex.data, now());
      tokenType = expiresAt ? 'user' : 'system_user';
      if (expiresAt) {
        // A short-lived USER token: the configuration was not set to a system
        // user token. Swap it for a long-lived one so a nightly sync survives.
        const ll = await getJson(longLivedExchangeUrl({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, token }));
        if (ll.ok && ll.data?.access_token) {
          token = ll.data.access_token;
          expiresAt = tokenExpiry(ll.data, now());
        }
      }
    } catch { return fail('token_exchange_failed'); }

    let clientBusinessId = null;
    try {
      const me = await getJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/me?fields=id,client_business_id&access_token=${encodeURIComponent(token)}`);
      if (me.ok) clientBusinessId = me.data?.client_business_id ?? null;
    } catch { /* informational only */ }

    const nowIso = new Date(now()).toISOString();
    const done = (id, reconnected) => go(`${back}?oauth_connected=1&platform=meta_ads&connection_id=${id}${reconnected ? '&reconnected=1' : ''}`);

    if (stateRow.connection_id) {
      const { data: conn } = await admin.from('ad_platform_connections')
        .select('id, company_entity_id, platform, meta').eq('id', stateRow.connection_id).maybeSingle();
      if (!mayReconnect(stateRow, conn)) return fail('reconnect_target_missing');
      if (review && !isReviewConnection(conn, stateRow.company_entity_id)) return fail('reconnect_target_missing');
      const meta = { ...(conn.meta || {}), oauth: newConnectionMeta({ clientBusinessId, tokenType, nowIso, reviewTest: review }).oauth };
      const { data: updated, error } = await admin.from('ad_platform_connections')
        .update({
          access_token: token, token_expires_at: expiresAt, is_active: true, meta,
          last_tested_at: null, last_test_status: null, last_test_success: null, last_test_error: null,
          updated_at: nowIso,
        })
        .eq('id', conn.id).eq('company_entity_id', stateRow.company_entity_id).select('id');
      if (error) return fail('save_failed');
      if (!updated?.length) return fail('reconnect_target_missing');
      return done(conn.id, true);
    }

    const { data: inserted, error } = await admin.from('ad_platform_connections')
      .insert({
        company_entity_id: stateRow.company_entity_id,
        platform: 'meta_ads',
        display_name: review ? 'Meta Ads (App Review test)' : 'Meta Ads account',
        access_token: token,
        token_expires_at: expiresAt,
        is_active: true,
        sync_enabled: false,
        created_by: stateRow.user_id,
        meta: newConnectionMeta({ clientBusinessId, tokenType, nowIso, reviewTest: review }),
      })
      .select('id').single();
    if (error || !inserted) return fail('save_failed');
    return done(inserted.id, false);
  };
}
