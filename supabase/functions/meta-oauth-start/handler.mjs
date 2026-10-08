// JWT-auth: begin a Meta (Facebook Login for Business) connection for one
// company. Returns { url } for the browser to open. Logic here so node can
// execute it; index.ts wires the real collaborators. ADDITIVE: nothing in
// Integrations calls this yet.
//
// return_to: 'review_test' is the App Review test page's mode. It only ever
// ADDS checks (allow-listed active workspace; a reconnect only of a review
// row) and returns to /testing/meta-oauth.html. Without it, behaviour is the
// original one, unchanged.
import {
  authorizeUrl, mayConnect, mayReconnect,
  REVIEW_RETURN_TO, reviewCompanyIds, reviewNonce, mayUseReviewWorkspace, isReviewConnection,
} from './meta-oauth-lib.mjs';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function createStartHandler({ env, admin }) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!env.META_APP_ID || !env.META_LOGIN_CONFIG_ID || !env.META_OAUTH_REDIRECT_URI) {
      return json({ error: 'Meta login is not configured' }, 503);
    }

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: null };
    const user = auth?.user;
    if (!user) return json({ error: 'Unauthorized' }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const companyId = body?.company_entity_id;
    const connectionId = body?.connection_id ?? null;
    if (!companyId) return json({ error: 'company_entity_id required' }, 400);
    const returnTo = body?.return_to ?? null;
    if (returnTo !== null && returnTo !== REVIEW_RETURN_TO) return json({ error: 'Unknown return_to' }, 400);
    const review = returnTo === REVIEW_RETURN_TO;
    const allowlist = review ? reviewCompanyIds(env.META_REVIEW_COMPANY_IDS) : [];
    if (review && !allowlist.length) return json({ error: 'App Review test mode is not configured' }, 503);

    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('role, active_company_id, is_active').eq('id', user.id).maybeSingle();
    const { data: membership, error: membershipError } = await admin.from('entity_memberships')
      .select('role').eq('entity_id', companyId).eq('user_id', user.id).maybeSingle();
    if (!mayConnect({ profile, profileError, membership, membershipError, companyId })) {
      return json({ error: 'Admin access required for this company' }, 403);
    }
    if (review && !mayUseReviewWorkspace({ allowlist, companyId, profile, profileError, membership, membershipError })) {
      return json({ error: 'This workspace is not an App Review test workspace' }, 403);
    }

    if (connectionId) {
      const { data: conn } = await admin.from('ad_platform_connections')
        .select('id, company_entity_id, platform, meta').eq('id', connectionId).maybeSingle();
      if (!mayReconnect({ connection_id: connectionId, company_entity_id: companyId, platform: 'meta_ads' }, conn)) {
        return json({ error: 'Connection not found' }, 404);
      }
      if (review && !isReviewConnection(conn, companyId)) return json({ error: 'Connection not found' }, 404);
    }

    const nonce = review ? reviewNonce(crypto.randomUUID()) : crypto.randomUUID();
    const { error } = await admin.from('ad_platform_oauth_states').insert({
      nonce, company_entity_id: companyId, user_id: user.id, platform: 'meta_ads',
      ...(connectionId ? { connection_id: connectionId } : {}),
    });
    if (error) return json({ error: 'Could not start the connection' }, 500);

    return json({
      url: authorizeUrl({
        appId: env.META_APP_ID, configId: env.META_LOGIN_CONFIG_ID,
        redirectUri: env.META_OAUTH_REDIRECT_URI, state: nonce,
      }),
    });
  };
}
